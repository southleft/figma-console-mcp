/**
 * figma_export_assets handler (spec §3, §8.1 "assets-export"). The connector
 * runs the real plugin scripts against the fake Figma; file output goes to
 * real temp folders through createNodeAssetFs, so these are end to end.
 */

const mockLog = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
jest.mock("../../src/core/logger", () => ({ createChildLogger: () => mockLog, logger: mockLog }));

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { McpServer as V1McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as V1InMemory } from "@modelcontextprotocol/sdk/inMemory.js";
import { withToolIdentity } from "../../src/core/identity";
import { TASKS_EXTENSION_ID, defaultTaskStore, installTasks } from "../../src/core/tasks";
import { registerAssetTools } from "../../src/core/asset-tools";
import { createNodeAssetFs } from "../../src/core/assets/node-fs";
import type { AssetFs, AssetToolsOptions } from "../../src/core/assets/fs-types";
import { solid } from "../svg/fake-figma";
import { FakeFigma, type FakeImage, exportApi, gifBytes, imagePaint, jpegBytes, node, pngBytes, runScript, webpBytes } from "./export-fake";

const H1 = "a1".repeat(20);
const H2 = "b2".repeat(20);
const H3 = "c3".repeat(20);
const H4 = "d4".repeat(20);
const H5 = "e5".repeat(20);

interface Call {
	label: string;
	P: any;
	timeoutMs: number;
	fileKey?: string;
}

function fakeConnector(fake: FakeFigma, images: Record<string, FakeImage>, intercept?: (label: string, P: any) => unknown) {
	const calls: Call[] = [];
	return {
		calls,
		labels: () => calls.map((c) => c.label),
		renders: () => calls.filter((c) => c.label === "Export assets: render").map((c) => c.P.id),
		async executeCodeViaUI(code: string, timeoutMs: number, fileKey?: string) {
			const lines = code.split("\n");
			const label = lines[0].replace(/^\/\/ /, "");
			const P = new Function(`${lines[1]} return P;`)();
			calls.push({ label, P, timeoutMs, fileKey });
			const o = intercept?.(label, P);
			if (o !== undefined) return o instanceof Error ? Promise.reject(o) : o;
			try {
				return { success: true, result: await runScript(code, exportApi(fake, images)) };
			} catch (e) {
				return { success: false, error: `Error: ${(e as Error).message}` };
			}
		},
	};
}

type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<any>;

function setup(opts: { fake?: FakeFigma; images?: Record<string, FakeImage>; options?: AssetToolsOptions; intercept?: (label: string, P: any) => unknown } = {}) {
	const fake = opts.fake ?? new FakeFigma();
	const conn = fakeConnector(fake, opts.images ?? {}, opts.intercept);
	const tools: Record<string, Handler> = {};
	const server = { registerTool: (name: string, _cfg: unknown, h: Handler) => (tools[name] = h), server: { getClientCapabilities: () => undefined } };
	registerAssetTools(server as any, async () => conn, opts.options ?? { fs: createNodeAssetFs() });
	return { fake, conn, tool: tools.figma_export_assets };
}
const body = (r: any) => JSON.parse(r.content[0].text);

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fcm-export-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	jest.clearAllMocks();
});

const frame = (fake: FakeFigma, name: string, size: [number, number] = [100, 50], extra: Record<string, unknown> = {}) => node(fake, "FRAME", name, fake.currentPage, size, extra);
const twoColorSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1h9" stroke="#1E1E1E"/><path d="M1 5h9" fill="#FFB800"/></svg>';

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

	it("registerAssetTools lists the asset tools through withToolIdentity(McpServer), with no empty schema nodes and no propertyNames", async () => {
		const server = new (withToolIdentity(McpServer))({ name: "t", version: "0" });
		registerAssetTools(server, async () => ({}));
		const [ct, st] = InMemoryTransport.createLinkedPair();
		await server.connect(st);
		const client = new Client({ name: "c", version: "0" });
		await client.connect(ct);
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(["figma_export_assets", "figma_import_image", "figma_import_svg"]);
		const t = tools.find((x) => x.name === "figma_export_assets")!;
		expect(JSON.stringify(t)).not.toContain("propertyNames");
		expect(emptyNodes(t.inputSchema.properties)).toEqual([]);
		expect(t.description!.length).toBeLessThan(1400);
		await client.close();
		await server.close();
	});

	it("inline image and PDF resource blocks pass the SDK's result validation end to end", async () => {
		const fake = new FakeFigma();
		const png = frame(fake, "photo", [10, 10]);
		const pdf = frame(fake, "doc", [10, 10], { _pdfBytes: 2000 });
		const conn = fakeConnector(fake, {});
		const server = new (withToolIdentity(McpServer))({ name: "t", version: "0" });
		registerAssetTools(server, async () => conn, { fs: createNodeAssetFs() });
		const [ct, st] = InMemoryTransport.createLinkedPair();
		await server.connect(st);
		const client = new Client({ name: "c", version: "0" });
		await client.connect(ct);
		const a = (await client.callTool({ name: "figma_export_assets", arguments: { nodeIds: [png.id], output: "inline" } })) as any;
		expect(a.isError).toBeFalsy();
		expect(a.content.map((c: any) => c.type)).toEqual(["text", "image"]);
		const b = (await client.callTool({ name: "figma_export_assets", arguments: { nodeIds: [pdf.id], output: "inline", format: "PDF" } })) as any;
		expect(b.content.map((c: any) => c.type)).toEqual(["text", "resource"]);
		expect(b.content[1].resource.mimeType).toBe("application/pdf");
		expect(JSON.parse(b.content[0].text)._mcp).toBeDefined();
		await client.close();
		await server.close();
	});

	it("the v1 SDK server (Cloud path) lists and validates the export tool", async () => {
		const server = new (withToolIdentity(V1McpServer))({ name: "cloud", version: "0" });
		registerAssetTools(server as any, async () => ({}), { isRemoteMode: true });
		const [ct, st] = V1InMemory.createLinkedPair();
		await server.connect(st);
		const client = new V1Client({ name: "c", version: "0" });
		await client.connect(ct);
		const { tools } = await client.listTools();
		expect(tools.map((x) => x.name)).toContain("figma_export_assets");
		expect((await client.callTool({ name: "figma_export_assets", arguments: { format: "GIF" } })).isError).toBe(true);
		const files = await client.callTool({ name: "figma_export_assets", arguments: { output: "files" } });
		expect(files.isError).toBe(true);
		expect(JSON.stringify(files.content)).toContain("Writing files is Local Mode only.");
		await client.close();
		await server.close();
	});
});

describe("Cloud Mode", () => {
	it("rejects outputDir and output files before any connector call, and defaults to inline", async () => {
		const fake = new FakeFigma();
		const f = frame(fake, "card");
		const { conn, tool } = setup({ fake, options: { isRemoteMode: true } });
		for (const args of [{ output: "files" }, { outputDir: "/tmp/x" }, { overwrite: true }]) {
			const r = await tool(args);
			expect(r.isError).toBe(true);
			expect(body(r).error).toBe('Writing files is Local Mode only. In Cloud Mode use output "inline" (to look at assets) or "urls" (Figma-hosted links to download).');
		}
		expect(conn.calls).toHaveLength(0);
		const r = await tool({ nodeIds: [f.id] });
		expect(body(r)).toMatchObject({ success: true, output: "inline", assets: [{ nodeId: f.id, format: "PNG", block: 2, file: "card.png" }] });
		expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("urls without getFigmaAPI, or with a throwing one, returns the token message without any token text", async () => {
		const tokenMsg = 'output "urls" needs a Figma access token (FIGMA_ACCESS_TOKEN in Local Mode). Use output "files" or "inline".';
		const a = setup({ options: { isRemoteMode: true } });
		expect(body(await a.tool({ output: "urls" })).error).toBe(tokenMsg);
		const secret = "figd_SUPERSECRETTOKEN123";
		const b = setup({
			options: {
				isRemoteMode: true,
				getFigmaAPI: async () => {
					throw new Error(`token ${secret} was rejected`);
				},
			},
		});
		const r = await b.tool({ output: "urls" });
		expect(body(r).error).toBe(tokenMsg);
		expect(JSON.stringify(r)).not.toContain("figd_");
		expect(JSON.stringify(mockLog.info.mock.calls) + JSON.stringify(mockLog.error.mock.calls)).not.toContain("SUPERSECRET");
		expect(a.conn.calls.length + b.conn.calls.length).toBe(0);
	});
});

describe("files (Local Mode, real filesystem)", () => {
	it("writes renders with a fileName template and reports absolute paths", async () => {
		const fake = new FakeFigma();
		const set = node(fake, "COMPONENT_SET", "Icon/arrow", fake.currentPage, [100, 100]);
		const v = node(fake, "COMPONENT", "Size=24, Style=outline", set);
		const plain = frame(fake, "Icon/logo", [32, 32]);
		const { tool, conn } = setup({ fake });
		const r = await tool({ nodeIds: [v.id, plain.id], format: "SVG", outputDir: dir, fileName: "{set}/{variant}" });
		const b = body(r);
		expect(r.isError).toBeUndefined();
		expect(b.success).toBe(true);
		expect(b.outputDir).toBe(require("fs").realpathSync(dir));
		expect(b.assets.map((a: any) => a.path.slice(b.outputDir.length + 1))).toEqual(["Icon-arrow/24-outline.svg", "Icon-logo.svg"]);
		expect(b.assets[0]).toMatchObject({ nodeId: v.id, format: "SVG", width: 24, height: 24, mimeType: "image/svg+xml" });
		expect(readFileSync(join(dir, "Icon-arrow/24-outline.svg"), "utf8")).toContain("<svg");
		expect(b.totals).toMatchObject({ assets: 2, vectors: 0, images: 0, inlineBytes: 0 });
		expect(conn.labels()).toEqual(["Export assets: resolve nodes", "Export assets: render", "Export assets: render"]);
	});

	it("format omitted → one file per Export setting with Figma's suffixes; explicit scale overrides", async () => {
		const fake = new FakeFigma();
		const hero = frame(fake, "hero", [720, 480], {
			exportSettings: [
				{ format: "PNG", suffix: "", constraint: { type: "SCALE", value: 1 } },
				{ format: "PNG", suffix: "@2x", constraint: { type: "SCALE", value: 2 } },
				{ format: "SVG", suffix: "" },
			],
		});
		const { tool } = setup({ fake });
		const b = body(await tool({ nodeIds: [hero.id], outputDir: dir }));
		expect(readdirSync(dir).sort()).toEqual(["hero.png", "hero.svg", "hero@2x.png"]);
		expect(b.assets[1]).toMatchObject({ format: "PNG", scale: 2, suffix: "@2x", width: 1440, height: 960 });
		const three = body(await tool({ nodeIds: [hero.id], outputDir: dir, scale: 3 }));
		expect(three.assets).toEqual([expect.objectContaining({ scale: 3, suffix: "@3x", width: 2160, height: 1440 })]);
		expect(existsSync(join(dir, "hero@3x.png"))).toBe(true);
	});

	it("an existing file is skipped before export (no render for it); overwrite replaces it via writeReplace", async () => {
		const fake = new FakeFigma();
		const a = frame(fake, "logo", [10, 10]);
		const b2 = frame(fake, "mark", [10, 10]);
		writeFileSync(join(dir, "logo.svg"), "OLD");
		const real = createNodeAssetFs();
		const spyFs: AssetFs = { ...real, writeReplace: jest.fn(real.writeReplace), writeNew: jest.fn(real.writeNew) };
		const { tool, conn } = setup({ fake, options: { fs: spyFs } });
		const r = body(await tool({ nodeIds: [a.id, b2.id], format: "SVG", outputDir: dir }));
		expect(r.success).toBe(false);
		expect(r.skipped).toEqual([{ nodeId: a.id, file: "logo.svg", reason: '"logo.svg" already exists. Pass overwrite: true to replace it.' }]);
		expect(conn.renders()).toEqual([b2.id]);
		expect(readFileSync(join(dir, "logo.svg"), "utf8")).toBe("OLD");
		const again = body(await tool({ nodeIds: [a.id], format: "SVG", outputDir: dir, overwrite: true }));
		expect(again.success).toBe(true);
		expect(spyFs.writeReplace).toHaveBeenCalledTimes(1);
		expect(readFileSync(join(dir, "logo.svg"), "utf8")).toContain("<svg");
	});

	it("a file that appears mid-call is left as is", async () => {
		const fake = new FakeFigma();
		const a = frame(fake, "logo", [10, 10]);
		const real = createNodeAssetFs();
		const racy: AssetFs = { ...real, writeNew: async () => "exists" };
		const { tool } = setup({ fake, options: { fs: racy } });
		const r = await tool({ nodeIds: [a.id], format: "SVG", outputDir: dir });
		expect(r.isError).toBe(true);
		expect(body(r).skipped).toEqual([{ nodeId: a.id, file: "logo.svg", reason: '"logo.svg" appeared while exporting; left as is.' }]);
	});

	it("defaults to a fresh private temp folder", async () => {
		const fake = new FakeFigma();
		const a = frame(fake, "x", [10, 10]);
		const { tool } = setup({ fake });
		const b = body(await tool({ nodeIds: [a.id] }));
		try {
			expect(b.outputDir).toMatch(/figma-console-mcp-export-[^/]+$/);
			expect(existsSync(join(b.outputDir, "x.png"))).toBe(true);
		} finally {
			rmSync(b.outputDir, { recursive: true, force: true });
		}
	});

	it("svg.currentColor makes single-color icons code-ready and notes multi-color ones", async () => {
		const fake = new FakeFigma();
		const icon = frame(fake, "arrow", [24, 24]);
		const duo = frame(fake, "duo", [24, 24], { _svg: twoColorSvg });
		const { tool } = setup({ fake });
		const b = body(await tool({ nodeIds: [icon.id, duo.id], format: "SVG", outputDir: dir, svg: { currentColor: true, removeSize: true } }));
		const arrow = readFileSync(join(dir, "arrow.svg"), "utf8");
		expect(arrow).toContain('stroke="currentColor"');
		expect(arrow).not.toMatch(/<svg[^>]* width=/);
		expect(b.assets[0].bytes).toBe(Buffer.byteLength(arrow));
		expect(readFileSync(join(dir, "duo.svg"), "utf8")).toContain("#FFB800");
		expect(b.notes).toContain("duo: multi-color, left as is.");
	});

	it("images only: original files named by hash, deduped, with MIME sniffing", async () => {
		const fake = new FakeFigma();
		const screen = frame(fake, "Screen", [400, 800]);
		const paints: Array<[string, string]> = [
			[H1, "hero"],
			[H1, "thumb"],
			[H2, "jpeg"],
			[H3, "gif"],
			[H4, "webp"],
			[H5, "mystery"],
		];
		for (const [h, name] of paints) node(fake, "RECTANGLE", name, screen, [40, 40]).fills = [imagePaint(h)];
		const images = {
			[H1]: { bytes: pngBytes(3000, 2000, 300), width: 3000, height: 2000 },
			[H2]: { bytes: jpegBytes(10, 10), width: 10, height: 10 },
			[H3]: { bytes: gifBytes(), width: 1, height: 1 },
			[H4]: { bytes: webpBytes(), width: 1, height: 1 },
			[H5]: { bytes: new Uint8Array([1, 2, 3, 4, 5]), width: 0, height: 0 },
		};
		const { tool, conn } = setup({ fake, images });
		const b = body(await tool({ nodeIds: [screen.id], images: "only", outputDir: dir }));
		expect(conn.renders()).toEqual([]);
		expect(b.assets).toEqual([]);
		expect(b.images.map((im: any) => [im.mimeType, im.path.slice(b.outputDir.length + 1)])).toEqual([
			["image/png", `image-${H1.slice(0, 12)}.png`],
			["image/jpeg", `image-${H2.slice(0, 12)}.jpg`],
			["image/gif", `image-${H3.slice(0, 12)}.gif`],
			["image/webp", `image-${H4.slice(0, 12)}.webp`],
			["application/octet-stream", `image-${H5.slice(0, 12)}.bin`],
		]);
		expect(b.images[0]).toMatchObject({ imageHash: H1, width: 3000, height: 2000, bytes: 300, usedBy: [{ name: "hero" }, { name: "thumb" }] });
		expect(readFileSync(b.images[0].path).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	});

	it("explicit imageHashes alone export just those images; a missing one is reported", async () => {
		const fake = new FakeFigma();
		(fake.currentPage as any).selection = [frame(fake, "selected")];
		const { tool, conn } = setup({ fake, images: { [H1]: { bytes: pngBytes(5, 5), width: 5, height: 5 } } });
		const b = body(await tool({ imageHashes: [H1, H2.toUpperCase()], outputDir: dir }));
		expect(conn.renders()).toEqual([]);
		expect(b.images.map((im: any) => im.imageHash)).toEqual([H1]);
		expect(b.skipped).toEqual([{ imageHash: H2, reason: `Image ${H2} isn't in this file.` }]);
	});

	it("refuses to write through a symlinked folder", async () => {
		const fake = new FakeFigma();
		const a = frame(fake, "Icons/arrow", [10, 10]);
		const outside = mkdtempSync(join(tmpdir(), "fcm-outside-"));
		try {
			require("fs").symlinkSync(outside, join(dir, "Icons"));
			const { tool } = setup({ fake });
			const r = await tool({ nodeIds: [a.id], format: "SVG", outputDir: dir, fileName: "{path}" });
			expect(body(r).skipped).toEqual([{ nodeId: a.id, file: "Icons/arrow.svg", reason: "Won't write through a symbolic link: Icons." }]);
			expect(readdirSync(outside)).toEqual([]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("inline", () => {
	const inlineSetup = (fake: FakeFigma) => setup({ fake, options: { fs: createNodeAssetFs() } });

	it("PNG/JPG come back as image blocks with block indexes, SVG as text, PDF as a resource block", async () => {
		const fake = new FakeFigma();
		const p = frame(fake, "photo", [100, 50]);
		const j = frame(fake, "jay", [10, 20]);
		const s = frame(fake, "icon", [24, 24]);
		const d = frame(fake, "doc", [100, 100], { _pdfBytes: 100 * 1024 });
		const { tool } = inlineSetup(fake);
		const r = await tool({ nodeIds: [p.id], output: "inline", scale: 2 });
		expect(body(r).assets[0]).toMatchObject({ format: "PNG", scale: 2, width: 200, height: 100, block: 2, mimeType: "image/png", file: "photo@2x.png" });
		expect(r.content[1]).toEqual({ type: "image", mimeType: "image/png", data: expect.any(String) });
		const jr = await tool({ nodeIds: [j.id], output: "inline", format: "JPG" });
		expect(body(jr).assets[0]).toMatchObject({ format: "JPG", width: 10, height: 20, block: 2, mimeType: "image/jpeg" });
		const sr = await tool({ nodeIds: [s.id], output: "inline", format: "SVG" });
		expect(body(sr).assets[0].svg).toMatch(/^<svg width="24"/);
		expect(sr.content).toHaveLength(1);
		expect(body(sr).totals.inlineBytes).toBe(body(sr).assets[0].bytes);
		const dr = await tool({ nodeIds: [d.id], output: "inline", format: "PDF" });
		expect(body(dr).assets[0]).toMatchObject({ format: "PDF", block: 2, bytes: 100 * 1024 });
		expect(dr.content[1]).toEqual({ type: "resource", resource: { uri: `figma-export://${encodeURIComponent(d.id)}/doc.pdf`, mimeType: "application/pdf", blob: expect.any(String) } });
	});

	it("the 1 MiB per-image and 4 MiB total budgets count base64 length; plugin-side tooLarge is reported as skipped", async () => {
		const fake = new FakeFigma();
		const big = frame(fake, "big", [100, 100], { _rasterBytes: 900 * 1024 });
		const nodes = Array.from({ length: 6 }, (_, i) => frame(fake, `n${i}`, [100, 100], { _rasterBytes: 700 * 1024 }));
		const { tool } = inlineSetup(fake);
		const one = body(await tool({ nodeIds: [big.id], output: "inline" }));
		expect(one.skipped).toEqual([{ nodeId: big.id, reason: 'PNG is 900 KB; inline images are limited to 768 KB of image data each (1 MB as base64). Use output "files" (Local Mode) or "urls", or a smaller scale.' }]);
		const r = await tool({ nodeIds: nodes.map((x) => x.id), output: "inline" });
		const b = body(r);
		expect(b.assets).toHaveLength(4);
		expect(b.assets.map((a: any) => a.block)).toEqual([2, 3, 4, 5]);
		expect(r.content).toHaveLength(5);
		expect(b.skipped.map((s: any) => s.reason)).toEqual([
			expect.stringMatching(/^Inline image budget \(4 MB per call\) reached/),
			expect.stringMatching(/^Inline image budget \(4 MB per call\) reached/),
		]);
		const total = r.content.slice(1).reduce((s: number, c: any) => s + c.data.length, 0);
		expect(total).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(b.totals.inlineBytes).toBe(total);
	});

	it("SVG text stops at inlineSvgKB; a 300 KB PDF is skipped", async () => {
		const fake = new FakeFigma();
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="${"M0 0 ".repeat(600)}"/></svg>`;
		const icons = Array.from({ length: 4 }, (_, i) => frame(fake, `i${i}`, [24, 24], { _svg: svg }));
		const pdf = frame(fake, "big-doc", [100, 100], { _pdfBytes: 300 * 1024 });
		const { tool } = inlineSetup(fake);
		const b = body(await tool({ nodeIds: icons.map((x) => x.id), output: "inline", format: "SVG", inlineSvgKB: 8 }));
		expect(b.assets).toHaveLength(2);
		expect(b.skipped).toHaveLength(2);
		expect(b.skipped[0].reason).toBe('Inline SVG budget (8 KB) reached. Raise inlineSvgKB (up to 512), or use output "files" or "urls".');
		expect(b.totals.inlineBytes).toBeLessThanOrEqual(8 * 1024);
		const p = body(await tool({ nodeIds: [pdf.id], output: "inline", format: "PDF" }));
		expect(p.skipped).toEqual([{ nodeId: pdf.id, reason: 'PDFs over 256 KB can\'t be returned inline. Use output "files" or "urls".' }]);
	});

	it("original images inline: viewable types as image blocks, unknown types skipped", async () => {
		const fake = new FakeFigma();
		const screen = frame(fake, "Screen", [400, 800]);
		node(fake, "RECTANGLE", "a", screen, [40, 40]).fills = [imagePaint(H1)];
		node(fake, "RECTANGLE", "b", screen, [40, 40]).fills = [imagePaint(H5)];
		const images = { [H1]: { bytes: jpegBytes(30, 20), width: 30, height: 20 }, [H5]: { bytes: new Uint8Array([9, 9, 9, 9]), width: 1, height: 1 } };
		const { tool } = setup({ fake, images });
		const r = await tool({ nodeIds: [screen.id], output: "inline", images: "include" });
		const b = body(r);
		expect(b.assets).toEqual([expect.objectContaining({ nodeId: screen.id, block: 2 })]);
		expect(b.images).toEqual([expect.objectContaining({ imageHash: H1, mimeType: "image/jpeg", block: 3 })]);
		expect(r.content[2]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
		expect(b.skipped[0].reason).toMatch(/isn't PNG, JPEG, GIF or WebP/);
	});
});

describe("vectors", () => {
	function iconScreen(fake: FakeFigma, count: number) {
		const screen = frame(fake, "Screen", [4000, 4000]);
		node(fake, "TEXT", "t", screen);
		for (let i = 0; i < count; i++) node(fake, "VECTOR", `Icon/v${i}`, screen, [20, 20]).fills = [solid("#000000")];
		return screen;
	}

	it('vectors "only" produces no renders; files use the template with the vector\'s own node', async () => {
		const fake = new FakeFigma();
		const screen = iconScreen(fake, 3);
		const { tool, conn } = setup({ fake });
		const b = body(await tool({ nodeIds: [screen.id], vectors: "only", outputDir: dir, fileName: "{path}" }));
		expect(b.assets).toEqual([]);
		expect(b.vectors.map((v: any) => v.path.slice(b.outputDir.length + 1))).toEqual(["Icon/v0.svg", "Icon/v1.svg", "Icon/v2.svg"]);
		expect(b.vectors[0]).toMatchObject({ type: "VECTOR", foundIn: screen.id, width: 20, height: 20, mimeType: "image/svg+xml" });
		expect(conn.calls.filter((c) => c.label === "Export assets: render").every((c) => c.P.settings.format === "SVG_STRING")).toBe(true);
	});

	it('vectors "include" adds the render; the cap of 50 adds a note', async () => {
		const fake = new FakeFigma();
		const screen = iconScreen(fake, 63);
		const { tool } = setup({ fake, options: { fs: createNodeAssetFs() } });
		const b = body(await tool({ nodeIds: [screen.id], vectors: "include", output: "inline", inlineSvgKB: 512 }));
		expect(b.assets).toHaveLength(1);
		expect(b.vectors).toHaveLength(50);
		expect(b.notes).toContain("Found 63 vector layers; exported the first 50. Export the rest by id.");
	});
});

describe('output "urls"', () => {
	it("groups renders into one getImages call per option set, converts WIDTH to scale, filters image fills, skips null URLs", async () => {
		const fake = new FakeFigma();
		const a = frame(fake, "a", [100, 50], { exportSettings: [{ format: "PNG", constraint: { type: "SCALE", value: 2 } }] });
		const b2 = frame(fake, "b", [100, 50], { exportSettings: [{ format: "PNG", constraint: { type: "SCALE", value: 2 } }] });
		const c = frame(fake, "c", [50, 50], { exportSettings: [{ format: "PNG", constraint: { type: "WIDTH", value: 200 } }] });
		node(fake, "RECTANGLE", "photo", a, [10, 10]).fills = [imagePaint(H1)];
		node(fake, "RECTANGLE", "photo2", b2, [10, 10]).fills = [imagePaint(H2)];
		const api = {
			getImages: jest.fn(async (_key: string, ids: string[]) => ({ images: Object.fromEntries(ids.map((id) => [id, id === b2.id ? null : `https://figma-alpha-api.s3/${id}`])) })),
			getImageFills: jest.fn(async () => ({ meta: { images: { [H1]: "https://s3/h1", ["f".repeat(40)]: "https://s3/other" } } })),
		};
		const { tool, conn } = setup({ fake, options: { fs: createNodeAssetFs(), getFigmaAPI: async () => api as any } });
		const r = body(await tool({ nodeIds: [a.id, b2.id, c.id], output: "urls", images: "include" }));
		expect(conn.labels()).toEqual(["Export assets: resolve nodes"]);
		expect(api.getImages.mock.calls).toEqual([
			["FILE123", [a.id, b2.id], { format: "png", scale: 2, contents_only: true }],
			["FILE123", [c.id], { format: "png", scale: 4, contents_only: true }],
		]);
		expect(r.assets).toEqual([
			{ nodeId: a.id, name: "a", format: "PNG", scale: 2, suffix: "@2x", mimeType: "image/png", file: "a@2x.png", url: `https://figma-alpha-api.s3/${a.id}`, expiresInDays: 30, renderedFrom: "saved version" },
			expect.objectContaining({ nodeId: c.id, scale: 4, file: "c.png" }),
		]);
		expect(r.notes).toContain("c: width 200 became scale 4 for Figma's REST render.");
		expect(api.getImageFills).toHaveBeenCalledTimes(1);
		expect(r.images).toEqual([{ imageHash: H1, usedBy: [expect.objectContaining({ name: "photo" })], url: "https://s3/h1", expiresInDays: 14 }]);
		expect(r.skipped).toEqual([
			{ nodeId: b2.id, reason: "Figma's REST API couldn't render b." },
			{ imageHash: H2, reason: `Image ${H2} isn't in this file.` },
		]);
	});

	it("vectors go through REST as SVG; a REST failure skips that request's assets", async () => {
		const fake = new FakeFigma();
		const screen = frame(fake, "Screen", [400, 400]);
		node(fake, "TEXT", "t", screen);
		node(fake, "VECTOR", "icon", screen, [20, 20]).fills = [solid("#000")];
		const api = {
			getImages: jest.fn(async (_k: string, ids: string[], o: { format: string }) => {
				if (o.format === "png") throw new Error("Figma API error (403): forbidden");
				return { images: Object.fromEntries(ids.map((id) => [id, `https://x/${id}`])) };
			}),
			getImageFills: jest.fn(),
		};
		const { tool } = setup({ fake, options: { isRemoteMode: true, getFigmaAPI: async () => api as any } });
		const r = body(await tool({ nodeIds: [screen.id], output: "urls", vectors: "include" }));
		expect(r.vectors).toEqual([expect.objectContaining({ name: "icon", url: expect.stringMatching(/^https:\/\/x\//), file: "icon.svg" })]);
		expect(r.skipped).toEqual([{ nodeId: screen.id, reason: "Figma's REST API failed for Screen: Figma API error (403): forbidden" }]);
		expect(api.getImageFills).not.toHaveBeenCalled();
	});

	it("needs a file key", async () => {
		const fake = new FakeFigma();
		fake.fileKey = "";
		const f = frame(fake, "a");
		const { tool } = setup({ fake, options: { isRemoteMode: true, getFigmaAPI: async () => ({ getImages: jest.fn() }) as any } });
		expect(body(await tool({ nodeIds: [f.id], output: "urls" })).error).toBe('The file key isn\'t available, so output "urls" can\'t be used here.');
	});
});

describe("run control", () => {
	it("a maybeRunning outcome stops further renders and lists notAttempted", async () => {
		const fake = new FakeFigma();
		const f = Array.from({ length: 4 }, (_, i) => frame(fake, `f${i}`, [10, 10]));
		const { tool, conn } = setup({
			fake,
			intercept: (label, P) => (label === "Export assets: render" && P.id === f[1].id ? { success: false, error: "Error: Execution timed out after 60000ms" } : undefined),
		});
		const r = await tool({ nodeIds: f.map((x) => x.id), outputDir: dir });
		const b = body(r);
		expect(conn.renders()).toEqual([f[0].id, f[1].id]);
		expect(b.assets.map((a: any) => a.nodeId)).toEqual([f[0].id]);
		expect(b.skipped).toEqual([{ nodeId: f[1].id, reason: "Figma didn't answer in time; this export may still be running." }]);
		expect(b.incomplete).toEqual({ reason: expect.stringMatching(/^Figma didn't answer in time and may still be exporting\. Nothing more was sent\./), notAttempted: [f[2].id, f[3].id] });
		expect(b.success).toBe(false);
		expect(r.isError).toBeUndefined();
	});

	it("a thrown Local timeout during the preflight exports nothing", async () => {
		const fake = new FakeFigma();
		const { tool, conn } = setup({ fake, intercept: () => new Error("WebSocket command EXECUTE_CODE timed out after 32000ms") });
		const r = await tool({ nodeIds: ["1:1"] });
		expect(r.isError).toBe(true);
		expect(body(r).error).toMatch(/^Figma didn't answer the export check in time/);
		expect(conn.calls).toHaveLength(1);
	});

	it("a script error on one render skips it and the rest continue", async () => {
		const fake = new FakeFigma();
		const ok = frame(fake, "ok", [10, 10]);
		const bad = frame(fake, "bad", [10, 10], { _exportError: "failed to invert transform" });
		const { tool } = setup({ fake });
		const b = body(await tool({ nodeIds: [bad.id, ok.id], outputDir: dir }));
		expect(b.skipped).toEqual([{ nodeId: bad.id, reason: "Figma could not export bad: failed to invert transform" }]);
		expect(b.assets.map((a: any) => a.nodeId)).toEqual([ok.id]);
	});

	it("PAGE nodes are loaded before export; missing nodes and nothing selected are reported", async () => {
		const fake = new FakeFigma();
		node(fake, "FRAME", "child", fake.currentPage, [100, 100]);
		const load = jest.spyOn(fake.currentPage, "loadAsync");
		const { tool } = setup({ fake });
		const b = body(await tool({ nodeIds: [fake.currentPage.id, "404:1"], format: "PDF", outputDir: dir }));
		expect(load).toHaveBeenCalledTimes(2);
		expect(b.assets).toEqual([expect.objectContaining({ nodeId: fake.currentPage.id, format: "PDF" })]);
		expect(b.skipped).toEqual([{ nodeId: "404:1", reason: "Node 404:1 not found." }]);
		const none = await tool({});
		expect(body(none).error).toBe("Nothing to export: select layers in Figma or pass nodeIds.");
		const gone = await tool({ nodeIds: ["404:2"] });
		expect(body(gone)).toEqual({ error: "None of the nodes could be exported.", skipped: [{ nodeId: "404:2", reason: "Node 404:2 not found." }] });
	});

	it("passes fileKey through to every plugin call (Local)", async () => {
		const fake = new FakeFigma();
		const f = frame(fake, "x", [10, 10]);
		const { tool, conn } = setup({ fake });
		await tool({ nodeIds: [f.id], outputDir: dir, fileKey: "OTHER" });
		expect(conn.calls.map((c) => c.fileKey)).toEqual(["OTHER", "OTHER"]);
	});
});

describe("MCP tasks (Local)", () => {
	it("runs the render phase as a task when the request declares the tasks extension; Cloud stays synchronous", async () => {
		const server = new McpServer({ name: "tasks", version: "0" });
		installTasks(server);
		const fake = new FakeFigma();
		const f = frame(fake, "x", [10, 10]);
		const { tool, conn } = setup({ fake });
		const ctx = { mcpReq: { envelope: { "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION_ID]: {} } } } } };
		const handle = await tool({ nodeIds: [f.id], outputDir: dir }, ctx);
		expect(handle.resultType).toBe("task");
		let view = defaultTaskStore.get(handle.taskId)!;
		for (let i = 0; i < 100 && view.status === "working"; i++) {
			await new Promise((r) => setTimeout(r, 5));
			view = defaultTaskStore.get(handle.taskId)!;
		}
		expect(view.status).toBe("completed");
		expect(JSON.parse((view.result as { content: Array<{ text: string }> }).content[0].text).assets).toHaveLength(1);
		expect(conn.renders()).toEqual([f.id]);
		const cloud = setup({ fake, options: { isRemoteMode: true } });
		expect((await cloud.tool({ nodeIds: [f.id] }, ctx)).resultType).toBeUndefined();
		await server.close();
	});
});

describe("safety", () => {
	it("payload text arrives byte-identical in P and the script still parses", async () => {
		const fake = new FakeFigma();
		// (Ids are trimmed, so the line separators sit inside the string.)
		const evil = ['"; figma.root.remove(); "', "`${process.exit()}`", "</script> x y"];
		const { tool, conn } = setup({ fake });
		const r = await tool({ nodeIds: evil, outputDir: dir });
		expect(conn.calls[0].P.nodeIds).toEqual(evil);
		expect(body(r).skipped.map((s: any) => s.nodeId)).toEqual(evil);
	});

	it("the logger never receives SVG text or image data", async () => {
		const fake = new FakeFigma();
		const f = frame(fake, "x", [24, 24], { _svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="SECRETPATHDATA"/></svg>' });
		const { tool } = setup({ fake });
		await tool({ nodeIds: [f.id], output: "inline", format: "SVG" });
		const r = await tool({ nodeIds: [f.id], output: "inline", format: "PNG" });
		const logged = JSON.stringify([mockLog.info.mock.calls, mockLog.error.mock.calls, mockLog.debug.mock.calls]);
		expect(logged).not.toContain("SECRETPATHDATA");
		expect(logged).not.toContain(r.content[1].data.slice(0, 20));
		expect(mockLog.info).toHaveBeenCalledWith(expect.objectContaining({ output: "inline", assets: 1 }), "figma_export_assets");
	});

	it("sends one plugin call per asset with the right byte limit for the output", async () => {
		const fake = new FakeFigma();
		const f = frame(fake, "x", [10, 10]);
		const { tool, conn } = setup({ fake });
		mkdirSync(join(dir, "out"));
		await tool({ nodeIds: [f.id], outputDir: join(dir, "out") });
		expect(conn.calls[1].P).toMatchObject({ id: f.id, maxBytes: 32 * 1024 * 1024, inlineBase64: false });
		await tool({ nodeIds: [f.id], output: "inline" });
		expect(conn.calls[3].P).toMatchObject({ maxBase64: 1024 * 1024, maxBytes: 786_432, inlineBase64: true });
	});
});


describe("review fixes", () => {
	it("renders are pinned to the file the preflight resolved, even when another open file becomes active", async () => {
		const A = new FakeFigma();
		A.fileKey = "FILE_A";
		const B = new FakeFigma();
		B.fileKey = "FILE_B";
		const a = frame(A, "A-logo", [24, 24]);
		// B has a node with the same id (ids like 1:2 exist in every file).
		const bNode = node(B, "FRAME", "B-art", B.currentPage, [24, 24], { _svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" stroke="#FF0000"/></svg>' });
		B.nodes.set(a.id, bNode);
		const files: Record<string, FakeFigma> = { FILE_A: A, FILE_B: B };
		let active = "FILE_A";
		const routed: string[] = [];
		const conn = {
			async executeCodeViaUI(code: string, _t: number, fileKey?: string) {
				const to = fileKey || active;
				routed.push(to);
				const res = { success: true, result: await runScript(code, exportApi(files[to])) };
				active = "FILE_B";
				return res;
			},
		};
		const make = (options: AssetToolsOptions) => {
			const tools: Record<string, Handler> = {};
			const server = { registerTool: (name: string, _cfg: unknown, h: Handler) => (tools[name] = h), server: { getClientCapabilities: () => undefined } };
			registerAssetTools(server as any, async () => conn, options);
			return tools.figma_export_assets;
		};
		const b = body(await make({ fs: createNodeAssetFs() })({ nodeIds: [a.id], format: "SVG", output: "inline" }));
		expect(routed).toEqual(["FILE_A", "FILE_A"]);
		expect(b.assets[0].svg).toContain("#1E1E1E");
		// Cloud passes no fileKey; the render body refuses in the other file instead of exporting its layer.
		routed.length = 0;
		active = "FILE_A";
		const c = body(await make({ isRemoteMode: true })({ nodeIds: [a.id], format: "SVG" }));
		expect(routed).toEqual(["FILE_A", "FILE_B"]);
		expect(c.assets).toEqual([]);
		expect(c.incomplete.reason).toMatch(/^This export reached a different Figma file/);
		expect(c.incomplete.notAttempted).toEqual([a.id]);
	});

	it("each file's path is resolved again right before writing, so a folder swapped for a link mid-export is caught", async () => {
		const fake = new FakeFigma();
		const f = frame(fake, "arrow", [24, 24]);
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "fcm-export-out-")));
		try {
			const out = join(realpathSync(dir), "out");
			const { tool } = setup({
				fake,
				intercept: (label) => {
					// While Figma renders, the icons folder becomes a link to somewhere else.
					if (label === "Export assets: render") {
						renameSync(join(out, "icons"), join(out, "icons-old"));
						symlinkSync(outside, join(out, "icons"));
					}
					return undefined;
				},
			});
			const b = body(await tool({ nodeIds: [f.id], format: "SVG", outputDir: out, fileName: "icons/{name}" }));
			expect(b.assets).toEqual([]);
			expect(b.skipped).toEqual([{ nodeId: f.id, file: "icons/arrow.svg", reason: "Won't write through a symbolic link: icons." }]);
			expect(readdirSync(outside)).toEqual([]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("the description gives image-file links their own (shorter) expiry", () => {
		const { EXPORT_ASSETS_DESCRIPTION } = require("../../src/core/asset-export-tools");
		expect(EXPORT_ASSETS_DESCRIPTION).toContain("render and vector links expire after 30 days, image-file links within 14");
	});
});
