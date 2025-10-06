/**
 * Console Monitor
 * Captures and manages console logs from Figma plugins via Chrome DevTools Protocol
 * Monitors both main page console AND Web Worker consoles (where Figma plugins run)
 */

import type { Page, WebWorker } from '@cloudflare/puppeteer';
import { createChildLogger } from './logger.js';
import type { ConsoleLogEntry, ConsoleConfig } from './types/index.js';

const logger = createChildLogger({ component: 'console-monitor' });

/**
 * Console Monitor
 * Listens to page console events and maintains a circular buffer of logs
 * Also monitors Web Workers to capture Figma plugin console logs
 */
export class ConsoleMonitor {
	private logs: ConsoleLogEntry[] = [];
	private config: ConsoleConfig;
	private isMonitoring = false;
	private page: Page | null = null;
	private workers: Set<WebWorker> = new Set();

	constructor(config: ConsoleConfig) {
		this.config = config;
	}

	/**
	 * Start monitoring console logs on a page
	 */
	async startMonitoring(page: Page): Promise<void> {
		if (this.isMonitoring && this.page === page) {
			logger.info('Already monitoring this page');
			return;
		}

		this.page = page;
		this.isMonitoring = true;

		logger.info('Starting console monitoring (page + workers)');

		// Listen to main page console events
		page.on('console', async (msg) => {
			try {
				const entry = await this.processConsoleMessage(msg, 'page');
				if (entry) {
					this.addLog(entry);
				}
			} catch (error) {
				logger.error({ error }, 'Failed to process console message');
			}
		});

		// Listen to page errors
		page.on('pageerror', (error) => {
			this.addLog({
				timestamp: Date.now(),
				level: 'error',
				message: error.message,
				args: [],
				stackTrace: {
					callFrames: error.stack
						? error.stack.split('\n').map((line) => ({
								functionName: line.trim(),
								url: '',
								lineNumber: 0,
								columnNumber: 0,
						  }))
						: [],
				},
				source: 'page',
			});
		});

		// Monitor existing workers (for Figma plugin console logs)
		const existingWorkers = page.workers();
		logger.info({ workerCount: existingWorkers.length }, 'Found existing workers');
		for (const worker of existingWorkers) {
			this.attachWorkerListeners(worker);
		}

		// Listen for new workers being created (e.g., when plugin starts)
		page.on('workercreated', (worker) => {
			logger.info({ workerUrl: worker.url() }, 'New worker created');
			this.attachWorkerListeners(worker);
		});

		// Listen for workers being destroyed
		page.on('workerdestroyed', (worker) => {
			logger.info({ workerUrl: worker.url() }, 'Worker destroyed');
			this.workers.delete(worker);
		});

		logger.info({
			pageMonitoring: true,
			workerMonitoring: true,
			initialWorkerCount: existingWorkers.length
		}, 'Console monitoring started');
	}

	/**
	 * Attach console listeners to a Web Worker
	 * This captures Figma plugin console logs
	 */
	private attachWorkerListeners(worker: WebWorker): void {
		this.workers.add(worker);

		const workerUrl = worker.url();
		logger.info({ workerUrl }, 'Attaching console listener to worker');

		// DIAGNOSTIC: Log a marker when worker listener is attached
		this.addLog({
			timestamp: Date.now(),
			level: 'info',
			message: `[MCP] Worker detected and monitored: ${workerUrl}`,
			args: [],
			source: 'plugin',
			workerUrl,
		});

		// Listen to worker console events
		worker.on('console', async (msg: any) => {
			try {
				logger.info({ workerUrl, type: msg.type(), text: msg.text() }, 'Worker console event received');
				const entry = await this.processConsoleMessage(msg, 'worker', workerUrl);
				if (entry) {
					this.addLog(entry);
				}
			} catch (error) {
				logger.error({ error, workerUrl }, 'Failed to process worker console message');
			}
		});

		// Worker doesn't have pageerror, but console.error will be captured above
	}

	/**
	 * Process console message from Puppeteer
	 * @param msg - Console message from page or worker
	 * @param context - Where the message came from ('page' or 'worker')
	 * @param workerUrl - URL of the worker (if context is 'worker')
	 */
	private async processConsoleMessage(
		msg: any,
		context: 'page' | 'worker',
		workerUrl?: string
	): Promise<ConsoleLogEntry | null> {
		const level = msg.type() as ConsoleLogEntry['level'];

		// Filter by configured levels
		if (
			this.config.filterLevels.length > 0 &&
			!this.config.filterLevels.includes(level)
		) {
			return null;
		}

		try {
			// Extract message text
			const message = msg.text();

			// Extract arguments (with truncation)
			const args = await Promise.all(
				msg.args().map(async (arg: any) => {
					try {
						const jsonValue = await arg.jsonValue();
						return this.truncateValue(jsonValue);
					} catch {
						return String(arg);
					}
				})
			);

			// Determine source based on context
			let source: ConsoleLogEntry['source'];
			if (context === 'worker') {
				// Workers are where Figma plugins run
				source = 'plugin';
			} else {
				// Page console - determine if plugin or figma
				const location = msg.location();
				source = this.determineSource(location?.url);
			}

			const entry: ConsoleLogEntry = {
				timestamp: Date.now(),
				level,
				message: this.truncateString(message),
				args,
				source,
			};

			// Add worker URL metadata for debugging
			if (workerUrl && context === 'worker') {
				entry.workerUrl = workerUrl;
			}

			// Add stack trace for errors
			if (level === 'error' && msg.stackTrace) {
				entry.stackTrace = {
					callFrames: msg.stackTrace().callFrames || [],
				};
			}

			return entry;
		} catch (error) {
			logger.error({ error, context, workerUrl }, 'Failed to extract console message details');
			return null;
		}
	}

	/**
	 * Determine if log is from plugin or Figma
	 */
	private determineSource(url?: string): ConsoleLogEntry['source'] {
		if (!url) return 'unknown';

		// Plugin code typically runs in iframes or specific contexts
		if (url.includes('plugin') || url.includes('iframe')) {
			return 'plugin';
		}

		if (url.includes('figma.com')) {
			return 'figma';
		}

		return 'unknown';
	}

	/**
	 * Add log to circular buffer
	 */
	private addLog(entry: ConsoleLogEntry): void {
		this.logs.push(entry);

		// Maintain buffer size
		if (this.logs.length > this.config.bufferSize) {
			this.logs.shift();
		}

		logger.debug({ level: entry.level, source: entry.source }, 'Log captured');
	}

	/**
	 * Truncate string to max length
	 */
	private truncateString(str: string): string {
		const maxLength = this.config.truncation.maxStringLength;
		if (str.length <= maxLength) {
			return str;
		}
		return str.substring(0, maxLength) + '... (truncated)';
	}

	/**
	 * Truncate value (string, array, object) intelligently
	 * Based on AgentDesk pattern to prevent context overflow
	 */
	private truncateValue(value: any, depth = 0): any {
		const { maxStringLength, maxArrayLength, maxObjectDepth } = this.config.truncation;

		// Max depth reached
		if (depth >= maxObjectDepth) {
			return '[Max depth reached]';
		}

		// Handle null/undefined
		if (value === null || value === undefined) {
			return value;
		}

		// Handle strings
		if (typeof value === 'string') {
			return this.truncateString(value);
		}

		// Handle arrays
		if (Array.isArray(value)) {
			const truncated = value.slice(0, maxArrayLength).map((item) =>
				this.truncateValue(item, depth + 1)
			);

			if (value.length > maxArrayLength) {
				truncated.push(`... (${value.length - maxArrayLength} more items)`);
			}

			return truncated;
		}

		// Handle objects
		if (typeof value === 'object') {
			const result: any = {};
			let count = 0;

			for (const [key, val] of Object.entries(value)) {
				if (count >= 10) {
					// Limit object properties
					result['...'] = '(more properties)';
					break;
				}
				result[key] = this.truncateValue(val, depth + 1);
				count++;
			}

			return result;
		}

		// Primitives (number, boolean, etc.)
		return value;
	}

	/**
	 * Get logs with optional filtering
	 */
	getLogs(options?: {
		count?: number;
		level?: ConsoleLogEntry['level'] | 'all';
		since?: number;
	}): ConsoleLogEntry[] {
		let filtered = [...this.logs];

		// Filter by timestamp
		if (options?.since) {
			filtered = filtered.filter((log) => log.timestamp >= options.since!);
		}

		// Filter by level
		if (options?.level && options.level !== 'all') {
			filtered = filtered.filter((log) => log.level === options.level);
		}

		// Limit count (get most recent)
		if (options?.count) {
			filtered = filtered.slice(-options.count);
		}

		return filtered;
	}

	/**
	 * Clear log buffer
	 */
	clear(): number {
		const count = this.logs.length;
		this.logs = [];
		logger.info({ clearedCount: count }, 'Console buffer cleared');
		return count;
	}

	/**
	 * Stop monitoring
	 */
	stopMonitoring(): void {
		if (!this.isMonitoring) {
			return;
		}

		this.isMonitoring = false;
		this.page = null;

		logger.info('Console monitoring stopped');
	}

	/**
	 * Get monitoring status
	 */
	getStatus() {
		return {
			isMonitoring: this.isMonitoring,
			logCount: this.logs.length,
			bufferSize: this.config.bufferSize,
			workerCount: this.workers.size,
			oldestTimestamp: this.logs[0]?.timestamp,
			newestTimestamp: this.logs[this.logs.length - 1]?.timestamp,
		};
	}
}
