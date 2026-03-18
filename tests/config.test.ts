/**
 * Config Tests
 *
 * Unit tests for loadConfig, validateConfig, getConfig.
 */

import { loadConfig, validateConfig, getConfig } from "../src/core/config";
import type { ServerConfig } from "../src/core/types/index";

// ============================================================================
// Helper: build a valid config for mutation tests
// ============================================================================

function makeValidConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		mode: "local",
		browser: {
			headless: false,
			args: ["--no-sandbox"],
		},
		console: {
			bufferSize: 1000,
			filterLevels: ["log", "info", "warn", "error", "debug"],
			truncation: {
				maxStringLength: 500,
				maxArrayLength: 10,
				maxObjectDepth: 3,
				removeDuplicates: true,
			},
		},
		screenshots: {
			defaultFormat: "png",
			quality: 90,
			storePath: "/tmp/test",
		},
		local: {
			debugHost: "localhost",
			debugPort: 9222,
		},
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("Config", () => {
	// ========================================================================
	// loadConfig
	// ========================================================================

	describe("loadConfig", () => {
		it("returns a valid config object", () => {
			const config = loadConfig();
			expect(config).toBeDefined();
			expect(config.mode).toBeDefined();
			expect(config.browser).toBeDefined();
			expect(config.console).toBeDefined();
			expect(config.screenshots).toBeDefined();
		});

		it("has correct default values", () => {
			const config = loadConfig();
			expect(config.mode).toBe("local");
			expect(config.browser.headless).toBe(false);
			expect(config.console.bufferSize).toBe(1000);
			expect(config.console.filterLevels).toContain("log");
			expect(config.console.filterLevels).toContain("error");
			expect(config.screenshots.defaultFormat).toBe("png");
			expect(config.screenshots.quality).toBe(90);
		});

		it("has correct default truncation settings", () => {
			const config = loadConfig();
			expect(config.console.truncation.maxStringLength).toBe(500);
			expect(config.console.truncation.maxArrayLength).toBe(10);
			expect(config.console.truncation.maxObjectDepth).toBe(3);
			expect(config.console.truncation.removeDuplicates).toBe(true);
		});

		it("includes browser args", () => {
			const config = loadConfig();
			expect(Array.isArray(config.browser.args)).toBe(true);
			expect(config.browser.args.length).toBeGreaterThan(0);
		});

		it("includes local mode settings", () => {
			const config = loadConfig();
			expect(config.local).toBeDefined();
			expect(config.local!.debugHost).toBeDefined();
			expect(config.local!.debugPort).toBeDefined();
		});
	});

	// ========================================================================
	// validateConfig
	// ========================================================================

	describe("validateConfig", () => {
		it("does not throw for a valid config", () => {
			const config = makeValidConfig();
			expect(() => validateConfig(config)).not.toThrow();
		});

		it("throws when browser.args is not an array", () => {
			const config = makeValidConfig();
			(config.browser as any).args = "not-an-array";
			expect(() => validateConfig(config)).toThrow("browser.args must be an array");
		});

		it("throws when console.bufferSize is zero", () => {
			const config = makeValidConfig();
			config.console.bufferSize = 0;
			expect(() => validateConfig(config)).toThrow(
				"console.bufferSize must be positive"
			);
		});

		it("throws when console.bufferSize is negative", () => {
			const config = makeValidConfig();
			config.console.bufferSize = -10;
			expect(() => validateConfig(config)).toThrow(
				"console.bufferSize must be positive"
			);
		});

		it("throws when console.filterLevels is not an array", () => {
			const config = makeValidConfig();
			(config.console as any).filterLevels = "log";
			expect(() => validateConfig(config)).toThrow(
				"console.filterLevels must be an array"
			);
		});

		it("throws when truncation.maxStringLength is not positive", () => {
			const config = makeValidConfig();
			config.console.truncation.maxStringLength = 0;
			expect(() => validateConfig(config)).toThrow(
				"console.truncation.maxStringLength must be positive"
			);
		});

		it("throws when truncation.maxArrayLength is not positive", () => {
			const config = makeValidConfig();
			config.console.truncation.maxArrayLength = -1;
			expect(() => validateConfig(config)).toThrow(
				"console.truncation.maxArrayLength must be positive"
			);
		});

		it("throws when truncation.maxObjectDepth is not positive", () => {
			const config = makeValidConfig();
			config.console.truncation.maxObjectDepth = 0;
			expect(() => validateConfig(config)).toThrow(
				"console.truncation.maxObjectDepth must be positive"
			);
		});

		it("throws when screenshots.defaultFormat is invalid", () => {
			const config = makeValidConfig();
			(config.screenshots as any).defaultFormat = "gif";
			expect(() => validateConfig(config)).toThrow(
				'screenshots.defaultFormat must be "png" or "jpeg"'
			);
		});

		it("throws when screenshots.quality is below 0", () => {
			const config = makeValidConfig();
			config.screenshots.quality = -1;
			expect(() => validateConfig(config)).toThrow(
				"screenshots.quality must be between 0 and 100"
			);
		});

		it("throws when screenshots.quality is above 100", () => {
			const config = makeValidConfig();
			config.screenshots.quality = 101;
			expect(() => validateConfig(config)).toThrow(
				"screenshots.quality must be between 0 and 100"
			);
		});

		it("accepts edge values: quality 0 and 100", () => {
			const config0 = makeValidConfig();
			config0.screenshots.quality = 0;
			expect(() => validateConfig(config0)).not.toThrow();

			const config100 = makeValidConfig();
			config100.screenshots.quality = 100;
			expect(() => validateConfig(config100)).not.toThrow();
		});

		it("accepts jpeg format", () => {
			const config = makeValidConfig();
			(config.screenshots as any).defaultFormat = "jpeg";
			expect(() => validateConfig(config)).not.toThrow();
		});
	});

	// ========================================================================
	// getConfig
	// ========================================================================

	describe("getConfig", () => {
		it("returns a validated config", () => {
			const config = getConfig();
			expect(config).toBeDefined();
			expect(config.mode).toBeDefined();
			// If getConfig didn't throw, validation passed
		});

		it("returns the same structure as loadConfig", () => {
			const loaded = loadConfig();
			const got = getConfig();
			expect(Object.keys(got)).toEqual(Object.keys(loaded));
		});
	});
});
