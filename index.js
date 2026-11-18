// true: folders are listed before bookmarks at every level.
// false: folders and bookmarks are sorted together by title.
const folders_first = false;

// Control characters that are illegal in HTML, usually left behind by damaged exports.
const illegal_characters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Tags whose content is never a bookmark. Scripts and styles are skipped entirely.
const skipped_tags = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
  'HEAD', 'TITLE', 'META', 'LINK', 'HR'
]);

const indent_unit = '    ';

const input_1 = document.getElementById('input_1');
const input_2 = document.getElementById('input_2');
const output_area = document.getElementById('output_area');


// ---------- Tree helpers ----------

function create_folder(title) {
  return { kind: 'folder', title: title, children: [] };
}

// Folders with the same name under the same parent become one folder.
function find_or_create_folder(parent_folder, title) {
  const existing_folder = parent_folder.children.find(
    node => node.kind === 'folder' && node.title === title
  );
  if (existing_folder) {
    return existing_folder;
  }
  const new_folder = create_folder(title);
  parent_folder.children.push(new_folder);
  return new_folder;
}

function add_bookmark(anchor_element, target_folder) {
  const url = anchor_element.getAttribute('href');
  if (url === null) {
    return; // an anchor without a link is not a bookmark
  }
  target_folder.children.push({
    kind: 'bookmark',
    title: anchor_element.textContent,
    url: url
  });
}


// ---------- Parsing ----------

function sanitize_input(raw_html) {
  return raw_html
    .replace(/^\uFEFF/, '')                 // byte order mark
    .replace(illegal_characters, '');       // illegal control characters
}

// Walks the parsed DOM and keeps only folders, bookmarks and their titles and URLs.
// The state object remembers the most recent folder heading so the following
// list (DL) can be attached to it, even when the HTML has no proper nesting.
function collect_bookmarks(element, target_folder, state) {
  for (const child of element.children) {
    const tag_name = child.tagName;

    if (skipped_tags.has(tag_name)) {
      continue;
    }

    if (tag_name === 'H3') {
      state.pending_folder = find_or_create_folder(target_folder, child.textContent);
    } else if (tag_name === 'A') {
      add_bookmark(child, target_folder);
    } else if (tag_name === 'DL') {
      const owner_folder = state.pending_folder || target_folder;
      state.pending_folder = null;
      collect_bookmarks(child, owner_folder, state);
    } else {
      collect_bookmarks(child, target_folder, state);
    }
  }
}

// DOMParser builds an inert document: scripts do not run and images are not loaded.
function parse_into(raw_html, root_folder) {
  const cleaned_html = sanitize_input(raw_html);
  if (cleaned_html.trim() === '') {
    return;
  }
  const parsed_document = new DOMParser().parseFromString(cleaned_html, 'text/html');
  collect_bookmarks(parsed_document.body, root_folder, { pending_folder: null });
}


// ---------- Cleanup ----------

function compare_nodes(first_node, second_node) {
  if (folders_first && first_node.kind !== second_node.kind) {
    return first_node.kind === 'folder' ? -1 : 1;
  }
  const first_key = first_node.title.toLowerCase();
  const second_key = second_node.title.toLowerCase();
  if (first_key < second_key) return -1;
  if (first_key > second_key) return 1;
  return 0;
}

// Within each folder, keeps the first bookmark for each URL (case-insensitive),
// then sorts every level by title.
function tidy_folder(folder) {
  const seen_urls = new Set();
  const kept_nodes = [];

  for (const node of folder.children) {
    if (node.kind === 'folder') {
      tidy_folder(node);
      kept_nodes.push(node);
      continue;
    }
    const url_key = node.url.toLowerCase();
    if (!seen_urls.has(url_key)) {
      seen_urls.add(url_key);
      kept_nodes.push(node);
    }
  }

  kept_nodes.sort(compare_nodes);
  folder.children = kept_nodes;
}


// ---------- Output ----------

function escape_html(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Produces the Netscape bookmark format that Chrome, Firefox, Edge and Safari all import.
function render_folder(folder, depth, lines) {
  const indent = indent_unit.repeat(depth);

  for (const node of folder.children) {
    if (node.kind === 'folder') {
      lines.push(`${indent}<DT><H3>${escape_html(node.title)}</H3>`);
      lines.push(`${indent}<DL><p>`);
      render_folder(node, depth + 1, lines);
      lines.push(`${indent}</DL><p>`);
      if (depth === 1) {
        lines.push('');
      }
    } else {
      lines.push(`${indent}<DT><A HREF="${escape_html(node.url)}">${escape_html(node.title)}</A>`);
    }
  }
}

function build_header() {
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    `<!-- Merged bookmarks, generated ${new Date().toISOString()} -->`,
    '<META HTTP-EQUIV="Content-Security-Policy" CONTENT="default-src \'none\'; script-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    ''
  ];
}


// ---------- Main ----------

function merge_bookmarks() {
  try {
    if (input_1.value.trim() === '' && input_2.value.trim() === '') {
      output_area.value = '';
      return;
    }

    const root_folder = create_folder('');
    parse_into(input_1.value, root_folder);
    parse_into(input_2.value, root_folder);
    tidy_folder(root_folder);

    const lines = build_header();
    lines.push('<DL><p>');
    render_folder(root_folder, 1, lines);
    lines.push('</DL><p>', '');

    output_area.value = lines.join('\n');
  } catch (error) {
    output_area.value = `<!-- Merge failed: ${error.message} -->`;
  }
}

input_1.addEventListener('input', merge_bookmarks);
input_2.addEventListener('input', merge_bookmarks);
