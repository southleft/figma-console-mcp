/**
 * Consistency Scorer (weight: 0.15)
 *
 * Checks pattern uniformity across the design system.
 * Evaluates naming delimiter consistency, casing consistency,
 * size value consistency, and mode naming consistency.
 */

import { classifyComponents } from "./component-metadata.js";
import type { CategoryScore, DesignSystemRawData, Finding } from "./types.js";
import { buildCollectionNameMap, clamp, getSeverity } from "./types.js";

/** Maximum examples to include in a finding. */
const MAX_EXAMPLES = 5;

// Accepts PascalCase and Title Case with spaces (see naming-semantics.ts) —
// "Form Field" and "FormField" are the same convention for casing purposes.
const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*(?: [A-Z0-9&(][a-zA-Z0-9()]*)*$/;
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
			tooltip:
				"Variable names should use the same delimiter throughout (/ or . or -). Mixed delimiters make tokens harder to find and autocomplete.",
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
			tooltip:
				"Variable names should use the same delimiter throughout (/ or . or -). Mixed delimiters make tokens harder to find and autocomplete.",
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
		tooltip:
			"Variable names should use the same delimiter throughout (/ or . or -). Mixed delimiters make tokens harder to find and autocomplete.",
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
	// Check component name casing. Variant components use Figma's `prop=value`
	// naming and would drown the signal — measure the published surface
	// (standalone components + component sets) instead.
	const { scorableUnits } = classifyComponents(data);
	const componentSegments: string[] = [];
	for (const comp of scorableUnits) {
		const segments = comp.name.split("/").map((s: string) => s.trim());
		componentSegments.push(...segments);
	}

	// Check variable name segments. Pure-numeric segments (scale steps like
	// "100", "3.5", "12") carry no casing signal and are skipped.
	const NUMERIC_SEGMENT_RE = /^\d+([.·․․]?\d+)?$/;
	const variableLeaves: string[] = [];
	for (const v of data.variables) {
		const segments = v.name.split(/[/.]/);
		if (segments.length > 0) {
			variableLeaves.push(...segments);
		}
	}

	// Calibration: components and variables legitimately follow DIFFERENT
	// conventions (TitleCase components + lowercase/kebab token paths is the
	// dominant real-world pattern). Pooling them and demanding one dominant
	// casing structurally fails every such system, so consistency is measured
	// WITHIN each pool and combined as a segment-weighted average.
	const pools: Array<{ label: string; segments: string[] }> = [
		{
			label: "component",
			segments: componentSegments.filter(
				(s) => s.length > 1 && !NUMERIC_SEGMENT_RE.test(s),
			),
		},
		{
			label: "variable",
			segments: variableLeaves.filter(
				(s) => s.length > 1 && !NUMERIC_SEGMENT_RE.test(s),
			),
		},
	].filter((p) => p.segments.length > 0);

	if (pools.length === 0) {
		return {
			id: "consistency-casing",
			label: "Casing consistency",
			score: 100,
			severity: "info",
			tooltip:
				"Name segments should follow a consistent casing convention within components and within variables (the two may differ — e.g. TitleCase components with kebab-case token paths).",
			details: "No name segments to evaluate.",
		};
	}

	// A segment can be AMBIGUOUS between conventions: a single lowercase word
	// ("default", "brand") is simultaneously valid camelCase, kebab-case, and
	// snake_case — only multi-word segments reveal the convention. Score each
	// segment against the set of conventions it is compatible with, and pick
	// the convention that the most segments are compatible with.
	const compatibleCasings = (segment: string): string[] => {
		const out: string[] = [];
		if (PASCAL_CASE_RE.test(segment)) out.push("PascalCase");
		if (CAMEL_CASE_RE.test(segment)) out.push("camelCase");
		if (KEBAB_CASE_RE.test(segment)) out.push("kebab-case");
		if (SNAKE_CASE_RE.test(segment)) out.push("snake_case");
		if (out.length === 0) out.push(detectCasing(segment));
		return out;
	};

	let weightedConsistent = 0;
	let totalSegments = 0;
	const poolSummaries: string[] = [];
	const nonDominantSegments: string[] = [];
	for (const pool of pools) {
		const casingCounts = new Map<string, number>();
		const compat = pool.segments.map((s) => compatibleCasings(s));
		for (const casings of compat) {
			for (const casing of casings) {
				casingCounts.set(casing, (casingCounts.get(casing) ?? 0) + 1);
			}
		}
		let dominantCasing = "mixed";
		let dominantCount = 0;
		for (const [casing, count] of casingCounts.entries()) {
			if (count > dominantCount) {
				dominantCount = count;
				dominantCasing = casing;
			}
		}
		weightedConsistent += dominantCount;
		totalSegments += pool.segments.length;
		poolSummaries.push(
			`${pool.label} names ${Math.round((dominantCount / pool.segments.length) * 100)}% ${dominantCasing}`,
		);
		for (let i = 0; i < pool.segments.length; i++) {
			if (
				!compat[i].includes(dominantCasing) &&
				nonDominantSegments.length < MAX_EXAMPLES
			) {
				nonDominantSegments.push(`${pool.segments[i]} (${pool.label})`);
			}
		}
	}

	const ratio = weightedConsistent / totalSegments;
	const score = clamp(ratio * 100);

	return {
		id: "consistency-casing",
		label: "Casing consistency",
		score,
		severity: getSeverity(score),
		tooltip:
			"Name segments should follow a consistent casing convention within components and within variables (the two may differ — e.g. TitleCase components with kebab-case token paths).",
		details: `${Math.round(ratio * 100)}% of name segments follow their pool's dominant casing (${poolSummaries.join("; ")}).`,
		examples:
			nonDominantSegments.length > 0 ? nonDominantSegments : undefined,
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
			tooltip:
				"Numeric token values should follow a consistent scale (e.g. multiples of 4 or 8). Consistent scales create visual rhythm and predictable spacing.",
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
			tooltip:
				"Numeric token values should follow a consistent scale (e.g. multiples of 4 or 8). Consistent scales create visual rhythm and predictable spacing.",
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
		tooltip:
			"Numeric token values should follow a consistent scale (e.g. multiples of 4 or 8). Consistent scales create visual rhythm and predictable spacing.",
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
			tooltip:
				"All collections with multiple modes should use the same mode names (e.g. Light/Dark). Inconsistent mode names cause confusion.",
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
			tooltip:
				"All collections with multiple modes should use the same mode names (e.g. Light/Dark). Inconsistent mode names cause confusion.",
			details: "Only one collection has modes; consistency is not applicable.",
		};
	}

	// Calibration: collections legitimately serve DIFFERENT mode axes — a
	// theme collection's Light/Dark, a density collection's Compact/
	// Comfortable, a shape collection's Pill/Sharp. Demanding identical mode
	// SETS across them penalizes correct architecture. What actually causes
	// confusion is the same mode CONCEPT spelled differently across
	// collections ("light" vs "Light" vs "light-mode"), so measure spelling
	// consistency per mode concept instead.
	const spellingsByConcept = new Map<string, Set<string>>();
	for (const collection of collections) {
		for (const mode of collection.modes || []) {
			const concept = mode.name.toLowerCase().replace(/[\s_-]+/g, "");
			if (!spellingsByConcept.has(concept)) {
				spellingsByConcept.set(concept, new Set());
			}
			spellingsByConcept.get(concept)?.add(mode.name);
		}
	}

	const concepts = [...spellingsByConcept.entries()];
	const inconsistent = concepts.filter(([, spellings]) => spellings.size > 1);
	const ratio =
		concepts.length === 0
			? 1
			: (concepts.length - inconsistent.length) / concepts.length;
	const score = clamp(ratio * 100);

	return {
		id: "consistency-mode-naming",
		label: "Mode naming consistency",
		score,
		severity: getSeverity(score),
		tooltip:
			"The same mode concept should be spelled identically across collections (e.g. always \"Light\", never a mix of \"Light\" and \"light\"). Collections may have different mode sets — that's architecture, not inconsistency.",
		details:
			inconsistent.length > 0
				? `${inconsistent.length} mode name${inconsistent.length === 1 ? "" : "s"} spelled inconsistently across collections.`
				: "Mode names are spelled consistently across collections.",
		examples:
			inconsistent.length > 0
				? inconsistent
						.slice(0, MAX_EXAMPLES)
						.map(([, spellings]) => [...spellings].join(" vs "))
				: undefined,
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
		shortLabel: "Consistency",
		score,
		weight: 0.15,
		findings,
	};
}
