/**
 * Bridge-first variable resolution.
 *
 * Figma's Variables REST API (`/files/:key/variables/local`) is **Enterprise-only**
 * and returns 403 for the majority of users (Starter/Pro/Org). The Desktop Bridge
 * and cloud relay read variables through the Plugin API
 * (`figma.variables.getLocalVariablesAsync`), which works on **every** Figma plan.
 *
 * Orchestration tools (e.g. `figma_get_design_system_kit`) historically called the
 * REST API directly and dead-ended on a 403 for non-Enterprise users — even when a
 * bridge was connected. This helper mirrors `figma_get_variables`' resolution order
 * so every variable-reading tool behaves consistently:
 *
 *   1. Desktop Bridge / cloud relay (any plan)  ← preferred
 *   2. REST Variables API (Enterprise only)      ← fallback
 *
 * It returns the same normalized shape as `formatVariables()`.
 */

import { formatVariables, withTimeout, type FigmaAPI } from "./figma-api.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "variable-resolver" });

export interface ResolvedVariables {
	collections: any[];
	variables: any[];
	summary: {
		totalCollections: number;
		totalVariables: number;
		variablesByType: Record<string, number>;
	};
	/** Which transport actually produced the data. */
	source: "desktop_bridge" | "rest_api";
}

/**
 * The Desktop Bridge returns variables/collections as **arrays**, while
 * `formatVariables()` expects **objects keyed by id** (the REST shape). Convert so
 * the same formatter handles both transports.
 */
function bridgeArraysToFormatInput(data: {
	variables: any[];
	variableCollections: any[];
}): { variables: Record<string, any>; variableCollections: Record<string, any> } {
	const variables: Record<string, any> = {};
	for (const v of data.variables || []) {
		if (v && v.id) variables[v.id] = v;
	}
	const variableCollections: Record<string, any> = {};
	for (const c of data.variableCollections || []) {
		if (c && c.id) variableCollections[c.id] = c;
	}
	return { variables, variableCollections };
}

/**
 * Resolve + format local variables, preferring the Desktop Bridge / cloud relay and
 * falling back to the Enterprise-only REST API only when no bridge is connected.
 *
 * @throws a bridge-pointing error when the bridge is unavailable AND the REST API
 *         fails (e.g. 403 without Enterprise), so callers/LLMs retry via the bridge
 *         instead of treating variables as inaccessible.
 */
export async function resolveFormattedVariables(opts: {
	getDesktopConnector?: () => Promise<any>;
	getFigmaAPI: () => Promise<FigmaAPI>;
	fileKey: string;
	timeoutMs?: number;
}): Promise<ResolvedVariables> {
	const { getDesktopConnector, getFigmaAPI, fileKey } = opts;
	const timeoutMs = opts.timeoutMs ?? 30000;

	// 1. Desktop Bridge / cloud relay — works on ANY plan. Preferred.
	if (getDesktopConnector) {
		try {
			const connector = await getDesktopConnector();
			const raw: any = await withTimeout(
				connector.getVariables(fileKey),
				timeoutMs,
				"Desktop Bridge variables",
			);
			// EXECUTE_CODE responses nest the return value under `result`; unwrap so
			// both the live and cached plugin paths produce a uniform shape. See #68.
			const data = raw?.result?.variables ? raw.result : raw;

			if (data?.success && Array.isArray(data.variables)) {
				const formatted = formatVariables(bridgeArraysToFormatInput(data));
				logger.info(
					{ source: "desktop_bridge", variableCount: formatted.variables.length },
					"Resolved variables via Desktop Bridge",
				);
				return { ...formatted, source: "desktop_bridge" };
			}

			logger.warn(
				{ fileKey, error: data?.error },
				"Desktop Bridge returned no variables; falling back to REST API",
			);
		} catch (err) {
			logger.warn(
				{ fileKey, error: err instanceof Error ? err.message : String(err) },
				"Desktop Bridge variable fetch failed; falling back to REST API",
			);
		}
	}

	// 2. REST Variables API — Enterprise only. Last resort.
	const api = await getFigmaAPI();
	try {
		const local = await withTimeout(
			api.getLocalVariables(fileKey),
			timeoutMs,
			"getLocalVariables",
		);
		const formatted = formatVariables(local);
		logger.info(
			{ source: "rest_api", variableCount: formatted.variables.length },
			"Resolved variables via REST API",
		);
		return { ...formatted, source: "rest_api" };
	} catch (restErr) {
		const msg = restErr instanceof Error ? restErr.message : String(restErr);
		throw new Error(
			`[figma-console-mcp] Could not read variables. The Figma Variables REST API ` +
				`is unavailable for this file (${msg}) — it requires an Enterprise plan. ` +
				`Connect the Figma Console MCP Desktop Bridge plugin (or pair it via Cloud Mode) ` +
				`to read variables on ANY plan, then retry.`,
		);
	}
}
