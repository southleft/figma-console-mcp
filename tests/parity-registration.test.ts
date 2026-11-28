/**
 * How the parity tools sit in the server (registration, hints, toolsets,
 * figma_call, tasks, the Worker bundle boundary, mode-aware text), checked on
 * the real modules. Each feature's own suite covers behavior; this file covers
 * the wiring, and each parity feature adds its cases here.
 *
 * Asset import/export: figma_import_svg, figma_import_image, figma_export_assets
 * (src/core/asset-tools.ts registers all three).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { McpServer as V1McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as V1InMemory } from "@modelcontextprotocol/sdk/inMemory.js";
import { withToolIdentity } from "../src/core/identity";
import { applyToolAnnotations } from "../src/core/tool-annotations";
import { applyToolsets, registerToolsetTools, resetEnabledToolsets } from "../src/core/toolsets";
import { LOCAL_TASK_TOOLS, TaskStore, enableTasksForTools } from "../src/core/tasks";
import { registerAssetTools } from "../src/core/asset-tools";
import { createNodeAssetFs } from "../src/core/assets/node-fs";
import { containsAnyTypeSchema } from "./helpers/schema";

const ASSET_TOOLS = ["figma_export_assets", "figma_import_image", "figma_import_svg"];
const root = resolve(__dirname, "..");

type Listed = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };

async function listLocal(): Promise<{ tools: Listed[]; server: any; close: () => Promise<void> }> {
	const server = new (withToolIdentity(McpServer))({ name: "local", version: "0" });
	registerAssetTools(server, async () => ({ executeCodeViaUI: jest.fn() }), { fs: createNodeAssetFs(), getFigmaAPI: async () => ({}) as any });
	registerToolsetTools(server as any);
	const unclassified = applyToolAnnotations(server);
	expect(unclassified).toEqual([]);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await server.connect(st);
	const client = new Client({ name: "c", version: "0" });
	await client.connect(ct);
	const { tools } = await client.listTools();
	return {
		tools: tools as Listed[],
		server,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

async function listCloud(connector: unknown = { executeCodeViaUI: jest.fn() }) {
	const server = new (withToolIdentity(V1McpServer))({ name: "cloud", version: "0" });
	registerAssetTools(server as any, async () => connector, { isRemoteMode: true, getFigmaAPI: async () => ({}) as any });
	applyToolAnnotations(server);
	const [ct, st] = V1InMemory.createLinkedPair();
	await server.connect(st);
	const client = new V1Client({ name: "c", version: "0" });
	await client.connect(ct);
	const { tools } = await client.listTools();
	return {
		tools: tools as unknown as Listed[],
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

/**
 * Tool names the Cloud /mcp server registers, read from src/index.ts the way
 * scripts/update-tool-counts.mjs reads it: the register*() calls in the /mcp
 * block, resolved through relative imports and followed into nested
 * register*() calls, then every .tool("…") / .registerTool("…") literal in
 * those files and in the block itself.
 */
function cloudToolNames(): Set<string> {
	const indexPath = resolve(root, "src/index.ts");
	const src = readFileSync(indexPath, "utf8");
	const start = src.indexOf('if (url.pathname === "/mcp")');
	const block = src.slice(start, src.indexOf("statelessServer.connect(", start));
	const importsOf = (file: string, text: string) => {
		const map = new Map<string, string>();
		for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.{1,2}\/[^"]+)\.js"/g)) {
			for (const spec of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
				map.set((spec.replace(/^type\s+/, "").split(/\s+as\s+/).pop() as string).trim(), resolve(dirname(file), `${m[2]}.ts`));
			}
		}
		return map;
	};
	const REGISTER_CALL = /\b(register[A-Za-z]+)\(/g;
	const TOOL = /\.(?:tool|registerTool)\(\s*["'`](fig(?:ma|jam)_[a-z_]+)["'`]/g;
	const names = new Set([...block.matchAll(TOOL)].map((m) => m[1]));
	const fromIndex = importsOf(indexPath, src);
	const queue = [...block.matchAll(REGISTER_CALL)].map((m) => fromIndex.get(m[1])).filter((f): f is string => !!f);
	const seen = new Set<string>();
	while (queue.length) {
		const file = queue.shift() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(TOOL)) names.add(m[1]);
		const local = importsOf(file, text);
		for (const m of text.matchAll(REGISTER_CALL)) {
			const target = local.get(m[1]);
			if (target) queue.push(target);
		}
	}
	return names;
}

/** Every figma_… / figjam_… name in a text. */
const toolNamesIn = (text: string) => [...new Set(text.match(/\bfig(?:ma|jam)_[a-z_]+/g) ?? [])].sort();

/** Relative-import graph of an entry file, as published-dependencies.test.ts walks it (type-only imports skipped). */
function reachableFrom(entry: string): Set<string> {
	const seen = new Set<string>();
	const IMPORT = /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
	const visit = (file: string) => {
		if (seen.has(file) || !existsSync(file)) return;
		seen.add(file);
		for (const m of [...readFileSync(file, "utf8").matchAll(IMPORT)]) {
			if (m[2]) continue;
			const spec = m[3] ?? m[4];
			if (!spec?.startsWith(".")) continue;
			const target = resolve(dirname(file), spec).replace(/\.js$/, ".ts");
			visit(target.endsWith(".ts") ? target : `${target}.ts`);
		}
	};
	visit(resolve(root, entry));
	return new Set([...seen].map((f) => f.replace(`${root}/`, "")));
}

beforeEach(() => resetEnabledToolsets());

describe("asset import/export: registration", () => {
	it("Local registers the three tools, all classified", async () => {
		const { tools, close } = await listLocal();
		expect(tools.map((t) => t.name).filter((n) => ASSET_TOOLS.includes(n)).sort()).toEqual(ASSET_TOOLS);
		await close();
	});

	it("Cloud registers the same three on the v1 SDK, and a bad argument returns isError for each", async () => {
		const connector = { executeCodeViaUI: jest.fn() };
		const { tools, client, close } = await listCloud(connector);
		expect(tools.map((t) => t.name).sort()).toEqual(ASSET_TOOLS);
		const BAD: Record<string, Record<string, unknown>> = {
			figma_import_svg: { dryRun: "yes" },
			figma_import_image: { scaleMode: "STRETCH" },
			figma_export_assets: { format: "GIF" },
		};
		for (const name of ASSET_TOOLS) {
			const res = await client.callTool({ name, arguments: BAD[name] });
			expect({ name, isError: res.isError }).toEqual({ name, isError: true });
		}
		expect(connector.executeCodeViaUI).not.toHaveBeenCalled();
		await close();
	});

	it("both Cloud paths in src/index.ts register the asset tools without a filesystem", () => {
		const src = readFileSync(resolve(root, "src/index.ts"), "utf8");
		const calls = [...src.matchAll(/registerAssetTools\(([\s\S]*?)\);/g)].map((m) => m[1]);
		expect(calls).toHaveLength(2); // Durable Object /sse and stateless /mcp
		for (const c of calls) {
			expect(c).toContain("isRemoteMode: true");
			expect(c).not.toMatch(/\bfs\s*:/);
		}
		const mcpStart = src.indexOf('if (url.pathname === "/mcp")');
		const mcpEnd = src.indexOf("statelessServer.connect(", mcpStart);
		expect(src.slice(mcpStart, mcpEnd)).toContain("registerAssetTools(statelessServer");
	});

	it("Local registers the asset tools before annotations, tasks and toolsets are applied", () => {
		const src = readFileSync(resolve(root, "src/local.ts"), "utf8");
		const at = src.indexOf("registerAssetTools(server");
		expect(at).toBeGreaterThan(0);
		for (const marker of ["registerToolsetTools(server", "applyToolAnnotations(server)", "enableTasksForTools(server", "applyToolsets(server"]) {
			expect({ marker, after: src.indexOf(marker) > at }).toEqual({ marker, after: true });
		}
		expect(src).toMatch(/registerAssetTools\(server, \(\) => this\.getDesktopConnector\(\), \{\s*fs: createNodeAssetFs\(\),/);
	});
});

describe("asset import/export: schemas", () => {
	it("are Gemini-safe in both modes (no propertyNames, no z.any()-shaped nodes)", async () => {
		const local = await listLocal();
		const cloud = await listCloud();
		for (const tools of [local.tools, cloud.tools]) {
			for (const t of tools.filter((x) => ASSET_TOOLS.includes(x.name))) {
				expect(JSON.stringify(t.inputSchema)).not.toContain("propertyNames");
				expect({ name: t.name, issues: containsAnyTypeSchema(t.inputSchema) }).toEqual({ name: t.name, issues: [] });
			}
		}
		await local.close();
		await cloud.close();
	});

	it("Cloud schemas keep only the Local-only fields the spec keeps, each rejected at run time", async () => {
		// The asset tools keep one schema for both modes (svg.md §2.11, §3.7, §10.4) and refuse these
		// fields in Cloud Mode before contacting Figma. Listed here so a new Local-only field, at any
		// depth, is a deliberate choice. recursive, offset and limit page through a directory.
		const LOCAL_ONLY = ["fileKey", "path", "paths", "directory", "recursive", "offset", "limit", "outputDir", "overwrite"];
		const EXCEPTIONS: Record<string, string[]> = {
			figma_import_svg: ["directory", "fileKey", "limit", "offset", "paths", "recursive"],
			figma_import_image: ["directory", "fileKey", "images[].path", "limit", "offset", "recursive"],
			figma_export_assets: ["fileKey", 'output="files"', "outputDir", "overwrite"],
		};
		/** Local-only fields anywhere in a JSON Schema ("images[].path" for nested ones), plus an output enum offering "files". */
		const localOnlyIn = (schema: unknown): string[] => {
			const found: string[] = [];
			const walk = (node: any, at: string) => {
				if (!node || typeof node !== "object") return;
				if (node.items) walk(node.items, `${at}[]`);
				for (const k of ["anyOf", "oneOf", "allOf"]) for (const sub of Array.isArray(node[k]) ? node[k] : []) walk(sub, at);
				for (const [key, child] of Object.entries((node.properties ?? {}) as Record<string, any>)) {
					const path = at ? `${at}.${key}` : key;
					if (LOCAL_ONLY.includes(key)) found.push(path);
					if (key === "output" && Array.isArray(child?.enum) && child.enum.includes("files")) found.push(`${path}="files"`);
					walk(child, path);
				}
			};
			walk(schema, "");
			return found.sort();
		};
		const connector = { executeCodeViaUI: jest.fn() };
		const { tools, client, close } = await listCloud(connector);
		for (const t of tools) {
			expect({ name: t.name, localOnly: localOnlyIn(t.inputSchema) }).toEqual({ name: t.name, localOnly: [...EXCEPTIONS[t.name]].sort() });
		}
		const schemaOf = (name: string) => tools.find((t) => t.name === name)?.inputSchema as any;
		expect(schemaOf("figma_export_assets").properties.output.enum).toContain("files");
		expect(schemaOf("figma_import_image").properties.images.items.properties.path).toBeDefined();

		// Each kept field is refused in Cloud Mode with a Local Mode message, before Figma is contacted.
		const svg = { svgs: [{ markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>' }] };
		const img = { images: [{ data: "iVBORw0KGgo=" }] };
		const PROBES: Record<string, Record<string, Record<string, unknown>>> = {
			figma_import_svg: {
				directory: { directory: "/tmp/icons" },
				fileKey: { ...svg, fileKey: "abc123" },
				limit: { ...svg, limit: 5 },
				offset: { ...svg, offset: 1 },
				paths: { paths: ["/tmp/icons/a.svg"] },
				recursive: { ...svg, recursive: true },
			},
			figma_import_image: {
				directory: { directory: "/tmp/photos" },
				fileKey: { ...img, fileKey: "abc123" },
				"images[].path": { images: [{ path: "/tmp/photos/a.png" }] },
				limit: { ...img, limit: 5 },
				offset: { ...img, offset: 1 },
				recursive: { ...img, recursive: true },
			},
			figma_export_assets: {
				fileKey: { fileKey: "abc123" },
				'output="files"': { output: "files" },
				outputDir: { outputDir: "/tmp/out" },
				overwrite: { overwrite: true },
			},
		};
		for (const [name, probes] of Object.entries(PROBES)) {
			expect(Object.keys(probes).sort()).toEqual([...EXCEPTIONS[name]].sort());
			for (const [field, args] of Object.entries(probes)) {
				const res = await client.callTool({ name, arguments: args });
				expect({ name, field, isError: res.isError, localMode: /Local Mode/.test(JSON.stringify(res.content)) }).toEqual({ name, field, isError: true, localMode: true });
			}
		}
		expect(connector.executeCodeViaUI).not.toHaveBeenCalled();
		await close();
	});
});

describe("asset import/export: hints, figma_call, toolsets, tasks", () => {
	it("hints follow the tool kinds", async () => {
		const { tools, close } = await listLocal();
		const hints = Object.fromEntries(tools.filter((t) => ASSET_TOOLS.includes(t.name)).map((t) => [t.name, t.annotations]));
		expect(hints.figma_import_svg).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
		expect(hints.figma_import_image).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
		expect(hints.figma_export_assets).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
		await close();
	});

	it("figma_call refuses the two destructive-hinted asset tools and runs figma_import_image", async () => {
		const { server, close } = await listLocal();
		applyToolsets(server, new Set(["core", "assets"]));
		const reg = server._registeredTools;
		const call = async (tool: string, args = "{}") => {
			const res = await reg.figma_call.handler({ tool, arguments: args }, {});
			return JSON.parse(res.content[0].text);
		};
		for (const tool of ["figma_import_svg", "figma_export_assets"]) {
			expect((await call(tool)).error).toMatch(/can delete or overwrite/);
		}
		// Reaches the tool's own validation, so figma_call ran it.
		const ran = await call("figma_import_image");
		expect(JSON.stringify(ran)).toMatch(/Nothing to import/);
		await close();
	});

	it("figma_enable_toolsets names the asset tools that must be called by name", async () => {
		const { server, close } = await listLocal();
		applyToolsets(server, new Set(["core"]));
		const res = await server._registeredTools.figma_enable_toolsets.handler({ toolsets: ["assets"] }, {});
		const body = JSON.parse(res.content[0].text);
		expect(body.tools.sort()).toEqual(ASSET_TOOLS);
		expect(body.note).toContain("figma_import_svg and figma_export_assets can delete or overwrite, so they can't run through figma_call.");
		await close();
	});

	it("run their own MCP tasks in the handler, so they are not in LOCAL_TASK_TOOLS (no double wrap)", async () => {
		for (const name of ASSET_TOOLS) expect(LOCAL_TASK_TOOLS).not.toContain(name);
		// Tasks are installed before connect, as src/local.ts does.
		const server = new (withToolIdentity(McpServer))({ name: "local", version: "0" });
		registerAssetTools(server, async () => ({}), { fs: createNodeAssetFs() });
		expect(enableTasksForTools(server, LOCAL_TASK_TOOLS, { store: new TaskStore() }).filter((n) => ASSET_TOOLS.includes(n))).toEqual([]);
	});
});

describe("asset import/export: Local/Cloud boundary", () => {
	it("the Worker entry never reaches the Node filesystem module", () => {
		const fromWorker = reachableFrom("src/index.ts");
		expect(fromWorker.has("src/core/asset-tools.ts")).toBe(true); // sanity: the walk reaches the module
		expect(fromWorker.has("src/core/assets/node-fs.ts")).toBe(false);
		expect(reachableFrom("src/local.ts").has("src/core/assets/node-fs.ts")).toBe(true);
	});

	it("reads the Cloud tool list from src/index.ts (sanity check for the D7 tests below)", () => {
		const cloud = cloudToolNames();
		for (const name of [...ASSET_TOOLS, "figma_capture_screenshot", "figma_set_image_fill"]) expect({ name, cloud: cloud.has(name) }).toEqual({ name, cloud: true });
		// Registered only by src/local.ts or toolsets.ts. One of these showing up here means a module
		// Cloud registers also registers a Local-only tool (for example behind `if (!isRemoteMode)`).
		for (const name of ["figma_list_open_files", "figma_get_selection", "figma_enable_toolsets", "figma_call"]) {
			expect({ name, cloud: cloud.has(name) }).toEqual({ name, cloud: false });
		}
	});

	it("Cloud descriptions and schemas name only tools Cloud registers, and no toolset settings", async () => {
		const cloud = cloudToolNames();
		const { tools, close } = await listCloud();
		for (const t of tools) {
			const text = JSON.stringify({ d: t.description, s: t.inputSchema });
			expect({ name: t.name, notInCloud: toolNamesIn(text).filter((n) => !cloud.has(n)) }).toEqual({ name: t.name, notInCloud: [] });
			for (const word of ["figma_enable_toolsets", "figma_call", "FIGMA_TOOLSETS"]) {
				expect({ name: t.name, word, found: text.includes(word) }).toEqual({ name: t.name, word, found: false });
			}
		}
		await close();
	});

	it("the asset modules' errors, hints and plugin script text name only tools Cloud registers", () => {
		// The same modules run in Cloud Mode, so any message they return can reach a Cloud model.
		const cloud = cloudToolNames();
		const files = [...reachableFrom("src/core/asset-tools.ts")]
			.filter((f) => /^src\/core\/(?:asset-tools|asset-export-tools|image-import-tools)\.ts$|^src\/core\/assets\//.test(f))
			.sort();
		expect(files).toEqual(expect.arrayContaining(["src/core/asset-export-tools.ts", "src/core/asset-tools.ts", "src/core/assets/plugin-scripts.ts", "src/core/image-import-tools.ts"]));
		for (const file of files) {
			// Block comments and whole-line comments never reach the model; everything else can.
			const text = readFileSync(resolve(root, file), "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, "");
			expect({ file, notInCloud: toolNamesIn(text).filter((n) => !cloud.has(n)) }).toEqual({ file, notInCloud: [] });
		}
	});
});
