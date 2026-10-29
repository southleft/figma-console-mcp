/**
 * Figma Shader tools (Plugin API, beta: Update 130+).
 *
 * Shaders are created in Figma (UI, or Figma's own MCP). The Plugin API can
 * apply them by id and set their properties. Applied shaders carry
 * `propertyMetadata` (author-defined names and types per property key), so
 * these tools let callers set properties by name ("turbulence") instead of
 * the opaque uniform keys ("3561834497:1861196824").
 *
 * Both tools build a Plugin API script and run it through executeCodeViaUI,
 * so no Desktop Bridge plugin change (or re-import) is needed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "shader-tools" });

const fileKeySchema = z
	.string()
	.optional()
	.describe(
		"Local Mode only. Run against this specific connected file instead of the active file. Get connected fileKeys from figma_list_open_files. Rejected in Cloud Mode, which pairs with a single plugin instance.",
	);

export const SHADER_TARGETS = ["fills", "strokes", "effects"] as const;

export const LIST_SHADERS_BODY = `
const results = new Map();
const limitUses = 20;
const describe = (meta) => Object.entries(meta || {}).map(([key, d]) => ({ key, name: d.name, type: d.type, defaultValue: d.defaultValue, description: d.description }));
const scan = (node, page) => {
  for (const target of ['fills', 'strokes', 'effects']) {
    const arr = node[target];
    if (!Array.isArray(arr)) continue;
    arr.forEach((p, index) => {
      if (!p || p.type !== 'SHADER') return;
      let entry = results.get(p.id);
      if (!entry) {
        entry = { id: p.id, kind: target === 'effects' ? 'effect' : 'fill', usageCount: 0, usedIn: [], properties: describe(p.propertyMetadata) };
        results.set(p.id, entry);
      }
      entry.usageCount++;
      if (entry.usedIn.length < limitUses) entry.usedIn.push({ nodeId: node.id, name: node.name, page: page.name, target, index });
    });
  }
};
let pages;
if (P.nodeId) {
  const root = await figma.getNodeByIdAsync(P.nodeId);
  if (!root) throw new Error('Node not found: ' + P.nodeId);
  let page = root; while (page && page.type !== 'PAGE') page = page.parent;
  scan(root, page || figma.currentPage);
  if ('findAll' in root) for (const n of root.findAll(() => true)) scan(n, page || figma.currentPage);
} else {
  pages = P.scope === 'file' ? figma.root.children : [figma.currentPage];
  for (const page of pages) {
    if (page !== figma.currentPage) await page.loadAsync();
    for (const n of page.findAll(() => true)) scan(n, page);
  }
}
let available = [];
let availableNote;
try {
  const list = await Promise.race([figma.listAvailableShaders(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))]);
  available = list.map(s => ({ id: s.id, name: s.name, kind: s.type, imported: s.imported, inFile: results.has(s.id), properties: describe(s.propertyDefinitions) }));
} catch (e) {
  availableNote = e && e.message === 'timeout'
    ? "Figma didn't return the library shader list in time. This happens when the file's window isn't the focused one."
    : 'Could not list library shaders: ' + (e && e.message ? e.message : e);
}
const out = { scope: P.nodeId ? 'node' : P.scope, inFile: Array.from(results.values()), available };
if (availableNote) out.availableNote = availableNote;
if (out.inFile.length > 0) out.note = 'Figma drops a shader from the file when nothing uses it and the file reloads. Keep at least one layer using each shader you want to reuse.';
return out;
`;

export const APPLY_SHADER_BODY = `
const node = await figma.getNodeByIdAsync(P.nodeId);
if (!node) throw new Error('Node not found: ' + P.nodeId);
const target = P.target;
if (!(target in node) || !Array.isArray(node[target])) throw new Error(node.type + ' nodes have no ' + target);
const original = node[target].map(p => JSON.parse(JSON.stringify(p)));
const clone = (v) => JSON.parse(JSON.stringify(v));

let index;
let paint;
if (P.index !== undefined) {
  const existing = original[P.index];
  if (!existing || existing.type !== 'SHADER') throw new Error(target + '[' + P.index + '] is not a shader. Omit index to add a new shader.');
  index = P.index;
  paint = clone(existing);
  if (P.shaderId && P.shaderId !== existing.id) { paint = { type: 'SHADER', id: P.shaderId }; }
} else {
  if (!P.shaderId) throw new Error('Pass shaderId to add a shader, or index to change one already applied.');
  paint = { type: 'SHADER', id: P.shaderId };
  index = P.replace ? 0 : original.length;
}
if (target === 'effects') paint.visible = P.visible !== undefined ? P.visible : (paint.visible !== undefined ? paint.visible : true);
else if (P.visible !== undefined) paint.visible = P.visible;
if (target !== 'effects') {
  if (P.opacity !== undefined) paint.opacity = P.opacity;
  if (P.blendMode !== undefined) paint.blendMode = P.blendMode;
}

const strip = (p) => { const c = clone(p); delete c.propertyMetadata; return c; };
const place = (p) => {
  const next = P.replace && P.index === undefined ? [] : original.map(strip);
  next[index] = strip(p);
  return next;
};
const write = async (p) => {
  try { node[target] = place(p); }
  catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (/not imported/i.test(msg)) {
      await figma.importShaderById(p.id);
      node[target] = place(p);
      return;
    }
    if (/Invalid shader id|Expected an id/i.test(msg)) {
      throw new Error(msg + (target === 'effects'
        ? ' Effect shaders and fill shaders are separate kinds: a fill shader goes on fills or strokes.'
        : ' Use an id from figma_list_shaders. A shader nothing in the file uses is dropped when the file reloads.'));
    }
    throw e;
  }
};

// Apply first (properties keep their current or default values) so Figma
// returns propertyMetadata, then map names to keys and write the changes.
await write(paint);
const applied = node[target][index];
const meta = applied.propertyMetadata || {};
const props = clone(applied.properties || {});
const byName = {};
for (const [key, d] of Object.entries(meta)) byName[d.name] = key;
const requested = P.properties || {};
const unknown = [];
for (const [name, raw] of Object.entries(requested)) {
  const key = meta[name] ? name : byName[name];
  if (!key) { unknown.push(name); continue; }
  const type = meta[key].type;
  let value = raw;
  if (value && typeof value === 'object' && value.variableId) value = { type: 'VARIABLE_ALIAS', id: value.variableId };
  else if (type === 'COLOR' && typeof value === 'string') value = figma.util.rgba(value);
  else if (type === 'COLOR' && value && typeof value === 'object' && value.a === undefined && 'r' in value) value = { r: value.r, g: value.g, b: value.b, a: 1 };
  props[key] = value;
}
if (unknown.length) {
  node[target] = original.map(strip);
  throw new Error('Unknown shader propert' + (unknown.length > 1 ? 'ies' : 'y') + ': ' + unknown.join(', ') + '. This shader has: ' + Object.values(meta).map(d => d.name + ' (' + d.type + ')').join(', ') + '. Nothing was changed.');
}
if (Object.keys(requested).length) {
  try { await write(Object.assign(strip(applied), { properties: props })); }
  catch (e) { node[target] = original.map(strip); throw new Error('Figma rejected the property values: ' + (e && e.message ? e.message : e) + ' Nothing was changed.'); }
}
const final = node[target][index];
const named = {};
for (const [key, v] of Object.entries(final.properties || {})) named[meta[key] ? meta[key].name : key] = v;
return {
  nodeId: node.id, name: node.name, target, index, shaderId: final.id,
  properties: named,
  definitions: Object.entries(meta).map(([key, d]) => ({ key, name: d.name, type: d.type, defaultValue: d.defaultValue })),
};
`;

export function shaderScript(payload: unknown, body: string): string {
	return `const P = ${JSON.stringify(payload)};\n${body}`;
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
	if (!result?.success) throw new Error(result?.error || "Shader script failed");
	return result.result;
}

const colorObject = { r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() };

const shaderValueSchema = z.union([
	z.number(),
	z.boolean(),
	z.string(),
	z
		.object({
			variableId: z.string().optional().describe("Bind the property to a variable instead of a literal"),
			x: z.number().optional(),
			y: z.number().optional(),
			x2: z.number().optional(),
			y2: z.number().optional(),
			radius: z.number().optional(),
			angle: z.number().optional(),
			r: z.number().optional(),
			g: z.number().optional(),
			b: z.number().optional(),
			a: z.number().optional(),
			color: z.object(colorObject).optional(),
			stops: z.array(z.object({ position: z.number(), color: z.object(colorObject) })).optional(),
		})
		.describe("Points {x,y}, lines {x,y,x2,y2}, circles {x,y,radius,angle?}, colors {r,g,b,a} (0–1), color points {x,y,color}, gradients {stops}, or {variableId}"),
]);

export function registerShaderTools(server: McpServer, getDesktopConnector: () => Promise<any>): void {
	server.tool(
		"figma_list_shaders",
		"List shaders: the ones applied in this file (fills, strokes and effects), with each property's name, type and default, and the layers using them; plus shaders from the user's libraries (figma.listAvailableShaders). Use the property names with figma_apply_shader. Shaders are created in Figma, not through the Plugin API. Requires Desktop Bridge.",
		{
			scope: z.enum(["page", "file"]).optional().default("page").describe("Search the current page (default) or every page"),
			nodeId: z.string().optional().describe("Only search this node and its descendants"),
			fileKey: fileKeySchema,
		},
		async ({ scope, nodeId, fileKey }) => {
			try {
				return ok(await run(getDesktopConnector, shaderScript({ scope, nodeId }, LIST_SHADERS_BODY), scope === "file" && !nodeId ? 120000 : 30000, fileKey));
			} catch (error) {
				return fail("figma_list_shaders", error);
			}
		},
	);

	server.tool(
		"figma_apply_shader",
		"Apply a shader to a node's fills, strokes or effects, or change the properties of one already applied. Set properties by name (e.g. {turbulence: 40, cloudColor: '#E8F4FF'}); names, types and defaults come from figma_list_shaders. Colors take hex strings or {r,g,b,a}, and any property can bind a variable with {variableId}. Pass index to change a shader already in that list; without index the shader is added on top (or replaces the list with replace: true). Fill shaders go on fills or strokes; effect shaders go on effects. Unknown property names change nothing and list the valid ones. Requires Desktop Bridge.",
		{
			nodeId: z.string(),
			shaderId: z.string().optional().describe("Shader id from figma_list_shaders. Optional when index points at a shader already applied"),
			target: z.enum(SHADER_TARGETS).optional().default("fills"),
			index: z.number().int().min(0).optional().describe("Change the shader at this position in the target list instead of adding one"),
			replace: z.boolean().optional().default(false).describe("Replace everything in the target list with this shader"),
			properties: z.record(z.string(), shaderValueSchema).optional().describe("Property values by name (or key)"),
			opacity: z.number().min(0).max(1).optional().describe("Fills and strokes only"),
			blendMode: z
				.enum(["NORMAL", "DARKEN", "MULTIPLY", "COLOR_BURN", "LIGHTEN", "SCREEN", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"])
				.optional()
				.describe("Fills and strokes only"),
			visible: z.boolean().optional(),
			fileKey: fileKeySchema,
		},
		async ({ fileKey, ...payload }) => {
			try {
				return ok(await run(getDesktopConnector, shaderScript(payload, APPLY_SHADER_BODY), 30000, fileKey));
			} catch (error) {
				return fail("figma_apply_shader", error);
			}
		},
	);
}
