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
