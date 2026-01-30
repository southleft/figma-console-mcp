/**
 * Token Architecture Scorer (weight: 0.20)
 *
 * Evaluates the depth and organization of the token system.
 * Checks collection organization, mode coverage, alias usage,
 * token tier depth, type distribution, and description coverage.
 */

import type { CategoryScore, DesignSystemRawData, Finding } from "./types.js";
import { buildCollectionNameMap, clamp, getSeverity } from "./types.js";

/** Maximum examples to include in a finding. */
const MAX_EXAMPLES = 5;

/**
 * Check if a value entry is a variable alias reference.
 */
function isAlias(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<string, unknown>).type === "VARIABLE_ALIAS"
	);
}

/** Check if variable data was unavailable (vs. genuinely empty). */
function variableDataUnavailable(data: DesignSystemRawData): boolean {
	return (
		data.dataAvailability !== undefined && !data.dataAvailability.variables
	);
}

/** Message explaining why variable data is missing. */
function variableUnavailableMessage(data: DesignSystemRawData): string {
	const reason =
		data.dataAvailability?.variableError ||
		"Figma Enterprise plan or Desktop Bridge plugin required";
	return `Variable data unavailable: ${reason}. Score reflects missing data, not actual design system quality.`;
}

/**
 * Score collection organization.
 * Variables should be organized into collections.
 */
function scoreCollectionOrganization(data: DesignSystemRawData): Finding {
	const count = data.collections.length;

	if (count === 0 && variableDataUnavailable(data)) {
		return {
			id: "token-collection-org",
			label: "Collection organization",
			score: 0,
			severity: "info",
			tooltip:
				"Variables should be grouped into collections by concern (colors, spacing, typography). More collections = better organization.",
			details: variableUnavailableMessage(data),
		};
	}

	let score: number;
	if (count >= 3) {
		score = 100;
	} else if (count === 2) {
		score = 80;
	} else if (count === 1) {
		score = 50;
	} else {
		score = 0;
	}

	return {
		id: "token-collection-org",
		label: "Collection organization",
		score: clamp(score),
		severity: getSeverity(score),
		tooltip:
			"Variables should be grouped into collections by concern (colors, spacing, typography). More collections = better organization.",
		details:
			count === 0
				? "No variable collections found. Organize variables into collections."
				: `${count} collection${count === 1 ? "" : "s"} found.`,
	};
}

/**
 * Score mode coverage.
 * Collections should have multiple modes (e.g., light/dark).
 */
function scoreModeCoverage(data: DesignSystemRawData): Finding {
	if (data.collections.length === 0) {
		return {
			id: "token-mode-coverage",
			label: "Mode coverage",
			score: 0,
			severity: variableDataUnavailable(data) ? "info" : "fail",
			tooltip:
				"Collections should support multiple modes (e.g. Light/Dark). This enables theming without duplicating tokens.",
			details: variableDataUnavailable(data)
				? variableUnavailableMessage(data)
				: "No collections found to evaluate mode coverage.",
		};
	}

	const maxModes = Math.max(
		...data.collections.map((c) => c.modes?.length ?? 0),
	);

	let score: number;
	if (maxModes >= 2) {
		score = 100;
	} else if (maxModes === 1) {
		score = 50;
	} else {
		score = 0;
	}

	return {
		id: "token-mode-coverage",
		label: "Mode coverage",
		score: clamp(score),
		severity: getSeverity(score),
		tooltip:
			"Collections should support multiple modes (e.g. Light/Dark). This enables theming without duplicating tokens.",
		details:
			maxModes >= 2
				? `Collections support up to ${maxModes} modes (e.g., light/dark).`
				: maxModes === 1
					? "Collections have only 1 mode. Consider adding light/dark modes."
					: "No modes detected in collections.",
	};
}

/**
 * Score alias usage.
 * Higher alias percentage indicates better token layering.
 */
function scoreAliasUsage(data: DesignSystemRawData): Finding {
	if (data.variables.length === 0) {
		return {
			id: "token-alias-usage",
			label: "Alias usage",
			score: 0,
			severity: variableDataUnavailable(data) ? "info" : "fail",
			tooltip:
				"Semantic tokens should reference primitive tokens via aliases rather than hard-coding values. Aliases enable single-source-of-truth updates.",
			details: variableDataUnavailable(data)
				? variableUnavailableMessage(data)
				: "No variables to evaluate alias usage.",
		};
	}

	const collectionNames = buildCollectionNameMap(data.collections);

	let aliasCount = 0;
	let totalValues = 0;
	const rawValueVars: any[] = [];

	for (const variable of data.variables) {
		if (!variable.valuesByMode) continue;
		let hasAnyAlias = false;
		for (const modeValues of Object.values(variable.valuesByMode)) {
			totalValues++;
			if (isAlias(modeValues)) {
				aliasCount++;
				hasAnyAlias = true;
			}
		}
		if (!hasAnyAlias) {
			rawValueVars.push(variable);
		}
	}

	if (totalValues === 0) {
		return {
			id: "token-alias-usage",
			label: "Alias usage",
			score: 0,
			severity: "fail",
			tooltip:
				"Semantic tokens should reference primitive tokens via aliases rather than hard-coding values. Aliases enable single-source-of-truth updates.",
			details: "No variable values found to evaluate.",
		};
	}

	const ratio = aliasCount / totalValues;
	const score = clamp(ratio * 100);

	return {
		id: "token-alias-usage",
		label: "Alias usage",
		score,
		severity: getSeverity(score),
		tooltip:
			"Semantic tokens should reference primitive tokens via aliases rather than hard-coding values. Aliases enable single-source-of-truth updates.",
		details: `${aliasCount} of ${totalValues} values are aliases (${Math.round(ratio * 100)}%). Higher alias usage indicates better token layering.`,
		examples:
			rawValueVars.length > 0 ? rawValueVars.slice(0, MAX_EXAMPLES).map((v: any) => v.name) : undefined,
		locations:
			rawValueVars.length > 0
				? rawValueVars.slice(0, MAX_EXAMPLES).map((v: any) => ({
						name: v.name,
						collection: collectionNames.get(v.variableCollectionId),
						type: "variable",
					}))
				: undefined,
	};
}

/**
 * Build a map of variable ID to variable for alias chain tracing.
 */
function buildVariableMap(variables: any[]): Map<string, any> {
	const map = new Map<string, any>();
	for (const v of variables) {
		if (v.id) {
			map.set(v.id, v);
		}
	}
	return map;
}

/**
 * Trace the depth of an alias chain starting from a given variable.
 * Returns the number of tiers (1 = raw value, 2 = one alias hop, etc.).
 */
function traceAliasDepth(
	variable: any,
	variableMap: Map<string, any>,
	visited: Set<string>,
): number {
	if (!variable.valuesByMode) return 1;

	const values = Object.values(variable.valuesByMode);
	let maxDepth = 1;

	for (const value of values) {
		if (isAlias(value)) {
			const targetId = (value as { type: string; id: string }).id;
			if (visited.has(targetId)) continue; // Prevent circular references

			const target = variableMap.get(targetId);
			if (target) {
				visited.add(targetId);
				const depth = 1 + traceAliasDepth(target, variableMap, visited);
				maxDepth = Math.max(maxDepth, depth);
			}
		}
	}

	return maxDepth;
}

/**
 * Score token tier depth.
 * Deeper alias chains indicate more sophisticated token architecture.
 */
function scoreTokenTierDepth(data: DesignSystemRawData): Finding {
	if (data.variables.length === 0) {
		return {
			id: "token-tier-depth",
			label: "Token tier depth",
			score: 0,
			severity: variableDataUnavailable(data) ? "info" : "fail",
			tooltip:
				"A layered token system (primitive -> semantic -> component) enables scalable theming. 3+ tiers indicates mature architecture.",
			details: variableDataUnavailable(data)
				? variableUnavailableMessage(data)
				: "No variables to evaluate tier depth.",
		};
	}

	const variableMap = buildVariableMap(data.variables);
	let maxDepth = 1;

	for (const variable of data.variables) {
		const visited = new Set<string>();
		if (variable.id) visited.add(variable.id);
		const depth = traceAliasDepth(variable, variableMap, visited);
		maxDepth = Math.max(maxDepth, depth);
	}

	let score: number;
	if (maxDepth >= 3) {
		score = 100;
	} else if (maxDepth === 2) {
		score = 67;
	} else {
		score = 33;
	}

	return {
		id: "token-tier-depth",
		label: "Token tier depth",
		score: clamp(score),
		severity: getSeverity(score),
		tooltip:
			"A layered token system (primitive -> semantic -> component) enables scalable theming. 3+ tiers indicates mature architecture.",
		details: `Maximum alias chain depth: ${maxDepth} tier${maxDepth === 1 ? "" : "s"}. 3+ tiers indicates a well-layered token architecture.`,
	};
}

/**
 * Score type distribution across variables.
 * A healthy system includes COLOR, FLOAT, and STRING variables.
 */
function scoreTypeDistribution(data: DesignSystemRawData): Finding {
	if (data.variables.length === 0) {
		return {
			id: "token-type-distribution",
			label: "Type distribution",
			score: 0,
			severity: variableDataUnavailable(data) ? "info" : "fail",
			tooltip:
				"A complete token system includes COLOR, FLOAT, and STRING variables. Missing types indicate gaps in the design language.",
			details: variableDataUnavailable(data)
				? variableUnavailableMessage(data)
				: "No variables to evaluate type distribution.",
		};
	}

	const expectedTypes = ["COLOR", "FLOAT", "STRING"];
	const presentTypes = new Set(data.variables.map((v) => v.resolvedType));
	const matchCount = expectedTypes.filter((t) => presentTypes.has(t)).length;

	const score = clamp((matchCount / expectedTypes.length) * 100);

	return {
		id: "token-type-distribution",
		label: "Type distribution",
		score,
		severity: getSeverity(score),
		tooltip:
			"A complete token system includes COLOR, FLOAT, and STRING variables. Missing types indicate gaps in the design language.",
		details: `${matchCount} of ${expectedTypes.length} expected types (COLOR, FLOAT, STRING) present. Found: ${[...presentTypes].join(", ") || "none"}.`,
	};
}

/**
 * Score description coverage for variables.
 * Well-documented variables should have non-empty descriptions.
 */
function scoreDescriptionCoverage(data: DesignSystemRawData): Finding {
	if (data.variables.length === 0) {
		return {
			id: "token-description-coverage",
			label: "Description coverage",
			score: 0,
			severity: variableDataUnavailable(data) ? "info" : "fail",
			tooltip:
				"Variables should have descriptions explaining their purpose and usage context. Descriptions help consumers choose the right token.",
			details: variableDataUnavailable(data)
				? variableUnavailableMessage(data)
				: "No variables to evaluate description coverage.",
		};
	}

	const collectionNames = buildCollectionNameMap(data.collections);

	const withDesc = data.variables.filter(
		(v) => v.description && v.description.trim().length > 0,
	);
	const withoutDesc = data.variables.filter(
		(v) => !v.description || v.description.trim().length === 0,
	);

	const ratio = withDesc.length / data.variables.length;
	const score = clamp(ratio * 100);

	return {
		id: "token-description-coverage",
		label: "Description coverage",
		score,
		severity: getSeverity(score),
		tooltip:
			"Variables should have descriptions explaining their purpose and usage context. Descriptions help consumers choose the right token.",
		details: `${withDesc.length} of ${data.variables.length} variables have descriptions (${Math.round(ratio * 100)}%).`,
		examples:
			withoutDesc.length > 0
				? withoutDesc.slice(0, MAX_EXAMPLES).map((v) => v.name)
				: undefined,
		locations:
			withoutDesc.length > 0
				? withoutDesc.slice(0, MAX_EXAMPLES).map((v) => ({
						name: v.name,
						collection: collectionNames.get(v.variableCollectionId),
						type: "variable",
					}))
				: undefined,
	};
}

/**
 * Token Architecture category scorer.
 * Returns the average score across all token architecture checks.
 */
export function scoreTokenArchitecture(
	data: DesignSystemRawData,
): CategoryScore {
	const findings: Finding[] = [
		scoreCollectionOrganization(data),
		scoreModeCoverage(data),
		scoreAliasUsage(data),
		scoreTokenTierDepth(data),
		scoreTypeDistribution(data),
		scoreDescriptionCoverage(data),
	];

	const score = clamp(
		findings.reduce((sum, f) => sum + f.score, 0) / findings.length,
	);

	return {
		id: "token-architecture",
		label: "Token Architecture",
		shortLabel: "Tokens",
		score,
		weight: 0.2,
		findings,
	};
}
