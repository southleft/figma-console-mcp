/**
 * Deep Component Extraction MCP Tool
 *
 * Provides unlimited-depth component tree extraction via the Desktop Bridge
 * Plugin API. Returns full visual properties, resolved design token names,
 * instance references (mainComponent), prototype reactions, and annotations
 * at every level of the tree.
 *
 * This complements figma_get_component_for_development (REST API, depth 4)
 * with deeper, richer data when the Desktop Bridge plugin is connected.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "deep-component-tools" });

export function registerDeepComponentTools(
	server: McpServer,
	getDesktopConnector: () => Promise<any>,
): void {
	server.tool(
		"figma_get_component_for_development_deep",
		"Get a deeply nested component tree with full visual properties, resolved design token names, instance references, prototype interactions, and annotations at every level. Uses the Desktop Bridge Plugin API for unlimited depth traversal — essential for complex components like data tables, nested menus, date pickers, and compound form fields where the standard depth-4 REST API tool misses deeper structure. Returns boundVariables resolved to actual token names (not just IDs), mainComponent references for INSTANCE nodes, and reactions for interaction states. Requires Desktop Bridge plugin. For simpler components (depth ≤ 4), use figma_get_component_for_development instead.",
		{
			nodeId: z
				.string()
				.describe("Component node ID to extract (e.g., '695:313')"),
			depth: z.preprocess(
				(v) => (typeof v === "string" ? Number(v) : v),
				z.number().optional().default(10),
			).describe("Maximum tree depth to traverse (default: 10, max: 20). Use higher values for deeply nested components."),
		},
		async ({ nodeId, depth = 10 }) => {
			try {
				const clampedDepth = Math.min(Math.max(depth, 1), 20);
				logger.info({ nodeId, depth: clampedDepth }, "Deep component extraction");

				const connector = await getDesktopConnector();
				const result = await connector.deepGetComponent(nodeId, clampedDepth);

				if (!result || (result.success === false)) {
					throw new Error(result?.error || "Failed to extract component");
				}

				const data = result.data || result;

				// Measure response size and warn if large
				const responseJson = JSON.stringify(data);
				const sizeKB = Math.round(responseJson.length / 1024);

				const response: any = {
					nodeId,
					component: data,
					metadata: {
						purpose: "deep_component_development",
						treeDepth: clampedDepth,
						responseSizeKB: sizeKB,
						variablesResolved: data._variableMapSize || 0,
						note: [
							`Deep component tree extracted via Plugin API (depth ${clampedDepth}).`,
							"boundVariables are resolved to token names, collections, and codeSyntax.",
							"INSTANCE nodes include mainComponent references (key, name, component set).",
							"Use this data to generate production-quality, token-aware, accessible code.",
							sizeKB > 200 ? "Response is large — consider targeting a specific child node for deeper analysis." : null,
						].filter(Boolean).join(" "),
					},
				};

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(response),
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Deep component extraction failed");

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "deep_component_failed",
								message: `Cannot extract deep component. ${message}`,
								hint: "This tool requires the Desktop Bridge plugin to be running in Figma. For REST API fallback (depth 4), use figma_get_component_for_development.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_analyze_component_set
	// -----------------------------------------------------------------------
	server.tool(
		"figma_analyze_component_set",
		"Analyze a Figma COMPONENT_SET to extract variant state machine and cross-variant diffs for code generation. Returns: (1) variant axes (size, state) with all values, (2) CSS pseudo-class mappings for interaction states (hover→:hover, focus→:focus-visible, disabled→:disabled, error→[aria-invalid]), (3) visual diff from default state per variant (only changed properties — fill token, stroke token, stroke weight, text color, opacity, effects, visibility), (4) component property definitions mapped to code props (BOOLEAN→boolean, TEXT→string, INSTANCE_SWAP→slot/ReactNode). Use this on the parent COMPONENT_SET node, not individual variants. Requires Desktop Bridge plugin.",
		{
			nodeId: z
				.string()
				.describe("COMPONENT_SET node ID (the parent of all variants, e.g., '214:274')"),
		},
		async ({ nodeId }) => {
			try {
				logger.info({ nodeId }, "Analyzing component set");

				const connector = await getDesktopConnector();
				const result = await connector.analyzeComponentSet(nodeId);

				if (!result || (result.success === false)) {
					throw new Error(result?.error || "Failed to analyze component set");
				}

				const data = result.data || result;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								nodeId,
								analysis: data,
								metadata: {
									purpose: "variant_state_machine",
									note: "Use cssMapping to implement interaction states as CSS pseudo-classes/attributes. diffFromDefault shows only what changes per variant — apply as style overrides. componentProps maps to your component's TypeScript interface.",
								},
							}),
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Component set analysis failed");

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "analyze_component_set_failed",
								message: `Cannot analyze component set. ${message}`,
								hint: "This tool requires the Desktop Bridge plugin and a COMPONENT_SET node ID (not an individual variant). Use figma_search_components to find component sets.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
