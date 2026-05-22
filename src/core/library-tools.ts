/**
 * Library Tools
 *
 * MCP tools for inspecting components from PUBLISHED shared/team libraries
 * without needing the source library file URL — only a component key
 * (the 40-char hex returned by component search results) is required.
 *
 * Bridges the gap between component discovery (search_design_system /
 * figma_search_components / figma_get_library_components) and full property
 * inspection (componentPropertyDefinitions, variants, visual specs).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import type { IFigmaConnector } from "./figma-connector.js";
import { extractVisualSpec } from "./design-system-tools.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "library-tools" });

// ============================================================================
// Types
// ============================================================================

interface PublishedComponentMeta {
	key: string;
	file_key: string;
	node_id: string;
	thumbnail_url?: string;
	name: string;
	description: string;
	created_at?: string;
	updated_at?: string;
	user?: { id?: string; handle?: string; img_url?: string };
	containing_frame?: {
		name?: string;
		nodeId?: string;
		pageId?: string;
		pageName?: string;
		backgroundColor?: string;
		containingComponentSet?: { name?: string; nodeId?: string } | boolean;
	};
}

interface VariantEntry {
	name: string;
	nodeId: string;
	key?: string;
	visualSpec?: ReturnType<typeof extractVisualSpec>;
}

interface LibraryComponentResponse {
	_mcp: "figma-console-mcp";
	componentKey: string;
	resolvedAs: "COMPONENT_SET" | "COMPONENT";
	fileKey: string;
	nodeId: string;
	name: string;
	description?: string;
	thumbnail_url?: string;
	containing_frame?: PublishedComponentMeta["containing_frame"];
	user?: PublishedComponentMeta["user"];
	created_at?: string;
	updated_at?: string;
	properties?: Record<string, any>;
	variants?: VariantEntry[];
	visualSpec?: ReturnType<typeof extractVisualSpec>;
	bounds?: { width: number; height: number };
	format: "full" | "summary";
	warnings?: string[];
	compression?: {
		originalSizeKB: number;
		finalSizeKB: number;
		strippedVisualSpecs: boolean;
	};
	usage: {
		instantiate: string;
		example?: string;
	};
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Detect whether a thrown REST error represents an HTTP 404.
 * FigmaAPI.request() throws Error("Figma API error (XXX): body").
 */
function is404(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes("(404)") || /\bNot Found\b/i.test(msg);
}

/**
 * Detect missing-token or auth-related errors so we can return a clear hint.
 */
function isAuthError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		msg.includes("FIGMA_ACCESS_TOKEN") ||
		msg.includes("(401)") ||
		msg.includes("(403)") ||
		/Forbidden|Unauthorized/i.test(msg)
	);
}

/**
 * Approximate JSON payload size in KB. Cheap — used for adaptive compression.
 */
function jsonSizeKB(obj: unknown): number {
	try {
		return JSON.stringify(obj).length / 1024;
	} catch {
		return 0;
	}
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerLibraryTools(
	server: McpServer,
	getFigmaAPI: () => Promise<FigmaAPI>,
): void {
	server.tool(
		"figma_get_library_component_by_key",
		`Get full property definitions, variants, and visual specs for a SINGLE published library component using only its component key.

**USE THIS when you have a component key** (the 40-char hex returned by figma_search_components, figma_get_library_components, or search_design_system) **and want to inspect what properties/variants it exposes** before instantiating it — without first needing the source library file's URL.

**RESOLVES**: componentKey → file_key + node_id → componentPropertyDefinitions + variants + visualSpec.

**WORKFLOW**:
1. Pass the componentKey from search results
2. Tool tries /v1/component_sets/{key} first (most common case — buttons, inputs with variants)
3. On 404 falls back to /v1/components/{key} (standalone components)
4. Fetches the parent COMPONENT_SET at depth=2 to read componentPropertyDefinitions and per-variant visual data
5. For COMPONENT_SET keys, also fetches the source file's /components list to map each variant's node to its published variant key (needed for figma_instantiate_component)

**REQUIRES** FIGMA_ACCESS_TOKEN with library_assets:read and files:read scopes.`,
		{
			componentKey: z
				.string()
				.min(1)
				.describe(
					"The component key (40-char hex string from search results, e.g., '806826503bbd2ab15d0ff77d076a9406a5a83197'). Works for both COMPONENT_SET and standalone COMPONENT keys.",
				),
			includeVisualSpecs: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					"Include per-variant visual specs (fills, strokes, padding, typography). Default true. Auto-stripped if response exceeds 500KB.",
				),
			format: z
				.enum(["full", "summary"])
				.optional()
				.default("full")
				.describe(
					"'full' returns properties + variants + visual specs. 'summary' returns properties + variant names only (no visualSpec). Auto-downgrades to 'summary' on large responses.",
				),
		},
		async ({ componentKey, includeVisualSpecs, format }) => {
			const warnings: string[] = [];
			try {
				const api = await getFigmaAPI();

				// ---- Resolve componentKey → meta (try COMPONENT_SET first, fall back to COMPONENT) ----
				let resolvedAs: "COMPONENT_SET" | "COMPONENT" = "COMPONENT_SET";
				let meta: PublishedComponentMeta | undefined;

				try {
					const setResponse = await api.getComponentSetByKey(componentKey);
					meta = setResponse?.meta;
				} catch (err) {
					if (!is404(err)) {
						throw err;
					}
					logger.info(
						{ componentKey },
						"component_sets/{key} returned 404, falling back to components/{key}",
					);
					try {
						const compResponse = await api.getComponentByKey(componentKey);
						meta = compResponse?.meta;
						resolvedAs = "COMPONENT";
					} catch (err2) {
						if (is404(err2)) {
							return {
								content: [
									{
										type: "text",
										text: JSON.stringify({
											_mcp: "figma-console-mcp",
											error: `Component key not found: ${componentKey}`,
											hint: "Verify the key is a published component or component_set key from figma_search_components / search_design_system. Unpublished/draft components are not accessible via this endpoint.",
											componentKey,
										}),
									},
								],
								isError: true,
							};
						}
						throw err2;
					}
				}

				if (!meta || !meta.file_key || !meta.node_id) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									_mcp: "figma-console-mcp",
									error: "Figma REST API returned a response without file_key or node_id.",
									hint: "This may indicate a Figma API change or a malformed component key. Re-check the key with figma_search_components.",
									componentKey,
								}),
							},
						],
						isError: true,
					};
				}

				const { file_key: fileKey, node_id: nodeId } = meta;

				// ---- Fetch full node tree (depth=2) + optionally the file's components list ----
				// Components list is only needed for COMPONENT_SET keys to map variant
				// node_ids → variant keys (needed for figma_instantiate_component).
				const needsComponentsList = resolvedAs === "COMPONENT_SET";
				const [nodeResponse, componentsResponse] = await Promise.all([
					api.getNodes(fileKey, [nodeId], { depth: 2 }).catch((err: Error) => {
						warnings.push(`getNodes failed: ${err.message}`);
						return null;
					}),
					needsComponentsList
						? api.getComponents(fileKey).catch((err: Error) => {
								warnings.push(
									`getComponents (variant key resolution) failed: ${err.message}. Variants will be returned without published keys.`,
								);
								return null;
							})
						: Promise.resolve(null),
				]);

				const doc = nodeResponse?.nodes?.[nodeId]?.document;

				// ---- Build base response ----
				const response: LibraryComponentResponse = {
					_mcp: "figma-console-mcp",
					componentKey,
					resolvedAs,
					fileKey,
					nodeId,
					name: meta.name,
					description: meta.description || undefined,
					thumbnail_url: meta.thumbnail_url,
					containing_frame: meta.containing_frame,
					user: meta.user,
					created_at: meta.created_at,
					updated_at: meta.updated_at,
					format,
					usage: {
						instantiate:
							resolvedAs === "COMPONENT_SET"
								? "For COMPONENT_SET, pick a VARIANT key from the variants[] array (NOT the top-level componentKey) and pass it to figma_instantiate_component."
								: "For standalone COMPONENT, pass the componentKey directly to figma_instantiate_component.",
					},
				};

				// ---- Extract bounds + visual spec from the document node ----
				if (doc) {
					if (doc.absoluteBoundingBox) {
						response.bounds = {
							width: doc.absoluteBoundingBox.width,
							height: doc.absoluteBoundingBox.height,
						};
					}
					if (includeVisualSpecs && format === "full") {
						const vs = extractVisualSpec(doc);
						if (vs) response.visualSpec = vs;
					}
					if (doc.componentPropertyDefinitions) {
						response.properties = doc.componentPropertyDefinitions;
					}
				}

				// ---- Build variants[] for COMPONENT_SET ----
				if (resolvedAs === "COMPONENT_SET") {
					const childComponents: any[] =
						doc?.children?.filter((c: any) => c.type === "COMPONENT") || [];

					// Map variant node_id -> published key from /components endpoint
					const keyByNodeId = new Map<string, string>();
					const rawComponents: any[] =
						componentsResponse?.meta?.components || [];
					for (const c of rawComponents) {
						const belongsToThisSet =
							c.component_set_id === nodeId ||
							c.containing_frame?.nodeId === nodeId ||
							c.containing_frame?.containingComponentSet?.nodeId === nodeId;
						if (belongsToThisSet && c.node_id && c.key) {
							keyByNodeId.set(c.node_id, c.key);
						}
					}

					const variants: VariantEntry[] = childComponents.map((child) => {
						const entry: VariantEntry = {
							name: child.name,
							nodeId: child.id,
						};
						const k = keyByNodeId.get(child.id);
						if (k) entry.key = k;
						if (includeVisualSpecs && format === "full") {
							const vs = extractVisualSpec(child);
							if (vs) entry.visualSpec = vs;
						}
						return entry;
					});

					if (variants.length > 0) {
						response.variants = variants;
						const firstWithKey = variants.find((v) => v.key);
						if (firstWithKey) {
							response.usage.example = `figma_instantiate_component({ componentKey: "${firstWithKey.key}" }) — first variant of "${meta.name}"`;
						}
					}
				} else {
					// Standalone COMPONENT — the input key IS the instantiation key
					response.usage.example = `figma_instantiate_component({ componentKey: "${componentKey}" })`;
				}

				// ---- Adaptive compression: if payload exceeds 500KB, strip visual specs ----
				const originalSize = jsonSizeKB(response);
				let finalResponse: LibraryComponentResponse = response;
				let strippedVisualSpecs = false;

				if (originalSize > 500) {
					strippedVisualSpecs = true;
					const stripped: LibraryComponentResponse = {
						...response,
						format: "summary",
						visualSpec: undefined,
						variants: response.variants?.map((v) => ({
							name: v.name,
							nodeId: v.nodeId,
							key: v.key,
						})),
					};
					finalResponse = stripped;
					finalResponse.compression = {
						originalSizeKB: Math.round(originalSize),
						finalSizeKB: Math.round(jsonSizeKB(finalResponse)),
						strippedVisualSpecs: true,
					};
					warnings.push(
						`Response was ${Math.round(originalSize)}KB — visual specs stripped to fit context. Set includeVisualSpecs=false on next call to skip extraction entirely, or fetch a single variant via getNodes for its visual spec.`,
					);
				}

				if (warnings.length > 0) {
					finalResponse.warnings = warnings;
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(finalResponse),
						},
					],
				};
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				logger.error(
					{ error, componentKey },
					"figma_get_library_component_by_key failed",
				);

				let hint =
					"Verify the componentKey is correct (40-char hex from search results) and FIGMA_ACCESS_TOKEN is set.";
				if (isAuthError(error)) {
					hint =
						"Authentication failed. FIGMA_ACCESS_TOKEN must be set with library_assets:read and files:read scopes. Get a token at https://www.figma.com/developers/api#access-tokens";
				} else if (errorMessage.includes("(429)") || /Rate/i.test(errorMessage)) {
					hint =
						"Rate limited by Figma API. Wait a moment and retry, or reduce concurrent requests.";
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								_mcp: "figma-console-mcp",
								error: errorMessage,
								hint,
								componentKey,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}

// ============================================================================
// Plugin-API based tools — library variable inspection + import
// ============================================================================
//
// These tools complement the REST-based component tool above by exposing
// the Figma Plugin API's team-library variable surface. They run via the
// Desktop Bridge (executeCodeViaUI) because the REST API's variables
// endpoints are Enterprise-only on most plans, while the Plugin API works
// on every plan — and crucially, can ONLY see libraries the current file
// has subscribed via the UI (which is exactly the surface the user wants).
//
// Pattern: send a short async script that calls figma.teamLibrary.* /
// figma.variables.* APIs and returns a plain JSON-serializable result.

/**
 * JSON-stringify a value safely, returning a fallback on failure.
 * Used inside the Plugin sandbox script to defend against unserializable
 * objects (e.g., live Variable nodes returned by importVariableByKeyAsync).
 */
function safeKey(value: string): string {
	return JSON.stringify(value);
}

export function registerLibraryVariableTools(
	server: McpServer,
	getDesktopConnector: () => Promise<IFigmaConnector>,
): void {
	// --------------------------------------------------------------------
	// figma_get_library_variables — list available variables from
	// libraries currently subscribed by the open file.
	// --------------------------------------------------------------------
	server.tool(
		"figma_get_library_variables",
		`List all variables from team libraries the current file has subscribed.

**USE THIS** when you want to see what design tokens (colors, spacing, typography sizes, booleans, strings) are available from shared libraries — without needing the library file's URL or REST API Enterprise plan.

**HOW IT WORKS**: Calls figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync() + getVariablesInLibraryCollectionAsync() via the Desktop Bridge. Only libraries the user has explicitly enabled in the current file appear (Figma security model).

**WORKFLOW**:
1. Call this tool to inventory available library variables
2. Find the variable you want (use libraryName + collectionName + variable name to identify)
3. Pass its key to figma_import_library_variable to bring it into the current file
4. Once imported, the variable's id can be used with figma_set_fills / figma_update_variable / any standard variable-binding tool

**Filters**: libraryName/collectionName accept partial case-insensitive matches.

**REQUIRES** the Desktop Bridge plugin to be running in Figma Desktop.`,
		{
			libraryName: z
				.string()
				.optional()
				.describe(
					"Optional: filter by library name (case-insensitive substring match). E.g., 'Northright' or 'Altitude'.",
				),
			collectionName: z
				.string()
				.optional()
				.describe(
					"Optional: filter by collection name within a library (case-insensitive substring match). E.g., 'Colors' or 'Spacing'.",
				),
			resolvedType: z
				.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
				.optional()
				.describe(
					"Optional: filter by variable type. Useful when you only need color tokens or only spacing values.",
				),
		},
		async ({ libraryName, collectionName, resolvedType }) => {
			try {
				const connector = await getDesktopConnector();

				// Script runs inside Plugin sandbox; receives no external bindings.
				// Build a result array and return it for the bridge to forward.
				const script = `
					if (!figma.teamLibrary || typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync !== 'function') {
						return { __error: 'figma.teamLibrary API not available. Requires a recent Figma Desktop build.' };
					}
					const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
					const out = [];
					for (let i = 0; i < collections.length; i++) {
						const coll = collections[i];
						let vars = [];
						try {
							vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(coll.key);
						} catch (innerErr) {
							out.push({
								libraryName: coll.libraryName || null,
								collectionKey: coll.key,
								collectionName: coll.name,
								error: innerErr && innerErr.message ? innerErr.message : String(innerErr),
								variables: [],
								variableCount: 0,
							});
							continue;
						}
						out.push({
							libraryName: coll.libraryName || null,
							collectionKey: coll.key,
							collectionName: coll.name,
							variableCount: vars.length,
							variables: vars.map(function(v) {
								return {
									key: v.key,
									name: v.name,
									resolvedType: v.resolvedType,
								};
							}),
						});
					}
					return out;
				`;

				const raw = await connector.executeCodeViaUI(script, 30000);

				// Detect the wrapped-error sentinel
				if (raw && typeof raw === "object" && (raw as any).__error) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									_mcp: "figma-console-mcp",
									error: (raw as any).__error,
									hint: "Plugin sandbox could not access the team library API. Ensure Figma Desktop is recent and the Desktop Bridge is connected.",
								}),
							},
						],
						isError: true,
					};
				}

				let collections = Array.isArray(raw) ? raw : [];

				// Apply server-side filters (cheaper to filter here than in plugin)
				if (libraryName) {
					const needle = libraryName.toLowerCase();
					collections = collections.filter(
						(c: any) =>
							typeof c.libraryName === "string" &&
							c.libraryName.toLowerCase().includes(needle),
					);
				}
				if (collectionName) {
					const needle = collectionName.toLowerCase();
					collections = collections.filter(
						(c: any) =>
							typeof c.collectionName === "string" &&
							c.collectionName.toLowerCase().includes(needle),
					);
				}
				if (resolvedType) {
					collections = collections.map((c: any) => ({
						...c,
						variables: (c.variables || []).filter(
							(v: any) => v.resolvedType === resolvedType,
						),
					}));
					collections = collections.filter(
						(c: any) => c.variables.length > 0,
					);
					// Refresh counts after filtering
					collections.forEach((c: any) => {
						c.variableCount = c.variables.length;
					});
				}

				const totalVariables = collections.reduce(
					(sum: number, c: any) => sum + (c.variableCount || 0),
					0,
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								_mcp: "figma-console-mcp",
								summary: {
									totalCollections: collections.length,
									totalVariables,
								},
								filters: {
									libraryName: libraryName || null,
									collectionName: collectionName || null,
									resolvedType: resolvedType || null,
								},
								collections,
								usage: {
									import:
										"Pick a variable's key from collections[].variables[].key and pass it to figma_import_library_variable to bring it into the current file.",
									note: "Only libraries the current file has explicitly subscribed via the Figma UI are listed. Subscribe a library via Figma > Assets panel > Libraries.",
								},
							}),
						},
					],
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "figma_get_library_variables failed");
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								_mcp: "figma-console-mcp",
								error: msg,
								hint: "Ensure the Desktop Bridge plugin is running in Figma Desktop. Run figma_get_status to verify the connection.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// --------------------------------------------------------------------
	// figma_import_library_variable — import a single library variable
	// into the current file so it can be bound to nodes.
	// --------------------------------------------------------------------
	server.tool(
		"figma_import_library_variable",
		`Import a single variable from a subscribed team library into the current file.

After import, the variable becomes locally addressable by its returned 'id' and can be passed to any tool that binds variables to nodes (fills, strokes, paddings, etc.). The import is idempotent — calling it twice returns the same local id.

**WORKFLOW**:
1. Run figma_get_library_variables to find the variable key
2. Call this tool with that key
3. Use the returned 'id' with figma_set_fills (boundVariables), figma_update_variable, or other binding tools

**REQUIRES** the Desktop Bridge plugin and that the source library is subscribed by the current file (otherwise importVariableByKeyAsync rejects).`,
		{
			variableKey: z
				.string()
				.min(1)
				.describe(
					"The variable key from figma_get_library_variables (collections[].variables[].key). Distinct from the variable's local id.",
				),
		},
		async ({ variableKey }) => {
			try {
				const connector = await getDesktopConnector();

				const script = `
					if (!figma.variables || typeof figma.variables.importVariableByKeyAsync !== 'function') {
						return { __error: 'figma.variables.importVariableByKeyAsync not available.' };
					}
					try {
						const imported = await figma.variables.importVariableByKeyAsync(${safeKey(variableKey)});
						if (!imported) {
							return { __error: 'Import returned no variable. The key may be invalid or the source library is not subscribed by this file.' };
						}
						return {
							id: imported.id,
							key: imported.key,
							name: imported.name,
							resolvedType: imported.resolvedType,
							description: imported.description || null,
							variableCollectionId: imported.variableCollectionId,
							remote: imported.remote === true,
						};
					} catch (e) {
						return { __error: (e && e.message) ? e.message : String(e) };
					}
				`;

				const raw = await connector.executeCodeViaUI(script, 20000);

				if (raw && typeof raw === "object" && (raw as any).__error) {
					const errMsg = (raw as any).__error as string;
					let hint =
						"Verify the variableKey was returned by figma_get_library_variables and that the source library is subscribed by the current file.";
					if (/not subscribed|not enabled|access/i.test(errMsg)) {
						hint =
							"The library containing this variable is not subscribed by the current file. Subscribe it via Figma > Assets panel > Libraries, then retry.";
					}
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									_mcp: "figma-console-mcp",
									error: errMsg,
									hint,
									variableKey,
								}),
							},
						],
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								_mcp: "figma-console-mcp",
								imported: raw,
								usage: {
									bind: `Use the imported variable's id ('${(raw as any)?.id}') with figma_set_fills, figma_update_variable, or any other variable-binding tool to reference this token from nodes in the current file.`,
									note: "Variables imported from a library remain linked to their source — updates published from the library will propagate here automatically.",
								},
							}),
						},
					],
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error(
					{ error, variableKey },
					"figma_import_library_variable failed",
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								_mcp: "figma-console-mcp",
								error: msg,
								hint: "Ensure the Desktop Bridge plugin is running. Run figma_get_status to verify.",
								variableKey,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
