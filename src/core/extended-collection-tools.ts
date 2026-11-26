/**
 * figma_extend_library_collection — create an extended collection: a local
 * extension of a library's variable collection (e.g. a brand or product theme)
 * that inherits every variable and can override values per mode.
 * Plugin API: figma.variables.extendLibraryCollectionByKeyAsync(key, name).
 * Without collectionKey it lists the library collections available to extend.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "extended-collection-tools" });

export function buildExtendCode(collectionKey: string | undefined, name: string | undefined): string {
	return `const KEY = ${JSON.stringify(collectionKey ?? null)}, NAME = ${JSON.stringify(name ?? null)};
if (typeof figma.variables.extendLibraryCollectionByKeyAsync !== "function") return { error: "This Figma version doesn't support extended collections." };
// Library lookups can stall while the file's window isn't focused: bound them.
const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
let available;
try { available = await within(figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync(), 15000); }
catch (e) { return { error: String(e).includes("timeout") ? "Figma didn't answer the library lookup. Focus this file's window in Figma Desktop and retry." : String(e) }; }
if (!KEY) return { available: available.map(c => ({ key: c.key, name: c.name, library: c.libraryName })) };
const src = available.find(c => c.key === KEY);
if (!src) return { error: "No library collection with that key is enabled in this file.", available: available.map(c => ({ key: c.key, name: c.name, library: c.libraryName })) };
let ext;
try { ext = await within(figma.variables.extendLibraryCollectionByKeyAsync(KEY, NAME || (src.name + " (extended)")), 30000); }
catch (e) { return { error: String(e).includes("timeout") ? "Figma didn't finish creating the extension in time. Check the file before retrying so you don't create a duplicate." : String(e) }; }
return { created: { id: ext.id, name: ext.name, extends: { key: KEY, name: src.name, library: src.libraryName }, modes: (ext.modes || []).map(m => ({ modeId: m.modeId, name: m.name })) } };`;
}

export function registerExtendedCollectionTools(server: McpServer, getDesktopConnector: () => Promise<any>): void {
	server.registerTool(
		"figma_extend_library_collection",
		{
			description:
				"Create an extended collection: a local extension of a library's variable collection (a brand or product theme) that inherits its variables and overrides values per mode. Without collectionKey, lists the library collections enabled in this file that can be extended. Set override values afterwards with figma_update_variable on the extended collection's modes.",
			inputSchema: z.object({
				collectionKey: z.string().optional().describe("Library collection key (omit to list the available ones)."),
				name: z.string().optional().describe("Name for the extended collection."),
				fileKey: z.string().optional().describe("Local Mode: run in this open file without changing the active file."),
			}),
		},
		async ({ collectionKey, name, fileKey }) => {
			const fail = (error: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error, ...extra }) }], isError: true });
			try {
				const connector = await getDesktopConnector();
				const res = await connector.executeCodeViaUI(buildExtendCode(collectionKey, name), 60000, fileKey);
				const raw = res && typeof res === "object" && "result" in res ? res.result : res;
				if (!raw) return fail(res?.error ?? "The plugin didn't return a result.");
				if (raw.error) return fail(raw.error, raw.available ? { available: raw.available } : {});
				if (raw.available && raw.available.length === 0) {
					return fail("No library variable collections are enabled in this file.", { fix: "Enable the library in Figma (Assets → Libraries) and try again." });
				}
				return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...raw }) }] };
			} catch (err) {
				logger.error({ err }, "figma_extend_library_collection failed");
				return fail(err instanceof Error ? err.message : String(err));
			}
		},
	);
}
