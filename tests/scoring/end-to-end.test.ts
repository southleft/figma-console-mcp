/**
 * End-to-End Scoring Pipeline Test
 *
 * Simulates realistic REST API data matching the structure returned by
 * GET /v1/files/:key/components, /component_sets, and local variables.
 * Validates the full pipeline produces correct, intuitive dashboard output.
 */

import { scoreDesignSystem } from "../../src/apps/design-system-dashboard/scoring/engine";
import type { DesignSystemRawData, DashboardData } from "../../src/apps/design-system-dashboard/scoring/types";

/**
 * Build realistic REST API data simulating a mid-sized design system.
 *
 * Mirrors what the Figma REST API returns:
 * - components: node_id, name, description, containing_frame
 * - componentSets: node_id, name, description
 * - variables: id, name, resolvedType, valuesByMode, variableCollectionId, description
 * - collections: id, name, modes
 */
function buildRealisticData(): DesignSystemRawData {
	// Component sets (variant groups)
	const componentSets = [
		{ node_id: "100:1", name: "Button", description: "Primary interactive element for user actions" },
		{ node_id: "100:2", name: "Input", description: "Text input field for forms" },
		{ node_id: "100:3", name: "Toggle", description: "Binary on/off control" },
		{ node_id: "100:4", name: "Badge", description: "" }, // Missing description
		{ node_id: "100:5", name: "Forms / Select", description: "Dropdown selection component with searchable options" },
	];

	// REST API format: variant names are "Property=Value" with
	// containing_frame.containingComponentSet identifying the parent
	const variantComponents = [
		// Button variants
		...["Primary", "Secondary", "Ghost", "Destructive"].flatMap((variant, i) =>
			["Default", "Hover", "Disabled"].map((state, j) => ({
				node_id: `200:${i * 10 + j}`,
				name: `Variant=${variant}, State=${state}`,
				description: "",
				containing_frame: {
					nodeId: "100:1",
					name: "Button",
					pageName: "Components",
					containingComponentSet: { nodeId: "100:1", name: "Button" },
				},
			})),
		),
		// Input variants
		...["Default", "Focused", "Error", "Disabled"].map((state, i) => ({
			node_id: `300:${i}`,
			name: `State=${state}`,
			description: "",
			containing_frame: {
				nodeId: "100:2",
				name: "Input",
				pageName: "Components",
				containingComponentSet: { nodeId: "100:2", name: "Input" },
			},
		})),
		// Toggle variants
		{ node_id: "400:0", name: "State=On", description: "", containing_frame: { nodeId: "100:3", name: "Toggle", containingComponentSet: { nodeId: "100:3", name: "Toggle" } } },
		{ node_id: "400:1", name: "State=Off", description: "", containing_frame: { nodeId: "100:3", name: "Toggle", containingComponentSet: { nodeId: "100:3", name: "Toggle" } } },
		// Badge variants
		{ node_id: "500:0", name: "Type=default", description: "", containing_frame: { nodeId: "100:4", name: "Badge", containingComponentSet: { nodeId: "100:4", name: "Badge" } } },
		{ node_id: "500:1", name: "Type=red", description: "", containing_frame: { nodeId: "100:4", name: "Badge", containingComponentSet: { nodeId: "100:4", name: "Badge" } } },
		// Select variants
		{ node_id: "600:0", name: "State=Closed", description: "", containing_frame: { nodeId: "100:5", name: "Forms / Select", containingComponentSet: { nodeId: "100:5", name: "Forms / Select" } } },
		{ node_id: "600:1", name: "State=Open", description: "", containing_frame: { nodeId: "100:5", name: "Forms / Select", containingComponentSet: { nodeId: "100:5", name: "Forms / Select" } } },
	];

	// Standalone components (no component set parent)
	const standaloneComponents = [
		{ node_id: "50:1", name: "Icon / Star", description: "" },
		{ node_id: "50:2", name: "Icon / Heart", description: "" },
		{ node_id: "50:3", name: "Icon / Check", description: "" },
		{ node_id: "50:4", name: "Logo", description: "Company logo component" },
		{ node_id: "50:5", name: "Divider", description: "Visual separator" },
		{ node_id: "50:6", name: "Avatar", description: "" },
	];

	// Variables (token system)
	const variables = [
		// Semantic color tokens (aliases)
		{ id: "v1", name: "color/action/primary", resolvedType: "COLOR", variableCollectionId: "col1", description: "Primary action color", valuesByMode: { "m1": { type: "VARIABLE_ALIAS", id: "v10" } } },
		{ id: "v2", name: "color/action/secondary", resolvedType: "COLOR", variableCollectionId: "col1", description: "Secondary action color", valuesByMode: { "m1": { type: "VARIABLE_ALIAS", id: "v11" } } },
		{ id: "v3", name: "color/action/danger", resolvedType: "COLOR", variableCollectionId: "col1", description: "", valuesByMode: { "m1": { type: "VARIABLE_ALIAS", id: "v12" } } },
		// Visual color tokens (raw values — leaf segments are visual color words, flagged by naming scorer)
		{ id: "v10", name: "color/primary/blue", resolvedType: "COLOR", variableCollectionId: "col2", description: "Blue primary", valuesByMode: { "m1": { r: 0.2, g: 0.4, b: 0.9, a: 1 } } },
		{ id: "v11", name: "color/accent/teal", resolvedType: "COLOR", variableCollectionId: "col2", description: "", valuesByMode: { "m1": { r: 0.3, g: 0.5, b: 0.95, a: 1 } } },
		{ id: "v12", name: "color/error/red", resolvedType: "COLOR", variableCollectionId: "col2", description: "", valuesByMode: { "m1": { r: 0.9, g: 0.2, b: 0.2, a: 1 } } },
		// Spacing tokens
		{ id: "v20", name: "spacing/xs", resolvedType: "FLOAT", variableCollectionId: "col3", description: "Extra small spacing", valuesByMode: { "m1": 4 } },
		{ id: "v21", name: "spacing/sm", resolvedType: "FLOAT", variableCollectionId: "col3", description: "Small spacing", valuesByMode: { "m1": 8 } },
		{ id: "v22", name: "spacing/md", resolvedType: "FLOAT", variableCollectionId: "col3", description: "Medium spacing", valuesByMode: { "m1": 16 } },
		{ id: "v23", name: "spacing/lg", resolvedType: "FLOAT", variableCollectionId: "col3", description: "", valuesByMode: { "m1": 24 } },
		// String token
		{ id: "v30", name: "font/family/primary", resolvedType: "STRING", variableCollectionId: "col4", description: "Primary font family", valuesByMode: { "m1": "Inter" } },
		// Boolean token (missing prefix)
		{ id: "v40", name: "feature/darkMode", resolvedType: "BOOLEAN", variableCollectionId: "col5", description: "", valuesByMode: { "m1": false } },
	];

	// Collections
	const collections = [
		{ id: "col1", name: "Semantic Colors", modes: [{ name: "Light" }, { name: "Dark" }] },
		{ id: "col2", name: "Primitives", modes: [{ name: "Default" }] },
		{ id: "col3", name: "Spacing", modes: [{ name: "Default" }] },
		{ id: "col4", name: "Typography", modes: [{ name: "Default" }] },
		{ id: "col5", name: "Feature Flags", modes: [{ name: "Default" }] },
	];

	// Styles
	const styles = [
		{ key: "s1", name: "Heading / H1", description: "", styleType: "TEXT" },
		{ key: "s2", name: "Body / Regular", description: "", styleType: "TEXT" },
		{ key: "s3", name: "Shadow / Elevation-1", description: "", styleType: "EFFECT" },
	];

	return {
		variables,
		collections,
		components: [...variantComponents, ...standaloneComponents],
		styles,
		componentSets,
		fileInfo: {
			name: "Test Design System",
			lastModified: "2025-06-15T10:30:00Z",
		},
		dataAvailability: {
			variables: true,
			collections: true,
			components: true,
			styles: true,
		},
	};
}

describe("End-to-end scoring pipeline", () => {
	let result: DashboardData;

	beforeAll(() => {
		result = scoreDesignSystem(buildRealisticData());
	});

	// -----------------------------------------------------------------------
	// Overall structure
	// -----------------------------------------------------------------------

	it("produces a valid overall score", () => {
		expect(result.overall).toBeGreaterThanOrEqual(0);
		expect(result.overall).toBeLessThanOrEqual(100);
		// With mixed-quality data, should be in "needs-work" range
		expect(result.status).toBe("needs-work");
	});

	// -----------------------------------------------------------------------
	// Component classification accuracy
	// -----------------------------------------------------------------------

	describe("component classification", () => {
		it("correctly separates variants from standalone", () => {
			// 12 button + 4 input + 2 toggle + 2 badge + 2 select = 22 variants
			expect(result.meta.variantCount).toBe(22);
			// 6 standalone (3 icons + logo + divider + avatar)
			expect(result.meta.standaloneCount).toBe(6);
			// 5 component sets
			expect(result.meta.componentSetCount).toBe(5);
			// Total raw components = 22 + 6 = 28
			expect(result.meta.componentCount).toBe(28);
		});

		it("does NOT inflate scorable count with individual variants", () => {
			// Scorable = 6 standalone + 5 sets = 11 (not 28)
			expect(result.meta.standaloneCount + result.meta.componentSetCount).toBe(11);
		});
	});

	// -----------------------------------------------------------------------
	// Category scores
	// -----------------------------------------------------------------------

	describe("category scores are reasonable", () => {
		it("naming-semantics detects visual color names", () => {
			const naming = result.categories.find((c) => c.id === "naming-semantics")!;
			expect(naming).toBeDefined();
			// Should flag blue/red color names
			const varNaming = naming.findings.find((f) => f.id === "naming-variable-semantic")!;
			expect(varNaming).toBeDefined();
			expect(varNaming.score).toBeLessThan(100);
			// Should have examples of visual-named variables
			expect(varNaming.examples?.length).toBeGreaterThan(0);
		});

		it("token-architecture detects alias layering", () => {
			const tokenArch = result.categories.find((c) => c.id === "token-architecture")!;
			expect(tokenArch).toBeDefined();
			const aliasUsage = tokenArch.findings.find((f) => f.id === "token-alias-usage")!;
			expect(aliasUsage).toBeDefined();
			// Some variables are aliases, some are raw → partial score
			expect(aliasUsage.score).toBeGreaterThan(0);
			expect(aliasUsage.score).toBeLessThan(100);
		});

		it("component-metadata detects missing descriptions", () => {
			const compMeta = result.categories.find((c) => c.id === "component-metadata")!;
			expect(compMeta).toBeDefined();
			const descPresence = compMeta.findings.find((f) => f.id === "component-desc-presence")!;
			expect(descPresence).toBeDefined();
			// Some components have descriptions, some don't → partial score
			expect(descPresence.score).toBeGreaterThan(0);
			expect(descPresence.score).toBeLessThan(100);
		});

		it("consistency detects delimiter usage", () => {
			const consistency = result.categories.find((c) => c.id === "consistency")!;
			expect(consistency).toBeDefined();
			const delimiter = consistency.findings.find((f) => f.id === "consistency-delimiter")!;
			expect(delimiter).toBeDefined();
			// "/" is the dominant delimiter
			expect(delimiter.details).toContain("/");
		});

		it("component-metadata detects generic layer names", () => {
			const compMeta = result.categories.find((c) => c.id === "component-metadata")!;
			expect(compMeta).toBeDefined();
			const genericNaming = compMeta.findings.find((f) => f.id === "component-generic-naming")!;
			expect(genericNaming).toBeDefined();
			// The test data uses intentional names, so score should be high
			expect(genericNaming.score).toBe(100);
			expect(genericNaming.label).toBe("Layer naming");
		});
	});

	// -----------------------------------------------------------------------
	// Location enrichment in findings
	// -----------------------------------------------------------------------

	describe("location enrichment", () => {
		it("variable findings show collection name", () => {
			const tokenArch = result.categories.find((c) => c.id === "token-architecture")!;
			const descCoverage = tokenArch.findings.find((f) => f.id === "token-description-coverage")!;

			// Variables missing descriptions should have locations with collection context
			if (descCoverage.locations && descCoverage.locations.length > 0) {
				const loc = descCoverage.locations[0];
				expect(loc.name).toBeDefined();
				expect(loc.collection).toBeDefined();
				expect(typeof loc.collection).toBe("string");
				expect(loc.type).toBe("variable");
			}
		});

		it("naming findings show collection context for visual-named variables", () => {
			const naming = result.categories.find((c) => c.id === "naming-semantics")!;
			const varNaming = naming.findings.find((f) => f.id === "naming-variable-semantic")!;

			if (varNaming.locations && varNaming.locations.length > 0) {
				const loc = varNaming.locations[0];
				expect(loc.name).toContain("color/");
				expect(loc.collection).toBe("Primitives");
				expect(loc.type).toBe("variable");
			}
		});

		it("component findings show nodeId for Figma navigation", () => {
			const compMeta = result.categories.find((c) => c.id === "component-metadata")!;
			const descPresence = compMeta.findings.find((f) => f.id === "component-desc-presence")!;

			if (descPresence.locations && descPresence.locations.length > 0) {
				const loc = descPresence.locations[0];
				expect(loc.name).toBeDefined();
				expect(loc.nodeId).toBeDefined();
				expect(loc.type).toBe("component");
			}
		});

		it("boolean naming finding shows collection context", () => {
			const naming = result.categories.find((c) => c.id === "naming-semantics")!;
			const boolNaming = naming.findings.find((f) => f.id === "naming-boolean-prefix")!;

			// "feature/darkMode" lacks is/has/can prefix
			if (boolNaming.locations && boolNaming.locations.length > 0) {
				const loc = boolNaming.locations[0];
				expect(loc.name).toBe("feature/darkMode");
				expect(loc.collection).toBe("Feature Flags");
				expect(loc.type).toBe("variable");
			}
		});
	});

	// -----------------------------------------------------------------------
	// Summary is actionable
	// -----------------------------------------------------------------------

	describe("summary quality", () => {
		it("summary contains actionable items with category context", () => {
			expect(result.summary.length).toBeGreaterThan(0);
			expect(result.summary.length).toBeLessThanOrEqual(5);

			for (const item of result.summary) {
				// Each item should have [Category] prefix
				expect(item).toMatch(/^\[.+\]/);
				// Should contain a colon separating label from details
				expect(item).toContain(":");
			}
		});
	});

	// -----------------------------------------------------------------------
	// Data availability passthrough
	// -----------------------------------------------------------------------

	describe("metadata passthrough", () => {
		it("passes through file info", () => {
			expect(result.fileInfo).toBeDefined();
			expect(result.fileInfo!.name).toBe("Test Design System");
		});

		it("passes through data availability", () => {
			expect(result.dataAvailability).toBeDefined();
			expect(result.dataAvailability!.variables).toBe(true);
		});
	});
});
