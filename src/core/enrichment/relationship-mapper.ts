/**
 * Relationship Mapper
 * Maps relationships between styles, variables, and components
 * Tracks usage counts and builds reverse lookup indexes
 */

import type {
	ComponentUsage,
	StyleUsage,
	VariableDependency,
} from "../types/enriched.js";
import type pino from "pino";

type Logger = pino.Logger;

export class RelationshipMapper {
	private logger: Logger;

	// Relationship indexes
	private componentsByStyle: Map<string, ComponentUsage[]> = new Map();
	private componentsByVariable: Map<string, ComponentUsage[]> = new Map();
	private stylesByVariable: Map<string, StyleUsage[]> = new Map();
	private variableDependencies: Map<string, VariableDependency[]> = new Map();

	// Usage counters
	private styleUsageCount: Map<string, number> = new Map();
	private variableUsageCount: Map<string, number> = new Map();

	constructor(logger: Logger) {
		this.logger = logger;
	}

	/**
	 * Build all relationship indexes from file data
	 */
	async buildRelationships(fileData: any): Promise<void> {
		this.logger.info("Building relationship indexes");

		try {
			// Clear existing indexes
			this.clear();

			// Build variable dependencies first
			if (fileData.variables) {
				await this.buildVariableDependencies(fileData.variables);
			}

			// Build style-variable relationships
			if (fileData.styles && fileData.variables) {
				await this.buildStyleVariableRelationships(
					fileData.styles,
					fileData.variables,
				);
			}

			// Build component relationships
			if (fileData.document) {
				await this.buildComponentRelationships(fileData.document);
			}

			this.logger.info({
				styles: this.componentsByStyle.size,
				variables: this.componentsByVariable.size,
			}, "Relationship indexes built successfully");
		} catch (error) {
			this.logger.error({ error }, "Error building relationships");
			throw error;
		}
	}

	/**
	 * Get components that use a specific style
	 */
	getComponentsByStyle(styleId: string): ComponentUsage[] {
		return this.componentsByStyle.get(styleId) || [];
	}

	/**
	 * Get components that use a specific variable
	 */
	getComponentsByVariable(variableId: string): ComponentUsage[] {
		return this.componentsByVariable.get(variableId) || [];
	}

	/**
	 * Get styles that use a specific variable
	 */
	getStylesByVariable(variableId: string): StyleUsage[] {
		return this.stylesByVariable.get(variableId) || [];
	}

	/**
	 * Get variable dependencies (what variables this variable references)
	 */
	getVariableDependencies(variableId: string): VariableDependency[] {
		return this.variableDependencies.get(variableId) || [];
	}

	/**
	 * Get usage count for a style
	 */
	getStyleUsageCount(styleId: string): number {
		return this.styleUsageCount.get(styleId) || 0;
	}

	/**
	 * Get usage count for a variable
	 */
	getVariableUsageCount(variableId: string): number {
		return this.variableUsageCount.get(variableId) || 0;
	}

	/**
	 * Find unused styles (styles with zero usage)
	 */
	getUnusedStyles(allStyles: any[]): StyleUsage[] {
		const unused: StyleUsage[] = [];

		for (const style of allStyles) {
			const usageCount = this.getStyleUsageCount(
				style.node_id || style.key || style.id,
			);
			if (usageCount === 0) {
				unused.push({
					id: style.id || style.key,
					name: style.name,
					type: style.style_type || style.styleType,
					node_id: style.node_id || style.key,
				});
			}
		}

		return unused;
	}

	/**
	 * Find unused variables (variables with zero usage)
	 */
	getUnusedVariables(allVariables: any[]): any[] {
		const unused: any[] = [];

		for (const variable of allVariables) {
			const usageCount = this.getVariableUsageCount(variable.id);
			if (usageCount === 0) {
				unused.push({
					id: variable.id,
					name: variable.name,
					collection: variable.variableCollectionId,
					resolvedType: variable.resolvedType,
				});
			}
		}

		return unused;
	}

	/**
	 * Build variable dependency graph (which variables reference which)
	 */
	private async buildVariableDependencies(
		variables: Map<string, any>,
	): Promise<void> {
		for (const [variableId, variable] of variables.entries()) {
			const dependencies = this.extractVariableDependencies(variable, variables);
			if (dependencies.length > 0) {
				this.variableDependencies.set(variableId, dependencies);
			}
		}
	}

	/**
	 * Extract dependencies from a single variable
	 */
	private extractVariableDependencies(
		variable: any,
		allVariables: Map<string, any>,
		depth = 0,
	): VariableDependency[] {
		const dependencies: VariableDependency[] = [];

		// Check all modes for variable aliases
		for (const [modeId, value] of Object.entries(
			variable.valuesByMode || {},
		)) {
			if (
				typeof value === "object" &&
				value !== null &&
				(value as any).type === "VARIABLE_ALIAS"
			) {
				const targetId = (value as any).id;
				const targetVariable = allVariables.get(targetId);

				if (targetVariable) {
					dependencies.push({
						id: targetId,
						name: targetVariable.name,
						type: "alias",
						depth,
					});

					// Increment usage count for the referenced variable
					const currentCount = this.variableUsageCount.get(targetId) || 0;
					this.variableUsageCount.set(targetId, currentCount + 1);
				}
			}
		}

		return dependencies;
	}

	/**
	 * Build relationships between styles and variables
	 */
	private async buildStyleVariableRelationships(
		styles: any[],
		variables: Map<string, any>,
	): Promise<void> {
		for (const style of styles) {
			const variableRefs = this.extractStyleVariableReferences(style);

			for (const varRef of variableRefs) {
				// Track which styles use this variable
				if (!this.stylesByVariable.has(varRef)) {
					this.stylesByVariable.set(varRef, []);
				}

				this.stylesByVariable.get(varRef)?.push({
					id: style.id || style.key,
					name: style.name,
					type: style.style_type || style.styleType,
					node_id: style.node_id || style.key,
				});

				// Increment variable usage count
				const currentCount = this.variableUsageCount.get(varRef) || 0;
				this.variableUsageCount.set(varRef, currentCount + 1);
			}
		}
	}

	/**
	 * Extract variable references from a style
	 */
	private extractStyleVariableReferences(style: any): string[] {
		const refs: string[] = [];

		// Check boundVariables
		if (style.boundVariables) {
			const props = ["fills", "strokes", "effects", "text"];
			for (const prop of props) {
				if (style.boundVariables[prop]) {
					const binding = style.boundVariables[prop];
					if (Array.isArray(binding)) {
						for (const b of binding) {
							if (b.id) refs.push(b.id);
						}
					} else if (binding.id) {
						refs.push(binding.id);
					}
				}
			}
		}

		return refs;
	}

	/**
	 * Build component relationships by traversing the document tree
	 */
	private async buildComponentRelationships(document: any): Promise<void> {
		// Traverse all pages
		if (document.children) {
			for (const page of document.children) {
				await this.traverseNode(page, page.name);
			}
		}
	}

	/**
	 * Recursively traverse nodes to find component instances and their style/variable usage
	 */
	private async traverseNode(
		node: any,
		pageName: string,
		path: string[] = [],
	): Promise<void> {
		const currentPath = [...path, node.name];

		// Check if this node uses any styles
		if (node.styles) {
			this.trackNodeStyleUsage(node, pageName, currentPath);
		}

		// Check if this node uses any variables (via boundVariables)
		if (node.boundVariables) {
			this.trackNodeVariableUsage(node, pageName, currentPath);
		}

		// Recurse into children
		if (node.children) {
			for (const child of node.children) {
				await this.traverseNode(child, pageName, currentPath);
			}
		}
	}

	/**
	 * Track which styles a node uses
	 */
	private trackNodeStyleUsage(
		node: any,
		pageName: string,
		path: string[],
	): void {
		const componentUsage: ComponentUsage = {
			id: node.id,
			name: node.name,
			type: node.type,
			page: pageName,
		};

		// Check all style properties (fill, stroke, text, effect, grid)
		const styleProps = ["fill", "stroke", "text", "effect", "grid"];

		for (const prop of styleProps) {
			const styleId = node.styles?.[prop];
			if (styleId) {
				// Add to componentsByStyle index
				if (!this.componentsByStyle.has(styleId)) {
					this.componentsByStyle.set(styleId, []);
				}
				this.componentsByStyle.get(styleId)?.push(componentUsage);

				// Increment style usage count
				const currentCount = this.styleUsageCount.get(styleId) || 0;
				this.styleUsageCount.set(styleId, currentCount + 1);
			}
		}
	}

	/**
	 * Track which variables a node uses
	 */
	private trackNodeVariableUsage(
		node: any,
		pageName: string,
		path: string[],
	): void {
		const componentUsage: ComponentUsage = {
			id: node.id,
			name: node.name,
			type: node.type,
			page: pageName,
		};

		// Extract all variable IDs from boundVariables
		const variableIds = this.extractNodeVariableReferences(node);

		for (const varId of variableIds) {
			// Add to componentsByVariable index
			if (!this.componentsByVariable.has(varId)) {
				this.componentsByVariable.set(varId, []);
			}
			this.componentsByVariable.get(varId)?.push(componentUsage);

			// Increment variable usage count
			const currentCount = this.variableUsageCount.get(varId) || 0;
			this.variableUsageCount.set(varId, currentCount + 1);
		}
	}

	/**
	 * Extract all variable references from a node's boundVariables
	 */
	private extractNodeVariableReferences(node: any): string[] {
		const refs: string[] = [];

		if (!node.boundVariables) return refs;

		// boundVariables can have many properties (fills, strokes, etc.)
		for (const [prop, binding] of Object.entries(node.boundVariables)) {
			if (Array.isArray(binding)) {
				for (const b of binding) {
					if ((b as any).id) refs.push((b as any).id);
				}
			} else if (binding && typeof binding === "object" && (binding as any).id) {
				refs.push((binding as any).id);
			}
		}

		return refs;
	}

	/**
	 * Detect circular variable references
	 */
	detectCircularReferences(): Array<{ chain: string[] }> {
		const circular: Array<{ chain: string[] }> = [];
		const visited = new Set<string>();
		const currentPath: string[] = [];

		for (const [variableId] of this.variableDependencies) {
			this.detectCircularDFS(variableId, visited, currentPath, circular);
		}

		return circular;
	}

	/**
	 * DFS helper for detecting circular references
	 */
	private detectCircularDFS(
		variableId: string,
		visited: Set<string>,
		currentPath: string[],
		circular: Array<{ chain: string[] }>,
	): void {
		if (currentPath.includes(variableId)) {
			// Found a cycle
			const cycleStart = currentPath.indexOf(variableId);
			const cycle = currentPath.slice(cycleStart).concat(variableId);
			circular.push({ chain: cycle });
			return;
		}

		if (visited.has(variableId)) return;

		visited.add(variableId);
		currentPath.push(variableId);

		const dependencies = this.variableDependencies.get(variableId) || [];
		for (const dep of dependencies) {
			this.detectCircularDFS(dep.id, visited, currentPath, circular);
		}

		currentPath.pop();
	}

	/**
	 * Clear all indexes and caches
	 */
	clear(): void {
		this.componentsByStyle.clear();
		this.componentsByVariable.clear();
		this.stylesByVariable.clear();
		this.variableDependencies.clear();
		this.styleUsageCount.clear();
		this.variableUsageCount.clear();
	}
}
