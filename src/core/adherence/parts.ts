/**
 * Part-level gaps: the system HAS the component, but not a part the request
 * needs (an article-preview card with no image area, a table with no
 * pagination). Checked against what the component actually contains — its
 * properties, variant axes/values, slots, layer names and nested instances —
 * so a missing part is reported instead of being hand-added on top.
 */
import { type CatalogEntry, tokenize } from "./matching.js";

/** What the plugin reads from a component (all variants, unioned). */
export interface ComponentAnatomy {
	/** Layer names and nested-instance component names, with the variant they occur in. */
	layers: Array<{ name: string; variant?: string }>;
	/** A variant that shows an image fill (or "" for a plain component). */
	imageIn?: string;
	textLayers: number;
}

/** Parts any text layer can carry (content is set through properties/overrides). */
const TEXT_PARTS = new Set(
	[
		"heading", "title", "subtitle", "subheading", "text", "description", "excerpt", "summary", "body", "caption",
		"label", "meta", "metadata", "date", "time", "timestamp", "author", "byline", "price", "value", "name", "copy",
		"content", "headline", "number", "amount", "percentage", "change", "count",
	].map((w) => tokenize(w)[0] ?? w),
);

export interface PartCheck {
	part: string;
	status: "present" | "missing" | "unverified";
	/** Where it was found: a property, variant value, or layer (and variant). */
	foundIn?: string;
}

export function checkParts(parts: string[], entry: Pick<CatalogEntry, "properties" | "variantAxes" | "description">, anatomy?: ComponentAnatomy): PartCheck[] {
	const props = entry.properties ?? [];
	const axes = entry.variantAxes ?? [];
	const known = props.length > 0 || axes.length > 0 || !!anatomy;
	return parts.map((part) => {
		const want = tokenize(part);
		if (want.length === 0) return { part, status: "unverified" as const };
		const hit = (text: string) => {
			const have = tokenize(text);
			return want.some((w) => have.includes(w));
		};
		for (const p of props) if (hit(p.name)) return { part, status: "present" as const, foundIn: `property "${p.name}" (${p.type})` };
		for (const a of axes) {
			if (hit(a.name)) return { part, status: "present" as const, foundIn: `variant axis "${a.name}"` };
			const v = a.values.find(hit);
			if (v) return { part, status: "present" as const, foundIn: `variant ${a.name}=${v}` };
		}
		if (anatomy) {
			const l = anatomy.layers.find((x) => hit(x.name));
			if (l) return { part, status: "present" as const, foundIn: `layer "${l.name}"${l.variant ? ` in variant ${l.variant}` : ""}` };
			if (want.includes("image") && anatomy.imageIn !== undefined)
				return { part, status: "present" as const, foundIn: `image fill${anatomy.imageIn ? ` in variant ${anatomy.imageIn}` : ""}` };
			if (want.every((w) => TEXT_PARTS.has(w)) && (anatomy.textLayers > 0 || props.some((p) => p.type === "TEXT")))
				return { part, status: "present" as const, foundIn: "text layer (set its content)" };
		} else if (want.every((w) => TEXT_PARTS.has(w)) && props.some((p) => p.type === "TEXT")) {
			return { part, status: "present" as const, foundIn: "text property" };
		}
		// A slot or swap can take another system component for this part.
		const open = props.find((p) => p.type === "SLOT" || p.type === "INSTANCE_SWAP");
		if (!anatomy && !known) return { part, status: "unverified" as const };
		if (open && !anatomy) return { part, status: "unverified" as const, foundIn: `may fit ${open.type === "SLOT" ? "slot" : "swap"} "${open.name}"` };
		return { part, status: "missing" as const };
	});
}

/** Plugin code that reads anatomy for the given component / component-set node ids. */
export function anatomyCode(nodeIds: string[]): string {
	return `const ids = ${JSON.stringify(nodeIds.slice(0, 40))};
const out = {};
for (const id of ids) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) continue;
  const variants = n.type === "COMPONENT_SET" ? n.children.slice(0, 24) : [n];
  const layers = []; let imageIn; let textLayers = 0; const seen = new Set();
  for (const v of variants) {
    const vname = n.type === "COMPONENT_SET" ? v.name : undefined;
    const stack = [...(v.children || [])]; let count = 0;
    while (stack.length && count < 400) {
      const c = stack.shift(); count++;
      if (c.type === "TEXT") textLayers++;
      try {
        if (imageIn === undefined && Array.isArray(c.fills) && c.fills.some(f => f.type === "IMAGE" && f.visible !== false)) imageIn = vname || "";
      } catch (e) {}
      const names = [c.name];
      if (c.type === "INSTANCE") { try { const mc = await c.getMainComponentAsync(); if (mc) names.push(mc.parent && mc.parent.type === "COMPONENT_SET" ? mc.parent.name : mc.name); } catch (e) {} }
      for (const nm of names) if (!seen.has(nm)) { seen.add(nm); layers.push({ name: nm, variant: vname }); }
      if (c.type !== "INSTANCE" && "children" in c) stack.push(...c.children);
    }
  }
  out[id] = { layers: layers.slice(0, 600), imageIn, textLayers };
}
return out;`;
}
