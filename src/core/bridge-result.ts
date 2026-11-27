/**
 * The Desktop Bridge UI's per-method wrappers (figma-desktop-bridge/ui.html)
 * catch a plugin-side rejection and RESOLVE it as `{ success: false, error }`,
 * so the reply reaches the server as a normal result rather than an error.
 * Tools that didn't check `success` then reported success for writes Figma
 * had refused (e.g. figma_update_variable with a mode id Figma rejects).
 *
 * The connectors call this on every reply and reject when it returns a
 * message, so a refused command is always an error, with any plugin version.
 *
 * EXECUTE_CODE is exempt: its `{ success: false, error }` is the outcome of the
 * caller's script, and figma_execute and the tools built on it read that shape
 * themselves.
 */
export function bridgeCommandFailure(method: string, result: unknown): string | null {
	if (method === "EXECUTE_CODE") return null;
	if (!result || typeof result !== "object") return null;
	const r = result as { success?: unknown; error?: unknown };
	if (r.success !== false) return null;
	return typeof r.error === "string" && r.error ? r.error : `${method} failed in the Figma plugin`;
}
