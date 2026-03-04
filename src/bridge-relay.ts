/**
 * Bridge Relay
 * Relays write commands from the Cloudflare Worker to the Figma Desktop Bridge plugin
 * via Supabase as a message queue.
 *
 * Flow: Worker → INSERT bridge_commands → plugin polls via Realtime → UPDATE result → Worker polls → return
 */

/** Minimal env interface — only what bridge-relay needs */
export interface BridgeEnv {
	SUPABASE_URL?: string;
	SUPABASE_SERVICE_KEY?: string;
}

const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 30_000;
const CLEANUP_OLDER_THAN_MS = 5 * 60 * 1000; // 5 minutes

export interface BridgeCommand {
	id: string;
	type: string;
	payload: unknown;
}

/**
 * Relay a command to the Figma Desktop Bridge plugin via Supabase.
 * Inserts the command, polls for the result, and returns it.
 * Throws a clear error if the plugin is not connected within 30 seconds.
 */
export async function bridgeRelay(
	command: BridgeCommand,
	sessionId: string,
	env: BridgeEnv
): Promise<unknown> {
	const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = env;

	if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
		throw new Error(
			'Bridge relay not configured: missing SUPABASE_URL or SUPABASE_SERVICE_KEY secrets.'
		);
	}

	const headers: Record<string, string> = {
		apikey: SUPABASE_SERVICE_KEY,
		Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
		'Content-Type': 'application/json',
	};

	const baseUrl = `${SUPABASE_URL}/rest/v1/bridge_commands`;

	// Applicatif cleanup (étape A): delete old unresolved rows for this session
	const cutoff = new Date(Date.now() - CLEANUP_OLDER_THAN_MS).toISOString();
	await fetch(
		`${baseUrl}?session_id=eq.${sessionId}&resolved_at=is.null&created_at=lt.${cutoff}`,
		{ method: 'DELETE', headers }
	).catch(() => {
		// Cleanup failure is non-blocking
	});

	// INSERT the command
	const insertRes = await fetch(baseUrl, {
		method: 'POST',
		headers: { ...headers, Prefer: 'return=minimal' },
		body: JSON.stringify({
			id: command.id,
			session_id: sessionId,
			command: { type: command.type, payload: command.payload },
		}),
	});

	if (!insertRes.ok) {
		const body = await insertRes.text();
		throw new Error(`Bridge relay: INSERT failed (${insertRes.status}): ${body}`);
	}

	// Poll every 500ms for up to 30s
	const deadline = Date.now() + TIMEOUT_MS;

	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);

		const pollRes = await fetch(
			`${baseUrl}?id=eq.${command.id}&select=result,resolved_at`,
			{ headers }
		);

		if (!pollRes.ok) continue;

		const rows = await pollRes.json() as Array<{
			result: unknown;
			resolved_at: string | null;
		}>;

		const row = rows[0];
		if (row?.resolved_at !== null && row?.result !== undefined) {
			return row.result;
		}
	}

	// Timeout: clean up the pending row
	await fetch(`${baseUrl}?id=eq.${command.id}`, {
		method: 'DELETE',
		headers,
	}).catch(() => {});

	throw new Error(
		JSON.stringify({
			error: 'bridge_timeout',
			message:
				'Bridge non connecté : le plugin Figma Desktop Bridge ne répond pas. ' +
				"Assurez-vous que le plugin est ouvert dans Figma Desktop et connecté à Supabase avec votre session ID.",
		})
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
