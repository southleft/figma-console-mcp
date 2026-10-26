/**
 * figma_scan_code_accessibility must never execute scripts contained in the
 * HTML it scans (issue #104 SEC-001). JSDOM used to run with
 * runScripts: "dangerously", so a <script> in caller-supplied HTML ran inside
 * this Node process.
 *
 * Runs the REAL tool handler in a child process via tsx, because Jest cannot
 * load jsdom's ESM build in-process.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const ROOT = resolve(__dirname, "..");

function runRealScan(html: string): { pwned: unknown; body: any } {
	const dir = mkdtempSync(join(tmpdir(), "fcm-a11y-"));
	const script = join(dir, "scan.mts");
	writeFileSync(
		script,
		`
import { registerAccessibilityTools } from ${JSON.stringify(join(ROOT, "src/core/accessibility-tools.ts"))};
let handler;
registerAccessibilityTools({ tool: (name, _d, _s, fn) => { if (name === "figma_scan_code_accessibility") handler = fn; } });
const res = await handler({ html: ${JSON.stringify(html)} });
console.log(JSON.stringify({ pwned: globalThis.__scanPwned ?? null, body: JSON.parse(res.content[0].text) }));
`,
	);
	try {
		const out = execFileSync(process.execPath, ["--import", "tsx", script], {
			cwd: ROOT,
			encoding: "utf-8",
			timeout: 60000,
			env: { ...process.env, LOG_LEVEL: "silent" },
		});
		return JSON.parse(out.trim().split("\n").pop() as string);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("figma_scan_code_accessibility script isolation", () => {
	it("does not run <script> tags or inline handlers from the scanned HTML", () => {
		const { pwned, body } = runRealScan(
			'<script>try { this.constructor.constructor("globalThis.__scanPwned = 1")(); } catch (e) {} globalThis.__scanPwned = globalThis.__scanPwned || 3;</script>' +
				'<img src="x" onerror="globalThis.__scanPwned = 2">',
		);
		expect(pwned).toBeNull();
		// The scan itself still works: the <img> has no alt text.
		expect(JSON.stringify(body)).toContain("image-alt");
	}, 90000);
});
