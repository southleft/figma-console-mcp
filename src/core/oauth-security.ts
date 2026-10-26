/**
 * OAuth hardening helpers for the Cloud Mode authorization server (src/index.ts).
 *
 * Pure functions with no Workers bindings so they can be unit-tested in Node.
 */

/** Escape a string for safe interpolation into HTML text or attribute values. */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Hosted MCP clients whose OAuth callback we accept even when the client's
 * dynamic registration has expired from KV (registrations live 30 days, but
 * clients keep reusing their client_id).
 */
const TRUSTED_CALLBACKS = new Set([
	"https://claude.ai/api/mcp/auth_callback",
	"https://claude.com/api/mcp/auth_callback",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Loopback redirects (RFC 8252 §7.3) are safe to accept for any client: only
 * a process on the user's own machine can receive them.
 */
function isLoopbackRedirect(uri: URL): boolean {
	return (uri.protocol === "http:" || uri.protocol === "https:") && LOOPBACK_HOSTS.has(uri.hostname);
}

/**
 * Decide whether /authorize may send an authorization code to `redirectUri`.
 *
 * - Registered client: exact match against the redirect_uris it registered
 *   (loopback: any port).
 * - Unknown client (never registered, or registration expired): any safe
 *   destination; non-loopback ones go through the consent page.
 */
export function isAllowedRedirectUri(redirectUri: string, registeredRedirectUris: string[] | null): boolean {
	let parsed: URL;
	try {
		parsed = new URL(redirectUri);
	} catch {
		return false;
	}
	if (parsed.hash) return false;

	if (registeredRedirectUris && registeredRedirectUris.length > 0) {
		if (registeredRedirectUris.includes(redirectUri)) return true;
		// RFC 8252 §7.3: native apps pick a free loopback port at runtime, so a
		// loopback redirect matches a registered one on scheme, host and path
		// with any port.
		if (isLoopbackRedirect(parsed)) {
			return registeredRedirectUris.some((r) => {
				try {
					const reg = new URL(r);
					return isLoopbackRedirect(reg) && reg.protocol === parsed.protocol && reg.hostname === parsed.hostname && reg.pathname === parsed.pathname && reg.search === parsed.search;
				} catch {
					return false;
				}
			});
		}
		return false;
	}
	// Unknown client (never registered, or its 30-day registration expired):
	// accept any well-formed destination that isn't a script/document scheme
	// or plain http off-loopback. Anything not loopback or trusted is shown
	// on the consent page, and the callback is bound to the browser that
	// started the flow, so an attacker can't skip that confirmation.
	if (UNSAFE_SCHEMES.has(parsed.protocol)) return false;
	if (parsed.protocol === "http:" && !isLoopbackRedirect(parsed)) return false;
	return true;
}

const UNSAFE_SCHEMES = new Set(["javascript:", "data:", "file:", "blob:", "vbscript:", "about:", "ws:", "wss:", "ftp:"]);

/**
 * Loopback and trusted hosted callbacks can skip the consent page. Any other
 * destination came from an open dynamic registration (anyone can register
 * any redirect_uri), so the user must confirm where their access is going.
 */
export function isLoopbackOrTrustedRedirect(redirectUri: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(redirectUri);
	} catch {
		return false;
	}
	return isLoopbackRedirect(parsed) || TRUSTED_CALLBACKS.has(`${parsed.origin}${parsed.pathname}`);
}

/** Read one cookie value from a Cookie header. */
export function readCookie(cookieHeader: string | null, name: string): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === name) return rest.join("=");
	}
	return null;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Verify a PKCE code_verifier against an S256 code_challenge (RFC 7636 §4.6). */
export async function verifyPkceS256(codeVerifier: string, codeChallenge: string): Promise<boolean> {
	if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
	return base64UrlEncode(new Uint8Array(digest)) === codeChallenge;
}

/** Lowercase hex SHA-256 of a string. */
export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Legacy /sse session ids bound to the bearer token that opened them:
 * 32 hex of randomness + 32 hex of HMAC(secret, nonce + token hash). Any
 * request naming a session must present the same token, without a storage
 * lookup (KV's eventual consistency would make a stored owner unreliable on
 * a session's first messages).
 */
export async function mintSseSessionId(secret: string, bearerToken: string): Promise<string> {
	const nonceBytes = new Uint8Array(16);
	crypto.getRandomValues(nonceBytes);
	const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
	const mac = await hmacHex(secret, `${nonce}:${await sha256Hex(bearerToken)}`);
	return nonce + mac.slice(0, 32);
}

export async function sseSessionBelongsTo(secret: string, sessionId: string, bearerToken: string): Promise<boolean> {
	if (!/^[0-9a-f]{64}$/.test(sessionId)) return false;
	const nonce = sessionId.slice(0, 32);
	const mac = await hmacHex(secret, `${nonce}:${await sha256Hex(bearerToken)}`);
	const expected = mac.slice(0, 32);
	const actual = sessionId.slice(32);
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
	return diff === 0;
}
