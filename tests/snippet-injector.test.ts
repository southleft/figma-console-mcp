/**
 * Snippet Injector Tests
 *
 * Unit tests for SnippetInjector: generateVariablesSnippet,
 * parseVariablesFromLog, findVariablesLog.
 */

import { SnippetInjector } from "../src/core/snippet-injector";
import type { ConsoleLogEntry } from "../src/core/types/index";

function makeLogEntry(overrides: Partial<ConsoleLogEntry> = {}): ConsoleLogEntry {
	return {
		timestamp: Date.now(),
		level: "log",
		message: "",
		args: [],
		source: "plugin",
		...overrides,
	};
}

describe("SnippetInjector", () => {
	let injector: SnippetInjector;

	beforeEach(() => {
		injector = new SnippetInjector();
	});

	// ========================================================================
	// generateVariablesSnippet
	// ========================================================================

	describe("generateVariablesSnippet", () => {
		it("returns a non-empty string", () => {
			const snippet = injector.generateVariablesSnippet();
			expect(typeof snippet).toBe("string");
			expect(snippet.length).toBeGreaterThan(0);
		});

		it("contains MCP_VARIABLES markers", () => {
			const snippet = injector.generateVariablesSnippet();
			expect(snippet).toContain("[MCP_VARIABLES]");
			expect(snippet).toContain("[MCP_VARIABLES_END]");
		});

		it("contains Figma variable API calls", () => {
			const snippet = injector.generateVariablesSnippet();
			expect(snippet).toContain("figma.variables.getLocalVariablesAsync");
			expect(snippet).toContain(
				"figma.variables.getLocalVariableCollectionsAsync"
			);
		});

		it("is wrapped in an async IIFE", () => {
			const snippet = injector.generateVariablesSnippet();
			expect(snippet).toMatch(/^\(async\s*\(\)\s*=>\s*\{/);
		});

		it("includes error handling", () => {
			const snippet = injector.generateVariablesSnippet();
			expect(snippet).toContain("[MCP_VARIABLES_ERROR]");
			expect(snippet).toContain("catch");
		});
	});

	// ========================================================================
	// parseVariablesFromLog
	// ========================================================================

	describe("parseVariablesFromLog", () => {
		it("returns null for logs without the marker", () => {
			const log = makeLogEntry({ message: "some random log" });
			expect(injector.parseVariablesFromLog(log)).toBeNull();
		});

		it("parses JSON from args[1] (standard position)", () => {
			const payload = {
				timestamp: 12345,
				variables: [{ id: "v1", name: "color" }],
				variableCollections: [{ id: "c1", name: "Colors" }],
			};
			const log = makeLogEntry({
				message: "[MCP_VARIABLES] {...} [MCP_VARIABLES_END]",
				args: ["[MCP_VARIABLES]", JSON.stringify(payload), "[MCP_VARIABLES_END]"],
			});

			const result = injector.parseVariablesFromLog(log);
			expect(result).not.toBeNull();
			expect(result!.variables).toHaveLength(1);
			expect(result!.variables[0].name).toBe("color");
			expect(result!.variableCollections).toHaveLength(1);
			expect(result!.timestamp).toBe(12345);
		});

		it("falls back to args[0] when args[1] is missing", () => {
			const payload = {
				timestamp: 99999,
				variables: [],
				variableCollections: [],
			};
			const log = makeLogEntry({
				message: "[MCP_VARIABLES]",
				args: [JSON.stringify(payload)],
			});

			const result = injector.parseVariablesFromLog(log);
			expect(result).not.toBeNull();
			expect(result!.timestamp).toBe(99999);
		});

		it("handles pre-parsed object in args (not string)", () => {
			const payload = {
				timestamp: 55555,
				variables: [{ id: "v2" }],
				variableCollections: [],
			};
			const log = makeLogEntry({
				message: "[MCP_VARIABLES]",
				args: ["[MCP_VARIABLES]", payload],
			});

			const result = injector.parseVariablesFromLog(log);
			expect(result).not.toBeNull();
			expect(result!.variables).toHaveLength(1);
		});

		it("defaults to empty arrays when fields are missing", () => {
			const log = makeLogEntry({
				message: "[MCP_VARIABLES]",
				args: ["[MCP_VARIABLES]", JSON.stringify({ timestamp: 1 })],
			});

			const result = injector.parseVariablesFromLog(log);
			expect(result!.variables).toEqual([]);
			expect(result!.variableCollections).toEqual([]);
		});

		it("defaults timestamp to Date.now() when missing", () => {
			const before = Date.now();
			const log = makeLogEntry({
				message: "[MCP_VARIABLES]",
				args: ["[MCP_VARIABLES]", JSON.stringify({ variables: [] })],
			});

			const result = injector.parseVariablesFromLog(log);
			expect(result!.timestamp).toBeGreaterThanOrEqual(before);
		});

		it("throws on empty args", () => {
			const log = makeLogEntry({
				message: "[MCP_VARIABLES]",
				args: [],
			});

			expect(() => injector.parseVariablesFromLog(log)).toThrow(
				"Failed to parse variables from console log"
			);
		});

		it("throws on invalid JSON in args", () => {
			const log = makeLogEntry({
				message: "[MCP_VARIABLES]",
				args: ["[MCP_VARIABLES]", "not-valid-json{{{"],
			});

			expect(() => injector.parseVariablesFromLog(log)).toThrow(
				"Failed to parse variables from console log"
			);
		});
	});

	// ========================================================================
	// findVariablesLog
	// ========================================================================

	describe("findVariablesLog", () => {
		it("returns null for empty log array", () => {
			expect(injector.findVariablesLog([])).toBeNull();
		});

		it("returns null when no logs contain the marker", () => {
			const logs = [
				makeLogEntry({ message: "hello" }),
				makeLogEntry({ message: "world" }),
			];
			expect(injector.findVariablesLog(logs)).toBeNull();
		});

		it("finds the log with the marker", () => {
			const target = makeLogEntry({
				message: "[MCP_VARIABLES] data [MCP_VARIABLES_END]",
			});
			const logs = [
				makeLogEntry({ message: "before" }),
				target,
				makeLogEntry({ message: "after" }),
			];

			expect(injector.findVariablesLog(logs)).toBe(target);
		});

		it("returns the most recent match (last in array)", () => {
			const older = makeLogEntry({
				message: "[MCP_VARIABLES] old",
				timestamp: 1000,
			});
			const newer = makeLogEntry({
				message: "[MCP_VARIABLES] new",
				timestamp: 2000,
			});
			const logs = [older, makeLogEntry({ message: "noise" }), newer];

			expect(injector.findVariablesLog(logs)).toBe(newer);
		});
	});
});
