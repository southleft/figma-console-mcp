/**
 * Optional Streamable HTTP endpoint for Local Mode (#48).
 */

import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as V2Client, StreamableHTTPClientTransport as V2HttpTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { parseHttpPort, rejectReason, startLocalHttpTransport, type LocalHttpHandle } from "../src/core/http-transport";
import { MCP_NAME, withToolIdentity } from "../src/core/identity";
import { applyToolAnnotations } from "../src/core/tool-annotations";

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
	let skills: SkillCatalog;
	const IdentifiedMcpServer = withToolIdentity(McpServer);
	// Mirrors local.ts startHttpEndpoint: identity-wrapped server, tools,
	// annotations, then the skills extension attached to every instance.
	const createServer = () => {
		created++;
		const server = new IdentifiedMcpServer({ name: "t", version: "0" });
		server.registerTool("ping", { description: "test" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
		server.registerTool("figma_get_status", { description: "status" }, async () => ({
			content: [{ type: "text", text: JSON.stringify({ connected: false }) }],
		}));
		applyToolAnnotations(server);
		skills.attach(server);
		return server;
	};
	const connect = async (url: string, headers?: Record<string, string>) => {
		const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
		const client = new Client({ name: "c", version: "0" });
		await client.connect(transport);
		return { client, transport };
	};

	beforeAll(async () => {
		skills = await loadSkills(join(__dirname, "..", "skills"));
	});
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
		expect((await b.client.listTools()).tools.map((t) => t.name)).toEqual(["ping", "figma_get_status"]);

		await a.transport.terminateSession();
		await new Promise((r) => setTimeout(r, 50));
		expect(endpoint.sessionCount()).toBe(1);

		await a.client.close();
		await b.client.close();
	});

	it("serves a 2025-11-25 client and a 2026-07-28 client at the same URL", async () => {
		endpoint = await startLocalHttpTransport({ port: 0, token: "s3cret", createServer });
		const headers = { Authorization: "Bearer s3cret" };

		// v1 SDK client: initialize handshake, sessionful legacy leg.
		const legacy = await connect(endpoint.url, headers);
		expect(legacy.transport.protocolVersion).toBe("2025-11-25");
		expect(endpoint.sessionCount()).toBe(1);

		// v2 SDK client pinned to the modern revision: server/discover, no session.
		const modernTransport = new V2HttpTransport(new URL(endpoint.url), { requestInit: { headers } });
		const modern = new V2Client({ name: "c2", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
		await modern.connect(modernTransport);
		expect(modern.getNegotiatedProtocolVersion()).toBe("2026-07-28");
		expect(endpoint.sessionCount()).toBe(1);

		for (const client of [legacy.client, modern] as any[]) {
			const { tools } = await client.listTools();
			const status = tools.find((t: any) => t.name === "figma_get_status");
			expect(status.annotations).toMatchObject({ readOnlyHint: true });
			const r = await client.callTool({ name: "figma_get_status", arguments: {} });
			expect(JSON.parse(r.content[0].text)).toEqual({ _mcp: MCP_NAME, connected: false });
		}

		// Skills extension: advertised and served on the modern era.
		expect(Object.keys(modern.getServerCapabilities()?.extensions ?? {})).toContain("io.modelcontextprotocol/skills");
		const listed = await new SkillsClient(modern).list();
		expect(listed.skills.map((x) => x.uri)).toEqual(expect.arrayContaining([expect.stringMatching(/^skill:\/\//)]));

		// The modern leg still enforces the token (and Host/Origin, shared gate).
		const noToken = new V2Client({ name: "c3", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
		await expect(noToken.connect(new V2HttpTransport(new URL(endpoint.url)))).rejects.toThrow();
		const evil = await fetch(endpoint.url, {
			method: "POST",
			headers: { ...headers, Origin: "https://evil.example", "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
		});
		expect(evil.status).toBe(403);

		await modern.close();
		await legacy.client.close();
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
