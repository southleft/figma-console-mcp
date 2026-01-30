/**
 * UI Rendering Logic Tests
 *
 * Validates the HTML output structure by testing the rendering logic
 * that produces the dashboard markup. Since the actual render functions
 * are in a browser-context file (mcp-app.ts), we test the contract:
 * the DashboardData → HTML expectations.
 */

import { scoreDesignSystem } from "../../src/apps/design-system-dashboard/scoring/engine";
import type { DesignSystemRawData, DashboardData, Finding } from "../../src/apps/design-system-dashboard/scoring/types";

function makeData(
	overrides: Partial<DesignSystemRawData> = {},
): DesignSystemRawData {
	return {
		variables: [],
		collections: [],
		components: [],
		styles: [],
		componentSets: [],
		...overrides,
	};
}

describe("Dashboard data contract for UI rendering", () => {
	// -----------------------------------------------------------------------
	// No fix-related fields
	// -----------------------------------------------------------------------

	describe("fix infrastructure removal", () => {
		it("no finding has fixable or fix fields", () => {
			const data = makeData({
				components: [
					{ name: "Button", node_id: "1:1", description: "" },
					{ name: "Card", node_id: "2:1", description: "A card" },
				],
				variables: [
					{
						name: "color/blue/500",
						resolvedType: "COLOR",
						id: "v1",
						variableCollectionId: "c1",
						description: "",
						valuesByMode: { "1:0": { r: 0, g: 0, b: 1, a: 1 } },
					},
				],
				collections: [
					{ id: "c1", name: "Colors", modes: [{ name: "Light" }] },
				],
			});

			const result = scoreDesignSystem(data);
			const allFindings = result.categories.flatMap((c) => c.findings);

			for (const finding of allFindings) {
				expect(finding).not.toHaveProperty("fixable");
				expect(finding).not.toHaveProperty("fix");
			}
		});

		it("JSON serialization contains no fix references", () => {
			const data = makeData({
				components: [{ name: "Button", node_id: "1:1" }],
			});
			const result = scoreDesignSystem(data);
			const json = JSON.stringify(result);

			expect(json).not.toContain('"fixable"');
			expect(json).not.toContain('"fix"');
			expect(json).not.toContain("ds_dashboard_fix");
		});
	});

	// -----------------------------------------------------------------------
	// Location data for UI rendering
	// -----------------------------------------------------------------------

	describe("location data for examples rendering", () => {
		it("variable findings include collection name in locations", () => {
			const data = makeData({
				variables: [
					{
						name: "color/blue/500",
						resolvedType: "COLOR",
						id: "v1",
						variableCollectionId: "c1",
						description: "",
						valuesByMode: { "1:0": { r: 0, g: 0, b: 1, a: 1 } },
					},
					{
						name: "color/red/400",
						resolvedType: "COLOR",
						id: "v2",
						variableCollectionId: "c2",
						description: "",
						valuesByMode: { "1:0": { r: 1, g: 0, b: 0, a: 1 } },
					},
				],
				collections: [
					{ id: "c1", name: "Brand Colors", modes: [{ name: "Light" }] },
					{ id: "c2", name: "Semantic Colors", modes: [{ name: "Light" }] },
				],
			});

			const result = scoreDesignSystem(data);

			// Check naming-semantics → variable naming finding
			const naming = result.categories.find(
				(c) => c.id === "naming-semantics",
			);
			expect(naming).toBeDefined();

			const varNaming = naming!.findings.find(
				(f) => f.id === "naming-variable-semantic",
			);

			// These variables have visual color names (blue, red) → should have locations
			if (varNaming && varNaming.locations) {
				expect(varNaming.locations.length).toBeGreaterThan(0);
				const firstLoc = varNaming.locations[0];
				expect(firstLoc.name).toMatch(/color/);
				expect(firstLoc.type).toBe("variable");
				// Collection name should be present
				expect(
					firstLoc.collection === "Brand Colors" ||
						firstLoc.collection === "Semantic Colors",
				).toBe(true);
			}
		});

		it("component findings include nodeId in locations", () => {
			const data = makeData({
				components: [
					{ name: "Button", node_id: "1:1", description: "" },
					{ name: "Card", node_id: "2:1", description: "" },
					{ name: "Input", node_id: "3:1", description: "" },
				],
			});

			const result = scoreDesignSystem(data);
			const compMeta = result.categories.find(
				(c) => c.id === "component-metadata",
			);
			expect(compMeta).toBeDefined();

			const descPresence = compMeta!.findings.find(
				(f) => f.id === "component-desc-presence",
			);
			expect(descPresence).toBeDefined();

			// All components lack descriptions → locations should list them
			if (descPresence!.locations) {
				expect(descPresence!.locations.length).toBeGreaterThan(0);
				for (const loc of descPresence!.locations) {
					expect(loc.nodeId).toBeDefined();
					expect(loc.type).toBe("component");
				}
			}
		});

		it("locations are capped at MAX_EXAMPLES (5)", () => {
			const data = makeData({
				components: Array.from({ length: 20 }, (_, i) => ({
					name: `Component${i}`,
					node_id: `${i}:1`,
					description: "",
				})),
			});

			const result = scoreDesignSystem(data);
			const compMeta = result.categories.find(
				(c) => c.id === "component-metadata",
			);

			for (const finding of compMeta!.findings) {
				if (finding.locations) {
					expect(finding.locations.length).toBeLessThanOrEqual(5);
				}
				if (finding.examples) {
					expect(finding.examples.length).toBeLessThanOrEqual(5);
				}
			}
		});
	});

	// -----------------------------------------------------------------------
	// Tooltip presence for UI rendering
	// -----------------------------------------------------------------------

	describe("tooltip data for finding labels", () => {
		it("all findings include a tooltip string", () => {
			const data = makeData({
				components: [
					{ name: "Button", node_id: "1:1", description: "Primary button" },
					{ name: "Card", node_id: "2:1", description: "" },
				],
				variables: [
					{
						name: "color/action/primary",
						resolvedType: "COLOR",
						id: "v1",
						variableCollectionId: "c1",
						description: "Primary action color",
						valuesByMode: { "1:0": { type: "VARIABLE_ALIAS", id: "v2" } },
					},
					{
						name: "color/blue/500",
						resolvedType: "COLOR",
						id: "v2",
						variableCollectionId: "c1",
						description: "",
						valuesByMode: { "1:0": { r: 0, g: 0, b: 1, a: 1 } },
					},
					{
						name: "spacing/sm",
						resolvedType: "FLOAT",
						id: "v3",
						variableCollectionId: "c2",
						description: "",
						valuesByMode: { "1:0": 8 },
					},
				],
				collections: [
					{ id: "c1", name: "Colors", modes: [{ name: "Light" }, { name: "Dark" }] },
					{ id: "c2", name: "Spacing", modes: [{ name: "Default" }] },
				],
			});

			const result = scoreDesignSystem(data);
			const allFindings = result.categories.flatMap((c) => c.findings);

			for (const finding of allFindings) {
				expect(finding.tooltip).toBeDefined();
				expect(typeof finding.tooltip).toBe("string");
				expect(finding.tooltip!.length).toBeGreaterThan(10);
			}
		});

		it("tooltips do not contain HTML entities or markup", () => {
			const data = makeData({
				components: [{ name: "Button", node_id: "1:1" }],
			});

			const result = scoreDesignSystem(data);
			const allFindings = result.categories.flatMap((c) => c.findings);

			for (const finding of allFindings) {
				if (finding.tooltip) {
					expect(finding.tooltip).not.toMatch(/<[^>]+>/);
					expect(finding.tooltip).not.toContain("&amp;");
					expect(finding.tooltip).not.toContain("&lt;");
				}
			}
		});
	});

	// -----------------------------------------------------------------------
	// Category expected IDs and labels
	// -----------------------------------------------------------------------

	describe("category identifiers match UI expectations", () => {
		it("returns expected category IDs", () => {
			const data = makeData();
			const result = scoreDesignSystem(data);
			const ids = result.categories.map((c) => c.id);

			expect(ids).toContain("naming-semantics");
			expect(ids).toContain("token-architecture");
			expect(ids).toContain("component-metadata");
			expect(ids).toContain("accessibility");
			expect(ids).toContain("consistency");
			expect(ids).toContain("coverage");
		});

		it("each category has a short label for gauge display", () => {
			const data = makeData();
			const result = scoreDesignSystem(data);

			for (const cat of result.categories) {
				expect(cat.shortLabel).toBeDefined();
				expect(cat.shortLabel.length).toBeLessThanOrEqual(15);
			}
		});
	});

	// -----------------------------------------------------------------------
	// Severity distribution is reasonable
	// -----------------------------------------------------------------------

	describe("severity assignment", () => {
		it("scores >= 90 get 'pass' severity", () => {
			// A well-structured design system
			const data = makeData({
				variables: [
					{
						name: "color/action/primary",
						resolvedType: "COLOR",
						id: "v1",
						variableCollectionId: "c1",
						description: "Primary action color for interactive elements",
						valuesByMode: {
							"1:0": { type: "VARIABLE_ALIAS", id: "v2" },
						},
					},
					{
						name: "color/action/secondary",
						resolvedType: "COLOR",
						id: "v2",
						variableCollectionId: "c1",
						description: "Secondary action color for less prominent elements",
						valuesByMode: { "1:0": { r: 0, g: 0, b: 1, a: 1 } },
					},
				],
				collections: [
					{
						id: "c1",
						name: "Colors",
						modes: [{ name: "Light" }, { name: "Dark" }],
					},
				],
			});

			const result = scoreDesignSystem(data);
			const allFindings = result.categories.flatMap((c) => c.findings);
			const passFindings = allFindings.filter((f) => f.severity === "pass");
			// At least some findings should pass with good data
			expect(passFindings.length).toBeGreaterThan(0);
		});
	});
});
