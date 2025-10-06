/**
 * Local Browser Manager
 * Connects to Figma Desktop via Chrome Remote Debugging Protocol
 */

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createChildLogger } from '../core/logger.js';
import type { IBrowserManager, ScreenshotOptions } from './base.js';

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
	 * Get active Figma page or create new one
	 */
	async getPage(): Promise<Page> {
		if (!this.browser) {
			await this.launch();
		}

		if (this.page && !this.page.isClosed()) {
			return this.page;
		}

		// Get existing pages (Figma tabs)
		const pages = await this.browser!.pages();

		logger.info({ pageCount: pages.length }, 'Found existing pages in Figma Desktop');

		// Find Figma pages (not DevTools, about:blank, etc.)
		const figmaPages = pages.filter(p => {
			const url = p.url();
			return url.includes('figma.com') && !url.includes('devtools');
		});

		if (figmaPages.length > 0) {
			// Prefer design/file pages over team pages
			const designPage = figmaPages.find(p =>
				p.url().includes('/design/') || p.url().includes('/file/')
			);

			const selectedPage = designPage || figmaPages[0];
			logger.info({
				url: selectedPage.url(),
				totalFigmaPages: figmaPages.length,
				isDesignFile: !!designPage
			}, 'Using existing Figma page');

			this.page = selectedPage;
			return this.page;
		}

		// If no Figma page found, use first available page or create new one
		if (pages.length > 0 && pages[0].url() !== 'about:blank') {
			logger.info({ url: pages[0].url() }, 'Using first available page');
			this.page = pages[0];
			return this.page;
		}

		// Create new page
		logger.info('Creating new page in Figma Desktop');
		this.page = await this.browser!.newPage();
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
	async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
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
