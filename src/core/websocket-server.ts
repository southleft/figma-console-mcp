/**
 * WebSocket Bridge Server
 *
 * Creates a WebSocket server that the Desktop Bridge plugin UI connects to.
 * Provides request/response correlation for command execution and forwards
 * unsolicited data (like VARIABLES_DATA) as events.
 *
 * Data flow: MCP Server ←WebSocket→ ui.html ←postMessage→ code.js ←figma.*→ Figma
 */

import { WebSocketServer as WSServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { createChildLogger } from './logger.js';
import type { ConsoleLogEntry } from './types/index.js';

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
}

export interface ConnectedFileInfo {
  fileName: string;
  fileKey: string | null;
  currentPage?: string;
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

export class FigmaWebSocketServer extends EventEmitter {
  private wss: WSServer | null = null;
  private client: WebSocket | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestIdCounter = 0;
  private options: WebSocketServerOptions;
  private _isStarted = false;
  private gracePeriodTimer: ReturnType<typeof setTimeout> | null = null;
  private _connectedFileInfo: ConnectedFileInfo | null = null;
  private consoleLogs: ConsoleLogEntry[] = [];
  private consoleBufferSize = 1000;
  private _currentSelection: SelectionInfo | null = null;
  private documentChanges: DocumentChangeEntry[] = [];
  private documentChangeBufferSize = 200;

  constructor(options: WebSocketServerOptions) {
    super();
    this.options = options;
  }

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    if (this._isStarted) return;

    return new Promise((resolve, reject) => {
      try {
        this.wss = new WSServer({
          port: this.options.port,
          host: this.options.host || 'localhost',
          maxPayload: 100 * 1024 * 1024, // 100MB — screenshots and large component data can be big
        });

        this.wss.on('listening', () => {
          this._isStarted = true;
          logger.info(
            { port: this.options.port, host: this.options.host || 'localhost' },
            'WebSocket bridge server started'
          );
          resolve();
        });

        this.wss.on('error', (error: any) => {
          if (!this._isStarted) {
            reject(error);
          } else {
            logger.error({ error }, 'WebSocket server error');
          }
        });

        this.wss.on('connection', (ws: WebSocket) => {
          // Cancel any pending grace period from a previous disconnect
          if (this.gracePeriodTimer) {
            clearTimeout(this.gracePeriodTimer);
            this.gracePeriodTimer = null;
          }

          // Only allow one client (the plugin UI)
          if (this.client) {
            logger.warn('Replacing existing WebSocket client connection');
            // Reject any pending requests from the old client before replacing
            this.rejectPendingRequests('Client replaced by new connection');
            this.client.close(1000, 'Replaced by new connection');
          }

          this.client = ws;
          logger.info('Desktop Bridge plugin connected via WebSocket');
          this.emit('connected');

          ws.on('message', (data: Buffer) => {
            try {
              const message = JSON.parse(data.toString());
              this.handleMessage(message);
            } catch (error) {
              logger.error({ error }, 'Failed to parse WebSocket message');
            }
          });

          ws.on('close', (code: number, reason: Buffer) => {
            logger.info(
              { code, reason: reason.toString() },
              'Desktop Bridge plugin disconnected'
            );
            if (this.client === ws) {
              this.client = null;
              this._connectedFileInfo = null;
              this._currentSelection = null;
            }
            this.emit('disconnected');

            // Give pending requests a grace period before rejecting
            this.gracePeriodTimer = setTimeout(() => {
              this.gracePeriodTimer = null;
              if (!this.client) {
                this.rejectPendingRequests('WebSocket client disconnected');
              }
            }, 5000);
          });

          ws.on('error', (error: any) => {
            logger.error({ error }, 'WebSocket client error');
          });
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle incoming message from plugin UI
   */
  private handleMessage(message: any): void {
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

    // Unsolicited data from plugin (e.g. VARIABLES_DATA, console messages)
    if (message.type) {
      // Track file identity when the plugin reports it
      if (message.type === 'FILE_INFO' && message.data) {
        this._connectedFileInfo = {
          fileName: message.data.fileName,
          fileKey: message.data.fileKey || null,
          currentPage: message.data.currentPage,
          connectedAt: Date.now(),
        };
        logger.info(
          { fileName: this._connectedFileInfo.fileName, fileKey: this._connectedFileInfo.fileKey },
          'Connected to Figma file'
        );
      }

      // Buffer document changes and emit event (enables cache invalidation + AI querying)
      if (message.type === 'DOCUMENT_CHANGE' && message.data) {
        const entry: DocumentChangeEntry = {
          hasStyleChanges: message.data.hasStyleChanges,
          hasNodeChanges: message.data.hasNodeChanges,
          changedNodeIds: message.data.changedNodeIds || [],
          changeCount: message.data.changeCount || 0,
          timestamp: message.data.timestamp || Date.now(),
        };
        this.documentChanges.push(entry);
        if (this.documentChanges.length > this.documentChangeBufferSize) {
          this.documentChanges.shift();
        }
        this.emit('documentChange', message.data);
      }

      // Track selection changes from the plugin
      if (message.type === 'SELECTION_CHANGE' && message.data) {
        this._currentSelection = message.data as SelectionInfo;
        this.emit('selectionChange', this._currentSelection);
      }

      // Track page changes and update connected file info
      if (message.type === 'PAGE_CHANGE' && message.data) {
        if (this._connectedFileInfo) {
          this._connectedFileInfo.currentPage = message.data.pageName;
        }
        this.emit('pageChange', message.data);
      }

      // Capture console logs forwarded from the plugin sandbox
      if (message.type === 'CONSOLE_CAPTURE' && message.data) {
        const data = message.data;
        const entry: ConsoleLogEntry = {
          timestamp: data.timestamp || Date.now(),
          level: data.level || 'log',
          message: typeof data.message === 'string' ? data.message.substring(0, 1000) : String(data.message),
          args: Array.isArray(data.args) ? data.args.slice(0, 10) : [],
          source: 'plugin',
        };
        this.consoleLogs.push(entry);
        if (this.consoleLogs.length > this.consoleBufferSize) {
          this.consoleLogs.shift();
        }
        this.emit('consoleLog', entry);
      }

      this.emit('pluginMessage', message);
      return;
    }

    logger.debug({ message }, 'Unhandled WebSocket message');
  }

  /**
   * Send a command to the plugin UI and wait for the response
   */
  sendCommand(method: string, params: Record<string, any> = {}, timeoutMs = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.client || this.client.readyState !== WebSocket.OPEN) {
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
      });

      const message = JSON.stringify({ id, method, params });
      this.client.send(message);

      logger.debug({ id, method }, 'Sent WebSocket command');
    });
  }

  /**
   * Check if a client is connected
   */
  isClientConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  /**
   * Whether the server has been started
   */
  isStarted(): boolean {
    return this._isStarted;
  }

  /**
   * Get info about the currently connected Figma file.
   * Returns null if no client is connected or file info hasn't been reported yet.
   */
  getConnectedFileInfo(): ConnectedFileInfo | null {
    return this._connectedFileInfo;
  }

  /**
   * Get console logs with optional filtering (mirrors ConsoleMonitor.getLogs API)
   */
  getConsoleLogs(options?: {
    count?: number;
    level?: ConsoleLogEntry['level'] | 'all';
    since?: number;
  }): ConsoleLogEntry[] {
    let filtered = [...this.consoleLogs];

    if (options?.since) {
      filtered = filtered.filter((log) => log.timestamp >= options.since!);
    }

    if (options?.level && options.level !== 'all') {
      filtered = filtered.filter((log) => log.level === options.level);
    }

    if (options?.count) {
      filtered = filtered.slice(-options.count);
    }

    return filtered;
  }

  /**
   * Clear console log buffer
   */
  clearConsoleLogs(): number {
    const count = this.consoleLogs.length;
    this.consoleLogs = [];
    return count;
  }

  /**
   * Get the current user selection in Figma
   */
  getCurrentSelection(): SelectionInfo | null {
    return this._currentSelection;
  }

  /**
   * Get buffered document change events with optional filtering
   */
  getDocumentChanges(options?: {
    count?: number;
    since?: number;
  }): DocumentChangeEntry[] {
    let filtered = [...this.documentChanges];

    if (options?.since) {
      filtered = filtered.filter((e) => e.timestamp >= options.since!);
    }

    if (options?.count) {
      filtered = filtered.slice(-options.count);
    }

    return filtered;
  }

  /**
   * Clear document change buffer
   */
  clearDocumentChanges(): number {
    const count = this.documentChanges.length;
    this.documentChanges = [];
    return count;
  }

  /**
   * Get console monitoring status
   */
  getConsoleStatus() {
    return {
      isMonitoring: this.isClientConnected(),
      logCount: this.consoleLogs.length,
      bufferSize: this.consoleBufferSize,
      workerCount: 0,
      oldestTimestamp: this.consoleLogs[0]?.timestamp,
      newestTimestamp: this.consoleLogs[this.consoleLogs.length - 1]?.timestamp,
    };
  }

  /**
   * Reject all pending requests (e.g. on disconnect)
   */
  private rejectPendingRequests(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  /**
   * Stop the server and clean up
   */
  async stop(): Promise<void> {
    if (this.gracePeriodTimer) {
      clearTimeout(this.gracePeriodTimer);
      this.gracePeriodTimer = null;
    }

    this.rejectPendingRequests('WebSocket server shutting down');

    // Terminate all connected clients so wss.close() resolves promptly
    if (this.wss) {
      for (const ws of this.wss.clients) {
        ws.terminate();
      }
    }
    this.client = null;

    if (this.wss) {
      return new Promise((resolve) => {
        this.wss!.close(() => {
          this._isStarted = false;
          logger.info('WebSocket bridge server stopped');
          resolve();
        });
      });
    }

    this._isStarted = false;
  }
}
