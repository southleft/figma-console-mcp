/**
 * Running plugin scripts for the asset tools without ever interleaving with
 * a script that may still be running (spec §2.5 step 10, review #5).
 *
 * Figma can't interrupt a plugin script. When a call times out, the script
 * keeps going; the plugin's message handler is async, so anything sent next
 * would run concurrently with it at its awaits. So: classify every bridge
 * outcome, and after a "maybe still running" outcome send nothing more in
 * this call.
 */

export type BridgeOutcome<T = unknown> =
	| { kind: "ok"; result: T }
	| { kind: "scriptError"; error: string }
	| { kind: "maybeRunning"; error: string }
	/** The script declined to start (another import is writing, or it reached the wrong file): nothing was changed. */
	| { kind: "refused"; error: string };

/** The plugin's own Promise.race in code.js fires 2 s before the server's timeout and resolves an ordinary envelope. */
const PLUGIN_TIMEOUT = /Execution timed out/;

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Run one EXECUTE_CODE call and classify it. The connector resolves
 * `{ success, result, error }`; the envelope is never read bare.
 *
 * Every THROWN error counts as maybeRunning. Script errors never arrive as
 * throws for EXECUTE_CODE: the bridge resolves them as `{ success: false }`
 * envelopes (bridgeCommandFailure exempts EXECUTE_CODE), so a throw is always
 * the transport: a timeout, a dropped or replaced socket ("Connection replaced
 * by same file reconnection", "WebSocket client disconnected", "Plugin
 * switched files", the Cloud relay's "Plugin disconnected"), or a send that
 * may or may not have reached Figma. Matching those texts would let the next
 * new wording slip through as a script error and the next chunk be sent while
 * the previous one is still running.
 *
 * A script that returns `{ refused: "…" }` chose not to start (it checks this
 * before touching anything), so the call stops with nothing changed.
 */
export async function classifyBridgeOutcome<T = unknown>(call: () => Promise<unknown>): Promise<BridgeOutcome<T>> {
	let res: unknown;
	try {
		res = await call();
	} catch (e) {
		return { kind: "maybeRunning", error: message(e) };
	}
	const env = res as { success?: unknown; result?: unknown; error?: unknown } | null | undefined;
	if (env && env.success === true) {
		const r = env.result as { refused?: unknown } | null | undefined;
		if (r && typeof r === "object" && typeof r.refused === "string" && r.refused) return { kind: "refused", error: r.refused };
		return { kind: "ok", result: env.result as T };
	}
	const err = env && typeof env.error === "string" && env.error ? env.error : "The plugin returned no result.";
	return PLUGIN_TIMEOUT.test(err) ? { kind: "maybeRunning", error: err } : { kind: "scriptError", error: err };
}

/** Wall-clock budget for one call's write phase. */
export class Budget {
	private readonly startedAt: number;
	constructor(
		readonly totalMs: number,
		private readonly now: () => number = Date.now,
	) {
		this.startedAt = now();
	}
	elapsed(): number {
		return this.now() - this.startedAt;
	}
	/** Launch only when the step could finish (by its timeout) inside the budget. */
	fits(nextTimeoutMs: number): boolean {
		return this.elapsed() + nextTimeoutMs <= this.totalMs;
	}
}

export interface WriteStep<T = unknown> {
	/** For logs and stop messages; never contains user text. */
	label: string;
	timeoutMs: number;
	/**
	 * A preparation step (restore version, container) that makes no progress on
	 * the items by itself. The first progress step always launches, even after
	 * setup steps, so a call can't spend its budget on setup and stop before any
	 * item (which a resume would then repeat forever).
	 */
	setup?: boolean;
	run(): Promise<BridgeOutcome<T>>;
}

export type StopReason = "maybeRunning" | "budget" | "cancelled" | "refused";

export interface WritePhaseResult {
	stop: null | { reason: StopReason; error?: string; elapsedMs: number };
	steps: number;
}

/**
 * Run steps in order, deciding before each one whether it may start:
 *   1. the previous outcome (maybeRunning or refused → stop: nothing more is sent),
 *   2. the abort signal (→ cancelled),
 *   3. the budget: everything up to and including the first progress step
 *      always launches; later steps launch only when they can finish in time.
 * `next` builds steps lazily, so a step can depend on earlier results.
 */
export async function runWritePhase(opts: {
	budget: Budget;
	signal?: AbortSignal;
	next: () => WriteStep | null;
	onOutcome: (step: WriteStep, outcome: BridgeOutcome) => void;
}): Promise<WritePhaseResult> {
	let steps = 0;
	let progressLaunched = false;
	for (;;) {
		if (opts.signal?.aborted) return { stop: { reason: "cancelled", elapsedMs: opts.budget.elapsed() }, steps };
		const step = opts.next();
		if (!step) return { stop: null, steps };
		if (progressLaunched && !opts.budget.fits(step.timeoutMs)) {
			return { stop: { reason: "budget", elapsedMs: opts.budget.elapsed() }, steps };
		}
		if (!step.setup) progressLaunched = true;
		const outcome = await step.run();
		steps++;
		opts.onOutcome(step, outcome);
		if (outcome.kind === "maybeRunning" || outcome.kind === "refused") {
			return { stop: { reason: outcome.kind, error: outcome.error, elapsedMs: opts.budget.elapsed() }, steps };
		}
	}
}

/** The `incomplete.reason` text for a stop (spec §2.5 step 10.5). */
export function stopMessage(reason: StopReason, runId: string, elapsedMs: number, error?: string): string {
	if (reason === "maybeRunning") {
		return `Figma didn't answer in time (or the connection dropped) and may still be importing. Nothing more was sent. Wait until Figma is idle (check with figma_capture_screenshot), then run the same call again with resumeRunId: "${runId}": components update in place, and SVGs this run already imported are recognized instead of imported twice.`;
	}
	if (reason === "refused") {
		return `${error ?? "Figma declined the next step."} Nothing more was sent. When that's sorted out, run the same call again with resumeRunId: "${runId}" to continue.`;
	}
	if (reason === "budget") {
		return `Stopped after ${Math.round(elapsedMs / 1000)} s to stay within the time limit for one call. Run the same call again with resumeRunId: "${runId}" to continue.`;
	}
	return `Cancelled. The batch Figma was working on may still finish. Run the same call again with resumeRunId: "${runId}" to continue.`;
}

// ---------------------------------------------------------------------------
// One write phase per file per server
// ---------------------------------------------------------------------------

const writeLocks = new Set<string>();

/**
 * Take the write lock for a file, or null when another figma_import_svg or
 * figma_import_image call in this server is still writing to it. Taken
 * synchronously right after planning, so two parallel calls can't both pass
 * their preflights and then interleave their writes (duplicate containers,
 * overlapping layout cursors). The plugin-side busy marker covers other
 * servers connected to the same file. The release function is idempotent.
 */
export function acquireWriteLock(key: string): (() => void) | null {
	if (writeLocks.has(key)) return null;
	writeLocks.add(key);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		writeLocks.delete(key);
	};
}

export const WRITE_LOCK_MESSAGE =
	"Another figma_import_svg or figma_import_image call is still writing to this file. Nothing was changed. Wait for it to finish (or for its task to complete), then run this call again.";
