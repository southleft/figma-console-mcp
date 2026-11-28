/**
 * figma_import_image plugin scripts (spec §10.4), run the way code.js runs
 * them (top-level await/return) against the fake figma.
 */

import { assetScript, SVG_HELPERS, SVG_PREFLIGHT_BODY } from "../../src/core/assets/plugin-scripts";
import { ALL_IMAGE_BODIES, IMAGE_CONTAINER_BODY, IMAGE_IMPORT_BODY, IMAGE_PREFLIGHT_BODY } from "../../src/core/assets/image-scripts";
import { displaySize } from "../../src/core/assets/image-plan";
import { EDITOR_SUPPORT } from "../../src/core/assets/limits";
import { FNode, runScript, solid } from "../svg/fake-figma";
import { ImageFake, b64, gif, jpeg, png } from "./image-fixtures";

const RUN = "abcdefabcdef";

afterEach(() => {
	delete (globalThis as any).__figmaConsoleImageImport;
	delete (globalThis as any).__figmaConsoleSvgImport;
});

function payload(fake: ImageFake, over: Record<string, unknown> = {}) {
	return {
		runId: RUN,
		targetId: fake.currentPage.id,
		final: true,
		focus: false,
		focusIds: [],
		opts: { nodeType: "rectangle", scaleMode: "FILL", box: null, fit: "contain" },
		layout: { mode: "single", columns: 1, gap: 24, padding: 40, cursor: null, container: null },
		items: [],
		...over,
	};
}

function item(bytes: Uint8Array, w: number, h: number, over: Record<string, unknown> = {}) {
	return { key: "i0", name: "Photo", source: "images[0]", data: b64(bytes), hash: "H0", pixelWidth: w, pixelHeight: h, density: 1, action: "create", ...over };
}

const run = (fake: ImageFake, P: unknown, body = IMAGE_IMPORT_BODY, label = "Import images (1 items)") => runScript(assetScript(label, P, body), fake.api());

describe("IMAGE_IMPORT_BODY: new layers", () => {
	it("makes a rectangle at the image's pixel size with an IMAGE fill, tagged and placed at clear space", async () => {
		const fake = new ImageFake();
		const existing = new FNode("FRAME", fake);
		existing._w = 100;
		existing._h = 50;
		fake.currentPage.appendChild(existing);
		const r = await run(fake, payload(fake, { items: [item(png(320, 200), 320, 200)] }));
		const res = r.results[0];
		expect(res).toMatchObject({ key: "i0", status: "created", type: "RECTANGLE", width: 320, height: 200, pixelWidth: 320, pixelHeight: 200 });
		const node = fake.nodes.get(res.nodeId)!;
		expect(node.parent).toBe(fake.currentPage);
		expect(node.name).toBe("Photo");
		expect(node.fills).toEqual([{ type: "IMAGE", imageHash: res.imageHash, scaleMode: "FILL" }]);
		expect(res.imageHash).toMatch(/^[0-9a-f]{40}$/);
		expect([node.x, node.y]).toEqual([260, 0]);
		expect(JSON.parse(node.getPluginData("imageImport"))).toMatchObject({ v: 1, runId: RUN, source: "images[0]", hash: "H0", imageHash: res.imageHash });
		expect(r.newTopLevelIds).toEqual([res.nodeId]);
		expect(fake.calls.filter((c) => c === "commitUndo")).toHaveLength(2);
		expect(fake.calls[0]).toBe("commitUndo");
		expect(fake.calls[fake.calls.length - 1]).toBe("commitUndo");
		expect((globalThis as any).__figmaConsoleImageImport).toBeUndefined();
	});

	it("nodeType frame makes a frame whose white fill is replaced by the image", async () => {
		const fake = new ImageFake();
		const r = await run(fake, payload(fake, { opts: { nodeType: "frame", scaleMode: "FIT", box: null, fit: "contain" }, items: [item(gif(40, 20), 40, 20)] }));
		const node = fake.nodes.get(r.results[0].nodeId)!;
		expect(node.type).toBe("FRAME");
		expect(node.fills).toEqual([{ type: "IMAGE", imageHash: r.results[0].imageHash, scaleMode: "FIT" }]);
	});

	it("sizes layers exactly like the server's displaySize, for every width/height/fit/density case", async () => {
		const cases: Array<[number, number, number, { w?: number; h?: number } | null, "contain" | "exact"]> = [
			[400, 200, 1, null, "contain"],
			[400, 200, 2, null, "contain"],
			[400, 200, 3, null, "contain"],
			[400, 200, 1, { w: 100 }, "contain"],
			[400, 200, 1, { h: 30 }, "contain"],
			[200, 400, 1, { w: 100, h: 100 }, "contain"],
			[400, 200, 1, { w: 90, h: 70 }, "exact"],
			[3, 1, 1, { w: 1 }, "contain"],
		];
		for (const [pw, ph, density, box, fit] of cases) {
			const fake = new ImageFake();
			const r = await run(fake, payload(fake, { opts: { nodeType: "rectangle", scaleMode: "FILL", box, fit }, items: [item(png(pw, ph), pw, ph, { density })] }));
			const want = displaySize(pw, ph, density, box, fit);
			expect([r.results[0].width, r.results[0].height]).toEqual([want.w, want.h]);
		}
	});

	it("CROP gets a centered cover transform; TILE gets scalingFactor 1/density", async () => {
		const fake = new ImageFake();
		const wide = await run(fake, payload(fake, { opts: { nodeType: "rectangle", scaleMode: "CROP", box: { w: 200, h: 100 }, fit: "exact" }, items: [item(png(100, 100), 100, 100)] }));
		expect(fake.nodes.get(wide.results[0].nodeId)!.fills[0].imageTransform).toEqual([
			[1, 0, 0],
			[0, 0.5, 0.25],
		]);
		const tall = await run(fake, payload(fake, { opts: { nodeType: "rectangle", scaleMode: "CROP", box: { w: 50, h: 100 }, fit: "exact" }, items: [item(png(100, 100), 100, 100)] }));
		expect(fake.nodes.get(tall.results[0].nodeId)!.fills[0].imageTransform).toEqual([
			[0.5, 0, 0.25],
			[0, 1, 0],
		]);
		const tile = await run(fake, payload(fake, { opts: { nodeType: "rectangle", scaleMode: "TILE", box: null, fit: "contain" }, items: [item(png(64, 64), 64, 64, { density: 2 })] }));
		expect(fake.nodes.get(tile.results[0].nodeId)!.fills[0]).toMatchObject({ scaleMode: "TILE", scalingFactor: 0.5 });
	});

	it("uses Figma's own pixel size when it differs from the header (EXIF rotation) and says so", async () => {
		const fake = new ImageFake();
		fake.sizeOverride = { width: 200, height: 300 };
		const r = await run(fake, payload(fake, { items: [item(jpeg(300, 200), 300, 200)] }));
		expect(r.results[0]).toMatchObject({ status: "created", width: 200, height: 300, pixelWidth: 200, pixelHeight: 300 });
		expect(r.results[0].notes[0]).toMatch(/^Figma reads this image as 200x300 px \(its header says 300x200/);
	});

	it("a createImage or base64Decode failure is reported with Figma's message and the next image still imports", async () => {
		const fake = new ImageFake();
		fake.createImageFails = (s) => (s.width === 13 ? "Image is too large" : null);
		const items = [item(png(13, 13), 13, 13, { key: "a" }), item(png(10, 10), 10, 10, { key: "b" }), item(png(5, 5), 5, 5, { key: "c", data: "!!!notbase64" })];
		const r = await run(fake, payload(fake, { items }), IMAGE_IMPORT_BODY, "Import images (3 items)");
		expect(r.results.map((x: any) => [x.key, x.status, x.stage, x.reason])).toEqual([
			["a", "failed", "import", "Figma couldn't read this image: Image is too large"],
			["b", "created", undefined, undefined],
			["c", "failed", "import", "Figma couldn't decode the image data: Invalid base64 string"],
		]);
		expect(fake.currentPage.children).toHaveLength(1);
	});

	it("a failure after the layer exists removes it", async () => {
		const fake = new ImageFake();
		const api = fake.api();
		const make = api.createRectangle;
		api.createRectangle = () => {
			const r = make();
			Object.defineProperty(r, "name", { set: () => { throw new Error("locked"); } });
			return r;
		};
		const r = await runScript(assetScript("Import images (1 items)", payload(fake, { items: [item(png(4, 4), 4, 4)] }), IMAGE_IMPORT_BODY), api);
		expect(r.results[0]).toMatchObject({ status: "failed", stage: "process", reason: "Couldn't finish this image: locked" });
		expect(fake.currentPage.children).toHaveLength(0);
	});
});

describe("IMAGE_IMPORT_BODY: fills of existing layers", () => {
	it("replaces fills, keeps size and position, notes styles and bindings, and reports layers it couldn't fill", async () => {
		const fake = new ImageFake();
		const hero = new FNode("RECTANGLE", fake);
		hero.name = "Hero";
		hero._w = 300;
		hero._h = 100;
		hero.x = 7;
		hero.fills = [solid("#ff0000")];
		(hero as any).fillStyleId = "S:abc";
		(hero as any).boundVariables = { fills: [{ type: "VARIABLE_ALIAS", id: "V1" }] };
		const group = new FNode("GROUP", fake);
		group.name = "Group";
		delete (group as any).fills;
		fake.currentPage.appendChild(hero);
		fake.currentPage.appendChild(group);
		const it = item(png(100, 100), 100, 100, { action: "fill", targetIds: [hero.id, group.id, "99:99"] });
		const r = await run(fake, payload(fake, { targetId: null, opts: { nodeType: "rectangle", scaleMode: "CROP", box: null, fit: "contain" }, items: [it] }));
		const res = r.results[0];
		expect(res).toMatchObject({ status: "updated", filled: [{ id: hero.id, name: "Hero" }], pixelWidth: 100, pixelHeight: 100 });
		expect(hero.fills).toEqual([{ type: "IMAGE", imageHash: res.imageHash, scaleMode: "CROP", imageTransform: expect.any(Array) }]);
		const t = hero.fills[0].imageTransform.flat();
		[1, 0, 0, 0, 1 / 3, 1 / 3].forEach((v, i) => expect(t[i]).toBeCloseTo(v, 12));
		expect([hero.width, hero.height, hero.x]).toEqual([300, 100, 7]);
		expect(res.notes).toEqual([
			'"Hero": its fill style was detached.',
			'"Hero": its fill variable binding was replaced.',
			`Not filled: "Group" (${group.id}) has no fills; 99:99 wasn't found.`,
		]);
		expect(r.newTopLevelIds).toEqual([]);
		expect(hero.getPluginData("imageImport")).toBe("");
	});

	it("fails the item when no layer took the fill", async () => {
		const fake = new ImageFake();
		const r = await run(fake, payload(fake, { targetId: null, items: [item(png(1, 1), 1, 1, { action: "fill", targetIds: ["1:404"] })] }));
		expect(r.results[0]).toMatchObject({ status: "failed", stage: "process", reason: "No layer took the image fill: 1:404 wasn't found." });
	});
});

describe("IMAGE_IMPORT_BODY: layout, focus, undo and the busy marker", () => {
	it("grid placement continues across two chunks; a container this run created is fitted to its content, a reused one only grows", async () => {
		const fake = new ImageFake();
		const section = fake.api().createSection();
		section.resizeWithoutConstraints(2000, 2000);
		const layout = { mode: "grid", columns: 2, gap: 10, padding: 20, cell: { w: 50, h: 50 }, cursor: null, container: { id: section.id, created: true } };
		const first = await run(fake, payload(fake, { targetId: section.id, final: false, layout, items: [item(png(50, 25), 50, 25, { key: "a" }), item(png(20, 50), 20, 50, { key: "b" })] }), IMAGE_IMPORT_BODY, "Import images (2 items)");
		expect(first.cursor).toMatchObject({ index: 2, originX: 20, originY: 20 });
		const second = await run(fake, payload(fake, { targetId: section.id, layout: { ...layout, cursor: first.cursor }, items: [item(png(50, 50), 50, 50, { key: "c" })] }));
		const pos = [...first.results, ...second.results].map((x: any) => { const n = fake.nodes.get(x.nodeId)!; return [n.x, n.y]; });
		expect(pos).toEqual([[20, 33], [95, 20], [20, 80]]);
		// Created by this run: fitted to the content plus padding (right 95+20, bottom 80+50).
		expect([section.width, section.height]).toEqual([135, 150]);
		const own = fake.api().createSection();
		own.resizeWithoutConstraints(2000, 2000);
		await run(fake, payload(fake, { targetId: own.id, layout: { ...layout, container: { id: own.id, created: false } }, items: [item(png(50, 50), 50, 50)] }));
		expect([own.width, own.height]).toEqual([2000, 2000]);
		const small = fake.api().createSection();
		small.resizeWithoutConstraints(10, 10);
		await run(fake, payload(fake, { targetId: small.id, layout: { ...layout, container: { id: small.id, created: true } }, items: [item(png(50, 50), 50, 50)] }));
		expect([small.width, small.height]).toEqual([90, 90]);
	});

	it("shelf placement wraps after `columns`; an auto-layout target isn't positioned", async () => {
		const fake = new ImageFake();
		const frame = fake.api().createFrame();
		const layout = { mode: "shelf", columns: 2, gap: 10, padding: 0, cursor: null, container: null };
		const items = [item(png(30, 10), 30, 10, { key: "a" }), item(png(20, 40), 20, 40, { key: "b" }), item(png(5, 5), 5, 5, { key: "c" })];
		const r = await run(fake, payload(fake, { targetId: frame.id, layout, items }), IMAGE_IMPORT_BODY, "Import images (3 items)");
		expect(r.results.map((x: any) => { const n = fake.nodes.get(x.nodeId)!; return [n.x, n.y]; })).toEqual([[0, 0], [40, 0], [0, 50]]);
		const auto = fake.api().createFrame();
		auto.layoutMode = "HORIZONTAL";
		const a = await run(fake, payload(fake, { targetId: auto.id, layout: { ...layout, mode: "auto-layout" }, items: [item(png(30, 10), 30, 10)] }));
		expect(fake.nodes.get(a.results[0].nodeId)!.rt[0][2]).toBe(0);
		expect(a.cursor).toBeNull();
	});

	it("focuses new layers only in the final chunk and only on the current page", async () => {
		const fake = new ImageFake();
		const r = await run(fake, payload(fake, { focus: true, final: false, items: [item(png(2, 2), 2, 2)] }));
		expect(fake.currentPage.selection).toEqual([]);
		const f = await run(fake, payload(fake, { focus: true, final: true, focusIds: [r.results[0].nodeId], items: [item(png(2, 2), 2, 2, { key: "b" })] }));
		expect(fake.currentPage.selection!.map((n) => n.id)).toEqual([r.results[0].nodeId, f.results[0].nodeId]);
		const other = new FNode("PAGE", fake);
		other.name = "Other";
		fake.pages.push(other);
		const o = await run(fake, payload(fake, { focus: true, targetId: other.id, items: [item(png(2, 2), 2, 2)] }));
		expect(o.notes).toEqual(['The result is on the page "Other", so it wasn\'t selected (switching pages would interrupt you).']);
	});

	it("sets the busy marker while running and clears it in finally, even when the body throws", async () => {
		const fake = new ImageFake();
		const api = fake.api();
		let seen: unknown;
		const make = api.createRectangle;
		api.createRectangle = () => {
			seen = (globalThis as any).__figmaConsoleImageImport;
			return make();
		};
		await runScript(assetScript("Import images (1 items)", payload(fake, { items: [item(png(2, 2), 2, 2)] }), IMAGE_IMPORT_BODY), api);
		expect(seen).toMatchObject({ runId: RUN });
		await expect(run(fake, payload(fake, { targetId: "404:1", items: [item(png(2, 2), 2, 2)] }))).rejects.toThrow("The target layer 404:1 no longer exists.");
		expect((globalThis as any).__figmaConsoleImageImport).toBeUndefined();
		expect(fake.calls.slice(-1)).toEqual(["commitUndo"]);
	});
});

describe("IMAGE_CONTAINER_BODY", () => {
	it("is the SVG container step with the image marker and plugin-data key", async () => {
		expect(IMAGE_CONTAINER_BODY.startsWith(SVG_HELPERS)).toBe(true);
		const own = IMAGE_CONTAINER_BODY.slice(SVG_HELPERS.length);
		// Its own marker is the image one; the SVG marker is only checked (both imports must not interleave).
		expect(own).toContain("const OWN_MARKER = '__figmaConsoleImageImport';");
		expect(own).toContain("const OTHER_MARKER = '__figmaConsoleSvgImport';");
		expect(own).not.toContain("'svgImport'");
		const fake = new ImageFake();
		const r = await run(fake, { runId: RUN, parentId: fake.currentPage.id, type: "frame", name: "Images", gap: 24, padding: 40, width: 600 }, IMAGE_CONTAINER_BODY, "Import images: container");
		const c = fake.nodes.get(r.id)!;
		expect(r).toMatchObject({ type: "FRAME", name: "Images", created: true, autoLayout: true });
		expect(c.layoutMode).toBe("HORIZONTAL");
		expect(JSON.parse(c.getPluginData("imageImport"))).toEqual({ v: 1, kind: "container", runId: RUN });
		expect(c.getPluginData("svgImport")).toBe("");
		expect((globalThis as any).__figmaConsoleImageImport).toBeUndefined();
	});
});

describe("IMAGE_PREFLIGHT_BODY", () => {
	const pf = (fake: ImageFake, over: Record<string, unknown> = {}) =>
		run(fake, { runId: RUN, creates: 1, parentId: null, containerName: "Images", resumeRunId: null, busyStaleMs: 900_000, targetIds: [], ...over }, IMAGE_PREFLIGHT_BODY, "Import images: check target");

	it("reports the file, the parent and fill targets", async () => {
		const fake = new ImageFake();
		const rect = new FNode("RECTANGLE", fake);
		rect.name = "Hero";
		rect._w = 30;
		rect._h = 20;
		fake.currentPage.appendChild(rect);
		const group = new FNode("GROUP", fake);
		group.name = "G";
		delete (group as any).fills;
		fake.currentPage.appendChild(group);
		const r = await pf(fake, { targetIds: [rect.id, group.id, "9:9"] });
		expect(r).toMatchObject({ editorType: "figma", fileKey: "FILE123", fileName: "Acme DS", parent: { id: fake.currentPage.id, type: "PAGE", autoLayout: false, onCurrentPage: true } });
		expect(r.targets).toEqual([
			{ id: rect.id, found: true, type: "RECTANGLE", name: "Hero", fillable: true, width: 30, height: 20 },
			{ id: group.id, found: true, type: "GROUP", name: "G", fillable: false, why: "is a GROUP, which has no fills" },
			{ id: "9:9", found: false },
		]);
	});

	it("refuses while either import's busy marker is fresh, ignores stale ones", async () => {
		const fake = new ImageFake();
		(globalThis as any).__figmaConsoleImageImport = { runId: "x", startedAt: Date.now() - 3000 };
		expect((await pf(fake)).fatal).toBe("An earlier image import is still running in Figma (started 3 s ago). Wait for it to finish, then run again.");
		(globalThis as any).__figmaConsoleImageImport = { runId: "x", startedAt: Date.now() - 1_000_000 };
		(globalThis as any).__figmaConsoleSvgImport = { runId: "y", startedAt: Date.now() };
		expect((await pf(fake)).fatal).toMatch(/^An earlier SVG import is still running in Figma/);
		delete (globalThis as any).__figmaConsoleSvgImport;
		expect((await pf(fake)).fatal).toBeUndefined();
	});

	it("the SVG preflight also refuses while an image import is running", async () => {
		const fake = new ImageFake();
		(globalThis as any).__figmaConsoleImageImport = { runId: "x", startedAt: Date.now() };
		const r = await run(
			fake,
			{ runId: RUN, parentId: null, wantsComponents: false, color: null, containerName: null, matchScope: "page", resumeRunId: null, editorSupport: EDITOR_SUPPORT, busyStaleMs: 900_000, maxCounted: 200, matches: [] },
			SVG_PREFLIGHT_BODY,
			"Import SVG: check target",
		);
		expect(r.fatal).toMatch(/^An earlier image import is still running in Figma/);
	});

	it("refuses Dev Mode, a missing image API, bad parents and non-slide parents in Slides", async () => {
		const dev = new ImageFake();
		dev.editorType = "dev";
		expect((await pf(dev)).fatal).toBe("Dev Mode is read-only. Switch the file to Design mode (Shift+D) and run again.");
		const old = new ImageFake();
		old.noImageApi = true;
		expect((await pf(old)).fatal).toBe("This Figma version has no image upload in the Plugin API. Update Figma Desktop.");
		const fake = new ImageFake();
		expect((await pf(fake, { parentId: "5:5" })).fatal).toBe("Parent 5:5 not found. Node ids change between sessions; get a fresh one from the file.");
		const inst = new FNode("INSTANCE", fake);
		inst.children = [];
		fake.currentPage.appendChild(inst);
		const inner = new FNode("FRAME", fake);
		inst.appendChild(inner);
		expect((await pf(fake, { parentId: inner.id })).fatal).toBe("Can't put layers inside a FRAME inside an instance. Use a frame, section, group, page or slide.");
		// Fills alone never resolve the parent.
		expect((await pf(fake, { parentId: "5:5", creates: 0 })).fatal).toBeUndefined();
		const slides = new ImageFake();
		slides.editorType = "slides";
		expect((await pf(slides)).fatal).toBe("In Slides, pass parentId (a slide id from figma_list_slides) or focus a slide.");
		const slide = new FNode("SLIDE", slides);
		slides.currentPage.appendChild(slide);
		slides.currentPage.focusedSlide = slide;
		expect((await pf(slides)).parent).toMatchObject({ id: slide.id, type: "SLIDE" });
		const loose = new FNode("FRAME", slides);
		slides.currentPage.appendChild(loose);
		expect((await pf(slides, { parentId: loose.id })).fatal).toBe("In Slides, put the images on a slide: pass a slide id (figma_list_slides) or a frame inside one.");
	});

	it("reuses a container by name and finds what an interrupted run placed", async () => {
		const fake = new ImageFake();
		const c = fake.api().createSection();
		c.name = "Images";
		const placed = new FNode("RECTANGLE", fake);
		placed._w = 10;
		placed._h = 5;
		c.appendChild(placed);
		placed.setPluginData("imageImport", JSON.stringify({ v: 1, runId: RUN, source: "images[0]", hash: "H0", imageHash: "IH" }));
		const other = new FNode("RECTANGLE", fake);
		c.appendChild(other);
		other.setPluginData("imageImport", JSON.stringify({ v: 1, runId: "000000000000", source: "images[1]", hash: "H1" }));
		const r = await pf(fake, { resumeRunId: RUN });
		expect(r.container).toEqual({ id: c.id, type: "SECTION", name: "Images", autoLayout: false });
		expect(r.resumed).toEqual([{ source: "images[0]", hash: "H0", nodeId: placed.id, type: "RECTANGLE", width: 10, height: 5, imageHash: "IH" }]);
	});
});

describe("static checks", () => {
	it("bodies hold no template syntax, backticks or syntax the sandbox rejects", () => {
		for (const [name, body] of Object.entries(ALL_IMAGE_BODIES)) {
			expect([name, body.includes("${")]).toEqual([name, false]);
			expect([name, body.includes("`")]).toEqual([name, false]);
			expect([name, /\?\.[A-Za-z_(]/.test(body)]).toEqual([name, false]);
			expect([name, body.includes("??")]).toEqual([name, false]);
			expect([name, /\{\s*\.\.\./.test(body)]).toEqual([name, false]);
		}
	});

	it("payload text arrives byte-identical and the label never carries it", async () => {
		const evil = '"; figma.root.remove(); "` ${x} </script> \u2028\u2029';
		const script = assetScript("Import images (1 items)", { items: [{ name: evil }] }, IMAGE_IMPORT_BODY);
		expect(script.split("\n")[0]).toBe("// Import images (1 items)");
		const P = new Function(`${script.split("\n")[1]} return P;`)();
		expect(P.items[0].name).toBe(evil);
		const fake = new ImageFake();
		const r = await run(fake, payload(fake, { items: [item(png(3, 3), 3, 3, { name: evil })] }));
		expect(fake.nodes.get(r.results[0].nodeId)!.name).toBe(evil);
	});
});
