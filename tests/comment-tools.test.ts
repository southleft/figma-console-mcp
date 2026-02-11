/**
 * Comment Tools Tests
 *
 * Unit tests for figma_get_comments, figma_post_comment, figma_delete_comment.
 * Tests the registerCommentTools() function with a mock McpServer and FigmaAPI.
 */

import { registerCommentTools } from "../src/core/comment-tools";

// ============================================================================
// Mock infrastructure
// ============================================================================

/** Captures tool registrations from server.tool() calls */
interface RegisteredTool {
	name: string;
	description: string;
	schema: any;
	handler: (args: any) => Promise<any>;
}

function createMockServer() {
	const tools: RegisteredTool[] = {};
	return {
		tool: jest.fn((name: string, description: string, schema: any, handler: any) => {
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
		getComments: jest.fn().mockResolvedValue({ comments: [] }),
		postComment: jest.fn().mockResolvedValue({
			id: "comment-123",
			message: "Test comment",
			created_at: "2025-01-15T10:00:00Z",
			user: { handle: "designer", img_url: "" },
			client_meta: null,
			order_id: "1",
		}),
		deleteComment: jest.fn().mockResolvedValue({}),
		...overrides,
	};
}

const MOCK_FILE_URL = "https://www.figma.com/design/abc123/My-File";
const MOCK_FILE_KEY = "abc123";

// ============================================================================
// Tests
// ============================================================================

describe("Comment Tools", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockApi: ReturnType<typeof createMockFigmaAPI>;

	beforeEach(() => {
		server = createMockServer();
		mockApi = createMockFigmaAPI();

		registerCommentTools(
			server as any,
			async () => mockApi as any,
			() => MOCK_FILE_URL,
		);
	});

	it("registers all 3 comment tools", () => {
		expect(server.tool).toHaveBeenCalledTimes(3);
		const names = server.tool.mock.calls.map((c: any[]) => c[0]);
		expect(names).toContain("figma_get_comments");
		expect(names).toContain("figma_post_comment");
		expect(names).toContain("figma_delete_comment");
	});

	// -----------------------------------------------------------------------
	// figma_get_comments
	// -----------------------------------------------------------------------
	describe("figma_get_comments", () => {
		const sampleComments = [
			{
				id: "c1",
				message: "Looks good!",
				resolved_at: null,
				user: { handle: "alice" },
				created_at: "2025-01-15T10:00:00Z",
			},
			{
				id: "c2",
				message: "Fixed the spacing",
				resolved_at: "2025-01-16T12:00:00Z",
				user: { handle: "bob" },
				created_at: "2025-01-15T11:00:00Z",
			},
			{
				id: "c3",
				message: "Still needs work",
				resolved_at: null,
				user: { handle: "carol" },
				created_at: "2025-01-15T12:00:00Z",
			},
		];

		it("returns active comments by default (filters resolved)", async () => {
			mockApi.getComments.mockResolvedValue({ comments: sampleComments });

			const tool = server._getTool("figma_get_comments");
			const result = await tool.handler({ as_md: false, include_resolved: false });

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			expect(data.comments).toHaveLength(2);
			expect(data.comments.map((c: any) => c.id)).toEqual(["c1", "c3"]);
			expect(data.summary.total).toBe(3);
			expect(data.summary.active).toBe(2);
			expect(data.summary.resolved).toBe(1);
			expect(data.summary.returned).toBe(2);
		});

		it("includes resolved comments when requested", async () => {
			mockApi.getComments.mockResolvedValue({ comments: sampleComments });

			const tool = server._getTool("figma_get_comments");
			const result = await tool.handler({ as_md: false, include_resolved: true });

			const data = JSON.parse(result.content[0].text);
			expect(data.comments).toHaveLength(3);
			expect(data.summary.returned).toBe(3);
		});

		it("passes as_md option to API", async () => {
			mockApi.getComments.mockResolvedValue({ comments: [] });

			const tool = server._getTool("figma_get_comments");
			await tool.handler({ as_md: true, include_resolved: false });

			expect(mockApi.getComments).toHaveBeenCalledWith(MOCK_FILE_KEY, { as_md: true });
		});

		it("uses explicit fileUrl when provided", async () => {
			mockApi.getComments.mockResolvedValue({ comments: [] });

			const tool = server._getTool("figma_get_comments");
			await tool.handler({
				fileUrl: "https://www.figma.com/design/xyz999/Other-File",
				as_md: false,
				include_resolved: false,
			});

			expect(mockApi.getComments).toHaveBeenCalledWith("xyz999", { as_md: false });
		});

		it("returns error when no URL available", async () => {
			// Re-register with null getCurrentUrl
			server = createMockServer();
			registerCommentTools(
				server as any,
				async () => mockApi as any,
				() => null,
			);

			const tool = server._getTool("figma_get_comments");
			const result = await tool.handler({ as_md: false, include_resolved: false });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("no_file_url");
		});

		it("returns error on API failure", async () => {
			mockApi.getComments.mockRejectedValue(new Error("Figma API error (403): Forbidden"));

			const tool = server._getTool("figma_get_comments");
			const result = await tool.handler({ as_md: false, include_resolved: false });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("get_comments_failed");
			expect(data.message).toContain("403");
		});
	});

	// -----------------------------------------------------------------------
	// figma_post_comment
	// -----------------------------------------------------------------------
	describe("figma_post_comment", () => {
		it("posts a basic comment", async () => {
			const tool = server._getTool("figma_post_comment");
			const result = await tool.handler({ message: "Hello from MCP!" });

			expect(result.isError).toBeUndefined();
			expect(mockApi.postComment).toHaveBeenCalledWith(
				MOCK_FILE_KEY,
				"Hello from MCP!",
				undefined,
				undefined,
			);
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(true);
			expect(data.comment.id).toBe("comment-123");
		});

		it("posts a comment pinned to a node", async () => {
			const tool = server._getTool("figma_post_comment");
			await tool.handler({
				message: "Check this component",
				node_id: "695:313",
			});

			expect(mockApi.postComment).toHaveBeenCalledWith(
				MOCK_FILE_KEY,
				"Check this component",
				{ node_id: "695:313", node_offset: { x: 0, y: 0 } },
				undefined,
			);
		});

		it("posts a comment pinned to a node with offset", async () => {
			const tool = server._getTool("figma_post_comment");
			await tool.handler({
				message: "Here specifically",
				node_id: "695:313",
				x: 100,
				y: 200,
			});

			expect(mockApi.postComment).toHaveBeenCalledWith(
				MOCK_FILE_KEY,
				"Here specifically",
				{ node_id: "695:313", node_offset: { x: 100, y: 200 } },
				undefined,
			);
		});

		it("posts a reply to an existing comment", async () => {
			const tool = server._getTool("figma_post_comment");
			await tool.handler({
				message: "I agree!",
				reply_to_comment_id: "comment-456",
			});

			expect(mockApi.postComment).toHaveBeenCalledWith(
				MOCK_FILE_KEY,
				"I agree!",
				undefined,
				"comment-456",
			);
		});

		it("returns error when no URL available", async () => {
			server = createMockServer();
			registerCommentTools(
				server as any,
				async () => mockApi as any,
				() => null,
			);

			const tool = server._getTool("figma_post_comment");
			const result = await tool.handler({ message: "test" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("no_file_url");
		});

		it("returns error on API failure", async () => {
			mockApi.postComment.mockRejectedValue(new Error("Figma API error (401): Unauthorized"));

			const tool = server._getTool("figma_post_comment");
			const result = await tool.handler({ message: "test" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("post_comment_failed");
			expect(data.message).toContain("401");
		});
	});

	// -----------------------------------------------------------------------
	// figma_delete_comment
	// -----------------------------------------------------------------------
	describe("figma_delete_comment", () => {
		it("deletes a comment by ID", async () => {
			const tool = server._getTool("figma_delete_comment");
			const result = await tool.handler({ comment_id: "comment-123" });

			expect(result.isError).toBeUndefined();
			expect(mockApi.deleteComment).toHaveBeenCalledWith(MOCK_FILE_KEY, "comment-123");
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(true);
			expect(data.deleted_comment_id).toBe("comment-123");
		});

		it("returns error when no URL available", async () => {
			server = createMockServer();
			registerCommentTools(
				server as any,
				async () => mockApi as any,
				() => null,
			);

			const tool = server._getTool("figma_delete_comment");
			const result = await tool.handler({ comment_id: "comment-123" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("no_file_url");
		});

		it("returns error when comment not found", async () => {
			mockApi.deleteComment.mockRejectedValue(new Error("Figma API error (404): Comment not found"));

			const tool = server._getTool("figma_delete_comment");
			const result = await tool.handler({ comment_id: "nonexistent" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("delete_comment_failed");
			expect(data.message).toContain("404");
		});

		it("uses explicit fileUrl when provided", async () => {
			const tool = server._getTool("figma_delete_comment");
			await tool.handler({
				fileUrl: "https://www.figma.com/design/xyz999/Other-File",
				comment_id: "comment-789",
			});

			expect(mockApi.deleteComment).toHaveBeenCalledWith("xyz999", "comment-789");
		});
	});

	// -----------------------------------------------------------------------
	// Edge cases
	// -----------------------------------------------------------------------
	describe("edge cases", () => {
		it("returns error for invalid Figma URL", async () => {
			server = createMockServer();
			registerCommentTools(
				server as any,
				async () => mockApi as any,
				() => "https://example.com/not-figma",
			);

			const tool = server._getTool("figma_get_comments");
			const result = await tool.handler({ as_md: false, include_resolved: false });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("invalid_url");
		});

		it("handles empty comments array", async () => {
			mockApi.getComments.mockResolvedValue({ comments: [] });

			const tool = server._getTool("figma_get_comments");
			const result = await tool.handler({ as_md: false, include_resolved: false });

			const data = JSON.parse(result.content[0].text);
			expect(data.comments).toHaveLength(0);
			expect(data.summary.total).toBe(0);
			expect(data.summary.active).toBe(0);
			expect(data.summary.resolved).toBe(0);
		});
	});
});
