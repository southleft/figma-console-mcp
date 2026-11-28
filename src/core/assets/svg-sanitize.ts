/**
 * SVG sanitizer for figma_import_svg (spec .notes/parity/svg.md §2.7).
 *
 * SVG input is untrusted wherever it comes from (a model, a downloaded icon
 * pack, a user's disk). It ends up in figma.createNodeFromSvg, which runs on
 * Figma's single plugin thread and can't be interrupted, so besides removing
 * active content this module bounds the work Figma will do.
 *
 * Hand-written on purpose: DOMPurify needs a DOM and jsdom doesn't run in
 * Cloudflare Workers, and this must behave identically in both modes. The
 * tokenizer is a strict XML subset, single forward pass, index based, with
 * explicit stacks (no recursion) and no regex with nested quantifiers over
 * unbounded input, so time is linear in the input.
 *
 * Pure and synchronous; no dependencies.
 */

import {
	MAX_ATTRS,
	MAX_ATTR_VALUE,
	MAX_DATA_URI_BYTES,
	MAX_DEPTH,
	MAX_ELEMENTS,
	MAX_ENTITIES,
	MAX_ENTITY_EXPANSION,
	MAX_ENTITY_VALUE,
	MAX_EXPANDED_BYTES,
	MAX_EXPANDED_DEPTH,
	MAX_EXPANDED_ELEMENTS,
	MAX_INTERNED,
	MAX_NOTES,
	MAX_REF_CANDIDATES,
	MAX_REMOVED_KINDS,
	MAX_STYLE_BYTES,
	MAX_STYLE_TOTAL_BYTES,
	MAX_SVG_BYTES,
	MAX_TITLE_LENGTH,
	MAX_TOTAL_ATTRS,
	formatMB,
} from "./limits.js";

export const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
/** Marker for a prefix that isn't bound to any namespace. */
const UNBOUND = "\u0000unbound";

/** Elements kept (SVG namespace, by local name). Shared with the HTML import feature. */
export const SVG_KEEP_ELEMENTS: readonly string[] = [
	"svg", "g", "defs", "symbol", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
	"text", "tspan", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "image",
	"style", "filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feDropShadow",
	"feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feMerge", "feMergeNode",
	"feOffset", "marker", "textPath", "switch",
];

/** Elements removed with their whole subtree (besides non-SVG namespaces and unknown elements). */
export const SVG_DROP_ELEMENTS: readonly string[] = [
	"script", "foreignObject", "iframe", "object", "embed", "audio", "video", "canvas", "animate",
	"animateMotion", "animateTransform", "animateColor", "set", "discard", "handler", "listener",
	"metadata", "cursor", "font", "font-face", "font-face-src", "font-face-uri", "glyph",
	"missing-glyph", "hkern", "vkern", "color-profile", "feImage",
];

const KEEP = new Set(SVG_KEEP_ELEMENTS);
/** Rendered only through a reference; cost nothing where they stand. */
const NON_RENDERED = new Set([
	"defs", "symbol", "clipPath", "mask", "pattern", "marker", "linearGradient", "radialGradient", "filter",
]);
const DRAWABLE = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "image", "use"]);
/** Only these keep text content (and CDATA). */
const TEXT_ELEMENTS = new Set(["style", "text", "tspan", "textPath"]);
/** Paint properties whose colors are collected and whose currentColor becomes the sentinel. */
const COLOR_PROPS = new Set(["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color"]);
const CURRENT_COLOR_PROPS = new Set(["fill", "stroke", "stop-color", "flood-color", "lighting-color"]);
/** The only properties (attributes or CSS) that may keep a url(); any other url() is removed. */
const URL_PROPS = new Set(["fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-end"]);
/**
 * Inherited properties whose url(#id) renders the target again at every shape
 * that inherits it (fill/stroke: patterns and gradients; markers: their content).
 * The order is the slot order of a Ctx in the expansion counter.
 */
const SLOT_PROPS = ["fill", "stroke", "marker-start", "marker-end"] as const;
const SLOT_PROP_SET: ReadonlySet<string> = new Set(SLOT_PROPS);
const INVALID_PAINT_NOTE = "fill, stroke or marker values CSS can't read were removed (the shape inherits instead).";
/** Non-inherited properties whose url(#id) renders the target again at the declaring element. */
const DIRECT_REF_PROPS = new Set(["clip-path", "mask", "filter"]);
/** CSS-wide keywords; on clip/mask/filter properties they would copy the parent's reference down. */
const CSS_WIDE_KEYWORD = /^(?:inherit|unset|revert|revert-layer)(?:\s*!\s*important)?$/i;
/** Properties where a CSS-wide keyword is dropped (see CSS_WIDE_KEYWORD). */
const REF_COPYING_PROP = /clip|mask|filter/;
/** Paint that comes from the element referencing a marker or <use>: the counter can't follow it. */
const CONTEXT_PAINT = /context-(?:fill|stroke)/i;
/**
 * Unprefixed attribute names with capitals that SVG defines. Any other
 * spelling with capitals (CLIP-PATH, Style, HREF, Fill) is removed: a parser
 * that folds case would honor it, and the checks below compare exact names.
 */
const CAMEL_ATTRS = new Set([
	"viewBox", "preserveAspectRatio", "gradientUnits", "gradientTransform", "patternUnits", "patternContentUnits",
	"patternTransform", "clipPathUnits", "maskUnits", "maskContentUnits", "filterUnits", "primitiveUnits", "stdDeviation",
	"markerWidth", "markerHeight", "markerUnits", "refX", "refY", "startOffset", "textLength", "lengthAdjust",
	"spreadMethod", "tableValues", "pathLength", "baseFrequency", "numOctaves", "stitchTiles", "kernelMatrix",
	"kernelUnitLength", "surfaceScale", "specularConstant", "specularExponent", "diffuseConstant", "limitingConeAngle",
	"pointsAtX", "pointsAtY", "pointsAtZ", "xChannelSelector", "yChannelSelector", "edgeMode", "targetX", "targetY",
	"preserveAlpha", "requiredExtensions", "requiredFeatures", "systemLanguage", "zoomAndPan", "baseProfile",
	"contentScriptType", "contentStyleType", "externalResourcesRequired", "filterRes", "glyphRef",
]);
/** Elements that keep a local href (#id); <image> keeps a data:image href only; every other href is removed. */
const LOCAL_HREF_ELEMENTS = new Set(["use", "linearGradient", "radialGradient", "pattern", "textPath"]);
/**
 * An id that can be referenced. Whitespace, quotes and parentheses end or
 * change a url() token, '%' is decoded by browsers before the lookup, and
 * braces end a CSS block, so a reference to such an id could resolve
 * differently in Figma than in the expansion counter: ids and references
 * containing them are removed.
 */
const REF_ID = /^[^\s"'`()%\\<>#{}]+$/;
/** CSS functions that fetch a URL given as a plain string, or read one from an attribute. */
const CSS_FETCH = /image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|\bsrc\s*\(|\battr\s*\(|element\s*\(/i;
const INFO_NOTE_ELEMENTS: Record<string, string> = {
	pattern: "<pattern> may not import exactly; check the screenshot.",
	marker: "<marker> may not import exactly; check the screenshot.",
	textPath: "<textPath> may not import exactly; check the screenshot.",
	switch: "<switch> may not import exactly; check the screenshot.",
};

export interface SanitizeOptions {
	/** "auto" (default): replace themeable currentColor with a marker color the plugin can find. */
	currentColorSentinel?: "auto" | false;
}

export interface SvgMeta {
	bytesIn: number;
	bytesOut: number;
	width?: number;
	height?: number;
	viewBox?: [number, number, number, number];
	title?: string;
	rootColor?: string;
	usesCurrentColor: boolean;
	hasText: boolean;
	hasImages: boolean;
	hasGradients: boolean;
	hasFilters: boolean;
	elementCount: number;
	expandedCount: number;
	/** First 64 literal colors as #rrggbb (the internal set used for the sentinel is unbounded). */
	colors: string[];
}

export type SanitizeResult =
	| {
			ok: true;
			markup: string;
			meta: SvgMeta;
			sentinel: string | null;
			notes: string[];
			removed: { elements: Record<string, number>; attributes: number; externalRefs: number };
	  }
	| { ok: false; error: string };

/** Errors carry only element/attribute names and safe ids, never other input text. */
class SanitizeError extends Error {}

const SAFE_ID = /^[A-Za-z_][\w.-]{0,63}$/;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[-A-Za-z0-9_.:]/;
// Unambiguous (the digits before a dot can only be split one way), so the
// anchored patterns below stay linear on long digit runs.
const NUM = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const PLAIN_LENGTH = new RegExp(`^\\s*(${NUM})(?:px)?\\s*$`);
const VIEWBOX = new RegExp(`^[\\s,]*(${NUM})[\\s,]+(${NUM})[\\s,]+(${NUM})[\\s,]+(${NUM})[\\s,]*$`);
const PERCENT = new RegExp(`^\\s*(${NUM})%\\s*$`);
const SAFE_UNIT_VALUE = /^[0-9.]{1,12}(?:em|ex|rem|%|pt|pc|cm|mm|in|vw|vh)$/;

/** "an element" unless the id is safe to quote back to the model. */
function quoteId(id: string | undefined): string {
	return id && SAFE_ID.test(id) ? `#${id}` : "another element";
}

function shortName(name: string): string {
	return name.length > 64 ? `${name.slice(0, 64)}…` : name;
}

/** UTF-8 byte length without TextEncoder (counts a surrogate pair as 4). */
export function utf8Length(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const d = s.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) {
				n += 4;
				i++;
			} else n += 3;
		} else n += 3;
	}
	return n;
}

function formatInt(n: number): string {
	return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ===========================================================================
// Colors
// ===========================================================================

/** All 148 CSS named colors. */
export const CSS_NAMED_COLORS: Readonly<Record<string, string>> = {
	aliceblue: "f0f8ff", antiquewhite: "faebd7", aqua: "00ffff", aquamarine: "7fffd4", azure: "f0ffff",
	beige: "f5f5dc", bisque: "ffe4c4", black: "000000", blanchedalmond: "ffebcd", blue: "0000ff",
	blueviolet: "8a2be2", brown: "a52a2a", burlywood: "deb887", cadetblue: "5f9ea0", chartreuse: "7fff00",
	chocolate: "d2691e", coral: "ff7f50", cornflowerblue: "6495ed", cornsilk: "fff8dc", crimson: "dc143c",
	cyan: "00ffff", darkblue: "00008b", darkcyan: "008b8b", darkgoldenrod: "b8860b", darkgray: "a9a9a9",
	darkgreen: "006400", darkgrey: "a9a9a9", darkkhaki: "bdb76b", darkmagenta: "8b008b",
	darkolivegreen: "556b2f", darkorange: "ff8c00", darkorchid: "9932cc", darkred: "8b0000",
	darksalmon: "e9967a", darkseagreen: "8fbc8f", darkslateblue: "483d8b", darkslategray: "2f4f4f",
	darkslategrey: "2f4f4f", darkturquoise: "00ced1", darkviolet: "9400d3", deeppink: "ff1493",
	deepskyblue: "00bfff", dimgray: "696969", dimgrey: "696969", dodgerblue: "1e90ff", firebrick: "b22222",
	floralwhite: "fffaf0", forestgreen: "228b22", fuchsia: "ff00ff", gainsboro: "dcdcdc",
	ghostwhite: "f8f8ff", gold: "ffd700", goldenrod: "daa520", gray: "808080", green: "008000",
	greenyellow: "adff2f", grey: "808080", honeydew: "f0fff0", hotpink: "ff69b4", indianred: "cd5c5c",
	indigo: "4b0082", ivory: "fffff0", khaki: "f0e68c", lavender: "e6e6fa", lavenderblush: "fff0f5",
	lawngreen: "7cfc00", lemonchiffon: "fffacd", lightblue: "add8e6", lightcoral: "f08080",
	lightcyan: "e0ffff", lightgoldenrodyellow: "fafad2", lightgray: "d3d3d3", lightgreen: "90ee90",
	lightgrey: "d3d3d3", lightpink: "ffb6c1", lightsalmon: "ffa07a", lightseagreen: "20b2aa",
	lightskyblue: "87cefa", lightslategray: "778899", lightslategrey: "778899", lightsteelblue: "b0c4de",
	lightyellow: "ffffe0", lime: "00ff00", limegreen: "32cd32", linen: "faf0e6", magenta: "ff00ff",
	maroon: "800000", mediumaquamarine: "66cdaa", mediumblue: "0000cd", mediumorchid: "ba55d3",
	mediumpurple: "9370db", mediumseagreen: "3cb371", mediumslateblue: "7b68ee",
	mediumspringgreen: "00fa9a", mediumturquoise: "48d1cc", mediumvioletred: "c71585",
	midnightblue: "191970", mintcream: "f5fffa", mistyrose: "ffe4e1", moccasin: "ffe4b5",
	navajowhite: "ffdead", navy: "000080", oldlace: "fdf5e6", olive: "808000", olivedrab: "6b8e23",
	orange: "ffa500", orangered: "ff4500", orchid: "da70d6", palegoldenrod: "eee8aa", palegreen: "98fb98",
	paleturquoise: "afeeee", palevioletred: "db7093", papayawhip: "ffefd5", peachpuff: "ffdab9",
	peru: "cd853f", pink: "ffc0cb", plum: "dda0dd", powderblue: "b0e0e6", purple: "800080",
	rebeccapurple: "663399", red: "ff0000", rosybrown: "bc8f8f", royalblue: "4169e1",
	saddlebrown: "8b4513", salmon: "fa8072", sandybrown: "f4a460", seagreen: "2e8b57",
	seashell: "fff5ee", sienna: "a0522d", silver: "c0c0c0", skyblue: "87ceeb", slateblue: "6a5acd",
	slategray: "708090", slategrey: "708090", snow: "fffafa", springgreen: "00ff7f", steelblue: "4682b4",
	tan: "d2b48c", teal: "008080", thistle: "d8bfd8", tomato: "ff6347", turquoise: "40e0d0",
	violet: "ee82ee", wheat: "f5deb3", white: "ffffff", whitesmoke: "f5f5f5", yellow: "ffff00",
	yellowgreen: "9acd32",
};

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const NUM_TOKEN = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const PCT_TOKEN = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)%$/;
const HUE_TOKEN = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))(deg|turn|rad|grad)?$/;

function channel(token: string): number | null {
	const m = /^([-+]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(token);
	if (!m) return null;
	const v = Number(m[1]);
	return clamp255(m[2] ? (v * 255) / 100 : v);
}

function alphaOf(token: string): number | null {
	if (NUM_TOKEN.test(token)) return clamp01(Number(token));
	if (PCT_TOKEN.test(token)) return clamp01(Number(token.slice(0, -1)) / 100);
	return null;
}

function hslToRgb(h: number, s: number, l: number): RGB {
	const hue = ((h % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] =
		hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
	return [clamp255((r + m) * 255), clamp255((g + m) * 255), clamp255((b + m) * 255)];
}

/**
 * Parse one CSS color with its alpha: 3/4/6/8-digit hex, rgb()/rgba() and
 * hsl()/hsla() in the comma syntax (exactly 3 channels, or 4 with a numeric or
 * percent alpha; rgb channels all numbers or all percentages, hsl saturation
 * and lightness percentages) or the space syntax (3 channels, optional
 * `/ alpha`), and the 148 named colors. Anything else is null: the result is
 * also what currentColor is replaced with (see `canonicalColor`), so nothing
 * that isn't a color, a quote or a comment start in a 4th "channel" included,
 * may pass.
 */
function parseColorA(input: string): RGBA | null {
	const v = input.trim().toLowerCase();
	if (v.length === 0 || v.length > 64) return null;
	if (v[0] === "#") {
		const hex = v.slice(1);
		if (!/^[0-9a-f]+$/.test(hex)) return null;
		const x = (i: number, n: number) => parseInt(n === 1 ? hex[i] + hex[i] : hex.slice(i * 2, i * 2 + 2), 16);
		if (hex.length === 3 || hex.length === 4) return [x(0, 1), x(1, 1), x(2, 1), hex.length === 4 ? x(3, 1) / 255 : 1];
		if (hex.length === 6 || hex.length === 8) return [x(0, 2), x(1, 2), x(2, 2), hex.length === 8 ? x(3, 2) / 255 : 1];
		return null;
	}
	const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(v);
	if (fn) {
		const args = fn[2].trim();
		const legacy = args.includes(",");
		let parts: string[];
		let alpha: string | undefined;
		if (legacy) {
			parts = args.split(",").map((s) => s.trim());
			if (parts.length === 4) alpha = parts.pop();
		} else {
			const halves = args.split("/");
			if (halves.length > 2) return null;
			parts = halves[0].trim().split(/\s+/);
			if (halves.length === 2) alpha = halves[1].trim();
		}
		if (parts.length !== 3) return null;
		let a = 1;
		if (alpha !== undefined) {
			const x = alphaOf(alpha);
			if (x === null) return null;
			a = x;
		}
		if (fn[1].startsWith("rgb")) {
			if (legacy && !(parts.every((p) => PCT_TOKEN.test(p)) || parts.every((p) => NUM_TOKEN.test(p)))) return null;
			const r = channel(parts[0]);
			const g = channel(parts[1]);
			const b = channel(parts[2]);
			return r === null || g === null || b === null ? null : [r, g, b, a];
		}
		const h = HUE_TOKEN.exec(parts[0]);
		const sl = parts.slice(1).map((p) => (PCT_TOKEN.test(p) ? Number(p.slice(0, -1)) : !legacy && NUM_TOKEN.test(p) ? Number(p) : null));
		if (!h || sl[0] === null || sl[1] === null) return null;
		let deg = Number(h[1]);
		if (h[2] === "turn") deg *= 360;
		else if (h[2] === "rad") deg = (deg * 180) / Math.PI;
		else if (h[2] === "grad") deg *= 0.9;
		return [...hslToRgb(deg, clamp01(sl[0] / 100), clamp01(sl[1] / 100)), a];
	}
	if (!hasOwn(CSS_NAMED_COLORS, v)) return null;
	const named = CSS_NAMED_COLORS[v];
	return [parseInt(named.slice(0, 2), 16), parseInt(named.slice(2, 4), 16), parseInt(named.slice(4, 6), 16), 1];
}

/**
 * Parse one CSS color (see `parseColorA`). `transparent`, `none`, `inherit`
 * and `currentColor` aren't colors (null).
 */
export function parseColor(input: string): RGB | null {
	const c = parseColorA(input);
	return c ? [c[0], c[1], c[2]] : null;
}

const toHex6 = (c: readonly number[]) => [c[0], c[1], c[2]].map((n) => n.toString(16).padStart(2, "0")).join("");

/**
 * The text written in place of currentColor for a literal color: a hex or
 * named color as written (letters, digits and '#' only), anything else rebuilt
 * from its numbers. Never the raw input: a quote or comment start in it would
 * re-pair the CSS strings of the declaration it lands in.
 */
function canonicalColor(input: string): string | null {
	const c = parseColorA(input);
	if (!c) return null;
	const v = input.trim();
	if (/^#[0-9a-fA-F]+$/.test(v) || /^[A-Za-z]+$/.test(v)) return v;
	return c[3] >= 1 ? `#${toHex6(c)}` : `rgba(${c[0]},${c[1]},${c[2]},${Math.round(c[3] * 1000) / 1000})`;
}

/**
 * A color every SVG parser reads (SVG 1.1 / CSS2: #rgb, #rrggbb, integer or
 * percent rgb(), the named colors but rebeccapurple). Newer syntaxes are kept,
 * but the expansion counter doesn't trust them to override an inherited paint.
 */
function universalColor(input: string): boolean {
	const v = input.trim().toLowerCase();
	if (v.length > 64) return false;
	if (/^#(?:[0-9a-f]{3}){1,2}$/.test(v)) return true;
	if (v !== "rebeccapurple" && hasOwn(CSS_NAMED_COLORS, v)) return true;
	const m = /^rgb\(([^()]*)\)$/.exec(v);
	if (!m) return false;
	const parts = m[1].split(",").map((p) => p.trim());
	return parts.length === 3 && (parts.every((p) => /^\d{1,3}$/.test(p)) || parts.every((p) => /^\d{1,3}(?:\.\d+)?%$/.test(p)));
}

/** Chebyshev distance between two colors. */
function chebyshev(a: RGB, b: RGB): number {
	return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

const NAMED_RGB: RGB[] = Object.values(CSS_NAMED_COLORS).map(
	(h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] as RGB,
);

/** Candidate k of the sentinel sequence (spec §2.7: starts far from every named color). */
export function sentinelCandidate(k: number): RGB {
	return [(0x17 + 37 * k) % 256, (((0xe9 - 53 * k) % 256) + 256) % 256, (0x5b + 97 * k) % 256];
}

/**
 * First candidate at Chebyshev distance >= 8 from every color in the SVG, the
 * root color and every named color. The plugin matches paints within 2/255,
 * so no real color can be mistaken for it. The sequence has period 256; null
 * when a crafted file blocks every candidate.
 */
export function pickSentinel(used: Iterable<string>): string | null {
	const blockers: RGB[] = NAMED_RGB.slice();
	for (const hex of used) blockers.push([parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]);
	for (let k = 0; k < 256; k++) {
		const c = sentinelCandidate(k);
		let clear = true;
		for (const b of blockers) {
			if (chebyshev(c, b) < 8) {
				clear = false;
				break;
			}
		}
		if (clear) return `#${toHex6(c).toUpperCase()}`;
	}
	return null;
}

// ===========================================================================
// Small string helpers (all linear)
// ===========================================================================

const URL_START = /url\s*\(/gi;

function hasUrl(v: string): boolean {
	URL_START.lastIndex = 0;
	return URL_START.test(v);
}

const isCssSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

interface UrlToken {
	start: number;
	end: number;
	/** The id of a local reference (#id), or null for anything else (external). */
	ref: string | null;
}

/**
 * Every url(...) in a value, read the way CSS reads it: a quoted URL runs to
 * the matching quote, an unquoted one to ')'. null when one isn't well formed
 * (unterminated, junk before ')', or a local reference to an id REF_ID
 * rejects); callers then drop the whole value, since another parser could
 * read it differently. Each scan resumes after the previous token, so time
 * is linear ("url(url(url(…" included).
 */
function scanUrls(v: string): UrlToken[] | null {
	if (!/url/i.test(v)) return NO_URLS;
	const out: UrlToken[] = [];
	URL_START.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = URL_START.exec(v))) {
		let j = m.index + m[0].length;
		while (isCssSpace(v[j])) j++;
		let body: string;
		const q = v[j];
		if (q === '"' || q === "'") {
			const close = v.indexOf(q, j + 1);
			if (close < 0) return null;
			body = v.slice(j + 1, close);
			j = close + 1;
			while (isCssSpace(v[j])) j++;
			if (v[j] !== ")") return null;
		} else {
			const close = v.indexOf(")", j);
			if (close < 0) return null;
			body = v.slice(j, close);
			let e = body.length;
			while (e > 0 && isCssSpace(body[e - 1])) e--;
			body = body.slice(0, e);
			// An unquoted URL can't contain quotes, '(' or whitespace (CSS makes it a bad-url).
			if (/[\s"'(]/.test(body)) return null;
			j = close;
		}
		let ref: string | null = null;
		if (body.startsWith("#")) {
			ref = body.slice(1);
			if (!REF_ID.test(ref)) return null;
		}
		out.push({ start: m.index, end: j + 1, ref });
		URL_START.lastIndex = j + 1;
	}
	return out;
}

/** Shared empty results (never mutated), so values without url() allocate nothing. */
const NO_URLS: UrlToken[] = [];
const NO_REFS: string[] = [];

/** Local ids referenced by url(#id) in a sanitized value (in order, repeats kept). */
function urlRefs(v: string): readonly string[] {
	const tokens = scanUrls(v);
	if (!tokens || tokens.length === 0) return NO_REFS;
	const out: string[] = [];
	for (const t of tokens) if (t.ref !== null) out.push(t.ref);
	return out;
}

/** Replace the url() tokens `keep` rejects with `none`. */
function replaceUrls(v: string, tokens: UrlToken[], keep: (t: UrlToken) => boolean): string {
	const parts: string[] = [];
	let at = 0;
	for (const t of tokens) {
		if (keep(t)) continue;
		parts.push(v.slice(at, t.start), "none");
		at = t.end;
	}
	parts.push(v.slice(at));
	return parts.join("");
}

/** javascript:, vbscript: and data:text survive whitespace and control-character obfuscation. */
function hasDangerousScheme(v: string): boolean {
	const s = v.replace(/[\s\u0000-\u001f\u007f]+/g, "").toLowerCase();
	return s.includes("javascript:") || s.includes("vbscript:") || s.includes("data:text");
}

/** Replace currentColor outside url(...) segments. */
function replaceCurrentColor(v: string, rep: string): string {
	if (!/currentcolor/i.test(v)) return v;
	const out: string[] = [];
	let i = 0;
	while (i < v.length) {
		URL_START.lastIndex = i;
		const m = URL_START.exec(v);
		const end = m ? m.index : v.length;
		out.push(v.slice(i, end).replace(/currentcolor/gi, rep));
		if (!m) break;
		const close = v.indexOf(")", m.index);
		const stop = close < 0 ? v.length : close + 1;
		out.push(v.slice(m.index, stop));
		i = stop;
	}
	return out.join("");
}

/** The color in a paint value, ignoring url(...) parts ("url(#g) red" → red). */
function colorOfValue(v: string): RGB | null {
	// `\)?` instead of `\)`: an unclosed url( strips to the end without backtracking over the tail.
	const stripped = hasUrl(v) ? v.replace(/url\s*\([^)]*\)?/gi, " ") : v;
	return parseColor(stripped);
}

/** How a paint or marker value is kept and counted (see `paintKind`). */
const PAINT_DROP = 0;
const PAINT_MAY_INHERIT = 1;
const PAINT_OVERRIDES = 2;
type PaintKind = typeof PAINT_DROP | typeof PAINT_MAY_INHERIT | typeof PAINT_OVERRIDES;

/**
 * A fill, stroke, marker-start or marker-end value (`decl`: in CSS, where a
 * trailing !important is allowed; a presentation attribute can't carry one).
 * CSS ignores a value its grammar rejects, and the element then inherits its
 * parent's value (fill="bogus", "", "#12345", "url(#p) junk", "red !important"
 * as an attribute all inherit in browsers), so such values are dropped
 * (PAINT_DROP) rather than counted as overriding the parent. PAINT_OVERRIDES:
 * none, currentColor, a color every SVG parser reads, or url(#id) with an
 * optional none / currentColor / such a color fallback (markers: none or
 * url(#id) only). PAINT_MAY_INHERIT: kept, but the parent's value stays
 * possible (CSS-wide keywords, and newer color syntaxes an SVG 1.1 parser
 * may reject and so inherit through).
 */
function paintKind(prop: string, raw: string, decl: boolean): PaintKind {
	let v = raw.trim();
	const bang = v.indexOf("!");
	if (bang >= 0) {
		if (!decl || !/^!\s*important$/i.test(v.slice(bang))) return PAINT_DROP;
		v = v.slice(0, bang).trim();
	}
	if (v.length === 0) return PAINT_DROP;
	const lower = v.length <= 16 ? v.toLowerCase() : "";
	if (lower === "none") return PAINT_OVERRIDES;
	if (lower === "initial" || CSS_WIDE_KEYWORD.test(v)) return PAINT_MAY_INHERIT;
	const marker = prop === "marker-start" || prop === "marker-end";
	if (!marker && lower === "currentcolor") return PAINT_OVERRIDES;
	if (v.slice(0, 4).toLowerCase() === "url(") {
		const tokens = scanUrls(v);
		if (!tokens || tokens.length !== 1 || tokens[0].start !== 0 || tokens[0].ref === null) return PAINT_DROP;
		v = v.slice(tokens[0].end).trim();
		if (v === "") return PAINT_OVERRIDES;
		if (marker) return PAINT_DROP;
		const fallback = v.length <= 16 ? v.toLowerCase() : "";
		if (fallback === "none" || fallback === "currentcolor") return PAINT_OVERRIDES;
	} else if (marker) return PAINT_DROP;
	if (universalColor(v)) return PAINT_OVERRIDES;
	if (parseColorA(v) || v.toLowerCase() === "transparent") return PAINT_MAY_INHERIT;
	return PAINT_DROP;
}

/**
 * var() and env(): custom properties can't be declared here (names start
 * with a letter), so these resolve to their fallback or make the property
 * invalid at computed-value time, which inherits: either way the counter
 * would read a different value than the renderer. Removed wherever they appear.
 */
const SUBSTITUTION_FN = /(?<![\w-])(?:var|env)\s*\(/i;

/**
 * Attributes that aren't CSS properties, and properties CSS doesn't inherit:
 * an element's descendants never receive these, so their markup is charged
 * only where it is written. Every other attribute and declaration (unknown
 * names included) may be inherited, so the expansion counter charges its
 * markup again at every element below the one that writes it.
 */
const NOT_PROPERTY_ATTRS = new Set([
	"id", "class", "href", "xlink:href", "xml:space", "viewBox", "preserveAspectRatio", "points", "offset",
	"gradientUnits", "gradientTransform", "spreadMethod", "patternUnits", "patternContentUnits", "patternTransform",
	"clipPathUnits", "maskUnits", "maskContentUnits", "markerUnits", "markerWidth", "markerHeight", "refX", "refY",
	"orient", "filterUnits", "primitiveUnits", "stdDeviation", "in", "in2", "result", "mode", "operator", "values",
	"type", "x1", "y1", "x2", "y2", "fx", "fy", "fr", "dx", "dy", "pathLength", "textLength", "lengthAdjust",
	"startOffset", "tableValues", "slope", "intercept", "amplitude", "exponent", "k1", "k2", "k3", "k4",
]);
/** Non-inherited CSS properties: their CSS-wide keywords are removed (`inherit` would copy the parent's value down). */
const NOT_INHERITED_PROPS = new Set([
	"transform", "transform-origin", "transform-box", "rotate", "x", "y", "width", "height", "cx", "cy", "r", "rx", "ry",
	"d", "opacity", "clip-path", "mask", "filter", "stop-color", "stop-opacity", "flood-color", "flood-opacity",
	"lighting-color", "display", "overflow", "clip", "mix-blend-mode", "isolation", "vector-effect", "baseline-shift",
	"alignment-baseline", "text-decoration", "unicode-bidi", "mask-type",
]);
const notInherited = (name: string) => NOT_PROPERTY_ATTRS.has(name) || NOT_INHERITED_PROPS.has(name);

// ===========================================================================
// CSS (style attributes and <style> text)
// ===========================================================================

const NOTES_OMITTED = "Further notes omitted.";

/** Notes for one SVG: distinct, at most MAX_NOTES (then one "omitted" note), so crafted input can't grow them. */
class NoteSet {
	private readonly set = new Set<string>();
	add(note: string): void {
		if (this.set.has(note)) return;
		this.set.add(this.set.size < MAX_NOTES ? note : NOTES_OMITTED);
	}
	has(note: string): boolean {
		return this.set.has(note);
	}
	list(): string[] {
		return [...this.set];
	}
}

interface CssContext {
	externalRefs: number;
	notes: NoteSet;
}

/** Remove comments outside strings. */
function stripCssComments(css: string): string {
	if (!css.includes("/*")) return css;
	const out: string[] = [];
	let i = 0;
	let start = 0;
	while (i < css.length) {
		const c = css[i];
		if (c === '"' || c === "'") {
			const e = css.indexOf(c, i + 1);
			i = e < 0 ? css.length : e + 1;
			continue;
		}
		if (c === "/" && css[i + 1] === "*") {
			out.push(css.slice(start, i));
			const e = css.indexOf("*/", i + 2);
			i = e < 0 ? css.length : e + 2;
			start = i;
			out.push(" ");
			continue;
		}
		i++;
	}
	out.push(css.slice(start));
	return out.join("");
}

/** Split on a separator outside strings and parentheses. */
function splitTopLevel(text: string, sep: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"' || c === "'") {
			const e = text.indexOf(c, i + 1);
			i = e < 0 ? text.length : e + 1;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")") depth = Math.max(0, depth - 1);
		else if (c === sep && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
		i++;
	}
	parts.push(text.slice(start));
	return parts;
}

function count(s: string, ch: string): number {
	let n = 0;
	for (let i = s.indexOf(ch); i >= 0; i = s.indexOf(ch, i + 1)) n++;
	return n;
}

const CSS_FORBIDDEN = /expression\s*\(|behavior|-moz-binding|javascript:/i;

/**
 * What to do with a property/value pair, shared by presentation attributes
 * and CSS declarations. "drop": remove it. "fetch": remove it and count an
 * external reference (a fetch without url(), e.g. image-set("…")).
 * "external": it has an external url(): attributes are removed, CSS replaces
 * the url() with none; counts an external reference. "strip": a property
 * that may not reference anything has local url()s: attributes are removed,
 * CSS replaces them with none. null: keep. `tokens` are the value's url() tokens.
 */
function refPolicy(prop: string, value: string, tokens: UrlToken[] | null): "drop" | "fetch" | "external" | "strip" | null {
	// `all: inherit` would copy clip-path, mask and filter down.
	if (prop === "all") return "drop";
	if ((REF_COPYING_PROP.test(prop) || NOT_INHERITED_PROPS.has(prop)) && CSS_WIDE_KEYWORD.test(value.trim())) return "drop";
	if (SUBSTITUTION_FN.test(value)) return "drop";
	if ((prop === "fill" || prop === "stroke") && CONTEXT_PAINT.test(value)) return "drop";
	if (CSS_FETCH.test(value)) return "fetch";
	if (tokens === null) return "drop";
	if (tokens.length === 0) return null;
	const external = tokens.some((t) => t.ref === null);
	if (external) return "external";
	// Only the reference properties keep a url(); mask-image, -webkit-mask, cursor, background… lose it.
	return URL_PROPS.has(prop) ? null : "strip";
}

/** Sanitized "prop:value" declarations (joined by ';'), or "" when none survive. */
function sanitizeDeclarations(text: string, ctx: CssContext): string {
	const kept: string[] = [];
	for (const raw of splitTopLevel(stripCssComments(text), ";")) {
		const colon = raw.indexOf(":");
		if (colon < 0) continue;
		const prop = raw.slice(0, colon).trim().toLowerCase();
		let value = raw.slice(colon + 1).trim();
		if (!/^-?[a-z][a-z0-9-]*$/.test(prop) || value.length === 0) continue;
		if (raw.includes("\\")) continue;
		// Unbalanced parentheses or quotes swallow the following declarations; drop rather than guess.
		if (count(raw, "(") !== count(raw, ")") || count(raw, '"') % 2 === 1 || count(raw, "'") % 2 === 1) continue;
		if (CSS_FORBIDDEN.test(raw) || hasDangerousScheme(raw)) continue;
		// marker / marker-mid repeat a marker at every vertex: an unbounded multiplier.
		if (prop === "marker-mid" || prop === "marker") {
			ctx.notes.add("marker-mid removed.");
			continue;
		}
		const tokens = scanUrls(value);
		const policy = refPolicy(prop, value, tokens);
		if (policy === "drop") continue;
		if (policy === "fetch" || policy === "external") ctx.externalRefs++;
		if (policy === "fetch") continue;
		if (policy !== null && tokens) value = replaceUrls(value, tokens, (t) => t.ref !== null && URL_PROPS.has(prop));
		value = value.replace(/\s+/g, " ");
		if (SLOT_PROP_SET.has(prop) && paintKind(prop, value, true) === PAINT_DROP) {
			ctx.notes.add(INVALID_PAINT_NOTE);
			continue;
		}
		kept.push(`${prop}:${value}`);
	}
	return kept.join(";");
}

const SELECTOR_OK = /^[A-Za-z0-9_.#\-\s,>*:]+$/;

interface CssRule {
	selector: string;
	declarations: string;
}

/** Parse a stylesheet into rules, dropping at-rules (with their blocks) and anything malformed. */
function parseStylesheet(css: string): CssRule[] {
	const text = stripCssComments(css);
	const rules: CssRule[] = [];
	let i = 0;
	while (i < text.length) {
		// selector (or at-rule prelude) up to '{' or ';'
		let j = i;
		while (j < text.length && text[j] !== "{" && text[j] !== ";" && text[j] !== "}") {
			if (text[j] === '"' || text[j] === "'") {
				const e = text.indexOf(text[j], j + 1);
				j = e < 0 ? text.length : e + 1;
				continue;
			}
			j++;
		}
		if (j >= text.length) break;
		const prelude = text.slice(i, j).trim();
		if (text[j] === ";" || text[j] === "}") {
			i = j + 1; // statement at-rule (@import …;) or stray token
			continue;
		}
		// balanced block
		let depth = 0;
		let k = j;
		for (; k < text.length; k++) {
			const c = text[k];
			if (c === '"' || c === "'") {
				const e = text.indexOf(c, k + 1);
				if (e < 0) {
					k = text.length;
					break;
				}
				k = e;
				continue;
			}
			if (c === "{") depth++;
			else if (c === "}") {
				depth--;
				if (depth === 0) break;
			}
		}
		if (k >= text.length) break; // unterminated block: drop the rest
		if (!prelude.startsWith("@")) rules.push({ selector: prelude, declarations: text.slice(j + 1, k) });
		i = k + 1;
	}
	return rules;
}

function sanitizeStylesheet(css: string, ctx: CssContext): { text: string; rules: CssRule[] } {
	const out: CssRule[] = [];
	for (const rule of parseStylesheet(css)) {
		if (!SELECTOR_OK.test(rule.selector)) continue;
		if (rule.selector.includes("\\") || rule.declarations.includes("\\")) continue;
		if (/[{}]/.test(rule.declarations)) continue;
		const decls = sanitizeDeclarations(rule.declarations, ctx);
		if (!decls) continue;
		out.push({ selector: rule.selector.replace(/\s+/g, " ").trim(), declarations: decls });
	}
	return { text: out.map((r) => `${r.selector}{${r.declarations}}`).join(""), rules: out };
}

function declarationsOf(text: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const d of splitTopLevel(text, ";")) {
		const c = d.indexOf(":");
		if (c > 0) out.push([d.slice(0, c).trim().toLowerCase(), d.slice(c + 1).trim()]);
	}
	return out;
}

// ===========================================================================
// Tokenizer (strict XML subset) → raw tree
// ===========================================================================

interface XAttr {
	qname: string;
	prefix: string | null;
	local: string;
	/** Resolved namespace of a prefixed attribute (UNBOUND when the prefix isn't bound); null or absent when unprefixed. */
	ns?: string | null;
	value: string;
}
interface XEl {
	t: 1;
	qname: string;
	prefix: string | null;
	local: string;
	ns: string;
	attrs: XAttr[];
	children: XNode[];
}
interface XText {
	t: 2;
	text: string;
}
type XNode = XEl | XText;

const BUILTIN_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function lineCol(src: string, pos: number): string {
	let line = 1;
	let last = -1;
	for (let i = 0; i < pos && i < src.length; i++) {
		if (src.charCodeAt(i) === 10) {
			line++;
			last = i;
		}
	}
	return `line ${line}, column ${pos - last}`;
}

function validCodePoint(cp: number): boolean {
	return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

class Tokenizer {
	private readonly n: number;
	readonly entities = new Map<string, string>();
	readonly notes = new NoteSet();
	private elementCount = 0;
	private attrCount = 0;
	/** Characters added by declared entities so far (bounded by MAX_ENTITY_EXPANSION). */
	private entityGrowth = 0;
	private firstUnknownEntity: string | null = null;
	private firstDuplicateAttr: string | null = null;
	/**
	 * Namespace scope: the URIs bound to each prefix, innermost last, and the
	 * default namespaces in force. Each open element records what it pushed, so
	 * its end tag pops exactly that: memory is one entry per declaration, never
	 * a copy of the scope per element.
	 */
	private readonly bindings = new Map<string, string[]>();
	private readonly defaults: string[] = [];
	private readonly scopes: Array<{ prefixes: string[] | null; def: boolean }> = [];

	constructor(private readonly src: string) {
		this.n = src.length;
	}

	private fail(pos: number, message: string): never {
		throw new SanitizeError(`${lineCol(this.src, pos)}: ${message}`);
	}

	private startsWith(s: string, i: number): boolean {
		return this.src.startsWith(s, i);
	}

	/** Entity and character references; bare '&' stays literal (lenient with hand-written titles). */
	private decode(raw: string): string {
		if (raw.indexOf("&") < 0) return raw;
		const parts: string[] = [];
		let i = 0;
		for (;;) {
			const amp = raw.indexOf("&", i);
			if (amp < 0) {
				parts.push(raw.slice(i));
				break;
			}
			parts.push(raw.slice(i, amp));
			// Bounded look-ahead for ';' keeps "&&&…" inputs linear.
			let semi = -1;
			for (let k = amp + 1; k < raw.length && k <= amp + 41; k++) {
				const ch = raw.charCodeAt(k);
				if (ch === 59) {
					semi = k;
					break;
				}
				if (ch === 38 || ch === 60) break;
			}
			if (semi < 0) {
				parts.push("&");
				i = amp + 1;
				continue;
			}
			const ref = raw.slice(amp + 1, semi);
			if (ref[0] === "#") {
				const hex = ref[1] === "x" || ref[1] === "X";
				const digits = ref.slice(hex ? 2 : 1);
				const cp = (hex ? /^[0-9a-fA-F]{1,6}$/ : /^\d{1,7}$/).test(digits) ? parseInt(digits, hex ? 16 : 10) : -1;
				if (validCodePoint(cp)) parts.push(String.fromCodePoint(cp));
				else this.notes.add("Invalid character reference removed.");
			} else if (/^[A-Za-z_][\w.-]*$/.test(ref)) {
				const builtin = BUILTIN_ENTITIES[ref];
				const v = builtin ?? this.entities.get(ref);
				if (v !== undefined && builtin === undefined) {
					// Checked before the value is added, so memory stays bounded however many references follow.
					this.entityGrowth += v.length;
					if (this.entityGrowth > MAX_ENTITY_EXPANSION) {
						throw new SanitizeError(`DOCTYPE entities in this SVG expand to more than ${formatMB(MAX_ENTITY_EXPANSION)} of text. Expand them in the file, or remove the DOCTYPE.`);
					}
				}
				if (v !== undefined) parts.push(v);
				else if (this.firstUnknownEntity === null) {
					// One note names the first; a note per distinct name would grow with the input.
					this.firstUnknownEntity = ref;
					this.notes.add(ref.length <= 32 ? `Unknown entity &${ref}; removed.` : "Unknown entity removed.");
				} else if (ref !== this.firstUnknownEntity) this.notes.add("Other unknown entities removed.");
			} else {
				parts.push("&");
				i = amp + 1;
				continue;
			}
			i = semi + 1;
		}
		return parts.join("");
	}

	private skipQuoted(i: number): number {
		const q = this.src[i];
		const e = this.src.indexOf(q, i + 1);
		if (e < 0) this.fail(i, "unterminated quoted string in the DOCTYPE.");
		return e + 1;
	}

	private readName(i: number): number {
		if (i >= this.n || !NAME_START.test(this.src[i])) return i;
		let j = i + 1;
		while (j < this.n && NAME_CHAR.test(this.src[j])) j++;
		return j;
	}

	private skipWs(i: number): number {
		while (i < this.n) {
			const c = this.src.charCodeAt(i);
			if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
			i++;
		}
		return i;
	}

	/** <!DOCTYPE …> with an optional internal subset; records safe general internal entities. */
	private doctype(start: number): number {
		let j = start + 9;
		while (j < this.n) {
			const c = this.src[j];
			if (c === '"' || c === "'") {
				j = this.skipQuoted(j);
				continue;
			}
			if (c === "[") {
				j = this.internalSubset(j + 1);
				continue;
			}
			if (c === ">") return j + 1;
			j++;
		}
		this.fail(start, "unterminated DOCTYPE.");
	}

	private internalSubset(j: number): number {
		const start = j;
		while (j < this.n) {
			const c = this.src[j];
			if (c === " " || c === "\t" || c === "\n" || c === "\r") {
				j++;
			} else if (c === "]") {
				return j + 1;
			} else if (this.startsWith("<!--", j)) {
				const e = this.src.indexOf("-->", j + 4);
				if (e < 0) this.fail(j, "unterminated comment.");
				j = e + 3;
			} else if (this.startsWith("<?", j)) {
				const e = this.src.indexOf("?>", j + 2);
				if (e < 0) this.fail(j, "unterminated processing instruction.");
				j = e + 2;
			} else if (this.startsWith("<!ENTITY", j)) {
				j = this.entityDecl(j + 8);
			} else if (this.startsWith("<!", j)) {
				j += 2;
				while (j < this.n && this.src[j] !== ">") {
					if (this.src[j] === '"' || this.src[j] === "'") j = this.skipQuoted(j);
					else j++;
				}
				j++;
			} else if (c === "%") {
				const e = this.src.indexOf(";", j);
				if (e < 0 || e - j > 64) this.fail(j, "malformed parameter entity reference in the DOCTYPE.");
				this.notes.add("External or parameter entities ignored.");
				j = e + 1;
			} else {
				j++;
			}
		}
		this.fail(start, "unterminated DOCTYPE internal subset.");
	}

	private entityDecl(j: number): number {
		j = this.skipWs(j);
		let param = false;
		if (this.src[j] === "%") {
			param = true;
			j = this.skipWs(j + 1);
		}
		const nameEnd = this.readName(j);
		const name = this.src.slice(j, nameEnd);
		j = this.skipWs(nameEnd);
		let value: string | null = null;
		let external = false;
		if (this.src[j] === '"' || this.src[j] === "'") {
			const e = this.src.indexOf(this.src[j], j + 1);
			if (e < 0) this.fail(j, "unterminated entity value.");
			value = this.src.slice(j + 1, e);
			j = e + 1;
		} else if (this.startsWith("SYSTEM", j) || this.startsWith("PUBLIC", j)) {
			external = true;
		}
		while (j < this.n && this.src[j] !== ">") {
			if (this.src[j] === '"' || this.src[j] === "'") j = this.skipQuoted(j);
			else j++;
		}
		if (j >= this.n) this.fail(j, "unterminated entity declaration.");
		if (param || external) this.notes.add("External or parameter entities ignored.");
		else if (
			value !== null &&
			name &&
			value.length <= MAX_ENTITY_VALUE &&
			!/[&<%]/.test(value) &&
			this.entities.size < MAX_ENTITIES &&
			!this.entities.has(name)
		) {
			// No '&' in values means no nesting, so no billion-laughs expansion.
			this.entities.set(name, value);
		}
		return j + 1;
	}

	parse(): XEl {
		const src = this.src;
		const stack: XEl[] = [];
		let root: XEl | null = null;
		let rootClosed = false;
		// Adjacent text and CDATA (split only by comments or PIs) become one text node, so
		// "a<??>" repeated can't make a million nodes: text nodes stay bounded by elements.
		let textOwner: XEl | null = null;
		const textParts: string[] = [];
		const addText = (owner: XEl, text: string) => {
			if (owner !== textOwner) flushText();
			textOwner = owner;
			textParts.push(text);
		};
		const flushText = () => {
			if (textOwner && textParts.length > 0) {
				textOwner.children.push({ t: 2, text: textParts.length === 1 ? textParts[0] : textParts.join("") });
			}
			textOwner = null;
			textParts.length = 0;
		};
		let i = 0;
		while (i < this.n) {
			const lt = src.indexOf("<", i);
			const textEnd = lt < 0 ? this.n : lt;
			if (textEnd > i) {
				const raw = src.slice(i, textEnd);
				if (stack.length > 0) {
					addText(stack[stack.length - 1], this.decode(raw));
				} else if (raw.trim() !== "") {
					if (rootClosed) this.fail(i, "content after the root element.");
					throw new SanitizeError("This isn't an SVG: there is text before the root element.");
				}
				i = textEnd;
				if (lt < 0) break;
			}
			// i is at '<'
			if (this.startsWith("<?", i)) {
				const e = src.indexOf("?>", i + 2);
				if (e < 0) this.fail(i, "unterminated processing instruction.");
				i = e + 2;
			} else if (this.startsWith("<!--", i)) {
				const e = src.indexOf("-->", i + 4);
				if (e < 0) this.fail(i, "unterminated comment.");
				i = e + 3;
			} else if (this.startsWith("<![CDATA[", i)) {
				const e = src.indexOf("]]>", i + 9);
				if (e < 0) this.fail(i, "unterminated CDATA section.");
				if (stack.length > 0) addText(stack[stack.length - 1], src.slice(i + 9, e));
				else if (src.slice(i + 9, e).trim() !== "") this.fail(i, rootClosed ? "content after the root element." : "text before the root element.");
				i = e + 3;
			} else if (this.startsWith("<!DOCTYPE", i) || this.startsWith("<!doctype", i)) {
				if (root) this.fail(i, "a DOCTYPE must come before the root element.");
				i = this.doctype(i);
			} else if (src[i + 1] === "/") {
				const nameEnd = this.readName(i + 2);
				const name = src.slice(i + 2, nameEnd);
				const close = this.skipWs(nameEnd);
				if (!name || src[close] !== ">") this.fail(i, "malformed end tag.");
				const open = stack[stack.length - 1];
				if (!open) this.fail(i, `</${shortName(name)}> has no matching start tag.`);
				if (open.qname !== name) this.fail(i, `</${shortName(name)}> doesn't close <${shortName(open.qname)}>.`);
				flushText();
				stack.pop();
				this.popScope();
				if (stack.length === 0) rootClosed = true;
				i = close + 1;
			} else {
				if (rootClosed) this.fail(i, "content after the root element.");
				flushText();
				const tag = this.startTag(i, stack);
				if (!root) root = tag.el;
				// A self-closing root (<svg/>) closes immediately.
				if (stack.length === 0) rootClosed = true;
				i = tag.next;
			}
		}
		if (stack.length > 0) throw new SanitizeError(`The SVG ends before <${shortName(stack[stack.length - 1].qname)}> is closed.`);
		if (!root) throw new SanitizeError("This isn't an SVG: it has no root element.");
		return root;
	}

	private startTag(i: number, stack: XEl[]): { el: XEl; next: number } {
		const src = this.src;
		const nameEnd = this.readName(i + 1);
		if (nameEnd === i + 1) this.fail(i, "'<' must start a tag (escape it as &lt; in text).");
		const qname = src.slice(i + 1, nameEnd);
		const colon = qname.indexOf(":");
		const localName = colon >= 0 ? qname.slice(colon + 1) : qname;
		const attrs: XAttr[] = [];
		const seen = new Set<string>();
		let j = nameEnd;
		let selfClosing = false;
		let parsed = 0;
		for (;;) {
			const before = j;
			j = this.skipWs(j);
			if (j >= this.n) this.fail(i, `<${shortName(qname)}> isn't closed with '>'.`);
			if (src[j] === "/" && src[j + 1] === ">") {
				selfClosing = true;
				j += 2;
				break;
			}
			if (src[j] === ">") {
				j++;
				break;
			}
			if (j === before && parsed > 0) this.fail(j, "attributes must be separated by whitespace.");
			parsed++;
			const an = this.readName(j);
			if (an === j) this.fail(j, `unexpected character in <${shortName(qname)}>.`);
			const aname = src.slice(j, an);
			j = this.skipWs(an);
			if (src[j] !== "=") this.fail(j, `attribute ${shortName(aname)} has no value.`);
			j = this.skipWs(j + 1);
			const q = src[j];
			if (q !== '"' && q !== "'") this.fail(j, "attribute values must be quoted.");
			const end = src.indexOf(q, j + 1);
			if (end < 0) this.fail(j, "unterminated attribute value.");
			const isImageHref = localName === "image" && (aname === "href" || aname.endsWith(":href"));
			const cap = isImageHref ? MAX_DATA_URI_BYTES : MAX_ATTR_VALUE;
			if (end - j - 1 > cap) this.fail(j, `an attribute value is longer than ${formatMB(cap)}.`);
			if (++this.attrCount > MAX_TOTAL_ATTRS) throw new SanitizeError(`The SVG has more than ${formatInt(MAX_TOTAL_ATTRS)} attributes.`);
			if (seen.has(aname)) {
				// One note names the first; a note per distinct name would grow with the input.
				if (this.firstDuplicateAttr === null) {
					this.firstDuplicateAttr = aname;
					this.notes.add(`Duplicate attribute ${shortName(aname)} ignored.`);
				} else if (aname !== this.firstDuplicateAttr) this.notes.add("Other duplicate attributes ignored.");
			} else {
				seen.add(aname);
				if (attrs.length >= MAX_ATTRS) this.fail(j, `an element has more than ${MAX_ATTRS} attributes.`);
				const ac = aname.indexOf(":");
				attrs.push({
					qname: aname,
					prefix: ac >= 0 ? aname.slice(0, ac) : null,
					local: ac >= 0 ? aname.slice(ac + 1) : aname,
					ns: null,
					value: this.decode(src.slice(j + 1, end)),
				});
			}
			j = end + 1;
		}

		if (++this.elementCount > MAX_ELEMENTS) throw new SanitizeError(`The SVG has more than ${formatInt(MAX_ELEMENTS)} elements.`);
		if (stack.length + 1 > MAX_DEPTH) throw new SanitizeError(`SVG nests elements more than ${MAX_DEPTH} deep.`);

		// Namespace scope: push this element's declarations, then resolve its name and attributes.
		let pushed: string[] | null = null;
		let def = false;
		for (const a of attrs) {
			if (a.prefix === null && a.local === "xmlns") {
				if (!def) {
					this.defaults.push(a.value);
					def = true;
				}
			} else if (a.prefix === "xmlns" && a.local) {
				let list = this.bindings.get(a.local);
				if (!list) this.bindings.set(a.local, (list = []));
				list.push(a.value);
				(pushed ??= []).push(a.local);
			}
		}
		this.scopes.push({ prefixes: pushed, def });
		const prefix = colon >= 0 ? qname.slice(0, colon) : null;
		const ns = prefix === null ? this.defaultNs() : this.resolve(prefix);
		for (const a of attrs) if (a.prefix !== null && a.prefix !== "xmlns") a.ns = this.resolve(a.prefix);

		const el: XEl = { t: 1, qname, prefix, local: localName, ns, attrs, children: [] };
		const parent = stack[stack.length - 1];
		if (parent) parent.children.push(el);
		if (selfClosing) this.popScope();
		else stack.push(el);
		return { el, next: j };
	}

	/** Unprefixed elements are SVG unless a non-empty default namespace says otherwise (lenient: many SVGs omit xmlns). */
	private defaultNs(): string {
		const d = this.defaults[this.defaults.length - 1];
		return d === undefined || d === "" ? SVG_NS : d;
	}

	private resolve(prefix: string): string {
		if (prefix === "xml") return XML_NS;
		const list = this.bindings.get(prefix);
		return list && list.length > 0 ? list[list.length - 1] : UNBOUND;
	}

	private popScope(): void {
		const scope = this.scopes.pop();
		if (!scope) return;
		if (scope.def) this.defaults.pop();
		if (scope.prefixes) for (const p of scope.prefixes) this.bindings.get(p)?.pop();
	}
}

/** Element of the raw (unsanitized) tree; attribute values and text are entity-decoded. */
export type RawSvgElement = XEl;
export type RawSvgNode = XNode;

/**
 * Parse without sanitizing, for SVG that comes from Figma's own exporter
 * (svg-code.ts rewrites colors and size in it). Same strict tokenizer and
 * caps as the sanitizer, so it is linear and bounded too.
 */
export function parseSvgRaw(src: string): { ok: true; root: RawSvgElement } | { ok: false; error: string } {
	try {
		return { ok: true, root: new Tokenizer(src).parse() };
	} catch (e) {
		if (e instanceof SanitizeError) return { ok: false, error: e.message };
		return { ok: false, error: UNREADABLE_MESSAGE };
	}
}

/** For anything that isn't a SanitizeError (e.g. a RangeError on a huge string); never echoes input. */
const UNREADABLE_MESSAGE = "Couldn't read this SVG: it is too large or too complex once expanded.";

// ===========================================================================
// Sanitize: raw tree → output tree
// ===========================================================================

interface OEl {
	name: string;
	attrs: Array<[string, string]>;
	children: ONode[];
	parent: OEl | null;
}
type ONode = OEl | string;

function getAttr(el: OEl, name: string): string | undefined {
	for (const [k, v] of el.attrs) if (k === name) return v;
	return undefined;
}
function setAttr(el: OEl, name: string, value: string): void {
	for (const a of el.attrs) {
		if (a[0] === name) {
			a[1] = value;
			return;
		}
	}
	el.attrs.push([name, value]);
}
function removeAttr(el: OEl, name: string): void {
	el.attrs = el.attrs.filter((a) => a[0] !== name);
}
function hrefOf(el: OEl): string | undefined {
	return getAttr(el, "href") ?? getAttr(el, "xlink:href");
}

function textOf(el: XEl): string {
	const parts: string[] = [];
	for (const c of el.children) if (c.t === 2) parts.push(c.text);
	return parts.join("");
}

interface State extends CssContext {
	/** By element name; a Map, so names like constructor or __proto__ are plain keys. */
	removedElements: Map<string, number>;
	removedAttributes: number;
	dataUriBytes: number;
	styleBytes: number;
	title?: string;
	taintedFilters: Set<OEl>;
}

/** Element names reported back in `removed.elements` (the rest count under OTHER_REMOVED). */
const REPORTABLE_NAME = /^[A-Za-z_][\w.:-]{0,63}$/;
const OTHER_REMOVED = "(other)";

/**
 * Removed element names reach the tool response, so only short plain names
 * are echoed, and at most MAX_REMOVED_KINDS of them: anything else counts
 * under "(other)".
 */
function countRemoved(st: State, name: string): void {
	const m = st.removedElements;
	const key = REPORTABLE_NAME.test(name) && (m.has(name) || m.size < MAX_REMOVED_KINDS) ? name : OTHER_REMOVED;
	m.set(key, (m.get(key) ?? 0) + 1);
}

function removedRecord(m: Map<string, number>): Record<string, number> {
	const out: Record<string, number> = Object.create(null);
	for (const [k, v] of m) out[k] = v;
	return out;
}

const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif);base64,/i;

/** Output attributes for one kept element. Returns null when the element must go (use/image without href). */
function sanitizeAttributes(x: XEl, name: string, st: State): Array<[string, string]> | null {
	const out: Array<[string, string]> = [];
	const has = new Set<string>();
	let href = false;
	const gradientBox = (name === "linearGradient" || name === "radialGradient") &&
		(() => {
			const u = x.attrs.find((a) => a.prefix === null && a.local === "gradientUnits");
			return !u || u.value.trim() === "objectBoundingBox";
		})();
	for (const a of x.attrs) {
		// Namespace declarations are regenerated on the root.
		if (a.prefix === "xmlns" || (a.prefix === null && a.local === "xmlns")) {
			if (a.prefix === "xmlns" && a.value !== XLINK_NS && a.value !== SVG_NS) st.removedAttributes++;
			continue;
		}
		let attrName: string;
		if (a.prefix === null) attrName = a.local;
		else {
			const ans = a.ns ?? UNBOUND;
			if (ans === XLINK_NS && a.local === "href") attrName = "xlink:href";
			else if (ans === XML_NS && a.local === "space") attrName = "xml:space";
			else {
				st.removedAttributes++;
				continue;
			}
		}
		const lower = attrName.toLowerCase();
		// Exact names only: CLIP-PATH, Style or HREF would pass every check below unseen.
		if (lower !== attrName && !CAMEL_ATTRS.has(attrName)) {
			st.removedAttributes++;
			continue;
		}
		if (lower.startsWith("on") || lower.startsWith("data-")) {
			st.removedAttributes++;
			continue;
		}
		// marker (the shorthand) and marker-mid repeat a marker at every vertex: an unbounded multiplier.
		if (lower === "marker-mid" || lower === "marker") {
			st.removedAttributes++;
			st.notes.add("marker-mid removed.");
			continue;
		}
		let value = a.value;
		// No SVG attribute needs a backslash, and browsers read most of them as CSS, where an
		// escape (cursor="u\72l(https://…)") is a url() that no textual check sees.
		if (value.includes("\\")) {
			st.removedAttributes++;
			continue;
		}
		if (hasDangerousScheme(value)) {
			st.removedAttributes++;
			continue;
		}
		if (attrName === "href" || attrName === "xlink:href") {
			const v = value.trim();
			if (v.startsWith("#") && LOCAL_HREF_ELEMENTS.has(name)) {
				// A local reference is an id (REF_ID); the counter resolves it exactly as written.
				if (!REF_ID.test(v.slice(1))) {
					st.removedAttributes++;
					continue;
				}
				value = v;
			} else if (v.startsWith("#")) {
				// Nothing follows a local href on other elements (filter, image, mask…), so none may keep one.
				st.removedAttributes++;
				continue;
			} else if (name === "image" && DATA_IMAGE.test(v.slice(0, 40))) {
				const body = v.slice(v.indexOf(",") + 1);
				if (!/^[A-Za-z0-9+/=\s]*$/.test(body)) {
					st.removedAttributes++;
					continue;
				}
				if (st.dataUriBytes + v.length > MAX_DATA_URI_BYTES) {
					st.removedAttributes++;
					st.notes.add(`Embedded images over ${formatMB(MAX_DATA_URI_BYTES)} in total were removed.`);
					continue;
				}
				st.dataUriBytes += v.length;
				value = v;
			} else if (name === "image" && /^data:image\/webp/i.test(v)) {
				st.removedAttributes++;
				st.notes.add("WebP images aren't supported by Figma; removed.");
				continue;
			} else {
				st.removedAttributes++;
				st.externalRefs++;
				continue;
			}
			href = true;
		} else if (attrName === "style") {
			value = sanitizeDeclarations(value, st);
			if (!value) {
				st.removedAttributes++;
				continue;
			}
		} else if (attrName === "id") {
			if (!REF_ID.test(value)) {
				st.removedAttributes++;
				continue;
			}
		} else {
			const policy = refPolicy(attrName, value, scanUrls(value));
			if (policy !== null) {
				st.removedAttributes++;
				if (policy === "fetch" || policy === "external") st.externalRefs++;
				continue;
			}
			if (SLOT_PROP_SET.has(attrName) && paintKind(attrName, value, false) === PAINT_DROP) {
				st.removedAttributes++;
				st.notes.add(INVALID_PAINT_NOTE);
				continue;
			}
		}
		if (gradientBox && /^(x1|y1|x2|y2|cx|cy|r|fx|fy)$/.test(attrName)) {
			const m = PERCENT.exec(value);
			if (m) {
				value = String(Number(m[1]) / 100);
				st.notes.add("Percentage gradient coordinates converted to fractions.");
			}
		}
		if (has.has(attrName)) {
			st.notes.add(`Duplicate attribute ${attrName} ignored.`);
			continue;
		}
		has.add(attrName);
		out.push([attrName, value]);
	}
	// Importers differ on which of href and xlink:href wins; keep only the one the counter follows.
	if (has.has("href") && has.has("xlink:href")) {
		st.removedAttributes++;
		return out.filter(([k]) => k !== "xlink:href");
	}
	if ((name === "use" || name === "image") && !href) return null;
	return out;
}

function sanitizeTree(rootX: XEl, st: State): OEl {
	if (rootX.ns !== SVG_NS || rootX.local !== "svg") {
		throw new SanitizeError(`This isn't an SVG: the root element is <${shortName(rootX.qname)}>.`);
	}
	const rootAttrs = sanitizeAttributes(rootX, "svg", st) ?? [];
	const root: OEl = { name: "svg", attrs: rootAttrs, children: [], parent: null };

	interface Work {
		x: XNode;
		parent: OEl;
		filter: OEl | null;
	}
	const work: Work[] = [];
	const pushChildren = (x: XEl, parent: OEl, filter: OEl | null) => {
		for (let k = x.children.length - 1; k >= 0; k--) work.push({ x: x.children[k], parent, filter });
	};
	pushChildren(rootX, root, null);

	while (work.length > 0) {
		const { x, parent, filter } = work.pop() as Work;
		if (x.t === 2) {
			if (x.text && TEXT_ELEMENTS.has(parent.name)) parent.children.push(x.text);
			continue;
		}
		if (x.ns !== SVG_NS) {
			countRemoved(st, x.qname);
			if (filter) st.taintedFilters.add(filter);
			continue;
		}
		const name = x.local;
		if (name === "title" || name === "desc") {
			if (name === "title" && st.title === undefined) {
				const t = textOf(x).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
				if (t) st.title = t.slice(0, MAX_TITLE_LENGTH);
			}
			continue;
		}
		if (name === "a") {
			pushChildren(x, parent, filter);
			continue;
		}
		if (!KEEP.has(name)) {
			countRemoved(st, name);
			if (filter) st.taintedFilters.add(filter);
			continue;
		}
		if (name === "style") {
			const type = x.attrs.find((a) => a.prefix === null && a.local === "type");
			if (type && type.value.trim().toLowerCase() !== "text/css" && type.value.trim() !== "") {
				countRemoved(st, "style");
				continue;
			}
			const css = textOf(x);
			if (css.length > MAX_STYLE_BYTES || st.styleBytes + css.length > MAX_STYLE_TOTAL_BYTES) {
				countRemoved(st, "style");
				st.notes.add(`A <style> over ${MAX_STYLE_BYTES / 1024} KB (or ${MAX_STYLE_TOTAL_BYTES / 1024} KB in total) was removed.`);
				continue;
			}
			st.styleBytes += css.length;
			const { text } = sanitizeStylesheet(css, st);
			if (!text) continue;
			parent.children.push({ name: "style", attrs: [], children: [text], parent });
			continue;
		}
		const attrs = sanitizeAttributes(x, name, st);
		if (!attrs) {
			countRemoved(st, name);
			continue;
		}
		const el: OEl = { name, attrs, children: [], parent };
		parent.children.push(el);
		pushChildren(x, el, name === "filter" ? el : filter);
	}
	return root;
}

// ===========================================================================
// Post-processing passes over the output tree
// ===========================================================================

function walkElements(root: OEl, fn: (el: OEl) => void): void {
	const stack: OEl[] = [root];
	while (stack.length > 0) {
		const el = stack.pop() as OEl;
		fn(el);
		for (let k = el.children.length - 1; k >= 0; k--) {
			const c = el.children[k];
			if (typeof c !== "string") stack.push(c);
		}
	}
}

/** Remove filters that lost a primitive, and every reference to them. */
function removeTaintedFilters(root: OEl, st: State): void {
	if (st.taintedFilters.size === 0) return;
	const ids = new Set<string>();
	const parents = new Set<OEl>();
	for (const f of st.taintedFilters) {
		const id = getAttr(f, "id");
		if (id) ids.add(id);
		if (f.parent) parents.add(f.parent);
		countRemoved(st, "filter");
	}
	// One pass per parent: filtering once per removed filter is quadratic next to many siblings.
	for (const p of parents) p.children = p.children.filter((c) => typeof c === "string" || !st.taintedFilters.has(c));
	st.notes.add("A filter used effects Figma can't import (e.g. turbulence), so it was removed.");
	const refsRemoved = (v: string) => urlRefs(v).some((r) => ids.has(r));
	walkElements(root, (el) => {
		const filter = getAttr(el, "filter");
		if (filter !== undefined && refsRemoved(filter)) removeAttr(el, "filter");
		const style = getAttr(el, "style");
		if (style !== undefined) {
			const kept = declarationsOf(style).filter(([p, v]) => !(p === "filter" && refsRemoved(v)));
			const text = kept.map(([p, v]) => `${p}:${v}`).join(";");
			if (text) setAttr(el, "style", text);
			else removeAttr(el, "style");
		}
		if (el.name === "style" && typeof el.children[0] === "string") {
			const css = el.children[0];
			const rules = parseStylesheet(css).map((r) => ({
				selector: r.selector.trim(),
				declarations: declarationsOf(r.declarations)
					.filter(([p, v]) => !(p === "filter" && refsRemoved(v)))
					.map(([p, v]) => `${p}:${v}`)
					.join(";"),
			}));
			el.children = [rules.filter((r) => r.declarations).map((r) => `${r.selector}{${r.declarations}}`).join("")];
		}
	});
}

/**
 * Only the first element with a given id keeps it. Importers differ on which
 * duplicate a reference (or an #id rule) resolves to, so the output must not
 * leave that choice open: the counter charges what the output says.
 */
function dedupeIds(root: OEl, st: State): void {
	const seen = new Set<string>();
	walkElements(root, (el) => {
		const id = getAttr(el, "id");
		if (id === undefined) return;
		if (!seen.has(id)) {
			seen.add(id);
			return;
		}
		removeAttr(el, "id");
		st.removedAttributes++;
		st.notes.add("Several elements had the same id; only the first one keeps it.");
	});
}

interface ColorScan {
	colors: Set<string>;
	ordered: string[];
	usesCurrentColor: boolean;
}

function addColor(scan: ColorScan, c: RGB | null): void {
	if (!c) return;
	const hex = toHex6(c);
	if (!scan.colors.has(hex)) {
		scan.colors.add(hex);
		scan.ordered.push(hex);
	}
}

function scanColors(root: OEl): ColorScan {
	const scan: ColorScan = { colors: new Set(), ordered: [], usesCurrentColor: false };
	walkElements(root, (el) => {
		for (const [k, v] of el.attrs) {
			if (COLOR_PROPS.has(k)) {
				addColor(scan, colorOfValue(v));
				if (/currentcolor/i.test(v)) scan.usesCurrentColor = true;
			} else if (k === "style") {
				for (const [p, v2] of declarationsOf(v)) {
					if (!COLOR_PROPS.has(p)) continue;
					addColor(scan, colorOfValue(v2));
					if (/currentcolor/i.test(v2)) scan.usesCurrentColor = true;
				}
			}
		}
		if (el.name === "style" && typeof el.children[0] === "string") {
			for (const rule of parseStylesheet(el.children[0])) {
				for (const [p, v] of declarationsOf(rule.declarations)) {
					if (!COLOR_PROPS.has(p)) continue;
					addColor(scan, colorOfValue(v));
					if (/currentcolor/i.test(v)) scan.usesCurrentColor = true;
				}
			}
		}
	});
	return scan;
}

/**
 * The element's own `color` (style wins over the attribute), when it's a
 * literal color, in canonical form (`canonicalColor`): it is written into
 * other declarations, so never as raw text.
 */
function ownColor(el: OEl): string | null {
	let value = getAttr(el, "color");
	const style = getAttr(el, "style");
	if (style) for (const [p, v] of declarationsOf(style)) if (p === "color") value = v;
	if (value === undefined) return null;
	const v = value.trim();
	if (v.length > 64 || hasUrl(v)) return null;
	return canonicalColor(v);
}

/**
 * currentColor whose effective color comes from a non-root ancestor (or the
 * element itself) is that literal color: it isn't the icon's themeable
 * color. Every other currentColor becomes the sentinel. `sentinel` and every
 * replacement are canonical colors (letters, digits, '#', commas, dots and
 * parentheses), so no declaration can change shape. In <style> text only
 * declaration values change: a selector that spells currentcolor stays as it is.
 */
function applyCurrentColor(root: OEl, sentinel: string): void {
	const stack: Array<{ el: OEl; eff: string | null }> = [{ el: root, eff: null }];
	while (stack.length > 0) {
		const { el, eff: inherited } = stack.pop() as { el: OEl; eff: string | null };
		const eff = el === root ? null : (ownColor(el) ?? inherited);
		const rep = eff ?? sentinel;
		for (const a of el.attrs) {
			if (CURRENT_COLOR_PROPS.has(a[0])) a[1] = replaceCurrentColor(a[1], rep);
			else if (a[0] === "style" && /currentcolor/i.test(a[1])) {
				a[1] = declarationsOf(a[1])
					.map(([p, v]) => `${p}:${CURRENT_COLOR_PROPS.has(p) ? replaceCurrentColor(v, rep) : v}`)
					.join(";");
			}
		}
		if (el.name === "style" && typeof el.children[0] === "string" && /currentcolor/i.test(el.children[0])) {
			el.children[0] = parseStylesheet(el.children[0])
				.map((r) => `${r.selector.trim()}{${declarationsOf(r.declarations).map(([p, v]) => `${p}:${replaceCurrentColor(v, sentinel)}`).join(";")}}`)
				.join("");
		}
		for (let k = el.children.length - 1; k >= 0; k--) {
			const c = el.children[k];
			if (typeof c !== "string") stack.push({ el: c, eff });
		}
	}
}

// ===========================================================================
// Reference expansion (use bombs, recursive references)
// ===========================================================================

/*
 * The model (spec §2.7 "Reference expansion"). Figma creates one node per
 * element it renders, and renders a referenced element again for every
 * reference. So an element rendered under some inherited values costs
 *   1 + its rendered children + its <use> target + every clip-path / mask /
 *   filter target + (at a painted shape) every pattern or gradient its
 *   effective fill and stroke name + (at a path-like shape) every marker its
 *   effective marker-start and marker-end name,
 * where "effective" follows inheritance: an element's own presentation
 * attribute, style attribute or matching <style> rule, else its parent's
 * value (a <use> passes its values into the referenced subtree). Pattern,
 * marker, clipPath and mask content inherits from where it is defined, not
 * from the referencing element, so a <pattern fill="url(#next)"> multiplies
 * and a pattern filled by its own ancestor is a loop. Elements are memoized
 * by (element, effective values).
 *
 * Markup is charged the same way: an element's own markup and the
 * declarations of every rule that can match it, at every rendered copy, plus
 * the markup it may pass down by inheritance (every attribute and
 * declaration but NOT_PROPERTY_ATTRS / NOT_INHERITED_PROPS) once per element
 * below it, and, for a url(#…) target, what its content inherits where it is
 * defined once per element of it. A sum over ancestors is an upper bound of
 * what any element inherits, so the total never comes out low.
 */

/**
 * The paint servers (or markers) one element may get for one inherited
 * property. Interned, so equal sets are one object. `big`: more than
 * MAX_REF_CANDIDATES, counted as over the cap wherever it is drawn.
 */
interface SlotVal {
	id: number;
	/** The targets' document-order indices, sorted. */
	ix: readonly number[];
	big: boolean;
}

/** Effective fill, stroke, marker-start and marker-end at one element (interned). */
interface Ctx {
	id: number;
	s: readonly SlotVal[];
}

/** One element's own value for a slot, and whether its parent's value stays possible. */
interface SlotDecl {
	refs: SlotVal;
	inherit: boolean;
}

interface Rec {
	cost: number;
	bytes: number;
	depth: number;
}

/** An element rendered with given effective slot values. */
interface Key {
	rule: false;
	el: OEl;
	ctx: Ctx;
	rec: Rec | null;
	visiting: boolean;
}

/**
 * Not an element: it costs nothing itself, only what it references. One per
 * <style> rule with clip-path / mask / filter references (`targets`), and one
 * per selector key (`subs`: the rules naming it). Elements point at their
 * keys' nodes, so rule references multiply through <use> and referenced
 * content like attributes, while memory stays keys + targets per rule (a copy
 * of every target under every key was keys × targets: 0.5 GB for 64 KB).
 */
interface RuleNode {
	rule: true;
	targets: Array<{ t: OEl; w: number }>;
	subs: RuleNode[];
	rec: Rec | null;
	visiting: boolean;
}

type ExpansionNode = Key | RuleNode;

interface Edge {
	t: ExpansionNode;
	/** How many copies of `t` the source creates (0: followed for cycle detection only). */
	w: number;
	/**
	 * Inherited markup per element of `t`, on top of `t`'s own: what a url(#…)
	 * target's content inherits where it is defined, which no ancestor of the
	 * referencing element accounts for.
	 */
	a: number;
}

interface Frame {
	node: ExpansionNode;
	edges: Edge[] | null;
	i: number;
	acc: number;
	bytes: number;
	/** The node's inheritable markup, charged once per element below it. */
	inh: number;
	/** Deepest child so far. */
	depth: number;
	/** Element frames from the entry to this one. */
	level: number;
	pending: Edge | null;
}

/** What the rules under one selector key declare. */
interface RuleKey {
	/** The key's node (one sub per rule with clip-path / mask / filter references), or null. */
	direct: RuleNode | null;
	/** Per slot, while rules are read: the candidates each rule names (deduplicated next to each other). */
	raw: Array<SlotVal[] | null> | null;
	/** Per slot: what the rules name (a rule may not match, so the parent's value stays possible). */
	slots: ReadonlyArray<SlotDecl | null>;
	/** Declarations of the rules naming the key: charged at every element it can match. */
	bytes: number;
	/** The inheritable part of `bytes`: charged again at every element below a matching one. */
	inh: number;
}

/** Static facts about one element, gathered once. */
interface Info {
	index: number;
	slots: ReadonlyArray<SlotDecl | null>;
	/** clip-path / mask / filter targets, one entry per reference. */
	direct: OEl[];
	rules: RuleNode[];
	/** Own markup (tag and attribute names, attribute values, text) and the declarations of matching rules. */
	bytes: number;
	/** The part of `bytes` the element's descendants may inherit. */
	inh: number;
	/** `inh` of every ancestor where the element is defined: what its content inherits as a url(#…) target. */
	anc: number;
	/** Nothing in its subtree depends on inherited slots (no shapes, <use> or patterns). */
	ctxFree: boolean;
	hasElementChildren: boolean;
	hasStops: boolean;
	/** Effective slots where the element is defined. */
	sctx: Ctx;
	/** The first key made for this element, then any others by ctx id. */
	key: Key | null;
	more: Map<number, Key> | null;
}

/** Shared empty values, so elements that declare nothing allocate nothing. */
const NO_SLOTS: ReadonlyArray<SlotDecl | null> = [null, null, null, null];
const NO_TARGETS: OEl[] = [];
const NO_RULES: RuleNode[] = [];
const NO_SUBS: RuleNode[] = [];

/** A slot's own declarations while an element is read. The two markers are shared and never mutated. */
interface SlotAcc {
	targets: OEl[];
	inherit: boolean;
}
const NOT_DECLARED: SlotAcc = { targets: [], inherit: false };
/** Declared with no reference, as a certain override (fill="red"): the parent's value no longer applies. */
const DECLARED_NONE: SlotAcc = { targets: [], inherit: false };

/** Paint-server parts: they draw nothing, so <style> rules that match them expand nothing (their markup still counts). */
const RULE_INERT = new Set(["linearGradient", "radialGradient", "stop"]);
const GRADIENTS = new Set(["linearGradient", "radialGradient"]);
/** Painted with fill and stroke: each one renders its paint servers again (Figma copies gradient stops into every paint). */
const PAINT_SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath"]);
/** Draw marker-start and marker-end. */
const MARKER_SHAPES = new Set(["path", "line", "polyline", "polygon"]);
/** Union map keys pack two value ids into one number; MAX_INTERNED keeps ids below this. */
const ID_SPAN = 2 ** 21;

/**
 * The index key a selector's matches are found by: the last compound's id, else
 * its first class, else its type, else "*" (every element). Lowercased. This
 * is a superset of what the selector matches (ancestors, other classes and
 * pseudo-classes only narrow it), so the expansion count never comes out low.
 */
function selectorKey(selector: string): string {
	const parts = selector.trim().split(/[\s>]+/);
	const last = parts[parts.length - 1] ?? "";
	const id = /#([\w-]+)/.exec(last);
	if (id) return `i:${id[1].toLowerCase()}`;
	const cls = /\.([\w-]+)/.exec(last);
	if (cls) return `c:${cls[1].toLowerCase()}`;
	const type = /^([A-Za-z][\w-]*)/.exec(last);
	if (type) return `t:${type[1].toLowerCase()}`;
	return "*";
}

class ExpansionCounter {
	private readonly ids = new Map<string, OEl>();
	/** <style> rules by selector key. */
	private readonly ruleKeys = new Map<string, RuleKey>();
	private readonly info = new Map<OEl, Info>();
	/** Every element in document order. */
	private readonly order: OEl[] = [];
	private readonly slotByKey = new Map<string, SlotVal>();
	private readonly unions = new Map<number, SlotVal>();
	private readonly ctxByKey = new Map<string, Ctx>();
	private nextId = 0;
	/**
	 * SlotVals, Ctxs and union entries made so far. Their number is chosen by
	 * the input (every element matching a different mix of class rules, every
	 * <use> passing different candidates down), so it is capped: past
	 * MAX_INTERNED the file can only be over the expansion caps anyway.
	 */
	private interned = 0;
	/** Edges inside rule nodes (key → rule, rule → target). */
	private ruleEdges = 0;
	private readonly EMPTY: SlotVal;
	private readonly BIG: SlotVal;
	private readonly EMPTY_CTX: Ctx;
	/** fill="red" and the like: declared, names nothing, overrides the parent's value. */
	private readonly NONE_DECL: SlotDecl;
	/** Slot tuples made only of NONE_DECL and null (the common case), shared by bit mask. */
	private readonly noneTuples: Array<Array<SlotDecl | null> | undefined> = [];
	private readonly framePool: Frame[] = [];
	readonly cap = MAX_EXPANDED_ELEMENTS;
	/**
	 * Steps (edges followed, elements entered) across every walk. Each step
	 * either adds at least 1 to a count that must stay under the cap or is
	 * bounded by the tree's own edges, so a file under every cap stays far
	 * below this; only definitions nobody draws, re-expanded under many
	 * different inherited values, can reach it.
	 */
	private work = 0;
	private readonly workLimit: number;

	constructor(root: OEl) {
		this.EMPTY = { id: this.nextId++, ix: [], big: false };
		this.BIG = { id: this.nextId++, ix: [], big: true };
		this.EMPTY_CTX = { id: this.nextId++, s: [this.EMPTY, this.EMPTY, this.EMPTY, this.EMPTY] };
		this.NONE_DECL = { refs: this.EMPTY, inherit: false };
		this.ctxByKey.set(this.ctxKey(this.EMPTY_CTX.s), this.EMPTY_CTX);

		const styles: string[] = [];
		walkElements(root, (el) => {
			this.info.set(el, {
				index: this.order.length,
				slots: NO_SLOTS,
				direct: NO_TARGETS,
				rules: NO_RULES,
				bytes: 0,
				inh: 0,
				anc: 0,
				ctxFree: true,
				hasElementChildren: false,
				hasStops: false,
				sctx: this.EMPTY_CTX,
				key: null,
				more: null,
			});
			this.order.push(el);
			if (el.name === "style" && typeof el.children[0] === "string") styles.push(el.children[0]);
			// dedupeIds left one element per id.
			const id = getAttr(el, "id");
			if (id !== undefined && !this.ids.has(id)) this.ids.set(id, el);
		});
		// Each rule's declarations are read once and each selector keyed once: linear in the stylesheet.
		for (const css of styles) for (const rule of parseStylesheet(css)) this.indexRule(rule);
		for (const rk of this.ruleKeys.values()) {
			const raw = rk.raw;
			if (!raw) continue;
			// One interned value per key and slot: folding rule by rule interned every intermediate union.
			rk.slots = raw.map((vals) => (vals ? { refs: this.slotOfMany(vals, NO_TARGETS), inherit: true } : null));
			rk.raw = null;
		}

		// Children come after their parent in document order, so a reverse pass sees them first.
		for (let k = this.order.length - 1; k >= 0; k--) {
			const el = this.order[k];
			const info = this.infoOf(el);
			let free = !PAINT_SHAPES.has(el.name) && !MARKER_SHAPES.has(el.name) && el.name !== "use" && el.name !== "pattern";
			for (const c of el.children) {
				if (typeof c === "string") continue;
				info.hasElementChildren = true;
				if (c.name === "stop") info.hasStops = true;
				if (!this.infoOf(c).ctxFree) free = false;
			}
			info.ctxFree = free;
		}

		// Document order: a parent's static slots and inherited markup are known before its children's.
		let staticEdges = this.ruleEdges;
		for (const el of this.order) {
			const info = this.infoOf(el);
			const parent = el.parent ? this.infoOf(el.parent) : null;
			this.gather(el, info);
			info.anc = parent ? parent.anc + parent.inh : 0;
			info.sctx = this.eff(info, parent ? parent.sctx : this.EMPTY_CTX);
			staticEdges += el.children.length + 1 + info.direct.length + info.rules.length;
			if (PAINT_SHAPES.has(el.name) || MARKER_SHAPES.has(el.name)) for (const v of info.sctx.s) staticEdges += v.ix.length;
		}
		// Every element expanded once where it's defined, plus what the caps allow on top.
		this.workLimit = 4 * this.cap + 2 * staticEdges + 4 * this.order.length;
	}

	private infoOf(el: OEl): Info {
		return this.info.get(el) as Info;
	}

	// ---- Slot values ---------------------------------------------------------

	private charge(): void {
		if (++this.interned > MAX_INTERNED) this.overflow();
	}

	/** The interned value for sorted, distinct element indices (at most MAX_REF_CANDIDATES). */
	private intern(ix: number[]): SlotVal {
		if (ix.length === 0) return this.EMPTY;
		const key = ix.join(",");
		let v = this.slotByKey.get(key);
		if (!v) {
			this.charge();
			this.slotByKey.set(key, (v = { id: this.nextId++, ix, big: false }));
		}
		return v;
	}

	/** Sorted distinct indices of `seen`, or the BIG value past MAX_REF_CANDIDATES. */
	private internSet(seen: Set<number>): SlotVal {
		return this.intern([...seen].sort((a, b) => a - b));
	}

	private slotOf(targets: readonly OEl[]): SlotVal {
		if (targets.length === 0) return this.EMPTY;
		const seen = new Set<number>();
		for (const t of targets) {
			seen.add(this.infoOf(t).index);
			if (seen.size > MAX_REF_CANDIDATES) return this.BIG;
		}
		return this.internSet(seen);
	}

	/** The union of `vals` and `extra`, interned once (no intermediate unions). */
	private slotOfMany(vals: readonly SlotVal[], extra: readonly OEl[]): SlotVal {
		let only: SlotVal | null = null;
		let many = false;
		for (const v of vals) {
			if (v.big) return this.BIG;
			if (v === this.EMPTY || v === only) continue;
			if (only === null) only = v;
			else many = true;
		}
		if (extra.length === 0 && !many) return only ?? this.EMPTY;
		if (only === null) return this.slotOf(extra);
		const seen = new Set<number>();
		for (const t of extra) {
			seen.add(this.infoOf(t).index);
			if (seen.size > MAX_REF_CANDIDATES) return this.BIG;
		}
		for (const v of vals) {
			for (const i of v.ix) {
				seen.add(i);
				if (seen.size > MAX_REF_CANDIDATES) return this.BIG;
			}
		}
		return this.internSet(seen);
	}

	/** Interned per pair; the sorted index lists merge in one pass. */
	private union(a: SlotVal, b: SlotVal): SlotVal {
		if (a === b || b === this.EMPTY) return a;
		if (a === this.EMPTY) return b;
		if (a.big || b.big) return this.BIG;
		const key = a.id < b.id ? a.id * ID_SPAN + b.id : b.id * ID_SPAN + a.id;
		let v = this.unions.get(key);
		if (v) return v;
		this.charge();
		const x = a.ix;
		const y = b.ix;
		const ix: number[] = [];
		let i = 0;
		let j = 0;
		while (i < x.length || j < y.length) {
			const n = j >= y.length || (i < x.length && x[i] < y[j]) ? x[i++] : i >= x.length || y[j] < x[i] ? y[j++] : (j++, x[i++]);
			ix.push(n);
			if (ix.length > MAX_REF_CANDIDATES) {
				v = this.BIG;
				break;
			}
		}
		v ??= this.intern(ix);
		this.unions.set(key, v);
		return v;
	}

	private ctxKey(s: readonly SlotVal[]): string {
		return `${s[0].id},${s[1].id},${s[2].id},${s[3].id}`;
	}

	private ctxOf(s: readonly SlotVal[]): Ctx {
		const key = this.ctxKey(s);
		let c = this.ctxByKey.get(key);
		if (!c) {
			this.charge();
			this.ctxByKey.set(key, (c = { id: this.nextId++, s }));
		}
		return c;
	}

	/** The element's effective slots given what it inherits. */
	private eff(info: Info, inherited: Ctx): Ctx {
		if (info.ctxFree) return this.EMPTY_CTX;
		let s: SlotVal[] | null = null;
		for (let k = 0; k < 4; k++) {
			const d = info.slots[k];
			if (!d) continue;
			const v = d.inherit ? this.union(d.refs, inherited.s[k]) : d.refs;
			if (v !== inherited.s[k]) (s ??= inherited.s.slice())[k] = v;
		}
		return s ? this.ctxOf(s) : inherited;
	}

	private merge(a: Ctx, b: Ctx): Ctx {
		if (a === b || b === this.EMPTY_CTX) return a;
		if (a === this.EMPTY_CTX) return b;
		return this.ctxOf(a.s.map((v, k) => this.union(v, b.s[k])));
	}

	/** fill/stroke name paint servers; marker-start/marker-end name markers. Anything else renders nothing. */
	private slotTarget(k: number, t: OEl): boolean {
		return k < 2 ? t.name === "pattern" || GRADIENTS.has(t.name) : t.name === "marker";
	}

	// ---- Static facts --------------------------------------------------------

	private indexRule(rule: CssRule): void {
		const direct = new Map<string, Map<OEl, number>>();
		const slots: Array<OEl[] | null> = [null, null, null, null];
		let bytes = 0;
		let inh = 0;
		for (const [p, v] of declarationsOf(rule.declarations)) {
			const n = p.length + v.length + 2;
			bytes += n;
			if (!notInherited(p)) inh += n;
			const k = (SLOT_PROPS as readonly string[]).indexOf(p);
			if (k >= 0) {
				// A rule may not match (selectors are matched as a superset), so it only adds candidates and
				// keeps the parent's value possible: one that names nothing and overrides adds nothing, while
				// `fill: inherit` (or anything less certain) adds the parent's value, which a rule always does.
				const refs = urlRefs(v);
				if (refs.length === 0 && paintKind(p, v, true) === PAINT_OVERRIDES) continue;
				const list = (slots[k] ??= []);
				for (const id of refs) {
					const t = this.ids.get(id);
					if (t && this.slotTarget(k, t)) list.push(t);
				}
				continue;
			}
			if (!DIRECT_REF_PROPS.has(p)) continue;
			// The cascade keeps one declaration per property, so a target counts as often as the
			// declaration naming it most often does (repeating a declaration adds nothing).
			const counts = new Map<OEl, number>();
			for (const id of urlRefs(v)) {
				const t = this.ids.get(id);
				if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
			}
			if (counts.size === 0) continue;
			let m = direct.get(p);
			if (!m) direct.set(p, (m = new Map()));
			for (const [t, c] of counts) m.set(t, Math.max(m.get(t) ?? 0, c));
		}
		const targets: Array<{ t: OEl; w: number }> = [];
		for (const m of direct.values()) for (const [t, w] of m) targets.push({ t, w });
		// One node per rule, shared by every key the selector list names.
		const node: RuleNode | null = targets.length > 0 ? { rule: true, targets, subs: NO_SUBS, rec: null, visiting: false } : null;
		if (node) this.ruleEdges += targets.length;
		const vals = slots.map((s) => (s ? this.slotOf(s) : null));
		const hasSlots = vals.some((v) => v !== null);
		for (const key of new Set(rule.selector.split(",").map(selectorKey))) {
			let rk = this.ruleKeys.get(key);
			if (!rk) this.ruleKeys.set(key, (rk = { direct: null, raw: null, slots: NO_SLOTS, bytes: 0, inh: 0 }));
			rk.bytes += bytes;
			rk.inh += inh;
			if (node) {
				rk.direct ??= { rule: true, targets: [], subs: [], rec: null, visiting: false };
				rk.direct.subs.push(node);
				this.ruleEdges++;
			}
			if (!hasSlots) continue;
			const raw = (rk.raw ??= [null, null, null, null]);
			for (let k = 0; k < 4; k++) {
				const v = vals[k];
				if (!v) continue;
				const list = (raw[k] ??= []);
				if (list[list.length - 1] !== v) list.push(v);
			}
		}
	}

	/**
	 * One own declaration of a slot or direct property (`decl`: from a style
	 * attribute). `own` collects, per slot, the targets named and whether the
	 * parent's value stays possible; it is allocated only when an element
	 * declares a slot. `live`: the element's slots can matter (not ctxFree).
	 */
	private read(info: Info, own: SlotAcc[] | null, p: string, v: string, decl: boolean, live: boolean): SlotAcc[] | null {
		const k = (SLOT_PROPS as readonly string[]).indexOf(p);
		if (k >= 0) {
			if (!live) return own;
			own ??= [NOT_DECLARED, NOT_DECLARED, NOT_DECLARED, NOT_DECLARED];
			const refs = urlRefs(v);
			const kind = paintKind(p, v, decl);
			if (refs.length === 0 && kind === PAINT_OVERRIDES) {
				if (own[k] === NOT_DECLARED) own[k] = DECLARED_NONE;
				return own;
			}
			let d = own[k];
			if (d === NOT_DECLARED || d === DECLARED_NONE) own[k] = d = { targets: [], inherit: false };
			// Only a certain override hides the parent's value (sanitizing removed what CSS ignores;
			// a keyword, or a color some parser may not read, keeps it possible).
			if (kind !== PAINT_OVERRIDES) d.inherit = true;
			for (const id of refs) {
				const t = this.ids.get(id);
				if (t && this.slotTarget(k, t)) d.targets.push(t);
			}
		} else if (DIRECT_REF_PROPS.has(p)) {
			for (const id of urlRefs(v)) {
				const t = this.ids.get(id);
				if (!t) continue;
				if (info.direct === NO_TARGETS) info.direct = [];
				info.direct.push(t);
				// Each costs at least 1: past the cap this element can only overflow.
				if (info.direct.length > this.cap) this.overflow(info.direct.length);
			}
		}
		return own;
	}

	/** Own slots, direct references, matching rules and markup size of one element. */
	private gather(el: OEl, info: Info): void {
		const live = !info.ctxFree;
		let bytes = el.name.length + 2;
		let inh = 0;
		let own: SlotAcc[] | null = null;
		for (const [k, v] of el.attrs) {
			const n = k.length + v.length + 4;
			bytes += n;
			if (k === "style") {
				for (const [p, v2] of declarationsOf(v)) {
					if (!notInherited(p)) inh += p.length + v2.length + 2;
					own = this.read(info, own, p, v2, true, live);
				}
			} else {
				if (!notInherited(k)) inh += n;
				own = this.read(info, own, k, v, false, live);
			}
		}
		for (const c of el.children) if (typeof c === "string") bytes += c.length;

		let ruleVals: Array<SlotVal[] | null> | null = null;
		if (this.ruleKeys.size > 0) {
			// Every element with a given id matches `#id`, not only the first one references resolve to.
			const keys = new Set(["*", `t:${el.name.toLowerCase()}`]);
			const id = getAttr(el, "id");
			if (id !== undefined) keys.add(`i:${id.trim().toLowerCase()}`);
			const cls = getAttr(el, "class");
			if (cls) for (const c of cls.split(/\s+/)) if (c) keys.add(`c:${c.toLowerCase()}`);
			for (const key of keys) {
				const rk = this.ruleKeys.get(key);
				if (!rk) continue;
				// Declarations apply wherever the rule matches, paint-server parts included.
				bytes += rk.bytes;
				inh += rk.inh;
				if (RULE_INERT.has(el.name)) continue;
				if (rk.direct) {
					if (info.rules === NO_RULES) info.rules = [];
					info.rules.push(rk.direct);
				}
				if (!live) continue;
				for (let k = 0; k < 4; k++) {
					const d = rk.slots[k];
					if (!d) continue;
					ruleVals ??= [null, null, null, null];
					(ruleVals[k] ??= []).push(d.refs);
				}
			}
		}
		info.bytes = bytes;
		info.inh = inh;
		// A ctxFree element's slots are never read (eff returns EMPTY_CTX): nothing to intern.
		if (!live || (!own && !ruleVals)) return;

		if (own && !ruleVals) {
			let mask = 0;
			let plain = true;
			for (let k = 0; k < 4; k++) {
				if (own[k] === DECLARED_NONE) mask |= 1 << k;
				else if (own[k] !== NOT_DECLARED) plain = false;
			}
			if (plain) {
				info.slots = this.noneTuples[mask] ??= [0, 1, 2, 3].map((k) => (mask & (1 << k) ? this.NONE_DECL : null));
				return;
			}
		}
		const slots: Array<SlotDecl | null> = [null, null, null, null];
		for (let k = 0; k < 4; k++) {
			const o = own ? own[k] : NOT_DECLARED;
			const rv = ruleVals ? ruleVals[k] : null;
			// A rule that can match may not: its candidates join the element's own, interned once,
			// and the parent's value stays possible.
			if (rv) slots[k] = { refs: this.slotOfMany(rv, o.targets), inherit: true };
			else if (o === DECLARED_NONE) slots[k] = this.NONE_DECL;
			else if (o !== NOT_DECLARED) slots[k] = { refs: this.slotOf(o.targets), inherit: o.inherit };
		}
		info.slots = slots;
	}

	// ---- Walk ----------------------------------------------------------------

	private keyFor(el: OEl, ctx: Ctx): Key {
		const info = this.infoOf(el);
		const c = info.ctxFree ? this.EMPTY_CTX : ctx;
		// Almost every element renders under one set of values: keep that key inline.
		if (info.key && info.key.ctx === c) return info.key;
		if (!info.key) return (info.key = { rule: false, el, ctx: c, rec: null, visiting: false });
		info.more ??= new Map();
		let k = info.more.get(c.id);
		if (!k) info.more.set(c.id, (k = { rule: false, el, ctx: c, rec: null, visiting: false }));
		return k;
	}

	/** The element rendered where it is defined (how url(#…) targets render). */
	private staticKey(el: OEl): Key {
		return this.keyFor(el, this.infoOf(el).sctx);
	}

	/** An edge to a url(#…) target: rendered where it is defined, inheriting what is declared above it there. */
	private refEdge(t: OEl, w: number): Edge {
		return { t: this.staticKey(t), w, a: this.infoOf(t).anc };
	}

	private slotEdges(v: SlotVal, out: Edge[]): void {
		if (v.big) this.overflow();
		for (const i of v.ix) out.push(this.refEdge(this.order[i], 1));
	}

	private edgesOf(k: Key): Edge[] {
		const el = k.el;
		const info = this.infoOf(el);
		const E = k.ctx;
		const out: Edge[] = [];
		for (const c of el.children) {
			if (typeof c === "string" || NON_RENDERED.has(c.name)) continue;
			// Ancestors' inherited markup is charged at the ancestors (once per element below them).
			out.push({ t: this.keyFor(c, this.eff(this.infoOf(c), E)), w: 1, a: 0 });
		}
		const href = hrefOf(el);
		const t = href !== undefined && href.startsWith("#") ? this.ids.get(href.slice(1)) : undefined;
		if (t) {
			// The referenced subtree inherits from the <use> (its shadow tree), not from where it is defined.
			if (el.name === "use") out.push({ t: this.keyFor(t, this.eff(this.infoOf(t), E)), w: 1, a: 0 });
			else if (el.name === "pattern" && t.name === "pattern") {
				// A pattern without children renders the referenced one's (SVG 1.1 §13.3), which may inherit from either.
				if (info.hasElementChildren) out.push({ t: this.staticKey(t), w: 0, a: 0 });
				else out.push({ t: this.keyFor(t, this.merge(this.infoOf(t).sctx, E)), w: 1, a: this.infoOf(t).anc });
			} else if (GRADIENTS.has(el.name) && GRADIENTS.has(t.name)) {
				// Likewise a gradient without stops gets the referenced one's.
				out.push(this.refEdge(t, info.hasStops ? 0 : 1));
			} else if (el.name === "textPath") out.push({ t: this.staticKey(t), w: 1, a: 0 });
		}
		for (const d of info.direct) out.push(this.refEdge(d, 1));
		for (const r of info.rules) out.push({ t: r, w: 1, a: 0 });
		if (PAINT_SHAPES.has(el.name)) {
			this.slotEdges(E.s[0], out);
			this.slotEdges(E.s[1], out);
		}
		if (MARKER_SHAPES.has(el.name)) {
			this.slotEdges(E.s[2], out);
			this.slotEdges(E.s[3], out);
		}
		return out;
	}

	private ruleEdgesOf(n: RuleNode): Edge[] {
		const out: Edge[] = [];
		for (const { t, w } of n.targets) out.push(this.refEdge(t, w));
		for (const s of n.subs) out.push({ t: s, w: 1, a: 0 });
		return out;
	}

	private overflow(found?: number): never {
		const at = found !== undefined ? ` (found at least ${formatInt(found)})` : "";
		throw new SanitizeError(
			`SVG expands to more than ${formatInt(this.cap)} elements through <use> and references${at}. Simplify it or remove the repeated <use>.`,
		);
	}

	private tooManyBytes(found: number): never {
		throw new SanitizeError(
			`SVG expands to more than ${formatMB(MAX_EXPANDED_BYTES)} of markup through <use> and references (found at least ${formatMB(found)}). Simplify it or remove the repeated <use>.`,
		);
	}

	private tooDeep(): never {
		throw new SanitizeError(`SVG nests elements more than ${MAX_EXPANDED_DEPTH} deep through <use> and references. Flatten it or remove the chained <use>.`);
	}

	/** The element closing the loop, and the referenced element it loops through (a rule's target when the loop runs through a rule). */
	private cycle(stack: Frame[], repeated: ExpansionNode): never {
		let i = stack.length - 1;
		while (i > 0 && stack[i].node.rule) i--;
		const from = (stack[i].node as Key).el;
		let through: OEl | undefined;
		if (repeated.rule) {
			for (let k = stack.findIndex((s) => s.node === repeated) + 1; k < stack.length && !through; k++) {
				const n = stack[k].node;
				if (!n.rule) through = n.el;
			}
		} else through = repeated.el;
		throw new SanitizeError(`<${from.name}> references itself (directly or through ${quoteId(through ? getAttr(through, "id") : undefined)}).`);
	}

	private enter(stack: Frame[], node: ExpansionNode, level: number): void {
		const lvl = level + (node.rule ? 0 : 1);
		if (lvl > MAX_EXPANDED_DEPTH) this.tooDeep();
		if (++this.work > this.workLimit) this.overflow();
		node.visiting = true;
		// Frames are reused: one per element entered would be pure garbage-collector churn.
		const f = this.framePool.pop();
		const acc = node.rule ? 0 : 1;
		const info = node.rule ? null : this.infoOf(node.el);
		const bytes = info ? info.bytes : 0;
		const inh = info ? info.inh : 0;
		if (f) {
			f.node = node;
			f.edges = null;
			f.i = 0;
			f.acc = acc;
			f.bytes = bytes;
			f.inh = inh;
			f.depth = 0;
			f.level = lvl;
			f.pending = null;
			stack.push(f);
		} else stack.push({ node, edges: null, i: 0, acc, bytes, inh, depth: 0, level: lvl, pending: null });
	}

	/** Markup of a frame so far: its own and its children's, and its inheritable markup once per element below. */
	private frameBytes(f: Frame): number {
		return f.acc > 1 ? f.bytes + f.inh * (f.acc - 1) : f.bytes;
	}

	private add(f: Frame, e: Edge, r: Rec): void {
		if (r.depth > f.depth) f.depth = r.depth;
		if (e.w === 0) return;
		f.acc += e.w * r.cost;
		f.bytes += e.w * (r.bytes + e.a * r.cost);
		if (f.acc > this.cap) this.overflow(f.acc);
		const bytes = this.frameBytes(f);
		if (bytes > MAX_EXPANDED_BYTES) this.tooManyBytes(bytes);
	}

	/** Expand one node: iterative, memoized, stops as soon as a cap is passed. */
	private run(start: ExpansionNode): Rec {
		if (start.rec) return start.rec;
		const stack: Frame[] = [];
		this.enter(stack, start, 0);
		let result: Rec | null = null;
		while (stack.length > 0) {
			const f = stack[stack.length - 1];
			if (f.edges === null) f.edges = f.node.rule ? this.ruleEdgesOf(f.node) : this.edgesOf(f.node);
			if (f.i < f.edges.length) {
				const e = f.edges[f.i++];
				if (++this.work > this.workLimit) this.overflow();
				if (e.t.rec) {
					this.add(f, e, e.t.rec);
					continue;
				}
				if (e.t.visiting) this.cycle(stack, e.t);
				f.pending = e;
				this.enter(stack, e.t, f.level);
				continue;
			}
			stack.pop();
			f.node.visiting = false;
			const bytes = this.frameBytes(f);
			if (bytes > MAX_EXPANDED_BYTES) this.tooManyBytes(bytes);
			const rec: Rec = { cost: f.acc, bytes, depth: f.depth + (f.node.rule ? 0 : 1) };
			if (rec.depth > MAX_EXPANDED_DEPTH) this.tooDeep();
			f.node.rec = rec;
			f.edges = null;
			f.pending = null;
			this.framePool.push(f);
			const parent = stack[stack.length - 1];
			if (parent) {
				this.add(parent, parent.pending as Edge, rec);
				parent.pending = null;
			} else result = rec;
		}
		return result as Rec;
	}

	/** Elements Figma creates for the drawn tree with every reference expanded. */
	expandRoot(root: OEl): number {
		return this.run(this.staticKey(root)).cost;
	}

	/**
	 * Figma's parser still reads definitions nobody draws: walk each once, where
	 * it is defined, so their loops and bombs are caught too, and hold their
	 * total to the same caps as the drawn tree (separately, so a definition
	 * that is also drawn isn't refused for being counted twice). Each
	 * non-rendered element (defs, symbol, pattern, marker, clipPath, mask,
	 * gradient, filter) is one definition; its cost leaves out the
	 * non-rendered elements inside it, which are definitions of their own, so
	 * nothing is summed twice.
	 */
	checkUndrawn(): void {
		let cost = 0;
		let bytes = 0;
		for (const el of this.order) {
			const rec = this.run(this.staticKey(el));
			if (!NON_RENDERED.has(el.name)) continue;
			cost += rec.cost;
			bytes += rec.bytes + this.infoOf(el).anc * rec.cost;
			if (cost > this.cap) this.overflow(cost);
			if (bytes > MAX_EXPANDED_BYTES) this.tooManyBytes(bytes);
		}
	}
}

// ===========================================================================
// Serializer
// ===========================================================================

/**
 * Characters XML 1.0 can't carry (control characters, lone surrogates,
 * U+FFFE/FFFF). Removed from the input before anything else reads it, so
 * every check sees exactly the text the serializer writes (stripping them
 * afterwards re-formed url(, javascript: and ids the checks had passed).
 */
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const HAS_INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapeAttr(v: string): string {
	return /[&<>"]/.test(v) ? v.replace(/[&<>"]/g, (c) => ESCAPES[c]) : v;
}
function escapeText(v: string): string {
	return /[&<>]/.test(v) ? v.replace(/[&<>]/g, (c) => ESCAPES[c]) : v;
}

/** UTF-8 length of `v` once escaped (attribute values also escape '"'). */
function escapedLength(v: string, attr: boolean): number {
	let n = utf8Length(v);
	for (let i = 0; i < v.length; i++) {
		const c = v.charCodeAt(i);
		if (c === 38) n += 4;
		else if (c === 60 || c === 62) n += 3;
		else if (c === 34 && attr) n += 5;
	}
	return n;
}

/** Exact UTF-8 size of serialize(root), computed without building it (re-escaping can grow a value ~6\u00d7). */
function serializedLength(root: OEl): number {
	let n = 0;
	walkElements(root, (el) => {
		n += 1 + el.name.length;
		for (const [k, v] of el.attrs) n += 4 + k.length + escapedLength(v, true);
		if (el.children.length === 0) n += 2;
		else n += 4 + el.name.length;
		for (const c of el.children) if (typeof c === "string") n += escapedLength(c, false);
	});
	return n;
}

function serialize(root: OEl): string {
	const out: string[] = [];
	const stack: Array<OEl | string> = [root];
	while (stack.length > 0) {
		const item = stack.pop() as OEl | string;
		if (typeof item === "string") {
			out.push(item);
			continue;
		}
		const el = item;
		out.push(`<${el.name}`);
		for (const [k, v] of el.attrs) out.push(` ${k}="${escapeAttr(v)}"`);
		if (el.children.length === 0) {
			out.push("/>");
			continue;
		}
		out.push(">");
		stack.push(`</${el.name}>`);
		for (let k = el.children.length - 1; k >= 0; k--) {
			const c = el.children[k];
			stack.push(typeof c === "string" ? escapeText(c) : c);
		}
	}
	return out.join("");
}

// ===========================================================================
// Entry point
// ===========================================================================

function parseViewBox(v: string | undefined): [number, number, number, number] | undefined {
	if (!v) return undefined;
	const m = VIEWBOX.exec(v);
	if (!m) return undefined;
	const box = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
	return box[2] > 0 && box[3] > 0 ? box : undefined;
}

function normalizeRootSize(root: OEl, notes: NoteSet): { width?: number; height?: number; viewBox?: [number, number, number, number] } {
	const viewBox = parseViewBox(getAttr(root, "viewBox"));
	const out: { width?: number; height?: number; viewBox?: [number, number, number, number] } = {};
	if (viewBox) out.viewBox = viewBox;
	const replaced: string[] = [];
	for (const dim of ["width", "height"] as const) {
		const raw = getAttr(root, dim);
		if (raw === undefined) continue;
		const m = PLAIN_LENGTH.exec(raw);
		if (m) {
			const n = Number(m[1]);
			if (n > 0) out[dim] = n;
			continue;
		}
		if (viewBox) {
			const n = dim === "width" ? viewBox[2] : viewBox[3];
			setAttr(root, dim, String(n));
			out[dim] = n;
			const safe = raw.trim();
			replaced.push(SAFE_UNIT_VALUE.test(safe) ? `'${safe}'` : "");
		}
	}
	if (replaced.length > 0 && viewBox) {
		const shown = [...new Set(replaced.filter(Boolean))].join("/");
		notes.add(`width/height ${shown ? `${shown} ` : ""}replaced with the viewBox size (${viewBox[2]}×${viewBox[3]}).`);
	}
	if (!viewBox && out.width === undefined && out.height === undefined) {
		notes.add("No viewBox or size: Figma picks the size. Add a viewBox for predictable results.");
	}
	return out;
}

interface DrawScan {
	drawables: number;
	symbolDrawables: number;
	hasText: boolean;
	hasImages: boolean;
	hasGradients: boolean;
	hasFilters: boolean;
	elements: number;
	info: Set<string>;
}

function scanDrawables(root: OEl): DrawScan {
	const scan: DrawScan = { drawables: 0, symbolDrawables: 0, hasText: false, hasImages: false, hasGradients: false, hasFilters: false, elements: 0, info: new Set() };
	const stack: Array<{ el: OEl; hidden: boolean; inSymbol: boolean }> = [{ el: root, hidden: false, inSymbol: false }];
	while (stack.length > 0) {
		const { el, hidden, inSymbol } = stack.pop() as { el: OEl; hidden: boolean; inSymbol: boolean };
		scan.elements++;
		if (el.name === "text" || el.name === "tspan" || el.name === "textPath") scan.hasText = true;
		if (el.name === "image") scan.hasImages = true;
		if (el.name === "linearGradient" || el.name === "radialGradient") scan.hasGradients = true;
		if (el.name === "filter") scan.hasFilters = true;
		if (INFO_NOTE_ELEMENTS[el.name]) scan.info.add(INFO_NOTE_ELEMENTS[el.name]);
		if (DRAWABLE.has(el.name)) {
			if (!hidden) scan.drawables++;
			else if (inSymbol) scan.symbolDrawables++;
		}
		const childHidden = hidden || NON_RENDERED.has(el.name);
		const childInSymbol = inSymbol || el.name === "symbol";
		for (const c of el.children) if (typeof c !== "string") stack.push({ el: c, hidden: childHidden, inSymbol: childInSymbol });
	}
	return scan;
}

/**
 * Sanitize untrusted SVG markup. Never throws for bad input: problems come
 * back as `{ ok: false, error }` with a message that quotes only element and
 * attribute names and safe ids.
 */
export function sanitizeSvg(input: string, opts: SanitizeOptions = {}): SanitizeResult {
	try {
		return sanitizeOrThrow(input, opts);
	} catch (e) {
		if (e instanceof SanitizeError) return { ok: false, error: e.message };
		// The contract is "never throws for bad input": one bad file must not abort a batch.
		return { ok: false, error: UNREADABLE_MESSAGE };
	}
}

function sanitizeOrThrow(input: string, opts: SanitizeOptions): SanitizeResult {
	const bytesIn = utf8Length(input);
	if (bytesIn > MAX_SVG_BYTES) {
		throw new SanitizeError(`SVG is ${formatMB(bytesIn)}; the limit is ${formatMB(MAX_SVG_BYTES)}. Simplify it (e.g. with SVGO) or split it.`);
	}
	let src = input;
	if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
	if (src.indexOf("\u0000") >= 0) throw new SanitizeError("SVG contains NUL bytes; it isn't a text SVG file.");
	// Before anything reads it: see INVALID_XML. Character references can't bring them back (decode rejects them).
	const stripped = HAS_INVALID_XML.test(src);
	if (stripped) src = src.replace(INVALID_XML, "");

	const tokenizer = new Tokenizer(src);
	if (stripped) tokenizer.notes.add("Characters XML doesn't allow (control characters, U+FFFE, lone surrogates) were removed.");
	const rootX = tokenizer.parse();
	const st: State = {
		removedElements: new Map(),
		removedAttributes: 0,
		externalRefs: 0,
		dataUriBytes: 0,
		styleBytes: 0,
		notes: tokenizer.notes,
		taintedFilters: new Set(),
	};
	const root = sanitizeTree(rootX, st);
	dedupeIds(root, st);
	removeTaintedFilters(root, st);

	const size = normalizeRootSize(root, st.notes);
	const draw = scanDrawables(root);
	if (draw.drawables === 0) {
		throw new SanitizeError(
			draw.symbolDrawables > 0
				? "This SVG only defines <symbol>s (a sprite sheet) and draws nothing. Split it into one SVG per symbol."
				: "This SVG has nothing to draw after removing unsupported content.",
		);
	}

	// currentColor first: every later pass, the expansion counter above all, must see exactly the
	// markup that is serialized (rewriting <style> after counting turned a selector into an #id).
	const scan = scanColors(root);
	const rootColor = ownColor(root) ?? undefined;
	const rootColorRgb = rootColor ? parseColor(rootColor) : null;
	let sentinel: string | null = null;
	if (opts.currentColorSentinel !== false && scan.usesCurrentColor) {
		const used = new Set(scan.colors);
		if (rootColorRgb) used.add(toHex6(rootColorRgb));
		sentinel = pickSentinel(used);
		if (sentinel) applyCurrentColor(root, sentinel);
		else {
			// No marker color left (a crafted palette): fall back to a literal color.
			applyCurrentColor(root, rootColor ?? "#000000");
			st.notes.add("Couldn't pick a marker color for currentColor; used the single-color rule instead.");
		}
	}

	// <style> rules are part of the count: each element carries the references of the rules that can match it.
	const counter = new ExpansionCounter(root);
	const expanded = counter.expandRoot(root);
	// Definitions nobody draws still reach Figma's parser: their loops and bombs, and their total.
	counter.checkUndrawn();

	if (draw.hasText) st.notes.add("Contains text: Figma makes text layers and replaces fonts that aren't installed. Convert text to paths for exact results.");
	if (draw.hasFilters) st.notes.add("Filters import only partly (Figma maps drop shadows and blurs).");
	for (const n of draw.info) st.notes.add(n);

	// Canonical namespace declarations on the root.
	root.attrs = root.attrs.filter(([k]) => k !== "xmlns" && k !== "xmlns:xlink");
	let usesXlink = false;
	walkElements(root, (el) => {
		if (getAttr(el, "xlink:href") !== undefined) usesXlink = true;
	});
	root.attrs.unshift(["xmlns", SVG_NS]);
	if (usesXlink) root.attrs.splice(1, 0, ["xmlns:xlink", XLINK_NS]);

	// Re-escaping (" → &quot;, > → &gt;) can make the output longer than the input; the per-SVG cap
	// bounds what reaches createNodeFromSvg, so it applies to the output too. Measured before
	// building it, so an over-cap result never allocates the (up to ~6×) escaped strings.
	const bytesOut = serializedLength(root);
	if (bytesOut > MAX_SVG_BYTES) {
		throw new SanitizeError(`After sanitizing, the SVG is ${formatMB(bytesOut)}; the limit is ${formatMB(MAX_SVG_BYTES)}. Simplify it (e.g. with SVGO) or split it.`);
	}
	const markup = serialize(root);
	const meta: SvgMeta = {
		bytesIn,
		bytesOut,
		...(size.width !== undefined ? { width: size.width } : {}),
		...(size.height !== undefined ? { height: size.height } : {}),
		...(size.viewBox ? { viewBox: size.viewBox } : {}),
		...(st.title ? { title: st.title } : {}),
		...(rootColor ? { rootColor } : {}),
		usesCurrentColor: scan.usesCurrentColor,
		hasText: draw.hasText,
		hasImages: draw.hasImages,
		hasGradients: draw.hasGradients,
		hasFilters: draw.hasFilters,
		elementCount: draw.elements,
		expandedCount: expanded,
		colors: scan.ordered.slice(0, 64).map((h) => `#${h}`),
	};
	return {
		ok: true,
		markup,
		meta,
		sentinel,
		notes: st.notes.list(),
		removed: { elements: removedRecord(st.removedElements), attributes: st.removedAttributes, externalRefs: st.externalRefs },
	};
}
