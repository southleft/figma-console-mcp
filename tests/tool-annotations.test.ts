/**
 * Every tool the server registers (local or cloud) must have behavior hints
 * in src/core/tool-annotations.ts. Scans the source for registrations so a
 * new tool fails here instead of shipping without readOnly/destructive hints.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	TOOL_KINDS,
	applyToolAnnotations,
	hintsFor,
} from "../src/core/tool-annotations";

function registeredToolNames(dir: string, out = new Set<string>()): Set<string> {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) {
			if (entry !== "ui") registeredToolNames(p, out);
			continue;
		}
		if (!p.endsWith(".ts")) continue;
		const src = readFileSync(p, "utf8");
		for (const m of src.matchAll(/\.(?:tool|registerTool)\(\s*["'`]([a-z_]+)["'`]/g)) out.add(m[1]);
		for (const m of src.matchAll(/registerAppTool\(\s*\w+,\s*["'`]([a-z_]+)["'`]/g)) out.add(m[1]);
	}
	return out;
}

describe("tool annotations", () => {
	const names = registeredToolNames(join(__dirname, "..", "src"));

	it("finds the registered tools", () => {
		expect(names.size).toBeGreaterThan(100);
	});

	it("classifies every registered tool", () => {
		const missing = [...names].filter((n) => !(n in TOOL_KINDS)).sort();
		expect(missing).toEqual([]);
	});

	it("has no stale entries for tools that no longer exist", () => {
		const stale = Object.keys(TOOL_KINDS).filter((n) => !names.has(n)).sort();
		expect(stale).toEqual([]);
	});

	it("never marks a read-only tool destructive", () => {
		for (const name of Object.keys(TOOL_KINDS)) {
			const h = hintsFor(name)!;
			if (h.readOnlyHint) expect(h.destructiveHint).toBe(false);
		}
	});

	it("marks deletes and arbitrary code destructive", () => {
		for (const name of Object.keys(TOOL_KINDS)) {
			if (/_delete_|^figma_execute/.test(name)) {
				expect(hintsFor(name)!.destructiveHint).toBe(true);
			}
		}
	});

	it("applies hints to a server and keeps per-tool overrides", () => {
		const server = new McpServer({ name: "t", version: "0" });
		server.registerTool("figma_get_status", { description: "s" }, async () => ({ content: [] }));
		server.registerTool(
			"figma_delete_node",
			{ description: "d", inputSchema: z.object({ nodeId: z.string() }), annotations: { title: "Delete node" } },
			async () => ({ content: [] }),
		);
		server.registerTool("not_classified", { description: "x" }, async () => ({ content: [] }));

		const missing = applyToolAnnotations(server);
		expect(missing).toEqual(["not_classified"]);

		const tools = (server as any)._registeredTools;
		expect(tools.figma_get_status.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
		});
		expect(tools.figma_delete_node.annotations).toMatchObject({
			title: "Delete node",
			destructiveHint: true,
			readOnlyHint: false,
		});
	});
});
