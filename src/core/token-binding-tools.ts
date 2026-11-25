/**
 * figma_bind_tokens — bind a node's layout/shape/type properties to EXISTING
 * variables and styles, by name or id. The structured way to satisfy
 * figma_audit_adherence's token checks without raw figma_execute.
 *
 * It never creates a variable or style: an unknown name is an error that lists
 * the closest real names, so a missing token is reported, not invented.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "token-binding-tools" });

/** Node fields Figma lets you bind to FLOAT variables (setBoundVariable). */
export const BINDABLE_FIELDS = [
	"paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing", "counterAxisSpacing",
	"topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
	"strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight",
	"width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "opacity",
	// text nodes
	"fontSize", "fontFamily", "fontStyle", "fontWeight", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent",
] as const;

/** Shorthands that expand to several fields. */
export const SHORTHANDS: Record<string, string[]> = {
	padding: ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"],
	paddingX: ["paddingLeft", "paddingRight"],
	paddingY: ["paddingTop", "paddingBottom"],
	gap: ["itemSpacing"],
	cornerRadius: ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"],
	radius: ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"],
};

export function expandBindings(bindings: Record<string, string>): { fields: Record<string, string>; unknown: string[] } {
	const fields: Record<string, string> = {};
	const unknown: string[] = [];
	for (const [k, v] of Object.entries(bindings)) {
		if (SHORTHANDS[k]) for (const f of SHORTHANDS[k]) fields[f] = v;
		else if ((BINDABLE_FIELDS as readonly string[]).includes(k)) fields[k] = v;
		else unknown.push(k);
	}
	return { fields, unknown };
}

function buildCode(args: { nodeId: string; fields: Record<string, string>; textStyle?: string; effectStyle?: string }) {
	return `
const node = await figma.getNodeByIdAsync(${JSON.stringify(args.nodeId)});
if (!node) return { error: "Node ${args.nodeId} not found in this file." };
const FIELDS = ${JSON.stringify(args.fields)};
const vars = await figma.variables.getLocalVariablesAsync();
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const collName = {}; for (const c of collections) collName[c.id] = c.name;
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
function findVar(ref) {
  const byId = vars.find(v => v.id === ref);
  if (byId) return { v: byId };
  let hits = vars.filter(v => v.name === ref || (collName[v.variableCollectionId] + "/" + v.name) === ref);
  if (hits.length === 0) hits = vars.filter(v => norm(v.name) === norm(ref));
  if (hits.length === 1) return { v: hits[0] };
  if (hits.length > 1) return { error: "ambiguous", options: hits.slice(0, 5).map(v => collName[v.variableCollectionId] + "/" + v.name) };
  const words = String(ref).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const close = vars
    .map(v => ({ v, s: words.filter(w => v.name.toLowerCase().includes(w)).length }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 5)
    .map(x => collName[x.v.variableCollectionId] + "/" + x.v.name);
  return { error: "not-found", options: close };
}
const results = [];
for (const [field, ref] of Object.entries(FIELDS)) {
  if (!(field in node)) { results.push({ field, ok: false, error: "This " + node.type + " has no " + field + "." }); continue; }
  const f = findVar(ref);
  if (!f.v) { results.push({ field, ok: false, token: ref, error: f.error === "ambiguous" ? "Several variables match — use the collection/name or id." : "No variable with this name exists.", options: f.options }); continue; }
  const v = f.v;
  const isText = node.type === "TEXT";
  const wantsString = field === "fontFamily" || field === "fontStyle";
  if (wantsString ? v.resolvedType !== "STRING" : v.resolvedType !== "FLOAT") {
    results.push({ field, ok: false, token: v.name, error: v.name + " is a " + v.resolvedType + " variable; " + field + " needs " + (wantsString ? "STRING" : "FLOAT") + "." });
    continue;
  }
  try {
    if (isText && ["fontSize","fontFamily","fontStyle","fontWeight","lineHeight","letterSpacing","paragraphSpacing","paragraphIndent"].includes(field)) {
      const fonts = node.getRangeAllFontNames(0, node.characters.length);
      for (const fn of fonts) await figma.loadFontAsync(fn);
      node.setRangeBoundVariable(0, node.characters.length, field, v);
    } else {
      node.setBoundVariable(field, v);
    }
    results.push({ field, ok: true, token: collName[v.variableCollectionId] + "/" + v.name });
  } catch (e) { results.push({ field, ok: false, token: v.name, error: String(e && e.message || e) }); }
}
async function findStyle(kind, ref) {
  const list = kind === "text" ? await figma.getLocalTextStylesAsync() : await figma.getLocalEffectStylesAsync();
  return list.find(s => s.id === ref || s.name === ref || s.key === ref) || list.find(s => norm(s.name) === norm(ref)) || null;
}
const TEXT_STYLE = ${JSON.stringify(args.textStyle ?? null)};
if (TEXT_STYLE) {
  if (node.type !== "TEXT") results.push({ field: "textStyle", ok: false, error: "Only text nodes take a text style." });
  else {
    const s = await findStyle("text", TEXT_STYLE);
    if (!s) results.push({ field: "textStyle", ok: false, token: TEXT_STYLE, error: "No local text style with this name or id.", options: (await figma.getLocalTextStylesAsync()).filter(x => String(TEXT_STYLE).toLowerCase().split(/[^a-z0-9]+/).some(w => w && x.name.toLowerCase().includes(w))).slice(0, 5).map(x => x.name) });
    else { await figma.loadFontAsync(s.fontName); await node.setTextStyleIdAsync(s.id); results.push({ field: "textStyle", ok: true, token: s.name }); }
  }
}
const EFFECT_STYLE = ${JSON.stringify(args.effectStyle ?? null)};
if (EFFECT_STYLE) {
  const s = await findStyle("effect", EFFECT_STYLE);
  if (!s) results.push({ field: "effectStyle", ok: false, token: EFFECT_STYLE, error: "No local effect style with this name or id." });
  else if (!("setEffectStyleIdAsync" in node)) results.push({ field: "effectStyle", ok: false, error: "This node can't take an effect style." });
  else { await node.setEffectStyleIdAsync(s.id); results.push({ field: "effectStyle", ok: true, token: s.name }); }
}
return { node: { id: node.id, name: node.name, type: node.type }, results };`;
}

export function registerTokenBindingTools(server: McpServer, getDesktopConnector: () => Promise<any>): void {
	server.registerTool(
		"figma_bind_tokens",
		{
			description:
				"Bind a node's spacing, radius, size, stroke, opacity and typography to EXISTING variables, and apply a text or effect style — by name or id. Use it so generated designs use the system's tokens instead of raw numbers (what figma_audit_adherence checks). bindings maps a field to a variable: padding / paddingX / paddingY / gap / cornerRadius (shorthands), or paddingLeft…, itemSpacing, counterAxisSpacing, topLeftRadius…, strokeWeight, width, height, min/max sizes, opacity, and on text fontSize, fontFamily, fontStyle, fontWeight, lineHeight, letterSpacing, paragraphSpacing. Variables match by id, exact name, \"Collection/name\", or name ignoring punctuation. Colors: use figma_set_fills / figma_set_strokes with a variable. It never creates tokens: an unknown or ambiguous name fails for that field and lists the closest real names — report a missing token to the user rather than substituting a raw value. Local variables and styles only (import library variables first with figma_import_library_variable). Requires the Desktop Bridge.",
			inputSchema: z.object({
				nodeId: z.string().describe("Node to bind."),
				bindings: z
					.record(z.string(), z.string())
					.optional()
					.describe('Field → variable name or id, e.g. { "padding": "spacing/md", "gap": "spacing/sm", "cornerRadius": "radius/lg" }.'),
				textStyle: z.string().optional().describe("Local text style name or id (text nodes)."),
				effectStyle: z.string().optional().describe("Local effect style name or id."),
				fileKey: z.string().optional().describe("Run against this connected file instead of the active one."),
			}),
		},
		async (args) => {
			try {
				const { fields, unknown } = expandBindings(args.bindings ?? {});
				if (unknown.length) {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ error: `Unknown field(s): ${unknown.join(", ")}. Nothing was changed.`, bindableFields: [...Object.keys(SHORTHANDS), ...BINDABLE_FIELDS] }) }],
						isError: true,
					};
				}
				if (Object.keys(fields).length === 0 && !args.textStyle && !args.effectStyle) {
					return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Nothing to bind: pass bindings, textStyle or effectStyle." }) }], isError: true };
				}
				const connector = await getDesktopConnector();
				const res = await connector.executeCodeViaUI(
					buildCode({ nodeId: args.nodeId, fields, textStyle: args.textStyle, effectStyle: args.effectStyle }),
					30000,
					args.fileKey,
				);
				const raw = res && typeof res === "object" && "result" in res ? res.result : res;
				if (!raw || raw.error) {
					return { content: [{ type: "text" as const, text: JSON.stringify({ error: raw?.error ?? res?.error ?? "Binding failed in the plugin." }) }], isError: true };
				}
				const failed = raw.results.filter((r: any) => !r.ok);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: failed.length === 0,
								node: raw.node,
								bound: raw.results.filter((r: any) => r.ok),
								...(failed.length
									? {
											failed,
											ai_instruction:
												"Some tokens weren't bound. Don't replace them with raw values or new variables: pick from `options` only if one is clearly the intended token, otherwise tell the user which token is missing.",
										}
									: {}),
							}),
						},
					],
					...(failed.length && failed.length === raw.results.length ? { isError: true } : {}),
				};
			} catch (err) {
				logger.error({ err }, "figma_bind_tokens failed");
				return { content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], isError: true };
			}
		},
	);
}
