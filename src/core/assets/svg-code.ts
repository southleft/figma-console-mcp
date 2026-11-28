/**
 * Code-ready SVG from Figma's exporter (spec §3.4 step 6):
 *   currentColor — a single-color icon's color becomes `currentColor`, so CSS
 *                  `color` recolors it;
 *   removeSize   — the root width/height go, the viewBox stays, so CSS sets
 *                  the size.
 *
 * Re-reads the SVG with the sanitizer's strict tokenizer (linear, capped) and
 * writes it back out with every qualified name and attribute order kept.
 * Anything it can't read safely is returned unchanged with a note.
 */

import { type RawSvgElement, type RawSvgNode, parseColor, parseSvgRaw } from "./svg-sanitize.js";

export interface CodeSvgOptions {
	currentColor?: boolean;
	removeSize?: boolean;
}

export interface CodeSvgResult {
	svg: string;
	/** True when the text changed. */
	changed: boolean;
	/** Short notes without the asset name; the caller prefixes it. */
	notes: string[];
}

const PAINT_PROPS = new Set(["fill", "stroke"]);
/** Their presence means more than one color is drawn (or one that currentColor can't express). */
const MULTI_COLOR_ELEMENTS = new Set(["linearGradient", "radialGradient", "stop", "image", "pattern", "meshgradient"]);
const NOT_A_PAINT = new Set(["none", "", "inherit", "transparent", "currentcolor", "context-fill", "context-stroke"]);

type Classified = { kind: "ignore" } | { kind: "color"; hex: string } | { kind: "multi" };

/** Alpha below 1 can't be carried by currentColor alone, so such a color counts as "can't convert". */
function hasAlpha(v: string): boolean {
	if (v[0] === "#") {
		const h = v.slice(1);
		if (h.length === 4) return parseInt(h[3] + h[3], 16) < 255;
		if (h.length === 8) return parseInt(h.slice(6, 8), 16) < 255;
		return false;
	}
	const m = /^(?:rgba?|hsla?)\(([^()]*)\)$/.exec(v);
	if (!m) return false;
	const parts = m[1].split(/[\s,/]+/).filter(Boolean);
	if (parts.length < 4) return false;
	const a = parts[3];
	const n = a.endsWith("%") ? Number(a.slice(0, -1)) / 100 : Number(a);
	return !(n >= 1);
}

function classify(value: string): Classified {
	const v = value.trim().toLowerCase();
	if (NOT_A_PAINT.has(v)) return { kind: "ignore" };
	if (v.startsWith("url(")) return { kind: "multi" };
	const rgb = parseColor(v);
	if (!rgb || hasAlpha(v)) return { kind: "multi" };
	return { kind: "color", hex: rgb.map((c) => c.toString(16).padStart(2, "0")).join("") };
}

function declarations(style: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const part of style.split(";")) {
		const i = part.indexOf(":");
		if (i <= 0) continue;
		out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
	}
	return out;
}

/**
 * Clip paths and masks are never drawn in their own color: a clip's fill is
 * ignored (only its geometry clips) and a mask's fill IS the mask (luminance,
 * or alpha with mask-type:alpha). Figma's exporter writes both for ordinary
 * icons (`<clipPath><rect fill="white"/></clipPath>` for a frame with Clip
 * content, `<mask style="mask-type:alpha"><rect fill="#D9D9D9"/></mask>` for a
 * mask layer), so their paints are neither counted as icon colors nor
 * rewritten. Matched by element name, not by being inside <defs>: Figma
 * writes <mask> outside it. Markers and symbols are drawn where they're used,
 * so their paints do count.
 */
const NOT_DRAWN_IN_OWN_COLOR = new Set(["clipPath", "mask"]);

/** Every element except clipPath/mask subtrees (left byte for byte as they are). */
function walk(root: RawSvgElement, fn: (el: RawSvgElement) => void): void {
	const stack: RawSvgElement[] = [root];
	while (stack.length) {
		const el = stack.pop() as RawSvgElement;
		if (el !== root && NOT_DRAWN_IN_OWN_COLOR.has(el.local)) continue;
		fn(el);
		for (let i = el.children.length - 1; i >= 0; i--) {
			const c = el.children[i];
			if (c.t === 1) stack.push(c);
		}
	}
}

const escAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// '>' stays literal in text so CSS child combinators inside <style> survive inlining into HTML.
const escText = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/]]>/g, "]]&gt;");

function serialize(root: RawSvgElement): string {
	const out: string[] = [];
	const stack: Array<RawSvgNode | { close: string }> = [root];
	while (stack.length) {
		const item = stack.pop() as RawSvgNode | { close: string };
		if ("close" in item) {
			out.push(`</${item.close}>`);
			continue;
		}
		if (item.t === 2) {
			out.push(escText(item.text));
			continue;
		}
		const attrs = item.attrs.map((a) => ` ${a.qname}="${escAttr(a.value)}"`).join("");
		if (!item.children.length) {
			out.push(`<${item.qname}${attrs}/>`);
			continue;
		}
		out.push(`<${item.qname}${attrs}>`);
		stack.push({ close: item.qname });
		for (let i = item.children.length - 1; i >= 0; i--) stack.push(item.children[i]);
	}
	return out.join("");
}

const PLAIN_NUMBER = /^\s*([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)(?:px)?\s*$/i;

export function toCodeSvg(svg: string, opts: CodeSvgOptions): CodeSvgResult {
	if (!opts.currentColor && !opts.removeSize) return { svg, changed: false, notes: [] };
	let parsed;
	try {
		parsed = parseSvgRaw(svg);
	} catch {
		parsed = { ok: false as const, error: "unreadable" };
	}
	if (!parsed.ok || parsed.root.local !== "svg") return { svg, changed: false, notes: ["couldn't re-read Figma's SVG, so it was left as is."] };
	const root = parsed.root;
	const notes: string[] = [];
	let changed = false;

	if (opts.currentColor) {
		const colors = new Set<string>();
		let multi = false;
		walk(root, (el) => {
			if (MULTI_COLOR_ELEMENTS.has(el.local)) multi = true;
			for (const a of el.attrs) {
				if (a.prefix !== null) continue;
				if (a.local === "stop-color") multi = true;
				else if (PAINT_PROPS.has(a.local)) {
					const c = classify(a.value);
					if (c.kind === "multi") multi = true;
					else if (c.kind === "color") colors.add(c.hex);
				} else if (a.local === "style") {
					for (const [prop, value] of declarations(a.value)) {
						const p = prop.toLowerCase();
						if (p === "stop-color") multi = true;
						else if (PAINT_PROPS.has(p)) {
							const c = classify(value);
							if (c.kind === "multi") multi = true;
							else if (c.kind === "color") colors.add(c.hex);
						}
					}
				}
			}
		});
		if (multi || colors.size > 1) notes.push("multi-color, left as is.");
		else if (colors.size === 1) {
			walk(root, (el) => {
				for (const a of el.attrs) {
					if (a.prefix !== null) continue;
					if (PAINT_PROPS.has(a.local) && classify(a.value).kind === "color") {
						a.value = "currentColor";
						changed = true;
					} else if (a.local === "style") {
						const decls = declarations(a.value);
						let touched = false;
						const rebuilt = decls.map(([p, v]) => {
							if (PAINT_PROPS.has(p.toLowerCase()) && classify(v).kind === "color") {
								touched = true;
								return `${p}:currentColor`;
							}
							return `${p}:${v}`;
						});
						if (touched) {
							a.value = rebuilt.join(";");
							changed = true;
						}
					}
				}
			});
		}
	}

	if (opts.removeSize) {
		const get = (name: string) => root.attrs.find((a) => a.prefix === null && a.local === name);
		const w = get("width");
		const h = get("height");
		if (w || h) {
			if (!get("viewBox")) {
				const wm = w ? PLAIN_NUMBER.exec(w.value) : null;
				const hm = h ? PLAIN_NUMBER.exec(h.value) : null;
				if (wm && hm) {
					root.attrs.push({ qname: "viewBox", prefix: null, local: "viewBox", value: `0 0 ${Number(wm[1])} ${Number(hm[1])}` });
				} else {
					notes.push("removeSize: no viewBox and no numeric size, so width/height were kept.");
					return { svg: changed ? serialize(root) : svg, changed, notes };
				}
			}
			root.attrs = root.attrs.filter((a) => !(a.prefix === null && (a.local === "width" || a.local === "height")));
			changed = true;
		}
	}

	return { svg: changed ? serialize(root) : svg, changed, notes };
}
