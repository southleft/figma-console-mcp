/**
 * zod 4 converts every z.record() to JSON Schema with `propertyNames: {type:"string"}`.
 * Gemini rejects that keyword with a 400, so tools/list must not carry it.
 */

import { z } from "zod";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { withToolIdentity } from "../src/core/identity";
import { registerWriteTools } from "../src/core/write-tools";

describe("tools/list through withToolIdentity", () => {
	it("serves record schemas without propertyNames", async () => {
		const server = new (withToolIdentity(McpServer))({ name: "t", version: "0" });
		server.registerTool(
			"record_tool",
			{
				description: "test",
				inputSchema: z.object({ overrides: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }),
			},
			async () => ({ content: [{ type: "text", text: "ok" }] }),
		);

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client({ name: "c", version: "0" });
		await client.connect(clientTransport);

		const { tools } = await client.listTools();
		const overrides = (tools[0].inputSchema.properties as Record<string, any>).overrides;
		expect(overrides.type).toBe("object");
		expect(overrides.additionalProperties).toEqual({ type: ["string", "number", "boolean"] });
		expect(JSON.stringify(tools)).not.toContain("propertyNames");

		await client.close();
		await server.close();
	});

	it("leaves no propertyNames in the real write tools (records nested in arrays)", async () => {
		const server = new (withToolIdentity(McpServer))({ name: "t", version: "0" });
		registerWriteTools(server, async () => ({}) as any);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client({ name: "c", version: "0" });
		await client.connect(clientTransport);
		const { tools } = await client.listTools();
		expect(tools.length).toBeGreaterThan(10);
		expect(JSON.stringify(tools)).not.toContain("propertyNames");
		await client.close();
		await server.close();
	});
});
