import { registerAnalyticsTools, summarizeAnalytics } from "../src/core/analytics-tools";

describe("library analytics summary", () => {
	it("ranks usages and lists unused assets", () => {
		const rows = [
			{ component_key: "a", component_name: "Gizmo", num_instances: 10 },
			{ component_key: "b", component_name: "Widget", num_instances: 250 },
			{ component_key: "c", component_name: "Old Panel", num_instances: 0 },
		];
		const s: any = summarizeAnalytics("component", "usages", "component", rows, 2);
		expect(s.top.map((r: any) => r.component_name)).toEqual(["Widget", "Gizmo"]);
		expect(s.total).toBe(260);
		expect(s.unused).toEqual(["Old Panel"]);
	});
	it("totals weekly actions per asset with detach rates", () => {
		const rows = [
			{ week: "2026-10-05", component_key: "a", component_name: "Gizmo", insertions: 10, detachments: 4 },
			{ week: "2026-10-12", component_key: "a", component_name: "Gizmo", insertions: 10, detachments: 2 },
			{ week: "2026-10-12", component_key: "b", component_name: "Widget", insertions: 50, detachments: 0 },
		];
		const s: any = summarizeAnalytics("component", "actions", "component", rows, 5);
		expect(s.totals).toEqual({ insertions: 70, detachments: 6 });
		expect(s.mostDetached).toEqual([expect.objectContaining({ name: "Gizmo", detachments: 6, detachRate: 0.3 })]);
		expect(s.mostInserted[0].name).toBe("Widget");
	});
});

describe("figma_get_library_analytics", () => {
	const setup = (api: any) => {
		const tools: Record<string, any> = {};
		registerAnalyticsTools({ registerTool: (n: string, _c: any, h: any) => (tools[n] = h) } as any, { getFigmaAPI: async () => api, getCurrentUrl: () => "https://www.figma.com/design/LIBKEY/x" });
		return tools.figma_get_library_analytics;
	};
	const json = (r: any) => JSON.parse(r.content[0].text);
	it("follows cursors across pages", async () => {
		const calls: any[] = [];
		const tool = setup({
			getLibraryAnalytics: async (fk: string, _a: string, _m: string, p: any) => {
				calls.push({ fk, ...p });
				return p.cursor ? { rows: [{ component_name: "B", num_instances: 1 }] } : { rows: [{ component_name: "A", num_instances: 2 }], next_page: true, cursor: "c1" };
			},
		});
		const r = json(await tool({ asset: "component", metric: "usages" }));
		expect(calls.map((c) => c.cursor)).toEqual([undefined, "c1"]);
		expect(calls[0]).toMatchObject({ fk: "LIBKEY", group_by: "component" });
		expect(r.rows).toBe(2);
	});
	it("explains a missing scope", async () => {
		const tool = setup({ getLibraryAnalytics: async () => { throw new Error('Figma API error (403): Invalid scope: ["file_content:read"]'); } });
		const r = json(await tool({ asset: "variable", metric: "actions" }));
		expect(r.error).toMatch(/library_analytics:read/);
		expect(r.fix).toMatch(/Library analytics: read/);
	});
	it("rejects groupings the API doesn't support", async () => {
		const tool = setup({});
		expect(json(await tool({ asset: "style", metric: "usages", groupBy: "team" })).error).toMatch(/only available for actions/);
	});
});
