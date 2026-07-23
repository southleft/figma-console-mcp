/**
 * Design System Audit — Remediation Capability Map
 *
 * For every audit finding, declares whether the Figma Console MCP can fix it,
 * on which side (design file vs. code), which tools do the work, and how.
 * Consumed by both the dashboard app and the plain report tool so audits
 * always end with an actionable "here is how this gets fixed" section.
 */

/** How fixable a finding is by this MCP. */
export type Fixability =
	| "design" // fully automatable against the Figma file with MCP write tools
	| "design-assisted" // automatable, but requires a design decision first
	| "code" // fixable in the consuming codebase (via export/sync tooling)
	| "manual"; // requires human design work; MCP can only scaffold/report

export interface Remediation {
	fixability: Fixability;
	/** MCP tools that perform the fix. */
	tools: string[];
	/** One-line description of the fix approach. */
	how: string;
}

const REMEDIATIONS: Record<string, Remediation> = {
	// --- Naming & Semantics ---
	"naming-variable-semantic": {
		fixability: "design",
		tools: ["figma_rename_variable", "figma_batch_update_variables"],
		how: "Rename visual color names (blue/500) to semantic ones (action/primary); renames propagate to all bound nodes.",
	},
	"naming-component-casing": {
		fixability: "design",
		tools: ["figma_rename_node", "figma_execute"],
		how: "Bulk-rename standalone components and component sets to consistent casing; instances keep working (name-based references in code should be re-synced).",
	},
	"naming-variant-semantic": {
		fixability: "design",
		tools: ["figma_execute"],
		how: "Rename variant values (e.g. color=red → variant=danger) across each component set; instance properties update automatically.",
	},
	"naming-boolean-prefix": {
		fixability: "design",
		tools: ["figma_rename_variable"],
		how: "Prefix boolean variables with is/has/can (e.g. reduced-motion → is-reduced-motion).",
	},
	// --- Token Architecture ---
	"token-collection-org": {
		fixability: "design",
		tools: ["figma_create_variable_collection", "figma_batch_create_variables"],
		how: "Split or create collections to separate primitive and semantic tiers.",
	},
	"token-mode-coverage": {
		fixability: "design",
		tools: ["figma_add_mode", "figma_batch_update_variables"],
		how: "Add missing modes (e.g. Dark) to semantic collections and fill per-mode values.",
	},
	"token-alias-usage": {
		fixability: "design-assisted",
		tools: ["figma_batch_update_variables", "figma_execute"],
		how: "Convert duplicate/derived raw values into aliases of their primitives (value-identical, zero visual change); which tokens form tiers is a design decision.",
	},
	"token-tier-depth": {
		fixability: "design-assisted",
		tools: ["figma_create_variable_collection", "figma_batch_create_variables"],
		how: "Introduce a semantic tier that aliases primitives; requires naming/architecture decisions.",
	},
	"token-type-distribution": {
		fixability: "design",
		tools: ["figma_create_variable"],
		how: "Add missing token types (FLOAT/STRING/BOOLEAN) for spacing, typography, or feature flags.",
	},
	"token-description-coverage": {
		fixability: "design",
		tools: ["figma_update_variable", "figma_execute"],
		how: "Bulk-generate descriptions from token name/value patterns, then hand-tune the exceptions.",
	},
	// --- Component Metadata ---
	"component-desc-presence": {
		fixability: "design",
		tools: ["figma_set_description", "figma_generate_component_doc"],
		how: "Generate descriptions from component name, props, and variants for every undocumented component.",
	},
	"component-desc-quality": {
		fixability: "design",
		tools: ["figma_set_description"],
		how: "Expand thin descriptions with purpose/behavior/usage sections.",
	},
	"component-property-completeness": {
		fixability: "design-assisted",
		tools: ["figma_add_component_property", "figma_execute"],
		how: "Add real properties (booleans bound to layer visibility, instance swaps, variants) — which props are meaningful is a design decision.",
	},
	"component-variant-structure": {
		fixability: "design-assisted",
		tools: ["figma_execute"],
		how: "Combine related standalone components into variant sets via combineAsVariants (originals become variants; instances survive).",
	},
	"component-category-org": {
		fixability: "design",
		tools: ["figma_rename_node", "figma_execute"],
		how: 'Prefix component names with category paths ("Forms/Input") — coordinate with code-side references before renaming.',
	},
	"component-generic-naming": {
		fixability: "design",
		tools: ["figma_rename_node", "figma_execute"],
		how: "Bulk-rename default layer names (Frame 123, Rectangle 4) from content/context.",
	},
	// --- Accessibility ---
	"a11y-color-contrast": {
		fixability: "design-assisted",
		tools: ["figma_update_variable", "figma_batch_update_variables"],
		how: "Adjust failing token values toward AA (report lists exact pairs and ratios); the new hues are a design decision.",
	},
	"a11y-state-variants": {
		fixability: "design-assisted",
		tools: ["figma_execute", "figma_set_instance_properties"],
		how: "Clone default variants into missing states, restyled with the system's own hover/focus/disabled conventions.",
	},
	"a11y-semantic-colors": {
		fixability: "design",
		tools: ["figma_create_variable", "figma_batch_create_variables"],
		how: "Add missing semantic families as aliases of existing scales (e.g. error/* aliasing danger/*).",
	},
	// --- Consistency ---
	"consistency-delimiter": {
		fixability: "design",
		tools: ["figma_rename_variable", "figma_execute"],
		how: "Normalize name delimiters ( / vs . vs - ) across variables and components.",
	},
	"consistency-casing": {
		fixability: "design",
		tools: ["figma_rename_node", "figma_rename_variable", "figma_execute"],
		how: "Bulk-normalize casing of component and token name segments.",
	},
	"consistency-size-values": {
		fixability: "design-assisted",
		tools: ["figma_batch_update_variables"],
		how: "Snap off-scale size values to the scale, or add the missing step; changing values shifts bound layouts, so review the diff.",
	},
	"consistency-mode-naming": {
		fixability: "design",
		tools: ["figma_rename_mode"],
		how: "Align mode names across collections (e.g. default → Default).",
	},
	// --- Coverage ---
	"coverage-token-types": {
		fixability: "design",
		tools: ["figma_create_variable"],
		how: "Add the missing variable types with genuinely useful tokens (never filler).",
	},
	"coverage-core-components": {
		fixability: "manual",
		tools: ["figma_execute", "figma_instantiate_component"],
		how: "Missing core components (input, navigation, …) need real design work; the MCP can scaffold structure but not design intent.",
	},
	"coverage-variable-count": {
		fixability: "design-assisted",
		tools: ["figma_batch_create_variables", "figma_import_tokens"],
		how: "Grow (or prune) the token set; what belongs in the system is a design decision.",
	},
	"coverage-collection-completeness": {
		fixability: "design",
		tools: ["figma_create_variable_collection", "figma_batch_create_variables"],
		how: "Add the missing collection kinds (color/spacing/typography groupings).",
	},
};

/** Look up remediation info for a finding id. */
export function getRemediation(findingId: string): Remediation | undefined {
	return REMEDIATIONS[findingId];
}

/** Human-readable one-liner for a finding's fixability. */
export function describeFixability(f: Fixability): string {
	switch (f) {
		case "design":
			return "auto-fixable in Figma by this MCP";
		case "design-assisted":
			return "fixable in Figma by this MCP after a design decision";
		case "code":
			return "fixable on the code side (export/sync via this MCP)";
		case "manual":
			return "needs human design work (MCP can scaffold)";
	}
}
