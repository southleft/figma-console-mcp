/**
 * A small fake of the Figma Plugin API, enough to run the figma_import_svg
 * scripts: node trees with Figma's transform rules (children of groups and
 * boolean operations are positioned relative to the nearest frame-like
 * ancestor), paints, plugin data, components and sets, variables, and a
 * createNodeFromSvg that turns sanitized markup into a frame.
 *
 * Modeled Figma behavior the scripts depend on:
 *   - every SVG shape (<path>, <rect>, <circle>, <line>) imports as a VECTOR
 *     (live gate P0.6, 2026-11-27);
 *   - resize()/resizeWithoutConstraints() on an auto-layout frame reset both
 *     sizing modes to FIXED;
 *   - rescale/resize of TEXT needs its font loaded (loadFontAsync);
 *   - FigJam has no figma.variables (set `variablesAvailable = false`);
 *   - createNodeFromSvg gives the wrapping frame a white fill (seen live in FigJam and Slides).
 */

export const MIXED = Symbol("mixed");
type M = number[][];

const identity = (): M => [
	[1, 0, 0],
	[0, 1, 0],
];
const mul = (a: M, b: M): M => [
	[a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
	[a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]],
];
const clone = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const NON_CONTAINER = new Set(["GROUP", "BOOLEAN_OPERATION"]);

let nextId = 1;

interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export class FNode {
	id: string;
	name = "";
	parent: FNode | null = null;
	children: FNode[] | undefined;
	removed = false;
	rt: M = identity();
	_w = 0;
	_h = 0;
	visible = true;
	fills: any[] = [];
	strokes: any[] = [];
	effects: any[] = [];
	strokeWeight: number | symbol = 1;
	strokeAlign = "CENTER";
	strokeCap: string | symbol = "NONE";
	strokeJoin = "MITER";
	strokeMiterLimit = 4;
	dashPattern: number[] = [];
	opacity = 1;
	blendMode = "PASS_THROUGH";
	isMask = false;
	constraints: { horizontal: string; vertical: string } | undefined;
	layoutMode: string | undefined;
	description = "";
	pluginData: Record<string, string> = {};
	componentPropertyReferences: Record<string, string> | null = null;
	vectorNetwork: any;
	cornerRadius: number | symbol = 0;
	topLeftRadius = 0;
	topRightRadius = 0;
	bottomRightRadius = 0;
	bottomLeftRadius = 0;
	cornerSmoothing = 0;
	arcData: any;
	booleanOperation: string | undefined;
	remote = false;
	_defs: Record<string, { type: string }> | undefined;
	_defsThrow = false;
	_instances: Array<{ name: string }> = [];
	_publish: string | Error = "UNPUBLISHED";
	_vpThrow = false;
	clipsContent = true;
	layoutWrap: string | undefined;
	primaryAxisSizingMode = "AUTO";
	counterAxisSizingMode = "AUTO";
	fontName: { family: string; style: string } | undefined;
	characters = "";
	setVectorNetworkAsync = jest.fn(async (net: any) => {
		this.vectorNetwork = clone(net);
		const xs = (net.vertices ?? []).map((v: any) => v.x);
		const ys = (net.vertices ?? []).map((v: any) => v.y);
		if (xs.length) {
			this._w = Math.max(...xs) - Math.min(...xs);
			this._h = Math.max(...ys) - Math.min(...ys);
		}
	});

	constructor(
		readonly type: string,
		readonly fake: FakeFigma,
	) {
		this.id = `${nextId++}:1`;
		if (["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "SECTION", "PAGE", "BOOLEAN_OPERATION", "SLIDE"].includes(type)) this.children = [];
		if (!["PAGE", "COMPONENT_SET", "SECTION", "GROUP", "BOOLEAN_OPERATION"].includes(type)) this.constraints = { horizontal: "MIN", vertical: "MIN" };
		if (["FRAME", "COMPONENT"].includes(type)) this.layoutMode = "NONE";
		fake.nodes.set(this.id, this);
	}

	get x() {
		if (NON_CONTAINER.has(this.type)) return this.bounds().x;
		return this.rt[0][2];
	}
	set x(v: number) {
		if (NON_CONTAINER.has(this.type)) {
			const dx = v - this.x;
			for (const c of this.children ?? []) c.x = c.x + dx;
			return;
		}
		this.rt = [[this.rt[0][0], this.rt[0][1], v], [this.rt[1][0], this.rt[1][1], this.rt[1][2]]];
	}
	get y() {
		if (NON_CONTAINER.has(this.type)) return this.bounds().y;
		return this.rt[1][2];
	}
	set y(v: number) {
		if (NON_CONTAINER.has(this.type)) {
			const dy = v - this.y;
			for (const c of this.children ?? []) c.y = c.y + dy;
			return;
		}
		this.rt = [[this.rt[0][0], this.rt[0][1], this.rt[0][2]], [this.rt[1][0], this.rt[1][1], v]];
	}
	get width() {
		return NON_CONTAINER.has(this.type) ? this.bounds().w : this._w;
	}
	get height() {
		return NON_CONTAINER.has(this.type) ? this.bounds().h : this._h;
	}
	/** Group bounds in the container's space, from the children's boxes. */
	private bounds(): Box {
		const boxes = (this.children ?? []).map((c) => c.containerBox());
		if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 };
		const x = Math.min(...boxes.map((b) => b.x));
		const y = Math.min(...boxes.map((b) => b.y));
		return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
	}
	/** Box in the nearest container's coordinates. */
	containerBox(): Box {
		if (NON_CONTAINER.has(this.type)) {
			const b = this.bounds();
			return { x: b.x, y: b.y, w: b.w, h: b.h };
		}
		const pts = [
			[0, 0],
			[this._w, 0],
			[0, this._h],
			[this._w, this._h],
		].map(([px, py]) => [this.rt[0][0] * px + this.rt[0][1] * py + this.rt[0][2], this.rt[1][0] * px + this.rt[1][1] * py + this.rt[1][2]]);
		const xs = pts.map((p) => p[0]);
		const ys = pts.map((p) => p[1]);
		return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
	}
	get relativeTransform() {
		return clone(this.rt);
	}
	set relativeTransform(m: M) {
		this.rt = clone(m);
	}
	/** Nearest ancestor that positions this node (groups and boolean operations don't). */
	container(): FNode | null {
		let p = this.parent;
		while (p && NON_CONTAINER.has(p.type)) p = p.parent;
		return p;
	}
	get absoluteTransform(): M {
		if (this.type === "PAGE") return identity();
		const c = this.container();
		if (NON_CONTAINER.has(this.type)) {
			const base = c ? c.absoluteTransform : identity();
			return mul(base, [
				[1, 0, this.x],
				[0, 1, this.y],
			]);
		}
		return c && c.type !== "PAGE" ? mul(c.absoluteTransform, this.rt) : clone(this.rt);
	}
	get absoluteBoundingBox() {
		const c = this.container();
		const base = c && c.type !== "PAGE" ? c.absoluteTransform : identity();
		const b = this.containerBox();
		return { x: base[0][2] + b.x, y: base[1][2] + b.y, width: b.w, height: b.h };
	}

	appendChild(child: FNode) {
		if (!this.children) throw new Error(`${this.type} can't have children`);
		child.detach();
		this.children.push(child);
		child.parent = this;
	}
	detach() {
		if (!this.parent?.children) return;
		const p = this.parent;
		p.children = p.children!.filter((c) => c !== this);
		this.parent = null;
		if (p.type === "GROUP" && p.children!.length === 0) p.remove();
	}
	remove() {
		this.detach();
		this.removed = true;
		this.fake.nodes.delete(this.id);
	}
	/** Figma: resize() resets both sizing modes of an auto-layout frame to FIXED. */
	private fixSizing() {
		if (this.layoutMode && this.layoutMode !== "NONE") {
			this.primaryAxisSizingMode = "FIXED";
			this.counterAxisSizingMode = "FIXED";
		}
	}
	/** Figma refuses layout-changing writes to text whose font isn't loaded. */
	assertFontsLoaded() {
		for (const n of [this, ...this.walk()]) {
			if (n.type === "TEXT" && n.fontName && !this.fake.loadedFonts.has(`${n.fontName.family}/${n.fontName.style}`)) {
				throw new Error(`Cannot write to node with unloaded font "${n.fontName.family} ${n.fontName.style}"`);
			}
		}
	}
	get hasMissingFont() {
		return !!this.fontName && this.fake.missingFonts.has(`${this.fontName.family}/${this.fontName.style}`);
	}
	getRangeAllFontNames() {
		return this.fontName ? [this.fontName] : [];
	}
	resizeWithoutConstraints(w: number, h: number) {
		this.fixSizing();
		this._w = w;
		this._h = h;
	}
	resize(w: number, h: number) {
		this.assertFontsLoaded();
		this.fixSizing();
		const sx = this._w ? w / this._w : 1;
		const sy = this._h ? h / this._h : 1;
		for (const c of this.children ?? []) {
			if (c.constraints?.horizontal === "SCALE") {
				c.x = c.x * sx;
				c.y = c.y * sy;
				c.resize(c._w * sx, c._h * sy);
			}
		}
		this._w = w;
		this._h = h;
	}
	rescale(s: number) {
		if (s < 0.01) throw new Error("scale too small");
		this.assertFontsLoaded();
		const scaleTree = (n: FNode, root: boolean) => {
			if (!root && !NON_CONTAINER.has(n.type)) {
				n.rt = [[n.rt[0][0], n.rt[0][1], n.rt[0][2] * s], [n.rt[1][0], n.rt[1][1], n.rt[1][2] * s]];
			}
			if (!NON_CONTAINER.has(n.type)) {
				n._w *= s;
				n._h *= s;
			}
			if (typeof n.strokeWeight === "number") n.strokeWeight *= s;
			for (const c of n.children ?? []) scaleTree(c, false);
		};
		scaleTree(this, true);
	}
	*walk(): Generator<FNode> {
		for (const c of this.children ?? []) {
			yield c;
			yield* c.walk();
		}
	}
	findOne(fn: (n: FNode) => boolean) {
		for (const n of this.walk()) if (fn(n)) return n;
		return null;
	}
	findAll(fn: (n: FNode) => boolean) {
		return [...this.walk()].filter(fn);
	}
	findAllWithCriteria(c: { types?: string[]; pluginData?: { keys?: string[] } }) {
		return [...this.walk()].filter(
			(n) => (!c.types || c.types.includes(n.type)) && (!c.pluginData || (c.pluginData.keys ?? []).some((k) => n.pluginData[k] !== undefined)),
		);
	}
	getPluginData(k: string) {
		return this.pluginData[k] ?? "";
	}
	setPluginData(k: string, v: string) {
		this.pluginData[k] = v;
	}
	async getInstancesAsync() {
		return this._instances;
	}
	async getPublishStatusAsync() {
		if (this._publish instanceof Error) throw this._publish;
		return this._publish;
	}
	get componentPropertyDefinitions() {
		if (this._defsThrow) throw new Error("Component set has existing errors");
		if (this._defs) return this._defs;
		if (this.type === "COMPONENT_SET") {
			const defs: Record<string, { type: string }> = {};
			for (const c of this.children ?? []) for (const k of Object.keys(parseVariant(c.name))) defs[k] = { type: "VARIANT" };
			return defs;
		}
		return {};
	}
	get variantProperties() {
		if (this._vpThrow) throw new Error("variant errors");
		return this.parent?.type === "COMPONENT_SET" ? parseVariant(this.name) : null;
	}
	async loadAsync() {}
}

function parseVariant(name: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of name.split(",")) {
		const [k, v] = part.split("=");
		if (k && v) out[k.trim()] = v.trim();
	}
	return out;
}

const NAMED: Record<string, string> = { red: "ff0000", magenta: "ff00ff", black: "000000", white: "ffffff" };
export function rgb(hex: string) {
	let h = hex.replace("#", "").toLowerCase();
	if (NAMED[h]) h = NAMED[h];
	if (h.length === 3) h = h.split("").map((c) => c + c).join("");
	return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
}
export const solid = (hex: string, extra: Record<string, unknown> = {}) => ({ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: rgb(hex), ...extra });

function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
	return out;
}

/** Sanitized markup → a frame, the way createNodeFromSvg builds one (roughly). */
export function defaultSvgParse(fake: FakeFigma, markup: string): FNode {
	const frame = new FNode("FRAME", fake);
	frame.fills = [solid("#ffffff")];
	const stack: Array<{ node: FNode; fill?: string; stroke?: string; sw?: string }> = [];
	for (const m of markup.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
		const [, close, tag, rest, self] = m;
		if (close) {
			if (tag === "svg" || tag === "g") stack.pop();
			continue;
		}
		const a = attrs(rest);
		const top = stack[stack.length - 1];
		const fill = a.fill ?? top?.fill ?? "black";
		const stroke = a.stroke ?? top?.stroke ?? "none";
		const sw = a["stroke-width"] ?? top?.sw ?? "1";
		if (tag === "svg") {
			const vb = (a.viewBox ?? "").split(/[\s,]+/).map(Number);
			frame._w = Number(a.width) || vb[2] || 100;
			frame._h = Number(a.height) || vb[3] || 100;
			stack.push({ node: frame, fill: a.fill, stroke: a.stroke, sw: a["stroke-width"] });
			continue;
		}
		const paints = (node: FNode) => {
			node.fills = fill === "none" ? [] : fill.startsWith("url(") ? [{ type: "GRADIENT_LINEAR", visible: true, gradientStops: [] }] : [solid(fill)];
			node.strokes = stroke === "none" ? [] : [solid(stroke)];
			node.strokeWeight = Number(sw);
		};
		let node: FNode | null = null;
		if (tag === "g") {
			const g = new FNode("GROUP", fake);
			(top?.node ?? frame).appendChild(g);
			if (!self) stack.push({ node: g, fill: a.fill ?? top?.fill, stroke: a.stroke ?? top?.stroke, sw: a["stroke-width"] ?? top?.sw });
			continue;
		}
		// Every shape becomes a VECTOR (live gate P0.6), positioned at its own box.
		const shape = (x: number, y: number, w: number, h: number, d: string) => {
			const v = new FNode("VECTOR", fake);
			v.x = x;
			v.y = y;
			v._w = w;
			v._h = h;
			v.vectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: w, y: h }], segments: [], regions: [], d };
			return v;
		};
		if (tag === "path") {
			node = shape(0, 0, frame._w, frame._h, a.d);
		} else if (tag === "rect") {
			node = shape(Number(a.x ?? 0), Number(a.y ?? 0), Number(a.width ?? 0), Number(a.height ?? 0), `rect:${a.width}x${a.height}`);
		} else if (tag === "circle") {
			const r = Number(a.r ?? 0);
			node = shape(Number(a.cx ?? 0) - r, Number(a.cy ?? 0) - r, 2 * r, 2 * r, `circle:${r}`);
		} else if (tag === "line") {
			const x1 = Number(a.x1 ?? 0);
			node = shape(x1, Number(a.y1 ?? 0), Math.abs(Number(a.x2 ?? 0) - x1), 0, "line");
		} else if (tag === "text") {
			node = new FNode("TEXT", fake);
			node._w = 10;
			node._h = 10;
			node.fontName = { family: "Inter", style: "Regular" };
			node.characters = "text";
		}
		if (!node) continue;
		paints(node);
		(top?.node ?? frame).appendChild(node);
	}
	return frame;
}

export interface FakeVariable {
	id: string;
	key: string;
	name: string;
	resolvedType: string;
	variableCollectionId: string;
}

export class FakeFigma {
	nodes = new Map<string, FNode>();
	calls: string[] = [];
	mixed = MIXED;
	editorType = "figma";
	fileKey = "FILE123";
	currentPage: FNode & { selection?: FNode[]; focusedSlide?: FNode | null };
	root: any;
	pages: FNode[];
	svgFactory: (markup: string) => FNode = (m) => defaultSvgParse(this, m);
	localVariables: FakeVariable[] = [];
	collections: Array<{ id: string; name: string }> = [];
	libraryCollections: Array<{ key: string; name: string; libraryName: string; vars: Array<{ key: string; name: string; resolvedType: string }> }> = [];
	versionResult: { id: string } | null = { id: "4471234567" };
	/** "family/style" of fonts loaded in this plugin session, and of fonts that can't be loaded. */
	loadedFonts = new Set<string>();
	missingFonts = new Set<string>();
	/** false: figma.variables is undefined, as in FigJam (live gate P0.2). */
	variablesAvailable = true;

	constructor() {
		const page = new FNode("PAGE", this) as FNode & { selection?: FNode[] };
		page.name = "Page 1";
		page.selection = [];
		this.currentPage = page;
		this.pages = [page];
		const self = this;
		this.root = {
			type: "DOCUMENT",
			name: "Acme DS",
			get children() {
				return self.pages;
			},
			findAllWithCriteria(c: any) {
				return self.pages.flatMap((p) => p.findAllWithCriteria(c));
			},
		};
	}

	log(name: string) {
		this.calls.push(name);
	}

	api(): any {
		const f = this;
		return {
			mixed: MIXED,
			get editorType() {
				return f.editorType;
			},
			get fileKey() {
				return f.fileKey;
			},
			get currentPage() {
				return f.currentPage;
			},
			get root() {
				return f.root;
			},
			commitUndo: () => f.log("commitUndo"),
			saveVersionHistoryAsync: jest.fn(async (title: string, description?: string) => {
				f.log(`saveVersionHistoryAsync:${title}:${description ?? ""}`);
				return f.versionResult;
			}),
			loadAllPagesAsync: async () => f.log("loadAllPagesAsync"),
			getNodeByIdAsync: async (id: string) => f.nodes.get(id) ?? null,
			createNodeFromSvg: (markup: string) => {
				f.log("createNodeFromSvg");
				const frame = f.svgFactory(markup);
				f.currentPage.appendChild(frame);
				return frame;
			},
			createComponentFromNode: (node: FNode) => {
				f.log("createComponentFromNode");
				const comp = new FNode("COMPONENT", f);
				comp.name = node.name;
				comp.rt = clone(node.rt);
				comp._w = node._w;
				comp._h = node._h;
				comp.fills = node.fills;
				const parent = node.parent;
				for (const c of (node.children ?? []).slice()) comp.appendChild(c);
				if (parent) {
					const idx = parent.children!.indexOf(node);
					parent.children!.splice(idx, 1, comp);
					comp.parent = parent;
					node.parent = null;
				}
				node.removed = true;
				f.nodes.delete(node.id);
				return comp;
			},
			combineAsVariants: (comps: FNode[], parent: FNode) => {
				f.log("combineAsVariants");
				const set = new FNode("COMPONENT_SET", f);
				parent.appendChild(set);
				for (const c of comps) set.appendChild(c);
				return set;
			},
			group: (nodes: FNode[], parent: FNode) => {
				f.log("group");
				const g = new FNode("GROUP", f);
				parent.appendChild(g);
				for (const n of nodes) g.appendChild(n);
				return g;
			},
			flatten: (nodes: FNode[], parent: FNode) => {
				f.log("flatten");
				const v = new FNode("VECTOR", f);
				v.fills = clone(nodes[0].fills);
				v.strokes = clone(nodes[0].strokes);
				v.strokeWeight = nodes[0].strokeWeight;
				const boxes = nodes.map((n) => n.containerBox());
				const x = Math.min(...boxes.map((b) => b.x));
				const y = Math.min(...boxes.map((b) => b.y));
				v._w = Math.max(...boxes.map((b) => b.x + b.w)) - x;
				v._h = Math.max(...boxes.map((b) => b.y + b.h)) - y;
				v.x = x;
				v.y = y;
				v.vectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: v._w, y: v._h }], segments: [], regions: [], d: nodes.map((n) => n.vectorNetwork?.d).join(" ") };
				for (const n of nodes) n.remove();
				parent.appendChild(v);
				return v;
			},
			createSection: () => {
				f.log("createSection");
				const s = new FNode("SECTION", f);
				s._w = 100;
				s._h = 100;
				f.currentPage.appendChild(s);
				return s;
			},
			createFrame: () => {
				f.log("createFrame");
				const fr = new FNode("FRAME", f);
				fr._w = 100;
				fr._h = 100;
				fr.fills = [solid("#ffffff")];
				f.currentPage.appendChild(fr);
				return fr;
			},
			loadFontAsync: async (font: { family: string; style: string }) => {
				const k = `${font.family}/${font.style}`;
				f.log(`loadFontAsync:${k}`);
				if (f.missingFonts.has(k)) throw new Error(`The font "${font.family} ${font.style}" could not be loaded`);
				f.loadedFonts.add(k);
			},
			util: {
				solidPaint: (css: string) => {
					if (!/^#?[0-9a-f]{3,8}$/i.test(css) && !NAMED[css.toLowerCase()]) throw new Error(`Invalid color "${css}"`);
					return { type: "SOLID", color: rgb(css), opacity: 1 };
				},
			},
			variables: !f.variablesAvailable ? undefined : {
				getLocalVariablesAsync: async (type?: string) => f.localVariables.filter((v) => !type || v.resolvedType === type),
				getLocalVariableCollectionsAsync: async () => f.collections,
				getVariableByIdAsync: async (id: string) => f.localVariables.find((v) => v.id === id) ?? null,
				getVariableCollectionByIdAsync: async (id: string) => f.collections.find((c) => c.id === id) ?? null,
				importVariableByKeyAsync: jest.fn(async (key: string) => {
					f.log(`importVariableByKeyAsync:${key}`);
					for (const c of f.libraryCollections) {
						const v = c.vars.find((x) => x.key === key);
						if (v) return { id: `VariableID:lib/${key}`, key, name: v.name, resolvedType: "COLOR", variableCollectionId: `lib:${c.key}` };
					}
					throw new Error("not found");
				}),
				setBoundVariableForPaint: (paint: any, field: string, v: FakeVariable) => ({ ...paint, boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: v.id } } }),
			},
			teamLibrary: {
				getAvailableLibraryVariableCollectionsAsync: async () => f.libraryCollections.map((c) => ({ key: c.key, name: c.name, libraryName: c.libraryName })),
				getVariablesInLibraryCollectionAsync: async (key: string) => f.libraryCollections.find((c) => c.key === key)?.vars ?? [],
			},
			viewport: { scrollAndZoomIntoView: jest.fn((nodes: FNode[]) => f.log(`scroll:${nodes.map((n) => n.id).join(",")}`)) },
		};
	}
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** Run a generated script the way code.js does (top-level await/return). */
export function runScript(script: string, figma: unknown): Promise<any> {
	return new AsyncFunction("figma", script)(figma);
}

/** A component with vector art and an svgImport record, as an earlier import leaves it. */
export function makeIconComponent(fake: FakeFigma, opts: { name: string; parent?: FNode; leaves?: number; record?: Record<string, unknown>; size?: [number, number] }) {
	const comp = new FNode("COMPONENT", fake);
	comp.name = opts.name;
	comp._w = opts.size?.[0] ?? 24;
	comp._h = opts.size?.[1] ?? 24;
	(opts.parent ?? fake.currentPage).appendChild(comp);
	for (let i = 0; i < (opts.leaves ?? 1); i++) {
		const v = new FNode("VECTOR", fake);
		v.name = "Vector";
		v._w = comp._w;
		v._h = comp._h;
		v.vectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: comp._w, y: comp._h }], segments: [], regions: [], d: "old" };
		v.fills = [solid("#000000")];
		comp.appendChild(v);
	}
	if (opts.record) comp.setPluginData("svgImport", JSON.stringify({ v: 1, ...opts.record }));
	return comp;
}
