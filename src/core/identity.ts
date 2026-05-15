/**
 * Server identity helpers.
 *
 * When a user has multiple Figma-related MCP servers configured at once
 * (e.g. figma-console-mcp alongside Figma's native codegen MCP), an LLM can
 * conflate errors from one server with the troubleshooting copy of another —
 * producing remediation advice that points at the wrong tool. Tagging our
 * responses with an explicit `[figma-console-mcp]` prefix and an `_mcp`
 * field makes attribution unambiguous.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const MCP_NAME = "figma-console-mcp";

export const ERROR_PREFIX = `[${MCP_NAME}]`;

/**
 * Prefix a thrown-error message with our MCP identity so cross-tool errors
 * can't be mistakenly attributed to this server.
 */
export function identifiedError(message: string): Error {
	return new Error(`${ERROR_PREFIX} ${message}`);
}

/**
 * Tag a response payload with our MCP identity at the top level.
 * The `_mcp` field is read by LLMs alongside the rest of the response and
 * gives them a reliable signal for "which server produced this output".
 */
export function withIdentity<T extends Record<string, unknown>>(
	data: T,
): T & { _mcp: string } {
	return { _mcp: MCP_NAME, ...data };
}

/**
 * Tag every text/JSON content block in a tool response with our MCP identity.
 * Idempotent — already-tagged content (from adaptiveResponse or explicit
 * withIdentity calls) is left alone. Non-JSON text content is left alone.
 */
function tagToolResponse(result: unknown): unknown {
	if (
		!result ||
		typeof result !== "object" ||
		!("content" in result) ||
		!Array.isArray((result as { content: unknown[] }).content)
	) {
		return result;
	}

	const r = result as { content: Array<{ type: string; text?: string; [k: string]: unknown }>; [k: string]: unknown };

	const newContent = r.content.map((item) => {
		if (item.type !== "text" || typeof item.text !== "string") return item;

		try {
			const parsed = JSON.parse(item.text);
			if (
				parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				!("_mcp" in parsed)
			) {
				return { ...item, text: JSON.stringify({ _mcp: MCP_NAME, ...parsed }) };
			}
		} catch {
			// Not JSON — leave the text untouched (e.g. AI instruction blocks
			// emitted by adaptiveResponse, or plain-text error messages).
		}
		return item;
	});

	return { ...r, content: newContent };
}

/**
 * Monkey-patch an MCP server instance so every tool registered on it gets
 * identity tagging applied to its responses and an identity prefix on any
 * Error it throws — without modifying the ~97 individual tool handlers.
 *
 * Call this once, immediately after constructing the McpServer, BEFORE any
 * tool registration calls run. The wrap is idempotent at the response level
 * (tools that already tag themselves via withIdentity or adaptiveResponse
 * won't get double-tagged).
 *
 * Adds attribution coverage to every response path uniformly — see
 * project_lauren_cross_mcp_confusion for why this matters.
 */
export function wrapServerForIdentity(server: McpServer): void {
	// We have to bypass the McpServer.tool overload types because we're
	// composing over arbitrary call signatures. The runtime behavior is
	// the same regardless of which overload the caller invokes.
	type AnyTool = (...args: unknown[]) => unknown;
	const target = server as unknown as { tool: AnyTool };
	const originalTool = target.tool.bind(target);

	target.tool = function (...args: unknown[]): unknown {
		if (args.length === 0 || typeof args[args.length - 1] !== "function") {
			return originalTool(...args);
		}

		const handler = args[args.length - 1] as (...a: unknown[]) => unknown;

		const wrappedHandler = async (...handlerArgs: unknown[]): Promise<unknown> => {
			try {
				const result = await handler(...handlerArgs);
				return tagToolResponse(result);
			} catch (err) {
				if (err instanceof Error && !err.message.startsWith(ERROR_PREFIX)) {
					err.message = `${ERROR_PREFIX} ${err.message}`;
				}
				throw err;
			}
		};

		return originalTool(...args.slice(0, -1), wrappedHandler);
	};
}
