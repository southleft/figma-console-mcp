/**
 * TypeScript types for Design-Code Parity Checker & Documentation Generator
 */

// ============================================================================
// Parity Checker Types
// ============================================================================

/** Code-side component specification provided by the AI after reading source code */
export interface CodeSpec {
	/** Path to the component source file */
	filePath?: string;

	/** Visual properties from code */
	visual?: {
		backgroundColor?: string;
		borderColor?: string;
		borderWidth?: number;
		borderRadius?: number | string;
		opacity?: number;
		fills?: Array<{ color?: string; opacity?: number }>;
		strokes?: Array<{ color?: string; width?: number }>;
		effects?: Array<{ type: string; color?: string; offset?: { x: number; y: number }; blur?: number }>;
	};

	/** Spacing and layout properties from code */
	spacing?: {
		paddingTop?: number;
		paddingRight?: number;
		paddingBottom?: number;
		paddingLeft?: number;
		gap?: number;
		width?: number | string;
		height?: number | string;
		minWidth?: number;
		minHeight?: number;
		maxWidth?: number;
		maxHeight?: number;
		layoutDirection?: "horizontal" | "vertical";
	};

	/** Typography properties from code */
	typography?: {
		fontFamily?: string;
		fontSize?: number;
		fontWeight?: number | string;
		lineHeight?: number | string;
		letterSpacing?: number;
		textAlign?: string;
		textDecoration?: string;
		textTransform?: string;
	};

	/** Design token usage in code */
	tokens?: {
		usedTokens?: string[];
		hardcodedValues?: Array<{ property: string; value: string | number }>;
		tokenPrefix?: string;
	};

	/** Component API (props/attributes) from code */
	componentAPI?: {
		props?: Array<{
			name: string;
			type: string;
			required?: boolean;
			defaultValue?: string | number | boolean;
			description?: string;
			values?: string[];
		}>;
		events?: string[];
		slots?: string[];
	};

	/** Accessibility properties from code */
	accessibility?: {
		role?: string;
		ariaLabel?: string;
		ariaRequired?: boolean;
		keyboardInteractions?: string[];
		contrastRatio?: number;
		focusVisible?: boolean;
	};

	/** Metadata from code */
	metadata?: {
		name?: string;
		description?: string;
		status?: string;
		version?: string;
		tags?: string[];
	};
}

/** Severity levels for parity discrepancies */
export type DiscrepancySeverity = "critical" | "major" | "minor" | "info";

/** Categories of parity comparison */
export type ParityCategory =
	| "visual"
	| "spacing"
	| "typography"
	| "tokens"
	| "componentAPI"
	| "accessibility"
	| "naming"
	| "metadata";

/** Individual property mismatch between design and code */
export interface ParityDiscrepancy {
	category: ParityCategory;
	property: string;
	severity: DiscrepancySeverity;
	designValue: string | number | boolean | null;
	codeValue: string | number | boolean | null;
	message: string;
	suggestion?: string;
}

/** Actionable fix for a discrepancy */
export interface ParityActionItem {
	discrepancyIndex: number;
	side: "design" | "code";
	/** For design-side fixes: which Figma MCP tool to call */
	figmaTool?: string;
	/** Ready-to-use parameters for the Figma tool call */
	figmaToolParams?: Record<string, string | number | boolean | null | object>;
	/** For code-side fixes */
	codeChange?: {
		filePath?: string;
		property: string;
		currentValue: string | number | boolean | null;
		targetValue: string | number | boolean | null;
		description: string;
	};
}

/** Full parity check result */
export interface ParityCheckResult {
	summary: {
		totalDiscrepancies: number;
		parityScore: number;
		byCritical: number;
		byMajor: number;
		byMinor: number;
		byInfo: number;
		categories: Partial<Record<ParityCategory, number>>;
	};
	discrepancies: ParityDiscrepancy[];
	actionItems: ParityActionItem[];
	ai_instruction: string;
	designData: Record<string, unknown>;
	codeData: CodeSpec;
}

// ============================================================================
// Documentation Generator Types
// ============================================================================

/** Code-side documentation info provided by the AI */
export interface CodeDocInfo {
	/** Component props/API */
	props?: Array<{
		name: string;
		type: string;
		required?: boolean;
		defaultValue?: string;
		description?: string;
	}>;
	/** Events emitted */
	events?: Array<{
		name: string;
		payload?: string;
		description?: string;
	}>;
	/** Named slots (for web components / Vue) */
	slots?: Array<{
		name: string;
		description?: string;
	}>;
	/** Import statement */
	importStatement?: string;
	/** Usage examples in code */
	usageExamples?: Array<{
		title: string;
		code: string;
		language?: string;
	}>;
	/** Changelog entries */
	changelog?: Array<{
		version: string;
		date: string;
		changes: string;
	}>;
	/** Component file path */
	filePath?: string;
	/** Package name */
	packageName?: string;
	/** CVA or variant definition code block */
	variantDefinition?: string;
	/** Sub-components that compose this component */
	subComponents?: Array<{
		name: string;
		description?: string;
		element?: string;
		dataSlot?: string;
		props?: Array<{
			name: string;
			type: string;
			required?: boolean;
			defaultValue?: string;
			description?: string;
		}>;
	}>;
	/** All source files related to this component */
	sourceFiles?: Array<{
		path: string;
		role: string;
		variants?: number;
		description?: string;
	}>;
	/** Base component this extends */
	baseComponent?: {
		name: string;
		url?: string;
		description?: string;
	};
}

/** Toggle which doc sections to include */
export interface DocSections {
	overview?: boolean;
	anatomy?: boolean;
	statesAndVariants?: boolean;
	visualSpecs?: boolean;
	typography?: boolean;
	contentGuidelines?: boolean;
	behavior?: boolean;
	implementation?: boolean;
	accessibility?: boolean;
	relatedComponents?: boolean;
	changelog?: boolean;
	parity?: boolean;
}

/** Full documentation generation result */
export interface DocGenerationResult {
	componentName: string;
	figmaNodeId: string;
	fileKey: string;
	timestamp: string;
	markdown: string;
	includedSections: string[];
	canonicalSource: "figma" | "code" | "reconciled";
	dataSourceSummary: {
		figmaEnriched: boolean;
		hasCodeInfo: boolean;
		variablesIncluded: boolean;
		stylesIncluded: boolean;
	};
	suggestedOutputPath: string;
	ai_instruction: string;
}

/** CompanyDocsMCP-compatible content entry */
export interface CompanyDocsContentEntry {
	title: string;
	content: string;
	category: string;
	tags: string[];
	metadata: {
		source: string;
		figmaUrl: string;
		systemName?: string;
		generatedAt: string;
	};
}
