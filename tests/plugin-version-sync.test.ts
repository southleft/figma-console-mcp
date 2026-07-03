/**
 * Plugin version handshake invariants.
 *
 * History:
 * - Issue #62: figma-desktop-bridge/code.js had PLUGIN_VERSION frozen at
 *   1.14.0 while the package moved on. Figma Desktop caches plugin files;
 *   a never-changing version meant users kept running stale code.js and new
 *   methods failed with "Unknown method". Fix: release.sh bumps
 *   PLUGIN_VERSION whenever plugin files change.
 * - v1.33.1 false positive: the FILE_INFO handshake compared the plugin's
 *   reported version against the SERVER package version with strict !==.
 *   Server-only releases (deps, docs) bump package.json without touching
 *   plugin files, so an up-to-date plugin (1.33.0) connected to server
 *   1.33.1 was falsely flagged stale and users were nagged to re-import a
 *   manifest that would install byte-identical files. Fix: the handshake
 *   compares against the version embedded in the BUNDLED code.js (what a
 *   re-import actually installs), and release.sh only bumps PLUGIN_VERSION
 *   when figma-desktop-bridge/ changed since the last release.
 *
 * Invariants enforced here:
 * 1. PLUGIN_VERSION in code.js is present and parseable.
 * 2. PLUGIN_VERSION never EXCEEDS package.json (it may lag on server-only
 *    releases, but a plugin newer than the package means a manual edit
 *    bypassed release.sh).
 * 3. getBundledPluginVersion() returns exactly the constant from the shipped
 *    code.js — the handshake's comparison anchor.
 * 4. computePluginUpdateAvailable() ignores the server version entirely.
 */

import * as fs from "fs";
import * as path from "path";
import {
	parseBundledPluginVersion,
	getBundledPluginVersion,
	computePluginUpdateAvailable,
} from "../src/core/websocket-server";

const root = path.resolve(__dirname, "..");
const pkgVersion: string = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const codeJs = fs.readFileSync(
	path.join(root, "figma-desktop-bridge", "code.js"),
	"utf8",
);

/** Numeric semver comparison: negative when a < b, 0 when equal, positive when a > b. */
function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
}

describe("#62 plugin version drift", () => {
	it("figma-desktop-bridge/code.js has a parseable PLUGIN_VERSION", () => {
		expect(parseBundledPluginVersion(codeJs)).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("PLUGIN_VERSION never exceeds package.json version", () => {
		const pluginVersion = parseBundledPluginVersion(codeJs)!;
		// May lag (server-only releases don't bump it) but must never lead.
		expect(compareSemver(pluginVersion, pkgVersion)).toBeLessThanOrEqual(0);
	});

	it("getBundledPluginVersion() reads the constant from the shipped code.js", () => {
		expect(getBundledPluginVersion()).toBe(parseBundledPluginVersion(codeJs));
	});
});

describe("v1.33.1 regression — server-only releases must not flag the plugin stale", () => {
	it("plugin matching the bundled version is current, regardless of server version", () => {
		// The live false positive: plugin 1.33.0, server package 1.33.1,
		// bundled plugin files still 1.33.0. No re-import needed.
		expect(computePluginUpdateAvailable("1.33.0", "1.33.0")).toBe(false);
	});

	it("plugin older than the bundled version is stale", () => {
		expect(computePluginUpdateAvailable("1.32.0", "1.33.0")).toBe(true);
	});

	it("plugin that reports no version is stale (predates version reporting)", () => {
		expect(computePluginUpdateAvailable(null, "1.33.0")).toBe(true);
	});

	it("parseBundledPluginVersion returns null for sources without the constant", () => {
		expect(parseBundledPluginVersion("var x = 1;")).toBeNull();
		expect(parseBundledPluginVersion("var PLUGIN_VERSION = 'abc'")).toBeNull();
	});
});
