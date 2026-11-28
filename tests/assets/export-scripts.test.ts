/**
 * figma_export_assets plugin scripts (spec §3.4 step 2, §3.5) run with
 * `new AsyncFunction("figma", script)` against the fake Figma: node
 * resolution, vector discovery, image scan, renders and original images.
 */

import { ALL_EXPORT_BODIES, EXPORT_IMAGE_BODY, EXPORT_NODE_BODY, EXPORT_PREFLIGHT_BODY, assetScript } from "../../src/core/assets/plugin-scripts";
import { solid } from "../svg/fake-figma";
import { FakeFigma, type FNode, exportApi, imagePaint, jpegBytes, node, pngBytes, runScript } from "./export-fake";

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);

const defaults = { nodeIds: null, useSelection: true, maxNodes: 50, maxSettings: 10, scanImages: false, scanVectors: false, maxScan: 5000, maxVectors: 50, maxImages: 50 };
const preflight = (fake: FakeFigma, P: Record<string, unknown>) => runScript(assetScript("Export assets: resolve nodes", { ...defaults, ...P }, EXPORT_PREFLIGHT_BODY), exportApi(fake));

describe("static checks", () => {
	it("bodies have no ${ or backticks and parse as async function bodies", () => {
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
		for (const [name, body] of Object.entries(ALL_EXPORT_BODIES)) {
			expect(`${name}:${body.includes("${")}`).toBe(`${name}:false`);
			expect(body.includes("`")).toBe(false);
			expect(() => new AsyncFunction("figma", `const P = {};\n${body}`)).not.toThrow();
		}
	});

	it("avoids syntax the Figma sandbox has rejected (?. ?? and object spread)", () => {
		for (const body of Object.values(ALL_EXPORT_BODIES)) {
			expect(body).not.toMatch(/\?\.|\?\?|\{\s*\.\.\./);
		}
	});
});

describe("EXPORT_PREFLIGHT_BODY: nodes", () => {
	it("resolves ids, reports missing and unexportable ones, and returns sizes, settings and variants", async () => {
		const fake = new FakeFigma();
		const frame = node(fake, "FRAME", "Hero", fake.currentPage, [1440, 960], {
			exportSettings: [{ format: "PNG", suffix: "@2x", constraint: { type: "SCALE", value: 2 } }],
			_renderBounds: { x: -10, y: -10, width: 1460, height: 990 },
		});
		const set = node(fake, "COMPONENT_SET", "Icon/arrow", fake.currentPage, [100, 100]);
		const variant = node(fake, "COMPONENT", "Size=24, Style=outline", set);
		const odd = node(fake, "FRAME", "No export", fake.currentPage) as any;
		odd.exportAsync = undefined;
		const r = await preflight(fake, { nodeIds: [frame.id, variant.id, "999:9", odd.id], useSelection: false });
		expect(r.fileKey).toBe("FILE123");
		expect(r.missing).toEqual(["999:9"]);
		expect(r.unsupported).toEqual([{ id: odd.id, type: "FRAME" }]);
		expect(r.nodes[0]).toEqual({
			id: frame.id,
			name: "Hero",
			type: "FRAME",
			page: "Page 1",
			width: 1440,
			height: 960,
			renderW: 1460,
			renderH: 990,
			exportSettings: [{ format: "PNG", suffix: "@2x", constraint: { type: "SCALE", value: 2 } }],
		});
		expect(r.nodes[1]).toMatchObject({ id: variant.id, setName: "Icon/arrow", variant: ["24", "outline"] });
	});

	it("uses the selection (first 50) and loads PAGE nodes before reading them", async () => {
		const fake = new FakeFigma();
		const sel = Array.from({ length: 52 }, (_, i) => node(fake, "FRAME", `f${i}`, fake.currentPage));
		(fake.currentPage as any).selection = sel;
		const r = await preflight(fake, {});
		expect(r.nodes).toHaveLength(50);
		expect(r.selectionCount).toBe(52);

		const page = fake.currentPage;
		const load = jest.spyOn(page, "loadAsync");
		node(fake, "FRAME", "a", page, [100, 50]).x = 10;
		const p = await preflight(fake, { nodeIds: [page.id], useSelection: false });
		expect(load).toHaveBeenCalled();
		expect(p.nodes[0]).toMatchObject({ type: "PAGE", width: expect.any(Number), height: expect.any(Number) });
	});

	it("caps Export settings per node and reports the total", async () => {
		const fake = new FakeFigma();
		const f = node(fake, "FRAME", "f", fake.currentPage, [10, 10], { exportSettings: Array.from({ length: 12 }, () => ({ format: "PNG" })) });
		const r = await preflight(fake, { nodeIds: [f.id], useSelection: false });
		expect(r.nodes[0].exportSettings).toHaveLength(10);
		expect(r.nodes[0].settingsTotal).toBe(12);
	});
});

describe("EXPORT_PREFLIGHT_BODY: vector discovery", () => {
	function vec(fake: FakeFigma, parent: FNode, name = "Vector", size: [number, number] = [20, 20]) {
		const v = node(fake, "VECTOR", name, parent, size);
		v.fills = [solid("#000000")];
		return v;
	}

	it("nested groups yield one maximal candidate; text, backgrounds and tiny nodes are skipped", async () => {
		const fake = new FakeFigma();
		const screen = node(fake, "FRAME", "Screen", fake.currentPage, [400, 800]);
		node(fake, "TEXT", "Title", screen, [100, 20]);
		const logo = node(fake, "GROUP", "Logo", screen);
		const inner = node(fake, "GROUP", "Mark", logo);
		vec(fake, inner);
		node(fake, "ELLIPSE", "Dot", inner, [6, 6]);
		node(fake, "RECTANGLE", "Background", screen, [400, 800]);
		vec(fake, screen, "Speck", [3, 3]);
		const r = await preflight(fake, { nodeIds: [screen.id], useSelection: false, scanVectors: true });
		expect(r.vectors.map((v: any) => v.name)).toEqual(["Logo"]);
		expect(r.vectors[0]).toMatchObject({ type: "GROUP", foundIn: screen.id });
		expect(r.vectorTotal).toBe(1);
	});

	it("a frame whose only geometry is rectangles, or with an image fill, isn't vector art", async () => {
		const fake = new FakeFigma();
		const screen = node(fake, "FRAME", "Screen", fake.currentPage, [400, 800]);
		node(fake, "TEXT", "t", screen);
		const card = node(fake, "FRAME", "Card", screen, [200, 100]);
		node(fake, "RECTANGLE", "bg", card, [200, 100]);
		const photo = node(fake, "FRAME", "Photo", screen, [200, 100]);
		photo.fills = [imagePaint(H1)];
		vec(fake, photo);
		const avatar = node(fake, "ELLIPSE", "Avatar", screen, [40, 40]);
		avatar.fills = [imagePaint(H2)];
		const r = await preflight(fake, { nodeIds: [screen.id], useSelection: false, scanVectors: true });
		// The photo frame is descended into, and its plain vector child counts on its own.
		expect(r.vectors.map((v: any) => v.name)).toEqual(["Vector"]);
	});

	it("instances dedupe by main component key; an instance whose main isn't vector art is descended into", async () => {
		const fake = new FakeFigma();
		const lib = node(fake, "FRAME", "Components", fake.currentPage, [500, 500]);
		node(fake, "TEXT", "label", lib);
		const iconMain = node(fake, "COMPONENT", "Icon/search", lib, [20, 20], { key: "k-search" });
		vec(fake, iconMain);
		const buttonMain = node(fake, "COMPONENT", "Button", lib, [120, 40], { key: "k-button" });
		node(fake, "TEXT", "Label", buttonMain);

		const screen = node(fake, "FRAME", "Screen", fake.currentPage, [400, 800]);
		node(fake, "TEXT", "t", screen);
		const i1 = node(fake, "INSTANCE", "Icon/search", screen, [20, 20], { _main: iconMain });
		vec(fake, i1);
		const i2 = node(fake, "INSTANCE", "Icon/search", screen, [20, 20], { _main: iconMain });
		vec(fake, i2);
		const button = node(fake, "INSTANCE", "Button", screen, [120, 40], { _main: buttonMain });
		node(fake, "TEXT", "Label", button);
		const nested = node(fake, "INSTANCE", "Icon/search", button, [16, 16], { _main: iconMain });
		vec(fake, nested);
		const iconMain2 = node(fake, "COMPONENT", "Icon/close", lib, [20, 20], { key: "k-close" });
		vec(fake, iconMain2);
		const close = node(fake, "INSTANCE", "Icon/close", button, [16, 16], { _main: iconMain2 });
		vec(fake, close);

		const r = await preflight(fake, { nodeIds: [screen.id], useSelection: false, scanVectors: true });
		expect(r.vectors).toEqual([
			{ nodeId: i1.id, name: "Icon/search", type: "INSTANCE", foundIn: screen.id, width: 20, height: 20, page: "Page 1", mainComponentName: "Icon/search", componentKey: "k-search" },
			{ nodeId: close.id, name: "Icon/close", type: "INSTANCE", foundIn: screen.id, width: 16, height: 16, page: "Page 1", mainComponentName: "Icon/close", componentKey: "k-close" },
		]);
	});

	it("variant mains report <set>/<values>; the requested node itself can be a candidate", async () => {
		const fake = new FakeFigma();
		const set = node(fake, "COMPONENT_SET", "Icon/arrow", fake.currentPage, [100, 100]);
		const v24 = node(fake, "COMPONENT", "Size=24, Style=outline", set, [24, 24], { key: "k24" });
		vec(fake, v24);
		const r = await preflight(fake, { nodeIds: [v24.id], useSelection: false, scanVectors: true });
		expect(r.vectors).toEqual([
			{
				nodeId: v24.id,
				name: "Size=24, Style=outline",
				type: "COMPONENT",
				foundIn: v24.id,
				width: 24,
				height: 24,
				page: "Page 1",
				mainComponentName: "Icon/arrow/24-outline",
				componentKey: "k24",
				setName: "Icon/arrow",
				variant: ["24", "outline"],
			},
		]);
	});

	it("caps at maxVectors but keeps counting; respects the scan budget", async () => {
		const fake = new FakeFigma();
		const screen = node(fake, "FRAME", "Screen", fake.currentPage, [4000, 4000]);
		node(fake, "TEXT", "t", screen);
		for (let i = 0; i < 63; i++) vec(fake, screen, `v${i}`);
		const r = await preflight(fake, { nodeIds: [screen.id], useSelection: false, scanVectors: true });
		expect(r.vectors).toHaveLength(50);
		expect(r.vectorTotal).toBe(63);
		const small = await preflight(fake, { nodeIds: [screen.id], useSelection: false, scanVectors: true, maxScan: 10 });
		expect(small.scanTruncated).toBe(true);
		expect(small.scanned).toBe(10);
		expect(small.vectors.length).toBeLessThanOrEqual(9);
	});

	it("hidden layers neither count nor disqualify", async () => {
		const fake = new FakeFigma();
		const g = node(fake, "GROUP", "Icon", fake.currentPage);
		vec(fake, g);
		const hiddenText = node(fake, "TEXT", "note", g);
		hiddenText.visible = false;
		const r = await preflight(fake, { nodeIds: [g.id], useSelection: false, scanVectors: true });
		expect(r.vectors.map((v: any) => v.name)).toEqual(["Icon"]);
	});
});

describe("EXPORT_PREFLIGHT_BODY: images", () => {
	it("collects IMAGE paints in fills and strokes, deduped by hash with usedBy, skipping hidden paints and layers", async () => {
		const fake = new FakeFigma();
		const screen = node(fake, "FRAME", "Screen", fake.currentPage, [400, 800]);
		const a = node(fake, "RECTANGLE", "Hero", screen, [400, 200]);
		a.fills = [imagePaint(H1)];
		const b = node(fake, "RECTANGLE", "Thumb", screen, [40, 40]);
		b.fills = [imagePaint(H1), imagePaint(H2, { visible: false })];
		const c = node(fake, "ELLIPSE", "Ring", screen, [40, 40]);
		c.strokes = [imagePaint(H2)];
		const hidden = node(fake, "RECTANGLE", "Hidden", screen, [40, 40]);
		hidden.visible = false;
		hidden.fills = [imagePaint("c".repeat(40))];
		const r = await preflight(fake, { nodeIds: [screen.id], useSelection: false, scanImages: true });
		expect(r.images).toEqual([
			{ hash: H1, usedBy: [{ nodeId: a.id, name: "Hero" }, { nodeId: b.id, name: "Thumb" }], usedByCount: 2 },
			{ hash: H2, usedBy: [{ nodeId: c.id, name: "Ring" }], usedByCount: 1 },
		]);
		expect(r.imageTotal).toBe(2);
		expect(r.vectors).toEqual([]);
	});
});

describe("EXPORT_NODE_BODY and EXPORT_IMAGE_BODY", () => {
	const render = (fake: FakeFigma, P: Record<string, unknown>) => runScript(assetScript("Export assets: render", P, EXPORT_NODE_BODY), exportApi(fake));

	it("returns SVG text with UTF-8 bytes, base64 rasters, and tooLarge instead of oversized data", async () => {
		const fake = new FakeFigma();
		// 5 + 2 (é) + 4 (surrogate pair) + 6 bytes of UTF-8.
		const f = node(fake, "FRAME", "f", fake.currentPage, [10, 10], { _svg: "<svg>é😀</svg>" });
		expect(await render(fake, { id: f.id, settings: { format: "SVG_STRING" }, maxBytes: 100 })).toEqual({ svg: "<svg>é😀</svg>", bytes: 17 });
		expect(await render(fake, { id: f.id, settings: { format: "SVG_STRING" }, maxBytes: 16 })).toEqual({ tooLarge: true, bytes: 17 });
		const png = await render(fake, { id: f.id, settings: { format: "PNG", constraint: { type: "SCALE", value: 2 } }, maxBytes: 1000 });
		expect(Buffer.from(png.base64, "base64").subarray(0, 4)).toEqual(Buffer.from(pngBytes(20, 20).subarray(0, 4)));
		expect(png.bytes).toBe(64);
		// inline: compared as base64 length (64 bytes → 88 chars).
		expect(await render(fake, { id: f.id, settings: { format: "PNG" }, inlineBase64: true, maxBase64: 87, maxBytes: 65 })).toEqual({ tooLarge: true, bytes: 64 });
		expect((await render(fake, { id: f.id, settings: { format: "PNG" }, inlineBase64: true, maxBase64: 88, maxBytes: 66 })).bytes).toBe(64);
	});

	it("reports missing nodes and Figma's export errors; loads pages first", async () => {
		const fake = new FakeFigma();
		expect(await render(fake, { id: "9:9", settings: {}, maxBytes: 1 })).toEqual({ error: "Node 9:9 not found." });
		const bad = node(fake, "FRAME", "Broken", fake.currentPage, [10, 10], { _exportError: "failed to invert transform" });
		expect(await render(fake, { id: bad.id, settings: { format: "PNG" }, maxBytes: 100 })).toEqual({ error: "Figma could not export Broken: failed to invert transform" });
		const load = jest.spyOn(fake.currentPage, "loadAsync");
		await render(fake, { id: fake.currentPage.id, settings: { format: "PDF" }, maxBytes: 1e6 });
		expect(load).toHaveBeenCalled();
	});

	it("original images: bytes, size, missing, tooLarge", async () => {
		const fake = new FakeFigma();
		const api = exportApi(fake, { [H1]: { bytes: jpegBytes(3000, 2000, 500), width: 3000, height: 2000 } });
		const run = (P: Record<string, unknown>) => runScript(assetScript("Export assets: original image", P, EXPORT_IMAGE_BODY), api);
		const ok = await run({ hash: H1, maxBytes: 1000 });
		expect(ok).toMatchObject({ bytes: 500, width: 3000, height: 2000 });
		expect(Buffer.from(ok.base64, "base64")[0]).toBe(0xff);
		expect(await run({ hash: H2, maxBytes: 1000 })).toEqual({ error: "missing" });
		expect(await run({ hash: H1, maxBytes: 100 })).toEqual({ tooLarge: true, bytes: 500, width: 3000, height: 2000 });
	});
});

describe("review fixes", () => {
	it("images inside a main component are found even when an instance of it was scanned first", async () => {
		const fake = new FakeFigma();
		const lib = node(fake, "FRAME", "Components", fake.currentPage, [500, 500]);
		const card = node(fake, "COMPONENT", "Card", lib, [200, 100], { key: "k-card" });
		node(fake, "TEXT", "Title", card);
		const avatar = node(fake, "ELLIPSE", "Avatar", card, [40, 40]);
		avatar.fills = [imagePaint(H1)];
		const screen = node(fake, "FRAME", "Screen", fake.currentPage, [400, 800]);
		const inst = node(fake, "INSTANCE", "Card", screen, [200, 100], { _main: card });
		node(fake, "TEXT", "Title", inst);
		const instAvatar = node(fake, "ELLIPSE", "Avatar", inst, [40, 40]);
		instAvatar.fills = [imagePaint(H2)];
		for (const second of [card.id, lib.id]) {
			const r = await preflight(fake, { nodeIds: [screen.id, second], useSelection: false, scanImages: true, scanVectors: true });
			expect(r.images.map((i: any) => i.hash).sort()).toEqual([H1, H2].sort());
		}
		// The instance hides its avatar: the main's image must still be there (not "No image fills").
		instAvatar.visible = false;
		const r = await preflight(fake, { nodeIds: [screen.id, card.id], useSelection: false, scanImages: true, scanVectors: true });
		expect(r.images.map((i: any) => i.hash)).toEqual([H1]);
	});

	it("render and original-image steps refuse a file other than the one the preflight resolved", async () => {
		const fake = new FakeFigma();
		const f = node(fake, "FRAME", "Hero", fake.currentPage, [10, 10]);
		const r = await runScript(assetScript("Export assets: render", { id: f.id, settings: { format: "PNG" }, fileKey: "FILE_A", maxBytes: 1e6, inlineBase64: false }, EXPORT_NODE_BODY), exportApi(fake));
		expect(r.refused).toMatch(/^This export reached a different Figma file/);
		expect(fake.calls.some((c) => c.startsWith("exportAsync"))).toBe(false);
		const i = await runScript(assetScript("Export assets: original image", { hash: H1, fileKey: "FILE_A", maxBytes: 1e6, inlineBase64: false }, EXPORT_IMAGE_BODY), exportApi(fake, { [H1]: { bytes: pngBytes(1, 1), width: 1, height: 1 } }));
		expect(i.refused).toMatch(/^This export reached a different Figma file/);
		const ok = await runScript(assetScript("Export assets: render", { id: f.id, settings: { format: "PNG" }, fileKey: "FILE123", maxBytes: 1e6, inlineBase64: false }, EXPORT_NODE_BODY), exportApi(fake));
		expect(typeof ok.base64).toBe("string");
	});
});
