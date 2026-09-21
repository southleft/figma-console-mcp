/**
 * figma_generate_component_doc — fidelity on harder components.
 *
 * Second report from Robin Di Capua (after v1.40.1), found by running the tool
 * across tabs / scrollable containers and checking every claim against the
 * file. Each case is modeled structurally on his description.
 */

import {
	cleanVariantName,
	collectAllVariantData,
	collectSpacingAcrossVariants,
	collectTypographyAcrossVariants,
	countPossiblyTruncated,
	describeStrokeWeight,
	buildAnatomyTree,
	buildVariableNameMap,
	generateAnatomySection,
	generateFrontmatter,
	generateOverviewSection,
	generateParitySection,
	generateStatesAndVariantsSection,
	generateTypographySection,
	generateVisualSpecsSection,
	DOC_TREE_DEPTH,
} from "../src/core/design-code-tools";

const BLUE = { r: 0, g: 0.443, b: 0.922 }; // #0071EB
const solid = (color: any, varId?: string) => ({ type: "SOLID", color, ...(varId ? { boundVariables: { color: { id: varId } } } : {}) });
const names = new Map([["v-focus", "Border/Interactive Focused"]]);

const text = (weight: number, extra: any = {}) => ({
	name: "Label", type: "TEXT",
	style: { fontFamily: "GYG Sans VF", fontWeight: weight, fontSize: 16, lineHeightPx: 24, letterSpacing: 0 },
	fills: [solid({ r: 0.1, g: 0.1, b: 0.1 })],
	...extra,
});

/** Tab item: bottom-only underline, hidden focus ring sharing the underline's color */
const tabItem = (name: string, bottom: number, scalar: number, weight: number) => ({
	name, type: "COMPONENT",
	layoutMode: "HORIZONTAL", paddingLeft: 8, paddingRight: 8,
	strokes: [solid(BLUE, "v-focus")],
	strokeWeight: scalar,
	individualStrokeWeights: { top: 0, right: 0, bottom, left: 0 },
	children: [
		text(weight),
		{ name: "Focus Ring", type: "RECTANGLE", visible: false, strokes: [solid(BLUE, "v-focus")], strokeWeight: 2 },
	],
});
const tabSet = {
	name: "Tab Item", type: "COMPONENT_SET",
	children: [
		tabItem("State=Default, Is Selected=True", 4, 2, 600),
		tabItem("State=Default, Is Selected=False", 2, 1, 400),
		tabItem("State=Hover, Is Selected=False", 2, 1, 400),
		tabItem("State=Hover, Is Selected=True", 4, 2, 600),
	],
};

describe("1 — hidden layers are labeled, not presented as if they render", () => {
	const data = collectAllVariantData(tabSet, names);
	const md = generateVisualSpecsSection(tabSet.children[0], null, data, names, tabSet);
	const firstBlock = md.split("| **")[1];

	it("distinguishes the visible underline from the hidden focus ring sharing its color", () => {
		expect(firstBlock).toContain("| Stroke | `Border/Interactive Focused` | #0071EB |");
		expect(firstBlock).toContain("| Stroke (Focus Ring) _(hidden layer)_ | `Border/Interactive Focused` | #0071EB |");
	});

	it("dedupes stroke and text rows like fill rows", () => {
		const twoRings = { ...tabSet.children[0], children: [...tabSet.children[0].children, tabSet.children[0].children[1]] };
		const out = generateVisualSpecsSection(twoRings, null, collectAllVariantData(twoRings, names), names);
		expect(out.match(/Stroke \(Focus Ring\)/g)).toHaveLength(1);
	});

	it("never lets a hidden layer stand in for the rendered text color in the matrix", () => {
		const v = {
			name: "Chip", type: "COMPONENT", componentPropertyDefinitions: { Variant: { type: "VARIANT", variantOptions: ["A"] } },
			children: [text(400, { name: "Ghost", visible: false, fills: [solid(BLUE)] }), text(400, { name: "Real", fills: [solid({ r: 1, g: 0, b: 0 })] })],
		};
		const md2 = generateStatesAndVariantsSection(v, collectAllVariantData(v, names));
		expect(md2).toContain("#FF0000");
		expect(md2).not.toMatch(/\| \*\*Chip\*\* .*#0071EB/);
	});

	it("propagates hidden-ness from a hidden parent to everything beneath it", () => {
		const v = { name: "X", type: "COMPONENT", children: [{ name: "Group", type: "FRAME", visible: false, children: [{ name: "Dot", type: "ELLIPSE", fills: [solid(BLUE)] }] }] };
		expect(collectAllVariantData(v, names)[0].descendantFills[0].hidden).toBe(true);
	});
});

describe("2 — border width reports what renders (individualStrokeWeights)", () => {
	it("reports the per-side weight, not the vestigial scalar", () => {
		const row = collectSpacingAcrossVariants(tabSet).rows.find((r) => r.property === "Border width")!;
		expect(row.valueCell).toBe("varies by **Is Selected**: True 4px bottom · False 2px bottom");
		expect(row.valueCell).not.toContain("1px");
	});

	it("describes uniform, one-sided and mixed weights", () => {
		const stroke = { strokes: [solid(BLUE)] };
		expect(describeStrokeWeight({ ...stroke, strokeWeight: 2 })).toBe(2);
		expect(describeStrokeWeight({ ...stroke, strokeWeight: 1, individualStrokeWeights: { top: 3, right: 3, bottom: 3, left: 3 } })).toBe(3);
		expect(describeStrokeWeight({ ...stroke, strokeWeight: 1, individualStrokeWeights: { top: 0, right: 0, bottom: 4, left: 0 } })).toBe("4px bottom");
		expect(describeStrokeWeight({ ...stroke, individualStrokeWeights: { top: 1, right: 2, bottom: 3, left: 4 } })).toBe("1px / 2px / 3px / 4px (top / right / bottom / left)");
	});

	it("omits border width entirely where no stroke is painted (REST reports strokeWeight: 1 on everything)", () => {
		const set = { type: "COMPONENT_SET", children: [{ name: "A=1", strokeWeight: 1, strokes: [] }, { name: "A=2", strokeWeight: 1 }] };
		expect(collectSpacingAcrossVariants(set).rows.find((r) => r.property === "Border width")).toBeUndefined();
	});
});

describe("3 — typography is compared across variants", () => {
	it("reports both weights, scoped by the property that drives them", () => {
		const rows = collectTypographyAcrossVariants(tabSet);
		expect(rows.map((r) => [r.style.fontWeight, r.scope])).toEqual([
			[600, "Is Selected=True"],
			[400, "Is Selected=False"],
		]);
	});

	it("one unscoped row when every variant agrees", () => {
		const set = { type: "COMPONENT_SET", children: [tabItem("A=1", 2, 1, 400), tabItem("A=2", 2, 1, 400)] };
		const rows = collectTypographyAcrossVariants(set);
		expect(rows).toHaveLength(1);
		expect(rows[0].scope).toBe("");
	});

	it("says where an element exists when only some variants have it", () => {
		const bare = { name: "Has label=False", type: "COMPONENT", children: [] };
		const set = { type: "COMPONENT_SET", children: [{ ...tabItem("Has label=True", 2, 1, 400) }, bare] };
		expect(collectTypographyAcrossVariants(set)[0].scope).toBe("Has label=True");
	});
});

describe("5 — non-solid paints are named, not dropped", () => {
	it("reports a gradient fill with its stops", () => {
		const v = {
			name: "Tabs", type: "COMPONENT", children: [{
				name: "Overflow Fade Hint", type: "RECTANGLE",
				fills: [{ type: "GRADIENT_LINEAR", gradientStops: [{ color: { r: 1, g: 1, b: 1, a: 0 }, position: 0 }, { color: { r: 1, g: 1, b: 1, a: 1 }, position: 1 }] }],
			}],
		};
		const md = generateVisualSpecsSection(v, null, collectAllVariantData(v, names), names);
		expect(md).toContain("| Fill (Overflow Fade Hint) | — | linear gradient (2 stops: #FFFFFF00 → #FFFFFF) |");
	});

	it("treats a gradient on the variant root as its background, and ignores invisible paints", () => {
		const v = { name: "Hero", type: "COMPONENT", fills: [{ type: "GRADIENT_RADIAL", gradientStops: [] }, { type: "IMAGE", visible: false }], children: [] };
		const [d] = collectAllVariantData(v, names);
		expect(d.fills.map((f) => f.hex)).toEqual(["radial gradient (0 stops)"]);
	});
});

describe("6 — a bare boolean is not a variant name", () => {
	it("keeps the property name next to boolean-like values only", () => {
		expect(cleanVariantName("Is scrollable=False")).toBe("Is scrollable=False");
		expect(cleanVariantName("State=Hover, Is Selected=True")).toBe("Hover / Is Selected=True");
		expect(cleanVariantName("Variant=Danger")).toBe("Danger");
		expect(cleanVariantName("Size=lg, Disabled=yes")).toBe("lg / Disabled=yes");
	});
});

describe("7 — the properties table", () => {
	const tabs = {
		name: "Tabs", type: "COMPONENT_SET",
		componentPropertyDefinitions: {
			"Is scrollable": { type: "VARIANT", defaultValue: "False", variantOptions: ["False", "True"] },
			"Tab List#64630:9": { type: "SLOT", defaultValue: { guid: {} }, preferredValues: [] },
			"Panel#64630:10": { type: "SLOT", preferredValues: [{ type: "COMPONENT", key: "k" }], description: "The active panel" },
		},
	};
	const md = generateStatesAndVariantsSection(tabs, []);

	it("renders for a set whose properties are all VARIANT (the guard used to skip it)", () => {
		expect(md).toContain("### Configurable Properties");
		expect(md).toContain("| **Is scrollable** |");
	});

	it("lists SLOT properties — for a compositional component they are the API", () => {
		expect(md).toContain("| **Tab List** | `slot` | — | Accepts nested content for tab list |");
		expect(md).toContain("| **Panel** | `slot` | — | The active panel (1 preferred values) |");
	});
});

describe("8 — reaching the extraction depth limit is reported", () => {
	const nest = (levels: number): any => levels === 0
		? { name: "Deep", type: "FRAME", children: [] }
		: { name: `L${levels}`, type: "FRAME", children: [nest(levels - 1)] };

	it("flags an empty container sitting exactly at the limit (REST cuts trees off as children: [])", () => {
		expect(countPossiblyTruncated(nest(DOC_TREE_DEPTH))).toBe(1);
	});

	it("stays quiet for trees that end before the limit, and for leaf layers at it", () => {
		expect(countPossiblyTruncated(nest(DOC_TREE_DEPTH - 1))).toBe(0);
		const leafAtLimit = JSON.parse(JSON.stringify(nest(DOC_TREE_DEPTH)).replace('"name":"Deep","type":"FRAME"', '"name":"Deep","type":"TEXT"'));
		expect(countPossiblyTruncated(leafAtLimit)).toBe(0);
	});
});

describe("minor", () => {
	it("reports zero padding on an auto-layout component instead of omitting it", () => {
		const set = { type: "COMPONENT_SET", children: [{ name: "A=1", layoutMode: "HORIZONTAL", paddingRight: 8, paddingLeft: 8 }, { name: "A=2", layoutMode: "HORIZONTAL", paddingRight: 8, paddingLeft: 8 }] };
		const rows = collectSpacingAcrossVariants(set).rows;
		expect(rows.find((r) => r.property === "Padding top")).toMatchObject({ valueCell: "0px" });
		expect(rows.find((r) => r.property === "Gap")).toMatchObject({ valueCell: "0px" });
	});

	it("does not invent padding rows for a node with no auto-layout", () => {
		const set = { type: "COMPONENT_SET", children: [{ name: "A=1", cornerRadius: 4 }, { name: "A=2", cornerRadius: 4 }] };
		expect(collectSpacingAcrossVariants(set).rows.map((r) => r.property)).toEqual(["Border radius"]);
	});
});

describe("4 — anatomy shows every distinct layer structure, not one variant's", () => {
	const list = { name: "Tab List", type: "FRAME", children: [{ name: "Tab", type: "INSTANCE", children: [] }] };
	const tabs = {
		name: "Tabs", type: "COMPONENT_SET",
		children: [
			{ name: "Is scrollable=False", type: "COMPONENT", children: [list] },
			{
				name: "Is scrollable=True", type: "COMPONENT", children: [
					{ name: "Scroller", type: "FRAME", children: [{ name: "Scroll Content", type: "FRAME", children: [list] }] },
					{ name: "Overflow Fade Hint", type: "RECTANGLE" },
				],
			},
		],
	};
	const md = generateAnatomySection(tabs);

	it("emits one tree per structure, headed by the property that decides it", () => {
		expect(md).toContain("2 variants share 2 distinct layer structures");
		expect(md).toContain("**Is scrollable=False** (1 variant)");
		expect(md).toContain("**Is scrollable=True** (1 variant)");
		expect(md).toContain("Scroll Content");
		expect(md).toContain("Overflow Fade Hint");
	});

	it("names the variants with their property, not a bare 'False'", () => {
		expect(md).toContain("- Is scrollable=False");
		expect(md).not.toMatch(/^- False$/m);
	});

	it("still emits a single tree when every variant is built the same way", () => {
		const out = generateAnatomySection(tabSet);
		expect(out).not.toContain("distinct layer structures");
		expect(out.match(/```/g)).toHaveLength(2);
		expect(out).toContain("Focus Ring (RECTANGLE) (hidden)");
	});

	it("explains structure by ONE property across a larger matrix", () => {
		const v = (name: string, scroll: boolean) => ({ name, type: "COMPONENT", children: scroll ? [{ name: "Scroller", type: "FRAME", children: [list] }] : [list] });
		const set = { name: "Tabs", type: "COMPONENT_SET", children: [v("Size=sm, Scroll=False", false), v("Size=lg, Scroll=False", false), v("Size=sm, Scroll=True", true), v("Size=lg, Scroll=True", true)] };
		const out = generateAnatomySection(set);
		expect(out).toContain("decided by **Scroll**");
		expect(out).toContain("**Scroll=True** (2 variants)");
	});
});

describe("3 (rendering) — typography table", () => {
	it("adds an 'Applies to' column only when styles differ between variants", () => {
		const md = generateTypographySection(tabSet);
		expect(md).toContain("| Label | GYG Sans VF | SemiBold (600) | 16px | 24px | 0 | Is Selected=True |");
		expect(md).toContain("| Label | GYG Sans VF | Regular (400) | 16px | 24px | 0 | Is Selected=False |");
		const uniform = { type: "COMPONENT_SET", children: [tabItem("A=1", 2, 1, 400), tabItem("A=2", 2, 1, 400)] };
		expect(generateTypographySection(uniform)).not.toContain("Applies to");
	});
});

describe("minor — nothing is asserted that isn't known", () => {
	const node = { type: "COMPONENT", name: "Badge" };

	it("omits status, version and description from frontmatter when none is known", () => {
		const fm = generateFrontmatter("Badge", "", node, null, "https://figma.com/x");
		expect(fm).not.toContain("status:");
		expect(fm).not.toContain("version:");
		expect(fm).not.toContain("description:");
		expect(fm).toContain("title: Badge");
	});

	it("still emits them when they ARE known", () => {
		const fm = generateFrontmatter("Badge", "A small status label. More text.", node, { description: "Deprecated — use Tag" }, "https://figma.com/x");
		expect(fm).toContain("status: deprecated");
		expect(fm).toContain("description: A small status label.");
		const withCode = generateFrontmatter("Badge", "", node, null, "u", { changelog: [{ version: "2.3.0", date: "2026-01-01", changes: "x" }] } as any);
		expect(withCode).toContain("status: stable");
		expect(withCode).toContain("version: 2.3.0");
	});

	it("writes no filler sentence when the Figma description is empty", () => {
		const parsed = { overview: "", whenToUse: [], whenNotToUse: [], contentGuidelines: [], accessibilityNotes: [], additionalNotes: [] };
		const md = generateOverviewSection("Badge", "", "https://figma.com/x", parsed as any);
		expect(md).not.toContain("The Badge component.");
	});

	it("qualifies a variable name with its collection only on a real collision", () => {
		const map = buildVariableNameMap(
			[
				{ id: "1", name: "Primitive/2x", variableCollectionId: "c-space" },
				{ id: "2", name: "Primitive/2x", variableCollectionId: "c-radius" },
				{ id: "3", name: "Label/Primary", variableCollectionId: "c-color" },
			],
			[{ id: "c-space", name: "Spacing" }, { id: "c-radius", name: "Radius" }, { id: "c-color", name: "Color" }],
		);
		expect(map.get("1")).toBe("Spacing/Primitive/2x");
		expect(map.get("2")).toBe("Radius/Primitive/2x");
		expect(map.get("3")).toBe("Label/Primary");
	});
});

describe("sweep — parity compares property VALUES, never a property name", () => {
	const set = { type: "COMPONENT_SET", children: [{ name: "Size=sm, State=default" }, { name: "Size=lg, State=hover" }] };

	it("no longer reports the property NAME 'Size' as a Figma-only variant", () => {
		const md = generateParitySection(set, { props: [{ name: "variant", type: '"primary" | "ghost"' }] } as any);
		expect(md).not.toMatch(/\| Size \|/);
	});

	it("compares each property with the code prop of the same name", () => {
		const md = generateParitySection(set, { props: [{ name: "size", type: '"sm" | "md" | "lg"' }] } as any);
		expect(md).toContain("| Size: sm | Yes | Yes | In sync |");
		expect(md).toContain("| Size: md | **No** | Yes | Code-only — needs Figma variant |");
		expect(md).not.toContain("State:"); // no code counterpart → no claim
	});

	it("keeps the classic single 'Variant' output unchanged", () => {
		const v = { type: "COMPONENT_SET", children: [{ name: "Variant=Default" }, { name: "Variant=Danger" }] };
		const md = generateParitySection(v, { props: [{ name: "variant", type: '"default" | "success"' }] } as any);
		expect(md).toContain("| Default | Yes | Yes | In sync |");
		expect(md).toContain("| Danger | Yes | **No** | Figma-only — needs code variant |");
		expect(md).toContain("| success | **No** | Yes | Code-only — needs Figma variant |");
	});
});

describe("found in review of this fix", () => {
	it("a label hidden in ONE variant is not reported as plain 'all variants'", () => {
		const shown = tabItem("Show label=True", 2, 1, 400);
		const hiddenLabel = { ...tabItem("Show label=False", 2, 1, 400), children: [text(400, { visible: false })] };
		const rows = collectTypographyAcrossVariants({ type: "COMPONENT_SET", children: [shown, hiddenLabel] });
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.style.hidden)!.scope).toBe("Show label=False");
		expect(rows.find((r) => !r.style.hidden)!.scope).toBe("Show label=True");
	});

	it("documents shadows, blurs and opacity instead of implying the component is flat", () => {
		const card = {
			name: "Card", type: "COMPONENT", fills: [solid({ r: 1, g: 1, b: 1 })],
			effects: [
				{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0 },
				{ type: "DROP_SHADOW", visible: false, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 9 }, radius: 9 },
			],
			children: [{ name: "Scrim", type: "RECTANGLE", opacity: 0.5, effects: [{ type: "BACKGROUND_BLUR", radius: 12 }] }],
		};
		const md = generateVisualSpecsSection(card, null, collectAllVariantData(card, names), names);
		expect(md).toContain("| Effect | — | drop shadow: x 0 · y 2 · blur 4 · spread 0 · #00000040 |");
		expect(md).toContain("| Effect (Scrim) | — | background blur 12px |");
		expect(md).toContain("| Effect (Scrim) | — | opacity 50% |");
		expect(md).not.toContain("y 9"); // invisible effect
	});

	it("shows EVERY icon in a variant, not only the first", () => {
		const chip = {
			name: "Chip", type: "COMPONENT_SET",
			componentPropertyDefinitions: { Variant: { type: "VARIANT", variantOptions: ["A"] } },
			children: [{ name: "Variant=A", type: "COMPONENT", children: [
				{ name: "Leading icon", type: "INSTANCE" }, { name: "Label", type: "TEXT" }, { name: "Trailing icon", type: "INSTANCE", visible: false },
			] }],
		};
		const md = generateStatesAndVariantsSection(chip, collectAllVariantData(chip, names));
		expect(md).toContain("Leading icon; Trailing icon _(hidden in this variant)_");
	});

	it("flags a text layer that mixes styles rather than presenting its base style as the whole truth", () => {
		const v = { name: "Note", type: "COMPONENT", children: [text(400, { characterStyleOverrides: [0, 0, 5, 5, 0], styleOverrideTable: { 5: { fontWeight: 700 } } })] };
		expect(generateTypographySection(v)).toContain("Label _(mixed styles — base style shown)_");
	});

	it("reports truncation against the depth ACTUALLY fetched when the deep fetch falls back", () => {
		const nest = (levels: number): any => levels === 0 ? { name: "Deep", type: "FRAME", children: [] } : { name: `L${levels}`, type: "FRAME", children: [nest(levels - 1)] };
		const md = generateAnatomySection({ name: "C", type: "COMPONENT", children: [nest(3)] }, 4);
		expect(md).toContain("depth limit of this extraction (4 levels)");
		expect(generateAnatomySection({ name: "C", type: "COMPONENT", children: [nest(3)] })).not.toContain("depth limit");
	});
});

describe("found by LIVE testing on a hard component (CBDS Navigation-Side)", () => {
	it("labels sizing by the layout's real axes — a vertical layout's primary axis is HEIGHT", () => {
		const sidebar = { name: "Side", type: "FRAME", layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED", children: [] };
		expect(buildAnatomyTree(sidebar)).toContain("[hug-content, fixed-width]");
		const row = { ...sidebar, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED" };
		expect(buildAnatomyTree(row)).toContain("[fixed-width, fixed-height]");
	});

	it("collapses runs of identical siblings, but keeps one that prints differently", () => {
		const item = (caretHidden: boolean) => ({ name: "Nav item", type: "INSTANCE", children: [{ name: "Label", type: "TEXT" }, { name: "Caret", type: "VECTOR", visible: !caretHidden }] });
		const tree = buildAnatomyTree({ name: "Menu", type: "FRAME", children: [item(true), item(true), item(false), item(true), item(true), item(true)] });
		expect(tree).toContain("Nav item (INSTANCE) ×2");
		expect(tree).toContain("Nav item (INSTANCE) ×3");
		expect(tree.match(/Nav item \(INSTANCE\)/g)).toHaveLength(3); // 2 + the odd one + 3
	});

	it("names the glyph inside a generic icon wrapper, and groups repeats instead of listing 23 icons", () => {
		const lookup = { components: { w: { name: "Size=small", componentSetId: "s" }, g1: { name: "MagnifyingGlass" }, g2: { name: "CaretDown" } }, componentSets: { s: { name: "Icon" } } };
		const icon = (glyph: string, visible = true) => ({ name: "Icon", type: "INSTANCE", componentId: "w", visible, children: [{ name: glyph, type: "INSTANCE", componentId: glyph === "MagnifyingGlass" ? "g1" : "g2", children: [] }] });
		const nav = {
			name: "Nav", type: "COMPONENT_SET", componentPropertyDefinitions: { open: { type: "VARIANT", variantOptions: ["true"] } },
			children: [{ name: "open=true", type: "COMPONENT", children: [icon("MagnifyingGlass"), icon("CaretDown"), icon("CaretDown", false), icon("CaretDown", false)] }],
		};
		const md = generateStatesAndVariantsSection(nav, collectAllVariantData(nav, names, lookup), lookup);
		expect(md).toContain("| MagnifyingGlass; CaretDown ×3 _(2 hidden)_ |");
		const allHidden = { ...nav, children: [{ name: "open=true", type: "COMPONENT", children: [icon("CaretDown", false), icon("CaretDown", false)] }] };
		expect(generateStatesAndVariantsSection(allHidden, collectAllVariantData(allHidden, names, lookup), lookup)).toContain("| CaretDown ×2 _(all hidden)_ |");
		expect(md).not.toContain("Icon (small)");
	});

	it("lists an (element, style) once with ONE scope, however many times the layer repeats", () => {
		const badge = (hidden: boolean) => text(600, { name: "text-8", visible: !hidden });
		const open = { name: "open=true", type: "COMPONENT", children: [badge(true), badge(true), badge(false), text(400, { name: "Menu item" })] };
		const closed = { name: "open=false", type: "COMPONENT", children: [badge(true), badge(true)] };
		const rows = collectTypographyAcrossVariants({ type: "COMPONENT_SET", children: [open, closed] });
		const label = (r: any) => `${r.style.nodeName}${r.style.hidden ? " (hidden)" : ""} → ${r.scope || "all"}`;
		expect(rows.map(label)).toEqual(["text-8 (hidden) → all", "text-8 → open=true", "Menu item → open=true"]);
	});

	it("rounds scaled effect values and leaves no orphaned Overview heading", () => {
		const v = { name: "Logo", type: "COMPONENT", effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.12 }, offset: { x: 0, y: 0.39000001549720764 }, radius: 1.5600000619888306 }], children: [] };
		const md = generateVisualSpecsSection(v, null, collectAllVariantData(v, names), names);
		expect(md).toContain("drop shadow: x 0 · y 0.39 · blur 1.56 · spread 0 · #0000001F");
		const parsed = { overview: "", whenToUse: [], whenNotToUse: [], contentGuidelines: [], accessibilityNotes: [], additionalNotes: [] };
		expect(generateOverviewSection("Logo", "", "https://figma.com/x", parsed as any)).not.toContain("## Overview");
		expect(generateOverviewSection("Logo", "A mark.", "https://figma.com/x", { ...parsed, overview: "A mark." } as any)).toContain("## Overview");
	});
});
