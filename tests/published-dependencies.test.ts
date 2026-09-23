/**
 * What `npm install figma-console-mcp` / `npx figma-console-mcp` installs must be
 * exactly what the npm entry point (src/local.ts) needs at runtime.
 *
 * Reported 2026-09-23 from a production dependency audit: figma-console-mcp →
 * @cloudflare/puppeteer → @puppeteer/browsers → extract-zip (high; symlink path
 * traversal, GHSA-7pqw-9j4j-h8q3 / GHSA-jmr9-qjv8-65gv, no fixed release). The
 * local server never loads Puppeteer — only the Cloudflare Worker (src/index.ts)
 * does — but it was a `dependency`, so every consumer installed it and every
 * consumer's audit flagged it, with no way for them to fix it.
 *
 * Both directions are guarded:
 *   - every package the local runtime graph imports is a declared `dependency`
 *     (moving something to devDependencies must never break `npx` users), and
 *   - Worker-only packages stay out of `dependencies`.
 */

import { readFileSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";

const root = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const dependencies = new Set(Object.keys(pkg.dependencies ?? {}));

/** Loaded by a string name at runtime, which no import scan can see */
const LOADED_BY_NAME = new Set([
	"pino-pretty", // pino transport target in src/core/logger.ts (TTY mode)
]);

/** Used only by the Cloudflare Worker entry (src/index.ts), built from this repo */
const WORKER_ONLY = ["@cloudflare/puppeteer", "agents"];

/** Bare package names imported at RUNTIME by the local entry's source graph */
function runtimeImportsOfLocalEntry(): Map<string, string> {
	const seen = new Set<string>();
	const bare = new Map<string, string>();
	const IMPORT = /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

	const visit = (file: string) => {
		if (seen.has(file) || !existsSync(file)) return;
		seen.add(file);
		const src = readFileSync(file, "utf8");
		// Collect before recursing: a shared /g regex's lastIndex would be clobbered
		// by the nested visit() calls and silently skip imports.
		for (const m of [...src.matchAll(IMPORT)]) {
			if (m[2]) continue; // `import type` / `export type` — erased at compile time
			const spec = m[3] ?? m[4] ?? m[5];
			if (!spec) continue;
			if (spec.startsWith(".")) {
				const target = resolve(dirname(file), spec).replace(/\.js$/, ".ts");
				visit(target.endsWith(".ts") ? target : `${target}.ts`);
			} else if (!spec.startsWith("node:") && !builtinModules.includes(spec.split("/")[0])) {
				const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
				if (!bare.has(name)) bare.set(name, file.replace(`${root}/`, ""));
			}
		}
	};
	visit(resolve(root, "src/local.ts"));
	return bare;
}

describe("published dependencies match the npm runtime", () => {
	const imports = runtimeImportsOfLocalEntry();

	it("walks a real graph (sanity check on the scanner itself)", () => {
		expect(imports.has("@modelcontextprotocol/sdk")).toBe(true);
		expect(imports.has("zod")).toBe(true);
		expect(imports.size).toBeGreaterThan(5);
	});

	it("every package the local server imports at runtime is a declared dependency", () => {
		const undeclared = [...imports].filter(([name]) => !dependencies.has(name)).map(([name, from]) => `${name} (imported by ${from})`);
		expect(undeclared).toEqual([]);
	});

	it("keeps Worker-only packages out of what npm users install", () => {
		for (const name of WORKER_ONLY) {
			expect({ name, inDependencies: dependencies.has(name) }).toEqual({ name, inDependencies: false });
			expect({ name, importedByLocal: imports.has(name) }).toEqual({ name, importedByLocal: false });
		}
	});

	it("declares no production dependency that the npm runtime never loads", () => {
		const unused = [...dependencies].filter((d) => !imports.has(d) && !LOADED_BY_NAME.has(d));
		// uuid predates this check and is unused everywhere — tracked separately
		expect(unused.filter((d) => d !== "uuid")).toEqual([]);
	});

	it("does not publish the Worker build, whose imports are dev-only", () => {
		expect(pkg.files).toContain("!dist/cloudflare");
	});
});
