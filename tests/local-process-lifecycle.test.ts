import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { registerLocalProcessLifecycle } from "../src/core/local-process-lifecycle.js";
import { getPortFilePath } from "../src/core/port-discovery.js";

const flushPromises = () =>
	new Promise<void>((resolve) => setImmediate(resolve));

describe("local process lifecycle", () => {
	for (const terminalEvent of ["SIGINT", "SIGTERM", "end", "close"] as const) {
		it(`shuts down and exits on ${terminalEvent}`, async () => {
			const stdin = new EventEmitter();
			const processEvents = new EventEmitter();
			const shutdown = jest.fn().mockResolvedValue(undefined);
			const exit = jest.fn();

			registerLocalProcessLifecycle({ shutdown, stdin, processEvents, exit });
			(terminalEvent === "end" || terminalEvent === "close"
				? stdin
				: processEvents
			).emit(terminalEvent);
			await flushPromises();

			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(exit).toHaveBeenCalledTimes(1);
			expect(exit).toHaveBeenCalledWith(0);
		});
	}

	it("coalesces repeated terminal events into one shutdown", async () => {
		const stdin = new EventEmitter();
		const processEvents = new EventEmitter();
		const shutdown = jest.fn().mockResolvedValue(undefined);
		const exit = jest.fn();

		registerLocalProcessLifecycle({ shutdown, stdin, processEvents, exit });
		stdin.emit("end");
		stdin.emit("close");
		processEvents.emit("SIGTERM");
		await flushPromises();

		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it("reports shutdown errors and still exits", async () => {
		const stdin = new EventEmitter();
		const processEvents = new EventEmitter();
		const error = new Error("shutdown failed");
		const onShutdownError = jest.fn();
		const exit = jest.fn();

		registerLocalProcessLifecycle({
			shutdown: jest.fn().mockRejectedValue(error),
			stdin,
			processEvents,
			exit,
			onShutdownError,
		});
		stdin.emit("end");
		await flushPromises();

		expect(onShutdownError).toHaveBeenCalledWith(error);
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("forces exit when shutdown exceeds the deadline", async () => {
		jest.useFakeTimers();
		try {
			const stdin = new EventEmitter();
			const processEvents = new EventEmitter();
			const exit = jest.fn();
			const onShutdownTimeout = jest.fn();

			registerLocalProcessLifecycle({
				shutdown: () => new Promise<void>(() => undefined),
				stdin,
				processEvents,
				exit,
				shutdownTimeoutMs: 25,
				onShutdownTimeout,
			});
			stdin.emit("close");
			jest.advanceTimersByTime(25);

			expect(onShutdownTimeout).toHaveBeenCalledWith(25);
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			jest.useRealTimers();
		}
	});
});

const repoRoot = process.cwd();

async function reservePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Failed to reserve a TCP port"));
				return;
			}
			const port = address.port;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function waitForExit(
	child: ChildProcess,
	timeoutMs: number,
): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Child did not exit within ${timeoutMs}ms`)),
			timeoutMs,
		);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

describe("local server stdin EOF integration", () => {
	jest.setTimeout(30_000);

	it("exits and releases its advertised port when stdin closes", async () => {
		const port = await reservePort();
		const portFile = getPortFilePath(port);
		const tsxCli = require.resolve("tsx/cli");
		let child: ChildProcess | undefined;
		let stderr = "";

		try {
			child = spawn(
				process.execPath,
				[tsxCli, join(repoRoot, "src", "local.ts")],
				{
					cwd: repoRoot,
					env: { ...process.env, FIGMA_WS_PORT: String(port) },
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});

			await waitFor(() => existsSync(portFile), 15_000);
			child.stdin?.end();

			const exitCode = await waitForExit(child, 7_000);
			expect(exitCode).toBe(0);
			expect(existsSync(portFile)).toBe(false);

			await new Promise<void>((resolve, reject) => {
				const probe = createServer();
				probe.once("error", reject);
				probe.listen(port, "127.0.0.1", () =>
					probe.close((error) => (error ? reject(error) : resolve())),
				);
			});
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\nChild stderr:\n${stderr}`,
			);
		} finally {
			if (child && child.exitCode === null) child.kill("SIGKILL");
			try {
				if (existsSync(portFile)) unlinkSync(portFile);
			} catch {
				/* best-effort */
			}
		}
	});
});
