/**
 * MCP Tasks pilot, end to end over in-memory transports: a 2026-07-28 client
 * that declares `io.modelcontextprotocol/tasks` gets a task handle and polls
 * tasks/get; a 2026 client without the extension and a 2025-era (v1 SDK)
 * client get the ordinary synchronous result from the same server.
 *
 * The ext-tasks client driver (@modelcontextprotocol/ext-tasks/client) is
 * ESM-only and can't load under this CJS jest setup, so the client side here
 * is the raw wire protocol — the same three calls Claude Code makes.
 */
import { z } from "zod";
import { McpServer as V2McpServer, InMemoryTransport as V2InMemory } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Client as V2Client } from "@modelcontextprotocol/client";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCP_NAME, withToolIdentity } from "../src/core/identity";
import { confirmStep } from "../src/core/confirm";
import { applyToolAnnotations } from "../src/core/tool-annotations";
import { LOCAL_TASK_TOOLS, TASKS_EXTENSION_ID, TaskStore, enableTasksForTools } from "../src/core/tasks";
import { registerDesignSystemTools } from "../src/core/design-system-tools";

const Passthrough = z.object({}).passthrough();

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
};

/** A server shaped like local.ts: identity subclass, tools, annotations, then tasks. */
function buildServer(store: TaskStore) {
	const gates: Deferred[] = [];
	const aborted: boolean[] = [];
	const Identified = withToolIdentity(V2McpServer);
	const server = new Identified({ name: "tasks-test", version: "0" });
	server.registerTool(
		"slow_tool",
		{ description: "slow", inputSchema: z.object({ n: z.number() }) },
		async ({ n }: { n: number }) => {
			const gate = deferred();
			gates.push(gate);
			await gate.promise;
			return { content: [{ type: "text", text: JSON.stringify({ doubled: n * 2 }) }] };
		},
	);
	server.registerTool("slow_throw", { description: "throws" }, async () => {
		throw new Error("bridge went away");
	});
	server.registerTool(
		"slow_confirm",
		{ description: "asks first", inputSchema: z.object({ id: z.string() }) },
		async ({ id }: { id: string }, ctx: unknown) => {
			const step = confirmStep(server as any, ctx as any, `confirm_${id}`, {
				message: `Proceed with ${id}?`,
				fields: { ok: { type: "boolean" } },
			});
			if (step.status === "ask") return step.result;
			return { content: [{ type: "text", text: JSON.stringify({ step: step.status }) }] };
		},
	);
	server.registerTool("fast_tool", { description: "not task-enabled" }, async () => ({
		content: [{ type: "text", text: JSON.stringify({ fast: true }) }],
	}));
	applyToolAnnotations(server);
	const enabled = enableTasksForTools(server, ["slow_tool", "slow_throw", "slow_confirm"], { store });
	return { server, gates, aborted, enabled };
}

/** Serve one server the way local.ts does (serveStdio: both protocol eras), over memory. */
function serve(server: V2McpServer) {
	const [ct, st] = V2InMemory.createLinkedPair();
	serveStdio(() => server, { transport: st });
	return ct;
}

async function connectV2(server: V2McpServer, withTasks: boolean) {
	const ct = serve(server);
	const client = new V2Client(
		{ name: "c", version: "0" },
		{
			capabilities: {
				elicitation: { form: {} },
				...(withTasks ? { extensions: { [TASKS_EXTENSION_ID]: {} } } : {}),
			} as any,
			versionNegotiation: { mode: { pin: "2026-07-28" } },
		},
	);
	await client.connect(ct);
	expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
	return client;
}

/**
 * A wire-level 2026-07-28 client. @modelcontextprotocol/client 2.4.0 decodes a
 * `resultType: "task"` answer as "Unsupported result type 'task'" (it has no
 * tasks driver; ext-tasks drives it through a raw-dispatch seam), so this
 * speaks JSON-RPC directly — every request carries the per-request envelope,
 * as Claude Code's v2 runtime sends it.
 */
class WireClient {
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
	constructor(
		private readonly transport: any,
		private readonly capabilities: Record<string, unknown>,
	) {
		transport.onmessage = (msg: any) => {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(msg.error);
			else p.resolve(msg.result);
		};
	}
	static async connect(server: V2McpServer, capabilities: Record<string, unknown>) {
		const client = new WireClient(serve(server), capabilities);
		await client.transport.start();
		const discovered = await client.request("server/discover", {});
		return { client, discovered };
	}
	request(method: string, params: Record<string, unknown>): Promise<any> {
		const id = this.nextId++;
		const _meta = {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientInfo": { name: "wire", version: "0" },
			"io.modelcontextprotocol/clientCapabilities": this.capabilities,
		};
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.transport.send({ jsonrpc: "2.0", id, method, params: { ...params, _meta } });
		});
	}
	close() {
		return this.transport.close();
	}
}

const TASK_CAPS = { elicitation: { form: {} }, extensions: { [TASKS_EXTENSION_ID]: {} } };
const connectTasks = async (server: V2McpServer) => (await WireClient.connect(server, TASK_CAPS)).client;

const callRaw = (client: WireClient, name: string, args: Record<string, unknown>) =>
	client.request("tools/call", { name, arguments: args });
const tasksGet = (client: WireClient | V2Client, taskId: string): Promise<any> =>
	client instanceof WireClient
		? client.request("tasks/get", { taskId })
		: (client.request({ method: "tasks/get", params: { taskId } } as any, Passthrough) as Promise<any>);

async function pollUntilTerminal(client: WireClient, taskId: string, tries = 50) {
	for (let i = 0; i < tries; i++) {
		const t = await tasksGet(client, taskId);
		if (["completed", "failed", "cancelled"].includes(t.status)) return t;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("task never finished");
}

const waitFor = async (cond: () => boolean) => {
	for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
	expect(cond()).toBe(true);
};

describe("MCP tasks — client declares the extension", () => {
	it("advertises the extension and keeps annotations on task-enabled tools", async () => {
		const { server, enabled } = buildServer(new TaskStore());
		expect(enabled).toEqual(["slow_tool", "slow_throw", "slow_confirm"]);
		const client = await connectV2(server, true);
		expect((client.getServerCapabilities() as any)?.extensions?.[TASKS_EXTENSION_ID]).toEqual({});
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(["fast_tool", "slow_confirm", "slow_throw", "slow_tool"]);
		await client.close();

		// Same answer on the wire, through server/discover.
		const wire = await WireClient.connect(buildServer(new TaskStore()).server, TASK_CAPS);
		expect(wire.discovered.capabilities.extensions[TASKS_EXTENSION_ID]).toEqual({});
		await wire.client.close();
	});

	it("returns a task, then tasks/get delivers the stamped result", async () => {
		const { server, gates } = buildServer(new TaskStore());
		const client = await connectTasks(server);

		const handle = await callRaw(client, "slow_tool", { n: 21 });
		expect(handle.resultType).toBe("task");
		expect(handle.taskId).toMatch(/^task-[0-9a-f]{32}$/);
		expect(handle.status).toBe("working");
		expect(typeof handle.createdAt).toBe("string");
		expect(typeof handle.lastUpdatedAt).toBe("string");
		expect(handle.ttlMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
		expect(handle.pollIntervalMs).toBe(2000);
		// The SDK adds an empty `content` to every contentless tools/call result; the discriminator is resultType.

		// Persisted before the response: the first poll already resolves.
		const working = await tasksGet(client, handle.taskId);
		expect(working.status).toBe("working");
		expect(working.resultType).toBe("complete");

		await waitFor(() => gates.length === 1);
		gates[0].resolve();
		const done = await pollUntilTerminal(client, handle.taskId);
		expect(done.status).toBe("completed");
		expect(JSON.parse(done.result.content[0].text)).toEqual({ _mcp: MCP_NAME, doubled: 42 });
		// Still answerable after completion (retained >= 1 h).
		expect((await tasksGet(client, handle.taskId)).status).toBe("completed");
		await client.close();
	});

	it("cancels a running task", async () => {
		const { server, gates } = buildServer(new TaskStore());
		const client = await connectTasks(server);
		const handle = await callRaw(client, "slow_tool", { n: 1 });
		const ack = await client.request("tasks/cancel", { taskId: handle.taskId });
		expect(ack).toMatchObject({ resultType: "complete" });
		const after = await tasksGet(client, handle.taskId);
		expect(after.status).toBe("cancelled");
		// The late result is discarded: the task stays cancelled.
		await waitFor(() => gates.length === 1);
		gates[0].resolve();
		await new Promise((r) => setTimeout(r, 20));
		const final = await tasksGet(client, handle.taskId);
		expect(final.status).toBe("cancelled");
		expect(final).not.toHaveProperty("result");
		await client.close();
	});

	it("turns a thrown tool error into a completed isError result, like a sync call", async () => {
		const { server } = buildServer(new TaskStore());
		const client = await connectTasks(server);
		const handle = await callRaw(client, "slow_throw", {});
		expect(handle.resultType).toBe("task");
		const done = await pollUntilTerminal(client, handle.taskId);
		expect(done.status).toBe("completed");
		expect(done.result.isError).toBe(true);
		expect(done.result.content[0].text).toBe("[figma-console-mcp] bridge went away");
		await client.close();
	});

	it("surfaces an elicitation as input_required and finishes after tasks/update", async () => {
		const { server } = buildServer(new TaskStore());
		const client = await connectTasks(server);
		const handle = await callRaw(client, "slow_confirm", { id: "x" });
		expect(handle.resultType).toBe("task");
		let t: any;
		for (let i = 0; i < 50; i++) {
			t = await tasksGet(client, handle.taskId);
			if (t.status !== "working") break;
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(t.status).toBe("input_required");
		expect(t.inputRequests.confirm_x.method).toBe("elicitation/create");
		const ack = await client.request("tasks/update", {
			taskId: handle.taskId,
			// An unknown key is ignored, per spec.
			inputResponses: { confirm_x: { action: "accept", content: { ok: true } }, bogus: {} },
		});
		expect(ack).toMatchObject({ resultType: "complete" });
		const done = await pollUntilTerminal(client, handle.taskId);
		expect(done.status).toBe("completed");
		expect(JSON.parse(done.result.content[0].text)).toEqual({ _mcp: MCP_NAME, step: "accepted" });
		await client.close();
	});

	it("answers an unknown task id with -32602", async () => {
		const { server } = buildServer(new TaskStore());
		const client = await connectTasks(server);
		await expect(tasksGet(client, "task-nope")).rejects.toMatchObject({ code: -32602 });
		await client.close();
	});

	it("keeps tools that didn't opt in synchronous", async () => {
		const { server } = buildServer(new TaskStore());
		const client = await connectV2(server, true);
		const r: any = await client.callTool({ name: "fast_tool", arguments: {} });
		expect(JSON.parse(r.content[0].text)).toEqual({ _mcp: MCP_NAME, fast: true });
		await client.close();
	});

	it("falls back to synchronous when the concurrency cap is reached", async () => {
		const { server, gates } = buildServer(new TaskStore({ maxConcurrent: 1 }));
		const client = await connectTasks(server);
		const first = await callRaw(client, "slow_tool", { n: 1 });
		expect(first.resultType).toBe("task");
		const second = callRaw(client, "slow_tool", { n: 2 });
		await waitFor(() => gates.length === 2);
		gates[1].resolve();
		const sync = await second;
		expect(sync.resultType).not.toBe("task");
		expect(JSON.parse(sync.content[0].text)).toEqual({ _mcp: MCP_NAME, doubled: 4 });
		gates[0].resolve();
		await client.close();
	});
});

describe("MCP tasks — the real figma_get_design_system_kit", () => {
	it("answers as a task and completes with the kit", async () => {
		const Identified = withToolIdentity(V2McpServer);
		const server = new Identified({ name: "kit", version: "0" });
		const gate = deferred();
		const api = {
			getLocalVariables: jest.fn().mockResolvedValue({ variableCollections: {}, variables: {} }),
			getComponents: jest.fn().mockImplementation(async () => {
				await gate.promise; // a slow crawl
				return { meta: { components: [] } };
			}),
			getComponentSets: jest.fn().mockResolvedValue({ meta: { component_sets: [] } }),
			getStyles: jest.fn().mockResolvedValue({ meta: { styles: [] } }),
			getNodes: jest.fn().mockResolvedValue({ nodes: {} }),
			getImages: jest.fn().mockResolvedValue({ images: {} }),
		};
		registerDesignSystemTools(server, async () => api as any, () => "https://www.figma.com/design/abc123/X");
		applyToolAnnotations(server);
		// Only the kit is registered here (the audit tool's module is ESM-only under jest).
		expect(enableTasksForTools(server, LOCAL_TASK_TOOLS, { store: new TaskStore() })).toEqual([
			"figma_get_design_system_kit",
		]);

		const client = await connectTasks(server);
		const listed = await client.request("tools/list", {});
		const kitTool = listed.tools.find((t: any) => t.name === "figma_get_design_system_kit");
		expect(kitTool.annotations.readOnlyHint).toBe(true);

		const handle = await callRaw(client, "figma_get_design_system_kit", { fileKey: "abc123" });
		expect(handle.resultType).toBe("task");
		expect((await tasksGet(client, handle.taskId)).status).toBe("working");
		gate.resolve();
		const done = await pollUntilTerminal(client, handle.taskId);
		expect(done.status).toBe("completed");
		const body = JSON.parse(done.result.content[0].text);
		expect(body._mcp).toBe(MCP_NAME);
		expect(body.fileKey).toBe("abc123");
		await client.close();
	});
});

describe("MCP tasks — clients that don't declare the extension", () => {
	it("a 2026-07-28 client without the extension gets a synchronous result", async () => {
		const { server, gates } = buildServer(new TaskStore());
		const client = await connectV2(server, false);
		const pending = client.callTool({ name: "slow_tool", arguments: { n: 5 } });
		await waitFor(() => gates.length === 1);
		gates[0].resolve();
		const r: any = await pending;
		expect(r.resultType).toBeUndefined();
		expect(JSON.parse(r.content[0].text)).toEqual({ _mcp: MCP_NAME, doubled: 10 });
		// …and may not poke at tasks either.
		await expect(tasksGet(client, "task-x")).rejects.toMatchObject({ code: -32021 });
		await client.close();
	});

	it("a 2025-era (v1 SDK) client gets a synchronous result", async () => {
		const { server, gates } = buildServer(new TaskStore());
		const client = new V1Client({ name: "legacy", version: "0" });
		await client.connect(serve(server) as any);
		const pending = client.callTool({ name: "slow_tool", arguments: { n: 7 } });
		await waitFor(() => gates.length === 1);
		gates[0].resolve();
		const r: any = await pending;
		expect(r.resultType).toBeUndefined();
		expect(JSON.parse(r.content[0].text)).toEqual({ _mcp: MCP_NAME, doubled: 14 });
		await client.close();
	});
});
