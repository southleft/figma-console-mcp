import { type CatalogEntry, pairLibraries, resolveNeeds, tokenize } from "../src/core/adherence/matching";

const cat = (name: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
	name, key: `k-${name}`, type: "COMPONENT_SET", source: "local", ...extra,
});

const catalog: CatalogEntry[] = [
	cat("Button", { variantAxes: [{ name: "Variant", values: ["Primary", "Secondary", "Ghost"] }, { name: "Size", values: ["sm", "md"] }] }),
	cat("Icon Button"),
	cat("Forms/Text Field", { description: "Single-line input with label and helper text" }),
	cat("Forms/Select"),
	cat("Checkbox"),
	cat("Avatar", { variantAxes: [{ name: "Size", values: ["24", "32"] }] }),
	cat("Card"),
	cat("Badge"),
	cat("Modal"),
	cat("Tabs"),
];
const status = (need: string) => resolveNeeds([need], catalog)[0];

describe("adherence matching", () => {
	it("tokenizes compounds, camelCase, plurals and synonyms", () => {
		expect(tokenize("Date Picker")).toEqual(["datepicker"]);
		expect(tokenize("primaryButton")).toEqual(["button"]);
		expect(tokenize("text field")).toEqual(["input"]);
		expect(tokenize("dropdown menus")).toEqual(["select", "menu"]);
	});

	it("matches direct names and synonyms", () => {
		expect(status("primary button")).toMatchObject({ status: "matched", component: { name: "Button" } });
		expect(status("CTA")).toMatchObject({ status: "matched", component: { name: "Button" } });
		expect(status("email text field")).toMatchObject({ status: "possible" });
		expect(status("text input")).toMatchObject({ status: "matched", component: { name: "Forms/Text Field" } });
		expect(status("dropdown")).toMatchObject({ status: "matched", component: { name: "Forms/Select" } });
		expect(status("dialog")).toMatchObject({ status: "matched", component: { name: "Modal" } });
		expect(status("user avatar")).toMatchObject({ status: "possible" });
		expect(status("avatar")).toMatchObject({ status: "matched" });
		expect(status("tag")).toMatchObject({ status: "matched", component: { name: "Badge" } });
	});

	it("reports gaps instead of stretching a match", () => {
		for (const need of ["date picker", "data table", "toast", "slider", "stepper", "rating stars"]) {
			expect(status(need).status).toBe("gap");
		}
	});

	it("prefers the exact component over a longer name", () => {
		const r = status("button");
		expect(r.component?.name).toBe("Button");
		expect(r.candidates[1]?.name).toBe("Icon Button");
	});

	it("flags a tie between different components as possible, not matched", () => {
		const r = resolveNeeds(["card"], [cat("Card"), cat("Marketing/Card")])[0];
		expect(r.status).toBe("possible");
	});

	it("never offers archived, deprecated or private components", () => {
		const r = resolveNeeds(["select"], [cat("Archive / Select/Default"), cat("_Select base"), cat("Deprecated/Select"), cat("Select")])[0];
		expect(r.status).toBe("matched");
		expect(r.candidates.map((c) => c.name)).toEqual(["Select"]);
		expect(resolveNeeds(["select"], [cat("Archive/Select")])[0].status).toBe("gap");
	});

	it("pairs Figma and code libraries without force-pairing", () => {
		const figma = [cat("Button"), cat("Forms/Text Field"), cat("Dialog"), cat("Avatar"), cat("Archive/Old Card"), cat("Tooltip")];
		const r = pairLibraries(figma, ["Button", "TextField", "Modal", "Badge", "Tooltip"]);
		expect(r.pairs.map((p) => `${p.figma.name}=${p.code}:${p.matchedBy}`)).toEqual([
			"Button=Button:exact",
			"Tooltip=Tooltip:exact",
			"Forms/Text Field=TextField:normalized",
			"Dialog=Modal:concept",
		]);
		expect(r.figmaOnly.map((f) => f.name)).toEqual(["Avatar"]);
		expect(r.codeOnly).toEqual(["Badge"]);
		expect(r.retiredInFigma).toEqual(["Archive/Old Card"]);
	});
});


import { pickDefaultVariant } from "../src/core/adherence/matching";
describe("default variant", () => {
	it("prefers the variant whose values say Default", () => {
		const v = pickDefaultVariant([
			{ name: "State=Hover, Variant=Primary, Size=Md" },
			{ name: "State=Default, Variant=Primary, Size=Md" },
			{ name: "State=Default, Variant=Default, Size=Md" },
		]);
		expect(v?.name).toBe("State=Default, Variant=Default, Size=Md");
		expect(pickDefaultVariant([{ name: "A=1" }, { name: "A=2" }])?.name).toBe("A=1");
	});
});
