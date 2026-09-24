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
return collections
  .filter((c) => c.isExtension === true)
  .map((c) => ({
    id: c.id,
    name: c.name,
    isExtension: true,
    parentVariableCollectionId: c.parentVariableCollectionId,
    rootVariableCollectionId: c.rootVariableCollectionId,
    defaultModeId: c.defaultModeId,
    modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name, parentModeId: m.parentModeId })),
    variableIds: c.variableIds,
    variableOverrides: c.variableOverrides || {},
  }));
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
	for (const ext of extensions) {
		const existing = data.variableCollections.find((c: any) => c.id === ext.id);
		if (existing) Object.assign(existing, ext);
		else data.variableCollections.push({ ...ext });
	}
	return extensions.length;
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
	const variables: any[] = data?.variables ?? [];
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
		const v = variables.find((x) => x.id === variableId);
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
	const variables: any[] = data?.variables ?? [];
	const out: any[] = [];
	for (const variableId of collection.variableIds ?? []) {
		const base = variables.find((v) => v.id === variableId);
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
		const raw = await connector.executeCodeViaUI(EXTENDED_COLLECTIONS_CODE, 15000, fileKey);
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
