import { buildExtendCode, buildResetOverrideCode } from "../src/core/extended-collection-tools";

const run = (code: string, figma: any) => new Function("figma", `return (async () => { ${code} })();`)(figma);
const lib = [{ key: "K1", name: "Brand", libraryName: "Core DS" }];
const localBase = () => ({
	id: "VC:local", name: "ButtonGroup", remote: false, isExtension: false,
	extend: jest.fn((name: string) => ({ id: "VC:ext2", name, modes: [{ modeId: "VC:ext2/2:0", name: "medium", parentModeId: "1:0" }] })),
});
const fakeFigma = (created: any[] = [], locals: any[] = [localBase()]) => ({
	teamLibrary: { getAvailableLibraryVariableCollectionsAsync: async () => lib },
	variables: {
		extendLibraryCollectionByKeyAsync: async (key: string, name: string) => (created.push({ key, name }), { id: "VC:ext", name, modes: [{ modeId: "1:0", name: "Light" }] }),
		getLocalVariableCollectionsAsync: async () => locals,
		getVariableCollectionByIdAsync: async (id: string) => locals.find((c) => c.id === id) ?? null,
	},
});

describe("extend library collection", () => {
	it("lists library collections and the file's own collections without a key", async () => {
		expect(await run(buildExtendCode(undefined, undefined), fakeFigma())).toEqual({
			available: [{ key: "K1", name: "Brand", library: "Core DS" }],
			local: [{ collectionId: "VC:local", name: "ButtonGroup" }],
		});
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

describe("extend a local collection", () => {
	it("extends one of the file's own collections by id", async () => {
		const base = localBase();
		const r = await run(buildExtendCode(undefined, "ButtonGroup (brand)", "VC:local"), fakeFigma([], [base]));
		expect(base.extend).toHaveBeenCalledWith("ButtonGroup (brand)");
		expect(r.created).toMatchObject({ id: "VC:ext2", extends: { collectionId: "VC:local", name: "ButtonGroup" }, modes: [{ modeId: "VC:ext2/2:0", name: "medium" }] });
	});
	it("refuses an id that isn't a local collection, and lists the local ones", async () => {
		const r = await run(buildExtendCode(undefined, undefined, "VC:nope"), fakeFigma());
		expect(r.error).toMatch(/No local collection/);
		expect(r.local).toEqual([{ collectionId: "VC:local", name: "ButtonGroup" }]);
	});
	it("explains when Figma doesn't allow extending (not Enterprise)", async () => {
		const base: any = { ...localBase(), extend: undefined };
		const r = await run(buildExtendCode(undefined, undefined, "VC:local"), fakeFigma([], [base]));
		expect(r.error).toMatch(/Enterprise/);
	});
});

describe("reset an extension's override", () => {
	const M0 = "VC:ext/1:0", M1 = "VC:ext/1:1";
	const setup = (overrides: Record<string, Record<string, unknown>>) => {
		const variable = { id: "V:1", name: "radius/sm", setValueForMode: jest.fn((m: string, v: unknown) => { (ext.variableOverrides["V:1"] ??= {})[m] = v; }) };
		const ext: any = {
			id: "VC:ext", name: "Brand B", isExtension: true,
			modes: [{ modeId: M0, name: "Light" }, { modeId: M1, name: "Dark" }],
			variableIds: ["V:1"],
			variableOverrides: overrides,
			removeOverridesForVariable: jest.fn((v: any) => { delete ext.variableOverrides[v.id]; }),
		};
		const figma = { variables: { getVariableCollectionByIdAsync: async (id: string) => (id === ext.id ? ext : null), getVariableByIdAsync: async (id: string) => (id === "V:1" ? variable : null) } };
		return { ext, variable, figma };
	};

	it("clears every mode's override when no mode is given", async () => {
		const { ext, figma } = setup({ "V:1": { [M0]: 4, [M1]: 6 } });
		const r = await run(buildResetOverrideCode("VC:ext", "V:1", undefined), figma);
		expect(ext.variableOverrides["V:1"]).toBeUndefined();
		expect(r).toMatchObject({ reset: { variable: "radius/sm", collection: "Brand B", modes: ["Light", "Dark"] }, remainingOverrides: {} });
	});
	it("clears one mode and keeps the others (Figma only clears all at once)", async () => {
		const { ext, figma } = setup({ "V:1": { [M0]: 4, [M1]: 6 } });
		const r = await run(buildResetOverrideCode("VC:ext", "V:1", M1), figma);
		expect(ext.variableOverrides["V:1"]).toEqual({ [M0]: 4 });
		expect(r.reset.modes).toEqual(["Dark"]);
		expect(r.remainingOverrides).toEqual({ Light: 4 });
	});
	it("says so when there's nothing to reset, and changes nothing", async () => {
		const { ext, figma } = setup({ "V:1": { [M0]: 4 } });
		const r = await run(buildResetOverrideCode("VC:ext", "V:1", M1), figma);
		expect(ext.removeOverridesForVariable).not.toHaveBeenCalled();
		expect(r.unchanged).toMatch(/not overridden/);
	});
	it("refuses a collection that isn't an extension", async () => {
		const figma = { variables: { getVariableCollectionByIdAsync: async () => ({ id: "VC:base", name: "Base", isExtension: false }), getVariableByIdAsync: async () => ({ id: "V:1" }) } };
		expect((await run(buildResetOverrideCode("VC:base", "V:1", undefined), figma)).error).toMatch(/isn't an extended collection/);
	});

	it("refuses a variable that isn't in the extension instead of saying it 'already inherits'", async () => {
		const { ext, figma } = setup({ "V:1": { [M0]: 4 } });
		ext.variableIds = ["V:other"];
		const r = await run(buildResetOverrideCode("VC:ext", "V:1", undefined), figma);
		expect(r.error).toMatch(/isn't in "Brand B"/);
	});
	it("if restoring the other modes fails, puts every override back and reports the values", async () => {
		const { ext, variable, figma } = setup({ "V:1": { [M0]: 4, [M1]: 6 } });
		let calls = 0;
		variable.setValueForMode = jest.fn((m: string, v: unknown) => {
			calls++;
			if (calls === 1) throw new Error("in setValueForMode: boom");
			(ext.variableOverrides["V:1"] ??= {})[m] = v;
		});
		const r = await run(buildResetOverrideCode("VC:ext", "V:1", M1), figma);
		expect(r.error).toMatch(/boom/);
		expect(r.rolledBack).toBe(true);
		expect(ext.variableOverrides["V:1"]).toEqual({ [M0]: 4, [M1]: 6 });
		expect(r.originalOverrides).toEqual({ Light: 4, Dark: 6 });
	});
});

describe("listing when the library lookup fails", () => {
	it("still lists the file's own collections, with a warning", async () => {
		const f: any = fakeFigma();
		f.teamLibrary.getAvailableLibraryVariableCollectionsAsync = async () => { throw new Error("library service unavailable"); };
		const r = await run(buildExtendCode(undefined, undefined), f);
		expect(r.local).toEqual([{ collectionId: "VC:local", name: "ButtonGroup" }]);
		expect(r.available).toEqual([]);
		expect(r.warning).toMatch(/library service unavailable/);
	});
});
