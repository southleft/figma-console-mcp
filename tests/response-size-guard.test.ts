/**
 * Oversized tool results must never reach the client.
 *
 * Found while live-testing v1.40.3: a figma_execute call returning ~20 MB of node
 * JSON did not fail — it DISCONNECTED the server. Claude Code closes the transport
 * when one JSON-RPC message passes 16 MB, the user sees "Connection closed", and
 * every tool is gone for the rest of the session.
 */

import { capToolResponse, MAX_TOOL_RESPONSE_BYTES, wrapServerForIdentity } from "../src/core/identity";

const text = (s: string) => ({ content: [{ type: "text", text: s }] });

describe("capToolResponse", () => {
	it("passes ordinary results through untouched", () => {
		const r = text(JSON.stringify({ ok: true }));
		expect(capToolResponse(r)).toBe(r);
	});

	it("replaces an oversized result with an actionable error instead of returning it", () => {
		const big = text(JSON.stringify({ data: "x".repeat(MAX_TOOL_RESPONSE_BYTES + 10) }));
		const out: any = capToolResponse(big);
		expect(out.isError).toBe(true);
		const body = JSON.parse(out.content[0].text);
		expect(body.error).toContain("above the 8.0 MB this server will return");
		expect(body.note).toContain("changes still happened");
		expect(body.hint).toContain("summary");
		expect(out.content[0].text.length).toBeLessThan(2000); // the error itself is tiny
	});

	it("counts base64 image payloads too, and multi-part content in total", () => {
		const half = "y".repeat(MAX_TOOL_RESPONSE_BYTES / 2 + 1);
		const out: any = capToolResponse({ content: [{ type: "image", data: half, mimeType: "image/png" }, { type: "text", text: half }] });
		expect(out.isError).toBe(true);
	});

	it("measures BYTES, not characters", () => {
		const out: any = capToolResponse(text("€".repeat(40)), 100); // 40 chars, 120 bytes
		expect(out.isError).toBe(true);
	});

	it("ignores shapes that aren't tool results", () => {
		expect(capToolResponse(undefined)).toBeUndefined();
		expect(capToolResponse({ foo: 1 })).toEqual({ foo: 1 });
	});
});

describe("wrapServerForIdentity applies the cap to every registered tool", () => {
	it("guards a handler that returns too much", async () => {
		let registered: any;
		const server: any = { tool: (...args: any[]) => { registered = args[args.length - 1]; } };
		wrapServerForIdentity(server);
		server.tool("huge", "desc", {}, async () => text("z".repeat(MAX_TOOL_RESPONSE_BYTES + 1)));
		const out = await registered({});
		expect(out.isError).toBe(true);
	});
});
