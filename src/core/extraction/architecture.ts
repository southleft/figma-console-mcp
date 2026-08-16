/**
 * Design-system architecture classification: the difference between a UI kit
 * and a design system.
 *
 * A vibe-coded app ships FollowButton, ModerationMenu, NodeCard — components
 * named after USAGE. A general-purpose design system ships Button, Menu,
 * Card — the usage lives in recipes/patterns built on those primitives. This
 * module deterministically classifies each inventoried component:
 *
 *  - level: atom / molecule / organism / template (atomic-design vernacular;
 *    heuristic, reviewed with the user by the skill)
 *  - specializationOf: the canonical generic component a domain-named
 *    component is really an instance of (FollowButton → Button)
 *  - missingPrimitives: canonical components that specializations imply but
 *    that don't exist generically in the codebase — the DS build list
 *
 * The canonical vocabulary follows the shared component taxonomy documented
 * across public design systems (designsystems.surf component index et al.,
 * via the design-systems-assistant knowledge base). The judgment calls —
 * which specializations to collapse, what the org calls each layer — belong
 * to the skill's generalization pass, not this module.
 */

import type { DsComponentEntry } from "./types.js";

/** Canonical generic component nouns → atomic level. */
const CANONICAL: Record<string, "atom" | "molecule" | "organism"> = {
  // Atoms — single-purpose leaves.
  button: "atom",
  icon: "atom",
  avatar: "atom",
  badge: "atom",
  chip: "atom",
  tag: "atom",
  pill: "atom",
  link: "atom",
  input: "atom",
  textarea: "atom",
  select: "atom",
  checkbox: "atom",
  radio: "atom",
  switch: "atom",
  toggle: "atom",
  slider: "atom",
  spinner: "atom",
  skeleton: "atom",
  divider: "atom",
  rule: "atom",
  label: "atom",
  tooltip: "atom",
  image: "atom",
  logo: "atom",
  // Molecules — small compositions of atoms.
  card: "molecule",
  menu: "molecule",
  dropdown: "molecule",
  combobox: "molecule",
  breadcrumb: "molecule",
  breadcrumbs: "molecule",
  tabs: "molecule",
  accordion: "molecule",
  field: "molecule",
  form: "molecule",
  search: "molecule",
  pagination: "molecule",
  stepper: "molecule",
  toast: "molecule",
  snackbar: "molecule",
  alert: "molecule",
  banner: "molecule",
  dialog: "molecule",
  modal: "molecule",
  popover: "molecule",
  row: "molecule",
  listitem: "molecule",
  bar: "molecule",
  toolbar: "molecule",
  actionbar: "molecule",
  composer: "molecule",
  editor: "molecule",
  // Organisms — larger assemblies.
  nav: "organism",
  navbar: "organism",
  sidebar: "organism",
  rail: "organism",
  header: "organism",
  footer: "organism",
  hero: "organism",
  table: "organism",
  list: "organism",
  drawer: "organism",
  gallery: "organism",
  carousel: "organism",
  slideshow: "organism",
  feed: "organism",
  wall: "organism",
  canvas: "organism",
  room: "organism",
  terminal: "organism",
  marquee: "organism",
  lightbox: "organism",
  frame: "organism",
  section: "organism",
  band: "organism",
  prose: "organism",
};

/** Split a PascalCase / camelCase name into lowercase words. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
}

export interface DsSpecialization {
  component: string;
  /** Canonical generic the component is really an instance of. */
  genericOf: string;
  /** Why: the domain qualifier(s) that make it product-specific. */
  qualifier: string;
  suggestion: string;
}

export interface DsArchitecture {
  /** component name → atomic-design level (heuristic). */
  levels: Record<string, "atom" | "molecule" | "organism" | "template" | "unclassified">;
  /** Domain-named instances of canonical generics (the UI-kit smell). */
  specializations: DsSpecialization[];
  /**
   * Canonical generics implied by specializations but absent as standalone
   * components — the build list that turns this kit into a system.
   */
  missingPrimitives: string[];
  /** Counts per level for the summary. */
  summary: Record<string, number>;
}

export function classifyArchitecture(
  components: DsComponentEntry[],
): DsArchitecture {
  const portable = components.filter(
    (c) => c.classification !== "pure-vendor",
  );
  const names = new Set(portable.map((c) => c.name.toLowerCase()));
  const levels: DsArchitecture["levels"] = {};
  const specializations: DsSpecialization[] = [];
  const impliedGenerics = new Set<string>();

  for (const c of portable) {
    const w = words(c.name);
    // Try the longest canonical suffix: "ActionBar" → actionbar; "FollowButton" → button.
    let matched: string | null = null;
    let qualifierWords: string[] = [];
    for (let take = Math.min(2, w.length); take >= 1; take--) {
      const suffix = w.slice(-take).join("");
      if (CANONICAL[suffix]) {
        matched = suffix;
        qualifierWords = w.slice(0, w.length - take);
        break;
      }
    }

    if (matched) {
      levels[c.name] = CANONICAL[matched];
      if (qualifierWords.length > 0) {
        const genericName =
          matched.charAt(0).toUpperCase() + matched.slice(1);
        specializations.push({
          component: c.name,
          genericOf: genericName,
          qualifier: qualifierWords.join(" "),
          suggestion: `"${c.name}" is a ${qualifierWords.join(" ")} USAGE of a generic ${genericName} — in a general-purpose system it becomes a ${genericName} variant/recipe, not a component of its own.`,
        });
        impliedGenerics.add(genericName);
      }
    } else {
      // No canonical noun: judge by size — many props or a page-ish name
      // reads template/organism; otherwise leave honest.
      levels[c.name] = /page|layout|template|shell|view|screen/i.test(c.name)
        ? "template"
        : "unclassified";
    }
  }

  const missingPrimitives = [...impliedGenerics]
    .filter((g) => !names.has(g.toLowerCase()))
    .sort();

  const summary: Record<string, number> = {};
  for (const level of Object.values(levels))
    summary[level] = (summary[level] ?? 0) + 1;

  return { levels, specializations, missingPrimitives, summary };
}
