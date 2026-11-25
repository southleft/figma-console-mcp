/**
 * Ask the user to confirm a destructive operation via MCP elicitation.
 *
 * Elicitation pauses a tool call and shows the user a small form (Claude Code
 * renders a dialog; Claude desktop/claude.ai render forms). The agent cannot
 * answer it — only the human can — so it's a real safety gate for operations
 * like "replace" imports that permanently delete variables.
 *
 * Behavior:
 *  - Client doesn't support elicitation → "unsupported": the caller proceeds
 *    exactly as before (the tool's own guardrails still apply).
 *  - FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE=off|false|0 → "unsupported" too
 *    (opt-out for scripted / unattended runs).
 *  - User accepts → "accepted" with the form content.
 *  - User declines, cancels, the prompt times out, or the request fails after
 *    the client said it supports elicitation → caller must NOT proceed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "confirm" });

/** How long a person has to answer before the operation is abandoned. */
export const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

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

export type ConfirmOutcome =
	| { status: "unsupported" }
	| { status: "accepted"; content: Record<string, unknown> }
	| { status: "declined" | "cancelled" | "timeout" | "error"; reason?: string };

export function confirmationsDisabled(): boolean {
	// `process` may be absent in Cloudflare Workers without nodejs_compat.
	const env = typeof process !== "undefined" ? process.env : undefined;
	const v = (env?.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE ?? "").toLowerCase();
	return v === "off" || v === "false" || v === "0" || v === "no";
}

export function clientSupportsElicitation(server: McpServer): boolean {
	try {
		const caps = server.server.getClientCapabilities() as
			| { elicitation?: Record<string, unknown> }
			| undefined;
		const e = caps?.elicitation;
		if (!e) return false;
		// `{}` means form-only (backwards compat); `{ url: {} }` alone means no form.
		return Object.keys(e).length === 0 || "form" in e;
	} catch {
		return false;
	}
}

export async function askUser(
	server: McpServer | undefined,
	req: ConfirmRequest,
): Promise<ConfirmOutcome> {
	if (!server || confirmationsDisabled() || !clientSupportsElicitation(server)) {
		return { status: "unsupported" };
	}
	try {
		const result = await server.server.elicitInput(
			{
				mode: "form",
				message: req.message,
				requestedSchema: {
					type: "object",
					properties: req.fields as any,
					...(req.required ? { required: req.required } : {}),
				},
			},
			{ timeout: CONFIRM_TIMEOUT_MS },
		);
		if (result.action === "accept") {
			return { status: "accepted", content: (result.content ?? {}) as Record<string, unknown> };
		}
		return { status: result.action === "decline" ? "declined" : "cancelled" };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const timedOut = /timed? ?out/i.test(msg);
		logger.warn({ err: msg }, "Confirmation prompt failed — not proceeding");
		return { status: timedOut ? "timeout" : "error", reason: msg };
	}
}

/** Standard tool result when the user didn't confirm. Nothing was changed. */
export function notConfirmedResult(operation: string, outcome: ConfirmOutcome) {
	const why =
		outcome.status === "declined"
			? "The user declined"
			: outcome.status === "cancelled"
				? "The user dismissed the confirmation"
				: outcome.status === "timeout"
					? "The confirmation prompt timed out"
					: `The confirmation prompt failed (${"reason" in outcome ? outcome.reason : "unknown error"})`;
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
