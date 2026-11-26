import { buildExtendCode } from "../src/core/extended-collection-tools";

const run = (code: string, figma: any) => new Function("figma", `return (async () => { ${code} })();`)(figma);
const lib = [{ key: "K1", name: "Brand", libraryName: "Core DS" }];
const fakeFigma = (created: any[] = []) => ({
	teamLibrary: { getAvailableLibraryVariableCollectionsAsync: async () => lib },
	variables: { extendLibraryCollectionByKeyAsync: async (key: string, name: string) => (created.push({ key, name }), { id: "VC:ext", name, modes: [{ modeId: "1:0", name: "Light" }] }) },
});

describe("extend library collection", () => {
	it("lists available collections without a key", async () => {
		expect(await run(buildExtendCode(undefined, undefined), fakeFigma())).toEqual({ available: [{ key: "K1", name: "Brand", library: "Core DS" }] });
	});
	it("creates the extension, defaulting the name", async () => {
		const created: any[] = [];
		const r = await run(buildExtendCode("K1", undefined), fakeFigma(created));
		expect(created).toEqual([{ key: "K1", name: "Brand (extended)" }]);
		expect(r.created).toMatchObject({ id: "VC:ext", extends: { name: "Brand", library: "Core DS" }, modes: [{ name: "Light" }] });
	});
	it("refuses an unknown key and lists what's available", async () => {
		const r = await run(buildExtendCode("NOPE", "X"), fakeFigma());
		expect(r.error).toMatch(/No library collection/);
		expect(r.available).toHaveLength(1);
	});
});
