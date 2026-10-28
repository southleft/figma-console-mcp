/**
 * Figma Personal Access Token (PAT) checks for the Cloud endpoints.
 */

export interface FigmaPatUser {
	id: string;
	handle: string;
	email: string;
}

/**
 * Check if a token is a Figma Personal Access Token.
 * PATs start with 'figd_' — OAuth tokens start with 'figu_'.
 */
export function isFigmaPAT(token: string): boolean {
	return token.startsWith("figd_");
}

/**
 * Validate a Figma Personal Access Token (PAT) by calling the Figma API.
 * PATs require the X-Figma-Token header (not Bearer).
 *
 * GET /v1/me needs the `current_user:read` scope. Figma answers 401 for a bad
 * token but 403 for a real token without that scope, so a 403 still proves
 * the token is genuine: accept it rather than reject a working token whose
 * owner simply didn't grant that one scope.
 *
 * Returns the user info if valid, null if invalid/expired.
 */
export async function validateFigmaPAT(
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<FigmaPatUser | null> {
	try {
		const response = await fetchImpl("https://api.figma.com/v1/me", {
			headers: { "X-Figma-Token": token },
		});
		if (response.status === 403) {
			return { id: "", handle: "(token without current_user:read)", email: "" };
		}
		if (!response.ok) return null;
		const data = (await response.json()) as FigmaPatUser;
		return data?.id ? data : null;
	} catch {
		return null;
	}
}
