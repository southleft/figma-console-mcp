/**
 * EXECUTE_CODE after its timeout.
 *
 * The plugin cannot cancel a running script. When EXECUTE_CODE's timeout wins
 * the race, the handler reports "Execution timed out" — and the script keeps
 * running, usually finishing a little later with its document changes applied.
 * Its outcome used to be discarded. The timeout timer was also never cleared,
 * so after a syntax error it fired later and rejected with nobody listening.
 *
 * The EXECUTE_CODE handler from figma-desktop-bridge/code.js and the late-result
 * routing functions from ui.html are extracted and run against fakes, so the
 * real plugin code is what's under test.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_DIR = join(__dirname, "..", "figma-desktop-bridge");
const codeJs = readFileSync(join(PLUGIN_DIR, "code.js"), "utf8");
const uiHtml = readFileSync(join(PLUGIN_DIR, "ui.html"), "utf8");

/** Source of `function name(...) {...}` in a plugin file, or "" if absent. */
function extractFunction(source: string, name: string): string {
	const start = source.indexOf(`function ${name}(`);
	if (start === -1) return "";
	let depth = 0;
	for (let i = source.indexOf("{", start); i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
	}
	throw new Error(`Unbalanced braces in ${name}`);
}

function extractExecuteCodeHandler(): string {
	const start = codeJs.indexOf("if (msg.type === 'EXECUTE_CODE') {");
	if (start === -1) throw new Error("EXECUTE_CODE handler not found");
	const next = codeJs.indexOf("// UPDATE_VARIABLE", start);
	return codeJs.slice(start, codeJs.lastIndexOf("}", next) + 1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeHarness(opts: { postMessageThrowsOn?: (m: any) => boolean } = {}) {
	const posted: any[] = [];
	const warnings: string[] = [];
	const timers = { set: [] as any[], cleared: [] as any[] };
	const figma = {
		root: { name: "Test File" },
		fileKey: "file-1",
		ui: {
			postMessage: (m: any) => {
				if (opts.postMessageThrowsOn?.(m)) throw new Error("Cannot serialize value");
				posted.push(m);
			},
		},
	};
	const fakeSetTimeout = (fn: () => void, ms: number) => {
		const id = setTimeout(fn, ms);
		timers.set.push(id);
		return id;
	};
	const fakeClearTimeout = (id: any) => {
		timers.cleared.push(id);
		clearTimeout(id);
	};
	const fakeConsole = {
		log: () => {},
		info: () => {},
		debug: () => {},
		error: () => {},
		warn: (...args: any[]) => warnings.push(args.join(" ")),
	};
	// Not strict: code.js runs the script with a direct eval, as in the plugin.
	const run = new Function(
		"figma",
		"msg",
		"setTimeout",
		"clearTimeout",
		"console",
		`${extractFunction(codeJs, "reportLateExecuteResult")}\nreturn (async () => { ${extractExecuteCodeHandler()} })();`,
	);
	return {
		posted,
		warnings,
		timers,
		execute: (msg: Record<string, unknown>) =>
			run(figma, { type: "EXECUTE_CODE", requestId: "execute_code_1_1", ...msg }, fakeSetTimeout, fakeClearTimeout, fakeConsole),
	};
}

describe("code.js EXECUTE_CODE — results that arrive after the timeout", () => {
	it("still reports an in-time result exactly as before", async () => {
		const h = makeHarness();
		await h.execute({ code: "return { ok: true };", timeout: 1000, executionId: "ws_1_1" });

		expect(h.posted).toHaveLength(1);
		expect(h.posted[0]).toMatchObject({
			type: "EXECUTE_CODE_RESULT",
			requestId: "execute_code_1_1",
			success: true,
			result: { ok: true },
			fileContext: { fileName: "Test File", fileKey: "file-1" },
		});
	});

	it("clears the timeout timer when the code finishes first", async () => {
		const h = makeHarness();
		await h.execute({ code: "return 1;", timeout: 1000, executionId: "ws_1_1" });

		expect(h.timers.set).toHaveLength(1);
		expect(h.timers.cleared.includes(h.timers.set[0])).toBe(true);
	});

	it("reports the outcome of a script that finishes after its timeout", async () => {
		const h = makeHarness();
		await h.execute({
			code: "await new Promise(function (r) { setTimeout(r, 80); }); return { done: true };",
			timeout: 20,
			executionId: "ws_7_123",
		});

		// The timeout is reported first, naming the run, and flagged as a timeout.
		expect(h.posted).toHaveLength(1);
		expect(h.posted[0]).toMatchObject({ type: "EXECUTE_CODE_RESULT", success: false, timedOut: true, executionId: "ws_7_123" });
		expect(h.posted[0].error).toContain("Execution timed out after 20ms (executionId ws_7_123)");
		expect(h.posted[0].error).toContain("was not stopped");

		await sleep(150);

		expect(h.posted).toHaveLength(2);
		const late = h.posted[1];
		expect(late).toMatchObject({
			type: "EXECUTE_CODE_LATE_RESULT",
			executionId: "ws_7_123",
			success: true,
			result: { done: true },
			timeoutMs: 20,
			fileContext: { fileName: "Test File", fileKey: "file-1" },
		});
		expect(late.durationMs).toBeGreaterThanOrEqual(60);
		// Also visible through figma_get_console_logs.
		expect(h.warnings.some((w) => w.includes("Late EXECUTE_CODE result") && w.includes("ws_7_123"))).toBe(true);
	});

	it("reports a script that fails after its timeout", async () => {
		const h = makeHarness();
		await h.execute({
			code: "await new Promise(function (r) { setTimeout(r, 60); }); throw new TypeError('boom');",
			timeout: 20,
			executionId: "ws_8_1",
		});
		await sleep(130);

		expect(h.posted.map((m) => m.type)).toEqual(["EXECUTE_CODE_RESULT", "EXECUTE_CODE_LATE_RESULT"]);
		expect(h.posted[1]).toMatchObject({ executionId: "ws_8_1", success: false, error: "TypeError: boom" });
	});

	it("falls back to the plugin request id when ui.html sends no executionId", async () => {
		const h = makeHarness();
		await h.execute({ code: "await new Promise(function (r) { setTimeout(r, 50); }); return 1;", timeout: 10 });
		await sleep(110);

		expect(h.posted[1]).toMatchObject({ type: "EXECUTE_CODE_LATE_RESULT", executionId: "execute_code_1_1", result: 1 });
	});

	it("says so when the late value can't be posted", async () => {
		const h = makeHarness({ postMessageThrowsOn: (m) => m.type === "EXECUTE_CODE_LATE_RESULT" && m.success === true });
		await h.execute({ code: "await new Promise(function (r) { setTimeout(r, 50); }); return 1;", timeout: 10, executionId: "ws_9_1" });
		await sleep(110);

		expect(h.posted[1]).toMatchObject({ type: "EXECUTE_CODE_LATE_RESULT", executionId: "ws_9_1", success: false });
		expect(h.posted[1].error).toContain("Late result could not be sent");
	});

	it("clears the timer after a syntax error, so it doesn't reject later with nobody listening", async () => {
		const h = makeHarness();
		await h.execute({ code: "return {", timeout: 20, executionId: "ws_11_1" });
		await sleep(50);

		expect(h.posted).toHaveLength(1);
		expect(h.posted[0]).toMatchObject({ type: "EXECUTE_CODE_RESULT", success: false });
		expect(h.posted[0].error).toContain("Syntax error");
		expect(h.timers.cleared.includes(h.timers.set[0])).toBe(true);
	});

	it("does not report a late result for code that failed before the timeout", async () => {
		const h = makeHarness();
		await h.execute({ code: "throw new Error('early');", timeout: 50, executionId: "ws_10_1" });
		await sleep(80);

		expect(h.posted).toHaveLength(1);
		expect(h.posted[0]).toMatchObject({ success: false, timedOut: false, error: "Error: early" });
	});
});

// ============================================================================
// ui.html — late results go back only to the server that sent the request
// ============================================================================

function makeRelay() {
	const warnings: string[] = [];
	const source = ["rememberExecutionSocket", "settleExecutionSocket", "forwardLateExecuteResult", "relayExecuteResultIfLate"]
		.map((name) => {
			const fn = extractFunction(uiHtml, name);
			if (!fn) throw new Error(`${name} not found in ui.html`);
			return fn;
		})
		.join("\n");
	const api = new Function(
		"console",
		`var executionSockets = new Map(); var EXECUTION_SOCKETS_LIMIT = 50;
		${source}
		return { rememberExecutionSocket, settleExecutionSocket, forwardLateExecuteResult, relayExecuteResultIfLate, executionSockets };`,
	)({ warn: (...args: any[]) => warnings.push(args.join(" ")) });
	return { ...api, warnings };
}

function fakeSocket(readyState = 1) {
	const sent: any[] = [];
	return { readyState, sent, send: (json: string) => sent.push(JSON.parse(json)) };
}

describe("ui.html relay of late EXECUTE_CODE results", () => {
	const lateMsg = { type: "EXECUTE_CODE_LATE_RESULT", executionId: "ws_5_1", success: true, result: { done: true }, durationMs: 900, timeoutMs: 500 };

	it("sends a late result only to the socket that sent the request", () => {
		const r = makeRelay();
		const origin = fakeSocket();
		const other = fakeSocket();
		r.rememberExecutionSocket("ws_5_1", origin);
		r.rememberExecutionSocket("ws_6_1", other);
		r.settleExecutionSocket("ws_5_1", { success: false, timedOut: true });

		r.forwardLateExecuteResult(lateMsg);

		expect(origin.sent).toEqual([
			{ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: "ws_5_1", success: true, result: { done: true }, durationMs: 900, timeoutMs: 500 } },
		]);
		expect(other.sent).toEqual([]);
		expect(r.executionSockets.has("ws_5_1")).toBe(false);
	});

	it("stops tracking a request once it has a final (non-timeout) response", () => {
		const r = makeRelay();
		r.rememberExecutionSocket("ws_5_1", fakeSocket());
		r.settleExecutionSocket("ws_5_1", { success: true, result: 1 });
		expect(r.executionSockets.has("ws_5_1")).toBe(false);

		r.forwardLateExecuteResult(lateMsg);
		expect(r.warnings.some((w) => w.includes("Dropping late EXECUTE_CODE result") && w.includes("ws_5_1"))).toBe(true);
	});

	it("drops, with a warning, a late result whose server has disconnected", () => {
		const r = makeRelay();
		const closed = fakeSocket(3);
		r.rememberExecutionSocket("ws_5_1", closed);
		r.forwardLateExecuteResult(lateMsg);
		expect(closed.sent).toEqual([]);
		expect(r.warnings).toHaveLength(1);
	});

	it("caps how many requests it remembers", () => {
		const r = makeRelay();
		for (let i = 0; i < 60; i++) r.rememberExecutionSocket(`ws_${i}_1`, fakeSocket());
		expect(r.executionSockets.size).toBe(50);
		expect(r.executionSockets.has("ws_0_1")).toBe(false);
		expect(r.executionSockets.has("ws_59_1")).toBe(true);
	});

	describe("an EXECUTE_CODE_RESULT from the plugin", () => {
		it("is left to the normal handler while its request is pending", () => {
			const r = makeRelay();
			const socket = fakeSocket();
			r.rememberExecutionSocket("ws_5_1", socket);
			const handled = r.relayExecuteResultIfLate({ requestId: "execute_code_1_1", executionId: "ws_5_1", success: true, result: 1 }, new Map([["execute_code_1_1", {}]]));
			expect(handled).toBe(false);
			expect(socket.sent).toEqual([]);
		});

		it("is forwarded as a late result when this hop already timed out", () => {
			const r = makeRelay();
			const socket = fakeSocket();
			r.rememberExecutionSocket("ws_5_1", socket);
			r.settleExecutionSocket("ws_5_1", { success: false, timedOut: true });
			const handled = r.relayExecuteResultIfLate({ requestId: "execute_code_1_1", executionId: "ws_5_1", success: true, result: 1 }, new Map());
			expect(handled).toBe(true);
			expect(socket.sent).toEqual([{ type: "EXECUTE_CODE_LATE_RESULT", data: expect.objectContaining({ executionId: "ws_5_1", success: true, result: 1 }) }]);
		});

		it("is not forwarded when it is only the plugin's own timeout report", () => {
			const r = makeRelay();
			const socket = fakeSocket();
			r.rememberExecutionSocket("ws_5_1", socket);
			const handled = r.relayExecuteResultIfLate({ requestId: "execute_code_1_1", executionId: "ws_5_1", success: false, timedOut: true, error: "timed out" }, new Map());
			expect(handled).toBe(true);
			expect(socket.sent).toEqual([]);
			// Still tracked: the real outcome follows as EXECUTE_CODE_LATE_RESULT.
			expect(r.executionSockets.has("ws_5_1")).toBe(true);
		});
	});

	it("is wired into the WebSocket dispatch and the plugin message handler", () => {
		expect(uiHtml).toMatch(/if \(isExecute\) rememberExecutionSocket\(message\.id, activeWs\);/);
		expect(uiHtml).toMatch(/if \(isExecute\) settleExecutionSocket\(message\.id, result\);/);
		expect(uiHtml).toMatch(/handler\(message\.params \|\| \{\}, message\.id\)/);
		expect(uiHtml).toMatch(/'EXECUTE_CODE': function\(params, requestId\) \{ return window\.executeCode\(params\.code, params\.timeout, requestId\); \}/);
		expect(uiHtml).toMatch(/if \(relayExecuteResultIfLate\(msg, window\.__figmaPendingRequests\)\) break;/);
		const lateCase = uiHtml.slice(uiHtml.indexOf("case 'EXECUTE_CODE_LATE_RESULT':"));
		expect(lateCase.slice(0, lateCase.indexOf("break;"))).toContain("forwardLateExecuteResult(msg)");
	});

	it("marks its own timeout so the server knows a late result may follow", () => {
		expect(uiHtml).toMatch(/timeoutError\.timedOut = true;/);
		expect(uiHtml).toMatch(/timedOut: err\.timedOut === true/);
		expect(uiHtml).toMatch(/if \(msg\.timedOut\) failure\.timedOut = true;/);
	});
});
