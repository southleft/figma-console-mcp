/**
 * Component Metadata Scorer (weight: 0.20)
 *
 * Checks component quality and completeness within the design system.
 * Evaluates description presence, description quality, property completeness,
 * variant structure, and category organization.
 *
 * Scores against "scorable units" (component sets + standalone components)
 * rather than raw variant count to avoid inflated totals.
 */

import type { CategoryScore, DesignSystemRawData, Finding } from "./types.js";
import { clamp, getSeverity } from "./types.js";

/** Maximum examples to include in a finding. */
const MAX_EXAMPLES = 5;

/** Minimum description length to be considered "quality" documentation. */
const MIN_QUALITY_DESC_LENGTH = 20;

// ---------------------------------------------------------------------------
// Component classification
// ---------------------------------------------------------------------------

export interface ComponentClassification {
	standalone: any[]; // Components NOT in any variant set
	variants: any[]; // Individual variants (inside component sets)
	componentSets: any[]; // The variant groups themselves
	scorableUnits: any[]; // standalone + componentSets = meaningful count
}

interface ComponentSetLookup {
	nodeIds: Set<string>;
	namePrefixes: Set<string>; // "SetName/" for prefix matching (fallback)
}

/**
 * Build a lookup structure for matching components to variant groups.
 * Collects component set node IDs for `containing_frame.containingComponentSet`
 * matching (primary REST API path) and name prefixes as fallback.
 */
function buildComponentSetLookup(data: DesignSystemRawData): ComponentSetLookup {
	const nodeIds = new Set<string>();
	const namePrefixes = new Set<string>();
	for (const cs of data.componentSets) {
		if (cs.node_id) nodeIds.add(cs.node_id);
		if (cs.name) namePrefixes.add(cs.name + "/");
	}
	return { nodeIds, namePrefixes };
}

/**
 * Check if a component belongs to a variant set.
 *
 * Detection order:
 * 1. Plugin API: `componentSetId` (set on ComponentNode by Figma plugin runtime)
 * 2. REST API: `containing_frame.containingComponentSet` (present on variants
 *    returned by GET /v1/files/:key/components)
 * 3. File JSON: `component_set_id` (snake_case field on COMPONENT nodes in file tree)
 * 4. Name prefix: variant names starting with "SetName/" (some API formats)
 * 5. Frame node ID: containing_frame.nodeId matching a known component set node
 */
function isComponentInSet(component: any, lookup: ComponentSetLookup): boolean {
	// Plugin API: direct componentSetId
	if (component.componentSetId) return true;
	// REST API: containing_frame.containingComponentSet is set on variant components
	if (component.containing_frame?.containingComponentSet) return true;
	// File JSON: snake_case variant of componentSetId
	if (component.component_set_id) return true;
	// Name-based fallback: variant names may start with "SetName/"
	if (component.name) {
		for (const prefix of lookup.namePrefixes) {
			if (component.name.startsWith(prefix)) return true;
		}
	}
	// Frame node ID fallback
	const frameNodeId = component.containing_frame?.nodeId;
	if (frameNodeId && lookup.nodeIds.has(frameNodeId)) return true;
	return false;
}

/**
 * Classify components into standalone, variants, and component sets.
 * Scoring evaluates `scorableUnits` (standalone + componentSets)
 * instead of the raw component list which double-counts variants.
 */
export function classifyComponents(
	data: DesignSystemRawData,
): ComponentClassification {
	const lookup = buildComponentSetLookup(data);
	const standalone: any[] = [];
	const variants: any[] = [];

	for (const comp of data.components) {
		if (isComponentInSet(comp, lookup)) {
			variants.push(comp);
		} else {
			standalone.push(comp);
		}
	}

	return {
		standalone,
		variants,
		componentSets: data.componentSets,
		scorableUnits: [...standalone, ...data.componentSets],
	};
}

// ---------------------------------------------------------------------------
// Scoring functions (operate on scorable units)
// ---------------------------------------------------------------------------

/**
 * Score description presence across scorable units.
 * Component sets and standalone components should have non-empty descriptions.
 */
function scoreDescriptionPresence(
	classification: ComponentClassification,
): Finding {
	const { scorableUnits } = classification;

	if (scorableUnits.length === 0) {
		return {
			id: "component-desc-presence",
			label: "Description presence",
			score: 100,
			severity: "info",
			details: "No components to evaluate.",
		};
	}

	const withDesc = scorableUnits.filter(
		(c) => c.description && c.description.trim().length > 0,
	);
	const withoutDesc = scorableUnits.filter(
		(c) => !c.description || c.description.trim().length === 0,
	);

	const ratio = withDesc.length / scorableUnits.length;
	const score = clamp(ratio * 100);

	return {
		id: "component-desc-presence",
		label: "Description presence",
		score,
		severity: getSeverity(score),
		details: `${withDesc.length} of ${scorableUnits.length} components have descriptions (${Math.round(ratio * 100)}%).`,
		examples:
			withoutDesc.length > 0
				? withoutDesc.slice(0, MAX_EXAMPLES).map((c) => c.name)
				: undefined,
		locations:
			withoutDesc.length > 0
				? withoutDesc.slice(0, MAX_EXAMPLES).map((c) => ({
						name: c.name,
						nodeId: c.node_id,
						type: "component",
					}))
				: undefined,
	};
}

/**
 * Score description quality.
 * Descriptions should be meaningful (>20 chars), not just the component name.
 */
function scoreDescriptionQuality(
	classification: ComponentClassification,
): Finding {
	const { scorableUnits } = classification;
	const withDesc = scorableUnits.filter(
		(c) => c.description && c.description.trim().length > 0,
	);

	if (withDesc.length === 0) {
		return {
			id: "component-desc-quality",
			label: "Description quality",
			score: 0,
			severity: scorableUnits.length === 0 ? "info" : "fail",
			details:
				scorableUnits.length === 0
					? "No components to evaluate."
					: "No components have descriptions to evaluate quality.",
		};
	}

	const shortDescs = withDesc.filter(
		(c) => c.description.trim().length < MIN_QUALITY_DESC_LENGTH,
	);
	const qualityCount = withDesc.length - shortDescs.length;

	const ratio = qualityCount / withDesc.length;
	const score = clamp(ratio * 100);

	return {
		id: "component-desc-quality",
		label: "Description quality",
		score,
		severity: getSeverity(score),
		details:
			shortDescs.length > 0
				? `${shortDescs.length} of ${withDesc.length} descriptions are too short (<${MIN_QUALITY_DESC_LENGTH} chars). Provide usage guidance, not just names.`
				: `All ${withDesc.length} descriptions provide meaningful documentation.`,
		examples:
			shortDescs.length > 0
				? shortDescs.slice(0, MAX_EXAMPLES).map((c) => c.name)
				: undefined,
	};
}

/**
 * Score property completeness.
 * Standalone components should define properties for flexibility.
 * Component sets inherently have properties via their variants.
 */
function scorePropertyCompleteness(
	classification: ComponentClassification,
): Finding {
	const { standalone, componentSets, scorableUnits } = classification;

	if (scorableUnits.length === 0) {
		return {
			id: "component-property-completeness",
			label: "Property completeness",
			score: 100,
			severity: "info",
			details: "No components to evaluate.",
		};
	}

	// Component sets always count as having properties (they are variant groups)
	// For standalone, check if they have any property definitions
	const standaloneWithProps = standalone.filter(
		(c) =>
			c.componentPropertyDefinitions &&
			Object.keys(c.componentPropertyDefinitions).length > 0,
	);
	const standaloneWithoutProps = standalone.filter(
		(c) =>
			!c.componentPropertyDefinitions ||
			Object.keys(c.componentPropertyDefinitions).length === 0,
	);

	const withProperties = standaloneWithProps.length + componentSets.length;
	const ratio = withProperties / scorableUnits.length;
	const score = clamp(ratio * 100);

	return {
		id: "component-property-completeness",
		label: "Property completeness",
		score,
		severity: getSeverity(score),
		details: `${withProperties} of ${scorableUnits.length} components have defined properties or variants (${Math.round(ratio * 100)}%).`,
		examples:
			standaloneWithoutProps.length > 0
				? standaloneWithoutProps.slice(0, MAX_EXAMPLES).map((c) => c.name)
				: undefined,
		locations:
			standaloneWithoutProps.length > 0
				? standaloneWithoutProps.slice(0, MAX_EXAMPLES).map((c) => ({
						name: c.name,
						nodeId: c.node_id,
						type: "component",
					}))
				: undefined,
	};
}

/**
 * Score variant structure.
 * A higher ratio of component sets to total scorable units indicates
 * good use of variant organization.
 */
function scoreVariantStructure(
	classification: ComponentClassification,
): Finding {
	const { standalone, componentSets, scorableUnits } = classification;

	if (scorableUnits.length === 0) {
		return {
			id: "component-variant-structure",
			label: "Variant structure",
			score: 100,
			severity: "info",
			details: "No components to evaluate.",
		};
	}

	const setCount = componentSets.length;
	const ratio = setCount / scorableUnits.length;
	const score = clamp(ratio * 100);

	return {
		id: "component-variant-structure",
		label: "Variant structure",
		score,
		severity: getSeverity(score),
		details:
			setCount > 0
				? `${setCount} of ${scorableUnits.length} components use variant sets (${Math.round(ratio * 100)}%). ${standalone.length} standalone component${standalone.length === 1 ? "" : "s"}.`
				: "No components use variant structures. Consider organizing components into sets with variants.",
		examples:
			standalone.length > 0 && setCount > 0
				? standalone.slice(0, MAX_EXAMPLES).map((c) => `${c.name} (standalone)`)
				: undefined,
	};
}

/**
 * Score category organization.
 * Components should use path separators (/) for logical grouping.
 */
function scoreCategoryOrganization(
	classification: ComponentClassification,
): Finding {
	const { scorableUnits } = classification;

	if (scorableUnits.length === 0) {
		return {
			id: "component-category-org",
			label: "Category organization",
			score: 100,
			severity: "info",
			details: "No components to evaluate.",
		};
	}

	const withPath = scorableUnits.filter((c) => c.name?.includes("/"));
	const withoutPath = scorableUnits.filter((c) => !c.name?.includes("/"));
	const ratio = withPath.length / scorableUnits.length;
	const score = clamp(ratio * 100);

	return {
		id: "component-category-org",
		label: "Category organization",
		score,
		severity: getSeverity(score),
		details:
			withPath.length > 0
				? `${withPath.length} of ${scorableUnits.length} components use path-based grouping (${Math.round(ratio * 100)}%).`
				: 'No components use path separators for grouping. Use "/" in names for organization (e.g., "Forms/Input").',
		examples:
			withoutPath.length > 0
				? withoutPath.slice(0, MAX_EXAMPLES).map((c) => c.name)
				: undefined,
		locations:
			withoutPath.length > 0
				? withoutPath.slice(0, MAX_EXAMPLES).map((c) => ({
						name: c.name,
						nodeId: c.node_id,
						type: "component",
					}))
				: undefined,
	};
}

/**
 * Component Metadata category scorer.
 * Returns the average score across all component metadata checks.
 */
export function scoreComponentMetadata(
	data: DesignSystemRawData,
): CategoryScore {
	const classification = classifyComponents(data);

	const findings: Finding[] = [
		scoreDescriptionPresence(classification),
		scoreDescriptionQuality(classification),
		scorePropertyCompleteness(classification),
		scoreVariantStructure(classification),
		scoreCategoryOrganization(classification),
	];

	const score = clamp(
		findings.reduce((sum, f) => sum + f.score, 0) / findings.length,
	);

	return {
		id: "component-metadata",
		label: "Component Metadata",
		shortLabel: "Comp",
		score,
		weight: 0.2,
		findings,
	};
}
