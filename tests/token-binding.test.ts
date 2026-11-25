import { BINDABLE_FIELDS, expandBindings } from "../src/core/token-binding-tools";

describe("figma_bind_tokens field expansion", () => {
	it("expands shorthands and keeps real fields", () => {
		const { fields, unknown } = expandBindings({ padding: "space/md", gap: "space/sm", cornerRadius: "radius/lg", fontSize: "type/body" });
		expect(unknown).toEqual([]);
		expect(fields).toMatchObject({
			paddingLeft: "space/md", paddingRight: "space/md", paddingTop: "space/md", paddingBottom: "space/md",
			itemSpacing: "space/sm", topLeftRadius: "radius/lg", bottomRightRadius: "radius/lg", fontSize: "type/body",
		});
	});
	it("rejects fields Figma can't bind (no silent ignore)", () => {
		expect(expandBindings({ fills: "x", margin: "y" }).unknown).toEqual(["fills", "margin"]);
	});
	it("only lists fields Figma's setBoundVariable accepts", () => {
		expect(BINDABLE_FIELDS).not.toContain("fills");
		expect(BINDABLE_FIELDS).toContain("itemSpacing");
	});
});
