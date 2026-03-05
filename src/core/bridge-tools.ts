/**
 * Bridge Tools — Desktop Bridge connector tools shared between local and remote modes.
 *
 * Extracted from local.ts so that both the local McpServer (local.ts) and the
 * remote Cloudflare Worker (index.ts — DO and /mcp handler) can register the
 * same set of Desktop Bridge tools without duplication.
 *
 * All 27 tools here communicate exclusively through the IFigmaConnector interface,
 * meaning they work identically whether the connector is:
 *   - WebSocketConnector / CDPConnector  (local mode)
 *   - SupabaseBridgeConnector            (remote Cloudflare + Supabase relay mode)
 *
 * Tools that require browserManager, wsServer, or in-process cache are NOT here;
 * they remain in local.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IFigmaConnector } from "./figma-connector.js";

export function registerBridgeTools(
	server: McpServer,
	getConnector: () => Promise<IFigmaConnector>,
): void {
	// ============================================================================
	// CORE EXECUTION
	// ============================================================================

	server.tool(
		"figma_execute",
		`Execute arbitrary JavaScript in Figma's plugin context with full access to the figma API. Use for complex operations not covered by other tools. Requires Desktop Bridge plugin. CAUTION: Can modify your document.

**COMPONENT INSTANCES:** For instances (node.type === 'INSTANCE'), use figma_set_instance_properties — direct text editing FAILS SILENTLY. Check instance.componentProperties for available props (may have #nodeId suffixes).

**RESULT ANALYSIS:** Check resultAnalysis.warning for silent failures (empty arrays, null returns).

**VALIDATION:** After creating/modifying visuals: screenshot with figma_capture_screenshot, check alignment/spacing/proportions, iterate up to 3x.

**PLACEMENT:** Always create components inside a Section or Frame, never on blank canvas. Use parent.insertChild(0, bg) for z-ordering backgrounds behind content.`,
		{
			code: z
				.string()
				.describe(
					"JavaScript code to execute. Has access to the 'figma' global object. " +
						"Example: 'const rect = figma.createRectangle(); rect.resize(100, 100); return { id: rect.id };'",
				),
			timeout: z
				.number()
				.optional()
				.default(5000)
				.describe("Execution timeout in milliseconds (default: 5000, max: 30000)"),
		},
		async ({ code, timeout }) => {
			try {
				const connector = await getConnector();
				const result = await connector.executeCodeViaUI(
					code,
					Math.min(timeout, 30000),
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: result.success,
								result: result.result,
								error: result.error,
								resultAnalysis: result.resultAnalysis,
								fileContext: result.fileContext,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to execute code in Figma plugin context",
								hint: "Make sure the Desktop Bridge plugin is running in Figma",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// VARIABLE OPERATIONS
	// ============================================================================

	server.tool(
		"figma_update_variable",
		"Update a single variable's value. For multiple updates, use figma_batch_update_variables instead (10-50x faster). Use figma_get_variables first for IDs. COLOR: hex '#FF0000', FLOAT: number, STRING: text, BOOLEAN: true/false. Requires Desktop Bridge plugin.",
		{
			variableId: z
				.string()
				.describe(
					"The variable ID to update (e.g., 'VariableID:123:456'). Get this from figma_get_variables.",
				),
			modeId: z
				.string()
				.describe(
					"The mode ID to update the value in (e.g., '1:0'). Get this from the variable's collection modes.",
				),
			value: z
				.union([z.string(), z.number(), z.boolean()])
				.describe(
					"The new value. For COLOR: hex string like '#FF0000'. For FLOAT: number. For STRING: text. For BOOLEAN: true/false.",
				),
		},
		async ({ variableId, modeId, value }) => {
			try {
				const connector = await getConnector();
				const result = await connector.updateVariable(variableId, modeId, value);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Variable "${result.variable.name}" updated successfully`,
								variable: result.variable,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to update variable",
								hint: "Make sure the Desktop Bridge plugin is running and the variable ID is correct",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_create_variable",
		"Create a single Figma variable. For multiple variables, use figma_batch_create_variables instead (10-50x faster). Use figma_get_variables first to get collection IDs. Supports COLOR, FLOAT, STRING, BOOLEAN. Requires Desktop Bridge plugin.",
		{
			name: z.string().describe("Name for the new variable (e.g., 'primary-blue')"),
			collectionId: z
				.string()
				.describe(
					"The collection ID to create the variable in (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables.",
				),
			resolvedType: z
				.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
				.describe("The variable type: COLOR, FLOAT, STRING, or BOOLEAN"),
			description: z.string().optional().describe("Optional description for the variable"),
			valuesByMode: z
				.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
				.optional()
				.describe(
					"Optional initial values by mode ID. Example: { '1:0': '#FF0000', '1:1': '#0000FF' }",
				),
		},
		async ({ name, collectionId, resolvedType, description, valuesByMode }) => {
			try {
				const connector = await getConnector();
				const result = await connector.createVariable(name, collectionId, resolvedType, {
					description,
					valuesByMode,
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Variable "${name}" created successfully`,
								variable: result.variable,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to create variable",
								hint: "Make sure the Desktop Bridge plugin is running and the collection ID is correct",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_create_variable_collection",
		"Create an empty variable collection. To create a collection WITH variables and modes in one step, use figma_setup_design_tokens instead. Requires Desktop Bridge plugin.",
		{
			name: z.string().describe("Name for the new collection (e.g., 'Brand Colors')"),
			initialModeName: z
				.string()
				.optional()
				.describe(
					"Name for the initial mode (default mode is created automatically). Example: 'Light'",
				),
			additionalModes: z
				.array(z.string())
				.optional()
				.describe("Additional mode names to create. Example: ['Dark', 'High Contrast']"),
		},
		async ({ name, initialModeName, additionalModes }) => {
			try {
				const connector = await getConnector();
				const result = await connector.createVariableCollection(name, {
					initialModeName,
					additionalModes,
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Collection "${name}" created successfully`,
								collection: result.collection,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to create variable collection",
								hint: "Make sure the Desktop Bridge plugin is running in Figma",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_delete_variable",
		"Delete a Figma variable. WARNING: This is a destructive operation that cannot be undone (except with Figma's undo). Use figma_get_variables first to get variable IDs. Requires the Desktop Bridge plugin to be running.",
		{
			variableId: z
				.string()
				.describe(
					"The variable ID to delete (e.g., 'VariableID:123:456'). Get this from figma_get_variables.",
				),
		},
		async ({ variableId }) => {
			try {
				const connector = await getConnector();
				const result = await connector.deleteVariable(variableId);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Variable "${result.deleted.name}" deleted successfully`,
								deleted: result.deleted,
								timestamp: Date.now(),
								warning:
									"This action cannot be undone programmatically. Use Figma's Edit > Undo if needed.",
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to delete variable",
								hint: "Make sure the Desktop Bridge plugin is running and the variable ID is correct",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_delete_variable_collection",
		"Delete a Figma variable collection and ALL its variables. WARNING: This is a destructive operation that deletes all variables in the collection and cannot be undone (except with Figma's undo). Requires the Desktop Bridge plugin to be running.",
		{
			collectionId: z
				.string()
				.describe(
					"The collection ID to delete (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables.",
				),
		},
		async ({ collectionId }) => {
			try {
				const connector = await getConnector();
				const result = await connector.deleteVariableCollection(collectionId);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Collection "${result.deleted.name}" and ${result.deleted.variableCount} variables deleted successfully`,
								deleted: result.deleted,
								timestamp: Date.now(),
								warning:
									"This action cannot be undone programmatically. Use Figma's Edit > Undo if needed.",
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to delete variable collection",
								hint: "Make sure the Desktop Bridge plugin is running and the collection ID is correct",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_rename_variable",
		"Rename an existing Figma variable. This updates the variable's name while preserving all its values and settings. Requires the Desktop Bridge plugin to be running.",
		{
			variableId: z
				.string()
				.describe(
					"The variable ID to rename (e.g., 'VariableID:123:456'). Get this from figma_get_variables.",
				),
			newName: z
				.string()
				.describe(
					"The new name for the variable. Can include slashes for grouping (e.g., 'colors/primary/background').",
				),
		},
		async ({ variableId, newName }) => {
			try {
				const connector = await getConnector();
				const result = await connector.renameVariable(variableId, newName);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Variable renamed from "${result.oldName}" to "${result.variable.name}"`,
								oldName: result.oldName,
								variable: result.variable,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to rename variable",
								hint: "Make sure the Desktop Bridge plugin is running and the variable ID is correct",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_add_mode",
		"Add a new mode to an existing Figma variable collection. Modes allow variables to have different values for different contexts (e.g., Light/Dark themes, device sizes). Requires the Desktop Bridge plugin to be running.",
		{
			collectionId: z
				.string()
				.describe(
					"The collection ID to add the mode to (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables.",
				),
			modeName: z
				.string()
				.describe(
					"The name for the new mode (e.g., 'Dark', 'Mobile', 'High Contrast').",
				),
		},
		async ({ collectionId, modeName }) => {
			try {
				const connector = await getConnector();
				const result = await connector.addMode(collectionId, modeName);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Mode "${modeName}" added to collection "${result.collection.name}"`,
								newMode: result.newMode,
								collection: result.collection,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to add mode to collection",
								hint: "Make sure the Desktop Bridge plugin is running, the collection ID is correct, and you haven't exceeded Figma's mode limit",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_rename_mode",
		"Rename an existing mode in a Figma variable collection. Requires the Desktop Bridge plugin to be running.",
		{
			collectionId: z
				.string()
				.describe(
					"The collection ID containing the mode (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables.",
				),
			modeId: z
				.string()
				.describe(
					"The mode ID to rename (e.g., '123:0'). Get this from the collection's modes array in figma_get_variables.",
				),
			newName: z
				.string()
				.describe("The new name for the mode (e.g., 'Dark Theme', 'Tablet')."),
		},
		async ({ collectionId, modeId, newName }) => {
			try {
				const connector = await getConnector();
				const result = await connector.renameMode(collectionId, modeId, newName);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Mode renamed from "${result.oldName}" to "${newName}"`,
								oldName: result.oldName,
								collection: result.collection,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to rename mode",
								hint: "Make sure the Desktop Bridge plugin is running, the collection ID and mode ID are correct",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// BATCH OPERATIONS
	// ============================================================================

	server.tool(
		"figma_batch_create_variables",
		"Create multiple variables in one operation. Use instead of calling figma_create_variable repeatedly — up to 50x faster for bulk operations. Get collection IDs from figma_get_variables first. Requires Desktop Bridge plugin.",
		{
			collectionId: z
				.string()
				.describe(
					"Collection ID to create all variables in (e.g., 'VariableCollectionId:123:456')",
				),
			variables: z
				.array(
					z.object({
						name: z.string().describe("Variable name (e.g., 'primary-blue')"),
						resolvedType: z
							.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
							.describe("Variable type"),
						description: z.string().optional().describe("Optional description"),
						valuesByMode: z
							.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
							.optional()
							.describe(
								"Values by mode ID. For COLOR: hex like '#FF0000'. Example: { '1:0': '#FF0000' }",
							),
					}),
				)
				.min(1)
				.max(100)
				.describe("Array of variables to create (1-100)"),
		},
		async ({ collectionId, variables }) => {
			try {
				const connector = await getConnector();
				const script = `
const results = [];
const collectionId = ${JSON.stringify(collectionId)};
const vars = ${JSON.stringify(variables)};

function hexToRgba(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return {
    r: parseInt(hex.substring(0, 2), 16) / 255,
    g: parseInt(hex.substring(2, 4), 16) / 255,
    b: parseInt(hex.substring(4, 6), 16) / 255,
    a: hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1
  };
}

const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
if (!collection) return { created: 0, failed: vars.length, results: vars.map(v => ({ success: false, name: v.name, error: 'Collection not found: ' + collectionId })) };

for (const v of vars) {
  try {
    const variable = figma.variables.createVariable(v.name, collection, v.resolvedType);
    if (v.description) variable.description = v.description;
    if (v.valuesByMode) {
      for (const [modeId, value] of Object.entries(v.valuesByMode)) {
        const processed = v.resolvedType === 'COLOR' && typeof value === 'string' ? hexToRgba(value) : value;
        variable.setValueForMode(modeId, processed);
      }
    }
    results.push({ success: true, name: v.name, id: variable.id });
  } catch (err) {
    results.push({ success: false, name: v.name, error: String(err) });
  }
}

return {
  created: results.filter(r => r.success).length,
  failed: results.filter(r => !r.success).length,
  results
};`;
				const timeout = Math.max(5000, variables.length * 200);
				const result = await connector.executeCodeViaUI(script, Math.min(timeout, 30000));
				if (result.error) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: result.error,
									message: "Batch create failed during execution",
									hint: "Check that the collection ID is valid and the Desktop Bridge plugin is running",
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
								success: true,
								message: `Batch created ${result.result?.created ?? 0} variables (${result.result?.failed ?? 0} failed)`,
								...result.result,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to batch create variables",
								hint: "Make sure the Desktop Bridge plugin is running and the collection ID is correct",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_batch_update_variables",
		"Update multiple variable values in one operation. Use instead of calling figma_update_variable repeatedly — up to 50x faster for bulk updates. Get variable/mode IDs from figma_get_variables first. Requires Desktop Bridge plugin.",
		{
			updates: z
				.array(
					z.object({
						variableId: z.string().describe("Variable ID (e.g., 'VariableID:123:456')"),
						modeId: z.string().describe("Mode ID (e.g., '1:0')"),
						value: z
							.union([z.string(), z.number(), z.boolean()])
							.describe(
								"New value. COLOR: hex like '#FF0000'. FLOAT: number. STRING: text. BOOLEAN: true/false.",
							),
					}),
				)
				.min(1)
				.max(100)
				.describe("Array of updates to apply (1-100)"),
		},
		async ({ updates }) => {
			try {
				const connector = await getConnector();
				const script = `
const results = [];
const updates = ${JSON.stringify(updates)};

function hexToRgba(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return {
    r: parseInt(hex.substring(0, 2), 16) / 255,
    g: parseInt(hex.substring(2, 4), 16) / 255,
    b: parseInt(hex.substring(4, 6), 16) / 255,
    a: hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1
  };
}

for (const u of updates) {
  try {
    const variable = await figma.variables.getVariableByIdAsync(u.variableId);
    if (!variable) throw new Error('Variable not found: ' + u.variableId);
    const isColor = variable.resolvedType === 'COLOR';
    const processed = isColor && typeof u.value === 'string' ? hexToRgba(u.value) : u.value;
    variable.setValueForMode(u.modeId, processed);
    results.push({ success: true, variableId: u.variableId, name: variable.name });
  } catch (err) {
    results.push({ success: false, variableId: u.variableId, error: String(err) });
  }
}

return {
  updated: results.filter(r => r.success).length,
  failed: results.filter(r => !r.success).length,
  results
};`;
				const timeout = Math.max(5000, updates.length * 150);
				const result = await connector.executeCodeViaUI(script, Math.min(timeout, 30000));
				if (result.error) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: result.error,
									message: "Batch update failed during execution",
									hint: "Check that variable IDs and mode IDs are valid",
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
								success: true,
								message: `Batch updated ${result.result?.updated ?? 0} variables (${result.result?.failed ?? 0} failed)`,
								...result.result,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to batch update variables",
								hint: "Make sure the Desktop Bridge plugin is running and variable/mode IDs are correct",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_setup_design_tokens",
		"Create a complete design token structure in one operation: collection, modes, and all variables. Ideal for importing CSS custom properties or design tokens into Figma. Requires Desktop Bridge plugin.",
		{
			collectionName: z
				.string()
				.describe("Name for the token collection (e.g., 'Brand Tokens')"),
			modes: z
				.array(z.string())
				.min(1)
				.max(4)
				.describe("Mode names (first becomes default). Example: ['Light', 'Dark']"),
			tokens: z
				.array(
					z.object({
						name: z.string().describe("Token name (e.g., 'color/primary')"),
						resolvedType: z
							.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
							.describe("Token type"),
						description: z.string().optional().describe("Optional description"),
						values: z
							.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
							.describe(
								"Values keyed by mode NAME (not ID). Example: { 'Light': '#FFFFFF', 'Dark': '#000000' }",
							),
					}),
				)
				.min(1)
				.max(100)
				.describe("Token definitions (1-100)"),
		},
		async ({ collectionName, modes, tokens }) => {
			try {
				const connector = await getConnector();
				const script = `
const collectionName = ${JSON.stringify(collectionName)};
const modeNames = ${JSON.stringify(modes)};
const tokenDefs = ${JSON.stringify(tokens)};

function hexToRgba(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return {
    r: parseInt(hex.substring(0, 2), 16) / 255,
    g: parseInt(hex.substring(2, 4), 16) / 255,
    b: parseInt(hex.substring(4, 6), 16) / 255,
    a: hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1
  };
}

const collection = figma.variables.createVariableCollection(collectionName);
const modeMap = {};

const defaultModeId = collection.modes[0].modeId;
collection.renameMode(defaultModeId, modeNames[0]);
modeMap[modeNames[0]] = defaultModeId;

for (let i = 1; i < modeNames.length; i++) {
  const newModeId = collection.addMode(modeNames[i]);
  modeMap[modeNames[i]] = newModeId;
}

const results = [];
for (const t of tokenDefs) {
  try {
    const variable = figma.variables.createVariable(t.name, collection, t.resolvedType);
    if (t.description) variable.description = t.description;
    for (const [modeName, value] of Object.entries(t.values)) {
      const modeId = modeMap[modeName];
      if (!modeId) { results.push({ success: false, name: t.name, error: 'Unknown mode: ' + modeName }); continue; }
      const processed = t.resolvedType === 'COLOR' && typeof value === 'string' ? hexToRgba(value) : value;
      variable.setValueForMode(modeId, processed);
    }
    results.push({ success: true, name: t.name, id: variable.id });
  } catch (err) {
    results.push({ success: false, name: t.name, error: String(err) });
  }
}

return {
  collectionId: collection.id,
  collectionName: collectionName,
  modes: modeMap,
  created: results.filter(r => r.success).length,
  failed: results.filter(r => !r.success).length,
  results
};`;
				const timeout = Math.max(10000, tokens.length * 200 + modes.length * 500);
				const result = await connector.executeCodeViaUI(script, Math.min(timeout, 30000));
				if (result.error) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: result.error,
									message: "Design token setup failed during execution",
									hint: "Check the token definitions and ensure the Desktop Bridge plugin is running",
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
								success: true,
								message: `Created collection "${collectionName}" with ${modes.length} mode(s) and ${result.result?.created ?? 0} tokens`,
								...result.result,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to setup design tokens",
								hint: "Make sure the Desktop Bridge plugin is running in Figma",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// COMPONENT OPERATIONS
	// ============================================================================

	server.tool(
		"figma_instantiate_component",
		`Create an instance of a component from the design system.

**CRITICAL: Always pass BOTH componentKey AND nodeId together!**
Search results return both identifiers. Pass both so the tool can automatically fall back to nodeId if the component isn't published to a library. Most local/unpublished components require nodeId.

**IMPORTANT: Always re-search before instantiating!**
NodeIds are session-specific and may be stale from previous conversations. ALWAYS search for components at the start of each design session to get current, valid identifiers.

**VISUAL VALIDATION WORKFLOW:**
After instantiating components, use figma_take_screenshot to verify the result looks correct. Check placement, sizing, and visual balance.`,
		{
			componentKey: z
				.string()
				.optional()
				.describe(
					"The component key from search results. Pass this WITH nodeId for automatic fallback.",
				),
			nodeId: z
				.string()
				.optional()
				.describe(
					"The node ID from search results. ALWAYS pass this alongside componentKey - most local components need it.",
				),
			variant: z
				.record(z.string())
				.optional()
				.describe(
					"Variant properties to set (e.g., { Type: 'Simple', State: 'Active' })",
				),
			overrides: z
				.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
				.optional()
				.describe("Property overrides (e.g., { 'Button Label': 'Click Me' })"),
			position: z
				.object({ x: z.number(), y: z.number() })
				.optional()
				.describe("Position on canvas (default: 0, 0)"),
			parentId: z.string().optional().describe("Parent node ID to append the instance to"),
		},
		async ({ componentKey, nodeId, variant, overrides, position, parentId }) => {
			try {
				if (!componentKey && !nodeId) {
					throw new Error("Either componentKey or nodeId is required");
				}
				const connector = await getConnector();
				const result = await connector.instantiateComponent(componentKey || "", {
					nodeId,
					position,
					overrides,
					variant,
					parentId,
				});
				if (!result.success) {
					throw new Error(result.error || "Failed to instantiate component");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Component instantiated successfully",
								instance: result.instance,
								timestamp: Date.now(),
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to instantiate component",
								hint: "Make sure the component key is correct and the Desktop Bridge plugin is running",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_set_description",
		"Set the description text on a component, component set, or style. Descriptions appear in Dev Mode and help document design intent. Supports plain text and markdown formatting.",
		{
			nodeId: z
				.string()
				.describe("The node ID of the component or style to update (e.g., '123:456')"),
			description: z.string().describe("The plain text description to set"),
			descriptionMarkdown: z
				.string()
				.optional()
				.describe("Optional rich text description using markdown formatting"),
		},
		async ({ nodeId, description, descriptionMarkdown }) => {
			try {
				const connector = await getConnector();
				const result = await connector.setNodeDescription(
					nodeId,
					description,
					descriptionMarkdown,
				);
				if (!result.success) {
					throw new Error(result.error || "Failed to set description");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Description set successfully",
								node: result.node,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Make sure the node supports descriptions (components, component sets, styles)",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_add_component_property",
		"Add a new component property to a component or component set. Properties enable dynamic content and behavior in component instances. Supported types: BOOLEAN (toggle), TEXT (string), INSTANCE_SWAP (component swap), VARIANT (variant selection).",
		{
			nodeId: z.string().describe("The component or component set node ID"),
			propertyName: z
				.string()
				.describe("Name for the new property (e.g., 'Show Icon', 'Button Label')"),
			type: z
				.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"])
				.describe(
					"Property type: BOOLEAN for toggles, TEXT for strings, INSTANCE_SWAP for component swaps, VARIANT for variant selection",
				),
			defaultValue: z
				.union([z.string(), z.number(), z.boolean()])
				.describe(
					"Default value for the property. BOOLEAN: true/false, TEXT: string, INSTANCE_SWAP: component key, VARIANT: variant value",
				),
		},
		async ({ nodeId, propertyName, type, defaultValue }) => {
			try {
				const connector = await getConnector();
				const result = await connector.addComponentProperty(
					nodeId,
					propertyName,
					type,
					defaultValue,
				);
				if (!result.success) {
					throw new Error(result.error || "Failed to add property");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Component property added",
								propertyName: result.propertyName,
								hint: "The property name includes a unique suffix (e.g., 'Show Icon#123:456'). Use the full name for editing/deleting.",
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Cannot add properties to variant components. Add to the parent component set instead.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_edit_component_property",
		"Edit an existing component property. Can change the name, default value, or preferred values (for INSTANCE_SWAP). Use the full property name including the unique suffix.",
		{
			nodeId: z.string().describe("The component or component set node ID"),
			propertyName: z
				.string()
				.describe("The full property name with suffix (e.g., 'Show Icon#123:456')"),
			newValue: z
				.object({
					name: z.string().optional().describe("New name for the property"),
					defaultValue: z
						.union([z.string(), z.number(), z.boolean()])
						.optional()
						.describe("New default value"),
					preferredValues: z
						.array(
							z.object({
								type: z
									.enum(["COMPONENT", "COMPONENT_SET"])
									.describe("Type of preferred value"),
								key: z.string().describe("Component or component set key"),
							}),
						)
						.optional()
						.describe("Preferred values (INSTANCE_SWAP only)"),
				})
				.describe("Object with the values to update"),
		},
		async ({ nodeId, propertyName, newValue }) => {
			try {
				const connector = await getConnector();
				const result = await connector.editComponentProperty(nodeId, propertyName, newValue);
				if (!result.success) {
					throw new Error(result.error || "Failed to edit property");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Component property updated",
								propertyName: result.propertyName,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_delete_component_property",
		"Delete a component property. Only works with BOOLEAN, TEXT, and INSTANCE_SWAP properties (not VARIANT). This is a destructive operation.",
		{
			nodeId: z.string().describe("The component or component set node ID"),
			propertyName: z
				.string()
				.describe("The full property name with suffix (e.g., 'Show Icon#123:456')"),
		},
		async ({ nodeId, propertyName }) => {
			try {
				const connector = await getConnector();
				const result = await connector.deleteComponentProperty(nodeId, propertyName);
				if (!result.success) {
					throw new Error(result.error || "Failed to delete property");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Component property deleted",
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Cannot delete VARIANT properties. Only BOOLEAN, TEXT, and INSTANCE_SWAP can be deleted.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// NODE MANIPULATION
	// ============================================================================

	server.tool(
		"figma_resize_node",
		"Resize a node to specific dimensions. By default respects child constraints; use withConstraints=false to ignore them.",
		{
			nodeId: z.string().describe("The node ID to resize"),
			width: z.number().describe("New width in pixels"),
			height: z.number().describe("New height in pixels"),
			withConstraints: z
				.boolean()
				.optional()
				.default(true)
				.describe("Whether to apply child constraints during resize (default: true)"),
		},
		async ({ nodeId, width, height, withConstraints }) => {
			try {
				const connector = await getConnector();
				const result = await connector.resizeNode(nodeId, width, height, withConstraints);
				if (!result.success) {
					throw new Error(result.error || "Failed to resize node");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Node resized to ${width}x${height}`,
								node: result.node,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_move_node",
		"Move a node to a new position within its parent.",
		{
			nodeId: z.string().describe("The node ID to move"),
			x: z.number().describe("New X position"),
			y: z.number().describe("New Y position"),
		},
		async ({ nodeId, x, y }) => {
			try {
				const connector = await getConnector();
				const result = await connector.moveNode(nodeId, x, y);
				if (!result.success) {
					throw new Error(result.error || "Failed to move node");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Node moved to (${x}, ${y})`,
								node: result.node,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_set_fills",
		"Set the fill colors on a node. Accepts hex color strings (e.g., '#FF0000') or full paint objects.",
		{
			nodeId: z.string().describe("The node ID to modify"),
			fills: z
				.array(
					z.object({
						type: z
							.literal("SOLID")
							.describe("Fill type (currently only SOLID supported)"),
						color: z
							.string()
							.describe(
								"Hex color string (e.g., '#FF0000', '#FF000080' for transparency)",
							),
						opacity: z.number().optional().describe("Opacity 0-1 (default: 1)"),
					}),
				)
				.describe("Array of fill objects"),
		},
		async ({ nodeId, fills }) => {
			try {
				const connector = await getConnector();
				const result = await connector.setNodeFills(nodeId, fills);
				if (!result.success) {
					throw new Error(result.error || "Failed to set fills");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Fills updated",
								node: result.node,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_set_strokes",
		"Set the stroke (border) on a node. Accepts hex color strings and optional stroke weight.",
		{
			nodeId: z.string().describe("The node ID to modify"),
			strokes: z
				.array(
					z.object({
						type: z.literal("SOLID").describe("Stroke type"),
						color: z.string().describe("Hex color string"),
						opacity: z.number().optional().describe("Opacity 0-1"),
					}),
				)
				.describe("Array of stroke objects"),
			strokeWeight: z.number().optional().describe("Stroke thickness in pixels"),
		},
		async ({ nodeId, strokes, strokeWeight }) => {
			try {
				const connector = await getConnector();
				const result = await connector.setNodeStrokes(nodeId, strokes, strokeWeight);
				if (!result.success) {
					throw new Error(result.error || "Failed to set strokes");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Strokes updated",
								node: result.node,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_clone_node",
		"Duplicate a node. The clone is placed at a slight offset from the original.",
		{
			nodeId: z.string().describe("The node ID to clone"),
		},
		async ({ nodeId }) => {
			try {
				const connector = await getConnector();
				const result = await connector.cloneNode(nodeId);
				if (!result.success) {
					throw new Error(result.error || "Failed to clone node");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Node cloned",
								clonedNode: result.node,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_delete_node",
		"Delete a node from the canvas. WARNING: This is a destructive operation (can be undone with Figma's undo).",
		{
			nodeId: z.string().describe("The node ID to delete"),
		},
		async ({ nodeId }) => {
			try {
				const connector = await getConnector();
				const result = await connector.deleteNode(nodeId);
				if (!result.success) {
					throw new Error(result.error || "Failed to delete node");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Node deleted",
								deleted: result.deleted,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_rename_node",
		"Rename a node in the layer panel.",
		{
			nodeId: z.string().describe("The node ID to rename"),
			newName: z.string().describe("The new name for the node"),
		},
		async ({ nodeId, newName }) => {
			try {
				const connector = await getConnector();
				const result = await connector.renameNode(nodeId, newName);
				if (!result.success) {
					throw new Error(result.error || "Failed to rename node");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Node renamed to "${newName}"`,
								node: result.node,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_set_text",
		"Set the text content of a text node. Optionally adjust font size.",
		{
			nodeId: z.string().describe("The text node ID"),
			text: z.string().describe("The new text content"),
			fontSize: z.number().optional().describe("Optional font size to set"),
		},
		async ({ nodeId, text, fontSize }) => {
			try {
				const connector = await getConnector();
				const result = await connector.setTextContent(
					nodeId,
					text,
					fontSize ? { fontSize } : undefined,
				);
				if (!result.success) {
					throw new Error(result.error || "Failed to set text");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Text content updated",
								node: result.node,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Make sure the node is a TEXT node",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_create_child",
		"Create a new child node inside a parent container. Useful for adding shapes, text, or frames to existing structures.",
		{
			parentId: z.string().describe("The parent node ID"),
			nodeType: z
				.enum(["RECTANGLE", "ELLIPSE", "FRAME", "TEXT", "LINE"])
				.describe("Type of node to create"),
			properties: z
				.object({
					name: z.string().optional().describe("Name for the new node"),
					x: z.number().optional().describe("X position within parent"),
					y: z.number().optional().describe("Y position within parent"),
					width: z.number().optional().describe("Width (default: 100)"),
					height: z.number().optional().describe("Height (default: 100)"),
					fills: z
						.array(z.object({ type: z.literal("SOLID"), color: z.string() }))
						.optional()
						.describe("Fill colors (hex strings)"),
					text: z.string().optional().describe("Text content (for TEXT nodes only)"),
				})
				.optional()
				.describe("Properties for the new node"),
		},
		async ({ parentId, nodeType, properties }) => {
			try {
				const connector = await getConnector();
				const result = await connector.createChildNode(parentId, nodeType, properties);
				if (!result.success) {
					throw new Error(result.error || "Failed to create node");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Created ${nodeType} node`,
								node: result.node,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Make sure the parent node supports children (frames, groups, etc.)",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// ADVANCED: Arrange Component Set
	// ============================================================================

	server.tool(
		"figma_arrange_component_set",
		`Organize a component set with Figma's native purple dashed visualization. Use after creating variants, adding states (hover/disabled/pressed), or when component sets need cleanup.

Recreates the set using figma.combineAsVariants() for proper Figma integration, applies purple dashed border styling, and arranges variants in a labeled grid (columns = last property like State, rows = other properties like Type+Size). Creates a white container with title, row/column labels, and the component set.`,
		{
			componentSetId: z
				.string()
				.optional()
				.describe(
					"Node ID of the component set to arrange. If not provided, will look for a selected component set.",
				),
			componentSetName: z
				.string()
				.optional()
				.describe(
					"Name of the component set to find. Used if componentSetId not provided.",
				),
			options: z
				.object({
					gap: z
						.number()
						.optional()
						.default(24)
						.describe("Gap between grid cells in pixels (default: 24)"),
					cellPadding: z
						.number()
						.optional()
						.default(20)
						.describe("Padding inside each cell around the variant (default: 20)"),
					columnProperty: z
						.string()
						.optional()
						.describe(
							"Property to use for columns (default: auto-detect last property, usually 'State')",
						),
				})
				.optional()
				.describe("Layout options"),
		},
		async ({ componentSetId, componentSetName, options }) => {
			try {
				const connector = await getConnector();
				const code = `
// ============================================================================
// COMPONENT SET ARRANGEMENT WITH PROPER LABELS AND CONTAINER
// ============================================================================

const config = ${JSON.stringify(options || {})};
const gap = config.gap ?? 24;
const cellPadding = config.cellPadding ?? 20;
const columnProperty = config.columnProperty || null;

const LABEL_FONT_SIZE = 12;
const LABEL_COLOR = { r: 0.4, g: 0.4, b: 0.4 };
const TITLE_FONT_SIZE = 24;
const TITLE_COLOR = { r: 0.1, g: 0.1, b: 0.1 };
const CONTAINER_PADDING = 40;
const LABEL_GAP = 16;
const COLUMN_HEADER_HEIGHT = 32;

let componentSet = null;
const csId = ${JSON.stringify(componentSetId || null)};
const csName = ${JSON.stringify(componentSetName || null)};

if (csId) {
	componentSet = await figma.getNodeByIdAsync(csId);
} else if (csName) {
	const allNodes = figma.currentPage.findAll(n => n.type === "COMPONENT_SET" && n.name === csName);
	componentSet = allNodes[0];
} else {
	const selection = figma.currentPage.selection;
	componentSet = selection.find(n => n.type === "COMPONENT_SET");
}

if (!componentSet || componentSet.type !== "COMPONENT_SET") {
	return { error: "Component set not found. Provide componentSetId, componentSetName, or select a component set." };
}

const page = figma.currentPage;
const csOriginalX = componentSet.x;
const csOriginalY = componentSet.y;
const csOriginalName = componentSet.name;

const variants = componentSet.children.filter(n => n.type === "COMPONENT");
if (variants.length === 0) {
	return { error: "No variants found in component set" };
}

const parseVariantName = (name) => {
	const props = {};
	const parts = name.split(", ");
	for (const part of parts) {
		const [key, value] = part.split("=");
		if (key && value) { props[key.trim()] = value.trim(); }
	}
	return props;
};

const propertyValues = {};
const propertyOrder = [];
for (const variant of variants) {
	const props = parseVariantName(variant.name);
	for (const [key, value] of Object.entries(props)) {
		if (!propertyValues[key]) { propertyValues[key] = new Set(); propertyOrder.push(key); }
		propertyValues[key].add(value);
	}
}
for (const key of Object.keys(propertyValues)) { propertyValues[key] = Array.from(propertyValues[key]); }

const columnProp = columnProperty || propertyOrder[propertyOrder.length - 1];
const columnValues = propertyValues[columnProp] || [];
const rowProps = propertyOrder.filter(p => p !== columnProp);

const generateRowCombinations = (props, values) => {
	if (props.length === 0) return [{}];
	if (props.length === 1) return values[props[0]].map(v => ({ [props[0]]: v }));
	const result = [];
	const firstProp = props[0];
	const restProps = props.slice(1);
	const restCombos = generateRowCombinations(restProps, values);
	for (const value of values[firstProp]) {
		for (const combo of restCombos) { result.push({ [firstProp]: value, ...combo }); }
	}
	return result;
};
const rowCombinations = generateRowCombinations(rowProps, propertyValues);

const totalCols = columnValues.length;
const totalRows = rowCombinations.length;

let maxVariantWidth = 0;
let maxVariantHeight = 0;
for (const v of variants) {
	if (v.width > maxVariantWidth) maxVariantWidth = v.width;
	if (v.height > maxVariantHeight) maxVariantHeight = v.height;
}

const cellWidth = Math.ceil(maxVariantWidth + cellPadding);
const cellHeight = Math.ceil(maxVariantHeight + cellPadding);
const edgePadding = 24;
const csWidth = (totalCols * cellWidth) + ((totalCols - 1) * gap) + (edgePadding * 2);
const csHeight = (totalRows * cellHeight) + ((totalRows - 1) * gap) + (edgePadding * 2);

const oldElements = page.children.filter(n =>
	(n.type === "TEXT" && (n.name.startsWith("Row: ") || n.name.startsWith("Col: "))) ||
	(n.type === "FRAME" && (n.name === "Component Container" || n.name === "Row Labels" || n.name === "Column Headers"))
);
for (const el of oldElements) { el.remove(); }

const clonedVariants = [];
for (const variant of variants) {
	const clone = variant.clone();
	page.appendChild(clone);
	clonedVariants.push(clone);
}
componentSet.remove();

const newComponentSet = figma.combineAsVariants(clonedVariants, page);
newComponentSet.name = csOriginalName;
newComponentSet.strokes = [{ type: 'SOLID', color: { r: 151/255, g: 71/255, b: 255/255 } }];
newComponentSet.dashPattern = [10, 5];
newComponentSet.strokeWeight = 1;
newComponentSet.strokeAlign = "INSIDE";

const newVariants = newComponentSet.children.filter(n => n.type === "COMPONENT");
for (const variant of newVariants) {
	const props = parseVariantName(variant.name);
	const colValue = props[columnProp];
	const colIdx = columnValues.indexOf(colValue);
	let rowIdx = -1;
	for (let i = 0; i < rowCombinations.length; i++) {
		const combo = rowCombinations[i];
		let match = true;
		for (const [key, value] of Object.entries(combo)) {
			if (props[key] !== value) { match = false; break; }
		}
		if (match) { rowIdx = i; break; }
	}
	if (colIdx >= 0 && rowIdx >= 0) {
		const cellX = edgePadding + colIdx * (cellWidth + gap);
		const cellY = edgePadding + rowIdx * (cellHeight + gap);
		variant.x = Math.round(cellX + (cellWidth - variant.width) / 2);
		variant.y = Math.round(cellY + (cellHeight - variant.height) / 2);
	}
}
newComponentSet.resize(csWidth, csHeight);

await figma.loadFontAsync({ family: "Inter", style: "Regular" });
await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });

const containerFrame = figma.createFrame();
containerFrame.name = "Component Container";
containerFrame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
containerFrame.cornerRadius = 8;
containerFrame.layoutMode = 'VERTICAL';
containerFrame.primaryAxisSizingMode = 'AUTO';
containerFrame.counterAxisSizingMode = 'AUTO';
containerFrame.paddingTop = CONTAINER_PADDING;
containerFrame.paddingRight = CONTAINER_PADDING;
containerFrame.paddingBottom = CONTAINER_PADDING;
containerFrame.paddingLeft = CONTAINER_PADDING;
containerFrame.itemSpacing = 24;

const titleText = figma.createText();
titleText.name = "Title";
titleText.characters = csOriginalName;
titleText.fontSize = TITLE_FONT_SIZE;
titleText.fontName = { family: "Inter", style: "Semi Bold" };
titleText.fills = [{ type: 'SOLID', color: TITLE_COLOR }];
containerFrame.appendChild(titleText);
titleText.layoutSizingHorizontal = 'HUG';
titleText.layoutSizingVertical = 'HUG';

const contentRow = figma.createFrame();
contentRow.name = "Content Row";
contentRow.fills = [];
contentRow.layoutMode = 'HORIZONTAL';
contentRow.primaryAxisSizingMode = 'AUTO';
contentRow.counterAxisSizingMode = 'AUTO';
contentRow.itemSpacing = LABEL_GAP;
contentRow.counterAxisAlignItems = 'MIN';
containerFrame.appendChild(contentRow);

const rowLabelsFrame = figma.createFrame();
rowLabelsFrame.name = "Row Labels";
rowLabelsFrame.fills = [];
rowLabelsFrame.layoutMode = 'VERTICAL';
rowLabelsFrame.primaryAxisSizingMode = 'AUTO';
rowLabelsFrame.counterAxisSizingMode = 'AUTO';
rowLabelsFrame.counterAxisAlignItems = 'MAX';
rowLabelsFrame.itemSpacing = 0;

const rowLabelSpacer = figma.createFrame();
rowLabelSpacer.name = "Spacer";
rowLabelSpacer.fills = [];
rowLabelSpacer.resize(10, COLUMN_HEADER_HEIGHT + gap + edgePadding);
rowLabelsFrame.appendChild(rowLabelSpacer);
rowLabelSpacer.layoutSizingVertical = 'FIXED';

for (let i = 0; i < rowCombinations.length; i++) {
	const combo = rowCombinations[i];
	const labelText = rowProps.map(p => combo[p]).join(" / ");
	const isLastRow = (i === rowCombinations.length - 1);
	const rowLabelContainer = figma.createFrame();
	rowLabelContainer.name = "Row: " + labelText;
	rowLabelContainer.fills = [];
	rowLabelContainer.layoutMode = 'VERTICAL';
	rowLabelContainer.primaryAxisSizingMode = 'FIXED';
	rowLabelContainer.primaryAxisAlignItems = 'CENTER';
	rowLabelContainer.counterAxisAlignItems = 'MAX';
	rowLabelContainer.resize(10, cellHeight);
	const label = figma.createText();
	label.characters = labelText;
	label.fontSize = LABEL_FONT_SIZE;
	label.fontName = { family: "Inter", style: "Regular" };
	label.fills = [{ type: 'SOLID', color: LABEL_COLOR }];
	label.textAlignHorizontal = 'RIGHT';
	rowLabelContainer.appendChild(label);
	rowLabelsFrame.appendChild(rowLabelContainer);
	rowLabelContainer.layoutSizingHorizontal = 'HUG';
	rowLabelContainer.layoutSizingVertical = 'FIXED';
	if (!isLastRow) {
		const gapSpacer = figma.createFrame();
		gapSpacer.name = "Row Gap";
		gapSpacer.fills = [];
		gapSpacer.resize(1, gap);
		rowLabelsFrame.appendChild(gapSpacer);
		gapSpacer.layoutSizingHorizontal = 'FIXED';
		gapSpacer.layoutSizingVertical = 'FIXED';
	}
}
contentRow.appendChild(rowLabelsFrame);

const gridColumn = figma.createFrame();
gridColumn.name = "Grid Column";
gridColumn.fills = [];
gridColumn.layoutMode = 'VERTICAL';
gridColumn.primaryAxisSizingMode = 'AUTO';
gridColumn.counterAxisSizingMode = 'AUTO';
gridColumn.itemSpacing = gap;

const columnHeadersRow = figma.createFrame();
columnHeadersRow.name = "Column Headers";
columnHeadersRow.fills = [];
columnHeadersRow.layoutMode = 'HORIZONTAL';
columnHeadersRow.resize(csWidth, COLUMN_HEADER_HEIGHT);
columnHeadersRow.itemSpacing = 0;
columnHeadersRow.paddingLeft = edgePadding;
columnHeadersRow.paddingRight = edgePadding;

for (let i = 0; i < columnValues.length; i++) {
	const colValue = columnValues[i];
	const isLastCol = (i === columnValues.length - 1);
	const colHeaderContainer = figma.createFrame();
	colHeaderContainer.name = "Col: " + colValue;
	colHeaderContainer.fills = [];
	colHeaderContainer.layoutMode = 'HORIZONTAL';
	colHeaderContainer.primaryAxisAlignItems = 'CENTER';
	colHeaderContainer.counterAxisAlignItems = 'MAX';
	const colWidth = isLastCol ? cellWidth : cellWidth + gap;
	colHeaderContainer.resize(colWidth, COLUMN_HEADER_HEIGHT);
	if (!isLastCol) { colHeaderContainer.paddingRight = gap; }
	const label = figma.createText();
	label.characters = colValue;
	label.fontSize = LABEL_FONT_SIZE;
	label.fontName = { family: "Inter", style: "Regular" };
	label.fills = [{ type: 'SOLID', color: LABEL_COLOR }];
	label.textAlignHorizontal = 'CENTER';
	colHeaderContainer.appendChild(label);
	columnHeadersRow.appendChild(colHeaderContainer);
	colHeaderContainer.layoutSizingHorizontal = 'FIXED';
	colHeaderContainer.layoutSizingVertical = 'FILL';
}
gridColumn.appendChild(columnHeadersRow);
columnHeadersRow.layoutSizingHorizontal = 'FIXED';
columnHeadersRow.layoutSizingVertical = 'FIXED';

const componentSetWrapper = figma.createFrame();
componentSetWrapper.name = "Component Set Wrapper";
componentSetWrapper.fills = [];
componentSetWrapper.resize(csWidth, csHeight);
componentSetWrapper.appendChild(newComponentSet);
newComponentSet.x = 0;
newComponentSet.y = 0;
gridColumn.appendChild(componentSetWrapper);
componentSetWrapper.layoutSizingHorizontal = 'FIXED';
componentSetWrapper.layoutSizingVertical = 'FIXED';

contentRow.appendChild(gridColumn);

containerFrame.x = csOriginalX - CONTAINER_PADDING - 120;
containerFrame.y = csOriginalY - CONTAINER_PADDING - TITLE_FONT_SIZE - 24 - COLUMN_HEADER_HEIGHT - gap;

figma.currentPage.selection = [containerFrame];
figma.viewport.scrollAndZoomIntoView([containerFrame]);

return {
	success: true,
	message: "Component set arranged with proper container, labels, and alignment",
	containerId: containerFrame.id,
	componentSetId: newComponentSet.id,
	componentSetName: newComponentSet.name,
	grid: {
		rows: totalRows,
		columns: totalCols,
		cellWidth, cellHeight, gap,
		columnProperty: columnProp,
		columnValues,
		rowProperties: rowProps,
		rowLabels: rowCombinations.map(combo => rowProps.map(p => combo[p]).join(" / "))
	},
	componentSetSize: { width: csWidth, height: csHeight },
	variantCount: newVariants.length,
};
`;
				const result = await connector.executeCodeViaUI(code, 25000);
				if (!result.success) {
					throw new Error(result.error || "Failed to arrange component set");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								...result.result,
								hint: result.result?.success
									? "Component set arranged in a white container frame with properly aligned row and column labels. The purple dashed border is visible. Use figma_capture_screenshot to validate the layout."
									: undefined,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Make sure the Desktop Bridge plugin is running and a component set exists.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// DESKTOP BRIDGE OBSERVABILITY (remote / Supabase relay mode)
	// ============================================================================

	server.tool(
		"figma_get_status",
		`Check connection status to Figma Desktop. Reports which transport is active (CDP or WebSocket) and connection health. Works with both CDP (--remote-debugging-port=9222) and WebSocket (Desktop Bridge plugin) transports.`,
		{},
		async () => {
			try {
				const connector = await getConnector();
				const result = await connector.ping();
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								connected: result?.connected ?? false,
								transport: connector.getTransportType(),
								fileKey: result?.fileKey ?? null,
								fileName: result?.fileName ?? null,
								currentPage: result?.currentPage ?? null,
								selectionCount: result?.selectionCount ?? 0,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								connected: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_list_open_files",
		`List all Figma files currently connected via the Desktop Bridge plugin. Shows which files have the plugin open and which one is the active target for tool calls. Use figma_navigate to switch between files. WebSocket multi-client mode — each file with the Desktop Bridge plugin maintains its own connection.`,
		{},
		async () => {
			try {
				const connector = await getConnector();
				const result = await connector.ping();
				const files = result?.connected
					? [
							{
								fileKey: result.fileKey,
								fileName: result.fileName,
								currentPage: result.currentPage,
								currentPageId: result.currentPageId,
								selectionCount: result.selectionCount,
								active: true,
							},
						]
					: [];
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ files, count: files.length }),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								files: [],
								count: 0,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_get_selection",
		`Get the currently selected nodes in Figma. Returns node IDs, names, types, and dimensions. WebSocket-only — requires Desktop Bridge plugin. Use this to understand what the user is pointing at instead of asking them to describe it.`,
		{
			verbose: z
				.boolean()
				.optional()
				.describe(
					"If true, fetches additional details (fills, strokes, styles) for each selected node via figma_execute",
				),
		},
		async ({ verbose }) => {
			try {
				const connector = await getConnector();
				let nodes: any[];
				if (verbose) {
					const code = `(function() {
  var sel = figma.currentPage.selection;
  return sel.map(function(n) {
    var obj = { id: n.id, name: n.name, type: n.type };
    if (n.width !== undefined) obj.width = n.width;
    if (n.height !== undefined) obj.height = n.height;
    if (n.fills !== undefined) obj.fills = n.fills;
    if (n.strokes !== undefined) obj.strokes = n.strokes;
    return obj;
  });
})()`;
					nodes = await connector.executeCodeViaUI(code, 5000);
				} else {
					nodes = await connector.getSelection();
				}
				const safeNodes = Array.isArray(nodes) ? nodes : [];
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ nodes: safeNodes, count: safeNodes.length }),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								nodes: [],
								count: 0,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_reload_plugin",
		`Reload the current Figma page/plugin to test code changes. Optionally clears console logs before reload. Use when user says: 'reload plugin', 'refresh page', 'restart plugin', 'test my changes'. Returns reload confirmation and current URL. Best for rapid iteration during plugin development.`,
		{
			clearConsole: z
				.boolean()
				.optional()
				.describe("Clear console logs before reload"),
		},
		async ({ clearConsole: shouldClear }) => {
			try {
				const connector = await getConnector();
				if (shouldClear) {
					await connector.clearConsole();
				}
				const result = await connector.reloadPlugin();
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								reloaded: true,
								consoleCleared: shouldClear ?? false,
								result,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								reloaded: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_get_console_logs",
		`Get browser console output (log, info, warn, error, debug). Use to check runtime behavior, debug values, or client-side errors. Use 'level' to filter to errors or warnings only.`,
		{
			level: z
				.enum(["all", "error", "warn", "log", "info", "debug"])
				.optional()
				.describe(
					"Filter by level: 'all' (default), 'error' (errors only), 'warn' (warnings + errors)",
				),
			lines: z
				.number()
				.min(1)
				.max(200)
				.optional()
				.describe("Max lines to return (default: 50, max: 200)"),
			since: z
				.number()
				.optional()
				.describe("Only logs after this timestamp (Unix ms)"),
		},
		async ({ level, lines, since }) => {
			try {
				const connector = await getConnector();
				const opts: { since?: number; level?: string; lines?: number } = {};
				if (since !== undefined) opts.since = since;
				if (level && level !== "all") opts.level = level;
				if (lines !== undefined) opts.lines = lines;
				let logs: any[] = await connector.getConsoleLogs(opts);
				if (!Array.isArray(logs)) logs = [];
				// Apply level filter client-side as well (belt and suspenders)
				if (level && level !== "all") {
					const levels = level === "warn" ? ["warn", "error"] : [level];
					logs = logs.filter((l: any) => levels.includes(l.level));
				}
				// Apply lines limit
				const limit = lines ?? 50;
				logs = logs.slice(-limit);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ logs, count: logs.length }),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								logs: [],
								count: 0,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_clear_console",
		`Clear the console log buffer. In WebSocket mode, this safely clears the buffer without disrupting the connection. In CDP mode, this disrupts monitoring and requires MCP reconnect. Returns number of logs cleared.`,
		{},
		async () => {
			try {
				const connector = await getConnector();
				const result = await connector.clearConsole();
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ cleared: true, result }),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								cleared: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_get_design_changes",
		`Get recent document changes detected in Figma. Returns buffered change events including which nodes changed, whether styles were modified, and change counts. WebSocket-only — events are captured via Desktop Bridge plugin. Use this to understand what changed since you last checked.`,
		{
			count: z
				.number()
				.min(1)
				.optional()
				.describe(
					"Maximum number of change events to return (chronological order, oldest to newest; returns the last N events)",
				),
			since: z
				.number()
				.optional()
				.describe(
					"Only return changes after this Unix timestamp (ms). Useful for incremental polling.",
				),
			clear: z
				.boolean()
				.optional()
				.describe(
					"Clear the change buffer after reading. Set to true for polling workflows.",
				),
		},
		async ({ count, since, clear }) => {
			try {
				const connector = await getConnector();
				const opts: { since?: number; clear?: boolean; count?: number } = {};
				if (since !== undefined) opts.since = since;
				if (clear !== undefined) opts.clear = clear;
				if (count !== undefined) opts.count = count;
				let changes: any[] = await connector.getDesignChanges(opts);
				if (!Array.isArray(changes)) changes = [];
				if (count !== undefined) changes = changes.slice(-count);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ changes, count: changes.length }),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								changes: [],
								count: 0,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_watch_console",
		`Stream console logs in real-time for a specified duration (max 5 minutes). Use for monitoring plugin execution while user tests manually. Returns all logs captured during watch period with summary statistics. NOT for retrieving past logs (use figma_get_console_logs). Best for: watching plugin output during manual testing, debugging race conditions, monitoring async operations.`,
		{
			duration: z
				.number()
				.min(1)
				.max(300)
				.describe("How long to watch in seconds"),
			level: z
				.enum(["all", "error", "warn", "log", "info", "debug"])
				.optional()
				.describe("Filter by log level"),
		},
		async ({ duration, level }) => {
			try {
				const connector = await getConnector();
				const startTime = Date.now();
				// Cap sleep at 20 s to stay within Worker wall-time budget
				const sleepMs = Math.min(duration * 1000, 20_000);
				await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
				const opts: { since?: number; level?: string } = { since: startTime };
				if (level && level !== "all") opts.level = level;
				let logs: any[] = await connector.getConsoleLogs(opts);
				if (!Array.isArray(logs)) logs = [];
				if (level && level !== "all") {
					const levels = level === "warn" ? ["warn", "error"] : [level];
					logs = logs.filter((l: any) => levels.includes(l.level));
				}
				const summary = {
					total: logs.length,
					errors: logs.filter((l: any) => l.level === "error").length,
					warnings: logs.filter((l: any) => l.level === "warn").length,
					info: logs.filter((l: any) => ["log", "info", "debug"].includes(l.level)).length,
				};
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ logs, summary, watchedMs: Date.now() - startTime }),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								logs: [],
								summary: { total: 0, errors: 0, warnings: 0, info: 0 },
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
