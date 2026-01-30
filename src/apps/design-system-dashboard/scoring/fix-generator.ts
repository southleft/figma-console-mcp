/**
 * Design System Dashboard — Fix Generator
 *
 * Generates FixDefinitions for fixable findings.
 * Each generator inspects the raw data and produces a list of
 * concrete operations that the Desktop Bridge can execute.
 */

import { classifyComponents } from "./component-metadata.js";
import type { FixDefinition, FixOperation } from "./fix-types.js";
import type { DesignSystemRawData } from "./types.js";

/**
 * Generate fixes for components missing descriptions.
 * Creates a `set-description` operation for each component set or
 * standalone component that has no description.
 */
function generateComponentDescriptionFixes(
	data: DesignSystemRawData,
): FixDefinition | null {
	const classification = classifyComponents(data);
	const operations: FixOperation[] = [];

	for (const unit of classification.scorableUnits) {
		if (!unit.description || unit.description.trim().length === 0) {
			const nodeId = unit.node_id || unit.id;
			if (!nodeId) continue;

			// Build a contextual description from the component name
			const name = unit.name || "Component";
			const pathParts = name.split("/");
			const leafName = pathParts[pathParts.length - 1];
			const context =
				pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : "";
			const description = context
				? `${leafName} component in ${context}`
				: `${leafName} component`;

			operations.push({
				action: "set-description",
				targetId: nodeId,
				targetName: name,
				params: { description },
			});
		}
	}

	if (operations.length === 0) return null;

	return {
		findingId: "component-desc-presence",
		description: `Add descriptions to ${operations.length} component${operations.length === 1 ? "" : "s"}`,
		operations,
		requiresDesktopBridge: true,
	};
}

/**
 * Generate fixes for variables missing descriptions.
 * Creates a description based on the variable name, type, and collection.
 */
function generateVariableDescriptionFixes(
	data: DesignSystemRawData,
): FixDefinition | null {
	// Build a collection name lookup
	const collectionNames = new Map<string, string>();
	for (const col of data.collections) {
		if (col.id && col.name) {
			collectionNames.set(col.id, col.name);
		}
	}

	const operations: FixOperation[] = [];

	for (const variable of data.variables) {
		if (variable.description && variable.description.trim().length > 0)
			continue;
		if (!variable.id) continue;

		const name = variable.name || "Variable";
		const type = (variable.resolvedType || "unknown").toLowerCase();
		const collectionName = variable.variableCollectionId
			? collectionNames.get(variable.variableCollectionId) || ""
			: "";
		const description = collectionName
			? `${name} — ${type} token in ${collectionName}`
			: `${name} — ${type} token`;

		operations.push({
			action: "set-variable-description",
			targetId: variable.id,
			targetName: name,
			params: { description },
		});
	}

	if (operations.length === 0) return null;

	return {
		findingId: "token-description-coverage",
		description: `Add descriptions to ${operations.length} variable${operations.length === 1 ? "" : "s"}`,
		operations,
		requiresDesktopBridge: true,
	};
}

// ---------------------------------------------------------------------------
// Naming & consistency fix generators
// ---------------------------------------------------------------------------

const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;
const BOOLEAN_PREFIX_RE =
	/^(is|has|can|should|will|did|was|with|show|hide|enable|disable)/i;
const DELIMITERS = ["/", ".", "-", "_"] as const;

/** Convert a single name segment to PascalCase. */
function toPascalCase(segment: string): string {
	const words = segment
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.split(/[-_\s]+/)
		.filter((w) => w.length > 0);
	return words
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
		.join("");
}

/**
 * Generate fixes for components whose name segments are not PascalCase.
 * Converts each non-PascalCase segment (e.g. "button-primary" → "ButtonPrimary").
 */
function generateComponentCasingFixes(
	data: DesignSystemRawData,
): FixDefinition | null {
	const classification = classifyComponents(data);
	const operations: FixOperation[] = [];

	for (const unit of classification.scorableUnits) {
		const name = unit.name;
		if (!name) continue;
		const nodeId = unit.node_id || unit.id;
		if (!nodeId) continue;

		const segments = name.split("/").map((s: string) => s.trim());
		const allPascal = segments.every((seg: string) => PASCAL_CASE_RE.test(seg));
		if (allPascal) continue;

		const fixedSegments = segments.map((seg: string) =>
			PASCAL_CASE_RE.test(seg) ? seg : toPascalCase(seg),
		);
		const newName = fixedSegments.join("/");
		if (newName === name) continue;

		operations.push({
			action: "rename-node",
			targetId: nodeId,
			targetName: name,
			params: { newName },
		});
	}

	if (operations.length === 0) return null;

	return {
		findingId: "naming-component-casing",
		description: `Rename ${operations.length} component${operations.length === 1 ? "" : "s"} to PascalCase`,
		operations,
		requiresDesktopBridge: true,
	};
}

/**
 * Generate fixes for BOOLEAN variables missing a semantic prefix.
 * Prepends "is" to the leaf name (e.g. "visible" → "isVisible").
 */
function generateBooleanPrefixFixes(
	data: DesignSystemRawData,
): FixDefinition | null {
	const operations: FixOperation[] = [];

	for (const variable of data.variables) {
		if (!variable.id || !variable.name) continue;
		if (variable.resolvedType !== "BOOLEAN") continue;

		const name = variable.name;
		const parts = name.split(/[/.]/);
		const leaf = parts[parts.length - 1];
		if (BOOLEAN_PREFIX_RE.test(leaf)) continue;

		const newLeaf = `is${leaf.charAt(0).toUpperCase()}${leaf.slice(1)}`;

		// Rebuild the full path preserving original delimiters
		const lastDelimIdx = Math.max(name.lastIndexOf("/"), name.lastIndexOf("."));
		const newName =
			lastDelimIdx >= 0
				? name.substring(0, lastDelimIdx + 1) + newLeaf
				: newLeaf;

		operations.push({
			action: "rename-variable",
			targetId: variable.id,
			targetName: name,
			params: { newName },
		});
	}

	if (operations.length === 0) return null;

	return {
		findingId: "naming-boolean-prefix",
		description: `Add "is" prefix to ${operations.length} boolean variable${operations.length === 1 ? "" : "s"}`,
		operations,
		requiresDesktopBridge: true,
	};
}

/**
 * Generate fixes for variables using non-dominant delimiters.
 * Replaces all delimiters with the most-used delimiter across the system.
 */
function generateDelimiterConsistencyFixes(
	data: DesignSystemRawData,
): FixDefinition | null {
	const names = data.variables
		.map((v) => v.name)
		.filter((n): n is string => Boolean(n));
	if (names.length === 0) return null;

	// Count delimiter usage (mirrors consistency scorer logic)
	const counts = new Map<string, number>();
	for (const d of DELIMITERS) counts.set(d, 0);
	for (const name of names) {
		for (const d of DELIMITERS) {
			if (name.includes(d)) {
				counts.set(d, (counts.get(d) ?? 0) + 1);
			}
		}
	}

	let dominant = "/";
	let dominantCount = 0;
	for (const [d, c] of counts.entries()) {
		if (c > dominantCount) {
			dominantCount = c;
			dominant = d;
		}
	}

	if (dominantCount === 0) return null;

	const operations: FixOperation[] = [];

	for (const variable of data.variables) {
		if (!variable.id || !variable.name) continue;
		const name = variable.name;

		const usesAnyDelimiter = DELIMITERS.some((d) => name.includes(d));
		if (!usesAnyDelimiter) continue;
		if (name.includes(dominant)) continue;

		let newName = name;
		for (const d of DELIMITERS) {
			if (d !== dominant && newName.includes(d)) {
				newName = newName.split(d).join(dominant);
			}
		}

		if (newName === name) continue;

		operations.push({
			action: "rename-variable",
			targetId: variable.id,
			targetName: name,
			params: { newName },
		});
	}

	if (operations.length === 0) return null;

	return {
		findingId: "consistency-delimiter",
		description: `Normalize delimiters to "${dominant}" in ${operations.length} variable${operations.length === 1 ? "" : "s"}`,
		operations,
		requiresDesktopBridge: true,
	};
}

// ---------------------------------------------------------------------------
// Generator registry
// ---------------------------------------------------------------------------

/**
 * Generate all fix definitions from raw data.
 * Returns a map of findingId → FixDefinition for annotation onto findings.
 */
export function generateAllFixes(
	data: DesignSystemRawData,
): Map<string, FixDefinition> {
	const fixes = new Map<string, FixDefinition>();

	const generators = [
		generateComponentDescriptionFixes,
		generateVariableDescriptionFixes,
		generateComponentCasingFixes,
		generateBooleanPrefixFixes,
		generateDelimiterConsistencyFixes,
	];

	for (const generator of generators) {
		const fix = generator(data);
		if (fix) {
			fixes.set(fix.findingId, fix);
		}
	}

	return fixes;
}
