/**
 * MCP Tasks (`io.modelcontextprotocol/tasks`, protocol revision 2026-07-28).
 *
 * A slow tool call can answer with a task handle instead of blocking: the
 * client gets `{ resultType: "task", taskId, status, ... }` at once and polls
 * `tasks/get` until the task is terminal, so long runs don't hit client or
 * transport timeouts. Claude Code only calls `tasks/get` (and `tasks/cancel`
 * when the person stops a task), so the outcome always rides on `tasks/get`.
 *
 * Gating is per REQUEST, as the spec requires: a task is returned only when
 * the current request's `_meta["io.modelcontextprotocol/clientCapabilities"]`
 * lists the extension AND this process has installed the task methods on the
 * server (installTasks). Everything else — 2025-era clients, 2026 clients
 * without the extension, the Cloudflare (v1 SDK) build — gets the ordinary
 * synchronous result.
 *
 * The store is in memory and process-wide: the optional local HTTP endpoint
 * builds one McpServer per session, and a resumed client may ask about a task
 * on a new connection, so the store must outlive any single server instance.
 * Tasks do NOT survive a server restart (stdio servers end with the client
 * anyway).
 *
 * Opting a tool in is one call after registration:
 *
 *   enableTasksForTools(server, ["figma_get_design_system_kit"]);
 *
 * or, inside a handler, `return runAsTaskIfSupported(ctx, (signal) => work())`.
 *
 * Type-only SDK import: nothing here pulls v2 runtime code, so shared modules
 * may import runAsTaskIfSupported without breaking the Worker bundle.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { stampToolResult } from "./identity.js";

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

/**
 * Local-mode tools that answer as tasks when the client supports it: both
 * crawl the whole file through the bridge and can run for minutes on large
 * libraries. Add a name here to opt another tool in.
 */
export const LOCAL_TASK_TOOLS: readonly string[] = [
	"figma_get_design_system_kit",
	"figma_audit_design_system_report",
];
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/** JSON-RPC codes the tasks spec names. */
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

type InputRequests = Record<string, { method: string; params?: unknown }>;

/** The wire Task (DetailedTask) without `resultType`, which each method adds. */
export interface TaskView {
	taskId: string;
	status: TaskStatus;
	statusMessage?: string;
	createdAt: string;
	lastUpdatedAt: string;
	ttlMs: number | null;
	pollIntervalMs?: number;
	result?: Record<string, unknown>;
	error?: JsonRpcErrorObject;
	inputRequests?: InputRequests;
}

/**
 * The task's work. `signal` aborts on tasks/cancel or when the run exceeds
 * maxRunMs — cancellation is cooperative, so work that can't stop simply has
 * its eventual result discarded. `inputResponses` is set when the work is
 * re-run after the client answered an input_required round (all answers so
 * far, keyed as the work asked).
 */
export type TaskWork = (
	signal: AbortSignal,
	inputResponses?: Record<string, unknown>,
) => Promise<unknown>;

interface TaskRecord {
	taskId: string;
	status: TaskStatus;
	statusMessage?: string;
	createdAtMs: number;
	updatedAtMs: number;
	finishedAtMs?: number;
	result?: Record<string, unknown>;
	error?: JsonRpcErrorObject;
	inputRequests?: InputRequests;
	answered: Record<string, unknown>;
	controller: AbortController;
	work: TaskWork;
	/** True while a run of `work` is in flight (counts toward maxConcurrent). */
	running: boolean;
	runTimer?: ReturnType<typeof setTimeout>;
}

export interface TaskStoreOptions {
	/** Keep a finished task (and its result) this long after it finishes. Default 1 hour; floor 1 hour. */
	retentionMs?: number;
	/** Abort and fail a run that takes longer than this. Default 30 minutes. */
	maxRunMs?: number;
	/** Runs in flight at once; past this, callers fall back to synchronous. Default 4. */
	maxConcurrent?: number;
	/** Tasks remembered at once (oldest finished ones are evicted first). Default 200. */
	maxRetained?: number;
	/** Suggested tasks/get interval. Default 2000 (Claude Code's own default; it clamps to 250..30000). */
	pollIntervalMs?: number;
	/** Clock, for tests. */
	now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;

/** Error thrown from request handlers; the SDK serializes `code`/`message`/`data`. */
class TaskProtocolError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
	}
}

/** 128 bits from the platform CSPRNG (Node 20+ and Workers both expose Web Crypto). */
function newTaskId(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return `task-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A work rejection that carries a JSON-RPC error shape (e.g. the SDK's ProtocolError). */
function toJsonRpcError(err: unknown): JsonRpcErrorObject {
	const code = (err as { code?: unknown })?.code;
	const message = err instanceof Error ? err.message : String(err);
	const data = (err as { data?: unknown })?.data;
	return {
		code: Number.isSafeInteger(code) ? (code as number) : INTERNAL_ERROR,
		message: message || "Internal error",
		...(data !== undefined ? { data } : {}),
	};
}

export class TaskStore {
	readonly retentionMs: number;
	readonly maxRunMs: number;
	readonly maxConcurrent: number;
	readonly maxRetained: number;
	readonly pollIntervalMs: number;
	private readonly now: () => number;
	private readonly tasks = new Map<string, TaskRecord>();

	constructor(options: TaskStoreOptions = {}) {
		this.retentionMs = Math.max(options.retentionMs ?? HOUR_MS, HOUR_MS);
		this.maxRunMs = options.maxRunMs ?? 30 * 60 * 1000;
		this.maxConcurrent = options.maxConcurrent ?? 4;
		this.maxRetained = options.maxRetained ?? 200;
		this.pollIntervalMs = options.pollIntervalMs ?? 2000;
		this.now = options.now ?? Date.now;
	}

	/** Runs in flight right now (a cancelled run still counts until its work settles). */
	get runningCount(): number {
		let n = 0;
		for (const t of this.tasks.values()) if (t.running) n++;
		return n;
	}

	get size(): number {
		return this.tasks.size;
	}

	/** True when a new task could start now. */
	hasCapacity(): boolean {
		this.sweep();
		return this.runningCount < this.maxConcurrent;
	}

	/**
	 * Create a task and start its work. The record is in the store before this
	 * returns, so a tasks/get for the id resolves immediately (the spec's
	 * "durably created before responding"). Returns undefined when at the
	 * concurrency cap — the caller should run the work synchronously instead.
	 */
	create(work: TaskWork, options: { statusMessage?: string } = {}): TaskView | undefined {
		if (!this.hasCapacity()) return undefined;
		const now = this.now();
		const record: TaskRecord = {
			// 128 bits from the CSPRNG: ids are bearer handles, so they must not be guessable.
			taskId: newTaskId(),
			status: "working",
			statusMessage: options.statusMessage,
			createdAtMs: now,
			updatedAtMs: now,
			answered: {},
			controller: new AbortController(),
			work,
			running: false,
		};
		this.tasks.set(record.taskId, record);
		this.evictOverflow();
		this.run(record);
		return this.view(record);
	}

	get(taskId: string): TaskView | undefined {
		this.sweep();
		const record = this.tasks.get(taskId);
		return record ? this.view(record) : undefined;
	}

	/**
	 * Cancel a task. A non-terminal task becomes `cancelled` at once and its
	 * signal aborts; a result that arrives later is discarded. Returns false for
	 * an unknown id; cancelling a terminal task is an acknowledged no-op.
	 */
	cancel(taskId: string): boolean {
		this.sweep();
		const record = this.tasks.get(taskId);
		if (!record) return false;
		if (TERMINAL.has(record.status)) return true;
		this.finish(record, { status: "cancelled", statusMessage: "Cancelled by the client." });
		record.controller.abort(new Error("Task cancelled"));
		return true;
	}

	/**
	 * tasks/update: record answers for outstanding inputRequests. Unknown or
	 * already-answered keys are ignored (spec). Once every outstanding key is
	 * answered the task returns to `working` and the work re-runs with all
	 * answers. Returns false for an unknown id.
	 */
	update(taskId: string, inputResponses: Record<string, unknown>): boolean {
		this.sweep();
		const record = this.tasks.get(taskId);
		if (!record) return false;
		if (record.status !== "input_required" || !record.inputRequests) return true;
		for (const [key, value] of Object.entries(inputResponses ?? {})) {
			if (key in record.inputRequests && !(key in record.answered)) record.answered[key] = value;
		}
		const outstanding = Object.keys(record.inputRequests).filter((k) => !(k in record.answered));
		if (outstanding.length > 0) return true;
		record.inputRequests = undefined;
		record.status = "working";
		record.statusMessage = undefined;
		record.updatedAtMs = this.now();
		this.run(record);
		return true;
	}

	/** Drop finished tasks past retention, and fail runs past maxRunMs. */
	sweep(): void {
		const now = this.now();
		for (const [id, record] of this.tasks) {
			if (record.finishedAtMs !== undefined) {
				if (now - record.finishedAtMs >= this.retentionMs) this.tasks.delete(id);
			} else if (now - record.createdAtMs >= this.maxRunMs) {
				this.timeOut(record);
			}
		}
	}

	/** Abort every live run (server shutdown). */
	abortAll(): void {
		for (const record of this.tasks.values()) {
			if (!TERMINAL.has(record.status)) {
				this.finish(record, { status: "cancelled", statusMessage: "The server shut down." });
				record.controller.abort(new Error("Server shutting down"));
			}
		}
	}

	private timeOut(record: TaskRecord): void {
		if (TERMINAL.has(record.status)) return;
		const minutes = Math.round(this.maxRunMs / 60000);
		this.finish(record, {
			status: "failed",
			error: { code: INTERNAL_ERROR, message: `Task exceeded the ${minutes}-minute run limit and was stopped.` },
			statusMessage: "Timed out.",
		});
		record.controller.abort(new Error("Task timed out"));
	}

	private run(record: TaskRecord): void {
		record.running = true;
		const answers = Object.keys(record.answered).length > 0 ? { ...record.answered } : undefined;
		// The run timer is unref'd so an idle server can still exit.
		record.runTimer = setTimeout(
			() => this.timeOut(record),
			Math.max(0, record.createdAtMs + this.maxRunMs - this.now()),
		);
		record.runTimer.unref?.();
		Promise.resolve()
			.then(() => record.work(record.controller.signal, answers))
			.then(
				(result) => this.settle(record, result),
				(err) => this.settleError(record, err),
			)
			.finally(() => {
				record.running = false;
				if (record.runTimer) clearTimeout(record.runTimer);
				record.runTimer = undefined;
			});
	}

	private settle(record: TaskRecord, result: unknown): void {
		if (TERMINAL.has(record.status)) return; // cancelled or timed out meanwhile: discard
		if (isPlainObject(result) && result.resultType === "input_required") {
			const requests = isPlainObject(result.inputRequests) ? (result.inputRequests as InputRequests) : {};
			const keys = Object.keys(requests);
			const reused = keys.filter((k) => k in record.answered);
			if (keys.length === 0 || reused.length > 0) {
				// Keys must be unique over a task's lifetime; asking again for an
				// answered key would loop forever.
				this.finish(record, {
					status: "failed",
					error: {
						code: INTERNAL_ERROR,
						message: keys.length === 0
							? "Tool asked for input but sent no input requests."
							: `Tool asked again for already-answered input: ${reused.join(", ")}`,
					},
				});
				return;
			}
			record.status = "input_required";
			record.inputRequests = requests;
			record.statusMessage = "Waiting for your answer.";
			record.updatedAtMs = this.now();
			return;
		}
		const { resultType: _ignored, ...rest } = isPlainObject(result) ? result : { content: [] };
		this.finish(record, { status: "completed", result: rest });
	}

	private settleError(record: TaskRecord, err: unknown): void {
		if (TERMINAL.has(record.status)) return;
		const error = toJsonRpcError(err);
		this.finish(record, { status: "failed", error, statusMessage: error.message });
	}

	private finish(
		record: TaskRecord,
		outcome: {
			status: "completed" | "failed" | "cancelled";
			result?: Record<string, unknown>;
			error?: JsonRpcErrorObject;
			statusMessage?: string;
		},
	): void {
		const now = this.now();
		record.status = outcome.status;
		record.result = outcome.result;
		record.error = outcome.error;
		record.statusMessage = outcome.statusMessage;
		record.inputRequests = undefined;
		record.updatedAtMs = now;
		record.finishedAtMs = now;
		// Don't hold the closure (and whatever it captured) for an hour.
		record.work = async () => undefined;
	}

	private evictOverflow(): void {
		if (this.tasks.size <= this.maxRetained) return;
		const finished = [...this.tasks.values()]
			.filter((t) => t.finishedAtMs !== undefined)
			.sort((a, b) => (a.finishedAtMs ?? 0) - (b.finishedAtMs ?? 0));
		while (this.tasks.size > this.maxRetained && finished.length > 0) {
			this.tasks.delete(finished.shift()!.taskId);
		}
	}

	private view(record: TaskRecord): TaskView {
		// ttlMs counts from creation: while live, the run limit plus retention;
		// once finished, exactly when the record will be dropped.
		const ttlMs =
			record.finishedAtMs !== undefined
				? record.finishedAtMs - record.createdAtMs + this.retentionMs
				: this.maxRunMs + this.retentionMs;
		return {
			taskId: record.taskId,
			status: record.status,
			...(record.statusMessage !== undefined ? { statusMessage: record.statusMessage } : {}),
			createdAt: new Date(record.createdAtMs).toISOString(),
			lastUpdatedAt: new Date(record.updatedAtMs).toISOString(),
			ttlMs,
			pollIntervalMs: this.pollIntervalMs,
			...(record.status === "completed" && record.result ? { result: record.result } : {}),
			...(record.status === "failed" && record.error ? { error: record.error } : {}),
			...(record.status === "input_required" && record.inputRequests
				? { inputRequests: record.inputRequests }
				: {}),
		};
	}
}

/** Process-wide store shared by every McpServer this process builds. */
export const defaultTaskStore = new TaskStore();

/** Stores whose tasks/* methods are installed on at least one server. */
const installedStores = new WeakSet<TaskStore>();

/** Minimal view of the v2 handler context (absent on the v1 SDK). */
type HandlerCtx =
	| {
			mcpReq?: {
				envelope?: Record<string, unknown>;
				inputResponses?: Record<string, unknown>;
				[key: string]: unknown;
			};
			[key: string]: unknown;
	  }
	| undefined;

/** True when THIS request's client capabilities declare the tasks extension. */
export function requestSupportsTasks(ctx: unknown): boolean {
	const caps = (ctx as HandlerCtx)?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY] as
		| { extensions?: Record<string, unknown> }
		| undefined;
	const ext = caps?.extensions;
	return isPlainObject(ext) && TASKS_EXTENSION_ID in ext;
}

/**
 * Declare the extension and serve tasks/get, tasks/update and tasks/cancel on
 * one server, backed by `store`. Call before connecting. Idempotent per server.
 */
export function installTasks(mcp: McpServer, store: TaskStore = defaultTaskStore): void {
	const marker = mcp as unknown as { __figmaTasksInstalled?: boolean };
	if (marker.__figmaTasksInstalled) return;
	const server = mcp.server;

	const requireExtension = (ctx: unknown) => {
		if (!requestSupportsTasks(ctx)) {
			throw new TaskProtocolError(MISSING_REQUIRED_CLIENT_CAPABILITY, "Missing required client capability", {
				requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } },
			});
		}
	};
	const unknownTask = (taskId: string) =>
		new TaskProtocolError(INVALID_PARAMS, `Unknown or expired task: ${taskId}`);

	const TaskIdParams = z.object({ taskId: z.string() }).passthrough();
	// The v2 SDK lifts `inputResponses` out of every request's params into
	// ctx.mcpReq.inputResponses (its multi-round-trip handling), so tasks/update
	// reads them from there; params is the fallback for other dispatch paths.
	const UpdateParams = z
		.object({ taskId: z.string(), inputResponses: z.record(z.string(), z.unknown()).optional() })
		.passthrough();

	server.setRequestHandler("tasks/get", { params: TaskIdParams }, (params, ctx) => {
		requireExtension(ctx);
		const task = store.get(params.taskId);
		if (!task) throw unknownTask(params.taskId);
		return { resultType: "complete", ...task } as never;
	});
	server.setRequestHandler("tasks/update", { params: UpdateParams }, (params, ctx) => {
		requireExtension(ctx);
		const responses =
			params.inputResponses ?? (ctx as HandlerCtx)?.mcpReq?.inputResponses ?? {};
		if (!store.update(params.taskId, responses)) throw unknownTask(params.taskId);
		return { resultType: "complete" } as never;
	});
	server.setRequestHandler("tasks/cancel", { params: TaskIdParams }, (params, ctx) => {
		requireExtension(ctx);
		if (!store.cancel(params.taskId)) throw unknownTask(params.taskId);
		return { resultType: "complete" } as never;
	});
	server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } } as never);
	marker.__figmaTasksInstalled = true;
	installedStores.add(store);
}

/**
 * Run tool work as a task when this request allows it, else synchronously.
 *
 * Returns either a CreateTaskResult (the client will poll tasks/get) or the
 * work's own result, exactly as a non-task call would. The task's final
 * result is stamped like any tool result (`_mcp`, size cap). A plain Error
 * thrown by the work becomes an `isError` tool result — what the SDK does for
 * a synchronous call — while an error carrying a JSON-RPC `code` fails the
 * task (spec: `failed` is for protocol errors only).
 */
export async function runAsTaskIfSupported(
	ctx: unknown,
	work: (signal: AbortSignal, ctx: unknown) => Promise<unknown>,
	options: { store?: TaskStore; statusMessage?: string } = {},
): Promise<unknown> {
	const store = options.store ?? defaultTaskStore;
	const neverAborted = new AbortController().signal;
	if (!installedStores.has(store) || !requestSupportsTasks(ctx) || !store.hasCapacity()) {
		return work(neverAborted, ctx);
	}
	const task = store.create(
		async (signal, inputResponses) => {
			const runCtx = inputResponses ? withInputResponses(ctx, inputResponses) : ctx;
			try {
				return stampToolResult(await work(signal, runCtx));
			} catch (err) {
				if (Number.isSafeInteger((err as { code?: unknown })?.code)) throw err;
				return stampToolResult({
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				});
			}
		},
		{ statusMessage: options.statusMessage },
	);
	if (!task) return work(neverAborted, ctx);
	return { resultType: "task", ...task };
}

/** A copy of the handler context whose mcpReq carries `inputResponses` (MRTR re-entry). */
function withInputResponses(ctx: unknown, inputResponses: Record<string, unknown>): unknown {
	const c = (ctx ?? {}) as Record<string, unknown>;
	const mcpReq = (c.mcpReq ?? {}) as Record<string, unknown>;
	return { ...c, mcpReq: { ...mcpReq, inputResponses } };
}

/**
 * Opt registered tools into tasks: each named tool's callback is wrapped with
 * runAsTaskIfSupported, and the tasks methods are installed on the server.
 * Tools with an outputSchema are skipped (the SDK would reject a task handle
 * that has no structuredContent). Returns the names actually enabled.
 */
export function enableTasksForTools(
	mcp: McpServer,
	toolNames: readonly string[],
	options: { store?: TaskStore } = {},
): string[] {
	const store = options.store ?? defaultTaskStore;
	const registry = (mcp as unknown as {
		_registeredTools?: Record<
			string,
			{
				handler: (...args: unknown[]) => unknown;
				inputSchema?: unknown;
				outputSchema?: unknown;
				update(u: { callback: (...args: unknown[]) => unknown }): void;
			}
		>;
	})._registeredTools;
	if (!registry) return [];
	installTasks(mcp, store);
	const enabled: string[] = [];
	for (const name of toolNames) {
		const tool = registry[name];
		if (!tool || tool.outputSchema !== undefined) continue;
		const inner = tool.handler;
		const hasArgs = tool.inputSchema !== undefined;
		const statusMessage = `Running ${name}…`;
		// v2 calls (args, ctx) when the tool has an input schema, else (ctx).
		const wrapped = hasArgs
			? (args: unknown, ctx: unknown) =>
					runAsTaskIfSupported(ctx, (_signal, runCtx) => Promise.resolve(inner(args, runCtx)), {
						store,
						statusMessage,
					})
			: (ctx: unknown) =>
					runAsTaskIfSupported(ctx, (_signal, runCtx) => Promise.resolve(inner(runCtx)), {
						store,
						statusMessage,
					});
		tool.update({ callback: wrapped as (...args: unknown[]) => unknown });
		enabled.push(name);
	}
	return enabled;
}
