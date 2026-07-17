/**
 * Pure-function markdown formatter for version diff results.
 *
 * Takes a diff payload (the structured response from figma_diff_versions)
 * plus optional author/label metadata for the from/to versions, and produces
 * a release-notes-style markdown string.
 *
 * Mode-aware:
 *   summary  — header + a single line of counts
 *   standard — header + page section + per-component counts
 *   detailed — header + page section + per-component property/binding details
 *
 * Pure: no I/O, no side effects. Trivially testable.
 */

import type { DiffMode, NodeDiff, PageStructureDiff } from "./diff-engine.js";

export interface VersionAuthorMeta {
	version_id: string;
	label?: string | null;
	created_at?: string | null;
	user_handle?: string | null;
	is_head?: boolean;
}

export interface ChangelogInput {
	file_key: string;
	file_name?: string | null;
	from_version_id: string;
	to_version_id: string;
	from_meta?: VersionAuthorMeta | null;
	to_meta?: VersionAuthorMeta | null;
	page_structure: PageStructureDiff;
	scoped_nodes?: NodeDiff[];
	notes?: string[];
}

export function formatChangelogMarkdown(input: ChangelogInput, mode: DiffMode = "standard"): string {
	const lines: string[] = [];

	// Header
	const title = input.file_name ? `${input.file_name} — Change Log` : "Figma File Change Log";
	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`**From:** ${formatVersionRef(input.from_meta, input.from_version_id, false)}`);
	lines.push(`**To:** ${formatVersionRef(input.to_meta, input.to_version_id, true)}`);
	const span = computeSpanDays(input.from_meta?.created_at, input.to_meta?.created_at);
	if (span !== null) {
		lines.push(`**Span:** ${span} day${span === 1 ? "" : "s"}`);
	}
	lines.push("");

	// Summary mode: one-line punch line
	if (mode === "summary") {
		lines.push(formatSummaryLine(input));
		lines.push("");
		appendNotes(lines, input.notes);
		return lines.join("\n").trimEnd() + "\n";
	}

	// Page Structure section (always for standard/detailed)
	appendPageStructureSection(lines, input.page_structure);

	// Components section
	if (input.scoped_nodes && input.scoped_nodes.length > 0) {
		appendComponentsSection(lines, input.scoped_nodes, mode);
	} else {
		lines.push("## Components");
		lines.push("");
		lines.push("_No components were scoped for this changelog. Pass `component_ids` to include per-component changes._");
		lines.push("");
	}

	appendNotes(lines, input.notes);

	return lines.join("\n").trimEnd() + "\n";
}

// ============================================================================
// Section formatters
// ============================================================================

function appendPageStructureSection(lines: string[], page: PageStructureDiff): void {
	const total = page.summary.added + page.summary.removed + page.summary.renamed;
	lines.push("## Page Structure");
	lines.push("");
	if (total === 0) {
		lines.push("_No page-level changes._");
		lines.push("");
		return;
	}
	if (page.pages_added.length > 0) {
		lines.push(`**Added (${page.pages_added.length}):**`);
		for (const p of page.pages_added) lines.push(`- ${escapeMd(p.name)} \`${p.id}\``);
		lines.push("");
	}
	if (page.pages_removed.length > 0) {
		lines.push(`**Removed (${page.pages_removed.length}):**`);
		for (const p of page.pages_removed) lines.push(`- ${escapeMd(p.name)} \`${p.id}\``);
		lines.push("");
	}
	if (page.pages_renamed.length > 0) {
		lines.push(`**Renamed (${page.pages_renamed.length}):**`);
		for (const r of page.pages_renamed) {
			lines.push(`- \`${r.id}\`: ${escapeMd(r.old_name)} → ${escapeMd(r.new_name)}`);
		}
		lines.push("");
	}
}

function appendComponentsSection(lines: string[], scoped: NodeDiff[], mode: DiffMode): void {
	lines.push("## Components");
	lines.push("");
	const withChanges = scoped.filter((n) => n.change_count > 0);
	const unchanged = scoped.filter((n) => n.change_count === 0 && n.notes.length === 0);
	const notFound = scoped.filter((n) =>
		n.notes.some((note) => note.toLowerCase().includes("not found")),
	);

	if (withChanges.length === 0 && unchanged.length === 0 && notFound.length === 0) {
		lines.push("_No scoped components had changes._");
		lines.push("");
		return;
	}

	for (const n of withChanges) {
		appendComponentBlock(lines, n, mode);
	}
	if (unchanged.length > 0) {
		lines.push(`**No changes:** ${unchanged.map((n) => `\`${n.node_name || n.node_id}\``).join(", ")}`);
		lines.push("");
	}
	if (notFound.length > 0) {
		lines.push(
			`**Not found in either version:** ${notFound.map((n) => `\`${n.node_id || "(empty)"}\``).join(", ")}`,
		);
		lines.push("");
	}
}

function appendComponentBlock(lines: string[], n: NodeDiff, mode: DiffMode): void {
	const heading = n.node_name ? `${n.node_name}` : "(unnamed)";
	lines.push(`### ${escapeMd(heading)} — \`${n.node_id}\``);
	lines.push(`**${n.change_count} change${n.change_count === 1 ? "" : "s"}**`);

	// Each subsequent sub-section adds its own single-blank-line separator so
	// we don't end up with two consecutive blank lines when one of these
	// sub-sections is empty. (Earlier versions unconditionally pushed a blank
	// after the change count then again before each sub-section, producing
	// double-blanks in the common case.)
	const bullets: string[] = [];
	if (n.name_changed) {
		bullets.push(`- Renamed: \`${escapeMd(n.name_changed.from)}\` → \`${escapeMd(n.name_changed.to)}\``);
	}
	if (n.description_changed) {
		const fromLen = n.description_changed.from.length;
		const toLen = n.description_changed.to.length;
		bullets.push(`- Description changed (${fromLen} → ${toLen} chars)`);
	}
	if (n.children_added.length > 0) {
		const inline = n.children_added.map((c) => `\`${escapeMd(c.name || c.id)}\``).join(", ");
		bullets.push(`- Children added (${n.children_added.length}): ${inline}`);
	}
	if (n.children_removed.length > 0) {
		const inline = n.children_removed.map((c) => `\`${escapeMd(c.name || c.id)}\``).join(", ");
		bullets.push(`- Children removed (${n.children_removed.length}): ${inline}`);
	}
	if (bullets.length > 0) {
		lines.push("");
		lines.push(...bullets);
	}

	if (n.component_properties && hasAnyPropChanges(n.component_properties.summary)) {
		const s = n.component_properties.summary;
		const parts: string[] = [];
		if (s.added > 0) parts.push(`${s.added} added`);
		if (s.removed > 0) parts.push(`${s.removed} removed`);
		if (s.type_changed > 0) parts.push(`${s.type_changed} type changed`);
		if (s.default_changed > 0) parts.push(`${s.default_changed} default changed`);
		lines.push("");
		lines.push(`**Component properties:** ${parts.join(", ")}`);

		if (mode === "detailed") {
			for (const p of n.component_properties.added) {
				lines.push(`- ➕ \`${escapeMd(p.name)}\` (${p.type}, default: \`${stringifyValue(p.default_value)}\`)`);
			}
			for (const p of n.component_properties.removed) {
				lines.push(`- ➖ \`${escapeMd(p.name)}\` (${p.type})`);
			}
			for (const t of n.component_properties.type_changed) {
				lines.push(`- 🔄 \`${escapeMd(t.name)}\`: ${t.from_type} → ${t.to_type}`);
			}
			for (const d of n.component_properties.default_changed) {
				lines.push(
					`- ⚙️ \`${escapeMd(d.name)}\`: \`${stringifyValue(d.from_default)}\` → \`${stringifyValue(d.to_default)}\``,
				);
			}
		}
	}

	if (n.binding_changes.length > 0) {
		lines.push("");
		lines.push(`**Variable bindings (${n.binding_changes.length}):**`);
		if (mode === "detailed") {
			for (const b of n.binding_changes) {
				const arrow =
					b.change_kind === "added"
						? `→ \`${b.to_variable_id}\``
						: b.change_kind === "removed"
							? `(removed, was \`${b.from_variable_id}\`)`
							: `\`${b.from_variable_id}\` → \`${b.to_variable_id}\``;
				lines.push(`- ${escapeMd(b.node_name || b.node_id)} — \`${b.property}\` ${arrow}`);
			}
		} else {
			// standard mode: group by change_kind, give counts
			const counts = { added: 0, removed: 0, rebound: 0 };
			for (const b of n.binding_changes) counts[b.change_kind]++;
			const parts: string[] = [];
			if (counts.added > 0) parts.push(`${counts.added} added`);
			if (counts.removed > 0) parts.push(`${counts.removed} removed`);
			if (counts.rebound > 0) parts.push(`${counts.rebound} rebound`);
			lines.push(`_${parts.join(", ")}._`);
		}
	}

	lines.push("");
}

function appendNotes(lines: string[], notes?: string[]): void {
	if (!notes || notes.length === 0) return;
	lines.push("## Notes");
	lines.push("");
	for (const n of notes) lines.push(`- ${n}`);
	lines.push("");
}

// ============================================================================
// Helpers
// ============================================================================

function formatVersionRef(
	meta: VersionAuthorMeta | null | undefined,
	versionId: string,
	isTo: boolean,
): string {
	if (meta?.is_head || versionId === "current") {
		const date = meta?.created_at ? formatDate(meta.created_at) : "current state";
		const user = meta?.user_handle ? ` by ${meta.user_handle}` : "";
		return `Current state (last modified ${date}${user})`;
	}
	if (!meta) {
		return `\`${versionId}\` _(metadata not available)_`;
	}
	const label = meta.label && meta.label.trim() !== "" ? `"${meta.label}"` : "_(unlabeled)_";
	const date = meta.created_at ? formatDate(meta.created_at) : "";
	const user = meta.user_handle ? `by ${meta.user_handle}` : "";
	const parts = [label, date, user].filter(Boolean).join(" — ");
	return `${parts} \`${versionId}\``;
}

function formatSummaryLine(input: ChangelogInput): string {
	const p = input.page_structure.summary;
	const componentCount =
		input.scoped_nodes?.filter((n) => n.change_count > 0).length ?? 0;
	const totalComponentChanges =
		input.scoped_nodes?.reduce((acc, n) => acc + n.change_count, 0) ?? 0;
	const parts: string[] = [];
	if (p.added > 0) parts.push(`${p.added} page${p.added === 1 ? "" : "s"} added`);
	if (p.removed > 0) parts.push(`${p.removed} page${p.removed === 1 ? "" : "s"} removed`);
	if (p.renamed > 0) parts.push(`${p.renamed} page${p.renamed === 1 ? "" : "s"} renamed`);
	if (componentCount > 0) {
		parts.push(
			`${componentCount} component${componentCount === 1 ? "" : "s"} with ${totalComponentChanges} change${totalComponentChanges === 1 ? "" : "s"}`,
		);
	}
	if (parts.length === 0) return "_No structural changes detected._";
	return parts.join("; ") + ".";
}

function computeSpanDays(fromIso?: string | null, toIso?: string | null): number | null {
	if (!fromIso || !toIso) return null;
	const from = new Date(fromIso).getTime();
	const to = new Date(toIso).getTime();
	if (isNaN(from) || isNaN(to)) return null;
	return Math.max(0, Math.round((to - from) / (1000 * 60 * 60 * 24)));
}

function formatDate(iso: string): string {
	// ISO 8601 is fine as-is for release notes; trim time if it's midnight UTC for cleaner output
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso;
	return d.toISOString().slice(0, 10);
}

function escapeMd(s: string): string {
	// Escape characters that would break markdown. Keep light — release notes
	// should be readable, not over-escaped.
	return s.replace(/([\\`*_{}[\]<>])/g, "\\$1");
}

function stringifyValue(v: any): string {
	if (v === undefined) return "?"; // standard mode strips defaults; render placeholder
	if (v === null) return "null";
	if (typeof v === "string") return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

function hasAnyPropChanges(s: { added: number; removed: number; type_changed: number; default_changed: number }): boolean {
	return s.added > 0 || s.removed > 0 || s.type_changed > 0 || s.default_changed > 0;
}
