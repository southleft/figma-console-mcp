/**
 * Tool-level behavior of the adherence tools (registered on a fake server,
 * dependencies mocked). Regression tests for review findings on PR #169.
 */
import { registerAdherenceTools } from "../src/core/adherence-tools";
import { decisionsFromContracts } from "../src/core/adherence/props-parity";

type Handler = (args: any, ctx?: any) => Promise<any>;
function fakeServer() {
	const tools: Record<string, Handler> = {};
	return {
		tools,
		server: { getClientCapabilities: () => undefined },
		registerTool: (name: string, _cfg: any, h: Handler) => {
			tools[name] = h;
		},
	};
}
const json = (r: any) => JSON.parse(r.content[0].text);

/** A connector whose plugin code execution returns canned results per script. */
function connector(opts: { catalogFor?: (fileKey?: string) => any[]; audit?: any }) {
	const calls: Array<{ code: string; fileKey?: string }> = [];
	return {
		calls,
		executeCodeViaUI: async (code: string, _t: number, fileKey?: string) => {
			calls.push({ code, fileKey });
			if (code.includes('findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })')) {
				return { success: true, result: opts.catalogFor?.(fileKey) ?? [] };
			}
			return { success: true, result: opts.audit };
		},
	};
}

const cleanAudit = {
	root: { id: "1:1", name: "Screen", type: "FRAME" },
	file: { name: "Product", key: "PROD" },
	stats: { nodesVisited: 3, truncated: false, instances: 2, localInstances: 0, libraryInstances: 2, styledProps: 1, boundProps: 1, hardcoded: { color: 0, spacing: 0, radius: 0, typography: 0, effect: 0 }, gaps: 0, imitations: 0, suspects: 0, newComponents: 0, handDrawnVectors: 0, instancesWithStyleOverrides: 0 },
	componentsUsed: [{ name: "Button", key: "OTHER-LIB-KEY", setKey: null, source: "library", count: 2, nodeIds: ["2:2"] }],
	gaps: [],
	findings: [],
};

describe("figma_audit_adherence", () => {
	it("fails when libraryFileKeys can't be loaded, instead of passing unchecked", async () => {
		const f = fakeServer();
		const conn = connector({ audit: cleanAudit });
		registerAdherenceTools(f as any, {
			getDesktopConnector: async () => conn,
			getLocalCatalog: async () => [],
			getFigmaAPI: async () => {
				throw new Error("403 Forbidden");
			},
		});
		const r = json(await f.tools.figma_audit_adherence({ nodeId: "1:1", libraryFileKeys: ["LIB"] }));
		expect(r.pass).toBe(false);
		expect(r.counts.byRule["off-system-check-unavailable"]).toBe(1);
	});

	it("reads the component catalog from the audited file when fileKey is given", async () => {
		const f = fakeServer();
		const getLocalCatalog = jest.fn(async () => [{ name: "ActiveFileOnly", key: "a", type: "COMPONENT" as const, source: "local" }]);
		const conn = connector({
			catalogFor: (fk) => (fk === "PROD" ? [{ name: "Product Card", key: "p", type: "COMPONENT", source: "local" }] : []),
			audit: cleanAudit,
		});
		registerAdherenceTools(f as any, { getDesktopConnector: async () => conn, getLocalCatalog });
		await f.tools.figma_audit_adherence({ nodeId: "1:1", fileKey: "PROD" });
		expect(getLocalCatalog).not.toHaveBeenCalled();
		const catalogCall = conn.calls.find((c) => c.code.includes("findAllWithCriteria"));
		expect(catalogCall?.fileKey).toBe("PROD");
		const auditCall = conn.calls.find((c) => c.code.includes("DS_NAMES"));
		expect(auditCall?.code).toContain('"product card"');
		expect(auditCall?.code).not.toContain('"activefileonly"');
	});
});

describe("figma_check_library_parity decisions", () => {
	const manifest = JSON.stringify({
		modules: [
			{
				declarations: [
					{ name: "ALButton", tagName: "al-button", attributes: [{ name: "fullWidth", type: { text: "boolean" } }, { name: "isLoading", type: { text: "boolean" } }], slots: [{ name: "" }] },
					{ name: "ALIconButton", tagName: "al-icon-button", attributes: [{ name: "isLoading", type: { text: "boolean" } }], slots: [] },
				],
			},
		],
	});
	it("doesn't let a hyphenated key overwrite another component's decisions", async () => {
		const f = fakeServer();
		const conn = connector({
			catalogFor: () => [
				{ name: "Button", key: "b", type: "COMPONENT", variantAxes: [], properties: [], source: "local" },
				{ name: "Icon Button", key: "ib", type: "COMPONENT", variantAxes: [], properties: [], source: "local" },
			],
		});
		registerAdherenceTools(f as any, { getDesktopConnector: async () => conn });
		const r = json(
			await f.tools.figma_check_library_parity({
				components: ["Button", "IconButton"],
				manifestJson: manifest,
				classPrefixes: ["AL"],
				decisions: { button: { omit: ["fullWidth", "isLoading"] }, "icon-button": { omit: ["isLoading"] } },
			}),
		);
		expect(r.inSyncComponents).toEqual(expect.arrayContaining(["Button", "Icon Button"]));
	});
});

describe("contract decisions", () => {
	it("honors omit recorded on the prop itself, without a bindings block", () => {
		const d = decisionsFromContracts([{ name: "al-button", props: [{ name: "fullWidth", omit: true }, { name: "isPill", figmaOmit: true }] }]);
		expect(d.get("button")?.omit).toEqual(["fullWidth", "isPill"]);
	});
});
