/**
 * Spike: the shared src/core tool modules now call registerTool(name, { inputSchema: z.object(...) }, cb)
 * (the v2 form). The Cloudflare build still hands them a v1 McpServer (agents' McpAgent is v1-only).
 * Check that v1 accepts the same calls at runtime and validates arguments.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSlotTools } from "../src/core/slot-tools";
import { registerAssetTools } from "../src/core/asset-tools";
import { withToolIdentity } from "../src/core/identity";

describe("v1 McpServer runs the v2-style shared tool modules", () => {
	it("lists, validates, and calls tools", async () => {
		const server = new (withToolIdentity(McpServer))({ name: "cloud", version: "0" });
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

	it("lists, validates and calls the asset tools as Cloud registers them (no filesystem)", async () => {
		const server = new (withToolIdentity(McpServer))({ name: "cloud", version: "0" });
		const connector = { executeCodeViaUI: jest.fn() };
		registerAssetTools(server as any, async () => connector as any, { isRemoteMode: true });

		const [ct, st] = InMemoryTransport.createLinkedPair();
		await server.connect(st);
		const client = new Client({ name: "c", version: "0" });
		await client.connect(ct);

		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(["figma_export_assets", "figma_import_image", "figma_import_svg"]);
		for (const t of tools) expect(t.inputSchema.type).toBe("object");

		// Schema validation (wrong type) and the handler's Cloud rules both answer isError, before Figma is contacted.
		expect((await client.callTool({ name: "figma_import_svg", arguments: { svgs: "not-an-array" } })).isError).toBe(true);
		const dir = await client.callTool({ name: "figma_import_svg", arguments: { directory: "/tmp/icons" } });
		expect(dir.isError).toBe(true);
		expect(JSON.stringify(dir.content)).toContain("only Local Mode can do");
		const img = await client.callTool({ name: "figma_import_image", arguments: { images: [{ path: "/tmp/a.png" }] } });
		expect(img.isError).toBe(true);
		const files = await client.callTool({ name: "figma_export_assets", arguments: { output: "files" } });
		expect(files.isError).toBe(true);
		expect(JSON.stringify(files.content)).toContain("Writing files is Local Mode only.");
		expect(connector.executeCodeViaUI).not.toHaveBeenCalled();

		await client.close();
		await server.close();
	});
});
