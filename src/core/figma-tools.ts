/**
 * Figma API MCP Tools
 * MCP tool definitions for Figma REST API data extraction
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI, FigmaUrlInfo } from "./figma-api.js";
import { extractFileKey, extractFigmaUrlInfo, formatVariables, formatComponentData, withTimeout } from "./figma-api.js";
import { createChildLogger } from "./logger.js";
import { EnrichmentService } from "./enrichment/index.js";
import type { EnrichmentOptions } from "./types/enriched.js";
import { SnippetInjector } from "./snippet-injector.js";
import type { ConsoleMonitor } from "./console-monitor.js";
import { extractNodeSpec, validateReconstructionSpec, listVariants } from "./figma-reconstruction-spec.js";

const logger = createChildLogger({ component: "figma-tools" });

// Initialize enrichment service
const enrichmentService = new EnrichmentService(logger);

// Initialize snippet injector
const snippetInjector = new SnippetInjector();

// ============================================================================
// Cache Management & Data Processing Helpers
// ============================================================================

/**
 * Cache configuration
 */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 10; // LRU eviction

/**
 * Check if cache entry is still valid based on TTL
 */
function isCacheValid(timestamp: number, ttlMs: number = CACHE_TTL_MS): boolean {
	return Date.now() - timestamp < ttlMs;
}

/**
 * Rough token estimation for response size checking
 * Approximation: 1 token ≈ 4 characters for JSON
 */
function estimateTokens(data: any): number {
	const jsonString = JSON.stringify(data);
	return Math.ceil(jsonString.length / 4);
}

/**
 * Response size thresholds for adaptive verbosity
 * Based on typical Claude Desktop context window limits
 */
const RESPONSE_SIZE_THRESHOLDS = {
	// Conservative thresholds to leave room for conversation context
	IDEAL_SIZE_KB: 100,        // Target size for optimal performance
	WARNING_SIZE_KB: 200,      // Start considering compression
	CRITICAL_SIZE_KB: 500,     // Must compress to avoid context exhaustion
	MAX_SIZE_KB: 1000,         // Absolute maximum before emergency compression
} as const;

/**
 * Calculate JSON string size in KB
 */
function calculateSizeKB(data: any): number {
	const jsonString = JSON.stringify(data);
	return jsonString.length / 1024;
}

/**
 * Generic adaptive response wrapper - automatically compresses responses that exceed size thresholds
 * Can be used by any tool to prevent context window exhaustion
 *
 * @param responseData - The response data to potentially compress
 * @param options - Configuration options for compression behavior
 * @returns Response content array with optional AI instruction
 */
function adaptiveResponse(
	responseData: any,
	options: {
		toolName: string;
		compressionCallback?: (adjustedLevel: string) => any;
		suggestedActions?: string[];
	}
): { content: any[] } {
	const sizeKB = calculateSizeKB(responseData);

	// No compression needed
	if (sizeKB <= RESPONSE_SIZE_THRESHOLDS.IDEAL_SIZE_KB) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(responseData),
				},
			],
		};
	}

	// Determine compression level and message
	let compressionLevel: "info" | "warning" | "critical" | "emergency" = "info";
	let aiInstruction = "";
	let shouldCompress = false;

	if (sizeKB > RESPONSE_SIZE_THRESHOLDS.MAX_SIZE_KB) {
		compressionLevel = "emergency";
		shouldCompress = true;
		aiInstruction =
			`⚠️ RESPONSE AUTO-COMPRESSED: The ${options.toolName} response was automatically reduced because the full response would be ${sizeKB.toFixed(0)}KB, which would exhaust Claude Desktop's context window.\n\n`;
	} else if (sizeKB > RESPONSE_SIZE_THRESHOLDS.CRITICAL_SIZE_KB) {
		compressionLevel = "critical";
		shouldCompress = true;
		aiInstruction =
			`⚠️ RESPONSE AUTO-COMPRESSED: The ${options.toolName} response was automatically reduced because it would be ${sizeKB.toFixed(0)}KB, risking context window exhaustion.\n\n`;
	} else if (sizeKB > RESPONSE_SIZE_THRESHOLDS.WARNING_SIZE_KB) {
		compressionLevel = "warning";
		shouldCompress = true;
		aiInstruction =
			`ℹ️ RESPONSE OPTIMIZED: The ${options.toolName} response was automatically reduced because it would be ${sizeKB.toFixed(0)}KB.\n\n`;
	}

	// Map compression level to verbosity level
	const verbosityMap: Record<string, string> = {
		"info": "standard",
		"warning": "summary",
		"critical": "summary",
		"emergency": "inventory"
	};

	// If compression needed, apply callback to reduce data
	let finalData = responseData;
	if (shouldCompress && options.compressionCallback) {
		const targetVerbosity = verbosityMap[compressionLevel] || "summary";
		finalData = options.compressionCallback(targetVerbosity);

		// Add compression metadata
		finalData.compression = {
			originalSizeKB: Math.round(sizeKB),
			finalSizeKB: Math.round(calculateSizeKB(finalData)),
			compressionLevel,
		};

		logger.info(
			{
				tool: options.toolName,
				originalSizeKB: sizeKB.toFixed(2),
				finalSizeKB: calculateSizeKB(finalData).toFixed(2),
				compressionLevel,
			},
			"Response compressed to prevent context exhaustion"
		);
	}

	// Build AI instruction with suggested actions
	if (shouldCompress) {
		if (options.suggestedActions && options.suggestedActions.length > 0) {
			aiInstruction += `To get more detail:\n`;
			options.suggestedActions.forEach(action => {
				aiInstruction += `• ${action}\n`;
			});
		}
	}

	// Build response content
	const content: any[] = [
		{
			type: "text",
			text: JSON.stringify(finalData),
		},
	];

	// Add AI instruction as separate content block if needed
	if (aiInstruction) {
		content.unshift({
			type: "text",
			text: aiInstruction.trim(),
		});
	}

	return { content };
}

/**
 * Adaptive verbosity system - automatically downgrades verbosity based on response size
 * Returns adjusted verbosity level and compression info for AI instructions
 *
 * @deprecated Use adaptiveResponse instead for more flexible compression
 */
function adaptiveVerbosity(
	data: any,
	requestedVerbosity: "inventory" | "summary" | "standard" | "full"
): {
	adjustedVerbosity: "inventory" | "summary" | "standard" | "full";
	sizeKB: number;
	wasCompressed: boolean;
	compressionReason?: string;
	aiInstruction?: string;
} {
	const sizeKB = calculateSizeKB(data);

	// No adjustment needed - response is within ideal size
	if (sizeKB <= RESPONSE_SIZE_THRESHOLDS.IDEAL_SIZE_KB) {
		return {
			adjustedVerbosity: requestedVerbosity,
			sizeKB,
			wasCompressed: false,
		};
	}

	// Determine appropriate verbosity based on size
	let adjustedVerbosity = requestedVerbosity;
	let compressionReason = "";
	let aiInstruction = "";

	if (sizeKB > RESPONSE_SIZE_THRESHOLDS.MAX_SIZE_KB) {
		// Emergency: Force inventory mode
		adjustedVerbosity = "inventory";
		compressionReason = `Response size (${sizeKB.toFixed(0)}KB) exceeds maximum threshold (${RESPONSE_SIZE_THRESHOLDS.MAX_SIZE_KB}KB)`;
		aiInstruction =
			`⚠️ RESPONSE AUTO-COMPRESSED: The response was automatically reduced to 'inventory' verbosity (names/IDs only) because the full response would be ${sizeKB.toFixed(0)}KB, which would exhaust Claude Desktop's context window.\n\n` +
			`To get more detail:\n` +
			`• Use format='filtered' with collection/namePattern/mode filters to narrow the scope\n` +
			`• Use pagination (page=1, pageSize=20) to retrieve data in smaller chunks\n` +
			`• Use returnAsLinks=true to get resource_link references instead of full data\n\n` +
			`Current response contains variable/collection names and IDs only.`;
	} else if (sizeKB > RESPONSE_SIZE_THRESHOLDS.CRITICAL_SIZE_KB) {
		// Critical: Downgrade to summary if higher was requested
		if (requestedVerbosity === "full" || requestedVerbosity === "standard") {
			adjustedVerbosity = "summary";
			compressionReason = `Response size (${sizeKB.toFixed(0)}KB) exceeds critical threshold (${RESPONSE_SIZE_THRESHOLDS.CRITICAL_SIZE_KB}KB)`;
			aiInstruction =
				`⚠️ RESPONSE AUTO-COMPRESSED: The response was automatically reduced to 'summary' verbosity because the ${requestedVerbosity} response would be ${sizeKB.toFixed(0)}KB, risking context window exhaustion.\n\n` +
				`To get more detail, use filtering options:\n` +
				`• format='filtered' with collection='CollectionName' to focus on specific collections\n` +
				`• namePattern='color' to filter by variable name\n` +
				`• mode='Light' to filter by mode\n` +
				`• pagination with smaller pageSize values\n\n` +
				`Current response includes variable names, types, and mode information.`;
		}
	} else if (sizeKB > RESPONSE_SIZE_THRESHOLDS.WARNING_SIZE_KB) {
		// Warning: Downgrade full to standard
		if (requestedVerbosity === "full") {
			adjustedVerbosity = "standard";
			compressionReason = `Response size (${sizeKB.toFixed(0)}KB) exceeds warning threshold (${RESPONSE_SIZE_THRESHOLDS.WARNING_SIZE_KB}KB)`;
			aiInstruction =
				`ℹ️ RESPONSE OPTIMIZED: The response was automatically reduced to 'standard' verbosity because the full response would be ${sizeKB.toFixed(0)}KB.\n\n` +
				`This response includes essential variable properties. For specific details, use filtering:\n` +
				`• format='filtered' with collection/namePattern/mode filters\n` +
				`• Request verbosity='full' with specific filters to get complete data for a subset`;
		}
	}

	const wasCompressed = adjustedVerbosity !== requestedVerbosity;

	if (wasCompressed) {
		logger.info(
			{
				originalVerbosity: requestedVerbosity,
				adjustedVerbosity,
				sizeKB: sizeKB.toFixed(2),
				threshold: compressionReason,
			},
			"Adaptive compression applied"
		);
	}

	return {
		adjustedVerbosity,
		sizeKB,
		wasCompressed,
		compressionReason: wasCompressed ? compressionReason : undefined,
		aiInstruction: wasCompressed ? aiInstruction : undefined,
	};
}

/**
 * Generate compact summary of variables data (~2K tokens)
 * Returns high-level overview with counts and names
 */
function generateSummary(data: any): any {
	const summary = {
		fileKey: data.fileKey,
		timestamp: data.timestamp,
		source: data.source || 'cache',
		overview: {
			total_variables: data.variables?.length || 0,
			total_collections: data.variableCollections?.length || 0,
		},
		collections: data.variableCollections?.map((c: any) => ({
			id: c.id,
			name: c.name,
			modes: c.modes?.map((m: any) => ({ id: m.modeId, name: m.name })),
			variable_count: c.variableIds?.length || 0,
		})) || [],
		variables_by_type: {} as Record<string, number>,
		variable_names: [] as string[],
	};

	// Count variables by type
	const typeCount: Record<string, number> = {};
	const names: string[] = [];

	data.variables?.forEach((v: any) => {
		typeCount[v.resolvedType] = (typeCount[v.resolvedType] || 0) + 1;
		names.push(v.name);
	});

	summary.variables_by_type = typeCount;
	summary.variable_names = names;

	return summary;
}

/**
 * Apply filters to variables data
 */
function applyFilters(
	data: any,
	filters: {
		collection?: string;
		namePattern?: string;
		mode?: string;
	},
	verbosity: "inventory" | "summary" | "standard" | "full" = "standard"
): any {
	let filteredVariables = [...(data.variables || [])];
	let filteredCollections = [...(data.variableCollections || [])];

	// Filter by collection name or ID
	if (filters.collection) {
		const collectionFilter = filters.collection.toLowerCase();
		filteredCollections = filteredCollections.filter((c: any) =>
			c.name?.toLowerCase().includes(collectionFilter) ||
			c.id === filters.collection
		);

		const collectionIds = new Set(filteredCollections.map((c: any) => c.id));
		filteredVariables = filteredVariables.filter((v: any) =>
			collectionIds.has(v.variableCollectionId)
		);
	}

	// Filter by variable name pattern (regex or substring)
	if (filters.namePattern) {
		try {
			const regex = new RegExp(filters.namePattern, 'i');
			filteredVariables = filteredVariables.filter((v: any) =>
				regex.test(v.name)
			);
		} catch (e) {
			// If regex fails, fall back to substring match
			const pattern = filters.namePattern.toLowerCase();
			filteredVariables = filteredVariables.filter((v: any) =>
				v.name?.toLowerCase().includes(pattern)
			);
		}
	}

	// Find target mode ID if mode filter specified (needed for both filtering and transformation)
	let targetModeId: string | null = null;
	let targetModeName: string | null = null;
	if (filters.mode) {
		const modeFilter = filters.mode.toLowerCase();
		// Try direct mode ID match first
		if (data.variableCollections || filteredCollections.length > 0) {
			for (const collection of filteredCollections) {
				if (collection.modes) {
					const mode = collection.modes.find((m: any) =>
						m.modeId === filters.mode ||
						m.name?.toLowerCase().includes(modeFilter)
					);
					if (mode) {
						targetModeId = mode.modeId;
						targetModeName = mode.name;
						break;
					}
				}
			}
		}
	}

	// Filter by mode name or ID
	if (filters.mode) {
		filteredVariables = filteredVariables.filter((v: any) => {
			// Check if variable has values for the specified mode
			if (v.valuesByMode) {
				// Try to match by mode ID directly
				if (v.valuesByMode[filters.mode!]) {
					return true;
				}
				// Try using resolved targetModeId
				if (targetModeId && v.valuesByMode[targetModeId]) {
					return true;
				}
				// Try to match by mode name through collections
				const collection = filteredCollections.find((c: any) =>
					c.id === v.variableCollectionId
				);
				if (collection?.modes) {
					const mode = collection.modes.find((m: any) =>
						m.name?.toLowerCase().includes(filters.mode!.toLowerCase()) || m.modeId === filters.mode
					);
					return mode && v.valuesByMode[mode.modeId];
				}
			}
			return false;
		});
	}


	// Transform valuesByMode based on verbosity level
	// This is critical for reducing response size with multi-mode variables
	if (verbosity !== "full") {
		filteredVariables = filteredVariables.map((v: any) => {
			const variable = { ...v };
			// Use original collections array for lookup, not filtered, since we need mode metadata
			// Handle both variableCollections and collections property names
			const collections = data.variableCollections || data.collections || [];
			const collection = collections.find((c: any) => c.id === v.variableCollectionId);

			if (verbosity === "inventory") {
				// Inventory: Remove valuesByMode entirely, add mode count
				delete variable.valuesByMode;
				if (collection?.modes) {
					variable.modeCount = collection.modes.length;
				}
			} else if (verbosity === "summary") {
				// Summary: Replace valuesByMode with mode names array
				if (variable.valuesByMode && collection?.modes) {
					variable.modeNames = collection.modes.map((m: any) => m.name);
					variable.modeCount = collection.modes.length;
				}
				delete variable.valuesByMode;
			} else if (verbosity === "standard") {
				// Standard: If mode parameter specified, filter to that mode only
				if (targetModeId && variable.valuesByMode) {
					const singleModeValue = variable.valuesByMode[targetModeId];
					variable.valuesByMode = { [targetModeId]: singleModeValue };
					variable.selectedMode = {
						modeId: targetModeId,
						modeName: targetModeName,
					};
				}
				// If no mode specified, keep all valuesByMode but add metadata for context
				else if (variable.valuesByMode && collection?.modes) {
					variable.modeMetadata = collection.modes.map((m: any) => ({
						modeId: m.modeId,
						modeName: m.name,
					}));
				}
			}

			return variable;
		});

		// Apply field-level filtering based on verbosity
		if (verbosity === "inventory") {
			filteredVariables = filteredVariables.map((v: any) => ({
				id: v.id,
				name: v.name,
				resolvedType: v.resolvedType,
				variableCollectionId: v.variableCollectionId,
				...(v.modeCount && { modeCount: v.modeCount }),
			}));
		} else if (verbosity === "summary") {
			filteredVariables = filteredVariables.map((v: any) => ({
				id: v.id,
				name: v.name,
				resolvedType: v.resolvedType,
				variableCollectionId: v.variableCollectionId,
				...(v.modeNames && { modeNames: v.modeNames }),
				...(v.modeCount && { modeCount: v.modeCount }),
			}));
		} else if (verbosity === "standard") {
			filteredVariables = filteredVariables.map((v: any) => ({
				id: v.id,
				name: v.name,
				resolvedType: v.resolvedType,
				valuesByMode: v.valuesByMode,
				description: v.description,
				variableCollectionId: v.variableCollectionId,
				...(v.scopes && { scopes: v.scopes }),
				...(v.selectedMode && { selectedMode: v.selectedMode }),
				...(v.modeMetadata && { modeMetadata: v.modeMetadata }),
			}));
		}
		// For "full" verbosity, return all fields (no filtering)
	}

	// IMPORTANT: Only return filtered data, not the entire original data object
	// The ...data spread was including massive metadata that bloated responses
	return {
		variables: filteredVariables,
		variableCollections: filteredCollections,
	};
}

/**
 * Apply pagination to variables
 */
function paginateVariables(
	data: any,
	page: number = 1,
	pageSize: number = 50
): {
	data: any;
	pagination: {
		currentPage: number;
		pageSize: number;
		totalVariables: number;
		totalPages: number;
		hasNextPage: boolean;
		hasPrevPage: boolean;
	};
} {
	const variables = data.variables || [];
	const totalVariables = variables.length;
	const totalPages = Math.ceil(totalVariables / pageSize);

	// Validate page number
	const currentPage = Math.max(1, Math.min(page, totalPages || 1));

	// Calculate pagination
	const startIndex = (currentPage - 1) * pageSize;
	const endIndex = startIndex + pageSize;
	const paginatedVariables = variables.slice(startIndex, endIndex);

	return {
		data: {
			...data,
			variables: paginatedVariables,
		},
		pagination: {
			currentPage,
			pageSize,
			totalVariables,
			totalPages,
			hasNextPage: currentPage < totalPages,
			hasPrevPage: currentPage > 1,
		},
	};
}

/**
 * Manage LRU cache eviction
 */
function evictOldestCacheEntry(
	cache: Map<string, { data: any; timestamp: number }>
): void {
	if (cache.size >= MAX_CACHE_ENTRIES) {
		// Find oldest entry
		let oldestKey: string | null = null;
		let oldestTime = Infinity;

		for (const [key, entry] of cache.entries()) {
			if (entry.timestamp < oldestTime) {
				oldestTime = entry.timestamp;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			cache.delete(oldestKey);
			logger.info({ evictedKey: oldestKey }, 'Evicted oldest cache entry (LRU)');
		}
	}
}

/**
 * Resolve variable aliases to their final values for all modes
 * @param variables Array of variables to resolve
 * @param allVariablesMap Map of all variables by ID for lookup
 * @param collectionsMap Map of collections by ID for mode info
 * @returns Variables with added resolvedValuesByMode field
 */
function resolveVariableAliases(
	variables: any[],
	allVariablesMap: Map<string, any>,
	collectionsMap: Map<string, any>
): any[] {
	// Helper to format color value to hex
	const formatColorToHex = (color: any): string | null => {
		if (typeof color === 'string') return color;
		if (color && typeof color.r === 'number' && typeof color.g === 'number' && typeof color.b === 'number') {
			const r = Math.round(color.r * 255);
			const g = Math.round(color.g * 255);
			const b = Math.round(color.b * 255);
			const a = typeof color.a === 'number' ? color.a : 1;
			if (a < 1) {
				const aHex = Math.round(a * 255).toString(16).padStart(2, '0');
				return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${aHex}`.toUpperCase();
			}
			return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
		}
		return null;
	};

	// Helper to get mode ID from a mode object (handles both 'modeId' and 'id' properties)
	const getModeId = (mode: any): string | null => {
		return mode?.modeId || mode?.id || null;
	};

	// Helper to get default mode ID from a collection
	const getDefaultModeId = (collection: any, variable: any): string | null => {
		// Try explicit defaultModeId first
		if (collection?.defaultModeId) {
			return collection.defaultModeId;
		}
		// Try first mode's ID
		if (collection?.modes?.length > 0) {
			return getModeId(collection.modes[0]);
		}
		// Fallback to first key in valuesByMode
		const modeKeys = Object.keys(variable?.valuesByMode || {});
		return modeKeys.length > 0 ? modeKeys[0] : null;
	};

	// Helper to resolve a single value, following alias chains
	const resolveValue = (value: any, resolvedType: string, visited: Set<string> = new Set(), depth = 0): { resolved: any; aliasChain?: string[] } => {
		if (depth > 10) {
			logger.warn({ depth }, 'Max alias resolution depth reached');
			return { resolved: null, aliasChain: Array.from(visited) };
		}

		// Check if this is an alias
		if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
			const targetId = value.id;

			// Prevent circular references
			if (visited.has(targetId)) {
				logger.warn({ targetId, visited: Array.from(visited) }, 'Circular alias reference detected');
				return { resolved: null, aliasChain: Array.from(visited) };
			}

			visited.add(targetId);

			const targetVar = allVariablesMap.get(targetId);
			if (!targetVar) {
				logger.debug({ targetId }, 'Target variable not found in map');
				return { resolved: null, aliasChain: Array.from(visited) };
			}

			// Get the target's collection to find its default mode
			const targetCollection = collectionsMap.get(targetVar.variableCollectionId);
			const targetModeId = getDefaultModeId(targetCollection, targetVar);

			if (!targetModeId) {
				logger.debug({ targetId, collectionId: targetVar.variableCollectionId }, 'Could not determine target mode ID');
				return { resolved: null, aliasChain: Array.from(visited) };
			}

			const targetValue = targetVar.valuesByMode?.[targetModeId];
			if (targetValue === undefined) {
				logger.debug({ targetId, targetModeId, availableModes: Object.keys(targetVar.valuesByMode || {}) }, 'Target value not found for mode');
				return { resolved: null, aliasChain: Array.from(visited) };
			}

			// Recursively resolve
			const result = resolveValue(targetValue, targetVar.resolvedType, visited, depth + 1);
			return {
				resolved: result.resolved,
				aliasChain: [targetVar.name, ...(result.aliasChain || [])]
			};
		}

		// Not an alias - format the value based on type
		if (resolvedType === 'COLOR') {
			return { resolved: formatColorToHex(value) };
		}

		return { resolved: value };
	};

	// Process each variable
	return variables.map(variable => {
		const collection = collectionsMap.get(variable.variableCollectionId);
		const modes = collection?.modes || [];

		const resolvedValuesByMode: Record<string, { value: any; aliasTo?: string }> = {};

		for (const mode of modes) {
			const modeId = getModeId(mode);
			if (!modeId) continue;

			const rawValue = variable.valuesByMode?.[modeId];
			if (rawValue === undefined) continue;

			const { resolved, aliasChain } = resolveValue(rawValue, variable.resolvedType, new Set());

			const modeName = mode.name || modeId;
			resolvedValuesByMode[modeName] = {
				value: resolved,
				...(aliasChain && aliasChain.length > 0 && { aliasTo: aliasChain[0] })
			};
		}

		return {
			...variable,
			resolvedValuesByMode
		};
	});
}

/**
 * Register Figma API tools with the MCP server
 */
export function registerFigmaAPITools(
	server: McpServer,
	getFigmaAPI: () => Promise<FigmaAPI>,
	getCurrentUrl: () => string | null,
	getConsoleMonitor?: () => ConsoleMonitor | null,
	getBrowserManager?: () => any,
	ensureInitialized?: () => Promise<void>,
	variablesCache?: Map<string, { data: any; timestamp: number }>
) {
	// Tool 8: Get File Data (General Purpose)
	// NOTE: For specific use cases, consider using specialized tools:
	// - figma_get_component_for_development: For UI component implementation
	// - figma_get_file_for_plugin: For plugin development
	server.tool(
		"figma_get_file_data",
		"Get full file structure and document tree. WARNING: Can consume large amounts of tokens. NOT recommended for component descriptions (use figma_get_component instead). Best for understanding file structure or finding component nodeIds. Start with verbosity='summary' and depth=1 for initial exploration.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called. If not provided, ask the user to share their Figma file URL (they can copy it from Figma Desktop via right-click → 'Copy link')."
				),
			depth: z
				.number()
				.min(0)
				.max(3)
				.optional()
				.default(1)
				.describe(
					"How many levels of children to include (default: 1, max: 3). Start with 1 to prevent context exhaustion. Use 0 for full tree only when absolutely necessary."
				),
			verbosity: z
				.enum(["summary", "standard", "full"])
				.optional()
				.default("summary")
				.describe(
					"Controls payload size: 'summary' (IDs/names/types only, ~90% smaller - RECOMMENDED), 'standard' (essential properties, ~50% smaller), 'full' (everything). Default: summary for token efficiency."
				),
			nodeIds: z
				.array(z.string())
				.optional()
				.describe("Specific node IDs to retrieve (optional)"),
			enrich: z
				.boolean()
				.optional()
				.describe(
					"Set to true when user asks for: file statistics, health metrics, design system audit, or quality analysis. Adds statistics, health scores, and audit summaries. Default: false"
				),
		},
		async ({ fileUrl, depth, nodeIds, enrich, verbosity }) => {
			try {
				// Initialize API client (required for file data - no Desktop Bridge alternative)
				let api;
				try {
					api = await getFigmaAPI();
				} catch (apiError) {
					const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
					throw new Error(
						`Cannot retrieve file data. REST API authentication required.\n` +
						`Error: ${errorMessage}\n\n` +
						`To fix:\n` +
						`1. Local mode: Set FIGMA_ACCESS_TOKEN environment variable\n` +
						`2. Cloud mode: Authenticate via OAuth\n\n` +
						`Note: figma_get_file_data requires REST API access. ` +
						`For component-specific data, use figma_get_component which has Desktop Bridge fallback.`
					);
				}

				// Use provided URL or current URL from browser
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, depth, nodeIds, enrich, verbosity }, "Fetching file data");

				const fileData = await api.getFile(fileKey, {
					depth,
					ids: nodeIds,
				});

				// Apply verbosity filtering to reduce payload size
				const filterNode = (node: any, level: "summary" | "standard" | "full"): any => {
					if (!node) return node;

					if (level === "summary") {
						// Summary: Only IDs, names, types (~90% reduction)
						return {
							id: node.id,
							name: node.name,
							type: node.type,
							...(node.children && {
								children: node.children.map((child: any) => filterNode(child, level))
							}),
						};
					}

					if (level === "standard") {
						// Standard: Essential properties for plugin development (~50% reduction)
						const filtered: any = {
							id: node.id,
							name: node.name,
							type: node.type,
							visible: node.visible,
							locked: node.locked,
						};

						// Include bounds for layout calculations
						if (node.absoluteBoundingBox) filtered.absoluteBoundingBox = node.absoluteBoundingBox;
						if (node.size) filtered.size = node.size;

						// Include component/instance info for plugin work
						if (node.componentId) filtered.componentId = node.componentId;
						if (node.componentPropertyReferences) filtered.componentPropertyReferences = node.componentPropertyReferences;

						// Include basic styling (but not full details)
						if (node.fills && node.fills.length > 0) {
							filtered.fills = node.fills.map((fill: any) => ({
								type: fill.type,
								visible: fill.visible,
								...(fill.color && { color: fill.color }),
							}));
						}

						// Include plugin data if present
						if (node.pluginData) filtered.pluginData = node.pluginData;
						if (node.sharedPluginData) filtered.sharedPluginData = node.sharedPluginData;

						// Recursively filter children
						if (node.children) {
							filtered.children = node.children.map((child: any) => filterNode(child, level));
						}

						return filtered;
					}

					// Full: Return everything
					return node;
				};

				const filteredDocument = verbosity !== "full"
					? filterNode(fileData.document, verbosity || "standard")
					: fileData.document;

				let response: any = {
					fileKey,
					name: fileData.name,
					lastModified: fileData.lastModified,
					version: fileData.version,
					document: filteredDocument,
					components: fileData.components
						? Object.keys(fileData.components).length
						: 0,
					styles: fileData.styles
						? Object.keys(fileData.styles).length
						: 0,
					verbosity: verbosity || "standard",
					...(nodeIds && {
						requestedNodes: nodeIds,
						nodes: fileData.nodes,
					}),
				};

				// Apply enrichment if requested
				if (enrich) {
					const enrichmentOptions: EnrichmentOptions = {
						enrich: true,
						include_usage: true,
					};

					response = await enrichmentService.enrichFileData(
						{ ...response, ...fileData },
						enrichmentOptions
					);
				}

				const finalResponse = {
					...response,
					enriched: enrich || false,
				};

				// Use adaptive response to prevent context exhaustion
				return adaptiveResponse(finalResponse, {
					toolName: "figma_get_file_data",
					compressionCallback: (adjustedLevel: string) => {
						// Re-apply node filtering with lower verbosity
						const level = adjustedLevel as "summary" | "standard" | "full";
						const refiltered = {
							...finalResponse,
							document: verbosity !== "full"
								? filterNode(fileData.document, level)
								: fileData.document,
							verbosity: level,
						};
						return refiltered;
					},
					suggestedActions: [
						"Use verbosity='summary' with depth=1 for initial exploration",
						"Use verbosity='standard' for essential properties",
						"Request specific nodeIds to narrow the scope",
						"Reduce depth parameter (max 3, recommend 1-2)",
					],
				});
			} catch (error) {
				logger.error({ error }, "Failed to get file data");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve Figma file data",
									hint: "Make sure FIGMA_ACCESS_TOKEN is configured and the file is accessible",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	/**
	 * Tool 9: Get Variables (Design Tokens)
	 *
	 * WORKFLOW:
	 * - Primary: Attempts to fetch variables via Figma REST API (requires Enterprise plan)
	 * - Fallback: On 403 error, provides console-based extraction snippet
	 *
	 * TWO-CALL PATTERN (when API unavailable):
	 * 1. First call: Returns snippet + instructions (useConsoleFallback: true, default)
	 * 2. User runs snippet in Figma plugin console
	 * 3. Second call: Parses captured data (parseFromConsole: true)
	 *
	 * IMPORTANT: Snippet requires Figma Plugin API context, not browser DevTools console.
	 */
	server.tool(
		"figma_get_variables",
		"Extract design tokens and variables from a Figma file with code export support (CSS, Tailwind, TypeScript, Sass). Use when user asks for: design system tokens, variables, color/spacing values, theme data, or code exports. Handles multi-mode variables (Light/Dark themes). NOT for component metadata (use figma_get_component). Supports filtering by collection/mode/name and verbosity control to prevent token exhaustion. Enterprise plan required for Variables API; automatically falls back to Styles API or console-based extraction if unavailable.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called. If not provided, ask the user to share their Figma file URL (they can copy it from Figma Desktop via right-click → 'Copy link')."
				),
			includePublished: z
				.boolean()
				.optional()
				.default(true)
				.describe("Include published variables from libraries"),
			verbosity: z
				.enum(["inventory", "summary", "standard", "full"])
				.optional()
				.default("standard")
				.describe(
					"Controls payload size: 'inventory' (names/IDs only, ~95% smaller, use with filtered), 'summary' (names/values only, ~80% smaller), 'standard' (essential properties, ~45% smaller), 'full' (everything). Default: standard"
				),
			enrich: z
				.boolean()
				.optional()
				.describe(
					"Set to true when user asks for: CSS/Sass/Tailwind exports, code examples, design tokens, usage information, dependencies, or any export format. Adds resolved values, dependency graphs, and usage analysis. Default: false"
				),
			include_usage: z
				.boolean()
				.optional()
				.describe("Include usage in styles and components (requires enrich=true)"),
			include_dependencies: z
				.boolean()
				.optional()
				.describe("Include variable dependency graph (requires enrich=true)"),
			include_exports: z
				.boolean()
				.optional()
				.describe("Include export format examples (requires enrich=true)"),
				export_formats: z
				.array(z.enum(["css", "sass", "tailwind", "typescript", "json"]))
				.optional()
				.describe("Which code formats to generate examples for. Use when user mentions specific formats like 'CSS', 'Tailwind', 'SCSS', 'TypeScript', etc. Automatically enables enrichment."),
			format: z
				.enum(["summary", "filtered", "full"])
				.optional()
				.default("full")
				.describe(
					"Response format: 'summary' (~2K tokens with overview and names only), 'filtered' (apply collection/name/mode filters), 'full' (complete dataset from cache or fetch). " +
					"Summary is recommended for initial exploration. Full format returns all data but may be auto-summarized if >25K tokens. Default: full"
				),
			collection: z
				.string()
				.optional()
				.describe("Filter variables by collection name or ID. Case-insensitive substring match. Only applies when format='filtered'. Example: 'Primitives' or 'VariableCollectionId:123'"),
			namePattern: z
				.string()
				.optional()
				.describe("Filter variables by name using regex pattern or substring. Case-insensitive. Only applies when format='filtered'. Example: 'color/brand' or '^typography'"),
			mode: z
				.string()
				.optional()
				.describe("Filter variables by mode name or ID. Only returns variables that have values for this mode. Only applies when format='filtered'. Example: 'Light' or 'Dark'"),
			returnAsLinks: z
				.boolean()
				.optional()
				.default(false)
				.describe("Return variables as resource_link references instead of full data. Drastically reduces payload size (100+ variables = ~20KB vs >1MB). Use with figma_get_variable_by_id to fetch specific variables. Recommended for large variable sets. Default: false"),
			refreshCache: z
				.boolean()
				.optional()
				.default(false)
				.describe("Force refresh cache by fetching fresh data from Figma. Use when data may have changed since last fetch. Default: false (use cached data if available and fresh)"),
			useConsoleFallback: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					"Enable automatic fallback to console-based extraction when REST API returns 403 (Figma Enterprise plan required). " +
					"When enabled, provides a JavaScript snippet that users run in Figma's plugin console. " +
					"This is STEP 1 of a two-call workflow. After receiving the snippet, instruct the user to run it, then call this tool again with parseFromConsole=true. " +
					"Default: true. Set to false only to disable the fallback entirely."
				),
			parseFromConsole: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"Parse variables from console logs after user has executed the snippet. " +
					"This is STEP 2 of the two-call workflow. Set to true ONLY after: " +
					"(1) you received a console snippet from the first call, " +
					"(2) instructed the user to run it in Figma's PLUGIN console (Plugins → Development → Open Console or existing plugin), " +
					"(3) user confirmed they ran the snippet and saw '✅ Variables data captured!' message. " +
					"Default: false. Never set to true on the first call."
				),
			page: z
				.number()
				.int()
				.min(1)
				.optional()
				.default(1)
				.describe("Page number for paginated results (1-based). Use when response is too large (>1MB). Each page returns up to 50 variables."),
			pageSize: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.default(50)
				.describe("Number of variables per page (1-100). Default: 50. Smaller values reduce response size."),
			resolveAliases: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"Automatically resolve variable aliases to their final values (hex colors, numbers, etc.). " +
					"When true, each variable will include a 'resolvedValuesByMode' field with the actual values " +
					"instead of just alias references. Useful for getting color hex values without manual resolution. " +
					"Default: false."
				),
		},
		async ({
			fileUrl,
			includePublished,
			verbosity,
			enrich,
			include_usage,
			include_dependencies,
			include_exports,
			export_formats,
			format,
			collection,
			namePattern,
			mode,
			returnAsLinks,
			refreshCache,
			useConsoleFallback,
			parseFromConsole,
			page,
			pageSize,
			resolveAliases
		}) => {
			// Extract fileKey and optional branchId outside try block so they're available in catch block
			const url = fileUrl || getCurrentUrl();
			if (!url) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: "No Figma file URL provided",
									message: "Either pass fileUrl parameter or call figma_navigate first."
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}

			// Use extractFigmaUrlInfo to get fileKey, branchId, and nodeId
			const urlInfo = extractFigmaUrlInfo(url);
			if (!urlInfo) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: `Invalid Figma URL: ${url}`,
									message: "Could not extract file key from URL"
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}

			// For branch URLs, the branchId IS the file key to use for API calls
			// Figma branch URLs contain the branch key directly in the path
			const fileKey = urlInfo.branchId || urlInfo.fileKey;
			const mainFileKey = urlInfo.fileKey;
			const branchId = urlInfo.branchId;

			if (branchId) {
				logger.info({ mainFileKey, branchId, effectiveFileKey: fileKey }, 'Branch URL detected, using branch key for API calls');
			}

			try {
				// =====================================================================
				// CACHE-FIRST LOGIC: Check if we have cached data before fetching
				// =====================================================================
				let cachedData: any = null;
				let shouldFetch = true;

				if (variablesCache && !parseFromConsole) {
					const cacheEntry = variablesCache.get(fileKey);

					if (cacheEntry) {
						const isValid = isCacheValid(cacheEntry.timestamp);

						if (isValid && !refreshCache) {
							// Cache hit! Use cached data
							cachedData = cacheEntry.data;
							shouldFetch = false;

							logger.info(
								{
									fileKey,
									cacheAge: Date.now() - cacheEntry.timestamp,
									variableCount: cachedData.variables?.length,
								},
								'Using cached variables data'
							);
						} else if (!isValid) {
							logger.info({ fileKey, cacheAge: Date.now() - cacheEntry.timestamp }, 'Cache expired, will refresh');
						} else if (refreshCache) {
							logger.info({ fileKey }, 'Refresh cache requested, will fetch fresh data');
						}
					} else {
						logger.info({ fileKey }, 'No cache entry found, will fetch data');
					}
				}

				// If we have cached data, skip fetching and jump to formatting
				if (cachedData && !shouldFetch) {
					// Apply format logic based on user request
					let responseData = cachedData;
					let paginationInfo: any = null;

					if (format === 'summary') {
						// Return compact summary
						responseData = generateSummary(cachedData);
						logger.info({ fileKey, estimatedTokens: estimateTokens(responseData) }, 'Generated summary from cache');
					} else if (format === 'filtered') {
						// Apply filters with verbosity-aware valuesByMode transformation
						responseData = applyFilters(cachedData, {
							collection,
							namePattern,
							mode,
						}, verbosity || 'standard');

						// ALWAYS apply pagination for filtered results to prevent 1MB limit
						// Default to page 1, pageSize 50 if not specified
						const paginated = paginateVariables(
							responseData,
							page || 1,
							pageSize || 50
						);
						responseData = paginated.data;
						paginationInfo = paginated.pagination;

						// Apply verbosity filtering to minimize payload size
						// For filtered results, default to "inventory" for maximum size reduction
						const effectiveVerbosity = verbosity || "inventory";

						// CRITICAL FIX: Only include collections referenced by paginated variables
						const referencedCollectionIds = new Set(
							responseData.variables.map((v: any) => v.variableCollectionId)
						);
						responseData.variableCollections = responseData.variableCollections.filter(
							(c: any) => referencedCollectionIds.has(c.id)
						);

						// Filter variables to minimal needed fields
						responseData.variables = responseData.variables.map((v: any) => {
							if (effectiveVerbosity === "inventory") {
								// Ultra-minimal: just names and IDs for inventory purposes
								// If mode filter is specified, include only that mode's value
								const result: any = {
									id: v.id,
									name: v.name,
									collectionId: v.variableCollectionId,
								};

								// If mode filter specified, include just that single mode's value
								if (mode && v.valuesByMode) {
									// Find the mode ID from the collection
									const collection = responseData.variableCollections.find((c: any) =>
										c.id === v.variableCollectionId
									);
									if (collection?.modes) {
										const modeObj = collection.modes.find((m: any) =>
											m.name?.toLowerCase().includes(mode.toLowerCase()) || m.modeId === mode
										);
										if (modeObj && v.valuesByMode[modeObj.modeId]) {
											result.value = v.valuesByMode[modeObj.modeId];
											result.mode = modeObj.name;
										}
									}
								}
								return result;
							}
							if (effectiveVerbosity === "summary") {
								return {
									id: v.id,
									name: v.name,
									resolvedType: v.resolvedType,
									valuesByMode: v.valuesByMode,
									variableCollectionId: v.variableCollectionId,
									// Include modeNames and modeCount added by applyFilters
									...(v.modeNames && { modeNames: v.modeNames }),
									...(v.modeCount && { modeCount: v.modeCount }),
								};
							}
							if (effectiveVerbosity === "standard") {
								return {
									id: v.id,
									name: v.name,
									resolvedType: v.resolvedType,
									valuesByMode: v.valuesByMode,
									description: v.description,
									variableCollectionId: v.variableCollectionId,
								};
							}
							return v; // full
						});

						// Filter collections to remove massive variableIds arrays
						responseData.variableCollections = responseData.variableCollections.map((c: any) => {
							if (effectiveVerbosity === "inventory") {
								// Ultra-minimal: just ID and name, mode names only (no full mode objects)
								return {
									id: c.id,
									name: c.name,
									modeNames: c.modes?.map((m: any) => m.name) || [],
								};
							}
							if (effectiveVerbosity === "summary") {
								return {
									id: c.id,
									name: c.name,
									modes: c.modes, // Keep modes for user to understand mode structure
								};
							}
							if (effectiveVerbosity === "standard") {
								return {
									id: c.id,
									name: c.name,
									modes: c.modes,
									defaultModeId: c.defaultModeId,
								};
							}
							// For full, remove variableIds array to reduce size
							const { variableIds, ...rest } = c;
							return rest;
						});

						logger.info(
							{
								fileKey,
								originalCount: cachedData.variables?.length,
								filteredCount: paginationInfo.totalVariables,
								returnedCount: responseData.variables?.length,
								page: paginationInfo.currentPage,
								totalPages: paginationInfo.totalPages,
								verbosity: effectiveVerbosity,
							},
							'Applied filters, pagination, and verbosity filtering to cached data'
						);

						// Apply alias resolution if requested
						if (resolveAliases && responseData.variables?.length > 0) {
							// Build maps from ALL cached variables (not just filtered) for resolution
							const allVariablesMap = new Map<string, any>();
							const collectionsMap = new Map<string, any>();

							for (const v of cachedData.variables || []) {
								allVariablesMap.set(v.id, v);
							}
							for (const c of cachedData.variableCollections || []) {
								collectionsMap.set(c.id, c);
							}

							responseData.variables = resolveVariableAliases(
								responseData.variables,
								allVariablesMap,
								collectionsMap
							);

							logger.info(
								{ fileKey, resolvedCount: responseData.variables.length },
								'Applied alias resolution to filtered variables'
							);
						}
					} else {
						// format === 'full'
						// Check if we need to auto-summarize
						const estimatedTokens = estimateTokens(responseData);
						if (estimatedTokens > 25000) {
							logger.warn(
								{ fileKey, estimatedTokens },
								'Full data exceeds MCP token limit (25K), auto-summarizing. Use format=summary or format=filtered to get specific data.'
							);
							const summary = generateSummary(responseData);
							return {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												fileKey,
												source: 'cache_auto_summarized',
												warning: 'Full dataset exceeds MCP token limit (25,000 tokens)',
												suggestion: 'Use format="summary" for overview or format="filtered" with collection/namePattern/mode filters to get specific variables',
												estimatedTokens,
												summary,
											},
											null,
											2
										),
									},
								],
							};
						}
					}

					// Apply alias resolution for 'full' format if not already applied (filtered format handles it above)
					if (resolveAliases && format !== 'filtered' && responseData.variables?.length > 0) {
						// Build maps from ALL cached variables for resolution
						const allVariablesMap = new Map<string, any>();
						const collectionsMap = new Map<string, any>();

						for (const v of cachedData.variables || []) {
							allVariablesMap.set(v.id, v);
						}
						for (const c of cachedData.variableCollections || []) {
							collectionsMap.set(c.id, c);
						}

						responseData.variables = resolveVariableAliases(
							responseData.variables,
							allVariablesMap,
							collectionsMap
						);

						logger.info(
							{ fileKey, resolvedCount: responseData.variables.length, format },
							'Applied alias resolution to variables (full/summary format)'
						);
					}

					// Return cached/processed data
					// If returnAsLinks=true, return resource_link references instead of full data
					if (returnAsLinks) {
						const summary = {
							fileKey,
							source: 'cache',
							totalVariables: responseData.variables?.length || 0,
							totalCollections: responseData.variableCollections?.length || 0,
							...(paginationInfo && { pagination: paginationInfo }),
						};

						// Build resource_link content for each variable
						const content: any[] = [
							{
								type: "text",
								text: JSON.stringify(summary),
							},
						];

						// Add resource_link for each variable (minimal overhead ~150 bytes each)
						responseData.variables?.forEach((v: any) => {
							content.push({
								type: "resource_link",
								uri: `figma://variable/${v.id}`,
								name: v.name || v.id,
								description: `${v.resolvedType || 'VARIABLE'} from ${fileKey}`,
							});
						});

						logger.info(
							{
								fileKey,
								format: 'resource_links',
								variableCount: responseData.variables?.length || 0,
								linkCount: content.length - 1, // -1 for summary text
								estimatedSizeKB: (content.length * 150) / 1024,
							},
							`Returning variables as resource_links`
						);

						return { content };
					}

					// Default: return full data
					const responsePayload = {
						fileKey,
						source: 'cache',
						format: format || 'full',
						timestamp: cachedData.timestamp,
						data: responseData,
						...(paginationInfo && { pagination: paginationInfo }),
					};
					// Remove pretty printing to reduce payload size by 30-40%
					const responseText = JSON.stringify(responsePayload);
					const responseSizeBytes = Buffer.byteLength(responseText, 'utf8');
					const responseSizeMB = (responseSizeBytes / (1024 * 1024)).toFixed(2);

					logger.info(
						{
							fileKey,
							format: format || 'full',
							verbosity: verbosity || 'standard',
							variableCount: responseData.variables?.length || 0,
							collectionCount: responseData.variableCollections?.length || 0,
							responseSizeBytes,
							responseSizeMB: `${responseSizeMB} MB`,
							isUnder1MB: responseSizeBytes < 1024 * 1024,
						},
						`Response size check: ${responseSizeMB} MB`
					);

					return {
						content: [
							{
								type: "text",
								text: responseText,
							},
						],
					};
				}

				// =====================================================================
				// FETCH LOGIC: No cache or cache invalid/refresh requested
				// =====================================================================

				// Check if REST API token is available (determines priority)
				const hasToken = !!process.env.FIGMA_ACCESS_TOKEN;
				let restApiSucceeded = false;

				// PRIORITY LOGIC:
				// 1. If token exists → Try REST API FIRST (enterprise users)
				// 2. If no token OR REST API fails → Try Desktop Bridge as fallback
				logger.info({ hasToken }, "Authentication method detection");

				// Try REST API first if token is available
				if (hasToken && !parseFromConsole) {
					try {
						logger.info({ fileKey, includePublished, verbosity, enrich }, "Fetching variables via REST API (priority: token detected)");
						const api = await getFigmaAPI();

						// Wrap API call with timeout to prevent indefinite hangs (30s timeout)
						const { local, published } = await withTimeout(
							api.getAllVariables(fileKey),
							30000,
							'Figma Variables API'
						);

						let localFormatted = formatVariables(local);
						let publishedFormatted = includePublished
							? formatVariables(published)
							: null;

						// DEBUG: Check if valuesByMode exists before filtering
						if (localFormatted.variables[0]) {
							logger.info(
								{
									hasValuesByMode: !!localFormatted.variables[0].valuesByMode,
									variableKeys: Object.keys(localFormatted.variables[0]),
									collectionCount: localFormatted.collections?.length,
								},
								'Variable structure before filtering'
							);
						}

						// Apply collection/name/mode filtering if format is 'filtered'
						if (format === 'filtered') {
							// Create properly structured data for applyFilters
							const dataToFilter = {
								variables: localFormatted.variables,
								variableCollections: localFormatted.collections,
							};

							const filteredLocal = applyFilters(
								dataToFilter,
								{ collection, namePattern, mode },
								verbosity || "standard"
							);

							localFormatted = {
								summary: localFormatted.summary,
								collections: filteredLocal.variableCollections,
								variables: filteredLocal.variables,
							};

							// Also filter published if included
							if (includePublished && publishedFormatted) {
								const dataToFilterPublished = {
									variables: publishedFormatted.variables,
									variableCollections: publishedFormatted.collections,
								};

								const filteredPublished = applyFilters(
									dataToFilterPublished,
									{ collection, namePattern, mode },
									verbosity || "standard"
								);

								publishedFormatted = {
									summary: publishedFormatted.summary,
									collections: filteredPublished.variableCollections,
									variables: filteredPublished.variables,
								};
							}
						}

						// Apply verbosity filtering after collection/name/mode filters
						if (verbosity && verbosity !== 'full') {
							const verbosityFiltered = applyFilters(
								{
									variables: localFormatted.variables,
									variableCollections: localFormatted.collections,
								},
								{},
								verbosity
							);

							localFormatted = {
								...localFormatted,
								collections: verbosityFiltered.variableCollections,
								variables: verbosityFiltered.variables,
							};

							if (includePublished && publishedFormatted) {
								const verbosityFilteredPublished = applyFilters(
									{
										variables: publishedFormatted.variables,
										variableCollections: publishedFormatted.collections,
									},
									{},
									verbosity
								);

								publishedFormatted = {
									...publishedFormatted,
									collections: verbosityFilteredPublished.variableCollections,
									variables: verbosityFilteredPublished.variables,
								};
							}
						}

						// Apply pagination if requested
						let paginationInfo;
						if (pageSize) {
							const startIdx = (page - 1) * pageSize;
							const endIdx = startIdx + pageSize;
							const totalVars = localFormatted.variables.length;

							paginationInfo = {
								page,
								pageSize,
								totalItems: totalVars,
								totalPages: Math.ceil(totalVars / pageSize),
								hasNextPage: endIdx < totalVars,
								hasPrevPage: page > 1,
							};

							localFormatted.variables = localFormatted.variables.slice(startIdx, endIdx);

							if (includePublished && publishedFormatted) {
								publishedFormatted.variables = publishedFormatted.variables.slice(startIdx, endIdx);
							}
						}


						// Cache the successful REST API response
						const dataForCache = {
							fileKey,
							local: {
								summary: localFormatted.summary,
								collections: localFormatted.collections,
								variables: localFormatted.variables,
							},
							...(includePublished &&
								publishedFormatted && {
									published: {
										summary: publishedFormatted.summary,
										collections: publishedFormatted.collections,
										variables: publishedFormatted.variables,
									},
								}),
							verbosity: verbosity || "standard",
							enriched: enrich || false,
							timestamp: Date.now(),
							source: "rest_api",
						};

						if (variablesCache) {
							variablesCache.set(fileKey, { data: dataForCache, timestamp: Date.now() });
							logger.info({ fileKey }, "Cached REST API variables");
						}

						// Apply alias resolution if requested (REST API format has local.variables)
						if (resolveAliases && localFormatted.variables?.length > 0) {
							// Build maps from local variables and collections
							const allVariablesMap = new Map<string, any>();
							const collectionsMap = new Map<string, any>();

							for (const v of localFormatted.variables || []) {
								allVariablesMap.set(v.id, v);
							}
							for (const c of localFormatted.collections || []) {
								collectionsMap.set(c.id, c);
							}

							// Also include published variables if available
							if (publishedFormatted?.variables) {
								for (const v of publishedFormatted.variables) {
									allVariablesMap.set(v.id, v);
								}
							}
							if (publishedFormatted?.collections) {
								for (const c of publishedFormatted.collections) {
									collectionsMap.set(c.id, c);
								}
							}

							localFormatted.variables = resolveVariableAliases(
								localFormatted.variables,
								allVariablesMap,
								collectionsMap
							);

							if (publishedFormatted?.variables) {
								publishedFormatted.variables = resolveVariableAliases(
									publishedFormatted.variables,
									allVariablesMap,
									collectionsMap
								);
							}

							logger.info(
								{ fileKey, resolvedCount: localFormatted.variables.length },
								'Applied alias resolution to REST API variables'
							);
						}

						// Handle resource_links format
						if (returnAsLinks) {
							const content: any[] = [
								{
									type: "text",
									text: `Variables for file ${fileKey} (${localFormatted.variables.length} variables). Use figma_get_variable_by_id to fetch specific variables:\n\n`,
								},
							];

							for (const variable of localFormatted.variables) {
								content.push({
									type: "resource",
									resource: {
										uri: `figma://variable/${fileKey}/${variable.id}`,
										mimeType: "application/json",
										text: `${variable.name} (${variable.resolvedType})`,
									},
								});
							}

							logger.info(
								{
									fileKey,
									format: 'resource_links',
									variableCount: localFormatted.variables.length,
									linkCount: content.length - 1,
								},
								`Returning REST API variables as resource_links`
							);

							return { content };
						}

						// Build initial response data
						const responseData = {
							fileKey,
							local: {
								summary: localFormatted.summary,
								collections: localFormatted.collections,
								variables: localFormatted.variables,
							},
							...(includePublished &&
								publishedFormatted && {
									published: {
										summary: publishedFormatted.summary,
										collections: publishedFormatted.collections,
										variables: publishedFormatted.variables,
									},
								}),
							verbosity: verbosity || "standard",
							enriched: enrich || false,
							...(paginationInfo && { pagination: paginationInfo }),
						};

						// Mark REST API as successful
						restApiSucceeded = true;
						logger.info({ fileKey }, "REST API fetch successful, skipping Desktop Bridge");

						// Use adaptive response to prevent context exhaustion
						return adaptiveResponse(responseData, {
							toolName: "figma_get_variables",
							compressionCallback: (adjustedLevel: string) => {
								// Re-apply filters with adjusted verbosity
								const level = adjustedLevel as "inventory" | "summary" | "standard" | "full";
								const refiltered = applyFilters(
									{
										variables: localFormatted.variables,
										variableCollections: localFormatted.collections,
									},
									{ collection, namePattern, mode },
									level
								);

								return {
									...responseData,
									local: {
										...responseData.local,
										variables: refiltered.variables,
										collections: refiltered.variableCollections,
									},
									verbosity: level,
								};
							},
							suggestedActions: [
								"Use verbosity='inventory' or 'summary' for large variable sets",
								"Apply filters: collection, namePattern, or mode parameters",
								"Use pagination with pageSize parameter (default 50, max 100)",
								"Use returnAsLinks=true to get resource_link references instead of full data",
							],
						});
					} catch (restError) {
						const errorMessage = restError instanceof Error ? restError.message : String(restError);

						// Detect specific error types for better logging and handling
						const isTimeout = errorMessage.includes('timed out');
						const isRateLimit = errorMessage.includes('429') || errorMessage.toLowerCase().includes('rate limit');
						const isAuthError = errorMessage.includes('403') || errorMessage.includes('401');

						if (isTimeout) {
							logger.warn({ error: errorMessage, fileKey }, "REST API timed out after 30s, falling back to Desktop Bridge");
						} else if (isRateLimit) {
							logger.warn({ error: errorMessage, fileKey }, "REST API rate limited (429), falling back to Desktop Bridge");
						} else if (isAuthError) {
							logger.warn({ error: errorMessage, fileKey }, "REST API auth error, check FIGMA_ACCESS_TOKEN validity");
						} else {
							logger.warn({ error: errorMessage, fileKey }, "REST API failed, will try Desktop Bridge fallback");
						}
						// Don't throw - fall through to Desktop Bridge
					}
				}

				// FALLBACK: Try Desktop connection (when no token available OR as secondary fallback)
				// Ensure browser manager is initialized
				if (ensureInitialized && !parseFromConsole && (!hasToken || !restApiSucceeded)) {
					logger.info("Calling ensureInitialized to initialize browser manager");
					await ensureInitialized();
				}

				const browserManager = getBrowserManager?.();
				logger.info({ hasBrowserManager: !!browserManager, parseFromConsole, hasToken, restApiSucceeded }, "Desktop connection check");

				// Debug: Log why Desktop connection might be skipped
				if (!browserManager) {
					logger.error("Desktop connection skipped: browserManager is not available");
				} else if (parseFromConsole) {
					logger.info("Desktop connection skipped: parseFromConsole is true");
				} else if (restApiSucceeded) {
					logger.info("Desktop connection skipped: REST API already succeeded");
				}

				if (browserManager && !parseFromConsole && (!hasToken || !restApiSucceeded)) {
					try {
						logger.info({ fileKey }, "Attempting to get variables via Desktop connection");

						// Import and use the Desktop connector
						const { FigmaDesktopConnector } = await import('./figma-desktop-connector.js');
						const page = await browserManager.getPage();
						logger.info("Got page from browser manager");

						// Log to browser console for MCP capture
						await page.evaluate(() => {
							console.log('[FIGMA_TOOLS] 🚀 Got page from browser manager, creating Desktop connector...');
						});

						const connector = new FigmaDesktopConnector(page);

						await page.evaluate(() => {
							console.log('[FIGMA_TOOLS] ✅ Desktop connector created, initializing...');
						});

						await connector.initialize();
						logger.info("Desktop connector initialized, calling getVariablesFromPluginUI...");

						await page.evaluate(() => {
							console.log('[FIGMA_TOOLS] ✅ Desktop connector initialized, calling getVariablesFromPluginUI...');
						});

						const desktopResult = await connector.getVariablesFromPluginUI(fileKey);

						if (desktopResult.success && desktopResult.variables) {
							logger.info(
								{
									variableCount: desktopResult.variables.length,
									collectionCount: desktopResult.variableCollections?.length
								},
								"Successfully retrieved variables via Desktop connection!"
							);

							// Prepare data for caching (using the raw data, not enriched)
							const dataForCache = {
								fileKey,
								source: "desktop_connection",
								timestamp: desktopResult.timestamp || Date.now(),
								variables: desktopResult.variables,
								variableCollections: desktopResult.variableCollections,
							};

							// Store in cache with LRU eviction
							if (variablesCache) {
								evictOldestCacheEntry(variablesCache);
								variablesCache.set(fileKey, {
									data: dataForCache,
									timestamp: Date.now(),
								});
								logger.info(
									{ fileKey, cacheSize: variablesCache.size },
									'Stored variables in cache'
								);
							}

							// Apply format logic
							let responseData = dataForCache;

							if (format === 'summary') {
								responseData = generateSummary(dataForCache);
								logger.info({ fileKey, estimatedTokens: estimateTokens(responseData) }, 'Generated summary from fetched data');
							} else if (format === 'filtered') {
								// Apply filters with verbosity-aware valuesByMode transformation
								responseData = applyFilters(dataForCache, {
									collection,
									namePattern,
									mode,
								}, verbosity || 'standard');
								logger.info(
									{
										fileKey,
										originalCount: dataForCache.variables?.length,
										filteredCount: responseData.variables?.length,
									},
									'Applied filters to fetched data'
								);

								// Apply pagination (CRITICAL - was missing!)
								let paginationInfo: any = null;
								const paginated = paginateVariables(
									responseData,
									page || 1,
									pageSize || 50
								);
								responseData = paginated.data;
								paginationInfo = paginated.pagination;

								// Apply verbosity filtering (CRITICAL - was missing!)
								const effectiveVerbosity = verbosity || "inventory";

								// Only include collections referenced by paginated variables
								const referencedCollectionIds = new Set(
									responseData.variables.map((v: any) => v.variableCollectionId)
								);
								responseData.variableCollections = responseData.variableCollections.filter(
									(c: any) => referencedCollectionIds.has(c.id)
								);

								// Filter variables by verbosity
								responseData.variables = responseData.variables.map((v: any) => {
									if (effectiveVerbosity === "inventory") {
										return {
											id: v.id,
											name: v.name,
											collectionId: v.variableCollectionId,
										};
									}
									if (effectiveVerbosity === "summary") {
										return {
											id: v.id,
											name: v.name,
											resolvedType: v.resolvedType,
											valuesByMode: v.valuesByMode,
											variableCollectionId: v.variableCollectionId,
										};
									}
									return v; // standard/full
								});

								// Filter collections by verbosity
								responseData.variableCollections = responseData.variableCollections.map((c: any) => {
									if (effectiveVerbosity === "inventory") {
										return {
											id: c.id,
											name: c.name,
											modeNames: c.modes?.map((m: any) => m.name) || [],
										};
									}
									if (effectiveVerbosity === "summary") {
										return {
											id: c.id,
											name: c.name,
											modes: c.modes,
										};
									}
									return c; // standard/full
								});
							} else {
								// format === 'full'
								// Check if we need to auto-summarize
								const estimatedTokens = estimateTokens(responseData);
								if (estimatedTokens > 25000) {
									logger.warn(
										{ fileKey, estimatedTokens },
										'Full data exceeds MCP token limit (25K), auto-summarizing. Use format=summary or format=filtered to get specific data.'
									);
									const summary = generateSummary(responseData);
									return {
										content: [
											{
												type: "text",
												text: JSON.stringify(
													{
														fileKey,
														source: 'desktop_connection_auto_summarized',
														warning: 'Full dataset exceeds MCP token limit (25,000 tokens)',
														suggestion: 'Use format="summary" for overview or format="filtered" with collection/namePattern/mode filters to get specific variables',
														estimatedTokens,
														summary,
													}
												),
											},
										],
									};
								}
							}

							// Apply alias resolution if requested
							if (resolveAliases && responseData.variables?.length > 0) {
								// Build maps from ALL variables for resolution
								const allVariablesMap = new Map<string, any>();
								const collectionsMap = new Map<string, any>();

								for (const v of dataForCache.variables || []) {
									allVariablesMap.set(v.id, v);
								}
								for (const c of dataForCache.variableCollections || []) {
									collectionsMap.set(c.id, c);
								}

								responseData.variables = resolveVariableAliases(
									responseData.variables,
									allVariablesMap,
									collectionsMap
								);

								logger.info(
									{ fileKey, resolvedCount: responseData.variables.length },
									'Applied alias resolution to Desktop variables'
								);
							}

							// If returnAsLinks=true, return resource_link references
							if (returnAsLinks) {
								const summary = {
									fileKey,
									source: 'desktop_connection',
									totalVariables: responseData.variables?.length || 0,
									totalCollections: responseData.variableCollections?.length || 0,
								};

								const content: any[] = [
									{
										type: "text",
										text: JSON.stringify(summary),
									},
								];

								// Add resource_link for each variable
								responseData.variables?.forEach((v: any) => {
									content.push({
										type: "resource_link",
										uri: `figma://variable/${v.id}`,
										name: v.name || v.id,
										description: `${v.resolvedType || 'VARIABLE'} from ${fileKey}`,
									});
								});

								logger.info(
									{
										fileKey,
										format: 'resource_links',
										variableCount: responseData.variables?.length || 0,
										linkCount: content.length - 1,
									},
									`Returning Desktop variables as resource_links`
								);

								return { content };
							}

							// Default: return full data (removed pretty printing)
							return {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												fileKey,
												source: "desktop_connection",
												format: format || 'full',
												timestamp: dataForCache.timestamp,
												data: responseData,
												cached: true,
											}
										),
									},
								],
							};
						}
					} catch (desktopError) {
						const errorMessage = desktopError instanceof Error ? desktopError.message : String(desktopError);
						const errorStack = desktopError instanceof Error ? desktopError.stack : undefined;

						logger.error({
							error: desktopError,
							message: errorMessage,
							stack: errorStack
						}, "Desktop connection failed, falling back to other methods");

						// Try to log to browser console if we have access to page
						try {
							if (browserManager) {
								const page = await browserManager.getPage();
								await page.evaluate((msg: string, stack: string | undefined) => {
									console.error('[FIGMA_TOOLS] ❌ Desktop connection failed:', msg);
									if (stack) {
										console.error('[FIGMA_TOOLS] Stack trace:', stack);
									}
								}, errorMessage, errorStack);
							}
						} catch (logError) {
							// Ignore logging errors
						}

						// Continue to try other methods
					}
				}

				// FALLBACK: Parse from console logs if requested
				if (parseFromConsole) {
					const consoleMonitor = getConsoleMonitor?.();
					if (!consoleMonitor) {
						throw new Error("Console monitoring not available. Make sure browser is connected to Figma.");
					}

					logger.info({ fileKey }, "Parsing variables from console logs");

					// Get recent logs
					const logs = consoleMonitor.getLogs({ count: 100, level: "log" });
					const varLog = snippetInjector.findVariablesLog(logs);

					if (!varLog) {
						throw new Error(
							"No variables found in console logs.\n\n" +
							"Did you run the snippet in Figma's plugin console? Here's the correct workflow:\n\n" +
							"1. Call figma_get_variables() without parameters (you may have already done this)\n" +
							"2. Copy the provided snippet\n" +
							"3. Open Figma Desktop → Plugins → Development → Open Console\n" +
							"4. Paste and run the snippet in the PLUGIN console (not browser DevTools)\n" +
							"5. Wait for '✅ Variables data captured!' confirmation\n" +
							"6. Then call figma_get_variables({ parseFromConsole: true })\n\n" +
							"Note: The browser console won't work - you need a plugin console for the figma.variables API."
						);
					}

					// Parse variables from log
					const parsedData = snippetInjector.parseVariablesFromLog(varLog);

					if (!parsedData) {
						throw new Error("Failed to parse variables from console log");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										fileKey,
										source: "console_capture",
										local: {
											summary: {
												total_variables: parsedData.variables.length,
												total_collections: parsedData.variableCollections.length,
											},
											collections: parsedData.variableCollections,
											variables: parsedData.variables,
										},
										timestamp: parsedData.timestamp,
										enriched: false,
									},
									null,
									2
								),
							},
						],
					};
				}

				// No more fallback options available
				throw new Error(
					`Cannot retrieve variables. All methods failed.\n\n` +
					`Tried methods:\n` +
					`${hasToken ? '✗ REST API (failed)\n' : ''}` +
					`✗ Desktop Bridge (failed or not available)\n` +
					`\nTo fix:\n` +
					`1. If you have FIGMA_ACCESS_TOKEN: Check your token permissions\n` +
					`2. Install and run the Figma Desktop Bridge plugin\n` +
					`3. Alternative: Use parseFromConsole=true with console snippet workflow`
				);
			} catch (error) {
				logger.error({ error }, "Failed to get variables");
				const errorMessage =
					error instanceof Error ? error.message : String(error);

				// FIXED: Jump directly to Styles API (fast) instead of full file data (slow)
				if (errorMessage.includes("403")) {
					try {
						logger.info({ fileKey }, "Variables API requires Enterprise, falling back to Styles API");

						let api;
						try {
							api = await getFigmaAPI();
						} catch (apiError) {
							const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
							throw new Error(
								`Cannot retrieve variables or styles. REST API authentication required for both.\n` +
								`Error: ${errorMessage}\n\n` +
								`To fix:\n` +
								`1. Local mode: Set FIGMA_ACCESS_TOKEN environment variable\n` +
								`2. Cloud mode: Authenticate via OAuth`
							);
						}
						// Use the Styles API directly - much faster than getFile!
						const stylesData = await api.getStyles(fileKey);

						// Format the styles data similar to variables
						const formattedStyles = {
							summary: {
								total_styles: stylesData.meta?.styles?.length || 0,
								message: "Variables API requires Enterprise. Here are your design styles instead.",
								note: "These are Figma Styles (not Variables). Styles are the traditional way to store design tokens in Figma."
							},
							styles: stylesData.meta?.styles || []
						};

						logger.info(
							{ styleCount: formattedStyles.summary.total_styles },
							"Successfully retrieved styles as fallback!"
						);

						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											fileKey,
											source: "styles_api",
											message: "Variables API requires an Enterprise plan. Retrieved your design system styles instead.",
											data: formattedStyles,
											fallback_method: true,
										},
										null,
										2
									),
								},
							],
						};
					} catch (styleError) {
						logger.warn({ error: styleError }, "Style extraction failed");

						// Return a simple error message without the console snippet
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											error: "Unable to extract variables or styles from this file",
											message: "The Variables API requires an Enterprise plan, and the automatic style extraction encountered an error.",
											possibleReasons: [
												"The file may be private or require additional permissions",
												"The file structure may not contain extractable styles",
												"There may be a network or authentication issue"
											],
											suggestion: "Please ensure the file is accessible and try again, or check if your token has the necessary permissions.",
											technical: styleError instanceof Error ? styleError.message : String(styleError)
										},
										null,
										2
									),
								},
							],
						};
					}
				}

				// Standard error response
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve Figma variables",
									hint: errorMessage.includes("403")
										? "Variables API requires Enterprise plan. Set useConsoleFallback=true for alternative method."
										: "Make sure FIGMA_ACCESS_TOKEN is configured and has appropriate permissions",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 10: Get Component Data
	server.tool(
		"figma_get_component",
		"Get component metadata or reconstruction specification. Two export formats: (1) 'metadata' (default) - comprehensive documentation with properties, variants, and design tokens for style guides and references, (2) 'reconstruction' - node tree specification compatible with Figma Component Reconstructor plugin for programmatic component creation. IMPORTANT: For local/unpublished components with metadata format, ensure the Figma Desktop Bridge plugin is running (Right-click in Figma → Plugins → Development → Figma Desktop Bridge) to get complete description data.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called. If not provided, ask the user to share their Figma file URL (they can copy it from Figma Desktop via right-click → 'Copy link')."
				),
			nodeId: z
				.string()
				.describe("Component node ID (e.g., '123:456')"),
			format: z
				.enum(["metadata", "reconstruction"])
				.optional()
				.default("metadata")
				.describe(
					"Export format: 'metadata' (default) for comprehensive documentation, 'reconstruction' for node tree specification compatible with Figma Component Reconstructor plugin"
				),
			enrich: z
				.boolean()
				.optional()
				.describe(
					"Set to true when user asks for: design token coverage, hardcoded value analysis, or component quality metrics. Adds token coverage analysis and hardcoded value detection. Default: false. Only applicable for metadata format."
				),
		},
		async ({ fileUrl, nodeId, format = "metadata", enrich }) => {
			try {
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, nodeId, format, enrich }, "Fetching component data");

				// PRIORITY 1: Try Desktop Bridge plugin UI first (has reliable description field!)
				if (getBrowserManager && ensureInitialized) {
					try {
						logger.info({ nodeId }, "Attempting to get component via Desktop Bridge plugin UI");
						await ensureInitialized();

						const browserManager = getBrowserManager();
						if (!browserManager) {
							throw new Error("Browser manager not available after initialization");
						}

						const { FigmaDesktopConnector } = await import('./figma-desktop-connector.js');
						const page = await browserManager.getPage();
						const connector = new FigmaDesktopConnector(page);
						await connector.initialize();

						const desktopResult = await connector.getComponentFromPluginUI(nodeId);

						if (desktopResult.success && desktopResult.component) {
							logger.info(
								{
									componentName: desktopResult.component.name,
									hasDescription: !!desktopResult.component.description,
									hasDescriptionMarkdown: !!desktopResult.component.descriptionMarkdown,
									annotationsCount: desktopResult.component.annotations?.length || 0
								},
								"Successfully retrieved component via Desktop Bridge plugin UI!"
							);

							// Handle reconstruction format
							if (format === "reconstruction") {
								const reconstructionSpec = extractNodeSpec(desktopResult.component);
								const validation = validateReconstructionSpec(reconstructionSpec);

								if (!validation.valid) {
									logger.warn({ errors: validation.errors }, "Reconstruction spec validation warnings");
								}

								// Check if this is a COMPONENT_SET - plugin cannot create these
								if (reconstructionSpec.type === 'COMPONENT_SET') {
									const variants = listVariants(desktopResult.component);

									return {
										content: [
											{
												type: "text",
												text: JSON.stringify({
													error: "COMPONENT_SET_NOT_SUPPORTED",
													message: "The Figma Component Reconstructor plugin cannot create COMPONENT_SET nodes (variant containers). Please select a specific variant component instead.",
													componentName: reconstructionSpec.name,
													availableVariants: variants,
													instructions: [
														"1. In Figma, expand the component set to see individual variants",
														"2. Select the specific variant you want to reconstruct",
														"3. Copy the node ID of that variant",
														"4. Use figma_get_component with that variant's node ID"
													],
													note: "COMPONENT_SET is automatically created by Figma when you have variants. The plugin can only create individual COMPONENT nodes."
												}, null, 2),
											},
										],
									};
								}

								// Return spec directly for plugin compatibility
								// Plugin expects name, type, etc. at root level
								return {
									content: [
										{
											type: "text",
											text: JSON.stringify(reconstructionSpec, null, 2),
										},
									],
								};
							}

							// Handle metadata format (original behavior)
							let formatted = desktopResult.component;

							// Apply enrichment if requested
							if (enrich) {
								const enrichmentOptions: EnrichmentOptions = {
									enrich: true,
									include_usage: true,
								};

								formatted = await enrichmentService.enrichComponent(
									formatted,
									fileKey,
									enrichmentOptions
								);
							}

							return {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												fileKey,
												nodeId,
												component: formatted,
												source: "desktop_bridge_plugin",
												enriched: enrich || false,
												note: "Retrieved via Desktop Bridge plugin - description fields and annotations are reliable and current"
											},
											null,
											2
										),
									},
								],
							};
						}
					} catch (desktopError) {
						logger.warn({ error: desktopError, nodeId }, "Desktop Bridge plugin failed, falling back to REST API");
					}
				}

				// FALLBACK: Use REST API (may have missing/outdated description)
				logger.info({ nodeId }, "Using REST API fallback");

				// Initialize API client (may throw if no token available)
				let api;
				try {
					api = await getFigmaAPI();
				} catch (apiError) {
					const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
					throw new Error(
						`Cannot retrieve component data. Both Desktop Bridge and REST API are unavailable.\n` +
						`Desktop Bridge: ${getBrowserManager && ensureInitialized ? 'Failed (see logs above)' : 'Not available (local mode only)'}\n` +
						`REST API: ${errorMessage}\n\n` +
						`To fix:\n` +
						`1. Local mode: Set FIGMA_ACCESS_TOKEN environment variable, OR ensure Figma Desktop Bridge plugin is running\n` +
						`2. Cloud mode: Authenticate via OAuth\n` +
						`3. Make sure figma_navigate was called to initialize browser connection`
					);
				}

				const componentData = await api.getComponentData(fileKey, nodeId);

				if (!componentData) {
					throw new Error(`Component not found: ${nodeId}`);
				}

				// Handle reconstruction format
				if (format === "reconstruction") {
					const reconstructionSpec = extractNodeSpec(componentData.document);
					const validation = validateReconstructionSpec(reconstructionSpec);

					if (!validation.valid) {
						logger.warn({ errors: validation.errors }, "Reconstruction spec validation warnings");
					}

					// Check if this is a COMPONENT_SET - plugin cannot create these
					if (reconstructionSpec.type === 'COMPONENT_SET') {
						const variants = listVariants(componentData.document);

						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										error: "COMPONENT_SET_NOT_SUPPORTED",
										message: "The Figma Component Reconstructor plugin cannot create COMPONENT_SET nodes (variant containers). Please select a specific variant component instead.",
										componentName: reconstructionSpec.name,
										availableVariants: variants,
										instructions: [
											"1. In Figma, expand the component set to see individual variants",
											"2. Select the specific variant you want to reconstruct",
											"3. Copy the node ID of that variant",
											"4. Use figma_get_component with that variant's node ID"
										],
										note: "COMPONENT_SET is automatically created by Figma when you have variants. The plugin can only create individual COMPONENT nodes."
									}, null, 2),
								},
							],
						};
					}

					// Return spec directly for plugin compatibility
					// Plugin expects name, type, etc. at root level
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(reconstructionSpec, null, 2),
							},
						],
					};
				}

				// Handle metadata format (original behavior)
				let formatted = formatComponentData(componentData.document);

				// Apply enrichment if requested
				if (enrich) {
					const enrichmentOptions: EnrichmentOptions = {
						enrich: true,
						include_usage: true,
					};

					formatted = await enrichmentService.enrichComponent(
						formatted,
						fileKey,
						enrichmentOptions
					);
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									fileKey,
									nodeId,
									component: formatted,
									source: "rest_api",
									enriched: enrich || false,
									warning: "Retrieved via REST API - description field may be missing due to known Figma API bug",
									action_required: formatted.description || formatted.descriptionMarkdown ? null : "To get reliable component descriptions, run the Desktop Bridge plugin in Figma Desktop: Right-click → Plugins → Development → Figma Desktop Bridge, then try again."
								},
								null,
								2
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get component");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve component data",
									hint: "Make sure the node ID is correct and the file is accessible",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 11: Get Styles
	server.tool(
		"figma_get_styles",
		"Get all styles (color, text, effects, grids) from a Figma file with optional code exports. Use when user asks for: text styles, color palette, design system styles, typography, or style documentation. Returns organized style definitions with resolved values. NOT for design tokens/variables (use figma_get_variables). Set enrich=true for CSS/Tailwind/Sass code examples. Supports verbosity control to manage payload size.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called. If not provided, ask the user to share their Figma file URL (they can copy it from Figma Desktop via right-click → 'Copy link')."
				),
			verbosity: z
				.enum(["summary", "standard", "full"])
				.optional()
				.default("standard")
				.describe(
					"Controls payload size: 'summary' (names/types only, ~85% smaller), 'standard' (essential properties, ~40% smaller), 'full' (everything). Default: standard"
				),
			enrich: z
				.boolean()
				.optional()
				.describe(
					"Set to true when user asks for: CSS/Sass/Tailwind code, export formats, usage information, code examples, or design system exports. Adds resolved values, usage analysis, and export format examples. Default: false for backward compatibility"
				),
			include_usage: z
				.boolean()
				.optional()
				.describe("Include component usage information (requires enrich=true)"),
			include_exports: z
				.boolean()
				.optional()
				.describe("Include export format examples (requires enrich=true)"),
			export_formats: z
				.array(z.enum(["css", "sass", "tailwind", "typescript", "json"]))
				.optional()
				.describe(
					"Which code formats to generate examples for. Use when user mentions specific formats like 'CSS', 'Tailwind', 'SCSS', 'TypeScript', etc. Automatically enables enrichment. Default: all formats"
				),
		},
		async ({ fileUrl, verbosity, enrich, include_usage, include_exports, export_formats }) => {
			try {
				let api;
				try {
					api = await getFigmaAPI();
				} catch (apiError) {
					const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
					throw new Error(
						`Cannot retrieve styles. REST API authentication required.\n` +
						`Error: ${errorMessage}\n\n` +
						`To fix:\n` +
						`1. Local mode: Set FIGMA_ACCESS_TOKEN environment variable\n` +
						`2. Cloud mode: Authenticate via OAuth`
					);
				}

				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

			logger.info({ fileKey, verbosity, enrich }, "Fetching styles");

			// Get styles via REST API
			const stylesData = await api.getStyles(fileKey);
			let styles = stylesData.meta?.styles || [];

			logger.info(
				{ styleCount: styles.length },
				"Successfully retrieved styles via REST API"
			);


				// Apply verbosity filtering
				const filterStyle = (style: any, level: "summary" | "standard" | "full"): any => {
					if (!style) return style;

					if (level === "summary") {
						// Summary: Only key, name, type (~85% reduction)
						return {
							key: style.key,
							name: style.name,
							style_type: style.style_type,
						};
					}

					if (level === "standard") {
						// Standard: Essential properties (~40% reduction)
						return {
							key: style.key,
							name: style.name,
							description: style.description,
							style_type: style.style_type,
							...(style.remote && { remote: style.remote }),
						};
					}

					// Full: Return everything
					return style;
				};

				if (verbosity !== "full") {
					styles = styles.map((style: any) => filterStyle(style, verbosity || "standard"));
				}

				// Apply enrichment if requested
				if (enrich) {
					const enrichmentOptions: EnrichmentOptions = {
						enrich: true,
						include_usage: include_usage !== false,
						include_exports: include_exports !== false,
						export_formats: export_formats || [
							"css",
							"sass",
							"tailwind",
							"typescript",
							"json",
						],
					};

					styles = await enrichmentService.enrichStyles(
						styles,
						fileKey,
						enrichmentOptions
					);
				}

				const finalResponse = {
					fileKey,
					styles,
					totalStyles: styles.length,
					verbosity: verbosity || "standard",
					enriched: enrich || false,
				};

				// Use adaptive response to prevent context exhaustion
				return adaptiveResponse(finalResponse, {
					toolName: "figma_get_styles",
					compressionCallback: (adjustedLevel: string) => {
						// Re-apply style filtering with lower verbosity
						const level = adjustedLevel as "summary" | "standard" | "full";
						const refilteredStyles = verbosity !== "full"
							? styles.map((style: any) => filterStyle(style, level))
							: styles;
						return {
							...finalResponse,
							styles: refilteredStyles,
							verbosity: level,
						};
					},
					suggestedActions: [
						"Use verbosity='summary' for style names and types only",
						"Use verbosity='standard' for essential style properties",
						"Filter to specific style types if needed",
					],
				});
			} catch (error) {
				logger.error({ error }, "Failed to get styles");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve styles",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 12: Get Component Image (Visual Reference)
	server.tool(
		"figma_get_component_image",
		"Render a specific component or node as an image (PNG, JPG, SVG, PDF). Returns image URL valid for 30 days. Use when user asks for: component screenshot, visual preview, rendered output, or 'show me'. NOT for component metadata/properties (use figma_get_component). NOT for getting code/layout data (use figma_get_component_for_development). Best for: visual references, design review, documentation.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called. If not provided, ask the user to share their Figma file URL (they can copy it from Figma Desktop via right-click → 'Copy link')."
				),
			nodeId: z
				.string()
				.describe("Component node ID to render as image (e.g., '695:313')"),
			scale: z
				.number()
				.min(0.01)
				.max(4)
				.optional()
				.default(2)
				.describe("Image scale factor (0.01-4, default: 2 for high quality)"),
			format: z
				.enum(["png", "jpg", "svg", "pdf"])
				.optional()
				.default("png")
				.describe("Image format (default: png)"),
		},
		async ({ fileUrl, nodeId, scale, format }) => {
			try {
				let api;
				try {
					api = await getFigmaAPI();
				} catch (apiError) {
					const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
					throw new Error(
						`Cannot render component image. REST API authentication required.\n` +
						`Error: ${errorMessage}\n\n` +
						`To fix:\n` +
						`1. Local mode: Set FIGMA_ACCESS_TOKEN environment variable\n` +
						`2. Cloud mode: Authenticate via OAuth\n\n` +
						`Note: For component screenshots, figma_take_screenshot may work as browser-based alternative ` +
						`if you've called figma_navigate first.`
					);
				}

				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, nodeId, scale, format }, "Rendering component image");

				// First, fetch the node to check if it's a COMPONENT_SET
				const fileData = await api.getFile(fileKey, { ids: [nodeId] });
				const node = fileData.nodes[nodeId]?.document;

				if (!node) {
					throw new Error(
						`Node ${nodeId} not found in file ${fileKey}. Please verify the node ID is correct.`
					);
				}

				// Check if this is a COMPONENT_SET - cannot be rendered as image
				if (node.type === 'COMPONENT_SET') {
					const variants = listVariants(node);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: "COMPONENT_SET_NOT_RENDERABLE",
										message: "Node is a COMPONENT_SET which cannot be rendered. Please use a specific variant component ID instead.",
										componentName: node.name,
										availableVariants: variants,
										instructions: [
											"1. In Figma, expand the component set to see individual variants",
											"2. Select the specific variant you want to render",
											"3. Copy the node ID of that variant",
											"4. Use figma_get_component_image with that variant's node ID"
										],
										note: "COMPONENT_SET is a container for variants. Only individual variant components can be rendered as images."
									},
									null,
									2
								),
							},
						],
					};
				}

				// Call the new getImages method
				const result = await api.getImages(fileKey, nodeId, {
					scale,
					format,
					contents_only: true,
				});

				const imageUrl = result.images[nodeId];

				if (!imageUrl) {
					throw new Error(
						`Failed to render image for node ${nodeId}. The node may not exist or may not be renderable.`
					);
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									fileKey,
									nodeId,
									imageUrl,
									scale,
									format,
									expiresIn: "30 days",
									note: "Use this image as visual reference for component development. Image URLs expire after 30 days.",
								},
								null,
								2
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to render component image");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to render component image",
									hint: "Make sure the node ID is correct and the component is renderable",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 13: Get Component for Development (UI Implementation)
	server.tool(
		"figma_get_component_for_development",
		"Get component data optimized for UI implementation, includes rendered image + filtered implementation context (layout, typography, visual properties). Use when user asks to: 'build this component', 'implement this in React/Vue', 'generate code for', or needs both visual reference and technical specs. Automatically includes 2x scale image unless includeImage=false. Best for: UI development, code generation, design-to-code workflows. For just metadata, use figma_get_component; for just image, use figma_get_component_image.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called."
				),
			nodeId: z
				.string()
				.describe("Component node ID to get data for (e.g., '695:313')"),
			includeImage: z
				.boolean()
				.optional()
				.default(true)
				.describe("Include rendered image for visual reference (default: true)"),
		},
		async ({ fileUrl, nodeId, includeImage }) => {
			try {
				let api;
				try {
					api = await getFigmaAPI();
				} catch (apiError) {
					const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
					throw new Error(
						`Cannot retrieve component for development. REST API authentication required.\n` +
						`Error: ${errorMessage}\n\n` +
						`To fix:\n` +
						`1. Local mode: Set FIGMA_ACCESS_TOKEN environment variable\n` +
						`2. Cloud mode: Authenticate via OAuth\n\n` +
						`Note: For component metadata, figma_get_component has Desktop Bridge fallback ` +
						`that works without token (requires figma_navigate first).`
					);
				}

				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, nodeId, includeImage }, "Fetching component for development");

				// Get node data with depth for children
				const nodeData = await api.getNodes(fileKey, [nodeId], { depth: 2 });
				const node = nodeData.nodes?.[nodeId]?.document;

				if (!node) {
					throw new Error(`Component not found: ${nodeId}`);
				}

				// Filter to visual/layout properties only
				const filterForDevelopment = (n: any): any => {
					if (!n) return n;

					const result: any = {
						id: n.id,
						name: n.name,
						type: n.type,
						description: n.description,
						descriptionMarkdown: n.descriptionMarkdown,
					};

					// Layout & positioning
					if (n.absoluteBoundingBox) result.absoluteBoundingBox = n.absoluteBoundingBox;
					if (n.relativeTransform) result.relativeTransform = n.relativeTransform;
					if (n.size) result.size = n.size;
					if (n.constraints) result.constraints = n.constraints;
					if (n.layoutAlign) result.layoutAlign = n.layoutAlign;
					if (n.layoutGrow) result.layoutGrow = n.layoutGrow;
					if (n.layoutPositioning) result.layoutPositioning = n.layoutPositioning;

					// Auto-layout
					if (n.layoutMode) result.layoutMode = n.layoutMode;
					if (n.primaryAxisSizingMode) result.primaryAxisSizingMode = n.primaryAxisSizingMode;
					if (n.counterAxisSizingMode) result.counterAxisSizingMode = n.counterAxisSizingMode;
					if (n.primaryAxisAlignItems) result.primaryAxisAlignItems = n.primaryAxisAlignItems;
					if (n.counterAxisAlignItems) result.counterAxisAlignItems = n.counterAxisAlignItems;
					if (n.paddingLeft !== undefined) result.paddingLeft = n.paddingLeft;
					if (n.paddingRight !== undefined) result.paddingRight = n.paddingRight;
					if (n.paddingTop !== undefined) result.paddingTop = n.paddingTop;
					if (n.paddingBottom !== undefined) result.paddingBottom = n.paddingBottom;
					if (n.itemSpacing !== undefined) result.itemSpacing = n.itemSpacing;
					if (n.itemReverseZIndex) result.itemReverseZIndex = n.itemReverseZIndex;
					if (n.strokesIncludedInLayout) result.strokesIncludedInLayout = n.strokesIncludedInLayout;

					// Visual properties
					if (n.fills) result.fills = n.fills;
					if (n.strokes) result.strokes = n.strokes;
					if (n.strokeWeight !== undefined) result.strokeWeight = n.strokeWeight;
					if (n.strokeAlign) result.strokeAlign = n.strokeAlign;
					if (n.strokeCap) result.strokeCap = n.strokeCap;
					if (n.strokeJoin) result.strokeJoin = n.strokeJoin;
					if (n.dashPattern) result.dashPattern = n.dashPattern;
					if (n.cornerRadius !== undefined) result.cornerRadius = n.cornerRadius;
					if (n.rectangleCornerRadii) result.rectangleCornerRadii = n.rectangleCornerRadii;
					if (n.effects) result.effects = n.effects;
					if (n.opacity !== undefined) result.opacity = n.opacity;
					if (n.blendMode) result.blendMode = n.blendMode;
					if (n.isMask) result.isMask = n.isMask;
					if (n.clipsContent) result.clipsContent = n.clipsContent;

					// Typography
					if (n.characters) result.characters = n.characters;
					if (n.style) result.style = n.style;
					if (n.characterStyleOverrides) result.characterStyleOverrides = n.characterStyleOverrides;
					if (n.styleOverrideTable) result.styleOverrideTable = n.styleOverrideTable;

					// Component properties & variants
					if (n.componentProperties) result.componentProperties = n.componentProperties;
					if (n.componentPropertyDefinitions) result.componentPropertyDefinitions = n.componentPropertyDefinitions;
					if (n.variantProperties) result.variantProperties = n.variantProperties;
					if (n.componentId) result.componentId = n.componentId;

					// State
					if (n.visible !== undefined) result.visible = n.visible;
					if (n.locked) result.locked = n.locked;

					// Recursively process children
					if (n.children) {
						result.children = n.children.map((child: any) => filterForDevelopment(child));
					}

					return result;
				};

				const componentData = filterForDevelopment(node);

				// Get image if requested
				let imageUrl = null;
				if (includeImage) {
					try {
						const imageResult = await api.getImages(fileKey, nodeId, {
							scale: 2,
							format: "png",
							contents_only: true,
						});
						imageUrl = imageResult.images[nodeId];
					} catch (error) {
						logger.warn({ error }, "Failed to render component image, continuing without it");
					}
				}

				// Build response with component data and image URL
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									fileKey,
									nodeId,
									imageUrl,
									component: componentData,
									metadata: {
										purpose: "component_development",
										note: imageUrl
											? "Image URL provided above (valid for 30 days). Full component data optimized for UI implementation."
											: "Full component data optimized for UI implementation.",
									},
								},
								null,
								2
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get component for development");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve component development data",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 14: Get File for Plugin Development
	server.tool(
		"figma_get_file_for_plugin",
		"Get file data optimized for plugin development with filtered properties (IDs, structure, plugin data, component relationships). Excludes visual properties (fills, strokes, effects) to reduce payload. Use when user asks for: plugin development, file structure for manipulation, node IDs for plugin API. NOT for component descriptions (use figma_get_component). NOT for visual/styling data (use figma_get_component_for_development). Supports deeper tree traversal (max depth=5) than figma_get_file_data.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called."
				),
			depth: z
				.number()
				.min(0)
				.max(5)
				.optional()
				.default(2)
				.describe(
					"How many levels of children to include (default: 2, max: 5). Higher depths are safe here due to filtering."
				),
			nodeIds: z
				.array(z.string())
				.optional()
				.describe("Specific node IDs to retrieve (optional)"),
		},
		async ({ fileUrl, depth, nodeIds }) => {
			try {
				let api;
				try {
					api = await getFigmaAPI();
				} catch (apiError) {
					const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
					throw new Error(
						`Cannot retrieve file data for plugin development. REST API authentication required.\n` +
						`Error: ${errorMessage}\n\n` +
						`To fix:\n` +
						`1. Local mode: Set FIGMA_ACCESS_TOKEN environment variable\n` +
						`2. Cloud mode: Authenticate via OAuth`
					);
				}

				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, depth, nodeIds }, "Fetching file data for plugin development");

				const fileData = await api.getFile(fileKey, {
					depth,
					ids: nodeIds,
				});

				// Filter to plugin-relevant properties only
				const filterForPlugin = (node: any): any => {
					if (!node) return node;

					const result: any = {
						id: node.id,
						name: node.name,
						type: node.type,
						description: node.description,
						descriptionMarkdown: node.descriptionMarkdown,
					};

					// Navigation & structure
					if (node.visible !== undefined) result.visible = node.visible;
					if (node.locked) result.locked = node.locked;
					if (node.removed) result.removed = node.removed;

					// Lightweight bounds (just position/size)
					if (node.absoluteBoundingBox) {
						result.bounds = {
							x: node.absoluteBoundingBox.x,
							y: node.absoluteBoundingBox.y,
							width: node.absoluteBoundingBox.width,
							height: node.absoluteBoundingBox.height,
						};
					}

					// Plugin data (CRITICAL for plugins)
					if (node.pluginData) result.pluginData = node.pluginData;
					if (node.sharedPluginData) result.sharedPluginData = node.sharedPluginData;

					// Component relationships (important for plugins)
					if (node.componentId) result.componentId = node.componentId;
					if (node.mainComponent) result.mainComponent = node.mainComponent;
					if (node.componentPropertyReferences) result.componentPropertyReferences = node.componentPropertyReferences;
					if (node.instanceOf) result.instanceOf = node.instanceOf;
					if (node.exposedInstances) result.exposedInstances = node.exposedInstances;

					// Component properties (for manipulation)
					if (node.componentProperties) result.componentProperties = node.componentProperties;

					// Characters for text nodes (plugins often need this)
					if (node.characters !== undefined) result.characters = node.characters;

					// Recursively process children
					if (node.children) {
						result.children = node.children.map((child: any) => filterForPlugin(child));
					}

					return result;
				};

				const filteredDocument = filterForPlugin(fileData.document);

				const finalResponse = {
					fileKey,
					name: fileData.name,
					lastModified: fileData.lastModified,
					version: fileData.version,
					document: filteredDocument,
					components: fileData.components
						? Object.keys(fileData.components).length
						: 0,
					styles: fileData.styles
						? Object.keys(fileData.styles).length
						: 0,
					...(nodeIds && {
						requestedNodes: nodeIds,
						nodes: fileData.nodes,
					}),
					metadata: {
						purpose: "plugin_development",
						note: "Optimized for plugin development. Contains IDs, structure, plugin data, and component relationships.",
					},
				};

				// Use adaptive response to prevent context exhaustion
				return adaptiveResponse(finalResponse, {
					toolName: "figma_get_file_for_plugin",
					compressionCallback: (adjustedLevel: string) => {
						// For plugin format, we can't reduce much without breaking functionality
						// But we can strip some less critical metadata
						const compressNode = (node: any): any => {
							const result: any = {
								id: node.id,
								name: node.name,
								type: node.type,
							};

							// Keep only essential properties based on compression level
							if (adjustedLevel !== "inventory") {
								if (node.visible !== undefined) result.visible = node.visible;
								if (node.locked !== undefined) result.locked = node.locked;
								if (node.absoluteBoundingBox) result.absoluteBoundingBox = node.absoluteBoundingBox;
								if (node.pluginData) result.pluginData = node.pluginData;
								if (node.sharedPluginData) result.sharedPluginData = node.sharedPluginData;
								if (node.componentId) result.componentId = node.componentId;
							}

							if (node.children) {
								result.children = node.children.map(compressNode);
							}

							return result;
						};

						return {
							...finalResponse,
							document: compressNode(filteredDocument),
							metadata: {
								...finalResponse.metadata,
								compressionApplied: adjustedLevel,
							},
						};
					},
					suggestedActions: [
						"Reduce depth parameter (recommend 1-2)",
						"Request specific nodeIds to narrow the scope",
						"Filter to specific component types if possible",
					],
				});
			} catch (error) {
				logger.error({ error }, "Failed to get file for plugin");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve file data for plugin development",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 15: Capture Screenshot via Plugin (Desktop Bridge)
	// This uses exportAsync() which reads the current plugin runtime state, not the cloud state
	// Solves race condition where REST API screenshots show stale data after changes
	server.tool(
		"figma_capture_screenshot",
		"Capture a screenshot of a node using the plugin's exportAsync API. IMPORTANT: This tool captures the CURRENT state from the plugin runtime (not cloud state like REST API), making it reliable for validating changes immediately after making them. Use this instead of figma_get_component_image when you need to verify that changes were applied correctly. Requires Desktop Bridge connection (Figma Desktop with plugin running).",
		{
			nodeId: z
				.string()
				.optional()
				.describe(
					"ID of the node to capture (e.g., '1:234'). If not provided, captures the current page."
				),
			format: z
				.enum(["PNG", "JPG", "SVG"])
				.optional()
				.default("PNG")
				.describe("Image format (default: PNG)"),
			scale: z
				.number()
				.min(0.5)
				.max(4)
				.optional()
				.default(2)
				.describe("Scale factor (default: 2 for 2x resolution)"),
		},
		async ({ nodeId, format, scale }) => {
			try {
				// Check for Desktop Bridge connection
				const browserManager = getBrowserManager?.();
				if (!browserManager) {
					throw new Error(
						"Desktop Bridge not available. To capture screenshots:\n" +
						"1. Open your Figma file in Figma Desktop\n" +
						"2. Install and run the 'Figma Console MCP' plugin\n" +
						"3. Ensure the plugin shows 'MCP ready' status"
					);
				}

				// Ensure browser is initialized
				if (ensureInitialized) {
					await ensureInitialized();
				}

				const page = await browserManager.getPage();
				logger.info({ nodeId, format, scale }, "Capturing screenshot via Desktop Bridge");

				// Find the plugin UI frame and call the captureScreenshot function
				const frames = page.frames();
				let result = null;

				for (const frame of frames) {
					try {
						const hasFunction = await frame.evaluate('typeof window.captureScreenshot === "function"');
						if (hasFunction) {
							result = await frame.evaluate(
								`window.captureScreenshot(${JSON.stringify(nodeId)}, ${JSON.stringify({ format, scale })})`
							);
							break;
						}
					} catch {
						continue;
					}
				}

				if (!result) {
					throw new Error(
						"Desktop Bridge plugin not found. Ensure the 'Figma Console MCP' plugin is running in Figma Desktop."
					);
				}

				if (!result.success) {
					throw new Error(result.error || "Screenshot capture failed");
				}

				// Determine MIME type based on format
				const mimeType = format === "JPG" ? "image/jpeg" : format === "SVG" ? "image/svg+xml" : "image/png";

				logger.info({ byteLength: result.image.byteLength, format, mimeType }, "Screenshot captured via plugin");

				// Return as MCP image content type so Claude can actually see and analyze the image
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								image: {
									format: result.image.format,
									scale: result.image.scale,
									byteLength: result.image.byteLength,
									node: result.image.node,
									bounds: result.image.bounds,
								},
								metadata: {
									source: "plugin_export_async",
									note: "Screenshot captured successfully. The image is included below for visual analysis. This shows the CURRENT plugin runtime state (guaranteed to reflect recent changes).",
								},
							}, null, 2),
						},
						{
							type: "image",
							data: result.image.base64,
							mimeType: mimeType,
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to capture screenshot");
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: errorMessage,
								message: "Failed to capture screenshot via Desktop Bridge",
								suggestion: "Ensure Figma Desktop is open with the plugin running",
							}, null, 2),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 16: Set Instance Properties (Desktop Bridge)
	// Updates component properties on an instance using setProperties()
	// This is the correct way to update TEXT/BOOLEAN/VARIANT properties on component instances
	server.tool(
		"figma_set_instance_properties",
		"Update component properties on a component instance. IMPORTANT: Use this tool instead of trying to edit text nodes directly when working with component instances. Components often expose TEXT, BOOLEAN, INSTANCE_SWAP, and VARIANT properties that control their content. Direct text node editing may fail silently if the component uses properties. This tool handles the #nodeId suffix pattern automatically. Requires Desktop Bridge connection.",
		{
			nodeId: z
				.string()
				.describe(
					"ID of the INSTANCE node to update (e.g., '1:234'). Must be a component instance, not a regular frame."
				),
			properties: z
				.record(z.string(), z.union([z.string(), z.boolean()]))
				.describe(
					"Properties to set. Keys are property names (e.g., 'Label', 'Show Icon', 'Size'). " +
					"Values are strings for TEXT/VARIANT properties, booleans for BOOLEAN properties. " +
					"The tool automatically handles the #nodeId suffix for TEXT/BOOLEAN/INSTANCE_SWAP properties."
				),
		},
		async ({ nodeId, properties }) => {
			try {
				// Check for Desktop Bridge connection
				const browserManager = getBrowserManager?.();
				if (!browserManager) {
					throw new Error(
						"Desktop Bridge not available. To set instance properties:\n" +
						"1. Open your Figma file in Figma Desktop\n" +
						"2. Install and run the 'Figma Console MCP' plugin\n" +
						"3. Ensure the plugin shows 'MCP ready' status"
					);
				}

				// Ensure browser is initialized
				if (ensureInitialized) {
					await ensureInitialized();
				}

				const page = await browserManager.getPage();
				logger.info({ nodeId, properties: Object.keys(properties) }, "Setting instance properties via Desktop Bridge");

				// Find the plugin UI frame and call the setInstanceProperties function
				const frames = page.frames();
				let result = null;

				for (const frame of frames) {
					try {
						const hasFunction = await frame.evaluate('typeof window.setInstanceProperties === "function"');
						if (hasFunction) {
							result = await frame.evaluate(
								`window.setInstanceProperties(${JSON.stringify(nodeId)}, ${JSON.stringify(properties)})`
							);
							break;
						}
					} catch {
						continue;
					}
				}

				if (!result) {
					throw new Error(
						"Desktop Bridge plugin not found. Ensure the 'Figma Console MCP' plugin is running in Figma Desktop."
					);
				}

				if (!result.success) {
					throw new Error(result.error || "Failed to set instance properties");
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								instance: result.instance,
								metadata: {
									note: "Instance properties updated successfully. Use figma_capture_screenshot to verify visual changes.",
								},
							}, null, 2),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to set instance properties");
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: errorMessage,
								message: "Failed to set instance properties via Desktop Bridge",
								suggestions: [
									"Verify the node is a component INSTANCE (not a regular frame)",
									"Check available properties with figma_get_component first",
									"Ensure property names match exactly (case-sensitive)",
									"For TEXT properties, provide string values",
									"For BOOLEAN properties, provide true/false",
								],
							}, null, 2),
						},
					],
					isError: true,
				};
			}
		}
	);

}
