/**
 * Stdin Lifecycle
 *
 * EOF on stdin is the one "client went away" signal a stdio MCP server gets on
 * every platform. On Windows the client spawns the server through cmd.exe / npx
 * shims that don't forward termination, so SIGINT/SIGTERM never arrive and the
 * server outlives its client — still holding its WebSocket port and heartbeating
 * its port file (issue #116). The SDK's StdioServerTransport only listens for
 * 'data' and 'error', so it doesn't notice EOF either.
 */

/**
 * Call `onClosed` once when stdin ends (EOF) or is closed.
 * Both events usually fire for the same disconnect; the callback runs only once.
 */
export function onStdinClosed(
	onClosed: () => void,
	stdin: NodeJS.ReadableStream = process.stdin,
): void {
	let fired = false;
	const handler = () => {
		if (fired) return;
		fired = true;
		onClosed();
	};
	stdin.once("end", handler);
	stdin.once("close", handler);
}
