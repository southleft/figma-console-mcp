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
