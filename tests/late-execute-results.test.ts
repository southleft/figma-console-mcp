/**
 * Late EXECUTE_CODE results on the server.
 *
 * A timed-out figma_execute script keeps running in the plugin. Its outcome
 * reaches the server in one of two ways, and both used to be lost:
 *  - the plugin's EXECUTE_CODE_LATE_RESULT event (after the plugin itself
 *    reported the timeout), which the server had no handler for;
 *  - a response to a request whose server-side timer had already fired, which
 *    fell through to "Unhandled WebSocket message" at debug level.
 * The server now keeps these, for figma_execute requests only (sent with
 * trackLateResult), until drainLateExecuteResults() hands them out.
 */

import { WebSocket } from "ws";
import { FigmaWebSocketServer, MAX_LATE_RESULT_BYTES } from "../src/core/websocket-server";
import { WebSocketConnector } from "../src/core/websocket-connector";

jest.setTimeout(10000);

const TEST_PORT = 19241;

function connectClient(server: FigmaWebSocketServer, fileKey = "file-a"): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const identified = new Promise<void>((res) => server.once("fileConnected", () => res()));
		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		ws.on("error", reject);
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "FILE_INFO", data: { fileKey, fileName: `File ${fileKey}`, currentPage: "Page 1" } }));
			identified.then(() => resolve(ws));
		});
	});
}

/** Resolve with the next command the server sends to this client. */
function nextCommand(ws: WebSocket): Promise<{ id: string; method: string; params: any }> {
	return new Promise((resolve) => {
		const onMessage = (raw: any) => {
			const msg = JSON.parse(raw.toString());
			if (msg.id && msg.method) {
				ws.off("message", onMessage);
				resolve(msg);
			}
		};
		ws.on("message", onMessage);
	});
}

const lateResult = (server: FigmaWebSocketServer) =>
	new Promise<any>((resolve) => server.once("lateExecuteResult", resolve));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PLUGIN_TIMEOUT = { success: false, timedOut: true, error: "Error: Execution timed out after 50ms (executionId x). The script was not stopped and may still finish." };
const TRACK = { trackLateResult: true };

describe("FigmaWebSocketServer late EXECUTE_CODE results", () => {
	let server: FigmaWebSocketServer;
	let clients: WebSocket[] = [];

	beforeEach(async () => {
		server = new FigmaWebSocketServer({ port: TEST_PORT });
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
		for (const c of clients) c.close();
		clients = [];
	});

	async function connect(fileKey = "file-a") {
		const ws = await connectClient(server, fileKey);
		clients.push(ws);
		return ws;
	}

	it("keeps the plugin's late result for a request that timed out in the plugin", async () => {
		const ws = await connect();
		const command = nextCommand(ws);
		const pending = server.sendCommand("EXECUTE_CODE", { code: "const frames = [];\n  // long script\n  return frames;", timeout: 50 }, 2000, undefined, TRACK);
		const { id, method } = await command;
		expect(method).toBe("EXECUTE_CODE");

		ws.send(JSON.stringify({ id, result: PLUGIN_TIMEOUT }));
		await expect(pending).resolves.toEqual(PLUGIN_TIMEOUT);
		expect(server.drainLateExecuteResults()).toEqual([]);

		const received = lateResult(server);
		ws.send(JSON.stringify({ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: id, success: true, result: { done: true }, durationMs: 180, timeoutMs: 50 } }));
		await received;

		const late = server.drainLateExecuteResults();
		expect(late).toHaveLength(1);
		expect(late[0]).toMatchObject({
			executionId: id,
			fileKey: "file-a",
			codePreview: "const frames = []; // long script return frames;",
			success: true,
			result: { done: true },
			durationMs: 180,
			timeoutMs: 50,
		});
		// Drained: handed out once.
		expect(server.drainLateExecuteResults()).toEqual([]);
	});

	it("keeps a response that arrives after the server's own timeout instead of dropping it", async () => {
		const ws = await connect();
		const command = nextCommand(ws);
		const pending = server.sendCommand("EXECUTE_CODE", { code: "return 42;", timeout: 10 }, 50, undefined, TRACK);
		const { id } = await command;
		await expect(pending).rejects.toThrow("timed out after 50ms");

		const received = lateResult(server);
		ws.send(JSON.stringify({ id, result: { success: true, result: 42 } }));
		await received;

		expect(server.drainLateExecuteResults()).toEqual([expect.objectContaining({ executionId: id, success: true, result: 42 })]);
	});

	it("waits for the real outcome when the late response is only another hop's timeout report", async () => {
		const ws = await connect();
		const command = nextCommand(ws);
		const pending = server.sendCommand("EXECUTE_CODE", { code: "return 1;", timeout: 10 }, 50, undefined, TRACK);
		const { id } = await command;
		await expect(pending).rejects.toThrow("timed out");

		// ui.html's own timer fired too — no outcome in this one.
		ws.send(JSON.stringify({ id, result: { success: false, error: "EXECUTE_CODE request timed out after 2010ms" } }));
		await sleep(50);
		expect(server.drainLateExecuteResults()).toEqual([]);

		const received = lateResult(server);
		ws.send(JSON.stringify({ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: id, success: false, error: "TypeError: boom" } }));
		await received;
		expect(server.drainLateExecuteResults()).toEqual([expect.objectContaining({ executionId: id, success: false, error: "TypeError: boom" })]);
	});

	it("ignores late results for request ids it does not know (another server's, or long gone)", async () => {
		const ws = await connect();
		ws.send(JSON.stringify({ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: "ws_999_1", success: true, result: 1 } }));
		await sleep(50);
		expect(server.drainLateExecuteResults()).toEqual([]);
	});

	it("ignores a late result for a request that already completed normally", async () => {
		const ws = await connect();
		const command = nextCommand(ws);
		const pending = server.sendCommand("EXECUTE_CODE", { code: "return 1;", timeout: 1000 }, 2000, undefined, TRACK);
		const { id } = await command;
		ws.send(JSON.stringify({ id, result: { success: true, result: 1 } }));
		await pending;

		ws.send(JSON.stringify({ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: id, success: true, result: 2 } }));
		await sleep(50);
		expect(server.drainLateExecuteResults()).toEqual([]);
	});

	it("only accepts a late result from the file the request targeted", async () => {
		const wsA = await connect("file-a");
		const wsB = await connect("file-b");
		const command = nextCommand(wsA);
		const pending = server.sendCommand("EXECUTE_CODE", { code: "return 1;", timeout: 50 }, 2000, "file-a", TRACK);
		const { id } = await command;
		wsA.send(JSON.stringify({ id, result: PLUGIN_TIMEOUT }));
		await pending;

		wsB.send(JSON.stringify({ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: id, success: true, result: "spoofed" } }));
		await sleep(50);
		expect(server.drainLateExecuteResults()).toEqual([]);

		const received = lateResult(server);
		wsA.send(JSON.stringify({ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: id, success: true, result: "real" } }));
		await received;
		expect(server.drainLateExecuteResults()).toEqual([expect.objectContaining({ fileKey: "file-a", result: "real" })]);
	});

	it("drops an oversized value but keeps the outcome", async () => {
		const ws = await connect();
		const command = nextCommand(ws);
		const pending = server.sendCommand("EXECUTE_CODE", { code: "return big;", timeout: 50 }, 2000, undefined, TRACK);
		const { id } = await command;
		ws.send(JSON.stringify({ id, result: PLUGIN_TIMEOUT }));
		await pending;

		const received = lateResult(server);
		ws.send(JSON.stringify({ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: id, success: true, result: "x".repeat(MAX_LATE_RESULT_BYTES + 1) } }));
		await received;

		const [late] = server.drainLateExecuteResults();
		expect(late.success).toBe(true);
		expect(late.result).toBeUndefined();
		expect(late.resultOmitted).toContain("was not kept");
	});

	it("keeps at most the 10 most recent late results", async () => {
		const ws = await connect();
		const ids: string[] = [];
		for (let i = 0; i < 12; i++) {
			const command = nextCommand(ws);
			const pending = server.sendCommand("EXECUTE_CODE", { code: `return ${i};`, timeout: 50 }, 2000, undefined, TRACK);
			const { id } = await command;
			ws.send(JSON.stringify({ id, result: PLUGIN_TIMEOUT }));
			await pending;
			ids.push(id);
		}
		for (let i = 0; i < ids.length; i++) {
			const received = lateResult(server);
			ws.send(JSON.stringify({ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: ids[i], success: true, result: i } }));
			await received;
		}

		const late = server.drainLateExecuteResults();
		expect(late).toHaveLength(10);
		expect(late[0].result).toBe(2);
		expect(late[9].result).toBe(11);
	});

	it("ignores late results for requests not sent with trackLateResult (internal callers)", async () => {
		const ws = await connect();
		const command = nextCommand(ws);
		const pending = server.sendCommand("EXECUTE_CODE", { code: "return 1;", timeout: 10 }, 50);
		const { id } = await command;
		await expect(pending).rejects.toThrow(/^WebSocket command EXECUTE_CODE timed out after 50ms$/);

		ws.send(JSON.stringify({ id, result: { success: true, result: 1 } }));
		ws.send(JSON.stringify({ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: id, success: true, result: 2 } }));
		await sleep(50);
		expect(server.drainLateExecuteResults()).toEqual([]);
	});

	it("names the run in its own timeout error when tracking it", async () => {
		const ws = await connect();
		const command = nextCommand(ws);
		const pending = server.sendCommand("EXECUTE_CODE", { code: "return 1;", timeout: 10 }, 50, undefined, TRACK);
		const { id } = await command;
		await expect(pending).rejects.toThrow(`WebSocket command EXECUTE_CODE timed out after 50ms (executionId ${id})`);
	});

	it("ignores a response after the server's timeout that arrives from another file's socket", async () => {
		const wsA = await connect("file-a");
		const wsB = await connect("file-b");
		const command = nextCommand(wsA);
		const pending = server.sendCommand("EXECUTE_CODE", { code: "return 1;", timeout: 10 }, 50, "file-a", TRACK);
		const { id } = await command;
		await expect(pending).rejects.toThrow("timed out");

		wsB.send(JSON.stringify({ id, result: { success: true, result: "spoofed" } }));
		await sleep(50);
		expect(server.drainLateExecuteResults()).toEqual([]);
	});

	it("recognises a plugin timeout report by its timedOut flag, whatever the message", async () => {
		const ws = await connect();
		const command = nextCommand(ws);
		const pending = server.sendCommand("EXECUTE_CODE", { code: "return 1;", timeout: 50 }, 2000, undefined, TRACK);
		const { id } = await command;
		ws.send(JSON.stringify({ id, result: { success: false, timedOut: true, error: "something else" } }));
		await pending;

		const received = lateResult(server);
		ws.send(JSON.stringify({ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: id, success: true, result: 1 } }));
		await received;
		expect(server.drainLateExecuteResults()).toHaveLength(1);
	});

	it("does not treat a user error that mentions a timeout as a timeout report", async () => {
		const ws = await connect();
		const command = nextCommand(ws);
		const pending = server.sendCommand("EXECUTE_CODE", { code: "return 1;", timeout: 1000 }, 2000, undefined, TRACK);
		const { id } = await command;
		ws.send(JSON.stringify({ id, result: { success: false, error: "Error: fetch timed out after 300ms" } }));
		await pending;

		ws.send(JSON.stringify({ type: "EXECUTE_CODE_LATE_RESULT", data: { executionId: id, success: true, result: 1 } }));
		await sleep(50);
		expect(server.drainLateExecuteResults()).toEqual([]);
	});
});

describe("WebSocketConnector.drainLateExecuteResults", () => {
	it("delegates to the server", () => {
		const late = [{ executionId: "ws_1_1" }];
		const connector = new WebSocketConnector({ drainLateExecuteResults: () => late } as any);
		expect(connector.drainLateExecuteResults()).toBe(late);
	});
});
