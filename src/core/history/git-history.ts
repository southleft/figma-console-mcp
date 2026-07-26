/**
 * Code-side component history via `git log`.
 *
 * Answers "which commits touched this component's source files" so generated
 * documentation can pair the Figma design history with the code history that
 * followed (or preceded) it.
 *
 * Local mode only. `child_process` is imported DYNAMICALLY so this module stays
 * safe to include in the Cloudflare Workers bundle — a static import would fail
 * at bundle/startup time in a Workers runtime, where the caller instead reports
 * an unavailability note.
 *
 * Command safety: every git invocation uses execFile with an argv ARRAY (never
 * a shell string), so caller-supplied paths cannot inject commands. Paths are
 * additionally passed after a `--` separator so git treats them strictly as
 * pathspecs rather than options.
 *
 * Like design history, this never throws — failures degrade to notes.
 */

import { createChildLogger } from "../logger.js";

const logger = createChildLogger({ component: "git-history" });

export const DEFAULT_GIT_LIMIT = 10;
export const MAX_GIT_LIMIT = 50;

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

// ASCII unit/record separators — safe field delimiters because git commit
// subjects and author names cannot contain raw 0x1f / 0x1e bytes.
const UNIT_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const GIT_FORMAT = `%H${UNIT_SEP}%h${UNIT_SEP}%an${UNIT_SEP}%aI${UNIT_SEP}%s${RECORD_SEP}`;

export interface GitCommitEntry {
	hash: string;
	short_hash: string;
	author: string;
	/** ISO 8601 author date. */
	date: string;
	subject: string;
}

export interface GitHistoryResult {
	entries: GitCommitEntry[];
	notes: string[];
	_meta: {
		repo_root: string | null;
		paths: string[];
		followed_renames: boolean;
	};
}

export interface GitHistoryOptions {
	/** File paths (relative to repoPath, or absolute) to log commits for. */
	paths: string[];
	/** Max commits to return. */
	limit?: number;
	/** Working directory to resolve the repo from. Defaults to process.cwd(). */
	repoPath?: string;
}

/**
 * Fetch recent commits touching the given paths.
 *
 * Never throws — a missing git binary, a non-repo directory, or untracked paths
 * all produce an empty entry list plus an explanatory note.
 */
export async function buildGitHistory(
	options: GitHistoryOptions,
): Promise<GitHistoryResult> {
	const limit = clamp(options.limit ?? DEFAULT_GIT_LIMIT, 1, MAX_GIT_LIMIT);
	const cwd = options.repoPath || process.cwd();

	// Drop empties. Everything after `--` is a pathspec to git, so no further
	// sanitizing is needed to keep caller input from being read as a flag.
	const paths = [...new Set(options.paths.map((p) => p?.trim()).filter((p): p is string => !!p))];

	const result: GitHistoryResult = {
		entries: [],
		notes: [],
		_meta: { repo_root: null, paths, followed_renames: false },
	};

	if (paths.length === 0) {
		result.notes.push(
			"No source file paths available for git history. Pass codeInfo.filePath / codeInfo.sourceFiles, or history.gitPaths explicitly.",
		);
		return result;
	}

	let exec: ExecFileFn;
	try {
		exec = await loadExecFile();
	} catch (e) {
		result.notes.push(
			`Git history unavailable in this runtime: ${e instanceof Error ? e.message : String(e)}`,
		);
		return result;
	}

	// Confirm we're in a repo before running the real query, so "not a repo"
	// produces a clear note rather than a cryptic git error.
	const rootProbe = await runGit(exec, ["rev-parse", "--show-toplevel"], cwd);
	if (!rootProbe.ok) {
		result.notes.push(
			`Not a git repository (or git unavailable) at ${cwd}: ${firstLine(rootProbe.stderr) || rootProbe.error}`,
		);
		return result;
	}
	result._meta.repo_root = rootProbe.stdout.trim() || null;

	// `--follow` traces a file across renames but git only supports it for a
	// SINGLE pathspec — with several paths it errors out, so opt in only when
	// exactly one path was requested.
	const followRenames = paths.length === 1;
	result._meta.followed_renames = followRenames;

	const args = [
		"log",
		`-n`,
		String(limit),
		`--format=${GIT_FORMAT}`,
		...(followRenames ? ["--follow"] : []),
		"--",
		...paths,
	];

	const logResult = await runGit(exec, args, cwd);
	if (!logResult.ok) {
		result.notes.push(
			`git log failed: ${firstLine(logResult.stderr) || logResult.error}`,
		);
		return result;
	}

	result.entries = parseGitLog(logResult.stdout);

	if (result.entries.length === 0) {
		result.notes.push(
			`No commits found touching ${paths.map((p) => `\`${p}\``).join(", ")}. The paths may be untracked, or relative to a different directory than ${result._meta.repo_root ?? cwd}.`,
		);
	}

	logger.info(
		{ cwd, paths, entries: result.entries.length, followRenames },
		"Built git history",
	);

	return result;
}

// ============================================================================
// Parsing
// ============================================================================

/** Exported for unit testing — parses the record-separated `git log` output. */
export function parseGitLog(stdout: string): GitCommitEntry[] {
	const entries: GitCommitEntry[] = [];
	for (const rawRecord of stdout.split(RECORD_SEP)) {
		const record = rawRecord.replace(/^[\r\n]+/, "");
		if (record.trim() === "") continue;
		const fields = record.split(UNIT_SEP);
		if (fields.length < 5) continue;
		const [hash, shortHash, author, date, subject] = fields;
		entries.push({
			hash: hash.trim(),
			short_hash: shortHash.trim(),
			author: author.trim(),
			date: date.trim(),
			// Only the trailing newline is structural; keep interior text intact.
			subject: subject.replace(/[\r\n]+$/, "").trim(),
		});
	}
	return entries;
}

// ============================================================================
// Process plumbing
// ============================================================================

type ExecFileFn = (
	file: string,
	args: string[],
	options: { cwd: string; timeout: number; maxBuffer: number; windowsHide: boolean },
	callback: (
		error: (Error & { code?: number | string }) | null,
		stdout: string,
		stderr: string,
	) => void,
) => unknown;

/**
 * Dynamically resolve execFile. Kept out of the module's static import graph so
 * bundling for Cloudflare Workers (which has no child_process) does not break.
 */
async function loadExecFile(): Promise<ExecFileFn> {
	const mod = await import(/* webpackIgnore: true */ "node:child_process");
	const execFile = (mod as any).execFile;
	if (typeof execFile !== "function") {
		throw new Error("child_process.execFile is not available");
	}
	return execFile as ExecFileFn;
}

interface GitRunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	error: string;
}

function runGit(exec: ExecFileFn, args: string[], cwd: string): Promise<GitRunResult> {
	return new Promise((resolve) => {
		try {
			exec(
				"git",
				args,
				{ cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
				(error, stdout, stderr) => {
					resolve({
						ok: !error,
						stdout: stdout ?? "",
						stderr: stderr ?? "",
						error: error ? error.message : "",
					});
				},
			);
		} catch (e) {
			resolve({
				ok: false,
				stdout: "",
				stderr: "",
				error: e instanceof Error ? e.message : String(e),
			});
		}
	});
}

// ============================================================================
// Helpers
// ============================================================================

function firstLine(s: string): string {
	return (s || "").split("\n")[0].trim();
}

function clamp(n: number, min: number, max: number): number {
	return Math.min(Math.max(n, min), max);
}
