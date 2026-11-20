'use strict';

const first_bookmark_textarea = document.querySelector('[data-input1]');
const second_bookmark_textarea = document.querySelector('[data-input2]');
const merged_output_textarea = document.querySelector('[data-output]');
const first_upload_button = document.querySelector('[data-upload1]');
const second_upload_button = document.querySelector('[data-upload2]');
const download_button = document.querySelector('[data-download]');
const file_picker = document.querySelector('[data-file-picker]');
const download_link = document.querySelector('[data-download-link]');

const is_folders_first = true;
const is_ignore_leading_symbols = true;
const is_ignore_leading_articles = true;
const indent_unit = '    ';

const is_deduplicate_across_folders = true; // true: keep only the first occurrence of each exact URL in the whole tree.
const is_remove_empty_folders = true;       // true: drop folders that end up with no bookmarks, including nested ones.

// Cleaning switches. Titles are cleaned during the gather step, before sorting.
// URLs are cleaned during the gather step, before any uniquification.
const is_trim_titles = true;                // true: trim leading/trailing whitespace from folder and bookmark titles.
const is_ignore_bookmarks_without_url = true; // true: drop bookmarks whose href is missing or empty.
const is_normalize_url = true;              // true: re-construct URLs, remove trailing "/" suffix, remove duplicated query arguments (order preserved).
const is_https_everywhere = true;           // true: upgrade http:// to https:// except for localhost and private network IPs.
const is_normalize_titles = false;           // true: remove non-ASCII (emoji etc.), control characters and non-viable unicode, unify whitespace to a single space.

const illegal_character_pattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const skipped_tag_names = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
  'HEAD', 'TITLE', 'META', 'LINK', 'HR'
]);

const title_collator = new Intl.Collator(undefined, {
  usage: 'sort',
  sensitivity: 'base',
  ignorePunctuation: false,
  numeric: true
});

// Shared state for a single merge. Reset at the start of every merge.
const merge_state = {
  root_folder: null,               // Root folder of the merged tree.
  current_folder: null,            // Folder that new bookmarks and sub-folders are added to.
  pending_folder: null,            // Folder opened by the last H3, waiting for its DL.
  seen_urls: new Set(),            // Exact URLs already gathered (used when is_deduplicate_across_folders is on).
  output_lines: [],                // Output lines being rendered.
  indent_depth: 1,                 // Current indentation depth while rendering.
  upload_target_textarea: null,    // Textarea waiting for a picked file.
  active_download_object_url: null // Object URL of the last generated download, revoked after use.
};

function reset_merge_state() {
  merge_state.root_folder = create_folder('');
  merge_state.current_folder = merge_state.root_folder;
  merge_state.pending_folder = null;
  merge_state.seen_urls = new Set();
  merge_state.output_lines = [];
  merge_state.indent_depth = 1;
}

function normalize_title_text(raw_title) {
  return raw_title
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ') // Control characters (including tab and newline) become spaces.
    .replace(/[^\u0020-\u007E]/g, '')              // Remove all non-ASCII characters (emoji, non-viable unicode, etc.).
    .replace(/\s+/g, ' ')                          // Unify runs of whitespace to a single space.
    .trim();
}

function prepare_title(raw_title) {
  let cleaned_title = raw_title;

  if (is_trim_titles) {
    cleaned_title = cleaned_title.trim();
  }

  if (is_normalize_titles) {
    cleaned_title = normalize_title_text(cleaned_title);
  }

  return cleaned_title;
}

function is_local_or_private_host(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  if (host.includes(':')) {
    // IPv6: loopback (::1), unique local (fc00::/7), link-local (fe80::/10).
    return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }

  const ipv4_match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!ipv4_match) return false;

  const first_octet = Number(ipv4_match[1]);
  const second_octet = Number(ipv4_match[2]);

  return first_octet === 127
    || first_octet === 10
    || (first_octet === 172 && second_octet >= 16 && second_octet <= 31)
    || (first_octet === 192 && second_octet === 168);
}

function upgrade_to_https(url_text) {
  let parsed_url;

  try {
    parsed_url = new URL(url_text);
  } catch {
    return url_text;
  }

  if (parsed_url.protocol !== 'http:' || is_local_or_private_host(parsed_url.hostname)) {
    return url_text;
  }

  // The scheme is the text before the first colon, so only that part is replaced.
  return 'https:' + url_text.slice(url_text.indexOf(':') + 1);
}

function normalize_url_text(url_text) {
  let parsed_url;

  try {
    parsed_url = new URL(url_text);
  } catch {
    return url_text;
  }

  // Remove trailing "/" from the path.
  parsed_url.pathname = parsed_url.pathname.replace(/\/+$/, '');

  // Remove duplicated query arguments (identical name and value), keeping the first occurrence and the original order.
  const seen_argument_keys = new Set();
  const kept_arguments = new URLSearchParams();

  for (const [argument_name, argument_value] of parsed_url.searchParams) {
    const argument_key = JSON.stringify([argument_name, argument_value]);

    if (!seen_argument_keys.has(argument_key)) {
      seen_argument_keys.add(argument_key);
      kept_arguments.append(argument_name, argument_value);
    }
  }

  parsed_url.search = kept_arguments.toString();

  // The URL API adds "/" to bare origins, so strip any remaining trailing slashes before "?" or "#".
  return parsed_url.href.replace(/\/+(?=$|[?#])/, '');
}

function prepare_url(raw_url) {
  let url_text = raw_url.trim();

  if (!url_text) return '';

  if (is_https_everywhere) {
    url_text = upgrade_to_https(url_text);
  }

  if (is_normalize_url) {
    url_text = normalize_url_text(url_text);
  }

  return url_text;
}

function compare_titles(first_title, second_title) {
  const first_sort_key = title_sort_key(first_title);
  const second_sort_key = title_sort_key(second_title);

  return title_collator.compare(first_sort_key, second_sort_key)
    || ((first_sort_key > second_sort_key) - (first_sort_key < second_sort_key));
}

function title_sort_key(folder_title) {
  let sort_key = folder_title;

  if (is_ignore_leading_symbols) {
    sort_key = sort_key.replace(/^[^\p{L}\p{N}]+/u, '');
  }

  if (is_ignore_leading_articles) {
    sort_key = sort_key.replace(/^(the|a|an)\s+/i, '');
  }

  return sort_key;
}

function create_folder(folder_title) {
  return { node_type: 'folder', title: folder_title, children: [] };
}

function find_or_create_folder(folder_title) {
  let matching_folder = merge_state.current_folder.children.find(
    child_node => child_node.node_type === 'folder' && child_node.title === folder_title
  );

  if (!matching_folder) {
    matching_folder = create_folder(folder_title);
    merge_state.current_folder.children.push(matching_folder);
  }

  return matching_folder;
}

function add_bookmark(anchor_element) {
  // URL cleaning runs here, during gathering, so the uniquification phases see the cleaned URL.
  const url = prepare_url(anchor_element.getAttribute('href') ?? '');

  if (!url && is_ignore_bookmarks_without_url) return;

  // Gather step: the first bookmark with a given URL wins; later ones are never added.
  if (is_deduplicate_across_folders && url) {
    if (merge_state.seen_urls.has(url)) return;
    merge_state.seen_urls.add(url);
  }

  merge_state.current_folder.children.push({
    node_type: 'bookmark',
    title: prepare_title(anchor_element.textContent),
    url
  });
}

function collect_bookmarks(parent_element) {
  for (const child_element of parent_element.children) {
    const tag_name = child_element.tagName;

    if (skipped_tag_names.has(tag_name)) continue;

    if (tag_name === 'H3') {
      merge_state.pending_folder = find_or_create_folder(prepare_title(child_element.textContent));
    } else if (tag_name === 'A') {
      add_bookmark(child_element);
    } else if (tag_name === 'DL') {
      const owner_folder = merge_state.pending_folder || merge_state.current_folder;
      const previous_folder = merge_state.current_folder;

      merge_state.pending_folder = null;
      merge_state.current_folder = owner_folder;
      collect_bookmarks(child_element);
      merge_state.current_folder = previous_folder;
    } else {
      collect_bookmarks(child_element);
    }
  }
}

function parse_bookmark_html(raw_html) {
  const cleaned_html = raw_html
    .replace(/^\uFEFF/, '')
    .replace(illegal_character_pattern, '');

  if (!cleaned_html.trim()) return;

  const parsed_document = new DOMParser().parseFromString(
    cleaned_html,
    'text/html'
  );

  merge_state.current_folder = merge_state.root_folder;
  merge_state.pending_folder = null;
  collect_bookmarks(parsed_document.body);
}

function compare_nodes(first_node, second_node) {
  if (is_folders_first && first_node.node_type !== second_node.node_type) {
    return first_node.node_type === 'folder' ? -1 : 1;
  }

  return compare_titles(first_node.title, second_node.title);
}

function tidy_folder(folder) {
  const seen_url_keys = new Set();
  const kept_nodes = [];

  for (const node of folder.children) {
    if (node.node_type === 'folder') {
      tidy_folder(node);

      // Children are tidied first, so a folder that only held duplicates or
      // empty sub-folders is already empty by the time it is checked here.
      if (is_remove_empty_folders && node.children.length === 0) continue;

      kept_nodes.push(node);
      continue;
    }

    const url_key = node.url.toLowerCase();

    // Bookmarks without a URL (only kept when the ignore switch is off) are never treated as duplicates.
    if (!url_key) {
      kept_nodes.push(node);
      continue;
    }

    if (!seen_url_keys.has(url_key)) {
      seen_url_keys.add(url_key);
      kept_nodes.push(node);
    }
  }

  kept_nodes.sort(compare_nodes);
  folder.children = kept_nodes;
}

function escape_html(text_to_escape) {
  return String(text_to_escape)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render_folder(folder) {
  const current_depth = merge_state.indent_depth;
  const indent = indent_unit.repeat(current_depth);

  for (const node of folder.children) {
    if (node.node_type === 'folder') {
      merge_state.output_lines.push(`${indent}<DT><H3>${escape_html(node.title)}</H3>`);
      merge_state.output_lines.push(`${indent}<DL><p>`);

      merge_state.indent_depth++;
      render_folder(node);
      merge_state.indent_depth--;

      merge_state.output_lines.push(`${indent}</DL><p>`);

      if (current_depth === 1) merge_state.output_lines.push('');
    } else {
      merge_state.output_lines.push(
        `${indent}<DT><A HREF="${escape_html(node.url)}">${escape_html(node.title)}</A>`
      );
    }
  }
}

function build_header() {
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    `<!-- Merged bookmarks, generated ${new Date().toISOString()} -->`,
    '<META HTTP-EQUIV="Content-Security-Policy" CONTENT="default-src \'none\'; script-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    ''
  ];
}

function merge_bookmarks() {
  if (!first_bookmark_textarea.value.trim() && !second_bookmark_textarea.value.trim()) {
    merged_output_textarea.value = '';
    return;
  }

  try {
    reset_merge_state();

    parse_bookmark_html(first_bookmark_textarea.value);
    parse_bookmark_html(second_bookmark_textarea.value);
    tidy_folder(merge_state.root_folder);

    merge_state.output_lines = build_header();
    merge_state.output_lines.push('<DL><p>');
    render_folder(merge_state.root_folder);
    merge_state.output_lines.push('</DL><p>', '');

    merged_output_textarea.value = merge_state.output_lines.join('\n');
  } catch (error) {
    merged_output_textarea.value = `<!-- Merge failed: ${error.message} -->`;
  }
}

function open_file_picker(target_textarea) {
  merge_state.upload_target_textarea = target_textarea;
  file_picker.value = '';
  file_picker.click();
}

first_upload_button.addEventListener('click', () => open_file_picker(first_bookmark_textarea));
second_upload_button.addEventListener('click', () => open_file_picker(second_bookmark_textarea));

file_picker.addEventListener('change', async () => {
  const selected_file = file_picker.files?.[0];

  if (!selected_file || !merge_state.upload_target_textarea) return;

  try {
    merge_state.upload_target_textarea.value = await selected_file.text();
    merge_bookmarks();
  } catch (error) {
    merged_output_textarea.value = `<!-- Could not read file: ${error.message} -->`;
  } finally {
    merge_state.upload_target_textarea = null;
  }
});

first_bookmark_textarea.addEventListener('input', merge_bookmarks);
second_bookmark_textarea.addEventListener('input', merge_bookmarks);

download_button.addEventListener('click', () => {
  if (!merged_output_textarea.value) return;

  const current_time = new Date();
  const download_file_name = `${current_time.toISOString()
    .replace(/\..*$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '_')}.html`;

  if (merge_state.active_download_object_url) {
    URL.revokeObjectURL(merge_state.active_download_object_url);
  }

  merge_state.active_download_object_url = URL.createObjectURL(new Blob(
    [merged_output_textarea.value],
    { type: 'text/html;charset=UTF-8' }
  ));

  download_link.href = merge_state.active_download_object_url;
  download_link.download = download_file_name;
  download_link.click();

  // Revoke after the browser has had a chance to start the download.
  setTimeout(() => {
    if (merge_state.active_download_object_url) {
      URL.revokeObjectURL(merge_state.active_download_object_url);
      merge_state.active_download_object_url = null;
      download_link.removeAttribute('href');
    }
  }, 1000);
});
