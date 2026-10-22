/**
 * onStdinClosed Tests
 *
 * The server must exit when its MCP client closes stdin. On Windows no
 * SIGINT/SIGTERM reaches the server when the client exits, so stdin EOF is the
 * only signal — without it orphaned servers keep their ports forever (#116).
 */

import { PassThrough } from "stream";
import { onStdinClosed } from "../src/core/stdin-lifecycle";

describe("onStdinClosed", () => {
	it("calls back when stdin reaches EOF", async () => {
		const stdin = new PassThrough();
		const onClosed = jest.fn();
		onStdinClosed(onClosed, stdin);

		stdin.resume(); // the SDK's 'data' listener keeps stdin flowing in the real server
		stdin.end();
		await new Promise((resolve) => setImmediate(resolve));

		expect(onClosed).toHaveBeenCalled();
	});

	it("calls back when stdin is closed without EOF", async () => {
		const stdin = new PassThrough();
		const onClosed = jest.fn();
		onStdinClosed(onClosed, stdin);

		stdin.destroy();
		await new Promise((resolve) => setImmediate(resolve));

		expect(onClosed).toHaveBeenCalledTimes(1);
	});

	it("calls back only once when both 'end' and 'close' fire", async () => {
		const stdin = new PassThrough();
		const onClosed = jest.fn();
		onStdinClosed(onClosed, stdin);

		stdin.resume();
		stdin.end();
		await new Promise((resolve) => setImmediate(resolve));
		stdin.destroy();
		await new Promise((resolve) => setImmediate(resolve));

		expect(onClosed).toHaveBeenCalledTimes(1);
	});

	it("does not call back while stdin stays open", async () => {
		const stdin = new PassThrough();
		const onClosed = jest.fn();
		onStdinClosed(onClosed, stdin);

		stdin.resume();
		stdin.write('{"jsonrpc":"2.0","method":"ping","id":1}\n');
		await new Promise((resolve) => setImmediate(resolve));

		expect(onClosed).not.toHaveBeenCalled();
		stdin.destroy();
	});
});
