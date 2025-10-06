/**
 * TypeScript types for enriched Figma data responses
 * Phase 5: Enriched Data Extraction & Design System Auditing
 */

// Export format options
export type ExportFormat = "css" | "sass" | "tailwind" | "typescript" | "json";

// Export formats for a single token/style
export interface ExportFormats {
	css?: string;
	sass?: string;
	tailwind?: string;
	typescript?: string;
	json?: object;
}

// Variable reference information
export interface VariableReference {
	id: string;
	name: string;
	collection: string;
	resolvedType: string;
}

// Component usage information
export interface ComponentUsage {
	id: string;
	name: string;
	type: string;
	variant?: string;
	page?: string;
}

// Style usage information
export interface StyleUsage {
	id: string;
	name: string;
	type: string;
	node_id: string;
}

// Variable dependency information
export interface VariableDependency {
	id: string;
	name: string;
	type: "alias" | "reference";
	depth: number;
}

// Hardcoded value detected in component
export interface HardcodedValue {
	property: string;
	value: string | number;
	type: "color" | "spacing" | "typography" | "other";
	location: string; // Node path
	suggested_token?: string;
}

// Audit issue
export interface AuditIssue {
	severity: "error" | "warning" | "info";
	type: string;
	message: string;
	node_id?: string;
	suggestion?: string;
}

// Enriched style response
export interface EnrichedStyle {
	// Existing fields from Figma API
	node_id: string;
	name: string;
	key: string;
	style_type: string;
	description?: string;

	// Enriched fields
	resolved_value?: string | object;
	variable_reference?: VariableReference;
	used_in_components?: ComponentUsage[];
	usage_count?: number;
	export_formats?: ExportFormats;
	last_modified?: string;
	created_by?: string;
}

// Enriched variable response
export interface EnrichedVariable {
	// Existing fields from Figma API
	id: string;
	name: string;
	key: string;
	variableCollectionId: string;
	resolvedType: string;

	// Enriched fields
	resolved_values?: Record<string, any>; // Per mode
	used_in_styles?: StyleUsage[];
	used_in_components?: ComponentUsage[];
	usage_count?: number;
	dependencies?: VariableDependency[];
	export_formats?: ExportFormats;
	aliases?: string[]; // Other variables that reference this one
}

// Enriched component response
export interface EnrichedComponent {
	// Existing fields from Figma API
	id: string;
	name: string;
	type: string;
	description?: string;

	// Enriched fields
	styles_used?: StyleReference[];
	variables_used?: VariableReference[];
	hardcoded_values?: HardcodedValue[];
	token_coverage?: number; // 0-100 percentage
	audit_issues?: AuditIssue[];
}

// Style reference in component
export interface StyleReference {
	style_id: string;
	style_name: string;
	style_type: string;
	property: string; // fills, strokes, text, etc.
	resolved_value?: string | object;
}

// File-level enriched data
export interface EnrichedFileData {
	// Existing fields
	fileKey: string;
	name: string;
	lastModified: string;
	version: string;

	// Enriched statistics
	statistics?: {
		total_variables: number;
		total_styles: number;
		total_components: number;
		unused_variables: number;
		unused_styles: number;
		average_token_coverage: number;
		total_hardcoded_values: number;
		audit_issues_count: number;
	};

	// Health score (0-100)
	health_score?: number;

	// Audit summary
	audit_summary?: {
		errors: number;
		warnings: number;
		info: number;
		top_issues: AuditIssue[];
	};
}

// Enrichment options
export interface EnrichmentOptions {
	// Enable enrichment (opt-in for backward compatibility)
	enrich?: boolean;

	// What to include in enrichment
	include_usage?: boolean;
	include_exports?: boolean;
	include_dependencies?: boolean;
	include_audit?: boolean;

	// Export format preferences
	export_formats?: ExportFormat[];

	// Performance options
	use_cache?: boolean;
	max_depth?: number; // For dependency resolution
}

// Token coverage analysis result
export interface TokenCoverageResult {
	node_id: string;
	node_name: string;
	node_type: string;
	coverage_percentage: number;
	total_properties: number;
	properties_using_tokens: number;
	properties_hardcoded: number;
	breakdown: {
		colors: { total: number; using_tokens: number };
		spacing: { total: number; using_tokens: number };
		typography: { total: number; using_tokens: number };
		effects: { total: number; using_tokens: number };
	};
	children_coverage?: TokenCoverageResult[];
}

// Design system audit result
export interface DesignSystemAuditResult {
	file_key: string;
	file_name: string;
	audit_timestamp: string;
	health_score: number;

	// Token issues
	unused_variables: VariableReference[];
	unused_styles: StyleUsage[];
	duplicate_values: Array<{
		value: string;
		tokens: string[];
	}>;
	inconsistent_naming: Array<{
		token: string;
		issue: string;
		suggestion: string;
	}>;

	// Component issues
	components_with_hardcoded_values: Array<{
		component: ComponentUsage;
		hardcoded_count: number;
		coverage_percentage: number;
	}>;

	// Dependency issues
	circular_references: Array<{
		chain: string[];
	}>;
	orphaned_variables: VariableReference[];
	broken_references: Array<{
		source: string;
		target: string;
		issue: string;
	}>;

	// Recommendations
	recommendations: Array<{
		priority: "high" | "medium" | "low";
		category: string;
		message: string;
		affected_count: number;
	}>;
}

// Export tokens result
export interface ExportTokensResult {
	format: ExportFormat;
	output: string;
	metadata: {
		total_tokens: number;
		export_timestamp: string;
		file_name: string;
		includes_usage_comments: boolean;
	};
}

// Cache entry for enrichment data
export interface EnrichmentCache {
	resolved_values: Map<string, any>;
	relationships: Map<string, ComponentUsage[]>;
	dependencies: Map<string, VariableDependency[]>;
	last_updated: number;
	file_version: string;
}
