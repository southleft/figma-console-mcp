/**
 * figma_get_variables pagination (#98, #99).
 *
 *  #98 — format='full' ignored page/pageSize: it returned every variable
 *        and no `pagination` object, so callers believed they were paging.
 *  #99 — the pagination object's field names differed by backend; and the
 *        freshly-fetched (non-cache) filtered path dropped `pagination`
 *        from its response altogether.
 */

import { registerFigmaAPITools } from "../src/core/figma-tools";

const MOCK_FILE_URL = "https://www.figma.com/design/abc123/Test-File";

function makeVars(n: number) {
	return {
		success: true,
		variables: Array.from({ length: n }, (_, i) => ({
			id: `VariableID:1:${i}`,
			name: `color/c${i}`,
			resolvedType: "COLOR",
			variableCollectionId: "c1",
			valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 1 } },
		})),
		variableCollections: [{ id: "c1", name: "Colors", modes: [{ modeId: "m1", name: "Default" }], variableIds: [] }],
	};
}

function setup() {
	const tools: Record<string, any> = {};
	const server = { tool: (name: string, _d: string, _s: any, handler: any) => { tools[name] = handler; } };
	const connector = {
		getVariablesFromPluginUI: jest.fn().mockResolvedValue(makeVars(25)),
		getVariables: jest.fn().mockResolvedValue(makeVars(25)),
		getTransportType: () => "websocket",
	};
	registerFigmaAPITools(server as any, async () => ({}) as any, () => MOCK_FILE_URL, new Map(), undefined, async () => connector as any);
	return (args: any) => tools["figma_get_variables"]({ includePublished: false, enrich: false, ...args }).then((r: any) => JSON.parse(r.content[0].text));
}

const SHAPE = ["currentPage", "pageSize", "totalVariables", "totalPages", "hasNextPage", "hasPrevPage"].sort();

describe.each([
	["freshly fetched", false],
	["served from cache", true],
])("figma_get_variables pagination (%s)", (_label, warmCache) => {
	async function call(args: any) {
		const get = setup();
		if (warmCache) await get({ format: "summary" });
		return get(args);
	}

	it("format='full' with page/pageSize returns that page and a pagination object (#98)", async () => {
		const res = await call({ format: "full", page: 2, pageSize: 10 });
		const vars = res.data.variables;
		expect(vars).toHaveLength(10);
		expect(vars[0].id).toBe("VariableID:1:10");
		expect(res.pagination).toEqual({ currentPage: 2, pageSize: 10, totalVariables: 25, totalPages: 3, hasNextPage: true, hasPrevPage: true });
	});

	it("format='full' without paging params still returns everything, with no pagination", async () => {
		const res = await call({ format: "full" });
		expect(res.data.variables).toHaveLength(25);
		expect(res.pagination).toBeUndefined();
	});

	it("format='filtered' reports pagination with the shared field names (#99)", async () => {
		const res = await call({ format: "filtered", namePattern: "color", pageSize: 10 });
		expect(Object.keys(res.pagination).sort()).toEqual(SHAPE);
		expect(res.pagination.totalVariables).toBe(25);
	});
});
