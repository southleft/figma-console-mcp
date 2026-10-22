/**
 * Logger Tests
 *
 * In MCP stdio mode the stderr destination must be synchronous. With
 * sync: false pino flushes leftover lines on exit, and when the MCP client is
 * gone that flush retries EPIPE forever (sonic-boom 4.x) — the process never
 * exits (#116).
 */

import pino from "pino";
import { createLogger } from "../src/core/logger";

describe("createLogger in MCP stdio mode", () => {
	const originalIsTTY = process.stdout.isTTY;
	afterEach(() => {
		process.stdout.isTTY = originalIsTTY;
	});

	it("writes to stderr synchronously", () => {
		process.stdout.isTTY = false as unknown as true;
		const stream = createLogger()[pino.symbols.streamSym] as unknown as { fd: number; sync: boolean };

		expect(stream.fd).toBe(2);
		expect(stream.sync).toBe(true);
	});
});
