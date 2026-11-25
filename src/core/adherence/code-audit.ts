/**
 * Static design-system adherence check for generated CODE (React/Vue/Svelte/
 * HTML/CSS). The code-side twin of figma_audit_adherence: did the generator
 * use the system's components and tokens, or hardcode and re-implement?
 *
 * Deliberately line-based and conservative (no type-checker, no bundler):
 * every finding has a file:line a person can verify, and anything ambiguous
 * is a warning, not an error. Errors are reserved for clear inventions:
 *   - re-implementing a component the design system already has
 *   - referencing a token that doesn't exist (when the token set is known)
 */
import { tokenize } from "./matching.js";

export interface CodeSource {
	path: string;
	content: string;
}

export interface CodeDesignSystem {
	/** Import sources that ARE the design system, e.g. "@acme/ui", "@/components/ui". */
	packages?: string[];
	/** Component names the system provides (if packages can't be inspected). */
	components?: string[];
	/** Token names the system defines (CSS custom properties without "--", or dotted/dashed paths). */
	tokens?: string[];
}

export interface CodeFinding {
	file: string;
	line: number;
	rule: string;
	severity: "error" | "warning" | "info";
	message: string;
	snippet: string;
}

export interface CodeAuditResult {
	files: number;
	stats: {
		dsComponentUses: number;
		rawElements: number;
		reimplementations: number;
		tokenRefs: number;
		literals: number;
		unknownTokens: number;
		inlineStyles: number;
	};
	componentsUsed: Record<string, number>;
	findings: CodeFinding[];
}

/** HTML element → the UI concept a design system usually covers. */
const RAW_ELEMENT_CONCEPT: Record<string, string> = {
	button: "button",
	input: "input",
	select: "select",
	textarea: "textarea",
	dialog: "modal",
	table: "table",
};

const COLOR_RE = /(#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(\s*[\d.]+)/g;
const LENGTH_PROPS =
	"padding|margin|gap|row-gap|column-gap|rowGap|columnGap|border-radius|borderRadius|font-size|fontSize|line-height|lineHeight|letter-spacing|letterSpacing";
const LENGTH_RE = new RegExp(
	`\\b(?:${LENGTH_PROPS})(?:Top|Right|Bottom|Left|Inline|Block|X|Y|-top|-right|-bottom|-left|-inline|-block)?\\s*[:=]\\s*\\{?\\s*['"\`]?(-?\\d*\\.?\\d+)(px|rem|em)?\\b`,
	"g",
);
const TW_ARBITRARY_RE = /(?:^|[\s"'`])(?:[a-z]+:)*-?[a-z][a-z0-9-]*-\[(?:#|\d|rgb|hsl|oklch|calc\(\d)[^\]\s]*\]/g;
const VAR_RE = /var\(\s*--([A-Za-z0-9_-]+)/g;
/** Tailwind color utilities: bg-card, text-muted-foreground, border-border/50 … */
const TW_COLOR_CLASS_RE = /(?:^|[\s"'`:])(?:bg|text|border|ring|fill|stroke|from|via|to|outline|divide|accent|caret|decoration|placeholder|shadow)-([a-z][a-z0-9-]*?)(?:\/\d+)?(?=[\s"'`]|$)/g;
const TOKEN_DEF_RE = /^\s*--[A-Za-z0-9_-]+\s*:/;
const IMPORT_RE = /^\s*import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/;

function stripComment(line: string): string {
	const i = line.indexOf("//");
	if (i >= 0 && !/https?:$/.test(line.slice(0, i))) return line.slice(0, i);
	return line;
}

function importedNames(spec: string): string[] {
	const names: string[] = [];
	const def = spec.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
	if (def) names.push(def[1]);
	const braces = spec.match(/\{([\s\S]*)\}/);
	if (braces) {
		for (const part of braces[1].split(",")) {
			const m = part.trim().match(/^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
			if (m) names.push(m[2] ?? m[1]);
		}
	}
	return names;
}

function isDsSource(from: string, packages: string[]): boolean {
	return packages.some((p) => from === p || from.startsWith(`${p}/`));
}

/** The concept a component name stands for, using the shared UI synonym table. */
function concept(name: string): string | undefined {
	const t = tokenize(name);
	return t.length ? t[t.length - 1] : undefined;
}

export function auditCode(sources: CodeSource[], ds: CodeDesignSystem): CodeAuditResult {
	const packages = ds.packages ?? [];
	const knownTokens = ds.tokens && ds.tokens.length ? new Set(ds.tokens.map((t) => t.replace(/^--/, ""))) : null;
	const findings: CodeFinding[] = [];
	const stats = { dsComponentUses: 0, rawElements: 0, reimplementations: 0, tokenRefs: 0, literals: 0, unknownTokens: 0, inlineStyles: 0 };
	const componentsUsed: Record<string, number> = {};

	// Concepts the system covers, from declared components (+ anything imported from DS packages).
	const dsComponents = new Set(ds.components ?? []);
	for (const src of sources) {
		for (const line of src.content.split("\n")) {
			const m = line.match(IMPORT_RE);
			if (m && isDsSource(m[2], packages)) for (const n of importedNames(m[1])) if (/^[A-Z]/.test(n)) dsComponents.add(n);
		}
	}
	const dsConcepts = new Map<string, string>();
	for (const c of dsComponents) {
		const k = concept(c);
		if (k && !dsConcepts.has(k)) dsConcepts.set(k, c);
	}

	for (const src of sources) {
		const isStyleFile = /\.(css|scss|sass|less)$/i.test(src.path);
		const lines = src.content.split("\n");
		const dsLocal = new Set<string>();
		const add = (line: number, rule: string, severity: CodeFinding["severity"], message: string, text: string) =>
			findings.push({ file: src.path, line, rule, severity, message, snippet: text.trim().slice(0, 160) });

		lines.forEach((rawLine, idx) => {
			const n = idx + 1;
			const line = stripComment(rawLine);
			if (!line.trim() || /^\s*(\*|\/\*)/.test(line)) return;

			const imp = line.match(IMPORT_RE);
			if (imp) {
				if (isDsSource(imp[2], packages)) for (const name of importedNames(imp[1])) dsLocal.add(name);
				else if (imp[2].startsWith(".")) {
					for (const name of importedNames(imp[1])) {
						const k = /^[A-Z]/.test(name) ? concept(name) : undefined;
						// The source isn't necessarily in this audit, so it may be a wrapper
						// around the system's component: a warning, not an error. (When the
						// file IS audited, its definition gets the precise check below.)
						if (k && dsConcepts.has(k)) {
							add(n, "local-lookalike-import", "warning", `Imports a local "${name}" while the design system has "${dsConcepts.get(k)}". Unless it wraps the system's component, use the system's one.`, rawLine);
						}
					}
				}
				return;
			}

			// Locally defined component that duplicates a system one.
			const def = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:function|const|class)\s+([A-Z][\w$]*)\b/);
			if (def && !isStyleFile) {
				const k = concept(def[1]);
				// A wrapper that renders the system component isn't a re-implementation.
				const sys = k ? dsConcepts.get(k) : undefined;
				const body = lines.slice(idx + 1, idx + 60).join("\n");
				const nextDef = body.search(/\n\s*(?:export\s+)?(?:default\s+)?(?:function|const|class)\s+[A-Z]/);
				const ownBody = nextDef >= 0 ? body.slice(0, nextDef) : body;
				const wraps = sys ? new RegExp(`<${sys}[\\s/>.]`).test(ownBody) || new RegExp(`<${sys}[\\s/>.]`).test(line) : false;
				if (sys && !wraps) {
					stats.reimplementations++;
					add(n, "reimplements-component", "error", `Defines "${def[1]}" although the design system has "${sys}". Use the system's component, or report the gap.`, rawLine);
				}
			}

			// JSX usage of system components.
			for (const m of line.matchAll(/<([A-Z][\w$]*)(?:\.[\w$]+)?[\s/>]/g)) {
				if (dsLocal.has(m[1]) || (packages.length === 0 && dsComponents.has(m[1]))) {
					stats.dsComponentUses++;
					componentsUsed[m[1]] = (componentsUsed[m[1]] ?? 0) + 1;
				}
			}

			// Raw elements the system covers.
			if (!isStyleFile) {
				for (const m of line.matchAll(/<(button|input|select|textarea|dialog|table)\b/g)) {
					const k = RAW_ELEMENT_CONCEPT[m[1]];
					const sys = dsConcepts.get(k);
					stats.rawElements++;
					add(
						n,
						"raw-element",
						sys ? "warning" : "info",
						sys ? `Raw <${m[1]}> where the design system has "${sys}".` : `Raw <${m[1]}>. If the design system has a component for this, use it.`,
						rawLine,
					);
				}
				if (/\bstyle=\{\{|\bstyle="/.test(line)) {
					stats.inlineStyles++;
					add(n, "inline-style", "info", "Inline style. Prefer the system's components, classes or tokens.", rawLine);
				}
			}

			// Token references.
			for (const m of line.matchAll(VAR_RE)) {
				stats.tokenRefs++;
				if (knownTokens && !knownTokens.has(m[1])) {
					stats.unknownTokens++;
					add(n, "unknown-token", "error", `var(--${m[1]}) isn't a token in the design system. Don't invent tokens; use an existing one or report the gap.`, rawLine);
				}
			}

			// Tailwind theme classes that name a known token are token usage.
			if (knownTokens && !isStyleFile) {
				for (const m of line.matchAll(TW_COLOR_CLASS_RE)) if (knownTokens.has(m[1])) stats.tokenRefs++;
			}

			// Token definitions (theme files) are where literals belong.
			if (TOKEN_DEF_RE.test(line)) return;

			// Tailwind arbitrary values are reported once, as such — not again as colors/lengths.
			const twSpans: Array<[number, number]> = [];
			for (const m of line.matchAll(TW_ARBITRARY_RE)) {
				twSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
				stats.literals++;
				add(n, "tailwind-arbitrary-value", "warning", `Tailwind arbitrary value ${m[0].trim()}. Use a theme value.`, rawLine);
			}
			const inTw = (i: number) => twSpans.some(([a, b]) => i >= a && i < b);
			// href="#section" / url(#gradient) are anchors, not colors.
			const anchors = /href=|url\(/.test(line);
			for (const m of line.matchAll(COLOR_RE)) {
				if ((anchors && m[0].startsWith("#")) || inTw(m.index ?? 0)) continue;
				stats.literals++;
				add(n, "hardcoded-color", "warning", `Hardcoded color ${m[0]}${m[0].includes("(") ? "…)" : ""}. Use a color token.`, rawLine);
			}
			for (const m of line.matchAll(LENGTH_RE)) {
				if (Number(m[1]) === 0 || inTw(m.index ?? 0)) continue;
				stats.literals++;
				add(n, "hardcoded-length", "warning", `Hardcoded ${m[0].split(/[:=]/)[0].trim()} ${m[1]}${m[2] ?? ""}. Use a spacing/radius/type token.`, rawLine);
			}
		});
	}

	return { files: sources.length, stats, componentsUsed, findings };
}

export function scoreCodeAudit(r: CodeAuditResult, minScore = 90) {
	const s = r.stats;
	const compDen = s.dsComponentUses + s.reimplementations + r.findings.filter((f) => f.rule === "raw-element" && f.severity === "warning").length;
	const componentCoverage = compDen > 0 ? s.dsComponentUses / compDen : null;
	const tokDen = s.tokenRefs + s.literals;
	const tokenCoverage = tokDen > 0 ? (s.tokenRefs - s.unknownTokens) / tokDen : null;
	const parts = [componentCoverage, tokenCoverage].filter((x): x is number => x !== null);
	const score = parts.length ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100) : 100;
	const errors = r.findings.filter((f) => f.severity === "error").length;
	return {
		score,
		pass: errors === 0 && score >= minScore,
		componentCoverage: componentCoverage === null ? null : Math.round(componentCoverage * 1000) / 1000,
		tokenCoverage: tokenCoverage === null ? null : Math.round(tokenCoverage * 1000) / 1000,
		errors,
		warnings: r.findings.filter((f) => f.severity === "warning").length,
	};
}

/** Token names from a CSS file (custom properties) or a DTCG / nested JSON token file. */
/** Component names from a component folder's file names: "dropdown-menu.tsx" → "DropdownMenu". */
export function componentNamesFromFiles(fileNames: string[]): string[] {
	return fileNames
		.filter((f) => /\.(tsx|jsx|vue|svelte)$/i.test(f) && !/^(index|use-)/i.test(f) && !/\.(test|spec|stories)\./i.test(f))
		.map((f) =>
			f
				.replace(/\.[^.]+$/, "")
				.split(/[-_\s]+/)
				.map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
				.join(""),
		);
}

export function tokenNamesFrom(path: string, content: string): string[] {
	if (/\.json$/i.test(path)) {
		const out: string[] = [];
		const walk = (node: any, trail: string[]) => {
			if (!node || typeof node !== "object") return;
			if ("$value" in node || "value" in node) {
				out.push(trail.join("-"), trail.join("."));
				return;
			}
			for (const [k, v] of Object.entries(node)) if (!k.startsWith("$")) walk(v, [...trail, k]);
		};
		walk(JSON.parse(content), []);
		return out.map((n) => n.toLowerCase().replace(/[^a-z0-9.-]+/g, "-"));
	}
	return [...content.matchAll(/--([A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]);
}
