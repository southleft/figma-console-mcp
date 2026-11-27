/**
 * withToolIdentity: every tool result is tagged `_mcp`, every thrown error is
 * prefixed `[figma-console-mcp]`, and record schemas list without
 * `propertyNames` — on the v2 SDK (local) and the v1 SDK (Cloudflare) alike,
 * through nothing but the public registration methods.
 */
import { join } from "node:path";
import { z } from "zod";
import { McpServer as V2McpServer, InMemoryTransport as V2InMemory } from "@modelcontextprotocol/server";
import { Client as V2Client } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";
import { McpServer as V1McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as V1InMemory } from "@modelcontextprotocol/sdk/inMemory.js";
import { ERROR_PREFIX, MCP_NAME, identifyToolHandler, withToolIdentity } from "../src/core/identity";

// Same shape as ext-apps' registerAppTool (ESM-only, so not loadable under jest):
// an outside helper that registers through the instance's public registerTool.
const registerAppTool = (server: any, name: string, config: any, cb: any) => server.registerTool(name, config, cb);
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const recordInput = z.object({
	overrides: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
	pattern: z.record(z.string().regex(/^[a-z]+$/), z.string()).optional(),
});

/** Register the same tool set through any server's registerTool. */
function registerFixtures(server: any) {
	server.registerTool("ok_tool", { description: "ok", inputSchema: recordInput }, async () => json({ value: 1 }));
	server.registerTool("throw_tool", { description: "throws" }, async () => {
		throw new Error("boom");
	});
	server.registerTool("text_tool", { description: "plain text" }, async () => ({
		content: [{ type: "text", text: "not json" }],
	}));
}

async function exercise(client: any) {
	const { tools } = await client.listTools();
	const ok = await client.callTool({ name: "ok_tool", arguments: { overrides: { a: 1 } } });
	const thrown = await client.callTool({ name: "throw_tool", arguments: {} });
	const text = await client.callTool({ name: "text_tool", arguments: {} });
	return { tools, ok, thrown, text };
}

function expectStamped({ tools, ok, thrown, text }: Awaited<ReturnType<typeof exercise>>) {
	expect(JSON.parse(ok.content[0].text)).toEqual({ _mcp: MCP_NAME, value: 1 });
	expect(thrown.isError).toBe(true);
	expect(thrown.content[0].text).toBe(`${ERROR_PREFIX} boom`);
	expect(text.content[0].text).toBe("not json");

	const props = tools.find((t: any) => t.name === "ok_tool").inputSchema.properties;
	expect(props.overrides.type).toBe("object");
	expect(props.overrides.additionalProperties).toEqual({ type: ["string", "number", "boolean"] });
	expect(props.overrides).not.toHaveProperty("propertyNames");
	// Keys that actually constrain keep their propertyNames.
	expect(props.pattern.propertyNames).toEqual({ type: "string", pattern: "^[a-z]+$" });
}

describe("withToolIdentity on the v2 SDK (local)", () => {
	it("stamps results and thrown errors, quiets record keys, and leaves skills/resources alone", async () => {
		const calls = jest.fn();
		const Identified = withToolIdentity(V2McpServer, { onToolCall: calls });
		const server = new Identified({ name: "t", version: "0" });
		expect(server).toBeInstanceOf(V2McpServer);
		registerFixtures(server);
		registerAppTool(server as any, "app_tool", { description: "app", _meta: { ui: { resourceUri: "ui://x" } } }, async () => json({ app: true }));
		server.registerResource("r", "test://r", { mimeType: "text/plain" }, async () => ({
			contents: [{ uri: "test://r", text: "resource body" }],
		}));
		// The skills extension registers custom 3-arg request handlers; it must still attach.
		(await loadSkills(join(__dirname, "..", "skills"))).attach(server);

		const [ct, st] = V2InMemory.createLinkedPair();
		await server.connect(st);
		const client = new V2Client({ name: "c", version: "0" });
		await client.connect(ct);

		const result = await exercise(client);
		expectStamped(result);
		expect(calls).toHaveBeenCalledTimes(3);

		const app: any = await client.callTool({ name: "app_tool", arguments: {} });
		expect(JSON.parse(app.content[0].text)).toEqual({ _mcp: MCP_NAME, app: true });
		const res: any = await client.readResource({ uri: "test://r" });
		expect(res.contents[0].text).toBe("resource body");
		const skills = await new SkillsClient(client).list();
		expect(skills.skills.length).toBeGreaterThan(0);

		await client.close();
		await server.close();
	});
});

describe("withToolIdentity on the v1 SDK (Cloudflare)", () => {
	it("stamps registerTool and tool() results and thrown errors, and quiets record keys", async () => {
		const Identified = withToolIdentity(V1McpServer);
		const server = new Identified({ name: "cloud", version: "0" });
		expect(server).toBeInstanceOf(V1McpServer);
		registerFixtures(server);
		// v1's tool() does not route through registerTool, so it is wrapped too.
		server.tool("legacy_tool", "legacy form", { m: z.record(z.string(), z.string()) }, async () => {
			throw new Error("legacy boom");
		});

		const [ct, st] = V1InMemory.createLinkedPair();
		await server.connect(st);
		const client = new V1Client({ name: "c", version: "0" });
		await client.connect(ct);

		const result = await exercise(client);
		expectStamped(result);
		const legacy: any = await client.callTool({ name: "legacy_tool", arguments: { m: {} } });
		expect(legacy.isError).toBe(true);
		expect(legacy.content[0].text).toBe(`${ERROR_PREFIX} legacy boom`);
		const legacySchema = result.tools.find((t: any) => t.name === "legacy_tool").inputSchema;
		expect(JSON.stringify(legacySchema)).not.toContain("propertyNames");

		await client.close();
		await server.close();
	});
});

describe("control: a stock server", () => {
	it("does list propertyNames, so the assertions above prove something", async () => {
		const server = new V2McpServer({ name: "plain", version: "0" });
		server.registerTool("plain", { inputSchema: z.object({ m: z.record(z.string(), z.string()) }) }, async () => json({}));
		const [ct, st] = V2InMemory.createLinkedPair();
		await server.connect(st);
		const client = new V2Client({ name: "c", version: "0" });
		await client.connect(ct);
		const { tools } = await client.listTools();
		expect((tools[0].inputSchema.properties as any).m.propertyNames).toEqual({ type: "string" });
		await client.close();
		await server.close();
	});
});

describe("identifyToolHandler", () => {
	it("is idempotent and leaves already-tagged or prefixed output alone", async () => {
		const once = identifyToolHandler(async () => json({ _mcp: "other", x: 1 }));
		expect(identifyToolHandler(once)).toBe(once);
		expect(JSON.parse(((await once()) as any).content[0].text)).toEqual({ _mcp: "other", x: 1 });

		const thrower = identifyToolHandler(async () => {
			throw new Error(`${ERROR_PREFIX} already`);
		});
		await expect(thrower()).rejects.toThrow(new Error(`${ERROR_PREFIX} already`));
	});
});
