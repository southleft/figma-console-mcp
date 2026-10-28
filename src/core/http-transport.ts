/**
 * Optional Streamable HTTP endpoint for Local Mode (#48).
 *
 * stdio only serves the process that spawned the server. With
 * FIGMA_MCP_HTTP_PORT set, the same process also serves MCP at
 * http://127.0.0.1:<port>/mcp, so other local clients can share its
 * Desktop Bridge connection instead of each starting their own server.
 *
 * Each HTTP session gets its own McpServer (built by `createServer`), exactly
 * as each stdio client gets its own process today; all of them share the one
 * WebSocket bridge and its caches.
 *
 * Only loopback is served. Requests must name a loopback Host (blocks DNS
 * rebinding) and may not come from a non-loopback browser Origin (blocks web
 * pages). FIGMA_MCP_HTTP_TOKEN additionally requires a bearer token.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "http-transport" });

export const MCP_HTTP_PATH = "/mcp";
/** A session with no requests for this long is closed. Clients re-initialize on the 404. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
/** Past this many open sessions, the least recently used one is closed. */
export const MAX_SESSIONS = 32;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface LocalHttpOptions {
	port: number;
	/** Interface to bind. Default 127.0.0.1. */
	host?: string;
	/** When set, every request must send `Authorization: Bearer <token>`. */
	token?: string;
	/** Builds a fresh McpServer with every tool registered. */
	createServer: () => McpServer;
}

export interface LocalHttpHandle {
	url: string;
	port: number;
	sessionCount(): number;
	close(): Promise<void>;
}

interface Session {
	transport: StreamableHTTPServerTransport;
	server: McpServer;
	lastUsed: number;
}

/** Parse FIGMA_MCP_HTTP_PORT. Returns null when unset; throws on a bad value. */
export function parseHttpPort(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === "") return null;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`FIGMA_MCP_HTTP_PORT must be a port number (1-65535), got "${raw}"`);
	}
	return port;
}

/** Hostname of a Host header or Origin, lowercased, IPv6 kept in brackets. */
function hostnameOf(hostPort: string): string {
	const h = hostPort.trim().toLowerCase();
	if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
	return h.split(":")[0];
}

/** Why a request is refused before it reaches MCP, or null to let it through. */
export function rejectReason(
	headers: IncomingMessage["headers"],
	port: number,
	token: string | undefined,
): { status: number; message: string } | null {
	const host = headers.host;
	if (!host || !LOOPBACK_HOSTNAMES.has(hostnameOf(host)) || !host.endsWith(`:${port}`)) {
		return { status: 403, message: `Host "${host ?? ""}" is not allowed; connect to http://127.0.0.1:${port}${MCP_HTTP_PATH}` };
	}
	// Non-browser clients send no Origin. Browsers always do on these requests;
	// allow loopback pages (e.g. MCP Inspector) and refuse everything else,
	// including "null" (sandboxed iframes, file: pages), which won't parse.
	const origin = headers.origin;
	if (origin !== undefined) {
		let originHost = "";
		try {
			originHost = hostnameOf(new URL(origin).host);
		} catch {
			// Unparseable: refused below.
		}
		if (!LOOPBACK_HOSTNAMES.has(originHost)) {
			return { status: 403, message: `Origin "${origin}" is not allowed` };
		}
	}
	if (token) {
		const auth = headers.authorization ?? "";
		const given = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
		const expected = Buffer.from(token);
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
			return { status: 401, message: "Missing or wrong bearer token (FIGMA_MCP_HTTP_TOKEN)" };
		}
	}
	return null;
}

function sendError(res: ServerResponse, status: number, message: string, code = -32000): void {
	if (res.headersSent) return;
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(Object.assign(new Error("Request body too large"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
			} catch {
				reject(Object.assign(new Error("Request body is not valid JSON"), { status: 400, code: -32700 }));
			}
		});
		req.on("error", reject);
	});
}

export async function startLocalHttpTransport(options: LocalHttpOptions): Promise<LocalHttpHandle> {
	const host = options.host ?? "127.0.0.1";
	const sessions = new Map<string, Session>();

	const closeSession = async (id: string, reason: string) => {
		const session = sessions.get(id);
		if (!session) return;
		sessions.delete(id);
		logger.info({ sessionId: id, reason, open: sessions.size }, "HTTP MCP session closed");
		try {
			await session.server.close();
		} catch {
			// Already closed.
		}
	};

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const path = (req.url ?? "").split("?")[0];
		if (path !== MCP_HTTP_PATH) {
			sendError(res, 404, `Not found; the MCP endpoint is ${MCP_HTTP_PATH}`);
			return;
		}
		const rejected = rejectReason(req.headers, actualPort, options.token);
		if (rejected) {
			logger.warn({ status: rejected.status, host: req.headers.host, origin: req.headers.origin }, "HTTP MCP request refused");
			sendError(res, rejected.status, rejected.message);
			return;
		}

		const sessionId = req.headers["mcp-session-id"];
		if (typeof sessionId === "string") {
			const session = sessions.get(sessionId);
			if (!session) {
				sendError(res, 404, "Session not found; re-initialize", -32001);
				return;
			}
			session.lastUsed = Date.now();
			await session.transport.handleRequest(req, res);
			return;
		}

		if (req.method !== "POST") {
			sendError(res, 400, "Missing mcp-session-id header");
			return;
		}
		let body: unknown;
		try {
			body = await readJsonBody(req);
		} catch (err) {
			const e = err as Error & { status?: number; code?: number };
			sendError(res, e.status ?? 400, e.message, e.code ?? -32000);
			return;
		}
		const messages = Array.isArray(body) ? body : [body];
		if (!messages.some((m) => isInitializeRequest(m))) {
			sendError(res, 400, "Missing mcp-session-id header; send initialize first");
			return;
		}

		if (sessions.size >= MAX_SESSIONS) {
			const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
			if (oldest) await closeSession(oldest[0], "session limit");
		}

		const server = options.createServer();
		const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => {
				sessions.set(id, { transport, server, lastUsed: Date.now() });
				logger.info({ sessionId: id, open: sessions.size }, "HTTP MCP session opened");
			},
		});
		transport.onclose = () => {
			if (transport.sessionId) void closeSession(transport.sessionId, "closed by client");
		};
		await server.connect(transport);
		await transport.handleRequest(req, res, body);
	};

	const httpServer: Server = createServer((req, res) => {
		handle(req, res).catch((err) => {
			logger.error({ err }, "HTTP MCP request failed");
			sendError(res, 500, "Internal error");
		});
	});

	let actualPort = options.port;
	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => {
			httpServer.off("listening", onListening);
			reject(err);
		};
		const onListening = () => {
			httpServer.off("error", onError);
			const addr = httpServer.address();
			if (addr && typeof addr === "object") actualPort = addr.port;
			resolve();
		};
		httpServer.once("error", onError);
		httpServer.once("listening", onListening);
		httpServer.listen(options.port, host);
	});

	const sweep = setInterval(() => {
		const cutoff = Date.now() - SESSION_IDLE_MS;
		for (const [id, s] of sessions) if (s.lastUsed < cutoff) void closeSession(id, "idle");
	}, 60_000);
	sweep.unref();

	const urlHost = host.includes(":") ? `[${host}]` : host;
	const url = `http://${urlHost}:${actualPort}${MCP_HTTP_PATH}`;
	logger.info({ url, auth: options.token ? "bearer" : "none" }, "HTTP MCP endpoint listening");

	return {
		url,
		port: actualPort,
		sessionCount: () => sessions.size,
		close: async () => {
			clearInterval(sweep);
			await Promise.all([...sessions.keys()].map((id) => closeSession(id, "shutdown")));
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
				httpServer.closeAllConnections?.();
			});
		},
	};
}
