/**
 * Cloud WebSocket Relay — Durable Object
 *
 * Bridges the Figma Desktop Bridge plugin to the cloud MCP server.
 * The plugin connects via WebSocket (hibernation-aware); the MCP DO
 * sends commands via fetch() RPC and receives responses.
 *
 * IMPORTANT: Uses hibernation-safe patterns throughout:
 *   - WebSocket retrieved via this.ctx.getWebSockets() (not class property)
 *   - File info persisted in DO storage (not in-memory)
 *   - Pending requests kept in-memory (safe: fetch keeps DO alive)
 *
 * Routes:
 *   /ws/connect   — WebSocket upgrade from plugin (paired via code)
 *   /relay/command — RPC from MCP DO → plugin (holds response open)
 *   /relay/status  — Connection & file info query
 */

import { DurableObject } from 'cloudflare:workers';

export interface RelayFileInfo {
	fileName: string;
	fileKey: string | null;
	currentPage?: string;
	currentPageId?: string;
	connectedAt: number;
}

interface PendingRelay {
	resolve: (value: Response) => void;
	reject: (reason: Error) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Generate a 6-character alphanumeric pairing code (uppercase).
 */
export function generatePairingCode(): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O/1/I confusion
	let code = '';
	const arr = new Uint8Array(6);
	crypto.getRandomValues(arr);
	for (let i = 0; i < 6; i++) {
		code += chars[arr[i] % chars.length];
	}
	return code;
}

export class PluginRelayDO extends DurableObject {
	private pendingRequests: Map<string, PendingRelay> = new Map();
	private requestIdCounter = 0;

	// ======================================================================
	// Hibernation-safe WebSocket retrieval
	// ======================================================================

	/**
	 * Get the active plugin WebSocket. Uses ctx.getWebSockets() which
	 * survives DO hibernation (unlike a class property reference).
	 */
	private getPluginWs(): WebSocket | null {
		const sockets = this.ctx.getWebSockets('plugin');
		return sockets.length > 0 ? sockets[0] : null;
	}

	/**
	 * Incoming fetch handler — dispatches to routes.
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/ws/connect') {
			return this.handlePluginConnect(request);
		}

		if (url.pathname === '/relay/command') {
			return this.handleRelayCommand(request);
		}

		if (url.pathname === '/relay/status') {
			return this.handleRelayStatus();
		}

		return new Response('Not found', { status: 404 });
	}

	// ==========================================================================
	// WebSocket — plugin connects here
	// ==========================================================================

	private handlePluginConnect(request: Request): Response {
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
			return new Response('Expected WebSocket upgrade', { status: 426 });
		}

		// Close any existing plugin connection (e.g., re-pairing)
		const existing = this.getPluginWs();
		if (existing) {
			try { existing.close(1000, 'Replaced by new connection'); } catch { /* ignore */ }
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		// Accept with 'plugin' tag — this.ctx.getWebSockets('plugin') retrieves
		// the socket even after the DO wakes from hibernation.
		this.ctx.acceptWebSocket(server, ['plugin']);

		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Hibernation callback — incoming message from plugin WebSocket.
	 */
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== 'string') return;

		try {
			const data = JSON.parse(message);

			// FILE_INFO identification from plugin — persist to DO storage
			if (data.type === 'FILE_INFO' && data.data) {
				const fileInfo: RelayFileInfo = {
					fileName: data.data.fileName,
					fileKey: data.data.fileKey || null,
					currentPage: data.data.currentPage,
					currentPageId: data.data.currentPageId || null,
					connectedAt: Date.now(),
				};
				await this.ctx.storage.put('fileInfo', fileInfo);
				return;
			}

			// Event broadcasts from plugin (PAGE_CHANGE, etc.)
			if (data.type === 'PAGE_CHANGE' && data.data) {
				const fileInfo = await this.ctx.storage.get<RelayFileInfo>('fileInfo');
				if (fileInfo) {
					fileInfo.currentPage = data.data.pageName;
					fileInfo.currentPageId = data.data.pageId || null;
					await this.ctx.storage.put('fileInfo', fileInfo);
				}
				return;
			}

			// Response to a relayed command
			if (data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				clearTimeout(pending.timeoutId);
				this.pendingRequests.delete(data.id);

				const body = JSON.stringify(data.error
					? { error: data.error }
					: { result: data.result });

				pending.resolve(new Response(body, {
					headers: { 'Content-Type': 'application/json' },
				}));
			}
		} catch {
			// Malformed message — ignore
		}
	}

	/**
	 * Hibernation callback — WebSocket closed.
	 */
	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
		this.handleDisconnect();
	}

	/**
	 * Hibernation callback — WebSocket error.
	 */
	webSocketError(ws: WebSocket, error: unknown): void {
		this.handleDisconnect();
	}

	private handleDisconnect(): void {
		// Clear persisted file info
		this.ctx.storage.delete('fileInfo');

		// Reject all in-flight commands
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timeoutId);
			pending.resolve(new Response(
				JSON.stringify({ error: 'Plugin disconnected' }),
				{ status: 502, headers: { 'Content-Type': 'application/json' } },
			));
		}
		this.pendingRequests.clear();
	}

	// ==========================================================================
	// Relay — MCP DO sends commands here
	// ==========================================================================

	private async handleRelayCommand(request: Request): Promise<Response> {
		const pluginWs = this.getPluginWs();
		if (!pluginWs) {
			return new Response(
				JSON.stringify({ error: 'No plugin connected. User must pair the Desktop Bridge plugin first.' }),
				{ status: 502, headers: { 'Content-Type': 'application/json' } },
			);
		}

		const body = await request.json() as { method: string; params?: Record<string, any>; timeoutMs?: number };
		const { method, params = {}, timeoutMs = 15000 } = body;

		const id = `relay_${++this.requestIdCounter}_${Date.now()}`;

		// Send command to plugin
		try {
			pluginWs.send(JSON.stringify({ id, method, params }));
		} catch {
			return new Response(
				JSON.stringify({ error: 'Failed to send command to plugin — connection may be stale' }),
				{ status: 502, headers: { 'Content-Type': 'application/json' } },
			);
		}

		// Wait for plugin response (the DO stays alive because fetch is active)
		return new Promise<Response>((resolve) => {
			const timeoutId = setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					resolve(new Response(
						JSON.stringify({ error: `Command ${method} timed out after ${timeoutMs}ms` }),
						{ status: 504, headers: { 'Content-Type': 'application/json' } },
					));
				}
			}, timeoutMs);

			this.pendingRequests.set(id, { resolve, reject: () => {}, timeoutId });
		});
	}

	// ==========================================================================
	// Status
	// ==========================================================================

	private async handleRelayStatus(): Promise<Response> {
		const pluginWs = this.getPluginWs();
		const fileInfo = await this.ctx.storage.get<RelayFileInfo>('fileInfo');

		return new Response(
			JSON.stringify({
				connected: pluginWs !== null,
				fileInfo: fileInfo || null,
				pendingCommands: this.pendingRequests.size,
			}),
			{ headers: { 'Content-Type': 'application/json' } },
		);
	}
}
