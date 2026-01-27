/**
 * Hello World MCP App - Server Registration
 *
 * Minimal MCP App to test ext-apps protocol with Claude Desktop.
 * Zero Figma dependencies - completely isolated test.
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

const HELLO_WORLD_URI = "ui://figma-console/hello-world";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Register the Hello World MCP App with the server.
 */
export function registerHelloWorldApp(server: McpServer): void {
	// Tool: returns current server time (visible to model, triggers UI)
	registerAppTool(
		server,
		"hello_world",
		{
			title: "Hello World",
			description:
				"Minimal MCP App test - displays an interactive UI with server time",
			_meta: {
				ui: { resourceUri: HELLO_WORLD_URI },
			},
		},
		async () => {
			const now = new Date().toISOString();
			return {
				content: [{ type: "text" as const, text: now }],
			};
		},
	);

	// Tool: refresh endpoint callable from the UI
	registerAppTool(
		server,
		"hello_world_refresh",
		{
			title: "Hello World Refresh",
			description: "Returns current server time (called from MCP App UI)",
			_meta: {
				ui: {
					resourceUri: HELLO_WORLD_URI,
					visibility: ["app"],
				},
			},
		},
		async () => {
			const now = new Date().toISOString();
			return {
				content: [{ type: "text" as const, text: now }],
			};
		},
	);

	// Resource: serves the Vite-built HTML
	registerAppResource(
		server,
		"Hello World App",
		HELLO_WORLD_URI,
		{
			description: "Minimal MCP App test UI",
		},
		async () => {
			const htmlPath = resolve(__dirname, "mcp-app.html");
			const html = await readFile(htmlPath, "utf-8");
			return {
				contents: [
					{
						uri: HELLO_WORLD_URI,
						mimeType: RESOURCE_MIME_TYPE,
						text: html,
					},
				],
			};
		},
	);
}
