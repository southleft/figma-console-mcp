/**
 * Code layer discovery (Figma code layers, open beta Oct 2026).
 *
 * Code layers are React components rendered on the canvas. The Plugin API
 * exposes them as `CODE_INSTANCE` nodes with layout, export, dev resources
 * and related links, but not their source or props, and neither the Plugin
 * API nor REST can create one. Creating and editing code layers goes
 * through Figma (UI, GitHub import, or Figma's own MCP `send_code_to_figma`).
 * This tool finds them so agents can screenshot, position, or document them.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "code-layer-tools" });

export const GET_CODE_LAYERS_SCRIPT = (scope: "page" | "file", limit: number) => `
const limit = ${JSON.stringify(limit)};
const pages = ${JSON.stringify(scope)} === 'file' ? figma.root.children : [figma.currentPage];
const layers = [];
let truncated = false;
for (const page of pages) {
  if (page !== figma.currentPage) await page.loadAsync();
  for (const n of page.findAll(x => x.type === 'CODE_INSTANCE')) {
    if (layers.length >= limit) { truncated = true; break; }
    const item = { id: n.id, name: n.name, page: page.name, pageId: page.id, x: n.x, y: n.y, width: n.width, height: n.height, visible: n.visible, locked: n.locked, parent: n.parent ? { id: n.parent.id, type: n.parent.type } : null };
    try { item.devResources = (await n.getDevResourcesAsync()).map(r => ({ name: r.name, url: r.url })); } catch (e) {}
    try { item.relatedLinks = (await n.getRelatedLinksAsync()).map(r => ({ name: r.name, url: r.url })); } catch (e) {}
    layers.push(item);
  }
  if (truncated) break;
}
return { scope: ${JSON.stringify(scope)}, count: layers.length, truncated, codeLayers: layers };
`;

export function registerCodeLayerTools(server: McpServer, getDesktopConnector: () => Promise<any>): void {
	server.tool(
		"figma_get_code_layers",
		"Find code layers (Figma's React code layers, node type CODE_INSTANCE) on the current page or across the file, with position, size, page, and any dev resources or related links (e.g. the GitHub source). The Plugin API and REST API expose code layers as rendered layers only: their source and props can't be read or edited, and new code layers can't be created through them. Create or edit code layers in Figma, through a GitHub import, or with Figma's own MCP server (send_code_to_figma). Use figma_capture_screenshot with a code layer's id to see it. Requires Desktop Bridge.",
		{
			scope: z.enum(["page", "file"]).optional().default("page").describe("Search the current page (default) or every page"),
			limit: z.number().int().min(1).max(500).optional().default(100),
			fileKey: z
				.string()
				.optional()
				.describe("Local Mode only. Run against this connected file instead of the active file. Rejected in Cloud Mode."),
		},
		async ({ scope, limit, fileKey }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.executeCodeViaUI(GET_CODE_LAYERS_SCRIPT(scope, limit), scope === "file" ? 120000 : 30000, fileKey);
				if (!result?.success) throw new Error(result?.error || "Failed to list code layers");
				return { content: [{ type: "text" as const, text: JSON.stringify(result.result) }] };
			} catch (error) {
				logger.error({ error }, "figma_get_code_layers failed");
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
					isError: true,
				};
			}
		},
	);
}
