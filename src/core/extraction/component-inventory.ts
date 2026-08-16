/**
 * Component inventory: find the components a production app actually uses,
 * classify how they relate to vendor code, extract prop contracts, and count
 * real usage so porting can be ranked by what matters.
 *
 * Analysis is regex-based on purpose — it must survive whatever a vibe-coded
 * app throws at it (broken types, mixed idioms, generated files) where a
 * strict AST parse would bail. Accuracy is "inventory-grade": the agent doing
 * the porting reads the real source; this module just has to find it.
 *
 * Memory discipline: each file is read once. We keep only small per-file
 * indexes (tag counts, imports, attribute strings), never the file text.
 */

import type {
  DsClassification,
  DsComponentEntry,
  DsFramework,
  DsPropEntry,
} from "./types.js";
import type { WalkedFile } from "./walker.js";
import { readTextFile } from "./walker.js";

/** Vendor prefixes whose imports mark wrapped / pure-vendor usage. */
const VENDOR_PREFIXES = [
  "@mui/",
  "@material/",
  "@angular/material",
  "@chakra-ui/",
  "antd",
  "@mantine/",
  "@radix-ui/",
  "@headlessui/",
  "@ariakit/",
  "react-aria-components",
  "react-bootstrap",
  "@shoelace-style/",
  "@spectrum-web-components/",
];

const SOURCE_EXTS = new Set([
  ".tsx",
  ".jsx",
  ".ts",
  ".js",
  ".mjs",
  ".html",
  ".astro",
]);
const MAX_ATTR_SAMPLES_PER_TAG = 40;
const MAX_OBSERVED_VALUES = 20;
const MAX_USAGE_FILES = 12;

interface FileIndex {
  relPath: string;
  /** PascalCase JSX tag → open-tag count. */
  jsxTags: Map<string, number>;
  /** custom-element / Angular selector tag (has a dash) → count. */
  elementTags: Map<string, number>;
  /** imported name → module specifier. */
  imports: Map<string, string>;
  /** tag name → raw attribute strings sampled from open tags. */
  attrSamples: Map<string, string[]>;
}

interface Definition {
  name: string;
  relPath: string;
  framework: DsFramework;
  exportKind: "default" | "named";
  props: DsPropEntry[];
  vendorImports: string[];
  /** Angular selector or custom-element tag, when the component has one. */
  elementTag?: string;
}

/** Balanced-brace block starting at the first "{" at/after `from`. */
function braceBlock(text: string, from: number): string | null {
  const start = text.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length && i < start + 20000; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return null;
}

/** Parse `interface XProps { ... }` / `type XProps = { ... }` members. */
function parsePropsBlock(block: string): DsPropEntry[] {
  const props: DsPropEntry[] = [];
  // Member lines: `name?: type;` — multi-line object types contribute noise
  // lines that fail the match, which is fine for inventory purposes.
  const memberRe =
    /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*([^;\n]+)[;,]?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(block)) !== null && props.length < 60) {
    const type = m[3].trim();
    props.push({ name: m[1], required: !m[2], type });
  }
  return props;
}

/** Find props for component `name` in its definition file's text. */
function extractProps(text: string, name: string): DsPropEntry[] {
  const declRe = new RegExp(
    `(?:interface|type)\\s+${name}Props\\b[^{=]*[{=]`,
  );
  const m = declRe.exec(text);
  let props: DsPropEntry[] = [];
  if (m) {
    const block = braceBlock(text, m.index);
    if (block) props = parsePropsBlock(block);
  }
  // Merge in defaults from destructured params: ({ variant = "primary" }).
  const sigRe = new RegExp(
    `(?:function\\s+${name}|const\\s+${name}[^=]*=[^(]*)\\(\\s*\\{([^}]*)\\}`,
  );
  const sig = sigRe.exec(text);
  if (sig) {
    const defaultRe = /([A-Za-z_$][\w$]*)\s*=\s*("[^"]*"|'[^']*'|[\w.[\]]+)/g;
    let d: RegExpExecArray | null;
    while ((d = defaultRe.exec(sig[1])) !== null) {
      const existing = props.find((p) => p.name === d![1]);
      if (existing) existing.defaultValue = d[2];
      else props.push({ name: d[1], required: false, defaultValue: d[2] });
    }
  }
  return props;
}

function looksLikeJsxFile(text: string, ext: string): boolean {
  if (ext === ".tsx" || ext === ".jsx") return true;
  return /<[A-Z][\w.]*[\s/>]/.test(text);
}

/**
 * Framework routing entry files are pages, not portable components — the same
 * rule as Astro's src/pages exclusion, applied to Next's app/pages routers.
 */
function isRouteEntryFile(relPath: string): boolean {
  if (
    /(^|\/)(app|pages)\//.test(relPath) &&
    /(^|\/)(page|layout|error|loading|not-found|template|default|route|_app|_document|index)\.(tsx|jsx|ts|js)$/.test(
      relPath,
    )
  )
    return true;
  return false;
}

function extractReactDefinitions(
  text: string,
  relPath: string,
  ext: string,
): Definition[] {
  if (!looksLikeJsxFile(text, ext)) return [];
  if (isRouteEntryFile(relPath)) return [];
  const defs = new Map<string, Definition>();
  const add = (name: string, exportKind: "default" | "named") => {
    if (!/^[A-Z]/.test(name)) return;
    if (!defs.has(name)) {
      defs.set(name, {
        name,
        relPath,
        framework: "react",
        exportKind,
        props: extractProps(text, name),
        vendorImports: extractVendorImports(text),
      });
    }
  };

  let m: RegExpExecArray | null;
  const patterns: Array<[RegExp, "default" | "named"]> = [
    // `async` covers React Server Components (export async function X —
    // found live: an async RSC was invisible to the inventory).
    [/export\s+default\s+(?:async\s+)?function\s+([A-Z][\w$]*)/g, "default"],
    [/export\s+(?:async\s+)?function\s+([A-Z][\w$]*)\s*[(<]/g, "named"],
    [
      // export const X = (...) => / forwardRef(...) / memo(...)
      /export\s+const\s+([A-Z][\w$]*)(?:\s*:\s*[^=]+)?\s*=\s*(?:React\.)?(?:forwardRef|memo)?\s*[(<]/g,
      "named",
    ],
  ];
  for (const [re, kind] of patterns) {
    while ((m = re.exec(text)) !== null) add(m[1], kind);
  }
  // `export default X` referencing an earlier declaration.
  const dflt = /export\s+default\s+([A-Z][\w$]*)\s*;?/.exec(text);
  if (dflt && new RegExp(`(?:function|const|class)\\s+${dflt[1]}\\b`).test(text)) {
    add(dflt[1], "default");
  }
  // Deferred named exports — the shadcn house style:
  //   const Button = React.forwardRef(...); ... export { Button, buttonVariants }
  const exportListRe = /export\s*\{([^}]*)\}/g;
  while ((m = exportListRe.exec(text)) !== null) {
    for (const part of m[1].split(",")) {
      const name = part.split(" as ")[0]?.trim();
      if (
        name &&
        /^[A-Z][\w$]*$/.test(name) &&
        new RegExp(`(?:function|const|class)\\s+${name}\\b`).test(text)
      ) {
        add(name, "named");
      }
    }
  }
  return [...defs.values()];
}

function extractAngularDefinitions(text: string, relPath: string): Definition[] {
  if (!text.includes("@Component")) return [];
  const defs: Definition[] = [];
  const compRe = /@Component\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = compRe.exec(text)) !== null) {
    const meta = braceBlock(text, m.index) ?? "";
    const selector = /selector\s*:\s*['"]([^'"]+)['"]/.exec(meta)?.[1];
    const cls = /export\s+class\s+([\w$]+)/.exec(text.slice(m.index));
    if (!cls) continue;
    // Angular props = @Input() members.
    const props: DsPropEntry[] = [];
    const inputRe =
      /@Input\(\)\s+(?:readonly\s+)?([\w$]+)(\!|\?)?\s*(?::\s*([^;=\n]+))?/g;
    let im: RegExpExecArray | null;
    while ((im = inputRe.exec(text)) !== null && props.length < 60) {
      props.push({
        name: im[1],
        required: im[2] === "!",
        type: im[3]?.trim(),
      });
    }
    defs.push({
      name: cls[1],
      relPath,
      framework: "angular",
      exportKind: "named",
      props,
      vendorImports: extractVendorImports(text),
      elementTag: selector,
    });
  }
  return defs;
}

function extractWebComponentDefinitions(
  text: string,
  relPath: string,
): Definition[] {
  const defs: Definition[] = [];
  const defineRe =
    /customElements\.define\(\s*['"]([a-z][\w-]*)['"]\s*,\s*([\w$]+)/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = defineRe.exec(text)) !== null) {
    seen.add(m[2]);
    defs.push({
      name: m[2],
      relPath,
      framework: "web-components",
      exportKind: "named",
      props: extractLitProps(text),
      vendorImports: extractVendorImports(text),
      elementTag: m[1],
    });
  }
  // Lit @customElement decorator form.
  const decoRe =
    /@customElement\(\s*['"]([a-z][\w-]*)['"]\s*\)\s*(?:export\s+)?class\s+([\w$]+)/g;
  while ((m = decoRe.exec(text)) !== null) {
    if (seen.has(m[2])) continue;
    defs.push({
      name: m[2],
      relPath,
      framework: "web-components",
      exportKind: "named",
      props: extractLitProps(text),
      vendorImports: extractVendorImports(text),
      elementTag: m[1],
    });
  }
  return defs;
}

function extractLitProps(text: string): DsPropEntry[] {
  const props: DsPropEntry[] = [];
  const re = /@property\([^)]*\)\s+(?:accessor\s+)?([\w$]+)(\?)?\s*(?::\s*([^;=\n]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && props.length < 60) {
    props.push({ name: m[1], required: !m[2], type: m[3]?.trim() });
  }
  return props;
}

/**
 * An .astro file IS a component: name = PascalCase basename. Props come from
 * the frontmatter's `interface Props` / `const { ... } = Astro.props`.
 * Page routes (src/pages/**) are not portable components and are skipped.
 */
function extractAstroDefinition(text: string, relPath: string): Definition[] {
  if (/(^|\/)pages\//.test(relPath)) return [];
  const base = relPath.split("/").pop()!.replace(/\.astro$/, "");
  const name = base.replace(/[^\w$]/g, "");
  if (!/^[A-Z]/.test(name)) return [];

  let props: DsPropEntry[] = [];
  const propsDecl = /(?:interface|type)\s+Props\b[^{=]*[{=]/.exec(text);
  if (propsDecl) {
    const block = braceBlock(text, propsDecl.index);
    if (block) props = parsePropsBlock(block);
  }
  // Defaults from `const { kind = 'primary', href } = Astro.props`.
  const destructure = /const\s*\{([^}]*)\}\s*=\s*Astro\.props/.exec(text);
  if (destructure) {
    const defaultRe = /([A-Za-z_$][\w$]*)\s*=\s*("[^"]*"|'[^']*'|[\w.[\]]+)/g;
    let d: RegExpExecArray | null;
    while ((d = defaultRe.exec(destructure[1])) !== null) {
      const existing = props.find((p) => p.name === d![1]);
      if (existing) existing.defaultValue = d[2];
      else props.push({ name: d[1], required: false, defaultValue: d[2] });
    }
  }

  return [
    {
      name,
      relPath,
      framework: "astro",
      exportKind: "default",
      props,
      vendorImports: extractVendorImports(text),
    },
  ];
}

function extractVendorImports(text: string): string[] {
  const out = new Set<string>();
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1];
    if (VENDOR_PREFIXES.some((p) => spec === p || spec.startsWith(p)))
      out.add(spec);
  }
  return [...out];
}

function indexFile(text: string, relPath: string): FileIndex {
  const idx: FileIndex = {
    relPath,
    jsxTags: new Map(),
    elementTags: new Map(),
    imports: new Map(),
    attrSamples: new Map(),
  };

  const importRe =
    /import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(text)) !== null) {
    const spec = m[3];
    if (m[1]) idx.imports.set(m[1], spec);
    if (m[2]) {
      for (const part of m[2].split(",")) {
        const name = part.split(" as ").pop()?.trim();
        if (name) idx.imports.set(name, spec);
      }
    }
  }

  // Open tags. Attribute string is captured up to the closing ">" (bounded).
  const tagRe = /<([A-Za-z][\w.-]*)([^<>]{0,400}?)\/?>/g;
  while ((m = tagRe.exec(text)) !== null) {
    const tag = m[1];
    const isPascal = /^[A-Z]/.test(tag);
    const isElement = tag.includes("-");
    if (!isPascal && !isElement) continue;
    const map = isPascal ? idx.jsxTags : idx.elementTags;
    map.set(tag, (map.get(tag) ?? 0) + 1);
    const attrs = m[2].trim();
    if (attrs) {
      const samples = idx.attrSamples.get(tag) ?? [];
      if (samples.length < MAX_ATTR_SAMPLES_PER_TAG) {
        samples.push(attrs);
        idx.attrSamples.set(tag, samples);
      }
    }
  }
  return idx;
}

/** Parse observed literal prop values out of sampled attribute strings. */
function observedPropsFromSamples(samples: string[]): Record<string, string[]> {
  const observed = new Map<string, Set<string>>();
  const attrRe =
    /([A-Za-z_$][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(true|false|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')\s*\})/g;
  for (const sample of samples) {
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(sample)) !== null) {
      const value = (m[2] ?? m[3] ?? m[4] ?? "").replace(/^["']|["']$/g, "");
      const set = observed.get(m[1]) ?? new Set();
      if (set.size < MAX_OBSERVED_VALUES) set.add(value);
      observed.set(m[1], set);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [k, v] of observed) out[k] = [...v].sort();
  return out;
}

function classify(def: Definition): {
  classification: DsClassification;
  vendorModule?: string;
} {
  if (/(^|\/)components\/ui\//.test(def.relPath)) {
    return { classification: "vendored", vendorModule: "shadcn/ui" };
  }
  if (def.vendorImports.length > 0) {
    return { classification: "wrapped", vendorModule: def.vendorImports[0] };
  }
  return { classification: "bespoke" };
}

export interface InventoryResult {
  components: DsComponentEntry[];
  duplicateGroups: Array<{ name: string; files: string[] }>;
}

export function buildComponentInventory(
  files: WalkedFile[],
  targetIndex: number,
): InventoryResult {
  const definitions: Definition[] = [];
  const indexes: FileIndex[] = [];

  for (const file of files) {
    if (!SOURCE_EXTS.has(file.ext)) continue;
    const text = readTextFile(file.path);
    if (!text) continue;

    if (file.ext === ".astro") {
      definitions.push(...extractAstroDefinition(text, file.relPath));
    } else if (file.ext !== ".html") {
      definitions.push(
        ...extractReactDefinitions(text, file.relPath, file.ext),
        ...extractAngularDefinitions(text, file.relPath),
        ...extractWebComponentDefinitions(text, file.relPath),
      );
    }
    indexes.push(indexFile(text, file.relPath));
  }

  // ---- Join usage onto definitions -----------------------------------------
  const components: DsComponentEntry[] = [];
  const byName = new Map<string, Definition[]>();
  for (const def of definitions) {
    const list = byName.get(def.name) ?? [];
    list.push(def);
    byName.set(def.name, list);
  }

  for (const def of definitions) {
    const lookupTag = def.elementTag ?? def.name;
    const usingFiles: string[] = [];
    let tagCount = 0;
    let importCount = 0;
    const samples: string[] = [];

    for (const idx of indexes) {
      if (idx.relPath === def.relPath) continue;
      const count = def.elementTag
        ? (idx.elementTags.get(def.elementTag) ?? 0)
        : (idx.jsxTags.get(def.name) ?? 0);
      const imported = idx.imports.has(def.name);
      if (imported) importCount++;
      if (count > 0 || imported) {
        tagCount += count;
        if (usingFiles.length < MAX_USAGE_FILES) usingFiles.push(idx.relPath);
        const s = idx.attrSamples.get(lookupTag);
        if (s) samples.push(...s);
      }
    }

    const { classification, vendorModule } = classify(def);
    const dupFiles = (byName.get(def.name) ?? [])
      .filter((d) => d.relPath !== def.relPath)
      .map((d) => d.relPath);

    components.push({
      name: def.name,
      file: def.relPath,
      targetIndex,
      framework: def.framework,
      classification,
      vendorModule,
      exportKind: def.exportKind,
      props: def.props,
      usage: { importCount, tagCount, files: usingFiles },
      observedProps:
        samples.length > 0 ? observedPropsFromSamples(samples) : undefined,
      duplicates: dupFiles.length > 0 ? dupFiles : undefined,
    });
  }

  // ---- Pure-vendor usage (no local definition) -----------------------------
  const definedNames = new Set(definitions.map((d) => d.name));
  const vendorUsage = new Map<
    string,
    { module: string; tagCount: number; importCount: number; files: string[] }
  >();
  for (const idx of indexes) {
    for (const [name, spec] of idx.imports) {
      if (definedNames.has(name)) continue;
      if (!/^[A-Z]/.test(name)) continue;
      if (!VENDOR_PREFIXES.some((p) => spec === p || spec.startsWith(p)))
        continue;
      const tagCount = idx.jsxTags.get(name) ?? 0;
      const entry = vendorUsage.get(name) ?? {
        module: spec,
        tagCount: 0,
        importCount: 0,
        files: [],
      };
      entry.tagCount += tagCount;
      entry.importCount++;
      if (entry.files.length < MAX_USAGE_FILES) entry.files.push(idx.relPath);
      vendorUsage.set(name, entry);
    }
  }
  for (const [name, u] of vendorUsage) {
    components.push({
      name,
      targetIndex,
      framework: "react",
      classification: "pure-vendor",
      vendorModule: u.module,
      props: [],
      usage: { importCount: u.importCount, tagCount: u.tagCount, files: u.files },
    });
  }

  // ---- Duplicate groups ----------------------------------------------------
  const duplicateGroups = [...byName.entries()]
    .filter(([, defs]) => defs.length > 1)
    .map(([name, defs]) => ({ name, files: defs.map((d) => d.relPath) }));

  // Rank: most-used first — porting order should follow real usage.
  components.sort(
    (a, b) =>
      b.usage.tagCount + b.usage.importCount * 2 -
      (a.usage.tagCount + a.usage.importCount * 2),
  );

  return { components, duplicateGroups };
}
