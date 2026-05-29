import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "slot-tools" });

const SLOT_LAYOUT_MODES = ["NONE", "HORIZONTAL", "VERTICAL"] as const;
const SLOT_CHILD_NODE_TYPES = [
	"FRAME",
	"RECTANGLE",
	"ELLIPSE",
	"TEXT",
	"LINE",
	"POLYGON",
	"STAR",
	"VECTOR",
] as const;

const preferredValueSchema = z.object({
	type: z.enum(["COMPONENT", "COMPONENT_SET"]).describe("Type of preferred value"),
	key: z.string().describe("Component or component set key"),
});

/**
 * Register MCP tools for Figma Slots (open beta).
 * Requires Desktop Bridge and a Figma Desktop version with SlotNode API support.
 */
export function registerSlotTools(
	server: McpServer,
	getDesktopConnector: () => Promise<any>,
): void {
	server.tool(
		"figma_create_slot",
		`Create a SlotNode inside a component using createSlot(). Automatically creates a linked SLOT component property. Slots are freeform drop zones for instance content — more flexible than INSTANCE_SWAP. Requires a standalone COMPONENT (not a variant inside a COMPONENT_SET). GRID layout is not allowed on slots. Requires Desktop Bridge.`,
		{
			nodeId: z
				.string()
				.describe("The COMPONENT node ID to add a slot to"),
			name: z
				.string()
				.optional()
				.describe("Slot layer name (e.g. 'Content', 'Footer')"),
			width: z
				.number()
				.optional()
				.describe("Initial slot width in pixels"),
			height: z
				.number()
				.optional()
				.describe("Initial slot height in pixels"),
			layoutMode: z
				.enum(SLOT_LAYOUT_MODES)
				.optional()
				.describe("Auto-layout mode for the slot (GRID is not supported)"),
		},
		async ({ nodeId, name, width, height, layoutMode }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.createSlot(nodeId, {
					name,
					width,
					height,
					layoutMode,
				});

				if (!result.success) {
					throw new Error(result.error || "Failed to create slot");
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								slot: result.slot,
								hint: "Use figma_get_slots to inspect slots. Populate instance slots with figma_append_to_slot (not figma_set_instance_properties).",
							}),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_create_slot failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Target a standalone COMPONENT. Add slots to variant components before combineAsVariants. Ensure Figma Desktop supports Slots (open beta).",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_get_slots",
		`List SlotNode children on a component, component set, or instance. Returns slot IDs, names, property keys, dimensions, and current child nodes. Use on instances before figma_append_to_slot to discover slot names/IDs.`,
		{
			nodeId: z
				.string()
				.describe("COMPONENT, COMPONENT_SET, or INSTANCE node ID"),
		},
		async ({ nodeId }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.getSlots(nodeId);

				if (!result.success) {
					throw new Error(result.error || "Failed to get slots");
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result.data ?? result),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_get_slots failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Ensure the node is a component or instance with slots, and Desktop Bridge is connected.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_append_to_slot",
		`Add content to a slot on a component instance. Clones sourceNodeId into the slot, or creates a new node (nodeType). SLOT content cannot be set via figma_set_instance_properties — use this tool instead. Widgets, stickies, and raw ComponentNodes cannot be appended to slots.`,
		{
			slotId: z
				.string()
				.optional()
				.describe("Direct SlotNode ID (from figma_get_slots)"),
			instanceId: z
				.string()
				.optional()
				.describe("Instance ID — use with slotName when slotId is unknown"),
			slotName: z
				.string()
				.optional()
				.describe("Slot layer name on the instance (e.g. 'Content')"),
			sourceNodeId: z
				.string()
				.optional()
				.describe("Node to clone into the slot (default: clone=true)"),
			nodeType: z
				.enum(SLOT_CHILD_NODE_TYPES)
				.optional()
				.describe("Create a new node in the slot instead of cloning"),
			properties: z
				.record(z.string(), z.union([z.string(), z.number()]))
				.optional()
				.describe("Properties for created nodes: name, text, width, height"),
			clone: z
				.boolean()
				.optional()
				.default(true)
				.describe("When using sourceNodeId, clone the node (default true). Set false to move."),
			clearExisting: z
				.boolean()
				.optional()
				.default(false)
				.describe("Remove existing slot children before appending"),
		},
		async (args) => {
			try {
				if (!args.slotId && !(args.instanceId && args.slotName)) {
					throw new Error("Provide slotId OR (instanceId + slotName)");
				}
				if (!args.sourceNodeId && !args.nodeType) {
					throw new Error("Provide sourceNodeId (clone into slot) or nodeType (create new content)");
				}

				const connector = await getDesktopConnector();
				const result = await connector.appendToSlot(args);

				if (!result.success) {
					throw new Error(result.error || "Failed to append to slot");
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								slot: result.slot,
								appendedNode: result.appendedNode,
								hint: "Use figma_capture_screenshot to verify slot content visually.",
							}),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_append_to_slot failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hints: [
									"Use figma_get_slots on the instance to find slot IDs/names",
									"Clone instances or frames — not raw ComponentNodes",
									"SLOT properties cannot be set via figma_set_instance_properties",
								],
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_reset_slot",
		`Reset a slot on a component instance to its default (empty) state from the main component. Uses SlotNode.resetSlot().`,
		{
			slotId: z
				.string()
				.optional()
				.describe("Direct SlotNode ID"),
			instanceId: z
				.string()
				.optional()
				.describe("Instance ID — use with slotName when slotId is unknown"),
			slotName: z
				.string()
				.optional()
				.describe("Slot layer name on the instance"),
		},
		async ({ slotId, instanceId, slotName }) => {
			try {
				if (!slotId && !(instanceId && slotName)) {
					throw new Error("Provide slotId OR (instanceId + slotName)");
				}

				const connector = await getDesktopConnector();
				const result = await connector.resetSlot({ slotId, instanceId, slotName });

				if (!result.success) {
					throw new Error(result.error || "Failed to reset slot");
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								slot: result.slot,
							}),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_reset_slot failed");
				return {
					content: [
						{
							type: "text" as const,
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
		"figma_add_slot_property",
		`Manually add a SLOT component property and bind it to an existing frame (alternative to figma_create_slot). The frame must be a direct child of the component, must not use GRID layout, and must not be nested inside another slot. Supports description and preferredValues.`,
		{
			nodeId: z.string().describe("COMPONENT or COMPONENT_SET node ID"),
			propertyName: z.string().describe("Slot property name (e.g. 'Content')"),
			frameNodeId: z
				.string()
				.describe("Frame node ID to bind as the slot content area"),
			description: z
				.string()
				.optional()
				.describe("Slot property description (SLOT-only)"),
			preferredValues: z
				.array(preferredValueSchema)
				.optional()
				.describe("Preferred components for slot content (SLOT-only)"),
		},
		async ({ nodeId, propertyName, frameNodeId, description, preferredValues }) => {
			try {
				const connector = await getDesktopConnector();
				const code = `
const component = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!component || (component.type !== 'COMPONENT' && component.type !== 'COMPONENT_SET')) {
  throw new Error('Node must be COMPONENT or COMPONENT_SET');
}
const frame = await figma.getNodeByIdAsync(${JSON.stringify(frameNodeId)});
if (!frame || frame.type !== 'FRAME') {
  throw new Error('frameNodeId must be a FRAME node');
}
if (frame.parent !== component) {
  throw new Error('Frame must be a direct child of the component');
}
if (frame.layoutMode === 'GRID') {
  throw new Error('GRID layoutMode is not allowed on slot frames');
}
const options = {};
${description ? `options.description = ${JSON.stringify(description)};` : ""}
${preferredValues ? `options.preferredValues = ${JSON.stringify(preferredValues)};` : ""}
const propKey = component.addComponentProperty(${JSON.stringify(propertyName)}, 'SLOT', '', Object.keys(options).length ? options : undefined);
frame.componentPropertyReferences = { slotContentId: propKey };
return { propertyKey: propKey, frameId: frame.id, frameName: frame.name };
`;
				const result = await connector.executeCodeViaUI(code, 10000);

				if (!result.success) {
					throw new Error(result.error || "Failed to add slot property");
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								result: result.result,
								hint: "Prefer figma_create_slot() for new slots — it creates the SlotNode and property automatically.",
							}),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_add_slot_property failed");
				return {
					content: [
						{
							type: "text" as const,
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
}
