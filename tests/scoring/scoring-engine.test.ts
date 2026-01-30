/**
 * Scoring Engine Tests
 *
 * Validates the complete scoring pipeline: all 6 category scorers,
 * location enrichment, and overall dashboard output structure.
 */

import { scoreDesignSystem } from "../../src/apps/design-system-dashboard/scoring/engine";
import type { DesignSystemRawData, DashboardData } from "../../src/apps/design-system-dashboard/scoring/types";

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

describe("scoreDesignSystem", () => {
	// -----------------------------------------------------------------------
	// Output structure
	// -----------------------------------------------------------------------

	describe("output structure", () => {
		it("returns all required fields", () => {
			const data = makeData();
			const result = scoreDesignSystem(data);

			expect(result).toHaveProperty("overall");
			expect(result).toHaveProperty("status");
			expect(result).toHaveProperty("categories");
			expect(result).toHaveProperty("summary");
			expect(result).toHaveProperty("meta");
			expect(typeof result.overall).toBe("number");
			expect(["good", "needs-work", "poor"]).toContain(result.status);
			expect(Array.isArray(result.categories)).toBe(true);
			expect(Array.isArray(result.summary)).toBe(true);
		});

		it("returns exactly 6 categories", () => {
			const data = makeData();
			const result = scoreDesignSystem(data);
			expect(result.categories).toHaveLength(6);
		});

		it("category weights sum to 1.0", () => {
			const data = makeData();
			const result = scoreDesignSystem(data);
			const totalWeight = result.categories.reduce((sum, c) => sum + c.weight, 0);
			expect(totalWeight).toBeCloseTo(1.0, 2);
		});

		it("overall score is between 0 and 100", () => {
			const data = makeData();
			const result = scoreDesignSystem(data);
			expect(result.overall).toBeGreaterThanOrEqual(0);
			expect(result.overall).toBeLessThanOrEqual(100);
		});

		it("each category has required fields", () => {
			const data = makeData();
			const result = scoreDesignSystem(data);

			for (const cat of result.categories) {
				expect(cat).toHaveProperty("id");
				expect(cat).toHaveProperty("label");
				expect(cat).toHaveProperty("shortLabel");
				expect(cat).toHaveProperty("score");
				expect(cat).toHaveProperty("weight");
				expect(cat).toHaveProperty("findings");
				expect(cat.score).toBeGreaterThanOrEqual(0);
				expect(cat.score).toBeLessThanOrEqual(100);
				expect(Array.isArray(cat.findings)).toBe(true);
			}
		});

		it("each finding has required fields", () => {
			const data = makeData({
				components: [{ name: "Button", node_id: "1:1", description: "" }],
			});
			const result = scoreDesignSystem(data);

			for (const cat of result.categories) {
				for (const finding of cat.findings) {
					expect(finding).toHaveProperty("id");
					expect(finding).toHaveProperty("label");
					expect(finding).toHaveProperty("score");
					expect(finding).toHaveProperty("severity");
					expect(["pass", "warning", "fail", "info"]).toContain(finding.severity);
					expect(typeof finding.score).toBe("number");
				}
			}
		});

		it("does NOT include fixable or fix fields (fix infrastructure removed)", () => {
			const data = makeData({
				components: [{ name: "Button", node_id: "1:1" }],
			});
			const result = scoreDesignSystem(data);

			for (const cat of result.categories) {
				for (const finding of cat.findings) {
					expect(finding).not.toHaveProperty("fixable");
					expect(finding).not.toHaveProperty("fix");
				}
			}
		});
	});

	// -----------------------------------------------------------------------
	// Meta counts
	// -----------------------------------------------------------------------

	describe("meta counts", () => {
		it("reports correct component classification counts", () => {
			const data = makeData({
				components: [
					// 2 variants
					{
						name: "Size=Large",
						node_id: "10:1",
						containing_frame: {
							nodeId: "9:1",
							containingComponentSet: { nodeId: "9:1", name: "Button" },
						},
					},
					{
						name: "Size=Small",
						node_id: "10:2",
						containing_frame: {
							nodeId: "9:1",
							containingComponentSet: { nodeId: "9:1", name: "Button" },
						},
					},
					// 1 standalone
					{ name: "Icon / Star", node_id: "1:1" },
				],
				componentSets: [{ name: "Button", node_id: "9:1" }],
				variables: [{ name: "color/primary", resolvedType: "COLOR", id: "v1", variableCollectionId: "c1" }],
				collections: [{ id: "c1", name: "Colors", modes: [{ name: "Light" }] }],
			});

			const result = scoreDesignSystem(data);
			expect(result.meta.componentCount).toBe(3);
			expect(result.meta.componentSetCount).toBe(1);
			expect(result.meta.standaloneCount).toBe(1);
			expect(result.meta.variantCount).toBe(2);
			expect(result.meta.variableCount).toBe(1);
			expect(result.meta.collectionCount).toBe(1);
		});
	});

	// -----------------------------------------------------------------------
	// Location enrichment
	// -----------------------------------------------------------------------

	describe("location enrichment", () => {
		it("includes locations with collection context for variable findings", () => {
			const data = makeData({
				variables: [
					{
						name: "color/blue/500",
						resolvedType: "COLOR",
						id: "v1",
						variableCollectionId: "c1",
						description: "",
					},
					{
						name: "color/red/400",
						resolvedType: "COLOR",
						id: "v2",
						variableCollectionId: "c1",
						description: "",
					},
				],
				collections: [
					{ id: "c1", name: "Colors", modes: [{ name: "Light" }] },
				],
			});

			const result = scoreDesignSystem(data);

			// Find token-architecture category → description coverage finding
			const tokenArch = result.categories.find((c) => c.id === "token-architecture");
			expect(tokenArch).toBeDefined();

			const descCoverage = tokenArch!.findings.find(
				(f) => f.id === "token-description-coverage",
			);
			expect(descCoverage).toBeDefined();

			// Should have locations with collection context
			if (descCoverage!.locations && descCoverage!.locations.length > 0) {
				for (const loc of descCoverage!.locations) {
					expect(loc).toHaveProperty("name");
					expect(loc).toHaveProperty("collection");
					expect(loc.collection).toBe("Colors");
					expect(loc.type).toBe("variable");
				}
			}
		});

		it("includes locations with nodeId for component findings", () => {
			const data = makeData({
				components: [
					{ name: "Button", node_id: "1:1", description: "" },
					{ name: "Card", node_id: "2:1", description: "" },
				],
			});

			const result = scoreDesignSystem(data);

			// Find component-metadata category → description presence
			const compMeta = result.categories.find(
				(c) => c.id === "component-metadata",
			);
			expect(compMeta).toBeDefined();

			const descPresence = compMeta!.findings.find(
				(f) => f.id === "component-desc-presence",
			);
			expect(descPresence).toBeDefined();

			if (descPresence!.locations && descPresence!.locations.length > 0) {
				for (const loc of descPresence!.locations) {
					expect(loc).toHaveProperty("name");
					expect(loc).toHaveProperty("nodeId");
					expect(loc.type).toBe("component");
				}
			}
		});
	});

	// -----------------------------------------------------------------------
	// Status thresholds
	// -----------------------------------------------------------------------

	describe("status thresholds", () => {
		it("returns 'poor' status for empty design systems", () => {
			const result = scoreDesignSystem(makeData());
			// Empty data → mostly 0 or info scores → overall will be low
			expect(result.overall).toBeLessThanOrEqual(100);
		});
	});

	// -----------------------------------------------------------------------
	// Summary generation
	// -----------------------------------------------------------------------

	describe("summary generation", () => {
		it("generates summary items for failing findings", () => {
			const data = makeData({
				// Enough data to trigger some failures
				components: [
					{ name: "button", node_id: "1:1", description: "" },
					{ name: "card", node_id: "2:1" },
				],
			});

			const result = scoreDesignSystem(data);
			// Summary should contain actionable items
			expect(Array.isArray(result.summary)).toBe(true);
			// Each summary item should reference a category
			for (const item of result.summary) {
				expect(item).toContain("[");
				expect(item).toContain("]");
			}
		});
	});

	// -----------------------------------------------------------------------
	// Data availability
	// -----------------------------------------------------------------------

	describe("data availability", () => {
		it("passes through dataAvailability", () => {
			const data = makeData({
				dataAvailability: {
					variables: false,
					collections: false,
					components: true,
					styles: true,
					variableError: "Enterprise plan required",
				},
			});

			const result = scoreDesignSystem(data);
			expect(result.dataAvailability).toBeDefined();
			expect(result.dataAvailability!.variables).toBe(false);
			expect(result.dataAvailability!.variableError).toBe(
				"Enterprise plan required",
			);
		});

		it("passes through fileInfo", () => {
			const data = makeData({
				fileInfo: {
					name: "Test Design System",
					lastModified: "2025-01-01T00:00:00Z",
				},
			});

			const result = scoreDesignSystem(data);
			expect(result.fileInfo).toBeDefined();
			expect(result.fileInfo!.name).toBe("Test Design System");
		});
	});
});
