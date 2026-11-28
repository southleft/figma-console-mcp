import { APP_TOOLS, CORE_TOOLS, TOOLSETS, parseToolsetsEnv, toolsetOf } from "../src/core/toolsets";
import { TOOL_KINDS } from "../src/core/tool-annotations";

describe("toolsets", () => {
	it("puts every annotated tool in exactly one toolset", () => {
		const seen = new Map<string, string>();
		for (const t of CORE_TOOLS) seen.set(t, "core");
		for (const [set, def] of Object.entries(TOOLSETS)) {
			for (const t of def.tools) {
				expect(seen.has(t) ? `${t} in ${seen.get(t)} and ${set}` : "").toBe("");
				seen.set(t, set);
			}
		}
		const missing = Object.keys(TOOL_KINDS).filter((t) => !toolsetOf(t));
		expect(missing).toEqual([]);
	});
	it("lists only real tools", () => {
		const all = [...CORE_TOOLS, ...APP_TOOLS, ...Object.values(TOOLSETS).flatMap((s) => s.tools)];
		expect(all.filter((t) => !TOOL_KINDS[t])).toEqual([]);
	});
	it("parses FIGMA_TOOLSETS", () => {
		expect(parseToolsetsEnv(undefined)).toEqual(new Set(["core"]));
		expect(parseToolsetsEnv("all")).toBe("all");
		expect(parseToolsetsEnv("variables, parity,bogus")).toEqual(new Set(["core", "variables", "parity"]));
		expect(parseToolsetsEnv("assets")).toEqual(new Set(["core", "assets"]));
	});
	it("groups SVG/image import and asset export in the assets toolset", () => {
		expect(TOOLSETS.assets.tools).toEqual(["figma_import_svg", "figma_import_image", "figma_export_assets"]);
		for (const t of TOOLSETS.assets.tools) expect(toolsetOf(t)).toBe("assets");
		// The import tools stay out of core: they are reached through figma_enable_toolsets.
		for (const t of TOOLSETS.assets.tools) expect(CORE_TOOLS).not.toContain(t);
		// The toolset description carries the words a model looks for.
		expect(TOOLSETS.assets.description).toMatch(/icons/);
		expect(TOOLSETS.assets.description).toMatch(/SVG/);
		expect(TOOLSETS.assets.description).toMatch(/export/);
	});
});

import { applyToolsets, registerToolsetTools, resetEnabledToolsets } from "../src/core/toolsets";

describe("toolsets across per-request servers (sessionless HTTP)", () => {
	const fakeServer = () => {
		const reg: Record<string, any> = {};
		const mk = (name: string, handler?: any) => (reg[name] = { enabled: true, enable() { this.enabled = true; }, disable() { this.enabled = false; }, handler });
		for (const n of ["figma_get_status", "figma_export_tokens", "figma_list_slides"]) mk(n);
		const server: any = { _registeredTools: reg, registerTool: (n: string, _c: any, h: any) => mk(n, h), sendToolListChanged: () => {} };
		registerToolsetTools(server);
		return server;
	};
	beforeEach(() => resetEnabledToolsets());

	it("a toolset enabled on one server is on in the next server built", async () => {
		const first = fakeServer();
		applyToolsets(first, new Set(["core"]));
		expect(first._registeredTools.figma_export_tokens.enabled).toBe(false);
		await first._registeredTools.figma_enable_toolsets.handler({ toolsets: ["variables"] });
		const second = fakeServer();
		applyToolsets(second, new Set(["core"]));
		expect(second._registeredTools.figma_export_tokens.enabled).toBe(true);
		expect(second._registeredTools.figma_list_slides.enabled).toBe(false);
	});
});

describe("figma_call is not a permission bypass", () => {
	const setup = () => {
		const reg: Record<string, any> = {};
		const mk = (name: string, o: any = {}) => (reg[name] = { enabled: true, handler: async (a: any) => ({ content: [{ type: "text", text: JSON.stringify({ ran: name, a }) }] }), ...o });
		mk("figma_delete_node");
		mk("figma_export_tokens", { annotations: { destructiveHint: false } });
		mk("figma_delete_variable", { annotations: { destructiveHint: true } });
		const server: any = { _registeredTools: reg, registerTool: (n: string, _c: any, h: any) => mk(n, { handler: h }) };
		registerToolsetTools(server);
		return (tool: string, args?: string) => reg.figma_call.handler({ tool, arguments: args }, {}).then((r: any) => JSON.parse(r.content[0].text));
	};
	it("refuses core and destructive tools", async () => {
		const call = setup();
		expect((await call("figma_delete_node")).error).toMatch(/core tool/);
		expect((await call("figma_delete_variable")).error).toMatch(/delete or overwrite/);
	});
	it("runs an enabled, non-destructive toolset tool with JSON arguments", async () => {
		const call = setup();
		expect(await call("figma_export_tokens", '{"format":"css"}')).toEqual({ ran: "figma_export_tokens", a: { format: "css" } });
		expect((await call("figma_export_tokens", "[1]")).error).toMatch(/JSON object/);
	});
});

describe("figma_enable_toolsets names the tools figma_call refuses", () => {
	const setup = (hints: Record<string, boolean>) => {
		const reg: Record<string, any> = {};
		const mk = (name: string, o: any = {}) => (reg[name] = { enabled: false, ...o });
		for (const [name, destructiveHint] of Object.entries(hints)) mk(name, { annotations: { destructiveHint } });
		const server: any = { _registeredTools: reg, registerTool: (n: string, _c: any, h: any) => mk(n, { enabled: true, handler: h }), sendToolListChanged: () => {} };
		registerToolsetTools(server);
		return async (toolsets: string[]) => JSON.parse((await reg.figma_enable_toolsets.handler({ toolsets })).content[0].text);
	};
	beforeEach(() => resetEnabledToolsets());

	it("lists the destructive-hinted assets tools and how to reach them", async () => {
		const enable = setup({ figma_import_svg: true, figma_import_image: false, figma_export_assets: true });
		const res = await enable(["assets"]);
		expect(res.tools).toEqual(["figma_import_svg", "figma_import_image", "figma_export_assets"]);
		expect(res.note).toContain("figma_import_svg and figma_export_assets can delete or overwrite, so they can't run through figma_call.");
		expect(res.note).toContain("Call them by name");
		expect(res.note).toContain("include assets in FIGMA_TOOLSETS");
		expect(res.note).not.toContain("figma_import_image can");
	});

	it("says nothing extra when every enabled tool can run through figma_call", async () => {
		const enable = setup({ figma_get_styles: false });
		const res = await enable(["inspect"]);
		expect(res.note).toBe("These tools are now listed. If your client doesn't show them yet, call them through figma_call({ tool, arguments }).");
	});

	it("uses the singular for one tool", async () => {
		const enable = setup({ figma_export_tokens: true, figma_create_variable: false });
		const res = await enable(["variables"]);
		expect(res.note).toContain("figma_export_tokens can delete or overwrite, so it can't run through figma_call. Call it by name; if your client doesn't list it,");
	});
});
