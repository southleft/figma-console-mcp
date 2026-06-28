/**
 * Slot extraction tests.
 *
 * Mirrors the extractSlots() helper in figma-desktop-bridge/code.js (the plugin
 * sandbox is plain JS that can't be imported here, so the logic is ported faithfully
 * and exercised against mock nodes — same approach as tests/lint-design.test.ts).
 *
 * Ground truth for the shapes came from a live probe against the Plugin API
 * (Figma slots, GA June 2026): a SLOT property def is { type:'SLOT', description,
 * preferredValues[] }; the SLOT node carries limitViolations and links to its
 * property via componentPropertyReferences.slotContentId.
 */

// --- Faithful port of code.js extractSlots() ---
function extractSlots(node: any): any[] {
	function canReadDefs(n: any) {
		if (n.type === "COMPONENT_SET") return true;
		if (n.type === "COMPONENT") return !(n.parent && n.parent.type === "COMPONENT_SET");
		return false;
	}
	if (!canReadDefs(node)) return [];
	let defs: any;
	try {
		defs = node.componentPropertyDefinitions;
	} catch (e) {
		return [];
	}
	if (!defs) return [];
	const byProp: Record<string, any> = {};
	for (const k in defs) {
		if (defs[k] && defs[k].type === "SLOT") {
			byProp[k] = {
				propertyName: k,
				description: defs[k].description || null,
				preferredValues: (defs[k].preferredValues || []).slice(),
				slotNodeIds: [],
				slotNames: [],
				limitViolations: [],
			};
		}
	}
	if (Object.keys(byProp).length === 0) return [];
	let slotNodes: any[] = [];
	try {
		slotNodes = node.findAllWithCriteria({ types: ["SLOT"] });
	} catch (e) {
		try {
			slotNodes = node.findAll((n: any) => n.type === "SLOT");
		} catch (e2) {
			slotNodes = [];
		}
	}
	for (const sn of slotNodes) {
		const refs = sn.componentPropertyReferences || {};
		const pk = refs.slotContentId;
		let entry = pk && byProp[pk] ? byProp[pk] : null;
		if (!entry) {
			entry = byProp[pk || sn.id] = {
				propertyName: pk || null,
				description: null,
				preferredValues: [],
				slotNodeIds: [],
				slotNames: [],
				limitViolations: [],
			};
		}
		entry.slotNodeIds.push(sn.id);
		if (entry.slotNames.indexOf(sn.name) === -1) entry.slotNames.push(sn.name);
		const lv = sn.limitViolations || [];
		for (const v of lv) {
			if (entry.limitViolations.indexOf(v) === -1) entry.limitViolations.push(v);
		}
	}
	return Object.keys(byProp).map((key) => {
		const e = byProp[key];
		return {
			name: e.slotNames[0] || e.propertyName,
			propertyName: e.propertyName,
			description: e.description,
			preferredValues: e.preferredValues,
			instanceCount: e.slotNodeIds.length,
			limitViolations: e.limitViolations,
		};
	});
}

// --- Mock builders ---
function slotNode(id: string, propKey: string, opts: { name?: string; limitViolations?: string[] } = {}) {
	return {
		type: "SLOT",
		id,
		name: opts.name || "Slot",
		componentPropertyReferences: { slotContentId: propKey },
		limitViolations: opts.limitViolations || [],
	};
}

describe("extractSlots", () => {
	it("extracts a single slot's contract from a non-variant component", () => {
		const sn = slotNode("10:1", "Slot#5943:0");
		const node = {
			type: "COMPONENT",
			parent: { type: "PAGE" },
			componentPropertyDefinitions: {
				"Slot#5943:0": { type: "SLOT", description: null, preferredValues: [] },
			},
			findAllWithCriteria: () => [sn],
		};
		const slots = extractSlots(node);
		expect(slots).toHaveLength(1);
		expect(slots[0]).toMatchObject({
			name: "Slot",
			propertyName: "Slot#5943:0",
			instanceCount: 1,
			limitViolations: [],
		});
	});

	it("surfaces preferredValues and description", () => {
		const node = {
			type: "COMPONENT",
			parent: { type: "PAGE" },
			componentPropertyDefinitions: {
				"Body#1:0": {
					type: "SLOT",
					description: "Card body content",
					preferredValues: [{ type: "COMPONENT", key: "abc" }],
				},
			},
			findAllWithCriteria: () => [slotNode("9:9", "Body#1:0", { name: "Body" })],
		};
		const [slot] = extractSlots(node);
		expect(slot.description).toBe("Card body content");
		expect(slot.preferredValues).toHaveLength(1);
		expect(slot.name).toBe("Body");
	});

	it("returns [] for a component with no slot properties", () => {
		const node = {
			type: "COMPONENT",
			parent: { type: "PAGE" },
			componentPropertyDefinitions: {
				"Label#2:0": { type: "TEXT", defaultValue: "Click" },
				"Disabled#2:1": { type: "BOOLEAN", defaultValue: false },
			},
			findAllWithCriteria: () => [],
		};
		expect(extractSlots(node)).toEqual([]);
	});

	it("returns [] for a variant component (defs unreadable on variants — the old skip case)", () => {
		const node = {
			type: "COMPONENT",
			parent: { type: "COMPONENT_SET" },
			// In real Figma this getter throws; the canReadDefs guard means we never touch it.
			get componentPropertyDefinitions(): any {
				throw new Error("Can only get component property definitions of a component set or non-variant component");
			},
			findAllWithCriteria: () => [],
		};
		expect(extractSlots(node)).toEqual([]);
	});

	it("groups a COMPONENT_SET's per-variant slot nodes by property and aggregates", () => {
		// A set with the same SLOT property realized in 3 variants; one variant's content
		// breaks the min limit. Should collapse to ONE slot entry, instanceCount 3.
		const node = {
			type: "COMPONENT_SET",
			parent: { type: "PAGE" },
			componentPropertyDefinitions: {
				"Content#7:0": { type: "SLOT", description: null, preferredValues: [] },
			},
			findAllWithCriteria: () => [
				slotNode("a:1", "Content#7:0"),
				slotNode("a:2", "Content#7:0", { limitViolations: ["BELOW_MIN"] }),
				slotNode("a:3", "Content#7:0", { limitViolations: ["BELOW_MIN"] }),
			],
		};
		const slots = extractSlots(node);
		expect(slots).toHaveLength(1);
		expect(slots[0].instanceCount).toBe(3);
		expect(slots[0].limitViolations).toEqual(["BELOW_MIN"]); // de-duplicated union
	});

	it("falls back to findAll when findAllWithCriteria is unavailable", () => {
		const sn = slotNode("z:1", "Slot#1:0");
		const node = {
			type: "COMPONENT",
			parent: { type: "PAGE" },
			componentPropertyDefinitions: {
				"Slot#1:0": { type: "SLOT", description: null, preferredValues: [] },
			},
			findAllWithCriteria: () => {
				throw new Error("criteria search unsupported");
			},
			findAll: (pred: (n: any) => boolean) => [sn].filter(pred),
		};
		const slots = extractSlots(node);
		expect(slots).toHaveLength(1);
		expect(slots[0].instanceCount).toBe(1);
	});

	it("ignores non-component nodes", () => {
		expect(extractSlots({ type: "FRAME" })).toEqual([]);
		expect(extractSlots({ type: "INSTANCE" })).toEqual([]);
	});
});
