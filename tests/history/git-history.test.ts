/**
 * Git history tests.
 *
 * The `git log` parser is tested directly. buildGitHistory is exercised against
 * this repo itself (it is a git checkout), plus the degradation paths.
 */

import { buildGitHistory, parseGitLog } from "../../src/core/history/git-history";

const UNIT = "\x1f";
const RECORD = "\x1e";

function record(fields: string[]): string {
	return fields.join(UNIT) + RECORD;
}

describe("parseGitLog", () => {
	it("parses a single commit record", () => {
		const out = parseGitLog(
			record(["abc123def456", "abc123d", "TJ Pitre", "2026-03-02T09:30:00-05:00", "feat: add thing"]),
		);
		expect(out).toEqual([
			{
				hash: "abc123def456",
				short_hash: "abc123d",
				author: "TJ Pitre",
				date: "2026-03-02T09:30:00-05:00",
				subject: "feat: add thing",
			},
		]);
	});

	it("parses multiple records and strips inter-record newlines", () => {
		const out = parseGitLog(
			record(["h1", "s1", "A", "2026-01-01T00:00:00Z", "first"]) +
				"\n" +
				record(["h2", "s2", "B", "2026-01-02T00:00:00Z", "second"]) +
				"\n",
		);
		expect(out).toHaveLength(2);
		expect(out[0].short_hash).toBe("s1");
		expect(out[1].short_hash).toBe("s2");
		expect(out[1].subject).toBe("second");
	});

	it("keeps subjects that contain spaces and punctuation intact", () => {
		const out = parseGitLog(
			record(["h", "s", "A", "2026-01-01T00:00:00Z", "fix(button): don't crash on null — v2"]),
		);
		expect(out[0].subject).toBe("fix(button): don't crash on null — v2");
	});

	it("returns an empty array for empty output", () => {
		expect(parseGitLog("")).toEqual([]);
		expect(parseGitLog("\n")).toEqual([]);
	});

	it("skips malformed records rather than throwing", () => {
		const out = parseGitLog("not-a-valid-record" + RECORD + record(["h", "s", "A", "d", "ok"]));
		expect(out).toHaveLength(1);
		expect(out[0].subject).toBe("ok");
	});
});

describe("buildGitHistory", () => {
	it("returns a note when no paths are supplied", async () => {
		const result = await buildGitHistory({ paths: [] });
		expect(result.entries).toEqual([]);
		expect(result.notes[0]).toContain("No source file paths");
	});

	it("ignores blank path entries", async () => {
		const result = await buildGitHistory({ paths: ["", "   "] });
		expect(result._meta.paths).toEqual([]);
		expect(result.notes[0]).toContain("No source file paths");
	});

	it("reads real commits for a tracked file in this repo", async () => {
		const result = await buildGitHistory({
			paths: ["package.json"],
			limit: 3,
			repoPath: process.cwd(),
		});

		expect(result._meta.repo_root).toBeTruthy();
		expect(result.entries.length).toBeGreaterThan(0);
		expect(result.entries.length).toBeLessThanOrEqual(3);
		for (const c of result.entries) {
			expect(c.hash).toMatch(/^[0-9a-f]{7,40}$/);
			expect(c.short_hash.length).toBeGreaterThan(0);
			expect(c.author.length).toBeGreaterThan(0);
			expect(Number.isNaN(Date.parse(c.date))).toBe(false);
		}
	});

	it("uses --follow only for a single path", async () => {
		const one = await buildGitHistory({ paths: ["package.json"], limit: 1 });
		expect(one._meta.followed_renames).toBe(true);

		const many = await buildGitHistory({
			paths: ["package.json", "tsconfig.json"],
			limit: 1,
		});
		expect(many._meta.followed_renames).toBe(false);
		// Multi-path must still succeed — --follow would have errored here.
		expect(many.notes.join(" ")).not.toContain("git log failed");
	});

	it("degrades to a note outside a git repository", async () => {
		const result = await buildGitHistory({ paths: ["anything.ts"], repoPath: "/" });
		expect(result.entries).toEqual([]);
		expect(result.notes.join(" ")).toMatch(/Not a git repository|git log failed/);
	});

	it("degrades to a note for an untracked path", async () => {
		const result = await buildGitHistory({
			paths: ["definitely/not/a/real/file-xyz.tsx"],
			repoPath: process.cwd(),
		});
		expect(result.entries).toEqual([]);
		expect(result.notes.join(" ")).toContain("No commits found");
	});

	it("does not execute shell metacharacters in caller-supplied paths", async () => {
		// execFile with an argv array means this is a (nonexistent) pathspec,
		// not a command. It must come back empty, not run `touch`.
		const result = await buildGitHistory({
			paths: ["package.json; touch /tmp/figma-mcp-pwned"],
			repoPath: process.cwd(),
		});
		expect(result.entries).toEqual([]);
		const fs = await import("node:fs");
		expect(fs.existsSync("/tmp/figma-mcp-pwned")).toBe(false);
	});
});
