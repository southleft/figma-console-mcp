/**
 * figma_generate_component_doc must read bridge data from the file being
 * DOCUMENTED, not whichever file is active in Figma.
 *
 * Found by live testing v1.40.3: documenting a CBDS component while a different
 * file was active printed "—" for every color token and raw `VariableID:118:874`
 * for spacing, because variable names were fetched from the active file. Node and
 * variable ids are only unique within a file, so on an id collision the same bug
 * returns the WRONG names, description or annotations instead of none.
 */

import { registerDesignCodeTools } from "../src/core/design-code-tools";

const DOC_FILE = "fileDOC";
const ACTIVE_FILE = "fileACTIVE";

const node = {
	id: "1:1", name: "Chip", type: "COMPONENT",
	fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, boundVariables: { color: { id: "VariableID:1:1" } } }],
	children: [],
};

function setup(activeFileKey: string) {
	const tools: Record<string, any> = {};
	const server = { tool: (name: string, _d: string, _s: any, handler: any) => { tools[name] = handler; } };
	const api = {
		getNodes: jest.fn().mockResolvedValue({ nodes: { "1:1": { document: node, components: {}, componentSets: {} } } }),
		getComponents: jest.fn().mockResolvedValue({ meta: { components: [] } }),
	};
	// A bridge with two files open: each answers for ITS OWN variables / nodes.
	const filesOnBridge: Record<string, any> = {
		[DOC_FILE]: { variables: [{ id: "VariableID:1:1", name: "color/danger", variableCollectionId: "c" }], description: "The real chip." },
		[ACTIVE_FILE]: { variables: [{ id: "VariableID:1:1", name: "WRONG/from-other-file", variableCollectionId: "c" }], description: "A DIFFERENT component that shares id 1:1." },
	};
	const connector = {
		getVariables: jest.fn(async (fileKey?: string) => ({ variables: filesOnBridge[fileKey ?? activeFileKey].variables, variableCollections: [] })),
		getComponentFromPluginUI: jest.fn(async (_id: string, fileKey?: string) => ({ success: true, component: { description: filesOnBridge[fileKey ?? activeFileKey].description, annotations: [] } })),
	};
	registerDesignCodeTools(server as any, async () => api as any, () => `https://www.figma.com/design/${activeFileKey}/Active`, undefined, {}, async () => connector);
	return { run: tools.figma_generate_component_doc, connector };
}

describe("figma_generate_component_doc — cross-file bridge reads", () => {
	it("resolves token names and description from the DOCUMENTED file while another file is active", async () => {
		const { run, connector } = setup(ACTIVE_FILE);
		const res = await run({ nodeId: "1:1", fileUrl: `https://www.figma.com/design/${DOC_FILE}/Doc`, enrich: false, includeFrontmatter: true });
		const md: string = JSON.parse(res.content[0].text).markdown;

		expect(connector.getVariables).toHaveBeenCalledWith(DOC_FILE);
		expect(connector.getComponentFromPluginUI).toHaveBeenCalledWith("1:1", DOC_FILE);
		expect(md).toContain("`color/danger`");
		expect(md).toContain("The real chip.");
		expect(md).not.toContain("WRONG/from-other-file");
		expect(md).not.toContain("DIFFERENT component");
	});

	it("falls back to hex — never to another file's names — when the documented file isn't on the bridge", async () => {
		const { run, connector } = setup(ACTIVE_FILE);
		connector.getVariables.mockImplementation(async (fileKey?: string) => {
			if (fileKey === DOC_FILE) throw new Error("No WebSocket client connected");
			return { variables: [{ id: "VariableID:1:1", name: "WRONG/from-other-file" }] };
		});
		const res = await run({ nodeId: "1:1", fileUrl: `https://www.figma.com/design/${DOC_FILE}/Doc`, enrich: false });
		const md: string = JSON.parse(res.content[0].text).markdown;
		expect(md).toContain("#FF0000");
		expect(md).not.toContain("WRONG/from-other-file");
	});

	it("still uses the active file when no fileUrl is given (unchanged behavior)", async () => {
		const { run, connector } = setup(DOC_FILE);
		await run({ nodeId: "1:1", enrich: false });
		expect(connector.getVariables).toHaveBeenCalledWith(DOC_FILE);
	});
});
