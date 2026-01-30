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

/** State-related variant values that indicate accessible component design. */
const STATE_VARIANTS = [
	"disabled",
	"error",
	"focus",
	"hover",
	"active",
	"pressed",
	"selected",
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
 * Extract resolved color values from variables.
 * Returns an array of { name, r, g, b } objects for direct color values.
 */
function extractColorValues(
	variables: any[],
): Array<{ name: string; r: number; g: number; b: number }> {
	const colors: Array<{ name: string; r: number; g: number; b: number }> = [];

	for (const variable of variables) {
		if (variable.resolvedType !== "COLOR" || !variable.valuesByMode) continue;

		for (const value of Object.values(variable.valuesByMode)) {
			if (isDirectColor(value)) {
				colors.push({
					name: variable.name,
					r: value.r,
					g: value.g,
					b: value.b,
				});
				break; // Use the first direct color value per variable
			}
		}
	}

	return colors;
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
			details:
				colors.length === 0
					? "No direct color values to evaluate."
					: "Only one color found; need at least two to check contrast.",
		};
	}

	const bgPattern = /background|bg|surface|canvas|base/i;
	const fgPattern = /text|foreground|fg|on-|on\.|label|title|body|heading/i;

	const backgrounds = colors.filter((c) => bgPattern.test(c.name));
	const foregrounds = colors.filter((c) => fgPattern.test(c.name));

	// If naming conventions are not used, use luminance-based heuristic
	let pairs: Array<{
		fg: { name: string; r: number; g: number; b: number };
		bg: { name: string; r: number; g: number; b: number };
	}> = [];

	if (backgrounds.length > 0 && foregrounds.length > 0) {
		// Pair foregrounds with backgrounds by naming proximity
		for (const fg of foregrounds) {
			for (const bg of backgrounds) {
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
			details: "No components to evaluate.",
		};
	}

	// Check which state variants exist across all component names
	const allNames = components.map((c) => c.name.toLowerCase()).join(" ");
	const foundStates = STATE_VARIANTS.filter((state) =>
		allNames.includes(state),
	);
	const ratio = foundStates.length / STATE_VARIANTS.length;
	const score = clamp(ratio * 100);

	const missingStates = STATE_VARIANTS.filter(
		(state) => !allNames.includes(state),
	);

	return {
		id: "a11y-state-variants",
		label: "State variants",
		score,
		severity: getSeverity(score),
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
		shortLabel: "A11y",
		score,
		weight: 0.15,
		findings,
	};
}
