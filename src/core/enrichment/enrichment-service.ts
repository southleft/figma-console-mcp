/**
 * Enrichment Service
 * Coordinates enrichment of Figma API responses
 */

import type pino from "pino";
import { StyleValueResolver } from "./style-resolver";
import { RelationshipMapper } from "./relationship-mapper";
import type {
	EnrichedStyle,
	EnrichedVariable,
	EnrichedComponent,
	EnrichedFileData,
	EnrichmentOptions,
	ExportFormat,
} from "../types/enriched";

type Logger = pino.Logger;

export class EnrichmentService {
	private logger: Logger;
	private styleResolver: StyleValueResolver;
	private relationshipMapper: RelationshipMapper;

	// Caches
	private fileDataCache: Map<string, any> = new Map();
	private lastEnrichmentTime: Map<string, number> = new Map();
	private CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	constructor(logger: Logger) {
		this.logger = logger;
		this.styleResolver = new StyleValueResolver(logger);
		this.relationshipMapper = new RelationshipMapper(logger);
	}

	/**
	 * Enrich styles response
	 */
	async enrichStyles(
		styles: any[],
		fileKey: string,
		options: EnrichmentOptions = {},
	): Promise<EnrichedStyle[]> {
		if (!options.enrich) {
			return styles; // Return as-is if enrichment not requested
		}

		this.logger.info({ fileKey, count: styles.length }, "Enriching styles");

		try {
			// Get file data for relationships
			const fileData = await this.getFileDataForEnrichment(fileKey);
			const variables = this.extractVariablesMap(fileData);

			// Build relationships if requested
			if (options.include_usage) {
				await this.relationshipMapper.buildRelationships(fileData);
			}

			const enrichedStyles: EnrichedStyle[] = [];

			for (const style of styles) {
				const enriched: EnrichedStyle = {
					...style,
				};

				// Resolve value and variable reference
				if (options.include_exports !== false) {
					const { value, variableRef } =
						await this.styleResolver.resolveStyleValue(
							style,
							variables,
							options.max_depth,
						);

					enriched.resolved_value = value;
					enriched.variable_reference = variableRef;

					// Generate export formats
					if (value && options.export_formats) {
						enriched.export_formats = this.styleResolver.generateExportFormats(
							style.name,
							value,
							style.style_type,
							options.export_formats,
						);
					}
				}

				// Add usage information
				if (options.include_usage) {
					const styleId = style.node_id || style.key || style.id;
					enriched.used_in_components =
						this.relationshipMapper.getComponentsByStyle(styleId);
					enriched.usage_count =
						this.relationshipMapper.getStyleUsageCount(styleId);
				}

				enrichedStyles.push(enriched);
			}

			this.logger.info(
				{ enrichedCount: enrichedStyles.length },
				"Styles enrichment complete",
			);
			return enrichedStyles;
		} catch (error) {
			this.logger.error({ error }, "Failed to enrich styles");
			return styles; // Return original on error
		}
	}

	/**
	 * Enrich variables response
	 */
	async enrichVariables(
		variables: any[],
		fileKey: string,
		options: EnrichmentOptions = {},
	): Promise<EnrichedVariable[]> {
		if (!options.enrich) {
			return variables;
		}

		this.logger.info({ fileKey, count: variables.length }, "Enriching variables");

		try {
			const fileData = await this.getFileDataForEnrichment(fileKey);
			const variablesMap = this.extractVariablesMap(fileData);

			// Build relationships if requested
			if (options.include_usage) {
				await this.relationshipMapper.buildRelationships(fileData);
			}

			const enrichedVars: EnrichedVariable[] = [];

			for (const variable of variables) {
				const enriched: EnrichedVariable = {
					...variable,
				};

				// Resolve values for all modes
				if (options.include_exports !== false) {
					const resolved_values: Record<string, any> = {};
					for (const [modeId, value] of Object.entries(
						variable.valuesByMode || {},
					)) {
						const resolvedValue = await this.styleResolver.resolveVariableValue(
							variable,
							variablesMap,
							options.max_depth,
						);
						resolved_values[modeId] = resolvedValue;
					}
					enriched.resolved_values = resolved_values;

					// Generate export formats using first mode
					const firstModeValue = Object.values(resolved_values)[0];
					if (firstModeValue && options.export_formats) {
						enriched.export_formats = this.styleResolver.generateExportFormats(
							variable.name,
							firstModeValue,
							variable.resolvedType,
							options.export_formats,
						);
					}
				}

				// Add usage information
				if (options.include_usage) {
					enriched.used_in_styles =
						this.relationshipMapper.getStylesByVariable(variable.id);
					enriched.used_in_components =
						this.relationshipMapper.getComponentsByVariable(variable.id);
					enriched.usage_count =
						this.relationshipMapper.getVariableUsageCount(variable.id);
				}

				// Add dependencies
				if (options.include_dependencies) {
					enriched.dependencies =
						this.relationshipMapper.getVariableDependencies(variable.id);
				}

				enrichedVars.push(enriched);
			}

			this.logger.info(
				{ enrichedCount: enrichedVars.length },
				"Variables enrichment complete",
			);
			return enrichedVars;
		} catch (error) {
			this.logger.error({ error }, "Failed to enrich variables");
			return variables;
		}
	}

	/**
	 * Enrich component response
	 */
	async enrichComponent(
		component: any,
		fileKey: string,
		options: EnrichmentOptions = {},
	): Promise<EnrichedComponent> {
		if (!options.enrich) {
			return component;
		}

		this.logger.info(
			{ fileKey, componentId: component.id },
			"Enriching component",
		);

		try {
			const enriched: EnrichedComponent = {
				...component,
			};

			const fileData = await this.getFileDataForEnrichment(fileKey);

			// Build relationships
			await this.relationshipMapper.buildRelationships(fileData);

			// Extract styles used
			if (component.styles) {
				const stylesUsed: any[] = [];
				for (const [prop, styleId] of Object.entries(component.styles)) {
					const style = fileData.styles?.[styleId as string];
					if (style) {
						stylesUsed.push({
							style_id: styleId,
							style_name: style.name,
							style_type: style.style_type,
							property: prop,
						});
					}
				}
				enriched.styles_used = stylesUsed;
			}

			// Extract variables used
			if (component.boundVariables) {
				const varsUsed: any[] = [];
				// This would need actual variable resolution
				enriched.variables_used = varsUsed;
			}

			// Detect hardcoded values (simplified for now)
			// TODO: Implement full hardcoded value detection
			enriched.hardcoded_values = [];

			// Calculate token coverage
			const totalProps = (enriched.styles_used?.length || 0) + (enriched.variables_used?.length || 0) + (enriched.hardcoded_values?.length || 0);
			const tokenProps = (enriched.styles_used?.length || 0) + (enriched.variables_used?.length || 0);
			enriched.token_coverage =
				totalProps > 0 ? Math.round((tokenProps / totalProps) * 100) : 0;

			this.logger.info(
				{ componentId: component.id, coverage: enriched.token_coverage },
				"Component enrichment complete",
			);
			return enriched;
		} catch (error) {
			this.logger.error({ error }, "Failed to enrich component");
			return component;
		}
	}

	/**
	 * Enrich file data response
	 */
	async enrichFileData(
		fileData: any,
		options: EnrichmentOptions = {},
	): Promise<EnrichedFileData> {
		if (!options.enrich) {
			return fileData;
		}

		this.logger.info({ fileKey: fileData.fileKey }, "Enriching file data");

		try {
			const enriched: EnrichedFileData = {
				...fileData,
			};

			// Build relationships for statistics
			await this.relationshipMapper.buildRelationships(fileData);

			// Calculate statistics
			const styles = Object.values(fileData.styles || {});
			const variables = Array.from(
				this.extractVariablesMap(fileData).values(),
			);

			const unusedStyles = this.relationshipMapper.getUnusedStyles(styles as any[]);
			const unusedVars = this.relationshipMapper.getUnusedVariables(variables);

			enriched.statistics = {
				total_variables: variables.length,
				total_styles: styles.length,
				total_components: Object.keys(fileData.components || {}).length,
				unused_variables: unusedVars.length,
				unused_styles: unusedStyles.length,
				average_token_coverage: 0, // TODO: Calculate from components
				total_hardcoded_values: 0, // TODO: Calculate from components
				audit_issues_count: 0, // TODO: Calculate from audit
			};

			// Calculate health score (simple formula)
			const usageRate =
				variables.length > 0
					? ((variables.length - unusedVars.length) / variables.length) * 100
					: 100;
			enriched.health_score = Math.round(usageRate);

			this.logger.info(
				{ health_score: enriched.health_score },
				"File data enrichment complete",
			);
			return enriched;
		} catch (error) {
			this.logger.error({ error }, "Failed to enrich file data");
			return fileData;
		}
	}

	/**
	 * Get file data for enrichment (with caching)
	 */
	private async getFileDataForEnrichment(fileKey: string): Promise<any> {
		const now = Date.now();
		const lastEnrich = this.lastEnrichmentTime.get(fileKey) || 0;

		// Return cached if fresh
		if (
			this.fileDataCache.has(fileKey) &&
			now - lastEnrich < this.CACHE_TTL_MS
		) {
			return this.fileDataCache.get(fileKey);
		}

		// This would be replaced with actual API call
		// For now, return empty structure
		const fileData = {
			styles: {},
			variables: {},
			document: {},
			components: {},
		};

		this.fileDataCache.set(fileKey, fileData);
		this.lastEnrichmentTime.set(fileKey, now);

		return fileData;
	}

	/**
	 * Extract variables as a Map for efficient lookup
	 */
	private extractVariablesMap(fileData: any): Map<string, any> {
		const variablesMap = new Map<string, any>();

		if (fileData.variables) {
			for (const [id, variable] of Object.entries(fileData.variables)) {
				variablesMap.set(id, variable);
			}
		}

		return variablesMap;
	}

	/**
	 * Clear all caches
	 */
	clearCache(): void {
		this.fileDataCache.clear();
		this.lastEnrichmentTime.clear();
		this.styleResolver.clearCache();
		this.relationshipMapper.clear();
	}
}
