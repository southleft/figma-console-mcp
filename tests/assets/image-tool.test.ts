/**
 * figma_import_image handler (spec §10). The connector runs the real plugin
 * scripts against the image fake, so these go end to end: validation,
 * sources, preflight, plan, container, chunks, run control and the response.
 */

const mockLog = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
jest.mock("../../src/core/logger", () => ({ createChildLogger: () => mockLog, logger: mockLog }));

import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { McpServer as V1McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as V1InMemory } from "@modelcontextprotocol/sdk/inMemory.js";
import { withToolIdentity } from "../../src/core/identity";
import { TASKS_EXTENSION_ID, defaultTaskStore, installTasks } from "../../src/core/tasks";
import { registerAssetTools } from "../../src/core/asset-tools";
import { IMPORT_IMAGE_SCHEMA, registerImportImageTool } from "../../src/core/image-import-tools";
import type { AssetFs, AssetToolsOptions } from "../../src/core/assets/fs-types";
import { FNode, runScript, solid } from "../svg/fake-figma";
import { ImageFake, b64, gif, jpeg, png, webp } from "./image-fixtures";

const MiB = 1024 * 1024;

interface Call {
	label: string;
	P: any;
	timeoutMs: number;
	fileKey?: string;
}

function fakeConnector(fake: ImageFake, intercept?: (label: string, P: any) => unknown) {
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

/** In-memory AssetFs with the image half; the rest isn't used by this tool. */
function memFs(files: Record<string, Uint8Array>): AssetFs {
	const unused = async (): Promise<never> => {
		throw new Error("not used by the image import");
	};
	return {
		listSvgFiles: unused,
		readSvgFile: unused,
		async listImageFiles(dir, o) {
			const list = Object.keys(files)
				.filter((p) => p.startsWith(`${dir}/`) && (o.recursive || !p.slice(dir.length + 1).includes("/")))
				.map((p) => ({ path: p, relPath: p.slice(dir.length + 1), size: files[p].length }));
			const sub = Object.keys(files).some((p) => p.startsWith(`${dir}/`) && p.slice(dir.length + 1).includes("/"));
			return { root: dir, files: list, scanned: list.length, truncated: false, skippedSubfolders: sub && !o.recursive };
		},
		async readImageFile(path, maxBytes) {
			if (!(path in files)) throw new Error(`File not found: ${path}`);
			if (files[path].length > maxBytes) throw new Error(`${path} is too big`);
			return { bytes: files[path], size: files[path].length };
		},
		prepareOutputDir: unused,
		resolveInside: unused,
		writeNew: unused,
		writeReplace: unused,
	};
}

type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<any>;

function setup(opts: { fake?: ImageFake; options?: AssetToolsOptions; intercept?: (label: string, P: any) => unknown } = {}) {
	const fake = opts.fake ?? new ImageFake();
	const conn = fakeConnector(fake, opts.intercept);
	const tools: Record<string, Handler> = {};
	const server = { registerTool: (name: string, _cfg: unknown, h: Handler) => (tools[name] = h), server: { getClientCapabilities: () => undefined } };
	registerImportImageTool(server as any, async () => conn, opts.options ?? { fs: memFs({}) });
	return { fake, conn, tool: tools.figma_import_image };
}

const body = (r: any) => JSON.parse(r.content[0].text);
const PNG = b64(png(120, 80));

afterEach(() => {
	delete (globalThis as any).__figmaConsoleImageImport;
	delete (globalThis as any).__figmaConsoleSvgImport;
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

	it("registerAssetTools registers it beside the SVG tools; listed through withToolIdentity(McpServer) with no empty schema nodes", async () => {
		const server = new (withToolIdentity(McpServer))({ name: "t", version: "0" });
		registerAssetTools(server, async () => ({}));
		const [ct, st] = InMemoryTransport.createLinkedPair();
		await server.connect(st);
		const client = new Client({ name: "c", version: "0" });
		await client.connect(ct);
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).filter((n) => /^figma_(import|export)_/.test(n)).sort()).toEqual(["figma_export_assets", "figma_import_image", "figma_import_svg"]);
		const t = tools.find((x) => x.name === "figma_import_image")!;
		expect(JSON.stringify(t)).not.toContain("propertyNames");
		expect(emptyNodes(t.inputSchema.properties)).toEqual([]);
		expect(t.description!.length).toBeLessThan(1000);
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
		expect(tools.map((x) => x.name)).toContain("figma_import_image");
		expect((await client.callTool({ name: "figma_import_image", arguments: { images: "nope" } })).isError).toBe(true);
		const cloudFiles = await client.callTool({ name: "figma_import_image", arguments: { directory: "/x" } });
		expect(cloudFiles.isError).toBe(true);
		expect(JSON.parse((cloudFiles.content as Array<{ text: string }>)[0].text).error).toMatch(/^path and directory read files from disk/);
		await client.close();
		await server.close();
	});

	it("the schema accepts the documented shapes and rejects oversized input", () => {
		expect(IMPORT_IMAGE_SCHEMA.safeParse({ images: [{ data: PNG, name: "a", nodeIds: ["1:2"] }, { path: "/a.png" }], width: 100, fit: "exact", height: 50, scaleMode: "CROP", nodeType: "frame", layout: { container: "none" } }).success).toBe(true);
		expect(IMPORT_IMAGE_SCHEMA.safeParse({ images: [{ data: "A".repeat(12_000_001) }] }).success).toBe(false);
		expect(IMPORT_IMAGE_SCHEMA.safeParse({ images: Array.from({ length: 101 }, () => ({ data: "AA" })) }).success).toBe(false);
		expect(IMPORT_IMAGE_SCHEMA.safeParse({ images: [{ data: PNG }], resumeRunId: "nothex" }).success).toBe(false);
	});
});

describe("validation", () => {
	it("Cloud rejects paths, directory, paging and fileKey, and more than 50 images, before any connector call", async () => {
		const { conn, tool } = setup({ options: { isRemoteMode: true } });
		for (const args of [{ images: [{ path: "/a.png" }] }, { directory: "/pics" }, { images: [{ data: PNG }], offset: 1 }]) {
			const r = await tool(args);
			expect(r.isError).toBe(true);
			expect(body(r).error).toBe("path and directory read files from disk, which only Local Mode can do. Cloud Mode has no filesystem: pass the image as base64 in images[].data instead.");
		}
		expect(body(await tool({ images: [{ data: PNG }], fileKey: "abc" })).error).toMatch(/^Per-file targeting \(fileKey\) is Local Mode only/);
		expect(body(await tool({ images: Array.from({ length: 51 }, () => ({ data: PNG })) })).error).toBe("Cloud Mode imports up to 50 images per call. Split the batch into several calls.");
		expect(conn.calls).toHaveLength(0);
	});

	it("cross-field errors return isError with no connector call", async () => {
		const { conn, tool } = setup();
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{}, /^Nothing to import/],
			[{ images: [{ data: PNG, path: "/a.png" }] }, /^images\[0\] needs data \(base64\) or path, not both\.$/],
			[{ images: [{ data: PNG }, { data: PNG }], nodeIds: ["1:2"] }, /^nodeIds applies to a single image/],
			[{ images: [{ data: PNG }], fit: "exact", width: 3 }, /^fit "exact" needs both width and height\.$/],
			[{ images: [{ path: "a.png" }] }, /^"a\.png" is a relative path/],
		];
		for (const [args, re] of cases) {
			const r = await tool(args);
			expect(r.isError).toBe(true);
			expect(body(r).error).toMatch(re);
		}
		expect(conn.calls).toHaveLength(0);
	});

	it("every image failing returns isError without contacting Figma, with each reason", async () => {
		const { conn, tool } = setup();
		const r = await tool({
			images: [
				{ data: "not base64!" },
				{ data: b64(webp()) },
				{ data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64") },
				{ data: b64(png(5000, 10, { headerOnly: true })) },
				{ data: `${"A".repeat(Math.ceil((9 * MiB) / 3) * 4)}` },
			],
		});
		expect(r.isError).toBe(true);
		const b = body(r);
		expect(b.items.map((i: any) => [i.source, i.stage, i.reason])).toEqual([
			["images[0]", "decode", "images[0].data isn't valid base64."],
			["images[1]", "format", "This is a WebP image; Figma's plugin API takes PNG, JPEG or GIF. Convert it first."],
			["images[2]", "format", "This is SVG markup; import it with figma_import_svg."],
			["images[3]", "format", "This image is 5000×10 px; Figma's plugin API takes images up to 4096 px on each side. Scale it down first."],
			["images[4]", "decode", "images[4] is 9 MB; the limit per image is 8 MB."],
		]);
		expect(b.summary).toEqual({ requested: 5, created: 0, updated: 0, unchanged: 0, failed: 5 });
		expect(conn.calls).toHaveLength(0);
	});
});

describe("new layers", () => {
	it("a single inline PNG makes exactly preflight → one chunk; the response has the §10.5 shape", async () => {
		const { conn, tool, fake } = setup();
		const r = await tool({ images: [{ data: `data:image/png;base64,${PNG}`, name: "Hero" }] });
		expect(conn.labels()).toEqual(["Import images: check target", "Import images (1 items)"]);
		expect(r.isError).toBeUndefined();
		const b = body(r);
		expect(b).toMatchObject({
			success: true,
			dryRun: false,
			summary: { requested: 1, created: 1, updated: 0, unchanged: 0, failed: 0 },
			file: { name: "Acme DS", editorType: "figma" },
			items: [],
			unchanged: [],
		});
		expect(b.runId).toMatch(/^[0-9a-f]{12}$/);
		const [row] = b.created;
		expect(row.slice(0, 2)).toEqual(["images[0]", "Hero"]);
		const node = fake.nodes.get(row[2])!;
		expect([node.type, node.width, node.height, node.parent]).toEqual(["RECTANGLE", 120, 80, fake.currentPage]);
		expect(node.fills[0]).toEqual({ type: "IMAGE", imageHash: row[3], scaleMode: "FILL" });
		expect(b.hint).toBe(`Check the result with figma_capture_screenshot({ nodeId: "${row[2]}" }).`);
		expect(fake.currentPage.selection!.map((n) => n.id)).toEqual([row[2]]);
		// The chunk carries normalized base64 and the server's header reading.
		expect(conn.calls[1].P.items[0]).toMatchObject({ data: PNG, pixelWidth: 120, pixelHeight: 80, density: 1, action: "create", name: "Hero" });
		expect(conn.calls[0].P).toMatchObject({ creates: 1, targetIds: [], containerName: "Images" });
	});

	it("verbose returns full items with format and pixel size; width/height fit; @2x names place at 1x", async () => {
		const { tool } = setup();
		const b = body(await tool({ images: [{ data: b64(jpeg(800, 400)), name: "banner@2x" }], verbose: true, layout: { container: "none" } }));
		expect(b.items[0]).toMatchObject({ source: "images[0]", name: "banner@2x", status: "created", type: "RECTANGLE", width: 400, height: 200, format: "JPEG", pixelWidth: 800, pixelHeight: 400 });
		expect(b.created).toBeUndefined();
		const fitted = body(await setup().tool({ images: [{ data: b64(gif(400, 100)) }], width: 200, height: 200, verbose: true }));
		expect(fitted.items[0]).toMatchObject({ width: 200, height: 50, format: "GIF" });
		const exact = body(await setup().tool({ images: [{ data: b64(gif(400, 100)) }], width: 200, height: 200, fit: "exact", density: 4, verbose: true }));
		expect(exact.items[0]).toMatchObject({ width: 200, height: 200 });
	});

	it("a batch gets an 'Images' wrapping frame in a near-square grid; failures don't stop it", async () => {
		const { conn, tool, fake } = setup();
		const images = [...Array.from({ length: 5 }, (_, i) => ({ data: b64(png(100 + i, 50, { seed: i })), name: `p${i}` })), { data: b64(webp()) }];
		const b = body(await tool({ images }));
		expect(conn.labels()).toEqual(["Import images: check target", "Import images: container", "Import images (5 items)"]);
		expect(conn.calls[1].P).toMatchObject({ type: "frame", name: "Images", width: 3 * 104 + 2 * 24 + 2 * 40 });
		expect(b.container).toMatchObject({ name: "Images", type: "FRAME", created: true });
		expect(b.summary).toMatchObject({ requested: 6, created: 5, failed: 1 });
		expect(b.success).toBe(false);
		const frame = fake.nodes.get(b.container.id)!;
		expect(frame.children!.map((c) => c.name)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
		expect(b.hint).toContain(b.container.id);
	});

	it("45 images go in chunks of 20, 20 and 5, laid out as one run", async () => {
		const { conn, tool } = setup();
		const b = body(await tool({ images: Array.from({ length: 45 }, (_, i) => ({ data: b64(png(10, 10, { seed: i })) })), layout: { container: "none" } }));
		expect(conn.labels().slice(1)).toEqual(["Import images (20 items)", "Import images (20 items)", "Import images (5 items)"]);
		expect(conn.calls[2].P.layout.cursor).toMatchObject({ index: 20 });
		expect(conn.calls[3].P.focusIds).toHaveLength(40);
		expect(b.summary.created).toBe(45);
	});
});

describe("fills of existing layers", () => {
	it("nodeIds puts the image into those layers; missing ones are noted; nothing new is created or selected", async () => {
		const fake = new ImageFake();
		const card = new FNode("FRAME", fake);
		card.name = "Card";
		card._w = 200;
		card._h = 120;
		card.fills = [solid("#ffffff")];
		fake.currentPage.appendChild(card);
		const { conn, tool } = setup({ fake });
		const b = body(await tool({ images: [{ data: PNG }], nodeIds: [card.id.replace(":", "-"), "77:77"], scaleMode: "FIT" }));
		expect(conn.labels()).toEqual(["Import images: check target", "Import images (1 items)"]);
		expect(conn.calls[0].P).toMatchObject({ creates: 0, targetIds: [card.id, "77:77"] });
		expect(conn.calls[1].P.targetId).toBeNull();
		expect(b.summary).toMatchObject({ updated: 1, created: 0 });
		expect(b.items[0]).toMatchObject({ source: "images[0]", status: "updated", filled: [{ id: card.id, name: "Card" }], notes: ["Not filled: 77:77 wasn't found."] });
		expect(card.fills[0]).toMatchObject({ type: "IMAGE", scaleMode: "FIT", imageHash: b.items[0].imageHash });
		expect(fake.currentPage.children).toEqual([card]);
		expect(fake.currentPage.selection).toEqual([]);
		expect(b.hint).toContain(card.id);
	});

	it("an image whose layers all can't take fills fails in planning and nothing is sent", async () => {
		const fake = new ImageFake();
		const g = new FNode("GROUP", fake);
		g.name = "G";
		delete (g as any).fills;
		fake.currentPage.appendChild(g);
		const { conn, tool } = setup({ fake });
		const r = await tool({ images: [{ data: PNG, nodeIds: [g.id] }] });
		expect(r.isError).toBe(true);
		expect(body(r).items[0]).toMatchObject({ status: "failed", stage: "plan", reason: expect.stringMatching(/^None of the layers can take an image fill: "G" \(.+\) is a GROUP, which has no fills\./) });
		expect(conn.labels()).toEqual(["Import images: check target"]);
	});
});

describe("files", () => {
	it("reads paths and a directory page (natural order); density comes from @2x file names; a mislabelled file is noted", async () => {
		const files = {
			"/pics/b10.png": png(20, 20),
			"/pics/b2.png": png(20, 20, { seed: 2 }),
			"/pics/hero@2x.jpg": jpeg(400, 200),
			"/pics/actually-jpeg.png": jpeg(10, 10),
			"/pics/sub/deep.gif": gif(3, 3),
			"/one/logo.gif": gif(64, 32),
		};
		const { tool } = setup({ options: { fs: memFs(files) } });
		const b = body(await tool({ images: [{ path: "/one/logo.gif", name: "Logo" }], directory: "/pics", verbose: true, layout: { container: "none" } }));
		expect(b.items.map((i: any) => [i.source, i.name, i.width, i.height])).toEqual([
			["/one/logo.gif", "Logo", 64, 32],
			["actually-jpeg.png", "actually-jpeg", 10, 10],
			["b2.png", "b2", 20, 20],
			["b10.png", "b10", 20, 20],
			["hero@2x.jpg", "hero@2x", 200, 100],
		]);
		expect(b.items[1].notes).toEqual(["The file is a JPEG despite its extension."]);
		expect(b.remaining).toBeUndefined();
		const rec = body(await setup({ options: { fs: memFs(files) } }).tool({ directory: "/pics", recursive: true, offset: 2, limit: 2 }));
		expect(rec.created.map((r: any[]) => r[0])).toEqual(["b10.png", "hero@2x.jpg"]);
		expect(rec.remaining).toEqual({ count: 1, nextOffset: 4 });
	});

	it("directory errors name the folder; files over the 64 MiB read budget go to remaining", async () => {
		const files = { "/pics/sub/a.png": png(1, 1) };
		const { tool } = setup({ options: { fs: memFs(files) } });
		const empty = body(await tool({ directory: "/pics" }));
		expect(empty).toEqual({ error: "No PNG, JPEG or GIF files in /pics", hint: "Pass recursive: true to include subfolders." });
		expect(body(await tool({ directory: "/pics", recursive: true, offset: 5 })).error).toBe("offset 5 is past the end of /pics (1 image files).");
		// Nine 7.9 MiB files: eight fit in 64 MiB, the ninth waits for the next call.
		const big: Record<string, Uint8Array> = {};
		const blob = new Uint8Array(Math.floor(7.9 * MiB));
		blob.set(png(1, 1, { headerOnly: true }));
		for (let i = 0; i < 9; i++) big[`/big/f${i}.png`] = blob;
		const s = setup({ options: { fs: memFs(big) } });
		const b = body(await s.tool({ images: [{ path: "/big/f8.png" }], directory: "/big", dryRun: true }));
		expect(b.items).toHaveLength(8);
		// f8 was read as images[0], so f7 and f8 of the folder are left.
		expect(b.remaining).toEqual({ count: 2, nextOffset: 7 });
		const p = body(await setup({ options: { fs: memFs(big) } }).tool({ images: Array.from({ length: 9 }, (_, i) => ({ path: `/big/f${i}.png` })), dryRun: true }));
		expect(p.remaining).toEqual({ count: 1, images: ["images[8]"] });
		expect(p.notes).toContain("Stopped reading files after 64 MB; the images in remaining.images weren't read. Import them in another call.");
	});

	it("read errors fail only that file", async () => {
		const { tool } = setup({ options: { fs: memFs({ "/a.png": png(2, 2) }) } });
		const b = body(await tool({ images: [{ path: "/missing.png" }, { path: "/a.png" }] }));
		expect(b.items[0]).toMatchObject({ source: "/missing.png", status: "failed", stage: "read", reason: "File not found: /missing.png" });
		expect(b.summary.created).toBe(1);
	});
});

describe("dryRun", () => {
	it("makes only the preflight call and reports planned actions and sizes", async () => {
		const fake = new ImageFake();
		const rect = new FNode("RECTANGLE", fake);
		rect.name = "R";
		fake.currentPage.appendChild(rect);
		const { conn, tool } = setup({ fake });
		const b = body(await tool({ images: [{ data: PNG, name: "A" }, { data: PNG, nodeIds: [rect.id] }, { data: b64(webp()) }], width: 60, dryRun: true }));
		expect(conn.labels()).toEqual(["Import images: check target"]);
		expect(b.summary).toEqual({ requested: 3, actions: { create: 1, fill: 1, fail: 1 } });
		expect(b.items.map((i: any) => [i.action, i.width, i.height])).toEqual([
			["create", 60, 40],
			["fill", undefined, undefined],
			["fail", undefined, undefined],
		]);
		expect(b.items[1].targets).toEqual([{ id: rect.id, name: "R", type: "RECTANGLE" }]);
		expect(b.runId).toBeUndefined();
		expect(fake.currentPage.children).toEqual([rect]);
	});
});

describe("run control", () => {
	it("after a timeout nothing more is sent; a resume run places only the rest", async () => {
		let chunks = 0;
		const fake = new ImageFake();
		const images = Array.from({ length: 30 }, (_, i) => ({ data: b64(png(8, 8, { seed: i })), name: `n${i}` }));
		const first = setup({ fake, intercept: (label) => (label.startsWith("Import images (") && ++chunks === 2 ? new Error("WebSocket command EXECUTE_CODE timed out after 30000ms.") : undefined) });
		const b1 = body(await first.tool({ images, layout: { container: "none" } }));
		expect(first.conn.labels()).toEqual(["Import images: check target", "Import images (20 items)", "Import images (10 items)"]);
		expect(b1.incomplete.runId).toBe(b1.runId);
		expect(b1.incomplete.reason).toMatch(/^Figma didn't answer in time \(or the connection dropped\) and may still be importing images\. Nothing more was sent\./);
		expect(b1.incomplete.inProgress).toHaveLength(10);
		expect(b1.items.map((i: any) => i.status)).toEqual(Array(10).fill("unknown"));
		expect(b1.summary).toMatchObject({ created: 20, failed: 0 });
		// 10 of 30 aren't confirmed: not a success.
		expect(b1.success).toBe(false);
		expect(b1.hint).toContain(`resumeRunId: "${b1.runId}"`);
		const second = setup({ fake });
		const b2 = body(await second.tool({ images, layout: { container: "none" }, resumeRunId: b1.runId }));
		expect(b2.summary).toMatchObject({ unchanged: 20, created: 10 });
		expect(second.conn.labels()).toEqual(["Import images: check target", "Import images (10 items)"]);
		expect(fake.currentPage.children).toHaveLength(30);
	});

	it("a plugin-side timeout envelope counts as maybeRunning; a script error fails only its chunk", async () => {
		const s1 = setup({ intercept: (label) => (label === "Import images (1 items)" ? { success: false, error: "Error: Execution timed out after 5000ms" } : undefined) });
		const b = body(await s1.tool({ images: [{ data: PNG }] }));
		expect(b.incomplete).toBeDefined();
		expect(b.items[0]).toMatchObject({ status: "unknown", stage: "import" });
		let n = 0;
		const s2 = setup({ intercept: (label) => (label.startsWith("Import images (") && ++n === 1 ? { success: false, error: "TypeError: boom" } : undefined) });
		const b2 = body(await s2.tool({ images: Array.from({ length: 25 }, (_, i) => ({ data: b64(png(4, 4, { seed: i })) })), layout: { container: "none" } }));
		expect(b2.summary).toMatchObject({ failed: 20, created: 5 });
		expect(b2.items[0].reason).toBe("Figma reported an error for this batch: TypeError: boom");
		expect(b2.incomplete).toBeUndefined();
	});

	it("a preflight timeout changes nothing; a running import's busy marker refuses the call", async () => {
		const s = setup({ intercept: () => new Error("Command EXECUTE_CODE timed out after 20000ms") });
		const r = await s.tool({ images: [{ data: PNG }] });
		expect(r.isError).toBe(true);
		expect(body(r).error).toMatch(/^Figma didn't answer the pre-import check in time .*Nothing was changed\.$/);
		(globalThis as any).__figmaConsoleImageImport = { runId: "x", startedAt: Date.now() };
		const busy = await setup().tool({ images: [{ data: PNG }] });
		expect(body(busy).error).toMatch(/^An earlier image import is still running in Figma/);
	});

	it("passes fileKey to every call", async () => {
		const { conn, tool } = setup();
		await tool({ images: [{ data: PNG }, { data: PNG }], fileKey: "OTHER" });
		expect(conn.calls.length).toBe(3);
		expect(conn.calls.every((c) => c.fileKey === "OTHER")).toBe(true);
	});
});

describe("safety", () => {
	it("image data arrives byte-identical in P and is never logged or returned", async () => {
		const { conn, tool } = setup();
		const data = b64(png(30, 30, { seed: 9 }));
		// Names are trimmed, so the line separator sits mid-name.
		const EVIL = '"; figma.root.remove(); "` ${x} \u2028 </script> end';
		const r = await tool({ images: [{ data, name: EVIL }], verbose: true });
		expect(conn.calls[1].P.items[0].data).toBe(data);
		expect(body(r).items[0].name).toBe(EVIL);
		expect(r.content[0].text).not.toContain(data.slice(0, 40));
		const logged = JSON.stringify([mockLog.info.mock.calls, mockLog.error.mock.calls, mockLog.warn.mock.calls, mockLog.debug.mock.calls]);
		expect(logged).not.toContain(data.slice(0, 40));
		expect(mockLog.info).toHaveBeenCalledWith(expect.objectContaining({ items: 1, chunks: 1, mode: "local" }), "figma_import_image");
	});
});

describe("MCP tasks", () => {
	it("runs the write phase as a task when the client supports it", async () => {
		const server = new McpServer({ name: "tasks", version: "0" });
		installTasks(server);
		const { conn, tool } = setup();
		const ctx = { mcpReq: { envelope: { "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION_ID]: {} } } } } };
		const handle = await tool({ images: [{ data: PNG }] }, ctx);
		expect(handle.resultType).toBe("task");
		const id = handle.taskId;
		let view = defaultTaskStore.get(id)!;
		for (let i = 0; i < 100 && view.status === "working"; i++) {
			await new Promise((r) => setTimeout(r, 5));
			view = defaultTaskStore.get(id)!;
		}
		expect(view.status).toBe("completed");
		const result = view.result as { content: Array<{ text: string }> };
		expect(JSON.parse(result.content[0].text).summary.created).toBe(1);
		expect(conn.labels()).toEqual(["Import images: check target", "Import images (1 items)"]);
		await server.close();
	});
});

describe("review fixes", () => {
	it("a chain of resumes keeps one runId, so nothing an earlier call placed is placed again", async () => {
		const fake = new ImageFake();
		const images = Array.from({ length: 60 }, (_, i) => ({ data: b64(png(8, 8, { seed: i })), name: `n${i}` }));
		const secondChunkTimesOut = () => {
			let n = 0;
			return (label: string) => (label.startsWith("Import images (") && ++n === 2 ? new Error("WebSocket command EXECUTE_CODE timed out after 30000ms.") : undefined);
		};
		const a = body(await setup({ fake, intercept: secondChunkTimesOut() }).tool({ images, layout: { container: "none" } }));
		const b = body(await setup({ fake, intercept: secondChunkTimesOut() }).tool({ images, layout: { container: "none" }, resumeRunId: a.runId }));
		expect(b.runId).toBe(a.runId);
		expect(fake.currentPage.children).toHaveLength(40);
		const c = body(await setup({ fake }).tool({ images, layout: { container: "none" }, resumeRunId: b.incomplete.runId }));
		expect(c.summary).toMatchObject({ unchanged: 40, created: 20 });
		expect(fake.currentPage.children).toHaveLength(60);
	});

	it("after the preflight every step is pinned to the file it checked; a step that reaches another file refuses", async () => {
		const A = new ImageFake();
		A.fileKey = "FILE_A";
		const B = new ImageFake();
		B.fileKey = "FILE_B";
		const files: Record<string, ImageFake> = { FILE_A: A, FILE_B: B };
		let active = "FILE_A";
		const routed: string[] = [];
		const conn = {
			async executeCodeViaUI(code: string, _t: number, fileKey?: string) {
				const to = fileKey || active;
				routed.push(to);
				const res = { success: true, result: await runScript(code, files[to].api()) };
				active = "FILE_B";
				return res;
			},
		};
		const make = (options: AssetToolsOptions) => {
			const tools: Record<string, Handler> = {};
			const server = { registerTool: (name: string, _cfg: unknown, h: Handler) => (tools[name] = h), server: { getClientCapabilities: () => undefined } };
			registerImportImageTool(server as any, async () => conn, options);
			return tools.figma_import_image;
		};
		const b = body(await make({ fs: memFs({}) })({ images: [{ data: PNG }, { data: PNG }] }));
		expect(routed).toEqual(["FILE_A", "FILE_A", "FILE_A"]);
		expect(b.summary.created).toBe(2);
		expect(B.currentPage.children).toHaveLength(0);
		// Cloud passes no fileKey; the plugin-side check refuses in file B.
		routed.length = 0;
		active = "FILE_A";
		const c = body(await make({ isRemoteMode: true })({ images: [{ data: PNG }, { data: PNG }] }));
		expect(routed).toEqual(["FILE_A", "FILE_B"]);
		expect(c.incomplete.reason).toMatch(/^This step reached a different Figma file/);
		expect(B.currentPage.children).toHaveLength(0);
	});

	it("x or y alone gets a note", async () => {
		const b = body(await setup().tool({ images: [{ data: PNG }], x: 100 }));
		expect(b.notes).toContain("x ignored: pass both x and y to place the result; it went to clear space.");
	});
});
