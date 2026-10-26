/**
 * Cloud Mode OAuth hardening (issue #104 SEC-002 / SEC-005).
 *
 * Unit tests for the pure helpers, plus source guards on src/index.ts for the
 * three properties that made tokens stealable or shared between users:
 *  - /authorize must validate redirect_uri before storing it
 *  - authorization codes must be random and one-time, not the client_id
 *  - no session may read a token from a slot shared by every user
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createHash, webcrypto } from "crypto";
import {
	escapeHtml,
	isAllowedRedirectUri,
	isLoopbackOrTrustedRedirect,
	mintSseSessionId,
	readCookie,
	sseSessionBelongsTo,
	verifyPkceS256,
} from "../src/core/oauth-security";

if (!(globalThis as any).crypto?.subtle) {
	(globalThis as any).crypto = webcrypto;
}

describe("escapeHtml", () => {
	it("neutralises script injection in the callback error page", () => {
		expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe(
			"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;",
		);
	});
});

describe("isAllowedRedirectUri", () => {
	const registered = ["https://chatgpt.com/connector_platform_oauth_redirect", "cursor://anysphere.cursor/oauth"];

	it("accepts an exact registered match", () => {
		expect(isAllowedRedirectUri("cursor://anysphere.cursor/oauth", registered)).toBe(true);
	});

	it("refuses anything a registered client did not register", () => {
		expect(isAllowedRedirectUri("https://evil.example/cb", registered)).toBe(false);
		expect(isAllowedRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect/x", registered)).toBe(false);
	});

	it("lets a registered loopback redirect use any port (RFC 8252)", () => {
		const reg = ["http://localhost:3334/oauth/callback"];
		expect(isAllowedRedirectUri("http://localhost:51234/oauth/callback", reg)).toBe(true);
		expect(isAllowedRedirectUri("http://localhost:51234/other", reg)).toBe(false);
		expect(isAllowedRedirectUri("http://127.0.0.1:3334/oauth/callback", reg)).toBe(false);
	});

	it("for an unknown (or expired) client, accepts safe destinations, which then get the consent page", () => {
		expect(isAllowedRedirectUri("http://localhost:33418/oauth/callback", null)).toBe(true);
		expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback", null)).toBe(true);
		expect(isAllowedRedirectUri("cursor://anysphere.cursor/oauth", null)).toBe(true);
		expect(isAllowedRedirectUri("https://vscode.dev/redirect", null)).toBe(true);
		expect(isLoopbackOrTrustedRedirect("https://vscode.dev/redirect")).toBe(false);
		expect(isLoopbackOrTrustedRedirect("https://localhost.evil.example/cb")).toBe(false);
		expect(isLoopbackOrTrustedRedirect("https://claude.ai.evil.example/api/mcp/auth_callback")).toBe(false);
	});

	it("refuses script/document schemes and plain http off-loopback", () => {
		for (const uri of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "http://evil.example/cb"]) {
			expect(isAllowedRedirectUri(uri, null)).toBe(false);
		}
	});

	it("refuses malformed URIs and fragments", () => {
		expect(isAllowedRedirectUri("not a url", null)).toBe(false);
		expect(isAllowedRedirectUri("http://localhost:1/cb#frag", null)).toBe(false);
	});
});

describe("isLoopbackOrTrustedRedirect", () => {
	it("sends other registered destinations through the consent page", () => {
		expect(isLoopbackOrTrustedRedirect("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(false);
		expect(isLoopbackOrTrustedRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
	});
});

describe("readCookie", () => {
	it("reads one cookie among several", () => {
		expect(readCookie("a=1; fcm_consent=abc=; b=2", "fcm_consent")).toBe("abc=");
		expect(readCookie(null, "fcm_consent")).toBeNull();
		expect(readCookie("a=1", "fcm_consent")).toBeNull();
	});
});

describe("verifyPkceS256", () => {
	const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
	const challenge = createHash("sha256").update(verifier).digest("base64url");

	it("accepts the matching verifier (RFC 7636 appendix B vector)", async () => {
		expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
		await expect(verifyPkceS256(verifier, challenge)).resolves.toBe(true);
	});

	it("rejects a wrong or malformed verifier", async () => {
		await expect(verifyPkceS256(verifier.replace("d", "e"), challenge)).resolves.toBe(false);
		await expect(verifyPkceS256("short", challenge)).resolves.toBe(false);
	});
});

describe("legacy /sse session binding", () => {
	it("a session id verifies only with the token that minted it", async () => {
		const id = await mintSseSessionId("secret", "figu_victim");
		expect(id).toMatch(/^[0-9a-f]{64}$/);
		await expect(sseSessionBelongsTo("secret", id, "figu_victim")).resolves.toBe(true);
		await expect(sseSessionBelongsTo("secret", id, "figd_attacker")).resolves.toBe(false);
		await expect(sseSessionBelongsTo("other-secret", id, "figu_victim")).resolves.toBe(false);
		await expect(sseSessionBelongsTo("secret", "f".repeat(64), "figu_victim")).resolves.toBe(false);
		await expect(sseSessionBelongsTo("secret", "not-hex", "figu_victim")).resolves.toBe(false);
	});
});

describe("src/index.ts OAuth source guards", () => {
	const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf-8");

	it("never writes or reads a token slot shared by all users", () => {
		expect(src).not.toMatch(/oauth_token:figma-console-mcp-default-session/);
		expect(src).not.toMatch(/patTokenKey/);
	});

	it("validates redirect_uri in /authorize before storing it", () => {
		const authorize = src.slice(src.indexOf('url.pathname === "/authorize"'), src.indexOf('url.pathname === "/authorize/continue"'));
		expect(authorize.indexOf("isAllowedRedirectUri(")).toBeGreaterThan(-1);
		expect(authorize.indexOf("isAllowedRedirectUri(")).toBeLessThan(authorize.indexOf("OAUTH_STATE.put(mcpStateKey"));
	});

	it("issues random one-time codes and checks PKCE at /token", () => {
		expect(src).not.toMatch(/const authCode = sessionId/);
		expect(src).toMatch(/auth_code:\$\{authCode\}/);
		expect(src).toMatch(/OAUTH_STATE\.delete\(codeKey\)/);
		expect(src).toMatch(/verifyPkceS256\(codeVerifier/);
	});

	it("binds the callback to the browser that started the flow, before exchanging the code", () => {
		const cb = src.slice(src.indexOf('url.pathname === "/oauth/callback"'));
		expect(cb.indexOf("flowCookieName(stateToken)")).toBeGreaterThan(-1);
		expect(cb.indexOf("flowCookieName(stateToken)")).toBeLessThan(cb.indexOf("api.figma.com/v1/oauth/token"));
	});

	it("requires PKCE S256 on /authorize", () => {
		expect(src).toMatch(/if \(!codeChallenge \|\| codeChallengeMethod !== "S256"\)/);
	});

	it("gives each /sse session its own verified token", () => {
		expect(src).not.toMatch(/FigmaConsoleMCPv3\.serveSSE\("\/sse"\)\.fetch\(request, env, ctx\);\n\t\t\}/);
		expect((src.match(/serveSSEWithToken\(request, env, ctx, bearerToken\)/g) || []).length).toBe(2);
	});
});
