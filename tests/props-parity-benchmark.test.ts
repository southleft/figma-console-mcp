/**
 * Labelled benchmark for property-level parity (Figma component ↔ code props).
 * Every case uses invented component names and covers one convention that is
 * common across design systems — and, for each convention, a case where the
 * difference is REAL. Drift detection is scored as precision / recall:
 *   - a clean case reported as drift  → false positive (hurts precision)
 *   - a real drift reported as in-sync → false negative (hurts recall)
 * The rules must not be tuned to any one library; this is the guard.
 */
import { type CodeComponent, type FigmaComponentShape, compareComponentProps } from "../src/core/adherence/props-parity";

const bool = (name: string) => ({ name, kind: "boolean" as const, typeText: "boolean" });
const str = (name: string) => ({ name, kind: "string" as const, typeText: "string" });
const en = (name: string, values: string[]) => ({ name, kind: "enum" as const, values, typeText: values.map((v) => `'${v}'`).join(" | ") });
const code = (props: CodeComponent["props"], extra: Partial<CodeComponent> = {}): CodeComponent => ({ props, slots: [], ...extra });
const NATIVE = ["disabled", "checked", "required", "readonly", "open", "selected", "invalid"];

type Case = { id: string; figma: FigmaComponentShape; code: CodeComponent; drift: boolean };
const CASES: Case[] = [
	// ---- conventions that are NOT drift
	{ id: "boolean axis named like a prop", drift: false, figma: { name: "Field", variantAxes: [{ name: "isDisabled", values: ["true", "false"] }] }, code: code([bool("disabled")]) },
	{ id: "boolean axis ↔ string prop of same concept", drift: false, figma: { name: "Field", variantAxes: [{ name: "hasError", values: ["false", "true"] }] }, code: code([str("error")]) },
	{ id: "responsive breakpoint axis", drift: false, figma: { name: "Panel", variantAxes: [{ name: "Breakpoint", values: ["sm", "md", "lg"] }] }, code: code([]) },
	{
		id: "content properties (text, swap, item toggles)",
		drift: false,
		figma: { name: "Menu", variantAxes: [], properties: [{ name: "Title Text", type: "TEXT" }, { name: "Left Icon", type: "INSTANCE_SWAP" }, { name: "Show Item 3", type: "BOOLEAN" }] },
		code: code([]),
	},
	{ id: "state inherited from native element", drift: false, figma: { name: "Control", variantAxes: [{ name: "State", values: ["Default", "Hover", "Disabled"] }] }, code: code([], { inherited: NATIVE }) },
	{ id: "runtime states (filled, open)", drift: false, figma: { name: "Picker", variantAxes: [{ name: "State", values: ["Default", "Filled", "Open"] }] }, code: code([]) },
	{ id: "variant value synonyms", drift: false, figma: { name: "Notice", variantAxes: [{ name: "Variant", values: ["Danger", "Info", "Success"] }] }, code: code([en("variant", ["destructive", "informational", "positive"])]) },
	{ id: "size naming synonyms", drift: false, figma: { name: "Chiplet", variantAxes: [{ name: "Size", values: ["Small", "Medium", "Large"] }] }, code: code([en("size", ["sm", "md", "lg"])]) },
	{ id: "behavioural code props", drift: false, figma: { name: "Slider", variantAxes: [] }, code: code([bool("loop"), en("align", ["start", "end"]), bool("defaultOpen"), str("ariaLabel"), bool("autoPlay")]) },
	{ id: "uninformative axes", drift: false, figma: { name: "Tile", variantAxes: [{ name: "Property 1", values: ["Default", "Variant2"] }, { name: "Type", values: ["Box"] }] }, code: code([]) },
	{ id: "boolean axis ↔ slot", drift: false, figma: { name: "Sheet", variantAxes: [{ name: "Footer", values: ["Yes", "No"] }] }, code: code([], { slots: ["", "footer"] }) },
	{ id: "numeric sample-data axis (percent)", drift: false, figma: { name: "Meter", variantAxes: [{ name: "Percent", values: ["0%", "50%", "100%"] }] }, code: code([]) },
	{ id: "interaction layered on a state: Error (Focus)", drift: false, figma: { name: "Entry", variantAxes: [{ name: "State", values: ["Default", "Error", "Error (Focus)"] }] }, code: code([], { inherited: NATIVE }) },
	{ id: "code flag ↔ figma boolean property", drift: false, figma: { name: "Notice", variantAxes: [], properties: [{ name: "hasIcon", type: "BOOLEAN" }] }, code: code([bool("withIcon")]) },
	{ id: "runtime code prop (controlled open)", drift: false, figma: { name: "Picker", variantAxes: [] }, code: code([bool("open")]) },
	{ id: "orientation inherited from a primitive", drift: false, figma: { name: "Rule", variantAxes: [{ name: "Orientation", values: ["Horizontal", "Vertical"] }] }, code: code([], { inherited: [...NATIVE, "orientation"] }) },
	{ id: "boolean axis for an interaction (isFocused)", drift: false, figma: { name: "Knob", variantAxes: [{ name: "isFocused", values: ["true", "false"] }] }, code: code([]) },
	{ id: "boolean error axis on a native-backed field", drift: false, figma: { name: "Entry2", variantAxes: [{ name: "hasError", values: ["true", "false"] }] }, code: code([], { inherited: NATIVE }) },
	// ---- REAL drift for each convention
	{ id: "boolean error axis on a non-native component", drift: true, figma: { name: "Tile2", variantAxes: [{ name: "hasError", values: ["true", "false"] }] }, code: code([]) },
	{ id: "numeric axis that isn't sample data", drift: true, figma: { name: "Badge2", variantAxes: [{ name: "Size", values: ["16", "24"] }] }, code: code([]) },
	{ id: "error state on a non-native component without a prop", drift: true, figma: { name: "Panel2", variantAxes: [{ name: "State", values: ["Default", "Error"] }] }, code: code([]) },
	{ id: "code flag with no figma property or axis", drift: true, figma: { name: "Notice2", variantAxes: [], properties: [{ name: "hasIcon", type: "BOOLEAN" }] }, code: code([bool("withBorder")]) },
	{ id: "orientation axis without inheritance or prop", drift: true, figma: { name: "Rule2", variantAxes: [{ name: "Orientation", values: ["Horizontal", "Vertical"] }] }, code: code([]) },
	{ id: "figma variant value code lacks", drift: true, figma: { name: "Action", variantAxes: [{ name: "Variant", values: ["Primary", "Ghost"] }] }, code: code([en("variant", ["primary"])]) },
	{ id: "code variant value figma lacks", drift: true, figma: { name: "Action", variantAxes: [{ name: "Variant", values: ["Primary", "Secondary"] }] }, code: code([en("variant", ["primary", "secondary", "link"])]) },
	{ id: "figma state with no prop, not inherited", drift: true, figma: { name: "Action", variantAxes: [{ name: "State", values: ["Default", "Loading"] }] }, code: code([]) },
	{ id: "disabled state on a non-native component without a prop", drift: true, figma: { name: "Card", variantAxes: [{ name: "State", values: ["Default", "Disabled"] }] }, code: code([]) },
	{ id: "visual boolean code prop with no figma axis", drift: true, figma: { name: "List", variantAxes: [] }, code: code([bool("isCompact")]) },
	{ id: "figma boolean axis with no code prop", drift: true, figma: { name: "Surface", variantAxes: [{ name: "isElevated", values: ["true", "false"] }] }, code: code([]) },
	{ id: "figma axis with no code counterpart", drift: true, figma: { name: "Table", variantAxes: [{ name: "Density", values: ["Comfortable", "Compact"] }] }, code: code([]) },
	{ id: "code enum prop not in figma", drift: true, figma: { name: "Label", variantAxes: [] }, code: code([en("tone", ["neutral", "brand"])]) },
	{ id: "numeric size axis without a prop", drift: true, figma: { name: "Portrait", variantAxes: [{ name: "Size", values: ["12", "10", "8"] }] }, code: code([]) },
	{ id: "synonyms don't over-merge different values", drift: true, figma: { name: "Action", variantAxes: [{ name: "Variant", values: ["Primary", "Warning"] }] }, code: code([en("variant", ["primary", "danger"])]) },
];

describe("property parity benchmark (precision / recall)", () => {
	const results = CASES.map((c) => ({ ...c, got: compareComponentProps(c.figma, c.code).status === "drift" }));
	const tp = results.filter((r) => r.drift && r.got).length;
	const fp = results.filter((r) => !r.drift && r.got);
	const fn = results.filter((r) => r.drift && !r.got);
	const precision = tp / (tp + fp.length);
	const recall = tp / (tp + fn.length);

	it.each(results.map((r) => [r.id, r]))("%s", (_id, r: any) => {
		expect(r.got).toBe(r.drift);
	});

	it("scores precision and recall of 1.0 on the benchmark", () => {
		expect({ precision, recall, falsePositives: fp.map((r) => r.id), falseNegatives: fn.map((r) => r.id) }).toEqual({
			precision: 1,
			recall: 1,
			falsePositives: [],
			falseNegatives: [],
		});
	});
});
