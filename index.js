const FOLDERS_FIRST = false; // true: folders listed before bookmarks at each level
const a = document.getElementById('in1');
const b = document.getElementById('in2');
const o = document.getElementById('out');

const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Same-name folder under the same parent is reused, so folders merge.
const getFolder = (p, t) => {
  let f = p.c.find(x => x.f && x.t === t);
  if (!f) { f = { f: 1, t, c: [] }; p.c.push(f); }
  return f;
};

// Keeps only folder titles, bookmark titles and URLs. HR separators and all other attributes are dropped.
function walk(n, t, s) {
  for (const e of n.children) {
    const g = e.tagName;
    if (g === 'H3') s.l = getFolder(t, e.textContent);
    else if (g === 'A') { const h = e.getAttribute('href'); if (h !== null) t.c.push({ t: e.textContent, u: h }); }
    else if (g === 'DL') { const d = s.l || t; s.l = null; walk(e, d, s); }
    else if (g !== 'HR') walk(e, t, s);
  }
}

function parse(h, r) {
  if (h.trim()) walk(new DOMParser().parseFromString(h, 'text/html').body, r, { l: null });
}

// Drops URL duplicates within each folder (first kept, case-insensitive), then sorts by title.
function clean(n) {
  const seen = new Set(), k = [];
  for (const c of n.c) {
    if (c.f) { clean(c); k.push(c); }
    else {
      const x = c.u.toLowerCase();
      if (!seen.has(x)) { seen.add(x); k.push(c); }
    }
  }
  k.sort((x, y) => {
    if (FOLDERS_FIRST && !!x.f !== !!y.f) return x.f ? -1 : 1;
    const p = x.t.toLowerCase(), q = y.t.toLowerCase();
    return p < q ? -1 : p > q ? 1 : 0;
  });
  n.c = k;
}

function emit(n, i, L) {
  for (const c of n.c) {
    if (c.f) {
      L.push(i + '<DT><H3>' + esc(c.t) + '</H3>', i + '<DL><p>');
      emit(c, i + '    ', L);
      L.push(i + '</DL><p>');
    } else L.push(i + '<DT><A HREF="' + esc(c.u) + '">' + esc(c.t) + '</A>');
  }
}

function run() {
  if (!a.value.trim() && !b.value.trim()) { o.value = ''; return; }
  const r = { c: [] };
  parse(a.value, r);
  parse(b.value, r);
  clean(r);
  const L = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ];
  emit(r, '    ', L);
  L.push('</DL><p>');
  o.value = L.join('\n') + '\n';
}

a.addEventListener('input', run);
b.addEventListener('input', run);
