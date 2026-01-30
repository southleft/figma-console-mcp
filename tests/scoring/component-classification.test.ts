/**
 * Component Classification Tests
 *
 * Validates that isComponentInSet correctly identifies variants across
 * all Figma data formats: Plugin API, REST API, and file JSON.
 */

import {
	classifyComponents,
	type ComponentClassification,
} from "../../src/apps/design-system-dashboard/scoring/component-metadata";
import type { DesignSystemRawData } from "../../src/apps/design-system-dashboard/scoring/types";

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

describe("classifyComponents", () => {
	it("returns empty classification when no components exist", () => {
		const data = makeData();
		const result = classifyComponents(data);
		expect(result.standalone).toHaveLength(0);
		expect(result.variants).toHaveLength(0);
		expect(result.componentSets).toHaveLength(0);
		expect(result.scorableUnits).toHaveLength(0);
	});

	it("classifies all components as standalone when no component sets exist", () => {
		const data = makeData({
			components: [
				{ name: "Icon / Star", node_id: "1:1" },
				{ name: "Icon / Heart", node_id: "1:2" },
			],
			componentSets: [],
		});
		const result = classifyComponents(data);
		expect(result.standalone).toHaveLength(2);
		expect(result.variants).toHaveLength(0);
		expect(result.scorableUnits).toHaveLength(2);
	});

	// -----------------------------------------------------------------------
	// REST API format: containing_frame.containingComponentSet
	// -----------------------------------------------------------------------

	describe("REST API detection (containing_frame.containingComponentSet)", () => {
		it("detects variants via containingComponentSet", () => {
			const data = makeData({
				components: [
					{
						name: "Size=Large, State=Active",
						node_id: "10:1",
						containing_frame: {
							nodeId: "9:1",
							name: "Button",
							containingComponentSet: {
								nodeId: "9:1",
								name: "Button",
							},
						},
					},
					{
						name: "Size=Small, State=Active",
						node_id: "10:2",
						containing_frame: {
							nodeId: "9:1",
							name: "Button",
							containingComponentSet: {
								nodeId: "9:1",
								name: "Button",
							},
						},
					},
					{
						name: "Icon / Star",
						node_id: "2:1",
						containing_frame: {
							nodeId: "3:1",
							name: "Icons",
						},
					},
				],
				componentSets: [{ name: "Button", node_id: "9:1" }],
			});

			const result = classifyComponents(data);
			expect(result.variants).toHaveLength(2);
			expect(result.standalone).toHaveLength(1);
			expect(result.standalone[0].name).toBe("Icon / Star");
			expect(result.scorableUnits).toHaveLength(2); // 1 standalone + 1 set
		});

		it("handles REST API data with many categories", () => {
			const data = makeData({
				components: [
					// 3 icon standalone components
					{ name: "Icon / AArrowDown", node_id: "1:1", containing_frame: { nodeId: "0:1", name: "Icons" } },
					{ name: "Icon / AArrowUp", node_id: "1:2", containing_frame: { nodeId: "0:1", name: "Icons" } },
					{ name: "Icon / Activity", node_id: "1:3", containing_frame: { nodeId: "0:1", name: "Icons" } },
					// 2 social media icon variants
					{
						name: "Name=Facebook, Colors=Original",
						node_id: "10:1",
						containing_frame: {
							nodeId: "9:1",
							name: "Social Media Icon",
							containingComponentSet: { nodeId: "9:1", name: "Social Media Icon" },
						},
					},
					{
						name: "Name=Instagram, Colors=Original",
						node_id: "10:2",
						containing_frame: {
							nodeId: "9:1",
							name: "Social Media Icon",
							containingComponentSet: { nodeId: "9:1", name: "Social Media Icon" },
						},
					},
				],
				componentSets: [
					{ name: "Social Media Icon", node_id: "9:1" },
				],
			});

			const result = classifyComponents(data);
			expect(result.standalone).toHaveLength(3);
			expect(result.variants).toHaveLength(2);
			expect(result.componentSets).toHaveLength(1);
			expect(result.scorableUnits).toHaveLength(4); // 3 standalone + 1 set
		});
	});

	// -----------------------------------------------------------------------
	// Plugin API format: componentSetId
	// -----------------------------------------------------------------------

	describe("Plugin API detection (componentSetId)", () => {
		it("detects variants via componentSetId", () => {
			const data = makeData({
				components: [
					{ name: "Size=Large", node_id: "10:1", componentSetId: "9:1" },
					{ name: "Size=Small", node_id: "10:2", componentSetId: "9:1" },
					{ name: "Standalone", node_id: "2:1" },
				],
				componentSets: [{ name: "Button", node_id: "9:1" }],
			});

			const result = classifyComponents(data);
			expect(result.variants).toHaveLength(2);
			expect(result.standalone).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	// File JSON format: component_set_id (snake_case)
	// -----------------------------------------------------------------------

	describe("File JSON detection (component_set_id)", () => {
		it("detects variants via component_set_id", () => {
			const data = makeData({
				components: [
					{ name: "Size=Large", node_id: "10:1", component_set_id: "9:1" },
					{ name: "Size=Small", node_id: "10:2", component_set_id: "9:1" },
					{ name: "Standalone", node_id: "2:1" },
				],
				componentSets: [{ name: "Button", node_id: "9:1" }],
			});

			const result = classifyComponents(data);
			expect(result.variants).toHaveLength(2);
			expect(result.standalone).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	// Name prefix fallback
	// -----------------------------------------------------------------------

	describe("Name prefix fallback", () => {
		it("detects variants when name starts with SetName/", () => {
			const data = makeData({
				components: [
					{ name: "Button/Size=Large", node_id: "10:1" },
					{ name: "Button/Size=Small", node_id: "10:2" },
					{ name: "Icon / Star", node_id: "2:1" },
				],
				componentSets: [{ name: "Button", node_id: "9:1" }],
			});

			const result = classifyComponents(data);
			expect(result.variants).toHaveLength(2);
			expect(result.standalone).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	// Frame node ID fallback
	// -----------------------------------------------------------------------

	describe("Frame node ID fallback", () => {
		it("detects variants when containing_frame.nodeId matches a component set", () => {
			const data = makeData({
				components: [
					{
						name: "Size=Large",
						node_id: "10:1",
						containing_frame: { nodeId: "9:1", name: "Button" },
					},
					{ name: "Standalone", node_id: "2:1" },
				],
				componentSets: [{ name: "Button", node_id: "9:1" }],
			});

			const result = classifyComponents(data);
			expect(result.variants).toHaveLength(1);
			expect(result.standalone).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	// Scorable unit count
	// -----------------------------------------------------------------------

	describe("scorable units calculation", () => {
		it("counts standalone + componentSets (not individual variants)", () => {
			const data = makeData({
				components: [
					// 5 variants of Button
					...Array.from({ length: 5 }, (_, i) => ({
						name: `Variant=${i}`,
						node_id: `10:${i}`,
						containing_frame: {
							nodeId: "9:1",
							containingComponentSet: { nodeId: "9:1", name: "Button" },
						},
					})),
					// 3 variants of Toggle
					...Array.from({ length: 3 }, (_, i) => ({
						name: `State=${i}`,
						node_id: `20:${i}`,
						containing_frame: {
							nodeId: "19:1",
							containingComponentSet: { nodeId: "19:1", name: "Toggle" },
						},
					})),
					// 2 standalone icons
					{ name: "Icon / Star", node_id: "1:1" },
					{ name: "Icon / Heart", node_id: "1:2" },
				],
				componentSets: [
					{ name: "Button", node_id: "9:1" },
					{ name: "Toggle", node_id: "19:1" },
				],
			});

			const result = classifyComponents(data);
			expect(result.variants).toHaveLength(8); // 5 + 3
			expect(result.standalone).toHaveLength(2);
			expect(result.componentSets).toHaveLength(2);
			// Scorable = 2 standalone + 2 component sets = 4 (not 10)
			expect(result.scorableUnits).toHaveLength(4);
		});
	});
});
