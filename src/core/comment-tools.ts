/**
 * Figma Comments MCP Tools
 * Tools for getting, posting, and deleting comments on Figma files via REST API.
 * Works in both local and Cloudflare Workers modes — no Plugin API dependency.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import { extractFigmaUrlInfo, extractFileKey, normalizeNodeId } from "./figma-api.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "comment-tools" });

// ============================================================================
// Helpers
// ============================================================================

interface CommentThread {
	root: any;
	replies: any[];
	lastActivity: number;
}

function timeOf(comment: any): number {
	const t = Date.parse(comment?.created_at ?? "");
	return Number.isNaN(t) ? 0 : t;
}

/** Groups the flat REST list into threads, newest activity first. */
export function buildThreads(comments: any[]): CommentThread[] {
	const byRoot = new Map<string, CommentThread>();
	for (const c of comments) {
		if (!c.parent_id) {
			byRoot.set(c.id, { root: c, replies: [], lastActivity: timeOf(c) });
		}
	}
	for (const c of comments) {
		if (!c.parent_id) continue;
		const thread = byRoot.get(c.parent_id);
		// A reply whose root is missing is still shown, as its own thread.
		if (!thread) {
			byRoot.set(c.id, { root: c, replies: [], lastActivity: timeOf(c) });
			continue;
		}
		thread.replies.push(c);
		thread.lastActivity = Math.max(thread.lastActivity, timeOf(c));
	}
	const threads = [...byRoot.values()];
	for (const t of threads) {
		t.replies.sort((a, b) => timeOf(a) - timeOf(b));
	}
	threads.sort((a, b) => b.lastActivity - a.lastActivity);
	return threads;
}

function collectNodeIds(node: any, ids: Set<string>): void {
	if (!node) return;
	if (node.id) ids.add(node.id);
	for (const child of node.children ?? []) {
		collectNodeIds(child, ids);
	}
}

function reactionCounts(reactions: any[] | undefined): Record<string, number> | undefined {
	if (!reactions?.length) return undefined;
	const counts: Record<string, number> = {};
	for (const r of reactions) {
		counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
	}
	return counts;
}

function compactComment(c: any): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: c.id,
		author: c.user?.handle,
		created_at: c.created_at,
		message: c.message,
	};
	const reactions = reactionCounts(c.reactions);
	if (reactions) out.reactions = reactions;
	return out;
}

function compactThread(t: CommentThread): Record<string, unknown> {
	const out: Record<string, unknown> = compactComment(t.root);
	const meta = t.root.client_meta;
	if (meta?.node_id) out.node_id = meta.node_id;
	if (t.root.resolved_at) out.resolved_at = t.root.resolved_at;
	if (t.replies.length) out.replies = t.replies.map(compactComment);
	return out;
}

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
		"Get comment threads on a Figma file. Returns threads (root comment + replies) sorted by latest activity, in a compact format by default (author handle, message, timestamps, pinned node, reaction counts). Narrow the result with an explicit node_id (includes comments pinned to nested nodes), thread_id or since, and page with limit/offset — files often have hundreds of comments. Use include_resolved to also see resolved threads and format='full' for raw Figma API objects.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted. A node-id in the URL does not filter comments; use node_id explicitly."),
			as_md: z
				.boolean()
				.optional()
				.default(false)
				.describe("Return comment message bodies as markdown. Default: false"),
			include_resolved: z
				.boolean()
				.optional()
				.default(false)
				.describe("Include resolved (completed) comment threads. Default: false (only active threads unless thread_id is given)"),
			node_id: z
				.string()
				.optional()
				.describe("Only threads pinned to this node (e.g. '695:313' or '695-313') or, with include_nested, to any node inside it. Omit or pass an empty string to return threads across the file."),
			include_nested: z
				.boolean()
				.optional()
				.default(true)
				.describe("With node_id: also match threads pinned to descendants of the node (one extra REST call). Default: true"),
			thread_id: z
				.string()
				.optional()
				.describe("Return only the thread containing this comment ID (root or reply), including resolved threads."),
			since: z
				.string()
				.optional()
				.describe("ISO date/time: only threads with a comment or reply created at or after it."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.default(30)
				.describe("Maximum threads to return. Default: 30"),
			offset: z
				.number()
				.int()
				.min(0)
				.optional()
				.default(0)
				.describe("Threads to skip, for paging. Default: 0"),
			format: z
				.enum(["compact", "full"])
				.optional()
				.default("compact")
				.describe("'compact' (default) — trimmed fields; 'full' — raw Figma API comment objects."),
		},
		async ({
			fileUrl,
			as_md = false,
			include_resolved = false,
			node_id,
			include_nested = true,
			thread_id,
			since,
			limit = 30,
			offset = 0,
			format = "compact",
		}) => {
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
										"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
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

				let sinceTime: number | undefined;
				if (since) {
					sinceTime = Date.parse(since);
					if (Number.isNaN(sinceTime)) {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										error: "invalid_since",
										message: `Invalid since date: ${since}`,
									}),
								},
							],
							isError: true,
						};
					}
				}

				const targetNode = node_id || undefined;

				logger.info(
					{ fileKey, as_md, include_resolved, targetNode, thread_id, since, limit, offset, format },
					"Fetching comments",
				);

				const api = await getFigmaAPI();
				const response = await api.getComments(fileKey, { as_md });
				const allComments: any[] = response.comments || [];
				const threads = buildThreads(allComments);

				let selected = include_resolved || thread_id
					? threads
					: threads.filter((t) => !t.root.resolved_at);

				let nodeIds: Set<string> | undefined;
				if (targetNode) {
					const normalized = normalizeNodeId(targetNode);
					nodeIds = new Set([normalized]);
					if (include_nested) {
						const nodes = await api.getNodes(fileKey, [normalized]);
						const document = nodes?.nodes?.[normalized]?.document;
						if (!document) {
							return {
								content: [
									{
										type: "text" as const,
										text: JSON.stringify({
											error: "node_not_found",
											message: `Node ${normalized} not found in file ${fileKey}`,
										}),
									},
								],
								isError: true,
							};
						}
						collectNodeIds(document, nodeIds);
					}
					const ids = nodeIds;
					selected = selected.filter((t) => {
						const pinned = t.root.client_meta?.node_id;
						return pinned !== undefined && ids.has(pinned);
					});
				}

				if (thread_id) {
					const byId = allComments.find((c: any) => c.id === thread_id);
					const rootId = byId ? byId.parent_id || byId.id : thread_id;
					selected = selected.filter((t) => t.root.id === rootId);
				}

				if (sinceTime !== undefined) {
					const from = sinceTime;
					selected = selected.filter((t) => t.lastActivity >= from);
				}

				const page = selected.slice(offset, offset + limit);
				const comments = page.map((t) =>
					format === "full"
						? { ...t.root, replies: t.replies }
						: compactThread(t),
				);

				const result = {
					comments,
					summary: {
						total: threads.length,
						active: threads.filter((t) => !t.root.resolved_at).length,
						resolved: threads.filter((t) => t.root.resolved_at).length,
						comments_total: allComments.length,
						matched: selected.length,
						returned: comments.length,
						offset,
						has_more: offset + comments.length < selected.length,
						...(targetNode
							? { node_id: normalizeNodeId(targetNode), nested_nodes: nodeIds?.size }
							: {}),
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
		"Post a comment on a Figma file, optionally pinned to a specific design node. Use after figma_check_design_parity to notify designers of drift when code is the canonical source. Supports replies to existing comment threads. Limitation: @mentions are a Figma UI-only feature — including '@name' in the message renders as plain text, not a clickable mention tag, and does not trigger Figma notifications.",
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
										"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
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
										"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
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
