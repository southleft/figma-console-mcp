import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaWebSocketServer } from "./websocket-server.js";

/**
 * Register tools that operate across every Figma file connected via the
 * Desktop Bridge plugin at once, rather than only the single active file.
 * Local mode only — cloud/relay mode pairs with exactly one plugin instance.
 */
export function registerMultiFileTools(
	server: McpServer,
	getWsServer: () => FigmaWebSocketServer | null,
	getDesktopConnector: () => Promise<any>,
) {
	server.tool(
		"figma_execute_across_files",
		"Run the same JavaScript against multiple Figma files connected via the Desktop Bridge plugin, IN PARALLEL, without touching the active file or target lock. Built for cross-file consistency work — e.g. running the same structural check or fix against every file in a multi-file design system and diffing the results — instead of switching the active file and running figma_execute once per file in sequence. Each file's code runs in that file's own plugin context (same 'figma' global as figma_execute); a fix targeting only some files should read figma_list_open_files first, then pass just those fileKeys. Requires Desktop Bridge plugin open in each target file.",
		{
			code: z
				.string()
				.describe(
					"JavaScript code to execute in each targeted file. Has access to the 'figma' global object, same as figma_execute. Example: 'return { pageCount: figma.root.children.length };'",
				),
			fileKeys: z
				.array(z.string())
				.optional()
				.describe(
					"Which connected files to target, by fileKey. Omit (or pass an empty array) to run against every currently connected file. Get fileKeys from figma_list_open_files.",
				),
			timeout: z
				.number()
				.optional()
				.default(10000)
				.describe(
					"Per-file execution timeout in milliseconds (default: 10000, max: 30000). Applies independently to each file — one slow/unresponsive file does not delay the others.",
				),
		},
		async ({ code, fileKeys, timeout }: { code: string; fileKeys?: string[]; timeout: number }) => {
			try {
				const wsServer = getWsServer();
				if (!wsServer?.isClientConnected()) {
					return {
						content: [{
							type: "text" as const,
							text: JSON.stringify({
								error: "No files connected. Open the Desktop Bridge plugin in Figma to connect files.",
								results: {},
							}),
						}],
						isError: true,
					};
				}

				const connectedFiles = wsServer.getConnectedFiles();
				const cappedTimeout = Math.min(timeout, 30000);

				let targets = connectedFiles;
				let missingFileKeys: string[] = [];
				if (fileKeys && fileKeys.length > 0) {
					const connectedKeySet = new Set(connectedFiles.map((f) => f.fileKey));
					missingFileKeys = fileKeys.filter((k) => !connectedKeySet.has(k));
					targets = connectedFiles.filter(
						(f) => f.fileKey && fileKeys.includes(f.fileKey),
					);
				}

				if (targets.length === 0) {
					return {
						content: [{
							type: "text" as const,
							text: JSON.stringify({
								error: "No matching connected files to target.",
								requestedFileKeys: fileKeys,
								connectedFileKeys: connectedFiles.map((f) => f.fileKey),
							}),
						}],
						isError: true,
					};
				}

				const connector = await getDesktopConnector();
				const outcomes = await Promise.allSettled(
					targets.map((file) =>
						connector.executeCodeViaUI(
							code,
							cappedTimeout,
							file.fileKey ?? undefined,
						),
					),
				);

				const results: Record<string, unknown> = {};
				let succeeded = 0;
				let failed = 0;
				outcomes.forEach((outcome, i) => {
					const file = targets[i];
					const key = file.fileKey || `unknown-${i}`;
					if (outcome.status === "fulfilled") {
						const result = outcome.value;
						const ok = result?.success !== false;
						if (ok) succeeded++;
						else failed++;
						results[key] = {
							fileName: file.fileName,
							success: result?.success,
							result: result?.result,
							error: result?.error,
						};
					} else {
						failed++;
						results[key] = {
							fileName: file.fileName,
							success: false,
							error:
								outcome.reason instanceof Error
									? outcome.reason.message
									: String(outcome.reason),
						};
					}
				});

				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							results,
							totalTargeted: targets.length,
							totalSucceeded: succeeded,
							totalFailed: failed,
							missingFileKeys:
								missingFileKeys.length > 0 ? missingFileKeys : undefined,
							timestamp: Date.now(),
						}),
					}],
					isError: failed > 0 && succeeded === 0,
				};
			} catch (error) {
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							message: "Failed to execute across files",
						}),
					}],
					isError: true,
				};
			}
		},
	);
}
