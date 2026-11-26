/**
 * Property-level parity between a Figma component (variant axes + component
 * properties) and its code counterpart, read from a Custom Elements Manifest
 * (custom-elements.json — Web Components; React wrappers built with
 * @lit/react share the same props).
 *
 * Deterministic and explainable: every mapping says which rule made it, and
 * every difference lists the exact values on each side. It reports; it never
 * decides which side is right.
 */

export interface CodeProp {
	name: string;
	kind: "enum" | "boolean" | "string" | "number" | "other";
	values?: string[];
	typeText: string;
}

export interface CodeComponent {
	tagName?: string;
	className?: string;
	props: CodeProp[];
	slots: string[];
}

export interface FigmaComponentShape {
	name: string;
	variantAxes: Array<{ name: string; values: string[] }>;
	/** Non-variant component properties (BOOLEAN / TEXT / INSTANCE_SWAP / SLOT). */
	properties?: Array<{ name: string; type: string }>;
}

export interface AxisComparison {
	figmaAxis: string;
	codeProp?: string;
	/** How the axis was mapped: same-name, boolean-flag, state, or none */
	mappedBy: "same-name" | "same-values" | "boolean-flag" | "slot" | "state" | "none";
	figmaOnlyValues: string[];
	codeOnlyValues: string[];
	/** For state axes: each non-interaction state value and the prop it maps to (or null) */
	stateProps?: Record<string, string | null>;
}

/** Decisions already on record for one component (e.g. from design-system contracts). */
export interface ComponentDecisions {
	/** Code props deliberately not expressed in Figma. */
	omit?: string[];
	/** Code prop → the Figma axis/property it is deliberately paired with. */
	pairWith?: Record<string, string>;
}

export interface PropsParity {
	component: string;
	codeTag?: string;
	status: "in-sync" | "drift";
	axes: AxisComparison[];
	/** Appearance-affecting code props with no Figma axis or property */
	codeOnlyProps: Array<{ name: string; type: string }>;
	/** Figma content properties (Show X / Slot X / Text) with no code prop or slot */
	figmaOnlyProperties: string[];
	/** Code props skipped because a recorded decision omits them from Figma. */
	omittedByDecision?: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** "Display Sm" → "displaysm", "display-sm" → "displaysm" */
const normValue = norm;

/** Props that never show up as a design variant. */
const NON_VISUAL_PROPS = new Set(
	[
		"id", "name", "value", "values", "href", "target", "type", "label", "ariaLabel", "ariaLabelledBy",
		"ariaDescribedBy", "ariaControls", "role", "tabIndex", "form", "autocomplete", "placeholder", "rel",
		"download", "items", "options", "min", "max", "step", "maxLength", "minLength", "pattern", "accept",
		"fieldNote", "errorNote", "helperText", "pressedLabel", "text", "titleText", "src", "alt", "srcset",
		"sizes", "loading", "describedBy", "labelledBy", "for", "lang", "dir", "isFocused", "isRequired",
		"isAriaDisabled", "isPressed", "isOpen", "isActive", "isActiveDropdown", "isExpanded", "filterMode",
		// behavior, not appearance
		"triggerHasOwnFocusable", "disableClickOutside", "disableBackdropClick", "multiple", "isDismissed",
		"isDynamic", "isInteractive", "behavior", "tagName", "isHidden", "isDragging",
	].map(norm),
);

/** Figma state values that are interactions, not props. */
const INTERACTION_STATES = new Set(["default", "rest", "hover", "focus", "focused", "active", "pressed", "focusvisible"]);
const STATE_AXIS = /^(state|states|interaction|status)$/i;
const OFF_VALUES = new Set(["default", "no", "off", "false", "hidden", "none", "regular", "base"]);

export function parseTypeText(typeText: string): Pick<CodeProp, "kind" | "values"> {
	const t = typeText.trim();
	if (/^boolean$/.test(t)) return { kind: "boolean" };
	const lits = [...t.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
	if (lits.length > 0) return { kind: "enum", values: lits };
	if (/^string$/.test(t)) return { kind: "string" };
	if (/^number$/.test(t)) return { kind: "number" };
	return { kind: "other" };
}

/** Index a Custom Elements Manifest by normalized component name (tag minus prefix, and class name minus prefix). */
export function indexCem(cem: any, prefixes: string[] = []): Map<string, CodeComponent> {
	const out = new Map<string, CodeComponent>();
	for (const mod of cem?.modules ?? []) {
		for (const dec of mod.declarations ?? []) {
			if (!dec.tagName && !dec.customElement) continue;
			const props: CodeProp[] = [];
			const seen = new Set<string>();
			for (const a of [...(dec.attributes ?? []), ...(dec.members ?? []).filter((m: any) => m.kind === "field" && m.privacy !== "private" && m.privacy !== "protected" && !m.static)]) {
				const name = a.fieldName ?? a.name;
				if (!name || seen.has(name) || name.startsWith("_")) continue;
				seen.add(name);
				const typeText = a.type?.text ?? "";
				props.push({ name, typeText, ...parseTypeText(typeText) });
			}
			const comp: CodeComponent = {
				tagName: dec.tagName,
				className: dec.name,
				props,
				slots: (dec.slots ?? []).map((s: any) => s.name ?? ""),
			};
			const keys = new Set<string>();
			if (dec.tagName) {
				keys.add(norm(dec.tagName));
				keys.add(norm(dec.tagName.replace(/^[a-z]+-/, "")));
			}
			if (dec.name) {
				keys.add(norm(dec.name));
				for (const p of prefixes) if (dec.name.startsWith(p)) keys.add(norm(dec.name.slice(p.length)));
				keys.add(norm(dec.name.replace(/^[A-Z]{2,}(?=[A-Z][a-z])/, "")));
			}
			for (const k of keys) if (k && !out.has(k)) out.set(k, comp);
		}
	}
	return out;
}

function findBooleanFor(code: CodeComponent, hints: string[]): CodeProp | undefined {
	const bools = code.props.filter((p) => p.kind === "boolean");
	for (const h of hints.map(norm).filter(Boolean)) {
		const exact = bools.find((p) => [norm(p.name), norm(p.name.replace(/^(is|has|show|hide)/i, ""))].includes(h));
		if (exact) return exact;
	}
	for (const h of hints.map(norm).filter((x) => x.length >= 4)) {
		const partial = bools.find((p) => norm(p.name).includes(h));
		if (partial) return partial;
	}
	return undefined;
}

export function compareComponentProps(
	figma: FigmaComponentShape,
	code: CodeComponent,
	decisions: ComponentDecisions = {},
): PropsParity {
	const axes: AxisComparison[] = [];
	const usedProps = new Set<string>();
	const omitted = new Set(decisions.omit ?? []);
	for (const o of omitted) usedProps.add(o);

	// Recorded pairings win over every heuristic.
	const pairedTo = new Map<string, CodeProp[]>();
	for (const [prop, axisName] of Object.entries(decisions.pairWith ?? {})) {
		const cp = code.props.find((p) => p.name === prop);
		if (!cp) continue;
		pairedTo.set(norm(axisName), [...(pairedTo.get(norm(axisName)) ?? []), cp]);
	}

	for (const axis of figma.variantAxes) {
		const fValues = axis.values;
		const forced = pairedTo.get(norm(axis.name));
		if (forced && !STATE_AXIS.test(axis.name)) {
			for (const p of forced) usedProps.add(p.name);
			const enumProp = forced.find((p) => p.kind === "enum");
			if (enumProp) {
				const cv = new Set((enumProp.values ?? []).map(normValue));
				const fv = new Set(fValues.map(normValue));
				const missing = fValues.filter((v) => !cv.has(normValue(v)) && normValue(v) !== "default");
				axes.push({
					figmaAxis: axis.name,
					codeProp: enumProp.name,
					mappedBy: "same-name",
					// One unmatched Figma value is the code's omitted default.
					figmaOnlyValues: missing.length <= 1 ? [] : missing,
					codeOnlyValues: (enumProp.values ?? []).filter((v) => !fv.has(normValue(v))),
				});
			} else {
				// Boolean pairings: the axis must have a value for "on" besides its off value.
				const hasOn = fValues.some((v) => !OFF_VALUES.has(norm(v)));
				axes.push({
					figmaAxis: axis.name,
					codeProp: forced.map((p) => p.name).join(", "),
					mappedBy: "boolean-flag",
					figmaOnlyValues: [],
					codeOnlyValues: hasOn || fValues.length >= 2 ? [] : forced.map((p) => `${p.name}=true`),
				});
			}
			continue;
		}
		// 1. State axis: interactions need no prop; other states need a boolean.
		if (STATE_AXIS.test(axis.name)) {
			const stateProps: Record<string, string | null> = {};
			for (const v of fValues) {
				if (INTERACTION_STATES.has(norm(v))) continue;
				const p = findBooleanFor(code, [v, `is${v}`]);
				stateProps[v] = p?.name ?? null;
				if (p) usedProps.add(p.name);
			}
			const missing = Object.entries(stateProps).filter(([, p]) => !p).map(([v]) => v);
			axes.push({ figmaAxis: axis.name, mappedBy: "state", figmaOnlyValues: missing, codeOnlyValues: [], stateProps });
			continue;
		}
		// 2. Same-name enum prop.
		const sameName = code.props.find((p) => norm(p.name) === norm(axis.name) && (p.kind === "enum" || p.kind === "boolean"));
		if (sameName && sameName.kind === "enum") {
			usedProps.add(sameName.name);
			const cv = new Set((sameName.values ?? []).map(normValue));
			const fv = new Set(fValues.map(normValue));
			axes.push({
				figmaAxis: axis.name,
				codeProp: sameName.name,
				mappedBy: "same-name",
				// "Default" on the Figma side is the code's omitted value.
				figmaOnlyValues: fValues.filter((v) => !cv.has(normValue(v)) && normValue(v) !== "default"),
				codeOnlyValues: (sameName.values ?? []).filter((v) => !fv.has(normValue(v))),
			});
			continue;
		}
		// 2b. Same values, different name: Orientation=Row|Column ↔ direction: 'row' | 'column'.
		const nonDefault = fValues.filter((v) => normValue(v) !== "default");
		const byValues = code.props.find(
			(p) =>
				p.kind === "enum" &&
				!usedProps.has(p.name) &&
				nonDefault.length > 0 &&
				// Every Figma value is in the enum — or all but one, which is then the
				// value code expresses by omitting the prop (Orientation=Horizontal|Vertical
				// ↔ variant: 'vertical').
				nonDefault.filter((v) => !(p.values ?? []).map(normValue).includes(normValue(v))).length <=
					(nonDefault.length >= 2 ? 1 : 0),
		);
		if (byValues) {
			usedProps.add(byValues.name);
			const fv = new Set(fValues.map(normValue));
			axes.push({
				figmaAxis: axis.name,
				codeProp: byValues.name,
				mappedBy: "same-values",
				figmaOnlyValues: [],
				codeOnlyValues: (byValues.values ?? []).filter((v) => !fv.has(normValue(v))),
			});
			continue;
		}
		// 2c. An axis that toggles a slot: Footer=Yes|No ↔ slot "footer".
		if (code.slots.map(norm).includes(norm(axis.name)) && fValues.every((v) => /^(yes|no|on|off|true|false|shown|hidden|show|hide)$/i.test(v))) {
			axes.push({ figmaAxis: axis.name, codeProp: `slot "${axis.name.toLowerCase()}"`, mappedBy: "slot", figmaOnlyValues: [], codeOnlyValues: [] });
			continue;
		}
		// 2d. One base value plus flags: Shape=Label|Dot ↔ isDot; Role=Item|Header|Expandable ↔ isHeader, isExpandableHeader.
		if (!sameName && !OFF_VALUES.has(norm(fValues[0] ?? "")) && fValues.length >= 2) {
			const flagged = fValues.map((v) => ({ v, p: findBooleanFor(code, [v, `is${v}`, `has${v}`, `is${v}${axis.name}`]) }));
			const unmapped = flagged.filter((x) => !x.p);
			if (flagged.some((x) => x.p) && unmapped.length <= 1) {
				for (const x of flagged) if (x.p) usedProps.add(x.p.name);
				axes.push({
					figmaAxis: axis.name,
					codeProp: flagged.filter((x) => x.p).map((x) => `${x.v}→${x.p!.name}`).join(", "),
					mappedBy: "boolean-flag",
					figmaOnlyValues: [],
					codeOnlyValues: [],
				});
				continue;
			}
		}
		// 3. Boolean flags: an axis like Shape=Default|Pill → isPill; Checked=On|Off|Indeterminate → isChecked + isIndeterminate.
		const onValues = fValues.filter((v) => !OFF_VALUES.has(norm(v)));
		const offPresent = fValues.some((v) => OFF_VALUES.has(norm(v)));
		if (offPresent || sameName?.kind === "boolean") {
			const mapped: string[] = [];
			const missing: string[] = [];
			const axisProp = sameName?.kind === "boolean" ? sameName : findBooleanFor(code, [axis.name, `is${axis.name}`]);
			if (axisProp) usedProps.add(axisProp.name);
			for (const v of onValues) {
				// "On"/"Yes"/"Shown" are the axis itself; a named value is its own flag.
				const generic = /^(on|yes|true|shown|visible|show)$/i.test(v);
				const p = generic ? axisProp : findBooleanFor(code, [v, `is${v}`, `has${v}`]) ?? (fValues.length === 2 ? axisProp : undefined);
				if (p) {
					usedProps.add(p.name);
					mapped.push(`${v}→${p.name}`);
				} else missing.push(v);
			}
			// Hidden/Shown axes often map to a hideX prop.
			if (missing.length && /hidden|shown/i.test(fValues.join(" "))) {
				const hide = findBooleanFor(code, [`hide${axis.name}`]);
				if (hide) {
					usedProps.add(hide.name);
					missing.length = 0;
					mapped.push(`Hidden→${hide.name}`);
				}
			}
			axes.push({
				figmaAxis: axis.name,
				codeProp: mapped.join(", ") || axisProp?.name,
				mappedBy: mapped.length || axisProp ? "boolean-flag" : "none",
				figmaOnlyValues: missing,
				codeOnlyValues: [],
			});
			continue;
		}
		// 4. No counterpart.
		axes.push({ figmaAxis: axis.name, mappedBy: "none", figmaOnlyValues: fValues, codeOnlyValues: [] });
	}

	// Figma content properties: Slot X ↔ slot "x"; Show X ↔ hideX / showX / slot; Text ↔ default slot or label.
	const slotNames = new Set(code.slots.map(norm));
	const figmaOnlyProperties: string[] = [];
	for (const p of figma.properties ?? []) {
		const base = p.name.split("#")[0].trim();
		const m = base.match(/^(?:slot|show|has)\s+(.+)$/i);
		const rawSubject = norm(m ? m[1] : base);
		// Content words that name the same thing on each side.
		const CONTENT_SYNONYMS: Record<string, string> = { helper: "fieldnote", helpertext: "fieldnote", hint: "fieldnote", description: "fieldnote", caption: "fieldnote" };
		const subject = CONTENT_SYNONYMS[rawSubject] ?? rawSubject;
		// "Show Text" / "Show Label" toggles map to hideText / hideLabel flags first.
		if (m) {
			const toggle = findBooleanFor(code, [`hide${subject}`, `show${subject}`, `has${subject}`]);
			if (toggle) {
				usedProps.add(toggle.name);
				continue;
			}
		}
		if (/^(text|label|content|value)$/.test(subject) && (slotNames.has("") || code.props.some((x) => ["label", "value", "text"].includes(norm(x.name))))) continue;
		if (slotNames.has(subject) || [...slotNames].some((s) => s && (s.includes(subject) || subject.includes(s)))) continue;
		const flag = findBooleanFor(code, [subject, `hide${subject}`, `show${subject}`, `has${subject}`]);
		if (flag) {
			usedProps.add(flag.name);
			continue;
		}
		if (code.props.some((x) => norm(x.name).includes(subject) || (subject.length > 3 && subject.includes(norm(x.name))))) continue;
		figmaOnlyProperties.push(base);
	}

	const codeOnlyProps = code.props
		.filter((p) => !usedProps.has(p.name) && !NON_VISUAL_PROPS.has(norm(p.name)) && (p.kind === "enum" || p.kind === "boolean"))
		.map((p) => ({ name: p.name, type: p.typeText }));

	// Recorded pairings onto STATE axes count as mapped.
	for (const [prop] of Object.entries(decisions.pairWith ?? {})) usedProps.add(prop);
	const codeOnlyFinal = codeOnlyProps.filter((p) => !usedProps.has(p.name));
	const driftFinal =
		axes.some((a) => a.mappedBy === "none" || a.figmaOnlyValues.length || a.codeOnlyValues.length) ||
		codeOnlyFinal.length > 0 ||
		figmaOnlyProperties.length > 0;
	return {
		component: figma.name,
		codeTag: code.tagName,
		status: driftFinal ? "drift" : "in-sync",
		axes,
		codeOnlyProps: codeOnlyFinal,
		figmaOnlyProperties,
		...(omitted.size ? { omittedByDecision: [...omitted] } : {}),
	};
}

/**
 * Decisions from contract files: `{ name: "al-button", props: [{ name, bindings: { figma: { omit, pairWith } } }] }`
 * (the Altitude contract format). Keyed like indexCem (normalized tag, with and without prefix).
 */
export function decisionsFromContracts(contracts: any[]): Map<string, ComponentDecisions> {
	const out = new Map<string, ComponentDecisions>();
	for (const c of contracts) {
		const tag: string | undefined = c?.name ?? c?.id;
		if (!tag) continue;
		const d: ComponentDecisions = { omit: [], pairWith: {} };
		for (const p of c.props ?? []) {
			const f = p?.bindings?.figma;
			if (!f || !p.name) continue;
			if (f.omit === true || p.figmaOmit === true || p.omit === true) d.omit!.push(p.name);
			if (typeof f.pairWith === "string") d.pairWith![p.name] = f.pairWith;
		}
		out.set(norm(tag), d);
		out.set(norm(tag.replace(/^[a-z]+-/, "")), d);
	}
	return out;
}
