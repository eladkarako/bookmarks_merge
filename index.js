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

let uploadTarget = null;
let activeDownloadUrl = null;

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

function findOrCreateFolder(parent, title) {
  let folder = parent.children.find(
    node => node.kind === 'folder' && node.title === title
  );

  if (!folder) {
    folder = createFolder(title);
    parent.children.push(folder);
  }

  return folder;
}

function addBookmark(anchor, folder, state) {
  const url = anchor.getAttribute('href');

  if (url === null) return;

  // Gather step: the first bookmark with a given URL wins; later ones are never added.
  if (dedupeAcrossFolders) {
    if (state.seenUrls.has(url)) return;
    state.seenUrls.add(url);
  }

  folder.children.push({
    kind: 'bookmark',
    title: anchor.textContent,
    url
  });
}

function collectBookmarks(element, targetFolder, state) {
  for (const child of element.children) {
    const tagName = child.tagName;

    if (skippedTags.has(tagName)) continue;

    if (tagName === 'H3') {
      state.pendingFolder = findOrCreateFolder(
        targetFolder,
        child.textContent
      );
    } else if (tagName === 'A') {
      addBookmark(child, targetFolder, state);
    } else if (tagName === 'DL') {
      const ownerFolder = state.pendingFolder || targetFolder;
      state.pendingFolder = null;
      collectBookmarks(child, ownerFolder, state);
    } else {
      collectBookmarks(child, targetFolder, state);
    }
  }
}

function parseInto(rawHtml, rootFolder, seenUrls) {
  const cleanedHtml = rawHtml
    .replace(/^\uFEFF/, '')
    .replace(illegalCharacters, '');

  if (!cleanedHtml.trim()) return;

  const parsedDocument = new DOMParser().parseFromString(
    cleanedHtml,
    'text/html'
  );

  collectBookmarks(parsedDocument.body, rootFolder, {
    pendingFolder: null,
    seenUrls
  });
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

function renderFolder(folder, depth, lines) {
  const indent = indentUnit.repeat(depth);

  for (const node of folder.children) {
    if (node.kind === 'folder') {
      lines.push(`${indent}<DT><H3>${escapeHtml(node.title)}</H3>`);
      lines.push(`${indent}<DL><p>`);
      renderFolder(node, depth + 1, lines);
      lines.push(`${indent}</DL><p>`);

      if (depth === 1) lines.push('');
    } else {
      lines.push(
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
    const rootFolder = createFolder('');
    const seenUrls = new Set();

    parseInto(input1.value, rootFolder, seenUrls);
    parseInto(input2.value, rootFolder, seenUrls);
    tidyFolder(rootFolder);

    const lines = buildHeader();
    lines.push('<DL><p>');
    renderFolder(rootFolder, 1, lines);
    lines.push('</DL><p>', '');

    output.value = lines.join('\n');
  } catch (error) {
    output.value = `<!-- Merge failed: ${error.message} -->`;
  }
}

function openFile(target) {
  uploadTarget = target;
  filePicker.value = '';
  filePicker.click();
}

upload1.addEventListener('click', () => openFile(input1));
upload2.addEventListener('click', () => openFile(input2));

filePicker.addEventListener('change', async () => {
  const file = filePicker.files?.[0];

  if (!file || !uploadTarget) return;

  try {
    uploadTarget.value = await file.text();
    mergeBookmarks();
  } catch (error) {
    output.value = `<!-- Could not read file: ${error.message} -->`;
  } finally {
    uploadTarget = null;
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

  if (activeDownloadUrl) {
    URL.revokeObjectURL(activeDownloadUrl);
  }

  activeDownloadUrl = URL.createObjectURL(new Blob(
    [output.value],
    { type: 'text/html;charset=UTF-8' }
  ));

  downloadLink.href = activeDownloadUrl;
  downloadLink.download = filename;
  downloadLink.click();

  // Revoke after the browser has had a chance to start the download.
  setTimeout(() => {
    if (activeDownloadUrl) {
      URL.revokeObjectURL(activeDownloadUrl);
      activeDownloadUrl = null;
      downloadLink.removeAttribute('href');
    }
  }, 1000);
});
