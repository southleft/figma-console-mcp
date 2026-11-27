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

import { buildCode } from "../src/core/token-binding-tools";
describe("figma_bind_tokens plugin script", () => {
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
	function mockFigma(calls: string[]) {
		const vars = [
			{ id: "V:1", name: "font/family/body", resolvedType: "STRING", variableCollectionId: "C" },
			{ id: "V:2", name: "type/size/lg", resolvedType: "FLOAT", variableCollectionId: "C" },
		];
		const text: any = {
			id: "1:1", name: "Label", type: "TEXT", characters: "Hello", fontName: { family: "Inter", style: "Regular" },
			getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }],
			setRangeBoundVariable: (_s: number, _e: number, field: string, v: any) => calls.push(`bind:${field}=${v.name}`),
			setTextStyleIdAsync: async (id: string) => calls.push(`style:${id}`),
		};
		return {
			getNodeByIdAsync: async (id: string) => (id === "1:1" ? text : null),
			variables: { getLocalVariablesAsync: async () => vars, getLocalVariableCollectionsAsync: async () => [{ id: "C", name: "Theme" }] },
			getLocalTextStylesAsync: async () => [{ id: "S:1", name: "Body/Regular", key: "k", fontName: { family: "Inter", style: "Regular" } }],
			getLocalEffectStylesAsync: async () => [],
			loadFontAsync: async () => {},
		};
	}
	it("binds fontFamily on text (TextNode has fontName, not fontFamily)", async () => {
		const calls: string[] = [];
		const run = new AsyncFunction("figma", buildCode({ nodeId: "1:1", fields: { fontFamily: "font/family/body" } }));
		const r = await run(mockFigma(calls));
		expect(r.results).toEqual([expect.objectContaining({ field: "fontFamily", ok: true })]);
		expect(calls).toEqual(["bind:fontFamily=font/family/body"]);
	});
	it("applies the text style before field bindings so it can't undo them", async () => {
		const calls: string[] = [];
		const run = new AsyncFunction("figma", buildCode({ nodeId: "1:1", fields: { fontSize: "type/size/lg" }, textStyle: "Body/Regular" }));
		await run(mockFigma(calls));
		expect(calls).toEqual(["style:S:1", "bind:fontSize=type/size/lg"]);
	});
	it("reports a missing node safely even with quotes in the id", async () => {
		const run = new AsyncFunction("figma", buildCode({ nodeId: 'x" + 1 + "', fields: { fontSize: "type/size/lg" } }));
		const r = await run(mockFigma([]));
		expect(r.error).toBe('Node x" + 1 + " not found in this file.');
	});
});
