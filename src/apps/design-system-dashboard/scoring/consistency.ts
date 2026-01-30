/**
 * Consistency Scorer (weight: 0.15)
 *
 * Checks pattern uniformity across the design system.
 * Evaluates naming delimiter consistency, casing consistency,
 * size value consistency, and mode naming consistency.
 */

import type { CategoryScore, DesignSystemRawData, Finding } from "./types.js";
import { buildCollectionNameMap, clamp, getSeverity } from "./types.js";

/** Maximum examples to include in a finding. */
const MAX_EXAMPLES = 5;

const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;
const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;
const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Supported delimiters in variable names. */
const DELIMITERS = ["/", ".", "-", "_"] as const;

/**
 * Count delimiter occurrences across all variable names.
 * Returns a map of delimiter to count of variables that use it.
 */
function countDelimiterUsage(names: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const delimiter of DELIMITERS) {
		counts.set(delimiter, 0);
	}

	for (const name of names) {
		for (const delimiter of DELIMITERS) {
			if (name.includes(delimiter)) {
				counts.set(delimiter, (counts.get(delimiter) ?? 0) + 1);
			}
		}
	}

	return counts;
}

/**
 * Score naming delimiter consistency.
 * Variable names should consistently use the same delimiter (/, ., or -).
 */
function scoreDelimiterConsistency(data: DesignSystemRawData): Finding {
	const names = data.variables.map((v) => v.name);

	if (names.length === 0) {
		return {
			id: "consistency-delimiter",
			label: "Naming delimiter consistency",
			score: 100,
			severity: "info",
			details: "No variables to evaluate.",
		};
	}

	const counts = countDelimiterUsage(names);

	// Find variables that use any delimiter at all
	const varsWithDelimiter = names.filter((name) =>
		DELIMITERS.some((d) => name.includes(d)),
	);

	if (varsWithDelimiter.length === 0) {
		return {
			id: "consistency-delimiter",
			label: "Naming delimiter consistency",
			score: 100,
			severity: "pass",
			details: "No delimiters used in variable names (single-segment names).",
		};
	}

	// Find the dominant delimiter
	let dominantDelimiter = "/";
	let dominantCount = 0;

	for (const [delimiter, count] of counts.entries()) {
		if (count > dominantCount) {
			dominantCount = count;
			dominantDelimiter = delimiter;
		}
	}

	const ratio = dominantCount / varsWithDelimiter.length;
	const score = clamp(ratio * 100);

	const collectionNames = buildCollectionNameMap(data.collections);

	// Find variables using non-dominant delimiters
	const nonDominantVars = data.variables.filter((v) => {
		const name = v.name;
		const usesDelimiter = DELIMITERS.some((d) => name.includes(d));
		if (!usesDelimiter) return false;
		return !name.includes(dominantDelimiter);
	});

	return {
		id: "consistency-delimiter",
		label: "Naming delimiter consistency",
		score,
		severity: getSeverity(score),
		details: `${Math.round(ratio * 100)}% of variables use "${dominantDelimiter}" as delimiter. Consistent delimiter usage improves navigability.`,
		examples:
			nonDominantVars.length > 0
				? nonDominantVars.slice(0, MAX_EXAMPLES).map((v) => v.name)
				: undefined,
		locations:
			nonDominantVars.length > 0
				? nonDominantVars.slice(0, MAX_EXAMPLES).map((v) => ({
						name: v.name,
						collection: collectionNames.get(v.variableCollectionId),
						type: "variable",
					}))
				: undefined,
	};
}

/**
 * Detect the casing pattern of a name segment.
 */
function detectCasing(segment: string): string {
	if (PASCAL_CASE_RE.test(segment)) return "PascalCase";
	if (CAMEL_CASE_RE.test(segment)) return "camelCase";
	if (KEBAB_CASE_RE.test(segment)) return "kebab-case";
	if (SNAKE_CASE_RE.test(segment)) return "snake_case";
	if (segment === segment.toUpperCase() && segment.length > 1)
		return "UPPERCASE";
	if (segment === segment.toLowerCase()) return "lowercase";
	return "mixed";
}

/**
 * Score casing consistency across component and variable names.
 */
function scoreCasingConsistency(data: DesignSystemRawData): Finding {
	// Check component name casing
	const componentSegments: string[] = [];
	for (const comp of data.components) {
		const segments = comp.name.split("/").map((s: string) => s.trim());
		componentSegments.push(...segments);
	}

	// Check variable name leaf segments
	const variableLeaves: string[] = [];
	for (const v of data.variables) {
		const segments = v.name.split(/[/.]/);
		if (segments.length > 0) {
			variableLeaves.push(...segments);
		}
	}

	const allSegments = [...componentSegments, ...variableLeaves].filter(
		(s) => s.length > 1,
	);

	if (allSegments.length === 0) {
		return {
			id: "consistency-casing",
			label: "Casing consistency",
			score: 100,
			severity: "info",
			details: "No name segments to evaluate.",
		};
	}

	// Count casing patterns
	const casingCounts = new Map<string, number>();
	for (const segment of allSegments) {
		const casing = detectCasing(segment);
		casingCounts.set(casing, (casingCounts.get(casing) ?? 0) + 1);
	}

	// Find dominant casing
	let dominantCasing = "mixed";
	let dominantCount = 0;
	for (const [casing, count] of casingCounts.entries()) {
		if (count > dominantCount) {
			dominantCount = count;
			dominantCasing = casing;
		}
	}

	const ratio = dominantCount / allSegments.length;
	const score = clamp(ratio * 100);

	// Find segments using non-dominant casing
	const nonDominantSegments = allSegments.filter(
		(seg) => detectCasing(seg) !== dominantCasing,
	);

	return {
		id: "consistency-casing",
		label: "Casing consistency",
		score,
		severity: getSeverity(score),
		details: `${Math.round(ratio * 100)}% of name segments use ${dominantCasing}. Consistent casing improves readability.`,
		examples:
			nonDominantSegments.length > 0
				? nonDominantSegments.slice(0, MAX_EXAMPLES)
				: undefined,
	};
}

/**
 * Check if numeric values follow a consistent scale pattern.
 * Common patterns: multiples of 4, multiples of 8, powers of 2.
 */
function detectScalePattern(values: number[]): {
	pattern: string;
	matchRatio: number;
} {
	if (values.length === 0) return { pattern: "none", matchRatio: 0 };

	const positiveValues = values.filter((v) => v > 0);
	if (positiveValues.length === 0) return { pattern: "none", matchRatio: 0 };

	const scales = [
		{ name: "4px base", divisor: 4 },
		{ name: "8px base", divisor: 8 },
		{ name: "2px base", divisor: 2 },
	];

	let bestPattern = "none";
	let bestRatio = 0;

	for (const scale of scales) {
		const matching = positiveValues.filter(
			(v) => v % scale.divisor === 0,
		).length;
		const ratio = matching / positiveValues.length;
		if (ratio > bestRatio) {
			bestRatio = ratio;
			bestPattern = scale.name;
		}
	}

	return { pattern: bestPattern, matchRatio: bestRatio };
}

/**
 * Score size value consistency.
 * Numeric (FLOAT) variables should follow a consistent scale.
 */
function scoreSizeValueConsistency(data: DesignSystemRawData): Finding {
	const floatVars = data.variables.filter((v) => v.resolvedType === "FLOAT");

	if (floatVars.length === 0) {
		return {
			id: "consistency-size-values",
			label: "Size value consistency",
			score: 100,
			severity: "info",
			details: "No numeric variables to evaluate.",
		};
	}

	// Extract numeric values (skip aliases)
	const numericValues: number[] = [];
	for (const v of floatVars) {
		if (!v.valuesByMode) continue;
		for (const value of Object.values(v.valuesByMode)) {
			if (typeof value === "number") {
				numericValues.push(value);
			}
		}
	}

	if (numericValues.length === 0) {
		return {
			id: "consistency-size-values",
			label: "Size value consistency",
			score: 50,
			severity: "warning",
			details: "No direct numeric values found (all aliases).",
		};
	}

	const { pattern, matchRatio } = detectScalePattern(numericValues);
	const score = clamp(matchRatio * 100);

	return {
		id: "consistency-size-values",
		label: "Size value consistency",
		score,
		severity: getSeverity(score),
		details:
			pattern !== "none"
				? `${Math.round(matchRatio * 100)}% of numeric values follow a ${pattern} scale.`
				: "No consistent scale pattern detected in numeric values.",
	};
}

/**
 * Score mode naming consistency.
 * All collections should use the same mode names.
 */
function scoreModeNamingConsistency(data: DesignSystemRawData): Finding {
	const collections = data.collections;

	if (collections.length <= 1) {
		return {
			id: "consistency-mode-naming",
			label: "Mode naming consistency",
			score: 100,
			severity: collections.length === 0 ? "info" : "pass",
			details:
				collections.length === 0
					? "No collections to evaluate."
					: "Only one collection; mode naming consistency is not applicable.",
		};
	}

	// Collect mode name sets per collection
	const modeNameSets: string[][] = [];
	for (const collection of collections) {
		if (collection.modes && collection.modes.length > 0) {
			const modeNames = collection.modes
				.map((m: { name: string }) => m.name.toLowerCase())
				.sort();
			modeNameSets.push(modeNames);
		}
	}

	if (modeNameSets.length <= 1) {
		return {
			id: "consistency-mode-naming",
			label: "Mode naming consistency",
			score: 100,
			severity: "pass",
			details: "Only one collection has modes; consistency is not applicable.",
		};
	}

	// Compare mode name sets - check how many match the most common pattern
	const serialized = modeNameSets.map((s) => s.join(","));
	const patternCounts = new Map<string, number>();
	for (const s of serialized) {
		patternCounts.set(s, (patternCounts.get(s) ?? 0) + 1);
	}

	let dominantCount = 0;
	for (const count of patternCounts.values()) {
		if (count > dominantCount) {
			dominantCount = count;
		}
	}

	const ratio = dominantCount / modeNameSets.length;
	const score = clamp(ratio * 100);

	return {
		id: "consistency-mode-naming",
		label: "Mode naming consistency",
		score,
		severity: getSeverity(score),
		details:
			ratio < 1
				? `${Math.round(ratio * 100)}% of collections share the same mode names. Align mode names across collections.`
				: "All collections use consistent mode names.",
	};
}

/**
 * Consistency category scorer.
 * Returns the average score across all consistency checks.
 */
export function scoreConsistency(data: DesignSystemRawData): CategoryScore {
	const findings: Finding[] = [
		scoreDelimiterConsistency(data),
		scoreCasingConsistency(data),
		scoreSizeValueConsistency(data),
		scoreModeNamingConsistency(data),
	];

	const score = clamp(
		findings.reduce((sum, f) => sum + f.score, 0) / findings.length,
	);

	return {
		id: "consistency",
		label: "Consistency",
		shortLabel: "Cons",
		score,
		weight: 0.15,
		findings,
	};
}
