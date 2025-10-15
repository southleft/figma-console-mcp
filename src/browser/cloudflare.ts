/**
 * Cloudflare Browser Manager
 * Manages Puppeteer browser instance lifecycle for Cloudflare Browser Rendering API
 */

import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer';
import { createChildLogger } from '../core/logger.js';
import type { BrowserConfig } from '../core/types/index.js';
import type { IBrowserManager } from './base.js';

const logger = createChildLogger({ component: 'cloudflare-browser' });

/**
 * Environment interface for Cloudflare Workers
 */
export interface CloudflareEnv {
	BROWSER: Fetcher;
	MCP_OBJECT: DurableObjectNamespace;
	FIGMA_ACCESS_TOKEN?: string; // Optional Figma API token for data extraction
}

/**
 * Cloudflare Browser Manager
 * Implements IBrowserManager for Cloudflare Browser Rendering API
 */
export class CloudflareBrowserManager implements IBrowserManager {
	private browser: Browser | null = null;
	private page: Page | null = null;
	private env: CloudflareEnv;
	private config: BrowserConfig;

	constructor(env: CloudflareEnv, config: BrowserConfig) {
		this.env = env;
		this.config = config;
	}

	/**
	 * Launch browser instance via Cloudflare Browser Rendering API
	 */
	async launch(): Promise<void> {
		if (this.browser) {
			logger.info('Browser already running, reusing instance');
			return;
		}

		logger.info('Launching browser with Cloudflare Browser Rendering API');

		try {
			this.browser = await puppeteer.launch(this.env.BROWSER, {
				keep_alive: 600000, // Keep alive for 10 minutes
			});

			logger.info('Browser launched successfully');
		} catch (error) {
			logger.error({ error }, 'Failed to launch browser');
			throw new Error(`Browser launch failed: ${error}`);
		}
	}

	/**
	 * Get or create a page instance
	 */
	async getPage(): Promise<Page> {
		if (!this.browser) {
			await this.launch();
		}

		if (this.page && !this.page.isClosed()) {
			return this.page;
		}

		logger.info('Creating new browser page');
		this.page = await this.browser!.newPage();

		// Set viewport size
		await this.page.setViewport({
			width: 1920,
			height: 1080,
			deviceScaleFactor: 1,
		});

		logger.info('Browser page created');
		return this.page;
	}

	/**
	 * Navigate to Figma URL
	 */
	async navigateToFigma(figmaUrl?: string): Promise<Page> {
		const page = await this.getPage();

		// Default to Figma homepage if no URL provided
		const url = figmaUrl || 'https://www.figma.com';

		logger.info({ url }, 'Navigating to Figma');

		try {
			await page.goto(url, {
				waitUntil: 'networkidle2',
				timeout: 30000,
			});

			logger.info({ url }, 'Navigation successful');
			return page;
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
	 * Check if browser is running
	 */
	isRunning(): boolean {
		return this.browser !== null && this.browser.isConnected();
	}

	/**
	 * Close browser instance
	 */
	async close(): Promise<void> {
		if (!this.browser) {
			return;
		}

		logger.info('Closing browser');

		try {
			await this.browser.close();
			this.browser = null;
			this.page = null;

			logger.info('Browser closed successfully');
		} catch (error) {
			logger.error({ error }, 'Failed to close browser');
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

// Re-export Env for backwards compatibility
export type Env = CloudflareEnv;
