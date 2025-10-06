/**
 * Snippet Injector
 * Generates and manages console-based data extraction snippets for Figma
 */

import type { ConsoleLogEntry } from './types/index.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ component: 'snippet-injector' });

export class SnippetInjector {
	/**
	 * Generate variables extraction snippet for Figma console
	 */
	generateVariablesSnippet(): string {
		return `
(async () => {
  try {
    const vars = await figma.variables.getLocalVariablesAsync();
    const collections = await figma.variables.getLocalVariableCollectionsAsync();

    const payload = {
      timestamp: Date.now(),
      variables: vars.map(v => ({
        id: v.id,
        name: v.name,
        key: v.key,
        resolvedType: v.resolvedType,
        valuesByMode: v.valuesByMode,
        variableCollectionId: v.variableCollectionId,
        scopes: v.scopes,
        description: v.description,
        hiddenFromPublishing: v.hiddenFromPublishing
      })),
      variableCollections: collections.map(c => ({
        id: c.id,
        name: c.name,
        key: c.key,
        modes: c.modes.map(m => ({ modeId: m.modeId, name: m.name })),
        defaultModeId: c.defaultModeId,
        variableIds: c.variableIds
      }))
    };

    console.log('[MCP_VARIABLES]', JSON.stringify(payload), '[MCP_VARIABLES_END]');
    console.log('✅ Variables data captured! Run figma_get_variables({ parseFromConsole: true }) in Claude to retrieve.');

  } catch (error) {
    console.error('[MCP_VARIABLES_ERROR]', error.message);
    console.log('❌ Make sure you\\'re running this in a Figma file with variables.');
  }
})();
		`.trim();
	}

	/**
	 * Parse variables from console log entry
	 */
	parseVariablesFromLog(logEntry: ConsoleLogEntry): {
		variables: any[];
		variableCollections: any[];
		timestamp: number;
	} | null {
		try {
			// Check for marker
			if (!logEntry.message.includes('[MCP_VARIABLES]')) {
				return null;
			}

			// Extract JSON from args
			// The snippet logs: console.log('[MCP_VARIABLES]', JSON.stringify(payload), '[MCP_VARIABLES_END]')
			// So args[0] is the marker, args[1] is the JSON string
			const jsonStr = logEntry.args[1] || logEntry.args[0];

			if (!jsonStr) {
				throw new Error('No data found in console log');
			}

			const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;

			logger.info(
				{
					variableCount: data.variables?.length || 0,
					collectionCount: data.variableCollections?.length || 0,
				},
				'Successfully parsed variables from console log'
			);

			return {
				variables: data.variables || [],
				variableCollections: data.variableCollections || [],
				timestamp: data.timestamp || Date.now(),
			};
		} catch (error) {
			logger.error({ error }, 'Failed to parse variables from console log');
			throw new Error(
				`Failed to parse variables from console log: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Find the most recent variables log entry
	 */
	findVariablesLog(logs: ConsoleLogEntry[]): ConsoleLogEntry | null {
		// Search in reverse (most recent first)
		for (let i = logs.length - 1; i >= 0; i--) {
			const log = logs[i];
			if (log.message.includes('[MCP_VARIABLES]')) {
				return log;
			}
		}
		return null;
	}
}
