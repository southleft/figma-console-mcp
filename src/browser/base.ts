/**
 * Browser Manager Interface
 * Abstract interface for browser automation across different runtimes
 */

/**
 * Screenshot options
 */
export interface ScreenshotOptions {
	fullPage?: boolean;
	type?: 'png' | 'jpeg';
	quality?: number;
}

/**
 * Browser Manager Interface
 * Provides unified API for browser automation regardless of runtime (Cloudflare/Local)
 *
 * Note: Uses 'any' for Page type to support both puppeteer-core and @cloudflare/puppeteer
 * implementations which have incompatible type definitions but compatible runtime behavior
 */
export interface IBrowserManager {
	/**
	 * Launch or connect to browser instance
	 */
	launch(): Promise<void>;

	/**
	 * Get active page instance
	 */
	getPage(): Promise<any>;

	/**
	 * Navigate to Figma URL
	 */
	navigateToFigma(url?: string): Promise<any>;

	/**
	 * Reload current page
	 */
	reload(hardReload?: boolean): Promise<void>;

	/**
	 * Evaluate JavaScript in page context
	 */
	evaluate<T>(fn: () => T): Promise<T>;

	/**
	 * Take screenshot of current page
	 */
	screenshot(options?: ScreenshotOptions): Promise<Buffer>;

	/**
	 * Check if browser is running
	 */
	isRunning(): boolean;

	/**
	 * Close browser instance
	 */
	close(): Promise<void>;

	/**
	 * Get current URL
	 */
	getCurrentUrl(): string | null;

	/**
	 * Wait for navigation to complete
	 */
	waitForNavigation(timeout?: number): Promise<void>;
}
