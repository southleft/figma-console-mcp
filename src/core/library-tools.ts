import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaAPI, extractFigmaUrlInfo } from "./figma-api.js";
import type { IFigmaConnector } from "./figma-connector.js";
import type { ComponentVariant } from "./design-system-manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LibraryComponentManifest = {
	fileKey: string;
	fileName: string;
	totalComponents: number;
	totalComponentSets: number;
	componentSets: Record<string, LibraryComponentSet>;
	components: Record<string, LibraryComponent>;
};

type LibraryComponent = {
	key: string;
	nodeId: string;
	name: string;
	description: string;
	category: string;
	containingFrame?: string;
};

type LibraryComponentSet = {
	key: string;
	nodeId: string;
	name: string;
	description: string;
	category: string;
	variantAxes: ComponentVariant[];
	variants: LibraryComponent[];
};

type FigmaRestComponent = {
	key: string;
	name: string;
	description: string;
	containing_frame?: { name: string; nodeId: string };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Infers a component category from its name by taking the first segment
 * before a separator (/, –, space). Mirrors the inferCategory logic in
 * design-system-manifest.ts.
 */
function inferCategory(name: string): string {
	for (const sep of ["/", "–", " – "]) {
		if (name.includes(sep)) {
			return name.split(sep)[0].trim();
		}
	}
	return name.split(" ")[0].trim();
}

/**
 * Parses variant axes from a Figma node's variantGroupProperties, falling
 * back to inferring axes from child component names (e.g. "Type=Primary, Size=Large").
 */
function extractVariantAxes(
	variantGroupProperties: Record<string, { values: string[] }> | undefined,
	childNames: string[],
): ComponentVariant[] {
	if (variantGroupProperties && Object.keys(variantGroupProperties).length > 0) {
		return Object.entries(variantGroupProperties).map(([name, { values }]) => ({ name, values }));
	}

	// Fallback: infer from child names
	const axisMap = new Map<string, Set<string>>();
	for (const childName of childNames) {
		for (const part of childName.split(",").map((p) => p.trim())) {
			const eqIdx = part.indexOf("=");
			if (eqIdx !== -1) {
				const axis = part.slice(0, eqIdx).trim();
				const value = part.slice(eqIdx + 1).trim();
				if (!axisMap.has(axis)) axisMap.set(axis, new Set());
				axisMap.get(axis)!.add(value);
			}
		}
	}
	return Array.from(axisMap.entries()).map(([name, valSet]) => ({ name, values: Array.from(valSet) }));
}

/**
 * Builds a full LibraryComponentManifest for a given file key.
 */
async function buildManifestForFile(
	api: FigmaAPI,
	fileKey: string,
): Promise<LibraryComponentManifest> {
	const [componentSetsResponse, componentsResponse, fileResponse] = await Promise.all([
		api.getComponentSets(fileKey) as Promise<{
			meta: { component_sets: Array<FigmaRestComponent & { node_id: string }> };
		}>,
		api.getComponents(fileKey) as Promise<{
			meta: { components: Array<FigmaRestComponent & { node_id: string }> };
		}>,
		api.getFile(fileKey, { depth: 1 }) as Promise<{ name: string }>,
	]);

	const fileName = fileResponse?.name || fileKey;

	// Figma REST API returns arrays — remap to Record<nodeId, component> for internal use.
	const rawComponentSets: Record<string, FigmaRestComponent> = {};
	for (const cs of componentSetsResponse?.meta?.component_sets ?? []) {
		rawComponentSets[cs.node_id] = cs;
	}
	const rawComponents: Record<string, FigmaRestComponent> = {};
	for (const c of componentsResponse?.meta?.components ?? []) {
		rawComponents[c.node_id] = c;
	}

	// Fetch full node data for component sets to get variantGroupProperties.
	// Batch in groups of 50 (Figma API limit).
	const componentSetNodeIds = Object.keys(rawComponentSets);
	const variantPropertiesMap = new Map<string, Record<string, { values: string[] }>>();
	const childNodesMap = new Map<string, Array<{ name: string; id: string }>>();

	if (componentSetNodeIds.length > 0) {
		const BATCH_SIZE = 50;
		for (let i = 0; i < componentSetNodeIds.length; i += BATCH_SIZE) {
			const batch = componentSetNodeIds.slice(i, i + BATCH_SIZE);
			const nodesResponse = (await api.getNodes(fileKey, batch)) as {
				nodes: Record<
					string,
					{
						document: {
							variantGroupProperties?: Record<string, { values: string[] }>;
							children?: Array<{ name: string; id: string }>;
						};
					}
				>;
			};

			for (const [nodeId, node] of Object.entries(nodesResponse?.nodes ?? {})) {
				if (node?.document?.variantGroupProperties) {
					variantPropertiesMap.set(nodeId, node.document.variantGroupProperties);
				}
				childNodesMap.set(nodeId, (node?.document?.children ?? []).map((c) => ({ name: c.name, id: c.id })));
			}
		}
	}

	// Assemble component sets
	const componentSets: Record<string, LibraryComponentSet> = {};
	for (const [nodeId, rawSet] of Object.entries(rawComponentSets)) {
		const childNodes = childNodesMap.get(nodeId) ?? [];
		const childNames = childNodes.map((c) => c.name);
		componentSets[rawSet.name] = {
			key: rawSet.key,
			nodeId,
			name: rawSet.name,
			description: rawSet.description || "",
			category: inferCategory(rawSet.name),
			variantAxes: extractVariantAxes(variantPropertiesMap.get(nodeId), childNames),
			variants: childNodes.map(({ name, id: childNodeId }) => ({
				// Use the individual variant's own published key so importComponentByKeyAsync
				// only loads that specific variant, not the entire set (which would trigger
				// a full recursive import of all variants and their icon dependencies).
				key: rawComponents[childNodeId]?.key ?? rawSet.key,
				nodeId: childNodeId,
				name,
				description: "",
				category: inferCategory(rawSet.name),
			})),
		};
	}

	// Assemble standalone components (skip those that are children of a component set)
	const componentSetChildNodeIds = new Set(
		Array.from(childNodesMap.values()).flat().map((c) => c.id),
	);
	const components: Record<string, LibraryComponent> = {};
	for (const [nodeId, rawComp] of Object.entries(rawComponents)) {
		if (componentSetChildNodeIds.has(nodeId)) continue;
		components[rawComp.name] = {
			key: rawComp.key,
			nodeId,
			name: rawComp.name,
			description: rawComp.description || "",
			category: inferCategory(rawComp.name),
			containingFrame: rawComp.containing_frame?.name,
		};
	}

	return {
		fileKey,
		fileName,
		totalComponents: Object.keys(components).length,
		totalComponentSets: Object.keys(componentSets).length,
		componentSets,
		components,
	};
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Registers library discovery tools that let Claude explore components from
 * external Figma team libraries (e.g. a design system) before placing
 * instances with figma_instantiate_component.
 *
 * When called with no arguments, figma_get_library_components automatically
 * discovers all library file keys by scanning the current file for component
 * instances and resolving their source libraries via the REST API.
 */
export function registerLibraryTools(
	server: McpServer,
	getFigmaAPI: () => Promise<FigmaAPI>,
	getDesktopConnector: () => Promise<IFigmaConnector>,
): void {
	// -----------------------------------------------------------------------
	// figma_get_library_components
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_library_components",
		`Fetch all components and their variant properties from Figma team library file(s).

When called with NO arguments, automatically discovers all libraries used in the current
Figma file by scanning for component instances and resolving their source libraries —
no manual file key input required.

When called WITH a libraryFileKey or libraryUrl, fetches only that specific library.

Returns component keys, names, categories, and variant axes (e.g. {appearance: ["filled","outlined","ghost"]}).
Use the returned component keys with figma_instantiate_component to place real design-system components.`,
		{
			libraryFileKey: z
				.string()
				.optional()
				.describe("Figma file key of the library (the hash in the URL: figma.com/design/{fileKey}/...). Omit to auto-detect from the current file."),
			libraryUrl: z
				.string()
				.optional()
				.describe("Full Figma URL of the library file (alternative to libraryFileKey). Omit to auto-detect."),
		},
		async ({ libraryFileKey, libraryUrl }) => {
			try {
				const api = await getFigmaAPI();

				// ── Manual mode: a specific library was requested ──────────────────
				if (libraryFileKey || libraryUrl) {
					let fileKey = libraryFileKey;
					if (!fileKey && libraryUrl) {
						const urlInfo = extractFigmaUrlInfo(libraryUrl);
						if (!urlInfo) {
							throw new Error("Could not parse Figma URL. Provide the raw file key instead.");
						}
						fileKey = urlInfo.branchId || urlInfo.fileKey;
					}
					const manifest = await buildManifestForFile(api, fileKey!);
					return {
						content: [{ type: "text", text: JSON.stringify(manifest) }],
					};
				}

				// ── Auto-detection mode: discover libraries from current file ──────
				const connector = await getDesktopConnector();

				// Step 1: read user-configured library file keys from plugin storage.
				const configRaw = await connector.executeCodeViaUI(
					`const cfg = await figma.clientStorage.getAsync('libraryConfig');
return JSON.stringify((cfg || []).map(function(c) { return c.fileKey; }));`,
					5000,
				);
				let configuredFileKeys: string[] = [];
				try {
					configuredFileKeys = JSON.parse(typeof configRaw === "string" ? configRaw : JSON.stringify(configRaw));
				} catch {
					configuredFileKeys = [];
				}

				// Step 2: scan the current page for INSTANCE nodes that reference
				//         remote library components, and collect their mainComponent.key.
				const instanceKeysRaw = await connector.executeCodeViaUI(
					`const instances = figma.currentPage.findAllWithCriteria({ types: ['INSTANCE'] });
const keys = new Set();
for (const inst of instances) {
  if (inst.mainComponent && inst.mainComponent.remote) {
    keys.add(inst.mainComponent.key);
  }
}
return JSON.stringify([...keys]);`,
					15000,
				);
				let componentKeys: string[] = [];
				try {
					componentKeys = JSON.parse(typeof instanceKeysRaw === "string" ? instanceKeysRaw : JSON.stringify(instanceKeysRaw));
				} catch {
					componentKeys = [];
				}

				// Step 3: resolve instance component keys → library file keys via REST API.
				const discoveredFileKeySet = new Set<string>();
				if (componentKeys.length > 0) {
					const RESOLVE_BATCH = 20;
					for (let i = 0; i < componentKeys.length; i += RESOLVE_BATCH) {
						const batch = componentKeys.slice(i, i + RESOLVE_BATCH);
						const results = await Promise.allSettled(
							batch.map((key) => api.getComponent(key) as Promise<{ meta: { file_key: string } }>),
						);
						for (const result of results) {
							if (result.status === "fulfilled" && result.value?.meta?.file_key) {
								discoveredFileKeySet.add(result.value.meta.file_key);
							}
						}
					}
				}

				// Merge configured + discovered, deduplicated.
				const fileKeySet = new Set<string>([...configuredFileKeys, ...discoveredFileKeySet]);

				if (fileKeySet.size === 0) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									message:
										"No team libraries found. Open the Desktop Bridge plugin in Figma and use the " +
										"Libraries section to add your library URLs or file keys, or place at least one " +
										"library component on the canvas so it can be auto-detected.",
									totalLibraries: 0,
									libraries: [],
								}),
							},
						],
					};
				}

				// Step 3: fetch full manifests for each discovered library in parallel.
				const manifestResults = await Promise.allSettled(
					Array.from(fileKeySet).map((fk) => buildManifestForFile(api, fk)),
				);

				const libraries: LibraryComponentManifest[] = [];
				for (const result of manifestResults) {
					if (result.status === "fulfilled") {
						libraries.push(result.value);
					}
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								totalLibraries: libraries.length,
								libraries,
							}),
						},
					],
				};
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: errorMessage,
								message: "Failed to fetch library components.",
								hint: "Ensure the Desktop Bridge plugin is connected and your FIGMA_ACCESS_TOKEN has access to the libraries.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
