/**
 * Ask the user to confirm a destructive operation via MCP elicitation.
 *
 * Elicitation shows the PERSON a small form (Claude Code renders a dialog;
 * Claude desktop/claude.ai render forms). The agent can't answer it, so it's a
 * real safety gate for operations like "replace" imports that permanently
 * delete variables.
 *
 * Written for the v2 SDK's multi-round-trip model (protocol 2026-07-28): the
 * handler RETURNS an input-required result on its first pass, and the client
 * re-calls the tool with the user's answer in `ctx.mcpReq.inputResponses`.
 * The SDK's legacy shim serves the same code to 2025-era clients by sending a
 * real `elicitation/create` request and re-entering the handler. Handlers
 * re-run from the top on the retry, so everything before the gate must be
 * safe to repeat (reads, diffs) — never put a write before `confirmStep`.
 *
 *   const step = confirmStep(server, ctx, "confirm_delete", { message, fields });
 *   if (step.status === "ask") return step.result;           // first pass
 *   if (step.status === "declined" || step.status === "cancelled")
 *     return notConfirmedResult("the delete", step);         // nothing changed
 *   // "accepted" (use step.content) or "unsupported" (proceed as before)
 *
 * "unsupported" — the client can't show forms, FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE
 * is off, or the tool is running on the v1 SDK (Cloudflare) — means proceed
 * exactly as before; the tool's own guardrails still apply.
 */
// Type-only import: this module is shared with the Cloudflare build (v1 SDK),
// so it must not pull v2 runtime code into the Worker bundle. The wire shapes
// below are what the SDK's `inputRequired()` / `inputResponse()` produce
// (hand-built results are explicitly legal per the SDK docs).
import type { McpServer } from "@modelcontextprotocol/server";

const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

interface InputRequiredResult {
	resultType: "input_required";
	inputRequests: Record<string, { method: "elicitation/create"; params: Record<string, unknown> }>;
	[key: string]: unknown;
}

type Primitive =
	| { type: "boolean"; title?: string; description?: string; default?: boolean }
	| {
			type: "string";
			title?: string;
			description?: string;
			enum?: string[];
			enumNames?: string[];
			default?: string;
	  };

export interface ConfirmRequest {
	/** Shown to the user. Say what will happen and what can't be undone. */
	message: string;
	/** Flat form fields (primitives only, per the elicitation spec). */
	fields: Record<string, Primitive>;
	required?: string[];
}

export type ConfirmStep =
	| { status: "unsupported" }
	| { status: "ask"; result: InputRequiredResult }
	| { status: "accepted"; content: Record<string, unknown> }
	| { status: "declined" | "cancelled" };

/** Minimal view of the v2 handler context we read (absent on the v1 SDK). */
type HandlerCtx =
	| {
			mcpReq?: {
				inputResponses?: Record<string, unknown>;
				envelope?: Record<string, unknown>;
			};
	  }
	| undefined;

/**
 * Short stable fingerprint of what the user is being asked to approve. Build
 * it into the confirmStep key (e.g. `confirm_delete_${fingerprint(fileKey, ids)}`):
 * the answer arrives on a re-run of the handler, possibly minutes later, and if
 * the target file or the affected items changed in between, the key no longer
 * matches — so the old answer is ignored and the user is asked again about
 * what will actually happen. (FNV-1a; not a security boundary.)
 */
export function fingerprint(...parts: Array<string | number | null | undefined>): string {
	let h = 0x811c9dc5;
	const text = parts.map((p) => String(p ?? "")).join("\u0000");
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}

export function confirmationsDisabled(): boolean {
	// `process` may be absent in Cloudflare Workers without nodejs_compat.
	const env = typeof process !== "undefined" ? process.env : undefined;
	const v = (env?.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE ?? "").toLowerCase();
	return v === "off" || v === "false" || v === "0" || v === "no";
}

/** `{}` means form-only (pre-mode rule); `{ url: {} }` alone means no forms. */
export function supportsForm(caps: unknown): boolean {
	const e = (caps as { elicitation?: Record<string, unknown> } | undefined)?.elicitation;
	if (!e || typeof e !== "object") return false;
	return Object.keys(e).length === 0 || "form" in e;
}

/**
 * Client capabilities for THIS request: the request's own `_meta` envelope on
 * 2026-07-28, the initialize-declared ones on a 2025-era connection.
 */
export function requestClientCapabilities(server: McpServer | undefined, ctx: HandlerCtx): unknown {
	const fromEnvelope = ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY];
	if (fromEnvelope) return fromEnvelope;
	try {
		return server?.server.getClientCapabilities();
	} catch {
		return undefined;
	}
}

export function confirmStep(
	server: McpServer | undefined,
	ctx: HandlerCtx,
	key: string,
	req: ConfirmRequest,
): ConfirmStep {
	// v1 SDK (Cloudflare) has no multi-round-trip support: keep old behavior.
	if (!ctx?.mcpReq || confirmationsDisabled()) return { status: "unsupported" };

	const answer = ctx.mcpReq.inputResponses?.[key] as
		| { action?: unknown; content?: Record<string, unknown> }
		| undefined;
	if (answer && typeof answer === "object" && typeof answer.action === "string") {
		if (answer.action === "accept") return { status: "accepted", content: answer.content ?? {} };
		return { status: answer.action === "decline" ? "declined" : "cancelled" };
	}

	if (!supportsForm(requestClientCapabilities(server, ctx))) return { status: "unsupported" };

	return {
		status: "ask",
		result: {
			resultType: "input_required",
			inputRequests: {
				[key]: {
					method: "elicitation/create",
					params: {
						mode: "form",
						message: req.message,
						requestedSchema: {
							type: "object",
							properties: req.fields,
							...(req.required ? { required: req.required } : {}),
						},
					},
				},
			},
		},
	};
}

/** Standard tool result when the user didn't confirm. Nothing was changed. */
export function notConfirmedResult(operation: string, step: { status: "declined" | "cancelled" }) {
	const why = step.status === "declined" ? "The user declined" : "The user dismissed the confirmation";
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({
					success: false,
					confirmed: false,
					message: `${why}, so ${operation} was not performed. Nothing was changed in Figma.`,
					hint: "Don't retry this without asking the user first. If they want it, they can confirm when prompted.",
				}),
			},
		],
	};
}
