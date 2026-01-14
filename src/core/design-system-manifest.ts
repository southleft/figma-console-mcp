/**
 * Design System Manifest Types
 *
 * A structured representation of a Figma design system that enables
 * high-fidelity AI-assisted design generation.
 */

// ============================================================================
// TOKEN TYPES
// ============================================================================

export interface ColorToken {
	name: string;
	value: string;  // Hex color like "#3B82F6"
	variableId?: string;
	description?: string;
	scopes?: string[];  // e.g., ["FRAME_FILL", "TEXT_FILL"]
}

export interface SpacingToken {
	name: string;
	value: number;  // Pixel value
	variableId?: string;
	description?: string;
}

export interface TypographyToken {
	name: string;
	fontFamily: string;
	fontSize: number;
	fontWeight: number;
	lineHeight: number | { value: number; unit: 'PIXELS' | 'PERCENT' | 'AUTO' };
	letterSpacing?: number;
	textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
	textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
	styleId?: string;
	description?: string;
}

export interface EffectToken {
	name: string;
	type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';
	effects: Array<{
		type: string;
		color?: { r: number; g: number; b: number; a: number };
		offset?: { x: number; y: number };
		radius?: number;
		spread?: number;
		visible?: boolean;
	}>;
	styleId?: string;
	description?: string;
}

export interface TokenCollection {
	id: string;
	name: string;
	modes: Array<{
		modeId: string;
		name: string;
	}>;
	defaultModeId: string;
}

// ============================================================================
// COMPONENT TYPES
// ============================================================================

export interface ComponentVariant {
	name: string;
	values: string[];
	defaultValue?: string;
}

export interface ComponentProperty {
	name: string;
	type: 'TEXT' | 'BOOLEAN' | 'INSTANCE_SWAP' | 'VARIANT';
	defaultValue?: string | boolean;
	options?: string[];  // For INSTANCE_SWAP, available component keys
}

export interface ComponentSpec {
	key: string;  // For figma.importComponentByKeyAsync()
	nodeId: string;
	name: string;
	description?: string;
	variants?: ComponentVariant[];
	properties?: ComponentProperty[];
	defaultSize?: { width: number; height: number };
	boundVariables?: Record<string, string>;  // Property -> Variable ID
	usage?: string;  // AI guidance on when to use this component
	category?: string;  // e.g., "Buttons", "Inputs", "Cards"
}

export interface ComponentSet {
	key: string;
	nodeId: string;
	name: string;
	description?: string;
	variants: ComponentSpec[];
	variantAxes: ComponentVariant[];
}

// ============================================================================
// PATTERN TYPES
// ============================================================================

export interface LayoutPattern {
	name: string;
	description: string;
	properties: {
		padding?: string | number;  // Token name or pixel value
		gap?: string | number;
		borderRadius?: number;
		background?: string;  // Token name
		shadow?: string;  // Token name
		layoutMode?: 'HORIZONTAL' | 'VERTICAL' | 'NONE';
		primaryAxisAlign?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
		counterAxisAlign?: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
	};
	usage?: string;
}

// ============================================================================
// DESIGN RULES
// ============================================================================

export interface DesignRule {
	category: 'spacing' | 'color' | 'typography' | 'component' | 'layout';
	rule: string;
	priority: 'required' | 'recommended' | 'optional';
	examples?: string[];
}

// ============================================================================
// MAIN MANIFEST TYPE
// ============================================================================

export interface DesignSystemManifest {
	// Metadata
	version: string;
	generatedAt: number;
	fileKey: string;
	fileName?: string;
	fileUrl?: string;

	// Token Collections
	collections: TokenCollection[];

	// Tokens by Type
	tokens: {
		colors: Record<string, ColorToken>;
		spacing: Record<string, SpacingToken>;
		typography: Record<string, TypographyToken>;
		effects: Record<string, EffectToken>;
		other: Record<string, {
			name: string;
			type: string;
			value: any;
			variableId?: string;
		}>;
	};

	// Components
	components: Record<string, ComponentSpec>;
	componentSets: Record<string, ComponentSet>;

	// Patterns (detected or manually defined)
	patterns: Record<string, LayoutPattern>;

	// Design Rules
	rules: DesignRule[];

	// Summary for AI context
	summary: {
		totalTokens: number;
		totalComponents: number;
		totalComponentSets: number;
		colorPalette: string[];  // Main color tokens
		spacingScale: number[];  // Available spacing values
		typographyScale: string[];  // Typography style names
		componentCategories: string[];
	};
}

// ============================================================================
// MANIFEST GENERATION OPTIONS
// ============================================================================

export interface ManifestGenerationOptions {
	includeTokens?: boolean;
	includeComponents?: boolean;
	includeStyles?: boolean;
	includePatterns?: boolean;
	componentCategories?: string[];  // Filter to specific categories
	tokenCollections?: string[];  // Filter to specific collections
	inferPatterns?: boolean;  // Auto-detect common patterns
	verbose?: boolean;  // Include all details vs summary
}

// ============================================================================
// DESIGN SYSTEM CACHE
// ============================================================================

export interface ManifestCacheEntry {
	manifest: DesignSystemManifest;
	timestamp: number;
	fileKey: string;
	rawComponents?: {
		components: any[];
		componentSets: any[];
	};
}

/**
 * Cache for design system manifests with TTL-based invalidation.
 * Singleton pattern to share cache across tool calls.
 */
export class DesignSystemManifestCache {
	private static instance: DesignSystemManifestCache;
	private cache: Map<string, ManifestCacheEntry> = new Map();
	private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

	private constructor() {}

	static getInstance(): DesignSystemManifestCache {
		if (!DesignSystemManifestCache.instance) {
			DesignSystemManifestCache.instance = new DesignSystemManifestCache();
		}
		return DesignSystemManifestCache.instance;
	}

	get(fileKey: string): ManifestCacheEntry | null {
		const entry = this.cache.get(fileKey);
		if (!entry) return null;
		if (!this.isValid(entry)) {
			this.cache.delete(fileKey);
			return null;
		}
		return entry;
	}

	set(fileKey: string, manifest: DesignSystemManifest, rawComponents?: { components: any[]; componentSets: any[] }): void {
		this.cache.set(fileKey, {
			manifest,
			timestamp: Date.now(),
			fileKey,
			rawComponents,
		});
	}

	invalidate(fileKey: string): void {
		this.cache.delete(fileKey);
	}

	invalidateAll(): void {
		this.cache.clear();
	}

	isValid(entry: ManifestCacheEntry): boolean {
		return Date.now() - entry.timestamp < this.TTL_MS;
	}

	getStats(): { fileKey: string; age: number; componentCount: number; tokenCount: number }[] {
		const stats: { fileKey: string; age: number; componentCount: number; tokenCount: number }[] = [];
		for (const [fileKey, entry] of this.cache) {
			stats.push({
				fileKey,
				age: Math.round((Date.now() - entry.timestamp) / 1000),
				componentCount: entry.manifest.summary.totalComponents + entry.manifest.summary.totalComponentSets,
				tokenCount: entry.manifest.summary.totalTokens,
			});
		}
		return stats;
	}
}

// ============================================================================
// COMPONENT SEARCH UTILITIES
// ============================================================================

export interface ComponentSearchResult {
	name: string;
	key: string;
	nodeId: string;
	type: 'component' | 'componentSet';
	description?: string;
	category?: string;
	variantCount?: number;
	defaultSize?: { width: number; height: number };
}

/**
 * Search components by name, category, or description
 */
export function searchComponents(
	manifest: DesignSystemManifest,
	query: string,
	options?: { category?: string; limit?: number; offset?: number }
): { results: ComponentSearchResult[]; total: number; hasMore: boolean } {
	const limit = options?.limit ?? 10;
	const offset = options?.offset ?? 0;
	const queryLower = query.toLowerCase();
	const categoryLower = options?.category?.toLowerCase();

	const allResults: ComponentSearchResult[] = [];

	// Search component sets first (they're typically the main design system components)
	for (const [name, compSet] of Object.entries(manifest.componentSets)) {
		const nameLower = name.toLowerCase();
		const descLower = compSet.description?.toLowerCase() || '';

		const matchesQuery = !query || nameLower.includes(queryLower) || descLower.includes(queryLower);
		const matchesCategory = !categoryLower || inferCategory(name).toLowerCase().includes(categoryLower);

		if (matchesQuery && matchesCategory) {
			allResults.push({
				name: compSet.name,
				key: compSet.key,
				nodeId: compSet.nodeId,
				type: 'componentSet',
				description: compSet.description,
				category: inferCategory(name),
				variantCount: compSet.variants?.length || 0,
			});
		}
	}

	// Then search standalone components
	for (const [name, comp] of Object.entries(manifest.components)) {
		const nameLower = name.toLowerCase();
		const descLower = comp.description?.toLowerCase() || '';

		const matchesQuery = !query || nameLower.includes(queryLower) || descLower.includes(queryLower);
		const matchesCategory = !categoryLower || inferCategory(name).toLowerCase().includes(categoryLower);

		if (matchesQuery && matchesCategory) {
			allResults.push({
				name: comp.name,
				key: comp.key,
				nodeId: comp.nodeId,
				type: 'component',
				description: comp.description,
				category: inferCategory(name),
				defaultSize: comp.defaultSize,
			});
		}
	}

	const total = allResults.length;
	const paginatedResults = allResults.slice(offset, offset + limit);
	const hasMore = offset + limit < total;

	return { results: paginatedResults, total, hasMore };
}

/**
 * Infer category from component name (e.g., "Button/Primary" -> "Button")
 */
function inferCategory(name: string): string {
	const parts = name.split('/');
	return parts[0] || 'Uncategorized';
}

/**
 * Get unique categories from manifest
 */
export function getCategories(manifest: DesignSystemManifest): { name: string; componentCount: number; componentSetCount: number }[] {
	const categories = new Map<string, { componentCount: number; componentSetCount: number }>();

	for (const name of Object.keys(manifest.componentSets)) {
		const cat = inferCategory(name);
		const existing = categories.get(cat) || { componentCount: 0, componentSetCount: 0 };
		existing.componentSetCount++;
		categories.set(cat, existing);
	}

	for (const name of Object.keys(manifest.components)) {
		const cat = inferCategory(name);
		const existing = categories.get(cat) || { componentCount: 0, componentSetCount: 0 };
		existing.componentCount++;
		categories.set(cat, existing);
	}

	return Array.from(categories.entries())
		.map(([name, counts]) => ({ name, ...counts }))
		.sort((a, b) => (b.componentCount + b.componentSetCount) - (a.componentCount + a.componentSetCount));
}

/**
 * Get token categories and counts for summary
 */
export function getTokenSummary(manifest: DesignSystemManifest): {
	colors: { count: number; groups: string[] };
	spacing: { count: number; scale: number[] };
	typography: { count: number; groups: string[] };
	effects: { count: number };
	collections: string[];
} {
	// Group colors by prefix (e.g., "primary/500" -> "primary")
	const colorGroups = new Set<string>();
	for (const name of Object.keys(manifest.tokens.colors)) {
		const group = name.split('/')[0];
		colorGroups.add(group);
	}

	// Group typography by prefix
	const typographyGroups = new Set<string>();
	for (const name of Object.keys(manifest.tokens.typography)) {
		const group = name.split('/')[0];
		typographyGroups.add(group);
	}

	// Get spacing scale values
	const spacingValues = Object.values(manifest.tokens.spacing)
		.map(t => t.value)
		.filter((v, i, arr) => arr.indexOf(v) === i)
		.sort((a, b) => a - b);

	return {
		colors: {
			count: Object.keys(manifest.tokens.colors).length,
			groups: Array.from(colorGroups).slice(0, 10),
		},
		spacing: {
			count: Object.keys(manifest.tokens.spacing).length,
			scale: spacingValues.slice(0, 15),
		},
		typography: {
			count: Object.keys(manifest.tokens.typography).length,
			groups: Array.from(typographyGroups).slice(0, 10),
		},
		effects: {
			count: Object.keys(manifest.tokens.effects).length,
		},
		collections: manifest.collections.map(c => c.name),
	};
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert RGB color object to hex string
 */
export function rgbToHex(color: { r: number; g: number; b: number }): string {
	const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
	return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`.toUpperCase();
}

/**
 * Parse a Figma color value to hex
 */
export function figmaColorToHex(value: any): string {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object' && 'r' in value) {
		return rgbToHex(value);
	}
	return '#000000';
}

/**
 * Generate a human-readable summary of the manifest
 */
export function generateManifestSummary(manifest: DesignSystemManifest): string {
	const lines: string[] = [
		`# Design System Manifest`,
		``,
		`**File:** ${manifest.fileName || manifest.fileKey}`,
		`**Generated:** ${new Date(manifest.generatedAt).toISOString()}`,
		``,
		`## Summary`,
		`- **${manifest.summary.totalTokens}** design tokens`,
		`- **${manifest.summary.totalComponents}** components`,
		`- **${manifest.summary.totalComponentSets}** component sets`,
		``,
		`## Color Palette`,
		manifest.summary.colorPalette.slice(0, 10).map(c => `- ${c}`).join('\n'),
		``,
		`## Spacing Scale`,
		`${manifest.summary.spacingScale.join('px, ')}px`,
		``,
		`## Typography`,
		manifest.summary.typographyScale.slice(0, 10).map(t => `- ${t}`).join('\n'),
		``,
		`## Component Categories`,
		manifest.summary.componentCategories.map(c => `- ${c}`).join('\n'),
	];

	return lines.join('\n');
}

/**
 * Create an empty manifest template
 */
export function createEmptyManifest(fileKey: string): DesignSystemManifest {
	return {
		version: '1.0.0',
		generatedAt: Date.now(),
		fileKey,
		collections: [],
		tokens: {
			colors: {},
			spacing: {},
			typography: {},
			effects: {},
			other: {},
		},
		components: {},
		componentSets: {},
		patterns: {},
		rules: [],
		summary: {
			totalTokens: 0,
			totalComponents: 0,
			totalComponentSets: 0,
			colorPalette: [],
			spacingScale: [],
			typographyScale: [],
			componentCategories: [],
		},
	};
}
