/**
 * Browser Manager
 * Manages Puppeteer browser instance lifecycle for Cloudflare Browser Rendering API
 */

import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer';
import { createChildLogger } from './logger.js';
import type { BrowserConfig } from './types/index.js';

const logger = createChildLogger({ component: 'browser-manager' });

/**
 * Environment interface for Cloudflare Workers
 */
export interface Env {
	BROWSER: Fetcher;
	MCP_OBJECT: DurableObjectNamespace;
}

/**
 * Browser Manager
 * Handles browser instance creation, page management, and navigation
 */
export class BrowserManager {
	private browser: Browser | null = null;
	private page: Page | null = null;
	private env: Env;
	private config: BrowserConfig;

	constructor(env: Env, config: BrowserConfig) {
		this.env = env;
		this.config = config;
	}

	/**
	 * Launch browser instance
	 */
	async launch(): Promise<Browser> {
		if (this.browser) {
			logger.info('Browser already running, reusing instance');
			return this.browser;
		}

		logger.info('Launching browser with Cloudflare Browser Rendering API');

		try {
			this.browser = await puppeteer.launch(this.env.BROWSER, {
				keep_alive: 600000, // Keep alive for 10 minutes
			});

			logger.info('Browser launched successfully');
			return this.browser;
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

	/**
	 * Take screenshot of current page
	 */
	async screenshot(options?: {
		fullPage?: boolean;
		type?: 'png' | 'jpeg';
		quality?: number;
	}): Promise<Buffer> {
		const page = await this.getPage();

		logger.info({ options }, 'Taking screenshot');

		try {
			const screenshot = await page.screenshot({
				fullPage: options?.fullPage ?? false,
				type: options?.type ?? 'png',
				quality: options?.quality,
			});

			logger.info('Screenshot captured successfully');
			return screenshot as Buffer;
		} catch (error) {
			logger.error({ error }, 'Screenshot failed');
			throw new Error(`Screenshot failed: ${error}`);
		}
	}

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
