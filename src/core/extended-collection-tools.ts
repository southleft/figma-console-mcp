/**
 * Extended collections (Enterprise): a collection that inherits every variable
 * of another collection (a brand or product theme) and overrides values per mode.
 *
 * - figma_extend_library_collection: create one from a library collection
 *   (figma.variables.extendLibraryCollectionByKeyAsync) or from one of the
 *   file's own collections (VariableCollection.extend). Without a target it
 *   lists both kinds.
 * - figma_reset_variable_override: put a variable in an extension back to the
 *   inherited value (ExtendedVariableCollection.removeOverridesForVariable).
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "extended-collection-tools" });

export function buildExtendCode(collectionKey: string | undefined, name: string | undefined, collectionId?: string): string {
	return `const KEY = ${JSON.stringify(collectionKey ?? null)}, NAME = ${JSON.stringify(name ?? null)}, LOCAL_ID = ${JSON.stringify(collectionId ?? null)};
// Library lookups can stall while the file's window isn't focused: bound them.
const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
const listLocal = async () => (await figma.variables.getLocalVariableCollectionsAsync()).map(c => ({ collectionId: c.id, name: c.name, ...(c.isExtension ? { isExtension: true } : {}) }));
if (LOCAL_ID) {
  const src = await figma.variables.getVariableCollectionByIdAsync(LOCAL_ID);
  if (!src || src.remote) return { error: "No local collection with that id in this file. To extend a library collection, pass its collectionKey instead.", local: await listLocal() };
  if (typeof src.extend !== "function") return { error: "Figma doesn't allow extending collections here: extended collections need an Enterprise plan and a current Figma version." };
  let ext;
  try { ext = src.extend(NAME || (src.name + " (extended)")); } catch (e) { return { error: String(e) }; }
  return { created: { id: ext.id, name: ext.name, extends: { collectionId: src.id, name: src.name }, modes: (ext.modes || []).map(m => ({ modeId: m.modeId, name: m.name })) } };
}
if (KEY && typeof figma.variables.extendLibraryCollectionByKeyAsync !== "function") return { error: "Figma doesn't allow extending collections here: extended collections need an Enterprise plan and a current Figma version." };
// Listing: the file's own collections don't depend on the library lookup.
const local = KEY ? null : await listLocal();
let available;
try { available = await within(figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync(), 15000); }
catch (e) {
  const msg = String(e).includes("timeout") ? "Figma didn't answer the library lookup. Focus this file's window in Figma Desktop and retry." : String(e);
  if (!KEY) return { available: [], local, warning: "Library collections couldn't be listed: " + msg };
  return { error: msg };
}
const libs = available.map(c => ({ key: c.key, name: c.name, library: c.libraryName }));
if (!KEY) return { available: libs, local };
const src = available.find(c => c.key === KEY);
if (!src) return { error: "No library collection with that key is enabled in this file.", available: libs };
let ext;
try { ext = await within(figma.variables.extendLibraryCollectionByKeyAsync(KEY, NAME || (src.name + " (extended)")), 30000); }
catch (e) { return { error: String(e).includes("timeout") ? "Figma didn't finish creating the extension in time. Check the file before retrying so you don't create a duplicate." : String(e) }; }
return { created: { id: ext.id, name: ext.name, extends: { key: KEY, name: src.name, library: src.libraryName }, modes: (ext.modes || []).map(m => ({ modeId: m.modeId, name: m.name })) } };`;
}

/**
 * Figma's API clears a variable's overrides in ALL of the extension's modes at
 * once, so resetting one mode clears them all and puts the others back.
 */
export function buildResetOverrideCode(collectionId: string, variableId: string, modeId: string | undefined): string {
	return `const CID = ${JSON.stringify(collectionId)}, VID = ${JSON.stringify(variableId)}, MODE = ${JSON.stringify(modeId ?? null)};
const ext = await figma.variables.getVariableCollectionByIdAsync(CID);
if (!ext) return { error: "No collection with that id in this file." };
if (!ext.isExtension) return { error: '"' + ext.name + '" isn\\'t an extended collection, so its values aren\\'t overrides. Change them with figma_update_variable.' };
const variable = await figma.variables.getVariableByIdAsync(VID);
if (!variable) return { error: "No variable with that id." };
if (Array.isArray(ext.variableIds) && !ext.variableIds.includes(VID)) return { error: '"' + variable.name + '" isn\\'t in "' + ext.name + '", so it has no override there.' };
const modeName = (id) => (ext.modes.find(m => m.modeId === id) || {}).name || id;
if (MODE && !ext.modes.some(m => m.modeId === MODE)) return { error: "That mode isn't one of this collection's modes.", modes: ext.modes.map(m => ({ modeId: m.modeId, name: m.name })) };
const current = Object.assign({}, (ext.variableOverrides || {})[VID] || {});
const toReset = MODE ? (MODE in current ? [MODE] : []) : Object.keys(current);
const names = (ids) => ids.map(modeName);
const remaining = () => Object.fromEntries(Object.entries((ext.variableOverrides || {})[VID] || {}).map(([m, v]) => [modeName(m), v]));
if (toReset.length === 0) return { unchanged: '"' + variable.name + '" is not overridden' + (MODE ? ' in ' + modeName(MODE) : '') + ' in "' + ext.name + '": it already inherits.', remainingOverrides: remaining() };
const original = Object.fromEntries(Object.entries(current).map(([m, v]) => [modeName(m), v]));
ext.removeOverridesForVariable(variable);
const keep = Object.entries(current).filter(([m]) => !toReset.includes(m));
try {
  for (const [m, v] of keep) variable.setValueForMode(m, v);
} catch (e) {
  // Put every original override back (including the one being reset), so a
  // failure never loses values the caller didn't ask to reset.
  const failed = [];
  for (const [m, v] of Object.entries(current)) { try { variable.setValueForMode(m, v); } catch (_) { failed.push(modeName(m)); } }
  return { error: "Resetting failed while restoring the other modes' overrides: " + String(e), rolledBack: failed.length === 0, ...(failed.length ? { notRestored: failed } : {}), originalOverrides: original };
}
return { reset: { variable: variable.name, collection: ext.name, modes: names(toReset) }, remainingOverrides: remaining() };`;
}

const unwrap = (res: any) => (res && typeof res === "object" && "result" in res ? res.result : res);

export function registerExtendedCollectionTools(server: McpServer, getDesktopConnector: () => Promise<any>): void {
	const fail = (error: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error, ...extra }) }], isError: true });

	server.registerTool(
		"figma_extend_library_collection",
		{
			description:
				"Create an extended collection (Enterprise): it inherits every variable of a library collection (collectionKey) or of one of this file's own collections (collectionId), and overrides values per mode, e.g. a brand or product theme. With neither, lists both kinds. Set override values afterwards with figma_update_variable on the extension's modes; undo one with figma_reset_variable_override.",
			inputSchema: z.object({
				collectionKey: z.string().optional().describe("Library collection key (from the listing)."),
				collectionId: z.string().optional().describe("Id of one of this file's own collections (from the listing)."),
				name: z.string().optional().describe("Name for the extended collection."),
				fileKey: z.string().optional().describe("Local Mode: run in this open file without changing the active file."),
			}),
		},
		async ({ collectionKey, collectionId, name, fileKey }) => {
			if (collectionKey && collectionId) return fail("Pass collectionKey (a library collection) or collectionId (a local one), not both.");
			try {
				const connector = await getDesktopConnector();
				const res = await connector.executeCodeViaUI(buildExtendCode(collectionKey, name, collectionId), 60000, fileKey);
				const raw = unwrap(res);
				if (!raw) return fail(res?.error ?? "The plugin didn't return a result.");
				if (raw.error) return fail(raw.error, { ...(raw.available ? { available: raw.available } : {}), ...(raw.local ? { local: raw.local } : {}) });
				if (raw.available && raw.available.length === 0 && (!raw.local || raw.local.length === 0)) {
					return fail("This file has no collections to extend: no library collections are enabled and it has none of its own.", { fix: "Enable a library in Figma (Assets → Libraries), or create a collection, and try again." });
				}
				return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...raw }) }] };
			} catch (err) {
				logger.error({ err }, "figma_extend_library_collection failed");
				return fail(err instanceof Error ? err.message : String(err));
			}
		},
	);

	server.registerTool(
		"figma_reset_variable_override",
		{
			description:
				"Put a variable in an extended collection back to the value it inherits, removing the extension's override. Without modeId, resets every mode; with modeId, only that mode. Get ids from figma_get_variables filtered by the extension (overriddenModeIds).",
			inputSchema: z.object({
				collectionId: z.string().describe("The extended collection's id."),
				variableId: z.string().describe("The variable's id."),
				modeId: z.string().optional().describe("One of the extension's mode ids (omit to reset every mode)."),
				fileKey: z.string().optional().describe("Local Mode: run in this open file without changing the active file."),
			}),
		},
		async ({ collectionId, variableId, modeId, fileKey }) => {
			try {
				const connector = await getDesktopConnector();
				const res = await connector.executeCodeViaUI(buildResetOverrideCode(collectionId, variableId, modeId), 30000, fileKey);
				const raw = unwrap(res);
				if (!raw) return fail(res?.error ?? "The plugin didn't return a result.");
				if (raw.error) {
					const { error, ...extra } = raw;
					return fail(error, extra);
				}
				return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...raw }) }] };
			} catch (err) {
				logger.error({ err }, "figma_reset_variable_override failed");
				return fail(err instanceof Error ? err.message : String(err));
			}
		},
	);
}
