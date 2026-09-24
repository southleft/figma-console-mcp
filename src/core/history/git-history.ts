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

import { basename, isAbsolute } from "node:path";
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
			// Folder name only: these notes are rendered into published docs
			`Not a git repository (or git unavailable) at \`${basename(cwd)}\`: ${firstLine(rootProbe.stderr) || rootProbe.error}`,
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
			`No commits found touching ${paths.map((p) => `\`${isAbsolute(p) ? basename(p) : p}\``).join(", ")}. The paths may be untracked, or relative to a different directory than the repository root (\`${basename(result._meta.repo_root ?? cwd)}\`).`,
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

/** Where the documented code came from, so a generated page can be pinned to it */
export interface SourceRevision {
	/** Web URL of the repository (credentials stripped), or null for unknown hosts */
	webBase: string | null;
	host: "github" | "gitlab" | "bitbucket" | null;
	/** Full SHA of HEAD */
	commit: string;
	/** True when any of the documented files differ from HEAD */
	dirty: boolean;
	/** Input path → path relative to the repo root, for files git tracks */
	tracked: Map<string, string>;
}

/**
 * Turn a git remote into a browsable web URL. Credentials are always dropped —
 * `https://user:token@host/…` must never end up in published documentation.
 * Exported for unit testing.
 */
export function remoteToWebBase(remote: string): { webBase: string; host: SourceRevision["host"] } | null {
	const r = remote.trim();
	let host: string, path: string;
	const scp = r.match(/^[\w.-]+@([^:/]+):(.+)$/); // git@github.com:org/repo.git
	if (scp) { host = scp[1]; path = scp[2]; }
	else {
		try {
			const u = new URL(r); // https://…, ssh://git@host/…
			if (!/^(https?|ssh|git):$/.test(u.protocol)) return null;
			host = u.hostname; path = u.pathname.replace(/^\/+/, "");
		} catch { return null; }
	}
	path = path.replace(/\.git$/, "").replace(/\/+$/, "");
	if (!host || !path) return null;
	const kind = /(^|\.)github\.com$/i.test(host) ? "github"
		: /gitlab/i.test(host) ? "gitlab"
		: /(^|\.)bitbucket\.org$/i.test(host) ? "bitbucket"
		: null;
	if (!kind) return null; // unknown host: no guessing at URL layouts
	return { webBase: `https://${host}/${path}`, host: kind };
}

/** Browsable URL for a file at a commit, per host */
export function blobUrl(rev: Pick<SourceRevision, "webBase" | "host" | "commit">, repoRelativePath: string): string | null {
	if (!rev.webBase || !rev.host) return null;
	const p = repoRelativePath.split("/").map(encodeURIComponent).join("/");
	if (rev.host === "gitlab") return `${rev.webBase}/-/blob/${rev.commit}/${p}`;
	if (rev.host === "bitbucket") return `${rev.webBase}/src/${rev.commit}/${p}`;
	return `${rev.webBase}/blob/${rev.commit}/${p}`;
}

/** Browsable URL for a commit, per host */
export function commitUrl(rev: Pick<SourceRevision, "webBase" | "host">, sha: string): string | null {
	if (!rev.webBase || !rev.host) return null;
	if (rev.host === "gitlab") return `${rev.webBase}/-/commit/${sha}`;
	if (rev.host === "bitbucket") return `${rev.webBase}/commits/${sha}`;
	return `${rev.webBase}/commit/${sha}`;
}

/**
 * Resolve the commit the documented files are read at, and which of them git
 * tracks. Never throws; returns null outside a git repo. Files git does not
 * track (e.g. a design system installed under node_modules) are simply absent
 * from `tracked`, so no link is invented for them.
 */
export async function resolveSourceRevision(options: { paths: string[]; repoPath?: string }): Promise<SourceRevision | null> {
	const cwd = options.repoPath || process.cwd();
	const paths = [...new Set(options.paths.map((p) => p?.trim()).filter((p): p is string => !!p))];
	if (paths.length === 0) return null;
	let exec: ExecFileFn;
	try { exec = await loadExecFile(); } catch { return null; }

	const head = await runGit(exec, ["rev-parse", "HEAD"], cwd);
	if (!head.ok) return null;
	const commit = head.stdout.trim();

	const tracked = new Map<string, string>();
	for (const p of paths) {
		const ls = await runGit(exec, ["ls-files", "--full-name", "--error-unmatch", "--", p], cwd);
		const rel = ls.ok ? ls.stdout.trim().split("\n")[0] : "";
		if (rel) tracked.set(p, rel);
	}

	const status = tracked.size > 0
		? await runGit(exec, ["status", "--porcelain", "--", ...tracked.keys()], cwd)
		: { ok: true, stdout: "" } as GitRunResult;
	const remote = await runGit(exec, ["remote", "get-url", "origin"], cwd);
	const web = remote.ok ? remoteToWebBase(remote.stdout) : null;

	return {
		webBase: web?.webBase ?? null,
		host: web?.host ?? null,
		commit,
		dirty: !!(status.ok && status.stdout.trim()),
		tracked,
	};
}

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
