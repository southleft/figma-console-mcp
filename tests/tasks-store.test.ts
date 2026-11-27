/**
 * The in-memory MCP task store (src/core/tasks.ts): lifecycle, retention,
 * cancellation, concurrency cap and per-request gating.
 */
import {
	TASKS_EXTENSION_ID,
	TaskStore,
	requestSupportsTasks,
	runAsTaskIfSupported,
} from "../src/core/tasks";

const HOUR = 60 * 60 * 1000;
const tick = () => new Promise((r) => setImmediate(r));

function clock(start = Date.parse("2026-11-25T12:00:00Z")) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

function gated<T>(value: T) {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let signal: AbortSignal | undefined;
	const work = jest.fn(async (s: AbortSignal) => {
		signal = s;
		await gate;
		return value;
	});
	return { work, release, signal: () => signal };
}

const ok = (text: string) => ({ content: [{ type: "text", text }] });

describe("TaskStore", () => {
	it("creates a working task that is readable immediately", () => {
		const store = new TaskStore();
		const { work } = gated(ok("x"));
		const task = store.create(work)!;
		expect(task.status).toBe("working");
		expect(task.taskId).toMatch(/^task-[0-9a-f]{32}$/);
		expect(store.get(task.taskId)?.status).toBe("working");
		expect(task.createdAt).toBe(task.lastUpdatedAt);
		expect(task.pollIntervalMs).toBe(2000);
		expect(task.ttlMs).toBe(30 * 60 * 1000 + HOUR);
	});

	it("ids are unique", () => {
		const store = new TaskStore({ maxConcurrent: 100 });
		const ids = new Set(Array.from({ length: 50 }, () => store.create(async () => ok(""))!.taskId));
		expect(ids.size).toBe(50);
	});

	it("completes with the work's result (resultType stripped) and reports exact ttl", async () => {
		const c = clock();
		const store = new TaskStore({ now: c.now });
		const { work, release } = gated({ ...ok("done"), resultType: "complete" });
		const { taskId } = store.create(work)!;
		c.advance(5000);
		release();
		await tick();
		const t = store.get(taskId)!;
		expect(t.status).toBe("completed");
		expect(t.result).toEqual(ok("done"));
		expect(t.ttlMs).toBe(5000 + HOUR);
		expect(Date.parse(t.lastUpdatedAt) - Date.parse(t.createdAt)).toBe(5000);
	});

	it("retains finished tasks for at least an hour, then drops them", async () => {
		const c = clock();
		const store = new TaskStore({ now: c.now, retentionMs: 1000 }); // floored to 1 h
		expect(store.retentionMs).toBe(HOUR);
		const { taskId } = store.create(async () => ok("x"))!;
		await tick();
		c.advance(HOUR - 1);
		expect(store.get(taskId)?.status).toBe("completed");
		c.advance(1);
		expect(store.get(taskId)).toBeUndefined();
		expect(store.size).toBe(0);
	});

	it("does not expire a task that is still working", async () => {
		const c = clock();
		const store = new TaskStore({ now: c.now, maxRunMs: 3 * HOUR });
		const { work } = gated(ok("x"));
		const { taskId } = store.create(work)!;
		c.advance(2 * HOUR);
		expect(store.get(taskId)?.status).toBe("working");
	});

	it("fails and aborts a run that passes maxRunMs", async () => {
		const c = clock();
		const store = new TaskStore({ now: c.now, maxRunMs: 1000 });
		const g = gated(ok("late"));
		const { taskId } = store.create(g.work)!;
		await tick();
		c.advance(1000);
		const t = store.get(taskId)!;
		expect(t.status).toBe("failed");
		expect(t.error?.code).toBe(-32603);
		expect(g.signal()?.aborted).toBe(true);
		g.release();
		await tick();
		expect(store.get(taskId)?.status).toBe("failed");
	});

	it("cancel marks the task cancelled, aborts its signal and discards a late result", async () => {
		const store = new TaskStore();
		const g = gated(ok("late"));
		const { taskId } = store.create(g.work)!;
		await tick();
		expect(store.cancel(taskId)).toBe(true);
		expect(g.signal()?.aborted).toBe(true);
		expect(store.get(taskId)?.status).toBe("cancelled");
		g.release();
		await tick();
		const t = store.get(taskId)!;
		expect(t.status).toBe("cancelled");
		expect(t.result).toBeUndefined();
		// Cancelling a terminal task is an acknowledged no-op; unknown ids are refused.
		expect(store.cancel(taskId)).toBe(true);
		expect(store.cancel("task-unknown")).toBe(false);
	});

	it("a rejection with a JSON-RPC code fails the task with that error", async () => {
		const store = new TaskStore();
		const err = Object.assign(new Error("bad params"), { code: -32602, data: { field: "x" } });
		const { taskId } = store.create(async () => {
			throw err;
		})!;
		await tick();
		const t = store.get(taskId)!;
		expect(t.status).toBe("failed");
		expect(t.error).toEqual({ code: -32602, message: "bad params", data: { field: "x" } });
		expect(t.result).toBeUndefined();
	});

	it("caps concurrent runs; a cancelled run still counts until its work settles", async () => {
		const store = new TaskStore({ maxConcurrent: 2 });
		const a = gated(ok("a"));
		const b = gated(ok("b"));
		const ta = store.create(a.work)!;
		store.create(b.work);
		await tick();
		expect(store.runningCount).toBe(2);
		expect(store.hasCapacity()).toBe(false);
		expect(store.create(async () => ok("c"))).toBeUndefined();
		store.cancel(ta.taskId);
		expect(store.hasCapacity()).toBe(false);
		a.release();
		await tick();
		await tick();
		expect(store.hasCapacity()).toBe(true);
		b.release();
	});

	it("evicts the oldest finished tasks past maxRetained", async () => {
		const store = new TaskStore({ maxRetained: 2, maxConcurrent: 10 });
		const first = store.create(async () => ok("1"))!;
		await tick();
		store.create(async () => ok("2"));
		await tick();
		store.create(async () => ok("3"));
		await tick();
		expect(store.size).toBe(2);
		expect(store.get(first.taskId)).toBeUndefined();
	});

	describe("input_required", () => {
		const ask = (key: string) => ({
			resultType: "input_required",
			inputRequests: { [key]: { method: "elicitation/create", params: { message: "?" } } },
		});

		it("parks on input, ignores unknown keys, and re-runs with the answers", async () => {
			const store = new TaskStore();
			const work = jest.fn(async (_s: AbortSignal, responses?: Record<string, unknown>) =>
				responses?.k ? ok(JSON.stringify(responses.k)) : ask("k"),
			);
			const { taskId } = store.create(work)!;
			await tick();
			let t = store.get(taskId)!;
			expect(t.status).toBe("input_required");
			expect(Object.keys(t.inputRequests!)).toEqual(["k"]);

			expect(store.update(taskId, { other: { action: "accept" } })).toBe(true);
			expect(store.get(taskId)!.status).toBe("input_required");

			expect(store.update(taskId, { k: { action: "accept" } })).toBe(true);
			await tick();
			t = store.get(taskId)!;
			expect(t.status).toBe("completed");
			expect(t.result).toEqual(ok(JSON.stringify({ action: "accept" })));
			expect(work).toHaveBeenCalledTimes(2);
			expect(store.update("task-unknown", {})).toBe(false);
		});

		it("doesn't count time spent waiting for the person against the run limit", async () => {
			const c = clock();
			const store = new TaskStore({ now: c.now, maxRunMs: 30 * 60 * 1000 });
			const work = jest.fn(async (_s: AbortSignal, responses?: Record<string, unknown>) => (responses?.k ? ok("done") : ask("k")));
			const { taskId } = store.create(work)!;
			await tick();
			expect(store.get(taskId)!.status).toBe("input_required");
			c.advance(31 * 60 * 1000); // the person answers 31 minutes later
			expect(store.get(taskId)!.status).toBe("input_required");
			store.update(taskId, { k: { action: "accept" } });
			await tick();
			expect(store.get(taskId)!.status).toBe("completed");
		});

		it("abandons a task whose question is never answered, after the retention period", async () => {
			const c = clock();
			const store = new TaskStore({ now: c.now });
			const { taskId } = store.create(async () => ask("k"))!;
			await tick();
			c.advance(HOUR + 1);
			expect(store.get(taskId)?.status).toBe("cancelled");
		});

		it("fails rather than loop when the work asks again for an answered key", async () => {
			const store = new TaskStore();
			const { taskId } = store.create(async () => ask("k"))!;
			await tick();
			store.update(taskId, { k: { action: "accept" } });
			await tick();
			const t = store.get(taskId)!;
			expect(t.status).toBe("failed");
			expect(t.error?.message).toMatch(/already-answered/);
		});
	});

	it("abortAll cancels live tasks", async () => {
		const store = new TaskStore();
		const g = gated(ok("x"));
		const { taskId } = store.create(g.work)!;
		await tick();
		store.abortAll();
		expect(store.get(taskId)?.status).toBe("cancelled");
		expect(g.signal()?.aborted).toBe(true);
		g.release();
	});
});

describe("per-request gating", () => {
	const env = (caps: unknown) => ({
		mcpReq: { envelope: { "io.modelcontextprotocol/clientCapabilities": caps } },
	});

	it("requires the extension in THIS request's client capabilities", () => {
		expect(requestSupportsTasks(env({ extensions: { [TASKS_EXTENSION_ID]: {} } }))).toBe(true);
		expect(requestSupportsTasks(env({ extensions: {} }))).toBe(false);
		expect(requestSupportsTasks(env({}))).toBe(false);
		expect(requestSupportsTasks({ mcpReq: {} })).toBe(false); // 2025-era: no envelope
		expect(requestSupportsTasks(undefined)).toBe(false); // v1 SDK handler extra
	});

	it("runs synchronously when the store isn't installed on a server", async () => {
		const store = new TaskStore();
		const result = await runAsTaskIfSupported(
			env({ extensions: { [TASKS_EXTENSION_ID]: {} } }),
			async () => ok("sync"),
			{ store },
		);
		expect(result).toEqual(ok("sync"));
		expect(store.size).toBe(0);
	});
});
