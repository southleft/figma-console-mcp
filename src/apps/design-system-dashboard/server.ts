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
import {
	describeFixability,
	getRemediation,
} from "./scoring/remediation.js";
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
 * @param getCurrentUrl - Optional function to get the current browser URL (for lastFileUrl tracking)
 */
export function registerDesignSystemDashboardApp(
	server: McpServer,
	getDesignSystemData: (
		fileUrl?: string,
		forceRefresh?: boolean,
	) => Promise<DesignSystemRawData>,
	getCurrentUrl?: () => string | null,
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
				// Track the actual URL used (explicit or current browser URL)
				// This ensures ds_dashboard_refresh uses the correct file
				lastFileUrl = fileUrl || getCurrentUrl?.() || undefined;
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
				const src = scored.dataAvailability?.componentsSource;
				const sourceNote =
					src === "rest-published"
						? " Component data reflects the last PUBLISHED library snapshot (Desktop Bridge unavailable), not unpublished edits."
						: src === "none"
							? " No component data was available — component-based checks are not meaningful for this run."
							: "";

				return {
					content: [
						{
							type: "text" as const,
							text: `Design System: ${fileName}. Health: ${scored.overall}/100 — ${scored.status}. ${categorySummaries}.${unavailableNote}${sourceNote} The dashboard UI is now showing detailed results. For finding-by-finding detail and what this MCP can auto-fix, call figma_audit_design_system_report (results are cached — no re-crawl).`,
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

/**
 * Register the plain design-system audit tool.
 *
 * This is deliberately a SEPARATE registration from the dashboard app: the
 * app tools above are only visible to MCP-Apps-capable hosts (e.g. Claude
 * Desktop) and may be gated behind ENABLE_MCP_APPS, while this standard tool
 * must be available to EVERY MCP client (Claude Code, headless agents, CI) —
 * it runs the same fetch + scoring engine and returns the report as data.
 *
 * Token-safety design: the default 'summary' output is bounded regardless
 * of file size (scores + non-pass findings with ≤3 examples each). Full
 * detail is consumed in CHUNKS via the `category` parameter (one category
 * per call) rather than one giant payload; `format: "full"` exists for
 * programmatic consumers and clamps per-finding examples/locations.
 * Compute-safety: the underlying fetch is chunked at the source (the bridge
 * crawls pages in batches of 3 with event-loop yields) and cached for 5
 * minutes, so summary + drill-down calls share one crawl. Use forceRefresh
 * only after editing the file.
 */
export function registerDesignSystemAuditTool(
	server: McpServer,
	getDesignSystemData: (
		fileUrl?: string,
		forceRefresh?: boolean,
	) => Promise<DesignSystemRawData>,
	getCurrentUrl?: () => string | null,
): void {
	server.tool(
		"figma_audit_design_system_report",
		"Run the design-system health audit and return the scored report as data (no UI required). Same deterministic engine as the Design System Dashboard app: naming & semantics, token architecture, component metadata, accessibility, consistency, coverage — each 0-100 plus a weighted overall. Start with the default summary, then drill into one category at a time via `category` (chunked; avoids one giant payload). Results are cached ~5 minutes; pass forceRefresh after editing the file. Every finding includes whether this MCP can fix it (design-side write tools vs. design decision vs. manual).",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL. If not provided, uses the currently active file.",
				),
			format: z
				.enum(["summary", "full"])
				.optional()
				.default("summary")
				.describe(
					"'summary' (default) — bounded readable report: overall + category scores + non-pass findings + remediation. 'full' — complete scored JSON (examples/locations clamped); prefer per-category calls over 'full' when working interactively.",
				),
			category: z
				.enum([
					"naming-semantics",
					"token-architecture",
					"component-metadata",
					"accessibility",
					"consistency",
					"coverage",
				])
				.optional()
				.describe(
					"Return full findings (including passes, examples, locations) for ONE category — the chunked drill-down path after a summary call.",
				),
			forceRefresh: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"Bypass the 5-minute audit cache and re-crawl the file. Only needed after editing the file.",
				),
		},
		async ({ fileUrl, format, category, forceRefresh }) => {
			try {
				lastFileUrl = fileUrl || getCurrentUrl?.() || lastFileUrl;
				const data = await getDesignSystemData(fileUrl, forceRefresh);
				const scored = scoreDesignSystem(data);

				const clampFinding = (f: any) => ({
					...f,
					examples: f.examples?.slice(0, 5),
					locations: f.locations?.slice(0, 10),
				});

				const sourceNote = (): string | null => {
					const src = scored.dataAvailability?.componentsSource;
					if (src === "rest-published") {
						return "Component data came from the PUBLISHED library snapshot (Desktop Bridge unavailable) — scores reflect the last publish, not unpublished edits.";
					}
					if (src === "none") {
						return "No component data was available (bridge disconnected and nothing published) — component-based checks defaulted to passing and are NOT meaningful.";
					}
					return null; // bridge-live needs no caveat
				};

				const remediationLines = (findings: any[]): string[] => {
					const lines: string[] = [];
					for (const f of findings) {
						if (f.severity === "pass" || f.severity === "info") continue;
						const rem = getRemediation(f.id);
						if (!rem) continue;
						lines.push(
							`  - ${f.label}: ${describeFixability(rem.fixability)} — ${rem.how} [${rem.tools.join(", ")}]`,
						);
					}
					return lines;
				};

				// Per-category drill-down: full findings for one category only.
				if (category) {
					const cat = scored.categories.find((c) => c.id === category);
					if (!cat) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Unknown category '${category}'. Valid: ${scored.categories.map((c) => c.id).join(", ")}`,
								},
							],
							isError: true,
						};
					}
					const payload = {
						file: scored.fileInfo?.name,
						overall: scored.overall,
						category: {
							...cat,
							findings: cat.findings.map((f) => ({
								...clampFinding(f),
								remediation: getRemediation(f.id),
							})),
						},
						componentsSource: scored.dataAvailability?.componentsSource,
					};
					return {
						content: [
							{ type: "text" as const, text: JSON.stringify(payload) },
						],
					};
				}

				if (format === "full") {
					const clamped = {
						...scored,
						categories: scored.categories.map((c) => ({
							...c,
							findings: c.findings.map((f) => ({
								...clampFinding(f),
								remediation: getRemediation(f.id),
							})),
						})),
					};
					return {
						content: [
							{ type: "text" as const, text: JSON.stringify(clamped) },
						],
					};
				}

				const lines: string[] = [];
				const fileName = scored.fileInfo?.name || "Unknown file";
				lines.push(
					`Design System: ${fileName} — Overall Health: ${scored.overall}/100 (${scored.status})`,
				);
				const allFindings: any[] = [];
				for (const c of scored.categories) {
					lines.push(`\n${c.label}: ${c.score}/100 (weight ${c.weight})`);
					for (const f of c.findings) {
						allFindings.push(f);
						if (f.severity === "pass") continue;
						lines.push(
							`  [${f.severity.toUpperCase()}] ${f.label} (${f.score}): ${f.details ?? ""}`,
						);
						if (f.examples?.length) {
							lines.push(`    e.g. ${f.examples.slice(0, 3).join(" | ")}`);
						}
					}
				}
				if (scored.summary.length) {
					lines.push("\nTop actions:");
					for (const s of scored.summary) lines.push(`  - ${s}`);
				}
				const remLines = remediationLines(allFindings);
				if (remLines.length) {
					lines.push("\nRemediation — what this MCP can fix:");
					lines.push(...remLines);
					lines.push(
						"  Ask the agent to apply any of the design-side fixes above; 'design decision' items need your choice first (the agent can propose options).",
					);
				}
				const note = sourceNote();
				if (note) lines.push(`\nData source: ${note}`);
				if (scored.dataAvailability && !scored.dataAvailability.variables) {
					lines.push(
						"\nNote: variable/token data was unavailable (connect the Desktop Bridge plugin or use an Enterprise REST token) — Token Architecture reflects missing data, not actual quality.",
					);
				}
				lines.push(
					"\nTip: call again with category=<id> for full findings on one dimension (chunked; cached, no re-crawl within 5 min).",
				);
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
				};
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text" as const,
							text: `Design system audit error: ${errorMessage}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
