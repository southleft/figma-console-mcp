/**
 * Coverage Scorer (weight: 0.10)
 *
 * Checks completeness of the design system.
 * Evaluates token type coverage, core component presence,
 * variable count health, and collection completeness.
 */

import type { CategoryScore, DesignSystemRawData, Finding } from "./types.js";
import { clamp, getSeverity } from "./types.js";

/** All variable types that a complete token system should include. */
const ALL_VARIABLE_TYPES = ["COLOR", "FLOAT", "STRING", "BOOLEAN"] as const;

/** Core component categories that a mature design system should have. */
const CORE_COMPONENT_PATTERNS = [
	{ name: "button", pattern: /button/i },
	{ name: "input", pattern: /input|text\s*field/i },
	{ name: "card", pattern: /card/i },
	{ name: "modal/dialog", pattern: /modal|dialog/i },
	{ name: "navigation", pattern: /nav|navigation|menu|sidebar/i },
	{ name: "alert/toast", pattern: /alert|toast|notification|snackbar/i },
] as const;

/**
 * Score token type coverage.
 * A complete system should include COLOR, FLOAT, STRING, and BOOLEAN variables.
 */
function variableDataUnavailable(data: DesignSystemRawData): boolean {
	return (
		data.dataAvailability !== undefined && !data.dataAvailability.variables
	);
}

function variableUnavailableMessage(data: DesignSystemRawData): string {
	const reason =
		data.dataAvailability?.variableError ||
		"Figma Enterprise plan or Desktop Bridge plugin required";
	return `Variable data unavailable: ${reason}`;
}

function scoreTokenTypeCoverage(data: DesignSystemRawData): Finding {
	if (data.variables.length === 0) {
		return {
			id: "coverage-token-types",
			label: "Token type coverage",
			score: 0,
			severity: variableDataUnavailable(data) ? "info" : "fail",
			details: variableDataUnavailable(data)
				? variableUnavailableMessage(data)
				: "No variables found in the design system.",
		};
	}

	const presentTypes = new Set(data.variables.map((v) => v.resolvedType));
	const foundTypes = ALL_VARIABLE_TYPES.filter((t) => presentTypes.has(t));

	let score: number;
	switch (foundTypes.length) {
		case 4:
			score = 100;
			break;
		case 3:
			score = 75;
			break;
		case 2:
			score = 50;
			break;
		case 1:
			score = 25;
			break;
		default:
			score = 0;
	}

	const missingTypes = ALL_VARIABLE_TYPES.filter((t) => !presentTypes.has(t));

	return {
		id: "coverage-token-types",
		label: "Token type coverage",
		score: clamp(score),
		severity: getSeverity(score),
		details:
			missingTypes.length > 0
				? `${foundTypes.length} of ${ALL_VARIABLE_TYPES.length} variable types present. Missing: ${missingTypes.join(", ")}.`
				: "All variable types (COLOR, FLOAT, STRING, BOOLEAN) are present.",
	};
}

/**
 * Score core component presence.
 * A mature design system should include button, input, card, modal, nav, and alert components.
 */
function scoreCoreComponentPresence(data: DesignSystemRawData): Finding {
	if (data.components.length === 0) {
		return {
			id: "coverage-core-components",
			label: "Core component presence",
			score: 0,
			severity: "fail",
			details: "No components found in the design system.",
		};
	}

	const foundCategories: string[] = [];
	const missingCategories: string[] = [];
	const matchExamples: string[] = [];

	for (const category of CORE_COMPONENT_PATTERNS) {
		const matching = data.components.filter((c) =>
			category.pattern.test(c.name),
		);
		if (matching.length > 0) {
			foundCategories.push(category.name);
			matchExamples.push(
				`${category.name}: ${matching
					.slice(0, 2)
					.map((c) => c.name)
					.join(", ")}`,
			);
		} else {
			missingCategories.push(category.name);
		}
	}

	const ratio = foundCategories.length / CORE_COMPONENT_PATTERNS.length;
	const score = clamp(ratio * 100);

	return {
		id: "coverage-core-components",
		label: "Core component presence",
		score,
		severity: getSeverity(score),
		details:
			missingCategories.length > 0
				? `${foundCategories.length} of ${CORE_COMPONENT_PATTERNS.length} core component categories found. Missing: ${missingCategories.join(", ")}.`
				: "All core component categories are represented.",
		examples: matchExamples.length > 0 ? matchExamples : undefined,
	};
}

/**
 * Score variable count health.
 * A healthy design system should have a meaningful number of tokens.
 */
function scoreVariableCountHealth(data: DesignSystemRawData): Finding {
	const count = data.variables.length;

	let score: number;
	let details: string;

	if (count === 0 && variableDataUnavailable(data)) {
		return {
			id: "coverage-variable-count",
			label: "Variable count health",
			score: 0,
			severity: "info",
			details: variableUnavailableMessage(data),
		};
	}

	if (count === 0) {
		score = 0;
		details =
			"No variables found. A design system needs tokens for colors, spacing, and typography.";
	} else if (count <= 10) {
		score = 50;
		details = `${count} variables found. Consider expanding the token set for better coverage.`;
	} else if (count <= 50) {
		score = 75;
		details = `${count} variables found. Good foundation; consider adding more semantic layers.`;
	} else {
		score = 100;
		details = `${count} variables found. Healthy token coverage.`;
	}

	return {
		id: "coverage-variable-count",
		label: "Variable count health",
		score: clamp(score),
		severity: getSeverity(score),
		details,
	};
}

/**
 * Score collection completeness.
 * Collections should cover different design concerns (color, spacing, typography, etc.).
 */
function scoreCollectionCompleteness(data: DesignSystemRawData): Finding {
	const count = data.collections.length;

	let score: number;
	let details: string;

	if (count === 0 && variableDataUnavailable(data)) {
		return {
			id: "coverage-collection-completeness",
			label: "Collection completeness",
			score: 0,
			severity: "info",
			details: variableUnavailableMessage(data),
		};
	}

	if (count === 0) {
		score = 0;
		details =
			"No variable collections found. Organize tokens into logical collections.";
	} else if (count === 1) {
		score = 50;
		details =
			"1 collection found. Consider splitting tokens into multiple collections by concern (color, spacing, typography).";
	} else if (count === 2) {
		score = 75;
		details = `${count} collections found. Good separation of concerns.`;
	} else {
		score = 100;
		details = `${count} collections found. Well-organized token architecture.`;
	}

	return {
		id: "coverage-collection-completeness",
		label: "Collection completeness",
		score: clamp(score),
		severity: getSeverity(score),
		details,
	};
}

/**
 * Coverage category scorer.
 * Returns the average score across all coverage checks.
 */
export function scoreCoverage(data: DesignSystemRawData): CategoryScore {
	const findings: Finding[] = [
		scoreTokenTypeCoverage(data),
		scoreCoreComponentPresence(data),
		scoreVariableCountHealth(data),
		scoreCollectionCompleteness(data),
	];

	const score = clamp(
		findings.reduce((sum, f) => sum + f.score, 0) / findings.length,
	);

	return {
		id: "coverage",
		label: "Coverage",
		shortLabel: "Cover",
		score,
		weight: 0.1,
		findings,
	};
}
