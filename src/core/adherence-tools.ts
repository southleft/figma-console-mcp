/**
 * Design-system adherence: generate with the system, never invent.
 *
 *   figma_resolve_components — BEFORE building: map each needed UI element to a
 *     real component, or flag it as a gap. Possible matches and gaps go to the
 *     PERSON (elicitation) when the client supports it — the agent doesn't get
 *     to improvise a substitute.
 *   figma_audit_adherence — AFTER building: deterministic, scored report of a
 *     composition: component instances vs. hand-built imitations, token-bound
 *     vs. hardcoded styling, declared gaps. Built to be the evidence a separate
 *     grader agent judges from.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { createChildLogger } from "./logger.js";
import { confirmStep, fingerprint } from "./confirm.js";
import {
	type CatalogEntry,
	MATCH_THRESHOLD,
	POSSIBLE_THRESHOLD,
	type NeedResolution,
	pairLibraries,
	pickDefaultVariant,
	resolveNeeds,
} from "./adherence/matching.js";
import { GAP_PREFIX, buildAuditCode } from "./adherence/audit-code.js";
import { extractFileKey } from "./figma-api.js";
import { auditCode, type CodeSource, componentNamesFromFiles, scoreCodeAudit, tokenNamesFrom } from "./adherence/code-audit.js";
import { type ComponentDecisions, compareComponentProps, decisionsFromContracts, indexCem } from "./adherence/props-parity.js";

const logger = createChildLogger({ component: "adherence-tools" });

export interface AdherenceToolDeps {
	/** Local mode: read files from disk (absent in Cloud Mode — pass `sources`). */
	readFile?: (path: string) => Promise<string>;
	/** Local mode: list a directory's file names. */
	listDir?: (path: string) => Promise<string[]>;
	getDesktopConnector: () => Promise<any>;
	/** Components defined in the active file (local design system), if any. */
	getLocalCatalog?: () => Promise<CatalogEntry[]>;
	/** REST access for published libraries (needs a token). */
	getFigmaAPI?: () => Promise<any>;
}

const text = (data: unknown, isError = false) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data) }],
	...(isError ? { isError: true } : {}),
});

/** Components + component sets of a published library, as catalog entries. */
export async function loadLibraryCatalog(api: any, fileKey: string): Promise<{ entries: CatalogEntry[]; variantKeys: Set<string> }> {
	const [comps, sets] = await Promise.all([api.getComponents(fileKey), api.getComponentSets(fileKey)]);
	const rawComponents: any[] = comps?.meta?.components ?? [];
	const rawSets: any[] = sets?.meta?.component_sets ?? [];
	const variantKeys = new Set<string>();
	const bySet = new Map<string, any[]>();
	for (const c of rawComponents) {
		if (c.key) variantKeys.add(c.key);
		const setId = c.containing_frame?.containingComponentSet?.nodeId ?? c.component_set_id;
		if (setId) bySet.set(setId, [...(bySet.get(setId) ?? []), c]);
	}
	const entries: CatalogEntry[] = [];
	for (const s of rawSets) {
		const axes = new Map<string, Set<string>>();
		for (const v of bySet.get(s.node_id) ?? []) {
			for (const part of String(v.name).split(",")) {
				const [k, val] = part.split("=").map((x: string) => x?.trim());
				if (k && val) axes.set(k, (axes.get(k) ?? new Set()).add(val));
			}
		}
		variantKeys.add(s.key);
		const dv = pickDefaultVariant<any>(bySet.get(s.node_id) ?? []);
		entries.push({
			...(dv ? { defaultVariant: { name: dv.name, key: dv.key, nodeId: dv.node_id } } : {}),
			name: s.name,
			key: s.key,
			nodeId: s.node_id,
			type: "COMPONENT_SET",
			description: s.description || undefined,
			variantAxes: [...axes].map(([name, values]) => ({ name, values: [...values] })),
			source: fileKey,
		});
	}
	for (const c of rawComponents) {
		const inSet = c.containing_frame?.containingComponentSet || c.component_set_id;
		if (inSet) continue;
		entries.push({ name: c.name, key: c.key, nodeId: c.node_id, type: "COMPONENT", description: c.description || undefined, source: fileKey });
	}
	return { entries, variantKeys };
}

function libraryKeysFrom(args: { libraryFileKeys?: string[]; libraryFileUrls?: string[] }): string[] {
	const keys = [...(args.libraryFileKeys ?? [])];
	for (const u of args.libraryFileUrls ?? []) {
		const k = extractFileKey(u);
		if (k) keys.push(k);
	}
	return [...new Set(keys)];
}

/**
 * Components defined in the connected file, read through the plugin. Used when
 * no cached design-system manifest is available (Cloud Mode).
 */
export async function pluginCatalog(connector: any, fileKey?: string): Promise<CatalogEntry[]> {
	const code = `await figma.loadAllPagesAsync();
const out = [];
for (const n of figma.root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })) {
  if (out.length >= 5000) break;
  if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") continue;
  let axes = [], props = [];
  try {
    const defs = n.componentPropertyDefinitions || {};
    axes = Object.entries(defs).filter(([, d]) => d.type === "VARIANT").map(([k, d]) => ({ name: k.split("#")[0], values: d.variantOptions || [] }));
    props = Object.entries(defs).filter(([, d]) => d.type !== "VARIANT").map(([k, d]) => ({ name: k.split("#")[0], type: d.type }));
  } catch (e) {}
  let dv;
  try { if (n.type === "COMPONENT_SET" && n.defaultVariant) dv = { name: n.defaultVariant.name, key: n.defaultVariant.key, nodeId: n.defaultVariant.id }; } catch (e) {}
  out.push({ name: n.name, key: n.key, nodeId: n.id, type: n.type, description: n.description || undefined, variantAxes: axes, properties: props, defaultVariant: dv, source: "local" });
}
return out;`;
	const res = await connector.executeCodeViaUI(code, 60000, fileKey);
	const value = res && typeof res === "object" && "result" in res ? res.result : res;
	if (!Array.isArray(value)) throw new Error(res?.error ?? "Could not read components from the file.");
	return value;
}

async function loadCatalog(
	deps: AdherenceToolDeps,
	libraryKeys: string[],
	includeLocal: boolean,
	fileKey?: string,
): Promise<{ catalog: CatalogEntry[]; sources: Array<{ source: string; components: number; error?: string }>; variantKeys: Set<string> }> {
	const catalog: CatalogEntry[] = [];
	const sources: Array<{ source: string; components: number; error?: string }> = [];
	const variantKeys = new Set<string>();
	if (includeLocal) {
		try {
			// The cached manifest describes the ACTIVE file; a specific fileKey is read
			// from that file through the plugin, so the catalog matches what's audited.
			const local =
				deps.getLocalCatalog && !fileKey
					? await deps.getLocalCatalog()
					: await pluginCatalog(await deps.getDesktopConnector(), fileKey);
			catalog.push(...local);
			sources.push({ source: "local", components: local.length });
		} catch (err) {
			sources.push({ source: "local", components: 0, error: err instanceof Error ? err.message : String(err) });
		}
	}
	if (libraryKeys.length > 0) {
		if (!deps.getFigmaAPI) {
			for (const k of libraryKeys) sources.push({ source: k, components: 0, error: "Library lookup needs the Figma REST API (FIGMA_ACCESS_TOKEN)." });
		} else {
			let api: any = null;
			let apiError: string | null = null;
			try {
				api = await deps.getFigmaAPI();
			} catch (err) {
				apiError = err instanceof Error ? err.message : String(err);
			}
			for (const k of libraryKeys) {
				if (!api) {
					sources.push({ source: k, components: 0, error: `Figma REST API unavailable: ${apiError}` });
					continue;
				}
				try {
					const lib = await loadLibraryCatalog(api, k);
					catalog.push(...lib.entries);
					for (const v of lib.variantKeys) variantKeys.add(v);
					sources.push({ source: k, components: lib.entries.length });
				} catch (err) {
					sources.push({ source: k, components: 0, error: err instanceof Error ? err.message : String(err) });
				}
			}
		}
	}
	return { catalog, sources, variantKeys };
}

const RESOLVE_DESCRIPTION = `Before generating a design or code from a design system: map each UI element the request needs to a REAL component, and report what's missing instead of inventing it. Pass the needs in plain words (e.g. ["primary button", "date picker", "user avatar", "pricing card"]). Matching is deterministic (names, variants, descriptions, UI synonyms) — no judgment calls:
• matched — build with this component (key/nodeId returned; use figma_instantiate_component).
• possible — something might fit; a person must confirm.
• gap — the system has nothing for it.
When the client supports it, the PERSON is asked how to handle each possible/gap item (stop, use a candidate, or a clearly labeled "${GAP_PREFIX} …" placeholder) and the decisions are returned. Otherwise the result says to stop and report the gaps to the user. Never substitute a hand-built look-alike for a gap. Searches the active file's components by default; pass libraryFileKeys/libraryFileUrls for published libraries (REST, needs FIGMA_ACCESS_TOKEN). Then verify the result with figma_audit_adherence.`;

const AUDIT_DESCRIPTION = `Score how faithfully a generated composition uses the design system — the check to run after building a screen/section, and the evidence for an independent grader. Walks the frame (nodeId, or the single selected node) and reports: component instances used (local vs. library, by name), hand-built layers imitating a system component (error), new components created inside the composition (error), hand-drawn vectors (warning), styling not bound to variables/styles (colors, spacing, radius, typography, effects), instance style overrides, and declared "${GAP_PREFIX} …" placeholders. Returns componentCoverage, tokenCoverage, a 0–100 score, and pass/fail against minScore (default 90; any error fails). Pass libraryFileKeys to also fail instances of components that aren't from those libraries (off-system). Deterministic: same file, same result. Requires the Desktop Bridge.`;

function libraryKeysUsed(args: { libraryFileKeys?: string[] }): boolean {
	return (args.libraryFileKeys ?? []).length > 0;
}

export function registerAdherenceTools(server: McpServer, deps: AdherenceToolDeps): void {
	server.registerTool(
		"figma_resolve_components",
		{
			description: RESOLVE_DESCRIPTION,
			inputSchema: z.object({
				needs: z
					.array(z.string().min(1))
					.min(1)
					.max(40)
					.describe("The UI elements the request needs, in plain words, one per entry."),
				libraryFileKeys: z.array(z.string()).optional().describe("Published library file keys to search (REST)."),
				libraryFileUrls: z.array(z.string()).optional().describe("Published library file URLs (alternative to keys)."),
				includeLocal: z
					.boolean()
					.optional()
					.describe("Search components defined in the active file. Default true."),
				askUser: z
					.boolean()
					.optional()
					.describe("Ask the person how to handle possible matches and gaps when the client can show a form. Default true."),
			}),
		},
		async (args, ctx) => {
			try {
				const libraryKeys = libraryKeysFrom(args);
				const { catalog, sources } = await loadCatalog(deps, libraryKeys, args.includeLocal !== false);
				if (catalog.length === 0) {
					return text(
						{
							error: "No design-system components were found to match against, so nothing can be resolved. This is not the same as 'everything is a gap'.",
							sources,
							hint: "Open the Desktop Bridge in the design-system file, or pass libraryFileKeys/libraryFileUrls for the published library (needs FIGMA_ACCESS_TOKEN).",
						},
						true,
					);
				}

				const items = resolveNeeds(args.needs, catalog);
				const unresolved = items
					.map((it, i) => ({ it, i }))
					.filter(({ it }) => it.status !== "matched");

				// Let the person decide every non-match. Keyed to the exact needs and
				// candidates, so a re-run with different results asks again.
				let decisions: Record<number, { decision: "stop" | "placeholder" | "use"; component?: NeedResolution["component"] }> = {};
				let decisionSource: "user" | "none" = "none";
				if (unresolved.length > 0 && args.askUser !== false) {
					const fields: Record<string, any> = {};
					const fieldFor: Record<string, number> = {};
					for (const { it, i } of unresolved.slice(0, 15)) {
						const opts: string[] = [];
						const names: string[] = [];
						it.candidates.slice(0, 2).forEach((c, ci) => {
							if (c.score >= POSSIBLE_THRESHOLD) {
								opts.push(`use_${ci}`);
								names.push(`Use "${c.name}"`);
							}
						});
						opts.push("placeholder", "stop");
						names.push(`Add a labeled "${GAP_PREFIX} ${it.need}" placeholder`, "Stop — don't build it");
						const key = `need_${i + 1}`;
						fieldFor[key] = i;
						fields[key] = {
							type: "string",
							title: `${it.status === "gap" ? "Missing" : "Unsure"}: ${it.need}`,
							enum: opts,
							enumNames: names,
							default: "stop",
						};
					}
					const gapList = unresolved.filter(({ it }) => it.status === "gap").map(({ it }) => it.need);
					const possibleList = unresolved.filter(({ it }) => it.status === "possible").map(({ it }) => it.need);
					const step = confirmStep(
						server,
						ctx,
						`resolve_${fingerprint(...unresolved.map(({ it }) => `${it.need}=${it.candidates.map((c) => c.key).join(",")}`))}`,
						{
							message:
								[
									gapList.length ? `The design system has nothing for: ${gapList.join(", ")}.` : "",
									possibleList.length ? `Unclear matches for: ${possibleList.join(", ")}.` : "",
									"Choose how to handle each one. Nothing will be invented without your choice.",
								]
									.filter(Boolean)
									.join(" "),
							fields,
							required: Object.keys(fields),
						},
					);
					if (step.status === "ask") return step.result as any;
					if (step.status === "accepted") {
						decisionSource = "user";
						for (const [field, value] of Object.entries(step.content)) {
							const i = fieldFor[field];
							if (i === undefined) continue;
							const v = String(value);
							if (v.startsWith("use_")) {
								decisions[i] = { decision: "use", component: items[i].candidates[Number(v.slice(4))] };
							} else if (v === "placeholder") decisions[i] = { decision: "placeholder" };
							else decisions[i] = { decision: "stop" };
						}
					} else if (step.status === "declined" || step.status === "cancelled") {
						decisionSource = "user";
						decisions = Object.fromEntries(unresolved.map(({ i }) => [i, { decision: "stop" as const }]));
					}
				}

				const out = items.map((it, i) => {
					const d = decisions[i];
					const base: Record<string, unknown> = {
						need: it.need,
						status: it.status,
						...(it.component ? { component: it.component } : {}),
						...(it.status !== "matched" && it.candidates.length ? { candidates: it.candidates } : {}),
					};
					if (it.status === "matched") base.action = "build-with-component";
					else if (d?.decision === "use") {
						base.action = "build-with-component";
						base.component = d.component;
						base.decidedBy = "user";
					} else if (d?.decision === "placeholder") {
						base.action = "placeholder";
						base.placeholderName = `${GAP_PREFIX} ${it.need}`;
						base.decidedBy = "user";
					} else if (d?.decision === "stop") {
						base.action = "skip";
						base.decidedBy = "user";
					} else base.action = "ask-user";
					return base;
				});

				const counts = {
					needs: items.length,
					matched: items.filter((x) => x.status === "matched").length,
					possible: items.filter((x) => x.status === "possible").length,
					gaps: items.filter((x) => x.status === "gap").length,
				};
				const awaitingUser = out.filter((x) => x.action === "ask-user").map((x) => x.need);
				return text({
					success: true,
					summary: counts,
					sources,
					catalogSize: catalog.length,
					thresholds: { matched: MATCH_THRESHOLD, possible: POSSIBLE_THRESHOLD },
					decisionsBy: decisionSource,
					items: out,
					rules: [
						"Build ONLY items whose action is build-with-component, using that component: for a component set, instantiate component.defaultVariant (figma_instantiate_component with its key + nodeId, plus `variant` to pick other values from variantAxes); never the set key.",
						`For action placeholder, add one plainly labeled frame named exactly "${GAP_PREFIX} <need>" — no styling that imitates a real component.`,
						"For action skip, build nothing for it.",
						"Never hand-build a look-alike, and never create a new component, for anything not matched.",
						"Bind every color, spacing, radius and text style to the system's variables/styles; run figma_audit_adherence on the result.",
					],
					...(awaitingUser.length
						? {
								ai_instruction: `STOP before building. The design system has no confirmed component for: ${awaitingUser.join(", ")}. Tell the user exactly which items are missing or unclear (list the candidates) and ask how to proceed. Do not substitute, approximate or hand-build them.`,
							}
						: {}),
				});
			} catch (err) {
				logger.error({ err }, "figma_resolve_components failed");
				return text({ error: err instanceof Error ? err.message : String(err) }, true);
			}
		},
	);

	server.registerTool(
		"figma_audit_adherence",
		{
			description: AUDIT_DESCRIPTION,
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Root of the composition to audit. Defaults to the single selected node."),
				libraryFileKeys: z
					.array(z.string())
					.optional()
					.describe("If set, instances must come from these published libraries (or the file itself if allowLocal); anything else is off-system."),
				allowLocal: z
					.boolean()
					.optional()
					.describe("With libraryFileKeys: also allow components defined in this file. Default true."),
				minScore: z.number().min(0).max(100).optional().describe("Pass threshold for the 0–100 score. Default 90."),
				maxNodes: z.number().int().min(50).max(20000).optional().describe("Walk limit. Default 5000."),
				maxFindings: z.number().int().min(1).max(500).optional().describe("Findings returned (sorted by severity). Default 100."),
				fileKey: z.string().optional().describe("Run against this connected file instead of the active one."),
			}),
		},
		async (args) => {
			try {
				const connector = await deps.getDesktopConnector();
				const libraryKeys = args.libraryFileKeys ?? [];
				const { catalog, sources, variantKeys } = await loadCatalog(deps, libraryKeys, true, args.fileKey);
				const componentNames = [
					...new Set(
						catalog
							.map((c) => c.name.split("/").pop()!.trim().toLowerCase())
							.filter((n) => n.length >= 3),
					),
				];
				const code = buildAuditCode({ nodeId: args.nodeId, maxNodes: args.maxNodes ?? 5000, componentNames });
				const res = await connector.executeCodeViaUI(code, 120000, args.fileKey);
				const raw = res && typeof res === "object" && "result" in res ? res.result : res;
				if (!raw || raw.error) {
					return text({ error: raw?.error ?? res?.error ?? "Audit failed to run in the plugin.", hint: "Pass a nodeId of the generated frame (or select it) in the connected file." }, true);
				}

				const findings: any[] = raw.findings ?? [];
				// Off-system components: only checkable against the given libraries.
				// Asked to check against libraries but none loaded: the off-system check
				// can't run, so the audit can't vouch for it — fail loudly, don't pass.
				const offSystemUnchecked = libraryKeys.length > 0 && variantKeys.size === 0;
				if (offSystemUnchecked) {
					findings.push({
						rule: "off-system-check-unavailable",
						severity: "error",
						message: `Couldn't load the libraries in libraryFileKeys (${sources.filter((x) => x.error).map((x) => `${x.source}: ${x.error}`).join("; ") || "no components returned"}), so instances weren't checked against them. Fix access (FIGMA_ACCESS_TOKEN, file key) and re-run.`,
					});
				}
				if (libraryKeys.length > 0 && variantKeys.size > 0) {
					const allowLocal = args.allowLocal !== false;
					for (const u of raw.componentsUsed ?? []) {
						const inLib = (u.key && variantKeys.has(u.key)) || (u.setKey && variantKeys.has(u.setKey));
						const ok = inLib || (u.source === "local" && allowLocal);
						u.inAllowedLibraries = ok;
						if (!ok) {
							findings.push({
								nodeId: u.nodeIds?.[0],
								name: u.name,
								type: "INSTANCE",
								rule: "off-system-component",
								severity: "error",
								message: `"${u.name}" (${u.count}×) isn't from the allowed libraries.`,
								nodeIds: u.nodeIds,
							});
						}
					}
				}

				const s = raw.stats;
				const inventions = s.imitations + s.suspects + s.newComponents + s.handDrawnVectors;
				const componentCoverage = s.instances + inventions > 0 ? s.instances / (s.instances + inventions) : null;
				const tokenCoverage = s.styledProps > 0 ? s.boundProps / s.styledProps : null;
				const parts = [componentCoverage, tokenCoverage].filter((x): x is number => x !== null);
				const score = parts.length ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100) : 100;
				const sevRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
				findings.sort((a, b) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3));
				const errors = findings.filter((f) => f.severity === "error").length;
				const warnings = findings.filter((f) => f.severity === "warning").length;
				const minScore = args.minScore ?? 90;
				const pass = errors === 0 && score >= minScore && !s.truncated;
				const byRule: Record<string, number> = {};
				for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
				const maxFindings = args.maxFindings ?? 100;

				return text({
					success: true,
					pass,
					score,
					minScore,
					componentCoverage: componentCoverage === null ? null : Math.round(componentCoverage * 1000) / 1000,
					tokenCoverage: tokenCoverage === null ? null : Math.round(tokenCoverage * 1000) / 1000,
					root: raw.root,
					file: raw.file,
					counts: { errors, warnings, info: findings.length - errors - warnings, byRule },
					stats: s,
					componentsUsed: raw.componentsUsed,
					declaredGaps: raw.gaps,
					catalogSources: sources,
					findings: findings.slice(0, maxFindings),
					findingsTruncated: findings.length > maxFindings,
					scoring:
						"componentCoverage = instances ÷ (instances + imitations + hand-built suspects + new components + hand-drawn vectors). tokenCoverage = bound ÷ styled properties outside instances (fills, strokes, spacing, radius, effects, text styles). score = mean of the two × 100. Fails on any error, on score < minScore, or if the walk was truncated.",
					...(s.truncated ? { warning: `Stopped after ${s.nodesVisited} nodes; raise maxNodes or audit a smaller frame. A truncated audit never passes.` } : {}),
					...(raw.gaps?.length ? { gapNote: `${raw.gaps.length} declared gap placeholder(s): ${raw.gaps.join(", ")}. These are reported, not scored.` } : {}),
				});
			} catch (err) {
				logger.error({ err }, "figma_audit_adherence failed");
				return text({ error: err instanceof Error ? err.message : String(err) }, true);
			}
		},
	);

	server.registerTool(
		"figma_audit_code_adherence",
		{
			description:
				"Check generated CODE against the design system — the code-side twin of figma_audit_adherence and the evidence for an independent grader. Flags: re-implementing a component the system already has (error), references to tokens that don't exist (error, when tokensPath/tokens is given), raw <button>/<input>/<select>/<textarea>/<dialog>/<table> where the system has a component, hardcoded colors and spacing/radius/type lengths instead of tokens, Tailwind arbitrary values like bg-[#fff] or p-[13px], and inline styles. Counts system component usage from imports of designSystem.packages. Returns componentCoverage, tokenCoverage, a 0–100 score and pass/fail (minScore, default 90; any error fails), with file:line for every finding. Static and deterministic. Pass files (local paths) or sources ({path, content}).",
			inputSchema: z.object({
				files: z.array(z.string()).optional().describe("Local file paths to check (Local Mode)."),
				sources: z
					.array(z.object({ path: z.string(), content: z.string() }))
					.optional()
					.describe("Inline file contents (works in every mode)."),
				designSystem: z
					.object({
						packages: z.array(z.string()).optional().describe('Import sources that are the design system, e.g. ["@acme/ui", "@/components/ui"].'),
						components: z.array(z.string()).optional().describe("Component names the system provides, if not discoverable from imports."),
						componentsDir: z
							.string()
							.optional()
							.describe('Folder of the system\'s component files (e.g. "src/components/ui"); names come from file names (dropdown-menu.tsx → DropdownMenu). Local Mode.'),
						tokensPath: z.string().optional().describe("Token file (CSS custom properties or DTCG/nested JSON) — enables unknown-token checks."),
						tokens: z.array(z.string()).optional().describe("Token names, as an alternative to tokensPath."),
					})
					.describe("What counts as the design system."),
				minScore: z.number().min(0).max(100).optional().describe("Pass threshold. Default 90."),
				maxFindings: z.number().int().min(1).max(500).optional().describe("Findings returned. Default 100."),
			}),
		},
		async (args) => {
			try {
				const sources: CodeSource[] = [...(args.sources ?? [])];
				const unreadable: string[] = [];
				if (args.files?.length) {
					if (!deps.readFile) {
						return text({ error: "Reading files needs Local Mode. Pass `sources` with the file contents instead." }, true);
					}
					for (const f of args.files) {
						try {
							sources.push({ path: f, content: await deps.readFile(f) });
						} catch {
							unreadable.push(f);
						}
					}
				}
				if (sources.length === 0) return text({ error: "No code to check: pass files or sources.", unreadable }, true);

				let components = args.designSystem.components;
				if (args.designSystem.componentsDir) {
					if (!deps.listDir) return text({ error: "componentsDir needs Local Mode; pass designSystem.components instead." }, true);
					components = [...(components ?? []), ...componentNamesFromFiles(await deps.listDir(args.designSystem.componentsDir))];
				}
				let tokens = args.designSystem.tokens;
				if (args.designSystem.tokensPath) {
					if (!deps.readFile) return text({ error: "tokensPath needs Local Mode; pass designSystem.tokens instead." }, true);
					tokens = [...(tokens ?? []), ...tokenNamesFrom(args.designSystem.tokensPath, await deps.readFile(args.designSystem.tokensPath))];
				}
				const result = auditCode(sources, { ...args.designSystem, components, tokens });
				const verdict = scoreCodeAudit(result, args.minScore ?? 90);
				const sevRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
				result.findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
				const byRule: Record<string, number> = {};
				for (const f of result.findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
				const maxFindings = args.maxFindings ?? 100;
				return text({
					success: true,
					...verdict,
					minScore: args.minScore ?? 90,
					files: result.files,
					...(unreadable.length ? { unreadable } : {}),
					stats: result.stats,
					componentsUsed: result.componentsUsed,
					counts: { errors: verdict.errors, warnings: verdict.warnings, byRule },
					findings: result.findings.slice(0, maxFindings),
					findingsTruncated: result.findings.length > maxFindings,
					...(args.designSystem.packages?.length || components?.length
						? {}
						: { warning: "No designSystem.packages or components given, so component usage and re-implementations can't be checked — only tokens and literals." }),
					scoring:
						"componentCoverage = system component uses ÷ (uses + re-implementations + raw elements the system covers). tokenCoverage = valid token references ÷ (token references + hardcoded literals). score = mean × 100. Fails on any error or score < minScore.",
				});
			} catch (err) {
				logger.error({ err }, "figma_audit_code_adherence failed");
				return text({ error: err instanceof Error ? err.message : String(err) }, true);
			}
		},
	);

	server.registerTool(
		"figma_check_library_parity",
		{
			description:
				"Library-level parity between a Figma component library and its code counterpart: which components exist on both sides, which are only in Figma, and which are only in code. Pairs by exact name, then the same words ignoring case/punctuation/folders, then the same UI concept (only when unambiguous, so nothing is force-paired). Archived/deprecated/private Figma components are listed separately, not counted as missing. Figma side: the active file's components (default) and/or published libraries (libraryFileKeys, REST). Code side: componentsDir (file names, Local Mode) and/or a components list. Then use figma_check_design_parity on each pair for property-level drift. Deterministic; it reports differences and decides nothing.",
			inputSchema: z.object({
				componentsDir: z.string().optional().describe('Folder of the code library\'s component files, e.g. "src/components/ui" (Local Mode).'),
				components: z.array(z.string()).optional().describe("Code component names (alternative or addition to componentsDir)."),
				libraryFileKeys: z.array(z.string()).optional().describe("Published Figma library file keys (REST)."),
				includeLocal: z.boolean().optional().describe("Include components defined in the active Figma file. Default true."),
				manifestPath: z
					.string()
					.optional()
					.describe("custom-elements.json (Custom Elements Manifest) of the code library — enables property-level parity: Figma variant axes and component properties vs. code props and slots. React wrappers built with @lit/react share these props. Local Mode."),
				manifestJson: z.string().optional().describe("The manifest's contents, as an alternative to manifestPath (any mode)."),
				classPrefixes: z.array(z.string()).optional().describe('Class-name prefixes to strip when matching, e.g. ["AL"] for ALButton → Button.'),
				contractsDir: z
					.string()
					.optional()
					.describe("Folder of component contract files (*.contract.json with props[].bindings.figma.omit / pairWith) — decisions already on record: omitted props aren't drift, and recorded pairings beat automatic matching. Local Mode."),
				decisions: z
					.record(
						z.string(),
						z.object({
							omit: z.array(z.string()).optional().describe("Code props deliberately not in Figma."),
							pairWith: z.record(z.string(), z.string()).optional().describe("Code prop → Figma axis/property name."),
						}),
					)
					.optional()
					.describe('Inline decisions per component (key: code component or tag name), e.g. { "button": { "omit": ["fullWidth"], "pairWith": { "isPill": "Shape" } } }.'),
			}),
		},
		async (args) => {
			try {
				let cem: any = null;
				if (args.manifestJson) cem = JSON.parse(args.manifestJson);
				else if (args.manifestPath) {
					if (!deps.readFile) return text({ error: "manifestPath needs Local Mode; pass manifestJson instead." }, true);
					cem = JSON.parse(await deps.readFile(args.manifestPath));
				}
				const cemIndex = cem ? indexCem(cem, args.classPrefixes ?? []) : null;
				const decisionIndex = new Map<string, ComponentDecisions>();
				if (args.contractsDir) {
					if (!deps.listDir || !deps.readFile) return text({ error: "contractsDir needs Local Mode; pass decisions instead." }, true);
					const files = (await deps.listDir(args.contractsDir)).filter((f) => f.endsWith(".contract.json"));
					const contracts: any[] = [];
					for (const f of files) {
						try {
							contracts.push(JSON.parse(await deps.readFile(`${args.contractsDir.replace(/\/$/, "")}/${f}`)));
						} catch {}
					}
					for (const [k, v] of decisionsFromContracts(contracts)) decisionIndex.set(k, v);
				}
				for (const [k, v] of Object.entries(args.decisions ?? {})) {
					decisionIndex.set(k.toLowerCase().replace(/[^a-z0-9]/g, ""), v);
				}
				let code = [...(args.components ?? [])];
				if (cemIndex && code.length === 0 && !args.componentsDir) {
					// Code components straight from the manifest's custom elements.
					const names = new Set<string>();
					for (const c of cemIndex.values()) {
						const raw = c.tagName ? c.tagName.replace(/^[a-z]+-/, "") : c.className ?? "";
						names.add(raw.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join(""));
					}
					code = [...names].filter(Boolean);
				}
				if (args.componentsDir) {
					if (!deps.listDir) return text({ error: "componentsDir needs Local Mode; pass components instead." }, true);
					code = [...code, ...componentNamesFromFiles(await deps.listDir(args.componentsDir))];
				}
				code = [...new Set(code)];
				if (code.length === 0) return text({ error: "No code components given: pass componentsDir or components." }, true);
				// Property-level parity needs component property definitions, which only
				// the plugin can read — so with a manifest, the local side comes from it.
				const { catalog, sources } = await loadCatalog(
					cemIndex ? { ...deps, getLocalCatalog: undefined } : deps,
					args.libraryFileKeys ?? [],
					args.includeLocal !== false,
				);
				if (catalog.length === 0) {
					return text({ error: "No Figma components found to compare against.", sources, hint: "Open the Desktop Bridge in the library file, or pass libraryFileKeys." }, true);
				}
				const r = pairLibraries(catalog, code);
				let props: any[] | undefined;
				if (cemIndex) {
					const byKey = new Map(catalog.map((c) => [c.key, c]));
					props = r.pairs.map((p) => {
						const fig = byKey.get(p.figma.key)!;
						const codeComp = cemIndex.get(p.code.toLowerCase().replace(/[^a-z0-9]/g, "")) ?? cemIndex.get(fig.name.split("/").pop()!.toLowerCase().replace(/[^a-z0-9]/g, ""));
						if (!codeComp) return { component: fig.name, status: "no-manifest-entry", note: `No custom element in the manifest matches "${p.code}".` };
						if (!fig.properties && libraryKeysUsed(args)) {
							return { component: fig.name, status: "unknown", note: "Property definitions are only readable from the open file (Desktop Bridge), not from a published library over REST." };
						}
						const nk = (x?: string) => (x ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
						const dec =
							decisionIndex.get(nk(codeComp.tagName)) ?? decisionIndex.get(nk(p.code)) ?? decisionIndex.get(nk(fig.name.split("/").pop()));
						return compareComponentProps({ name: fig.name, variantAxes: fig.variantAxes ?? [], properties: fig.properties }, codeComp, dec);
					});
				}
				const coverage = r.pairs.length / Math.max(1, r.pairs.length + r.figmaOnly.length + r.codeOnly.length);
				const propSummary = props
					? {
							inSync: props.filter((x) => x.status === "in-sync").length,
							drift: props.filter((x) => x.status === "drift").length,
							unchecked: props.filter((x) => x.status !== "in-sync" && x.status !== "drift").length,
						}
					: undefined;
				return text({
					success: true,
					summary: {
						paired: r.pairs.length,
						figmaOnly: r.figmaOnly.length,
						codeOnly: r.codeOnly.length,
						coverage: Math.round(coverage * 1000) / 1000,
						...(propSummary ? { properties: propSummary } : {}),
					},
					sources,
					pairs: r.pairs,
					figmaOnly: r.figmaOnly,
					codeOnly: r.codeOnly,
					...(r.retiredInFigma.length ? { retiredInFigma: r.retiredInFigma } : {}),
					...(props
						? {
								propertyParity: props.filter((x) => x.status !== "in-sync"),
								inSyncComponents: props.filter((x) => x.status === "in-sync").map((x) => x.component),
								propertyRules:
									"State axes: hover/focus/active need no prop; other states (Disabled, Error…) must map to a boolean prop. Other axes: same-name enum prop (values compared; Figma 'Default' = the code's omitted value), or a boolean flag (Shape=Pill → isPill, Label=Hidden → hideLabel). Figma 'Slot X' / 'Show X' / 'Text' properties map to slots or flags. Code-only props exclude non-visual ones (href, aria-*, value…).",
							}
						: {}),
					nextSteps: [
						"For each pair, run figma_check_design_parity (nodeId + codeSpec from the code file) to find property-level drift.",
						"figmaOnly / codeOnly are gaps on the other side: report them to the person; don't create components to close them without approval.",
						"Pairs matched by 'concept' are inferred from synonyms. Confirm them before relying on them.",
					],
				});
			} catch (err) {
				logger.error({ err }, "figma_check_library_parity failed");
				return text({ error: err instanceof Error ? err.message : String(err) }, true);
			}
		},
	);
}
