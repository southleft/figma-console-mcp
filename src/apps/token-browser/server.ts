/**
 * Token Browser MCP App - Server Registration
 *
 * Registers tools and resource for the Token Browser MCP App.
 * Uses the official @modelcontextprotocol/ext-apps helpers for proper
 * MCP Apps protocol compatibility with Claude Desktop.
 *
 * Data flow:
 *   1. LLM calls figma_browse_tokens → server fetches + caches data,
 *      returns SHORT summary to LLM (avoids context exhaustion)
 *   2. UI opens, connects, calls token_browser_refresh (app-only visibility)
 *   3. token_browser_refresh returns full JSON → UI renders
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
	registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const TOKEN_BROWSER_URI = "ui://figma-console/token-browser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Register the Token Browser MCP App with the server.
 *
 * @param server - The MCP server instance
 * @param getVariablesHandler - Function to fetch variables data
 */
export function registerTokenBrowserApp(
	server: McpServer,
	getVariablesHandler: (fileUrl?: string) => Promise<{
		variables: any[];
		collections: any[];
		[key: string]: any;
	}>,
): void {
	// Shared state: remember last URL so refresh tool can reuse it
	let lastFileUrl: string | undefined;

	// Tool: fetches + caches data, returns SHORT summary to LLM
	registerAppTool(
		server,
		"figma_browse_tokens",
		{
			title: "Browse Design Tokens",
			description:
				"Open an interactive browser to explore design tokens (variables) from a Figma file. Shows tokens organized by collection with search, filtering, and mode switching. Data is displayed in the UI — do not attempt to list or describe the tokens in chat.",
			inputSchema: {
				fileUrl: z
					.string()
					.url()
					.optional()
					.describe(
						"Figma file URL. If not provided, uses the currently active file.",
					),
			},
			_meta: {
				ui: { resourceUri: TOKEN_BROWSER_URI },
			},
		},
		async ({ fileUrl }) => {
			try {
				lastFileUrl = fileUrl;
				const result = await getVariablesHandler(fileUrl);

				const varCount = result.variables?.length || 0;
				const colCount = result.collections?.length || 0;

				// Count by type
				const colors =
					result.variables?.filter((v: any) => v.resolvedType === "COLOR")
						.length || 0;
				const numbers =
					result.variables?.filter((v: any) => v.resolvedType === "FLOAT")
						.length || 0;

				return {
					content: [
						{
							type: "text" as const,
							text: `Token Browser opened: ${varCount} tokens across ${colCount} collections (${colors} colors, ${numbers} numbers). The interactive UI is now displaying the results — users can search, filter by type, and browse by collection.`,
						},
					],
				};
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text" as const,
							text: `Token Browser error: ${errorMessage}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	// Tool: returns full JSON data (app-only, hidden from LLM)
	registerAppTool(
		server,
		"token_browser_refresh",
		{
			title: "Token Browser Refresh",
			description: "Refresh token data (called from MCP App UI)",
			inputSchema: {
				fileUrl: z
					.string()
					.url()
					.optional()
					.describe("Figma file URL to refresh data for."),
			},
			_meta: {
				ui: {
					resourceUri: TOKEN_BROWSER_URI,
					visibility: ["app"],
				},
			},
		},
		async ({ fileUrl }) => {
			try {
				const url = fileUrl || lastFileUrl;
				const result = await getVariablesHandler(url);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: errorMessage,
								variables: [],
								collections: [],
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// Resource: serves the Vite-built HTML
	registerAppResource(
		server,
		"Token Browser App",
		TOKEN_BROWSER_URI,
		{
			description:
				"Interactive browser for exploring Figma design tokens and variables",
		},
		async () => {
			const htmlPath = resolve(__dirname, "mcp-app.html");
			const html = await readFile(htmlPath, "utf-8");
			return {
				contents: [
					{
						uri: TOKEN_BROWSER_URI,
						mimeType: RESOURCE_MIME_TYPE,
						text: html,
					},
				],
			};
		},
	);
}
