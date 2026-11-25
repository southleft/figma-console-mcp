/**
 * Plugin-side walker for figma_audit_adherence, run through the Desktop
 * Bridge's code execution (no plugin update needed).
 *
 * It inventories a composition (a frame/section the agent generated) and
 * reports, per node, whether it's built from the design system:
 *   - instances of components (local or library) — counted, not descended into
 *     (their internals belong to the system), but styling overrides are noted
 *   - styling on everything else: fills/strokes/effects/radius/spacing/text,
 *     each either bound (variable or style) or hardcoded
 *   - likely inventions: hand-built frames named like a component, new
 *     components created inside the composition, hand-drawn vectors
 *   - declared gaps: nodes named "GAP: …" (placeholders a person approved)
 *
 * Output is raw facts + per-node findings; scoring happens server-side.
 */

export interface AuditCodeOptions {
	nodeId?: string;
	maxNodes: number;
	/** Lowercased base names of the system's components (for imitation checks). */
	componentNames: string[];
}

/** Common UI words — a hand-built frame named like this is probably an imitation. */
export const UI_VOCABULARY = [
	"button", "btn", "input", "textfield", "text field", "select", "dropdown", "checkbox",
	"radio", "toggle", "switch", "modal", "dialog", "tooltip", "popover", "badge", "tag",
	"chip", "pill", "avatar", "card", "tab", "tabs", "navbar", "nav bar", "sidebar",
	"breadcrumb", "pagination", "toast", "snackbar", "alert", "banner", "spinner",
	"slider", "accordion", "menu", "icon", "search", "date picker", "datepicker", "stepper",
];

export const GAP_PREFIX = "GAP:";

export function buildAuditCode(opts: AuditCodeOptions): string {
	return `
const ROOT_ID = ${JSON.stringify(opts.nodeId ?? null)};
const MAX_NODES = ${Math.max(50, Math.min(opts.maxNodes, 20000))};
const DS_NAMES = new Set(${JSON.stringify(opts.componentNames.slice(0, 5000))});
const VOCAB = ${JSON.stringify(UI_VOCABULARY)};
const GAP_PREFIX = ${JSON.stringify(GAP_PREFIX)};

let root = null;
if (ROOT_ID) root = await figma.getNodeByIdAsync(ROOT_ID);
else if (figma.currentPage.selection.length === 1) root = figma.currentPage.selection[0];
if (!root) return { error: ROOT_ID ? "Node " + ROOT_ID + " not found in this file." : "Pass nodeId, or select exactly one frame to audit." };

const findings = [];
const stats = {
  nodesVisited: 0, truncated: false,
  instances: 0, localInstances: 0, libraryInstances: 0,
  styledProps: 0, boundProps: 0,
  hardcoded: { color: 0, spacing: 0, radius: 0, typography: 0, effect: 0 },
  gaps: 0, imitations: 0, suspects: 0, newComponents: 0, handDrawnVectors: 0,
  instancesWithStyleOverrides: 0,
};
const used = {};      // component name -> { key, source, count }
const gapNames = [];

function pathOf(n) {
  const parts = [];
  let p = n;
  while (p && p !== root && parts.length < 6) { parts.unshift(p.name); p = p.parent; }
  return parts.join(" / ");
}
function add(node, rule, severity, message, extra) {
  findings.push(Object.assign({ nodeId: node.id, name: node.name, type: node.type, path: pathOf(node), rule, severity, message }, extra || {}));
}
function nameWords(name) {
  return (" " + String(name).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ");
}
function isMixed(v) { return typeof v === "symbol"; }
function bv(node, field) {
  const b = node.boundVariables || {};
  const v = b[field];
  return !!(v && (!Array.isArray(v) || v.length > 0));
}

function checkPaints(node, prop, label) {
  const paints = node[prop];
  if (isMixed(paints) || !Array.isArray(paints)) return;
  const visible = paints.filter(p => p.visible !== false && p.type !== "IMAGE" && p.type !== "VIDEO");
  if (visible.length === 0) return;
  stats.styledProps++;
  const styleId = prop === "fills" ? node.fillStyleId : node.strokeStyleId;
  if (typeof styleId === "string" && styleId !== "") { stats.boundProps++; return; }
  const unbound = visible.filter(p => !(p.type === "SOLID" && p.boundVariables && p.boundVariables.color));
  if (unbound.length === 0) { stats.boundProps++; return; }
  stats.hardcoded.color++;
  const p = unbound[0];
  let value = p.type;
  if (p.type === "SOLID") {
    const c = p.color, h = v => Math.round(v * 255).toString(16).padStart(2, "0");
    value = "#" + h(c.r) + h(c.g) + h(c.b) + (p.opacity !== undefined && p.opacity < 1 ? " @" + Math.round(p.opacity * 100) + "%" : "");
  }
  add(node, "hardcoded-color", "warning", label + " color " + value + " isn't a variable or style.", { value });
}

function checkSpacing(node) {
  if (!("layoutMode" in node) || node.layoutMode === "NONE") return;
  const fields = ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing"];
  if (node.layoutWrap === "WRAP") fields.push("counterAxisSpacing");
  const bad = [];
  for (const f of fields) {
    const v = node[f];
    if (typeof v !== "number" || v === 0) continue;
    stats.styledProps++;
    if (bv(node, f)) stats.boundProps++;
    else { stats.hardcoded.spacing++; bad.push(f + " " + v); }
  }
  if (bad.length) add(node, "hardcoded-spacing", "warning", "Spacing isn't bound to tokens: " + bad.join(", ") + ".", { value: bad.join(", ") });
}

function checkRadius(node) {
  if (!("cornerRadius" in node)) return;
  const corners = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"];
  const vals = corners.map(c => node[c]).filter(v => typeof v === "number" && v > 0);
  if (vals.length === 0) return;
  stats.styledProps++;
  if (corners.every(c => !(node[c] > 0) || bv(node, c))) { stats.boundProps++; return; }
  stats.hardcoded.radius++;
  add(node, "hardcoded-radius", "warning", "Corner radius " + vals[0] + " isn't bound to a token.", { value: vals[0] });
}

function checkEffects(node) {
  if (!("effects" in node) || isMixed(node.effects) || !node.effects.some(e => e.visible !== false)) return;
  stats.styledProps++;
  if ((typeof node.effectStyleId === "string" && node.effectStyleId !== "") || bv(node, "effects")) { stats.boundProps++; return; }
  stats.hardcoded.effect++;
  add(node, "hardcoded-effect", "warning", "Shadow/blur isn't an effect style or variable.");
}

function checkText(node) {
  stats.styledProps++;
  if (typeof node.textStyleId === "string" && node.textStyleId !== "") { stats.boundProps++; return; }
  if (isMixed(node.textStyleId)) {
    stats.hardcoded.typography++;
    add(node, "mixed-text-style", "warning", "Text mixes styled and unstyled ranges.");
    return;
  }
  if (bv(node, "fontSize") && (bv(node, "fontFamily") || bv(node, "fontStyle") || bv(node, "fontWeight"))) { stats.boundProps++; return; }
  stats.hardcoded.typography++;
  const size = isMixed(node.fontSize) ? "mixed" : node.fontSize;
  add(node, "hardcoded-typography", "warning", "Text (" + size + "px) has no text style or typography variables.", { value: size });
}

function imitation(node) {
  const words = nameWords(node.name);
  const trimmed = words.trim();
  const last = String(node.name).split("/").pop().trim().toLowerCase();
  if (DS_NAMES.has(trimmed) || DS_NAMES.has(last)) return { kind: "imitation", label: last };
  for (const v of VOCAB) if (words.indexOf(" " + v + " ") >= 0) return { kind: "suspect", label: v };
  return null;
}

const queue = [root];
const VECTORS = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON"]);
while (queue.length) {
  const node = queue.shift();
  if (stats.nodesVisited >= MAX_NODES) { stats.truncated = true; break; }
  stats.nodesVisited++;
  if (node.visible === false) continue;

  if (typeof node.name === "string" && node.name.trim().toUpperCase().startsWith(GAP_PREFIX)) {
    stats.gaps++;
    gapNames.push(node.name.trim().slice(GAP_PREFIX.length).trim());
    continue;
  }

  if (node.type === "INSTANCE") {
    stats.instances++;
    let mc = null;
    try { mc = await node.getMainComponentAsync(); } catch (e) {}
    const set = mc && mc.parent && mc.parent.type === "COMPONENT_SET" ? mc.parent : null;
    const label = set ? set.name : (mc ? mc.name : node.name);
    const remote = !!(mc && mc.remote);
    if (remote) stats.libraryInstances++; else stats.localInstances++;
    const k = label + "|" + (remote ? "library" : "local");
    if (!used[k]) used[k] = { name: label, key: mc ? mc.key : null, setKey: set ? set.key : null, source: remote ? "library" : "local", count: 0, nodeIds: [] };
    used[k].count++;
    if (used[k].nodeIds.length < 5) used[k].nodeIds.push(node.id);
    if (!mc) add(node, "missing-main-component", "error", "Instance's main component is missing (deleted or unavailable).");
    try {
      const styleFields = ["fills", "strokes", "effects", "cornerRadius", "topLeftRadius", "paddingLeft", "paddingTop", "itemSpacing", "fontSize", "fontName", "textStyleId", "fillStyleId"];
      const ov = (node.overrides || []).filter(o => (o.overriddenFields || []).some(f => styleFields.indexOf(f) >= 0));
      if (ov.length) {
        stats.instancesWithStyleOverrides++;
        add(node, "style-override", "info", ov.length + " layer(s) inside this " + label + " have styling overridden. Check they use tokens, or use a variant instead.", { overriddenLayers: ov.length });
      }
    } catch (e) {}
    continue;
  }

  if (node !== root && (node.type === "COMPONENT" || node.type === "COMPONENT_SET")) {
    stats.newComponents++;
    add(node, "new-component", "error", "A new " + (node.type === "COMPONENT_SET" ? "component set" : "component") + " was created inside the composition. Use an existing component, or report the gap.");
    continue;
  }

  if (node !== root && (node.type === "FRAME" || node.type === "GROUP")) {
    const im = imitation(node);
    if (im && im.kind === "imitation") {
      stats.imitations++;
      add(node, "imitates-component", "error", "Hand-built layer named like the system's \\"" + im.label + "\\" component. Replace it with an instance.", { component: im.label });
    } else if (im && im.kind === "suspect" && "children" in node && node.children.length > 0) {
      stats.suspects++;
      add(node, "looks-hand-built", "warning", "Looks like a hand-built " + im.label + " (not an instance). If the system has one, use it; if not, it's a gap to report.", { looksLike: im.label });
    }
  }

  if (VECTORS.has(node.type)) {
    stats.handDrawnVectors++;
    add(node, "hand-drawn-vector", "warning", "Hand-drawn vector outside any component. Use the system's icon components.");
  }

  if ("fills" in node) checkPaints(node, "fills", node.type === "TEXT" ? "Text" : "Fill");
  if ("strokes" in node) checkPaints(node, "strokes", "Stroke");
  if (node.type === "TEXT") checkText(node);
  else {
    checkSpacing(node);
    checkRadius(node);
    checkEffects(node);
  }

  if ("children" in node && !VECTORS.has(node.type)) for (const c of node.children) queue.push(c);
}

return {
  root: { id: root.id, name: root.name, type: root.type },
  file: { name: figma.root.name, key: figma.fileKey || null },
  stats, componentsUsed: Object.values(used).sort((a, b) => b.count - a.count), gaps: gapNames, findings,
};
`;
}
