/**
 * Bridge outcome classification and the write-phase loop shared by the
 * asset tools (spec §2.5 step 10, §8.1 "assets-run-control").
 */

import { Budget, type BridgeOutcome, acquireWriteLock, classifyBridgeOutcome, runWritePhase, stopMessage, type WriteStep } from "../../src/core/assets/run-control";

describe("classifyBridgeOutcome", () => {
	it("treats the plugin's own timeout envelope as maybeRunning", async () => {
		const o = await classifyBridgeOutcome(async () => ({ success: false, error: "Error: Execution timed out after 5000ms" }));
		expect(o).toEqual({ kind: "maybeRunning", error: "Error: Execution timed out after 5000ms" });
	});

	it("treats every thrown error as maybeRunning: the connectors' exact timeout, disconnect and reconnect texts", async () => {
		// Verbatim from websocket-server.ts, websocket-connector.ts and cloud-websocket-relay.ts: a thrown
		// error is always the transport (script errors arrive as { success: false } envelopes).
		const thrown = [
			"WebSocket command EXECUTE_CODE timed out after 12000ms. The script may still be running in Figma",
			"Command EXECUTE_CODE timed out after 12000ms",
			"No WebSocket client connected. Make sure the Desktop Bridge plugin is open in Figma.",
			"No active file connected. Make sure the Desktop Bridge plugin is open in Figma.",
			"The Desktop Bridge plugin is still busy with EXECUTE_CODE, sent 30s ago",
			"Connection replaced by same file reconnection",
			"WebSocket client disconnected",
			"Plugin switched files",
			"Plugin disconnected",
			"No plugin connected. User must pair the plugin first.",
			"Failed to send command to plugin — connection may be stale",
			"Failed to send WebSocket command EXECUTE_CODE: socket hang up",
			"Server shutting down",
			"Per-file targeting (fileKey) is Local Mode only.",
		];
		for (const m of thrown) {
			const o = await classifyBridgeOutcome(async () => {
				throw new Error(m);
			});
			expect(o.kind).toBe("maybeRunning");
		}
	});

	it("classifies other failures as scriptError and unwraps success", async () => {
		expect(await classifyBridgeOutcome(async () => ({ success: false, error: "TypeError: x is undefined" }))).toEqual({ kind: "scriptError", error: "TypeError: x is undefined" });
		expect((await classifyBridgeOutcome(async () => ({ success: false }))).kind).toBe("scriptError");
		expect((await classifyBridgeOutcome(async () => undefined)).kind).toBe("scriptError");
		expect(await classifyBridgeOutcome(async () => ({ success: true, result: { a: 1 } }))).toEqual({ kind: "ok", result: { a: 1 } });
		// A script that declined to start (busy, wrong file) is "refused", not ok.
		expect(await classifyBridgeOutcome(async () => ({ success: true, result: { refused: "Another SVG import is still writing." } }))).toEqual({
			kind: "refused",
			error: "Another SVG import is still writing.",
		});
	});
});

function steps(outcomes: BridgeOutcome[], timeoutMs = 1000) {
	const calls: number[] = [];
	let i = 0;
	const next = (): WriteStep | null => {
		if (i >= outcomes.length) return null;
		const n = i++;
		return {
			label: `step${n}`,
			timeoutMs,
			run: async () => {
				calls.push(n);
				return outcomes[n];
			},
		};
	};
	return { calls, next };
}

const OK: BridgeOutcome = { kind: "ok", result: {} };

describe("runWritePhase", () => {
	it("makes no further connector call after maybeRunning", async () => {
		const { calls, next } = steps([OK, { kind: "maybeRunning", error: "timed out" }, OK, OK]);
		const seen: string[] = [];
		const r = await runWritePhase({ budget: new Budget(60_000), next, onOutcome: (s, o) => seen.push(`${s.label}:${o.kind}`) });
		expect(calls).toEqual([0, 1]);
		expect(seen).toEqual(["step0:ok", "step1:maybeRunning"]);
		expect(r.stop).toMatchObject({ reason: "maybeRunning", error: "timed out" });
	});

	it("keeps going after a scriptError", async () => {
		const { calls, next } = steps([{ kind: "scriptError", error: "boom" }, OK]);
		const r = await runWritePhase({ budget: new Budget(60_000), next, onOutcome: () => {} });
		expect(calls).toEqual([0, 1]);
		expect(r.stop).toBeNull();
	});

	it("stops between chunks when the signal aborts, reporting cancelled", async () => {
		const ac = new AbortController();
		const { calls, next } = steps([OK, OK, OK]);
		const r = await runWritePhase({
			budget: new Budget(60_000),
			signal: ac.signal,
			next,
			onOutcome: (s) => {
				if (s.label === "step0") ac.abort();
			},
		});
		expect(calls).toEqual([0]);
		expect(r.stop?.reason).toBe("cancelled");
	});

	it("doesn't launch the next step when elapsed + timeout exceeds the budget; the first step always launches", async () => {
		let now = 0;
		const budget = new Budget(10_000, () => now);
		const { calls, next } = steps([OK, OK, OK], 8_000);
		const r = await runWritePhase({
			budget,
			next,
			onOutcome: () => {
				now += 3_000;
			},
		});
		// The first step's timeout (8 s) fits; after 3 s elapsed, 3 + 8 > 10 stops the second.
		expect(calls).toEqual([0]);
		expect(r.stop?.reason).toBe("budget");
		const tiny = steps([OK], 50_000);
		const first = await runWritePhase({ budget: new Budget(1_000), next: tiny.next, onOutcome: () => {} });
		expect(tiny.calls).toEqual([0]);
		expect(first.stop).toBeNull();
	});

	it("words the stop reasons with the runId", () => {
		expect(stopMessage("maybeRunning", "abcdefabcdef", 0)).toMatch(/may still be importing\. Nothing more was sent\..*resumeRunId: "abcdefabcdef"/);
		expect(stopMessage("refused", "abcdefabcdef", 0, "This step reached a different Figma file.")).toBe(
			'This step reached a different Figma file. Nothing more was sent. When that\'s sorted out, run the same call again with resumeRunId: "abcdefabcdef" to continue.',
		);
		expect(stopMessage("budget", "abcdefabcdef", 241_000)).toBe(
			'Stopped after 241 s to stay within the time limit for one call. Run the same call again with resumeRunId: "abcdefabcdef" to continue.',
		);
		expect(stopMessage("cancelled", "abcdefabcdef", 0)).toMatch(/^Cancelled\. The batch Figma was working on may still finish/);
	});
});

describe("review fixes", () => {
	it("stops after a refused step: nothing more is sent", async () => {
		const { calls, next } = steps([OK, { kind: "refused", error: "busy" }, OK]);
		const r = await runWritePhase({ budget: new Budget(60_000), next, onOutcome: () => {} });
		expect(calls).toEqual([0, 1]);
		expect(r.stop).toMatchObject({ reason: "refused", error: "busy" });
	});

	it("setup steps don't use up the always-launch guarantee: the first progress step runs after them", async () => {
		// Cloud: a 120 s budget, a checkpoint that took 2 s, then a chunk whose timeout is the full 120 s.
		let now = 0;
		const budget = new Budget(120_000, () => now);
		const launched: string[] = [];
		const plan: WriteStep[] = [
			{ label: "checkpoint", setup: true, timeoutMs: 30_000, run: async () => (launched.push("checkpoint"), (now += 2_000), OK) },
			{ label: "container", setup: true, timeoutMs: 15_000, run: async () => (launched.push("container"), (now += 1_000), OK) },
			{ label: "chunk1", timeoutMs: 120_000, run: async () => (launched.push("chunk1"), (now += 60_000), OK) },
			{ label: "chunk2", timeoutMs: 120_000, run: async () => (launched.push("chunk2"), OK) },
		];
		let i = 0;
		const r = await runWritePhase({ budget, next: () => plan[i++] ?? null, onOutcome: () => {} });
		// The first chunk always launches; the second doesn't fit any more.
		expect(launched).toEqual(["checkpoint", "container", "chunk1"]);
		expect(r.stop?.reason).toBe("budget");
	});

	it("the write lock admits one writer per file and its release is idempotent", () => {
		const a = acquireWriteLock("FILE_A");
		expect(a).not.toBeNull();
		expect(acquireWriteLock("FILE_A")).toBeNull();
		const b = acquireWriteLock("FILE_B");
		expect(b).not.toBeNull();
		a!();
		a!();
		const again = acquireWriteLock("FILE_A");
		expect(again).not.toBeNull();
		again!();
		b!();
	});
});
