/**
 * Console Monitor Tests
 *
 * Unit tests for ConsoleMonitor: startMonitoring, getLogs, clear,
 * stopMonitoring, getStatus, and internal processing/truncation logic.
 */

import { ConsoleMonitor } from "../src/core/console-monitor";
import type { ConsoleConfig, ConsoleLogEntry } from "../src/core/types/index";

// ============================================================================
// Mock infrastructure
// ============================================================================

function makeConfig(overrides: Partial<ConsoleConfig> = {}): ConsoleConfig {
	return {
		bufferSize: 100,
		filterLevels: ["log", "info", "warn", "error", "debug"],
		truncation: {
			maxStringLength: 50,
			maxArrayLength: 5,
			maxObjectDepth: 3,
			removeDuplicates: true,
		},
		...overrides,
	};
}

/** Create a mock Puppeteer-like console message */
function makeMockMsg(overrides: {
	text?: string;
	type?: string;
	args?: any[];
	location?: { url?: string };
	stackTrace?: any;
} = {}) {
	const args = (overrides.args || []).map((v: any) => ({
		jsonValue: jest.fn().mockResolvedValue(v),
	}));

	return {
		text: jest.fn().mockReturnValue(overrides.text || "test message"),
		type: jest.fn().mockReturnValue(overrides.type || "log"),
		args: jest.fn().mockReturnValue(args),
		location: jest.fn().mockReturnValue(overrides.location || { url: "https://www.figma.com/test" }),
		stackTrace: overrides.stackTrace
			? jest.fn().mockReturnValue(overrides.stackTrace)
			: undefined,
	};
}

/** Create a mock Puppeteer Page with event handling */
function makeMockPage() {
	const handlers: Record<string, Function[]> = {};

	const page = {
		on: jest.fn((event: string, handler: Function) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		}),
		frames: jest.fn().mockReturnValue([]),
		workers: jest.fn().mockReturnValue([]),
		mainFrame: jest.fn().mockReturnValue({ _isMainFrame: true }),
		// Helper to trigger events in tests
		_emit(event: string, ...args: any[]) {
			for (const h of handlers[event] || []) {
				h(...args);
			}
		},
		_handlers: handlers,
	};

	return page;
}

/** Create a mock Worker */
function makeMockWorker(url = "blob:plugin-worker") {
	const handlers: Record<string, Function[]> = {};
	return {
		url: jest.fn().mockReturnValue(url),
		on: jest.fn((event: string, handler: Function) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		}),
		_emit(event: string, ...args: any[]) {
			for (const h of handlers[event] || []) {
				h(...args);
			}
		},
		_handlers: handlers,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("ConsoleMonitor", () => {
	let monitor: ConsoleMonitor;

	beforeEach(() => {
		monitor = new ConsoleMonitor(makeConfig());
	});

	// ========================================================================
	// Constructor & initial state
	// ========================================================================

	describe("constructor", () => {
		it("starts with empty logs and not monitoring", () => {
			const status = monitor.getStatus();
			expect(status.isMonitoring).toBe(false);
			expect(status.logCount).toBe(0);
			expect(status.workerCount).toBe(0);
		});
	});

	// ========================================================================
	// startMonitoring
	// ========================================================================

	describe("startMonitoring", () => {
		it("sets monitoring state to true", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			expect(monitor.getStatus().isMonitoring).toBe(true);
		});

		it("registers console, pageerror, worker, and frame event listeners", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			const events = page.on.mock.calls.map((c: any[]) => c[0]);
			expect(events).toContain("console");
			expect(events).toContain("pageerror");
			expect(events).toContain("workercreated");
			expect(events).toContain("workerdestroyed");
			expect(events).toContain("frameattached");
			expect(events).toContain("framedetached");
			expect(events).toContain("framenavigated");
		});

		it("adds diagnostic marker log on start", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			const logs = monitor.getLogs();
			const diagnostic = logs.find((l) =>
				l.message.includes("[MCP DIAGNOSTIC] Monitoring started")
			);
			expect(diagnostic).toBeDefined();
		});

		it("is idempotent for same page", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);
			const countBefore = page.on.mock.calls.length;

			await monitor.startMonitoring(page);
			// Should not add more listeners
			expect(page.on.mock.calls.length).toBe(countBefore);
		});

		it("attaches to existing workers", async () => {
			const worker = makeMockWorker();
			const page = makeMockPage();
			page.workers.mockReturnValue([worker]);

			await monitor.startMonitoring(page);

			expect(worker.on).toHaveBeenCalledWith("console", expect.any(Function));
			expect(monitor.getStatus().workerCount).toBe(1);
		});
	});

	// ========================================================================
	// Console event processing
	// ========================================================================

	describe("console event handling", () => {
		it("captures console messages from page", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);
			const logsBefore = monitor.getLogs().length;

			const msg = makeMockMsg({ text: "hello from plugin", type: "log" });
			await page._emit("console", msg);

			// Allow async processing
			await new Promise((r) => setTimeout(r, 10));

			const logs = monitor.getLogs();
			expect(logs.length).toBeGreaterThan(logsBefore);
			const found = logs.find((l) => l.message === "hello from plugin");
			expect(found).toBeDefined();
			expect(found!.level).toBe("log");
		});

		it("captures page errors", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			page._emit("pageerror", { message: "Uncaught TypeError", stack: "at foo\nat bar" });

			const logs = monitor.getLogs();
			const errorLog = logs.find((l) => l.message === "Uncaught TypeError");
			expect(errorLog).toBeDefined();
			expect(errorLog!.level).toBe("error");
			expect(errorLog!.stackTrace).toBeDefined();
		});

		it("captures worker console events", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			// Simulate a new worker being created
			const worker = makeMockWorker("blob:figma-plugin");
			page._emit("workercreated", worker);

			// Simulate worker console message
			const msg = makeMockMsg({ text: "plugin log", type: "info" });
			await worker._emit("console", msg);

			await new Promise((r) => setTimeout(r, 10));

			const logs = monitor.getLogs();
			const found = logs.find((l) => l.message === "plugin log");
			expect(found).toBeDefined();
			expect(found!.source).toBe("plugin");
		});

		it("removes workers on workerdestroyed", async () => {
			const worker = makeMockWorker();
			const page = makeMockPage();
			page.workers.mockReturnValue([worker]);
			await monitor.startMonitoring(page);

			expect(monitor.getStatus().workerCount).toBe(1);

			page._emit("workerdestroyed", worker);
			expect(monitor.getStatus().workerCount).toBe(0);
		});

		it("filters out messages not in configured levels", async () => {
			const restrictedMonitor = new ConsoleMonitor(
				makeConfig({ filterLevels: ["error"] })
			);
			const page = makeMockPage();
			await restrictedMonitor.startMonitoring(page);
			const countAfterStart = restrictedMonitor.getLogs().length;

			const msg = makeMockMsg({ text: "info msg", type: "info" });
			await page._emit("console", msg);
			await new Promise((r) => setTimeout(r, 10));

			// The info message should be filtered out (only diagnostic logs from start)
			const infoLogs = restrictedMonitor
				.getLogs()
				.filter((l) => l.message === "info msg");
			expect(infoLogs).toHaveLength(0);
		});
	});

	// ========================================================================
	// Navigation handling
	// ========================================================================

	describe("navigation handling", () => {
		it("clears logs when navigating to a different file", async () => {
			const page = makeMockPage();
			const mainFrame = {
				url: jest.fn().mockReturnValue("https://www.figma.com/design/abc/File1"),
				_isMainFrame: true,
			};
			page.mainFrame.mockReturnValue(mainFrame);

			await monitor.startMonitoring(page);

			// First navigation sets lastUrl
			mainFrame.url.mockReturnValue("https://www.figma.com/design/abc/File1");
			page._emit("framenavigated", mainFrame);

			// Navigate to different file
			mainFrame.url.mockReturnValue("https://www.figma.com/design/xyz/File2");
			page._emit("framenavigated", mainFrame);

			// Logs should be cleared (only the post-navigation diagnostic log remains)
			const logs = monitor.getLogs();
			const navDiag = logs.find((l) => l.message.includes("Navigated to new file"));
			expect(navDiag).toBeDefined();
		});

		it("does NOT clear logs on hash-only changes", async () => {
			const page = makeMockPage();
			const mainFrame = {
				url: jest.fn().mockReturnValue("https://www.figma.com/design/abc/File?node-id=1"),
				_isMainFrame: true,
			};
			page.mainFrame.mockReturnValue(mainFrame);

			await monitor.startMonitoring(page);
			const logCountBefore = monitor.getLogs().length;

			// First nav
			page._emit("framenavigated", mainFrame);

			// Hash change only (same base URL)
			mainFrame.url.mockReturnValue("https://www.figma.com/design/abc/File?node-id=2");
			page._emit("framenavigated", mainFrame);

			// Logs should not have been cleared
			expect(monitor.getLogs().length).toBeGreaterThanOrEqual(logCountBefore);
		});
	});

	// ========================================================================
	// getLogs filtering
	// ========================================================================

	describe("getLogs", () => {
		beforeEach(async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);
		});

		it("returns all logs with no options", () => {
			const logs = monitor.getLogs();
			expect(logs.length).toBeGreaterThan(0); // diagnostic logs from start
		});

		it("filters by level", async () => {
			const page = makeMockPage();
			// Emit an error via pageerror
			page._emit = (monitor as any).page._emit || (() => {});
			// Directly use the monitor's pageerror handler
			(monitor as any).page = null; // reset
			const freshMonitor = new ConsoleMonitor(makeConfig());
			const freshPage = makeMockPage();
			await freshMonitor.startMonitoring(freshPage);

			freshPage._emit("pageerror", { message: "error!", stack: "" });

			const errorLogs = freshMonitor.getLogs({ level: "error" });
			expect(errorLogs.every((l) => l.level === "error")).toBe(true);

			const infoLogs = freshMonitor.getLogs({ level: "info" });
			expect(infoLogs.every((l) => l.level === "info")).toBe(true);
		});

		it("filters by count (most recent)", async () => {
			const freshMonitor = new ConsoleMonitor(makeConfig());
			const page = makeMockPage();
			await freshMonitor.startMonitoring(page);

			// Add several page errors
			for (let i = 0; i < 5; i++) {
				page._emit("pageerror", { message: `Error ${i}`, stack: "" });
			}

			const lastTwo = freshMonitor.getLogs({ count: 2 });
			expect(lastTwo).toHaveLength(2);
		});

		it("filters by timestamp", async () => {
			const freshMonitor = new ConsoleMonitor(makeConfig());
			const page = makeMockPage();
			await freshMonitor.startMonitoring(page);

			const afterStart = Date.now() + 1;

			page._emit("pageerror", { message: "Late error", stack: "" });

			const recentLogs = freshMonitor.getLogs({ since: afterStart });
			// Should only include logs with timestamp >= afterStart
			expect(recentLogs.every((l) => l.timestamp >= afterStart)).toBe(true);
		});
	});

	// ========================================================================
	// Circular buffer
	// ========================================================================

	describe("circular buffer", () => {
		it("maintains buffer size limit", async () => {
			const smallMonitor = new ConsoleMonitor(makeConfig({ bufferSize: 5 }));
			const page = makeMockPage();
			await smallMonitor.startMonitoring(page);

			// Add more than buffer size
			for (let i = 0; i < 10; i++) {
				page._emit("pageerror", { message: `Error ${i}`, stack: "" });
			}

			expect(smallMonitor.getLogs().length).toBeLessThanOrEqual(5);
		});

		it("keeps most recent entries (FIFO)", async () => {
			const smallMonitor = new ConsoleMonitor(makeConfig({ bufferSize: 3 }));
			const page = makeMockPage();
			await smallMonitor.startMonitoring(page);

			// Diagnostic logs fill part of the buffer, then errors push them out
			for (let i = 0; i < 5; i++) {
				page._emit("pageerror", { message: `Err-${i}`, stack: "" });
			}

			const logs = smallMonitor.getLogs();
			// Last entry should be the most recent error
			expect(logs[logs.length - 1].message).toBe("Err-4");
		});
	});

	// ========================================================================
	// clear
	// ========================================================================

	describe("clear", () => {
		it("returns count of cleared logs", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			const beforeCount = monitor.getLogs().length;
			const cleared = monitor.clear();
			expect(cleared).toBe(beforeCount);
		});

		it("empties the log buffer", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			monitor.clear();
			expect(monitor.getLogs()).toHaveLength(0);
		});

		it("returns 0 when already empty", () => {
			expect(monitor.clear()).toBe(0);
		});
	});

	// ========================================================================
	// stopMonitoring
	// ========================================================================

	describe("stopMonitoring", () => {
		it("sets monitoring to false", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);
			monitor.stopMonitoring();

			expect(monitor.getStatus().isMonitoring).toBe(false);
		});

		it("is idempotent", () => {
			monitor.stopMonitoring();
			monitor.stopMonitoring();
			expect(monitor.getStatus().isMonitoring).toBe(false);
		});
	});

	// ========================================================================
	// getStatus
	// ========================================================================

	describe("getStatus", () => {
		it("reports correct status when not monitoring", () => {
			const status = monitor.getStatus();
			expect(status.isMonitoring).toBe(false);
			expect(status.logCount).toBe(0);
			expect(status.bufferSize).toBe(100);
			expect(status.workerCount).toBe(0);
			expect(status.oldestTimestamp).toBeUndefined();
			expect(status.newestTimestamp).toBeUndefined();
		});

		it("reports timestamps when logs exist", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			const status = monitor.getStatus();
			expect(status.logCount).toBeGreaterThan(0);
			expect(status.oldestTimestamp).toBeDefined();
			expect(status.newestTimestamp).toBeDefined();
		});
	});

	// ========================================================================
	// Source determination
	// ========================================================================

	describe("source determination (via console events)", () => {
		it("classifies plugin URLs as plugin source", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			const msg = makeMockMsg({
				text: "plugin msg",
				location: { url: "blob:https://www.figma.com/plugin-123" },
			});
			await page._emit("console", msg);
			await new Promise((r) => setTimeout(r, 10));

			const found = monitor.getLogs().find((l) => l.message === "plugin msg");
			expect(found?.source).toBe("plugin");
		});

		it("classifies figma.com URLs as figma source", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			const msg = makeMockMsg({
				text: "figma msg",
				location: { url: "https://www.figma.com/app/something" },
			});
			await page._emit("console", msg);
			await new Promise((r) => setTimeout(r, 10));

			const found = monitor.getLogs().find((l) => l.message === "figma msg");
			expect(found?.source).toBe("figma");
		});
	});

	// ========================================================================
	// Truncation (tested via console event args)
	// ========================================================================

	describe("truncation", () => {
		it("truncates long strings", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			const longStr = "x".repeat(200);
			const msg = makeMockMsg({
				text: longStr,
				args: [longStr],
			});
			await page._emit("console", msg);
			await new Promise((r) => setTimeout(r, 10));

			const found = monitor.getLogs().find((l) => l.message.includes("(truncated)"));
			expect(found).toBeDefined();
			expect(found!.message.length).toBeLessThan(200);
		});

		it("truncates long arrays in args", async () => {
			const page = makeMockPage();
			await monitor.startMonitoring(page);

			const longArray = Array.from({ length: 20 }, (_, i) => i);
			const msg = makeMockMsg({ text: "arr", args: [longArray] });
			await page._emit("console", msg);
			await new Promise((r) => setTimeout(r, 10));

			const found = monitor.getLogs().find((l) => l.message === "arr");
			expect(found).toBeDefined();
			// The arg should be truncated to maxArrayLength + "more items" indicator
			const arg = found!.args[0];
			expect(Array.isArray(arg)).toBe(true);
			expect(arg.length).toBeLessThanOrEqual(6); // 5 items + "more" message
		});
	});
});
