/**
 * Figma Comments MCP Tools
 * Tools for getting, posting, and deleting comments on Figma files via REST API.
 * Works in both local and Cloudflare Workers modes — no Plugin API dependency.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import { extractFileKey } from "./figma-api.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "comment-tools" });

// ============================================================================
// Tool Registration
// ============================================================================

export function registerCommentTools(
	server: McpServer,
	getFigmaAPI: () => Promise<FigmaAPI>,
	getCurrentUrl: () => string | null,
	options?: { isRemoteMode?: boolean },
): void {
	// -----------------------------------------------------------------------
	// Tool: figma_get_comments
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_comments",
		"Get comments on a Figma file. Returns comment threads with author, message, timestamps, and pinned node locations. Use include_resolved to also see resolved comments.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			as_md: z
				.boolean()
				.optional()
				.default(false)
				.describe("Return comment message bodies as markdown. Default: false"),
			include_resolved: z
				.boolean()
				.optional()
				.default(false)
				.describe("Include resolved (completed) comment threads. Default: false (only active comments)"),
		},
		async ({ fileUrl, as_md = false, include_resolved = false }) => {
			try {
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "no_file_url",
									message:
										"No Figma file URL available. Pass the fileUrl parameter, call figma_navigate (CDP mode), or ensure the Desktop Bridge plugin is connected (WebSocket mode).",
								}),
							},
						],
						isError: true,
					};
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "invalid_url",
									message: `Invalid Figma URL: ${url}`,
								}),
							},
						],
						isError: true,
					};
				}

				logger.info({ fileKey, as_md, include_resolved }, "Fetching comments");

				const api = await getFigmaAPI();
				const response = await api.getComments(fileKey, { as_md });
				const allComments: any[] = response.comments || [];

				// Filter out resolved comments unless explicitly requested
				const comments = include_resolved
					? allComments
					: allComments.filter((c: any) => !c.resolved_at);

				const result = {
					comments,
					summary: {
						total: allComments.length,
						active: allComments.filter((c: any) => !c.resolved_at).length,
						resolved: allComments.filter((c: any) => c.resolved_at).length,
						returned: comments.length,
					},
				};

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result),
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Failed to get comments");

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "get_comments_failed",
								message: `Cannot get comments. ${message}`,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_post_comment
	// -----------------------------------------------------------------------
	server.tool(
		"figma_post_comment",
		"Post a comment on a Figma file, optionally pinned to a specific design node. Use after figma_check_design_parity to notify designers of drift when code is the canonical source. Supports replies to existing comment threads.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			message: z
				.string()
				.describe("The comment message text. Supports basic formatting."),
			node_id: z
				.string()
				.optional()
				.describe("Node ID to pin the comment to (e.g., '695:313'). Comment appears on that element in Figma."),
			x: z
				.number()
				.optional()
				.describe("X coordinate for comment placement (absolute canvas position). Used with node_id."),
			y: z
				.number()
				.optional()
				.describe("Y coordinate for comment placement (absolute canvas position). Used with node_id."),
			reply_to_comment_id: z
				.string()
				.optional()
				.describe("ID of an existing comment to reply to. Creates a threaded reply instead of a new top-level comment."),
		},
		async ({ fileUrl, message, node_id, x, y, reply_to_comment_id }) => {
			try {
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "no_file_url",
									message:
										"No Figma file URL available. Pass the fileUrl parameter, call figma_navigate (CDP mode), or ensure the Desktop Bridge plugin is connected (WebSocket mode).",
								}),
							},
						],
						isError: true,
					};
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "invalid_url",
									message: `Invalid Figma URL: ${url}`,
								}),
							},
						],
						isError: true,
					};
				}

				logger.info({ fileKey, node_id, reply_to_comment_id }, "Posting comment");

				const api = await getFigmaAPI();

				// Build client_meta for pinning to a node/position
				// Figma API requires node_offset when node_id is present — default to (0,0) if not specified
				let clientMeta: { node_id?: string; node_offset?: { x: number; y: number } } | undefined;
				if (node_id) {
					clientMeta = {
						node_id,
						node_offset: { x: x ?? 0, y: y ?? 0 },
					};
				}

				const result = await api.postComment(
					fileKey,
					message,
					clientMeta,
					reply_to_comment_id,
				);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								comment: {
									id: result.id,
									message: result.message,
									created_at: result.created_at,
									user: result.user,
									client_meta: result.client_meta,
									order_id: result.order_id,
								},
							}),
						},
					],
				};
			} catch (error) {
				const message_text = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Failed to post comment");

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "post_comment_failed",
								message: `Cannot post comment. ${message_text}`,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_delete_comment
	// -----------------------------------------------------------------------
	server.tool(
		"figma_delete_comment",
		"Delete a comment from a Figma file by its comment ID. Use figma_get_comments to find comment IDs first.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			comment_id: z
				.string()
				.describe("The ID of the comment to delete. Get IDs from figma_get_comments."),
		},
		async ({ fileUrl, comment_id }) => {
			try {
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "no_file_url",
									message:
										"No Figma file URL available. Pass the fileUrl parameter, call figma_navigate (CDP mode), or ensure the Desktop Bridge plugin is connected (WebSocket mode).",
								}),
							},
						],
						isError: true,
					};
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "invalid_url",
									message: `Invalid Figma URL: ${url}`,
								}),
							},
						],
						isError: true,
					};
				}

				logger.info({ fileKey, comment_id }, "Deleting comment");

				const api = await getFigmaAPI();
				await api.deleteComment(fileKey, comment_id);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								deleted_comment_id: comment_id,
							}),
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Failed to delete comment");

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "delete_comment_failed",
								message: `Cannot delete comment. ${message}`,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
