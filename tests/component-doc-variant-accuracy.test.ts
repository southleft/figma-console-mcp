/**
 * Regression tests for figma_generate_component_doc accuracy across variants.
 *
 * Modeled on a real 2×5 badge set (Variant × Appearance) reported against
 * v1.40.0: outlined variants with a transparent container, an icon slot named
 * "Leading Modifier" driven by an INSTANCE_SWAP property, and a stray 55px /
 * 194px unbound padding on two variants while the other eight bind a variable.
 */

import {
	collectAllVariantData,
	collectSpacingAcrossVariants,
	generateStatesAndVariantsSection,
	generateVisualSpecsSection,
	parseVariantProperties,
	resolveMainComponentName,
	type ComponentLookup,
} from "../src/core/design-code-tools";

const NAVY = { r: 0.102, g: 0.169, b: 0.286 }; // #1A2B49
const RED = { r: 0.78, g: 0.165, b: 0.239 };
const WHITE = { r: 1, g: 1, b: 1 };

const solid = (color: any, varId?: string) => ({
	type: "SOLID",
	color,
	...(varId ? { boundVariables: { color: { id: varId } } } : {}),
});

const lookup: ComponentLookup = {
	components: {
		"10:1": { name: "features / ticket-checkmark" },
		"10:2": { name: "Size=16", componentSetId: "20:1" },
	},
	componentSets: { "20:1": { name: "glyph / warning" } },
};

const varNameMap = new Map([
	["v-label-primary", "Label/Primary"],
	["v-label-critical", "Label/Critical"],
	["v-bg-primary", "Surface/Primary"],
	["v-space-0", "spacing/0"],
]);

/** Icon slot: neutral layer name, wired to the "Modifier" instance-swap property */
const iconSlot = (componentId: string, color: any, varId: string) => ({
	name: "Leading Modifier",
	type: "INSTANCE",
	componentId,
	componentPropertyReferences: { mainComponent: "Modifier#4021:7" },
	absoluteBoundingBox: { x: 4, y: 4, width: 16, height: 16 },
	children: [
		{ name: "Vector", type: "VECTOR", fills: [solid(color, varId)] },
		{ name: "Vector", type: "VECTOR", fills: [solid(color, varId)] },
	],
});

const label = (color: any, varId: string) => ({
	name: "Label",
	type: "TEXT",
	fills: [solid(color, varId)],
});

function badgeVariant(name: string, opts: { filled: boolean; color: any; varId: string; extra?: any }) {
	return {
		name,
		type: "COMPONENT",
		absoluteBoundingBox: { x: 0, y: 0, width: 80, height: 24 },
		fills: opts.filled ? [solid(opts.color, "v-bg-primary")] : [],
		paddingLeft: 8,
		paddingRight: 8,
		itemSpacing: 4,
		boundVariables: { paddingTop: { type: "VARIABLE_ALIAS", id: "v-space-0" } },
		children: [
			iconSlot("10:1", opts.filled ? WHITE : opts.color, opts.varId),
			label(opts.filled ? WHITE : opts.color, opts.varId),
		],
		...opts.extra,
	};
}

const badgeSet = {
	name: "Badge",
	type: "COMPONENT_SET",
	componentPropertyDefinitions: {
		Variant: { type: "VARIANT", defaultValue: "Primary", variantOptions: ["Primary", "Secondary"] },
		Appearance: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Critical"] },
		"Modifier#4021:7": { type: "INSTANCE_SWAP", defaultValue: "10:1", preferredValues: [{ type: "COMPONENT", key: "abc" }] },
		"Show modifier#4021:8": { type: "BOOLEAN", defaultValue: true },
	},
	children: [
		// First child carries the stray, unbound 55px padding
		badgeVariant("Variant=Primary, Appearance=Default", {
			filled: true, color: NAVY, varId: "v-label-primary",
			extra: { paddingTop: 55, boundVariables: {} },
		}),
		badgeVariant("Variant=Primary, Appearance=Critical", { filled: true, color: RED, varId: "v-label-critical" }),
		badgeVariant("Variant=Secondary, Appearance=Default", { filled: false, color: NAVY, varId: "v-label-primary" }),
		badgeVariant("Variant=Secondary, Appearance=Critical", {
			filled: false, color: RED, varId: "v-label-critical",
			extra: { paddingTop: 194, boundVariables: {} },
		}),
	],
};

describe("Issue 1 — descendant fills must never become the Background", () => {
	const data = collectAllVariantData(badgeSet, varNameMap, lookup);
	const secondary = data[2];

	it("reports no background for a transparent variant instead of borrowing the icon's color", () => {
		expect(secondary.variantName).toBe("Variant=Secondary, Appearance=Default");
		expect(secondary.fills).toEqual([]);
		expect(secondary.iconColors[0].variableName).toBe("Label/Primary");
		expect(secondary.textColors[0].variableName).toBe("Label/Primary");
	});

	it("keeps the root fill as the only background on filled variants", () => {
		expect(data[0].fills).toHaveLength(1);
		expect(data[0].fills[0].variableName).toBe("Surface/Primary");
	});

	it("renders '—' in the matrix Background cell, never text-on-same-color", () => {
		const md = generateStatesAndVariantsSection(badgeSet, data, lookup);
		const row = md.split("\n").find((l) => l.startsWith("| **Secondary / Default**"))!;
		const cells = row.split("|").map((c) => c.trim());
		expect(cells[2]).toBe("—"); // Background
		expect(cells[4]).toContain("Label/Primary"); // Text/Icon Color
	});

	it("emits one Background row per filled variant and says 'none' for transparent ones", () => {
		const md = generateVisualSpecsSection(badgeSet.children[0], null, data, varNameMap, badgeSet);
		const blocks = md.split("| **").slice(1);
		const primary = blocks.find((b) => b.startsWith("Primary / Default**"))!;
		expect(primary.match(/\| Background/g)).toHaveLength(1);
		const sec = blocks.find((b) => b.startsWith("Secondary / Default**"))!;
		expect(sec).toContain("| Background | — | none (transparent) |");
		// icon artwork is labeled as such, once, despite two identical vector paths
		expect(sec.match(/\| Icon \(Leading Modifier\)/g)).toHaveLength(1);
	});

	it("labels a non-background inner fill by its layer, not as Background", () => {
		const node = {
			name: "Chip", type: "COMPONENT", fills: [],
			absoluteBoundingBox: { x: 0, y: 0, width: 80, height: 24 },
			children: [{
				name: "Dot", type: "ELLIPSE", fills: [solid(RED)],
				absoluteBoundingBox: { x: 4, y: 8, width: 8, height: 8 },
			}],
		};
		const [d] = collectAllVariantData(node, new Map());
		expect(d.fills).toEqual([]);
		expect(d.descendantFills).toHaveLength(1);
		expect(d.descendantFills[0].nodeName).toBe("Dot");
	});

	it("still recognizes a full-bleed background LAYER under a transparent root", () => {
		const node = {
			name: "Card", type: "COMPONENT", fills: [],
			absoluteBoundingBox: { x: 10, y: 10, width: 200, height: 100 },
			children: [{
				name: "bg", type: "RECTANGLE", fills: [solid(WHITE)],
				absoluteBoundingBox: { x: 10, y: 10, width: 200, height: 100 },
			}],
		};
		const [d] = collectAllVariantData(node, new Map());
		expect(d.fills).toHaveLength(1);
		expect(d.backgroundLayer).toBe("bg");
		expect(d.descendantFills).toEqual([]);
	});
});

describe("Issue 2 — Color Tokens headings name every variant property", () => {
	it("produces distinct headings matching the Variant Matrix", () => {
		const data = collectAllVariantData(badgeSet, varNameMap, lookup);
		const md = generateVisualSpecsSection(badgeSet.children[0], null, data, varNameMap, badgeSet);
		const headings = md.split("\n").filter((l) => /^\| \*\*.+\*\* \| \| \|$/.test(l));
		expect(headings).toEqual([
			"| **Primary / Default** | | |",
			"| **Primary / Critical** | | |",
			"| **Secondary / Default** | | |",
			"| **Secondary / Critical** | | |",
		]);
	});

	it("works when no property is literally named 'Variant'", () => {
		const set = {
			name: "Button", type: "COMPONENT_SET",
			children: [{ name: "Size=lg, State=hover", type: "COMPONENT", fills: [solid(NAVY)], children: [] }],
		};
		const md = generateVisualSpecsSection(set.children[0], null, collectAllVariantData(set, new Map()), new Map(), set);
		expect(md).toContain("| **lg / hover** | | |");
		expect(md).not.toContain("Size=lg");
	});
});

describe("Issue 3 — spacing is compared across variants", () => {
	const comparison = collectSpacingAcrossVariants(badgeSet, varNameMap);
	const row = (p: string) => comparison.rows.find((r) => r.property === p)!;

	it("reports a plain value when every variant agrees", () => {
		expect(row("Gap")).toMatchObject({ uniform: true, valueCell: "4px", variableCell: "—" });
	});

	it("says 'varies' and names the outliers instead of silently picking children[0]", () => {
		const top = row("Padding top");
		expect(top.uniform).toBe(false);
		expect(top.valueCell).toContain("varies");
		expect(top.valueCell).toContain("55px (unbound) — Primary / Default");
		expect(top.valueCell).toContain("194px (unbound) — Secondary / Critical");
		// REST omits zero-valued fields — the two healthy variants compare as 0px
		expect(top.valueCell).toContain("0px (`spacing/0`) — Primary / Critical, Secondary / Default");
		expect(top.variableCell).toBe("`spacing/0`, unbound");
	});

	it("flags a property bound on some variants and hardcoded on others", () => {
		expect(comparison.inconsistencies).toHaveLength(1);
		expect(comparison.inconsistencies[0]).toContain("**Padding top**");
		expect(comparison.inconsistencies[0]).toContain("on 2 of 4 variants");
		expect(comparison.inconsistencies[0]).toContain("Primary / Default (55px)");
	});

	it("explains legitimate variation by the property that drives it", () => {
		const sizes = {
			type: "COMPONENT_SET",
			children: [
				{ name: "Size=sm, State=default", paddingLeft: 8 },
				{ name: "Size=sm, State=hover", paddingLeft: 8 },
				{ name: "Size=lg, State=default", paddingLeft: 16 },
				{ name: "Size=lg, State=hover", paddingLeft: 16 },
			],
		};
		const c = collectSpacingAcrossVariants(sizes);
		expect(c.rows[0].valueCell).toBe("varies by **Size**: sm 8px · lg 16px");
		expect(c.inconsistencies).toEqual([]);
	});

	it("renders the scope note and the inconsistency list in the doc", () => {
		const data = collectAllVariantData(badgeSet, varNameMap, lookup);
		const md = generateVisualSpecsSection(badgeSet.children[0], null, data, varNameMap, badgeSet);
		expect(md).toContain("_Compared across all 4 variants");
		expect(md).toContain("#### Spacing Inconsistencies");
		expect(md).not.toContain("| Padding top | — | 55px |");
	});

	it("states which variant is described when only one is documented", () => {
		const variant = badgeSet.children[1];
		const md = generateVisualSpecsSection(variant, null, collectAllVariantData(variant, varNameMap, lookup), varNameMap);
		expect(md).toContain("_Describes the `Primary / Critical` variant only._");
	});

	it("leaves a plain single COMPONENT's spacing table unchanged", () => {
		const node = { name: "Chip", type: "COMPONENT", paddingLeft: 8, children: [] };
		const md = generateVisualSpecsSection(node, null, collectAllVariantData(node, new Map()), new Map());
		expect(md).toContain("| Padding left | — | 8px |");
		expect(md).not.toContain("variant only");
		expect(md).not.toContain("Compared across");
	});
});

describe("Issue 4 — icons are resolved from the main component, not the layer name", () => {
	const data = collectAllVariantData(badgeSet, varNameMap, lookup);

	it("detects an instance-swap icon slot whose layer name never says 'icon'", () => {
		expect(data.every((v) => v.icons.length === 1)).toBe(true);
		expect(data[0].icons[0]).toMatchObject({
			name: "features / ticket-checkmark",
			layerName: "Leading Modifier",
			swapProperty: "Modifier",
		});
	});

	it("shows the Icon column + mapping, flagged as a swappable default", () => {
		const md = generateStatesAndVariantsSection(badgeSet, data, lookup);
		expect(md).toContain("### Icon Mapping");
		expect(md).toContain("features / ticket-checkmark _(default — swappable via **Modifier**)_");
	});

	it("lists INSTANCE_SWAP properties under Configurable Properties", () => {
		const md = generateStatesAndVariantsSection(badgeSet, data, lookup);
		expect(md).toContain("| **Modifier** | `instance swap` | `features / ticket-checkmark` |");
		expect(md).toContain("1 preferred values");
	});

	it("names variant icons as 'Set (Value)' rather than a bare 'Size=16'", () => {
		expect(resolveMainComponentName("10:2", lookup)).toBe("glyph / warning (16)");
		expect(resolveMainComponentName("missing", lookup)).toBeUndefined();
	});

	it("does not treat a large swap slot (e.g. card media) as an icon", () => {
		const node = {
			name: "Card", type: "COMPONENT", children: [{
				name: "Media", type: "INSTANCE", componentId: "10:1",
				componentPropertyReferences: { mainComponent: "Media#1:1" },
				absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 180 },
			}],
		};
		expect(collectAllVariantData(node, new Map(), lookup)[0].icons).toEqual([]);
	});

	it("reports a nested icon once, not once per nested instance", () => {
		const node = {
			name: "Btn", type: "COMPONENT", children: [{
				name: "Icon / Wrapper", type: "INSTANCE",
				children: [{ name: "icon-inner", type: "INSTANCE", children: [] }],
			}],
		};
		expect(collectAllVariantData(node, new Map())[0].icons).toHaveLength(1);
	});

	it("falls back to the cleaned layer name when the main component is unknown", () => {
		const node = { name: "Btn", type: "COMPONENT", children: [{ name: "Icon / CircleAlert", type: "INSTANCE" }] };
		expect(collectAllVariantData(node, new Map())[0].icons[0].name).toBe("CircleAlert");
	});
});

describe("Review follow-ups", () => {
	it("compares border radius when every variant uses per-corner radii (no scalar cornerRadius)", () => {
		const set = {
			type: "COMPONENT_SET",
			children: [
				{ name: "Position=top", rectangleCornerRadii: [8, 8, 0, 0] },
				{ name: "Position=bottom", rectangleCornerRadii: [0, 0, 8, 8] },
			],
		};
		const row = collectSpacingAcrossVariants(set).rows.find((r) => r.property === "Border radius")!;
		expect(row).toBeDefined();
		expect(row.valueCell).toContain("8px / 8px / 0px / 0px");
	});

	it("labels each icon's colors with ITS OWN layer, not the first icon's", () => {
		const node = {
			name: "Select", type: "COMPONENT", children: [
				{ name: "Leading icon", type: "INSTANCE", children: [{ name: "v", type: "VECTOR", fills: [solid(NAVY)] }] },
				{ name: "Chevron icon", type: "INSTANCE", children: [{ name: "v", type: "VECTOR", fills: [solid(RED)] }] },
			],
		};
		const data = collectAllVariantData(node, new Map());
		const md = generateVisualSpecsSection(node, null, data, new Map());
		expect(md).toMatch(/\| Icon \(Leading icon\) \| — \| #1A2B49 \|/);
		expect(md).toMatch(/\| Icon \(Chevron icon\) \| — \| #C72A3D \|/);
	});

	it("does not flag a binding split that a variant property fully explains (found live: Badge Shape=Dot has no padding)", () => {
		const bound = { boundVariables: { paddingLeft: { id: "xs" } } };
		const set = {
			type: "COMPONENT_SET",
			children: [
				{ name: "Variant=Danger, Shape=Label", paddingLeft: 8, ...bound },
				{ name: "Variant=Info, Shape=Label", paddingLeft: 8, ...bound },
				{ name: "Variant=Danger, Shape=Dot" },
				{ name: "Variant=Info, Shape=Dot" },
			],
		};
		const c = collectSpacingAcrossVariants(set, new Map([["xs", "space/xs"]]));
		expect(c.rows[0].valueCell).toBe("varies by **Shape**: Label 8px (`space/xs`) · Dot 0px (unbound)");
		expect(c.inconsistencies).toEqual([]);
	});

	it("never calls variation 'explained' when every group is a single variant", () => {
		const bound = { boundVariables: { paddingLeft: { id: "xs" } } };
		const set = {
			type: "COMPONENT_SET",
			children: [
				{ name: "Variant=A", paddingLeft: 8, ...bound },
				{ name: "Variant=B", paddingLeft: 8, ...bound },
				{ name: "Variant=C", paddingLeft: 55 },
			],
		};
		const c = collectSpacingAcrossVariants(set, new Map([["xs", "space/xs"]]));
		expect(c.rows[0].valueCell).not.toContain("varies by");
		expect(c.rows[0].valueCell).toContain("55px (unbound) — C");
		expect(c.inconsistencies).toHaveLength(1);
	});

	it("shows the token when variants share a value but bind different variables", () => {
		const set = {
			type: "COMPONENT_SET",
			children: [
				{ name: "Variant=Primary, State=default", paddingLeft: 8, boundVariables: { paddingLeft: { id: "a" } } },
				{ name: "Variant=Primary, State=hover", paddingLeft: 8, boundVariables: { paddingLeft: { id: "a" } } },
				{ name: "Variant=Secondary, State=default", paddingLeft: 8, boundVariables: { paddingLeft: { id: "b" } } },
				{ name: "Variant=Secondary, State=hover", paddingLeft: 8, boundVariables: { paddingLeft: { id: "b" } } },
			],
		};
		const c = collectSpacingAcrossVariants(set, new Map([["a", "spacing/a"], ["b", "spacing/b"]]));
		expect(c.rows[0].valueCell).toBe("varies by **Variant**: Primary 8px (`spacing/a`) · Secondary 8px (`spacing/b`)");
	});
});

describe("parseVariantProperties", () => {
	it("parses ordered pairs and ignores non-variant names", () => {
		expect(parseVariantProperties("Size=lg, State=hover")).toEqual([["Size", "lg"], ["State", "hover"]]);
		expect(parseVariantProperties("Button")).toEqual([]);
	});
});
