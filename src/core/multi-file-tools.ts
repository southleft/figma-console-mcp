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
		"Run the same JavaScript against multiple Figma files connected via the Desktop Bridge plugin, IN PARALLEL, without touching the active file or target lock. Built for cross-file consistency work — e.g. running the same structural check or fix against every file in a multi-file design system and diffing the results — instead of switching the active file and running figma_execute once per file in sequence. Each file's code runs in that file's own plugin context (same 'figma' global as figma_execute). You must say which files to target: pass fileKeys (read them from figma_list_open_files first — strongly preferred for anything that writes), or pass allFiles: true to hit every connected file. Requires Desktop Bridge plugin open in each target file. Local Mode only.",
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
					"Which connected files to target, by fileKey. Get fileKeys from figma_list_open_files. Required unless allFiles is true.",
				),
			allFiles: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"Run against EVERY currently connected file. Opt-in on purpose: this executes the code in files the user may be actively working in, including any file pinned by target lock. Prefer naming fileKeys explicitly for anything that writes.",
				),
			timeout: z
				.number()
				.optional()
				.default(10000)
				.describe(
					"Per-file execution timeout in milliseconds (default: 10000, max: 30000). Applies independently to each file — one slow/unresponsive file does not delay the others.",
				),
		},
		async ({ code, fileKeys, allFiles, timeout }: { code: string; fileKeys?: string[]; allFiles: boolean; timeout: number }) => {
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

				// Fanning out to every connected file has to be asked for. This
				// runs arbitrary code in files the user may be actively editing,
				// including one pinned by target lock — the exact misrouting that
				// target lock exists to prevent. "All" is a decision, not a default.
				const hasExplicitTargets = Boolean(fileKeys && fileKeys.length > 0);
				if (!hasExplicitTargets && !allFiles) {
					return {
						content: [{
							type: "text" as const,
							text: JSON.stringify({
								error:
									"No target files specified. Pass fileKeys to name the files to run against, or allFiles: true to run against every connected file.",
								hint: "Call figma_list_open_files to see connected fileKeys. Naming files explicitly is strongly preferred for code that writes.",
								connectedFiles: connectedFiles.map((f) => ({
									fileKey: f.fileKey,
									fileName: f.fileName,
									isActive: f.isActive,
								})),
							}),
						}],
						isError: true,
					};
				}

				// A client is only ever registered under a real fileKey (see
				// handleFileInfo), so this filter is belt-and-braces — but an
				// entry without one must never fall through to sendCommand's
				// active-file default, which would silently run the code against
				// the active file instead and report it as a success.
				const targetable = connectedFiles.filter(
					(f): f is typeof f & { fileKey: string } => Boolean(f.fileKey),
				);
				const unidentifiedFiles = connectedFiles
					.filter((f) => !f.fileKey)
					.map((f) => f.fileName);

				let targets = targetable;
				let missingFileKeys: string[] = [];
				if (hasExplicitTargets) {
					const connectedKeySet = new Set(targetable.map((f) => f.fileKey));
					missingFileKeys = fileKeys!.filter((k) => !connectedKeySet.has(k));
					targets = targetable.filter((f) => fileKeys!.includes(f.fileKey));
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
						connector.executeCodeViaUI(code, cappedTimeout, file.fileKey),
					),
				);

				const results: Record<string, unknown> = {};
				let succeeded = 0;
				let failed = 0;
				outcomes.forEach((outcome, i) => {
					const file = targets[i];
					const key = file.fileKey;
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
							// Reported by the plugin itself, so the caller can confirm
							// each result came from the file it was addressed to.
							fileContext: result?.fileContext,
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
							// Connected but unaddressable (no fileKey reported) — skipped
							// rather than silently redirected to the active file.
							skippedUnidentifiedFiles:
								unidentifiedFiles.length > 0 ? unidentifiedFiles : undefined,
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
