/**
 * Static prop extraction for React component libraries, so property-level
 * parity works without a Custom Elements Manifest. Two common patterns:
 *
 *  - class-variance-authority (`cva`) variant maps, a common library-agnostic pattern:
 *      cva("…", { variants: { variant: { default: "…", outline: "…" }, size: { sm: "…" } } })
 *  - TypeScript props with literal unions and booleans:
 *      type Variant = 'primary' | 'secondary';
 *      type ButtonProps = { variant?: Variant; isLoading?: boolean; … }
 *
 * Deliberately line-free and forgiving: it reads what it can recognise and
 * returns nothing for what it can't, rather than guessing. Output matches the
 * CodeComponent shape used by props-parity.ts.
 */
import type { CodeComponent, CodeProp } from "./props-parity.js";

/** Find the matching close brace for the `{` at `open`. Ignores braces inside strings. */
function matchBrace(src: string, open: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return i;
	}
	return -1;
}

/** Top-level keys of an object literal body (between its braces). */
function topLevelKeys(body: string): Array<{ key: string; valueStart: number }> {
	const out: Array<{ key: string; valueStart: number }> = [];
	let depth = 0;
	let quote: string | null = null;
	let atKey = true;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (depth === 0 && atKey) {
			const m = body.slice(i).match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*))\s*:/);
			if (m) {
				out.push({ key: m[1] ?? m[2] ?? m[3], valueStart: i + m[0].length });
				i += m[0].length - 1;
				atKey = false;
				continue;
			}
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "{" || ch === "[" || ch === "(") depth++;
		else if (ch === "}" || ch === "]" || ch === ")") depth--;
		else if (ch === "," && depth === 0) atKey = true;
	}
	return out;
}

/** cva(...) variant groups → enum props. */
export function cvaProps(src: string, skip: (index: number) => boolean = () => false): CodeProp[] {
	const props: CodeProp[] = [];
	for (const m of src.matchAll(/\bvariants\s*:\s*\{/g)) {
		if (skip(m.index ?? 0)) continue;
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = matchBrace(src, open);
		if (close < 0) continue;
		const body = src.slice(open + 1, close);
		for (const { key, valueStart } of topLevelKeys(body)) {
			const rest = body.slice(valueStart).trimStart();
			if (!rest.startsWith("{")) continue;
			const o = body.indexOf("{", valueStart);
			const c = matchBrace(body, o);
			if (c < 0) continue;
			const values = topLevelKeys(body.slice(o + 1, c)).map((k) => k.key);
			if (values.length === 0) continue;
			const bool = values.length <= 2 && values.every((v) => v === "true" || v === "false");
			props.push(
				bool
					? { name: key, kind: "boolean", typeText: "boolean" }
					: { name: key, kind: "enum", values, typeText: values.map((v) => `'${v}'`).join(" | ") },
			);
		}
	}
	return props;
}

function literalUnion(text: string): string[] | null {
	const parts = text.split("|").map((p) => p.trim()).filter(Boolean);
	if (parts.length === 0) return null;
	const vals: string[] = [];
	for (const p of parts) {
		const m = p.match(/^(['"])(.*)\1$/);
		if (!m) return null;
		vals.push(m[2]);
	}
	return vals;
}

/** TypeScript props: literal-union and boolean members of *Props types/interfaces. */
export function tsProps(src: string, skip: (index: number, typeName?: string) => boolean = () => false): CodeProp[] {
	const aliases = new Map<string, string[]>();
	for (const m of src.matchAll(/\btype\s+([A-Z][\w]*)\s*=\s*([^;=]+?);/g)) {
		const vals = literalUnion(m[2].replace(/\s+/g, " "));
		if (vals) aliases.set(m[1], vals);
	}
	const props: CodeProp[] = [];
	const seen = new Set<string>();
	// Named *Props types/interfaces, plus inline object types in a component's
	// parameter list (`}: React.ComponentProps<"div"> & { side?: "left" | "right" }`).
	const decl = /\b(?:interface\s+([A-Z]\w*Props)\b[^{]*|type\s+([A-Z]\w*Props)\s*=\s*(?:[^{;]*&\s*)?)\{|(?:>|\))\s*&\s*\{|\}\s*:\s*\{/g;
	for (const m of src.matchAll(decl)) {
		if (skip(m.index ?? 0, m[1] ?? m[2])) continue;
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = matchBrace(src, open);
		if (close < 0) continue;
		const body = src.slice(open + 1, close);
		for (const mm of body.matchAll(/(?:^|[;\n,])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([^;\n]+)/g)) {
			const name = mm[1];
			if (seen.has(name) || name.startsWith("on") || name === "children" || name === "className" || name === "style") continue;
			const type = mm[2].trim().replace(/[,;]$/, "");
			let prop: CodeProp | null = null;
			if (/^boolean$/.test(type)) prop = { name, kind: "boolean", typeText: "boolean" };
			else if (aliases.has(type)) prop = { name, kind: "enum", values: aliases.get(type)!, typeText: type };
			else {
				const vals = literalUnion(type);
				if (vals) prop = { name, kind: "enum", values: vals, typeText: type };
			}
			if (prop) {
				seen.add(name);
				props.push(prop);
			}
		}
	}
	return props;
}

/** All props a React component source declares (cva variants + typed props), de-duplicated. */
/**
 * Many libraries keep a component's parts in one file (Menu, MenuItem,
 * MenuSeparator…). With `componentName`, props that belong to a different
 * component declared in the same file are left out: its *Props type, the
 * inline type in its parameter list, and a cva map named after it.
 */
export function reactComponentFromSource(src: string, componentName?: string): CodeComponent {
	const byName = new Map<string, CodeProp>();
	let skipTs: (i: number, typeName?: string) => boolean = () => false;
	let skipCva: (i: number) => boolean = () => false;
	if (componentName) {
		const decls = [...src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:function\s+|const\s+|class\s+)([A-Z]\w*)/g)].map((m) => ({ name: m[1], at: m.index ?? 0 }));
		const names = new Set(decls.map((d) => d.name));
		if (names.has(componentName) && names.size > 1) {
			const owner = (i: number) => [...decls].reverse().find((d) => d.at <= i)?.name;
			skipTs = (i, typeName) => {
				if (typeName) {
					const base = typeName.replace(/(Own|Base)?Props$/, "");
					return names.has(base) && base !== componentName;
				}
				const o = owner(i);
				return !!o && o !== componentName;
			};
			skipCva = (i) => {
				// const menuItemVariants = cva(…) → MenuItem
				const head = src.slice(Math.max(0, i - 400), i);
				const v = [...head.matchAll(/const\s+([a-z]\w*?)Variants\s*=\s*cva\s*\(/g)].pop();
				if (!v) return false;
				const pascal = v[1][0].toUpperCase() + v[1].slice(1);
				return names.has(pascal) && pascal !== componentName;
			};
		}
	}
	for (const p of [...cvaProps(src, skipCva), ...tsProps(src, skipTs)]) if (!byName.has(p.name)) byName.set(p.name, p);
	// Extending a native element's or a primitive's props (ComponentProps<"button">,
	// ButtonHTMLAttributes, ComponentProps<typeof X.Root>) brings its states along.
	const inherits = /ComponentProps(?:WithoutRef|WithRef)?<\s*(?:["'`]\w+["'`]|typeof\s+[\w.]+)\s*>|\w*HTMLAttributes<|HTMLProps</.test(src);
	// Headless primitives (ComponentProps<typeof X.Root>) also commonly carry orientation.
	const primitive = /ComponentProps(?:WithoutRef|WithRef)?<\s*typeof\s+[\w.]+\s*>/.test(src);
	return {
		props: [...byName.values()],
		slots: [],
		...(inherits ? { inherited: ["disabled", "checked", "required", "readonly", "open", "selected", "invalid", ...(primitive ? ["orientation"] : [])] } : {}),
	};
}
