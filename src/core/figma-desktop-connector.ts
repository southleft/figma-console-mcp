/**
 * Figma Desktop Connector
 *
 * This service connects directly to Figma Desktop's plugin context
 * to execute code with access to the full Figma Plugin API,
 * including variables without Enterprise access.
 *
 * Uses Puppeteer's Worker API to directly access plugin workers,
 * bypassing CDP context enumeration limitations.
 */

import { Page } from 'puppeteer-core';
import { logger } from './logger.js';

export class FigmaDesktopConnector {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Initialize connection to Figma Desktop's plugin context
   * No setup needed - Puppeteer handles worker access automatically
   */
  async initialize(): Promise<void> {
    logger.info('Figma Desktop connector initialized (using Puppeteer Worker API)');
  }

  /**
   * Execute code in Figma's plugin context where the figma API is available
   * Uses Puppeteer's direct worker access instead of CDP context enumeration
   */
  async executeInPluginContext<T = any>(code: string): Promise<T> {
    try {
      // Use Puppeteer's worker API directly - this can access plugin workers
      // that CDP's Runtime.getExecutionContexts cannot enumerate
      const workers = this.page.workers();

      // Log to browser console so MCP can capture it
      await this.page.evaluate((count, urls) => {
        console.log(`[DESKTOP_CONNECTOR] Found ${count} workers via Puppeteer API:`, urls);
      }, workers.length, workers.map(w => w.url()));

      logger.info({
        workerCount: workers.length,
        workerUrls: workers.map(w => w.url())
      }, 'Found workers via Puppeteer API');

      // Try each worker to find one with figma API
      for (const worker of workers) {
        try {
          // Log to browser console
          await this.page.evaluate((url) => {
            console.log(`[DESKTOP_CONNECTOR] Checking worker: ${url}`);
          }, worker.url());

          // Check if this worker has the figma API
          // Use string evaluation to avoid TypeScript errors about figma global
          const hasFigmaApi = await worker.evaluate('typeof figma !== "undefined"');

          // Log result to browser console
          await this.page.evaluate((url, hasApi) => {
            console.log(`[DESKTOP_CONNECTOR] Worker ${url} has figma API: ${hasApi}`);
          }, worker.url(), hasFigmaApi);

          if (hasFigmaApi) {
            logger.info({ workerUrl: worker.url() }, 'Found worker with Figma API');

            await this.page.evaluate((url) => {
              console.log(`[DESKTOP_CONNECTOR] ✅ SUCCESS! Found worker with Figma API: ${url}`);
            }, worker.url());

            // Execute the code in this worker context
            // Wrap the code in a function to ensure proper evaluation
            const wrappedCode = `(${code})`;
            const result = await worker.evaluate(wrappedCode);
            return result as T;
          }
        } catch (workerError) {
          // This worker doesn't have figma API or evaluation failed, try next
          await this.page.evaluate((url, err) => {
            console.error(`[DESKTOP_CONNECTOR] ❌ Worker ${url} check failed:`, err);
          }, worker.url(), workerError instanceof Error ? workerError.message : String(workerError));

          logger.error({ error: workerError, workerUrl: worker.url() }, 'Worker check failed, trying next');
          continue;
        }
      }

      // If no worker found with figma API, throw error
      throw new Error('No plugin worker found with Figma API. Make sure a plugin is running in Figma Desktop.');
    } catch (error) {
      logger.error({ error, code: code.substring(0, 200) }, 'Failed to execute in plugin context');
      throw error;
    }
  }


  /**
   * Get Figma variables from plugin UI window object
   * This bypasses Figma's plugin sandbox security restrictions
   * by accessing data that the plugin posted to its UI iframe
   */
  async getVariablesFromPluginUI(fileKey?: string): Promise<any> {
    try {
      // Log to browser console
      await this.page.evaluate((key) => {
        console.log(`[DESKTOP_CONNECTOR] 🚀 getVariablesFromPluginUI() called, fileKey: ${key}`);
      }, fileKey);

      logger.info({ fileKey }, 'Getting variables from plugin UI iframe');

      // Get all frames (iframes) in the page
      const frames = this.page.frames();

      await this.page.evaluate((count) => {
        console.log(`[DESKTOP_CONNECTOR] Found ${count} frames (iframes)`);
      }, frames.length);

      logger.info({ frameCount: frames.length }, 'Found frames in page');

      // Try to find plugin UI iframe with variables data
      for (const frame of frames) {
        try {
          const frameUrl = frame.url();

          await this.page.evaluate((url) => {
            console.log(`[DESKTOP_CONNECTOR] Checking frame: ${url}`);
          }, frameUrl);

          // Check if this frame has our variables data
          const hasData = await frame.evaluate('typeof window.__figmaVariablesData !== "undefined" && window.__figmaVariablesReady === true');

          await this.page.evaluate((url, has) => {
            console.log(`[DESKTOP_CONNECTOR] Frame ${url} has variables data: ${has}`);
          }, frameUrl, hasData);

          if (hasData) {
            logger.info({ frameUrl }, 'Found frame with variables data');

            await this.page.evaluate((url) => {
              console.log(`[DESKTOP_CONNECTOR] ✅ SUCCESS! Found plugin UI with variables data: ${url}`);
            }, frameUrl);

            // Get the data from window object
            const result = await frame.evaluate('window.__figmaVariablesData') as any;

            logger.info(
              {
                variableCount: result.variables?.length,
                collectionCount: result.variableCollections?.length
              },
              'Successfully retrieved variables from plugin UI'
            );

            await this.page.evaluate((varCount, collCount) => {
              console.log(`[DESKTOP_CONNECTOR] ✅ Retrieved ${varCount} variables in ${collCount} collections`);
            }, result.variables?.length || 0, result.variableCollections?.length || 0);

            return result;
          }
        } catch (frameError) {
          await this.page.evaluate((url, err) => {
            console.log(`[DESKTOP_CONNECTOR] Frame ${url} check failed: ${err}`);
          }, frame.url(), frameError instanceof Error ? frameError.message : String(frameError));

          logger.debug({ error: frameError, frameUrl: frame.url() }, 'Frame check failed, trying next');
          continue;
        }
      }

      // If no frame found with data, throw error
      throw new Error('No plugin UI found with variables data. Make sure the Variables Exporter (Persistent) plugin is running.');
    } catch (error) {
      logger.error({ error }, 'Failed to get variables from plugin UI');

      await this.page.evaluate((msg) => {
        console.error('[DESKTOP_CONNECTOR] ❌ getVariablesFromPluginUI failed:', msg);
      }, error instanceof Error ? error.message : String(error));

      throw error;
    }
  }

  /**
   * Get Figma variables using the desktop connection
   * This bypasses the Enterprise requirement!
   */
  async getVariables(fileKey?: string): Promise<any> {
    // Log to browser console
    await this.page.evaluate((key) => {
      console.log(`[DESKTOP_CONNECTOR] 🚀 getVariables() called, fileKey: ${key}`);
    }, fileKey);

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
   * Clean up resources (no-op since we use Puppeteer's built-in worker management)
   */
  async dispose(): Promise<void> {
    logger.info('Figma Desktop connector disposed');
  }
}