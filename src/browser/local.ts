/**
 * Local Browser Manager
 * Connects to Figma Desktop via Chrome Remote Debugging Protocol
 */

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createChildLogger } from '../core/logger.js';
import { extractFileKey } from '../core/figma-api.js';
import type { IBrowserManager, NavigationResult } from './base.js';

const logger = createChildLogger({ component: 'local-browser' });

/**
 * Local browser configuration
 */
export interface LocalBrowserConfig {
	debugPort: number;    // Default: 9222
	debugHost: string;    // Default: localhost
}

/**
 * Local Browser Manager
 * Connects to existing Figma Desktop instance via remote debugging port
 */
export class LocalBrowserManager implements IBrowserManager {
	private browser: Browser | null = null;
	private page: Page | null = null;
	private config: LocalBrowserConfig;

	constructor(config: LocalBrowserConfig) {
		this.config = config;
	}

	/**
	 * Connect to Figma Desktop via remote debugging port
	 */
	async launch(): Promise<void> {
		if (this.browser) {
			logger.info('Browser already connected, reusing instance');
			return;
		}

		const { debugHost, debugPort } = this.config;
		const browserURL = `http://${debugHost}:${debugPort}`;

		logger.info({ browserURL }, 'Connecting to Figma Desktop');

		try {
			// Connect to existing browser (Figma Desktop)
			this.browser = await puppeteer.connect({
				browserURL,
				defaultViewport: null, // Use Figma's viewport
			});

			logger.info('Connected to Figma Desktop successfully');

			// Handle disconnection
			this.browser.on('disconnected', () => {
				logger.warn('Disconnected from Figma Desktop');
				this.browser = null;
				this.page = null;
			});

		} catch (error) {
			logger.error({ error, browserURL }, 'Failed to connect to Figma Desktop');

			throw new Error(
				`Failed to connect to Figma Desktop at ${browserURL}.\n\n` +
				`Make sure:\n` +
				`1. Figma Desktop is running\n` +
				`2. Figma was launched with: --remote-debugging-port=${debugPort}\n` +
				`3. "Use Developer VM" is enabled in: Plugins → Development → Use Developer VM\n\n` +
				`macOS launch command:\n` +
				`  open -a "Figma" --args --remote-debugging-port=${debugPort}\n\n` +
				`Error: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Find the best page for plugin debugging
	 * Actively searches for pages with workers across ALL tabs
	 */
	private async findBestPage(): Promise<Page | null> {
		if (!this.browser) {
			return null;
		}

		const pages = await this.browser.pages();

		// Find Figma pages with workers
		const figmaPages = pages.filter(p => {
			const url = p.url();
			return url.includes('figma.com') && !url.includes('devtools');
		});

		if (figmaPages.length === 0) {
			return null;
		}

		// Check each page for workers
		const pagesWithWorkers = figmaPages
			.map(p => ({
				page: p,
				workerCount: p.workers().length,
				url: p.url()
			}))
			.filter(p => p.workerCount > 0)
			.sort((a, b) => b.workerCount - a.workerCount); // Most workers first

		if (pagesWithWorkers.length > 0) {
			logger.info({
				url: pagesWithWorkers[0].url,
				workerCount: pagesWithWorkers[0].workerCount,
				totalPagesWithWorkers: pagesWithWorkers.length
			}, 'Found page with active plugin workers');
			return pagesWithWorkers[0].page;
		}

		// No workers found - prefer design/file pages
		const designPage = figmaPages.find(p =>
			p.url().includes('/design/') || p.url().includes('/file/')
		);

		return designPage || figmaPages[0];
	}

	/**
	 * Find an existing browser tab whose URL matches the given Figma file key
	 */
	private async findPageByFileKey(targetFileKey: string): Promise<Page | null> {
		if (!this.browser) {
			return null;
		}

		const pages = await this.browser.pages();

		for (const page of pages) {
			const pageUrl = page.url();
			if (!pageUrl.includes('figma.com') || pageUrl.includes('devtools')) {
				continue;
			}

			const pageFileKey = extractFileKey(pageUrl);
			if (pageFileKey && pageFileKey === targetFileKey) {
				logger.info({ url: pageUrl, fileKey: pageFileKey }, 'Found existing tab for file key');
				return page;
			}
		}

		return null;
	}

	/**
	 * Get active Figma page or create new one
	 * Prefers pages with active plugin workers for plugin debugging
	 */
	async getPage(): Promise<Page> {
		// Ensure connection is alive before proceeding
		await this.ensureConnection();

		if (!this.browser) {
			await this.launch();
		}

		// If we already have a page from explicit navigation, use it (don't override with findBestPage)
		if (this.page && !this.page.isClosed()) {
			return this.page;
		}

		// No explicit page set — find the best page (most workers) for initial connection
		const bestPage = await this.findBestPage();
		if (bestPage) {
			const workerCount = bestPage.workers().length;
			logger.info({
				url: bestPage.url(),
				workerCount
			}, 'Selected page for monitoring (auto-detected)');

			this.page = bestPage;
			return this.page;
		}

		// Fallback: Get any existing page or create new one
		const pages = await this.browser!.pages();

		if (pages.length > 0 && pages[0].url() !== 'about:blank') {
			logger.warn({ url: pages[0].url() }, 'No Figma pages found, using first available page');
			this.page = pages[0];
			return this.page;
		}

		// Last resort: Create new page
		logger.warn('No suitable pages found, creating new page in Figma Desktop');
		this.page = await this.browser!.newPage();
		return this.page;
	}

	/**
	 * Navigate to Figma URL
	 * If the target file is already open in a tab, switches to it instead of navigating.
	 */
	async navigateToFigma(figmaUrl?: string): Promise<NavigationResult> {
		// Ensure connection is alive before navigation
		await this.ensureConnection();

		// Default to Figma homepage if no URL provided
		const url = figmaUrl || 'https://www.figma.com';

		// Check if the target file is already open in an existing tab
		const targetFileKey = extractFileKey(url);
		if (targetFileKey) {
			const existingPage = await this.findPageByFileKey(targetFileKey);
			if (existingPage) {
				logger.info({ url, fileKey: targetFileKey }, 'Switching to existing tab instead of navigating');
				await existingPage.bringToFront();
				this.page = existingPage;
				return { page: existingPage, action: 'switched_to_existing', url: existingPage.url() };
			}
		}

		// No existing tab found — fall through to normal navigation
		const page = await this.getPage();

		logger.info({ url }, 'Navigating to Figma');

		try {
			await page.goto(url, {
				waitUntil: 'networkidle2',
				timeout: 30000,
			});

			logger.info({ url }, 'Navigation successful');
			return { page, action: 'navigated', url };
		} catch (error) {
			logger.error({ error, url }, 'Navigation failed');
			throw new Error(`Failed to navigate to ${url}: ${error}`);
		}
	}

	/**
	 * Reload current page
	 */
	async reload(hardReload = false): Promise<void> {
		if (!this.page || this.page.isClosed()) {
			throw new Error('No active page to reload');
		}

		logger.info({ hardReload }, 'Reloading page');

		try {
			await this.page.reload({
				waitUntil: 'networkidle2',
				timeout: 30000,
			});

			logger.info('Page reloaded successfully');
		} catch (error) {
			logger.error({ error }, 'Page reload failed');
			throw new Error(`Page reload failed: ${error}`);
		}
	}

	/**
	 * Execute JavaScript in page context
	 */
	async evaluate<T>(fn: () => T): Promise<T> {
		const page = await this.getPage();
		return page.evaluate(fn);
	}

	// Screenshot functionality removed - use Figma REST API's getImages() instead
	// See: figma_take_screenshot and figma_get_component_image tools

	/**
	 * Check if browser is connected
	 */
	isRunning(): boolean {
		return this.browser !== null && this.browser.isConnected();
	}

	/**
	 * Disconnect from browser (doesn't close Figma Desktop)
	 */
	async close(): Promise<void> {
		if (!this.browser) {
			return;
		}

		logger.info('Disconnecting from Figma Desktop');

		try {
			// Just disconnect, don't close Figma Desktop
			this.browser.disconnect();
			this.browser = null;
			this.page = null;

			logger.info('Disconnected from Figma Desktop successfully');
		} catch (error) {
			logger.error({ error }, 'Failed to disconnect from browser');
			throw error;
		}
	}

	/**
	 * Get current page URL
	 */
	getCurrentUrl(): string | null {
		if (!this.page || this.page.isClosed()) {
			return null;
		}

		return this.page.url();
	}

	/**
	 * Check if the browser connection is still alive
	 * Returns false if connection is stale (e.g., after computer sleep)
	 */
	async isConnectionAlive(): Promise<boolean> {
		try {
			if (!this.browser || !this.page) {
				return false;
			}

			// Try to get the page title - this will fail if connection is dead
			await this.page.title();
			return true;
		} catch (error) {
			logger.warn({ error }, 'Browser connection appears to be dead');
			return false;
		}
	}

	/**
	 * Reconnect to Figma Desktop if connection was lost
	 * Call this before any operation that requires a live connection
	 */
	async ensureConnection(): Promise<void> {
		const isAlive = await this.isConnectionAlive();

		if (!isAlive) {
			logger.info('Connection lost, attempting to reconnect to Figma Desktop');

			// Clear stale references
			this.browser = null;
			this.page = null;

			// Reconnect
			await this.launch();
			logger.info('Successfully reconnected to Figma Desktop');
		}
	}

	/**
	 * Force a complete reconnection to Figma Desktop
	 * Use this when frames become detached or stale even though the browser appears connected
	 */
	async forceReconnect(): Promise<void> {
		logger.info('Force reconnecting to Figma Desktop');

		// Disconnect current connection if exists
		if (this.browser) {
			try {
				this.browser.disconnect();
			} catch (e) {
				// Ignore disconnect errors
			}
		}

		// Clear all references
		this.browser = null;
		this.page = null;

		// Reconnect
		await this.launch();
		logger.info('Force reconnect completed');
	}

	/**
	 * Wait for navigation
	 */
	async waitForNavigation(timeout = 30000): Promise<void> {
		if (!this.page || this.page.isClosed()) {
			throw new Error('No active page');
		}

		await this.page.waitForNavigation({
			waitUntil: 'networkidle2',
			timeout,
		});
	}
}
