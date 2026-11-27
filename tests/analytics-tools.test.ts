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

// Real response shapes from a live library: Figma returns rows only
// for assets in use (never a 0 row), names variants without their set, and
// reports counts as `usages` / `files_using` / `teams_using`.
describe("figma_get_library_analytics — live API shapes", () => {
	const setup = (api: any) => {
		const tools: Record<string, any> = {};
		registerAnalyticsTools({ registerTool: (n: string, _c: any, h: any) => (tools[n] = h) } as any, { getFigmaAPI: async () => api, getCurrentUrl: () => "https://www.figma.com/design/LIBKEY/x" });
		return tools.figma_get_library_analytics;
	};
	const json = (r: any) => JSON.parse(r.content[0].text);
	const usageRows = [
		{ component_key: "k-btn-primary", component_name: "Variant=Primary, State=Default", usages: 309, files_using: 1, teams_using: 1 },
		{ component_key: "k-done", component_name: "done-circle", usages: 760, files_using: 1, teams_using: 1 },
		{ component_key: "k-badge-default", component_name: "Variant=Default", usages: 12, files_using: 1, teams_using: 1 },
	];
	const published = {
		meta: {
			components: [
				{ key: "k-btn-primary", name: "Variant=Primary, State=Default", containing_frame: { containingComponentSet: { name: "Button" } } },
				{ key: "k-btn-ghost", name: "Variant=Ghost, State=Default", containing_frame: { containingComponentSet: { name: "Button" } } },
				{ key: "k-done", name: "done-circle", containing_frame: {} },
				{ key: "k-badge-default", name: "Variant=Default", containing_frame: { containingComponentSet: { name: "Badge" } } },
				{ key: "k-old", name: "Old Panel" },
			],
		},
	};
	const api = (over: any = {}) => ({ getLibraryAnalytics: async () => ({ rows: usageRows }), getComponents: async () => published, ...over });

	it("lists unused components by comparing against what the library publishes", async () => {
		const r = json(await setup(api())({ asset: "component", metric: "usages" }));
		expect(r.unused).toEqual(["Button / Variant=Ghost, State=Default", "Old Panel"]);
		expect(r.unusedCount).toBe(2);
		expect(r.published).toBe(5);
	});

	it("names variants with their component set", async () => {
		const r = json(await setup(api())({ asset: "component", metric: "usages" }));
		expect(r.top.map((x: any) => x.name)).toEqual(["done-circle", "Button / Variant=Primary, State=Default", "Badge / Variant=Default"]);
		expect(r.top[1].component_set_name).toBe("Button");
	});

	it("still answers when the published list can't be read, and says unused wasn't checked", async () => {
		const r = json(await setup(api({ getComponents: async () => { throw new Error("Figma API error (403)"); } }))({ asset: "component", metric: "usages" }));
		expect(r.success).toBe(true);
		expect(r.total).toBe(760 + 309 + 12);
		expect(r.unused).toBeUndefined();
		expect(r.notes.join(" ")).toMatch(/unused.*couldn't be checked/i);
	});

	it("explains an empty result instead of reporting a bare total of 0", async () => {
		const empty = json(await setup(api({ getLibraryAnalytics: async () => ({ rows: [] }), getComponents: async () => ({ meta: { components: [] } }) }))({ asset: "component", metric: "usages" }));
		expect(empty.notes.join(" ")).toMatch(/publishes no components/i);
		const unusedLib = json(await setup(api({ getLibraryAnalytics: async () => ({ rows: [] }) }))({ asset: "component", metric: "usages" }));
		expect(unusedLib.notes.join(" ")).toMatch(/no usage recorded/i);
		expect(unusedLib.unusedCount).toBe(5);
	});

	it("a 404 points at file access, not the plan", async () => {
		const r = json(await setup({ getLibraryAnalytics: async () => { throw new Error('Figma API error (404): {"status":404,"err":"Not found"}'); } })({ asset: "component", metric: "usages", fileKey: "OTHERKEY" }));
		expect(r.hint).toMatch(/account can't open it/);
		expect(r.hint).not.toMatch(/needs an Enterprise plan/);
	});
});

// Live production (Carbon, 2026-11-27): 804 published variables, none used,
// two pairs sharing a name across collections; styles published but no components.
describe("figma_get_library_analytics — published but unused", () => {
	const setup = (api: any) => {
		const tools: Record<string, any> = {};
		registerAnalyticsTools({ registerTool: (n: string, _c: any, h: any) => (tools[n] = h) } as any, { getFigmaAPI: async () => api, getCurrentUrl: () => "https://www.figma.com/design/LIBKEY/x" });
		return tools.figma_get_library_analytics;
	};
	const json = (r: any) => JSON.parse(r.content[0].text);
	const publishedVariables = {
		variableCollections: { "c-grid": { id: "c-grid", name: "Grid" }, "c-mini": { id: "c-mini", name: "Mini grid" } },
		variables: {
			a: { id: "a", key: "ka", name: "Left end-margin", variableCollectionId: "c-grid" },
			b: { id: "b", key: "kb", name: "Left end-margin", variableCollectionId: "c-mini" },
			c: { id: "c", key: "kc", name: "Layer/layer-02", variableCollectionId: "c-grid" },
		},
	};
	const api = { getLibraryAnalytics: async () => ({ rows: [] }), getPublishedVariables: async () => publishedVariables, getComponents: async () => ({ meta: { components: [] } }) };

	it("counts unused by asset, not by name, and names variables with their collection", async () => {
		const r = json(await setup(api)({ asset: "variable", metric: "usages" }));
		expect(r.unusedCount).toBe(3);
		expect(r.unused).toEqual(["Grid / Left end-margin", "Mini grid / Left end-margin", "Grid / Layer/layer-02"]);
		expect(r.rankedBy).toBeUndefined();
	});

	it("says nothing uses the published assets yet, without doubting the file is a library", async () => {
		const r = json(await setup(api)({ asset: "variable", metric: "usages" }));
		expect(r.notes.join(" ")).toMatch(/3 published variables.*nothing uses them yet/);
		expect(r.notes.join(" ")).not.toMatch(/isn't a published library/);
	});

	it("a file with no published components is told to publish its components, not 'as a library'", async () => {
		const r = json(await setup(api)({ asset: "component", metric: "usages" }));
		expect(r.notes.join(" ")).toMatch(/publishes no components/);
		expect(r.notes.join(" ")).not.toMatch(/as a library first/);
	});
});

describe("figma_get_library_analytics — empty actions", () => {
	it("no insertions or detachments in range doesn't claim the library is unused (a library in use, with 0 actions)", async () => {
		const tools: Record<string, any> = {};
		registerAnalyticsTools({ registerTool: (n: string, _c: any, h: any) => (tools[n] = h) } as any, {
			getFigmaAPI: async () => ({ getLibraryAnalytics: async () => ({ rows: [] }), getComponents: async () => ({ meta: { components: [{ key: "k", name: "Button" }] } }) }),
			getCurrentUrl: () => "https://www.figma.com/design/LIBKEY/x",
		});
		const r = JSON.parse((await tools.figma_get_library_analytics({ asset: "component", metric: "actions" })).content[0].text);
		expect(r.notes.join(" ")).toMatch(/No insertions or detachments recorded in this date range/);
		expect(r.notes.join(" ")).not.toMatch(/nothing uses/);
	});
});

describe("figma_get_library_analytics — review follow-ups", () => {
	const setup = (api: any) => {
		const tools: Record<string, any> = {};
		registerAnalyticsTools({ registerTool: (n: string, _c: any, h: any) => (tools[n] = h) } as any, { getFigmaAPI: async () => api, getCurrentUrl: () => "https://www.figma.com/design/LIBKEY/x" });
		return tools.figma_get_library_analytics;
	};
	const json = (r: any) => JSON.parse(r.content[0].text);

	it("doesn't list unused assets when paging stopped early (unseen pages may hold them)", async () => {
		let n = 0;
		const r = json(await setup({
			getLibraryAnalytics: async () => ({ rows: [{ component_key: `k${n}`, component_name: `C${n++}`, usages: 1 }], next_page: true, cursor: `c${n}` }),
			getComponents: async () => ({ meta: { components: [{ key: "k0", name: "C0" }, { key: "never-fetched", name: "Big" }] } }),
		})({ asset: "component", metric: "usages" }));
		expect(r.truncated).toBe(true);
		expect(r.unused).toBeUndefined();
		expect(r.notes.join(" ")).toMatch(/Unused.*not listed.*first 50 pages/i);
	});

	it("doesn't fetch the published list for team or file groupings, which can't use it", async () => {
		const getComponents = jest.fn(async () => ({ meta: { components: [] } }));
		await setup({ getLibraryAnalytics: async () => ({ rows: [{ team_name: "T", insertions: 1, detachments: 0 }] }), getComponents })({ asset: "component", metric: "actions", groupBy: "team" });
		await setup({ getLibraryAnalytics: async () => ({ rows: [{ file_name: "F", usages: 3 }] }), getComponents })({ asset: "component", metric: "usages", groupBy: "file" });
		expect(getComponents).not.toHaveBeenCalled();
	});
});
