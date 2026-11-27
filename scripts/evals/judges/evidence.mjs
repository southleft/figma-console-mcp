/**
 * Evidence for judging a generated Figma composition — facts only, never the
 * generator's reasoning or any automated verdict, so judges form their own view.
 *
 *   screenshot.png  the composition as rendered (≤1568px, the vision limit)
 *   evidence.json   { prompt, designSystem: { components, variables, textStyles },
 *                     composition: { size, layers, gapNotes, unboundValues } }
 *
 * Layers stop at instances (an instance is one unit: "uses component X").
 * Boxes are fractions of the root's width/height so they line up with the screenshot.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GAP = "GAP:";

export async function collectEvidence(call, { fileKey, rootId, prompt, outDir }) {
	const res = await call("figma_execute", {
		fileKey,
		timeout: 120000,
		code: `const root = await figma.getNodeByIdAsync(${JSON.stringify(rootId)});
if (!root) return { error: "root not found" };
await figma.loadAllPagesAsync();
const W = root.width || 1, H = root.height || 1;
const rb = root.absoluteBoundingBox || { x: root.x, y: root.y };
const box = (n) => { const b = n.absoluteBoundingBox; if (!b) return null; const r = (v) => Math.round(v * 1000) / 1000;
  return { left: r((b.x - rb.x) / W), top: r((b.y - rb.y) / H), right: r((b.x - rb.x + b.width) / W), bottom: r((b.y - rb.y + b.height) / H) }; };
const usedDescriptions = {};
const layers = []; const gapNotes = []; const unbound = { color: 0, spacing: 0, radius: 0, text: 0 };
const queue = [{ n: root, depth: 0, path: "" }];
while (queue.length && layers.length < 700) {
  const { n, depth, path } = queue.shift();
  if (n.visible === false) continue;
  const here = path ? path + " / " + n.name : n.name;
  if (String(n.name).trim().toUpperCase().startsWith(${JSON.stringify(GAP)})) {
    let note = ""; try { note = (n.type === "TEXT" ? [n] : n.findAll(x => x.type === "TEXT")).map(t => t.characters).join(" "); } catch (e) {}
    gapNotes.push({ id: n.id, name: n.name, note: note.slice(0, 400), box: box(n), parent: n.parent ? n.parent.name : null });
    continue;
  }
  const item = { id: n.id, type: n.type, name: n.name, depth, box: box(n) };
  if (n.type === "INSTANCE") {
    try { const mc = await n.getMainComponentAsync(); if (mc) { const set = mc.parent && mc.parent.type === "COMPONENT_SET" ? mc.parent : null; item.component = set ? set.name : mc.name; item.variant = set ? mc.name : undefined; item.fromLibrary = !!mc.remote;
      const d = (set ? set.description : mc.description) || ""; if (d && !usedDescriptions[item.component]) usedDescriptions[item.component] = d.slice(0, 300); } } catch (e) {}
    // Components placed inside this instance (slot content, swapped instances), so judges see them.
    try {
      const own = new Set();
      try { const mc = await n.getMainComponentAsync(); if (mc) for (const x of mc.findAll(y => y.type === "INSTANCE")) own.add(x.name); } catch (e) {}
      const nested = [];
      for (const x of n.findAll(y => y.type === "INSTANCE").slice(0, 60)) {
        let nm = x.name; try { const m = await x.getMainComponentAsync(); if (m) nm = m.parent && m.parent.type === "COMPONENT_SET" ? m.parent.name : m.name; } catch (e) {}
        const placed = x.parent && x.parent.type === "SLOT";
        if (placed || !own.has(x.name)) nested.push((placed ? "in slot: " : "") + nm);
      }
      if (nested.length) item.contains = [...new Set(nested)].slice(0, 15);
    } catch (e) {}
    layers.push(item); continue;
  }
  if (n.type === "TEXT") { item.text = n.characters.slice(0, 120); if (!(typeof n.textStyleId === "string" && n.textStyleId)) unbound.text++; }
  try {
    const fills = Array.isArray(n.fills) ? n.fills.filter(f => f.visible !== false && f.type === "SOLID") : [];
    if (fills.some(f => !(f.boundVariables && f.boundVariables.color)) && !(typeof n.fillStyleId === "string" && n.fillStyleId)) unbound.color++;
    if (n.layoutMode && n.layoutMode !== "NONE") { const bv = n.boundVariables || {}; for (const f of ["paddingLeft","paddingTop","itemSpacing"]) if (n[f] > 0 && !bv[f]) { unbound.spacing++; break; } }
    if (typeof n.cornerRadius === "number" && n.cornerRadius > 0 && !((n.boundVariables || {}).topLeftRadius)) unbound.radius++;
  } catch (e) {}
  layers.push(item);
  if ("children" in n) for (const c of n.children) queue.push({ n: c, depth: depth + 1, path: here });
}
// Inventory of the design system (this file's components + variables + text styles).
const comps = [];
for (const c of figma.root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })) {
  if (c.type === "COMPONENT" && c.parent && c.parent.type === "COMPONENT_SET") continue;
  comps.push(c.name);
}
// Details (description, properties, slots, variant axes) for components the judges must weigh:
// every component used, and every component a gap note names as a candidate.
const gapText = gapNotes.map(g => g.note + " " + g.name).join(" ").toLowerCase();
const detailNodes = [];
for (const c of figma.root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })) {
  if (c.type === "COMPONENT" && c.parent && c.parent.type === "COMPONENT_SET") continue;
  const nm = c.name; const leaf = nm.split("/").pop().trim().toLowerCase();
  const esc = (t) => t.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
  const word = (t) => t.length >= 4 && new RegExp("(^|[^a-z0-9])" + esc(t) + "([^a-z0-9]|$)").test(gapText);
  const named = word(nm.toLowerCase()) || word(leaf);
  if (usedDescriptions[nm] !== undefined || layers.some(l => l.component === nm) || named) detailNodes.push(c);
  if (detailNodes.length >= 40) break;
}
const componentDetails = {};
for (const c of detailNodes) {
  let props = {};
  try { for (const [k, d] of Object.entries(c.componentPropertyDefinitions || {})) props[k.split("#")[0]] = d.type === "VARIANT" ? "VARIANT: " + (d.variantOptions || []).join(" | ") : d.type; } catch (e) {}
  let slots = []; try { slots = (c.type === "COMPONENT_SET" ? c.defaultVariant : c).findAll(n => n.type === "SLOT").map(n => n.name).slice(0, 10); } catch (e) {}
  componentDetails[c.name] = { description: (c.description || "").slice(0, 300) || undefined, properties: props, slots: slots.length ? slots : undefined };
}
let variables = [];
try { const cols = await figma.variables.getLocalVariableCollectionsAsync(); const vars = await figma.variables.getLocalVariablesAsync();
  const byCol = {}; for (const v of vars) { (byCol[v.variableCollectionId] = byCol[v.variableCollectionId] || []).push(v.name); }
  variables = cols.map(c => ({ collection: c.name, names: (byCol[c.id] || []).slice(0, 150) })); } catch (e) {}
let textStyles = []; try { textStyles = (await figma.getLocalTextStylesAsync()).map(s => s.name).slice(0, 80); } catch (e) {}
const scale = Math.min(2, 1568 / Math.max(W, H));
const png = await root.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
// A second render with the gap notes hidden, so "where should X go?" can't anchor on the note itself.
let pngNoGaps = null;
const gapNodes = root.findAll(n => String(n.name).trim().toUpperCase().startsWith(${JSON.stringify(GAP)}) && n.visible !== false);
if (gapNodes.length) {
  try { for (const g of gapNodes) g.visible = false; pngNoGaps = figma.base64Encode(await root.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } })); }
  finally { for (const g of gapNodes) g.visible = true; }
}
return { size: { width: Math.round(W), height: Math.round(H) }, layers, gapNotes, unbound, usedDescriptions, componentDetails, comps, variables, textStyles, png: figma.base64Encode(png), pngNoGaps };`,
	});
	const r = res.result ?? res;
	if (!r || r.error) throw new Error(`evidence: ${r?.error ?? JSON.stringify(res).slice(0, 300)}`);
	// Large systems: keep a readable inventory (unique base names, no icon/asset folders, no retired).
	const ASSET = /^(icons?|iconography|glyphs?|illustrations?|logos?|assets?|emojis?|flags?|images?|graphics?)$/i;
	const RETIRED = /archiv|deprecat|^_|\/_|do not use/i;
	const all = [...new Set(r.comps.filter((n) => !RETIRED.test(n) && !n.split("/").slice(0, -1).some((s) => s.trim().split(/\s+/).some((w) => ASSET.test(w)))))].sort((a, b) => a.localeCompare(b));
	// Never truncate silently: judges decide "the system lacks it" from this list.
	const LIMIT = 6000;
	const comps = all.slice(0, LIMIT);
	const evidence = {
		prompt,
		designSystem: { usedComponentDescriptions: r.usedDescriptions, componentDetails: r.componentDetails, components: comps, componentListComplete: all.length <= LIMIT, componentCountIncludingAssets: r.comps.length, variables: r.variables, textStyles: r.textStyles },
		composition: { size: r.size, layers: r.layers, gapNotes: r.gapNotes, unboundValues: r.unbound },
	};
	if (outDir) {
		mkdirSync(outDir, { recursive: true });
		writeFileSync(join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2));
		writeFileSync(join(outDir, "screenshot.png"), Buffer.from(r.png, "base64"));
		if (r.pngNoGaps) writeFileSync(join(outDir, "screenshot-no-gaps.png"), Buffer.from(r.pngNoGaps, "base64"));
	}
	return { evidence, pngBase64: r.png, pngNoGapsBase64: r.pngNoGaps };
}

/** A compact, readable rendering of the layer tree for a judge. */
export function treeText(layers, max = 400) {
	return layers
		.slice(0, max)
		.map((l) => `${"  ".repeat(Math.min(l.depth, 8))}${l.type === "INSTANCE" ? `[${l.component ?? "?"}${l.variant ? ` · ${l.variant}` : ""}]` : l.type}${l.name && l.type !== "INSTANCE" ? ` "${l.name}"` : ""}${l.text ? `: ${JSON.stringify(l.text)}` : ""}${l.contains ? ` containing [${l.contains.join("], [")}]` : ""}`)
		.join("\n");
}
