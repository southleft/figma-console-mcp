/**
 * figma_import_svg handler (spec §2.5, §8.1 "assets-import-tool"). The
 * connector runs the real plugin scripts against the fake figma, so these are
 * end-to-end through planning, confirmation, chunking and the write phase.
 */

const mockLog = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
jest.mock("../../src/core/logger", () => ({ createChildLogger: () => mockLog, logger: mockLog }));

import { z } from "zod";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { McpServer as V1McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as V1InMemory } from "@modelcontextprotocol/sdk/inMemory.js";
import { withToolIdentity } from "../../src/core/identity";
import { TASKS_EXTENSION_ID, defaultTaskStore, installTasks } from "../../src/core/tasks";
import { registerAssetTools } from "../../src/core/asset-tools";
import type { AssetFs, AssetToolsOptions } from "../../src/core/assets/fs-types";
import { buildChunks, normalizeImportArgs, type ImportItem, type PlanGroup } from "../../src/core/assets/import-plan";
import { sanitizeSvg } from "../../src/core/assets/svg-sanitize";
import { FakeFigma, FNode, makeIconComponent, runScript } from "./fake-figma";

const svg = (body: string, attrs = 'viewBox="0 0 24 24"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const ICON = svg('<path d="M5 12h14" fill="none" stroke="currentColor"/>');
const iconN = (i: number) => svg(`<path d="M${i} 1h2" fill="#000000"/>`);

interface Call {
	label: string;
	P: any;
	timeoutMs: number;
	fileKey?: string;
}

function fakeConnector(fake: FakeFigma, intercept?: (label: string, P: any) => unknown) {
	const calls: Call[] = [];
	return {
		calls,
		labels: () => calls.map((c) => c.label),
		async executeCodeViaUI(code: string, timeoutMs: number, fileKey?: string) {
			const lines = code.split("\n");
			const label = lines[0].replace(/^\/\/ /, "");
			const P = new Function(`${lines[1]} return P;`)();
			calls.push({ label, P, timeoutMs, fileKey });
			const o = intercept?.(label, P);
			if (o !== undefined) return o instanceof Error ? Promise.reject(o) : o;
			try {
				return { success: true, result: await runScript(code, fake.api()) };
			} catch (e) {
				return { success: false, error: `Error: ${(e as Error).message}` };
			}
		},
	};
}

function memFs(files: Record<string, string>, sizes: Record<string, number> = {}): AssetFs {
	return {
		async listSvgFiles(dir) {
			const list = Object.keys(files)
				.filter((p) => p.startsWith(`${dir}/`))
				.map((p) => ({ path: p, relPath: p.slice(dir.length + 1), size: sizes[p] ?? files[p].length }));
			return { root: dir, files: list, scanned: list.length, truncated: false, skippedSubfolders: false };
		},
		async readSvgFile(path) {
			if (!(path in files)) throw new Error(`File not found: ${path}`);
			return { text: files[path], size: sizes[path] ?? files[path].length };
		},
		// Raster images and the export half; the SVG import uses neither.
		listImageFiles: async () => {
			throw new Error("not used by the SVG import");
		},
		readImageFile: async () => {
			throw new Error("not used by the SVG import");
		},
		prepareOutputDir: async () => {
			throw new Error("not used by import");
		},
		resolveInside: async () => ({ ok: false, reason: "not used by import" }),
		writeNew: async () => "exists",
		writeReplace: async () => {},
	};
}

type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<any>;

function setup(opts: { fake?: FakeFigma; options?: AssetToolsOptions; intercept?: (label: string, P: any) => unknown } = {}) {
	const fake = opts.fake ?? new FakeFigma();
	const conn = fakeConnector(fake, opts.intercept);
	const tools: Record<string, Handler> = {};
	const server = { registerTool: (name: string, _cfg: unknown, h: Handler) => (tools[name] = h), server: { getClientCapabilities: () => undefined } };
	registerAssetTools(server as any, async () => conn, opts.options ?? { fs: memFs({}) });
	return { fake, conn, tool: tools.figma_import_svg };
}
const body = (r: any) => JSON.parse(r.content[0].text);
const FORMS = { mcpReq: { envelope: { "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } } } };
const answer = (key: string, content: Record<string, unknown>, action = "accept") => ({
	mcpReq: { envelope: FORMS.mcpReq.envelope, inputResponses: { [key]: { action, content } } },
});

afterEach(() => {
	delete (globalThis as any).__figmaConsoleSvgImport;
	delete (globalThis as any).__figmaConsoleImageImport;
	delete (globalThis as any).__figmaConsoleSvgCheckpoints;
	delete process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE;
	delete process.env.FIGMA_CONSOLE_ASSET_TIMEOUT_SCALE;
	jest.clearAllMocks();
});

describe("registration", () => {
	function emptyNodes(schema: unknown, path = "$", out: string[] = []): string[] {
		if (schema && typeof schema === "object" && !Array.isArray(schema)) {
			const s = schema as Record<string, unknown>;
			const keys = Object.keys(s).filter((k) => k !== "description" && k !== "default");
			if (keys.length === 0) out.push(path);
			for (const [k, v] of Object.entries(s)) if (k !== "default" && k !== "enum" && k !== "required") emptyNodes(v, `${path}.${k}`, out);
		} else if (Array.isArray(schema)) schema.forEach((v, i) => emptyNodes(v, `${path}[${i}]`, out));
		return out;
	}

	it("lists through withToolIdentity(McpServer) with no empty schema nodes and no propertyNames", async () => {
		const server = new (withToolIdentity(McpServer))({ name: "t", version: "0" });
		registerAssetTools(server, async () => ({}));
		const [ct, st] = InMemoryTransport.createLinkedPair();
		await server.connect(st);
		const client = new Client({ name: "c", version: "0" });
		await client.connect(ct);
		const { tools } = await client.listTools();
		const t = tools.find((x) => x.name === "figma_import_svg")!;
		expect(t).toBeDefined();
		expect(JSON.stringify(t)).not.toContain("propertyNames");
		expect(emptyNodes(t.inputSchema.properties)).toEqual([]);
		expect(t.description!.length).toBeLessThan(1800);
		await client.close();
		await server.close();
	});

	it("the v1 SDK server lists and validates the tool (Cloud path)", async () => {
		const server = new (withToolIdentity(V1McpServer))({ name: "cloud", version: "0" });
		registerAssetTools(server as any, async () => ({}), { isRemoteMode: true });
		const [ct, st] = V1InMemory.createLinkedPair();
		await server.connect(st);
		const client = new V1Client({ name: "c", version: "0" });
		await client.connect(ct);
		const { tools } = await client.listTools();
		expect(tools.map((x) => x.name)).toContain("figma_import_svg");
		const bad = await client.callTool({ name: "figma_import_svg", arguments: { svgs: "nope" } });
		expect(bad.isError).toBe(true);
		const cloudFiles = await client.callTool({ name: "figma_import_svg", arguments: { directory: "/x" } });
		expect(cloudFiles.isError).toBe(true);
		await client.close();
		await server.close();
	});
});

describe("validation", () => {
	it("Cloud rejects paths, directory, paging and fileKey before any connector call, and more than 100 svgs", async () => {
		const { conn, tool } = setup({ options: { isRemoteMode: true } });
		for (const args of [{ paths: ["/a.svg"] }, { directory: "/icons" }, { svgs: [{ markup: ICON }], offset: 3 }]) {
			const r = await tool(args);
			expect(r.isError).toBe(true);
			expect(body(r).error).toBe("paths and directory read files from disk, which only Local Mode can do. Cloud Mode has no filesystem: pass the SVG markup in svgs instead.");
		}
		expect(body(await tool({ svgs: [{ markup: ICON }], fileKey: "abc" })).error).toMatch(/^Per-file targeting \(fileKey\) is Local Mode only/);
		const many = Array.from({ length: 101 }, () => ({ markup: ICON }));
		expect(body(await tool({ svgs: many })).error).toBe("Cloud Mode imports up to 100 SVGs per call. Split the batch into several calls.");
		expect(conn.calls).toHaveLength(0);
	});

	it("cross-field errors return isError with no connector call", async () => {
		const { conn, tool } = setup();
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{}, /^Nothing to import/],
			[{ svgs: [{ markup: ICON }], size: 24, width: 10 }, /^Use size, or width\/height, not both\.$/],
			[{ svgs: [{ markup: ICON }], variants: { pattern: "{name}-{Size}" }, asComponent: false }, /needs components/],
			[{ svgs: [{ markup: ICON }], color: { variable: "a", value: "#000" } }, /^Use one of color\.variable/],
			[{ svgs: [{ markup: ICON }], color: {} }, /^color needs a variable/],
			[{ svgs: [{ markup: ICON }], keepOverrides: true, onExisting: "skip" }, /^keepOverrides only applies/],
			[{ paths: ["icons/a.svg"] }, /^"icons\/a\.svg" is a relative path\. Pass an absolute path\.$/],
			[{ svgs: [{ markup: ICON }], variants: { pattern: "{name}" } }, /needs at least one \{Axis\}/],
			[{ svgs: Array.from({ length: 200 }, () => ({ markup: ICON })), paths: Array.from({ length: 301 }, (_, i) => `/p${i}.svg`) }, /^Too many SVGs in one call: 200 inline \+ 301 paths = 501; the limit is 500\./],
		];
		for (const [args, re] of cases) {
			const r = await tool(args);
			expect(r.isError).toBe(true);
			expect(body(r).error).toMatch(re);
		}
		// 16 MiB inline total (each item under its own 5 MiB cap).
		const big = svg(`<path d="${"M1 1 ".repeat(860_000)}"/>`);
		const total = await tool({ svgs: [big, big, big, big].map((markup) => ({ markup })) });
		expect(body(total).error).toMatch(/^The svgs total 16\.\d MB; the limit per call is 16 MB\./);
		expect(conn.calls).toHaveLength(0);
	});

	it("directory errors name the folder", async () => {
		const { tool } = setup({ options: { fs: memFs({}) } });
		expect(body(await tool({ directory: "/empty" })).error).toBe("No .svg files in /empty");
	});
});

describe("single SVG and batches", () => {
	it("a single inline SVG makes exactly preflight → one import chunk; the response matches §2.3", async () => {
		const { conn, tool, fake } = setup();
		const r = await tool({ svgs: [{ markup: ICON, name: "rocket" }] });
		expect(conn.labels()).toEqual(["Import SVG: check target", "Import SVG (1 items)"]);
		const b = body(r);
		expect(r.isError).toBeUndefined();
		expect(b).toMatchObject({ success: true, dryRun: false, summary: { requested: 1, created: 1, updated: 0, unchanged: 0, skipped: 0, conflicts: 0, failed: 0, componentSets: 0 }, file: { name: "Acme DS", editorType: "figma" } });
		expect(b.runId).toMatch(/^[0-9a-f]{12}$/);
		expect(b.items).toEqual([]);
		expect(b.created).toEqual([["svgs[0]", "rocket", expect.any(String)]]);
		expect(b.hint).toMatch(/^Check the result with figma_capture_screenshot\(\{ nodeId: "/);
		expect(fake.currentPage.children!.map((c) => c.name)).toEqual(["rocket"]);
		expect(conn.calls[1].P.layout.mode).toBe("single");
	});

	it("sanitize failures don't stop the batch and the summary adds up", async () => {
		const { tool } = setup();
		const r = body(await tool({ svgs: [{ markup: ICON }, { markup: "<html/>" }, { markup: svg('<script>x</script><path d="M1 1"/>') }, { markup: "<svg" }] }));
		expect(r.summary).toMatchObject({ requested: 4, created: 2, failed: 2 });
		expect(r.success).toBe(false);
		expect(r.items.map((i: any) => [i.source, i.status, i.stage])).toEqual([
			["svgs[1]", "failed", "sanitize"],
			["svgs[3]", "failed", "sanitize"],
		]);
		expect(r.container).toMatchObject({ type: "FRAME", name: "SVG import", created: true });
	});

	it("every input failing returns isError without contacting Figma", async () => {
		const { conn, tool } = setup();
		const r = await tool({ svgs: [{ markup: "<html/>" }] });
		expect(r.isError).toBe(true);
		expect(conn.calls).toHaveLength(0);
	});

	it("dryRun makes only the preflight call and reports actions and whether it would ask", async () => {
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/bell" });
		comp._instances = [{ name: "Toolbar" }];
		const { conn, tool } = setup({ fake });
		// A client that can show the question: the dry run says it would ask.
		const b = body(await tool({ svgs: [{ markup: ICON, name: "bell" }, { markup: ICON, name: "new" }], asComponent: true, namePrefix: "Icon/", dryRun: true }, FORMS));
		expect(conn.labels()).toEqual(["Import SVG: check target"]);
		expect(b.dryRun).toBe(true);
		expect(b.runId).toBeUndefined();
		expect(b.items.map((i: any) => [i.name, i.action])).toEqual([
			["Icon/bell", "update"],
			["Icon/new", "create"],
		]);
		expect(b.items[0]).toMatchObject({ existingId: comp.id, instanceCount: 1, published: "UNPUBLISHED" });
		expect(b.confirmation.wouldAsk).toBe(true);
		expect(b.confirmation.reason).toMatch(/replace the artwork of 1 existing component \(used by 1 instance in this file, including "Toolbar"\)/);
	});

	it("payload safety: hostile markup arrives byte-identical in P and the script parses", async () => {
		const hostile = svg('<text x="1" y="2">"; figma.root.remove(); " ` ${x} &lt;/script> \u2028 \u2029</text><path d="M1 1h2"/>');
		const { conn, tool } = setup();
		await tool({ svgs: [{ markup: hostile }] });
		const sent = conn.calls[1].P.groups[0].item.markup;
		const expected = sanitizeSvg(hostile);
		expect(expected.ok && sent === expected.markup).toBe(true);
		expect(sent).toContain("\u2028");
	});

	it("the logger never receives markup", async () => {
		const { tool } = setup();
		const marker = "MARKER_IN_MARKUP_77";
		await tool({ svgs: [{ markup: svg(`<text>${marker}</text><path d="M1 1"/>`) }] });
		expect(mockLog.info).toHaveBeenCalled();
		expect(JSON.stringify([...mockLog.info.mock.calls, ...mockLog.error.mock.calls])).not.toContain(marker);
	});
});

describe("chunking", () => {
	const mkItem = (i: number, extra: Partial<ImportItem> = {}): ImportItem => {
		const s = sanitizeSvg(iconN(i));
		if (!s.ok) throw new Error(s.error);
		return { key: `k${i}`, source: `svgs[${i}]`, kind: "inline", notes: [], markup: s.markup, sentinel: null, meta: s.meta, name: `I${i}`, artHash: "h", action: "create", ...extra };
	};
	const n = normalizeImportArgs({ svgs: [{ markup: "x" }] });

	it("120 items → 3 chunks of ≤ 50; set groups never split; an oversized item is its own chunk", () => {
		const singles: PlanGroup[] = Array.from({ length: 120 }, (_, i) => ({ kind: "single", item: mkItem(i) }));
		expect(buildChunks(singles, n).map((c) => c.items)).toEqual([50, 50, 20]);
		const set: PlanGroup = { kind: "set", name: "S", axes: ["Size"], action: "create", items: Array.from({ length: 30 }, (_, i) => mkItem(200 + i, { props: { Size: String(i) } })) };
		const mixed: PlanGroup[] = [...singles.slice(0, 40), set, ...singles.slice(40, 45)];
		const chunks = buildChunks(mixed, n);
		const setChunk = chunks.find((c) => c.keys.includes("k200"))!;
		expect(setChunk.keys.filter((k) => Number(k.slice(1)) >= 200)).toHaveLength(30);
		expect(chunks.every((c) => c.items <= 50)).toBe(true);
		const heavy = mkItem(999, { meta: { ...mkItem(1).meta!, expandedCount: 150_000 } });
		const withHeavy = buildChunks([singles[0], { kind: "single", item: heavy }, singles[1]], n);
		expect(withHeavy.map((c) => c.keys)).toEqual([["k0"], ["k999"], ["k1"]]);
	});

	it("measures chunk bytes on the JSON and fails a set group over 12 MiB as a whole", () => {
		const quoted = mkItem(1, { markup: '"'.repeat(800_000) });
		const c = buildChunks([{ kind: "single", item: quoted }], n);
		expect(c[0].jsonBytes).toBeGreaterThan(1_600_000);
		const bigVariants = Array.from({ length: 3 }, (_, i) => mkItem(300 + i, { markup: "x".repeat(4.5 * 1024 * 1024), props: { Size: String(i) } }));
		const set: PlanGroup = { kind: "set", name: "Big", axes: ["Size"], action: "create", items: bigVariants };
		expect(buildChunks([set], n)).toEqual([]);
		for (const it of bigVariants) expect(it).toMatchObject({ status: "failed", action: "fail", reason: expect.stringMatching(/^This variant group is 13\.5 MB of SVG; one set can carry at most 12 MB\./) });
	});

	it("a 120-item call sends three chunks and lays them out as one run", async () => {
		const { conn, tool, fake } = setup();
		const b = body(await tool({ svgs: Array.from({ length: 120 }, (_, i) => ({ markup: iconN(i), name: `n${i}` })), layout: { container: "none" } }));
		expect(conn.labels()).toEqual(["Import SVG: check target", "Import SVG (50 items)", "Import SVG (50 items)", "Import SVG (20 items)"]);
		expect(b.summary.created).toBe(120);
		expect(conn.calls[2].P.layout.cursor).toMatchObject({ index: 50 });
		expect(conn.calls[3].P.final).toBe(true);
		expect(conn.calls[1].P.final).toBe(false);
		expect(fake.currentPage.children).toHaveLength(120);
	});
});

describe("files", () => {
	it("reads paths and a directory page; files beyond the 64 MiB budget go to remaining at a group boundary", async () => {
		const MiB = 1024 * 1024;
		const files: Record<string, string> = {};
		const sizes: Record<string, number> = {};
		for (const name of ["a", "b", "c", "d", "e"]) {
			for (const size of ["16", "24"]) {
				const p = `/icons/${name}-${size}.svg`;
				files[p] = iconN(name.charCodeAt(0));
				sizes[p] = 7 * MiB;
			}
		}
		const { tool } = setup({ options: { fs: memFs(files, sizes) } });
		const b = body(await tool({ directory: "/icons", variants: { pattern: "{name}-{Size}" }, dryRun: true }));
		// 4 sets × 14 MiB = 56 MiB fit; the fifth would pass 64 MiB.
		expect(b.items).toHaveLength(8);
		expect(b.remaining).toEqual({ count: 2, nextOffset: 8 });

		const pathFiles: Record<string, string> = { "/p/1.svg": iconN(1), "/p/2.svg": iconN(2), "/p/3.svg": iconN(3) };
		const pathSizes = { "/p/1.svg": 30 * MiB, "/p/2.svg": 30 * MiB, "/p/3.svg": 30 * MiB };
		const { tool: t2 } = setup({ options: { fs: memFs(pathFiles, pathSizes) } });
		const b2 = body(await t2({ paths: Object.keys(pathFiles), dryRun: true }));
		expect(b2.items.map((i: any) => i.source)).toEqual(["/p/1.svg", "/p/2.svg"]);
		expect(b2.remaining).toEqual({ count: 1, paths: ["/p/3.svg"] });
	});

	it("names directory variants from relative paths and pages with nextOffset", async () => {
		const files: Record<string, string> = {};
		for (const size of ["16", "24"]) for (const style of ["outline", "solid"]) for (const n of ["bell", "zap"]) files[`/sets/${size}/${style}/${n}.svg`] = ICON;
		const { tool, fake, conn } = setup({ options: { fs: memFs(files) } });
		const b = body(await tool({ directory: "/sets", recursive: true, variants: { pattern: "{Size}/{Style}/{name}" }, namePrefix: "Icon/", limit: 4 }));
		expect(b.componentSets).toEqual([expect.objectContaining({ name: "Icon/bell", created: true, variants: 4 })]);
		expect(b.remaining).toEqual({ count: 4, nextOffset: 4 });
		// One set group on this page: no container (spec §2.6.6 rule 1).
		expect(b.container).toBeUndefined();
		expect(conn.labels()).toEqual(["Import SVG: check target", "Import SVG (4 items)"]);
		const set = fake.currentPage.findOne((n) => n.type === "COMPONENT_SET")!;
		expect(set.children!.map((c) => c.name)).toEqual(["Size=16, Style=outline", "Size=16, Style=solid", "Size=24, Style=outline", "Size=24, Style=solid"]);
		// A read error is a failed item, not a fatal error.
		const { tool: t2 } = setup({ options: { fs: memFs({ "/a.svg": ICON }) } });
		const b2 = body(await t2({ paths: ["/a.svg", "/missing.svg"] }));
		expect(b2.items).toEqual([expect.objectContaining({ source: "/missing.svg", status: "failed", stage: "read", reason: "File not found: /missing.svg" })]);
	});
});

describe("existing components and confirmation", () => {
	function library(opts: { instances?: number; publish?: string } = {}) {
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/bell", record: { artHash: "old", colorRef: "none" } });
		comp._instances = Array.from({ length: opts.instances ?? 0 }, (_, i) => ({ name: `Use ${i}` }));
		comp._publish = opts.publish ?? "UNPUBLISHED";
		return { fake, comp };
	}
	const args = (extra: Record<string, unknown> = {}) => ({ svgs: [{ markup: ICON, name: "bell" }, { markup: iconN(3), name: "new" }], asComponent: true, namePrefix: "Icon/", ...extra });

	it("updates with instances ask first with a fingerprinted key; declined writes nothing", async () => {
		const { fake } = library({ instances: 3 });
		const { conn, tool } = setup({ fake });
		const ask = await tool(args(), FORMS);
		expect(ask.resultType).toBe("input_required");
		const key = Object.keys(ask.inputRequests)[0];
		expect(key).toMatch(/^confirm_svg_update_[0-9a-z]+$/);
		const params = ask.inputRequests[key].params;
		expect(params.message).toMatch(/^In "Acme DS", replace the artwork of 1 existing component \(used by 3 instances in this file, including "Use 0"\)\? Where the layer structure/);
		expect(params.requestedSchema.properties.choice.enum).toEqual(["update", "keep-overrides", "skip"]);
		expect(conn.labels()).toEqual(["Import SVG: check target"]);
		const declined = await tool(args(), answer(key, {}, "decline"));
		expect(body(declined)).toMatchObject({ success: false, confirmed: false });
		expect(conn.labels().filter((l) => l !== "Import SVG: check target")).toEqual([]);
	});

	it("a published target with 0 instances also asks, with the library wording", async () => {
		const { fake } = library({ publish: "CURRENT" });
		const { tool } = setup({ fake });
		const ask = await tool(args(), FORMS);
		const msg = Object.values(ask.inputRequests as Record<string, any>)[0].params.message;
		expect(msg).toContain("1 of them is published: files using this library get the new artwork when they accept the library update.");
		expect(msg).not.toContain("used by");
	});

	it("accepted 'update' saves a restore version before the first chunk and reports it", async () => {
		const { fake, comp } = library({ instances: 2 });
		const { conn, tool } = setup({ fake });
		const key = Object.keys((await tool(args(), FORMS)).inputRequests)[0];
		const b = body(await tool(args(), answer(key, { choice: "update" })));
		expect(conn.labels().slice(-3)).toEqual(["Import SVG: save a restore version", "Import SVG: container", "Import SVG (2 items)"]);
		expect(b.restorePoint).toEqual({ versionId: "4471234567", title: "Before SVG import (Figma Console MCP)" });
		expect(b.summary).toMatchObject({ created: 1, updated: 1 });
		expect(b.items[0]).toMatchObject({ status: "updated", nodeId: comp.id, update: { instanceCount: 2, published: "UNPUBLISHED" } });
		expect(conn.calls.find((c) => c.label === "Import SVG: save a restore version")!.P.description).toContain("Icon/bell");
	});

	it("keep-overrides puts keepOverrides in the chunk payload; skip writes only new items", async () => {
		const { fake } = library({ instances: 1 });
		const { conn, tool } = setup({ fake });
		const key = Object.keys((await tool(args(), FORMS)).inputRequests)[0];
		await tool(args(), answer(key, { choice: "keep-overrides" }));
		expect(conn.calls[conn.calls.length - 1].P.opts.keepOverrides).toBe(true);

		const lib2 = library({ instances: 1 });
		const s2 = setup({ fake: lib2.fake });
		const key2 = Object.keys((await s2.tool(args(), FORMS)).inputRequests)[0];
		const b = body(await s2.tool(args(), answer(key2, { choice: "skip" })));
		expect(s2.conn.labels()).not.toContain("Import SVG: save a restore version");
		const chunk = s2.conn.calls[s2.conn.calls.length - 1].P;
		expect(chunk.groups.map((g: any) => g.item.action)).toEqual(["create"]);
		expect(b.items[0]).toMatchObject({ status: "skipped", reason: '"Icon/bell" exists; left as is (you chose to import only new SVGs).' });
	});

	it("a client that can't ask skips risky updates unless onExisting was explicit or confirmations are off", async () => {
		const { fake } = library({ instances: 4 });
		const s = setup({ fake });
		const b = body(await s.tool(args()));
		expect(b.items[0]).toMatchObject({ status: "skipped", reason: '"Icon/bell" has 4 instances, and this client can\'t ask for confirmation, so it wasn\'t updated. Pass onExisting: "update" to update it anyway.' });
		expect(b.summary.created).toBe(1);

		const explicit = setup({ fake: library({ instances: 4 }).fake });
		expect(body(await explicit.tool(args({ onExisting: "update" }))).summary).toMatchObject({ updated: 1, created: 1 });

		process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE = "off";
		const off = setup({ fake: library({ instances: 4 }).fake });
		expect(body(await off.tool(args(), FORMS)).summary).toMatchObject({ updated: 1 });
	});

	it("non-risky updates proceed without asking or a restore version", async () => {
		const { fake } = library();
		const { conn, tool } = setup({ fake });
		const b = body(await tool(args(), FORMS));
		expect(b.summary).toMatchObject({ updated: 1, created: 1 });
		expect(conn.labels()).not.toContain("Import SVG: save a restore version");
		expect(b.restorePoint).toBeUndefined();
	});

	it("a null versionId skips the risky updates and still imports the new items", async () => {
		const { fake } = library({ instances: 1 });
		fake.versionResult = null;
		const { tool } = setup({ fake });
		const b = body(await tool(args({ onExisting: "update" })));
		expect(b.items[0]).toMatchObject({ status: "skipped", reason: "Couldn't save a restore version first (Figma returned no version id), so existing components weren't changed." });
		expect(b.summary.created).toBe(1);
		expect(b.restorePoint).toBeUndefined();
	});

	it("unchanged items cause no write and no confirmation; metadata items travel without markup", async () => {
		const fake = new FakeFigma();
		const { conn, tool } = setup({ fake });
		await tool({ svgs: [{ markup: ICON, name: "bell" }], asComponent: true, namePrefix: "Icon/" });
		const comp = fake.currentPage.findOne((n) => n.type === "COMPONENT")!;
		comp._instances = [{ name: "x" }];
		conn.calls.length = 0;
		const again = body(await tool({ svgs: [{ markup: ICON, name: "bell" }], asComponent: true, namePrefix: "Icon/" }, FORMS));
		expect(conn.labels()).toEqual(["Import SVG: check target"]);
		expect(again.unchanged).toEqual([["svgs[0]", "Icon/bell", comp.id]]);
		conn.calls.length = 0;
		const meta = body(await tool({ svgs: [{ markup: ICON, name: "bell", description: "A bell" }], asComponent: true, namePrefix: "Icon/" }, FORMS));
		const chunk = conn.calls.find((c) => c.label.startsWith("Import SVG ("))!;
		expect(chunk.P.groups[0].item).toMatchObject({ action: "metadata", description: "A bell" });
		expect(chunk.P.groups[0].item.markup).toBeUndefined();
		expect(meta.unchanged).toEqual([["svgs[0]", "Icon/bell", comp.id, "metadata"]]);
		expect(comp.description).toBe("A bell");
	});

	it("adding variants to an existing set creates no container", async () => {
		const fake = new FakeFigma();
		const set = new FNode("COMPONENT_SET", fake);
		set.name = "Icon/zap";
		set._w = 56;
		set._h = 56;
		fake.currentPage.appendChild(set);
		makeIconComponent(fake, { name: "Size=16", parent: set, record: { artHash: "x" } });
		const other = new FNode("COMPONENT_SET", fake);
		other.name = "Icon/bell";
		fake.currentPage.appendChild(other);
		makeIconComponent(fake, { name: "Size=16", parent: other, record: { artHash: "x" } });
		const { conn, tool } = setup({ fake });
		const b = body(
			await tool({
				svgs: [
					{ markup: ICON, name: "zap-24" },
					{ markup: ICON, name: "bell-24" },
				],
				variants: { pattern: "{name}-{Size}" },
				namePrefix: "Icon/",
			}),
		);
		expect(conn.labels()).toEqual(["Import SVG: check target", "Import SVG (2 items)"]);
		expect(b.container).toBeUndefined();
		expect(b.componentSets.map((x: any) => [x.name, x.created, x.added])).toEqual([
			["Icon/zap", false, 1],
			["Icon/bell", false, 1],
		]);
	});

	it("conflicts for many matches and ineligible components", async () => {
		const fake = new FakeFigma();
		makeIconComponent(fake, { name: "Icon/dup" });
		makeIconComponent(fake, { name: "Icon/dup" });
		const t = makeIconComponent(fake, { name: "Icon/text" });
		t.appendChild(new FNode("TEXT", fake));
		const { tool } = setup({ fake });
		const r = await tool({ svgs: [{ markup: ICON, name: "dup" }, { markup: ICON, name: "text" }], asComponent: true, namePrefix: "Icon/" });
		const b = body(r);
		expect(r.isError).toBe(true);
		expect(b.items.map((i: any) => i.status)).toEqual(["conflict", "conflict"]);
		expect(b.items[0].reason).toMatch(/^2 components are named "Icon\/dup" \(ids .+\)\. Rename them so one is left, or pass onExisting: "duplicate"\.$/);
		expect(b.items[1].reason).toBe('"Icon/text" isn\'t plain vector artwork (it contains a text layer), so it wasn\'t replaced. Rename the import (namePrefix) or pass onExisting: "duplicate".');
	});
});

describe("run control", () => {
	it("after a timeout nothing more is sent and the response carries incomplete with the runId", async () => {
		let chunks = 0;
		const { conn, tool } = setup({
			intercept: (label) => {
				if (label.startsWith("Import SVG (") && ++chunks === 2) return new Error("WebSocket command EXECUTE_CODE timed out after 30000ms.");
				return undefined;
			},
		});
		const b = body(await tool({ svgs: Array.from({ length: 120 }, (_, i) => ({ markup: iconN(i), name: `n${i}` })), layout: { container: "none" } }));
		expect(conn.labels()).toEqual(["Import SVG: check target", "Import SVG (50 items)", "Import SVG (50 items)"]);
		expect(b.incomplete.runId).toBe(b.runId);
		expect(b.incomplete.reason).toMatch(/^Figma didn't answer in time \(or the connection dropped\) and may still be importing\. Nothing more was sent\./);
		expect(b.incomplete.notAttempted).toHaveLength(20);
		expect(b.incomplete.inProgress).toHaveLength(50);
		// Not-attempted items have no status, so they aren't listed as failures.
		expect(b.items.map((i: any) => i.status)).toEqual(Array(50).fill("unknown"));
		expect(b.summary.failed).toBe(0);
		expect(b.summary.created).toBe(50);
		// 70 of 120 aren't confirmed: not a success.
		expect(b.success).toBe(false);
		expect(b.hint).toContain(`resumeRunId: "${b.runId}"`);
	});

	it("a plugin-side timeout envelope counts as maybeRunning; a script error fails only its chunk", async () => {
		const { conn, tool } = setup({ intercept: (label) => (label === "Import SVG (1 items)" ? { success: false, error: "Error: Execution timed out after 5000ms" } : undefined) });
		const b = body(await tool({ svgs: [{ markup: ICON }] }));
		expect(b.incomplete).toBeDefined();
		expect(b.items[0]).toMatchObject({ status: "unknown" });
		expect(conn.calls).toHaveLength(2);
		let n = 0;
		const s2 = setup({ intercept: (label) => (label.startsWith("Import SVG (") && ++n === 1 ? { success: false, error: "TypeError: boom" } : undefined) });
		const b2 = body(await s2.tool({ svgs: Array.from({ length: 60 }, (_, i) => ({ markup: iconN(i), name: `n${i}` })), layout: { container: "none" } }));
		expect(b2.summary).toMatchObject({ failed: 50, created: 10 });
		expect(b2.incomplete).toBeUndefined();
	});

	it("resumeRunId reports what the interrupted run created instead of importing it again", async () => {
		let chunks = 0;
		const fake = new FakeFigma();
		const svgs = Array.from({ length: 60 }, (_, i) => ({ markup: iconN(i), name: `n${i}` }));
		const first = setup({ fake, intercept: (label) => (label.startsWith("Import SVG (") && ++chunks === 2 ? new Error("Command EXECUTE_CODE timed out after 1ms") : undefined) });
		const b1 = body(await first.tool({ svgs, layout: { container: "none" } }));
		expect(b1.summary.created).toBe(50);
		const second = setup({ fake });
		const b2 = body(await second.tool({ svgs, layout: { container: "none" }, resumeRunId: b1.runId }));
		expect(b2.summary).toMatchObject({ unchanged: 50, created: 10 });
		expect(fake.currentPage.children).toHaveLength(60);
	});

	it("a preflight timeout changes nothing and says so; the busy marker refuses a second run", async () => {
		const s = setup({ intercept: () => new Error("WebSocket command EXECUTE_CODE timed out after 60000ms.") });
		const r = await s.tool({ svgs: [{ markup: ICON }] });
		expect(r.isError).toBe(true);
		expect(body(r).error).toMatch(/^Figma didn't answer the pre-import check in time .*Nothing was changed\.$/);
		(globalThis as any).__figmaConsoleSvgImport = { runId: "x", startedAt: Date.now() };
		const busy = await setup().tool({ svgs: [{ markup: ICON }] });
		expect(body(busy).error).toMatch(/^An earlier SVG import is still running in Figma/);
	});

	it("passes fileKey to every call", async () => {
		const { conn, tool } = setup();
		await tool({ svgs: [{ markup: ICON }], fileKey: "OTHER" });
		expect(conn.calls.every((c) => c.fileKey === "OTHER")).toBe(true);
	});
});

describe("output", () => {
	it("compact lists by default; verbose returns full objects; moreItems beyond 150", async () => {
		const { tool } = setup();
		const svgs = [...Array.from({ length: 160 }, () => ({ markup: "<html/>" })), { markup: ICON, name: "ok" }];
		const b = body(await tool({ svgs }));
		expect(b.items).toHaveLength(150);
		expect(b.moreItems).toEqual({ count: 10, byStatus: { failed: 10 } });
		expect(b.created).toHaveLength(1);
		const v = body(await setup().tool({ svgs: [{ markup: ICON, name: "a" }], verbose: true }));
		expect(v.created).toBeUndefined();
		expect(v.items[0]).toMatchObject({ source: "svgs[0]", name: "a", status: "created", type: "FRAME" });
	});

	it("binds a local color variable end to end", async () => {
		const fake = new FakeFigma();
		fake.collections = [{ id: "C1", name: "Icons" }];
		fake.localVariables = [{ id: "V1", key: "K1", name: "icon/default", resolvedType: "COLOR", variableCollectionId: "C1" }];
		const { tool } = setup({ fake });
		const b = body(await tool({ svgs: [{ markup: ICON, name: "rocket" }], asComponent: true, size: 24, flatten: true, color: { variable: "icon/default" }, verbose: true }));
		expect(b.items[0].color).toMatchObject({ applied: true, mode: "variable", variable: "Icons/icon/default", source: "currentColor" });
		const comp = fake.currentPage.findOne((n) => n.type === "COMPONENT")!;
		expect(JSON.parse(comp.getPluginData("svgImport")).colorRef).toBe("var:K1");
	});
});

describe("MCP tasks", () => {
	it("asks before the task starts, then runs the write phase as a task", async () => {
		const server = new McpServer({ name: "tasks", version: "0" });
		installTasks(server);
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/bell", record: { artHash: "old" } });
		comp._instances = [{ name: "x" }];
		const { conn, tool } = setup({ fake });
		const caps = { elicitation: { form: {} }, extensions: { [TASKS_EXTENSION_ID]: {} } };
		const ctx = { mcpReq: { envelope: { "io.modelcontextprotocol/clientCapabilities": caps } } };
		const a = { svgs: [{ markup: ICON, name: "bell" }], asComponent: true, namePrefix: "Icon/" };
		const ask = await tool(a, ctx);
		expect(ask.resultType).toBe("input_required");
		const key = Object.keys(ask.inputRequests)[0];
		const handle = await tool(a, { mcpReq: { ...ctx.mcpReq, inputResponses: { [key]: { action: "accept", content: { choice: "update" } } } } });
		expect(handle.resultType).toBe("task");
		let view = defaultTaskStore.get(handle.taskId)!;
		for (let i = 0; i < 100 && view.status === "working"; i++) {
			await new Promise((r) => setTimeout(r, 5));
			view = defaultTaskStore.get(handle.taskId)!;
		}
		expect(view.status).toBe("completed");
		const result = view.result as { content: Array<{ text: string }> };
		expect(JSON.parse(result.content[0].text).summary.updated).toBe(1);
		expect(conn.labels()).toContain("Import SVG: save a restore version");
		await server.close();
	});
});

describe("schema", () => {
	it("accepts the documented examples", () => {
		const { IMPORT_SVG_SCHEMA } = require("../../src/core/asset-tools");
		const schema = IMPORT_SVG_SCHEMA as z.ZodTypeAny;
		expect(
			schema.safeParse({
				svgs: [{ name: "rocket", markup: "<svg/>" }],
				asComponent: true,
				size: 24,
				namePrefix: "Icon/",
				color: { variable: "icon/default" },
				flatten: true,
			}).success,
		).toBe(true);
		expect(schema.safeParse({ resumeRunId: "XYZ" }).success).toBe(false);
	});
});

describe("review fixes", () => {
	/** Two open files behind one connector that routes like websocket-server.ts: fileKey, else the active file. */
	function twoFiles() {
		const A = new FakeFigma();
		A.fileKey = "FILE_A";
		const B = new FakeFigma();
		B.fileKey = "FILE_B";
		const files: Record<string, FakeFigma> = { FILE_A: A, FILE_B: B };
		const state = { active: "FILE_A" };
		const calls: Array<{ label: string; routed: string }> = [];
		const conn = {
			async executeCodeViaUI(code: string, _t: number, fileKey?: string) {
				const routed = fileKey || state.active;
				calls.push({ label: code.split("\n")[0].replace(/^\/\/ /, ""), routed });
				const out = await (async () => {
					try {
						return { success: true, result: await runScript(code, files[routed].api()) };
					} catch (e) {
						return { success: false, error: `Error: ${(e as Error).message}` };
					}
				})();
				// The person clicks into file B right after the preflight answered.
				if (calls.length === 1) state.active = "FILE_B";
				return out;
			},
		};
		const tools: Record<string, Handler> = {};
		const server = { registerTool: (name: string, _cfg: unknown, h: Handler) => (tools[name] = h), server: { getClientCapabilities: () => undefined } };
		return { A, B, state, calls, conn, server, tools };
	}

	it("every write step goes to the file the preflight checked, even when another file becomes active", async () => {
		const t = twoFiles();
		registerAssetTools(t.server as any, async () => t.conn, { fs: memFs({}) });
		const b = body(await t.tools.figma_import_svg({ svgs: [{ markup: ICON, name: "arrow" }, { markup: iconN(2), name: "check" }], asComponent: true }));
		expect(b.success).toBe(true);
		expect(t.calls.map((c) => c.routed)).toEqual(["FILE_A", "FILE_A", "FILE_A"]);
		expect(t.A.currentPage.findAll((n) => n.type === "COMPONENT")).toHaveLength(2);
		expect(t.B.currentPage.children).toHaveLength(0);
	});

	it("a write step that reaches another file anyway (Cloud has no routing) refuses and stops the run", async () => {
		const t = twoFiles();
		registerAssetTools(t.server as any, async () => t.conn, { isRemoteMode: true });
		const b = body(await t.tools.figma_import_svg({ svgs: [{ markup: ICON, name: "a" }, { markup: iconN(2), name: "b" }] }));
		// Cloud never passes fileKey; the plugin-side check catches the switch.
		expect(t.calls.map((c) => c.routed)).toEqual(["FILE_A", "FILE_B"]);
		expect(t.B.currentPage.children).toHaveLength(0);
		expect(b.success).toBe(false);
		expect(b.incomplete.reason).toMatch(/^This step reached a different Figma file than the one checked at the start of this call/);
		expect(b.incomplete.notAttempted).toEqual(["a", "b"]);
	});

	it("a chain of resumes never re-imports what an earlier call of the run placed", async () => {
		const fake = new FakeFigma();
		const svgs = Array.from({ length: 150 }, (_, i) => ({ markup: iconN(i), name: `n${i}` }));
		const timeoutOnSecondChunk = () => {
			let n = 0;
			return (label: string) => (label.startsWith("Import SVG (") && ++n === 2 ? new Error("WebSocket command EXECUTE_CODE timed out after 30000ms.") : undefined);
		};
		const a = body(await setup({ fake, intercept: timeoutOnSecondChunk() }).tool({ svgs, layout: { container: "none" } }));
		expect(fake.currentPage.children).toHaveLength(50);
		const b = body(await setup({ fake, intercept: timeoutOnSecondChunk() }).tool({ svgs, layout: { container: "none" }, resumeRunId: a.runId }));
		expect(b.runId).toBe(a.runId);
		expect(b.incomplete.runId).toBe(a.runId);
		expect(fake.currentPage.children).toHaveLength(100);
		const c = body(await setup({ fake }).tool({ svgs, layout: { container: "none" }, resumeRunId: b.incomplete.runId }));
		expect(c.summary).toMatchObject({ unchanged: 100, created: 50 });
		expect(fake.currentPage.children).toHaveLength(150);
	});

	it("dryRun: success reflects planned conflicts, and the risky-update prediction matches what a real run does on this client", async () => {
		const fake = new FakeFigma();
		makeIconComponent(fake, { name: "Icon/dup" });
		makeIconComponent(fake, { name: "Icon/dup" });
		const conflict = body(await setup({ fake }).tool({ svgs: [{ markup: ICON, name: "dup" }], asComponent: true, namePrefix: "Icon/", dryRun: true }));
		expect(conflict.success).toBe(false);
		expect(conflict.items[0].action).toBe("conflict");

		const risky = () => {
			const f = new FakeFigma();
			makeIconComponent(f, { name: "Icon/bell", record: { artHash: "old" } })._instances = [{ name: "x" }, { name: "y" }];
			return f;
		};
		const dry = (extra: Record<string, unknown> = {}, ctx?: unknown) =>
			setup({ fake: risky() }).tool({ svgs: [{ markup: ICON, name: "bell" }], asComponent: true, namePrefix: "Icon/", dryRun: true, ...extra }, ctx).then(body);
		// No way to ask (v1 SDK / Cloud, no forms): the real run skips the update.
		const noAsk = await dry();
		expect(noAsk.items[0]).toMatchObject({ action: "skip", reason: '"Icon/bell" has 2 instances, and this client can\'t ask for confirmation, so a real run would skip it. Pass onExisting: "update" to update it anyway.' });
		expect(noAsk.confirmation).toEqual({ wouldAsk: false });
		const real = body(await setup({ fake: risky() }).tool({ svgs: [{ markup: ICON, name: "bell" }], asComponent: true, namePrefix: "Icon/" }));
		expect(real.items[0].status).toBe("skipped");
		// Explicit onExisting: updates without asking.
		const explicit = await dry({ onExisting: "update" });
		expect([explicit.items[0].action, explicit.confirmation.wouldAsk]).toEqual(["update", false]);
		// Confirmations off: updates without asking.
		process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE = "off";
		const off = await dry({}, FORMS);
		expect([off.items[0].action, off.confirmation.wouldAsk]).toEqual(["update", false]);
		delete process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE;
		// A client with forms is asked.
		const forms = await dry({}, FORMS);
		expect([forms.items[0].action, forms.confirmation.wouldAsk]).toEqual(["update", true]);
	});

	it("a restore version doesn't stall the run: the first chunk launches even when its timeout fills the budget; a resume reuses the version", async () => {
		// Slow-machine scale 10: one 400 KB update chunk has a 264 s timeout against the 240 s sync budget.
		process.env.FIGMA_CONSOLE_ASSET_TIMEOUT_SCALE = "10";
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/map", record: { artHash: "old" } });
		comp._instances = [{ name: "x" }];
		const big = svg(`<path d="M0 0${"h1".repeat(200_000)}" fill="#000"/>`);
		const { conn, tool } = setup({ fake });
		const b = body(await tool({ svgs: [{ markup: big, name: "map" }], asComponent: true, namePrefix: "Icon/", onExisting: "update" }));
		expect(conn.labels()).toEqual(["Import SVG: check target", "Import SVG: save a restore version", "Import SVG (1 items)"]);
		expect(b.summary.updated).toBe(1);
		// A resume of the same run finds the version it saved and doesn't save another.
		const again = setup({ fake });
		comp.setPluginData("svgImport", JSON.stringify({ v: 1, artHash: "older", colorRef: "none" }));
		const b2 = body(await again.tool({ svgs: [{ markup: big, name: "map" }], asComponent: true, namePrefix: "Icon/", onExisting: "update", resumeRunId: b.runId }));
		expect(again.conn.labels()).not.toContain("Import SVG: save a restore version");
		expect(b2.restorePoint).toEqual(b.restorePoint);
	});

	it("a busy marker that appears mid-run stops it with the items not attempted; a parallel call is refused by the write lock", async () => {
		let n = 0;
		const s = setup({
			intercept: (label) => {
				if (label.startsWith("Import SVG (") && ++n === 2) (globalThis as any).__figmaConsoleImageImport = { runId: "otherrun0000", startedAt: Date.now(), token: "t" };
				return undefined;
			},
		});
		const b = body(await s.tool({ svgs: Array.from({ length: 60 }, (_, i) => ({ markup: iconN(i), name: `n${i}` })), layout: { container: "none" } }));
		expect(b.summary.created).toBe(50);
		expect(b.incomplete.reason).toMatch(/^Another image import is still writing in Figma/);
		expect(b.incomplete.notAttempted).toHaveLength(10);
		expect(b.success).toBe(false);
		delete (globalThis as any).__figmaConsoleImageImport;

		// Two calls in parallel: the second passes its preflight but can't take the file's write lock.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const fake = new FakeFigma();
		const slow = setup({ fake, intercept: (label) => (label.startsWith("Import SVG (") ? gate.then(() => ({ success: true, result: { results: [] } })) : undefined) });
		const first = slow.tool({ svgs: [{ markup: ICON }] });
		await new Promise((r) => setTimeout(r, 10));
		const second = await setup({ fake }).tool({ svgs: [{ markup: ICON }] });
		expect(second.isError).toBe(true);
		expect(body(second).error).toMatch(/^Another figma_import_svg or figma_import_image call is still writing to this file/);
		release();
		await first;
		// Released afterwards.
		expect(body(await setup({ fake }).tool({ svgs: [{ markup: ICON }] })).summary.created).toBe(1);
	});

	it("directory paging: a name taken on an earlier page fails instead of overwriting; a set over 100 files reads only 100", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 150; i++) files[`/icons/16/a${String(i).padStart(3, "0")}.svg`] = iconN(i);
		files["/icons/16/arrow.svg"] = iconN(500);
		for (let i = 0; i < 100; i++) files[`/icons/24/aa${String(i).padStart(3, "0")}.svg`] = iconN(i);
		files["/icons/24/arrow.svg"] = iconN(501);
		const fake = new FakeFigma();
		const fs = memFs(files);
		const { tool } = setup({ fake, options: { fs } });
		const p1 = body(await tool({ directory: "/icons", recursive: true, asComponent: true, layout: { container: "none" } }));
		expect(p1.remaining.nextOffset).toBe(200);
		const p2 = body(await setup({ fake, options: { fs } }).tool({ directory: "/icons", recursive: true, asComponent: true, layout: { container: "none" }, offset: 200 }));
		const arrow = p2.items.find((i: any) => i.source === "24/arrow.svg");
		expect(arrow).toMatchObject({ status: "failed", reason: expect.stringMatching(/^Another SVG in this folder is also named "arrow" \(16\/arrow.svg\), on an earlier page/) });
		expect(p2.summary.updated).toBe(0);

		const reads: string[] = [];
		const setFiles: Record<string, string> = {};
		for (let i = 0; i < 300; i++) setFiles[`/set/icon-${i}.svg`] = iconN(i);
		const counting = memFs(setFiles);
		const read = counting.readSvgFile;
		counting.readSvgFile = async (p: string, m: number) => (reads.push(p), read(p, m));
		const s = body(await setup({ options: { fs: counting } }).tool({ directory: "/set", variants: { pattern: "{name}-{Size}" }, limit: 200, dryRun: true }));
		expect(reads).toHaveLength(100);
		expect(s.summary.requested).toBe(300);
		expect(s.summary.actions).toMatchObject({ create: 100, fail: 200 });
		expect(s.remaining).toBeUndefined();

		// A set that alone is more than one call reads (64 MB) fails unread instead of stalling paging.
		const huge: Record<string, string> = {};
		const sizes: Record<string, number> = {};
		for (let i = 0; i < 80; i++) {
			huge[`/huge/logo-${i}.svg`] = iconN(i);
			sizes[`/huge/logo-${i}.svg`] = 1024 * 1024;
		}
		huge["/huge/zz.svg"] = iconN(999);
		const hugeFs = memFs(huge, sizes);
		const hugeRead = hugeFs.readSvgFile;
		const hugeReads: string[] = [];
		hugeFs.readSvgFile = async (p: string, m: number) => (hugeReads.push(p), hugeRead(p, m));
		const h = body(await setup({ options: { fs: hugeFs } }).tool({ directory: "/huge", variants: { pattern: "{name}-{Size}" }, dryRun: true }));
		expect(hugeReads).toEqual([]);
		expect(h.items[0]).toMatchObject({ action: "fail", reason: "This file's variant set is 80 MB of SVG files; one call reads at most 64 MB. Simplify the SVGs or split the set." });
		expect(h.remaining).toEqual({ count: 1, nextOffset: 80 });
	});
});
