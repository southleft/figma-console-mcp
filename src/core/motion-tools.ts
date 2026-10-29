/**
 * Figma Motion tools (Plugin API Motion, beta: Updates 130–140).
 *
 * Read and write animation styles (Figma presets and local custom styles),
 * manual keyframe tracks, and export animated frames as MP4/GIF/WebM.
 * Easing and duration can be bound to EASING/TIMING variables.
 *
 * Every tool builds a Plugin API script here and runs it through
 * executeCodeViaUI, so no Desktop Bridge plugin change (or re-import) is
 * needed. Each script checks the API exists first, so an older Figma Desktop
 * gets a clear message instead of a TypeError.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "motion-tools" });

export const EASING_TYPES = [
	"EASE_IN",
	"EASE_OUT",
	"EASE_IN_AND_OUT",
	"LINEAR",
	"EASE_IN_BACK",
	"EASE_OUT_BACK",
	"EASE_IN_AND_OUT_BACK",
	"CUSTOM_CUBIC_BEZIER",
	"GENTLE",
	"QUICK",
	"BOUNCY",
	"SLOW",
	"CUSTOM_SPRING",
	"HOLD",
] as const;

export const KEYFRAME_PROPERTIES = [
	"OPACITY",
	"TRANSLATION_X",
	"TRANSLATION_Y",
	"TRANSLATION_XY",
	"ROTATION",
	"SCALE_X",
	"SCALE_Y",
	"SCALE_XY",
	"WIDTH",
	"HEIGHT",
	"CORNER_RADIUS",
	"RECTANGLE_TOP_LEFT_CORNER_RADIUS",
	"RECTANGLE_TOP_RIGHT_CORNER_RADIUS",
	"RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS",
	"RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS",
	"STROKE_WEIGHT",
	"BORDER_TOP_WEIGHT",
	"BORDER_BOTTOM_WEIGHT",
	"BORDER_LEFT_WEIGHT",
	"BORDER_RIGHT_WEIGHT",
	"STACK_SPACING",
	"STACK_COUNTER_SPACING",
	"STACK_PADDING_LEFT",
	"STACK_PADDING_TOP",
	"STACK_PADDING_RIGHT",
	"STACK_PADDING_BOTTOM",
	"GRID_ROW_GAP",
	"GRID_COLUMN_GAP",
	"PATH_TRIM_START",
	"PATH_TRIM_END",
] as const;

export const EFFECT_KEYFRAME_FIELDS = [
	"OFFSET_X",
	"OFFSET_Y",
	"RADIUS",
	"SPREAD",
	"COLOR",
	"SECONDARY_COLOR",
	"EFFECT_OPACITY",
	"REFRACTION_RADIUS",
	"REFRACTION_INTENSITY",
	"SPECULAR_ANGLE",
	"SPECULAR_INTENSITY",
	"CHROMATIC_ABERRATION",
	"SPLAY",
	"START_RADIUS",
	"NOISE_SIZE_X",
	"NOISE_SIZE_Y",
	"DENSITY",
] as const;

const MP4_WEBM_FPS = [12, 24, 30, 60];
const GIF_FPS = [8, 12, 15, 24, 30];
const VIDEO_SCALES = [0.5, 0.75, 1, 1.5, 2, 3, 4];
/** Inline (base64) exports above this many bytes must be written to disk instead. */
export const MAX_INLINE_EXPORT_BYTES = 5 * 1024 * 1024;

const fileKeySchema = z
	.string()
	.optional()
	.describe(
		"Local Mode only. Run against this specific connected file instead of the active file. Get connected fileKeys from figma_list_open_files. Rejected in Cloud Mode, which pairs with a single plugin instance.",
	);

const easingSchema = z
	.object({
		type: z
			.enum(EASING_TYPES)
			.optional()
			.describe("Easing curve. CUSTOM_CUBIC_BEZIER needs `bezier`; CUSTOM_SPRING needs `bounce`."),
		bezier: z
			.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() })
			.optional()
			.describe("Control points for CUSTOM_CUBIC_BEZIER, as in CSS cubic-bezier(x1, y1, x2, y2)"),
		bounce: z.number().min(0).max(1).optional().describe("Spring bounce (0–1) for CUSTOM_SPRING"),
		variableId: z
			.string()
			.optional()
			.describe("Bind an EASING variable instead of a literal curve (the other fields are then ignored)"),
	})
	.describe("Easing: a literal curve, or an EASING variable to bind");

const keyframeValueSchema = z
	.union([
		z.number(),
		z.object({ x: z.number(), y: z.number() }),
		z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() }),
	])
	.describe("A number (most properties), {x,y} for TRANSLATION_XY / SCALE_XY, or {r,g,b,a} (0–1) for colors");

const trackTargetShape = {
	property: z
		.enum(KEYFRAME_PROPERTIES)
		.optional()
		.describe("Node property to animate. TRANSLATION_* and ROTATION are additive offsets; SCALE_* are multipliers"),
	paint: z
		.object({ collection: z.enum(["fills", "strokes"]), index: z.number().int().min(0) })
		.optional()
		.describe("Animate the color of fills[index] or strokes[index] (values are {r,g,b,a})"),
	effect: z
		.object({ index: z.number().int().min(0), field: z.enum(EFFECT_KEYFRAME_FIELDS) })
		.optional()
		.describe("Animate a field of effects[index]"),
};

const keyframeTrackSchema = z.object({
	...trackTargetShape,
	baseValue: keyframeValueSchema.optional().describe("Value outside the keyframed range (optional)"),
	keyframes: z
		.array(
			z.object({
				time: z.number().min(0).describe("Position on the timeline in seconds"),
				value: keyframeValueSchema,
				easing: easingSchema.optional().describe("Easing INTO this keyframe"),
			}),
		)
		.min(1)
		.describe("Keyframes in time order"),
});

const keyframeTargetSchema = z
	.object(trackTargetShape)
	.describe("Which keyframe track: exactly one of property, paint or effect");

const propsSchema = z
	.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
	.optional()
	.describe(
		"Preset-specific options (e.g. {type:'fadeIn'}, {direction:'right', distance:120}). Valid keys and defaults per preset: figma_manage_animation_styles action 'list_presets'.",
	);

/**
 * Plugin-side helpers shared by every motion script: availability check,
 * easing/value conversion in both directions, and a normalized read of a
 * node's animations. Kept as one string so each script is self-contained.
 */
export const MOTION_HELPERS = `
const MOTION_UNAVAILABLE = 'The Figma Motion API is not available in this Figma Desktop. Update Figma Desktop (Motion shipped in Plugin API Update 130, June 2026).';
function assertMotion(node) {
  if (typeof figma.motion === 'undefined' || (node && typeof node.applyAnimationStyle !== 'function')) {
    throw new Error(MOTION_UNAVAILABLE);
  }
}
async function getTarget(id) {
  const node = id ? await figma.getNodeByIdAsync(id) : figma.currentPage.selection[0];
  if (!node) throw new Error(id ? 'Node not found: ' + id : 'No nodeId given and nothing is selected');
  if (!('animationStyles' in node)) throw new Error('Node ' + node.id + ' (' + node.type + ') cannot be animated');
  return node;
}
function assertWritable(node) {
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    throw new Error('Figma does not allow writing animations to a main component through the Plugin API. Apply them to an instance or a frame instead.');
  }
}
async function toEasing(e) {
  if (!e) return undefined;
  if (e.variableId) {
    const v = await figma.variables.getVariableByIdAsync(e.variableId);
    if (!v) throw new Error('EASING variable not found: ' + e.variableId);
    if (v.resolvedType !== 'EASING') throw new Error('Variable ' + v.name + ' is ' + v.resolvedType + ', not EASING');
    return figma.variables.createVariableAlias(v);
  }
  if (!e.type) throw new Error('easing needs a type or a variableId');
  const out = { type: e.type };
  if (e.type === 'CUSTOM_CUBIC_BEZIER') {
    if (!e.bezier) throw new Error('CUSTOM_CUBIC_BEZIER easing needs bezier {x1,y1,x2,y2}');
    out.easingFunctionCubicBezier = e.bezier;
  }
  if (e.type === 'CUSTOM_SPRING') out.easingFunctionSpring = { bounce: e.bounce === undefined ? 0.3 : e.bounce };
  return out;
}
async function timingAlias(id) {
  const v = await figma.variables.getVariableByIdAsync(id);
  if (!v) throw new Error('TIMING variable not found: ' + id);
  if (v.resolvedType !== 'TIMING') throw new Error('Variable ' + v.name + ' is ' + v.resolvedType + ', not TIMING');
  return figma.variables.createVariableAlias(v);
}
function toKeyframeValue(v) {
  if (typeof v === 'number') return { type: 'FLOAT', value: v };
  if (v && typeof v === 'object' && 'r' in v) return { type: 'COLOR', value: { r: v.r, g: v.g, b: v.b, a: v.a === undefined ? 1 : v.a } };
  if (v && typeof v === 'object' && 'x' in v) return { type: 'VECTOR', value: { x: v.x, y: v.y } };
  throw new Error('Unsupported keyframe value: ' + JSON.stringify(v));
}
function toField(t) {
  const n = (t.property ? 1 : 0) + (t.paint ? 1 : 0) + (t.effect ? 1 : 0);
  if (n !== 1) throw new Error('Each keyframe track needs exactly one of property, paint or effect');
  if (t.property) return { type: 'PROPERTY', name: t.property };
  if (t.paint) return { type: 'INDEXED_ITEM', collection: t.paint.collection, index: t.paint.index };
  return { type: 'INDEXED_ITEM', collection: 'effects', index: t.effect.index, field: t.effect.field };
}
const r3 = (n) => Math.round(n * 1000) / 1000;
async function readEasing(e) {
  if (!e) return undefined;
  if (e.type === 'VARIABLE_ALIAS') {
    const v = await figma.variables.getVariableByIdAsync(e.id);
    return { variableId: e.id, variableName: v ? v.name : undefined };
  }
  const out = { type: e.type };
  const b = e.easingFunctionCubicBezier;
  if (b) { out.bezier = { x1: r3(b.x1), y1: r3(b.y1), x2: r3(b.x2), y2: r3(b.y2) }; out.css = 'cubic-bezier(' + [b.x1, b.y1, b.x2, b.y2].map(r3).join(', ') + ')'; }
  if (e.easingFunctionSpring) out.bounce = r3(e.easingFunctionSpring.bounce);
  if (e.type === 'LINEAR') out.css = 'linear';
  if (e.type === 'HOLD') out.css = 'steps(1, end)';
  return out;
}
async function readProps(props) {
  if (!props) return undefined;
  const out = {};
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (v && typeof v === 'object' && v.type === 'VARIABLE_ALIAS') {
      const variable = await figma.variables.getVariableByIdAsync(v.id);
      out[k] = { variableId: v.id, variableName: variable ? variable.name : undefined };
    } else if (k === 'easing' && v && typeof v === 'object') {
      out[k] = await readEasing(v);
    } else out[k] = v;
  }
  return out;
}
function readValue(v) { return v ? v.value : undefined; }
async function readBinding(target, b) {
  const kfs = [];
  for (const k of b.keyframes || []) kfs.push({ time: r3(k.timelinePosition), value: readValue(k.value), easing: await readEasing(k.easing) });
  return { target, baseValue: readValue(b.baseValue), keyframes: kfs };
}
async function readTracks(node) {
  const mk = node.manualKeyframeTracks || {};
  const tracks = [];
  for (const key of Object.keys(mk)) {
    const entry = mk[key];
    if (!entry) continue;
    if (key === 'fills' || key === 'strokes') {
      for (const idx of Object.keys(entry)) {
        const b = entry[idx];
        if (b && b.keyframes) tracks.push(await readBinding({ paint: { collection: key, index: Number(idx) } }, b));
      }
    } else if (key === 'effects') {
      for (const idx of Object.keys(entry)) {
        const fx = entry[idx] || {};
        for (const field of Object.keys(fx)) {
          if (field !== 'properties' && fx[field] && fx[field].keyframes) tracks.push(await readBinding({ effect: { index: Number(idx), field } }, fx[field]));
        }
      }
    } else if (entry.keyframes) {
      tracks.push(await readBinding({ property: key }, entry));
    }
  }
  return tracks;
}
async function readStyle(a) {
  const out = { kind: a.type === 'CUSTOM' ? 'custom' : 'preset', appliedId: a.id, styleId: a.styleId, name: a.name };
  if (a.duration !== undefined) out.duration = r3(a.duration);
  if (a.timelineOffset !== undefined) out.timelineOffset = r3(a.timelineOffset);
  if (a.props) out.props = await readProps(a.props);
  if (a.type === 'CUSTOM') {
    try {
      const style = await figma.getStyleByIdAsync(a.styleId);
      if (style && style.animationEntries) out.entries = await Promise.all(style.animationEntries.map(readStyle));
    } catch (e) { /* remote or missing style */ }
  }
  return out;
}
async function readAnimations(node) {
  const styles = [];
  for (const a of node.animationStyles || []) styles.push(await readStyle(a));
  return {
    id: node.id, name: node.name, type: node.type,
    timelines: (node.timelines || []).map(t => ({ id: t.id, duration: r3(t.duration) })),
    animationStyles: styles,
    keyframeTracks: await readTracks(node),
  };
}
function hasAnimations(node) {
  if (!('animationStyles' in node)) return false;
  if ((node.animationStyles || []).length) return true;
  return Object.keys(node.manualKeyframeTracks || {}).length > 0;
}
async function readCustomStyle(s) {
  return { id: s.id, name: s.name, description: s.description, remote: s.remote, entries: await Promise.all(s.animationEntries.map(readStyle)) };
}
`;

/** Wrap a script body with the shared helpers and a JSON payload `P`. */
export function motionScript(payload: unknown, body: string): string {
	return `${MOTION_HELPERS}\nconst P = ${JSON.stringify(payload)};\n${body}`;
}

export const GET_ANIMATIONS_BODY = `
const node = await getTarget(P.nodeId);
assertMotion(node);
const out = { node: await readAnimations(node), playheadPosition: figma.motion.playheadPosition };
if (P.includeDescendants && 'findAll' in node) {
  const found = node.findAll(n => hasAnimations(n)).slice(0, P.limit);
  out.descendants = [];
  for (const n of found) out.descendants.push(await readAnimations(n));
}
return out;
`;

export const APPLY_ANIMATION_BODY = `
const node = await getTarget(P.nodeId);
assertMotion(node);
assertWritable(node);
const applied = [];
if (P.preset || P.customStyleId) {
  if (P.customStyleId) {
    const config = { type: 'CUSTOM' };
    if (P.timelineOffset !== undefined) config.timelineOffset = P.timelineOffset;
    applied.push(node.applyAnimationStyle(P.customStyleId, config));
  } else {
    const presets = figma.motion.figmaAnimationStyles().map(s => s.styleId);
    if (presets.indexOf(P.preset) === -1) throw new Error('Unknown preset "' + P.preset + '". Available: ' + presets.join(', '));
    const config = {};
    if (P.duration !== undefined) config.duration = P.duration;
    if (P.timelineOffset !== undefined) config.timelineOffset = P.timelineOffset;
    const props = Object.assign({}, P.props || {});
    const easing = await toEasing(P.easing);
    if (easing) props.easing = easing;
    if (P.durationVariableId) props.duration = await timingAlias(P.durationVariableId);
    if (Object.keys(props).length) config.props = props;
    applied.push(node.applyAnimationStyle(P.preset, config));
  }
}
for (const t of P.keyframeTracks || []) {
  const keyframes = [];
  for (const k of t.keyframes) {
    const kf = { timelinePosition: k.time, value: toKeyframeValue(k.value) };
    const easing = await toEasing(k.easing);
    if (easing) kf.easing = easing;
    keyframes.push(kf);
  }
  const track = { keyframes };
  if (t.baseValue !== undefined) track.baseValue = toKeyframeValue(t.baseValue);
  node.applyManualKeyframeTrack(toField(t), track);
  applied.push(t.property || (t.paint ? t.paint.collection + '[' + t.paint.index + ']' : 'effects[' + t.effect.index + '].' + t.effect.field));
}
return { applied, node: await readAnimations(node) };
`;

export const REMOVE_ANIMATION_BODY = `
const node = await getTarget(P.nodeId);
assertMotion(node);
assertWritable(node);
const removed = [];
if (P.all) {
  for (const a of (node.animationStyles || []).slice()) { node.removeAnimationStyle(a.id); removed.push(a.id); }
  for (const t of await readTracks(node)) { node.removeManualKeyframeTrack(toField(t.target)); removed.push(JSON.stringify(t.target)); }
} else {
  if (P.appliedId) {
    if (!(node.animationStyles || []).some(a => a.id === P.appliedId)) {
      throw new Error('No applied animation style with id ' + P.appliedId + ' on this node. Read appliedId values with figma_get_animations.');
    }
    node.removeAnimationStyle(P.appliedId);
    removed.push(P.appliedId);
  }
  if (P.keyframeTrack) { node.removeManualKeyframeTrack(toField(P.keyframeTrack)); removed.push(JSON.stringify(P.keyframeTrack)); }
}
return { removed, node: await readAnimations(node) };
`;

export const MANAGE_STYLES_BODY = `
assertMotion(null);
if (P.action === 'list_presets') {
  return { presets: figma.motion.figmaAnimationStyles().map(s => ({ styleId: s.styleId, name: s.name, description: s.description, props: s.props })) };
}
if (typeof figma.createCustomAnimationStyle !== 'function') {
  throw new Error('Custom animation styles need a newer Figma Desktop (Plugin API Update 140, September 2026).');
}
async function getStyle() {
  if (!P.styleId) throw new Error('styleId is required for ' + P.action);
  const s = await figma.getStyleByIdAsync(P.styleId);
  if (!s || s.type !== 'CUSTOM_ANIMATION') throw new Error('No custom animation style with id ' + P.styleId);
  return s;
}
async function entryProps(e) {
  const props = Object.assign({}, e.props || {});
  if (e.duration !== undefined) props.duration = e.duration;
  if (e.timelineOffset !== undefined) props.timelineOffset = e.timelineOffset;
  const easing = await toEasing(e.easing);
  if (easing) props.easing = easing;
  if (e.durationVariableId) props.duration = await timingAlias(e.durationVariableId);
  return props;
}
async function addEntries(style, entries) {
  const presets = figma.motion.figmaAnimationStyles().map(s => s.styleId);
  for (const e of entries || []) {
    if (presets.indexOf(e.preset) === -1) throw new Error('Unknown preset "' + e.preset + '". Available: ' + presets.join(', '));
    await style.addAnimationEntryAsync(e.preset, await entryProps(e));
  }
}
if (P.action === 'list') {
  const styles = await figma.getLocalCustomAnimationStylesAsync();
  return { styles: await Promise.all(styles.map(readCustomStyle)) };
}
if (P.action === 'create') {
  if (!P.name) throw new Error('name is required to create a style');
  const style = figma.createCustomAnimationStyle();
  style.name = P.name;
  if (P.description !== undefined) style.description = P.description;
  try { await addEntries(style, P.entries); } catch (e) { style.remove(); throw e; }
  return { created: await readCustomStyle(style) };
}
const style = await getStyle();
if (P.action === 'update') {
  if (P.name !== undefined) style.name = P.name;
  if (P.description !== undefined) style.description = P.description;
  await addEntries(style, P.entries);
  return { updated: await readCustomStyle(style) };
}
if (P.action === 'remove_entry') {
  if (!P.entryId) throw new Error('entryId is required for remove_entry');
  style.removeAnimationEntry(P.entryId);
  return { updated: await readCustomStyle(style) };
}
if (P.action === 'delete') {
  const name = style.name;
  style.remove();
  return { deleted: { id: P.styleId, name } };
}
throw new Error('Unknown action ' + P.action);
`;

export const EXPORT_ANIMATION_BODY = `
const node = P.nodeId ? await figma.getNodeByIdAsync(P.nodeId) : figma.currentPage.selection[0];
if (!node) throw new Error(P.nodeId ? 'Node not found: ' + P.nodeId : 'No nodeId given and nothing is selected');
if (typeof figma.motion === 'undefined') throw new Error(MOTION_UNAVAILABLE);
const settings = { format: P.format };
if (P.fps !== undefined) settings.fps = P.fps;
if (P.quality !== undefined && P.format !== 'GIF') settings.quality = P.quality;
if (P.loopCount !== undefined && P.format === 'GIF') settings.loopCount = P.loopCount;
if (P.scale !== undefined) settings.constraint = { type: 'SCALE', value: P.scale };
else if (P.width !== undefined) settings.constraint = { type: 'WIDTH', value: P.width };
else if (P.height !== undefined) settings.constraint = { type: 'HEIGHT', value: P.height };
let bytes;
try { bytes = await node.exportAsync(settings); }
catch (e) { throw new Error('Video export failed: ' + (e && e.message ? e.message : e) + '. Export works on a frame that has animated content (Motion); use its top-level frame.'); }
return { nodeId: node.id, name: node.name, format: P.format, bytes: bytes.length, base64: figma.base64Encode(bytes) };
`;

const MIME: Record<string, string> = { MP4: "video/mp4", GIF: "image/gif", WEBM: "video/webm" };

/** Validate fps/scale for a video format; returns an error message or null. */
export function validateVideoSettings(args: { format: string; fps?: number; scale?: number }): string | null {
	const allowed = args.format === "GIF" ? GIF_FPS : MP4_WEBM_FPS;
	if (args.fps !== undefined && !allowed.includes(args.fps)) {
		return `fps ${args.fps} is not supported for ${args.format}. Use one of: ${allowed.join(", ")}`;
	}
	if (args.scale !== undefined && !VIDEO_SCALES.includes(args.scale)) {
		return `scale ${args.scale} is not supported. Use one of: ${VIDEO_SCALES.join(", ")}`;
	}
	return null;
}

function ok(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function fail(tool: string, error: unknown) {
	logger.error({ error }, `${tool} failed`);
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
		isError: true,
	};
}

async function run(getDesktopConnector: () => Promise<any>, script: string, timeout: number, fileKey?: string) {
	const connector = await getDesktopConnector();
	const result = await connector.executeCodeViaUI(script, timeout, fileKey);
	if (!result?.success) throw new Error(result?.error || "Motion script failed");
	return result.result;
}

export interface MotionToolsOptions {
	/** Local Mode: figma_export_animation may write files to disk. */
	allowFileWrite?: boolean;
}

export function registerMotionTools(
	server: McpServer,
	getDesktopConnector: () => Promise<any>,
	options: MotionToolsOptions = {},
): void {
	server.tool(
		"figma_get_animations",
		"Read a node's Motion animations: applied animation styles (Figma presets and custom styles, with their entries), manual keyframe tracks, timelines and the playhead. Easing comes back with a CSS equivalent (cubic-bezier) where one exists, and token bindings come back as EASING/TIMING variable references. Set includeDescendants to also list animated layers inside it. Requires Desktop Bridge and Figma Desktop with the Motion API (beta).",
		{
			nodeId: z.string().optional().describe("Node to read. Defaults to the current selection"),
			includeDescendants: z.boolean().optional().default(false).describe("Also return animated layers inside the node"),
			limit: z.number().int().min(1).max(500).optional().default(100).describe("Max descendants to return"),
			fileKey: fileKeySchema,
		},
		async ({ nodeId, includeDescendants, limit, fileKey }) => {
			try {
				return ok(await run(getDesktopConnector, motionScript({ nodeId, includeDescendants, limit }, GET_ANIMATIONS_BODY), 30000, fileKey));
			} catch (error) {
				return fail("figma_get_animations", error);
			}
		},
	);

	server.tool(
		"figma_apply_animation",
		`Animate a node with Figma Motion. Pass exactly one of:
- preset: a Figma animation style (Position, Scale, Rotation, Size, Opacity, Path, TextStagger), with optional duration, timelineOffset, easing and preset props. List presets and their props with figma_manage_animation_styles action 'list_presets'.
- customStyleId: a local custom animation style (see figma_manage_animation_styles).
- keyframeTracks: manual keyframes per property, paint color or effect field. Each track replaces any existing track for that target.
Easing can be a literal curve or an EASING variable (easing.variableId); a preset's duration can be bound to a TIMING variable (durationVariableId). Main components can't be animated through the Plugin API: use an instance or frame. Motion plays in Figma's preview and video export, not in static screenshots.`,
		{
			nodeId: z.string().describe("Node to animate (an instance or frame, not a main component)"),
			preset: z.string().optional().describe("Figma animation style id, e.g. 'Opacity', 'Scale', 'Position'"),
			customStyleId: z.string().optional().describe("Local custom animation style id"),
			keyframeTracks: z.array(keyframeTrackSchema).optional().describe("Manual keyframe tracks"),
			duration: z.number().min(0).optional().describe("Preset duration in seconds"),
			durationVariableId: z.string().optional().describe("Bind the preset's duration to a TIMING variable"),
			timelineOffset: z.number().min(0).optional().describe("Start offset on the timeline in seconds"),
			easing: easingSchema.optional(),
			props: propsSchema,
			fileKey: fileKeySchema,
		},
		async (args) => {
			try {
				const modes = [args.preset, args.customStyleId, args.keyframeTracks?.length ? "k" : undefined].filter(Boolean);
				if (modes.length !== 1) throw new Error("Pass exactly one of preset, customStyleId or keyframeTracks");
				const { fileKey, ...payload } = args;
				return ok(await run(getDesktopConnector, motionScript(payload, APPLY_ANIMATION_BODY), 30000, fileKey));
			} catch (error) {
				return fail("figma_apply_animation", error);
			}
		},
	);

	server.tool(
		"figma_remove_animation",
		"Remove animations from a node: one applied animation style (appliedId, from figma_get_animations), one manual keyframe track, or everything (all: true). Returns what's left.",
		{
			nodeId: z.string().describe("Animated node"),
			appliedId: z.string().optional().describe("Applied animation style id (figma_get_animations → animationStyles[].appliedId)"),
			keyframeTrack: keyframeTargetSchema.optional(),
			all: z.boolean().optional().default(false).describe("Remove every animation style and keyframe track"),
			fileKey: fileKeySchema,
		},
		async ({ fileKey, ...payload }) => {
			try {
				if (!payload.all && !payload.appliedId && !payload.keyframeTrack) {
					throw new Error("Pass appliedId, keyframeTrack, or all: true");
				}
				return ok(await run(getDesktopConnector, motionScript(payload, REMOVE_ANIMATION_BODY), 30000, fileKey));
			} catch (error) {
				return fail("figma_remove_animation", error);
			}
		},
	);

	const entrySchema = z.object({
		preset: z.string().describe("Figma animation style id, e.g. 'Opacity'"),
		duration: z.number().min(0).optional(),
		durationVariableId: z.string().optional().describe("Bind duration to a TIMING variable"),
		timelineOffset: z.number().min(0).optional(),
		easing: easingSchema.optional(),
		props: propsSchema,
	});

	server.tool(
		"figma_manage_animation_styles",
		`Manage reusable Motion animation styles, the motion layer of a design system.
- list_presets: Figma's built-in animation styles with each one's props and defaults.
- list: local custom animation styles and their entries.
- create: a custom style (name, description) from entries, each a preset with duration, offset, easing and props. Durations and easings can bind to TIMING/EASING variables.
- update: rename, change the description, or append entries.
- remove_entry: drop one entry (entryId from list).
- delete: remove the style.
Apply a custom style with figma_apply_animation customStyleId.`,
		{
			action: z.enum(["list_presets", "list", "create", "update", "remove_entry", "delete"]),
			styleId: z.string().optional().describe("Custom animation style id (update, remove_entry, delete)"),
			name: z.string().optional().describe("Style name; use '/' for folders, e.g. 'Motion/Enter'"),
			description: z.string().optional(),
			entries: z.array(entrySchema).optional().describe("Entries to add (create, update)"),
			entryId: z.string().optional().describe("Entry id to remove (remove_entry)"),
			fileKey: fileKeySchema,
		},
		async ({ fileKey, ...payload }) => {
			try {
				return ok(await run(getDesktopConnector, motionScript(payload, MANAGE_STYLES_BODY), 30000, fileKey));
			} catch (error) {
				return fail("figma_manage_animation_styles", error);
			}
		},
	);

	server.tool(
		"figma_export_animation",
		`Export an animated frame as MP4, GIF or WebM. The node should be the frame that holds the Motion timeline (its top-level frame).${
			options.allowFileWrite
				? " The file is written to outputPath (default: the OS temp folder) and the path is returned. An existing file is never replaced unless overwrite is true."
				: ` Cloud Mode returns the video as base64 (up to ${MAX_INLINE_EXPORT_BYTES / 1024 / 1024} MB); use a lower fps, quality or scale for long animations.`
		}`,
		{
			nodeId: z.string().optional().describe("Frame to export. Defaults to the current selection"),
			format: z.enum(["MP4", "GIF", "WEBM"]),
			fps: z.number().int().optional().describe("MP4/WebM: 12, 24, 30 or 60. GIF: 8, 12, 15, 24 or 30"),
			quality: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().describe("MP4/WebM quality"),
			loopCount: z.number().int().min(0).optional().describe("GIF loops (0 = forever)"),
			scale: z.number().optional().describe("0.5, 0.75, 1, 1.5, 2, 3 or 4. Use scale, width or height, not several"),
			width: z.number().positive().optional().describe("Output width in px"),
			height: z.number().positive().optional().describe("Output height in px"),
			...(options.allowFileWrite
				? {
						outputPath: z.string().optional().describe("Where to write the file. Default: OS temp folder"),
						overwrite: z.boolean().optional().default(false).describe("Replace a file that already exists at outputPath"),
					}
				: {}),
			fileKey: fileKeySchema,
		},
		async (args: Record<string, any>) => {
			try {
				const settingsError = validateVideoSettings(args as { format: string; fps?: number; scale?: number });
				if (settingsError) throw new Error(settingsError);
				const { fileKey, outputPath, overwrite, ...payload } = args;
				const explicitTarget = options.allowFileWrite && outputPath ? (isAbsolute(outputPath) ? outputPath : resolve(outputPath)) : undefined;
				// Checked before the export so a long render isn't wasted.
				if (explicitTarget && !overwrite && existsSync(explicitTarget)) {
					throw new Error(`Nothing was written. "${explicitTarget}" already exists. Pass overwrite: true to replace it, or choose another outputPath.`);
				}
				const result = await run(getDesktopConnector, motionScript(payload, EXPORT_ANIMATION_BODY), 180000, fileKey);
				const ext = String(args.format).toLowerCase();
				const meta = { nodeId: result.nodeId, name: result.name, format: result.format, bytes: result.bytes, mimeType: MIME[args.format] };
				if (options.allowFileWrite) {
					const safeName = String(result.name || "animation").replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60);
					const target = explicitTarget
						?? join(tmpdir(), `figma-${safeName}-${Date.now()}.${ext}`);
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(target, Buffer.from(result.base64, "base64"));
					return ok({ ...meta, path: target });
				}
				if (result.bytes > MAX_INLINE_EXPORT_BYTES) {
					throw new Error(
						`The ${args.format} is ${(result.bytes / 1024 / 1024).toFixed(1)} MB, above the ${MAX_INLINE_EXPORT_BYTES / 1024 / 1024} MB that can be returned inline. Lower fps, quality or scale.`,
					);
				}
				return ok({ ...meta, base64: result.base64 });
			} catch (error) {
				return fail("figma_export_animation", error);
			}
		},
	);
}
