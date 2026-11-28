/**
 * Plugin-side scripts for figma_import_image (spec §10.4), run through
 * EXECUTE_CODE with assetScript() like the SVG scripts in ./plugin-scripts.ts,
 * and under the same contract: top-level await/return with no inner async
 * IIFE, user data only in the `const P = <JSON>` line, static String.raw
 * bodies with no `${` and no backticks, and no optional chaining, nullish
 * coalescing or object spread (the Figma sandbox has rejected them).
 *
 * It reuses figma_set_image_fill's plugin approach (createImage → imageHash →
 * an IMAGE paint that replaces fills), decoding base64 with
 * figma.base64Decode in the plugin instead of in ui.html, so the bridge needs
 * no change.
 */

import { CONTAINER_MAIN, LAYOUT_HELPERS, SVG_HELPERS } from "./plugin-scripts.js";

/** Helpers for the image bodies; displaySize mirrors image-plan.ts (a test keeps them in step). */
const IMAGE_HELPERS = String.raw`
function displaySize(pw, ph, density, box, fit) {
  let w = pw / density, h = ph / density;
  if (box && box.w !== undefined && box.h !== undefined) {
    if (fit === 'exact') { w = box.w; h = box.h; }
    else { const s = Math.min(box.w / w, box.h / h); w = w * s; h = h * s; }
  } else if (box && box.w !== undefined) { h = h * box.w / w; w = box.w; }
  else if (box && box.h !== undefined) { w = w * box.h / h; h = box.h; }
  return { w: Math.max(0.01, Math.round(w * 100) / 100), h: Math.max(0.01, Math.round(h * 100) / 100) };
}
function imagePaint(hash, pw, ph, nw, nh, density, scaleMode) {
  const p = { type: 'IMAGE', imageHash: hash, scaleMode: scaleMode };
  // CROP: a centered "cover" crop, so it looks like FILL but the crop stays editable.
  // imageTransform maps the layer's unit square into the image's unit square.
  if (scaleMode === 'CROP' && nw > 0 && nh > 0 && pw > 0 && ph > 0) {
    const ai = pw / ph, an = nw / nh;
    if (an > ai) { const k = ai / an; p.imageTransform = [[1, 0, 0], [0, k, (1 - k) / 2]]; }
    else { const k = an / ai; p.imageTransform = [[k, 0, (1 - k) / 2], [0, 1, 0]]; }
  }
  if (scaleMode === 'TILE') p.scalingFactor = 1 / density;
  return p;
}
function readImageRecord(n) { try { const s = n.getPluginData('imageImport'); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function busyFor(marker, what) {
  if (marker && Date.now() - marker.startedAt < P.busyStaleMs)
    return 'An earlier ' + what + ' import is still running in Figma (started ' + Math.round((Date.now() - marker.startedAt) / 1000) + ' s ago). Wait for it to finish, then run again.';
  return null;
}
`;

// ---------------------------------------------------------------------------
// Preflight (read-only): busy markers, editor, parent, container, resume,
// fill targets.
// ---------------------------------------------------------------------------

const IMAGE_PREFLIGHT_MAIN = String.raw`
const editor = figma.editorType;
const busy = busyFor(globalThis.__figmaConsoleImageImport, 'image') || busyFor(globalThis.__figmaConsoleSvgImport, 'SVG');
if (busy) return { fatal: busy };
if (typeof figma.createImage !== 'function' || typeof figma.base64Decode !== 'function') return { fatal: 'This Figma version has no image upload in the Plugin API. Update Figma Desktop.' };
if (editor === 'dev') return { fatal: 'Dev Mode is read-only. Switch the file to Design mode (Shift+D) and run again.' };
const out = { editorType: editor, fileKey: figma.fileKey || null, fileName: figma.root.name, targets: [] };

// The parent matters only when new layers are made; fills alone never touch it.
if (P.creates > 0) {
  let parent;
  if (P.parentId) {
    parent = await figma.getNodeByIdAsync(P.parentId);
    if (!parent) return { fatal: 'Parent ' + P.parentId + ' not found. Node ids change between sessions; get a fresh one from the file.' };
    if (parent.type === 'PAGE') await parent.loadAsync();
    const inInst = parent.type !== 'PAGE' && insideInstance(parent);
    if (!('appendChild' in parent) || ['INSTANCE', 'COMPONENT_SET', 'BOOLEAN_OPERATION'].indexOf(parent.type) >= 0 || inInst)
      return { fatal: "Can't put layers inside a " + parent.type + (inInst && parent.type !== 'INSTANCE' ? ' inside an instance' : '') + '. Use a frame, section, group, page or slide.' };
    if (editor === 'slides' && parent.type !== 'SLIDE' && !slideOf(parent))
      return { fatal: 'In Slides, put the images on a slide: pass a slide id (figma_list_slides) or a frame inside one.' };
  } else if (editor === 'slides') {
    parent = figma.currentPage.focusedSlide || figma.currentPage.selection.map(slideOf).filter(Boolean)[0];
    if (!parent) return { fatal: 'In Slides, pass parentId (a slide id from figma_list_slides) or focus a slide.' };
  } else parent = figma.currentPage;
  const parentPage = pageOf(parent);
  out.parent = { id: parent.id, type: parent.type, name: parent.name, autoLayout: !!(parent.layoutMode && parent.layoutMode !== 'NONE'), pageId: parentPage ? parentPage.id : null, pageName: parentPage ? parentPage.name : null, onCurrentPage: parentPage === figma.currentPage };
  if (P.containerName && 'children' in parent) {
    const c = parent.children.filter(function (n) { return (n.type === 'SECTION' || n.type === 'FRAME') && n.name === P.containerName; })[0];
    if (c) out.container = { id: c.id, type: c.type, name: c.name, autoLayout: c.type === 'FRAME' && !!c.layoutMode && c.layoutMode !== 'NONE' };
  }
  if (P.resumeRunId) {
    // The whole parent: an interrupted run may have placed layers in a container or straight in the parent.
    out.resumed = parent.findAllWithCriteria({ pluginData: { keys: ['imageImport'] } })
      .map(function (n) { return { n: n, r: readImageRecord(n) }; })
      .filter(function (x) { return x.r && x.r.runId === P.resumeRunId && x.r.source; })
      .map(function (x) { return { source: x.r.source, hash: x.r.hash, nodeId: x.n.id, type: x.n.type, width: x.n.width, height: x.n.height, imageHash: x.r.imageHash }; });
  }
}

for (const id of P.targetIds) {
  let n = null;
  try { n = await figma.getNodeByIdAsync(id); } catch (e) { n = null; }
  if (!n) { out.targets.push({ id: id, found: false }); continue; }
  const t = { id: id, found: true, type: n.type, name: n.name };
  if (!('fills' in n) || n.type === 'PAGE' || n.type === 'DOCUMENT') { t.fillable = false; t.why = 'is ' + article(n.type) + ', which has no fills'; }
  else { t.fillable = true; t.width = n.width; t.height = n.height; }
  out.targets.push(t);
}
return out;
`;

export const IMAGE_PREFLIGHT_BODY = SVG_HELPERS + IMAGE_HELPERS + IMAGE_PREFLIGHT_MAIN;

/** Busy-marker names for the image write steps: own marker first, the SVG import's second. */
const IMAGE_MARKERS = String.raw`
const OWN_MARKER = '__figmaConsoleImageImport';
const OTHER_MARKER = '__figmaConsoleSvgImport';
`;

/**
 * §2.9.4's container step with the image busy markers and plugin-data key, so
 * the SVG import's busy check and resume lookup stay about SVG imports.
 * Derived once from static text; no user data is involved.
 */
export const IMAGE_CONTAINER_BODY = SVG_HELPERS + IMAGE_MARKERS + CONTAINER_MAIN.split("'svgImport'").join("'imageImport'");

// ---------------------------------------------------------------------------
// Import one chunk: decode, createImage, then a new layer or the fills of
// existing layers. Layout comes from LAYOUT_HELPERS (spec §2.6.6).
// ---------------------------------------------------------------------------

const IMAGE_IMPORT_MAIN = String.raw`
const opts = P.opts;
const results = [];
const newTopLevelIds = [];
const notes = [];
let cursor = P.layout.cursor;

async function loadImage(it) {
  const itemNotes = [];
  let bytes;
  try { bytes = figma.base64Decode(it.data); } catch (e) { return { error: "Figma couldn't decode the image data: " + msg(e) }; }
  let image;
  try { image = figma.createImage(bytes); } catch (e) { return { error: "Figma couldn't read this image: " + msg(e) }; }
  bytes = null;
  // Figma's own reading wins over the file header (EXIF-rotated JPEGs swap sides).
  const size = await within(image.getSizeAsync(), 15000, null);
  let pw = it.pixelWidth, ph = it.pixelHeight;
  if (size && size.width > 0 && size.height > 0) {
    if (size.width !== pw || size.height !== ph) itemNotes.push('Figma reads this image as ' + size.width + 'x' + size.height + ' px (its header says ' + pw + 'x' + ph + ', e.g. because of EXIF rotation); sized from Figma\'s reading.');
    pw = size.width; ph = size.height;
  }
  return { image: image, pw: pw, ph: ph, notes: itemNotes };
}

function createLayer(it, target, img) {
  let node = null;
  try {
    node = opts.nodeType === 'frame' ? figma.createFrame() : figma.createRectangle();
    node.name = it.name;
    const d = displaySize(img.pw, img.ph, it.density, opts.box, opts.fit);
    node.resize(d.w, d.h);
    node.fills = [imagePaint(img.image.hash, img.pw, img.ph, d.w, d.h, it.density, opts.scaleMode)];
    target.appendChild(node);
    node.setPluginData('imageImport', JSON.stringify({ v: 1, runId: P.runId, source: it.source, hash: it.hash, imageHash: img.image.hash, importedAt: Date.now() }));
    place(node, false);
    newTopLevelIds.push(node.id);
    return { key: it.key, status: 'created', nodeId: node.id, type: node.type, width: node.width, height: node.height, imageHash: img.image.hash, pixelWidth: img.pw, pixelHeight: img.ph, notes: img.notes };
  } catch (e) {
    safeRemove(node);
    return { key: it.key, status: 'failed', stage: 'process', reason: "Couldn't finish this image: " + msg(e), notes: img.notes };
  }
}

async function fillLayers(it, img) {
  const filled = [], problems = [], itemNotes = img.notes;
  for (const id of it.targetIds) {
    let n = null;
    try { n = await getNode(id); } catch (e) { n = null; }
    if (!n) { problems.push(id + " wasn't found"); continue; }
    if (!('fills' in n)) { problems.push('"' + n.name + '" (' + id + ') has no fills'); continue; }
    try {
      const style = typeof n.fillStyleId === 'string' ? n.fillStyleId : '';
      const bound = n.boundVariables && n.boundVariables.fills && n.boundVariables.fills.length;
      n.fills = [imagePaint(img.image.hash, img.pw, img.ph, n.width, n.height, it.density, opts.scaleMode)];
      filled.push({ id: n.id, name: n.name });
      if (style) itemNotes.push('"' + n.name + '": its fill style was detached.');
      if (bound) itemNotes.push('"' + n.name + '": its fill variable binding was replaced.');
    } catch (e) { problems.push('"' + n.name + '" (' + id + '): ' + msg(e)); }
  }
  if (!filled.length) return { key: it.key, status: 'failed', stage: 'process', reason: 'No layer took the image fill: ' + problems.join('; ') + '.', notes: itemNotes };
  if (problems.length) itemNotes.push('Not filled: ' + problems.join('; ') + '.');
  return { key: it.key, status: 'updated', filled: filled, imageHash: img.image.hash, pixelWidth: img.pw, pixelHeight: img.ph, notes: itemNotes };
}

const wrong = wrongFile();
if (wrong) return { refused: wrong };
const claim = claimMarker(OWN_MARKER, OTHER_MARKER);
if (claim.refused) return { refused: claim.refused };
try {
  figma.commitUndo();
  let target = null;
  if (P.targetId) {
    target = await getNode(P.targetId);
    if (!target) throw new Error('The target layer ' + P.targetId + ' no longer exists.');
    if (target.type === 'PAGE') await target.loadAsync();
    if (!cursor && P.layout.mode !== 'auto-layout') cursor = initCursor(target);
  }
  for (const it of P.items) {
    const img = await loadImage(it);
    if (img.error) { results.push({ key: it.key, status: 'failed', stage: 'import', reason: img.error, notes: [] }); continue; }
    if (it.action === 'fill') results.push(await fillLayers(it, img));
    else if (!target) results.push({ key: it.key, status: 'failed', stage: 'process', reason: 'No target layer was given for new layers.', notes: [] });
    else results.push(createLayer(it, target, img));
  }
  if (target) settleContainer(target);
  if (P.final && P.focus && target) await focusResult(target);
  return { results: results, cursor: cursor, newTopLevelIds: newTopLevelIds, notes: notes };
} finally {
  try { figma.commitUndo(); } catch (e) {}
  releaseMarker(OWN_MARKER, claim.token);
}
`;

export const IMAGE_IMPORT_BODY = SVG_HELPERS + IMAGE_MARKERS + LAYOUT_HELPERS + IMAGE_HELPERS + IMAGE_IMPORT_MAIN;

/** Every image body, for the static checks (no `${`, no backticks, sandbox syntax). */
export const ALL_IMAGE_BODIES: Readonly<Record<string, string>> = {
	IMAGE_PREFLIGHT_BODY,
	IMAGE_CONTAINER_BODY,
	IMAGE_IMPORT_BODY,
};
