/**
 * Toolsets: load tools on demand instead of all at once.
 *
 * Every tool definition the server lists is sent to the model with every
 * message (~59k tokens for all 138). Most sessions use a small core. So the
 * server starts with the CORE set only; the rest are grouped into toolsets the
 * model (or the person) switches on with figma_enable_toolsets when needed.
 *
 *   FIGMA_TOOLSETS unset        → core only
 *   FIGMA_TOOLSETS=all          → every tool (previous behaviour)
 *   FIGMA_TOOLSETS=variables,parity → core + those toolsets
 *
 * Enabling sends tools/list_changed so the client refreshes its list. For a
 * client that doesn't refresh, figma_call runs any enabled tool by name.
 */
import { z } from "zod";

export interface Toolset {
	description: string;
	tools: string[];
}

export const CORE_TOOLS = [
	"figma_get_status",
	"figma_diagnose",
	"figma_list_open_files",
	"figma_navigate",
	"figma_reconnect",
	"figma_get_selection",
	"figma_capture_screenshot",
	"figma_execute",
	"figma_get_design_system_summary",
	"figma_search_components",
	"figma_resolve_components",
	"figma_instantiate_component",
	"figma_set_instance_properties",
	"figma_create_child",
	"figma_clone_node",
	"figma_move_node",
	"figma_resize_node",
	"figma_rename_node",
	"figma_delete_node",
	"figma_set_layout",
	"figma_set_fills",
	"figma_set_strokes",
	"figma_set_text",
	"figma_bind_tokens",
	"figma_get_variables",
	"figma_get_text_styles",
	"figma_audit_adherence",
	"figma_lint_design",
];

/** Called by MCP Apps UIs (only registered when ENABLE_MCP_APPS=true). */
export const APP_TOOLS = ["ds_dashboard_refresh", "token_browser_refresh"];

export const TOOLSETS: Record<string, Toolset> = {
	inspect: {
		description: "file data, component dev specs and CSS, styles, library components/variables, where an asset is used",
		tools: [
			"figma_get_file_data",
			"figma_get_file_for_plugin",
			"figma_get_component",
			"figma_get_component_details",
			"figma_get_component_image",
			"figma_get_component_for_development",
			"figma_get_component_for_development_deep",
			"figma_analyze_component_set",
			"figma_get_styles",
			"figma_get_token_values",
			"figma_browse_tokens",
			"figma_take_screenshot",
			"figma_get_design_changes",
			"figma_get_design_system_kit",
			"figma_get_library_components",
			"figma_get_library_component_by_key",
			"figma_get_library_variables",
			"figma_import_library_variable",
			"figma_set_image_fill",
			"figma_find_usages",
		],
	},
	variables: {
		description: "edit variables/collections/modes; extended collections (create from a library or local collection, reset overrides); import/export tokens (DTCG, CSS, Tailwind)",
		tools: [
			"figma_create_variable",
			"figma_create_variable_collection",
			"figma_batch_create_variables",
			"figma_setup_design_tokens",
			"figma_add_mode",
			"figma_update_variable",
			"figma_batch_update_variables",
			"figma_rename_variable",
			"figma_rename_mode",
			"figma_delete_variable",
			"figma_delete_variable_collection",
			"figma_import_tokens",
			"figma_export_tokens",
			"figma_extend_library_collection",
			"figma_reset_variable_override",
		],
	},
	components: {
		description: "author component sets, variants, properties, slots; dev resource links",
		tools: [
			"figma_create_component_set",
			"figma_arrange_component_set",
			"figma_add_component_property",
			"figma_edit_component_property",
			"figma_delete_component_property",
			"figma_set_description",
			"figma_get_slots",
			"figma_create_slot",
			"figma_add_slot_property",
			"figma_append_to_slot",
			"figma_reset_slot",
			"figma_manage_dev_resources",
		],
	},
	parity: {
		description: "design↔code parity, code adherence and accessibility audits, DS health reports, library analytics",
		tools: [
			"figma_check_library_parity",
			"figma_check_design_parity",
			"figma_audit_code_adherence",
			"figma_audit_component_accessibility",
			"figma_scan_code_accessibility",
			"figma_audit_design_system_report",
			"figma_audit_design_system",
			"figma_get_library_analytics",
		],
	},
	docs: {
		description: "component docs, version history, changelogs, comments, annotations",
		tools: [
			"figma_generate_component_doc",
			"figma_get_file_versions",
			"figma_get_file_at_version",
			"figma_diff_versions",
			"figma_get_changes_since_version",
			"figma_generate_changelog",
			"figma_blame_node",
			"figma_get_comments",
			"figma_post_comment",
			"figma_delete_comment",
			"figma_get_annotations",
			"figma_get_annotation_categories",
			"figma_set_annotations",
		],
	},
	debug: {
		description: "plugin console, reload/pairing, code across files",
		tools: [
			"figma_get_console_logs",
			"figma_watch_console",
			"figma_clear_console",
			"figma_reload_plugin",
			"figma_pair_plugin",
			"figma_execute_across_files",
		],
	},
	motion: {
		description: "animations, shaders, code layers",
		tools: [
			"figma_get_animations",
			"figma_apply_animation",
			"figma_remove_animation",
			"figma_manage_animation_styles",
			"figma_export_animation",
			"figma_list_shaders",
			"figma_apply_shader",
			"figma_get_code_layers",
		],
	},
	assets: {
		description:
			"draw icons and illustrations as editable vectors (write SVG), import SVG icon sets as components and variant sets, import PNG/JPEG/GIF images as layers or fills, export PNG/JPG/SVG/PDF, icon SVGs and original images to files",
		tools: ["figma_import_svg", "figma_import_image", "figma_export_assets"],
	},
	figjam: {
		description: "FigJam boards",
		tools: [
			"figjam_get_board_contents",
			"figjam_get_connections",
			"figjam_create_sticky",
			"figjam_create_stickies",
			"figjam_create_connector",
			"figjam_create_shape_with_text",
			"figjam_create_section",
			"figjam_create_table",
			"figjam_create_code_block",
			"figjam_auto_arrange",
		],
	},
	slides: {
		description: "Figma Slides",
		tools: [
			"figma_list_slides",
			"figma_get_slide_content",
			"figma_get_slide_grid",
			"figma_get_slide_transition",
			"figma_get_focused_slide",
			"figma_create_slide",
			"figma_duplicate_slide",
			"figma_add_text_to_slide",
			"figma_add_shape_to_slide",
			"figma_set_slide_transition",
			"figma_set_slide_background",
			"figma_skip_slide",
			"figma_reorder_slides",
			"figma_focus_slide",
			"figma_set_slides_view_mode",
			"figma_delete_slide",
		],
	},
	extraction: {
		description: "extract a design system from app code (figma_ds_*)",
		tools: ["figma_ds_analyze", "figma_ds_extract_tokens", "figma_ds_scaffold", "figma_ds_setup_storybook", "figma_ds_extract_component", "figma_ds_verify", "figma_ds_status"],
	},
};

/** Which toolset a tool belongs to ("core" for the always-on set; undefined if unknown). */
export function toolsetOf(name: string): string | undefined {
	// MCP Apps refresh tools are called by the apps' own UI; they stay on when the apps are enabled.
	if (CORE_TOOLS.includes(name) || name === "figma_enable_toolsets" || name === "figma_call" || APP_TOOLS.includes(name)) return "core";
	for (const [set, t] of Object.entries(TOOLSETS)) if (t.tools.includes(name)) return set;
	return undefined;
}

/** Parse FIGMA_TOOLSETS. Returns "all" or the set of enabled toolset names. */
export function parseToolsetsEnv(value: string | undefined): "all" | Set<string> {
	const v = (value ?? "").trim().toLowerCase();
	if (v === "all" || v === "*") return "all";
	const out = new Set<string>(["core"]);
	for (const part of v.split(",").map((s) => s.trim()).filter(Boolean)) {
		if (part === "all") return "all";
		if (TOOLSETS[part]) out.add(part);
	}
	return out;
}

/**
 * Toolsets switched on during this process. The local HTTP endpoint builds a
 * fresh server per request (2026-07-28 is sessionless), so what
 * figma_enable_toolsets turns on must outlive the server that handled it.
 * Process-wide by design: on a shared HTTP server, enabling a toolset enables
 * it for every client of that server.
 */
const enabledThisProcess = new Set<string>();

/** Test hook. */
export function resetEnabledToolsets(): void {
	enabledThisProcess.clear();
}

type Registered = Record<string, { enabled: boolean; enable(): void; disable(): void; handler?: unknown; inputSchema?: unknown; description?: string }>;
const registry = (server: object): Registered => (server as unknown as { _registeredTools: Registered })._registeredTools ?? {};

/**
 * Apply the selection. Call after every tool is registered and BEFORE connect
 * (no list_changed is sent for the initial state). Unknown tools stay enabled
 * — never hide a tool by accident. Returns what was enabled/disabled.
 */
export function applyToolsets(server: object, selection: "all" | Set<string>): { enabled: string[]; disabled: string[]; unknown: string[] } {
	const enabled: string[] = [];
	const disabled: string[] = [];
	const unknown: string[] = [];
	for (const [name, tool] of Object.entries(registry(server))) {
		const set = toolsetOf(name);
		if (!set) unknown.push(name);
		// Set the flag directly: this runs before connect, so no list_changed is wanted.
		if (selection === "all" || !set || selection.has(set) || enabledThisProcess.has(set)) {
			tool.enabled = true;
			enabled.push(name);
		} else {
			tool.enabled = false;
			disabled.push(name);
		}
	}
	return { enabled, disabled, unknown };
}

interface ToolsetServer {
	registerTool: (name: string, config: any, handler: (args: any, extra: any) => any) => unknown;
	sendToolListChanged?: () => void | Promise<void>;
}

/** Register figma_enable_toolsets and figma_call (both part of core). */
export function registerToolsetTools(server: ToolsetServer): void {
	const names = Object.keys(TOOLSETS);
	const catalog = names.map((n) => `${n}: ${TOOLSETS[n].description}`).join("\n");

	server.registerTool(
		"figma_enable_toolsets",
		{
			description: `Switch on more tools when a task needs them (the core set covers finding, building, binding, auditing). Toolsets:\n${catalog}`,
			inputSchema: z.object({
				toolsets: z.array(z.enum(names as [string, ...string[]])).min(1).describe("Toolsets to switch on."),
			}),
		},
		async ({ toolsets }: { toolsets: string[] }) => {
			const reg = registry(server);
			const now: string[] = [];
			for (const set of toolsets) {
				enabledThisProcess.add(set);
				for (const name of TOOLSETS[set]?.tools ?? []) {
					const t = reg[name];
					if (!t) continue;
					// Flip the flag directly (enable() would send one list_changed per tool); one notice below.
					t.enabled = true;
					now.push(name);
				}
			}
			try {
				await server.sendToolListChanged?.();
			} catch {}
			let note = "These tools are now listed. If your client doesn't show them yet, call them through figma_call({ tool, arguments }).";
			// figma_call refuses destructive-hinted tools (below), so name the ones just enabled.
			// Annotations are applied at startup, before any call can reach this handler.
			const direct = now.filter((name) => (reg[name] as { annotations?: { destructiveHint?: boolean } } | undefined)?.annotations?.destructiveHint === true);
			if (direct.length) {
				const sets = toolsets.filter((set) => TOOLSETS[set]?.tools.some((t) => direct.includes(t)));
				const list = direct.length === 1 ? direct[0] : `${direct.slice(0, -1).join(", ")} and ${direct[direct.length - 1]}`;
				const one = direct.length === 1;
				note += ` ${list} can delete or overwrite, so ${one ? "it can't" : "they can't"} run through figma_call. Call ${one ? "it" : "them"} by name; if your client doesn't list ${one ? "it" : "them"}, restart the client or include ${sets.join(",")} in FIGMA_TOOLSETS.`;
			}
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							success: true,
							enabled: toolsets,
							tools: now,
							note,
						}),
					},
				],
			};
		},
	);

	server.registerTool(
		"figma_call",
		{
			description:
				"Run a tool from an enabled toolset by name, if your tool list didn't refresh after figma_enable_toolsets. Core tools and tools that delete or overwrite can't be run this way: call those directly, so your client's per-tool permissions apply.",
			inputSchema: z.object({
				tool: z.string().describe("Tool name, e.g. figma_get_styles."),
				arguments: z.string().optional().describe('The tool\'s arguments as a JSON object string, e.g. \'{"format":"css"}\'.'),
			}),
		},
		async ({ tool, arguments: rawArgs }: { tool: string; arguments?: string }, extra: any) => {
			const t = registry(server)[tool] as any;
			const fail = (msg: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true });
			if (!t) return fail(`Unknown tool "${tool}".`);
			if (tool === "figma_call" || tool === "figma_enable_toolsets") return fail(`${tool} can't be run through figma_call.`);
			// Never a back door around per-tool permission rules: core tools are always listed,
			// and destructive tools must be called under their own name.
			if (toolsetOf(tool) === "core") return fail(`"${tool}" is a core tool and is always listed; call it directly.`);
			if (t.annotations?.destructiveHint === true) {
				return fail(`"${tool}" can delete or overwrite, so it isn't run through figma_call (your client's permission for it must apply). Call it directly; if your client doesn't list it, restart the client or set FIGMA_TOOLSETS to include its toolset.`);
			}
			if (!t.enabled) {
				const set = toolsetOf(tool);
				return fail(`"${tool}" is in the "${set}" toolset, which is off. Call figma_enable_toolsets({ toolsets: ["${set}"] }) first.`);
			}
			let args: unknown = {};
			if (rawArgs && rawArgs.trim()) {
				try {
					args = JSON.parse(rawArgs);
				} catch {
					return fail("arguments must be a JSON object string.");
				}
				if (!args || typeof args !== "object" || Array.isArray(args)) return fail("arguments must be a JSON object string.");
			}
			// Same path as a direct tools/call: the SDK's own validation and execution.
			const srv = server as any;
			if (typeof srv.validateToolInput === "function" && typeof srv.executeToolHandler === "function") {
				try {
					const input = await srv.validateToolInput(t, args, tool);
					return await srv.executeToolHandler(t, input, extra);
				} catch (err) {
					return fail(err instanceof Error ? err.message : String(err));
				}
			}
			const handler = t.handler ?? t.callback;
			if (typeof handler !== "function") return fail(`"${tool}" can't be called through figma_call.`);
			return handler(args, extra);
		},
	);
}
