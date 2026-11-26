/**
 * Gaps are marked where they belong, never filled in: missing components and
 * missing parts of existing components become explained in-place notes, and
 * the audit rejects notes that don't explain themselves or that stand in for
 * a component the system actually has. Invented names throughout.
 */
import { registerAdherenceTools } from "../src/core/adherence-tools";
import { checkParts } from "../src/core/adherence/parts";

type Handler = (args: any, ctx?: any) => Promise<any>;
function setup(opts: { catalog: any[]; anatomy?: any; audit?: any }) {
	const tools: Record<string, Handler> = {};
	const server = { getClientCapabilities: () => undefined, registerTool: (n: string, _c: any, h: Handler) => (tools[n] = h) };
	const conn = {
		executeCodeViaUI: async (code: string) => {
			if (code.includes("findAllWithCriteria")) return { success: true, result: opts.catalog };
			if (code.includes("textLayers")) return { success: true, result: opts.anatomy ?? {} };
			return { success: true, result: opts.audit };
		},
	};
	registerAdherenceTools(server as any, { getDesktopConnector: async () => conn, getLocalCatalog: async () => opts.catalog });
	return tools;
}
const json = (r: any) => JSON.parse(r.content[0].text);
const comp = (name: string, extra: any = {}) => ({ name, key: `k-${name}`, nodeId: `n-${name}`, type: "COMPONENT_SET", source: "local", ...extra });

describe("in-place gap notes", () => {
	it("marks a missing component with an explained placeholder by default, and doesn't stop the build", async () => {
		const t = setup({ catalog: [comp("Gizmo"), comp("Widget")] });
		const r = json(await t.figma_resolve_components({ needs: ["gizmo", "pagination"], askUser: false }));
		const gap = r.items.find((i: any) => i.need === "pagination");
		expect(gap).toMatchObject({ status: "gap", action: "placeholder", placeholderName: "GAP: pagination", decidedBy: "default" });
		expect(gap.placeholderNote).toMatch(/no component/);
		expect(r.ai_instruction).toBeUndefined();
		expect(r.gapNotes.map((g: any) => g.name)).toEqual(["GAP: pagination"]);
	});

	it("still stops for unclear matches unless the person said to note them", async () => {
		const catalog = [comp("Marketing/Gizmo"), comp("Product/Gizmo")];
		const ask = json(await setup({ catalog }).figma_resolve_components({ needs: ["gizmo"], askUser: false }));
		expect(ask.items[0].action).toBe("ask-user");
		expect(ask.ai_instruction).toMatch(/settle the unclear matches/);
		const note = json(await setup({ catalog }).figma_resolve_components({ needs: ["gizmo"], askUser: false, onUnclear: "placeholder" }));
		expect(note.items[0]).toMatchObject({ action: "placeholder", decidedBy: "onUnclear" });
		expect(note.items[0].placeholderNote).toMatch(/Marketing\/Gizmo/);
	});

	it("reports a missing part of a matched component as a part gap", async () => {
		const t = setup({
			catalog: [comp("Card", { properties: [{ name: "Title", type: "TEXT" }] })],
			anatomy: { "n-Card": { layers: [{ name: "Header" }, { name: "Body copy" }], textLayers: 2 } },
		});
		const r = json(await t.figma_resolve_components({ needs: ["card"], askUser: false, parts: [{ need: "card", parts: ["image", "title", "excerpt"] }] }));
		const card = r.items[0];
		expect(card.parts.map((p: any) => `${p.part}:${p.status}`)).toEqual(["image:missing", "title:present", "excerpt:present"]);
		expect(card.missingParts).toEqual([expect.objectContaining({ part: "image", placeholderName: "GAP: card — image" })]);
	});
});

describe("checkParts", () => {
	const anatomy = (layers: string[], extra: any = {}) => ({ layers: layers.map((name) => ({ name })), textLayers: 1, ...extra });
	it("finds parts through properties, variant values, layers, nested instances and image fills", () => {
		const entry = { properties: [{ name: "Show Avatar", type: "BOOLEAN" }], variantAxes: [{ name: "Layout", values: ["Stacked", "With Thumbnail"] }] };
		const r = checkParts(["avatar", "image", "action button", "pagination"], entry, anatomy(["Header", "Button"]));
		expect(r.map((x) => `${x.part}:${x.status}`)).toEqual(["avatar:present", "image:present", "action button:present", "pagination:missing"]);
		expect(checkParts(["photo"], {}, anatomy(["Frame 1"], { imageIn: "Type=Media" }))[0]).toMatchObject({ status: "present", foundIn: "image fill in variant Type=Media" });
	});
	it("says unverified, not missing, when it can't see inside the component", () => {
		expect(checkParts(["image"], {}, undefined)[0].status).toBe("unverified");
		expect(checkParts(["image"], { properties: [{ name: "Content", type: "SLOT" }] }, undefined)[0].status).toBe("unverified");
	});
});

describe("audit of gap notes", () => {
	const audit = (gapDetails: any[]) => ({
		root: { id: "1:1", name: "Screen", type: "FRAME" },
		file: { name: "F", key: "F" },
		stats: { nodesVisited: 3, truncated: false, instances: 1, localInstances: 1, libraryInstances: 0, styledProps: 0, boundProps: 0, hardcoded: { color: 0, spacing: 0, radius: 0, typography: 0, effect: 0 }, gaps: gapDetails.length, imitations: 0, suspects: 0, newComponents: 0, handDrawnVectors: 0, instancesWithStyleOverrides: 0 },
		componentsUsed: [],
		gaps: gapDetails.map((g) => g.need),
		gapDetails,
		findings: [],
	});
	it("passes an explained gap for something the system lacks", async () => {
		const t = setup({ catalog: [comp("Gizmo")], audit: audit([{ nodeId: "9:1", need: "pagination", note: "Pagination for the orders table goes here; the system has no pagination component." }]) });
		const r = json(await t.figma_audit_adherence({ nodeId: "1:1" }));
		expect(r.pass).toBe(true);
		expect(r.gapNotes).toHaveLength(1);
	});
	it("warns on a gap note that doesn't explain anything", async () => {
		const t = setup({ catalog: [comp("Gizmo")], audit: audit([{ nodeId: "9:1", need: "pagination", note: "pagination" }]) });
		const r = json(await t.figma_audit_adherence({ nodeId: "1:1" }));
		expect(r.counts.byRule["gap-unexplained"]).toBe(1);
	});
	it("fails a gap note standing in for a component the system has", async () => {
		const t = setup({ catalog: [comp("Gizmo"), comp("Pagination")], audit: audit([{ nodeId: "9:1", need: "pagination", note: "Pagination for the orders table would go here, none in the system." }]) });
		const r = json(await t.figma_audit_adherence({ nodeId: "1:1" }));
		expect(r.pass).toBe(false);
		expect(r.findings.find((f: any) => f.rule === "gap-but-component-exists")).toMatchObject({ severity: "error", component: "Pagination" });
	});
});
