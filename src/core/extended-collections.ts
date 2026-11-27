/**
 * Extended variable collections (Figma "collection extensions").
 *
 * An extended collection inherits every variable of its parent, has its OWN mode
 * ids (each pointing back to a `parentModeId`), and stores the values it
 * overrides on ITSELF — `variableOverrides[variableId][extendedModeId]`. The
 * variables keep their parent's id and `variableCollectionId`, and
 * `variable.valuesByMode` only holds the ROOT collection's modes.
 *
 * So anything that reads `variable.valuesByMode` grouped by
 * `variable.variableCollectionId` — i.e. every tool here, before this module —
 * sees an extended collection with no variables and no values, and concludes
 * that no override exists. This module fetches the extension data and resolves
 * the value of every variable in every extended mode (override, or inherited
 * through however many levels of parent).
 *
 * Plugin API reference: `ExtendedVariableCollection` (isExtension,
 * parentVariableCollectionId, rootVariableCollectionId, variableOverrides,
 * modes[].parentModeId).
 */

/**
 * Run through the Desktop Bridge (EXECUTE_CODE). Server-owned, so it works with
 * every installed plugin version — no manifest re-import. Returns [] when the
 * file has no extended collections (or the API predates them).
 */
export const EXTENDED_COLLECTIONS_CODE = `
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const extensions = collections.filter((c) => c.isExtension === true);
if (extensions.length === 0) return [];
// An extension of a LIBRARY collection inherits the library's variables, which
// getLocalVariablesAsync() doesn't return — send them along so the server can
// show the extension's values.
// Fetched in parallel; one that fails is skipped, never the extension itself.
const localIds = new Set((await figma.variables.getLocalVariablesAsync()).map((v) => v.id));
const serialize = (v) => v && ({ id: v.id, name: v.name, key: v.key, resolvedType: v.resolvedType, valuesByMode: v.valuesByMode, variableCollectionId: v.variableCollectionId, scopes: v.scopes, description: v.description, codeSyntax: v.codeSyntax, remote: true });
const out = [];
for (const c of extensions) {
  const ids = c.variableIds.filter((id) => !localIds.has(id));
  const libraryVariables = (await Promise.all(ids.map((id) => figma.variables.getVariableByIdAsync(id).then(serialize, () => null)))).filter(Boolean);
  out.push({
    id: c.id,
    name: c.name,
    isExtension: true,
    parentVariableCollectionId: c.parentVariableCollectionId,
    rootVariableCollectionId: c.rootVariableCollectionId,
    defaultModeId: c.defaultModeId,
    modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name, parentModeId: m.parentModeId })),
    variableIds: c.variableIds,
    variableOverrides: c.variableOverrides || {},
    ...(libraryVariables.length ? { libraryVariables } : {}),
  });
}
return out;
`;

export interface ExtendedCollectionInfo {
	id: string;
	name: string;
	isExtension: true;
	parentVariableCollectionId: string;
	rootVariableCollectionId: string;
	defaultModeId?: string;
	modes: Array<{ modeId: string; name: string; parentModeId: string }>;
	variableIds: string[];
	variableOverrides: Record<string, Record<string, unknown>>;
	/** Variables inherited from a library collection (not in the file's own variables) */
	libraryVariables?: any[];
}

/** Unwrap the bridge's EXECUTE_CODE envelope(s) to the array the snippet returned. */
export function unwrapExtendedCollectionsResult(raw: any): ExtendedCollectionInfo[] | null {
	let value = raw;
	for (let i = 0; i < 3 && value && !Array.isArray(value); i++) value = value.result;
	return Array.isArray(value) ? (value as ExtendedCollectionInfo[]) : null;
}

/**
 * Merge extension metadata onto the collections of a variables payload, in
 * place. Adds the extended collection if the payload didn't list it at all.
 * Returns the number of extended collections merged.
 */
export function mergeExtendedCollections(data: any, extensions: ExtendedCollectionInfo[]): number {
	if (!data || !Array.isArray(extensions) || extensions.length === 0) return 0;
	if (!Array.isArray(data.variableCollections)) data.variableCollections = [];
	for (const { libraryVariables, ...ext } of extensions) {
		// Figma reports an extension's defaultModeId in short form ("12:0")
		// while its modes use the full id ("VariableCollectionId:…/12:0").
		// A tool given the short form is refused by Figma, so report the real one.
		if (ext.defaultModeId && !ext.modes?.some((m) => m.modeId === ext.defaultModeId)) {
			const full = ext.modes?.find((m) => m.modeId.endsWith(`/${ext.defaultModeId}`));
			if (full) ext.defaultModeId = full.modeId;
		}
		const existing = data.variableCollections.find((c: any) => c.id === ext.id);
		const target = existing ? Object.assign(existing, ext) : ext;
		if (!existing) data.variableCollections.push(target);
		// Not enumerable: available to the extension views below, but never
		// serialized into a tool result (a library can hold thousands).
		if (libraryVariables?.length)
			Object.defineProperty(target, "libraryVariables", { value: libraryVariables, enumerable: false, configurable: true, writable: true });
	}
	return extensions.length;
}

/** A variable by id: the file's own, else one an extension inherits from a library. */
function findVariable(data: any, variableId: string): any {
	const own = (data?.variables ?? []).find((v: any) => v.id === variableId);
	if (own) return own;
	for (const c of data?.variableCollections ?? []) {
		const lib = c?.libraryVariables?.find((v: any) => v.id === variableId);
		if (lib) return lib;
	}
	return undefined;
}

export interface ResolvedModeValue {
	value: unknown;
	/** Collection whose override supplied the value; null when it comes from the root variable */
	overriddenIn: string | null;
}

/**
 * The value of `variableId` in `modeId` of `collectionId`, following the
 * extension chain: this collection's override, else the parent's value for the
 * parent mode, down to the root variable's own `valuesByMode`.
 */
export function resolveValueInCollection(
	data: any,
	collectionId: string,
	variableId: string,
	modeId: string,
): ResolvedModeValue | undefined {
	const collections: any[] = data?.variableCollections ?? [];
	let cId = collectionId;
	let mId = modeId;
	for (let depth = 0; depth < 16; depth++) {
		const c = collections.find((x) => x.id === cId);
		if (c?.isExtension) {
			const override = c.variableOverrides?.[variableId]?.[mId];
			if (override !== undefined) return { value: override, overriddenIn: c.id };
			const mode = c.modes?.find((m: any) => m.modeId === mId);
			if (!mode?.parentModeId || !c.parentVariableCollectionId) return undefined;
			cId = c.parentVariableCollectionId;
			mId = mode.parentModeId;
			continue;
		}
		const v = findVariable(data, variableId);
		if (!v || !v.valuesByMode || !(mId in v.valuesByMode)) return undefined;
		return { value: v.valuesByMode[mId], overriddenIn: null };
	}
	return undefined;
}

/**
 * The variables of an extended collection AS THEY APPEAR IN IT: the real
 * variable (same id — write tools keep working), with `valuesByMode` keyed by
 * the extended collection's own modes and resolved through the chain.
 * `overriddenModeIds` lists the modes this collection overrides; everything
 * else is inherited. `definedInCollectionId` keeps the variable's home.
 */
export function extendedCollectionView(data: any, collection: any): any[] {
	if (!collection?.isExtension) return [];
	const out: any[] = [];
	for (const variableId of collection.variableIds ?? []) {
		const base = findVariable(data, variableId);
		if (!base) continue;
		const valuesByMode: Record<string, unknown> = {};
		const overriddenModeIds: string[] = [];
		for (const mode of collection.modes ?? []) {
			const resolved = resolveValueInCollection(data, collection.id, variableId, mode.modeId);
			if (!resolved) continue;
			valuesByMode[mode.modeId] = resolved.value;
			if (resolved.overriddenIn === collection.id) overriddenModeIds.push(mode.modeId);
		}
		out.push({
			...base,
			variableCollectionId: collection.id,
			definedInCollectionId: base.variableCollectionId,
			valuesByMode,
			overriddenModeIds,
		});
	}
	return out;
}

/** Per-collection override totals, for summaries */
export function countOverrides(collection: any): { variables: number; values: number } {
	const overrides = collection?.variableOverrides ?? {};
	let values = 0;
	for (const byMode of Object.values(overrides) as Array<Record<string, unknown>>) values += Object.keys(byMode ?? {}).length;
	return { variables: Object.keys(overrides).length, values };
}

/**
 * For each variable, the overrides extended collections place on it —
 * `[{ collectionId, collectionName, valuesByMode: { [extendedModeId]: value }, modeNames }]`.
 * Only variables with at least one override get an entry.
 */
export function overridesByVariable(data: any): Map<string, Array<{ collectionId: string; collectionName: string; valuesByMode: Record<string, unknown>; modeNames: Record<string, string> }>> {
	const map = new Map<string, any[]>();
	for (const c of data?.variableCollections ?? []) {
		if (!c?.isExtension) continue;
		const modeNames: Record<string, string> = {};
		for (const m of c.modes ?? []) modeNames[m.modeId] = m.name;
		for (const [variableId, byMode] of Object.entries(c.variableOverrides ?? {}) as Array<[string, Record<string, unknown>]>) {
			if (!byMode || Object.keys(byMode).length === 0) continue;
			if (!map.has(variableId)) map.set(variableId, []);
			map.get(variableId)!.push({ collectionId: c.id, collectionName: c.name, valuesByMode: { ...byMode }, modeNames });
		}
	}
	return map;
}

/**
 * Add `extendedCollectionOverrides` to every variable an extended collection
 * overrides, in place — so an agent looking at the VARIABLE sees its overrides,
 * with mode names. Purely additive: ids and valuesByMode are untouched, so
 * id-keyed lookups elsewhere are unaffected.
 */
export function annotateVariableOverrides(data: any): void {
	const byVariable = overridesByVariable(data);
	for (const v of data?.variables ?? []) {
		const entries = byVariable.get(v.id);
		if (!entries) continue;
		v.extendedCollectionOverrides = entries.map((e) => ({
			collectionId: e.collectionId,
			collectionName: e.collectionName,
			overrides: Object.entries(e.valuesByMode).map(([modeId, value]) => ({ modeId, modeName: e.modeNames[modeId] ?? modeId, value })),
		}));
	}
}

/**
 * Fetch extension data through the bridge and merge it into `data` in place.
 * Never throws: on failure returns a warning string, so the caller can say the
 * picture may be incomplete instead of silently implying "no extensions".
 */
export async function augmentWithExtendedCollections(
	connector: { executeCodeViaUI?: (code: string, timeoutMs?: number, fileKey?: string) => Promise<any> },
	data: any,
	fileKey?: string,
): Promise<{ merged: number; warning?: string }> {
	if (!connector?.executeCodeViaUI) return { merged: 0 };
	try {
		const raw = await connector.executeCodeViaUI(EXTENDED_COLLECTIONS_CODE, 30000, fileKey);
		if (raw && raw.success === false) {
			return { merged: 0, warning: `Could not read extended collections: ${raw.error ?? "unknown error"}. Overrides in extended collections may be missing from this result.` };
		}
		const extensions = unwrapExtendedCollectionsResult(raw);
		if (!extensions) return { merged: 0 };
		const merged = mergeExtendedCollections(data, extensions);
		annotateVariableOverrides(data);
		return { merged };
	} catch (err) {
		return {
			merged: 0,
			warning: `Could not read extended collections: ${err instanceof Error ? err.message : String(err)}. Overrides in extended collections may be missing from this result.`,
		};
	}
}
