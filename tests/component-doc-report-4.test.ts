/**
 * figma_generate_component_doc — fourth report from Robin Di Capua (v1.40.6),
 * both about how clearly the Color Tokens table reads.
 */

import { collectAllVariantData, generateVisualSpecsSection } from "../src/core/design-code-tools";

const names = new Map([["v-focus", "Border/Focus"], ["v-sel", "Border/Selected"]]);
const BLUE = { r: 0, g: 0.4, b: 1 };
const RED = { r: 1, g: 0, b: 0 };
const solid = (color: any, id?: string) => ({ type: "SOLID", color, ...(id ? { boundVariables: { color: { id } } } : {}) });

/** A tab instance: the selected one has a bottom underline; each carries a hidden focus ring */
const tab = (name: string, selected: boolean, ringColor = BLUE) => ({
	name, type: "INSTANCE", componentId: selected ? "c-sel" : "c-unsel",
	componentProperties: { "Is Selected": { type: "VARIANT", value: selected ? "True" : "False" } },
	...(selected ? { strokes: [solid(BLUE, "v-sel")], individualStrokeWeights: { top: 0, right: 0, bottom: 4, left: 0 } } : {}),
	children: [
		{ name: "Focus Ring", type: "RECTANGLE", visible: false, componentPropertyReferences: { visible: "Is Focused#1:1" }, strokes: [solid(ringColor, "v-focus")] },
	],
});

/** The tab bar is the parent: two variants, each nesting the same tabs */
const bar = (ringInScrollable = BLUE) => ({
	name: "Tabs", type: "COMPONENT_SET",
	children: [
		{ name: "Is scrollable=False", type: "COMPONENT", children: [tab("Tab 1", true), tab("Tab 2", false)] },
		{ name: "Is scrollable=True", type: "COMPONENT", children: [tab("Tab 1", true, ringInScrollable), tab("Tab 2", false, ringInScrollable)] },
	],
});
// As REST delivers it: instances point at variant components of the "Tab Item" set
const lookup = { components: { "c-sel": { name: "Is Selected=True", componentSetId: "s-tab" }, "c-unsel": { name: "Is Selected=False", componentSetId: "s-tab" } }, componentSets: { "s-tab": { name: "Tab Item" } } };
const doc = (set: any) => generateVisualSpecsSection(set.children[0], null, collectAllVariantData(set, names, lookup), names, set);

describe("a property-controlled layer identical in every variant is printed once, under the property", () => {
	it("REPORTED: the focus ring appears once, not under each parent variant", () => {
		const md = doc(bar());
		expect(md.match(/Stroke \(Focus Ring\)/g)).toHaveLength(1);
		expect(md).toContain("| **When Tab Item's Is Focused = true** _(every variant; hidden otherwise)_ | | |");
		expect(md).toContain("| Stroke (Focus Ring) | `Border/Focus` |");
		// the hoisted block comes after the variant blocks
		expect(md.indexOf("When Tab Item's Is Focused")).toBeGreaterThan(md.indexOf("**Is scrollable=True**"));
	});

	it("…but stays with each variant when it differs between them (the difference is information)", () => {
		const md = doc(bar(RED));
		expect(md).not.toContain("When Is Focused");
		expect(md.match(/Stroke \(Focus Ring[^)]*\) _\(hidden — shown when Tab Item's Is Focused = true\)_/g)!.length).toBeGreaterThanOrEqual(2);
	});

	it("a plain hidden layer (no controlling property) is never hoisted", () => {
		const plain = bar();
		for (const v of plain.children) for (const t of v.children as any[]) delete t.children[0].componentPropertyReferences;
		const md = doc(plain);
		expect(md).not.toContain("When ");
		expect(md).toContain("_(hidden layer)_");
	});
});

describe("stroke and fill rows are qualified the way text rows are", () => {
	it("REPORTED: the selected tab's underline carries the instance's variant", () => {
		expect(doc(bar())).toContain("| Stroke (Tab 1 (Is Selected=True)) | `Border/Selected` |");
	});

	it("same-named fills inside different instances are told apart when their colors differ", () => {
		const chip = (sel: boolean) => ({
			name: "Chip", type: "INSTANCE", componentProperties: { Selected: { type: "VARIANT", value: sel ? "Yes" : "No" } },
			children: [{ name: "Dot", type: "ELLIPSE", fills: [solid(sel ? BLUE : RED)] }],
		});
		const set = { name: "Group", type: "COMPONENT_SET", children: [{ name: "A=1", type: "COMPONENT", children: [chip(true), chip(false)] }] };
		const md = doc(set);
		expect(md).toContain("| Fill (Dot in Chip (Selected=Yes)) |");
		expect(md).toContain("| Fill (Dot in Chip (Selected=No)) |");
	});
});

describe("live-found: a nested component's property is named with its owner", () => {
	it("a layer inside a nested instance says whose property shows it", () => {
		const md = doc(bar());
		expect(md).not.toMatch(/When Is Focused = true/); // would read as the tab bar's own property
		expect(md).toContain("When Tab Item's Is Focused = true");
	});

	it("a layer directly in the documented component keeps the bare property name", () => {
		const own = { name: "Tab Item", type: "COMPONENT_SET", children: ["A", "B"].map((n) => ({ name: `State=${n}`, type: "COMPONENT", children: [
			{ name: "Focus Ring", type: "RECTANGLE", visible: false, componentPropertyReferences: { visible: "Is Focused#1:1" }, strokes: [solid(BLUE, "v-focus")] },
		] })) };
		expect(doc(own)).toContain("| **When Is Focused = true** _(every variant; hidden otherwise)_ | | |");
	});
});
