'use strict';

const input1 = document.querySelector('[data-input1]');
const input2 = document.querySelector('[data-input2]');
const output = document.querySelector('[data-output]');
const upload1 = document.querySelector('[data-upload1]');
const upload2 = document.querySelector('[data-upload2]');
const downloadButton = document.querySelector('[data-download]');
const filePicker = document.querySelector('[data-file-picker]');
const downloadLink = document.querySelector('[data-download-link]');

const foldersFirst = true;
const ignoreLeadingSymbols = true;
const ignoreLeadingArticles = true;
const indentUnit = '    ';

const dedupeAcrossFolders = false; // true: keep only the first occurrence of each exact URL in the whole tree.
const removeEmptyFolders = false;  // true: drop folders that end up with no bookmarks, including nested ones.

const illegalCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const skippedTags = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
  'HEAD', 'TITLE', 'META', 'LINK', 'HR'
]);

const collator = new Intl.Collator(undefined, {
  usage: 'sort',
  sensitivity: 'base',
  ignorePunctuation: false,
  numeric: true
});

// Shared working state for a single merge. Reset at the start of every merge.
const db = {
  root: null,           // Root folder of the merged tree.
  currentFolder: null,  // Folder that new bookmarks and sub-folders are added to.
  pendingFolder: null,  // Folder opened by the last H3, waiting for its DL.
  seenUrls: new Set(),  // Exact URLs already gathered (used when dedupeAcrossFolders is on).
  lines: [],            // Output lines being rendered.
  depth: 1,             // Current indentation depth while rendering.
  uploadTarget: null,   // Textarea waiting for a picked file.
  activeDownloadUrl: null
};

function resetDb() {
  db.root = createFolder('');
  db.currentFolder = db.root;
  db.pendingFolder = null;
  db.seenUrls = new Set();
  db.lines = [];
  db.depth = 1;
}

function titleSortKey(title) {
  let key = title;

  if (ignoreLeadingSymbols) {
    key = key.replace(/^[^\p{L}\p{N}]+/u, '');
  }

  if (ignoreLeadingArticles) {
    key = key.replace(/^(the|a|an)\s+/i, '');
  }

  return key;
}

function compareTitles(first, second) {
  const firstKey = titleSortKey(first);
  const secondKey = titleSortKey(second);

  return collator.compare(firstKey, secondKey)
    || ((firstKey > secondKey) - (firstKey < secondKey));
}

function createFolder(title) {
  return { kind: 'folder', title, children: [] };
}

function findOrCreateFolder(title) {
  let folder = db.currentFolder.children.find(
    node => node.kind === 'folder' && node.title === title
  );

  if (!folder) {
    folder = createFolder(title);
    db.currentFolder.children.push(folder);
  }

  return folder;
}

function addBookmark(anchor) {
  const url = anchor.getAttribute('href');

  if (url === null) return;

  // Gather step: the first bookmark with a given URL wins; later ones are never added.
  if (dedupeAcrossFolders) {
    if (db.seenUrls.has(url)) return;
    db.seenUrls.add(url);
  }

  db.currentFolder.children.push({
    kind: 'bookmark',
    title: anchor.textContent,
    url
  });
}

function collectBookmarks(element) {
  for (const child of element.children) {
    const tagName = child.tagName;

    if (skippedTags.has(tagName)) continue;

    if (tagName === 'H3') {
      db.pendingFolder = findOrCreateFolder(child.textContent);
    } else if (tagName === 'A') {
      addBookmark(child);
    } else if (tagName === 'DL') {
      const ownerFolder = db.pendingFolder || db.currentFolder;
      const previousFolder = db.currentFolder;

      db.pendingFolder = null;
      db.currentFolder = ownerFolder;
      collectBookmarks(child);
      db.currentFolder = previousFolder;
    } else {
      collectBookmarks(child);
    }
  }
}

function parseInto(rawHtml) {
  const cleanedHtml = rawHtml
    .replace(/^\uFEFF/, '')
    .replace(illegalCharacters, '');

  if (!cleanedHtml.trim()) return;

  const parsedDocument = new DOMParser().parseFromString(
    cleanedHtml,
    'text/html'
  );

  db.currentFolder = db.root;
  db.pendingFolder = null;
  collectBookmarks(parsedDocument.body);
}

function compareNodes(first, second) {
  if (foldersFirst && first.kind !== second.kind) {
    return first.kind === 'folder' ? -1 : 1;
  }

  return compareTitles(first.title, second.title);
}

function tidyFolder(folder) {
  const seenUrls = new Set();
  const keptNodes = [];

  for (const node of folder.children) {
    if (node.kind === 'folder') {
      tidyFolder(node);

      // Children are tidied first, so a folder that only held duplicates or
      // empty sub-folders is already empty by the time it is checked here.
      if (removeEmptyFolders && node.children.length === 0) continue;

      keptNodes.push(node);
      continue;
    }

    const urlKey = node.url.toLowerCase();

    if (!seenUrls.has(urlKey)) {
      seenUrls.add(urlKey);
      keptNodes.push(node);
    }
  }

  keptNodes.sort(compareNodes);
  folder.children = keptNodes;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderFolder(folder) {
  const depth = db.depth;
  const indent = indentUnit.repeat(depth);

  for (const node of folder.children) {
    if (node.kind === 'folder') {
      db.lines.push(`${indent}<DT><H3>${escapeHtml(node.title)}</H3>`);
      db.lines.push(`${indent}<DL><p>`);

      db.depth++;
      renderFolder(node);
      db.depth--;

      db.lines.push(`${indent}</DL><p>`);

      if (depth === 1) db.lines.push('');
    } else {
      db.lines.push(
        `${indent}<DT><A HREF="${escapeHtml(node.url)}">${escapeHtml(node.title)}</A>`
      );
    }
  }
}

function buildHeader() {
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

function mergeBookmarks() {
  if (!input1.value.trim() && !input2.value.trim()) {
    output.value = '';
    return;
  }

  try {
    resetDb();

    parseInto(input1.value);
    parseInto(input2.value);
    tidyFolder(db.root);

    db.lines = buildHeader();
    db.lines.push('<DL><p>');
    renderFolder(db.root);
    db.lines.push('</DL><p>', '');

    output.value = db.lines.join('\n');
  } catch (error) {
    output.value = `<!-- Merge failed: ${error.message} -->`;
  }
}

function openFile(target) {
  db.uploadTarget = target;
  filePicker.value = '';
  filePicker.click();
}

upload1.addEventListener('click', () => openFile(input1));
upload2.addEventListener('click', () => openFile(input2));

filePicker.addEventListener('change', async () => {
  const file = filePicker.files?.[0];

  if (!file || !db.uploadTarget) return;

  try {
    db.uploadTarget.value = await file.text();
    mergeBookmarks();
  } catch (error) {
    output.value = `<!-- Could not read file: ${error.message} -->`;
  } finally {
    db.uploadTarget = null;
  }
});

input1.addEventListener('input', mergeBookmarks);
input2.addEventListener('input', mergeBookmarks);

downloadButton.addEventListener('click', () => {
  if (!output.value) return;

  const now = new Date();
  const filename = `${now.toISOString()
    .replace(/\..*$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '_')}.html`;

  if (db.activeDownloadUrl) {
    URL.revokeObjectURL(db.activeDownloadUrl);
  }

  db.activeDownloadUrl = URL.createObjectURL(new Blob(
    [output.value],
    { type: 'text/html;charset=UTF-8' }
  ));

  downloadLink.href = db.activeDownloadUrl;
  downloadLink.download = filename;
  downloadLink.click();

  // Revoke after the browser has had a chance to start the download.
  setTimeout(() => {
    if (db.activeDownloadUrl) {
      URL.revokeObjectURL(db.activeDownloadUrl);
      db.activeDownloadUrl = null;
      downloadLink.removeAttribute('href');
    }
  }, 1000);
});
