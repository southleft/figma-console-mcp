/**
 * Renders component history into the `## History` section of a generated
 * component doc.
 *
 * Three independent sub-sections, each omitted when it has nothing to say:
 *   - Design history  — from Figma version history (buildDesignHistory)
 *   - Code history    — from git log (buildGitHistory)
 *   - Release notes   — caller-supplied codeInfo.changelog entries
 *
 * Pure: no I/O, no side effects. Trivially testable.
 *
 * Note on backward compatibility: when no history is requested, the doc
 * generator keeps emitting its original `## Changelog` section verbatim. This
 * `## History` heading only appears when the caller opts in.
 */

import type { DesignHistoryResult } from "./component-history.js";
import type { GitHistoryResult } from "./git-history.js";

export interface ManualChangelogEntry {
	version: string;
	date: string;
	changes: string;
}

export interface HistorySectionInput {
	componentName: string;
	design?: DesignHistoryResult | null;
	git?: GitHistoryResult | null;
	manual?: ManualChangelogEntry[] | null;
}

export function formatHistorySection(input: HistorySectionInput): string {
	const lines: string[] = ["", "## History", ""];

	let wroteAnySubsection = false;

	if (input.design) {
		appendDesignHistory(lines, input.design);
		wroteAnySubsection = true;
	}
	if (input.git) {
		appendGitHistory(lines, input.git);
		wroteAnySubsection = true;
	}
	if (input.manual && input.manual.length > 0) {
		appendManualChangelog(lines, input.manual);
		wroteAnySubsection = true;
	}

	if (!wroteAnySubsection) return "";

	return lines.join("\n").trimEnd() + "\n";
}

// ============================================================================
// Sub-sections
// ============================================================================

function appendDesignHistory(lines: string[], design: DesignHistoryResult): void {
	lines.push("### Design history");
	lines.push("");

	if (design.entries.length > 0) {
		lines.push("| Version | Date | Author | Changes |");
		lines.push("|---------|------|--------|---------|");
		for (const e of design.entries) {
			// Auto-saves have no label and a 19-digit numeric ID that means nothing
			// to a reader — the Date column already identifies the row. The raw ID
			// stays available programmatically via historySummary / the entry object.
			const version = e.label ? escapeCell(e.label) : "_(auto-save)_";
			const date = formatDate(e.created_at);
			const author = e.author ? escapeCell(e.author) : "—";
			const changes = e.changes.length > 0
				? e.changes.map(escapeCell).join("<br>")
				: `${e.change_count} change${e.change_count === 1 ? "" : "s"}`;
			lines.push(`| ${version} | ${date} | ${author} | ${changes} |`);
		}
		lines.push("");
	}

	appendNotes(lines, design.notes);
}

function appendGitHistory(lines: string[], git: GitHistoryResult): void {
	lines.push("### Code history");
	lines.push("");

	if (git.entries.length > 0) {
		lines.push("| Commit | Date | Author | Message |");
		lines.push("|--------|------|--------|---------|");
		for (const c of git.entries) {
			lines.push(
				`| \`${c.short_hash}\` | ${formatDate(c.date)} | ${escapeCell(c.author)} | ${escapeCell(c.subject)} |`,
			);
		}
		lines.push("");

		if (git._meta.paths.length > 0) {
			const scope = git._meta.paths.map((p) => `\`${p}\``).join(", ");
			const follow = git._meta.followed_renames ? " (renames followed)" : "";
			lines.push(`_Commits touching ${scope}${follow}._`);
			lines.push("");
		}
	}

	appendNotes(lines, git.notes);
}

function appendManualChangelog(lines: string[], entries: ManualChangelogEntry[]): void {
	lines.push("### Release notes");
	lines.push("");
	lines.push("| Version | Date | Changes |");
	lines.push("|---------|------|---------|");
	for (const e of entries) {
		lines.push(`| ${escapeCell(e.version)} | ${escapeCell(e.date)} | ${escapeCell(e.changes)} |`);
	}
	lines.push("");
}

function appendNotes(lines: string[], notes: string[]): void {
	if (!notes || notes.length === 0) return;
	for (const n of notes) lines.push(`> ${n}`);
	lines.push("");
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Make a value safe inside a markdown table cell. Pipes would split the cell
 * and raw newlines would terminate the row, so both are neutralized.
 */
function escapeCell(s: string): string {
	return String(s)
		.replace(/\|/g, "\\|")
		.replace(/\r?\n/g, " ")
		.trim();
}

function formatDate(iso: string): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso;
	return d.toISOString().slice(0, 10);
}
