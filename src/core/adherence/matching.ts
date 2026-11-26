/**
 * Deterministic need → component matching for design-system adherence.
 *
 * Given a plain-language list of the UI a request needs ("primary button",
 * "date picker", "user avatar") and the design system's component catalog,
 * classify each need as:
 *   matched  — a component clearly covers it; build with that component
 *   possible — something might cover it; a PERSON decides (no agent guessing)
 *   gap      — nothing in the system covers it; report it, don't invent it
 *
 * No model judgment is involved: matching is token overlap over component
 * names, descriptions and variant values, with a small UI synonym table. The
 * thresholds are conservative on purpose — a false "gap" costs a question,
 * a false "matched" lets an agent improvise with the wrong component.
 */

export interface CatalogEntry {
	name: string;
	key: string;
	nodeId?: string;
	type: "COMPONENT" | "COMPONENT_SET";
	description?: string;
	/** Variant axes, e.g. [{ name: "Size", values: ["sm","md"] }] */
	variantAxes?: Array<{ name: string; values: string[] }>;
	/** For component sets: the variant to instantiate by default (instantiate variant keys, not set keys). */
	defaultVariant?: { name: string; key: string; nodeId?: string };
	/** "local" (this file) or the library file key it came from */
	source: string;
}

export type NeedStatus = "matched" | "possible" | "gap";

/**
 * The variant a person would reach for first: the one whose values say
 * "Default" most often (State=Default, Shape=Default …); ties keep source order.
 */
export function pickDefaultVariant<T extends { name: string }>(variants: T[]): T | undefined {
	let best: T | undefined;
	let bestScore = -1;
	for (const v of variants) {
		const score = (v.name.match(/=\s*Default\b/gi) ?? []).length;
		if (score > bestScore) {
			best = v;
			bestScore = score;
		}
	}
	return best;
}

export interface Candidate {
	name: string;
	key: string;
	nodeId?: string;
	type: CatalogEntry["type"];
	source: string;
	score: number;
	/** Why it matched: the need words found in the component */
	matchedOn: string[];
	variantAxes?: CatalogEntry["variantAxes"];
	defaultVariant?: CatalogEntry["defaultVariant"];
}

export interface NeedResolution {
	need: string;
	status: NeedStatus;
	component?: Candidate;
	candidates: Candidate[];
}

export const MATCH_THRESHOLD = 0.75;
export const POSSIBLE_THRESHOLD = 0.34;

const STOPWORDS = new Set([
	"a", "an", "the", "and", "or", "of", "for", "with", "to", "in", "on", "at", "by",
	"my", "your", "our", "their", "this", "that", "these", "those", "some", "any",
	"component", "components", "ui", "element", "widget", "item", "default", "new",
	"primary", "secondary", "tertiary", "small", "medium", "large", "sm", "md", "lg", "xl",
	"variant", "style", "type", "state", "basic", "simple", "standard",
]);

/**
 * Words that name the same UI concept. Each group maps to its first entry.
 * Keep groups tight: merging distinct concepts (e.g. select vs. menu) would
 * turn gaps into false matches.
 */
const SYNONYM_GROUPS: string[][] = [
	["button", "btn", "cta"],
	["input", "textfield", "textinput", "field", "textbox"],
	["textarea", "multiline"],
	["select", "dropdown", "combobox", "picker", "listbox"],
	["checkbox", "check"],
	["radio", "radiobutton", "radiogroup"],
	["toggle", "switch"],
	["modal", "dialog", "popup", "lightbox"],
	["drawer", "sheet", "sidesheet", "bottomsheet"],
	["tooltip", "hint"],
	["popover", "flyout"],
	["badge", "tag", "chip", "pill", "label"],
	["avatar", "profilepicture", "userimage", "profilephoto"],
	["card", "tile"],
	["tab", "tabs", "tabbar"],
	["navbar", "navigation", "nav", "topbar", "appbar", "header"],
	["sidebar", "sidenav", "rail"],
	["breadcrumb", "breadcrumbs"],
	["pagination", "pager", "paginator"],
	["toast", "snackbar", "notification"],
	["alert", "banner", "callout", "inlinemessage"],
	["spinner", "loader", "loading"],
	["progress", "progressbar", "meter"],
	["slider", "range"],
	["table", "datatable", "datagrid", "grid"],
	["list", "listitem", "row"],
	["menu", "menuitem", "contextmenu"],
	["accordion", "collapse", "disclosure", "expander"],
	["divider", "separator", "rule"],
	["icon", "glyph", "symbol"],
	["link", "anchor", "hyperlink"],
	["search", "searchbar", "searchfield"],
	["datepicker", "calendar", "date"],
	["stepper", "steps", "wizard"],
	["skeleton", "placeholder", "shimmer"],
	["footer", "bottombar"],
	["image", "img", "picture", "photo", "thumbnail"],
	["heading", "title", "headline"],
	["empty", "emptystate", "zerostate"],
	["upload", "dropzone", "fileupload"],
];

const CANON = new Map<string, string>();
for (const group of SYNONYM_GROUPS) for (const w of group) CANON.set(w, group[0]);

/** Compounds written as two words in needs ("date picker", "text field"). */
const COMPOUNDS: Array<[string, string]> = [
	["date picker", "datepicker"],
	["text field", "textfield"],
	["text input", "textinput"],
	["text area", "textarea"],
	["radio button", "radiobutton"],
	["check box", "checkbox"],
	["nav bar", "navbar"],
	["tab bar", "tabbar"],
	["app bar", "appbar"],
	["top bar", "topbar"],
	["side nav", "sidenav"],
	["search bar", "searchbar"],
	["search field", "searchfield"],
	["progress bar", "progressbar"],
	["data table", "datatable"],
	["data grid", "datagrid"],
	["list item", "listitem"],
	["menu item", "menuitem"],
	["empty state", "emptystate"],
	["zero state", "zerostate"],
	["file upload", "fileupload"],
	["drop zone", "dropzone"],
	["bottom sheet", "bottomsheet"],
	["side sheet", "sidesheet"],
	["profile picture", "profilepicture"],
	["profile photo", "profilephoto"],
	["context menu", "contextmenu"],
	["inline message", "inlinemessage"],
];

function singular(w: string): string {
	if (w.endsWith("s") && CANON.has(w.slice(0, -1))) return w.slice(0, -1);
	if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
	if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
	return w;
}

/** Lowercase, join known compounds, split camelCase / separators, canonicalize. */
export function tokenize(text: string): string[] {
	let t = ` ${text
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")} `;
	for (const [two, one] of COMPOUNDS) t = t.replaceAll(` ${two} `, ` ${one} `);
	const out: string[] = [];
	for (const raw of t.split(" ")) {
		if (!raw || /^\d+$/.test(raw)) continue;
		const w = singular(raw);
		if (STOPWORDS.has(w) || STOPWORDS.has(raw)) continue;
		out.push(CANON.get(w) ?? CANON.get(raw) ?? w);
	}
	return [...new Set(out)];
}

function componentTerms(entry: CatalogEntry) {
	// The last path segment of "Forms/Inputs/Text Field" is the component's
	// real name; earlier segments are folders and count for less.
	const segments = entry.name.split("/").map((s) => s.trim()).filter(Boolean);
	const base = new Set(tokenize(segments[segments.length - 1] ?? entry.name));
	const path = new Set(tokenize(segments.slice(0, -1).join(" ")));
	const desc = new Set(tokenize(entry.description ?? ""));
	const variants = new Set(
		tokenize(
			(entry.variantAxes ?? [])
				.flatMap((a) => [a.name, ...a.values])
				.join(" "),
		),
	);
	return { base, path, desc, variants };
}

/**
 * Score in [0, 1]. Dominated by the need's words appearing in the component's
 * own name; folder path, variant values and description add supporting weight.
 */
export function scoreMatch(needTokens: string[], entry: CatalogEntry): { score: number; matchedOn: string[] } {
	if (needTokens.length === 0) return { score: 0, matchedOn: [] };
	const { base, path, desc, variants } = componentTerms(entry);
	let total = 0;
	const matchedOn: string[] = [];
	for (const t of needTokens) {
		let w = 0;
		if (base.has(t)) w = 1;
		else if (variants.has(t)) w = 0.5;
		else if (path.has(t)) w = 0.45;
		else if (desc.has(t)) w = 0.35;
		if (w > 0) matchedOn.push(t);
		total += w;
	}
	let score = total / needTokens.length;
	// A component whose name has words the need doesn't mention is a weaker fit
	// ("Icon Button" for "button"), but only slightly — variants absorb a lot.
	const extraBase = [...base].filter((t) => !needTokens.includes(t)).length;
	if (base.size > 0 && extraBase > 0) score *= 1 - Math.min(0.25, (extraBase / base.size) * 0.25);
	return { score: Math.round(score * 1000) / 1000, matchedOn };
}

/**
 * Components a team has retired or hidden: an "archive"/"deprecated" folder or
 * name, or Figma's private-component prefixes ("_" / "."). Never offered.
 */
export function isRetired(entry: CatalogEntry): boolean {
	const segments = entry.name.split("/").map((s) => s.trim().toLowerCase());
	if (segments.some((s) => s.startsWith("_") || s.startsWith("."))) return true;
	return segments.some((s) => /\b(archived?|deprecated|legacy|do not use|old)\b/.test(s));
}

export function resolveNeeds(
	needs: string[],
	catalog: CatalogEntry[],
	opts: { maxCandidates?: number } = {},
): NeedResolution[] {
	const maxCandidates = opts.maxCandidates ?? 3;
	return needs.map((need) => {
		const tokens = tokenize(need);
		const scored: Candidate[] = [];
		for (const entry of catalog) {
			if (isRetired(entry)) continue;
			const { score, matchedOn } = scoreMatch(tokens, entry);
			if (score <= 0) continue;
			scored.push({
				name: entry.name,
				key: entry.key,
				nodeId: entry.nodeId,
				type: entry.type,
				source: entry.source,
				score,
				matchedOn,
				variantAxes: entry.variantAxes,
				defaultVariant: entry.defaultVariant,
			});
		}
		scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
		const candidates = scored.slice(0, maxCandidates);
		const best = candidates[0];
		let status: NeedStatus = "gap";
		if (best && best.score >= MATCH_THRESHOLD) {
			// Two different components scoring the same is ambiguity, not a match.
			const tie = candidates[1] && candidates[1].score >= best.score - 0.05 && candidates[1].name !== best.name;
			status = tie ? "possible" : "matched";
		} else if (best && best.score >= POSSIBLE_THRESHOLD) {
			status = "possible";
		}
		return {
			need,
			status,
			...(status === "matched" ? { component: best } : {}),
			candidates: status === "gap" ? candidates.filter((c) => c.score >= POSSIBLE_THRESHOLD / 2) : candidates,
		};
	});
}

export interface LibraryPair {
	figma: { name: string; key: string; nodeId?: string; source: string };
	code: string;
	/** exact = same name; normalized = same words; concept = same UI concept via synonyms */
	matchedBy: "exact" | "normalized" | "concept";
}

/**
 * Pair a Figma library's components with a code library's components by name.
 * Exact name first, then the same words ignoring case/punctuation/path, then
 * the same UI concept (synonym table) — and only when that concept maps to
 * exactly one component on each side, so nothing gets force-paired.
 */
export function pairLibraries(figma: CatalogEntry[], code: string[]) {
	const live = figma.filter((f) => !isRetired(f));
	const base = (n: string) => n.split("/").pop()!.trim();
	const norm = (n: string) => base(n).toLowerCase().replace(/[^a-z0-9]+/g, "");
	const pairs: LibraryPair[] = [];
	const usedF = new Set<CatalogEntry>();
	const usedC = new Set<string>();
	const take = (f: CatalogEntry, c: string, matchedBy: LibraryPair["matchedBy"]) => {
		pairs.push({ figma: { name: f.name, key: f.key, nodeId: f.nodeId, source: f.source }, code: c, matchedBy });
		usedF.add(f);
		usedC.add(c);
	};
	for (const f of live) {
		const c = code.find((x) => !usedC.has(x) && x === base(f.name));
		if (c) take(f, c, "exact");
	}
	for (const f of live) {
		if (usedF.has(f)) continue;
		const c = code.find((x) => !usedC.has(x) && norm(x) === norm(f.name));
		if (c) take(f, c, "normalized");
	}
	const key = (n: string) => tokenize(base(n)).join(" ");
	const byKeyF = new Map<string, CatalogEntry[]>();
	for (const f of live) if (!usedF.has(f)) byKeyF.set(key(f.name), [...(byKeyF.get(key(f.name)) ?? []), f]);
	const byKeyC = new Map<string, string[]>();
	for (const c of code) if (!usedC.has(c)) byKeyC.set(key(c), [...(byKeyC.get(key(c)) ?? []), c]);
	for (const [k, fs] of byKeyF) {
		const cs = byKeyC.get(k);
		if (k && fs.length === 1 && cs?.length === 1) take(fs[0], cs[0], "concept");
	}
	return {
		pairs,
		figmaOnly: live.filter((f) => !usedF.has(f)).map((f) => ({ name: f.name, key: f.key, nodeId: f.nodeId, source: f.source })),
		codeOnly: code.filter((c) => !usedC.has(c)),
		retiredInFigma: figma.filter((f) => isRetired(f)).map((f) => f.name),
	};
}
