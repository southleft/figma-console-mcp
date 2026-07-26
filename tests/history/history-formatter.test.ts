/**
 * History section markdown formatter tests.
 */

import { formatHistorySection } from "../../src/core/history/history-formatter";
import type { DesignHistoryResult } from "../../src/core/history/component-history";
import type { GitHistoryResult } from "../../src/core/history/git-history";

function design(overrides: Partial<DesignHistoryResult> = {}): DesignHistoryResult {
	return {
		entries: [
			{
				version_id: "v3",
				label: "v1.2 icon slot",
				created_at: "2026-03-01T12:00:00Z",
				author: "carol",
				is_labeled: true,
				change_count: 2,
				changes: ["Added 1 layer: `Icon`", "Component properties: 1 added"],
			},
		],
		notes: [],
		_meta: {
			node_ids: ["10:20"],
			versions_scanned: 3,
			pairs_diffed: 2,
			api_calls: 4,
			cache_hits: 1,
		},
		...overrides,
	};
}

function git(overrides: Partial<GitHistoryResult> = {}): GitHistoryResult {
	return {
		entries: [
			{
				hash: "a1b2c3d4e5f6",
				short_hash: "a1b2c3d",
				author: "TJ",
				date: "2026-03-02T09:30:00Z",
				subject: "feat(button): add icon slot",
			},
		],
		notes: [],
		_meta: {
			repo_root: "/repo",
			paths: ["src/Button.tsx"],
			followed_renames: true,
		},
		...overrides,
	};
}

describe("formatHistorySection", () => {
	it("renders a design history table with version, date, author and changes", () => {
		const md = formatHistorySection({ componentName: "Button", design: design() });
		expect(md).toContain("## History");
		expect(md).toContain("### Design history");
		expect(md).toContain("| Version | Date | Author | Changes |");
		expect(md).toContain("v1.2 icon slot");
		expect(md).toContain("2026-03-01");
		expect(md).toContain("carol");
		// Multiple bullets collapse into one cell via <br>
		expect(md).toContain("Added 1 layer: `Icon`<br>Component properties: 1 added");
	});

	it("renders a git history table and the path scope line", () => {
		const md = formatHistorySection({ componentName: "Button", git: git() });
		expect(md).toContain("### Code history");
		expect(md).toContain("| Commit | Date | Author | Message |");
		expect(md).toContain("`a1b2c3d`");
		expect(md).toContain("feat(button): add icon slot");
		expect(md).toContain("`src/Button.tsx`");
		expect(md).toContain("renames followed");
	});

	it("folds caller-supplied changelog entries in as release notes", () => {
		const md = formatHistorySection({
			componentName: "Button",
			design: design(),
			manual: [{ version: "2.1.0", date: "2026-03-05", changes: "Icon slot support" }],
		});
		expect(md).toContain("### Release notes");
		expect(md).toContain("| 2.1.0 | 2026-03-05 | Icon slot support |");
	});

	it("renders notes as blockquotes so caveats survive into the doc", () => {
		const md = formatHistorySection({
			componentName: "Button",
			design: design({ entries: [], notes: ["No tracked changes across the last 2 versions."] }),
		});
		expect(md).toContain("> No tracked changes across the last 2 versions.");
		// No table when there are no rows
		expect(md).not.toContain("| Version | Date | Author | Changes |");
	});

	it("escapes pipes and newlines so they cannot break table rows", () => {
		const md = formatHistorySection({
			componentName: "Button",
			git: git({
				entries: [
					{
						hash: "x",
						short_hash: "x1y2z3",
						author: "TJ",
						date: "2026-03-02T09:30:00Z",
						subject: "fix: handle a | b\nsecond line",
					},
				],
			}),
		});
		expect(md).toContain("fix: handle a \\| b second line");
		// The row must remain a single line
		const row = md.split("\n").find((l) => l.includes("x1y2z3"))!;
		expect(row.startsWith("|")).toBe(true);
		expect(row.endsWith("|")).toBe(true);
	});

	it("marks unlabeled autosave versions distinctly", () => {
		const md = formatHistorySection({
			componentName: "Button",
			design: design({
				entries: [
					{
						version_id: "v9",
						label: null,
						created_at: "2026-03-01T12:00:00Z",
						author: null,
						is_labeled: false,
						change_count: 1,
						changes: ["Renamed `A` → `B`"],
					},
				],
			}),
		});
		// The raw 19-digit version ID is meaningless to a reader; the Date column
		// identifies the row instead.
		expect(md).toContain("_(auto-save)_");
		expect(md).not.toContain("v9");
		expect(md).toContain("| — |"); // missing author
	});

	it("returns empty string when there is nothing to render", () => {
		expect(formatHistorySection({ componentName: "Button" })).toBe("");
		expect(formatHistorySection({ componentName: "Button", manual: [] })).toBe("");
	});
});
