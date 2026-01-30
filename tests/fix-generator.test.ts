import { generateAllFixes } from "../src/apps/design-system-dashboard/scoring/fix-generator";
import type { DesignSystemRawData } from "../src/apps/design-system-dashboard/scoring/types";
import type { FixDefinition } from "../src/apps/design-system-dashboard/scoring/fix-types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal DesignSystemRawData with sensible defaults. */
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

// ---------------------------------------------------------------------------
// generateAllFixes
// ---------------------------------------------------------------------------

describe("generateAllFixes", () => {
	it("returns a Map instance", () => {
		const result = generateAllFixes(makeData());
		expect(result).toBeInstanceOf(Map);
	});

	it("returns an empty map when there is nothing to fix", () => {
		const data = makeData({
			components: [
				{
					name: "Button",
					description: "A primary button component",
					node_id: "1:1",
					id: "c1",
				},
			],
		});
		const result = generateAllFixes(data);
		// The component already has a description and PascalCase name, so no fixes.
		expect(result.size).toBe(0);
	});

	it("includes all expected findingIds when data triggers every generator", () => {
		const data = makeData({
			components: [
				// Standalone component without description and non-PascalCase name
				{
					name: "button-primary",
					description: "",
					node_id: "1:1",
					id: "c1",
				},
			],
			variables: [
				// Variable without description
				{
					id: "v1",
					name: "colors/primary",
					description: "",
					resolvedType: "COLOR",
					variableCollectionId: "col1",
				},
				// Boolean variable without prefix
				{
					id: "v2",
					name: "state/active",
					description: "Is it active?",
					resolvedType: "BOOLEAN",
					variableCollectionId: "col1",
				},
				// Variable using a non-dominant delimiter
				{
					id: "v3",
					name: "spacing.small",
					description: "Small spacing",
					resolvedType: "FLOAT",
					variableCollectionId: "col1",
				},
			],
			collections: [
				{ id: "col1", name: "Primitives" },
			],
		});

		const fixes = generateAllFixes(data);

		expect(fixes.has("component-desc-presence")).toBe(true);
		expect(fixes.has("token-description-coverage")).toBe(true);
		expect(fixes.has("naming-component-casing")).toBe(true);
		expect(fixes.has("naming-boolean-prefix")).toBe(true);
		expect(fixes.has("consistency-delimiter")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Component description fixes (component-desc-presence)
// ---------------------------------------------------------------------------

describe("component description fixes (component-desc-presence)", () => {
	it("generates fixes for components without descriptions", () => {
		const data = makeData({
			components: [
				{ name: "Button", description: "", node_id: "1:1", id: "c1" },
				{ name: "Card", description: "", node_id: "1:2", id: "c2" },
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("component-desc-presence");

		expect(fix).toBeDefined();
		expect(fix!.operations).toHaveLength(2);
		expect(fix!.requiresDesktopBridge).toBe(true);
		expect(fix!.description).toContain("2 components");
	});

	it("skips components that already have descriptions", () => {
		const data = makeData({
			components: [
				{
					name: "Button",
					description: "A primary action button",
					node_id: "1:1",
					id: "c1",
				},
				{ name: "Card", description: "", node_id: "1:2", id: "c2" },
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("component-desc-presence");

		expect(fix).toBeDefined();
		expect(fix!.operations).toHaveLength(1);
		expect(fix!.operations[0].targetName).toBe("Card");
	});

	it("returns null (no fix entry) when all components have descriptions", () => {
		const data = makeData({
			components: [
				{
					name: "Button",
					description: "A button",
					node_id: "1:1",
					id: "c1",
				},
			],
		});

		const fixes = generateAllFixes(data);
		expect(fixes.has("component-desc-presence")).toBe(false);
	});

	it("uses node_id as targetId", () => {
		const data = makeData({
			components: [
				{ name: "Icon", description: "", node_id: "42:99", id: "c-icon" },
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("component-desc-presence")!;

		expect(fix.operations[0].targetId).toBe("42:99");
	});

	it("falls back to id when node_id is missing", () => {
		const data = makeData({
			components: [
				{ name: "Icon", description: "", id: "c-icon" },
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("component-desc-presence")!;

		expect(fix.operations[0].targetId).toBe("c-icon");
	});

	it("generates contextual description from name path", () => {
		const data = makeData({
			components: [
				{
					name: "Forms/TextInput",
					description: "",
					node_id: "1:1",
					id: "c1",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("component-desc-presence")!;
		const params = fix.operations[0].params;

		expect(params.description).toBe("TextInput component in Forms");
	});

	it("generates simple description for components without path", () => {
		const data = makeData({
			components: [
				{ name: "Button", description: "", node_id: "1:1", id: "c1" },
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("component-desc-presence")!;
		const params = fix.operations[0].params;

		expect(params.description).toBe("Button component");
	});

	it("handles multi-level paths for context", () => {
		const data = makeData({
			components: [
				{
					name: "Navigation/Tabs/TabItem",
					description: "",
					node_id: "1:1",
					id: "c1",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("component-desc-presence")!;
		const params = fix.operations[0].params;

		expect(params.description).toBe("TabItem component in Navigation/Tabs");
	});

	it("treats component sets as scorable units", () => {
		const data = makeData({
			componentSets: [
				{
					name: "ButtonSet",
					description: "",
					node_id: "set:1",
					id: "cs1",
				},
			],
			// This variant belongs to the set and should NOT be scored independently
			components: [
				{
					name: "Button/Primary",
					description: "",
					node_id: "1:1",
					id: "c1",
					containing_frame: { nodeId: "set:1" },
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("component-desc-presence")!;

		// Only the component set should generate a fix, not the variant
		expect(fix.operations).toHaveLength(1);
		expect(fix.operations[0].targetId).toBe("set:1");
		expect(fix.operations[0].targetName).toBe("ButtonSet");
	});
});

// ---------------------------------------------------------------------------
// Variable description fixes (token-description-coverage)
// ---------------------------------------------------------------------------

describe("variable description fixes (token-description-coverage)", () => {
	it("generates fixes for variables without descriptions", () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "color/primary",
					description: "",
					resolvedType: "COLOR",
					variableCollectionId: "col1",
				},
				{
					id: "v2",
					name: "spacing/sm",
					description: "",
					resolvedType: "FLOAT",
					variableCollectionId: "col1",
				},
			],
			collections: [{ id: "col1", name: "Primitives" }],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("token-description-coverage");

		expect(fix).toBeDefined();
		expect(fix!.operations).toHaveLength(2);
		expect(fix!.requiresDesktopBridge).toBe(true);
	});

	it("includes collection name in generated description", () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "color/primary",
					description: "",
					resolvedType: "COLOR",
					variableCollectionId: "col1",
				},
			],
			collections: [{ id: "col1", name: "Brand Colors" }],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("token-description-coverage")!;
		const desc = fix.operations[0].params.description as string;

		expect(desc).toContain("Brand Colors");
		expect(desc).toContain("color/primary");
		expect(desc).toContain("color");
	});

	it("generates description without collection when collection is unknown", () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "spacing/md",
					description: "",
					resolvedType: "FLOAT",
					variableCollectionId: "unknown-col",
				},
			],
			collections: [],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("token-description-coverage")!;
		const desc = fix.operations[0].params.description as string;

		expect(desc).toBe("spacing/md \u2014 float token");
	});

	it("skips variables that already have descriptions", () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "color/primary",
					description: "Primary brand color",
					resolvedType: "COLOR",
					variableCollectionId: "col1",
				},
				{
					id: "v2",
					name: "spacing/sm",
					description: "",
					resolvedType: "FLOAT",
					variableCollectionId: "col1",
				},
			],
			collections: [{ id: "col1", name: "Primitives" }],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("token-description-coverage")!;

		expect(fix.operations).toHaveLength(1);
		expect(fix.operations[0].targetName).toBe("spacing/sm");
	});

	it("returns no fix when all variables have descriptions", () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "color/primary",
					description: "The primary color",
					resolvedType: "COLOR",
					variableCollectionId: "col1",
				},
			],
			collections: [{ id: "col1", name: "Primitives" }],
		});

		const fixes = generateAllFixes(data);
		expect(fixes.has("token-description-coverage")).toBe(false);
	});

	it("uses the variable id as targetId", () => {
		const data = makeData({
			variables: [
				{
					id: "var-abc-123",
					name: "opacity/half",
					description: "",
					resolvedType: "FLOAT",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("token-description-coverage")!;

		expect(fix.operations[0].targetId).toBe("var-abc-123");
	});

	it("lowercases resolvedType in the description", () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "flag",
					description: "",
					resolvedType: "BOOLEAN",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("token-description-coverage")!;
		const desc = fix.operations[0].params.description as string;

		expect(desc).toContain("boolean");
		expect(desc).not.toContain("BOOLEAN");
	});
});

// ---------------------------------------------------------------------------
// Component casing fixes (naming-component-casing)
// ---------------------------------------------------------------------------

describe("component casing fixes (naming-component-casing)", () => {
	it('fixes "button-primary" segments to "ButtonPrimary"', () => {
		const data = makeData({
			components: [
				{
					name: "button-primary",
					description: "btn",
					node_id: "1:1",
					id: "c1",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-component-casing")!;

		expect(fix).toBeDefined();
		expect(fix.operations[0].params.newName).toBe("ButtonPrimary");
	});

	it('fixes "my_component" to "MyComponent"', () => {
		const data = makeData({
			components: [
				{
					name: "my_component",
					description: "x",
					node_id: "1:1",
					id: "c1",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-component-casing")!;

		expect(fix.operations[0].params.newName).toBe("MyComponent");
	});

	it('preserves "/" separators between segments', () => {
		const data = makeData({
			components: [
				{
					name: "forms/text-input",
					description: "x",
					node_id: "1:1",
					id: "c1",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-component-casing")!;

		expect(fix.operations[0].params.newName).toBe("Forms/TextInput");
	});

	it('skips already-PascalCase names like "Button"', () => {
		const data = makeData({
			components: [
				{
					name: "Button",
					description: "x",
					node_id: "1:1",
					id: "c1",
				},
			],
		});

		const fixes = generateAllFixes(data);
		expect(fixes.has("naming-component-casing")).toBe(false);
	});

	it('handles multi-segment paths like "Forms/text-input" -> "Forms/TextInput"', () => {
		const data = makeData({
			components: [
				{
					name: "Forms/text-input",
					description: "x",
					node_id: "1:1",
					id: "c1",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-component-casing")!;

		expect(fix.operations[0].params.newName).toBe("Forms/TextInput");
	});

	it("preserves already-PascalCase segments in a mixed path", () => {
		const data = makeData({
			components: [
				{
					name: "Navigation/tab-bar",
					description: "x",
					node_id: "1:1",
					id: "c1",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-component-casing")!;

		// "Navigation" is already PascalCase so stays as-is
		expect(fix.operations[0].params.newName).toBe("Navigation/TabBar");
	});

	it("uses node_id as targetId for rename operations", () => {
		const data = makeData({
			components: [
				{
					name: "bad-name",
					description: "x",
					node_id: "99:42",
					id: "c1",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-component-casing")!;

		expect(fix.operations[0].targetId).toBe("99:42");
		expect(fix.operations[0].action).toBe("rename-node");
	});

	it("generates correct plural description for multiple fixes", () => {
		const data = makeData({
			components: [
				{
					name: "button-primary",
					description: "x",
					node_id: "1:1",
					id: "c1",
				},
				{
					name: "card-header",
					description: "x",
					node_id: "1:2",
					id: "c2",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-component-casing")!;

		expect(fix.description).toContain("2 components");
	});
});

// ---------------------------------------------------------------------------
// Boolean prefix fixes (naming-boolean-prefix)
// ---------------------------------------------------------------------------

describe("boolean prefix fixes (naming-boolean-prefix)", () => {
	it('adds "is" prefix to boolean variables missing it (e.g. "visible" -> "isVisible")', () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "visible",
					description: "visibility flag",
					resolvedType: "BOOLEAN",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-boolean-prefix")!;

		expect(fix).toBeDefined();
		expect(fix.operations[0].params.newName).toBe("isVisible");
		expect(fix.operations[0].action).toBe("rename-variable");
	});

	it('preserves path structure (e.g. "state/active" -> "state/isActive")', () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "state/active",
					description: "desc",
					resolvedType: "BOOLEAN",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-boolean-prefix")!;

		expect(fix.operations[0].params.newName).toBe("state/isActive");
	});

	it("preserves dot-delimited path structure", () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "state.collapsed",
					description: "desc",
					resolvedType: "BOOLEAN",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-boolean-prefix")!;

		expect(fix.operations[0].params.newName).toBe("state.isCollapsed");
	});

	it("skips variables that already have boolean prefixes", () => {
		const prefixed = [
			{ id: "v1", name: "isOpen", resolvedType: "BOOLEAN", description: "x" },
			{ id: "v2", name: "hasValue", resolvedType: "BOOLEAN", description: "x" },
			{ id: "v3", name: "canEdit", resolvedType: "BOOLEAN", description: "x" },
			{ id: "v4", name: "shouldRender", resolvedType: "BOOLEAN", description: "x" },
			{ id: "v5", name: "willUpdate", resolvedType: "BOOLEAN", description: "x" },
			{ id: "v6", name: "showMenu", resolvedType: "BOOLEAN", description: "x" },
			{ id: "v7", name: "hideHeader", resolvedType: "BOOLEAN", description: "x" },
			{ id: "v8", name: "enableDark", resolvedType: "BOOLEAN", description: "x" },
			{ id: "v9", name: "disableAnimations", resolvedType: "BOOLEAN", description: "x" },
		];

		const data = makeData({ variables: prefixed });
		const fixes = generateAllFixes(data);

		expect(fixes.has("naming-boolean-prefix")).toBe(false);
	});

	it("only targets BOOLEAN resolvedType variables", () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "active",
					description: "x",
					resolvedType: "BOOLEAN",
				},
				{
					id: "v2",
					name: "count",
					description: "x",
					resolvedType: "FLOAT",
				},
				{
					id: "v3",
					name: "label",
					description: "x",
					resolvedType: "STRING",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-boolean-prefix")!;

		expect(fix.operations).toHaveLength(1);
		expect(fix.operations[0].targetName).toBe("active");
	});

	it("returns no fix when there are no boolean variables needing prefixes", () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "isActive",
					description: "x",
					resolvedType: "BOOLEAN",
				},
			],
		});

		const fixes = generateAllFixes(data);
		expect(fixes.has("naming-boolean-prefix")).toBe(false);
	});

	it("skips variables without id or name", () => {
		const data = makeData({
			variables: [
				{ id: "", name: "active", description: "x", resolvedType: "BOOLEAN" },
				{ id: "v2", name: "", description: "x", resolvedType: "BOOLEAN" },
			],
		});

		const fixes = generateAllFixes(data);
		expect(fixes.has("naming-boolean-prefix")).toBe(false);
	});

	it("capitalizes the first letter of the original leaf when adding prefix", () => {
		const data = makeData({
			variables: [
				{
					id: "v1",
					name: "checked",
					description: "x",
					resolvedType: "BOOLEAN",
				},
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("naming-boolean-prefix")!;

		expect(fix.operations[0].params.newName).toBe("isChecked");
	});
});

// ---------------------------------------------------------------------------
// Delimiter consistency fixes (consistency-delimiter)
// ---------------------------------------------------------------------------

describe("delimiter consistency fixes (consistency-delimiter)", () => {
	it("normalizes to the dominant delimiter", () => {
		const data = makeData({
			variables: [
				// "/" is dominant (used by 3 variables)
				{ id: "v1", name: "color/primary", description: "x", resolvedType: "COLOR" },
				{ id: "v2", name: "color/secondary", description: "x", resolvedType: "COLOR" },
				{ id: "v3", name: "spacing/sm", description: "x", resolvedType: "FLOAT" },
				// "." used by 1 variable -- should be fixed
				{ id: "v4", name: "spacing.lg", description: "x", resolvedType: "FLOAT" },
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("consistency-delimiter")!;

		expect(fix).toBeDefined();
		expect(fix.operations).toHaveLength(1);
		expect(fix.operations[0].params.newName).toBe("spacing/lg");
	});

	it("skips variables that already use the dominant delimiter", () => {
		const data = makeData({
			variables: [
				{ id: "v1", name: "color/primary", description: "x", resolvedType: "COLOR" },
				{ id: "v2", name: "color/secondary", description: "x", resolvedType: "COLOR" },
				{ id: "v3", name: "spacing/sm", description: "x", resolvedType: "FLOAT" },
			],
		});

		const fixes = generateAllFixes(data);
		// All use "/" which is dominant, so no fixes needed
		expect(fixes.has("consistency-delimiter")).toBe(false);
	});

	it('handles case where "/" is dominant but some use "." or "-"', () => {
		const data = makeData({
			variables: [
				{ id: "v1", name: "color/primary", description: "x", resolvedType: "COLOR" },
				{ id: "v2", name: "color/secondary", description: "x", resolvedType: "COLOR" },
				{ id: "v3", name: "spacing/sm", description: "x", resolvedType: "FLOAT" },
				{ id: "v4", name: "spacing.md", description: "x", resolvedType: "FLOAT" },
				{ id: "v5", name: "sizing-lg", description: "x", resolvedType: "FLOAT" },
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("consistency-delimiter")!;

		expect(fix).toBeDefined();
		expect(fix.operations).toHaveLength(2);

		const newNames = fix.operations.map((op) => op.params.newName);
		expect(newNames).toContain("spacing/md");
		expect(newNames).toContain("sizing/lg");
	});

	it("does not produce fixes when no delimiters are used", () => {
		const data = makeData({
			variables: [
				{ id: "v1", name: "primary", description: "x", resolvedType: "COLOR" },
				{ id: "v2", name: "secondary", description: "x", resolvedType: "COLOR" },
			],
		});

		const fixes = generateAllFixes(data);
		expect(fixes.has("consistency-delimiter")).toBe(false);
	});

	it("returns no fix when variables array is empty", () => {
		const data = makeData({ variables: [] });
		const fixes = generateAllFixes(data);
		expect(fixes.has("consistency-delimiter")).toBe(false);
	});

	it("uses rename-variable action", () => {
		const data = makeData({
			variables: [
				{ id: "v1", name: "a/b", description: "x", resolvedType: "COLOR" },
				{ id: "v2", name: "c/d", description: "x", resolvedType: "COLOR" },
				{ id: "v3", name: "e.f", description: "x", resolvedType: "COLOR" },
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("consistency-delimiter")!;

		expect(fix.operations[0].action).toBe("rename-variable");
	});

	it("replaces all non-dominant delimiters in a single variable name", () => {
		const data = makeData({
			variables: [
				{ id: "v1", name: "a/b", description: "x", resolvedType: "COLOR" },
				{ id: "v2", name: "c/d", description: "x", resolvedType: "COLOR" },
				// This variable uses two non-dominant delimiters
				{ id: "v3", name: "e.f-g", description: "x", resolvedType: "COLOR" },
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("consistency-delimiter")!;

		expect(fix.operations).toHaveLength(1);
		expect(fix.operations[0].params.newName).toBe("e/f/g");
	});

	it("identifies the correct dominant delimiter by usage count", () => {
		// "." is used by 3 variables, "/" by 1
		const data = makeData({
			variables: [
				{ id: "v1", name: "color.primary", description: "x", resolvedType: "COLOR" },
				{ id: "v2", name: "color.secondary", description: "x", resolvedType: "COLOR" },
				{ id: "v3", name: "spacing.sm", description: "x", resolvedType: "FLOAT" },
				{ id: "v4", name: "sizing/lg", description: "x", resolvedType: "FLOAT" },
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("consistency-delimiter")!;

		expect(fix).toBeDefined();
		expect(fix.operations).toHaveLength(1);
		// "." is dominant, so "/" should be replaced with "."
		expect(fix.operations[0].params.newName).toBe("sizing.lg");
	});

	it("sets requiresDesktopBridge to true", () => {
		const data = makeData({
			variables: [
				{ id: "v1", name: "a/b", description: "x", resolvedType: "COLOR" },
				{ id: "v2", name: "c/d", description: "x", resolvedType: "COLOR" },
				{ id: "v3", name: "e.f", description: "x", resolvedType: "COLOR" },
			],
		});

		const fixes = generateAllFixes(data);
		const fix = fixes.get("consistency-delimiter")!;

		expect(fix.requiresDesktopBridge).toBe(true);
	});
});
