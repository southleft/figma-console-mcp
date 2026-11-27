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

import { z } from "zod";

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

	const r = result as {
		content: Array<{ type: string; text?: string; [k: string]: unknown }>;
		[k: string]: unknown;
	};

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
 * Largest tool result this server will hand to the client, in bytes of content.
 *
 * MCP clients read one JSON-RPC message at a time and defend themselves against
 * runaway output: Claude Code disconnects the server outright once a single
 * message passes 16 MB ("wrote >16MB to stdout without a JSON-RPC message
 * boundary … Disconnecting"). The user sees only "Connection closed" and loses
 * every tool for the rest of the session. 8 MB leaves room for JSON-RPC string
 * escaping, which inflates nested JSON noticeably.
 */
export const MAX_TOOL_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Replace an oversized tool result with an actionable error. Returning it would
 * not deliver the data anyway — it would kill the connection.
 */
export function capToolResponse(
	result: unknown,
	maxBytes: number = MAX_TOOL_RESPONSE_BYTES,
): unknown {
	if (
		!result ||
		typeof result !== "object" ||
		!Array.isArray((result as { content?: unknown[] }).content)
	) {
		return result;
	}
	let bytes = 0;
	for (const item of (result as { content: Array<Record<string, unknown>> })
		.content) {
		if (typeof item?.text === "string")
			bytes += Buffer.byteLength(item.text, "utf8");
		if (typeof item?.data === "string") bytes += item.data.length; // base64 image/audio
	}
	if (bytes <= maxBytes) return result;

	const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					_mcp: MCP_NAME,
					error: `${ERROR_PREFIX} This call produced a ${mb(bytes)} MB result, above the ${mb(maxBytes)} MB this server will return. It was withheld because MCP clients disconnect on oversized messages (Claude Code closes the connection above 16 MB), which would have ended this session instead of delivering the data.`,
					resultBytes: bytes,
					note: "Only the RESPONSE was withheld. If this call made changes in Figma, those changes still happened.",
					hint: "Ask for less in one call: return counts or a summary instead of full node data, target fewer nodes, use a smaller depth, or page through the data across several calls.",
				}),
			},
		],
		isError: true,
	};
}

/**
 * Apply what identifyToolHandler applies to a result (`_mcp` tag + size cap)
 * outside a handler — e.g. a task's final result delivered by tasks/get.
 * Idempotent; results without a content array (a task handle, an
 * input-required round) pass through unchanged.
 */
export function stampToolResult(result: unknown): unknown {
	return capToolResponse(tagToolResponse(result));
}

export interface ToolIdentityOptions {
	/** Runs at the start of every tool call (local mode uses it for activity tracking). */
	onToolCall?: () => void;
}

type ToolHandler = (...args: unknown[]) => unknown;
const IDENTIFIED = Symbol.for("figma-console-mcp.identifiedToolHandler");

/**
 * Wrap one tool callback so its result is tagged with `_mcp`, capped at
 * MAX_TOOL_RESPONSE_BYTES, and any Error it throws carries the
 * `[figma-console-mcp]` prefix. The SDK turns a thrown error into an
 * `isError` result whose text is the message, so the prefix reaches the
 * client on both SDK versions. Idempotent: wrapping twice is a no-op.
 */
export function identifyToolHandler<F extends ToolHandler>(
	handler: F,
	options: ToolIdentityOptions = {},
): F {
	if ((handler as unknown as Record<symbol, unknown>)[IDENTIFIED]) return handler;
	const wrapped = async (...args: unknown[]): Promise<unknown> => {
		options.onToolCall?.();
		try {
			const result = await handler(...args);
			return capToolResponse(tagToolResponse(result));
		} catch (err) {
			if (err instanceof Error && !err.message.startsWith(ERROR_PREFIX)) {
				err.message = `${ERROR_PREFIX} ${err.message}`;
			}
			throw err;
		}
	};
	Object.defineProperty(wrapped, IDENTIFIED, { value: true });
	return wrapped as unknown as F;
}

/**
 * Subclass an McpServer class so every tool registered on it goes through
 * identifyToolHandler, and its schemas drop `propertyNames: {type:"string"}`
 * (see quietStringRecordKeys) — without modifying the ~100 tool handlers.
 *
 * Works on both SDKs because it relies only on their public registration
 * methods: the callback is always the last argument. v2 McpServer has only
 * `registerTool`; v1 (Cloudflare, agents' McpAgent) also has `tool`, which
 * does NOT route through `registerTool`, so both are overridden when present.
 * Nothing else on the server is touched: the low-level request handlers, the
 * skills extension, resources and ext-apps registration all see a stock
 * McpServer.
 *
 *   const IdentifiedMcpServer = withToolIdentity(McpServer);
 *   const server = new IdentifiedMcpServer({ name, version });
 *
 * Adds attribution coverage to every response path uniformly — see
 * project_lauren_cross_mcp_confusion for why this matters.
 */
export function withToolIdentity<T extends abstract new (...args: any[]) => object>(
	Base: T,
	options: ToolIdentityOptions = {},
): T {
	abstract class IdentifiedServer extends Base {}
	const baseProto = Base.prototype as Record<string, unknown>;
	for (const method of ["registerTool", "tool"]) {
		const original = baseProto[method];
		if (typeof original !== "function") continue;
		Object.defineProperty(IdentifiedServer.prototype, method, {
			configurable: true,
			writable: true,
			value: function (this: object, ...args: unknown[]): unknown {
				return (original as ToolHandler).apply(
					this,
					prepareToolRegistration(args, options),
				);
			},
		});
	}
	return IdentifiedServer as unknown as T;
}

/** Apply identity to the callback and quiet record keys in the schemas of one registration call. */
function prepareToolRegistration(
	args: unknown[],
	options: ToolIdentityOptions,
): unknown[] {
	if (args.length === 0 || typeof args[args.length - 1] !== "function") return args;
	const seen = new WeakSet<object>();
	for (const arg of args.slice(1, -1)) quietStringRecordKeys(arg, seen);
	return [
		...args.slice(0, -1),
		identifyToolHandler(args[args.length - 1] as ToolHandler, options),
	];
}

interface ZodLike {
	_zod: { def: Record<string, unknown> };
}

function isZodSchema(value: unknown): value is ZodLike {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { _zod?: { def?: unknown } })._zod?.def === "object"
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** A bare z.string() key: converts to exactly `propertyNames: {type:"string"}`. */
function isBareStringKey(key: unknown): boolean {
	if (!isZodSchema(key)) return false;
	const def = key._zod.def;
	return (
		def.type === "string" &&
		def.format === undefined &&
		!(Array.isArray(def.checks) && def.checks.length > 0) &&
		!z.globalRegistry.has(key as unknown as z.ZodType)
	);
}

/**
 * zod 4 converts every z.record(z.string(), …) to JSON Schema with
 * `propertyNames: {type:"string"}`. It says nothing (JSON object keys are
 * always strings), and Gemini rejects the keyword with a 400, so tools/list
 * must not carry it.
 *
 * Both SDKs build tools/list JSON Schema with zod's own converter, and zod
 * merges registry metadata into each schema's output — so registering
 * `propertyNames: undefined` for a string-keyed record drops the keyword on
 * v1 (z.toJSONSchema) and v2 (`~standard.jsonSchema`) alike. Records whose
 * keys actually constrain (patterns, enums, formats) keep their propertyNames.
 *
 * Walks zod schemas and plain objects (raw shapes, registration configs);
 * anything else is ignored.
 */
export function quietStringRecordKeys(
	value: unknown,
	seen: WeakSet<object> = new WeakSet(),
): void {
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) quietStringRecordKeys(item, seen);
		return;
	}
	if (isZodSchema(value)) {
		const def = value._zod.def;
		if (def.type === "record" && isBareStringKey(def.keyType)) {
			const schema = value as unknown as z.ZodType;
			z.globalRegistry.add(schema, {
				...(z.globalRegistry.get(schema) ?? {}),
				propertyNames: undefined,
			});
		}
		for (const child of Object.values(def)) quietStringRecordKeys(child, seen);
		return;
	}
	if (isPlainObject(value)) {
		for (const child of Object.values(value)) quietStringRecordKeys(child, seen);
	}
}
