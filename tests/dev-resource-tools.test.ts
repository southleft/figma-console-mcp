import { buildDevResourceCode, registerDevResourceTools } from "../src/core/dev-resource-tools";

/** Run the plugin-side script against a fake figma with in-memory dev resources. */
async function run(code: string, nodes: Record<string, { name: string; res: Array<{ name: string; url: string }>; hang?: boolean }>) {
	const mk = (id: string) => {
		const n = nodes[id];
		if (!n) return null;
		const hang = () => new Promise(() => {});
		return {
			id,
			name: n.name,
			getDevResourcesAsync: async () => (n.hang ? hang() : n.res.map((r) => ({ ...r, nodeId: id }))),
			addDevResourceAsync: async (url: string, name?: string) => {
				if (n.hang) return hang();
				n.res.push({ url, name: name ?? url });
			},
			editDevResourceAsync: async (url: string, patch: any) => {
				const r = n.res.find((x) => x.url === url);
				if (!r) throw new Error("no such resource");
				Object.assign(r, patch);
			},
			deleteDevResourceAsync: async (url: string) => {
				n.res = n.res.filter((x) => x.url !== url);
			},
		};
	};
	const figma = { getNodeByIdAsync: async (id: string) => mk(id), currentPage: { selection: [] as any[] } };
	return new Function("figma", `return (async () => { ${code} })();`)(figma);
}

describe("dev resources script", () => {
	it("adds links, skipping ones already there", async () => {
		const nodes = { "1:1": { name: "Button", res: [{ name: "Storybook", url: "https://sb.example/button" }] } };
		const r = await run(
			buildDevResourceCode("add", { items: [{ nodeId: "1:1", url: "https://sb.example/button", name: "Storybook" }, { nodeId: "1:1", url: "https://git.example/Button.tsx", name: "Code" }] }),
			nodes,
		);
		expect(r.results.map((x: any) => x.skipped ?? (x.ok ? "added" : "failed"))).toEqual(["already linked", "added"]);
		expect(nodes["1:1"].res.map((x) => x.url)).toEqual(["https://sb.example/button", "https://git.example/Button.tsx"]);
	});

	it("edits and deletes by current URL, and reports missing nodes", async () => {
		const nodes = { "1:1": { name: "Card", res: [{ name: "Docs", url: "https://docs.example/old" }] } };
		await run(buildDevResourceCode("edit", { items: [{ nodeId: "1:1", url: "https://docs.example/old", newUrl: "https://docs.example/new" }] }), nodes);
		expect(nodes["1:1"].res[0].url).toBe("https://docs.example/new");
		const d = await run(buildDevResourceCode("delete", { items: [{ nodeId: "1:1", url: "https://docs.example/new" }, { nodeId: "9:9", url: "https://x.example" }] }), nodes);
		expect(nodes["1:1"].res).toEqual([]);
		expect(d.results[1]).toMatchObject({ ok: false, error: "node not found" });
	});

	it("stops after repeated timeouts instead of hanging", async () => {
		jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
		const nodes = { "1:1": { name: "A", res: [], hang: true }, "1:2": { name: "B", res: [], hang: true }, "1:3": { name: "C", res: [], hang: true } };
		const p = run(buildDevResourceCode("list", { nodeIds: ["1:1", "1:2", "1:3"] }), nodes);
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
			jest.advanceTimersByTime(4100);
			await new Promise((r) => setImmediate(r));
		}
		const r = await p;
		jest.useRealTimers();
		expect(r.timedOut).toBe(2);
		expect(r.results.at(-1).note).toMatch(/Focus the file/);
	});
});

describe("figma_manage_dev_resources", () => {
	const setup = () => {
		const tools: Record<string, any> = {};
		const calls: string[] = [];
		const server = { getClientCapabilities: () => undefined, registerTool: (n: string, _c: any, h: any) => (tools[n] = h) };
		registerDevResourceTools(server as any, async () => ({ executeCodeViaUI: async (code: string) => (calls.push(code), { success: true, result: { results: [{ ok: true }], timedOut: 0 } }) }));
		return { tool: tools.figma_manage_dev_resources, calls };
	};
	const json = (r: any) => JSON.parse(r.content[0].text);

	it("rejects non-http URLs before touching the file", async () => {
		const { tool, calls } = setup();
		const r = json(await tool({ action: "add", items: [{ nodeId: "1:1", url: "javascript:alert(1)" }] }));
		expect(r.error).toMatch(/Not http/);
		expect(calls).toHaveLength(0);
	});

	it("needs a change for every edit", async () => {
		const { tool } = setup();
		expect(json(await tool({ action: "edit", items: [{ nodeId: "1:1", url: "https://a.example" }] })).error).toMatch(/name and\/or newUrl/);
	});
});

describe("dev resources deadline", () => {
	it("returns finished work and the remaining items when the budget runs out", async () => {
		const nodes: any = { "1:1": { name: "A", res: [] }, "1:2": { name: "B", res: [] } };
		const code = buildDevResourceCode("add", { items: [{ nodeId: "1:1", url: "https://a.example" }, { nodeId: "1:2", url: "https://b.example" }] }, -1);
		const r = await run(code, nodes);
		expect(r.incomplete).toBe(true);
		expect(r.remaining).toHaveLength(2);
		expect(nodes["1:1"].res).toEqual([]);
	});
});
