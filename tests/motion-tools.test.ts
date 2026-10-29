/**
 * Motion tools: tool-level validation plus the generated Plugin API scripts,
 * run against a fake `figma` global.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	APPLY_ANIMATION_BODY,
	GET_ANIMATIONS_BODY,
	MAX_INLINE_EXPORT_BYTES,
	motionScript,
	registerMotionTools,
	REMOVE_ANIMATION_BODY,
	validateVideoSettings,
} from "../src/core/motion-tools";
import { GET_CODE_LAYERS_SCRIPT, registerCodeLayerTools } from "../src/core/code-layer-tools";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function mockServer() {
	const tools: Record<string, Handler> = {};
	return { tool: jest.fn((name: string, _d: string, _s: unknown, h: Handler) => { tools[name] = h; }), tools };
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const runScript = (script: string, figma: unknown) => new AsyncFunction("figma", script)(figma);

function fakeNode(overrides: Record<string, unknown> = {}) {
	return {
		id: "1:2",
		name: "Card",
		type: "FRAME",
		animationStyles: [] as any[],
		manualKeyframeTracks: {} as Record<string, unknown>,
		timelines: [{ id: "1:2", duration: 2 }],
		applyAnimationStyle: jest.fn().mockReturnValue("AnimationPresetId:9"),
		applyManualKeyframeTrack: jest.fn(),
		removeAnimationStyle: jest.fn(),
		removeManualKeyframeTrack: jest.fn(),
		...overrides,
	};
}

function fakeFigma(node: ReturnType<typeof fakeNode>, variables: Record<string, { name: string; resolvedType: string }> = {}) {
	return {
		currentPage: { selection: [node] },
		getNodeByIdAsync: jest.fn(async (id: string) => (id === node.id ? node : null)),
		getStyleByIdAsync: jest.fn(async () => null),
		motion: {
			playheadPosition: undefined,
			figmaAnimationStyles: () => ["TextStagger", "Position", "Scale", "Rotation", "Size", "Opacity", "Path"].map((styleId) => ({ styleId })),
		},
		variables: {
			getVariableByIdAsync: jest.fn(async (id: string) => (variables[id] ? { id, ...variables[id] } : null)),
			createVariableAlias: jest.fn((v: { id: string }) => ({ type: "VARIABLE_ALIAS", id: v.id })),
		},
	};
}

describe("motion scripts", () => {
	it("applies a preset with token-bound easing and duration", async () => {
		const node = fakeNode();
		const figma = fakeFigma(node, { "V:e": { name: "ease/standard", resolvedType: "EASING" }, "V:t": { name: "dur/fast", resolvedType: "TIMING" } });
		await runScript(
			motionScript({ nodeId: "1:2", preset: "Opacity", timelineOffset: 0.1, easing: { variableId: "V:e" }, durationVariableId: "V:t", props: { type: "fadeIn" } }, APPLY_ANIMATION_BODY),
			figma,
		);
		expect(node.applyAnimationStyle).toHaveBeenCalledWith("Opacity", {
			timelineOffset: 0.1,
			props: { type: "fadeIn", easing: { type: "VARIABLE_ALIAS", id: "V:e" }, duration: { type: "VARIABLE_ALIAS", id: "V:t" } },
		});
	});

	it("types keyframe values and converts literal easings", async () => {
		const node = fakeNode();
		await runScript(
			motionScript(
				{
					nodeId: "1:2",
					keyframeTracks: [
						{ property: "ROTATION", keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 90, easing: { type: "CUSTOM_SPRING", bounce: 0.4 } }] },
						{ property: "SCALE_XY", keyframes: [{ time: 0.3, value: { x: 1, y: 1 }, easing: { type: "CUSTOM_CUBIC_BEZIER", bezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 } } }] },
						{ paint: { collection: "fills", index: 0 }, keyframes: [{ time: 1, value: { r: 1, g: 0, b: 0 } }] },
					],
				},
				APPLY_ANIMATION_BODY,
			),
			fakeFigma(node),
		);
		const calls = node.applyManualKeyframeTrack.mock.calls;
		expect(calls[0][0]).toEqual({ type: "PROPERTY", name: "ROTATION" });
		expect(calls[0][1].keyframes[1]).toEqual({ timelinePosition: 0.5, value: { type: "FLOAT", value: 90 }, easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.4 } } });
		expect(calls[1][1].keyframes[0].value).toEqual({ type: "VECTOR", value: { x: 1, y: 1 } });
		expect(calls[1][1].keyframes[0].easing).toEqual({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 } });
		expect(calls[2][0]).toEqual({ type: "INDEXED_ITEM", collection: "fills", index: 0 });
		expect(calls[2][1].keyframes[0].value).toEqual({ type: "COLOR", value: { r: 1, g: 0, b: 0, a: 1 } });
	});

	it("refuses main components and unknown presets, and checks variable types", async () => {
		const component = fakeNode({ type: "COMPONENT" });
		await expect(runScript(motionScript({ nodeId: "1:2", preset: "Opacity" }, APPLY_ANIMATION_BODY), fakeFigma(component))).rejects.toThrow(/main component/);
		const node = fakeNode();
		await expect(runScript(motionScript({ nodeId: "1:2", preset: "Wiggle" }, APPLY_ANIMATION_BODY), fakeFigma(node))).rejects.toThrow(/Unknown preset "Wiggle"/);
		const figma = fakeFigma(node, { "V:f": { name: "size", resolvedType: "FLOAT" } });
		await expect(runScript(motionScript({ nodeId: "1:2", preset: "Opacity", easing: { variableId: "V:f" } }, APPLY_ANIMATION_BODY), figma)).rejects.toThrow(/not EASING/);
	});

	it("says clearly when the Motion API is missing", async () => {
		const node = fakeNode();
		const figma = { ...fakeFigma(node), motion: undefined };
		await expect(runScript(motionScript({ nodeId: "1:2" }, GET_ANIMATIONS_BODY), figma)).rejects.toThrow(/Update Figma Desktop/);
	});

	it("reads styles, keyframe tracks and CSS easings", async () => {
		const node = fakeNode({
			animationStyles: [{ type: "FIGMA", id: "AP:1", styleId: "CC:1", name: "opacity", duration: 0.30000001192, props: { easing: { type: "EASE_OUT", easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } } } }],
			manualKeyframeTracks: {
				OPACITY: { baseValue: { type: "FLOAT", value: 1 }, keyframes: [{ timelinePosition: 0.4, value: { type: "FLOAT", value: 0 }, easing: { type: "LINEAR", easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 1, y2: 1 } } }] },
				fills: { 0: { baseValue: { type: "COLOR", value: { r: 0, g: 0, b: 1, a: 1 } }, keyframes: [] } },
			},
		});
		const out = await runScript(motionScript({ nodeId: "1:2" }, GET_ANIMATIONS_BODY), fakeFigma(node));
		expect(out.node.animationStyles[0]).toMatchObject({ kind: "preset", appliedId: "AP:1", duration: 0.3, props: { easing: { css: "cubic-bezier(0, 0, 0.58, 1)" } } });
		expect(out.node.keyframeTracks[0]).toEqual({ target: { property: "OPACITY" }, baseValue: 1, keyframes: [{ time: 0.4, value: 0, easing: { type: "LINEAR", bezier: { x1: 0, y1: 0, x2: 1, y2: 1 }, css: "linear" } }] });
		expect(out.node.keyframeTracks[1].target).toEqual({ paint: { collection: "fills", index: 0 } });
	});

	it("removes by applied id, by track, or everything", async () => {
		const node = fakeNode({ animationStyles: [{ type: "FIGMA", id: "AP:1" }], manualKeyframeTracks: { ROTATION: { keyframes: [] } } });
		await expect(runScript(motionScript({ nodeId: "1:2", appliedId: "nope" }, REMOVE_ANIMATION_BODY), fakeFigma(node))).rejects.toThrow(/No applied animation style/);
		await runScript(motionScript({ nodeId: "1:2", all: true }, REMOVE_ANIMATION_BODY), fakeFigma(node));
		expect(node.removeAnimationStyle).toHaveBeenCalledWith("AP:1");
		expect(node.removeManualKeyframeTrack).toHaveBeenCalledWith({ type: "PROPERTY", name: "ROTATION" });
	});
});

describe("motion tools", () => {
	const connectorReturning = (result: unknown) => ({ executeCodeViaUI: jest.fn().mockResolvedValue({ success: true, result }) });

	it("registers the motion tools", () => {
		const server = mockServer();
		registerMotionTools(server as any, async () => ({}));
		expect(Object.keys(server.tools).sort()).toEqual([
			"figma_apply_animation",
			"figma_export_animation",
			"figma_get_animations",
			"figma_manage_animation_styles",
			"figma_remove_animation",
		]);
	});

	it("requires exactly one animation source", async () => {
		const server = mockServer();
		registerMotionTools(server as any, async () => connectorReturning({}));
		const none = await server.tools.figma_apply_animation({ nodeId: "1:2" });
		expect(none.isError).toBe(true);
		const two = await server.tools.figma_apply_animation({ nodeId: "1:2", preset: "Opacity", customStyleId: "S:1" });
		expect(JSON.parse(two.content[0].text).error).toMatch(/exactly one/);
	});

	it("validates video fps and scale per format", () => {
		expect(validateVideoSettings({ format: "GIF", fps: 60 })).toMatch(/not supported for GIF/);
		expect(validateVideoSettings({ format: "MP4", fps: 60 })).toBeNull();
		expect(validateVideoSettings({ format: "MP4", scale: 5 })).toMatch(/scale 5/);
	});

	it("writes exports to disk in Local Mode", async () => {
		const server = mockServer();
		const connector = connectorReturning({ nodeId: "1:2", name: "Card", format: "GIF", bytes: 3, base64: Buffer.from("GIF").toString("base64") });
		registerMotionTools(server as any, async () => connector, { allowFileWrite: true });
		const target = join(tmpdir(), `motion-test-${Date.now()}.gif`);
		const res = await server.tools.figma_export_animation({ format: "GIF", fps: 12, outputPath: target });
		const body = JSON.parse(res.content[0].text);
		expect(body.path).toBe(target);
		expect(readFileSync(target, "utf8")).toBe("GIF");
		expect(body.base64).toBeUndefined();
		rmSync(target);
	});

	it("refuses to overwrite an existing file unless overwrite is true", async () => {
		const target = join(tmpdir(), `motion-test-existing-${Date.now()}.gif`);
		writeFileSync(target, "KEEP");
		const connector = connectorReturning({ nodeId: "1:2", name: "Card", format: "GIF", bytes: 3, base64: Buffer.from("GIF").toString("base64") });
		const refused = mockServer();
		registerMotionTools(refused as any, async () => connector, { allowFileWrite: true });
		const res = await refused.tools.figma_export_animation({ format: "GIF", outputPath: target });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/already exists/);
		expect(connector.executeCodeViaUI).not.toHaveBeenCalled();
		expect(readFileSync(target, "utf8")).toBe("KEEP");

		const allowed = mockServer();
		registerMotionTools(allowed as any, async () => connector, { allowFileWrite: true });
		await allowed.tools.figma_export_animation({ format: "GIF", outputPath: target, overwrite: true });
		expect(readFileSync(target, "utf8")).toBe("GIF");
		rmSync(target);
	});

	it("returns base64 in Cloud Mode and refuses oversized exports", async () => {
		const small = mockServer();
		registerMotionTools(small as any, async () => connectorReturning({ nodeId: "1", name: "a", format: "MP4", bytes: 4, base64: "AAAA" }));
		const ok = JSON.parse((await small.tools.figma_export_animation({ format: "MP4" })).content[0].text);
		expect(ok.base64).toBe("AAAA");
		expect(existsSync(ok.path ?? "/nonexistent")).toBe(false);

		const big = mockServer();
		registerMotionTools(big as any, async () => connectorReturning({ nodeId: "1", name: "a", format: "MP4", bytes: MAX_INLINE_EXPORT_BYTES + 1, base64: "" }));
		const res = await big.tools.figma_export_animation({ format: "MP4" });
		expect(res.isError).toBe(true);
	});
});

describe("code layer tools", () => {
	it("finds CODE_INSTANCE nodes with their links", async () => {
		const code = { id: "7:3", name: "Signup", type: "CODE_INSTANCE", x: 1, y: 2, width: 3, height: 4, visible: true, locked: false, parent: { id: "0:1", type: "PAGE" }, getDevResourcesAsync: async () => [{ name: "repo", url: "https://github.com/x/y" }], getRelatedLinksAsync: async () => [] };
		const page = { id: "0:1", name: "P", findAll: (pred: (n: any) => boolean) => [code, { type: "FRAME" }].filter(pred) };
		const out = await runScript(GET_CODE_LAYERS_SCRIPT("page", 10), { currentPage: page, root: { children: [page] } });
		expect(out.count).toBe(1);
		expect(out.codeLayers[0]).toMatchObject({ id: "7:3", page: "P", devResources: [{ name: "repo", url: "https://github.com/x/y" }] });
	});

	it("registers figma_get_code_layers", () => {
		const server = mockServer();
		registerCodeLayerTools(server as any, async () => ({}));
		expect(Object.keys(server.tools)).toEqual(["figma_get_code_layers"]);
	});
});
