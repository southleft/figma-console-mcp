/**
 * Regression test for issue #62 — figma_get_component_for_development_deep
 * fails with "Unknown method: DEEP_GET_COMPONENT".
 *
 * Root cause: figma-desktop-bridge/code.js had `PLUGIN_VERSION = '1.14.0'`
 * hardcoded while the npm package was at 1.22.3. Figma Desktop appears to
 * use the version string as a cache key for plugin files; if it never
 * changes, Figma keeps serving cached code.js / ui.html that predate any
 * newer methods (DEEP_GET_COMPONENT, ANALYZE_COMPONENT_SET, etc).
 *
 * scripts/release.sh now syncs PLUGIN_VERSION on every release. This test
 * ensures the value stays aligned with package.json so a manual edit that
 * bypasses release.sh is caught at test time.
 */

import * as fs from "fs";
import * as path from "path";

describe("#62 plugin version drift", () => {
	it("figma-desktop-bridge/code.js PLUGIN_VERSION matches package.json version", () => {
		const root = path.resolve(__dirname, "..");
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		const codeJs = fs.readFileSync(
			path.join(root, "figma-desktop-bridge", "code.js"),
			"utf8",
		);

		const match = codeJs.match(/var PLUGIN_VERSION\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'/);
		expect(match).not.toBeNull();
		const pluginVersion = match![1];

		expect(pluginVersion).toBe(pkg.version);
	});
});
