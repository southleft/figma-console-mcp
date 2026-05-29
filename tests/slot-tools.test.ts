/**
 * Slot Tools Tests
 *
 * Unit tests for Figma Slots MCP tools.
 */

import { registerSlotTools } from "../src/core/slot-tools";

interface RegisteredTool {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function createMockServer() {
	const tools: Record<string, RegisteredTool> = {};
	return {
		tool: jest.fn(
			(name: string, description: string, schema: Record<string, unknown>, handler: RegisteredTool["handler"]) => {
				tools[name] = { name, description, schema, handler };
			},
		),
		_tools: tools,
		_getTool(name: string): RegisteredTool {
			return tools[name];
		},
	};
}

function createMockConnector(overrides: Record<string, jest.Mock> = {}) {
	return {
		createSlot: jest.fn().mockResolvedValue({
			success: true,
			slot: {
				id: "1:10",
				name: "Content",
				type: "SLOT",
				propertyKey: "Content#1:10",
				width: 320,
				height: 200,
				layoutMode: "VERTICAL",
			},
		}),
		getSlots: jest.fn().mockResolvedValue({
			success: true,
			data: {
				nodeId: "1:2",
				nodeType: "INSTANCE",
				count: 1,
				slots: [
					{
						id: "1:10",
						name: "Content",
						type: "SLOT",
						propertyKey: "Content#1:10",
						children: [],
					},
				],
			},
		}),
		appendToSlot: jest.fn().mockResolvedValue({
			success: true,
			slot: { id: "1:10", name: "Content" },
			appendedNode: { id: "1:11", name: "Button", type: "FRAME" },
		}),
		resetSlot: jest.fn().mockResolvedValue({
			success: true,
			slot: { id: "1:10", name: "Content", childCount: 0 },
		}),
		executeCodeViaUI: jest.fn().mockResolvedValue({
			success: true,
			result: { propertyKey: "Content#1:10", frameId: "1:5", frameName: "Content" },
		}),
		...overrides,
	};
}

describe("registerSlotTools", () => {
	test("registers all five slot tools", () => {
		const server = createMockServer();
		registerSlotTools(server as never, async () => createMockConnector());

		expect(Object.keys(server._tools).sort()).toEqual([
			"figma_add_slot_property",
			"figma_append_to_slot",
			"figma_create_slot",
			"figma_get_slots",
			"figma_reset_slot",
		]);
	});

	test("figma_create_slot calls connector.createSlot", async () => {
		const server = createMockServer();
		const connector = createMockConnector();
		registerSlotTools(server as never, async () => connector);

		const result = await server._getTool("figma_create_slot").handler({
			nodeId: "1:2",
			name: "Content",
			width: 320,
			height: 200,
			layoutMode: "VERTICAL",
		});

		expect(connector.createSlot).toHaveBeenCalledWith("1:2", {
			name: "Content",
			width: 320,
			height: 200,
			layoutMode: "VERTICAL",
		});
		expect(result.isError).toBeUndefined();
		const payload = JSON.parse(result.content[0].text);
		expect(payload.success).toBe(true);
		expect(payload.slot.name).toBe("Content");
	});

	test("figma_get_slots returns slot list", async () => {
		const server = createMockServer();
		const connector = createMockConnector();
		registerSlotTools(server as never, async () => connector);

		const result = await server._getTool("figma_get_slots").handler({ nodeId: "1:2" });
		expect(connector.getSlots).toHaveBeenCalledWith("1:2");
		const payload = JSON.parse(result.content[0].text);
		expect(payload.count).toBe(1);
		expect(payload.slots[0].name).toBe("Content");
	});

	test("figma_append_to_slot requires slot target and content source", async () => {
		const server = createMockServer();
		registerSlotTools(server as never, async () => createMockConnector());

		const missingTarget = await server._getTool("figma_append_to_slot").handler({
			sourceNodeId: "1:99",
		});
		expect(missingTarget.isError).toBe(true);

		const missingSource = await server._getTool("figma_append_to_slot").handler({
			slotId: "1:10",
		});
		expect(missingSource.isError).toBe(true);
	});

	test("figma_append_to_slot clones into slot by slotId", async () => {
		const server = createMockServer();
		const connector = createMockConnector();
		registerSlotTools(server as never, async () => connector);

		const result = await server._getTool("figma_append_to_slot").handler({
			slotId: "1:10",
			sourceNodeId: "1:99",
			clearExisting: true,
		});

		expect(connector.appendToSlot).toHaveBeenCalledWith(
			expect.objectContaining({
				slotId: "1:10",
				sourceNodeId: "1:99",
				clearExisting: true,
			}),
		);
		expect(result.isError).toBeUndefined();
	});

	test("figma_reset_slot resolves by instanceId + slotName", async () => {
		const server = createMockServer();
		const connector = createMockConnector();
		registerSlotTools(server as never, async () => connector);

		await server._getTool("figma_reset_slot").handler({
			instanceId: "1:2",
			slotName: "Content",
		});

		expect(connector.resetSlot).toHaveBeenCalledWith({
			instanceId: "1:2",
			slotName: "Content",
		});
	});

	test("figma_add_slot_property executes binding code", async () => {
		const server = createMockServer();
		const connector = createMockConnector();
		registerSlotTools(server as never, async () => connector);

		const result = await server._getTool("figma_add_slot_property").handler({
			nodeId: "1:2",
			propertyName: "Content",
			frameNodeId: "1:5",
			description: "Main content area",
		});

		expect(connector.executeCodeViaUI).toHaveBeenCalled();
		const payload = JSON.parse(result.content[0].text);
		expect(payload.success).toBe(true);
		expect(payload.result.propertyKey).toBe("Content#1:10");
	});
});

describe("WebSocket slot commands", () => {
	test("connector exposes slot methods", async () => {
		const { WebSocketConnector } = await import("../src/core/websocket-connector");
		const mockServer = {
			isClientConnected: () => false,
			sendCommand: jest.fn().mockResolvedValue({ success: true }),
		};
		const connector = new WebSocketConnector(mockServer as never);

		await connector.createSlot("1:2", { name: "Content" });
		expect(mockServer.sendCommand).toHaveBeenCalledWith("CREATE_SLOT", {
			nodeId: "1:2",
			name: "Content",
		});

		await connector.getSlots("1:2");
		expect(mockServer.sendCommand).toHaveBeenCalledWith("GET_SLOTS", { nodeId: "1:2" });

		await connector.appendToSlot({ slotId: "1:10", sourceNodeId: "1:99" });
		expect(mockServer.sendCommand).toHaveBeenCalledWith("APPEND_TO_SLOT", {
			slotId: "1:10",
			sourceNodeId: "1:99",
		});

		await connector.resetSlot({ slotId: "1:10" });
		expect(mockServer.sendCommand).toHaveBeenCalledWith("RESET_SLOT", { slotId: "1:10" });
	});
});
