/**
 * Names, variant patterns, grouping and directory paging (spec §2.6.2,
 * §2.6.3, §8.1 "assets-svg-naming").
 */

import {
	artHashFor,
	baseNameOf,
	cleanName,
	compileVariantPattern,
	contentHash,
	formatVariantName,
	nameAndGroup,
	naturalCompare,
	newRunId,
	pageDirectory,
	standaloneDirName,
	parseVariantName,
	type CompiledPattern,
	type DirFile,
	type NameInput,
} from "../../src/core/assets/svg-naming";

function compile(pattern: string, axes?: Array<{ name: string; values: string[] }>): CompiledPattern {
	const c = compileVariantPattern(pattern, axes);
	if (!c.ok) throw new Error(c.error);
	return c.pattern;
}
const compileError = (pattern: string, axes?: Array<{ name: string; values: string[] }>) => {
	const c = compileVariantPattern(pattern, axes);
	return c.ok ? null : c.error;
};

describe("variant patterns", () => {
	it("{name}-{Size} parses arrow-left-24 with a greedy name", () => {
		expect(compile("{name}-{Size}").match("arrow-left-24")).toEqual({ name: "arrow-left", props: { Size: "24" } });
	});

	it("{Size}/{Style}/{name} parses 24/outline/arrow-left", () => {
		expect(compile("{Size}/{Style}/{name}").match("24/outline/arrow-left")).toEqual({ name: "arrow-left", props: { Size: "24", Style: "outline" } });
		// Axis values never span '/'.
		expect(compile("{Size}/{name}").match("a/b/c")).toEqual({ name: "b/c", props: { Size: "a" } });
	});

	it("axes values disambiguate {name}-{Style} and set variant order and the default", () => {
		// Without axes the greedy name takes "arrow-two" and Style "tone".
		expect(compile("{name}-{Style}").match("arrow-two-tone")).toEqual({ name: "arrow-two", props: { Style: "tone" } });
		const p = compile("{name}-{Style}", [{ name: "Style", values: ["solid", "two-tone"] }]);
		expect(p.match("arrow-two-tone")).toEqual({ name: "arrow", props: { Style: "two-tone" } });
		const inputs: NameInput[] = ["arrow-two-tone", "arrow-solid"].map((s, i) => ({ key: `k${i}`, source: `${s}.svg`, kind: "path", fileBase: s }));
		const res = nameAndGroup(inputs, { namePrefix: "", pattern: p, components: true });
		expect(res.groups).toEqual([{ kind: "set", name: "arrow", axes: ["Style"], keys: ["k1", "k0"] }]);
		expect(res.items.get("k1")?.name).toBe("Style=solid");
	});

	it("reports pattern errors; regex specials are literals", () => {
		expect(compileError("{Size}")).toBe("variants.pattern needs {name} exactly once.");
		expect(compileError("{name}-{name}-{Size}")).toBe("variants.pattern needs {name} exactly once.");
		expect(compileError("{name}-{Size}-{Size}")).toBe("variants.pattern uses {Size} twice.");
		expect(compileError("{name}")).toBe("variants.pattern needs at least one {Axis}, e.g. '{name}-{Size}'.");
		expect(compileError("{name}-{Size")).toBe("Unclosed '{' in variants.pattern.");
		expect(compileError("{name}-{Size}", [{ name: "Style", values: ["a"] }])).toBe('axes lists "Style", which isn\'t in variants.pattern.');
		expect(compileError("{name}-{9x}")).toMatch(/isn't \{name\} or an \{Axis\}/);
		const dot = compile("{name}.{Size}");
		expect(dot.match("icon.24")).toEqual({ name: "icon", props: { Size: "24" } });
		expect(dot.match("icon-24")).toBeNull();
		expect(compile("({name})+{Size}").match("(a)+1")).toEqual({ name: "a", props: { Size: "1" } });
	});

	it("matching stays fast on long adversarial names", () => {
		const p = compile("{name}-{A}-{B}-{C}-{D}-{E}-{F}");
		const subject = `${"-".repeat(298)}/`;
		// ~5 ms; a backtracking matcher takes hours here. The bound is far above anything parallel
		// jest workers or a slow CI runner (publish.yml runs `npm test`) can cause, and a slow run is
		// measured once more, so one GC pause or descheduling can't fail the suite.
		const run = () => {
			const t0 = performance.now();
			expect(p.match(subject)).toBeNull();
			return performance.now() - t0;
		};
		let took = run();
		if (took >= 5000) took = Math.min(took, run());
		expect(took).toBeLessThan(5000);
		expect(p.match("x".repeat(400))).toBeNull(); // over the subject cap
	});

	it("formats and parses variant names", () => {
		expect(formatVariantName(["Size", "Style"], { Style: "outline", Size: "24" })).toBe("Size=24, Style=outline");
		expect(parseVariantName("Size=24, Style=outline")).toEqual({ Size: "24", Style: "outline" });
		expect(parseVariantName("arrow")).toBeNull();
	});
});

describe("naming and grouping", () => {
	it("unmatched names become standalone components with a note", () => {
		const p = compile("{name}-{Size}");
		const inputs: NameInput[] = [
			{ key: "a", source: "home-16.svg", kind: "path", fileBase: "home-16" },
			{ key: "b", source: "logo.svg", kind: "path", fileBase: "logo" },
		];
		const res = nameAndGroup(inputs, { namePrefix: "Icon/", pattern: p, components: true });
		expect(res.items.get("b")).toMatchObject({ name: "Icon/logo" });
		expect(res.notes.get("b")).toEqual(['"logo.svg" doesn\'t match variants.pattern, so it became a standalone component.']);
		expect(res.groups.map((g) => g.kind)).toEqual(["set", "single"]);
	});

	it("groups by {name} + namePrefix, variant names in pattern order", () => {
		const p = compile("{Size}/{Style}/{name}");
		const rels = ["24/solid/bell", "16/outline/bell", "16/outline/zap"];
		const inputs: NameInput[] = rels.map((r, i) => ({ key: `k${i}`, source: `${r}.svg`, kind: "dir", relNoExt: r, fileBase: r.split("/").pop() }));
		const res = nameAndGroup(inputs, { namePrefix: "Icon/", pattern: p, components: true });
		const bell = res.groups.find((g) => g.kind === "set" && g.name === "Icon/bell");
		expect(bell).toMatchObject({ kind: "set", axes: ["Size", "Style"], keys: ["k1", "k0"] });
		expect(res.items.get("k0")).toMatchObject({ name: "Size=24, Style=solid", set: { name: "Icon/bell", props: { Size: "24", Style: "solid" } } });
	});

	it("fails only the later item for duplicate combinations and '=' or ',' values; extras beyond 100 variants fail", () => {
		const p = compile("{name}-{Size}");
		const inputs: NameInput[] = [
			{ key: "a", source: "x/arrow-16.svg", kind: "path", fileBase: "arrow-16" },
			{ key: "b", source: "y/arrow-16.svg", kind: "path", fileBase: "arrow-16" },
			{ key: "c", source: "arrow-a,b.svg", kind: "path", fileBase: "arrow-a,b" },
		];
		const res = nameAndGroup(inputs, { namePrefix: "", pattern: p, components: true });
		expect(res.items.has("a")).toBe(true);
		expect(res.failures.get("b")).toBe("Same variant as x/arrow-16.svg (Size=16).");
		expect(res.failures.get("c")).toBe('Variant value "a,b" can\'t contain "=" or ",". Figma reads variant names on those characters.');
		const many: NameInput[] = Array.from({ length: 102 }, (_, i) => ({ key: `m${i}`, source: `m-${i}.svg`, kind: "path", fileBase: `m-${i}` }));
		const big = nameAndGroup(many, { namePrefix: "", pattern: p, components: true });
		expect(big.groups[0].kind === "set" && big.groups[0].keys.length).toBe(100);
		expect(big.failures.size).toBe(2);
	});

	it("follows the base-name chain: item name → top-level name → file basename → <title> (inline) → SVG", () => {
		expect(baseNameOf({ key: "a", source: "s", kind: "inline", itemName: "  Bell\u0007 ", title: "T" }, "Top")).toBe("Bell");
		expect(baseNameOf({ key: "a", source: "s", kind: "inline", title: "T" }, "Top")).toBe("Top");
		expect(baseNameOf({ key: "a", source: "s", kind: "path", fileBase: "home", title: "Artboard 1" })).toBe("home");
		expect(baseNameOf({ key: "a", source: "s", kind: "inline", title: "Search" })).toBe("Search");
		expect(baseNameOf({ key: "a", source: "s", kind: "inline" })).toBe("SVG");
		expect(cleanName(`${"x".repeat(250)}`)).toHaveLength(200);
		// The top-level name only applies when exactly one SVG is given.
		const one = nameAndGroup([{ key: "a", source: "svgs[0]", kind: "inline", title: "T" }], { topName: "Rocket", namePrefix: "Icon/", components: false });
		expect(one.items.get("a")?.name).toBe("Icon/Rocket");
	});

	it("fails later standalone duplicates in a batch with a pattern hint (components only)", () => {
		const inputs: NameInput[] = [
			{ key: "a", source: "16/arrow.svg", kind: "dir", relNoExt: "16/arrow", fileBase: "arrow" },
			{ key: "b", source: "24/arrow.svg", kind: "dir", relNoExt: "24/arrow", fileBase: "arrow" },
		];
		const res = nameAndGroup(inputs, { namePrefix: "", components: true });
		expect(res.failures.get("b")).toBe('Another SVG in this batch is also named "arrow" (16/arrow.svg). Use variants.pattern (e.g. \'{Size}/{name}\') or namePrefix.');
		// Plain vectors may share a name.
		expect(nameAndGroup(inputs, { namePrefix: "", components: false }).failures.size).toBe(0);
	});
});

describe("naturalCompare", () => {
	it("orders numbers numerically, handles leading zeros, breaks ties by code units, ignores locale", () => {
		expect(["icon10", "icon2", "icon1"].sort(naturalCompare)).toEqual(["icon1", "icon2", "icon10"]);
		expect(naturalCompare("a007", "a7")).toBeLessThan(0); // equal numerically, tie broken by code units ('0' < '7')
		expect(naturalCompare("a07", "a8")).toBeLessThan(0);
		expect(naturalCompare("B", "a")).toBeLessThan(0); // code units, not locale
		expect(naturalCompare("é", "z")).toBeGreaterThan(0);
		expect(naturalCompare("x", "x")).toBe(0);
		expect(naturalCompare("24/outline/zap", "24/outline/bell")).toBeGreaterThan(0);
	});
});

describe("directory paging", () => {
	// Interleaved: one icon's files spread across the whole sorted listing.
	const icons = ["arrow", "bell", "zap", "cog", "home"];
	const files: DirFile[] = [];
	for (const size of ["16", "24"]) for (const style of ["outline", "solid"]) for (const n of icons) files.push({ path: `/root/${size}/${style}/${n}.svg`, relPath: `${size}/${style}/${n}.svg`, size: 100 });
	files.push({ path: "/root/readme-icon.svg", relPath: "readme-icon.svg", size: 50 });
	const pattern = compile("{Size}/{Style}/{name}");

	it("pages whole groups; nextOffset is a group start; the union is every file exactly once", () => {
		const seen: string[] = [];
		let offset = 0;
		const pages: DirFile[][] = [];
		for (let guard = 0; guard < 10; guard++) {
			const p = pageDirectory(files, { pattern, namePrefix: "", offset, limit: 8 });
			pages.push(p.files);
			seen.push(...p.files.map((f) => f.relPath));
			// every page holds whole groups (4 files per icon, 1 for the singleton)
			const names = p.files.map((f) => f.relPath.split("/").pop());
			for (const n of new Set(names)) if (n !== "readme-icon.svg") expect(names.filter((x) => x === n)).toHaveLength(4);
			if (p.nextOffset === undefined) break;
			expect(p.nextOffset).toBe(offset + p.files.length);
			offset = p.nextOffset;
		}
		expect(pages.length).toBe(3);
		expect(seen.slice().sort()).toEqual(files.map((f) => f.relPath).sort());
		expect(new Set(seen).size).toBe(files.length);
	});

	it("snaps a mid-group offset back with a note, and a group larger than limit is its own page", () => {
		const p = pageDirectory(files, { pattern, namePrefix: "", offset: 2, limit: 8 });
		expect(p.offset).toBe(0);
		expect(p.notes).toEqual(['offset 2 is inside the set "arrow"; started at 0 so the set isn\'t split.']);
		const small = pageDirectory(files, { pattern, namePrefix: "", offset: 0, limit: 3 });
		expect(small.files).toHaveLength(4);
		expect(small.nextOffset).toBe(4);
		expect(small.groupStarts).toEqual([0]);
		expect(pageDirectory(files, { pattern, namePrefix: "", offset: 999, limit: 8 }).error).toMatch(/past the end/);
	});

	it("orders files by naturalCompare without variants", () => {
		const flat = pageDirectory(
			[
				{ path: "/a/icon10.svg", relPath: "icon10.svg", size: 1 },
				{ path: "/a/icon2.svg", relPath: "icon2.svg", size: 1 },
			],
			{ namePrefix: "", offset: 0, limit: 10 },
		);
		expect(flat.files.map((f) => f.relPath)).toEqual(["icon2.svg", "icon10.svg"]);
		expect(flat.groupStarts).toEqual([0, 1]);
		expect(flat.nextOffset).toBeUndefined();
	});
});

describe("hashes and ids", () => {
	it("contentHash is stable and the art hash changes with any effective option but not with the color target", () => {
		expect(contentHash("abc")).toBe(contentHash("abc"));
		expect(contentHash("abc")).not.toBe(contentHash("abd"));
		expect(contentHash("abc")).toMatch(/^[0-9a-f]{14}$/);
		const base = { box: { w: 24, h: 24 }, square: true, scaleStrokes: true, flatten: false, asComponent: true, color: { apply: "auto", targets: ["fills", "strokes"] } };
		const h = artHashFor("<svg/>", base);
		expect(artHashFor("<svg/>", { ...base })).toBe(h);
		for (const change of [{ box: { w: 16, h: 16 } }, { square: false }, { scaleStrokes: false }, { flatten: true }, { asComponent: false }, { color: null }, { color: { apply: "all", targets: ["fills"] } }]) {
			expect(artHashFor("<svg/>", { ...base, ...change })).not.toBe(h);
		}
		expect(artHashFor("<svg />", base)).not.toBe(h);
		// The variable or value itself isn't part of ArtHashOptions at all: same hash for any target.
		expect(Object.keys(base.color)).toEqual(["apply", "targets"]);
	});

	it("newRunId is 12 hex characters", () => {
		expect(newRunId()).toMatch(/^[0-9a-f]{12}$/);
		expect(newRunId()).not.toBe(newRunId());
	});
});

describe("directory paging: review fixes", () => {
	it("a set over 100 files is its own page of 100; the rest is overflow and the next page starts after the set", () => {
		const files: DirFile[] = Array.from({ length: 300 }, (_, i) => ({ path: `/i/icon-${i}.svg`, relPath: `icon-${i}.svg`, size: 1 }));
		files.push({ path: "/i/zz.svg", relPath: "zz.svg", size: 1 });
		const pattern = compile("{name}-{Size}");
		const p = pageDirectory(files, { pattern, namePrefix: "", offset: 0, limit: 200 });
		expect(p.files).toHaveLength(100);
		expect(p.overflow).toHaveLength(200);
		expect(p.overflow[0]).toEqual({ file: expect.objectContaining({ relPath: "icon-100.svg" }), setName: "icon" });
		expect(p.nextOffset).toBe(300);
		expect(p.remainingCount).toBe(1);
		// The next page makes progress.
		expect(pageDirectory(files, { pattern, namePrefix: "", offset: 300, limit: 200 }).files.map((f) => f.relPath)).toEqual(["zz.svg"]);
		// After another group, an oversized set waits for its own page.
		const before = pageDirectory([{ path: "/i/aa.svg", relPath: "aa.svg", size: 1 }, ...files], { pattern, namePrefix: "", offset: 0, limit: 500 });
		expect(before.files.map((f) => f.relPath)).toEqual(["aa.svg"]);
		expect(before.nextOffset).toBe(1);
		// No room for the set next to inline svgs/paths: nothing is taken and paging stays put.
		const tight = pageDirectory(files, { pattern, namePrefix: "", offset: 0, limit: 40, maxFiles: 40 });
		expect(tight.files).toEqual([]);
		expect(tight.nextOffset).toBe(0);
		expect(tight.notes[0]).toMatch(/^The set "icon" \(100 files\) doesn't fit in this call/);
	});

	it("reports a standalone file whose component name an earlier page already takes", () => {
		// 16/ (150 icons + arrow) fills page 1; 24/arrow sorts after 24/aa000-aa099, onto page 2.
		const files: DirFile[] = [];
		const add = (rel: string) => files.push({ path: `/r/${rel}`, relPath: rel, size: 1 });
		for (let i = 0; i < 150; i++) add(`16/a${String(i).padStart(3, "0")}.svg`);
		add("16/arrow.svg");
		for (let i = 0; i < 100; i++) add(`24/aa${String(i).padStart(3, "0")}.svg`);
		add("24/arrow.svg");
		const page1 = pageDirectory(files, { namePrefix: "", offset: 0, limit: 200, components: true });
		expect(page1.files.map((f) => f.relPath)).toContain("16/arrow.svg");
		expect(page1.collisions).toEqual([]);
		const page2 = pageDirectory(files, { namePrefix: "", offset: page1.nextOffset!, limit: 200, components: true });
		expect(page2.files.map((f) => f.relPath)).toContain("24/arrow.svg");
		const idx = page2.files.findIndex((f) => f.relPath === "24/arrow.svg");
		expect(page2.collisions).toEqual([{ index: idx, name: "arrow", first: "16/arrow.svg" }]);
		// Plain vectors can share names.
		expect(pageDirectory(files, { namePrefix: "", offset: page1.nextOffset!, limit: 200 }).collisions).toEqual([]);
		expect(standaloneDirName("24/arrow.svg", "Icon/")).toBe("Icon/arrow");
	});
});
