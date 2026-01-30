/**
 * Naming & Semantics Scorer (weight: 0.20)
 *
 * Checks whether design system names describe intent rather than appearance.
 * Evaluates variable naming, component naming, variant naming, and boolean
 * naming conventions against semantic best practices.
 */

import type { CategoryScore, DesignSystemRawData, Finding } from "./types.js";
import { clamp, getSeverity } from "./types.js";

/** Maximum examples to include in a finding. */
const MAX_EXAMPLES = 5;

/** Color words that indicate visual (non-semantic) naming. */
const VISUAL_COLOR_WORDS = [
	"red",
	"blue",
	"green",
	"yellow",
	"orange",
	"purple",
	"pink",
	"black",
	"white",
	"gray",
	"grey",
	"cyan",
	"magenta",
	"teal",
	"indigo",
	"violet",
	"brown",
	"lime",
	"amber",
	"emerald",
	"rose",
	"sky",
	"slate",
	"zinc",
	"stone",
	"neutral",
];

/** Visual variant values that should be replaced with semantic ones. */
const VISUAL_VARIANT_VALUES = [
	"red",
	"blue",
	"green",
	"yellow",
	"orange",
	"purple",
	"pink",
	"black",
	"white",
	"gray",
	"grey",
	"cyan",
];

/** Semantic variant values that indicate good naming. */
const SEMANTIC_VARIANT_VALUES = [
	"primary",
	"secondary",
	"tertiary",
	"danger",
	"warning",
	"success",
	"info",
	"error",
	"disabled",
	"default",
	"accent",
	"muted",
	"destructive",
	"outline",
	"ghost",
	"link",
];

const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;
const BOOLEAN_PREFIX_RE =
	/^(is|has|can|should|will|did|was|with|show|hide|enable|disable)/i;

/**
 * Extract the leaf segment from a variable name.
 * e.g. "color/action/primary" -> "primary", "color.blue.500" -> "500"
 */
function getLeafName(name: string): string {
	const parts = name.split(/[/.]/);
	return parts[parts.length - 1];
}

/**
 * Check if a name contains visual color words in its leaf segments.
 */
function containsVisualColorWord(name: string): boolean {
	const leaf = getLeafName(name).toLowerCase();
	return VISUAL_COLOR_WORDS.some(
		(word) => leaf === word || leaf.startsWith(`${word}-`),
	);
}

/**
 * Score variable naming for semantic quality.
 * Variables should use semantic names (color.action.primary) rather than
 * visual names (color.blue.500).
 */
function scoreVariableNaming(data: DesignSystemRawData): Finding {
	const colorVars = data.variables.filter((v) => v.resolvedType === "COLOR");

	if (colorVars.length === 0) {
		return {
			id: "naming-variable-semantic",
			label: "Variable naming",
			score: 100,
			severity: "info",
			details: "No color variables to evaluate.",
		};
	}

	const visualVars = colorVars.filter((v) => containsVisualColorWord(v.name));
	const semanticRatio = 1 - visualVars.length / colorVars.length;
	const score = clamp(semanticRatio * 100);

	return {
		id: "naming-variable-semantic",
		label: "Variable naming",
		score,
		severity: getSeverity(score),
		details:
			visualVars.length > 0
				? `${visualVars.length} of ${colorVars.length} color variables use visual names instead of semantic names.`
				: `All ${colorVars.length} color variables use semantic names.`,
		examples:
			visualVars.length > 0
				? visualVars.slice(0, MAX_EXAMPLES).map((v) => v.name)
				: undefined,
	};
}

/**
 * Score component naming for consistency.
 * Components should use PascalCase and avoid mixed abbreviations.
 */
function scoreComponentNaming(data: DesignSystemRawData): Finding {
	const components = data.components;

	if (components.length === 0) {
		return {
			id: "naming-component-casing",
			label: "Component naming",
			score: 100,
			severity: "info",
			details: "No components to evaluate.",
		};
	}

	let pascalCount = 0;
	const nonPascalComps: string[] = [];
	for (const comp of components) {
		// Component names may use path separators; check each segment
		const segments = comp.name.split("/").map((s: string) => s.trim());
		const allPascal = segments.every((seg: string) => PASCAL_CASE_RE.test(seg));
		if (allPascal) {
			pascalCount++;
		} else {
			nonPascalComps.push(comp.name);
		}
	}

	const ratio = pascalCount / components.length;
	const score = clamp(ratio * 100);

	return {
		id: "naming-component-casing",
		label: "Component naming",
		score,
		severity: getSeverity(score),
		details: `${pascalCount} of ${components.length} components use consistent PascalCase naming.`,
		examples:
			nonPascalComps.length > 0
				? nonPascalComps.slice(0, MAX_EXAMPLES)
				: undefined,
	};
}

/**
 * Score variant naming for semantic quality.
 * Variant values should be semantic (primary, danger) rather than
 * visual (blue, red). Also checks for consistent size naming.
 */
function scoreVariantNaming(data: DesignSystemRawData): Finding {
	// Components with variants have a componentSetId
	const variantComponents = data.components.filter((c) => c.componentSetId);

	if (variantComponents.length === 0) {
		return {
			id: "naming-variant-semantic",
			label: "Variant naming",
			score: 100,
			severity: "info",
			details: "No variant components to evaluate.",
		};
	}

	// Extract variant info from component names (e.g., "Button/Primary" or "Size=Small, Color=Primary")
	let semanticCount = 0;
	let visualCount = 0;
	const visualVariantComps: string[] = [];

	for (const comp of variantComponents) {
		const nameLower = comp.name.toLowerCase();
		const hasVisual = VISUAL_VARIANT_VALUES.some(
			(v) =>
				nameLower === v ||
				nameLower.includes(`=${v}`) ||
				nameLower.includes(`, ${v}`),
		);
		const hasSemantic = SEMANTIC_VARIANT_VALUES.some(
			(v) =>
				nameLower === v ||
				nameLower.includes(`=${v}`) ||
				nameLower.includes(`, ${v}`),
		);

		if (hasSemantic) semanticCount++;
		if (hasVisual) {
			visualCount++;
			visualVariantComps.push(comp.name);
		}
	}

	const totalEvaluated = semanticCount + visualCount;
	if (totalEvaluated === 0) {
		return {
			id: "naming-variant-semantic",
			label: "Variant naming",
			score: 75,
			severity: "warning",
			details: "Variant values could not be classified as semantic or visual.",
		};
	}

	const ratio = semanticCount / totalEvaluated;
	const score = clamp(ratio * 100);

	return {
		id: "naming-variant-semantic",
		label: "Variant naming",
		score,
		severity: getSeverity(score),
		details:
			visualCount > 0
				? `${visualCount} variant values use visual names. Prefer semantic names like "primary", "danger".`
				: "Variant values use semantic naming conventions.",
		examples:
			visualVariantComps.length > 0
				? visualVariantComps.slice(0, MAX_EXAMPLES)
				: undefined,
	};
}

/**
 * Score boolean variable naming.
 * Boolean variables should follow is-, has-, can- prefix patterns.
 */
function scoreBooleanNaming(data: DesignSystemRawData): Finding {
	const boolVars = data.variables.filter((v) => v.resolvedType === "BOOLEAN");

	if (boolVars.length === 0) {
		return {
			id: "naming-boolean-prefix",
			label: "Boolean naming",
			score: 100,
			severity: "info",
			details: "No boolean variables to evaluate.",
		};
	}

	const missingPrefix = boolVars.filter((v) => {
		const leaf = getLeafName(v.name);
		return !BOOLEAN_PREFIX_RE.test(leaf);
	});
	const correctCount = boolVars.length - missingPrefix.length;

	const ratio = correctCount / boolVars.length;
	const score = clamp(ratio * 100);

	return {
		id: "naming-boolean-prefix",
		label: "Boolean naming",
		score,
		severity: getSeverity(score),
		details:
			missingPrefix.length > 0
				? `${missingPrefix.length} of ${boolVars.length} boolean variables lack is*/has*/can* prefixes.`
				: `All ${boolVars.length} boolean variables use proper prefixes.`,
		examples:
			missingPrefix.length > 0
				? missingPrefix.slice(0, MAX_EXAMPLES).map((v) => v.name)
				: undefined,
	};
}

/**
 * Naming & Semantics category scorer.
 * Returns the average score across all naming checks.
 */
export function scoreNamingSemantics(data: DesignSystemRawData): CategoryScore {
	const findings: Finding[] = [
		scoreVariableNaming(data),
		scoreComponentNaming(data),
		scoreVariantNaming(data),
		scoreBooleanNaming(data),
	];

	const score = clamp(
		findings.reduce((sum, f) => sum + f.score, 0) / findings.length,
	);

	return {
		id: "naming-semantics",
		label: "Naming & Semantics",
		shortLabel: "Name",
		score,
		weight: 0.2,
		findings,
	};
}
