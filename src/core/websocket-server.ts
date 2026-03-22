/**
 * WebSocket Bridge Server (Multi-Client)
 *
 * Creates a WebSocket server that multiple Desktop Bridge plugin instances connect to.
 * Each instance represents a different Figma file and is identified by its fileKey
 * (sent via FILE_INFO on connection). Per-file state (selection, document changes,
 * console logs) is maintained independently.
 *
 * Active file tracking: The "active" file is automatically switched when the user
 * interacts with a file (selection/page changes) or can be set explicitly via
 * setActiveFile(). All backward-compatible getters return data from the active file.
 *
 * Data flow: MCP Server ←WebSocket→ ui.html ←postMessage→ code.js ←figma.*→ Figma
 */

import { WebSocketServer as WSServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'http';
import type { Server as HttpServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createChildLogger } from './logger.js';
import type { ConsoleLogEntry } from './types/index.js';

// Read version from package.json
// Uses __dirname in CJS/Jest context, falls back to process.cwd() in ESM runtime
let SERVER_VERSION = '0.0.0';
try {
  const base = typeof __dirname !== 'undefined' ? join(__dirname, '..', '..') : process.cwd();
  SERVER_VERSION = JSON.parse(readFileSync(join(base, 'package.json'), 'utf-8')).version;
} catch {
  // Non-critical — version will show as 0.0.0
}

/**
 * Load the full plugin UI HTML content that gets served to the bootloader.
 * Falls back to a minimal error page if the file isn't found.
 */
function loadPluginUIContent(): string {
  const candidates = [
    // ESM runtime: dist/core/ → ../../figma-desktop-bridge/
    typeof __dirname !== 'undefined'
      ? join(__dirname, '..', '..', 'figma-desktop-bridge', 'ui-full.html')
      : join(process.cwd(), 'figma-desktop-bridge', 'ui-full.html'),
    // Direct from project root
    join(process.cwd(), 'figma-desktop-bridge', 'ui-full.html'),
  ];

  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        return readFileSync(path, 'utf-8');
      }
    } catch {
      // try next candidate
    }
  }

  return '<html><body><p>Plugin UI not found. Please reinstall figma-console-mcp.</p></body></html>';
}

const logger = createChildLogger({ component: 'websocket-server' });

export interface WebSocketServerOptions {
  port: number;
  host?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  method: string;
  timeoutId: ReturnType<typeof setTimeout>;
  createdAt: number;
  targetFileKey: string;
}

export interface ConnectedFileInfo {
  fileName: string;
  fileKey: string | null;
  currentPage?: string;
  currentPageId?: string;
  editorType?: 'figma' | 'figjam' | 'dev';
  connectedAt: number;
}

export interface SelectionInfo {
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    width?: number;
    height?: number;
  }>;
  count: number;
  page: string;
  timestamp: number;
}

export interface DocumentChangeEntry {
  hasStyleChanges: boolean;
  hasNodeChanges: boolean;
  changedNodeIds: string[];
  changeCount: number;
  timestamp: number;
}

/**
 * Per-file client connection state.
 * Each Figma file with the Desktop Bridge plugin open gets its own ClientConnection.
 */
export interface ClientConnection {
  ws: WebSocket;
  fileInfo: ConnectedFileInfo;
  selection: SelectionInfo | null;
  documentChanges: DocumentChangeEntry[];
  consoleLogs: ConsoleLogEntry[];
  lastActivity: number;
  gracePeriodTimer: ReturnType<typeof setTimeout> | null;
}

export class FigmaWebSocketServer extends EventEmitter {
  private wss: WSServer | null = null;
  private httpServer: HttpServer | null = null;
  /** Named clients indexed by fileKey — each represents a connected Figma file */
  private clients: Map<string, ClientConnection> = new Map();
  /** Clients awaiting FILE_INFO identification, mapped to their pending timeout */
  private _pendingClients: Map<WebSocket, ReturnType<typeof setTimeout>> = new Map();
  /** The fileKey of the currently active (targeted) file */
  private _activeFileKey: string | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestIdCounter = 0;
  private options: WebSocketServerOptions;
  private _isStarted = false;
  private _startedAt = Date.now();
  private consoleBufferSize = 1000;
  private documentChangeBufferSize = 200;
  /** Cached plugin UI HTML content — loaded once and served to bootloader requests */
  private _pluginUIContent: string | null = null;

  constructor(options: WebSocketServerOptions) {
    super();
    this.options = options;
    this._startedAt = Date.now();
  }

  /**
   * Handle HTTP requests on the same port as WebSocket.
   * Serves plugin UI content for the bootloader and health checks.
   */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS headers for Figma plugin iframe (sandboxed, origin: null)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || '/';

    // Plugin UI endpoint — bootloader redirects here
    if (url === '/plugin/ui' || url === '/plugin/ui/') {
      if (!this._pluginUIContent) {
        this._pluginUIContent = loadPluginUIContent();
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(this._pluginUIContent);
      return;
    }

    // Health/version endpoint
    if (url === '/health' || url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: SERVER_VERSION,
        clients: this.clients.size,
        uptime: Math.floor((Date.now() - this._startedAt) / 1000),
      }));
      return;
    }

    // 404 for anything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /**
   * Start the HTTP + WebSocket server.
   * HTTP serves the plugin UI content; WebSocket handles plugin communication.
   */
  async start(): Promise<void> {
    if (this._isStarted) return;

    return new Promise((resolve, reject) => {
      let rejected = false;
      const rejectOnce = (error: any) => {
        if (!rejected) {
          rejected = true;
          reject(error);
        }
      };

      try {
        // Create HTTP server first — handles plugin UI requests
        this.httpServer = createHttpServer((req, res) => this.handleHttpRequest(req, res));

        // Attach WebSocket server to the HTTP server (shares the same port)
        this.wss = new WSServer({
          server: this.httpServer,
          maxPayload: 100 * 1024 * 1024, // 100MB — screenshots and large component data can be big
          verifyClient: (info, callback) => {
            // Mitigate Cross-Site WebSocket Hijacking (CSWSH):
            // Reject connections from unexpected browser origins.
            const origin = info.origin;
            const allowed =
              !origin ||                           // No origin — local process (e.g. Node.js client)
              origin === 'null' ||                  // Sandboxed iframe / Figma Desktop plugin UI
              origin.startsWith('https://www.figma.com') ||
              origin.startsWith('https://figma.com');
            if (allowed) {
              callback(true);
            } else {
              logger.warn({ origin }, 'Rejected WebSocket connection from unauthorized origin');
              callback(false, 403, 'Unauthorized Origin');
            }
          },
        });

        // Error handler for startup failures (EADDRINUSE, etc.)
        // Must be on BOTH httpServer and wss — the WSS re-emits HTTP server errors
        // and throws if no listener is attached.
        const onStartupError = (error: any) => {
          if (!this._isStarted) {
            try { if (this.wss) { this.wss.close(); this.wss = null; } } catch { /* ignore */ }
            try { if (this.httpServer) { this.httpServer.close(); this.httpServer = null; } } catch { /* ignore */ }
            rejectOnce(error);
          } else {
            logger.error({ error }, 'HTTP/WebSocket server error');
          }
        };

        this.httpServer.on('error', onStartupError);
        this.wss.on('error', onStartupError);

        // Start listening on the HTTP server (which also handles WS upgrades)
        this.httpServer.listen(this.options.port, this.options.host || 'localhost', () => {
          this._isStarted = true;
          logger.info(
            { port: this.options.port, host: this.options.host || 'localhost' },
            'WebSocket bridge server started (with HTTP plugin UI endpoint)'
          );
          resolve();
        });

        this.wss.on('connection', (ws: WebSocket) => {
          // Add to pending until FILE_INFO identifies the file
          const pendingTimeout = setTimeout(() => {
            if (this._pendingClients.has(ws)) {
              this._pendingClients.delete(ws);
              logger.warn('Pending WebSocket client timed out without sending FILE_INFO');
              ws.close(1000, 'File identification timeout');
            }
          }, 30000);
          this._pendingClients.set(ws, pendingTimeout);

          // Send server identity to the client for debugging and logging
          try {
            ws.send(JSON.stringify({
              type: 'SERVER_HELLO',
              data: {
                port: (this.wss!.address() as any)?.port,
                pid: process.pid,
                serverVersion: SERVER_VERSION,
                startedAt: this._startedAt,
              },
            }));
          } catch {
            // Non-critical — client will still work without SERVER_HELLO
          }

          logger.info(
            { totalClients: this.clients.size, pendingClients: this._pendingClients.size },
            'New WebSocket connection (pending file identification)'
          );

          ws.on('message', (data: import('ws').RawData) => {
            try {
              let text: string;
              if (typeof data === 'string') {
                text = data;
              } else if (Buffer.isBuffer(data)) {
                text = data.toString();
              } else if (Array.isArray(data)) {
                text = Buffer.concat(data).toString();
              } else {
                text = Buffer.from(data as ArrayBuffer).toString();
              }
              const message = JSON.parse(text);
              this.handleMessage(message, ws);
            } catch (error) {
              logger.error({ error }, 'Failed to parse WebSocket message');
            }
          });

          ws.on('close', (code: number, reason: Buffer) => {
            this.handleClientDisconnect(ws, code, reason.toString());
          });

          ws.on('error', (error: any) => {
            logger.error({ error }, 'WebSocket client error');
          });
        });
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  /**
   * Find a named client connection by its WebSocket reference
   */
  private findClientByWs(ws: WebSocket): { fileKey: string; client: ClientConnection } | null {
    for (const [fileKey, client] of this.clients) {
      if (client.ws === ws) return { fileKey, client };
    }
    return null;
  }

  /**
   * Handle incoming message from a plugin UI WebSocket connection
   */
  private handleMessage(message: any, ws: WebSocket): void {
    // Response to a command we sent
    if (message.id && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;
      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Bootloader request: send the full plugin UI HTML
    if (message.type === 'GET_PLUGIN_UI') {
      if (!this._pluginUIContent) {
        this._pluginUIContent = loadPluginUIContent();
      }
      try {
        ws.send(JSON.stringify({
          type: 'PLUGIN_UI_CONTENT',
          html: this._pluginUIContent,
        }));
      } catch {
        // Non-critical — bootloader will show error
      }
      return;
    }

    // Unsolicited data from plugin (FILE_INFO, events, forwarded data)
    if (message.type) {
      // FILE_INFO promotes pending clients to named clients
      if (message.type === 'FILE_INFO' && message.data) {
        this.handleFileInfo(message.data, ws);
      }

      // Buffer document changes for the specific file
      if (message.type === 'DOCUMENT_CHANGE' && message.data) {
        const found = this.findClientByWs(ws);
        if (found) {
          const entry: DocumentChangeEntry = {
            hasStyleChanges: message.data.hasStyleChanges,
            hasNodeChanges: message.data.hasNodeChanges,
            changedNodeIds: message.data.changedNodeIds || [],
            changeCount: message.data.changeCount || 0,
            timestamp: message.data.timestamp || Date.now(),
          };
          found.client.documentChanges.push(entry);
          if (found.client.documentChanges.length > this.documentChangeBufferSize) {
            found.client.documentChanges.shift();
          }
          found.client.lastActivity = Date.now();
        }
        this.emit('documentChange', { fileKey: found?.fileKey ?? null, ...message.data });
      }

      // Track selection changes — user interaction makes this the active file
      if (message.type === 'SELECTION_CHANGE' && message.data) {
        const found = this.findClientByWs(ws);
        if (found) {
          found.client.selection = message.data as SelectionInfo;
          found.client.lastActivity = Date.now();
          this._activeFileKey = found.fileKey;
        }
        this.emit('selectionChange', { fileKey: found?.fileKey ?? null, ...message.data });
      }

      // Track page changes — user interaction makes this the active file
      if (message.type === 'PAGE_CHANGE' && message.data) {
        const found = this.findClientByWs(ws);
        if (found) {
          found.client.fileInfo.currentPage = message.data.pageName;
          found.client.fileInfo.currentPageId = message.data.pageId || null;
          found.client.lastActivity = Date.now();
          this._activeFileKey = found.fileKey;
        }
        this.emit('pageChange', { fileKey: found?.fileKey ?? null, ...message.data });
      }

      // Capture console logs for the specific file
      if (message.type === 'CONSOLE_CAPTURE' && message.data) {
        const found = this.findClientByWs(ws);
        const data = message.data;
        const entry: ConsoleLogEntry = {
          timestamp: data.timestamp || Date.now(),
          level: data.level || 'log',
          message: typeof data.message === 'string' ? data.message.substring(0, 1000) : String(data.message),
          args: Array.isArray(data.args) ? data.args.slice(0, 10) : [],
          source: 'plugin',
        };
        if (found) {
          found.client.consoleLogs.push(entry);
          if (found.client.consoleLogs.length > this.consoleBufferSize) {
            found.client.consoleLogs.shift();
          }
          found.client.lastActivity = Date.now();
        }
        this.emit('consoleLog', entry);
      }

      this.emit('pluginMessage', message);
      return;
    }

    logger.debug({ message }, 'Unhandled WebSocket message');
  }

  /**
   * Handle FILE_INFO message — promotes pending clients to named clients.
   * This is the critical multi-client identification step: each plugin reports
   * its fileKey on connect, allowing the server to track multiple files.
   */
  private handleFileInfo(data: any, ws: WebSocket): void {
    const fileKey = data.fileKey || null;

    if (!fileKey) {
      logger.warn('FILE_INFO received without fileKey — client remains pending');
      return;
    }

    // Remove from pending clients (cancel identification timeout)
    const pendingTimeout = this._pendingClients.get(ws);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      this._pendingClients.delete(ws);
    }

    // Check if this ws was already registered under a different fileKey
    // (shouldn't happen in practice — each plugin instance is per-file)
    const previousEntry = this.findClientByWs(ws);
    if (previousEntry && previousEntry.fileKey !== fileKey) {
      this.clients.delete(previousEntry.fileKey);
      if (this._activeFileKey === previousEntry.fileKey) {
        this._activeFileKey = null;
      }
      logger.info(
        { oldFileKey: previousEntry.fileKey, newFileKey: fileKey },
        'WebSocket client switched files'
      );
    }

    // If same fileKey already connected with a DIFFERENT ws, clean up old connection
    const existing = this.clients.get(fileKey);
    if (existing && existing.ws !== ws) {
      logger.info({ fileKey }, 'Replacing existing connection for same file');
      if (existing.gracePeriodTimer) {
        clearTimeout(existing.gracePeriodTimer);
      }
      // Reject any in-flight commands before replacing — the old ws close event
      // won't find this fileKey in the map after overwrite, so pending requests
      // would hang until timeout otherwise.
      this.rejectPendingRequestsForFile(fileKey, 'Connection replaced by same file reconnection');
      if (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING) {
        existing.ws.close(1000, 'Replaced by same file reconnection');
      }
    }

    // Create client connection (preserve per-file state from previous connection of same file)
    this.clients.set(fileKey, {
      ws,
      fileInfo: {
        fileName: data.fileName,
        fileKey,
        currentPage: data.currentPage,
        currentPageId: data.currentPageId || null,
        editorType: data.editorType || 'figma',
        connectedAt: Date.now(),
      },
      selection: existing?.selection || null,
      documentChanges: existing?.documentChanges || [],
      consoleLogs: existing?.consoleLogs || [],
      lastActivity: Date.now(),
      gracePeriodTimer: null,
    });

    // Most recently connected file becomes active (user just opened the plugin there).
    // On bulk reconnect the order is non-deterministic, but the first user interaction
    // (SELECTION_CHANGE or PAGE_CHANGE) will correct the active file immediately.
    this._activeFileKey = fileKey;

    logger.info(
      {
        fileName: data.fileName,
        fileKey,
        totalClients: this.clients.size,
        isActive: this._activeFileKey === fileKey,
      },
      'File connected via WebSocket'
    );

    // Emit both events for backward compat and new features
    this.emit('connected');
    this.emit('fileConnected', { fileKey, fileName: data.fileName });
  }

  /**
   * Handle a client WebSocket disconnecting.
   * Starts a grace period before removing the client to allow reconnection.
   */
  private handleClientDisconnect(ws: WebSocket, code: number, reason: string): void {
    // Check if it was a pending client (never identified itself)
    const pendingTimeout = this._pendingClients.get(ws);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      this._pendingClients.delete(ws);
      logger.info('Pending WebSocket client disconnected before file identification');
      this.emit('disconnected');
      return;
    }

    // Find which named client this belongs to
    const found = this.findClientByWs(ws);
    if (!found) {
      logger.debug('Unknown WebSocket client disconnected');
      this.emit('disconnected');
      return;
    }

    const { fileKey, client } = found;
    logger.info(
      { fileKey, fileName: client.fileInfo.fileName, code, reason },
      'File disconnected from WebSocket'
    );

    // Start grace period — keep state but clean up if not reconnected
    client.gracePeriodTimer = setTimeout(() => {
      client.gracePeriodTimer = null;
      // Only remove if the client in the map is still the disconnected one
      const current = this.clients.get(fileKey);
      if (current && current.ws === ws) {
        this.clients.delete(fileKey);
        this.rejectPendingRequestsForFile(fileKey, 'WebSocket client disconnected');

        // If active file disconnected, switch to another connected file
        if (this._activeFileKey === fileKey) {
          this._activeFileKey = null;
          for (const [fk, c] of this.clients) {
            if (c.ws.readyState === WebSocket.OPEN) {
              this._activeFileKey = fk;
              break;
            }
          }
        }

        this.emit('fileDisconnected', { fileKey, fileName: client.fileInfo.fileName });
      }
    }, 5000);

    this.emit('disconnected');
  }

  /**
   * Send a command to a plugin UI and wait for the response.
   * By default targets the active file. Pass targetFileKey to target a specific file.
   */
  sendCommand(method: string, params: Record<string, any> = {}, timeoutMs = 15000, targetFileKey?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const fileKey = targetFileKey || this._activeFileKey;

      if (!fileKey) {
        reject(new Error('No active file connected. Make sure the Desktop Bridge plugin is open in Figma.'));
        return;
      }

      const client = this.clients.get(fileKey);
      if (!client || client.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('No WebSocket client connected. Make sure the Desktop Bridge plugin is open in Figma.'));
        return;
      }

      const id = `ws_${++this.requestIdCounter}_${Date.now()}`;

      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`WebSocket command ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        method,
        timeoutId,
        createdAt: Date.now(),
        targetFileKey: fileKey,
      });

      const message = JSON.stringify({ id, method, params });
      try {
        client.ws.send(message);
      } catch (sendError) {
        this.pendingRequests.delete(id);
        clearTimeout(timeoutId);
        reject(new Error(`Failed to send WebSocket command ${method}: ${sendError instanceof Error ? sendError.message : String(sendError)}`));
        return;
      }
      client.lastActivity = Date.now();

      logger.debug({ id, method, fileKey }, 'Sent WebSocket command');
    });
  }

  /**
   * Check if any named client is connected (transport availability check)
   */
  isClientConnected(): boolean {
    for (const [, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether the server has been started
   */
  isStarted(): boolean {
    return this._isStarted;
  }

  /**
   * Get the bound address info (port, host, family).
   * Only available after the server has started listening.
   * Returns the actual port — critical when using port 0 for OS-assigned ports.
   */
  address(): import('net').AddressInfo | null {
    // Use the HTTP server's address (which is the actual listening socket)
    if (this.httpServer) {
      const addr = this.httpServer.address();
      if (typeof addr === 'string' || !addr) return null;
      return addr as import('net').AddressInfo;
    }
    // Fallback for backward compat
    if (!this.wss) return null;
    const addr = this.wss.address();
    if (typeof addr === 'string') return null;
    return addr as import('net').AddressInfo;
  }

  // ============================================================================
  // Active file getters (backward compatible — return active file's state)
  // ============================================================================

  /**
   * Get info about the currently active Figma file.
   * Returns null if no file is active or connected.
   */
  getConnectedFileInfo(): ConnectedFileInfo | null {
    if (!this._activeFileKey) return null;
    const client = this.clients.get(this._activeFileKey);
    return client?.fileInfo || null;
  }

  /**
   * Get the current user selection in the active Figma file
   */
  getCurrentSelection(): SelectionInfo | null {
    if (!this._activeFileKey) return null;
    const client = this.clients.get(this._activeFileKey);
    return client?.selection || null;
  }

  /**
   * Get buffered document change events from the active file
   */
  getDocumentChanges(options?: {
    count?: number;
    since?: number;
  }): DocumentChangeEntry[] {
    if (!this._activeFileKey) return [];
    const client = this.clients.get(this._activeFileKey);
    if (!client) return [];

    let filtered = [...client.documentChanges];

    if (options?.since !== undefined) {
      filtered = filtered.filter((e) => e.timestamp >= options.since!);
    }

    if (options?.count !== undefined && options.count > 0) {
      filtered = filtered.slice(-options.count);
    }

    return filtered;
  }

  /**
   * Clear document change buffer for the active file
   */
  clearDocumentChanges(): number {
    if (!this._activeFileKey) return 0;
    const client = this.clients.get(this._activeFileKey);
    if (!client) return 0;
    const count = client.documentChanges.length;
    client.documentChanges = [];
    return count;
  }

  /**
   * Get console logs from the active file with optional filtering
   */
  getConsoleLogs(options?: {
    count?: number;
    level?: ConsoleLogEntry['level'] | 'all';
    since?: number;
  }): ConsoleLogEntry[] {
    if (!this._activeFileKey) return [];
    const client = this.clients.get(this._activeFileKey);
    if (!client) return [];

    let filtered = [...client.consoleLogs];

    if (options?.since !== undefined) {
      filtered = filtered.filter((log) => log.timestamp >= options.since!);
    }

    if (options?.level && options.level !== 'all') {
      filtered = filtered.filter((log) => log.level === options.level);
    }

    if (options?.count !== undefined && options.count > 0) {
      filtered = filtered.slice(-options.count);
    }

    return filtered;
  }

  /**
   * Clear console log buffer for the active file
   */
  clearConsoleLogs(): number {
    if (!this._activeFileKey) return 0;
    const client = this.clients.get(this._activeFileKey);
    if (!client) return 0;
    const count = client.consoleLogs.length;
    client.consoleLogs = [];
    return count;
  }

  /**
   * Get console monitoring status for the active file
   */
  getConsoleStatus() {
    const client = this._activeFileKey ? this.clients.get(this._activeFileKey) : null;
    const logs = client?.consoleLogs || [];

    return {
      isMonitoring: !!(client && client.ws.readyState === WebSocket.OPEN),
      anyClientConnected: this.isClientConnected(),
      logCount: logs.length,
      bufferSize: this.consoleBufferSize,
      workerCount: 0,
      oldestTimestamp: logs[0]?.timestamp,
      newestTimestamp: logs[logs.length - 1]?.timestamp,
    };
  }

  // ============================================================================
  // Multi-client methods
  // ============================================================================

  /**
   * Get info about all connected Figma files.
   * Returns an array of ConnectedFileInfo for each file with an active WebSocket.
   */
  getConnectedFiles(): (ConnectedFileInfo & { isActive: boolean })[] {
    const files: (ConnectedFileInfo & { isActive: boolean })[] = [];
    for (const [fileKey, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        files.push({
          ...client.fileInfo,
          isActive: fileKey === this._activeFileKey,
        });
      }
    }
    return files;
  }

  /**
   * Set the active file by fileKey. Returns true if the file is connected.
   */
  setActiveFile(fileKey: string): boolean {
    const client = this.clients.get(fileKey);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      this._activeFileKey = fileKey;
      logger.info({ fileKey, fileName: client.fileInfo.fileName }, 'Active file switched');
      this.emit('activeFileChanged', { fileKey, fileName: client.fileInfo.fileName });
      return true;
    }
    return false;
  }

  /**
   * Get the currently active file's key
   */
  getActiveFileKey(): string | null {
    return this._activeFileKey;
  }

  /**
   * Get the editor type of the currently active file.
   * Returns 'figma' if no file is connected or editorType wasn't reported.
   */
  getEditorType(): 'figma' | 'figjam' | 'dev' {
    if (!this._activeFileKey) return 'figma';
    const client = this.clients.get(this._activeFileKey);
    return client?.fileInfo?.editorType || 'figma';
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Reject pending requests that were sent to a specific file
   */
  private rejectPendingRequestsForFile(fileKey: string, reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.targetFileKey === fileKey) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(reason));
        this.pendingRequests.delete(id);
      }
    }
  }

  /**
   * Reject all pending requests (used during shutdown)
   */
  private rejectPendingRequests(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  /**
   * Stop the server and clean up all connections
   */
  async stop(): Promise<void> {
    // Clear all per-client grace period timers
    for (const [, client] of this.clients) {
      if (client.gracePeriodTimer) {
        clearTimeout(client.gracePeriodTimer);
        client.gracePeriodTimer = null;
      }
    }

    // Clear pending client identification timeouts
    for (const [, timeout] of this._pendingClients) {
      clearTimeout(timeout);
    }
    this._pendingClients.clear();

    this.rejectPendingRequests('WebSocket server shutting down');

    // Terminate all connected clients so wss.close() resolves promptly
    if (this.wss) {
      for (const ws of this.wss.clients) {
        ws.terminate();
      }
    }
    this.clients.clear();
    this._activeFileKey = null;

    // Close WS server first (handles WebSocket connections)
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
    }

    // Then close HTTP server (releases the port)
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    this._isStarted = false;
    logger.info('WebSocket bridge server stopped');
  }
}
