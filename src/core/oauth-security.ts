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
 * - Registered client: exact match against the redirect_uris it registered.
 * - Unknown client (never registered, or registration expired): loopback or a
 *   trusted hosted callback only.
 *
 * Anything else is refused so an attacker-crafted /authorize link cannot
 * deliver a victim's code to the attacker's server.
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
		return registeredRedirectUris.includes(redirectUri);
	}
	return isLoopbackOrTrustedRedirect(redirectUri);
}

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
