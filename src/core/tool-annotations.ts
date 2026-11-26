/**
 * MCP tool annotations (behavior hints) for every tool the server registers.
 *
 * Hosts use these to decide how to treat a call:
 *  - readOnlyHint   — safe to auto-approve, and Claude Code retries it after a
 *                     dropped connection.
 *  - idempotentHint — calling twice with the same args has no extra effect, so
 *                     a retry is safe (Claude Code honors this too).
 *  - destructiveHint — may delete or overwrite user data; hosts may prompt.
 *
 * One table, applied after registration (`applyToolAnnotations`), so tool files
 * don't each carry their own hints and a new tool can't ship unclassified —
 * `tests/tool-annotations.test.ts` fails when a registered tool is missing here.
 *
 * Convention (the spec's destructiveHint technically covers any overwrite, but
 * hosts treat it as "dangerous"): deletes, replaces, resets and arbitrary code
 * are destructive; "set X to Y" updates are idempotent, non-destructive writes;
 * creates are non-idempotent, non-destructive writes.
 */

export type ToolKind =
	/** Reads only — no change to Figma, the filesystem or server state. */
	| "read"
	/** Changes session/UI state only (navigation, focus, reconnect). */
	| "session"
	/** Additive write; calling twice creates two things. */
	| "create"
	/** Sets something to a given value; repeating is a no-op. */
	| "update"
	/** Writes local files (may replace an existing file). */
	| "file"
	/** Deletes, replaces, resets, or runs arbitrary code. */
	| "destructive";

export interface ToolHints {
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
}

const KIND_HINTS: Record<ToolKind, Omit<ToolHints, "openWorldHint">> = {
	read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
	session: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
	create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
	update: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
	file: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
	destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

/**
 * Every registered tool, by kind. Grouped by surface for review; order inside
 * a group doesn't matter.
 */
export const TOOL_KINDS: Record<string, ToolKind> = {
	figma_enable_toolsets: "session",
	figma_call: "destructive", // runs any enabled tool, including deletes
	// ── Connection, console, status ──────────────────────────────────────────
	figma_get_status: "read",
	figma_diagnose: "read",
	figma_list_open_files: "read",
	figma_get_console_logs: "read",
	figma_watch_console: "read",
	figma_take_screenshot: "read",
	figma_capture_screenshot: "read",
	figma_get_selection: "read",
	// `clear: true` empties the change buffer, so a retry could lose events.
	figma_get_design_changes: "session",
	figma_clear_console: "session",
	figma_navigate: "session",
	figma_reconnect: "session",
	figma_reload_plugin: "session",
	figma_pair_plugin: "session",

	// ── Reads: files, components, tokens, styles ─────────────────────────────
	figma_get_file_data: "read",
	figma_get_file_for_plugin: "read",
	figma_get_variables: "read",
	figma_get_token_values: "read",
	figma_get_styles: "read",
	figma_get_text_styles: "read",
	figma_get_component: "read",
	figma_get_component_details: "read",
	figma_get_component_image: "read",
	figma_get_component_for_development: "read",
	figma_get_component_for_development_deep: "read",
	figma_search_components: "read",
	figma_get_library_components: "read",
	figma_get_library_component_by_key: "read",
	figma_get_library_variables: "read",
	figma_get_design_system_summary: "read",
	figma_get_design_system_kit: "read",
	figma_get_annotations: "read",
	figma_get_annotation_categories: "read",
	figma_get_slots: "read",
	figma_get_animations: "read",
	figma_get_code_layers: "read",
	figma_list_shaders: "read",
	figma_analyze_component_set: "read",
	// Design-system adherence (resolve may ask the person; neither writes).
	figma_resolve_components: "read",
	figma_audit_adherence: "read",
	figma_audit_code_adherence: "read",
	figma_check_library_parity: "read",

	// ── Audits & reports (compute only) ──────────────────────────────────────
	figma_lint_design: "read",
	figma_audit_component_accessibility: "read",
	figma_scan_code_accessibility: "read",
	figma_check_design_parity: "read",
	figma_audit_design_system_report: "read",
	figma_audit_design_system: "read",
	ds_dashboard_refresh: "read",
	figma_browse_tokens: "read",
	token_browser_refresh: "read",

	// ── Version history & comments ───────────────────────────────────────────
	figma_get_file_versions: "read",
	figma_get_file_at_version: "read",
	figma_diff_versions: "read",
	figma_get_changes_since_version: "read",
	figma_generate_changelog: "read",
	figma_blame_node: "read",
	figma_get_comments: "read",
	figma_post_comment: "create",
	figma_delete_comment: "destructive",

	// ── Arbitrary code ───────────────────────────────────────────────────────
	figma_execute: "destructive",
	figma_execute_across_files: "destructive",

	// ── Variables & tokens ───────────────────────────────────────────────────
	figma_create_variable: "create",
	figma_create_variable_collection: "create",
	figma_batch_create_variables: "create",
	figma_setup_design_tokens: "create",
	figma_add_mode: "create",
	figma_update_variable: "update",
	figma_batch_update_variables: "update",
	figma_rename_variable: "update",
	figma_rename_mode: "update",
	figma_import_library_variable: "update",
	figma_delete_variable: "destructive",
	figma_delete_variable_collection: "destructive",
	// strategy "replace" deletes variables missing from the payload.
	figma_import_tokens: "destructive",
	figma_export_tokens: "file",

	// ── Components & properties ──────────────────────────────────────────────
	figma_instantiate_component: "create",
	figma_create_component_set: "create",
	figma_add_component_property: "create",
	figma_edit_component_property: "update",
	figma_set_instance_properties: "update",
	figma_set_description: "update",
	figma_arrange_component_set: "update",
	figma_delete_component_property: "destructive",
	// Writes markdown to outputPath when given; otherwise returns it.
	figma_generate_component_doc: "file",

	// ── Nodes & layout ───────────────────────────────────────────────────────
	figma_create_child: "create",
	figma_clone_node: "create",
	figma_resize_node: "update",
	figma_move_node: "update",
	figma_rename_node: "update",
	figma_set_text: "update",
	figma_set_fills: "update",
	figma_set_strokes: "update",
	figma_set_image_fill: "update",
	figma_set_layout: "update",
	figma_bind_tokens: "update",
	figma_set_annotations: "update",
	figma_apply_shader: "update",
	figma_delete_node: "destructive",

	// ── Slots ────────────────────────────────────────────────────────────────
	figma_create_slot: "create",
	figma_add_slot_property: "create",
	figma_append_to_slot: "create",
	figma_reset_slot: "destructive",

	// ── Motion ───────────────────────────────────────────────────────────────
	figma_apply_animation: "update",
	figma_remove_animation: "destructive",
	// action "delete" removes a style; other actions list/create/update.
	figma_manage_animation_styles: "destructive",
	figma_export_animation: "file",

	// ── FigJam ───────────────────────────────────────────────────────────────
	figjam_get_board_contents: "read",
	figjam_get_connections: "read",
	figjam_create_sticky: "create",
	figjam_create_stickies: "create",
	figjam_create_connector: "create",
	figjam_create_shape_with_text: "create",
	figjam_create_section: "create",
	figjam_create_table: "create",
	figjam_create_code_block: "create",
	figjam_auto_arrange: "update",

	// ── Slides ───────────────────────────────────────────────────────────────
	figma_list_slides: "read",
	figma_get_slide_content: "read",
	figma_get_slide_grid: "read",
	figma_get_slide_transition: "read",
	figma_get_focused_slide: "read",
	figma_create_slide: "create",
	figma_duplicate_slide: "create",
	figma_add_text_to_slide: "create",
	figma_add_shape_to_slide: "create",
	figma_set_slide_transition: "update",
	figma_set_slide_background: "update",
	figma_skip_slide: "update",
	figma_reorder_slides: "update",
	figma_focus_slide: "session",
	figma_set_slides_view_mode: "session",
	figma_delete_slide: "destructive",

	// ── Design-system extraction (local filesystem) ──────────────────────────
	figma_ds_analyze: "file",
	figma_ds_extract_tokens: "file",
	figma_ds_scaffold: "file",
	figma_ds_setup_storybook: "file",
	figma_ds_extract_component: "read",
	figma_ds_verify: "read",
	figma_ds_status: "file",
};

/**
 * Tools that only touch the local machine / the user's open Figma file.
 * Everything else reaches the Figma REST API (an external system).
 */
const REST_TOOLS = new Set<string>([
	"figma_get_file_data",
	"figma_get_component",
	"figma_get_styles",
	"figma_get_component_image",
	"figma_get_component_for_development",
	"figma_get_file_for_plugin",
	"figma_get_comments",
	"figma_post_comment",
	"figma_delete_comment",
	"figma_get_file_versions",
	"figma_get_file_at_version",
	"figma_diff_versions",
	"figma_get_changes_since_version",
	"figma_generate_changelog",
	"figma_blame_node",
	"figma_get_library_components",
	"figma_get_library_component_by_key",
	"figma_get_design_system_kit",
	"figma_resolve_components",
]);

export function hintsFor(name: string): ToolHints | undefined {
	const kind = TOOL_KINDS[name];
	if (!kind) return undefined;
	return { ...KIND_HINTS[kind], openWorldHint: REST_TOOLS.has(name) };
}

/**
 * Apply hints to every registered tool. Existing per-tool annotations win
 * (a tool file can still override). Call after all registration and before
 * connect, so no list_changed notification fires.
 *
 * Returns the names of registered tools with no entry in TOOL_KINDS.
 */
export function applyToolAnnotations(server: object): string[] {
	const registered = (
		server as unknown as {
			_registeredTools: Record<
				string,
				{ annotations?: Record<string, unknown>; update(u: { annotations: Record<string, unknown> }): void }
			>;
		}
	)._registeredTools;
	const missing: string[] = [];
	for (const [name, tool] of Object.entries(registered ?? {})) {
		const hints = hintsFor(name);
		if (!hints) {
			missing.push(name);
			continue;
		}
		tool.annotations = { ...hints, ...(tool.annotations ?? {}) };
	}
	return missing;
}
