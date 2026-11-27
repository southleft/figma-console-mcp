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
	/** Non-variant component properties (BOOLEAN / TEXT / INSTANCE_SWAP / SLOT), when known. */
	properties?: Array<{ name: string; type: string }>;
	/** "local" (this file) or the library file key it came from */
	source: string;
	/** Small, square and vector-only: an icon, wherever it lives in the file. */
	iconLike?: boolean;
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
	// A calendar is usually a separate component (often a part OF a date picker).
	["datepicker", "date"],
	["calendar"],
	["stepper", "steps", "wizard"],
	["skeleton", "placeholder", "shimmer"],
	["footer", "bottombar"],
	["image", "img", "picture", "photo", "thumbnail", "media"],
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
	return tokenizeDetailed(text).map((t) => t.canon);
}

/** Tokens with both their literal (singularised) form and their synonym-group canon. */
export function tokenizeDetailed(text: string): Array<{ raw: string; canon: string }> {
	let t = ` ${text
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")} `;
	for (const [two, one] of COMPOUNDS) t = t.replaceAll(` ${two} `, ` ${one} `);
	const out: Array<{ raw: string; canon: string }> = [];
	const seen = new Set<string>();
	for (const word of t.split(" ")) {
		if (!word || /^\d+$/.test(word)) continue;
		const w = singular(word);
		if (STOPWORDS.has(w) || STOPWORDS.has(word)) continue;
		const canon = CANON.get(w) ?? CANON.get(word) ?? w;
		if (seen.has(canon + "|" + w)) continue;
		seen.add(canon + "|" + w);
		out.push({ raw: w, canon });
	}
	return out;
}

/**
 * Folder words that mark a component as an asset or an example rather than a
 * reusable UI component (common across design systems). A match inside one of
 * these is down-weighted unless the need itself asks for that kind of thing.
 */
const ASSET_FOLDERS = /^(icons?|iconography|glyphs?|illustrations?|logos?|assets?|emojis?|flags?|avatars? images?|images?|graphics?)$/;
const EXAMPLE_FOLDERS = /^(blocks?|examples?|patterns?|templates?|demos?|recipes?|samples?|showcase|playground|docs?|documentation)$/;

function componentTerms(entry: CatalogEntry) {
	// The last path segment of "Forms/Inputs/Text Field" is the component's
	// real name; earlier segments are folders and count for less.
	const segments = entry.name.split("/").map((s) => s.trim()).filter(Boolean);
	const baseDetailed = tokenizeDetailed(segments[segments.length - 1] ?? entry.name);
	const base = new Set(baseDetailed.map((t) => t.canon));
	const baseRaw = new Set(baseDetailed.map((t) => t.raw));
	const pathDetailed = tokenizeDetailed(segments.slice(0, -1).join(" "));
	const path = new Set(pathDetailed.map((t) => t.canon));
	const pathRaw = new Set(pathDetailed.map((t) => t.raw));
	const folderWords = segments.slice(0, -1).flatMap((seg) => seg.toLowerCase().split(/[^a-z]+/).filter(Boolean));
	const desc = new Set(tokenize(entry.description ?? ""));
	const variants = new Set(
		tokenize(
			(entry.variantAxes ?? [])
				.flatMap((a) => [a.name, ...a.values])
				.join(" "),
		),
	);
	return { base, baseRaw, path, pathRaw, desc, variants, depth: segments.length, folderWords };
}

/**
 * Score in [0, 1]. Dominated by the need's words appearing in the component's
 * own name; folder path, variant values and description add supporting weight.
 */
export function scoreMatch(needTokens: string[] | string, entry: CatalogEntry): { score: number; matchedOn: string[]; depth: number } {
	const need = typeof needTokens === "string" ? tokenizeDetailed(needTokens) : needTokens.map((t) => ({ raw: t, canon: t }));
	const { base, baseRaw, path, pathRaw, desc, variants, depth, folderWords } = componentTerms(entry);
	if (need.length === 0) return { score: 0, matchedOn: [], depth };
	let total = 0;
	let nameHits = 0;
	const matchedOn: string[] = [];
	for (const t of need) {
		let w = 0;
		if (baseRaw.has(t.raw)) w = 1; // the component's own word
		else if (base.has(t.canon)) w = 0.8; // a synonym of it
		else if (pathRaw.has(t.raw)) w = 0.8; // the need names the folder ("check icon" → Icons/Check)
		else if (entry.iconLike && /^(icons?|glyphs?|symbols?)$/.test(t.raw)) w = 0.8; // an icon, by its shape
		else if (variants.has(t.canon)) w = 0.5;
		else if (path.has(t.canon)) w = 0.45;
		else if (desc.has(t.canon)) w = 0.35;
		if (w > 0) matchedOn.push(t.raw);
		if (w >= 0.45) nameHits++;
		total += w;
	}
	let score = total / need.length;
	// Prose alone never makes a candidate: descriptions mention many things.
	if (nameHits === 0) score = Math.min(score, 0.3);
	// A component whose name has words the need doesn't mention is a weaker fit
	// ("Icon Button" for "button"), but only slightly — variants absorb a lot.
	const needCanon = new Set(need.map((t) => t.canon));
	const extraBase = [...base].filter((t) => !needCanon.has(t)).length;
	if (base.size > 0 && extraBase > 0) score *= 1 - Math.min(0.25, (extraBase / base.size) * 0.25);
	// Assets and examples aren't the component itself, unless that's what was asked for.
	const needWords = new Set(need.map((t) => t.raw));
	const askedForIcon = [...needWords].some((w) => /^(icons?|glyphs?|symbols?)$/.test(w));
	const inAsset =
		(folderWords.some((w) => ASSET_FOLDERS.test(w)) && !folderWords.some((w) => needWords.has(w.replace(/s$/, "")))) ||
		(entry.iconLike === true && !askedForIcon);
	const inExample = folderWords.some((w) => EXAMPLE_FOLDERS.test(w)) && !folderWords.some((w) => needWords.has(w.replace(/s$/, "")));
	if (inAsset) score *= 0.5;
	else if (inExample) score *= 0.7;
	return { score: Math.round(score * 1000) / 1000, matchedOn, depth };
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
		const tokens = tokenizeDetailed(need);
		// A component named exactly what was asked for is the answer: "tabs" is
		// Tabs, not Tab; "breadcrumbs" is not "Breadcrumbs Item".
		const literal = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
		const needLiteral = literal(need);
		const scored: Array<Candidate & { depth: number; exact: boolean }> = [];
		for (const entry of catalog) {
			if (isRetired(entry)) continue;
			const { score, matchedOn, depth } = scoreMatch(tokens.map((t) => t.raw).join(" "), entry);
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
				depth,
				exact: literal(entry.name.split("/").pop() ?? entry.name) === needLiteral,
			});
		}
		// Higher score first; among near-equals, the less nested component (a
		// top-level "Tooltip" over "Charts / Tooltip") — a sub-part or a usage
		// example lives deeper than the component itself.
		scored.sort((a, b) => b.score - a.score || Number(b.exact) - Number(a.exact) || a.depth - b.depth || a.name.localeCompare(b.name));
		const best = scored[0];
		const rivals = best ? scored.filter((c) => c !== best && c.name !== best.name && c.score >= best.score - 0.05) : [];
		// Not a tie when the best is the only exact name among its rivals, or it's
		// strictly less nested than all of them.
		const tie = best?.exact ? rivals.some((c) => c.exact && c.depth <= best.depth) : rivals.some((c) => c.depth <= best.depth);
		const candidates = scored.slice(0, maxCandidates).map(({ depth, exact, ...c }) => c);
		let status: NeedStatus = "gap";
		if (best && best.score >= MATCH_THRESHOLD) status = tie ? "possible" : "matched";
		else if (best && best.score >= POSSIBLE_THRESHOLD) status = "possible";
		return {
			need,
			status,
			...(status === "matched" ? { component: candidates[0] } : {}),
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
	// When several Figma components share a name (the component itself, an icon
	// of it, a sub-part, a usage example), pair the code component with the one
	// that IS the component: not an asset or example, then the least nested.
	const rank = (f: CatalogEntry) => {
		const segs = f.name.split("/").map((x) => x.trim()).filter(Boolean);
		const folders = segs.slice(0, -1).flatMap((x) => x.toLowerCase().split(/[^a-z]+/).filter(Boolean));
		const asset = f.iconLike || folders.some((w) => ASSET_FOLDERS.test(w)) ? 2 : folders.some((w) => EXAMPLE_FOLDERS.test(w)) ? 1 : 0;
		return asset * 100 + segs.length;
	};
	// An icon or illustration of a thing is never the counterpart of a UI component.
	const ordered = [...live].filter((f) => rank(f) < 200).sort((a, b) => rank(a) - rank(b));
	for (const f of ordered) {
		const c = code.find((x) => !usedC.has(x) && x === base(f.name));
		if (c) take(f, c, "exact");
	}
	for (const f of ordered) {
		if (usedF.has(f)) continue;
		const c = code.find((x) => !usedC.has(x) && norm(x) === norm(f.name));
		if (c) take(f, c, "normalized");
	}
	const key = (n: string) => tokenize(base(n)).join(" ");
	const byKeyF = new Map<string, CatalogEntry[]>();
	for (const f of ordered) if (!usedF.has(f)) byKeyF.set(key(f.name), [...(byKeyF.get(key(f.name)) ?? []), f]);
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
