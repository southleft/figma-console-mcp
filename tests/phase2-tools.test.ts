/**
 * Shader, layout, CSS color and text-style tools.
 *
 * The generated plugin scripts run against small fake `figma` objects that
 * mimic the Plugin API behavior verified live (Eventz shaders page, CBDS).
 */

import { APPLY_SHADER_BODY, LIST_SHADERS_BODY, registerShaderTools, shaderScript } from "../src/core/shader-tools";
import { layoutScript, parseGridTracks, registerLayoutTools } from "../src/core/layout-tools";
import { CSS_PAINT_BODY, HEX_COLOR_RE, registerWriteTools, TEXT_STYLE_BODY } from "../src/core/write-tools";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function mockServer() {
	const tools: Record<string, Handler> = {};
	return { tool: jest.fn((name: string, _d: string, _s: unknown, h: Handler) => { tools[name] = h; }), tools };
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const runScript = (script: string, figma: unknown) => new AsyncFunction("figma", script)(figma);
const withP = (payload: unknown, body: string) => `const P = ${JSON.stringify(payload)};\n${body}`;

// A fill shader as Figma reports it once applied.
const CLOUD = "cloud/429";
const CLOUD_META = {
	"k:density": { name: "density", type: "NUMBER", defaultValue: 50 },
	"k:cloudColor": { name: "cloudColor", type: "COLOR", defaultValue: { r: 1, g: 1, b: 1, a: 1 } },
};
const CLOUD_DEFAULTS = { "k:density": 50, "k:cloudColor": { r: 1, g: 1, b: 1, a: 1 } };

/** A node whose fills/strokes/effects validate shader ids like Figma does. */
function shaderNode(initialFills: any[] = []) {
	const store: Record<string, any[]> = { fills: initialFills, strokes: [], effects: [] };
	const node: any = { id: "1:1", name: "Box", type: "RECTANGLE" };
	for (const target of ["fills", "strokes", "effects"]) {
		Object.defineProperty(node, target, {
			get: () => store[target].map((p) => (p.type === "SHADER" ? { ...p, propertyMetadata: CLOUD_META } : p)),
			set: (paints: any[]) => {
				for (const p of paints) {
					if (p.type !== "SHADER") continue;
					if (p.id !== CLOUD || target === "effects") throw new Error(`in set_${target}: Invalid shader id "${p.id}". Expected an id from figma.listAvailableShaders().`);
					if ("propertyMetadata" in p) throw new Error("propertyMetadata is read-only");
				}
				store[target] = paints.map((p) => (p.type === "SHADER" ? { ...p, properties: { ...CLOUD_DEFAULTS, ...(p.properties || {}) } } : p));
			},
			enumerable: true,
		});
	}
	return { node, store };
}

function shaderFigma(node: any) {
	return {
		getNodeByIdAsync: async (id: string) => (id === node.id ? node : null),
		importShaderById: jest.fn(),
		util: { rgba: (hex: string) => ({ r: hex === "#FF0000" ? 1 : 0, g: 0, b: 0, a: 1 }) },
	};
}

describe("parseGridTracks", () => {
	it("reads fr, px, auto, repeat() and counts", () => {
		expect(parseGridTracks("240px repeat(2, 1fr) auto")).toEqual([
			{ type: "FIXED", value: 240 },
			{ type: "FLEX", value: 1 },
			{ type: "FLEX", value: 1 },
			{ type: "HUG" },
		]);
		expect(parseGridTracks("2fr fr 80")).toEqual([
			{ type: "FLEX", value: 2 },
			{ type: "FLEX", value: 1 },
			{ type: "FIXED", value: 80 },
		]);
		expect(parseGridTracks(3)).toHaveLength(3);
	});

	it("rejects tracks it can't represent", () => {
		expect(() => parseGridTracks("minmax(100px, 1fr)")).toThrow(/Can't read grid track/);
		expect(() => parseGridTracks("")).toThrow(/No grid tracks/);
		expect(() => parseGridTracks(0)).toThrow(/positive whole number/);
	});
});

describe("shader tools", () => {
	it("registers figma_list_shaders and figma_apply_shader", () => {
		const server = mockServer();
		registerShaderTools(server as any, async () => ({}));
		expect(Object.keys(server.tools)).toEqual(["figma_list_shaders", "figma_apply_shader"]);
	});

	it("lists in-file shaders with named properties, deduped by id", async () => {
		const mk = (id: string) => ({ id, name: "n" + id, fills: [{ type: "SHADER", id: CLOUD, properties: CLOUD_DEFAULTS, propertyMetadata: CLOUD_META }], strokes: [], effects: [] });
		const page = { type: "PAGE", name: "Shaders", id: "0:1", findAll: () => [mk("1:1"), mk("1:2"), { id: "1:3", fills: [{ type: "SOLID" }] }] };
		const out = await runScript(shaderScript({ scope: "page" }, LIST_SHADERS_BODY), {
			currentPage: page,
			root: { children: [page] },
			listAvailableShaders: async () => [],
		});
		expect(out.inFile).toHaveLength(1);
		expect(out.inFile[0]).toMatchObject({ id: CLOUD, kind: "fill", usageCount: 2 });
		expect(out.inFile[0].properties.map((p: any) => p.name)).toEqual(["density", "cloudColor"]);
		expect(out.note).toMatch(/reloads/);
	});

	it("adds a shader and sets properties by name, converting hex colors", async () => {
		const { node, store } = shaderNode([{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]);
		const out = await runScript(
			withP({ nodeId: "1:1", target: "fills", shaderId: CLOUD, properties: { density: 80, cloudColor: "#FF0000" }, opacity: 0.9 }, APPLY_SHADER_BODY),
			shaderFigma(node),
		);
		expect(store.fills.map((p) => p.type)).toEqual(["SOLID", "SHADER"]);
		expect(store.fills[1].opacity).toBe(0.9);
		expect(out.index).toBe(1);
		expect(out.properties).toEqual({ density: 80, cloudColor: { r: 1, g: 0, b: 0, a: 1 } });
	});

	it("changes an applied shader by index and binds variables", async () => {
		const { node, store } = shaderNode([{ type: "SHADER", id: CLOUD, properties: CLOUD_DEFAULTS }]);
		await runScript(withP({ nodeId: "1:1", target: "fills", index: 0, properties: { density: { variableId: "VariableID:1:2" } } }, APPLY_SHADER_BODY), shaderFigma(node));
		expect(store.fills).toHaveLength(1);
		expect(store.fills[0].properties["k:density"]).toEqual({ type: "VARIABLE_ALIAS", id: "VariableID:1:2" });
	});

	it("leaves the node unchanged on an unknown property name", async () => {
		const { node, store } = shaderNode([{ type: "SOLID" }]);
		await expect(
			runScript(withP({ nodeId: "1:1", target: "fills", shaderId: CLOUD, properties: { densty: 1 } }, APPLY_SHADER_BODY), shaderFigma(node)),
		).rejects.toThrow(/Unknown shader property: densty.*density \(NUMBER\).*Nothing was changed/);
		expect(store.fills).toEqual([{ type: "SOLID" }]);
	});

	it("explains that fill shaders don't go on effects", async () => {
		const { node } = shaderNode();
		await expect(
			runScript(withP({ nodeId: "1:1", target: "effects", shaderId: CLOUD }, APPLY_SHADER_BODY), shaderFigma(node)),
		).rejects.toThrow(/a fill shader goes on fills or strokes/);
	});
});

describe("figma_set_layout", () => {
	function frame(overrides: Record<string, unknown> = {}) {
		const sizes = () => ({ type: "FLEX", value: 1 });
		const f: any = {
			id: "2:1", name: "Grid", type: "FRAME", layoutMode: "NONE", width: 100, height: 100,
			layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
			paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
			itemSpacing: 0, counterAxisSpacing: 0, layoutWrap: "NO_WRAP", primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", counterAxisAlignContent: "AUTO",
			gridRowGap: 0, gridColumnGap: 0, gridAutoTracks: "NONE", gridItemsPositioning: "MANUAL",
			gridRowSizes: [] as any[], gridColumnSizes: [] as any[],
			resize(w: number, h: number) { this.width = w; this.height = h; },
			appendChild: jest.fn(), appendChildAt: jest.fn(),
			...overrides,
		};
		Object.defineProperty(f, "gridColumnCount", { get: () => f.gridColumnSizes.length, set: (n: number) => { f.gridColumnSizes = Array.from({ length: n }, sizes); } });
		Object.defineProperty(f, "gridRowCount", { get: () => f.gridRowSizes.length, set: (n: number) => { f.gridRowSizes = Array.from({ length: n }, sizes); } });
		return f;
	}

	it("sets auto layout with SPACE_EVENLY, wrap and per-side padding", async () => {
		const f = frame();
		const out = await runScript(layoutScript({ nodeId: "2:1", mode: "HORIZONTAL", wrap: true, gap: 12, counterAxisGap: 8, padding: { top: 16, left: 24 }, primaryAlign: "SPACE_EVENLY" }), { getNodeByIdAsync: async () => f });
		expect(out).toMatchObject({ mode: "HORIZONTAL", gap: 12, wrap: true, counterAxisGap: 8, primaryAlign: "SPACE_EVENLY", padding: { top: 16, right: 0, bottom: 0, left: 24 } });
	});

	it("builds grid tracks and reports them as CSS", async () => {
		const f = frame();
		const out = await runScript(
			layoutScript({ nodeId: "2:1", mode: "GRID", gap: 8, grid: { columns: parseGridTracks("240px 1fr auto"), rows: parseGridTracks(2), rowGap: 4 } }),
			{ getNodeByIdAsync: async () => f },
		);
		expect(out.grid).toMatchObject({ columns: "240px 1fr auto", rows: "1fr 1fr", columnGap: 8, rowGap: 4 });
	});

	it("refuses grid options on a non-grid frame", async () => {
		const f = frame({ layoutMode: "VERTICAL" });
		await expect(runScript(layoutScript({ nodeId: "2:1", grid: { columnGap: 4 } }), { getNodeByIdAsync: async () => f })).rejects.toThrow(/grid needs mode GRID \(this frame is VERTICAL\)/);
	});

	it("registers figma_set_layout and rejects unreadable tracks before calling Figma", async () => {
		const server = mockServer();
		const connector = { executeCodeViaUI: jest.fn() };
		registerLayoutTools(server as any, async () => connector);
		const res = await server.tools.figma_set_layout({ nodeId: "2:1", mode: "GRID", grid: { columns: "minmax(0, 1fr)" } });
		expect(res.isError).toBe(true);
		expect(connector.executeCodeViaUI).not.toHaveBeenCalled();
	});
});

describe("CSS colors on fills and strokes", () => {
	const connector = () => ({
		setNodeFills: jest.fn().mockResolvedValue({ success: true, node: { id: "1:1" } }),
		setNodeStrokes: jest.fn().mockResolvedValue({ success: true, node: { id: "1:1" } }),
		executeCodeViaUI: jest.fn().mockResolvedValue({ success: true, result: { node: { id: "1:1" }, colorSpaces: ["OKLCH"] } }),
	});

	it("recognizes hex colors", () => {
		for (const c of ["#fff", "FF0000", "#FF000080", "#abcd"]) expect(HEX_COLOR_RE.test(c)).toBe(true);
		for (const c of ["oklch(60% 0.2 250)", "rgb(0 0 0)", "#ggg"]) expect(HEX_COLOR_RE.test(c)).toBe(false);
	});

	it("keeps hex fills on the plugin handler and routes CSS colors through solidPaint", async () => {
		const server = mockServer();
		const c = connector();
		registerWriteTools(server as any, async () => c);
		await server.tools.figma_set_fills({ nodeId: "1:1", fills: [{ type: "SOLID", color: "#FF0000" }] });
		expect(c.setNodeFills).toHaveBeenCalledTimes(1);
		expect(c.executeCodeViaUI).not.toHaveBeenCalled();

		const res = await server.tools.figma_set_strokes({ nodeId: "1:1", strokes: [{ type: "SOLID", color: "oklch(60% 0.2 250)" }], strokeWeight: 2 });
		expect(c.setNodeStrokes).not.toHaveBeenCalled();
		expect(c.executeCodeViaUI.mock.calls[0][0]).toContain('"target":"strokes"');
		expect(c.executeCodeViaUI.mock.calls[0][0]).toContain('"strokeWeight":2');
		expect(JSON.parse(res.content[0].text)).toMatchObject({ success: true, colorSpaces: ["OKLCH"] });
	});

	it("notes when Figma drops the wide-gamut source of a translucent paint", async () => {
		const node: any = { id: "1:1", name: "R", type: "RECTANGLE", _f: [] };
		Object.defineProperty(node, "fills", {
			get: () => node._f,
			// Figma stores sourceColor only on fully opaque paints.
			set: (p: any[]) => { node._f = p.map((x) => (x.opacity < 1 ? { ...x, color: { r: x.color.r, g: x.color.g, b: x.color.b } } : x)); },
		});
		const figma = {
			getNodeByIdAsync: async () => node,
			root: { documentColorProfile: "SRGB" },
			util: { solidPaint: () => ({ type: "SOLID", color: { r: 1, g: 0, b: 0, sourceColor: { space: "DISPLAY_P3", r: 1, g: 0.2, b: 0.1 } }, opacity: 1 }) },
			variables: {},
		};
		const out = await runScript(withP({ nodeId: "1:1", target: "fills", paints: [{ color: "color(display-p3 1 0.2 0.1)", opacity: 0.5 }] }, CSS_PAINT_BODY), figma);
		expect(out.colorSpaces).toEqual(["SRGB"]);
		expect(out.note).toMatch(/only on fully opaque paints, so fills 0/);
	});
});

describe("figma_set_text styling", () => {
	const connector = () => ({
		setTextContent: jest.fn().mockResolvedValue({ success: true, node: { id: "3:1" } }),
		executeCodeViaUI: jest.fn().mockResolvedValue({ success: true, result: { node: { id: "3:1" }, fontName: { family: "Inter" }, fontSize: 16, textWrapStyle: "BALANCE" } }),
	});

	it("leaves plain text calls on the plugin handler", async () => {
		const server = mockServer();
		const c = connector();
		registerWriteTools(server as any, async () => c);
		await server.tools.figma_set_text({ nodeId: "3:1", text: "Hi", fontStyle: "Bold" });
		expect(c.setTextContent).toHaveBeenCalledWith("3:1", "Hi", { fontSize: undefined, fontFamily: undefined, fontStyle: "Bold" });
		expect(c.executeCodeViaUI).not.toHaveBeenCalled();
	});

	it("sets wrap and axes after the text, and styles without text", async () => {
		const server = mockServer();
		const c = connector();
		registerWriteTools(server as any, async () => c);
		await server.tools.figma_set_text({ nodeId: "3:1", text: "Hi", fontFamily: "Inter", fontVariations: { wght: 550 }, textWrapStyle: "BALANCE" });
		expect(c.setTextContent).toHaveBeenCalledWith("3:1", "Hi", undefined);
		expect(c.executeCodeViaUI.mock.calls[0][0]).toContain('"fontVariations":{"wght":550}');
		expect(c.executeCodeViaUI.mock.calls[0][0]).toContain('"fontFamily":"Inter"');

		const res = await server.tools.figma_set_text({ nodeId: "3:1", textWrapStyle: "PRETTY" });
		expect(c.setTextContent).toHaveBeenCalledTimes(1);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ success: true, message: "Text styling updated", textWrapStyle: "BALANCE" });

		const none = await server.tools.figma_set_text({ nodeId: "3:1" });
		expect(none.isError).toBe(true);
	});

	it("names a variable font's real axes when one is wrong", async () => {
		const node: any = { id: "3:1", name: "T", type: "TEXT", characters: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 12, textWrapStyle: "AUTO" };
		const figma = {
			mixed: Symbol("mixed"),
			getNodeByIdAsync: async () => node,
			loadFontAsync: async () => {},
			getFontFamilyVariationAxes: (f: string) => (f === "Inter" ? ["slnt", "wght"] : null),
		};
		await expect(runScript(withP({ nodeId: "3:1", fontVariations: { wdth: 80 } }, TEXT_STYLE_BODY), figma)).rejects.toThrow("Inter has no wdth axis. Its axes are: slnt, wght.");
		await expect(runScript(withP({ nodeId: "3:1", fontFamily: "ABeeZee", fontVariations: { wght: 500 } }, TEXT_STYLE_BODY), figma)).rejects.toThrow(/not a variable font/);
		const out = await runScript(withP({ nodeId: "3:1", fontVariations: { wght: 650 }, textWrapStyle: "PRETTY" }, TEXT_STYLE_BODY), figma);
		expect(out.fontName).toEqual({ family: "Inter", variationSettings: { wght: 650 } });
		expect(out.textWrapStyle).toBe("PRETTY");
	});
});
