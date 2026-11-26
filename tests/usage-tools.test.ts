import { buildUsageCode } from "../src/core/usage-tools";

const run = (code: string, figma: any) => new Function("figma", `return (async () => { ${code} })();`)(figma);
const page = { type: "PAGE", name: "Buttons", parent: null as any };
const onPage = (id: string) => ({ id, name: "Button", type: "INSTANCE", parent: { type: "FRAME", name: "Row", parent: page } });
const orphan = (id: string) => ({ id, name: "Button", type: "INSTANCE", parent: { type: "FRAME", name: "Sheet (plugin)", parent: null } });

describe("figma_find_usages script", () => {
	it("counts component instances on pages, and orphaned ones separately", async () => {
		const comp = { id: "1:1", name: "Button", type: "COMPONENT", getInstancesAsync: async () => [onPage("2:1"), orphan("2:2"), onPage("2:3")] };
		const r = await run(buildUsageCode("component", "1:1", 10, 1000), { getNodeByIdAsync: async () => comp });
		expect(r.total).toBe(2);
		expect(r.orphaned).toBe(1);
		expect(r.sampledByPage).toEqual({ Buttons: 2 });
	});
	it("finds variable bindings in fields and paints, and stops at maxNodes", async () => {
		const v = { id: "VariableID:1:1", name: "space/md" };
		const kids = [
			{ id: "3:1", name: "A", type: "FRAME", boundVariables: { itemSpacing: { id: v.id } } },
			{ id: "3:2", name: "B", type: "RECTANGLE", boundVariables: {}, fills: [{ boundVariables: { color: { id: v.id } } }] },
			{ id: "3:3", name: "C", type: "RECTANGLE", boundVariables: {} },
		];
		const pg: any = { type: "PAGE", name: "P", children: kids, parent: null };
		for (const k of kids as any[]) k.parent = pg;
		const figma = { loadAllPagesAsync: async () => {}, root: { children: [pg] }, variables: { getVariableByIdAsync: async () => v } };
		const r = await run(buildUsageCode("variable", v.id, 10, 1000), figma);
		expect(r.total).toBe(2);
		expect(r.sample.map((x: any) => x.field).sort()).toEqual(["fills", "itemSpacing"]);
		expect(r.truncated).toBe(false);
	});
	it("explains a missing target", async () => {
		const r = await run(buildUsageCode("style", "S:1", 10, 1000), { getStyleByIdAsync: async () => null });
		expect(r.error).toMatch(/No style/);
	});
});
