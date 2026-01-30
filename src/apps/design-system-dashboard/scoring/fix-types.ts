/**
 * Design System Dashboard — Fix Types
 *
 * Types for the auto-fix infrastructure that allows the dashboard
 * to fix issues it finds via the Desktop Bridge.
 */

export type FixAction =
	| "set-description"
	| "set-variable-description"
	| "rename-variable"
	| "rename-node"
	| "update-variable"
	| "create-variable"
	| "create-collection";

/** A single atomic fix operation to execute via Desktop Bridge. */
export interface FixOperation {
	action: FixAction;
	targetId: string;
	targetName: string;
	params: Record<string, unknown>;
}

/** A complete fix plan for a single finding, with all operations. */
export interface FixDefinition {
	findingId: string;
	description: string;
	operations: FixOperation[];
	requiresDesktopBridge: boolean;
}

/** Result of executing a fix. */
export interface FixResult {
	findingId: string;
	success: boolean;
	operationsCompleted: number;
	operationsTotal: number;
	errors: string[];
}

/** Callback signature for executing fix operations via Desktop Bridge. */
export type FixExecutor = (operations: FixOperation[]) => Promise<FixResult>;
