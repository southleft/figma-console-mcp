/**
 * Accessibility Scorer (weight: 0.15)
 *
 * Checks accessibility-related signals in the design system.
 * Evaluates color contrast ratios, state variant coverage,
 * and semantic color naming patterns.
 */

import type { CategoryScore, DesignSystemRawData, Finding } from "./types.js";
import { clamp, getSeverity } from "./types.js";

/** Maximum examples to include in a finding. */
const MAX_EXAMPLES = 5;

/** WCAG AA minimum contrast ratio for normal text. */
const WCAG_AA_RATIO = 4.5;

/**
 * State-related variant values that indicate accessible component design.
 * Each entry is a set of synonyms — CSS `:active` IS the pressed state, so a
 * library expressing it as either "active" or "pressed" satisfies that state.
 */
const STATE_VARIANTS: Array<{ name: string; synonyms: string[] }> = [
	{ name: "disabled", synonyms: ["disabled"] },
	{ name: "error", synonyms: ["error", "danger", "invalid"] },
	{ name: "focus", synonyms: ["focus", "focused"] },
	{ name: "hover", synonyms: ["hover", "hovered"] },
	{ name: "active/pressed", synonyms: ["active", "pressed"] },
	{ name: "selected", synonyms: ["selected", "checked"] },
];

/** Semantic color token name patterns that indicate accessibility awareness. */
const SEMANTIC_COLOR_NAMES = ["error", "warning", "success", "info", "danger"];

/**
 * Linearize an sRGB channel value for luminance calculation.
 * Input: channel value in 0-1 range.
 */
function linearize(channel: number): number {
	return channel <= 0.04045
		? channel / 12.92
		: ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * Calculate relative luminance of a color.
 * r, g, b are in 0-1 range (as Figma provides them).
 */
function luminance(r: number, g: number, b: number): number {
	return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * Calculate contrast ratio between two colors.
 * Returns a ratio >= 1 (e.g., 4.5 for WCAG AA compliance).
 */
function contrastRatio(
	r1: number,
	g1: number,
	b1: number,
	r2: number,
	g2: number,
	b2: number,
): number {
	const lum1 = luminance(r1, g1, b1);
	const lum2 = luminance(r2, g2, b2);
	const lighter = Math.max(lum1, lum2);
	const darker = Math.min(lum1, lum2);
	return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Check if a value is a direct color (not an alias).
 */
function isDirectColor(
	value: unknown,
): value is { r: number; g: number; b: number; a: number } {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.r === "number" &&
		typeof v.g === "number" &&
		typeof v.b === "number" &&
		v.type !== "VARIABLE_ALIAS"
	);
}

/**
 * Extract resolved color values from variables, following alias chains.
 * Semantic tokens are usually ALIASES of primitives — skipping them (the old
 * behavior) dropped exactly the tokens whose names drive fg/bg pairing, so
 * alias-heavy systems fell back to noisy scale-vs-scale pairing.
 * Returns an array of { name, r, g, b } objects.
 */
function extractColorValues(
	variables: any[],
): Array<{ name: string; r: number; g: number; b: number }> {
	const byId = new Map<string, any>();
	for (const variable of variables) {
		if (variable.id) byId.set(variable.id, variable);
	}

	const resolve = (variable: any, depth = 0): any => {
		if (!variable?.valuesByMode || depth > 8) return null;
		for (const value of Object.values(variable.valuesByMode)) {
			if (isDirectColor(value)) return value;
			const v = value as Record<string, unknown>;
			if (v?.type === "VARIABLE_ALIAS" && typeof v.id === "string") {
				const target = byId.get(v.id);
				const resolved = target ? resolve(target, depth + 1) : null;
				if (resolved) return resolved;
			}
		}
		return null;
	};

	const colors: Array<{ name: string; r: number; g: number; b: number }> = [];
	for (const variable of variables) {
		if (variable.resolvedType !== "COLOR") continue;
		const value = resolve(variable);
		// Skip translucent colors: they composite over whatever is beneath
		// them, so a standalone contrast ratio is meaningless (a 5%-alpha
		// "background/subtle" wash is not a 1.0:1 background).
		if (value && (value.a === undefined || value.a >= 0.99)) {
			colors.push({ name: variable.name, r: value.r, g: value.g, b: value.b });
		}
	}

	return colors;
}

/**
 * Component-scoped tokens (comp/button/..., component/card/...) only ever
 * co-occur with tokens of the SAME component scope — pairing a button label
 * against a card background measures a combination that never renders.
 * Returns the scope prefix for component-scoped names, or null for global
 * semantic tokens (which may pair freely).
 */
function componentScope(name: string): string | null {
	const m = name.match(/^(comp|component|components)\/([^/]+)/i);
	return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : null;
}

/**
 * Identify likely foreground/background color pairs and check contrast.
 *
 * Strategy: pair colors whose names suggest fg/bg relationships:
 * - Names containing "background"/"bg"/"surface" are backgrounds
 * - Names containing "text"/"foreground"/"fg"/"on" are foregrounds
 * Falls back to pairing dark colors with light colors if no naming convention found.
 */
function scoreColorContrast(data: DesignSystemRawData): Finding {
	const colors = extractColorValues(data.variables);

	if (colors.length < 2) {
		return {
			id: "a11y-color-contrast",
			label: "Color contrast",
			score: 100,
			severity: "info",
			tooltip:
				"Foreground/background color pairs should meet WCAG AA contrast ratio (4.5:1). Low contrast makes content unreadable for users with vision impairments.",
			details:
				colors.length === 0
					? "No direct color values to evaluate."
					: "Only one color found; need at least two to check contrast.",
		};
	}

	const bgPattern = /background|bg|surface|canvas|base/i;
	// "content" covers the common `color/content/*` semantic convention; the
	// bare `on-` fragment is anchored to a path segment so names like
	// "annotation-gray" don't false-match.
	const fgPattern =
		/text|foreground|fg|content|(?:^|\/)on-|on\.|label|title|body|heading/i;

	const backgrounds = colors.filter((c) => bgPattern.test(c.name));
	// A token whose name also matches the background pattern is a surface, not
	// a foreground — "body/background" must not be treated as body text.
	const foregrounds = colors.filter(
		(c) => fgPattern.test(c.name) && !bgPattern.test(c.name),
	);

	// If naming conventions are not used, use luminance-based heuristic
	let pairs: Array<{
		fg: { name: string; r: number; g: number; b: number };
		bg: { name: string; r: number; g: number; b: number };
	}> = [];

	if (backgrounds.length > 0 && foregrounds.length > 0) {
		// Pair foregrounds with backgrounds where the token names DECLARE the
		// relationship, instead of a full cross-product (which measures
		// combinations that never render — a primary button label on a
		// knockout background, default text on an inverted surface):
		//   1. inverse-content tokens pair with inverted backgrounds only;
		//   2. utility-family content (danger/warning/…) pairs with the same
		//      utility family's backgrounds;
		//   3. other GLOBAL content tokens pair with the default background
		//      (the canvas every non-inverse text token must survive on);
		//   4. component-scoped tokens pair by path mirror within the same
		//      component and variant family (content ↔ background).
		// Interaction/emphasis modifiers (-hover, -active, -strong, …) are
		// stripped when matching so state variants inherit their base pair.
		const stripModifiers = (leaf: string) =>
			leaf.replace(/-(hover|active|pressed|focus|strong|subtle|weak)$/i, "");
		const leafOf = (name: string) =>
			stripModifiers(name.split("/").pop()?.toLowerCase() ?? "");
		const utilityFamily = (name: string) =>
			name.match(/utility\/([a-z]+)/i)?.[1]?.toLowerCase() ?? null;

		// Family of a background token: first path segment after "background"
		// when one exists ("background/danger/weak" → danger), else null
		// (canvas-level backgrounds like "background/default").
		const bgFamilyOf = (name: string): string | null => {
			const segs = name.toLowerCase().split("/");
			const i = segs.findIndex((s) => /^(background|bg|surface)$/.test(s));
			if (i < 0) return null;
			const rest = segs.slice(i + 1).filter((s) => s !== "utility");
			return rest.length >= 2 ? rest[0] : null;
		};
		// Is a background the canvas (the default app surface)?
		const bgIsCanvas = (name: string): boolean => {
			const segs = name.toLowerCase().split("/");
			const i = segs.findIndex((s) => /^(background|bg|surface)$/.test(s));
			if (i < 0) return false;
			const rest = segs.slice(i + 1);
			return rest.length === 1 && stripModifiers(rest[0]) === "default";
		};
		// On-surface declaration for a content token: either an explicit
		// "/on/<family>" path segment (content/on/primary) or an "on-<family>"
		// / "<family>-strong" leaf — both dialects declare "this text sits ON
		// that family's surface". Returns the target family, or null.
		const onSurfaceFamilyOf = (name: string): string | null => {
			const lower = name.toLowerCase();
			const pathMatch = lower.match(/\/on\/([a-z][a-z0-9-]*)/);
			if (pathMatch) return stripModifiers(pathMatch[1]);
			const leaf = lower.split("/").pop() ?? "";
			const onLeaf = leaf.match(/^on-([a-z0-9-]+)$/);
			if (onLeaf) return stripModifiers(onLeaf[1]);
			const strongLeaf = leaf.match(/^([a-z0-9]+)-strong$/);
			if (strongLeaf) return strongLeaf[1];
			return null;
		};

		for (const fg of foregrounds) {
			const fgScope = componentScope(fg.name);
			const fgOnFamily = onSurfaceFamilyOf(fg.name);
			const fgIsInverse =
				fgOnFamily === "inverse" || /inverse/i.test(leafOf(fg.name));
			for (const bg of backgrounds) {
				const bgScope = componentScope(bg.name);
				if (fgScope !== bgScope) continue;
				const bgIsInverted =
					/invert|inverse/i.test(leafOf(bg.name)) ||
					bgFamilyOf(bg.name) === "inverse";
				if (fgScope !== null) {
					// Component scope: mirror the path with content→background
					// swapped and modifiers stripped.
					const mirror = fg.name
						.toLowerCase()
						.replace(/(^|\/)(content|text|foreground|fg)(\/|$)/, "$1background$3");
					const bgNorm = bg.name.toLowerCase();
					const strip = (s: string) =>
						s
							.split("/")
							.map((seg, i, arr) => (i === arr.length - 1 ? stripModifiers(seg) : seg))
							.join("/");
					if (strip(bgNorm) !== strip(mirror)) continue;
				} else if (fgIsInverse || bgIsInverted) {
					// inverse content ↔ inverted/inverse surfaces only
					if (!(fgIsInverse && bgIsInverted)) continue;
				} else if (fgOnFamily) {
					// declared on-surface text → its family's surface only
					if (bgFamilyOf(bg.name) !== fgOnFamily) continue;
				} else {
					// everything else (plain content, family-COLORED canvas text
					// like content/brand or content/danger/default) must survive
					// on the canvas — and only the canvas is a declared pair.
					if (!bgIsCanvas(bg.name)) continue;
				}
				pairs.push({ fg, bg });
			}
		}
	} else {
		// Heuristic: separate into light (luminance > 0.5) and dark (luminance <= 0.5)
		const lightColors = colors.filter((c) => luminance(c.r, c.g, c.b) > 0.5);
		const darkColors = colors.filter((c) => luminance(c.r, c.g, c.b) <= 0.5);

		for (const dark of darkColors) {
			for (const light of lightColors) {
				pairs.push({ fg: dark, bg: light });
			}
		}
	}

	if (pairs.length === 0) {
		return {
			id: "a11y-color-contrast",
			label: "Color contrast",
			score: 50,
			severity: "warning",
			tooltip:
				"Foreground/background color pairs should meet WCAG AA contrast ratio (4.5:1). Low contrast makes content unreadable for users with vision impairments.",
			details:
				"Could not identify foreground/background color pairs to check contrast.",
		};
	}

	// Limit pair evaluation to avoid performance issues with large token sets
	const maxPairs = 50;
	if (pairs.length > maxPairs) {
		pairs = pairs.slice(0, maxPairs);
	}

	let passingPairs = 0;
	const failingExamples: string[] = [];
	for (const { fg, bg } of pairs) {
		const ratio = contrastRatio(fg.r, fg.g, fg.b, bg.r, bg.g, bg.b);
		if (ratio >= WCAG_AA_RATIO) {
			passingPairs++;
		} else if (failingExamples.length < MAX_EXAMPLES) {
			failingExamples.push(`${fg.name} / ${bg.name} (${ratio.toFixed(1)}:1)`);
		}
	}

	const passRatio = passingPairs / pairs.length;
	const score = clamp(passRatio * 100);

	return {
		id: "a11y-color-contrast",
		label: "Color contrast",
		score,
		severity: getSeverity(score),
		tooltip:
			"Foreground/background color pairs should meet WCAG AA contrast ratio (4.5:1). Low contrast makes content unreadable for users with vision impairments.",
		details: `${passingPairs} of ${pairs.length} color pairs meet WCAG AA contrast ratio (${WCAG_AA_RATIO}:1).`,
		examples: failingExamples.length > 0 ? failingExamples : undefined,
	};
}

/**
 * Score state variant coverage.
 * Components should include state-related variants for accessibility.
 */
function scoreStateVariants(data: DesignSystemRawData): Finding {
	const components = data.components;

	if (components.length === 0) {
		return {
			id: "a11y-state-variants",
			label: "State variants",
			score: 100,
			severity: "info",
			tooltip:
				"Interactive components should include state variants (disabled, error, focus, hover, active, pressed, selected) for accessible interactions.",
			details: "No components to evaluate.",
		};
	}

	// Check which state variants exist across all component names
	const allNames = components.map((c) => c.name.toLowerCase()).join(" ");
	const foundStates = STATE_VARIANTS.filter((state) =>
		state.synonyms.some((syn) => allNames.includes(syn)),
	);
	const ratio = foundStates.length / STATE_VARIANTS.length;
	const score = clamp(ratio * 100);

	const missingStates = STATE_VARIANTS.filter(
		(state) => !state.synonyms.some((syn) => allNames.includes(syn)),
	).map((state) => state.name);

	return {
		id: "a11y-state-variants",
		label: "State variants",
		score,
		severity: getSeverity(score),
		tooltip:
			"Interactive components should include state variants (disabled, error, focus, hover, active, pressed, selected) for accessible interactions.",
		details:
			missingStates.length > 0
				? `Found ${foundStates.length} of ${STATE_VARIANTS.length} state variants. Missing: ${missingStates.join(", ")}.`
				: `All ${STATE_VARIANTS.length} state variants are represented.`,
	};
}

/**
 * Score semantic color naming.
 * The token set should include semantic color tokens for error/warning/success/info.
 */
function variableDataUnavailable(data: DesignSystemRawData): boolean {
	return (
		data.dataAvailability !== undefined && !data.dataAvailability.variables
	);
}

function scoreSemanticColorNaming(data: DesignSystemRawData): Finding {
	const colorVars = data.variables.filter((v) => v.resolvedType === "COLOR");

	if (colorVars.length === 0) {
		const unavailable = variableDataUnavailable(data);
		return {
			id: "a11y-semantic-colors",
			label: "Semantic color naming",
			score: 0,
			severity: unavailable ? "info" : "fail",
			tooltip:
				"The token set should include semantic color categories (error, warning, success, info, danger) to convey meaning beyond color alone.",
			details: unavailable
				? `Variable data unavailable: ${data.dataAvailability?.variableError || "Requires Desktop Bridge or Enterprise plan."}`
				: "No color variables found.",
		};
	}

	const foundSemantic: string[] = [];
	const missingSemantic: string[] = [];
	const semanticExamples: string[] = [];

	for (const name of SEMANTIC_COLOR_NAMES) {
		const matching = colorVars.filter((v) =>
			v.name.toLowerCase().includes(name),
		);
		if (matching.length > 0) {
			foundSemantic.push(name);
			semanticExamples.push(
				`${name}: ${matching
					.slice(0, 2)
					.map((v) => v.name)
					.join(", ")}`,
			);
		} else {
			missingSemantic.push(name);
		}
	}

	const ratio = foundSemantic.length / SEMANTIC_COLOR_NAMES.length;
	const score = clamp(ratio * 100);

	return {
		id: "a11y-semantic-colors",
		label: "Semantic color naming",
		score,
		severity: getSeverity(score),
		tooltip:
			"The token set should include semantic color categories (error, warning, success, info, danger) to convey meaning beyond color alone.",
		details:
			missingSemantic.length > 0
				? `Found ${foundSemantic.length} of ${SEMANTIC_COLOR_NAMES.length} semantic color categories. Missing: ${missingSemantic.join(", ")}.`
				: "All semantic color categories (error, warning, success, info, danger) are present.",
		examples:
			semanticExamples.length > 0
				? semanticExamples.slice(0, MAX_EXAMPLES)
				: undefined,
	};
}

/**
 * Accessibility category scorer.
 * Returns the average score across all accessibility checks.
 */
export function scoreAccessibility(data: DesignSystemRawData): CategoryScore {
	const findings: Finding[] = [
		scoreColorContrast(data),
		scoreStateVariants(data),
		scoreSemanticColorNaming(data),
	];

	const score = clamp(
		findings.reduce((sum, f) => sum + f.score, 0) / findings.length,
	);

	return {
		id: "accessibility",
		label: "Accessibility",
		shortLabel: "Accessibility",
		score,
		weight: 0.15,
		findings,
	};
}
