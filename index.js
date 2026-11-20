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

const is_ignore_about_blank_bookmarks = true; // true: drop bookmarks whose URL is about:blank.
const is_deduplicate_across_folders = true;   // true: keep only the first occurrence of each exact URL in the whole tree.
const is_remove_empty_folders = true;         // true: drop folders that end up with no bookmarks, including nested ones.

// Cleaning switches. Titles are cleaned during the gather step, before sorting.
// URLs are cleaned during the gather step, before any uniquification.
const is_trim_titles = true;                  // true: trim leading/trailing whitespace from folder and bookmark titles.
const is_ignore_bookmarks_without_url = true; // true: drop bookmarks whose href is missing or empty.
const is_normalize_url = true;                // true: re-construct URLs, remove trailing "/" suffix, remove duplicated query arguments (order preserved).
const is_https_everywhere = true;             // true: upgrade http:// to https:// except for localhost and private network IPs.
const is_normalize_titles = true;             // true: remove non-ASCII (emoji etc.), control characters and non-viable unicode, unify whitespace to a single space.

const illegal_character_pattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const skipped_tag_names = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
  'HEAD', 'TITLE', 'META', 'LINK', 'HR'
]);
const html_escape_map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

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
  upload_target_textarea: null,    // Textarea waiting for a picked file.
  active_download_object_url: null // Object URL of the last generated download, revoked after use.
};

const create_folder = folder_title => ({ node_type: 'folder', title: folder_title, children: [] });

const reset_merge_state = () => {
  merge_state.root_folder = create_folder('');
  merge_state.current_folder = merge_state.root_folder;
  merge_state.pending_folder = null;
  merge_state.seen_urls = new Set();
};


const normalize_title_text = raw_title => raw_title
  .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')                 // Control characters (incl. tab, newline, DEL, C1) become spaces.
  .replace(/[\p{Cn}\p{Co}\p{Cs}]/gu, '')                  // Unassigned, private-use, and lone surrogate code points are removed.
  .replace(/[\u00AD\u200B\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g, '') // Invisible format characters are removed.
  .replace(/(?<=[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F])\u200D|\u200D(?=[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji_Modifier}])/gu, '') // Joiners that link emoji sequences.
  .replace(/[\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u20E3]/gu, '') // Emoji, skin tones, flags, variation selectors, keycaps.
  .replace(/\s+/g, ' ')                                   // Unify runs of whitespace to a single space.
  .trim();


const prepare_title = raw_title => {
  const trimmed_title = is_trim_titles ? raw_title.trim() : raw_title;

  return is_normalize_titles ? normalize_title_text(trimmed_title) : trimmed_title;
};

const is_local_or_private_host = hostname => {
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
};

const upgrade_to_https = url_text => {
  let parsed_url;

  try {
    parsed_url = new URL(url_text);
  } catch {
    return url_text;
  }

  if (parsed_url.protocol !== 'http:' || is_local_or_private_host(parsed_url.hostname)) {
    return url_text;
  }

  // Replace only the scheme: the text before the first colon.
  return url_text.replace(/^[^:]*:/, 'https:');
};

const normalize_url_text = url_text => {
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
  const unique_arguments = Array.from(parsed_url.searchParams).filter(argument_entry => {
    const argument_key = JSON.stringify(argument_entry);

    if (seen_argument_keys.has(argument_key)) return false;

    seen_argument_keys.add(argument_key);
    return true;
  });

  parsed_url.search = new URLSearchParams(unique_arguments).toString();

  // The URL API adds "/" to bare origins, so strip any remaining trailing slashes before "?" or "#".
  return parsed_url.href.replace(/\/+(?=$|[?#])/, '');
};

const prepare_url = raw_url => {
  const trimmed_url = raw_url.trim();

  if (!trimmed_url) return '';

  const upgraded_url = is_https_everywhere ? upgrade_to_https(trimmed_url) : trimmed_url;

  return is_normalize_url ? normalize_url_text(upgraded_url) : upgraded_url;
};

const is_about_blank_url = url_text => /^about:blank\/*$/i.test(url_text.trim());

const title_sort_key = folder_title => {
  let sort_key = folder_title;

  if (is_ignore_leading_symbols) {
    sort_key = sort_key.replace(/^[^\p{L}\p{N}]+/u, '');
  }

  if (is_ignore_leading_articles) {
    sort_key = sort_key.replace(/^(the|a|an)\s+/i, '');
  }

  return sort_key;
};

const compare_titles = (first_title, second_title) => {
  const first_sort_key = title_sort_key(first_title);
  const second_sort_key = title_sort_key(second_title);

  return title_collator.compare(first_sort_key, second_sort_key)
    || ((first_sort_key > second_sort_key) - (first_sort_key < second_sort_key));
};

const find_or_create_folder = folder_title => {
  const parent_folder = merge_state.current_folder;
  const existing_folder = parent_folder.children.find(
    child_node => child_node.node_type === 'folder' && child_node.title === folder_title
  );

  if (existing_folder) return existing_folder;

  const new_folder = create_folder(folder_title);

  parent_folder.children.push(new_folder);
  return new_folder;
};

const add_bookmark = anchor_element => {
  // URL cleaning runs here, during gathering, so the uniquification phases see the cleaned URL.
  const url = prepare_url(anchor_element.getAttribute('href') ?? '');

  if (!url && is_ignore_bookmarks_without_url) return;

  // about:blank bookmarks are dropped before they can take part in uniquification.
  if (is_ignore_about_blank_bookmarks && is_about_blank_url(url)) return;

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
};

const collect_bookmarks = parent_element => {
  Array.from(parent_element.children).forEach(child_element => {
    const tag_name = child_element.tagName;

    if (skipped_tag_names.has(tag_name)) return;

    switch (tag_name) {
      case 'H3':
        merge_state.pending_folder = find_or_create_folder(prepare_title(child_element.textContent));
        break;

      case 'A':
        add_bookmark(child_element);
        break;

      case 'DL': {
        const owner_folder = merge_state.pending_folder ?? merge_state.current_folder;
        const previous_folder = merge_state.current_folder;

        merge_state.pending_folder = null;
        merge_state.current_folder = owner_folder;
        collect_bookmarks(child_element);
        merge_state.current_folder = previous_folder;
        break;
      }

      default:
        collect_bookmarks(child_element);
    }
  });
};

const parse_bookmark_html = raw_html => {
  const cleaned_html = raw_html
    .replace(/^\uFEFF/, '')
    .replace(illegal_character_pattern, '');

  if (!cleaned_html.trim()) return;

  const parsed_document = new DOMParser().parseFromString(cleaned_html, 'text/html');

  merge_state.current_folder = merge_state.root_folder;
  merge_state.pending_folder = null;
  collect_bookmarks(parsed_document.body);
};

const compare_nodes = (first_node, second_node) => {
  if (is_folders_first && first_node.node_type !== second_node.node_type) {
    return first_node.node_type === 'folder' ? -1 : 1;
  }

  return compare_titles(first_node.title, second_node.title);
};

const tidy_folder = folder => {
  const seen_url_keys = new Set();

  const kept_nodes = folder.children.filter(node => {
    if (node.node_type === 'folder') {
      // Children are tidied first, so a folder that only held duplicates or
      // empty sub-folders is already empty by the time it is checked here.
      tidy_folder(node);

      return !(is_remove_empty_folders && node.children.length === 0);
    }

    // Bookmarks without a URL (only kept when the ignore switch is off) are never treated as duplicates.
    const url_key = node.url.toLowerCase();

    if (!url_key) return true;
    if (seen_url_keys.has(url_key)) return false;

    seen_url_keys.add(url_key);
    return true;
  });

  folder.children = kept_nodes.sort(compare_nodes);
};

const escape_html = text_to_escape => String(text_to_escape)
  .replace(/[&<>"]/g, character => html_escape_map[character]);

const render_folder = (folder, depth = 1) => {
  const indent = indent_unit.repeat(depth);

  return folder.children.flatMap(node => {
    if (node.node_type === 'bookmark') {
      return [`${indent}<DT><A HREF="${escape_html(node.url)}">${escape_html(node.title)}</A>`];
    }

    const folder_lines = [
      `${indent}<DT><H3>${escape_html(node.title)}</H3>`,
      `${indent}<DL><p>`,
      ...render_folder(node, depth + 1),
      `${indent}</DL><p>`
    ];

    // Top-level folders are followed by a blank line for readability.
    return depth === 1 ? [...folder_lines, ''] : folder_lines;
  });
};

const build_header = () => [
  '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
  `<!-- Merged bookmarks, generated ${new Date().toISOString()} -->`,
  '<META HTTP-EQUIV="Content-Security-Policy" CONTENT="default-src \'none\'; script-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'>',
  '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
  '<TITLE>Bookmarks</TITLE>',
  '<H1>Bookmarks</H1>',
  ''
];

const merge_bookmarks = () => {
  const first_html = first_bookmark_textarea.value;
  const second_html = second_bookmark_textarea.value;

  if (!first_html.trim() && !second_html.trim()) {
    merged_output_textarea.value = '';
    return;
  }

  try {
    reset_merge_state();

    [first_html, second_html].forEach(parse_bookmark_html);
    tidy_folder(merge_state.root_folder);

    const output_lines = [
      ...build_header(),
      '<DL><p>',
      ...render_folder(merge_state.root_folder),
      '</DL><p>',
      ''
    ];

    merged_output_textarea.value = output_lines.join('\n');
  } catch (error) {
    merged_output_textarea.value = `<!-- Merge failed: ${error.message} -->`;
  }
};

const open_file_picker = target_textarea => {
  merge_state.upload_target_textarea = target_textarea;
  file_picker.value = '';
  file_picker.click();
};

const build_download_file_name = () => `${new Date().toISOString()
  .slice(0, 19)
  .replace(/[-:]/g, '')
  .replace('T', '_')}.html`;

first_upload_button.addEventListener('click', () => open_file_picker(first_bookmark_textarea));
second_upload_button.addEventListener('click', () => open_file_picker(second_bookmark_textarea));

file_picker.addEventListener('change', () => {
  const selected_file = file_picker.files?.[0];
  const target_textarea = merge_state.upload_target_textarea;

  if (!selected_file || !target_textarea) return;

  selected_file.text()
    .then(file_text => {
      target_textarea.value = file_text;
      merge_bookmarks();
    })
    .catch(error => {
      merged_output_textarea.value = `<!-- Could not read file: ${error.message} -->`;
    })
    .finally(() => {
      merge_state.upload_target_textarea = null;
    });
});

first_bookmark_textarea.addEventListener('input', merge_bookmarks);
second_bookmark_textarea.addEventListener('input', merge_bookmarks);

download_button.addEventListener('click', () => {
  if (!merged_output_textarea.value) return;

  const object_url = URL.createObjectURL(new Blob(
    [merged_output_textarea.value],
    { type: 'text/html;charset=UTF-8' }
  ));

  merge_state.active_download_object_url = object_url;
  download_link.href = object_url;
  download_link.download = build_download_file_name();
  download_link.click();

  // Revoke after the browser has had a chance to start the download.
  setTimeout(() => {
    URL.revokeObjectURL(object_url);

    if (merge_state.active_download_object_url === object_url) {
      merge_state.active_download_object_url = null;
      download_link.removeAttribute('href');
    }
  }, 1000);
});
