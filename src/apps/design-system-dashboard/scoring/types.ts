/**
 * Design System Dashboard — Shared Types
 *
 * Defines the JSON contract between the scoring engine (server-side),
 * the server registration (tools), and the UI (client-side rendering).
 */

// ---------------------------------------------------------------------------
// Scoring output types
// ---------------------------------------------------------------------------

export type FindingSeverity = "pass" | "warning" | "fail" | "info";

/** A single audit check result. */
export interface Finding {
	id: string;
	label: string;
	score: number; // 0-100
	severity: FindingSeverity;
	tooltip?: string; // Hover explanation for this check
	details?: string;
	examples?: string[]; // Up to 5 specific item names
	locations?: Array<{
		name: string;
		collection?: string; // variable collection name
		nodeId?: string; // Figma node ID
		type?: string; // "component" | "variable" | "collection"
	}>;
}

/** Build a map of collection ID → collection name for location context. */
export function buildCollectionNameMap(collections: any[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const col of collections) {
		if (col.id && col.name) map.set(col.id, col.name);
	}
	return map;
}

/** A scored category (one of the 6 gauge rings). */
export interface CategoryScore {
	id: string;
	label: string;
	shortLabel: string; // For gauge display
	score: number; // 0-100
	weight: number; // 0-1 (sum of all weights = 1)
	findings: Finding[];
}

/** Complete dashboard payload sent to the UI. */
export interface DashboardData {
	overall: number; // 0-100 weighted average
	status: "good" | "needs-work" | "poor";
	categories: CategoryScore[];
	summary: string[]; // Top 3-5 actionable items
	meta: {
		componentCount: number;
		variableCount: number;
		collectionCount: number;
		styleCount: number;
		componentSetCount: number;
		standaloneCount: number;
		variantCount: number;
		timestamp: number;
	};
	fileInfo?: FileInfo;
	dataAvailability?: DataAvailability;
}

// ---------------------------------------------------------------------------
// Raw Figma data (input to scoring engine)
// ---------------------------------------------------------------------------

/** File metadata from Figma REST API. */
export interface FileInfo {
	name: string;
	lastModified: string;
	version?: string;
	thumbnailUrl?: string;
}

/** Tracks which data sources were successfully fetched. */
export interface DataAvailability {
	variables: boolean;
	collections: boolean;
	components: boolean;
	styles: boolean;
	variableError?: string;
}

/** Raw data fetched from Figma tools, passed into the scoring engine. */
export interface DesignSystemRawData {
	variables: any[];
	collections: any[];
	components: any[];
	styles: any[];
	componentSets: any[];
	fileInfo?: FileInfo;
	dataAvailability?: DataAvailability;
}

// ---------------------------------------------------------------------------
// Category scorer interface
// ---------------------------------------------------------------------------

/** Each category module exports a function matching this signature. */
export type CategoryScorer = (data: DesignSystemRawData) => CategoryScore;

// ---------------------------------------------------------------------------
// Thresholds and helpers
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
	GOOD: 90,
	NEEDS_WORK: 50,
} as const;

export function getStatus(score: number): DashboardData["status"] {
	if (score >= THRESHOLDS.GOOD) return "good";
	if (score >= THRESHOLDS.NEEDS_WORK) return "needs-work";
	return "poor";
}

export function getSeverity(score: number): FindingSeverity {
	if (score >= THRESHOLDS.GOOD) return "pass";
	if (score >= THRESHOLDS.NEEDS_WORK) return "warning";
	return "fail";
}

/** Clamp a number to 0-100. */
export function clamp(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}
