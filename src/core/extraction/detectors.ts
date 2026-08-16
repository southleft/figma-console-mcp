/**
 * Framework / styling-method / component-library detection for a target app.
 *
 * Detection is evidence-based: package.json dependencies first (declared
 * intent), then file evidence (what the code actually does). Both are cheap —
 * no AST, no execution of user code.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  DsFramework,
  DsStylingMethod,
  DsTargetAnalysis,
} from "./types.js";
import type { WalkedFile } from "./walker.js";
import { readTextFile } from "./walker.js";

export interface PackageInfo {
  name?: string;
  deps: Record<string, string>;
}

export function readPackageInfo(root: string): PackageInfo {
  const raw = readTextFile(join(root, "package.json"));
  if (!raw) return { deps: {} };
  try {
    const pkg = JSON.parse(raw);
    return {
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      deps: {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
        ...(pkg.peerDependencies ?? {}),
      },
    };
  } catch {
    return { deps: {} };
  }
}

export function detectFrameworks(
  pkg: PackageInfo,
  files: WalkedFile[],
): DsFramework[] {
  const found = new Set<DsFramework>();
  const has = (dep: string) => dep in pkg.deps;

  if (has("astro")) found.add("astro");
  if (has("next")) found.add("next");
  if (has("react") || has("react-dom")) found.add("react");
  if (has("@angular/core")) found.add("angular");
  if (has("lit") || has("lit-element") || has("@stencil/core"))
    found.add("web-components");
  if (has("vue") || has("nuxt")) found.add("vue");
  if (has("svelte")) found.add("svelte");

  // File evidence fallback for apps with mangled/absent package.json.
  if (found.size === 0) {
    if (files.some((f) => f.ext === ".astro")) found.add("astro");
    if (files.some((f) => f.ext === ".tsx" || f.ext === ".jsx"))
      found.add("react");
    if (files.some((f) => f.relPath.endsWith(".component.ts")))
      found.add("angular");
    if (files.some((f) => f.ext === ".vue")) found.add("vue");
    if (files.some((f) => f.ext === ".svelte")) found.add("svelte");
  }

  return found.size > 0 ? [...found] : ["unknown"];
}

export function detectStylingMethods(
  root: string,
  pkg: PackageInfo,
  files: WalkedFile[],
  readFile: (f: WalkedFile) => string | null,
): DsStylingMethod[] {
  const found = new Set<DsStylingMethod>();
  const has = (dep: string) => dep in pkg.deps;

  if (has("tailwindcss")) {
    const version = pkg.deps["tailwindcss"] ?? "";
    // v4 has no required config file and uses @import "tailwindcss" / @theme.
    const v4ByVersion = /^[\^~]?4\./.test(version);
    const v4ByCss = files.some((f) => {
      if (f.ext !== ".css") return false;
      const text = readFile(f);
      return (
        !!text &&
        (text.includes('@import "tailwindcss"') ||
          text.includes("@import 'tailwindcss'") ||
          /@theme\b/.test(text))
      );
    });
    found.add(v4ByVersion || v4ByCss ? "tailwind-v4" : "tailwind-v3");
  }

  if (files.some((f) => /\.module\.(css|scss|sass)$/.test(f.relPath)))
    found.add("css-modules");
  if (files.some((f) => f.ext === ".scss" || f.ext === ".sass") || has("sass"))
    found.add("scss");
  if (has("@emotion/react") || has("@emotion/styled")) found.add("emotion");
  if (has("styled-components")) found.add("styled-components");
  if (
    files.some((f) => f.ext === ".css" && !/\.module\.css$/.test(f.relPath))
  )
    found.add("vanilla-css");

  return [...found];
}

/** Vendor component layers we recognize, dep name → display name. */
const COMPONENT_LIBRARY_DEPS: Record<string, string> = {
  "@mui/material": "Material UI (MUI)",
  "@mui/joy": "MUI Joy",
  "@material/web": "Material Web Components",
  "@angular/material": "Angular Material",
  "@chakra-ui/react": "Chakra UI",
  antd: "Ant Design",
  "@mantine/core": "Mantine",
  "react-bootstrap": "React Bootstrap",
  bootstrap: "Bootstrap",
  "@headlessui/react": "Headless UI",
  "@ariakit/react": "Ariakit",
  "react-aria-components": "React Aria Components",
  "@shoelace-style/shoelace": "Shoelace",
  "@spectrum-web-components/base": "Spectrum Web Components",
  daisyui: "daisyUI",
};

export function detectComponentLibraries(
  root: string,
  pkg: PackageInfo,
): DsTargetAnalysis["componentLibraries"] {
  const libs: DsTargetAnalysis["componentLibraries"] = [];
  const has = (dep: string) => dep in pkg.deps;

  // shadcn/ui: vendored source. components.json is its config marker; the
  // conventional source location is components/ui (possibly under src/).
  const shadcnConfig = ["components.json", "src/components.json"].find((p) =>
    existsSync(join(root, p)),
  );
  const shadcnDir = [
    "components/ui",
    "src/components/ui",
    "app/components/ui",
  ].find((p) => existsSync(join(root, p)));
  if (shadcnConfig || shadcnDir) {
    libs.push({
      name: "shadcn/ui",
      kind: "vendored",
      evidence: [shadcnConfig, shadcnDir].filter((x): x is string => !!x),
    });
  }

  const radixPkgs = Object.keys(pkg.deps).filter((d) =>
    d.startsWith("@radix-ui/"),
  );
  if (radixPkgs.length > 0) {
    libs.push({
      name: "Radix UI",
      kind: "package",
      evidence: radixPkgs.slice(0, 8),
    });
  }

  for (const [dep, name] of Object.entries(COMPONENT_LIBRARY_DEPS)) {
    if (has(dep)) libs.push({ name, kind: "package", evidence: [dep] });
  }

  if (has("class-variance-authority")) {
    libs.push({
      name: "CVA (class-variance-authority)",
      kind: "package",
      evidence: ["class-variance-authority"],
    });
  }

  return libs;
}
