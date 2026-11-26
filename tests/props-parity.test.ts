import { compareComponentProps, indexCem, parseTypeText } from "../src/core/adherence/props-parity";

const attr = (name: string, text: string) => ({ name, fieldName: name, type: { text } });
const cem = {
	modules: [
		{
			declarations: [
				{ name: "ALButton", tagName: "al-button", attributes: [attr("variant", "'primary' | 'neutral' | 'bare'"), attr("size", "'sm' | 'md' | 'lg'"), attr("isPill", "boolean"), attr("isDisabled", "boolean"), attr("hideText", "boolean"), attr("href", "string"), attr("fullWidth", "boolean")], slots: [{ name: "" }, { name: "before" }] },
				{ name: "ALDivider", tagName: "al-divider", attributes: [attr("variant", "'vertical'")], slots: [] },
				{ name: "ALBadge", tagName: "al-badge", attributes: [attr("isDot", "boolean")], slots: [{ name: "" }] },
				{ name: "ALDialog", tagName: "al-dialog", attributes: [attr("triggerHasOwnFocusable", "boolean")], slots: [{ name: "" }, { name: "footer" }] },
				{ name: "ALGroup", tagName: "al-checkbox-group", attributes: [attr("direction", "'row' | 'column'")], slots: [] },
				{ name: "ALInput", tagName: "al-input", attributes: [attr("isError", "boolean"), attr("isDisabled", "boolean"), attr("fieldNote", "string")], slots: [{ name: "field-note" }] },
			],
		},
	],
};
const idx = indexCem(cem, ["AL"]);
const get = (k: string) => idx.get(k)!;

describe("property parity", () => {
	it("parses manifest types", () => {
		expect(parseTypeText("'a' | 'b'")).toEqual({ kind: "enum", values: ["a", "b"] });
		expect(parseTypeText("boolean")).toEqual({ kind: "boolean" });
	});

	it("indexes by tag and by class name without prefix", () => {
		expect(idx.get("button")?.tagName).toBe("al-button");
		expect(idx.get("checkboxgroup")?.tagName).toBe("al-checkbox-group");
	});

	it("maps same-name enums, boolean flags, states and Show toggles; reports the rest", () => {
		const r = compareComponentProps(
			{
				name: "Button",
				variantAxes: [
					{ name: "State", values: ["Default", "Hover", "Focus", "Disabled"] },
					{ name: "Variant", values: ["Primary", "Neutral", "Bare", "Ghost"] },
					{ name: "Size", values: ["Sm", "Md", "Lg"] },
					{ name: "Shape", values: ["Default", "Pill"] },
				],
				properties: [{ name: "Show Text", type: "BOOLEAN" }, { name: "Slot Before", type: "BOOLEAN" }, { name: "Text", type: "TEXT" }],
			},
			get("button"),
		);
		const byAxis = Object.fromEntries(r.axes.map((a) => [a.figmaAxis, a]));
		expect(byAxis.State.stateProps).toEqual({ Disabled: "isDisabled" });
		expect(byAxis.Variant).toMatchObject({ mappedBy: "same-name", figmaOnlyValues: ["Ghost"], codeOnlyValues: [] });
		expect(byAxis.Shape).toMatchObject({ mappedBy: "boolean-flag", figmaOnlyValues: [] });
		expect(r.codeOnlyProps.map((p) => p.name)).toEqual(["fullWidth"]); // hideText ↔ Show Text; href is non-visual
		expect(r.figmaOnlyProperties).toEqual([]);
		expect(r.status).toBe("drift");
	});

	it("treats the value code expresses by omission as matched (Horizontal ↔ no variant)", () => {
		const r = compareComponentProps({ name: "Divider", variantAxes: [{ name: "Orientation", values: ["Horizontal", "Vertical"] }] }, get("divider"));
		expect(r.status).toBe("in-sync");
		expect(r.axes[0].mappedBy).toBe("same-values");
	});

	it("maps renamed axes by their values, base+flag axes, slot axes and helper text", () => {
		expect(compareComponentProps({ name: "Group", variantAxes: [{ name: "Orientation", values: ["Column", "Row"] }] }, get("checkboxgroup")).status).toBe("in-sync");
		expect(compareComponentProps({ name: "Badge", variantAxes: [{ name: "Shape", values: ["Label", "Dot"] }] }, get("badge")).status).toBe("in-sync");
		expect(compareComponentProps({ name: "Dialog", variantAxes: [{ name: "Footer", values: ["Yes", "No"] }] }, get("dialog")).status).toBe("in-sync");
		expect(
			compareComponentProps(
				{ name: "Input", variantAxes: [{ name: "State", values: ["Default", "Error", "Disabled"] }], properties: [{ name: "Show Helper", type: "BOOLEAN" }] },
				get("input"),
			).status,
		).toBe("in-sync");
	});

	it("reports a Figma state with no code prop", () => {
		const r = compareComponentProps({ name: "Input", variantAxes: [{ name: "State", values: ["Default", "Loading"] }] }, get("input"));
		expect(r.axes[0].figmaOnlyValues).toEqual(["Loading"]);
		expect(r.status).toBe("drift");
	});
});

import { decisionsFromContracts } from "../src/core/adherence/props-parity";
describe("recorded decisions", () => {
	const contracts = [
		{ name: "al-button", props: [{ name: "fullWidth", bindings: { figma: { omit: true } } }, { name: "isPill", bindings: { figma: { pairWith: "Shape" } } }] },
		{ name: "al-heading", props: [{ name: "isBold", bindings: { figma: { pairWith: "Weight" } } }] },
	];
	const dec = decisionsFromContracts(contracts);
	it("skips omitted props and honors pairings", () => {
		const r = compareComponentProps(
			{ name: "Button", variantAxes: [{ name: "Shape", values: ["Default", "Pill"] }], properties: [{ name: "Show Text", type: "BOOLEAN" }] },
			get("button"),
			dec.get("button"),
		);
		expect(r.codeOnlyProps.map((p) => p.name)).not.toContain("fullWidth");
		expect(r.omittedByDecision).toEqual(["fullWidth"]);
		expect(r.axes[0]).toMatchObject({ codeProp: "isPill", mappedBy: "boolean-flag" });
	});
	it("flags a paired boolean whose axis has no 'on' value", () => {
		const heading = indexCem({ modules: [{ declarations: [{ name: "ALHeading", tagName: "al-heading", attributes: [attr("isBold", "boolean")], slots: [{ name: "" }] }] }] }, ["AL"]).get("heading")!;
		const r = compareComponentProps({ name: "Heading", variantAxes: [{ name: "Weight", values: ["Default"] }] }, heading, dec.get("heading"));
		expect(r.axes[0].codeOnlyValues).toEqual(["isBold=true"]);
		expect(r.status).toBe("drift");
	});
});

describe("contract public props", () => {
	it("ignores runtime props the contract doesn't declare", () => {
		const tabs = indexCem({ modules: [{ declarations: [{ name: "ALTabs", tagName: "al-tabs", attributes: [attr("isScrollable", "boolean"), attr("variant", "'pill'")], slots: [] }] }] }, ["AL"]).get("tabs")!;
		const dec = decisionsFromContracts([{ name: "al-tabs", props: [{ name: "variant", bindings: { figma: { pairWith: "Variant" } } }] }]).get("tabs");
		const r = compareComponentProps({ name: "Tabs", variantAxes: [{ name: "Variant", values: ["Default", "Pill"] }] }, tabs, dec);
		expect(r.codeOnlyProps).toEqual([]);
		expect(r.status).toBe("in-sync");
	});
});

