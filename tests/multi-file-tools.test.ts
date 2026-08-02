/**
 * Multi-File Tools Tests
 *
 * Unit tests for registerMultiFileTools() — figma_execute_across_files fans
 * a single script out to every (or a chosen subset of) connected Desktop
 * Bridge files concurrently, without touching the active file/target lock.
 */

import { registerMultiFileTools } from "../src/core/multi-file-tools";

// ============================================================================
// Mock infrastructure
// ============================================================================

interface RegisteredTool {
	name: string;
	description: string;
	schema: any;
	handler: (args: any) => Promise<any>;
}

function createMockServer() {
	const tools: Record<string, RegisteredTool> = {};
	return {
		tool: jest.fn(
			(name: string, description: string, schema: any, handler: any) => {
				tools[name] = { name, description, schema, handler };
			},
		),
		_tools: tools,
		_getTool(name: string): RegisteredTool {
			return tools[name];
		},
	};
}

function connectedFile(fileKey: string, fileName: string, isActive = false) {
	return { fileKey, fileName, currentPage: "Page 1", connectedAt: Date.now(), isActive };
}

function createMockWsServer(files: ReturnType<typeof connectedFile>[]) {
	return {
		isClientConnected: jest.fn().mockReturnValue(files.length > 0),
		getConnectedFiles: jest.fn().mockReturnValue(files),
	};
}

function parseResult(result: any): any {
	return JSON.parse(result.content[0].text);
}

// ============================================================================
// Tests
// ============================================================================

describe("Multi-File Tools", () => {
	let server: ReturnType<typeof createMockServer>;

	beforeEach(() => {
		server = createMockServer();
	});

	it("registers exactly 1 tool", () => {
		const wsServer = createMockWsServer([]);
		registerMultiFileTools(server as any, () => wsServer as any, async () => ({}));
		expect(server.tool).toHaveBeenCalledTimes(1);
		expect(server._getTool("figma_execute_across_files")).toBeDefined();
	});

	describe("figma_execute_across_files", () => {
		it("errors when no files are connected", async () => {
			const wsServer = createMockWsServer([]);
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({}));
			const tool = server._getTool("figma_execute_across_files");

			const result = await tool.handler({ code: "return 1", timeout: 5000 });

			expect(result.isError).toBe(true);
			expect(parseResult(result).error).toContain("No files connected");
		});

		it("refuses to fan out when neither fileKeys nor allFiles is given", async () => {
			const files = [connectedFile("file-a", "Nova", true), connectedFile("file-b", "Vega")];
			const wsServer = createMockWsServer(files);
			const executeCodeViaUI = jest.fn().mockResolvedValue({ success: true, result: null });
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({ executeCodeViaUI }));
			const tool = server._getTool("figma_execute_across_files");

			const result = await tool.handler({ code: "figma.root.children[0].remove();", timeout: 5000 });
			const parsed = parseResult(result);

			// Nothing may execute — targeting every open file has to be asked for.
			expect(executeCodeViaUI).not.toHaveBeenCalled();
			expect(result.isError).toBe(true);
			expect(parsed.error).toContain("No target files specified");
			expect(parsed.connectedFiles).toEqual([
				{ fileKey: "file-a", fileName: "Nova", isActive: true },
				{ fileKey: "file-b", fileName: "Vega", isActive: false },
			]);
		});

		it("skips connected files that report no fileKey instead of hitting the active file", async () => {
			const files = [
				connectedFile("file-a", "Nova", true),
				{ ...connectedFile("", "Unidentified"), fileKey: null },
			];
			const wsServer = createMockWsServer(files as any);
			const executeCodeViaUI = jest.fn().mockResolvedValue({ success: true, result: null });
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({ executeCodeViaUI }));
			const tool = server._getTool("figma_execute_across_files");

			const result = await tool.handler({ code: "return 1;", allFiles: true, timeout: 5000 });
			const parsed = parseResult(result);

			// A null fileKey would fall through to sendCommand's active-file
			// default and silently run the code against file-a a second time.
			expect(executeCodeViaUI).toHaveBeenCalledTimes(1);
			expect(executeCodeViaUI).toHaveBeenCalledWith("return 1;", 5000, "file-a");
			expect(parsed.totalTargeted).toBe(1);
			expect(parsed.skippedUnidentifiedFiles).toEqual(["Unidentified"]);
		});

		it("returns the plugin-reported fileContext so targeting can be verified", async () => {
			const files = [connectedFile("file-a", "Nova")];
			const wsServer = createMockWsServer(files);
			const executeCodeViaUI = jest.fn().mockResolvedValue({
				success: true,
				result: null,
				fileContext: { fileName: "Nova", fileKey: "file-a" },
			});
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({ executeCodeViaUI }));
			const tool = server._getTool("figma_execute_across_files");

			const result = await tool.handler({ code: "return 1;", fileKeys: ["file-a"], timeout: 5000 });

			expect(parseResult(result).results["file-a"].fileContext).toEqual({
				fileName: "Nova",
				fileKey: "file-a",
			});
		});

		it("runs code against every connected file when allFiles is true", async () => {
			const files = [
				connectedFile("file-a", "Nova", true),
				connectedFile("file-b", "Vega"),
				connectedFile("file-c", "Luma"),
			];
			const wsServer = createMockWsServer(files);
			const executeCodeViaUI = jest.fn().mockResolvedValue({ success: true, result: { pages: 5 } });
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({ executeCodeViaUI }));
			const tool = server._getTool("figma_execute_across_files");

			const result = await tool.handler({ code: "return { pages: 5 };", allFiles: true, timeout: 5000 });
			const parsed = parseResult(result);

			expect(executeCodeViaUI).toHaveBeenCalledTimes(3);
			expect(executeCodeViaUI).toHaveBeenCalledWith("return { pages: 5 };", 5000, "file-a");
			expect(executeCodeViaUI).toHaveBeenCalledWith("return { pages: 5 };", 5000, "file-b");
			expect(executeCodeViaUI).toHaveBeenCalledWith("return { pages: 5 };", 5000, "file-c");
			expect(parsed.totalTargeted).toBe(3);
			expect(parsed.totalSucceeded).toBe(3);
			expect(parsed.totalFailed).toBe(0);
			expect(parsed.results["file-a"]).toEqual({
				fileName: "Nova",
				success: true,
				result: { pages: 5 },
				error: undefined,
			});
		});

		it("dispatches concurrently, not sequentially", async () => {
			const files = [connectedFile("file-a", "Nova"), connectedFile("file-b", "Vega")];
			const wsServer = createMockWsServer(files);
			const order: string[] = [];
			const executeCodeViaUI = jest.fn((code: string, timeout: number, fileKey?: string) => {
				order.push(`start:${fileKey}`);
				const delay = fileKey === "file-a" ? 20 : 5;
				return new Promise((resolve) =>
					setTimeout(() => {
						order.push(`end:${fileKey}`);
						resolve({ success: true, result: null });
					}, delay),
				);
			});
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({ executeCodeViaUI }));
			const tool = server._getTool("figma_execute_across_files");

			await tool.handler({ code: "return 1;", allFiles: true, timeout: 5000 });

			// Both dispatches fire before either resolves — file-b (shorter
			// delay) finishes before file-a, which is impossible if the calls
			// were serialized file-a-then-file-b.
			expect(order).toEqual(["start:file-a", "start:file-b", "end:file-b", "end:file-a"]);
		});

		it("only targets the requested fileKeys when provided", async () => {
			const files = [
				connectedFile("file-a", "Nova"),
				connectedFile("file-b", "Vega"),
				connectedFile("file-c", "Luma"),
			];
			const wsServer = createMockWsServer(files);
			const executeCodeViaUI = jest.fn().mockResolvedValue({ success: true, result: null });
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({ executeCodeViaUI }));
			const tool = server._getTool("figma_execute_across_files");

			const result = await tool.handler({
				code: "return 1;",
				fileKeys: ["file-a", "file-c"],
				timeout: 5000,
			});
			const parsed = parseResult(result);

			expect(executeCodeViaUI).toHaveBeenCalledTimes(2);
			expect(executeCodeViaUI).toHaveBeenCalledWith("return 1;", 5000, "file-a");
			expect(executeCodeViaUI).toHaveBeenCalledWith("return 1;", 5000, "file-c");
			expect(parsed.totalTargeted).toBe(2);
			expect(Object.keys(parsed.results).sort()).toEqual(["file-a", "file-c"]);
		});

		it("reports requested fileKeys that aren't connected without dropping valid ones", async () => {
			const files = [connectedFile("file-a", "Nova")];
			const wsServer = createMockWsServer(files);
			const executeCodeViaUI = jest.fn().mockResolvedValue({ success: true, result: null });
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({ executeCodeViaUI }));
			const tool = server._getTool("figma_execute_across_files");

			const result = await tool.handler({
				code: "return 1;",
				fileKeys: ["file-a", "file-nonexistent"],
				timeout: 5000,
			});
			const parsed = parseResult(result);

			expect(parsed.totalTargeted).toBe(1);
			expect(parsed.missingFileKeys).toEqual(["file-nonexistent"]);
			expect(Object.keys(parsed.results)).toEqual(["file-a"]);
		});

		it("errors when none of the requested fileKeys are connected", async () => {
			const files = [connectedFile("file-a", "Nova")];
			const wsServer = createMockWsServer(files);
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({}));
			const tool = server._getTool("figma_execute_across_files");

			const result = await tool.handler({
				code: "return 1;",
				fileKeys: ["file-nonexistent"],
				timeout: 5000,
			});

			expect(result.isError).toBe(true);
			expect(parseResult(result).error).toContain("No matching connected files");
		});

		it("keeps per-file results independent when one file's script throws and another succeeds", async () => {
			const files = [connectedFile("file-a", "Nova"), connectedFile("file-b", "Vega")];
			const wsServer = createMockWsServer(files);
			const executeCodeViaUI = jest.fn((_code: string, _timeout: number, fileKey?: string) => {
				if (fileKey === "file-a") return Promise.reject(new Error("Timeout"));
				return Promise.resolve({ success: true, result: { ok: true } });
			});
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({ executeCodeViaUI }));
			const tool = server._getTool("figma_execute_across_files");

			const result = await tool.handler({ code: "return 1;", allFiles: true, timeout: 5000 });
			const parsed = parseResult(result);

			expect(result.isError).toBe(false);
			expect(parsed.totalSucceeded).toBe(1);
			expect(parsed.totalFailed).toBe(1);
			expect(parsed.results["file-a"]).toEqual({
				fileName: "Nova",
				success: false,
				error: "Timeout",
			});
			expect(parsed.results["file-b"].success).toBe(true);
		});

		it("marks the response isError when every targeted file fails", async () => {
			const files = [connectedFile("file-a", "Nova"), connectedFile("file-b", "Vega")];
			const wsServer = createMockWsServer(files);
			const executeCodeViaUI = jest.fn().mockRejectedValue(new Error("boom"));
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({ executeCodeViaUI }));
			const tool = server._getTool("figma_execute_across_files");

			const result = await tool.handler({ code: "return 1;", allFiles: true, timeout: 5000 });
			const parsed = parseResult(result);

			expect(result.isError).toBe(true);
			expect(parsed.totalSucceeded).toBe(0);
			expect(parsed.totalFailed).toBe(2);
		});

		it("treats a script-level success:false as a per-file failure without throwing", async () => {
			const files = [connectedFile("file-a", "Nova")];
			const wsServer = createMockWsServer(files);
			const executeCodeViaUI = jest
				.fn()
				.mockResolvedValue({ success: false, error: "ReferenceError: x is not defined" });
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({ executeCodeViaUI }));
			const tool = server._getTool("figma_execute_across_files");

			const result = await tool.handler({ code: "return x;", allFiles: true, timeout: 5000 });
			const parsed = parseResult(result);

			expect(parsed.totalFailed).toBe(1);
			expect(parsed.results["file-a"].error).toBe("ReferenceError: x is not defined");
		});

		it("caps timeout at 30000ms even when a higher value is requested", async () => {
			const files = [connectedFile("file-a", "Nova")];
			const wsServer = createMockWsServer(files);
			const executeCodeViaUI = jest.fn().mockResolvedValue({ success: true, result: null });
			registerMultiFileTools(server as any, () => wsServer as any, async () => ({ executeCodeViaUI }));
			const tool = server._getTool("figma_execute_across_files");

			await tool.handler({ code: "return 1;", allFiles: true, timeout: 999999 });

			expect(executeCodeViaUI).toHaveBeenCalledWith("return 1;", 30000, "file-a");
		});
	});
});
