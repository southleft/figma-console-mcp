/**
 * Design System Health Dashboard — Scoring Engine
 *
 * Main orchestrator that runs all 6 category scorers against raw Figma data
 * and produces a Lighthouse-style health score.
 *
 * Data flow:
 *   DesignSystemRawData → scoreDesignSystem() → DashboardData (JSON)
 */

import { scoreAccessibility } from "./accessibility.js";
import {
	classifyComponents,
	scoreComponentMetadata,
} from "./component-metadata.js";
import { scoreConsistency } from "./consistency.js";
import { scoreCoverage } from "./coverage.js";
import { scoreNamingSemantics } from "./naming-semantics.js";
import { scoreTokenArchitecture } from "./token-architecture.js";
import type {
	CategoryScore,
	DashboardData,
	DesignSystemRawData,
	Finding,
} from "./types.js";
import { getStatus } from "./types.js";

/**
 * Collect actionable findings from scored categories.
 * Returns up to 5 human-readable strings from the worst findings,
 * prioritizing "fail" severity, then "warning", sorted by score ascending.
 */
function generateSummary(categories: CategoryScore[]): string[] {
	const actionableFindings: Array<Finding & { categoryLabel: string }> = [];

	for (const category of categories) {
		for (const finding of category.findings) {
			if (finding.severity === "fail" || finding.severity === "warning") {
				actionableFindings.push({
					...finding,
					categoryLabel: category.label,
				});
			}
		}
	}

	// Sort: fail before warning, then by score ascending (worst first)
	actionableFindings.sort((a, b) => {
		const severityOrder = { fail: 0, warning: 1, pass: 2, info: 3 };
		const aSev = severityOrder[a.severity];
		const bSev = severityOrder[b.severity];
		if (aSev !== bSev) return aSev - bSev;
		return a.score - b.score;
	});

	return actionableFindings
		.slice(0, 5)
		.map(
			(f) =>
				`[${f.categoryLabel}] ${f.label}: ${f.details ?? "Needs improvement."}`,
		);
}

/**
 * Score a design system's health from raw Figma data.
 *
 * Runs all 6 category scorers and produces a weighted overall score.
 * Category weights sum to 1.0:
 *   - Naming & Semantics:   0.20
 *   - Token Architecture:   0.20
 *   - Component Metadata:   0.20
 *   - Accessibility:        0.15
 *   - Consistency:          0.15
 *   - Coverage:             0.10
 *
 * @param data - Raw Figma data (variables, collections, components, styles)
 * @returns Complete dashboard payload with overall score, categories, and summary
 */
export function scoreDesignSystem(data: DesignSystemRawData): DashboardData {
	const categories: CategoryScore[] = [
		scoreNamingSemantics(data),
		scoreTokenArchitecture(data),
		scoreComponentMetadata(data),
		scoreAccessibility(data),
		scoreConsistency(data),
		scoreCoverage(data),
	];

	const overall = Math.round(
		categories.reduce((sum, c) => sum + c.score * c.weight, 0),
	);

	const summary = generateSummary(categories);

	const classification = classifyComponents(data);

	return {
		overall,
		status: getStatus(overall),
		categories,
		summary,
		meta: {
			componentCount: data.components.length,
			variableCount: data.variables.length,
			collectionCount: data.collections.length,
			styleCount: data.styles.length,
			componentSetCount: data.componentSets.length,
			standaloneCount: classification.standalone.length,
			variantCount: classification.variants.length,
			timestamp: Date.now(),
		},
		fileInfo: data.fileInfo,
		dataAvailability: data.dataAvailability,
	};
}
