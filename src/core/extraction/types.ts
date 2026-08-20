/**
 * Types for the Design System Extraction feature (figma_ds_* tools).
 *
 * Extraction turns a "vibe-coded" production app — no design system, but lots
 * of de-facto styling decisions — into (a) a component inventory, (b) a DTCG
 * TokenDocument, and (c) a scaffolded design-system/ package with Storybook.
 *
 * Everything here is Local Mode only: analysis walks the user's filesystem.
 * Manifests are persisted under `<outDir>/.extraction/` because full analyses
 * exceed MCP response budgets — tools return summaries plus manifest paths,
 * and the agent reads slices of the manifest as needed.
 */

/** Frameworks we detect and scaffold for. */
export type DsFramework =
  | "react"
  | "next"
  | "astro"
  | "angular"
  | "web-components"
  | "vue"
  | "svelte"
  | "unknown";

/** Styling methods we detect and can emit token files for. */
export type DsStylingMethod =
  | "tailwind-v4"
  | "tailwind-v3"
  | "css-modules"
  | "scss"
  | "vanilla-css"
  | "emotion"
  | "styled-components"
  | "inline-styles";

/**
 * How a component relates to vendor code — drives what "porting" means:
 * - vendored: copied-in source the team already owns (shadcn/ui pattern).
 *   Port the file itself.
 * - wrapped: a local component that wraps a vendor component (MUI Button with
 *   house defaults). Port the wrapper; keep the vendor package as a peer dep.
 * - pure-vendor: vendor component used directly in app code with no local
 *   definition. Not portable source — represented via tokens/theme and usage
 *   documentation only.
 * - bespoke: hand-rolled local component. Port fully.
 */
export type DsClassification =
  | "vendored"
  | "wrapped"
  | "pure-vendor"
  | "bespoke";

export interface DsPropEntry {
  name: string;
  /** Raw type text as written in the source (best-effort, regex-extracted). */
  type?: string;
  required: boolean;
  defaultValue?: string;
}

export interface DsComponentEntry {
  /** Component display name (export name / selector / custom-element tag). */
  name: string;
  /** Path relative to the target root. Absent for pure-vendor entries. */
  file?: string;
  /** Which target root this entry came from (index into DsAnalysis.targets). */
  targetIndex: number;
  framework: DsFramework;
  classification: DsClassification;
  /** For wrapped/pure-vendor: the vendor module specifier (e.g. "@mui/material"). */
  vendorModule?: string;
  exportKind?: "default" | "named";
  props: DsPropEntry[];
  usage: {
    /** import statements referencing the component across scanned files. */
    importCount: number;
    /** JSX/template tag occurrences across scanned files. */
    tagCount: number;
    /** Sample of using files (relative paths, capped). */
    files: string[];
  };
  /**
   * Distinct literal prop values observed at call sites, per prop — the raw
   * material for variant inference (e.g. variant → ["primary","ghost"]).
   * Values capped per prop.
   */
  observedProps?: Record<string, string[]>;
  /**
   * Components elsewhere in the inventory with the same name — the classic
   * vibe-code smell of three independent Button.tsx files. Relative paths.
   */
  duplicates?: string[];
}

export interface DsStyleSource {
  /** Relative path from the target root. */
  file: string;
  kind:
    | "css"
    | "scss"
    | "css-module"
    | "tailwind-config"
    | "theme-object"
    | "package-json";
  /** Why this file matters (e.g. "defines 42 custom properties in :root"). */
  note?: string;
}

/** An iconography asset found in the codebase. */
export interface DsIconEntry {
  /** Display name (file basename or component name). */
  name: string;
  /** Path relative to the target root. */
  file: string;
  source: "svg-file" | "inline-svg";
}

/**
 * A typographic rule mined from stylesheets — heading hierarchy, display/lead
 * classes, prose styles. Drives the Typography showcase.
 */
export interface DsTypographyRule {
  selector: string;
  /** Only the type-relevant declarations (font-*, line-height, etc.). */
  properties: Record<string, string>;
  /** "relative/path.css:line" */
  source: string;
}

export interface DsTargetAnalysis {
  /** Absolute path of the scanned app root. */
  root: string;
  packageName?: string;
  frameworks: DsFramework[];
  stylingMethods: DsStylingMethod[];
  /**
   * Vendor component layers detected from dependencies + file evidence.
   * kind "vendored" means the library's pattern puts source in the app
   * (shadcn); "package" means it is consumed from node_modules.
   */
  componentLibraries: Array<{
    name: string;
    kind: "vendored" | "package";
    evidence: string[];
  }>;
  styleSources: DsStyleSource[];
  /** Iconography: standalone .svg files + components with inline <svg>. */
  icons: DsIconEntry[];
  /** Heading hierarchy / type classes mined from stylesheets. */
  typography: DsTypographyRule[];
  stats: {
    filesScanned: number;
    filesSkipped: number;
    durationMs: number;
  };
}

/** Persisted as `<outDir>/.extraction/analysis.json`. */
export interface DsAnalysis {
  version: 1;
  generatedAt: string;
  /** Absolute output dir the design-system package will be generated into. */
  outDir: string;
  targets: DsTargetAnalysis[];
  components: DsComponentEntry[];
  /**
   * Atomic-design classification + generalization plan (see architecture.ts):
   * what separates this from a UI kit. Reviewed with the user by the skill.
   */
  architecture?: import("./architecture.js").DsArchitecture;
  /**
   * Component names defined in more than one place (within or across targets)
   * — consolidation candidates the skill reviews with the user.
   */
  duplicateGroups: Array<{ name: string; files: string[] }>;
}

/** Provenance stamped into each extracted token's $extensions. */
export interface DsTokenProvenance {
  /** "declared" = mined from explicit config/vars; "inferred" = frequency-promoted raw value. */
  confidence: "declared" | "inferred";
  /** Source locations, "relative/path.css:12" form. Capped. */
  sources: string[];
  /** Occurrence count for inferred (frequency-promoted) values. */
  frequency?: number;
  /** Note for the semantic-naming pass (e.g. "shadcn HSL triple", "tailwind theme.extend"). */
  note?: string;
}

/** $extensions key carrying DsTokenProvenance on extracted tokens. */
export const DS_EXTRACTION_EXTENSION_KEY = "figma-console-mcp.extraction" as const;

/** Persisted as `<outDir>/.extraction/tokens-report.json`. */
export interface DsTokensReport {
  version: 1;
  generatedAt: string;
  counts: Record<string, number>;
  warnings: string[];
  /** Raw values seen often but NOT promoted (below threshold) — for review. */
  belowThreshold: Array<{ value: string; type: string; frequency: number }>;
  filesWritten: string[];
}

export type DsPortStatus = "pending" | "in-progress" | "ported" | "skipped";

/** Persisted as `<outDir>/.extraction/status.json`. */
export interface DsStatusManifest {
  version: 1;
  updatedAt: string;
  components: Record<
    string,
    {
      status: DsPortStatus;
      notes?: string;
      storyFile?: string;
      updatedAt: string;
    }
  >;
}
