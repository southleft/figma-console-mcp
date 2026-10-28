/**
 * Optional Streamable HTTP endpoint for Local Mode (#48).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseHttpPort, rejectReason, startLocalHttpTransport, type LocalHttpHandle } from "../src/core/http-transport";

describe("parseHttpPort", () => {
	it("is off when unset or blank", () => {
		expect(parseHttpPort(undefined)).toBeNull();
		expect(parseHttpPort("  ")).toBeNull();
	});
	it("accepts a port and rejects anything else", () => {
		expect(parseHttpPort("3845")).toBe(3845);
		for (const bad of ["0", "70000", "abc", "38.5"]) expect(() => parseHttpPort(bad)).toThrow(/FIGMA_MCP_HTTP_PORT/);
	});
});

describe("rejectReason", () => {
	const ok = { host: "127.0.0.1:3845" };
	it("lets loopback hosts through without an Origin", () => {
		for (const host of ["127.0.0.1:3845", "localhost:3845", "[::1]:3845"]) expect(rejectReason({ host }, 3845, undefined)).toBeNull();
	});
	it("refuses other hosts and other ports (DNS rebinding)", () => {
		expect(rejectReason({ host: "evil.example:3845" }, 3845, undefined)?.status).toBe(403);
		expect(rejectReason({ host: "127.0.0.1:9999" }, 3845, undefined)?.status).toBe(403);
		expect(rejectReason({}, 3845, undefined)?.status).toBe(403);
	});
	it("refuses browser origins except loopback pages", () => {
		expect(rejectReason({ ...ok, origin: "https://evil.example" }, 3845, undefined)?.status).toBe(403);
		expect(rejectReason({ ...ok, origin: "null" }, 3845, undefined)?.status).toBe(403);
		expect(rejectReason({ ...ok, origin: "http://localhost:6274" }, 3845, undefined)).toBeNull();
	});
	it("requires the bearer token when one is configured", () => {
		expect(rejectReason(ok, 3845, "s3cret")?.status).toBe(401);
		expect(rejectReason({ ...ok, authorization: "Bearer nope" }, 3845, "s3cret")?.status).toBe(401);
		expect(rejectReason({ ...ok, authorization: "Bearer s3cret" }, 3845, "s3cret")).toBeNull();
	});
});

describe("startLocalHttpTransport", () => {
	let endpoint: LocalHttpHandle | null = null;
	let created = 0;
	const createServer = () => {
		created++;
		const server = new McpServer({ name: "t", version: "0" });
		server.tool("ping", "test", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
		return server;
	};
	const connect = async (url: string, headers?: Record<string, string>) => {
		const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
		const client = new Client({ name: "c", version: "0" });
		await client.connect(transport);
		return { client, transport };
	};

	beforeEach(() => {
		created = 0;
	});
	afterEach(async () => {
		await endpoint?.close();
		endpoint = null;
	});

	it("gives each client its own session and server", async () => {
		endpoint = await startLocalHttpTransport({ port: 0, createServer });
		expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

		const a = await connect(endpoint.url);
		const b = await connect(endpoint.url);
		expect(endpoint.sessionCount()).toBe(2);
		expect(created).toBe(2);

		const r = await a.client.callTool({ name: "ping", arguments: {} });
		expect((r.content as any)[0].text).toBe("pong");
		expect((await b.client.listTools()).tools.map((t) => t.name)).toEqual(["ping"]);

		await a.transport.terminateSession();
		await new Promise((r) => setTimeout(r, 50));
		expect(endpoint.sessionCount()).toBe(1);

		await a.client.close();
		await b.client.close();
	});

	it("enforces the bearer token", async () => {
		endpoint = await startLocalHttpTransport({ port: 0, token: "s3cret", createServer });
		await expect(connect(endpoint.url)).rejects.toThrow();
		const ok = await connect(endpoint.url, { Authorization: "Bearer s3cret" });
		expect(endpoint.sessionCount()).toBe(1);
		await ok.client.close();
	});

	it("fails to start with EADDRINUSE when the port is taken", async () => {
		endpoint = await startLocalHttpTransport({ port: 0, createServer });
		await expect(startLocalHttpTransport({ port: endpoint.port, createServer })).rejects.toMatchObject({ code: "EADDRINUSE" });
	});

	it("closes sessions on shutdown", async () => {
		endpoint = await startLocalHttpTransport({ port: 0, createServer });
		const a = await connect(endpoint.url);
		await endpoint.close();
		expect(endpoint.sessionCount()).toBe(0);
		endpoint = null;
		await a.client.close();
	});
});
