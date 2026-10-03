/**
 * Process lifecycle wiring for the local stdio MCP server.
 *
 * MCP clients communicate with the server through stdin/stdout. Closing that
 * transport produces stdin EOF, but does not necessarily send an OS signal.
 * Treat both stdin terminal events as normal shutdown requests so the
 * WebSocket bridge and its advertised port are released promptly.
 */

interface EventSource {
	on(event: string, listener: () => void): unknown;
}

interface UnrefableTimer {
	unref?: () => void;
}

export interface LocalProcessLifecycleOptions {
	shutdown: () => Promise<void>;
	stdin?: EventSource;
	processEvents?: EventSource;
	exit?: (code: number) => void;
	shutdownTimeoutMs?: number;
	onShutdownTimeout?: (timeoutMs: number) => void;
	onShutdownError?: (error: unknown) => void;
}

/**
 * Register all terminal conditions for the local MCP process.
 *
 * The returned function lets tests and callers initiate the same idempotent
 * shutdown path directly.
 */
export function registerLocalProcessLifecycle(
	options: LocalProcessLifecycleOptions,
): (code?: number) => Promise<void> {
	const {
		shutdown,
		stdin = process.stdin,
		processEvents = process,
		exit = (code) => process.exit(code),
		shutdownTimeoutMs = 5000,
		onShutdownTimeout,
		onShutdownError,
	} = options;

	let shuttingDown = false;

	const gracefulExit = async (code = 0): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;

		const backstop = setTimeout(() => {
			onShutdownTimeout?.(shutdownTimeoutMs);
			exit(code);
		}, shutdownTimeoutMs);
		(backstop as unknown as UnrefableTimer).unref?.();

		try {
			await shutdown();
		} catch (error) {
			onShutdownError?.(error);
		}

		clearTimeout(backstop);
		exit(code);
	};

	const requestNormalExit = () => {
		void gracefulExit(0);
	};

	processEvents.on("SIGINT", requestNormalExit);
	processEvents.on("SIGTERM", requestNormalExit);
	stdin.on("end", requestNormalExit);
	stdin.on("close", requestNormalExit);

	return gracefulExit;
}
