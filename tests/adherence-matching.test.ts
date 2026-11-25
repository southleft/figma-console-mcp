import { type CatalogEntry, resolveNeeds, tokenize } from "../src/core/adherence/matching";

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
});
