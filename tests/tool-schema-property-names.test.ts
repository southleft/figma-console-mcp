/**
 * zod 4 converts every z.record() to JSON Schema with `propertyNames: {type:"string"}`.
 * Gemini rejects that keyword with a 400, so tools/list must not carry it.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { stripStringPropertyNames, wrapServerForIdentity } from "../src/core/identity";

describe("stripStringPropertyNames", () => {
	it("drops propertyNames {type:'string'} at any depth", () => {
		const schema = {
			type: "object",
			properties: {
				overrides: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "string" } },
				list: { type: "array", items: { type: "object", propertyNames: { type: "string" } } },
			},
		};
		expect(JSON.stringify(stripStringPropertyNames(schema))).not.toContain("propertyNames");
	});

	it("keeps propertyNames that actually constrain keys", () => {
		const schema = { type: "object", propertyNames: { type: "string", pattern: "^[a-z]+$" } };
		expect(stripStringPropertyNames(schema)).toEqual(schema);
	});
});

describe("tools/list through wrapServerForIdentity", () => {
	it("serves record schemas without propertyNames", async () => {
		const server = new McpServer({ name: "t", version: "0" });
		wrapServerForIdentity(server);
		server.tool(
			"record_tool",
			"test",
			{ overrides: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() },
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
});
