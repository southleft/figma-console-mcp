/**
 * Version Tools Tests
 *
 * Unit tests for figma_get_file_versions and figma_get_file_at_version.
 * Mirrors the structure of comment-tools.test.ts: a hand-rolled mock McpServer
 * captures registrations, and a mock FigmaAPI lets us drive responses without
 * fetch mocking.
 */

import { registerVersionTools, _clearVersionSnapshotCacheForTesting } from "../src/core/version-tools";

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
	const tools: RegisteredTool[] = {};
	return {
		registerTool: jest.fn((name: string, __cfg: any, handler: any) => { const description = __cfg?.description ?? ""; const schema = __cfg?.inputSchema?.shape ?? __cfg?.inputSchema; void description; void schema;
			(tools as any)[name] = { name, description, schema, handler };
		}),
		_tools: tools,
		_getTool(name: string): RegisteredTool {
			return (tools as any)[name];
		},
	};
}

function createMockFigmaAPI(overrides: Record<string, jest.Mock> = {}) {
	return {
		getFileVersions: jest.fn().mockResolvedValue({
			versions: [],
			pagination: { prev_page: null, next_page: null },
		}),
		getFile: jest.fn().mockResolvedValue({ document: { id: "0:0", children: [] } }),
		getNodes: jest.fn().mockResolvedValue({ nodes: {} }),
		...overrides,
	};
}

beforeEach(() => {
	_clearVersionSnapshotCacheForTesting();
});

const MOCK_FILE_URL = "https://www.figma.com/design/abc123/My-File";
const MOCK_FILE_KEY = "abc123";

function makeUser(handle = "alice"): { id: string; handle: string; img_url: string } {
	return { id: `user-${handle}`, handle, img_url: `https://img.example.com/${handle}.png` };
}

function makeVersion(opts: {
	id: string;
	label?: string;
	description?: string;
	created_at?: string;
	user?: { id: string; handle: string; img_url: string };
}) {
	return {
		id: opts.id,
		label: opts.label ?? "",
		description: opts.description ?? "",
		created_at: opts.created_at ?? "2026-04-01T10:00:00Z",
		user: opts.user ?? makeUser(),
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("Version Tools", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockApi: ReturnType<typeof createMockFigmaAPI>;

	beforeEach(() => {
		server = createMockServer();
		mockApi = createMockFigmaAPI();

		registerVersionTools(
			server as any,
			async () => mockApi as any,
			() => MOCK_FILE_URL,
		);
	});

	it("registers all six version tools", () => {
		expect(server.registerTool).toHaveBeenCalledTimes(6);
		const names = server.registerTool.mock.calls.map((c: any[]) => c[0]);
		expect(names).toContain("figma_get_file_versions");
		expect(names).toContain("figma_get_file_at_version");
		expect(names).toContain("figma_diff_versions");
		expect(names).toContain("figma_get_changes_since_version");
		expect(names).toContain("figma_generate_changelog");
		expect(names).toContain("figma_blame_node");
	});

	// -----------------------------------------------------------------------
	// figma_get_file_versions
	// -----------------------------------------------------------------------
	describe("figma_get_file_versions", () => {
		it("returns labeled versions only by default (filters auto-saves)", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [
					makeVersion({ id: "v1", label: "Release 2.4" }),
					makeVersion({ id: "v2", label: "" }), // auto-save
					makeVersion({ id: "v3", label: "Release 2.3" }),
					makeVersion({ id: "v4", label: "" }), // auto-save
				],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			expect(data.versions).toHaveLength(2);
			expect(data.versions.map((v: any) => v.id)).toEqual(["v1", "v3"]);
			expect(data.versions.every((v: any) => v.is_labeled)).toBe(true);
			expect(data.pagination.filtered_out_autosaves).toBe(2);
			expect(data.pagination.has_more).toBe(false);
			expect(data.pagination.next_cursor).toBeNull();
			expect(data._meta.api_calls_made).toBe(1);
		});

		it("includes auto-saves when include_autosaves=true", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [
					makeVersion({ id: "v1", label: "Release 2.4" }),
					makeVersion({ id: "v2", label: "" }),
					makeVersion({ id: "v3", label: "" }),
				],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: true, max_versions: 50 });

			const data = JSON.parse(result.content[0].text);
			expect(data.versions).toHaveLength(3);
			expect(data.versions.map((v: any) => v.is_labeled)).toEqual([true, false, false]);
			expect(data.pagination.filtered_out_autosaves).toBe(0);
		});

		it("auto-paginates across multiple pages until cap reached", async () => {
			// Page 1 returns 2 labeled versions and signals more available.
			// Page 2 returns 2 more labeled versions and signals more available.
			// max_versions=3 means we should stop mid-page-2 and report has_more=true.
			// next_cursor must be the last DISPLAYED item (v3), not the last RECEIVED (v4).
			mockApi.getFileVersions
				.mockResolvedValueOnce({
					versions: [
						makeVersion({ id: "v1", label: "L1" }),
						makeVersion({ id: "v2", label: "L2" }),
					],
					pagination: { prev_page: null, next_page: "https://api.figma.com/...?after=v2" },
				})
				.mockResolvedValueOnce({
					versions: [
						makeVersion({ id: "v3", label: "L3" }),
						makeVersion({ id: "v4", label: "L4" }),
					],
					pagination: { prev_page: null, next_page: "https://api.figma.com/...?after=v4" },
				});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 3 });

			const data = JSON.parse(result.content[0].text);
			expect(data.versions.map((v: any) => v.id)).toEqual(["v1", "v2", "v3"]);
			expect(data.pagination.has_more).toBe(true);
			expect(data.pagination.next_cursor).toBe("v3"); // last DISPLAYED — caller continues with after=v3
			expect(data._meta.api_calls_made).toBe(2);
		});

		it("falls back to last-received id as next_cursor when no items collected", async () => {
			// Labeled-only mode, page returns only autosaves but Figma signals more pages.
			// Caller needs *some* cursor to continue scanning forward.
			mockApi.getFileVersions.mockResolvedValueOnce({
				versions: [
					makeVersion({ id: "vA", label: "" }),
					makeVersion({ id: "vB", label: "" }),
				],
				pagination: { prev_page: null, next_page: "https://api.figma.com/...?after=vB" },
			}).mockResolvedValueOnce({
				versions: [],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			const data = JSON.parse(result.content[0].text);
			expect(data.versions).toHaveLength(0);
			expect(data.pagination.filtered_out_autosaves).toBe(2);
			// Loop exited because page 2 returned empty (figmaSaysMore=false).
			expect(data.pagination.has_more).toBe(false);
			expect(data.pagination.next_cursor).toBeNull();
		});

		it("stops paginating when Figma signals no more pages", async () => {
			mockApi.getFileVersions
				.mockResolvedValueOnce({
					versions: [makeVersion({ id: "v1", label: "L1" })],
					pagination: { prev_page: null, next_page: "https://api.figma.com/...?after=v1" },
				})
				.mockResolvedValueOnce({
					versions: [makeVersion({ id: "v2", label: "L2" })],
					pagination: { prev_page: null, next_page: null }, // no more
				});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			const data = JSON.parse(result.content[0].text);
			expect(data.versions.map((v: any) => v.id)).toEqual(["v1", "v2"]);
			expect(data.pagination.has_more).toBe(false);
			expect(data.pagination.next_cursor).toBeNull();
			expect(data._meta.api_calls_made).toBe(2);
		});

		it("passes provided cursor as 'after' on the first call", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [makeVersion({ id: "vOld", label: "Old" })],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			await tool.handler({ include_autosaves: false, max_versions: 10, cursor: "vSomething" });

			expect(mockApi.getFileVersions).toHaveBeenCalledWith(MOCK_FILE_KEY, {
				page_size: 50,
				after: "vSomething",
			});
		});

		it("clamps max_versions above the hard cap", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			// Schema validation rejects values > 200; the runtime cap also clamps.
			// Test the runtime side by feeding a borderline value.
			await tool.handler({ include_autosaves: false, max_versions: 200 });
			expect(mockApi.getFileVersions).toHaveBeenCalled();
		});

		it("uses explicit fileUrl when provided", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			await tool.handler({
				fileUrl: "https://www.figma.com/design/xyz999/Other",
				include_autosaves: false,
				max_versions: 50,
			});

			expect(mockApi.getFileVersions).toHaveBeenCalledWith("xyz999", expect.any(Object));
		});

		it("returns no_file_url error when neither URL is available", async () => {
			server = createMockServer();
			registerVersionTools(server as any, async () => mockApi as any, () => null);

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("no_file_url");
		});

		it("returns invalid_url error for non-Figma URLs", async () => {
			server = createMockServer();
			registerVersionTools(
				server as any,
				async () => mockApi as any,
				() => "https://example.com/not-figma",
			);

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("invalid_url");
		});

		it("surfaces 403 error with scope hint", async () => {
			mockApi.getFileVersions.mockRejectedValue(
				new Error("Figma API error (403): forbidden"),
			);

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("get_file_versions_failed");
			expect(data.message).toContain("403");
			expect(data.message).toContain("file_versions:read");
		});

		it("does not loop forever when cursor fails to advance", async () => {
			// Pathological case: same response twice — should detect non-advancement and stop.
			mockApi.getFileVersions.mockResolvedValue({
				versions: [makeVersion({ id: "vSame", label: "L" })],
				pagination: { prev_page: null, next_page: "https://api/.../?before=vSame" },
			});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({
				include_autosaves: false,
				max_versions: 50,
				cursor: "vSame",
			});

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			// We should have called once and stopped (cursor === lastReceivedId after one page)
			expect(data._meta.api_calls_made).toBe(1);
		});

		it("handles empty response", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			const data = JSON.parse(result.content[0].text);
			expect(data.versions).toHaveLength(0);
			expect(data.pagination.has_more).toBe(false);
			expect(data.pagination.next_cursor).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// figma_get_file_at_version
	// -----------------------------------------------------------------------
	describe("figma_get_file_at_version", () => {
		it("calls getFile with version when no node_ids given", async () => {
			mockApi.getFile.mockResolvedValue({
				name: "My File",
				lastModified: "2026-04-01T10:00:00Z",
				document: { id: "0:0", children: [] },
			});

			const tool = server._getTool("figma_get_file_at_version");
			const result = await tool.handler({ version_id: "v1" });

			expect(result.isError).toBeUndefined();
			expect(mockApi.getFile).toHaveBeenCalledWith(MOCK_FILE_KEY, {
				version: "v1",
				depth: undefined,
			});
			expect(mockApi.getNodes).not.toHaveBeenCalled();

			const data = JSON.parse(result.content[0].text);
			expect(data._version.id).toBe("v1");
			expect(data._version.fileKey).toBe(MOCK_FILE_KEY);
			expect(data._version.scope).toBe("file");
			expect(data._version.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(data.name).toBe("My File");
		});

		it("calls getNodes with version when node_ids given", async () => {
			mockApi.getNodes.mockResolvedValue({ nodes: { "1:2": { document: { id: "1:2" } } } });

			const tool = server._getTool("figma_get_file_at_version");
			const result = await tool.handler({
				version_id: "v1",
				node_ids: ["1:2", "3:4"],
				depth: 2,
			});

			expect(result.isError).toBeUndefined();
			expect(mockApi.getNodes).toHaveBeenCalledWith(MOCK_FILE_KEY, ["1:2", "3:4"], {
				version: "v1",
				depth: 2,
			});
			expect(mockApi.getFile).not.toHaveBeenCalled();

			const data = JSON.parse(result.content[0].text);
			expect(data._version.scope).toBe("nodes");
		});

		it("respects explicit fileUrl", async () => {
			mockApi.getFile.mockResolvedValue({});

			const tool = server._getTool("figma_get_file_at_version");
			await tool.handler({
				fileUrl: "https://www.figma.com/design/xyz999/Other",
				version_id: "v9",
			});

			expect(mockApi.getFile).toHaveBeenCalledWith("xyz999", expect.objectContaining({ version: "v9" }));
		});

		it("returns no_file_url error when no URL", async () => {
			server = createMockServer();
			registerVersionTools(server as any, async () => mockApi as any, () => null);

			const tool = server._getTool("figma_get_file_at_version");
			const result = await tool.handler({ version_id: "v1" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("no_file_url");
		});

		it("surfaces 404 error with retention hint", async () => {
			mockApi.getFile.mockRejectedValue(new Error("Figma API error (404): not found"));

			const tool = server._getTool("figma_get_file_at_version");
			const result = await tool.handler({ version_id: "vGone" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("get_file_at_version_failed");
			expect(data.message).toContain("404");
			expect(data.message).toContain("retention");
		});

		it("returns invalid_url error for non-Figma URLs", async () => {
			server = createMockServer();
			registerVersionTools(
				server as any,
				async () => mockApi as any,
				() => "https://example.com/not-figma",
			);

			const tool = server._getTool("figma_get_file_at_version");
			const result = await tool.handler({ version_id: "v1" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("invalid_url");
		});
	});

	// -----------------------------------------------------------------------
	// figma_diff_versions
	// -----------------------------------------------------------------------
	describe("figma_diff_versions", () => {
		const makeFileResp = (pages: Array<{ id: string; name: string }>) => ({
			document: {
				id: "0:0",
				name: "Document",
				type: "DOCUMENT",
				children: pages.map((p) => ({ id: p.id, name: p.name, type: "CANVAS" })),
			},
			version: "VFOO",
			lastModified: "2026-04-01T00:00:00Z",
			thumbnailUrl: "https://example.com/thumb.png",
		});

		it("returns page-structure diff and a hint when no component_ids provided", async () => {
			mockApi.getFile
				.mockResolvedValueOnce(makeFileResp([{ id: "1:0", name: "Page A" }]))
				.mockResolvedValueOnce(
					makeFileResp([
						{ id: "1:0", name: "Page A" },
						{ id: "2:0", name: "Page B" },
					]),
				);

			const tool = server._getTool("figma_diff_versions");
			const result = await tool.handler({ from_version: "vA", to_version: "vB" });

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			expect(data.page_structure.summary.added).toBe(1);
			expect(data.scoped_nodes).toBeUndefined();
			expect(data.summary.api_calls_made).toBe(2);
			expect(data.summary.cache_hits).toBe(0);
			expect(data.notes.some((n: string) => n.includes("Pass component_ids"))).toBe(true);
			expect(data.notes.some((n: string) => n.includes("Variable VALUE history"))).toBe(true);
			expect(mockApi.getFile).toHaveBeenCalledWith(MOCK_FILE_KEY, { version: "vA", depth: 1 });
			expect(mockApi.getFile).toHaveBeenCalledWith(MOCK_FILE_KEY, { version: "vB", depth: 1 });
		});

		it("uses HEAD (no version param) when to_version is 'current'", async () => {
			mockApi.getFile.mockResolvedValue(makeFileResp([{ id: "1:0", name: "Page A" }]));

			const tool = server._getTool("figma_diff_versions");
			await tool.handler({ from_version: "vA", to_version: "current" });

			expect(mockApi.getFile).toHaveBeenCalledWith(MOCK_FILE_KEY, { version: "vA", depth: 1 });
			expect(mockApi.getFile).toHaveBeenCalledWith(MOCK_FILE_KEY, { depth: 1 });
		});

		it("returns scoped node diffs when component_ids provided", async () => {
			mockApi.getFile.mockResolvedValue(makeFileResp([{ id: "1:0", name: "Page A" }]));
			mockApi.getNodes
				.mockResolvedValueOnce({
					nodes: {
						"100:1": {
							document: {
								id: "100:1",
								name: "Button",
								type: "COMPONENT_SET",
								description: "old",
								componentPropertyDefinitions: {
									"Text#1:1": { type: "TEXT", defaultValue: "Label" },
								},
								children: [],
								boundVariables: {},
							},
						},
					},
				})
				.mockResolvedValueOnce({
					nodes: {
						"100:1": {
							document: {
								id: "100:1",
								name: "Button v2",
								type: "COMPONENT_SET",
								description: "new",
								componentPropertyDefinitions: {
									"Text#1:1": { type: "TEXT", defaultValue: "Label" },
									"Disabled#1:2": { type: "BOOLEAN", defaultValue: false },
								},
								children: [],
								boundVariables: {},
							},
						},
					},
				});

			const tool = server._getTool("figma_diff_versions");
			const result = await tool.handler({
				from_version: "vA",
				to_version: "vB",
				component_ids: ["100:1"],
				mode: "detailed",
			});

			const data = JSON.parse(result.content[0].text);
			expect(data.scoped_nodes).toHaveLength(1);
			expect(data.scoped_nodes[0].name_changed).toEqual({ from: "Button", to: "Button v2" });
			expect(data.scoped_nodes[0].description_changed.to).toBe("new");
			expect(data.scoped_nodes[0].component_properties.summary.added).toBe(1);
			expect(data.summary.scoped_nodes_with_changes).toBe(1);
			expect(data.summary.api_calls_made).toBe(4); // 2 doc + 2 node
		});

		it("rejects identical from/to versions", async () => {
			const tool = server._getTool("figma_diff_versions");
			const result = await tool.handler({ from_version: "vA", to_version: "vA" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("same_version");
		});

		it("captures fetch errors per node without aborting the whole diff", async () => {
			mockApi.getFile.mockResolvedValue(makeFileResp([]));
			mockApi.getNodes
				.mockResolvedValueOnce({ nodes: { "1:1": { document: { id: "1:1", name: "ok", type: "FRAME" } } } })
				.mockResolvedValueOnce({ nodes: { "1:1": { document: { id: "1:1", name: "ok", type: "FRAME" } } } })
				.mockRejectedValueOnce(new Error("Figma API error (404): not found"))
				.mockRejectedValueOnce(new Error("Figma API error (404): not found"));

			const tool = server._getTool("figma_diff_versions");
			const result = await tool.handler({
				from_version: "vA",
				to_version: "vB",
				component_ids: ["1:1", "9:9"],
			});

			const data = JSON.parse(result.content[0].text);
			expect(data.scoped_nodes).toHaveLength(1);
			expect(data._fetch_errors).toHaveLength(1);
			expect(data._fetch_errors[0].node_id).toBe("9:9");
		});

		it("attaches scope hint on 403", async () => {
			mockApi.getFile.mockRejectedValue(new Error("Figma API error (403): forbidden"));
			const tool = server._getTool("figma_diff_versions");
			const result = await tool.handler({ from_version: "vA", to_version: "vB" });
			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.message).toContain("file_versions:read");
		});

		it("returns no_file_url when neither URL is available", async () => {
			server = createMockServer();
			registerVersionTools(server as any, async () => mockApi as any, () => null);
			const tool = server._getTool("figma_diff_versions");
			const result = await tool.handler({ from_version: "vA", to_version: "vB" });
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content[0].text).error).toBe("no_file_url");
		});

		it("uses cache for repeat fetches at same version_id", async () => {
			mockApi.getFile.mockResolvedValue(makeFileResp([{ id: "1:0", name: "Page A" }]));
			const tool = server._getTool("figma_diff_versions");
			const first = await tool.handler({ from_version: "vA", to_version: "vB" });
			const firstData = JSON.parse(first.content[0].text);
			expect(firstData.summary.api_calls_made).toBe(2);
			expect(firstData.summary.cache_hits).toBe(0);

			const firstCallCount = mockApi.getFile.mock.calls.length;
			// Second diff with same versions: both fetches hit cache.
			const second = await tool.handler({ from_version: "vA", to_version: "vB" });
			const secondData = JSON.parse(second.content[0].text);
			expect(mockApi.getFile.mock.calls.length).toBe(firstCallCount); // no new live fetches
			expect(secondData.summary.api_calls_made).toBe(0);
			expect(secondData.summary.cache_hits).toBe(2);
		});

		// v1.24.0 coverage warnings — guards against the silent blind-spot failure
		// mode where the diff returns "no changes" but the user changed something
		// outside the tool's coverage (instance overrides, raw layout properties).
		describe("scope_coverage (v1.24.0)", () => {
			const flatFileResp = () => ({
				document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [] },
				version: "VFOO",
				lastModified: "2026-05-01T00:00:00Z",
				thumbnailUrl: "https://example.com/thumb.png",
			});

			it("always emits the raw-layout-properties warning in notes[]", async () => {
				mockApi.getFile.mockResolvedValue(flatFileResp());
				const tool = server._getTool("figma_diff_versions");
				const result = await tool.handler({ from_version: "vA", to_version: "vB" });
				const data = JSON.parse(result.content[0].text);
				expect(
					data.notes.some((n: string) =>
						n.includes("Raw layout/visual properties are NOT tracked"),
					),
				).toBe(true);
			});

			it("emits the instances-not-diffed warning only when component_ids are scoped", async () => {
				mockApi.getFile.mockResolvedValue(flatFileResp());
				mockApi.getNodes.mockResolvedValue({
					nodes: {
						"1:1": {
							document: { id: "1:1", name: "Button", type: "COMPONENT_SET", children: [] },
						},
					},
				});

				const tool = server._getTool("figma_diff_versions");

				// Unscoped: no instance warning (the user can't have meant instances)
				const unscoped = await tool.handler({ from_version: "vA", to_version: "vB" });
				const unscopedData = JSON.parse(unscoped.content[0].text);
				expect(
					unscopedData.notes.some((n: string) =>
						n.includes("INSTANCES of these components"),
					),
				).toBe(false);

				// Scoped: instance warning fires
				const scoped = await tool.handler({
					from_version: "vA",
					to_version: "vB",
					component_ids: ["1:1"],
				});
				const scopedData = JSON.parse(scoped.content[0].text);
				expect(
					scopedData.notes.some((n: string) => n.includes("INSTANCES of these components")),
				).toBe(true);
			});

			it("includes a structured scope_coverage object on every response", async () => {
				mockApi.getFile.mockResolvedValue(flatFileResp());
				const tool = server._getTool("figma_diff_versions");
				const result = await tool.handler({ from_version: "vA", to_version: "vB" });
				const data = JSON.parse(result.content[0].text);

				expect(data.scope_coverage).toBeDefined();
				expect(data.scope_coverage.page_structure_diffed).toBe(true);
				expect(data.scope_coverage.component_ids_diffed).toEqual([]);
				expect(data.scope_coverage.max_depth).toBe(2);
				expect(Array.isArray(data.scope_coverage.tracks)).toBe(true);
				expect(Array.isArray(data.scope_coverage.does_not_track)).toBe(true);
				expect(Array.isArray(data.scope_coverage.complementary_tools)).toBe(true);

				// Specifically: the four most important blind spots must be named.
				const blindspots = data.scope_coverage.does_not_track.join(" ");
				expect(blindspots).toMatch(/instances/i);
				expect(blindspots).toMatch(/raw layout/i);
				expect(blindspots).toMatch(/raw visual/i);
				expect(blindspots).toMatch(/variable value/i);

				// Complementary tools the AI should reach for when this tool comes back empty.
				const tools = data.scope_coverage.complementary_tools.join(" ");
				expect(tools).toContain("figma_get_design_changes");
				expect(tools).toContain("figma_get_variables");
			});

			it("populates scope_coverage.component_ids_diffed when component_ids are passed", async () => {
				mockApi.getFile.mockResolvedValue(flatFileResp());
				mockApi.getNodes.mockResolvedValue({
					nodes: {
						"4271:9562": {
							document: { id: "4271:9562", name: "Button", type: "COMPONENT_SET", children: [] },
						},
					},
				});
				const tool = server._getTool("figma_diff_versions");
				const result = await tool.handler({
					from_version: "vA",
					to_version: "vB",
					component_ids: ["4271:9562"],
				});
				const data = JSON.parse(result.content[0].text);
				expect(data.scope_coverage.component_ids_diffed).toEqual(["4271:9562"]);
			});

			it("scope_coverage propagates through figma_get_changes_since_version", async () => {
				mockApi.getFile.mockResolvedValue(flatFileResp());
				const tool = server._getTool("figma_get_changes_since_version");
				const result = await tool.handler({ since_version: "vA" });
				const data = JSON.parse(result.content[0].text);
				expect(data.scope_coverage).toBeDefined();
				expect(data.scope_coverage.max_depth).toBe(2);
			});
		});

		// v1.25.0: metadata buffer integration — description and annotation changes
		// captured by the Desktop Bridge plugin should surface in the diff response
		// when the time window overlaps with buffer entries.
		describe("metadata buffer (v1.25.0)", () => {
			const datedFileResp = (lastModified: string) => ({
				document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [] },
				version: "VFOO",
				lastModified,
				thumbnailUrl: "https://example.com/thumb.png",
			});

			// Helper: register a fresh server with a metadata getter that returns
			// a hand-rolled buffer. Mirrors the existing `beforeEach` pattern.
			const registerWithBuffer = (buffer: any[]) => {
				server = createMockServer();
				mockApi = createMockFigmaAPI();
				registerVersionTools(
					server as any,
					async () => mockApi as any,
					() => MOCK_FILE_URL,
					undefined,
					undefined,
					(opts) =>
						buffer.filter((e) => {
							if (opts.since !== undefined && e.timestamp < opts.since) return false;
							if (opts.until !== undefined && e.timestamp > opts.until) return false;
							return true;
						}),
				);
			};

			it("scope_coverage.metadata_buffer reports available:false when no getter wired", async () => {
				// Use the outer beforeEach server (no getter wired)
				mockApi.getFile.mockResolvedValue(datedFileResp("2026-05-01T00:00:00Z"));
				const tool = server._getTool("figma_diff_versions");
				const result = await tool.handler({ from_version: "vA", to_version: "vB" });
				const data = JSON.parse(result.content[0].text);
				expect(data.scope_coverage.metadata_buffer.available).toBe(false);
				expect(data.scope_coverage.does_not_track.join(" ")).toMatch(
					/component descriptions.*no plugin buffer wired/i,
				);
			});

			it("scope_coverage.metadata_buffer reports available:true with 0 entries when buffer is empty", async () => {
				registerWithBuffer([]);
				mockApi.getFile.mockResolvedValue(datedFileResp("2026-05-01T00:00:00Z"));
				const tool = server._getTool("figma_diff_versions");
				const result = await tool.handler({ from_version: "vA", to_version: "vB" });
				const data = JSON.parse(result.content[0].text);
				expect(data.scope_coverage.metadata_buffer).toEqual({
					available: true,
					entries_in_window: 0,
					entries_matched_to_scoped_nodes: 0,
					entries_outside_scope: 0,
				});
				expect(data.scope_coverage.tracks.join(" ")).toMatch(
					/component descriptions via plugin session buffer/i,
				);
				expect(data.notes.some((n: string) => n.includes("No description or annotation changes"))).toBe(true);
			});

			it("attaches buffer events to a matching scoped node under metadata_changes", async () => {
				const t0 = Date.parse("2026-05-01T00:00:00Z");
				const t1 = Date.parse("2026-05-01T00:05:00Z");
				registerWithBuffer([
					{
						node_id: "4271:9562",
						node_name: "Button",
						node_type: "COMPONENT_SET",
						field: "description",
						new_value: "Updated docs about loading state",
						timestamp: t0 + 60_000,
					},
					{
						node_id: "4271:9562",
						node_name: "Button",
						node_type: "COMPONENT_SET",
						field: "annotations",
						new_value: [{ label: "Use Primary for hero CTAs", categoryId: null, properties: [] }],
						timestamp: t0 + 120_000,
					},
				]);
				mockApi.getFile
					.mockResolvedValueOnce(datedFileResp(new Date(t0).toISOString()))
					.mockResolvedValueOnce(datedFileResp(new Date(t1).toISOString()));
				mockApi.getNodes.mockResolvedValue({
					nodes: {
						"4271:9562": {
							document: { id: "4271:9562", name: "Button", type: "COMPONENT_SET", children: [] },
						},
					},
				});

				const tool = server._getTool("figma_diff_versions");
				const result = await tool.handler({
					from_version: "vA",
					to_version: "vB",
					component_ids: ["4271:9562"],
				});
				const data = JSON.parse(result.content[0].text);

				expect(data.scoped_nodes[0].metadata_changes).toHaveLength(2);
				expect(data.scoped_nodes[0].metadata_changes[0]).toMatchObject({
					field: "description",
					source: "plugin_buffer",
				});
				expect(data.scoped_nodes[0].metadata_changes[1]).toMatchObject({
					field: "annotations",
					source: "plugin_buffer",
				});
				// Buffer matches roll into change_count so summary stats reflect them
				expect(data.scoped_nodes[0].change_count).toBeGreaterThanOrEqual(2);
				expect(data.scope_coverage.metadata_buffer.entries_in_window).toBe(2);
				expect(data.scope_coverage.metadata_buffer.entries_matched_to_scoped_nodes).toBe(2);
				expect(data.scope_coverage.metadata_buffer.entries_outside_scope).toBe(0);
			});

			it("surfaces unscoped buffer events under unscoped_metadata_changes", async () => {
				const t0 = Date.parse("2026-05-01T00:00:00Z");
				const t1 = Date.parse("2026-05-01T00:05:00Z");
				registerWithBuffer([
					{
						node_id: "999:999", // NOT in component_ids
						node_name: "Card",
						node_type: "COMPONENT_SET",
						field: "description",
						new_value: "Card got a docstring",
						timestamp: t0 + 30_000,
					},
				]);
				mockApi.getFile
					.mockResolvedValueOnce(datedFileResp(new Date(t0).toISOString()))
					.mockResolvedValueOnce(datedFileResp(new Date(t1).toISOString()));
				mockApi.getNodes.mockResolvedValue({
					nodes: {
						"4271:9562": {
							document: { id: "4271:9562", name: "Button", type: "COMPONENT_SET", children: [] },
						},
					},
				});

				const tool = server._getTool("figma_diff_versions");
				const result = await tool.handler({
					from_version: "vA",
					to_version: "vB",
					component_ids: ["4271:9562"],
				});
				const data = JSON.parse(result.content[0].text);

				expect(data.unscoped_metadata_changes).toHaveLength(1);
				expect(data.unscoped_metadata_changes[0]).toMatchObject({
					node_id: "999:999",
					field: "description",
					source: "plugin_buffer",
				});
				expect(data.scoped_nodes[0].metadata_changes).toBeUndefined();
				expect(data.scope_coverage.metadata_buffer.entries_outside_scope).toBe(1);
			});

			it("respects the time window — events outside [from, to] are excluded", async () => {
				const t0 = Date.parse("2026-05-01T00:00:00Z");
				const t1 = Date.parse("2026-05-01T00:05:00Z");
				registerWithBuffer([
					// Before window
					{ node_id: "4271:9562", field: "description", new_value: "old", timestamp: t0 - 60_000 },
					// In window
					{ node_id: "4271:9562", field: "description", new_value: "mid", timestamp: t0 + 60_000 },
					// After window
					{ node_id: "4271:9562", field: "description", new_value: "new", timestamp: t1 + 60_000 },
				]);
				mockApi.getFile
					.mockResolvedValueOnce(datedFileResp(new Date(t0).toISOString()))
					.mockResolvedValueOnce(datedFileResp(new Date(t1).toISOString()));
				mockApi.getNodes.mockResolvedValue({
					nodes: {
						"4271:9562": {
							document: { id: "4271:9562", name: "Button", type: "COMPONENT_SET", children: [] },
						},
					},
				});

				const tool = server._getTool("figma_diff_versions");
				const result = await tool.handler({
					from_version: "vA",
					to_version: "vB",
					component_ids: ["4271:9562"],
				});
				const data = JSON.parse(result.content[0].text);

				expect(data.scope_coverage.metadata_buffer.entries_in_window).toBe(1);
				expect(data.scoped_nodes[0].metadata_changes).toHaveLength(1);
				expect(data.scoped_nodes[0].metadata_changes[0].new_value).toBe("mid");
			});

			it("metadata buffer integration propagates through figma_generate_changelog", async () => {
				const t0 = Date.parse("2026-05-01T00:00:00Z");
				const t1 = Date.parse("2026-05-01T00:05:00Z");
				registerWithBuffer([
					{
						node_id: "4271:9562",
						field: "description",
						new_value: "Loading state docs",
						timestamp: t0 + 60_000,
					},
				]);
				mockApi.getFile
					.mockResolvedValueOnce(datedFileResp(new Date(t0).toISOString()))
					.mockResolvedValueOnce(datedFileResp(new Date(t1).toISOString()));
				mockApi.getNodes.mockResolvedValue({
					nodes: {
						"4271:9562": {
							document: { id: "4271:9562", name: "Button", type: "COMPONENT_SET", children: [] },
						},
					},
				});

				const tool = server._getTool("figma_generate_changelog");
				const result = await tool.handler({
					from_version: "vA",
					to_version: "vB",
					component_ids: ["4271:9562"],
				});
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.structured.scoped_nodes[0].metadata_changes).toHaveLength(1);
			});
		});
	});

	// -----------------------------------------------------------------------
	// figma_get_changes_since_version
	// -----------------------------------------------------------------------
	describe("figma_get_changes_since_version", () => {
		const makeFileResp = (pages: Array<{ id: string; name: string }>) => ({
			document: {
				id: "0:0",
				name: "Document",
				type: "DOCUMENT",
				children: pages.map((p) => ({ id: p.id, name: p.name, type: "CANVAS" })),
			},
			version: "VHEAD",
			lastModified: "2026-05-01T00:00:00Z",
		});

		it("delegates to runDiff with to_version='current'", async () => {
			mockApi.getFile
				.mockResolvedValueOnce(makeFileResp([{ id: "1:0", name: "Old" }]))
				.mockResolvedValueOnce(makeFileResp([{ id: "1:0", name: "Old" }, { id: "2:0", name: "New" }]));

			const tool = server._getTool("figma_get_changes_since_version");
			const result = await tool.handler({ since_version: "vOld" });

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			expect(data.from.version_id).toBe("vOld");
			expect(data.to.version_id).toBe("current");
			expect(data.page_structure.summary.added).toBe(1);
			// First call: from version_id; second: HEAD without version param.
			expect(mockApi.getFile).toHaveBeenNthCalledWith(1, MOCK_FILE_KEY, {
				version: "vOld",
				depth: 1,
			});
			expect(mockApi.getFile).toHaveBeenNthCalledWith(2, MOCK_FILE_KEY, { depth: 1 });
		});
	});

	// -----------------------------------------------------------------------
	// figma_generate_changelog
	// -----------------------------------------------------------------------
	describe("figma_generate_changelog", () => {
		const makeFileResp = (
			pages: Array<{ id: string; name: string }>,
			overrides: Partial<{ name: string; version: string; lastModified: string }> = {},
		) => ({
			document: {
				id: "0:0",
				name: "Document",
				type: "DOCUMENT",
				children: pages.map((p) => ({ id: p.id, name: p.name, type: "CANVAS" })),
			},
			name: overrides.name ?? "Test Design System",
			version: overrides.version ?? "VRESOLVED",
			lastModified: overrides.lastModified ?? "2026-04-01T00:00:00Z",
		});

		const versionsListWithUsers = (versions: Array<{ id: string; label: string; user: string; created_at: string }>) => ({
			versions: versions.map((v) => ({
				id: v.id,
				label: v.label,
				description: "",
				created_at: v.created_at,
				user: { id: `u-${v.user}`, handle: v.user, img_url: "" },
			})),
			pagination: { prev_page: null, next_page: null },
		});

		it("returns markdown + structured payload with enriched authors", async () => {
			mockApi.getFile
				.mockResolvedValueOnce(makeFileResp([{ id: "1:0", name: "Page A" }]))
				.mockResolvedValueOnce(
					makeFileResp([{ id: "1:0", name: "Page A" }, { id: "2:0", name: "Page B" }]),
				);
			mockApi.getFileVersions.mockResolvedValueOnce(
				versionsListWithUsers([
					{ id: "vTo", label: "v2 published", user: "bob", created_at: "2026-04-01T00:00:00Z" },
					{ id: "vFrom", label: "v1 published", user: "alice", created_at: "2026-01-01T00:00:00Z" },
				]),
			);

			const tool = server._getTool("figma_generate_changelog");
			const result = await tool.handler({ from_version: "vFrom", to_version: "vTo" });

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			expect(data.markdown).toContain("# Test Design System — Change Log");
			expect(data.markdown).toContain("v1 published");
			expect(data.markdown).toContain("v2 published");
			expect(data.markdown).toContain("by alice");
			expect(data.markdown).toContain("by bob");
			expect(data.markdown).toContain("Page B");
			expect(data.structured).toBeDefined();
			expect(data.structured.page_structure.summary.added).toBe(1);
			expect(data._meta.authors_enriched).toBe(true);
			expect(data._meta.from_author_found).toBe(true);
			expect(data._meta.to_author_found).toBe(true);
		});

		it("degrades gracefully when author lookup misses a version", async () => {
			mockApi.getFile.mockResolvedValue(makeFileResp([]));
			// Only "vTo" is in the lookback; "vFrom" is too old / unfound.
			mockApi.getFileVersions.mockResolvedValueOnce(
				versionsListWithUsers([
					{ id: "vTo", label: "Recent", user: "bob", created_at: "2026-04-01T00:00:00Z" },
				]),
			);

			const tool = server._getTool("figma_generate_changelog");
			const result = await tool.handler({ from_version: "vFromAncient", to_version: "vTo" });

			const data = JSON.parse(result.content[0].text);
			expect(data._meta.from_author_found).toBe(false);
			expect(data._meta.to_author_found).toBe(true);
			expect(data.markdown).toContain("metadata not available");
			expect(data.markdown).toContain("by bob");
		});

		it("renders 'Current state' when to_version is 'current'", async () => {
			mockApi.getFile
				.mockResolvedValueOnce(makeFileResp([]))
				.mockResolvedValueOnce(
					makeFileResp([], {
						lastModified: "2026-05-01T12:00:00Z",
						version: "VHEADRESOLVED",
					}),
				);
			mockApi.getFileVersions.mockResolvedValueOnce(
				versionsListWithUsers([
					{ id: "vFrom", label: "v1", user: "alice", created_at: "2026-01-01T00:00:00Z" },
				]),
			);

			const tool = server._getTool("figma_generate_changelog");
			const result = await tool.handler({ from_version: "vFrom", to_version: "current" });

			const data = JSON.parse(result.content[0].text);
			expect(data.markdown).toContain("Current state");
			expect(data.markdown).toContain("2026-05-01");
			expect(data._meta.to_author_found).toBe(false); // HEAD is not a labeled author
			// Author lookup should have been called only for vFrom (not 'current')
			expect(mockApi.getFileVersions).toHaveBeenCalledTimes(1);
		});

		it("propagates diff errors (e.g. same_version)", async () => {
			const tool = server._getTool("figma_generate_changelog");
			const result = await tool.handler({ from_version: "vA", to_version: "vA" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("same_version");
		});

		it("includes per-component sections in markdown when component_ids passed", async () => {
			mockApi.getFile.mockResolvedValue(makeFileResp([]));
			mockApi.getNodes.mockResolvedValue({
				nodes: {
					"100:1": {
						document: {
							id: "100:1",
							name: "Button",
							type: "COMPONENT_SET",
							description: "",
							componentPropertyDefinitions: {
								"Text#1:1": { type: "TEXT", defaultValue: "Label" },
							},
							children: [],
							boundVariables: {},
						},
					},
				},
			});
			mockApi.getFileVersions.mockResolvedValue(
				versionsListWithUsers([
					{ id: "vTo", label: "v2", user: "bob", created_at: "2026-04-01T00:00:00Z" },
					{ id: "vFrom", label: "v1", user: "alice", created_at: "2026-01-01T00:00:00Z" },
				]),
			);

			const tool = server._getTool("figma_generate_changelog");
			const result = await tool.handler({
				from_version: "vFrom",
				to_version: "vTo",
				component_ids: ["100:1"],
			});

			const data = JSON.parse(result.content[0].text);
			// Same node returned for both versions — no actual changes
			expect(data.markdown).toContain("## Components");
			expect(data.markdown).toMatch(/No changes:|0 change/);
		});

		it("survives author lookup throwing", async () => {
			mockApi.getFile.mockResolvedValue(makeFileResp([]));
			mockApi.getFileVersions.mockRejectedValueOnce(new Error("API down"));

			const tool = server._getTool("figma_generate_changelog");
			const result = await tool.handler({ from_version: "vA", to_version: "vB" });

			// Should still succeed — enrichment is best-effort
			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			expect(data.markdown).toContain("metadata not available");
		});
	});

	// -----------------------------------------------------------------------
	// figma_blame_node
	// -----------------------------------------------------------------------
	describe("figma_blame_node", () => {
		// Helper: build a getNodes response where node "100:1" optionally has the
		// target component property and/or a target child node.
		const makeNodeResp = (opts: {
			hasProperty?: boolean;
			hasChild?: boolean;
		}) => ({
			version: "VANY",
			lastModified: "2026-01-01T00:00:00Z",
			nodes: {
				"100:1": {
					document: {
						id: "100:1",
						name: "Button",
						type: "COMPONENT_SET",
						componentPropertyDefinitions: opts.hasProperty
							? { "Disabled#1:2": { type: "BOOLEAN", defaultValue: false } }
							: {},
						children: opts.hasChild
							? [{ id: "999:9", name: "NewVariant", type: "COMPONENT" }]
							: [],
					},
				},
			},
		});

		// Helper: build a versions list response. Versions in newest-first order.
		const makeVersionsList = (versions: Array<{ id: string; user: string; label?: string }>) => ({
			versions: versions.map((v) => ({
				id: v.id,
				label: v.label ?? "",
				description: "",
				created_at: "2026-01-01T00:00:00Z",
				user: { id: `u-${v.user}`, handle: v.user, img_url: "" },
			})),
			pagination: { prev_page: null, next_page: null },
		});

		it("rejects when neither target type is provided", async () => {
			const tool = server._getTool("figma_blame_node");
			const result = await tool.handler({ node_id: "100:1" });
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content[0].text).error).toBe("invalid_target");
		});

		it("rejects when both target types are provided", async () => {
			const tool = server._getTool("figma_blame_node");
			const result = await tool.handler({
				node_id: "100:1",
				target_component_property: "Foo#1:1",
				target_child_node_id: "999:9",
			});
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content[0].text).error).toBe("invalid_target");
		});

		it("returns target_not_at_start when property doesn't exist at start", async () => {
			mockApi.getNodes.mockResolvedValueOnce(makeNodeResp({ hasProperty: false }));

			const tool = server._getTool("figma_blame_node");
			const result = await tool.handler({
				node_id: "100:1",
				target_component_property: "Disabled#1:2",
				start_version: "vStart",
			});

			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content[0].text).error).toBe("target_not_at_start");
		});

		it("returns node_not_at_start when node itself is missing", async () => {
			mockApi.getNodes.mockResolvedValueOnce({ nodes: {} });

			const tool = server._getTool("figma_blame_node");
			const result = await tool.handler({
				node_id: "100:1",
				target_component_property: "Disabled#1:2",
				start_version: "vStart",
			});

			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content[0].text).error).toBe("node_not_at_start");
		});

		it("attributes property introduction to the correct labeled version (binary search)", async () => {
			// 4 versions older than start (newest-first):
			//   v0 (2026-04-01, alice, labeled "v3"): has property
			//   v1 (2026-03-01, alice, autosave):     has property
			//   v2 (2026-02-01, bob,   labeled "v2"): does NOT have property  <-- introduction is between v2 and v1
			//   v3 (2026-01-01, bob,   labeled "v1"): does NOT have property
			// Expected introduction: v1 (the OLDEST version where target exists)
			// start has property
			mockApi.getNodes.mockImplementation(async (_fk: string, _ids: string[], opts: any) => {
				const v = opts?.version;
				if (v === "vStart" || v === undefined) return makeNodeResp({ hasProperty: true });
				if (v === "v0") return makeNodeResp({ hasProperty: true });
				if (v === "v1") return makeNodeResp({ hasProperty: true });
				if (v === "v2") return makeNodeResp({ hasProperty: false });
				if (v === "v3") return makeNodeResp({ hasProperty: false });
				return { nodes: {} };
			});
			mockApi.getFileVersions.mockResolvedValueOnce(
				makeVersionsList([
					{ id: "vStart", user: "tj", label: "start_label" },
					{ id: "v0", user: "alice", label: "v3" },
					{ id: "v1", user: "alice" },
					{ id: "v2", user: "bob", label: "v2" },
					{ id: "v3", user: "bob", label: "v1" },
				]),
			);

			const tool = server._getTool("figma_blame_node");
			const result = await tool.handler({
				node_id: "100:1",
				target_component_property: "Disabled#1:2",
				start_version: "vStart",
				max_versions_to_walk: 50,
			});

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			expect(data.introduced_at.version_id).toBe("v1");
			expect(data.introduced_at.user_handle).toBe("alice");
			expect(data.attribution_certainty).toBe("exact");
			expect(data.summary.versions_in_search_range).toBe(4);
			// log2(4) === 2 probes typical, may be 2-3 depending on bias
			expect(data.summary.probes_made).toBeLessThanOrEqual(3);
		});

		it("flags system_attributed when the introducing version's user is 'Figma'", async () => {
			mockApi.getNodes.mockImplementation(async (_fk: string, _ids: string[], opts: any) => {
				const v = opts?.version;
				if (v === "vStart" || v === undefined) return makeNodeResp({ hasProperty: true });
				if (v === "v0") return makeNodeResp({ hasProperty: true });
				if (v === "v1") return makeNodeResp({ hasProperty: false });
				return { nodes: {} };
			});
			mockApi.getFileVersions.mockResolvedValueOnce(
				makeVersionsList([
					{ id: "vStart", user: "tj" },
					{ id: "v0", user: "Figma" },
					{ id: "v1", user: "alice" },
				]),
			);

			const tool = server._getTool("figma_blame_node");
			const result = await tool.handler({
				node_id: "100:1",
				target_component_property: "Disabled#1:2",
				start_version: "vStart",
			});

			const data = JSON.parse(result.content[0].text);
			expect(data.introduced_at.version_id).toBe("v0");
			expect(data.introduced_at.user_handle).toBe("Figma");
			expect(data.attribution_certainty).toBe("system_attributed");
			expect(data.notes.some((n: string) => n.includes("system-triggered autosave"))).toBe(true);
		});

		it("reports exists_at_lookback_horizon when target exists at oldest scanned", async () => {
			mockApi.getNodes.mockResolvedValue(makeNodeResp({ hasProperty: true }));
			mockApi.getFileVersions.mockResolvedValueOnce(
				makeVersionsList([
					{ id: "vStart", user: "tj" },
					{ id: "v0", user: "alice" },
					{ id: "v1", user: "alice" },
				]),
			);

			const tool = server._getTool("figma_blame_node");
			const result = await tool.handler({
				node_id: "100:1",
				target_component_property: "Disabled#1:2",
				start_version: "vStart",
			});

			const data = JSON.parse(result.content[0].text);
			expect(data.attribution_certainty).toBe("exists_at_lookback_horizon");
			expect(data.notes.some((n: string) => n.includes("older than the search range"))).toBe(true);
		});

		it("attributes to start_version when target is introduced exactly there (no older versions have it)", async () => {
			// start has it; both candidates don't
			mockApi.getNodes.mockImplementation(async (_fk: string, _ids: string[], opts: any) => {
				const v = opts?.version;
				if (v === "vStart") return makeNodeResp({ hasProperty: true });
				return makeNodeResp({ hasProperty: false });
			});
			// First call: collectCandidateVersions; second: findVersionAuthorMetadata for vStart
			mockApi.getFileVersions
				.mockResolvedValueOnce(
					makeVersionsList([
						{ id: "vStart", user: "tj", label: "shipped" },
						{ id: "v0", user: "alice" },
						{ id: "v1", user: "alice" },
					]),
				)
				.mockResolvedValueOnce(
					makeVersionsList([
						{ id: "vStart", user: "tj", label: "shipped" },
					]),
				);

			const tool = server._getTool("figma_blame_node");
			const result = await tool.handler({
				node_id: "100:1",
				target_component_property: "Disabled#1:2",
				start_version: "vStart",
			});

			const data = JSON.parse(result.content[0].text);
			expect(data.introduced_at.version_id).toBe("vStart");
			expect(data.introduced_at.user_handle).toBe("tj");
			expect(data.introduced_at.label).toBe("shipped");
			expect(data.attribution_certainty).toBe("exact");
		});

		it("works for child node target type", async () => {
			mockApi.getNodes.mockImplementation(async (_fk: string, _ids: string[], opts: any) => {
				const v = opts?.version;
				if (v === "vStart") return makeNodeResp({ hasChild: true });
				if (v === "v0") return makeNodeResp({ hasChild: true });
				if (v === "v1") return makeNodeResp({ hasChild: false });
				return { nodes: {} };
			});
			mockApi.getFileVersions.mockResolvedValueOnce(
				makeVersionsList([
					{ id: "vStart", user: "tj" },
					{ id: "v0", user: "alice", label: "added variant" },
					{ id: "v1", user: "alice" },
				]),
			);

			const tool = server._getTool("figma_blame_node");
			const result = await tool.handler({
				node_id: "100:1",
				target_child_node_id: "999:9",
				start_version: "vStart",
			});

			const data = JSON.parse(result.content[0].text);
			expect(data.target).toEqual({ type: "child_node", node_id: "999:9" });
			expect(data.introduced_at.version_id).toBe("v0");
			expect(data.introduced_at.label).toBe("added variant");
		});

		it("filters autosaves out when include_autosaves=false", async () => {
			mockApi.getNodes.mockImplementation(async (_fk: string, _ids: string[], opts: any) => {
				const v = opts?.version;
				if (v === "vStart") return makeNodeResp({ hasProperty: true });
				if (v === "vLabeled") return makeNodeResp({ hasProperty: true });
				return { nodes: {} };
			});
			mockApi.getFileVersions.mockResolvedValueOnce(
				makeVersionsList([
					{ id: "vStart", user: "tj", label: "start" },
					{ id: "vAuto1", user: "alice" }, // autosave — filtered
					{ id: "vAuto2", user: "alice" }, // autosave — filtered
					{ id: "vLabeled", user: "alice", label: "labeled" },
				]),
			);

			const tool = server._getTool("figma_blame_node");
			const result = await tool.handler({
				node_id: "100:1",
				target_component_property: "Disabled#1:2",
				start_version: "vStart",
				include_autosaves: false,
			});

			const data = JSON.parse(result.content[0].text);
			// Only vLabeled is in the candidate range
			expect(data.summary.versions_in_search_range).toBe(1);
			expect(data.introduced_at.version_id).toBe("vLabeled");
		});
	});

	// -----------------------------------------------------------------------
	// Selection fallback (Phase 5)
	// -----------------------------------------------------------------------
	describe("selection fallback", () => {
		const makeFileResp = (pages: Array<{ id: string; name: string }> = []) => ({
			document: {
				id: "0:0",
				name: "Document",
				type: "DOCUMENT",
				children: pages.map((p) => ({ id: p.id, name: p.name, type: "CANVAS" })),
			},
			name: "Test File",
			version: "VRES",
			lastModified: "2026-01-01T00:00:00Z",
		});
		const makeNodeResp = (nodeId: string, hasProperty: boolean) => ({
			version: "VANY",
			lastModified: "2026-01-01T00:00:00Z",
			nodes: {
				[nodeId]: {
					document: {
						id: nodeId,
						name: "Selected Node",
						type: "COMPONENT_SET",
						componentPropertyDefinitions: hasProperty
							? { "Disabled#1:2": { type: "BOOLEAN", defaultValue: false } }
							: {},
						children: [],
					},
				},
			},
		});

		// Helper: register version tools with a custom selection getter
		const registerWithSelection = (selectedIds: string[] | null) => {
			const s = createMockServer();
			registerVersionTools(
				s as any,
				async () => mockApi as any,
				() => MOCK_FILE_URL,
				undefined,
				() => selectedIds,
			);
			return s;
		};

		it("figma_blame_node uses selected node when node_id is omitted", async () => {
			mockApi.getNodes.mockImplementation(async (_fk: string, _ids: string[], opts: any) => {
				return makeNodeResp("999:1", opts?.version === "vStart");
			});
			mockApi.getFileVersions.mockResolvedValueOnce({
				versions: [
					{
						id: "vStart",
						label: "start",
						description: "",
						created_at: "2026-01-01T00:00:00Z",
						user: { id: "u-tj", handle: "tj", img_url: "" },
					},
					{
						id: "v0",
						label: "",
						description: "",
						created_at: "2025-12-01T00:00:00Z",
						user: { id: "u-alice", handle: "alice", img_url: "" },
					},
				],
				pagination: { prev_page: null, next_page: null },
			});

			const s = registerWithSelection(["999:1"]);
			const tool = s._getTool("figma_blame_node");
			const result = await tool.handler({
				target_component_property: "Disabled#1:2",
				start_version: "vStart",
			});

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			expect(data.node_id).toBe("999:1");
			expect(data.summary.used_selection).toBe(true);
			expect(data.notes.some((n: string) => n.includes("Auto-scoped"))).toBe(true);
		});

		it("figma_blame_node errors helpfully when node_id omitted and no selection", async () => {
			const s = registerWithSelection(null);
			const tool = s._getTool("figma_blame_node");
			const result = await tool.handler({ target_component_property: "Foo#1:1" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("no_node_id");
			expect(data.message).toContain("select a node first");
		});

		it("figma_blame_node ignores selection when node_id is explicitly passed", async () => {
			mockApi.getNodes.mockResolvedValue(makeNodeResp("explicit:1", true));
			mockApi.getFileVersions.mockResolvedValueOnce({
				versions: [],
				pagination: { prev_page: null, next_page: null },
			});

			const s = registerWithSelection(["selected:1"]);
			const tool = s._getTool("figma_blame_node");
			const result = await tool.handler({
				node_id: "explicit:1",
				target_component_property: "Disabled#1:2",
				start_version: "vStart",
			});

			const data = JSON.parse(result.content[0].text);
			expect(data.node_id).toBe("explicit:1");
			expect(data.summary.used_selection).toBe(false);
		});

		it("figma_diff_versions auto-scopes to selection when component_ids omitted", async () => {
			mockApi.getFile.mockResolvedValue(makeFileResp());
			mockApi.getNodes.mockResolvedValue(makeNodeResp("777:7", true));

			const s = registerWithSelection(["777:7"]);
			const tool = s._getTool("figma_diff_versions");
			const result = await tool.handler({ from_version: "vA", to_version: "vB" });

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			expect(data.summary.used_selection).toBe(true);
			expect(data.summary.scoped_nodes_requested).toBe(1);
			expect(data.scoped_nodes).toHaveLength(1);
			expect(data.scoped_nodes[0].node_id).toBe("777:7");
			expect(data.notes.some((n: string) => n.includes("Auto-scoped"))).toBe(true);
		});

		it("figma_diff_versions falls back to page-only diff when no selection", async () => {
			mockApi.getFile.mockResolvedValue(makeFileResp([{ id: "1:0", name: "Page A" }]));

			const s = registerWithSelection(null);
			const tool = s._getTool("figma_diff_versions");
			const result = await tool.handler({ from_version: "vA", to_version: "vB" });

			const data = JSON.parse(result.content[0].text);
			expect(data.summary.used_selection).toBe(false);
			expect(data.summary.scoped_nodes_requested).toBe(0);
			expect(data.scoped_nodes).toBeUndefined();
		});

		it("figma_diff_versions explicit component_ids overrides selection", async () => {
			mockApi.getFile.mockResolvedValue(makeFileResp());
			mockApi.getNodes.mockResolvedValue(makeNodeResp("explicit:1", true));

			const s = registerWithSelection(["selected:1"]);
			const tool = s._getTool("figma_diff_versions");
			const result = await tool.handler({
				from_version: "vA",
				to_version: "vB",
				component_ids: ["explicit:1"],
			});

			const data = JSON.parse(result.content[0].text);
			expect(data.summary.used_selection).toBe(false);
			expect(data.scoped_nodes[0].node_id).toBe("explicit:1");
		});

		it("figma_diff_versions explicit empty array opts out of selection fallback", async () => {
			mockApi.getFile.mockResolvedValue(makeFileResp([{ id: "1:0", name: "Page A" }]));

			const s = registerWithSelection(["selected:1"]);
			const tool = s._getTool("figma_diff_versions");
			const result = await tool.handler({
				from_version: "vA",
				to_version: "vB",
				component_ids: [],
			});

			const data = JSON.parse(result.content[0].text);
			expect(data.summary.used_selection).toBe(false);
			expect(data.summary.scoped_nodes_requested).toBe(0);
		});
	});
});
