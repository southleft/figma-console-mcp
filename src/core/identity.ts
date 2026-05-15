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
