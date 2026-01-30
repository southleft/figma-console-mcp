/**
 * Design System Dashboard MCP App - Server Registration
 *
 * Registers tools and resource for the Design System Dashboard MCP App.
 * Uses the official @modelcontextprotocol/ext-apps helpers for proper
 * MCP Apps protocol compatibility with Claude Desktop.
 *
 * Data flow:
 *   1. LLM calls figma_audit_design_system → server fetches + scores data,
 *      returns SHORT summary to LLM (avoids context exhaustion)
 *   2. UI opens, connects, calls ds_dashboard_refresh (app-only visibility)
 *   3. ds_dashboard_refresh returns full JSON → UI renders
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
import { scoreDesignSystem } from "./scoring/engine.js";
import type { DashboardData, DesignSystemRawData } from "./scoring/types.js";

const DASHBOARD_URI = "ui://figma-console/design-system-dashboard";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Shared state
let lastFileUrl: string | undefined;

/**
 * Register the Design System Dashboard MCP App with the server.
 *
 * @param server - The MCP server instance
 * @param getDesignSystemData - Function to fetch raw design system data from Figma
 */
export function registerDesignSystemDashboardApp(
	server: McpServer,
	getDesignSystemData: (fileUrl?: string) => Promise<DesignSystemRawData>,
): void {
	// Tool: fetches + scores data, returns SHORT summary to LLM
	registerAppTool(
		server,
		"figma_audit_design_system",
		{
			title: "Audit Design System Health",
			description:
				"Analyze the health and AI-readiness of a Figma file's design system. Produces a scored dashboard evaluating naming conventions, token architecture, component metadata, accessibility, consistency, and coverage. Results are displayed in the dashboard UI.",
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
				ui: { resourceUri: DASHBOARD_URI },
			},
		},
		async ({ fileUrl }) => {
			try {
				lastFileUrl = fileUrl;
				const data = await getDesignSystemData(fileUrl);
				const scored = scoreDesignSystem(data);

				const categorySummaries = scored.categories
					.map((c) => `${c.label}: ${c.score}/100`)
					.join(", ");

				const fileName = scored.fileInfo?.name || "Unknown file";
				const unavailableNote =
					scored.dataAvailability && !scored.dataAvailability.variables
						? " Note: Variable/token data was unavailable (requires Enterprise plan or Desktop Bridge). Token Architecture scores reflect missing data, not actual quality."
						: "";

				return {
					content: [
						{
							type: "text" as const,
							text: `Design System: ${fileName}. Health: ${scored.overall}/100 — ${scored.status}. ${categorySummaries}.${unavailableNote} The dashboard UI is now showing detailed results.`,
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
							text: `Design System Dashboard error: ${errorMessage}`,
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
		"ds_dashboard_refresh",
		{
			title: "Dashboard Refresh",
			description: "Refresh dashboard data (called from MCP App UI)",
			inputSchema: {
				fileUrl: z
					.string()
					.url()
					.optional()
					.describe("Figma file URL to refresh data for."),
			},
			_meta: {
				ui: {
					resourceUri: DASHBOARD_URI,
					visibility: ["app"],
				},
			},
		},
		async ({ fileUrl }) => {
			try {
				const url = fileUrl || lastFileUrl;
				const data = await getDesignSystemData(url);
				const scored = scoreDesignSystem(data);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(scored),
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
							text: JSON.stringify({
								error: errorMessage,
								overall: 0,
								status: "poor",
								categories: [],
								summary: [],
								meta: {
									componentCount: 0,
									variableCount: 0,
									collectionCount: 0,
									styleCount: 0,
									componentSetCount: 0,
									standaloneCount: 0,
									variantCount: 0,
									timestamp: Date.now(),
								},
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
		"Design System Dashboard App",
		DASHBOARD_URI,
		{
			description:
				"Interactive dashboard for evaluating design system health and AI-readiness",
		},
		async () => {
			const htmlPath = resolve(__dirname, "mcp-app.html");
			const html = await readFile(htmlPath, "utf-8");
			return {
				contents: [
					{
						uri: DASHBOARD_URI,
						mimeType: RESOURCE_MIME_TYPE,
						text: html,
					},
				],
			};
		},
	);
}
