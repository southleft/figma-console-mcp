/**
 * Figma Desktop Connector
 *
 * This service connects directly to Figma Desktop's plugin context
 * to execute code with access to the full Figma Plugin API,
 * including variables without Enterprise access.
 */

import { CDPSession, Page } from 'puppeteer-core';
import { logger } from './logger';

export class FigmaDesktopConnector {
  private page: Page;
  private session: CDPSession | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Initialize connection to Figma Desktop's plugin context
   */
  async initialize(): Promise<void> {
    try {
      // Create a CDP session for direct protocol access
      const client = await this.page.target().createCDPSession();
      this.session = client;

      // Enable Runtime domain for script execution
      await client.send('Runtime.enable');

      logger.info('Figma Desktop connector initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Figma Desktop connector');
      throw error;
    }
  }

  /**
   * Execute code in Figma's plugin context where the figma API is available
   * This mimics what the official Figma MCP does
   */
  async executeInPluginContext<T = any>(code: string): Promise<T> {
    if (!this.session) {
      throw new Error('Figma Desktop connector not initialized');
    }

    try {
      // Find the Figma plugin context (worker or isolated world)
      const { result } = await this.session.send('Runtime.evaluate', {
        expression: code,
        includeCommandLineAPI: true,
        returnByValue: true,
        // Try to execute in the context where figma API exists
        contextId: await this.findPluginContextId()
      });

      if (result.subtype === 'error') {
        throw new Error(result.description || 'Execution failed');
      }

      return result.value as T;
    } catch (error) {
      logger.error({ error, code }, 'Failed to execute in plugin context');

      // Fallback: Try to find and execute in a Web Worker context
      return this.executeInWorkerContext(code);
    }
  }

  /**
   * Find the execution context ID where the figma API is available
   */
  private async findPluginContextId(): Promise<number | undefined> {
    if (!this.session) return undefined;

    try {
      // Get all execution contexts
      const { contexts } = await this.session.send('Runtime.getExecutionContexts' as any);

      // Look for a context that might have the figma API
      // This could be a worker, isolated world, or specific frame
      for (const context of contexts) {
        const { result } = await this.session.send('Runtime.evaluate', {
          expression: 'typeof figma !== "undefined"',
          contextId: context.id,
          returnByValue: true
        });

        if (result.value === true) {
          logger.info({ contextId: context.id }, 'Found Figma plugin context');
          return context.id;
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Could not find plugin context');
    }

    return undefined;
  }

  /**
   * Execute code in a Web Worker context (where plugins run)
   */
  private async executeInWorkerContext<T = any>(code: string): Promise<T> {
    try {
      // Evaluate in the page but target worker contexts
      const result = await this.page.evaluate(`
        (async () => {
          // Try to find and communicate with Figma plugin workers
          const workers = await navigator.serviceWorker?.getRegistrations() || [];

          // Also check for shared workers or dedicated workers
          // This is where Figma plugins typically run

          // For now, we'll try direct evaluation in case we're in the right context
          try {
            return await (async function() { ${code} })();
          } catch (e) {
            throw new Error('Figma API not available in this context: ' + e.message);
          }
        })()
      `);

      return result as T;
    } catch (error) {
      logger.error({ error }, 'Failed to execute in worker context');
      throw error;
    }
  }

  /**
   * Get Figma variables using the desktop connection
   * This bypasses the Enterprise requirement!
   */
  async getVariables(fileKey?: string): Promise<any> {
    logger.info({ fileKey }, 'Getting variables via Desktop connection');

    const code = `
      (async () => {
        try {
          // Check if we're in the right context
          if (typeof figma === 'undefined') {
            throw new Error('Figma API not available in this context');
          }

          // Get variables just like the official MCP does
          const variables = await figma.variables.getLocalVariablesAsync();
          const collections = await figma.variables.getLocalVariableCollectionsAsync();

          // Format the response
          const result = {
            success: true,
            timestamp: Date.now(),
            variables: variables.map(v => ({
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
              modes: c.modes,
              defaultModeId: c.defaultModeId,
              variableIds: c.variableIds
            }))
          };

          return result;
        } catch (error) {
          return {
            success: false,
            error: error.message
          };
        }
      })()
    `;

    try {
      const result = await this.executeInPluginContext(code);

      if (!result.success) {
        throw new Error(result.error || 'Failed to get variables');
      }

      logger.info(
        {
          variableCount: result.variables?.length,
          collectionCount: result.variableCollections?.length
        },
        'Successfully retrieved variables via Desktop'
      );

      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to get variables via Desktop');
      throw error;
    }
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    if (this.session) {
      await this.session.detach();
      this.session = null;
    }
  }
}