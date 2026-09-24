/**
 * figma_generate_component_doc — third report from Robin Di Capua (v1.40.5).
 * A two-part tabs component: a tab bar with one variant property, and a tab
 * item with State × Is Selected plus a boolean that reveals a focus ring.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildAnatomyTree,
	collectAllVariantData,
	collectSpacingAcrossVariants,
	collectTypographyAcrossVariants,
	generateOverviewSection,
	generateParitySection,
	generateStatesAndVariantsSection,
	generateVisualSpecsSection,
	resolvePropertyBinding,
} from "../src/core/design-code-tools";
import { blobUrl, commitUrl, remoteToWebBase, resolveSourceRevision } from "../src/core/history/git-history";

const names = new Map([["v-r-sm", "Radius/sm"], ["v-r-md", "Radius/md"], ["v-sw", "Border/width"], ["v-focus", "Border/Focus"], ["v-pad", "Space/sm"]]);
const corners = (id: string, which = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]) =>
	Object.fromEntries(which.map((k) => [k, { type: "VARIABLE_ALIAS", id }]));

describe("1 — radius bindings are read per corner", () => {
	it("all four corners on one variable → that variable (there is no cornerRadius key)", () => {
		expect(resolvePropertyBinding({ cornerRadius: 4, boundVariables: corners("v-r-sm") }, "cornerRadius", names).name).toBe("Radius/sm");
	});

	it("different variables per corner → reported per corner", () => {
		const node = { boundVariables: { ...corners("v-r-sm", ["topLeftRadius", "topRightRadius"]), ...corners("v-r-md", ["bottomRightRadius", "bottomLeftRadius"]) } };
		expect(resolvePropertyBinding(node, "cornerRadius", names).name).toBe("top-left: Radius/sm, top-right: Radius/sm, bottom-right: Radius/md, bottom-left: Radius/md");
	});

	it("some corners bound → says which", () => {
		expect(resolvePropertyBinding({ boundVariables: corners("v-r-sm", ["topLeftRadius", "topRightRadius"]) }, "cornerRadius", names).name).toBe("Radius/sm (top-left, top-right only)");
	});

	it("per-side stroke weights: only painted sides count", () => {
		const underline = { strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], individualStrokeWeights: { top: 0, right: 0, bottom: 4, left: 0 }, boundVariables: { strokeBottomWeight: { id: "v-sw" } } };
		expect(resolvePropertyBinding(underline, "strokeWeight", names).name).toBe("Border/width");
	});

	it("REPORTED: the cross-variant table shows the radius token, and can now flag a binding split", () => {
		const set = { type: "COMPONENT_SET", children: [
			{ name: "State=Default", cornerRadius: 0 },
			{ name: "State=Hover", cornerRadius: 4, boundVariables: corners("v-r-sm") },
			{ name: "State=Pressed", cornerRadius: 4, boundVariables: corners("v-r-sm") },
		] };
		const c = collectSpacingAcrossVariants(set, names);
		const row = c.rows.find((r) => r.property === "Border radius")!;
		expect(row.variableCell).toContain("`Radius/sm`");
		expect(row.variableCell).toContain("unbound");
	});
});

describe("1 (live) — the REST shapes this tool actually receives", () => {
	// Captured from CBDS Tooltip / a bordered shape via exportAsync({format:"JSON_REST_V1"})
	const alias = (id: string) => ({ type: "VARIABLE_ALIAS", id });
	it("reads rectangleCornerRadii.RECTANGLE_*_CORNER_RADIUS", () => {
		const node = { cornerRadius: 4, boundVariables: { rectangleCornerRadii: {
			RECTANGLE_TOP_LEFT_CORNER_RADIUS: alias("v-r-sm"), RECTANGLE_TOP_RIGHT_CORNER_RADIUS: alias("v-r-sm"),
			RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: alias("v-r-sm"), RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: alias("v-r-sm"),
		} } };
		expect(resolvePropertyBinding(node, "cornerRadius", names).name).toBe("Radius/sm");
	});
	it("reads individualStrokeWeights.BORDER_*_WEIGHT", () => {
		const node = { strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], strokeWeight: 2, boundVariables: { individualStrokeWeights: {
			BORDER_TOP_WEIGHT: alias("v-sw"), BORDER_BOTTOM_WEIGHT: alias("v-sw"), BORDER_LEFT_WEIGHT: alias("v-sw"), BORDER_RIGHT_WEIGHT: alias("v-sw"),
		} } };
		expect(resolvePropertyBinding(node, "strokeWeight", names).name).toBe("Border/width");
	});
});

describe("2 — Design-Code Parity", () => {
	const tabs = { type: "COMPONENT_SET", children: [{ name: "Is scrollable=False" }, { name: "Is scrollable=True" }] };
	const item = {
		type: "COMPONENT_SET",
		componentPropertyDefinitions: { "Is Focused#123:4": { type: "BOOLEAN", defaultValue: false } },
		children: [{ name: "State=Default, Is Selected=True" }, { name: "State=Hover, Is Selected=False" }],
	};

	it("compares a True/False variant with a boolean prop, matching with or without 'is'", () => {
		const md = generateParitySection(tabs, { props: [{ name: "scrollable", type: "boolean" }] } as any);
		expect(md).toContain("| Is scrollable ↔ `scrollable` | Yes | Yes | In sync (boolean) |");
	});

	it("compares a BOOLEAN component property too, and lists what had no counterpart", () => {
		const md = generateParitySection(item, { props: [{ name: "isSelected", type: "boolean" }, { name: "isFocused", type: "boolean" }] } as any);
		expect(md).toContain("| Is Selected ↔ `isSelected` | Yes | Yes | In sync (boolean) |");
		expect(md).toContain("| Is Focused ↔ `isFocused` | Yes | Yes | In sync (boolean) |");
		expect(md).toContain("- Figma: State (Default | Hover)"); // hover is not a prop — said, not silently dropped
	});

	it("never prints a bare heading: says nothing was compared, or leaves the section out", () => {
		const md = generateParitySection(tabs, { props: [{ name: "onChange", type: "() => void" }] } as any);
		expect(md).toContain("nothing was compared");
		expect(md).toContain("- Figma: Is scrollable (True/False)");
		expect(generateParitySection({ type: "COMPONENT" }, { props: [] } as any)).toBe("");
	});

	it("flags a type mismatch instead of guessing", () => {
		const md = generateParitySection(tabs, { props: [{ name: "scrollable", type: '"auto" | "always"' }] } as any);
		expect(md).toMatch(/Is scrollable: (True|False).*Figma-only/);
	});
});

describe("3 — source links resolve, and the code side is pinned to a commit", () => {
	let repo: string;
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "fcm-src-rev-"));
		git("init", "-q");
		git("config", "user.email", "t@example.com"); git("config", "user.name", "T");
		mkdirSync(join(repo, "src/tabs"), { recursive: true });
		writeFileSync(join(repo, "src/tabs/Tabs.tsx"), "export {}\n");
		writeFileSync(join(repo, "src/tabs/Tabs.stories.tsx"), "export {}\n");
		git("add", "."); git("commit", "-qm", "init");
		git("remote", "add", "origin", "https://user:SECRET_TOKEN@github.com/acme/ds.git");
		mkdirSync(join(repo, "node_modules/@acme/ds"), { recursive: true });
		writeFileSync(join(repo, "node_modules/@acme/ds/Tabs.js"), "x\n"); // an installed package: untracked
	});
	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	it("strips credentials and maps hosts; unknown hosts get no guessed URL", () => {
		expect(remoteToWebBase("https://user:SECRET@github.com/acme/ds.git")).toEqual({ webBase: "https://github.com/acme/ds", host: "github" });
		expect(remoteToWebBase("git@gitlab.com:acme/ds.git")).toEqual({ webBase: "https://gitlab.com/acme/ds", host: "gitlab" });
		expect(remoteToWebBase("git@git.internal.corp:acme/ds.git")).toBeNull();
	});

	it("resolves commit, tracked files and dirtiness — and leaves untracked (installed) files unlinked", async () => {
		const rev = (await resolveSourceRevision({ paths: ["src/tabs/Tabs.tsx", "node_modules/@acme/ds/Tabs.js"], repoPath: repo }))!;
		expect(rev.commit).toBe(git("rev-parse", "HEAD"));
		expect(rev.webBase).toBe("https://github.com/acme/ds");
		expect(JSON.stringify(rev)).not.toContain("SECRET_TOKEN");
		expect(rev.tracked.get("src/tabs/Tabs.tsx")).toBe("src/tabs/Tabs.tsx");
		expect(rev.tracked.has("node_modules/@acme/ds/Tabs.js")).toBe(false);
		expect(rev.dirty).toBe(false);
		writeFileSync(join(repo, "src/tabs/Tabs.tsx"), "export const x = 1\n");
		expect((await resolveSourceRevision({ paths: ["src/tabs/Tabs.tsx"], repoPath: repo }))!.dirty).toBe(true);
		expect(blobUrl(rev, "src/tabs/Tabs.tsx")).toBe(`https://github.com/acme/ds/blob/${rev.commit}/src/tabs/Tabs.tsx`);
		expect(commitUrl(rev, "abc")).toBe("https://github.com/acme/ds/commit/abc");
	});

	it("links only what resolves; a stories FILE is 'Stories source', a storybookUrl is 'Storybook'", () => {
		const parsed = { overview: "", whenToUse: [], whenNotToUse: [], contentGuidelines: [], accessibilityNotes: [], additionalNotes: [] } as any;
		const code = { filePath: "src/tabs/Tabs.tsx", sourceFiles: [{ path: "src/tabs/Tabs.stories.tsx", role: "stories" }] } as any;
		const unresolved = generateOverviewSection("Tabs", "", "https://figma.com/x", parsed, code);
		expect(unresolved).toContain("Source: `src/tabs/Tabs.tsx`");
		expect(unresolved).toContain("Stories source: `src/tabs/Tabs.stories.tsx`");
		expect(unresolved).not.toMatch(/\]\(src\//); // no raw relative links
		expect(unresolved).not.toContain("[Storybook]");
		const resolved = generateOverviewSection("Tabs", "", "https://figma.com/x", parsed, { ...code, storybookUrl: "https://sb.acme.dev/?path=/story/tabs" }, (p) => `https://github.com/acme/ds/blob/abc/${p}`);
		expect(resolved).toContain("**[View Source](https://github.com/acme/ds/blob/abc/src/tabs/Tabs.tsx)**");
		expect(resolved).toContain("**[Storybook](https://sb.acme.dev/?path=/story/tabs)**");
		expect(resolved).toContain("**[Stories source](https://github.com/acme/ds/blob/abc/src/tabs/Tabs.stories.tsx)**");
	});
});

// A tab item whose focus ring is hidden and revealed by the "Is Focused" boolean
const BLUE = { r: 0, g: 0.4, b: 1 };
const focusRing = { name: "Focus Ring", type: "RECTANGLE", visible: false, componentPropertyReferences: { visible: "Is Focused#123:4" }, strokes: [{ type: "SOLID", color: BLUE, boundVariables: { color: { id: "v-focus" } } }] };
const label = (weight: number) => ({ name: "Label", type: "TEXT", fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], style: { fontFamily: "Sans VF", fontWeight: weight, fontSize: 16, lineHeightPx: 24, letterSpacing: 0 } });
const tabItemSet = {
	name: "Tab Item", type: "COMPONENT_SET",
	componentPropertyDefinitions: {
		State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default"] },
		"Is Focused#123:4": { type: "BOOLEAN", defaultValue: false },
	},
	children: [{ name: "State=Default", type: "COMPONENT", children: [label(400), focusRing] }],
};

describe("4 — a hidden layer is linked to the boolean that shows it", () => {
	it("anatomy and Color Tokens say what shows the layer", () => {
		expect(buildAnatomyTree(tabItemSet.children[0])).toContain("Focus Ring (RECTANGLE) (hidden — shown when Is Focused = true)");
		const md = generateVisualSpecsSection(tabItemSet.children[0], null, collectAllVariantData(tabItemSet, names), names, tabItemSet);
		expect(md).toContain("| Stroke (Focus Ring) _(hidden — shown when Is Focused = true)_ | `Border/Focus` |");
	});

	it("Configurable Properties describes the boolean by the layer it controls", () => {
		const md = generateStatesAndVariantsSection(tabItemSet, collectAllVariantData(tabItemSet, names));
		expect(md).toContain("| **Is Focused** | `boolean` | `false` | Shows/hides **Focus Ring** |");
		expect(md).not.toContain("is focused element");
	});

	it("a boolean that controls nothing we can see is not given an invented element name", () => {
		const set = { ...tabItemSet, componentPropertyDefinitions: { ...tabItemSet.componentPropertyDefinitions, "Compact#9:9": { type: "BOOLEAN", defaultValue: true } } };
		expect(generateStatesAndVariantsSection(set, [])).toContain("| **Compact** | `boolean` | `true` | Boolean toggle |");
	});
});

describe("5 — same-named layers in different nested instances are told apart", () => {
	const tab = (selected: boolean) => ({
		name: "Tab", type: "INSTANCE",
		componentProperties: { "Is Selected": { type: "VARIANT", value: selected ? "True" : "False" }, "Is Focused#123:4": { type: "BOOLEAN", value: false } },
		children: [{ ...label(selected ? 600 : 400), fills: [{ type: "SOLID", color: selected ? BLUE : { r: 0.3, g: 0.3, b: 0.3 } }] }],
	});
	const bar = { name: "Tabs", type: "COMPONENT_SET", children: [
		{ name: "Is scrollable=False", type: "COMPONENT", children: [tab(true), tab(false), tab(false)] },
		{ name: "Is scrollable=True", type: "COMPONENT", children: [tab(true), tab(false)] },
	] };

	it("typography rows sharing a name are qualified by their instance's variant", () => {
		const rows = collectTypographyAcrossVariants(bar);
		expect(rows.map((r) => r.style.nodeName)).toEqual(["Label in Tab (Is Selected=True)", "Label in Tab (Is Selected=False)"]);
	});

	it("Color Tokens text rows too — and only when the name is actually ambiguous", () => {
		const md = generateVisualSpecsSection(bar.children[0], null, collectAllVariantData(bar, names), names, bar);
		expect(md).toContain("| Text (Label in Tab (Is Selected=True)) |");
		expect(md).toContain("| Text (Label in Tab (Is Selected=False)) |");
		const plain = { name: "X", type: "COMPONENT_SET", children: [{ name: "A=1", type: "COMPONENT", children: [tab(true)] }] };
		expect(generateVisualSpecsSection(plain.children[0], null, collectAllVariantData(plain, names), names, plain)).toContain("| Text (Label) |");
	});
});

// ---------------------------------------------------------------------------
// Found in independent review of this change
// ---------------------------------------------------------------------------

import { displayPath, generateFrontmatter } from "../src/core/design-code-tools";
import { formatVariables } from "../src/core/figma-api";

describe("review: published docs never disclose local paths", () => {
	it("absolute paths become repo-relative, or just the file name", () => {
		expect(displayPath("/Users/robin/work/ds/src/tabs/Tabs.tsx", "/Users/robin/work/ds")).toBe("src/tabs/Tabs.tsx");
		expect(displayPath("/Users/robin/elsewhere/Tabs.tsx", "/Users/robin/work/ds")).toBe("Tabs.tsx");
		expect(displayPath("/Users/robin/work/ds/src/Tabs.tsx")).toBe("Tabs.tsx");
		expect(displayPath("src/tabs/Tabs.tsx")).toBe("src/tabs/Tabs.tsx");
	});

	it("overview and frontmatter use it", () => {
		const parsed = { overview: "", whenToUse: [], whenNotToUse: [], contentGuidelines: [], accessibilityNotes: [], additionalNotes: [] } as any;
		const code = { filePath: "/Users/robin/work/ds/src/tabs/Tabs.tsx" } as any;
		const md = generateOverviewSection("Tabs", "", "https://figma.com/x", parsed, code, undefined, "/Users/robin/work/ds");
		expect(md).toContain("Source: `src/tabs/Tabs.tsx`");
		expect(md).not.toContain("/Users/");
		const fm = generateFrontmatter("Tabs", "", { type: "COMPONENT" }, null, "https://figma.com/x", code);
		expect(fm).toContain("source: Tabs.tsx");
		expect(fm).not.toContain("/Users/");
	});
});

describe("review: parity treats a `true | false` literal type as boolean", () => {
	it("matches a True/False variant", () => {
		const tabs = { type: "COMPONENT_SET", children: [{ name: "Is scrollable=False" }, { name: "Is scrollable=True" }] };
		expect(generateParitySection(tabs, { props: [{ name: "scrollable", type: "true | false" }] } as any)).toContain("In sync (boolean)");
	});
});

describe("review: the cross-axis gap of a wrapping layout is reported with its binding", () => {
	it("reads counterAxisSpacing and its own binding key", () => {
		const set = { type: "COMPONENT_SET", children: [
			{ name: "A=1", layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 8, counterAxisSpacing: 12, boundVariables: { counterAxisSpacing: { id: "v-pad" } } },
			{ name: "A=2", layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 8, counterAxisSpacing: 12, boundVariables: { counterAxisSpacing: { id: "v-pad" } } },
		] };
		expect(collectSpacingAcrossVariants(set, names).rows.find((r) => r.property === "Row gap (wrap)")).toMatchObject({ valueCell: "12px", variableCell: "`Space/sm`" });
	});
});

describe("review: REST-sourced variables keep extended-collection fields", () => {
	it("formatVariables no longer strips them", () => {
		const out = formatVariables({
			variableCollections: {
				"c-b": { name: "Brand B", modes: [{ modeId: "b1", name: "Light", parentModeId: "l1" }], variableIds: ["v1"], isExtension: true, parentVariableCollectionId: "c-a", rootVariableCollectionId: "c-a", variableOverrides: { v1: { b1: 3 } } },
				"c-a": { name: "Brand", modes: [{ modeId: "l1", name: "Light" }], variableIds: ["v1"] },
			},
			variables: {},
		});
		expect(out.collections.find((c: any) => c.id === "c-b")).toMatchObject({ isExtension: true, parentVariableCollectionId: "c-a", variableOverrides: { v1: { b1: 3 } } });
		expect(out.collections.find((c: any) => c.id === "c-a").isExtension).toBeUndefined();
	});
});
