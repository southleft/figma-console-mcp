/**
 * Plugin-side scripts for figma_import_svg (spec §2.9) and figma_export_assets
 * (spec §3.5), run through EXECUTE_CODE so the Desktop Bridge plugin needs no
 * change or re-import.
 *
 * Contract with figma-desktop-bridge/code.js: it wraps the code in
 * `(async function() { … })()` and evals it, so bodies use top-level
 * await/return and never an inner async IIFE (issue #68). Tests run the same
 * strings with `new AsyncFunction("figma", script)`.
 *
 * Safety: user data enters ONLY through the `const P = <JSON>` line that
 * assetScript() writes (U+2028/U+2029 escaped). Bodies are static String.raw
 * constants with no `${` and no backticks (a test checks this), so nothing
 * can be spliced into the code. The first line is a fixed label for the
 * plugin's activity log and never holds user text.
 *
 * Sandbox syntax: no optional chaining, no nullish coalescing and no object
 * spread (the Figma sandbox has rejected them, see code.js), so these use
 * Object.assign and explicit checks.
 */

/** Labels allowed on the first line (fixed text plus a count). */
const LABEL_OK = /^[A-Za-z0-9 :(),-]{1,80}$/;

/** `// <label>` + the payload as a JSON literal + the body. */
export function assetScript(label: string, payload: unknown, body: string): string {
	if (!LABEL_OK.test(label)) throw new Error("assetScript label must be fixed text");
	const json = JSON.stringify(payload).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
	return `// ${label}\nconst P = ${json};\n${body}`;
}

/** Helpers shared by every import script (spec §2.9.1). Function declarations, so order doesn't matter. */
export const SVG_HELPERS = String.raw`
function msg(e) { return e && e.message ? e.message : String(e); }
function getNode(id) { return figma.getNodeByIdAsync(id); }
function walk(root, fn) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (fn(n) === false) continue;
    if ('children' in n && n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
}
function descendants(root) { const out = []; walk(root, function (n) { if (n !== root) out.push(n); }); return out; }
function hex(c) {
  return [c.r, c.g, c.b].map(function (v) { const s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16); return s.length < 2 ? '0' + s : s; }).join('');
}
function parseHex(h) { const s = h.charAt(0) === '#' ? h.slice(1) : h; return { r: parseInt(s.slice(0, 2), 16) / 255, g: parseInt(s.slice(2, 4), 16) / 255, b: parseInt(s.slice(4, 6), 16) / 255 }; }
function near(c, h, tol) {
  const t = tol === undefined ? 2 / 255 + 1e-9 : tol; const p = parseHex(h);
  return Math.abs(c.r - p.r) <= t && Math.abs(c.g - p.g) <= t && Math.abs(c.b - p.b) <= t;
}
const GEOM = ['VECTOR', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'BOOLEAN_OPERATION'];
const ART_TYPES = ['FRAME', 'GROUP', 'BOOLEAN_OPERATION', 'VECTOR', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE'];
function readRecord(n) { try { const s = n.getPluginData('svgImport'); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function article(word) { return /^[aeiou]/i.test(word) ? 'an ' + word : 'a ' + word; }
function eligibility(comp, set) {
  const rec = readRecord(comp);
  const textOk = !!(rec && rec.hasText);
  if (comp.layoutMode && comp.layoutMode !== 'NONE') return { eligible: false, why: 'it uses auto layout' };
  let why = null;
  const bad = comp.findOne(function (n) {
    if (n.type === 'TEXT') { if (textOk) return false; why = 'it contains a text layer'; return true; }
    if (n.type === 'INSTANCE') { why = 'it contains an instance layer'; return true; }
    if (ART_TYPES.indexOf(n.type) < 0) { why = 'it contains ' + article(n.type.toLowerCase().replace(/_/g, ' ')) + ' layer'; return true; }
    if (n.type === 'FRAME' && n.layoutMode && n.layoutMode !== 'NONE') { why = 'it uses auto layout'; return true; }
    const refs = n.componentPropertyReferences;
    if (refs && Object.keys(refs).length) { why = 'it has layers wired to component properties'; return true; }
    return false;
  });
  if (bad) return { eligible: false, why: why };
  let defs;
  try { defs = (set || comp).componentPropertyDefinitions; } catch (e) { return { error: 'variant errors' }; }
  for (const k in (defs || {})) {
    const t = defs[k] && defs[k].type;
    if (t === 'TEXT' || t === 'BOOLEAN' || t === 'INSTANCE_SWAP' || t === 'SLOT') {
      return { eligible: false, why: 'it has ' + article(t.toLowerCase().replace('_', ' ')) + ' property ("' + k.split('#')[0] + '")' };
    }
  }
  if (set) { try { const vp = comp.variantProperties; if (!vp) return { error: 'variant errors' }; } catch (e) { return { error: 'variant errors' }; } }
  return { eligible: true };
}
function setScaleConstraints(root) {
  walk(root, function (n) {
    if (n !== root && 'constraints' in n) { try { n.constraints = { horizontal: 'SCALE', vertical: 'SCALE' }; } catch (e) {} }
  });
}
function pageOf(node) { let n = node; while (n && n.type !== 'PAGE') n = n.parent; return n; }
function slideOf(node) { let n = node; while (n && n.type !== 'SLIDE') { if (n.type === 'PAGE') return null; n = n.parent; } return n || null; }
function insideInstance(node) { let n = node; while (n && n.type !== 'PAGE') { if (n.type === 'INSTANCE') return true; n = n.parent; } return false; }
function insideComponent(node) { let n = node; while (n && n.type !== 'PAGE') { if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') return true; n = n.parent; } return false; }
function clearSpot(parent, exclude) {
  const kids = ('children' in parent ? parent.children : []).filter(function (c) { return exclude.indexOf(c.id) < 0; });
  if (!kids.length) return { x: 0, y: 0 };
  if (parent.type === 'PAGE') {
    let right = -Infinity, top = Infinity;
    for (const c of kids) { right = Math.max(right, c.x + c.width); top = Math.min(top, c.y); }
    return { x: Math.round(right + 160), y: Math.round(top) };
  }
  let left = Infinity, bottom = -Infinity;
  for (const c of kids) { left = Math.min(left, c.x); bottom = Math.max(bottom, c.y + c.height); }
  return { x: Math.round(left), y: Math.round(bottom + 40) };
}
function label(editor) { return editor === 'figjam' ? 'FigJam' : editor === 'slides' ? 'Slides' : editor === 'dev' ? 'Dev Mode' : editor === 'figma' ? 'Figma Design' : String(editor); }
function within(promise, ms, fallback) {
  let timer;
  const guard = new Promise(function (resolve) { timer = setTimeout(function () { resolve(fallback); }, ms); });
  return Promise.race([Promise.resolve(promise).catch(function () { return fallback; }), guard]).then(function (v) { clearTimeout(timer); return v; });
}
function mul(a, b) {
  return [
    [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
    [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]]
  ];
}
function translate(dx, dy) { return [[1, 0, dx], [0, 1, dy]]; }
function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
function safeRemove(n) { try { if (n && !n.removed) n.remove(); } catch (e) {} }
// figma.variables is undefined in FigJam (live gate P0.2) and may throw on access: never touch it bare.
function variablesApi() { try { return figma.variables || null; } catch (e) { return null; } }
// Write steps carry the fileKey the preflight saw; a step that reaches another file changes nothing.
function wrongFile() {
  if (!P.fileKey) return null;
  let fk = null;
  try { fk = figma.fileKey || null; } catch (e) { fk = null; }
  return fk === P.fileKey ? null : 'This step reached a different Figma file than the one checked at the start of this call (another file became active), so nothing was changed in it.';
}
// Busy markers: check and take in one synchronous block (the plugin thread runs this without
// interleaving), and only ever remove our own, so a second run can't start while one is writing.
function claimMarker(own, other) {
  const now = Date.now();
  const names = [own, other];
  for (let i = 0; i < names.length; i++) {
    const m = globalThis[names[i]];
    if (m && now - m.startedAt < (P.busyStaleMs || 0)) {
      const what = names[i] === '__figmaConsoleImageImport' ? 'image' : 'SVG';
      return { refused: 'Another ' + what + ' import is still writing in Figma (started ' + Math.round((now - m.startedAt) / 1000) + ' s ago), so this step didn\'t start and nothing was changed. Wait for it to finish.' };
    }
  }
  const token = now + ':' + Math.random();
  globalThis[own] = { runId: P.runId, startedAt: now, token: token };
  return { token: token };
}
function releaseMarker(own, token) { const m = globalThis[own]; if (m && m.token === token) delete globalThis[own]; }
// Slides and clipping frames show only what's inside their bounds.
function boundedBox(p) {
  if (!p) return null;
  if (p.type === 'SLIDE' || ((p.type === 'FRAME' || p.type === 'COMPONENT') && p.clipsContent === true)) return { w: p.width, h: p.height, slide: p.type === 'SLIDE' };
  return null;
}
// Moves a node that landed outside its slide or clipping frame back inside; returns a note or null.
function keepVisible(node, center) {
  const b = boundedBox(node.parent);
  if (!b) return null;
  const w = node.width, h = node.height, tol = 0.5;
  if (node.x >= -tol && node.y >= -tol && node.x + w <= b.w + tol && node.y + h <= b.h + tol) return null;
  const where = b.slide ? 'the slide' : 'the frame "' + node.parent.name + '" (it clips its content)';
  let x, y, note;
  if (w > b.w + tol || h > b.h + tol) {
    x = (b.w - w) / 2; y = (b.h - h) / 2;
    note = '"' + node.name + '" is larger than ' + where + ', so it was centered and parts of it are cut off.';
  } else {
    if (center) { x = (b.w - w) / 2; y = (b.h - h) / 2; }
    else { x = Math.min(Math.max(node.x, 0), b.w - w); y = Math.min(Math.max(node.y, 0), b.h - h); }
    note = 'There was no free space inside ' + where + ', so "' + node.name + '" was placed inside its visible area and may overlap existing layers.';
  }
  node.x = Math.round(x); node.y = Math.round(y);
  return note;
}
`;

// ---------------------------------------------------------------------------
// Preflight (read-only): editor, parent, color, container, matches, resume.
// ---------------------------------------------------------------------------

const PREFLIGHT_MAIN = String.raw`
function normName(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function bigrams(s) { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; }
function similarity(a, b) { const x = bigrams(normName(a)), y = bigrams(normName(b)); if (!x.length || !y.length) return 0; let hit = 0; for (const g of x) if (y.indexOf(g) >= 0) hit++; return hit / Math.max(x.length, y.length); }
async function libraryColorVariables(filter) {
  const out = [];
  try {
    if (!figma.teamLibrary) return out;
    const cols = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const c of cols) {
      const vs = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key);
      for (const v of vs) {
        if (v.resolvedType !== 'COLOR') continue;
        const full = c.name + '/' + v.name;
        if (filter(v, full, c)) out.push({ key: v.key, name: v.name, collection: c.name, full: full, libraryName: c.libraryName });
      }
    }
  } catch (e) {}
  return out;
}
async function resolveColorVariable(ref) {
  const api = variablesApi();
  const vars = await api.getLocalVariablesAsync('COLOR');
  const cols = await api.getLocalVariableCollectionsAsync();
  const colName = {}; for (const c of cols) colName[c.id] = c.name;
  const full = function (v) { return (colName[v.variableCollectionId] || '') + '/' + v.name; };
  const tiers = [
    vars.filter(function (v) { return v.id === ref; }),
    vars.filter(function (v) { return v.name === ref; }),
    vars.filter(function (v) { return full(v) === ref; }),
    vars.filter(function (v) { return normName(v.name) === normName(ref) || normName(full(v)) === normName(ref); })
  ];
  for (const hits of tiers) {
    if (hits.length === 1) { const v = hits[0]; return { id: v.id, key: v.key, name: v.name, collection: colName[v.variableCollectionId] || '', label: full(v), remote: false }; }
    if (hits.length > 1) return { error: 'Several COLOR variables match ' + JSON.stringify(ref) + '; use Collection/name or the id.', options: hits.slice(0, 10).map(full) };
  }
  const n = normName(ref);
  const lib = await within(libraryColorVariables(function (v, f) { return v.name === ref || f === ref || normName(v.name) === n || normName(f) === n; }), 15000, []);
  if (lib && lib.length) {
    const list = lib.slice(0, 5).map(function (l) { return '"' + l.full + '" (variableKey "' + l.key + '")'; }).join(', ');
    return { error: 'No local COLOR variable named ' + JSON.stringify(ref) + '. Library matches: ' + list + '. Pass color.variableKey to use one.', options: lib.slice(0, 5).map(function (l) { return l.full; }) };
  }
  const close = vars.map(function (v) { return { f: full(v), s: similarity(full(v), ref) }; })
    .filter(function (x) { return x.s > 0.2; }).sort(function (a, b) { return b.s - a.s; }).slice(0, 5).map(function (x) { return x.f; });
  return { error: 'No COLOR variable named ' + JSON.stringify(ref) + ' in this file or its libraries.' + (close.length ? ' Close names: ' + close.map(function (c) { return '"' + c + '"'; }).join(', ') + '.' : ''), options: close };
}
async function findLibraryColorVariable(key) {
  const hits = await within(libraryColorVariables(function (v) { return v.key === key; }), 15000, []);
  if (!hits || !hits.length) return { error: 'No COLOR variable with key ' + JSON.stringify(key) + ' in the libraries this file uses. Enable the library in this file (Assets → Libraries) first.' };
  const h = hits[0];
  return { key: h.key, name: h.name, collection: h.collection, label: h.full, remote: true };
}
function sameProps(a, b, ci) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const f = function (s) { return ci ? String(s).toLowerCase() : String(s); };
  for (const k of kb) {
    const match = ka.filter(function (x) { return f(x) === f(k); })[0];
    if (match === undefined || f(a[match]) !== f(b[k])) return false;
  }
  return true;
}

const editor = figma.editorType;
const busy = globalThis.__figmaConsoleSvgImport;
if (busy && Date.now() - busy.startedAt < P.busyStaleMs)
  return { fatal: 'An earlier SVG import is still running in Figma (started ' + Math.round((Date.now() - busy.startedAt) / 1000) + ' s ago). Wait for it to finish, then run again.' };
// figma_import_image's marker: an image chunk that outlived its timeout is still writing too.
const busyImage = globalThis.__figmaConsoleImageImport;
if (busyImage && Date.now() - busyImage.startedAt < P.busyStaleMs)
  return { fatal: 'An earlier image import is still running in Figma (started ' + Math.round((Date.now() - busyImage.startedAt) / 1000) + ' s ago). Wait for it to finish, then run again.' };
if (typeof figma.createNodeFromSvg !== 'function') return { fatal: 'This Figma version has no SVG import in the Plugin API. Update Figma Desktop.' };
if (editor === 'dev') return { fatal: 'Dev Mode is read-only. Switch the file to Design mode (Shift+D) and run again.' };
const sup = P.editorSupport[editor];
if (!sup || !sup.vectors) return { fatal: "SVG import doesn't work in " + label(editor) + ' yet.' };
if (P.wantsComponents && !sup.components) return { fatal: 'Components and variant sets can only be made in Figma Design files. In ' + label(editor) + ', import plain vectors (leave out asComponent and variants).' };
if (P.color && (P.color.variable || P.color.variableKey) && (!sup.variableBinding || !variablesApi())) return { fatal: "Binding variables isn't available in " + label(editor) + '. Pass color.value instead.' };

let parent;
if (P.parentId) {
  parent = await figma.getNodeByIdAsync(P.parentId);
  if (!parent) return { fatal: 'Parent ' + P.parentId + ' not found. Node ids change between sessions; get a fresh one from the file.' };
  if (parent.type === 'PAGE') await parent.loadAsync();
  const inInst = parent.type !== 'PAGE' && insideInstance(parent);
  if (!('appendChild' in parent) || ['INSTANCE', 'COMPONENT_SET', 'BOOLEAN_OPERATION'].indexOf(parent.type) >= 0 || inInst)
    return { fatal: "Can't put layers inside a " + parent.type + (inInst && parent.type !== 'INSTANCE' ? ' inside an instance' : '') + '. Use a frame, section, group, page or slide.' };
  if (P.wantsComponents && insideComponent(parent))
    return { fatal: "Components can't be created inside another component. Use a section, frame or page outside it." };
  if (editor === 'slides' && parent.type !== 'SLIDE' && !slideOf(parent))
    return { fatal: 'In Slides, put the import on a slide: pass a slide id (figma_list_slides) or a frame inside one.' };
} else if (editor === 'slides') {
  parent = figma.currentPage.focusedSlide || figma.currentPage.selection.map(slideOf).filter(Boolean)[0];
  if (!parent) return { fatal: 'In Slides, pass parentId (a slide id from figma_list_slides) or focus a slide.' };
} else parent = figma.currentPage;

const parentPage = pageOf(parent);
const out = {
  editorType: editor, fileKey: figma.fileKey || null, fileName: figma.root.name,
  parent: { id: parent.id, type: parent.type, name: parent.name, autoLayout: !!(parent.layoutMode && parent.layoutMode !== 'NONE'), pageId: parentPage ? parentPage.id : null, pageName: parentPage ? parentPage.name : null, onCurrentPage: parentPage === figma.currentPage }
};

if (P.color && P.color.variable) {
  const r = await resolveColorVariable(P.color.variable);
  if (r.error) return { fatal: r.error, options: r.options };
  out.variable = r; out.colorRef = 'var:' + r.key;
} else if (P.color && P.color.variableKey) {
  const r = await findLibraryColorVariable(P.color.variableKey);
  if (r.error) return { fatal: r.error };
  out.variable = r; out.colorRef = 'var:' + P.color.variableKey;
} else if (P.color && P.color.value) {
  let p;
  try { p = figma.util.solidPaint(P.color.value); } catch (e) { return { fatal: 'Could not read color ' + JSON.stringify(P.color.value) + '. Use hex or a CSS color.' }; }
  out.colorRef = 'value:' + hex(p.color);
} else out.colorRef = 'inherit';

if (P.containerName && 'children' in parent) {
  const c = parent.children.filter(function (n) { return (n.type === 'SECTION' || n.type === 'FRAME') && n.name === P.containerName; })[0];
  if (c) out.container = { id: c.id, type: c.type, name: c.name, autoLayout: c.type === 'FRAME' && !!c.layoutMode && c.layoutMode !== 'NONE' };
}

if (P.resumeRunId) {
  // The whole parent: an interrupted run may have placed nodes in a container or straight in the parent.
  out.resumed = parent.findAllWithCriteria({ pluginData: { keys: ['svgImport'] } })
    .map(function (n) { return { n: n, r: readRecord(n) }; })
    .filter(function (x) { return x.r && x.r.runId === P.resumeRunId && x.r.source; })
    .map(function (x) { return { source: x.r.source, artHash: x.r.artHash, nodeId: x.n.id, type: x.n.type, width: x.n.width, height: x.n.height }; });
  const cps = globalThis.__figmaConsoleSvgCheckpoints;
  const cp = cps ? cps[(out.fileKey || '') + ':' + P.resumeRunId] : null;
  if (cp && cp.versionId) out.checkpoint = { versionId: cp.versionId };
}

out.matches = [];
if (P.matches.length) {
  if (P.matchScope === 'file') await figma.loadAllPagesAsync();
  const scope = P.matchScope === 'file' ? figma.root : parentPage;
  const index = new Map();
  for (const n of scope.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] })) {
    if (n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET') continue;
    if (n.remote) continue;
    if (!index.has(n.name)) index.set(n.name, []);
    index.get(n.name).push(n);
  }
  let counted = 0;
  const deadline = Date.now() + 10000;
  async function risk(target, publishTarget, cache) {
    if (counted >= P.maxCounted || Date.now() >= deadline) return { instanceCount: null, publish: 'UNKNOWN', counted: false };
    counted++;
    const inst = await within(target.getInstancesAsync(), 5000, null);
    let publish = cache ? cache.v : undefined;
    if (publish === undefined) {
      publish = await within(publishTarget.getPublishStatusAsync(), 3000, 'UNKNOWN');
      if (cache) cache.v = publish;
    }
    return { instanceCount: inst ? inst.length : null, publish: publish, firstInstance: inst && inst[0] ? inst[0].name : null, counted: true };
  }
  const isUnchanged = function (rec, m) { return !m.force && !!rec && rec.artHash === m.artHash && (out.colorRef === 'inherit' || rec.colorRef === out.colorRef); };
  for (const m of P.matches) {
    const all = index.get(m.name) || [];
    const wantType = m.kind === 'set' ? 'COMPONENT_SET' : 'COMPONENT';
    const r = { key: m.key };
    out.matches.push(r);
    if (!all.length) { r.status = 'none'; continue; }
    if (all.length > 1) { r.status = 'many'; r.count = all.length; r.ids = all.slice(0, 10).map(function (n) { return n.id; }); continue; }
    const node = all[0];
    if (node.type !== wantType) { r.status = 'kind-mismatch'; r.existingId = node.id; r.existingKind = node.type === 'COMPONENT_SET' ? 'set' : 'component'; continue; }
    r.status = 'one'; r.existingId = node.id;
    r.descriptionDiffers = m.description !== undefined && m.description !== node.description;
    if (m.kind === 'component') {
      const el = eligibility(node, null);
      if (el.error) { r.variantErrors = true; continue; }
      r.eligible = el.eligible;
      if (!el.eligible) { r.why = el.why; continue; }
      r.unchanged = isUnchanged(readRecord(node), m);
      r.width = node.width; r.height = node.height;
      if (!r.unchanged) Object.assign(r, await risk(node, node, null));
      continue;
    }
    let defs;
    try { defs = node.componentPropertyDefinitions; } catch (e) { r.variantErrors = true; continue; }
    r.axes = Object.keys(defs || {}).filter(function (k) { return defs[k].type === 'VARIANT'; });
    const children = node.children.filter(function (c) { return c.type === 'COMPONENT'; });
    const props = [];
    for (const c of children) { let vp = null; try { vp = c.variantProperties; } catch (e) { r.variantErrors = true; } props.push({ c: c, vp: vp }); }
    if (r.variantErrors) continue;
    const used = [];
    const cache = {};
    r.variants = [];
    for (const v of (m.variants || [])) {
      const vr = { key: v.key };
      let hit = props.filter(function (x) { return x.vp && used.indexOf(x.c.id) < 0 && sameProps(x.vp, v.props, false); })[0];
      if (hit) vr.matchedBy = 'exact';
      else {
        hit = props.filter(function (x) { return x.vp && used.indexOf(x.c.id) < 0 && sameProps(x.vp, v.props, true); })[0];
        if (hit) { vr.matchedBy = 'case-insensitive'; vr.matchedName = hit.c.name; }
      }
      r.variants.push(vr);
      if (!hit) { vr.existingId = null; continue; }
      used.push(hit.c.id);
      vr.existingId = hit.c.id;
      const el = eligibility(hit.c, node);
      if (el.error) { r.variantErrors = true; break; }
      vr.eligible = el.eligible;
      if (!el.eligible) { vr.why = el.why; continue; }
      // force is set on the set's query; a variant query may carry it too.
      vr.unchanged = isUnchanged(readRecord(hit.c), { artHash: v.artHash, force: m.force || v.force });
      vr.descriptionDiffers = v.description !== undefined && v.description !== hit.c.description;
      vr.width = hit.c.width; vr.height = hit.c.height;
      if (!vr.unchanged) Object.assign(vr, await risk(hit.c, node, cache));
    }
    r.untouched = children.length - used.length;
  }
}
return out;
`;

export const SVG_PREFLIGHT_BODY = SVG_HELPERS + PREFLIGHT_MAIN;

// ---------------------------------------------------------------------------
// Checkpoint: a named version before any risky update (spec §2.9.3).
// ---------------------------------------------------------------------------

export const SVG_CHECKPOINT_BODY = String.raw`
let fk = null;
try { fk = figma.fileKey || null; } catch (e) { fk = null; }
if (P.fileKey && fk !== P.fileKey) return { refused: 'This step reached a different Figma file than the one checked at the start of this call (another file became active), so nothing was changed in it.' };
figma.commitUndo();
const v = await figma.saveVersionHistoryAsync(P.title, P.description);
figma.commitUndo();
const versionId = v && v.id ? String(v.id) : null;
// A resumed run (same runId) reuses this version instead of saving another one.
if (versionId && P.runId) {
  const all = globalThis.__figmaConsoleSvgCheckpoints || {};
  const now = Date.now();
  for (const k in all) if (!all[k] || now - all[k].savedAt > 86400000) delete all[k];
  all[(fk || '') + ':' + P.runId] = { versionId: versionId, savedAt: now };
  globalThis.__figmaConsoleSvgCheckpoints = all;
}
return { versionId: versionId };
`;

// ---------------------------------------------------------------------------
// Container: reuse by name or create a section / wrapping frame (§2.9.4).
// ---------------------------------------------------------------------------

/**
 * Exported so figma_import_image can derive its container step
 * (./image-scripts.ts). Expects OWN_MARKER and OTHER_MARKER (the busy markers)
 * to be defined before it.
 */
export const CONTAINER_MAIN = String.raw`
const wrong = wrongFile();
if (wrong) return { refused: wrong };
const claim = claimMarker(OWN_MARKER, OTHER_MARKER);
if (claim.refused) return { refused: claim.refused };
try {
  figma.commitUndo();
  if (P.reuseId) {
    const c = await getNode(P.reuseId);
    if (c) return { id: c.id, type: c.type, name: c.name, created: false, autoLayout: c.type === 'FRAME' && !!c.layoutMode && c.layoutMode !== 'NONE' };
  }
  const parent = await getNode(P.parentId);
  if (!parent) throw new Error('Parent ' + P.parentId + ' not found.');
  if (parent.type === 'PAGE') await parent.loadAsync();
  let c;
  if (P.type === 'section') {
    c = figma.createSection();
  } else {
    c = figma.createFrame();
    c.fills = [];
    c.clipsContent = false;
    c.layoutMode = 'HORIZONTAL';
    c.layoutWrap = 'WRAP';
    c.itemSpacing = P.gap;
    c.counterAxisSpacing = P.gap;
    c.paddingTop = P.padding; c.paddingRight = P.padding; c.paddingBottom = P.padding; c.paddingLeft = P.padding;
    // resize() resets both sizing modes to FIXED, so it comes first and the modes after it.
    if (P.width) c.resize(P.width, Math.max(c.height, 1));
    c.primaryAxisSizingMode = 'FIXED';
    c.counterAxisSizingMode = 'AUTO';
  }
  c.name = P.name;
  const explicit = P.x !== undefined && P.x !== null && P.y !== undefined && P.y !== null;
  const spot = explicit ? { x: P.x, y: P.y } : clearSpot(parent, []);
  parent.appendChild(c);
  c.x = Math.round(spot.x);
  c.y = Math.round(spot.y);
  const notes = [];
  if (!explicit) { const nv = keepVisible(c, false); if (nv) notes.push(nv); }
  c.setPluginData('svgImport', JSON.stringify({ v: 1, kind: 'container', runId: P.runId }));
  return { id: c.id, type: c.type, name: c.name, created: true, autoLayout: P.type === 'frame', notes: notes };
} finally {
  try { figma.commitUndo(); } catch (e) {}
  releaseMarker(OWN_MARKER, claim.token);
}
`;

/** Busy-marker names for the SVG write steps (figma_import_image defines its own pair). */
export const SVG_MARKERS = String.raw`
const OWN_MARKER = '__figmaConsoleSvgImport';
const OTHER_MARKER = '__figmaConsoleImageImport';
`;

export const SVG_CONTAINER_BODY = SVG_HELPERS + SVG_MARKERS + CONTAINER_MAIN;

// ---------------------------------------------------------------------------
// Layout cursor (spec §2.6.6), shared by the SVG and image import chunks.
// Each chunk places its own new nodes and returns the cursor for the next one.
// Expects the body to define P.layout, `let cursor`, `results`, `notes` and
// `newTopLevelIds` (looked up when called, so declaration order is free).
// ---------------------------------------------------------------------------

export const LAYOUT_HELPERS = String.raw`
// One "placed inside the visible area" note per chunk is enough.
let visibleNoted = false;
function noteVisible(nv) { if (nv && !visibleNoted) { visibleNoted = true; notes.push(nv); } }
function initCursor(target) {
  const L = P.layout;
  let ox, oy;
  if (L.origin) { ox = L.origin.x; oy = L.origin.y; }
  else if (L.container && L.container.created) { ox = L.padding; oy = L.padding; }
  else if (target.type === 'PAGE') { const s = clearSpot(target, []); ox = s.x; oy = s.y; }
  else {
    const kids = target.children || [];
    if (kids.length) { let left = Infinity, bottom = -Infinity; for (const c of kids) { left = Math.min(left, c.x); bottom = Math.max(bottom, c.y + c.height); } ox = left; oy = bottom + L.gap; }
    else { ox = L.padding; oy = L.padding; }
  }
  return { index: 0, col: 0, x: Math.round(ox), y: Math.round(oy), rowH: 0, originX: Math.round(ox), originY: Math.round(oy) };
}

function place(node, asShelf) {
  const L = P.layout;
  if (L.mode === 'auto-layout') return;
  if (!cursor) return;
  const w = node.width, h = node.height;
  if (L.mode === 'grid' && !asShelf && L.cell) {
    const k = cursor.index, col = k % L.columns, row = Math.floor(k / L.columns);
    node.x = Math.round(cursor.originX + col * (L.cell.w + L.gap) + (L.cell.w - w) / 2);
    node.y = Math.round(cursor.originY + row * (L.cell.h + L.gap) + (L.cell.h - h) / 2);
    cursor.index++;
  } else {
    if (cursor.col >= L.columns) { cursor.x = cursor.originX; cursor.y = cursor.y + cursor.rowH + L.gap; cursor.rowH = 0; cursor.col = 0; }
    node.x = Math.round(cursor.x);
    node.y = Math.round(cursor.y);
    cursor.x = cursor.x + w + L.gap;
    cursor.rowH = Math.max(cursor.rowH, h);
    cursor.col++;
    cursor.index++;
  }
  // An explicit x/y wins; otherwise a slide or clipping frame must show the result.
  if (!L.origin) noteVisible(keepVisible(node, L.mode === 'single'));
}

function growContainer(target) {
  const L = P.layout;
  if (!L.container) return;
  if (!(target.type === 'SECTION' || (target.type === 'FRAME' && (!target.layoutMode || target.layoutMode === 'NONE')))) return;
  let right = 0, bottom = 0;
  for (const c of target.children) { right = Math.max(right, c.x + c.width); bottom = Math.max(bottom, c.y + c.height); }
  // A container this run created starts at the editor's default size (a FigJam section is
  // about 500x500), so it is fitted to its content; a reused one is only ever grown.
  // With nothing placed yet (every item failed), keep the starting size rather than shrink to a dot.
  const fitted = L.container.created && !P.layout.origin && target.children.length > 0;
  const w = fitted ? right + L.padding : Math.max(target.width, right + L.padding);
  const h = fitted ? bottom + L.padding : Math.max(target.height, bottom + L.padding);
  if (w !== target.width || h !== target.height) target.resizeWithoutConstraints(Math.round(w), Math.round(h));
}

// After each chunk: grow a frame/section container, and keep a container this run made inside its slide or clipping frame.
function settleContainer(target) {
  growContainer(target);
  if (P.layout.container && P.layout.container.created && !P.layout.origin && !P.layout.pinned) noteVisible(keepVisible(target, false));
}

async function focusResult(target) {
  const page = pageOf(target);
  if (page !== figma.currentPage) { notes.push('The result is on the page "' + (page ? page.name : '?') + '", so it wasn\'t selected (switching pages would interrupt you).'); return; }
  const ids = [];
  if (P.layout.container) ids.push(P.layout.container.id);
  else {
    for (const id of (P.focusIds || []).concat(newTopLevelIds)) if (ids.indexOf(id) < 0) ids.push(id);
    if (!ids.length) for (const r of results) if (r.nodeId && (r.status === 'updated' || r.status === 'unchanged')) ids.push(r.componentSetId || r.nodeId);
  }
  const nodes = [];
  for (const id of ids) { const n = await getNode(id); if (n && nodes.indexOf(n) < 0 && pageOf(n) === figma.currentPage) nodes.push(n); }
  if (!nodes.length) return;
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
}
`;

// ---------------------------------------------------------------------------
// Import one chunk (§2.9.5, geometry strategy §2.9.6).
// ---------------------------------------------------------------------------

const IMPORT_MAIN = String.raw`
const opts = P.opts;
const results = [];
const sets = [];
const newTopLevelIds = [];
const notes = [];
let cursor = P.layout.cursor;

function solidColor(css) { if (!css) return null; try { return figma.util.solidPaint(css).color; } catch (e) { return null; } }
function failed(item, stage, reason) { return { key: item.key, status: 'failed', stage: stage, reason: reason, notes: [] }; }

function restoreSentinel(root, item, itemNotes) {
  const refs = [];
  if (!item.sentinel) return refs;
  const fb = solidColor(item.rootColor) || { r: 0, g: 0, b: 0 };
  walk(root, function (n) {
    for (const prop of ['fills', 'strokes']) {
      if (!(prop in n)) continue;
      const paints = n[prop];
      if (!Array.isArray(paints)) continue;
      let changed = false;
      const next = paints.map(function (p, i) {
        if (p.type === 'SOLID' && near(p.color, item.sentinel)) { changed = true; refs.push({ node: n, prop: prop, index: i }); return Object.assign({}, p, { color: { r: fb.r, g: fb.g, b: fb.b } }); }
        if (p.gradientStops && p.gradientStops.some(function (s) { return near(s.color, item.sentinel); })) {
          changed = true;
          return Object.assign({}, p, { gradientStops: p.gradientStops.map(function (s) { return near(s.color, item.sentinel) ? Object.assign({}, s, { color: { r: fb.r, g: fb.g, b: fb.b, a: s.color.a } }) : s; }) });
        }
        return p;
      });
      if (changed) n[prop] = next;
    }
    if ('effects' in n && Array.isArray(n.effects) && n.effects.some(function (e) { return e.color && near(e.color, item.sentinel); })) {
      n.effects = n.effects.map(function (e) { return e.color && near(e.color, item.sentinel) ? Object.assign({}, e, { color: { r: fb.r, g: fb.g, b: fb.b, a: e.color.a } }) : e; });
    }
  });
  if (!refs.length) itemNotes.push("Couldn't locate the currentColor layers (the file's color profile may have converted colors); used the single-color rule instead.");
  return refs;
}

function flattenArt(root, refs, itemNotes) {
  const leaves = [];
  walk(root, function (n) {
    if (n === root) return true;
    if (n.visible === false) return false;
    if (GEOM.indexOf(n.type) >= 0) { leaves.push(n); return false; }
    return true;
  });
  if (leaves.length < 2) return refs;
  if (root.findOne(function (n) { return n.type === 'TEXT'; })) { itemNotes.push('flatten skipped: the SVG has text.'); return refs; }
  const isRef = function (n, prop, i) { return refs.some(function (r) { return r.node === n && r.prop === prop && r.index === i; }); };
  const special = leaves.some(function (n) {
    return n.isMask || ['fills', 'strokes'].some(function (prop) { return Array.isArray(n[prop]) && n[prop].some(function (p) { return p.type !== 'SOLID'; }); });
  });
  if (special) { itemNotes.push("flatten skipped: masks, gradients and images can't be merged."); return refs; }
  const val = function (x) { return x === figma.mixed ? 'mixed' : x; };
  const sig = function (n) {
    const ps = function (prop) { const a = n[prop]; if (!Array.isArray(a)) return 'mixed'; return a.map(function (p, i) { return isRef(n, prop, i) ? 'cc' : JSON.stringify(p); }); };
    return JSON.stringify([ps('fills'), ps('strokes'), val(n.strokeWeight), val(n.strokeAlign), val(n.strokeCap), val(n.strokeJoin), val(n.dashPattern), val(n.opacity), val(n.blendMode)]);
  };
  const s0 = sig(leaves[0]);
  if (!leaves.every(function (n) { return sig(n) === s0; })) { itemNotes.push('flatten skipped: layers have different colors or strokes.'); return refs; }
  const markers = { fills: [], strokes: [] };
  for (const prop of ['fills', 'strokes']) {
    const a = leaves[0][prop];
    if (Array.isArray(a)) a.forEach(function (p, i) { if (isRef(leaves[0], prop, i)) markers[prop].push(i); });
  }
  const v = figma.flatten(leaves, root);
  v.name = 'Vector';
  const kept = refs.filter(function (r) { return leaves.indexOf(r.node) < 0; });
  for (const prop of ['fills', 'strokes']) for (const i of markers[prop]) kept.push({ node: v, prop: prop, index: i });
  return kept;
}

function applyColor(root, plan, refs, itemNotes) {
  const targets = plan.targets;
  const solids = [];
  const distinct = [];
  let nonSolid = false;
  let regionFill = false;
  walk(root, function (n) {
    if (n === root) return true;
    for (const prop of targets) {
      if (!(prop in n)) continue;
      const ps = n[prop];
      if (!Array.isArray(ps)) continue;
      ps.forEach(function (p, i) {
        if (p.visible === false) return;
        if (p.type === 'SOLID') { solids.push({ node: n, prop: prop, index: i }); const h = hex(p.color); if (distinct.indexOf(h) < 0) distinct.push(h); }
        else nonSolid = true;
      });
    }
    if (n.type === 'VECTOR') { try { const net = n.vectorNetwork; if (net && net.regions && net.regions.some(function (r) { return r.fills && r.fills.length; })) regionFill = true; } catch (e) {} }
    return true;
  });
  if (regionFill) itemNotes.push("Some shapes carry per-region fills that weren't recolored.");
  let chosen, source;
  const cc = refs.filter(function (r) { if (targets.indexOf(r.prop) < 0) return false; const a = r.node[r.prop]; return Array.isArray(a) && a[r.index] && a[r.index].type === 'SOLID'; });
  if (plan.apply === 'currentColor' || (plan.apply === 'auto' && refs.length)) {
    if (!cc.length) return { applied: false, reason: 'no currentColor paints' };
    chosen = cc; source = 'currentColor';
  } else if (plan.apply === 'all') {
    chosen = solids; source = 'all';
  } else if (distinct.length === 1 && !nonSolid) {
    chosen = solids; source = 'single-color';
  } else if (!solids.length) {
    return { applied: false, reason: 'no solid paints' };
  } else {
    const list = distinct.slice(0, 5).map(function (h) { return '#' + h.toUpperCase(); }).join(', ') + (distinct.length > 5 ? ', …' : '');
    return { applied: false, reason: 'multi-color (' + list + '); left as is. Pass color.apply "all" to recolor everything.' };
  }
  if (!chosen.length) return { applied: false, reason: 'no solid paints' };
  const groups = new Map();
  for (const c of chosen) {
    if (!groups.has(c.node)) groups.set(c.node, { fills: [], strokes: [] });
    groups.get(c.node)[c.prop].push(c.index);
  }
  groups.forEach(function (byProp, node) {
    for (const prop of ['fills', 'strokes']) {
      if (!byProp[prop].length) continue;
      const arr = node[prop].slice();
      for (const i of byProp[prop]) {
        arr[i] = plan.variable ? variablesApi().setBoundVariableForPaint(arr[i], 'color', plan.variable) : Object.assign({}, arr[i], { color: { r: plan.value.r, g: plan.value.g, b: plan.value.b } });
      }
      node[prop] = arr;
    }
  });
  const res = { applied: true, mode: plan.variable ? 'variable' : 'value', source: plan.source || source, paints: chosen.length };
  if (plan.variable) res.variable = plan.label || plan.variable.name;
  else res.value = '#' + hex(plan.value).toUpperCase();
  return res;
}

function fitScale(node, box) {
  if (!box) return 1;
  let s = Infinity;
  if (box.w) s = Math.min(s, box.w / node.width);
  if (box.h) s = Math.min(s, box.h / node.height);
  if (!isFinite(s) || Math.abs(s - 1) < 1e-6) return 1;
  return s;
}

function fit(node, box, scaleStrokes) {
  const s = fitScale(node, box);
  if (s === 1) return;
  if (scaleStrokes) node.rescale(Math.max(s, 0.01));
  else { setScaleConstraints(node); node.resize(node.width * s, node.height * s); }
}

// Text layers can only be resized with their fonts loaded. Returns the first font that couldn't be, or null.
async function loadTextFonts(root) {
  if (typeof figma.loadFontAsync !== 'function' || typeof root.findAllWithCriteria !== 'function') return null;
  const seen = {};
  const fonts = [];
  let problem = null;
  for (const t of root.findAllWithCriteria({ types: ['TEXT'] })) {
    if (t.hasMissingFont && !problem) problem = 'a font that isn\'t installed';
    let names = [];
    try { names = t.fontName !== figma.mixed ? [t.fontName] : t.getRangeAllFontNames(0, t.characters.length); } catch (e) { names = []; }
    for (const f of names) {
      if (!f || !f.family) continue;
      const k = f.family + '\u0000' + f.style;
      if (!seen[k]) { seen[k] = true; fonts.push(f); }
    }
  }
  const failedFonts = [];
  await Promise.all(fonts.map(function (f) { return figma.loadFontAsync(f).catch(function () { failedFonts.push(f.family + ' ' + f.style); }); }));
  if (failedFonts.length) return failedFonts[0];
  return problem;
}

function squareUp(node, size) {
  const w = node.width, h = node.height;
  node.resizeWithoutConstraints(size, size);
  const dx = (size - w) / 2, dy = (size - h) / 2;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
  for (const c of node.children.slice()) { c.x = c.x + dx; c.y = c.y + dy; }
}

function boundVariableIds(root) {
  const ids = [];
  walk(root, function (n) {
    if (n === root) return true;
    for (const prop of ['fills', 'strokes']) {
      const ps = n[prop];
      if (!Array.isArray(ps)) continue;
      for (const p of ps) { const b = p.boundVariables && p.boundVariables.color; if (b && b.id && ids.indexOf(b.id) < 0) ids.push(b.id); }
    }
    return true;
  });
  return ids;
}

async function inheritedPlan(existing) {
  const api = variablesApi();
  if (!api) return null;
  const ids = boundVariableIds(existing);
  if (ids.length !== 1) return null;
  const v = await api.getVariableByIdAsync(ids[0]);
  if (!v) return null;
  let lbl = v.name;
  try { const col = await api.getVariableCollectionByIdAsync(v.variableCollectionId); if (col) lbl = col.name + '/' + v.name; } catch (e) {}
  return { variable: v, value: null, apply: 'auto', targets: ['fills', 'strokes'], label: lbl, source: 'inherited' };
}

function snapshot(o) {
  const s = { relativeTransform: clone(o.relativeTransform), fills: clone(o.fills), strokes: clone(o.strokes), effects: clone(o.effects), opacity: o.opacity, blendMode: o.blendMode, visible: o.visible,
    strokeWeight: o.strokeWeight, strokeAlign: o.strokeAlign, strokeCap: o.strokeCap, strokeJoin: o.strokeJoin, strokeMiterLimit: o.strokeMiterLimit, dashPattern: clone(o.dashPattern), net: clone(o.vectorNetwork) };
  if (o.strokeWeight === figma.mixed) s.sides = [o.strokeTopWeight, o.strokeRightWeight, o.strokeBottomWeight, o.strokeLeftWeight];
  return s;
}

function setIf(o, k, v) { if (v === undefined || v === figma.mixed) return; try { o[k] = v; } catch (e) {} }

function copyStrokeProps(o, src) {
  if (src.strokeWeight === figma.mixed) {
    setIf(o, 'strokeTopWeight', src.strokeTopWeight); setIf(o, 'strokeRightWeight', src.strokeRightWeight);
    setIf(o, 'strokeBottomWeight', src.strokeBottomWeight); setIf(o, 'strokeLeftWeight', src.strokeLeftWeight);
  } else setIf(o, 'strokeWeight', src.strokeWeight);
  setIf(o, 'strokeAlign', src.strokeAlign); setIf(o, 'strokeCap', src.strokeCap); setIf(o, 'strokeJoin', src.strokeJoin);
  setIf(o, 'strokeMiterLimit', src.strokeMiterLimit); setIf(o, 'dashPattern', clone(src.dashPattern));
  setIf(o, 'opacity', src.opacity); setIf(o, 'blendMode', src.blendMode); setIf(o, 'visible', src.visible); setIf(o, 'effects', clone(src.effects));
}

async function restoreSnapshot(o, s) {
  if (s.net) await o.setVectorNetworkAsync(s.net);
  o.relativeTransform = s.relativeTransform;
  if (s.sides) { o.strokeTopWeight = s.sides[0]; o.strokeRightWeight = s.sides[1]; o.strokeBottomWeight = s.sides[2]; o.strokeLeftWeight = s.sides[3]; }
  else setIf(o, 'strokeWeight', s.strokeWeight);
  setIf(o, 'strokeAlign', s.strokeAlign); setIf(o, 'strokeCap', s.strokeCap); setIf(o, 'strokeJoin', s.strokeJoin);
  setIf(o, 'strokeMiterLimit', s.strokeMiterLimit); setIf(o, 'dashPattern', s.dashPattern);
  setIf(o, 'opacity', s.opacity); setIf(o, 'blendMode', s.blendMode); setIf(o, 'visible', s.visible); setIf(o, 'effects', s.effects);
  setIf(o, 'fills', s.fills); setIf(o, 'strokes', s.strokes);
}

function regionFills(n) { try { const net = n.vectorNetwork; return !!(net && net.regions && net.regions.some(function (r) { return r.fills && r.fills.length; })); } catch (e) { return false; } }
function isLeaf(n) { return !('children' in n) || !n.children || n.children.length === 0; }

async function tryGeometry(C, F, dx, dy, keepOldPaints) {
  const A = descendants(C), B = descendants(F);
  if (A.length !== B.length) return { ok: false, why: 'layer count differs' };
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = B[i];
    if (a.type !== b.type) return { ok: false, why: 'layer types differ' };
    if ((isLeaf(a) ? 0 : a.children.length) !== (isLeaf(b) ? 0 : b.children.length)) return { ok: false, why: 'layer count differs' };
    if (!!a.isMask !== !!b.isMask) return { ok: false, why: 'layer types differ' };
    if (a.type === 'BOOLEAN_OPERATION' && a.booleanOperation !== b.booleanOperation) return { ok: false, why: 'layer types differ' };
  }
  const pairs = [];
  for (let i = 0; i < A.length; i++) {
    const a = A[i];
    if (!isLeaf(a)) { if (a.type !== 'GROUP' && a.type !== 'BOOLEAN_OPERATION') return { ok: false, why: 'nested frames' }; continue; }
    // createNodeFromSvg makes every SVG shape a VECTOR in every editor (live gate P0.6), so the
    // new side is always VECTOR and a pair can only line up on VECTOR leaves.
    if (a.type !== 'VECTOR') return { ok: false, why: 'unsupported layer type' };
    pairs.push([a, B[i]]);
  }
  if (!pairs.length) return { ok: false, why: 'no vector layers' };
  const t = C.absoluteTransform;
  if (Math.abs(t[0][1]) > 1e-6 || Math.abs(t[1][0]) > 1e-6 || Math.abs(t[0][0] - 1) > 1e-6 || Math.abs(t[1][1] - 1) > 1e-6) return { ok: false, why: 'rotated component' };
  if (!keepOldPaints) for (const pr of pairs) if (pr[1].type === 'VECTOR' && regionFills(pr[1])) return { ok: false, why: 'per-region fills' };
  const snaps = pairs.map(function (pr) { return snapshot(pr[0]); });
  const restore = async function () { for (let i = 0; i < pairs.length; i++) await restoreSnapshot(pairs[i][0], snaps[i]); };
  try {
    for (const pr of pairs) {
      const o = pr[0], n = pr[1];
      const net = clone(n.vectorNetwork);
      if (keepOldPaints && net.regions) for (const r of net.regions) { delete r.fills; delete r.fillStyleId; }
      await o.setVectorNetworkAsync(net);
      o.relativeTransform = mul(translate(dx, dy), n.relativeTransform);
      copyStrokeProps(o, n);
      if (!keepOldPaints) { o.fills = clone(n.fills); o.strokes = clone(n.strokes); }
    }
  } catch (e) {
    return { ok: false, applied: true, why: 'geometry update failed: ' + msg(e), restore: restore };
  }
  const cx = C.absoluteTransform[0][2], cy = C.absoluteTransform[1][2];
  const fx = F.absoluteTransform[0][2], fy = F.absoluteTransform[1][2];
  let worst = 0;
  for (const pr of pairs) {
    const ob = pr[0].absoluteBoundingBox, nb = pr[1].absoluteBoundingBox;
    if (!ob || !nb) continue;
    const tol = Math.max(0.01, 1e-4 * Math.max(nb.width, nb.height));
    const off = Math.max(Math.abs((ob.x - cx) - (nb.x - fx + dx)), Math.abs((ob.y - cy) - (nb.y - fy + dy)), Math.abs(ob.width - nb.width), Math.abs(ob.height - nb.height));
    if (off > tol) worst = Math.max(worst, off);
  }
  if (worst > 0) return { ok: false, applied: true, why: 'geometry check failed (off by ' + (Math.round(worst * 10) / 10) + ' px)', restore: restore };
  return { ok: true };
}

// tw/th: the component's size after the update. Nothing about C changes until the update goes ahead
// (a keepOverrides skip leaves it exactly as it was); st.changed records once it has.
function resizeTo(C, tw, th) { if (Math.abs(C.width - tw) > 1e-9 || Math.abs(C.height - th) > 1e-9) C.resizeWithoutConstraints(tw, th); }

async function replaceArtwork(C, F, tw, th, itemNotes, st) {
  const dx = (tw - F.width) / 2, dy = (th - F.height) / 2;
  const keepOldPaints = !opts.color && boundVariableIds(C).length > 0;
  const g = await tryGeometry(C, F, dx, dy, keepOldPaints);
  if (g.ok) { st.changed = true; resizeTo(C, tw, th); safeRemove(F); return { status: 'updated', update: { strategy: 'geometry', overridesKept: true } }; }
  if (g.applied) st.changed = true;
  if (opts.keepOverrides) {
    let restored = !g.applied;
    if (g.applied) {
      try { await g.restore(); restored = true; st.changed = false; }
      catch (e) { itemNotes.push('Restoring the earlier geometry failed (' + msg(e) + '), so the artwork was replaced instead.'); }
    }
    if (restored) {
      safeRemove(F);
      return { status: 'skipped', reason: 'Layer structure changed (' + g.why + '), so updating would reset instance overrides; left as is (keepOverrides).' };
    }
  }
  // Replace in one synchronous block: old children out, new ones in, centered in the target box.
  st.changed = true;
  resizeTo(C, tw, th);
  for (const k of C.children.slice()) k.remove();
  for (const k of F.children.slice()) { C.appendChild(k); k.x = k.x + dx; k.y = k.y + dy; }
  safeRemove(F);
  itemNotes.push('Layer structure changed (' + g.why + '), so overrides on the old layers reset in instances.');
  return { status: 'updated', update: { strategy: 'replace', overridesKept: false, fallbackReason: g.why } };
}

function tag(node, item, colorRef) {
  node.setPluginData('svgImport', JSON.stringify({ v: 1, runId: P.runId, artHash: item.artHash, colorRef: colorRef, source: item.source, hasText: !!item.hasText, importedAt: Date.now() }));
}

function variableColorRef(v) { return 'var:' + v.key; }

async function processItem(item, target, setCtx) {
  const itemNotes = [];
  const base = { key: item.key, notes: itemNotes };
  if (item.action === 'metadata') {
    const ex = await getNode(item.targetId);
    if (!ex) return { result: failed(item, 'process', 'The existing component ' + item.targetId + ' is gone; run again to create it.') };
    if (item.description !== undefined) ex.description = item.description;
    return { result: Object.assign(base, { status: 'unchanged', metadataUpdated: true, nodeId: ex.id, type: ex.type, width: ex.width, height: ex.height }) };
  }
  let existing = null;
  if (item.action === 'update') {
    existing = await getNode(item.targetId);
    if (!existing || existing.type !== 'COMPONENT') return { result: failed(item, 'process', 'The existing component ' + item.targetId + ' is gone; run again to create it.') };
    const owner = setCtx && setCtx.set ? setCtx.set : (existing.parent && existing.parent.type === 'COMPONENT_SET' ? existing.parent : null);
    const el = eligibility(existing, owner);
    if (el.error || !el.eligible) {
      return { result: Object.assign(base, { status: 'conflict', nodeId: existing.id, reason: '"' + existing.name + '" changed since the check and isn\'t plain vector artwork any more (' + (el.why || 'variant errors') + '), so it wasn\'t replaced.' }) };
    }
  }
  let frame;
  try { frame = figma.createNodeFromSvg(item.markup); }
  catch (e) { return { result: failed(item, 'import', 'Figma could not import this SVG: ' + msg(e)) }; }
  if (!frame || !frame.children || frame.children.length === 0 || !(frame.width > 0) || !(frame.height > 0)) {
    safeRemove(frame);
    return { result: failed(item, 'import', 'Figma imported nothing visible from this SVG.') };
  }
  // createNodeFromSvg gives the wrapping frame a white fill (seen live in FigJam and Slides).
  // Icons and illustrations need a transparent box, or they show a white square on any color.
  try { frame.fills = []; } catch (e) {}
  let node = frame;
  const st = { changed: false };
  try {
    // Loaded up front: rescale, resize and moving text into a component all need its fonts.
    const fontProblem = item.hasText ? await loadTextFonts(frame) : null;
    const cantScale = function (box) {
      if (!fontProblem || fitScale(node, box) === 1) return null;
      return "This SVG's text uses " + fontProblem + ", which Figma can't load, so it can't be resized. Convert the text to paths, or leave out size, width and height.";
    };
    if (!existing) {
      if (P.editorImportMode === 'group') { node = figma.group(frame.children.slice(), target); safeRemove(frame); }
      else target.appendChild(frame);
    }
    node.name = item.name;
    let refs = restoreSentinel(node, item, itemNotes);
    if (opts.flatten) refs = flattenArt(node, refs, itemNotes);
    let plan = null;
    let colorRef = opts.colorRef;
    if (opts.color) plan = { variable: variable, value: valueColor, apply: opts.color.apply, targets: opts.color.targets, label: opts.color.label, source: null };
    else if (existing) {
      plan = await inheritedPlan(existing);
      if (plan) colorRef = variableColorRef(plan.variable);
    }
    if (!plan && colorRef === 'inherit') colorRef = 'none';
    const color = plan ? applyColor(node, plan, refs, itemNotes) : undefined;
    if (existing) {
      const fitBox = opts.box ? opts.box : { w: existing.width, h: existing.height };
      const noScale = cantScale(fitBox);
      if (noScale) { safeRemove(frame); return { result: failed(item, 'process', noScale + ' The existing component was left as is.') }; }
      fit(node, fitBox, opts.scaleStrokes);
      // A new box resizes the component (to size×size for square icons, else to the fitted art),
      // but only once the update goes ahead: a skip leaves the component exactly as it was.
      let tw = existing.width, th = existing.height;
      if (opts.box) {
        tw = Math.max(opts.square && opts.box.w ? opts.box.w : node.width, 0.01);
        th = Math.max(opts.square && opts.box.h ? opts.box.h : node.height, 0.01);
      }
      const outcome = await replaceArtwork(existing, node, tw, th, itemNotes, st);
      if (outcome.status === 'skipped') return { result: Object.assign(base, { status: 'skipped', nodeId: existing.id, reason: outcome.reason }) };
      setScaleConstraints(existing);
      if (item.description !== undefined) existing.description = item.description;
      tag(existing, item, colorRef);
      return { result: Object.assign(base, { status: 'updated', nodeId: existing.id, type: existing.type, width: existing.width, height: existing.height, color: color, update: outcome.update }) };
    }
    const noScale = cantScale(opts.box);
    if (noScale) { if (node !== frame) safeRemove(node); safeRemove(frame); return { result: failed(item, 'process', noScale) }; }
    if (opts.box) fit(node, opts.box, opts.scaleStrokes);
    if (opts.square && opts.asComponent && opts.box && opts.box.w) squareUp(node, opts.box.w);
    if (opts.asComponent) {
      const comp = figma.createComponentFromNode(node);
      node = comp;
      setScaleConstraints(comp);
      if (item.description !== undefined) comp.description = item.description;
    }
    tag(node, item, colorRef);
    return { result: Object.assign(base, { status: 'created', nodeId: node.id, type: node.type, width: node.width, height: node.height, color: color }), node: node, placed: setCtx ? null : node };
  } catch (e) {
    // New items: remove whatever was made. Updates: the staging frame goes; the component is untouched
    // unless the failure came after its artwork started changing.
    if (node !== frame) safeRemove(node);
    safeRemove(frame);
    const why = !existing ? "Couldn't finish this SVG: "
      : st.changed ? 'Updating failed partway, so "' + existing.name + '" may be partly updated (restore the saved version if needed): '
      : 'Updating failed, so the existing component was left as is: ';
    return { result: failed(item, 'process', why + msg(e)) };
  }
}

function layoutNewSet(set, comps, axes) {
  const gap = 16, pad = 16;
  let cw = 0, ch = 0;
  for (const c of comps) { cw = Math.max(cw, c.node.width); ch = Math.max(ch, c.node.height); }
  const rows = [], cols = [];
  const keys = comps.map(function (c) {
    const props = c.item.props || {};
    if (axes.length < 2) return null;
    const rk = props[axes[0]], ck = axes.slice(1).map(function (a) { return props[a]; }).join('|');
    if (rows.indexOf(rk) < 0) rows.push(rk);
    if (cols.indexOf(ck) < 0) cols.push(ck);
    return { rk: rk, ck: ck };
  });
  comps.forEach(function (c, i) {
    const r = keys[i] ? rows.indexOf(keys[i].rk) : Math.floor(i / 12);
    const col = keys[i] ? cols.indexOf(keys[i].ck) : i % 12;
    c.node.x = Math.round(pad + col * (cw + gap) + (cw - c.node.width) / 2);
    c.node.y = Math.round(pad + r * (ch + gap) + (ch - c.node.height) / 2);
  });
  const nc = axes.length >= 2 ? cols.length : Math.min(12, comps.length);
  const nr = axes.length >= 2 ? rows.length : Math.ceil(comps.length / 12);
  set.resizeWithoutConstraints(pad * 2 + nc * cw + (nc - 1) * gap, pad * 2 + nr * ch + (nr - 1) * gap);
}

function placeNewVariants(set, added) {
  const gap = 16, pad = 16;
  let cw = 0, ch = 0, bottom = pad - gap;
  for (const c of set.children) { cw = Math.max(cw, c.width); ch = Math.max(ch, c.height); }
  for (const c of set.children) if (added.indexOf(c) < 0) bottom = Math.max(bottom, c.y + c.height);
  added.forEach(function (n, i) {
    const col = i % 12, row = Math.floor(i / 12);
    n.x = Math.round(pad + col * (cw + gap) + (cw - n.width) / 2);
    n.y = Math.round(bottom + gap + row * (ch + gap) + (ch - n.height) / 2);
  });
  let right = 0, low = 0;
  for (const c of set.children) { right = Math.max(right, c.x + c.width); low = Math.max(low, c.y + c.height); }
  set.resizeWithoutConstraints(Math.max(set.width, right + pad), Math.max(set.height, low + pad));
}

async function processSet(g, target) {
  const entry = { name: g.name, created: false, variants: 0, added: 0, updated: 0, untouched: g.untouched || 0 };
  if (g.action === 'create') {
    const comps = [];
    for (const it of g.variants) {
      const r = await processItem(it, target, { set: null });
      results.push(r.result);
      if (r.result.status === 'created' && r.node) comps.push({ node: r.node, item: it, result: r.result });
    }
    // No set was made: the items carry their reasons, and componentSets lists only sets that exist.
    if (!comps.length) return;
    let set;
    try { set = figma.combineAsVariants(comps.map(function (c) { return c.node; }), target); }
    catch (e) {
      for (const c of comps) { safeRemove(c.node); Object.assign(c.result, { status: 'failed', stage: 'process', reason: "Couldn't combine the variants into a set: " + msg(e) }); delete c.result.nodeId; }
      return;
    }
    set.name = g.name;
    if (g.description !== undefined) set.description = g.description;
    set.setPluginData('svgImport', JSON.stringify({ v: 1, kind: 'set', runId: P.runId }));
    layoutNewSet(set, comps, g.axes);
    set.strokes = [{ type: 'SOLID', color: { r: 0.592, g: 0.278, b: 1 } }];
    set.dashPattern = [10, 5];
    set.strokeWeight = 1;
    set.cornerRadius = 5;
    place(set, true);
    newTopLevelIds.push(set.id);
    for (const c of comps) c.result.componentSetId = set.id;
    Object.assign(entry, { id: set.id, created: true, variants: comps.length, added: comps.length });
    sets.push(entry);
    return;
  }
  const set = await getNode(g.setId);
  if (!set || set.type !== 'COMPONENT_SET') {
    for (const it of g.variants) results.push(failed(it, 'process', 'The component set ' + g.setId + ' is gone; run again to create it.'));
    return;
  }
  if (g.description !== undefined) set.description = g.description;
  const added = [];
  for (const it of g.variants) {
    const r = await processItem(it, target, { set: set });
    if (it.action === 'create' && r.result.status === 'created' && r.node) {
      try { set.appendChild(r.node); added.push(r.node); }
      catch (e) { safeRemove(r.node); Object.assign(r.result, { status: 'failed', stage: 'process', reason: "Couldn't add the variant to the set: " + msg(e) }); delete r.result.nodeId; }
    }
    if (r.result.status !== 'failed') r.result.componentSetId = set.id;
    if (r.result.status === 'updated') entry.updated++;
    results.push(r.result);
  }
  if (added.length && !(set.layoutMode && set.layoutMode !== 'NONE')) placeNewVariants(set, added);
  set.setPluginData('svgImport', JSON.stringify({ v: 1, kind: 'set', runId: P.runId }));
  Object.assign(entry, { id: set.id, variants: set.children.length, added: added.length });
  sets.push(entry);
}

let variable = null;
let valueColor = null;
const wrong = wrongFile();
if (wrong) return { refused: wrong };
const claim = claimMarker(OWN_MARKER, OTHER_MARKER);
if (claim.refused) return { refused: claim.refused };
try {
  figma.commitUndo();
  const target = await getNode(P.targetId);
  if (!target) throw new Error('The target layer ' + P.targetId + ' no longer exists.');
  if (target.type === 'PAGE') await target.loadAsync();
  if (opts.color && (opts.color.variableKey || opts.color.variableId) && !variablesApi()) throw new Error("Binding variables isn't available in this editor.");
  if (opts.color && opts.color.variableKey) variable = await variablesApi().importVariableByKeyAsync(opts.color.variableKey);
  else if (opts.color && opts.color.variableId) {
    variable = await variablesApi().getVariableByIdAsync(opts.color.variableId);
    if (!variable) throw new Error('The color variable ' + opts.color.variableId + ' is no longer in this file.');
  }
  if (opts.color && opts.color.value) valueColor = figma.util.solidPaint(opts.color.value).color;
  if (!cursor && P.layout.mode !== 'auto-layout') cursor = initCursor(target);
  for (const g of P.groups) {
    if (g.kind === 'single') {
      const r = await processItem(g.item, target, null);
      results.push(r.result);
      if (r.placed) { place(r.placed, false); newTopLevelIds.push(r.placed.id); }
    } else {
      await processSet(g, target);
    }
  }
  settleContainer(target);
  if (P.final && P.focus) await focusResult(target);
  return { results: results, sets: sets, cursor: cursor, newTopLevelIds: newTopLevelIds, notes: notes };
} finally {
  try { figma.commitUndo(); } catch (e) {}
  releaseMarker(OWN_MARKER, claim.token);
}
`;

export const SVG_IMPORT_BODY = SVG_HELPERS + SVG_MARKERS + LAYOUT_HELPERS + IMPORT_MAIN;

// ===========================================================================
// figma_export_assets (spec §3.4, §3.5)
// ===========================================================================

/**
 * Helpers for the export scripts. utf8Length is inlined because the Figma
 * sandbox isn't relied on to provide TextEncoder; b64len matches the server's
 * base64Length(), so an oversized render is refused before it is encoded and
 * never crosses the WebSocket.
 */
export const EXPORT_HELPERS = String.raw`
function msg(e) { return e && e.message ? e.message : String(e); }
function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}
function b64len(n) { return Math.ceil(n / 3) * 4; }
// Render steps carry the fileKey the preflight saw: node ids like 1:2 exist in every file.
function wrongFile() {
  if (!P.fileKey) return null;
  let fk = null;
  try { fk = figma.fileKey || null; } catch (e) { fk = null; }
  return fk === P.fileKey ? null : 'This export reached a different Figma file than the one checked at the start of this call (another file became active), so nothing was exported from it.';
}
`;

/**
 * Read-only. Resolves nodeIds (or the selection), loads PAGE nodes before
 * reading them, returns sizes and Export settings, and scans the subtrees for
 * image fills and vector art (icons, logos) within one shared layer budget.
 *
 * Vector art: a single VECTOR, BOOLEAN_OPERATION, STAR, POLYGON, ELLIPSE or
 * LINE; or a GROUP, FRAME or COMPONENT whose visible descendants are only
 * those plus RECTANGLE, GROUP and FRAME, with no image or video paint anywhere
 * and at least one geometry leaf that isn't a rectangle (a lone rectangle is a
 * background). Candidates are maximal (not descended into); instances count
 * when their main component is vector art, deduplicated by component key, so
 * forty copies of one icon export once.
 */
const EXPORT_PREFLIGHT_MAIN = String.raw`
const out = { editorType: figma.editorType, fileKey: null, nodes: [], missing: [], unsupported: [], vectors: [], vectorTotal: 0, images: [], imageTotal: 0, scanned: 0, scanTruncated: false, notes: [] };
try { out.fileKey = figma.fileKey || null; } catch (e) { out.fileKey = null; }
const VEC_LEAF = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'ELLIPSE', 'LINE'];
const VEC_OK = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'ELLIPSE', 'LINE', 'RECTANGLE', 'GROUP', 'FRAME'];
function kids(n) { return ('children' in n && n.children) ? n.children : []; }
function pageName(n) { let p = n; while (p && p.type !== 'PAGE') p = p.parent; return p ? p.name : ''; }
function variantOf(c) {
  if (!c || c.type !== 'COMPONENT' || !c.parent || c.parent.type !== 'COMPONENT_SET') return null;
  let vp = null;
  try { vp = c.variantProperties; } catch (e) { vp = null; }
  const values = [];
  if (vp) { for (const k in vp) values.push(String(vp[k])); }
  else String(c.name).split(',').forEach(function (part) { const i = part.indexOf('='); if (i > 0) values.push(part.slice(i + 1).trim()); });
  return { setName: c.parent.name, variant: values };
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
function sizeOf(n) {
  if (n.type === 'PAGE') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    for (const c of kids(n)) {
      const b = c.absoluteBoundingBox;
      if (!b) continue;
      let r = null;
      try { r = c.absoluteRenderBounds; } catch (e) { r = null; }
      if (!r) r = b;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
      rx0 = Math.min(rx0, r.x); ry0 = Math.min(ry0, r.y); rx1 = Math.max(rx1, r.x + r.width); ry1 = Math.max(ry1, r.y + r.height);
    }
    if (x0 === Infinity) return { width: 0, height: 0, renderW: 0, renderH: 0 };
    return { width: x1 - x0, height: y1 - y0, renderW: rx1 - rx0, renderH: ry1 - ry0 };
  }
  const w = num(n.width), h = num(n.height);
  let rb = null;
  try { rb = n.absoluteRenderBounds; } catch (e) { rb = null; }
  return { width: w, height: h, renderW: rb ? num(rb.width) : w, renderH: rb ? num(rb.height) : h };
}
function paintsOf(n) {
  const list = [];
  for (const k of ['fills', 'strokes']) {
    let v = null;
    try { v = n[k]; } catch (e) { v = null; }
    if (Array.isArray(v)) for (const p of v) list.push(p);
  }
  // Pages have backgrounds instead of fills; on frames backgrounds only mirror fills (deprecated), so they're skipped there.
  if (!('fills' in n) && 'backgrounds' in n) {
    let b = null;
    try { b = n.backgrounds; } catch (e) { b = null; }
    if (Array.isArray(b)) for (const p of b) list.push(p);
  }
  return list;
}
function hasMedia(n) {
  for (const p of paintsOf(n)) if (p && p.visible !== false && (p.type === 'IMAGE' || p.type === 'VIDEO')) return true;
  return false;
}
const imageMap = {};
const imageOrder = [];
function collectImages(n) {
  for (const p of paintsOf(n)) {
    if (!p || p.type !== 'IMAGE' || p.visible === false || !p.imageHash) continue;
    let e = imageMap[p.imageHash];
    if (!e) { e = imageMap[p.imageHash] = { hash: p.imageHash, usedBy: [], usedByCount: 0, seen: {} }; imageOrder.push(p.imageHash); }
    if (e.seen[n.id]) continue;
    e.seen[n.id] = true;
    e.usedByCount++;
    if (e.usedBy.length < 10) e.usedBy.push({ nodeId: n.id, name: n.name });
  }
}
let budget = P.maxScan;
const art = {};
function take() {
  if (budget <= 0) { out.scanTruncated = true; return false; }
  budget--; out.scanned++;
  return true;
}
// One post-order pass over a subtree (visible layers only: hidden ones don't render, so they
// neither count nor disqualify): collects image fills and records, per layer, whether it and
// everything under it is allowed vector content (ok) and whether it holds non-rectangle geometry.
function scan(root, images) {
  if (art[root.id] !== undefined) return true;
  if (!take()) return false;
  if (images) collectImages(root);
  const stack = [[root, 0]];
  // Out of budget: layers still open are marked "not vector art" so the selection walk can pass
  // through them to finished subtrees, while unscanned layers (no entry) are never walked.
  function stop() { for (const s of stack) art[s[0].id] = { ok: false, geom: false, media: false }; return false; }
  while (stack.length) {
    const top = stack[stack.length - 1];
    const n = top[0];
    const ch = kids(n);
    if (top[1] < ch.length) {
      const c = ch[top[1]++];
      if (c.visible === false || art[c.id] !== undefined) continue;
      if (!take()) return stop();
      if (images) collectImages(c);
      stack.push([c, 0]);
      continue;
    }
    stack.pop();
    const media = hasMedia(n);
    let ok = VEC_OK.indexOf(n.type) >= 0 && !media;
    let geom = VEC_LEAF.indexOf(n.type) >= 0;
    for (const c of ch) {
      if (c.visible === false) continue;
      const a = art[c.id];
      if (!a || !a.ok) ok = false;
      if (a && a.geom) geom = true;
    }
    art[n.id] = { ok: ok, geom: geom, media: media };
  }
  return true;
}
function isArt(n) {
  const a = art[n.id];
  if (!a || a.media) return false;
  if (VEC_LEAF.indexOf(n.type) >= 0) return a.ok;
  if (n.type !== 'GROUP' && n.type !== 'FRAME' && n.type !== 'COMPONENT') return false;
  if (!a.geom) return false;
  for (const c of kids(n)) {
    if (c.visible === false) continue;
    const ca = art[c.id];
    if (!ca || !ca.ok) return false;
  }
  return true;
}
const seenVec = {};
const mainIsArt = {};
function addVector(n, comp, foundIn) {
  out.vectorTotal++;
  if (out.vectors.length >= P.maxVectors) return;
  const v = { nodeId: n.id, name: n.name, type: n.type, foundIn: foundIn, width: num(n.width), height: num(n.height), page: pageName(n) };
  if (comp) {
    const vv = variantOf(comp);
    v.mainComponentName = vv ? vv.setName + '/' + vv.variant.join('-') : comp.name;
    if (comp.key) v.componentKey = comp.key;
    if (vv) { v.setName = vv.setName; v.variant = vv.variant; }
  }
  out.vectors.push(v);
}
// Pre-order over the scanned subtree: maximal candidates, document order.
async function selectVectors(root) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    // No entry = the scan never reached it (budget): don't walk it either, so this stays bounded.
    if (n.visible === false || art[n.id] === undefined) continue;
    if (n.type !== 'PAGE' && Math.max(num(n.width), num(n.height)) < 4) continue;
    if (n.type === 'INSTANCE') {
      let main = null;
      try { main = await n.getMainComponentAsync(); } catch (e) { main = null; }
      if (main) {
        const key = main.key || main.id;
        if (mainIsArt[key] === undefined) {
          let scanned = false;
          try { scanned = scan(main, false); } catch (e) { scanned = false; }
          mainIsArt[key] = scanned && isArt(main);
        }
        if (mainIsArt[key]) {
          if (!seenVec[key]) { seenVec[key] = true; addVector(n, main, root.id); }
          continue;
        }
      }
    } else if (isArt(n)) {
      const key = n.type === 'COMPONENT' ? (n.key || n.id) : 'node:' + n.id;
      if (!seenVec[key]) { seenVec[key] = true; addVector(n, n.type === 'COMPONENT' ? n : null, root.id); }
      continue;
    }
    const ch = kids(n);
    for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
  }
}

let targets = [];
if (P.nodeIds) {
  for (const id of P.nodeIds) {
    let n = null;
    try { n = await figma.getNodeByIdAsync(id); } catch (e) { n = null; }
    if (!n) out.missing.push(id); else targets.push(n);
  }
} else if (P.useSelection) {
  const sel = figma.currentPage.selection || [];
  out.selectionCount = sel.length;
  targets = sel.slice(0, P.maxNodes);
}
const valid = [];
for (const n of targets) {
  if (n.type === 'PAGE') { try { await n.loadAsync(); } catch (e) {} }
  if (!('exportAsync' in n) || typeof n.exportAsync !== 'function') { out.unsupported.push({ id: n.id, type: n.type }); continue; }
  const s = sizeOf(n);
  let settings = [];
  try { settings = JSON.parse(JSON.stringify(n.exportSettings || [])); } catch (e) { settings = []; }
  const info = { id: n.id, name: n.name, type: n.type, page: pageName(n), width: s.width, height: s.height, renderW: s.renderW, renderH: s.renderH, exportSettings: settings.slice(0, P.maxSettings) };
  if (settings.length > P.maxSettings) info.settingsTotal = settings.length;
  const v = variantOf(n);
  if (v) { info.setName = v.setName; info.variant = v.variant; }
  out.nodes.push(info);
  valid.push(n);
}
if (P.scanImages || P.scanVectors) {
  // Every requested subtree is scanned (with images) before the vector pass, which also scans the
  // main components of instances without images: a main that is itself requested, or inside a
  // requested node, must not be claimed by that image-less scan first.
  const done = [];
  for (const n of valid) {
    const complete = scan(n, P.scanImages);
    done.push(n);
    if (!complete || out.scanTruncated) break;
  }
  // Vectors in the finished part of a truncated subtree are still worth returning.
  if (P.scanVectors) for (const n of done) await selectVectors(n);
}
out.imageTotal = imageOrder.length;
out.images = imageOrder.slice(0, P.maxImages).map(function (h) { const e = imageMap[h]; return { hash: e.hash, usedBy: e.usedBy, usedByCount: e.usedByCount }; });
return out;
`;

export const EXPORT_PREFLIGHT_BODY = EXPORT_HELPERS + EXPORT_PREFLIGHT_MAIN;

/** One render. Oversized results come back as { tooLarge, bytes } instead of the data. */
const EXPORT_NODE_MAIN = String.raw`
const wrong = wrongFile();
if (wrong) return { refused: wrong };
const n = await figma.getNodeByIdAsync(P.id);
if (!n) return { error: 'Node ' + P.id + ' not found.' };
if (n.type === 'PAGE') await n.loadAsync();
if (!('exportAsync' in n)) return { error: n.type + ' layers can\'t be exported.' };
let out;
try { out = await n.exportAsync(P.settings); }
catch (e) { return { error: 'Figma could not export ' + n.name + ': ' + msg(e) }; }
if (typeof out === 'string') {
  const b = utf8Length(out);
  return b > P.maxBytes ? { tooLarge: true, bytes: b } : { svg: out, bytes: b };
}
const enc = b64len(out.length);
if (P.inlineBase64 ? enc > P.maxBase64 : out.length > P.maxBytes) return { tooLarge: true, bytes: out.length };
return { base64: figma.base64Encode(out), bytes: out.length };
`;

export const EXPORT_NODE_BODY = EXPORT_HELPERS + EXPORT_NODE_MAIN;

/** One original image behind an image fill, by hash. */
const EXPORT_IMAGE_MAIN = String.raw`
const wrong = wrongFile();
if (wrong) return { refused: wrong };
const img = figma.getImageByHash(P.hash);
if (!img) return { error: 'missing' };
let bytes;
try { bytes = await img.getBytesAsync(); } catch (e) { return { error: 'Figma could not read the image: ' + msg(e) }; }
let size = { width: 0, height: 0 };
try { size = await img.getSizeAsync(); } catch (e) {}
const info = { bytes: bytes.length, width: size.width, height: size.height };
const enc = b64len(bytes.length);
if (P.inlineBase64 ? enc > P.maxBase64 : bytes.length > P.maxBytes) return Object.assign({ tooLarge: true }, info);
return Object.assign({ base64: figma.base64Encode(bytes) }, info);
`;

export const EXPORT_IMAGE_BODY = EXPORT_HELPERS + EXPORT_IMAGE_MAIN;

/** Export bodies, for the same static checks. */
export const ALL_EXPORT_BODIES: Readonly<Record<string, string>> = {
	EXPORT_HELPERS,
	EXPORT_PREFLIGHT_BODY,
	EXPORT_NODE_BODY,
	EXPORT_IMAGE_BODY,
};

/** Every body, for the static checks in the tests. */
export const ALL_SVG_BODIES: Readonly<Record<string, string>> = {
	SVG_HELPERS,
	SVG_MARKERS,
	SVG_PREFLIGHT_BODY,
	SVG_CHECKPOINT_BODY,
	SVG_CONTAINER_BODY,
	SVG_IMPORT_BODY,
};
