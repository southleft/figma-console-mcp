/**
 * Integration tests for the `history` wiring inside figma_generate_component_doc.
 *
 * Captures the real tool handler from a mock McpServer and runs it end to end
 * against a stub Figma API, asserting on the emitted markdown. This is what
 * guards the wiring between the doc generator and the history builders — the
 * builders themselves are unit-tested separately.
 */

import { registerDesignCodeTools } from "../../src/core/design-code-tools";
import { _clearComponentHistoryCacheForTesting } from "../../src/core/history/component-history";

const FILE_URL = "https://www.figma.com/design/abc123XYZ/Test-File";
const NODE_ID = "10:20";

interface Captured {
	name: string;
	handler: (args: any) => Promise<any>;
}

function buttonSet(children: string[]) {
	return {
		id: NODE_ID,
		name: "Button",
		type: "COMPONENT_SET",
		description: "A button.",
		children: children.map((n, i) => ({
			id: `${NODE_ID}:${i}`,
			name: n,
			type: "COMPONENT",
			children: [],
		})),
		componentPropertyDefinitions: {},
	};
}

/**
 * Stub API. Version-scoped getNodes calls (those passing `version`) resolve from
 * `snapshots`; unscoped calls return the HEAD document.
 */
function stubApi(opts: { versions?: any[]; snapshots?: Record<string, any> } = {}) {
	return {
		getNodes: jest.fn(async (_fileKey: string, ids: string[], o: any = {}) => {
			const doc = o.version ? opts.snapshots?.[o.version] : buttonSet(["Label", "Icon"]);
			return doc ? { nodes: { [ids[0]]: { document: doc } } } : { nodes: {} };
		}),
		getComponents: jest.fn(async () => ({ meta: { components: [] } })),
		getComponentSets: jest.fn(async () => ({ meta: { component_sets: [] } })),
		getFileVersions: jest.fn(async () => ({
			versions: opts.versions ?? [],
			pagination: {},
		})),
	} as any;
}

function getDocHandler(api: any) {
	const captured: Captured[] = [];
	const mockServer = {
		tool: (name: string, _d: string, _s: any, handler: any) => {
			captured.push({ name, handler });
		},
	} as any;

	registerDesignCodeTools(
		mockServer,
		async () => api,
		() => FILE_URL,
		undefined,
		{ isRemoteMode: false },
	);

	const tool = captured.find((t) => t.name === "figma_generate_component_doc");
	if (!tool) throw new Error("figma_generate_component_doc was not registered");
	return tool.handler;
}

async function runDoc(api: any, args: Record<string, unknown>) {
	const handler = getDocHandler(api);
	const response = await handler({
		nodeId: NODE_ID,
		enrich: false,
		...args,
	});
	const payload = JSON.parse(response.content[0].text);
	if (payload.error) throw new Error(`Doc generation failed: ${payload.error}`);
	return payload;
}

const VERSIONS = [
	{
		id: "v3",
		label: "v1.2 icon slot",
		description: "",
		created_at: "2026-03-01T12:00:00Z",
		user: { id: "u3", handle: "carol", img_url: "" },
	},
	{
		id: "v2",
		label: "v1.1 sizes",
		description: "",
		created_at: "2026-02-01T12:00:00Z",
		user: { id: "u2", handle: "bob", img_url: "" },
	},
];

const SNAPSHOTS = {
	v2: buttonSet(["Label"]),
	v3: buttonSet(["Label", "Icon"]),
};

beforeEach(() => {
	_clearComponentHistoryCacheForTesting();
});

// ---------------------------------------------------------------------------

describe("figma_generate_component_doc — history off (backward compatibility)", () => {
	it("emits the original '## Changelog' section from codeInfo and never touches version history", async () => {
		const api = stubApi();
		const result = await runDoc(api, {
			codeInfo: {
				changelog: [{ version: "2.0.0", date: "2026-01-15", changes: "Rewrote internals" }],
			},
		});

		expect(result.markdown).toContain("## Changelog");
		expect(result.markdown).toContain("| 2.0.0 | 2026-01-15 | Rewrote internals |");
		expect(result.markdown).not.toContain("## History");
		expect(result.includedSections).toContain("changelog");
		expect(api.getFileVersions).not.toHaveBeenCalled();
	});

	it("omits the changelog entirely when no codeInfo.changelog is given", async () => {
		const result = await runDoc(stubApi(), {});
		expect(result.markdown).not.toContain("## Changelog");
		expect(result.markdown).not.toContain("## History");
		expect(result.includedSections).not.toContain("changelog");
	});

	it("does not attach historySummary when history was not requested", async () => {
		const result = await runDoc(stubApi(), {});
		expect(result.historySummary).toBeUndefined();
	});
});

describe("figma_generate_component_doc — Figma design history", () => {
	it("renders a design history table scoped to the component", async () => {
		const api = stubApi({ versions: VERSIONS, snapshots: SNAPSHOTS });
		const result = await runDoc(api, { history: { figma: true, versions: 5 } });

		expect(result.markdown).toContain("## History");
		expect(result.markdown).toContain("### Design history");
		expect(result.markdown).toContain("v1.2 icon slot");
		expect(result.markdown).toContain("carol");
		expect(result.markdown).toContain("Added 1 layer");
		expect(result.includedSections).toContain("history");
		expect(result.includedSections).not.toContain("changelog");
	});

	it("adds figmaVersion provenance to frontmatter without touching the code semver", async () => {
		const api = stubApi({ versions: VERSIONS, snapshots: SNAPSHOTS });
		const result = await runDoc(api, {
			history: { figma: true },
			codeInfo: {
				changelog: [{ version: "2.0.0", date: "2026-01-15", changes: "Rewrote internals" }],
			},
		});

		expect(result.markdown).toContain('figmaVersion: "v1.2 icon slot"');
		expect(result.markdown).toContain("figmaVersionDate: 2026-03-01");
		// The code-side semver is unchanged
		expect(result.markdown).toContain("version: 2.0.0");
	});

	it("folds a caller-supplied changelog in as release notes alongside design history", async () => {
		const api = stubApi({ versions: VERSIONS, snapshots: SNAPSHOTS });
		const result = await runDoc(api, {
			history: { figma: true },
			codeInfo: {
				changelog: [{ version: "2.0.0", date: "2026-01-15", changes: "Rewrote internals" }],
			},
		});

		expect(result.markdown).toContain("### Design history");
		expect(result.markdown).toContain("### Release notes");
		expect(result.markdown).toContain("| 2.0.0 | 2026-01-15 | Rewrote internals |");
	});

	it("reports history stats in historySummary", async () => {
		const api = stubApi({ versions: VERSIONS, snapshots: SNAPSHOTS });
		const result = await runDoc(api, { history: { figma: true } });

		expect(result.historySummary.design).toMatchObject({ requested: true, entries: 1 });
		expect(result.historySummary.design.apiCalls).toBeGreaterThan(0);
		expect(result.historySummary.git).toBeNull();
	});

	it("still produces a doc when version history is unavailable", async () => {
		const api = stubApi({ versions: VERSIONS, snapshots: SNAPSHOTS });
		api.getFileVersions.mockRejectedValue(new Error("Figma API error: 403 Forbidden"));

		const result = await runDoc(api, { history: { figma: true } });

		// Doc generation succeeds; the failure is surfaced as a note, not an error.
		expect(result.markdown).toContain("## History");
		expect(result.markdown).toContain("file_versions:read");
		expect(result.historySummary.design.entries).toBe(0);
		expect(result.ai_instruction).toContain("Design history returned no rows");
	});
});

describe("figma_generate_component_doc — git history", () => {
	it("renders commits for the component's source file", async () => {
		const result = await runDoc(stubApi(), {
			history: { git: true, gitLimit: 3 },
			codeInfo: { filePath: "package.json" },
		});

		expect(result.markdown).toContain("### Code history");
		expect(result.markdown).toContain("| Commit | Date | Author | Message |");
		expect(result.historySummary.git.entries).toBeGreaterThan(0);
		expect(result.historySummary.git.paths).toEqual(["package.json"]);
	});

	it("derives paths from codeInfo.sourceFiles when filePath is absent", async () => {
		const result = await runDoc(stubApi(), {
			history: { git: true, gitLimit: 2 },
			codeInfo: {
				sourceFiles: [
					{ path: "package.json", role: "manifest" },
					{ path: "tsconfig.json", role: "config" },
				],
			},
		});

		expect(result.historySummary.git.paths).toEqual(["package.json", "tsconfig.json"]);
		expect(result.historySummary.git.entries).toBeGreaterThan(0);
	});

	it("prefers explicit history.gitPaths over codeInfo-derived paths", async () => {
		const result = await runDoc(stubApi(), {
			history: { git: true, gitPaths: ["tsconfig.json"] },
			codeInfo: { filePath: "package.json" },
		});
		expect(result.historySummary.git.paths).toEqual(["tsconfig.json"]);
	});

	it("notes the unavailability instead of failing when no paths can be derived", async () => {
		const result = await runDoc(stubApi(), { history: { git: true } });

		expect(result.historySummary.git.entries).toBe(0);
		expect(result.markdown).toContain("No source file paths available");
		expect(result.ai_instruction).toContain("Git history returned no rows");
	});
});

describe("figma_generate_component_doc — remote mode", () => {
	it("reports git history as unavailable rather than attempting to shell out", async () => {
		const captured: Captured[] = [];
		const mockServer = {
			tool: (name: string, _d: string, _s: any, handler: any) => {
				captured.push({ name, handler });
			},
		} as any;
		registerDesignCodeTools(
			mockServer,
			async () => stubApi(),
			() => FILE_URL,
			undefined,
			{ isRemoteMode: true },
		);
		const handler = captured.find((t) => t.name === "figma_generate_component_doc")!.handler;

		const response = await handler({
			nodeId: NODE_ID,
			enrich: false,
			history: { git: true },
			codeInfo: { filePath: "package.json" },
		});
		const result = JSON.parse(response.content[0].text);

		expect(result.markdown).toContain("unavailable in remote/cloud mode");
		expect(result.historySummary.git.entries).toBe(0);
	});
});

describe("figma_generate_component_doc — history suggestion", () => {
	it("tells the caller how to enable history when it was not requested", async () => {
		const result = await runDoc(stubApi(), {});
		expect(result.ai_instruction).toContain("history: { figma: true }");
	});

	it("stops suggesting history once it is enabled", async () => {
		const api = stubApi({ versions: VERSIONS, snapshots: SNAPSHOTS });
		const result = await runDoc(api, { history: { figma: true } });
		expect(result.ai_instruction).not.toContain("To include an ongoing changelog");
	});
});
