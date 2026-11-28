/**
 * Names, variant patterns, grouping and directory paging for
 * figma_import_svg (spec §2.6.2, §2.6.3). Pure; no Node or Figma APIs.
 *
 * Ordering never depends on ICU or the platform (no localeCompare), so a
 * folder pages identically on every machine and in Workers.
 */

import { MAX_NAME_LENGTH, MAX_PATTERN_SUBJECT, MAX_VARIANTS_PER_SET } from "./limits.js";

// ---- Basic helpers -------------------------------------------------------

/** Trimmed, control characters removed, at most 200 characters. */
export function cleanName(s: string): string {
	return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, MAX_NAME_LENGTH).trim();
}

const DIGIT_RUN = /\d+|\D+/g;

/**
 * Natural order: digit runs compare numerically (by length after stripping
 * leading zeros, then by code units), other runs by UTF-16 code units; a full
 * code-unit comparison breaks ties. icon2 < icon10.
 */
export function naturalCompare(a: string, b: string): number {
	const ra = a.match(DIGIT_RUN) ?? [];
	const rb = b.match(DIGIT_RUN) ?? [];
	const n = Math.min(ra.length, rb.length);
	for (let i = 0; i < n; i++) {
		const x = ra[i];
		const y = rb[i];
		const dx = x.charCodeAt(0) >= 48 && x.charCodeAt(0) <= 57;
		const dy = y.charCodeAt(0) >= 48 && y.charCodeAt(0) <= 57;
		if (dx && dy) {
			const sx = x.replace(/^0+/, "");
			const sy = y.replace(/^0+/, "");
			if (sx.length !== sy.length) return sx.length - sy.length;
			if (sx !== sy) return sx < sy ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	if (ra.length !== rb.length) return ra.length - rb.length;
	return a === b ? 0 : a < b ? -1 : 1;
}

/** cyrb53: fast, sync, good spread; not a security boundary (detects "same artwork as last import"). */
export function contentHash(str: string, seed = 0): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export interface ArtHashOptions {
	box: { w?: number; h?: number } | null;
	square: boolean;
	scaleStrokes: boolean;
	flatten: boolean;
	asComponent: boolean;
	color: { apply: string; targets: string[] } | null;
}

/**
 * Hash of what the import would draw. The color TARGET (which variable or
 * value) isn't in it: the plugin compares that as a resolved colorRef, so two
 * spellings of the same variable count as unchanged.
 */
export function artHashFor(markup: string, o: ArtHashOptions): string {
	return contentHash(
		`${markup}\u0000${JSON.stringify({ box: o.box, square: o.square, scaleStrokes: o.scaleStrokes, flatten: o.flatten, asComponent: o.asComponent, color: o.color ? { apply: o.color.apply, targets: o.color.targets } : null })}`,
	);
}

/** 12 hex characters from the platform CSPRNG (Node 20+ and Workers expose Web Crypto). */
export function newRunId(): string {
	const bytes = new Uint8Array(6);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Variant patterns ----------------------------------------------------

type Token = { kind: "lit"; text: string } | { kind: "name" } | { kind: "axis"; name: string; values?: string[] };

export interface VariantAxisSpec {
	name: string;
	values: string[];
}

export interface PatternMatch {
	name: string;
	props: Record<string, string>;
}

export interface CompiledPattern {
	/** Axis names in pattern order. */
	axes: string[];
	/** Allowed values per axis (when given), in display order. */
	axisValues: Record<string, string[]>;
	match(subject: string): PatternMatch | null;
}

const AXIS_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,49}$/;

/**
 * Compile `{name}-{Size}`-style patterns. Matching is a memoized search over
 * (token, position) rather than a RegExp: adjacent lazy/greedy groups make a
 * backtracking regex polynomial with a high degree on long names.
 */
export function compileVariantPattern(
	pattern: string,
	axes?: VariantAxisSpec[],
): { ok: true; pattern: CompiledPattern } | { ok: false; error: string } {
	const tokens: Token[] = [];
	let lit = "";
	let names = 0;
	const axisNames: string[] = [];
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c !== "{") {
			lit += c;
			continue;
		}
		const close = pattern.indexOf("}", i + 1);
		if (close < 0) return { ok: false, error: "Unclosed '{' in variants.pattern." };
		const inner = pattern.slice(i + 1, close);
		if (lit) {
			tokens.push({ kind: "lit", text: lit });
			lit = "";
		}
		if (inner === "name") {
			names++;
			tokens.push({ kind: "name" });
		} else if (AXIS_NAME.test(inner)) {
			if (axisNames.includes(inner)) return { ok: false, error: `variants.pattern uses {${inner}} twice.` };
			axisNames.push(inner);
			tokens.push({ kind: "axis", name: inner });
		} else {
			return {
				ok: false,
				error: "variants.pattern has a token that isn't {name} or an {Axis} (letters, digits, spaces, '_' or '-', starting with a letter).",
			};
		}
		i = close;
	}
	if (lit) tokens.push({ kind: "lit", text: lit });
	if (names !== 1) return { ok: false, error: "variants.pattern needs {name} exactly once." };
	if (axisNames.length === 0) return { ok: false, error: "variants.pattern needs at least one {Axis}, e.g. '{name}-{Size}'." };
	const axisValues: Record<string, string[]> = {};
	for (const a of axes ?? []) {
		if (!axisNames.includes(a.name)) return { ok: false, error: `axes lists "${a.name}", which isn't in variants.pattern.` };
		axisValues[a.name] = a.values.slice();
	}
	for (const t of tokens) {
		if (t.kind === "axis" && axisValues[t.name]) {
			// Longest first, like an alternation of escaped values.
			t.values = [...new Set(axisValues[t.name])].sort((x, y) => y.length - x.length);
		}
	}

	const match = (subject: string): PatternMatch | null => {
		if (subject.length > MAX_PATTERN_SUBJECT) return null;
		const n = subject.length;
		const failed = new Set<number>();
		const caps: Array<[number, number]> = new Array(tokens.length);
		const rec = (ti: number, pos: number): boolean => {
			if (ti === tokens.length) return pos === n;
			const key = ti * (n + 1) + pos;
			if (failed.has(key)) return false;
			const tok = tokens[ti];
			if (tok.kind === "lit") {
				if (subject.startsWith(tok.text, pos) && rec(ti + 1, pos + tok.text.length)) return true;
			} else if (tok.kind === "name") {
				// Greedy: the longest name that still lets the rest match.
				for (let end = n; end > pos; end--) {
					caps[ti] = [pos, end];
					if (rec(ti + 1, end)) return true;
				}
			} else if (tok.values) {
				for (const v of tok.values) {
					if (!subject.startsWith(v, pos)) continue;
					caps[ti] = [pos, pos + v.length];
					if (rec(ti + 1, pos + v.length)) return true;
				}
			} else {
				// Lazy, never across '/'.
				for (let end = pos + 1; end <= n && subject.charCodeAt(end - 1) !== 47; end++) {
					caps[ti] = [pos, end];
					if (rec(ti + 1, end)) return true;
				}
			}
			failed.add(key);
			return false;
		};
		if (!rec(0, 0)) return null;
		let name = "";
		const props: Record<string, string> = {};
		tokens.forEach((t, i) => {
			if (t.kind === "name") name = subject.slice(caps[i][0], caps[i][1]);
			else if (t.kind === "axis") props[t.name] = subject.slice(caps[i][0], caps[i][1]);
		});
		return { name, props };
	};

	return { ok: true, pattern: { axes: axisNames, axisValues, match } };
}

/** "Size=24, Style=outline" in pattern order. */
export function formatVariantName(axes: string[], props: Record<string, string>): string {
	return axes.map((a) => `${a}=${props[a]}`).join(", ");
}

/** Parse "Size=24, Style=outline" (null when it isn't a variant name). */
export function parseVariantName(name: string): Record<string, string> | null {
	const out: Record<string, string> = {};
	const parts = name.split(",");
	for (const p of parts) {
		const eq = p.indexOf("=");
		if (eq <= 0) return null;
		const k = p.slice(0, eq).trim();
		const v = p.slice(eq + 1).trim();
		if (!k || !v) return null;
		out[k] = v;
	}
	return Object.keys(out).length ? out : null;
}

/** Sort key of a variant: index of each value in axes[].values (unknown values last). */
function axisOrderKey(pattern: CompiledPattern, props: Record<string, string>): number[] {
	return pattern.axes.map((a) => {
		const vals = pattern.axisValues[a];
		if (!vals) return 0;
		const i = vals.indexOf(props[a]);
		return i < 0 ? vals.length : i;
	});
}

function compareKeys(a: number[], b: number[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}

const hasAxisValues = (p: CompiledPattern) => Object.keys(p.axisValues).length > 0;

// ---- Naming and grouping -------------------------------------------------

export interface NameInput {
	key: string;
	/** "svgs[3]", the path as given, or the directory-relative path. */
	source: string;
	kind: "inline" | "path" | "dir";
	itemName?: string;
	/** Basename without .svg (files). */
	fileBase?: string;
	/** Directory items: relative path with '/' and without .svg. */
	relNoExt?: string;
	/** Sanitized <title> (inline only uses it). */
	title?: string;
}

export interface NamingOptions {
	/** Top-level `name` (applies only when exactly one input is given). */
	topName?: string;
	namePrefix: string;
	pattern?: CompiledPattern;
	/** Components are being made: same-name items in one batch are an error. */
	components: boolean;
}

export interface NamedItem {
	key: string;
	source: string;
	/** Layer/component name (variants: "Axis=value, …"). */
	name: string;
	set?: { name: string; props: Record<string, string> };
}

export type NamedGroup = { kind: "single"; key: string } | { kind: "set"; name: string; axes: string[]; keys: string[] };

export interface NamingResult {
	items: Map<string, NamedItem>;
	failures: Map<string, string>;
	notes: Map<string, string[]>;
	groups: NamedGroup[];
}

/** Base name: item name → top-level name → file basename → <title> (inline) → "SVG". */
export function baseNameOf(input: NameInput, topName?: string): string {
	const pick = [input.itemName, topName, input.kind !== "inline" ? input.fileBase : undefined, input.kind === "inline" ? input.title : undefined];
	for (const p of pick) {
		if (p === undefined) continue;
		const c = cleanName(p);
		if (c) return c;
	}
	return "SVG";
}

function patternSubject(input: NameInput, base: string): string {
	if (input.kind === "dir") return input.relNoExt ?? base;
	if (input.kind === "path") return input.fileBase ?? base;
	return base;
}

export function nameAndGroup(inputs: NameInput[], opts: NamingOptions): NamingResult {
	const items = new Map<string, NamedItem>();
	const failures = new Map<string, string>();
	const notes = new Map<string, string[]>();
	const note = (key: string, text: string) => notes.set(key, [...(notes.get(key) ?? []), text]);
	const topName = inputs.length === 1 ? opts.topName : undefined;

	interface SetDraft {
		name: string;
		members: Array<{ input: NameInput; props: Record<string, string>; order: number }>;
		firstIndex: number;
	}
	const sets = new Map<string, SetDraft>();
	const order: Array<{ kind: "single"; key: string; index: number } | { kind: "set"; name: string; index: number }> = [];
	const standaloneByName = new Map<string, string>();

	inputs.forEach((input, index) => {
		const base = baseNameOf(input, topName);
		if (opts.pattern) {
			const subject = patternSubject(input, base);
			const m = opts.pattern.match(subject);
			if (m) {
				const bad = Object.values(m.props).find((v) => v.includes("=") || v.includes(","));
				if (bad !== undefined) {
					failures.set(input.key, `Variant value "${bad.slice(0, 50)}" can't contain "=" or ",". Figma reads variant names on those characters.`);
					return;
				}
				const setName = cleanName(opts.namePrefix + m.name);
				if (!setName) {
					failures.set(input.key, "The {name} part of this file name is empty, so it can't name a component set.");
					return;
				}
				let draft = sets.get(setName);
				if (!draft) {
					draft = { name: setName, members: [], firstIndex: index };
					sets.set(setName, draft);
					order.push({ kind: "set", name: setName, index });
				}
				draft.members.push({ input, props: m.props, order: index });
				return;
			}
			note(input.key, `"${input.source.slice(0, 200)}" doesn't match variants.pattern, so it became a standalone component.`);
		}
		const name = cleanName(opts.namePrefix + base) || "SVG";
		if (opts.components) {
			const first = standaloneByName.get(name);
			if (first !== undefined) {
				failures.set(
					input.key,
					`Another SVG in this batch is also named "${name}" (${first}). Use variants.pattern (e.g. '{Size}/{name}') or namePrefix.`,
				);
				return;
			}
			standaloneByName.set(name, input.source);
		}
		items.set(input.key, { key: input.key, source: input.source, name });
		order.push({ kind: "single", key: input.key, index });
	});

	const groups: NamedGroup[] = [];
	for (const o of order) {
		if (o.kind === "single") {
			if (!items.has(o.key)) continue;
			const it = items.get(o.key) as NamedItem;
			if (sets.has(it.name)) {
				items.delete(o.key);
				failures.set(o.key, `"${it.name}" is also the name of a variant set in this batch. Rename one of them (namePrefix or variants.pattern).`);
				continue;
			}
			groups.push({ kind: "single", key: o.key });
			continue;
		}
		const draft = sets.get(o.name) as SetDraft;
		const pattern = opts.pattern as CompiledPattern;
		const members = draft.members.slice().sort((a, b) =>
			hasAxisValues(pattern)
				? compareKeys(axisOrderKey(pattern, a.props), axisOrderKey(pattern, b.props)) || naturalCompare(a.input.source, b.input.source)
				: naturalCompare(a.input.source, b.input.source),
		);
		const seen = new Map<string, string>();
		const keys: string[] = [];
		for (const m of members) {
			const vname = formatVariantName(pattern.axes, m.props);
			const first = seen.get(vname);
			if (first !== undefined) {
				failures.set(m.input.key, `Same variant as ${first} (${vname}).`);
				continue;
			}
			if (keys.length >= MAX_VARIANTS_PER_SET) {
				failures.set(m.input.key, `The set "${draft.name}" has more than ${MAX_VARIANTS_PER_SET} variants; at most ${MAX_VARIANTS_PER_SET} go in one set.`);
				continue;
			}
			seen.set(vname, m.input.source);
			items.set(m.input.key, { key: m.input.key, source: m.input.source, name: vname, set: { name: draft.name, props: m.props } });
			keys.push(m.input.key);
		}
		if (keys.length) groups.push({ kind: "set", name: draft.name, axes: pattern.axes.slice(), keys });
	}
	return { items, failures, notes, groups };
}

// ---- Directory paging ----------------------------------------------------

export interface DirFile {
	path: string;
	relPath: string;
	size: number;
}

export interface DirPage {
	files: DirFile[];
	/** Page index of the first file (after snapping to a group start). */
	offset: number;
	total: number;
	nextOffset?: number;
	remainingCount: number;
	/** Indices into `files` where a group (a set, or a single file) starts. */
	groupStarts: number[];
	notes: string[];
	/**
	 * Files of a set with more than MAX_VARIANTS_PER_SET files beyond the first
	 * hundred: consumed by this page (nextOffset is past them) but not on it,
	 * so they fail without being read.
	 */
	overflow: Array<{ file: DirFile; setName: string }>;
	/**
	 * Standalone files on this page (page-relative index) whose component name a
	 * file on an EARLIER page already takes. Within one page nameAndGroup
	 * keeps the first; across pages this does, so paging never decides
	 * whether a duplicate fails or overwrites the first one's component.
	 */
	collisions: Array<{ index: number; name: string; first: string }>;
	/** Set when offset is past the end. */
	error?: string;
}

/** The standalone component name nameAndGroup gives a directory file (no pattern match, no title). */
export function standaloneDirName(relPath: string, namePrefix: string): string {
	const base = cleanName((relPath.split(/[\\/]/).pop() ?? relPath).replace(/\.svg$/i, "")) || "SVG";
	return cleanName(namePrefix + base) || "SVG";
}

const stripSvg = (rel: string) => rel.replace(/\.svg$/i, "");

/**
 * Order every listed file into whole groups (sets never split), then take
 * the page at `offset`. Indices are stable while the folder and arguments
 * don't change; a mid-group offset snaps back to the group start.
 */
export function pageDirectory(
	files: DirFile[],
	o: {
		pattern?: CompiledPattern;
		namePrefix: string;
		offset: number;
		limit: number;
		/** Components are wanted: standalone name collisions across pages fail (see DirPage.collisions). */
		components?: boolean;
		/** Hard cap on files this page may hold (room left in the call); a set that can't fit isn't split. */
		maxFiles?: number;
	},
): DirPage {
	interface G {
		key: string;
		files: Array<{ f: DirFile; props?: Record<string, string> }>;
		first: string;
	}
	const groups = new Map<string, G>();
	let singleton = 0;
	for (const f of files) {
		const rel = f.relPath.replace(/\\/g, "/");
		const m = o.pattern ? o.pattern.match(stripSvg(rel)) : null;
		const key = m ? `set:${cleanName(o.namePrefix + m.name)}` : `one:${singleton++}`;
		let g = groups.get(key);
		if (!g) {
			g = { key, files: [], first: rel };
			groups.set(key, g);
		}
		g.files.push({ f, props: m?.props });
		if (naturalCompare(rel, g.first) < 0) g.first = rel;
	}
	const ordered = [...groups.values()].sort((a, b) => naturalCompare(a.first, b.first));
	const flat: Array<{ f: DirFile; group: number; groupName: string }> = [];
	const groupStart: number[] = [];
	ordered.forEach((g, gi) => {
		const p = o.pattern;
		const sorted = g.files.slice().sort((a, b) =>
			p && hasAxisValues(p) && a.props && b.props
				? compareKeys(axisOrderKey(p, a.props), axisOrderKey(p, b.props)) || naturalCompare(a.f.relPath, b.f.relPath)
				: naturalCompare(a.f.relPath, b.f.relPath),
		);
		groupStart.push(flat.length);
		for (const x of sorted) flat.push({ f: x.f, group: gi, groupName: g.key.startsWith("set:") ? g.key.slice(4) : "" });
	});
	const total = flat.length;
	const notes: string[] = [];
	const none = { overflow: [], collisions: [] };
	if (total === 0) return { files: [], offset: 0, total, remainingCount: 0, groupStarts: [], notes, ...none };
	if (o.offset >= total) {
		return { files: [], offset: o.offset, total, remainingCount: 0, groupStarts: [], notes, ...none, error: `offset ${o.offset} is past the end of the folder (${total} .svg files).` };
	}
	let start = o.offset;
	const gi = flat[start].group;
	if (groupStart[gi] !== start) {
		start = groupStart[gi];
		notes.push(`offset ${o.offset} is inside the set "${flat[o.offset].groupName}"; started at ${start} so the set isn't split.`);
	}
	// end: files on the page; consumed: where the next page starts (past an oversized set's overflow).
	let end = start;
	let consumed = start;
	let g = gi;
	const overflow: DirPage["overflow"] = [];
	while (g < ordered.length) {
		const gEnd = g + 1 < groupStart.length ? groupStart[g + 1] : total;
		const size = gEnd - groupStart[g];
		if (size > MAX_VARIANTS_PER_SET) {
			// A set over the variant cap starts its own page with its first hundred files (in the order
			// nameAndGroup uses); the rest can never join it, so they are consumed here and fail unread.
			if (end > start) break;
			end = groupStart[g] + MAX_VARIANTS_PER_SET;
			consumed = gEnd;
			for (const x of flat.slice(end, gEnd)) overflow.push({ file: x.f, setName: x.groupName });
			g++;
			break;
		}
		// A group larger than the limit is its own page.
		if (end > start && end - start + size > o.limit) break;
		end = gEnd;
		consumed = gEnd;
		g++;
		if (end - start >= o.limit) break;
	}
	if (o.maxFiles !== undefined && end - start > o.maxFiles) {
		// Only a single set can overshoot the room left by svgs and paths; sets are never split.
		notes.push(`The set "${flat[start].groupName}" (${end - start} files) doesn't fit in this call next to the svgs and paths (room for ${o.maxFiles} more). Import the folder in a call of its own.`);
		return { files: [], offset: start, total, remainingCount: total - start, groupStarts: [], nextOffset: start, notes, ...none };
	}
	const collisions: DirPage["collisions"] = [];
	if (o.components) {
		const firstByName = new Map<string, number>();
		for (let i = 0; i < end; i++) {
			if (flat[i].groupName) continue;
			const name = standaloneDirName(flat[i].f.relPath, o.namePrefix);
			const first = firstByName.get(name);
			if (first === undefined) firstByName.set(name, i);
			else if (i >= start && first < start) collisions.push({ index: i - start, name, first: flat[first].f.relPath });
		}
	}
	return {
		files: flat.slice(start, end).map((x) => x.f),
		offset: start,
		total,
		remainingCount: total - consumed,
		groupStarts: groupStart.filter((i) => i >= start && i < end).map((i) => i - start),
		...(consumed < total ? { nextOffset: consumed } : {}),
		notes,
		overflow,
		collisions,
	};
}
