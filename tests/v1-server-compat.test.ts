/**
 * Spike: the shared src/core tool modules now call registerTool(name, { inputSchema: z.object(...) }, cb)
 * (the v2 form). The Cloudflare build still hands them a v1 McpServer (agents' McpAgent is v1-only).
 * Check that v1 accepts the same calls at runtime and validates arguments.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSlotTools } from "../src/core/slot-tools";
import { wrapServerForIdentity } from "../src/core/identity";

describe("v1 McpServer runs the v2-style shared tool modules", () => {
	it("lists, validates, and calls tools", async () => {
		const server = new McpServer({ name: "cloud", version: "0" });
		wrapServerForIdentity(server as any);
		const connector = { getSlots: jest.fn().mockResolvedValue({ success: true, slots: [] }) };
		registerSlotTools(server as any, async () => connector as any);

		const [ct, st] = InMemoryTransport.createLinkedPair();
		await server.connect(st);
		const client = new Client({ name: "c", version: "0" });
		await client.connect(ct);

		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toContain("figma_get_slots");
		const getSlots = tools.find((t) => t.name === "figma_get_slots")!;
		expect(getSlots.inputSchema.type).toBe("object");
		expect(Object.keys(getSlots.inputSchema.properties ?? {}).length).toBeGreaterThan(0);

		const bad = await client.callTool({ name: "figma_get_slots", arguments: { nodeId: 42 } });
		expect(bad.isError).toBe(true);

		await client.close();
		await server.close();
	});
});
