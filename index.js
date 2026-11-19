const textarea1 = document.querySelectorAll('textarea["data-input1"]')
     ,textarea2 = document.querySelectorAll('textarea["data-input2"]')
     ,textarea3 = document.querySelectorAll('textarea["data-output"]')
     ,button1   = document.querySelectorAll('button["data-upload1"]')
     ,button2   = document.querySelectorAll('button["data-upload2"]')
     ,button3   = document.querySelectorAll('button["data-download"]')
     ,open_file = document.querySelectorAll('input[type="file"]')
     ,save_file = document.querySelectorAll('a[download]')
     ;

open_file.addEventListener("change", (ev)=>{
  if(!opener.files || 0 === opener.files.length){return false;}
  let target = open_file.getAttribute("data-target");
       if("textarea1" === target){ target = textarea1; }
  else if("textarea2" === target){ target = textarea2; }
  else if("textarea3" === target){ target = textarea3; }

  (async()=>{
    target.value = await open_file.files[0].text();
  })();
});

button1.addEventListener("click",(ev)=>{
  opener.value = "";
  opener.setAttribute("data-target","textarea1");
  opener.click();
},{capture:false, passive:false, once:false});

button2.addEventListener("click",(ev)=>{
  opener.value = "";
  opener.setAttribute("data-target","textarea1");
  opener.click();
},{capture:false, passive:false, once:false});

button3.addEventListener("click",(ev)=>{
  const date = new Date();
  save_file.download = date.toISOString()
                            .replace(/\..*$/,"")
                            .replace(/[\-\:]/ig,"")
                            .replace(/T/i,"_")
                      + ".html"
                      ;
  let href;
  try{
    href = new Blob([textarea3.value],{type:"text/html;charset=UTF-8"});
    href = new File([href], save_file.download, {"LastModified": date});
    save_file.href = self.URL.createObjectURL(href);
  }catch(err){
    try{
      save_file.href = "data:text/html;charset:UTF-8;base64,"
                      + btoa(unescape(encodeURIComponent(textarea3.value)));
    }catch(err){
      save_file.href = "data:text/html;charset:UTF-8," + encodeURIComponent(textarea3.value);
    }
  }

  save_file.click();

  try{
    self.URL.revokeObjectURL(save_file.href);
  }catch(err){}
  save_file.href = "";
},{capture:false, passive:false, once:false});




// true: folders are listed before bookmarks at every level.
// false: folders and bookmarks are sorted together by title.
const folders_first = false;

// Sorting options for titles. Set to false to disable a rule.
const ignore_leading_symbols = true;
const ignore_leading_articles = true;

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


// ---------- Natural compare (adapted from eladkarako's natural_compare.js gist) ----------

if (typeof Intl === 'undefined') {
  throw new Error('Intl is not available in this environment.');
}

const collator_options = {
  usage: 'sort',
  sensitivity: 'base',
  ignorePunctuation: false,
  numeric: true
};
const collator = new Intl.Collator(undefined, collator_options);

// Runs the extraction rule on a value before comparing it.
function extract_value(value) {
  const extraction_rule = natural_compare.extraction_rule || ((raw) => raw);
  return extraction_rule(value);
}

// Booleans become 0 or 1. null, undefined and NaN become 0.
function normalize_type(value) {
  let normalized = typeof value === 'boolean' ? Number(value) : value;
  normalized = (normalized == null || Number.isNaN(normalized)) ? 0 : normalized;
  return normalized;
}

// Compares two values in natural order: 1 < 2 < 10 < 20.
function natural_compare(first_value, second_value) {
  const first_normalized = normalize_type(extract_value(first_value));
  const second_normalized = normalize_type(extract_value(second_value));

  if (typeof first_normalized === 'number' && typeof second_normalized === 'number') {
    return (first_normalized > second_normalized) - (first_normalized < second_normalized);
  }

  const first_text = String(first_normalized);
  const second_text = String(second_normalized);

  // The code-unit tie-break keeps the order deterministic when the collator sees equal text.
  return collator.compare(first_text, second_text)
    || ((first_text > second_text) - (first_text < second_text));
}

// Pre-modifies a title before comparison so the sort focuses on the meaningful part.
function title_sort_key(raw_title) {
  let key = raw_title;
  if (ignore_leading_symbols) {
    key = key.replace(/^[^\p{L}\p{N}]+/u, '');   // [, #, quotes, emoji, punctuation
  }
  if (ignore_leading_articles) {
    key = key.replace(/^(the|a|an)\s+/i, '');     // "The Verge" sorts as "Verge"
  }
  return key;
}

natural_compare.extraction_rule = title_sort_key;


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
    .replace(/^\uFEFF/, '')            // byte order mark
    .replace(illegal_characters, '');  // illegal control characters
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
  return natural_compare(first_node.title, second_node.title);
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
