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
   * Get component data by node ID from plugin UI window object
   * This bypasses the REST API bug where descriptions are missing
   * by accessing data from the Desktop Bridge plugin via its UI iframe
   */
  async getComponentFromPluginUI(nodeId: string): Promise<any> {
    try {
      // Log to browser console
      await this.page.evaluate((id) => {
        console.log(`[DESKTOP_CONNECTOR] 🎯 getComponentFromPluginUI() called, nodeId: ${id}`);
      }, nodeId);

      logger.info({ nodeId }, 'Getting component from plugin UI iframe');

      // Get all frames (iframes) in the page
      const frames = this.page.frames();

      await this.page.evaluate((count) => {
        console.log(`[DESKTOP_CONNECTOR] Found ${count} frames (iframes)`);
      }, frames.length);

      logger.info({ frameCount: frames.length }, 'Found frames in page');

      // Try to find plugin UI iframe with requestComponentData function
      for (const frame of frames) {
        try {
          const frameUrl = frame.url();

          await this.page.evaluate((url) => {
            console.log(`[DESKTOP_CONNECTOR] Checking frame: ${url}`);
          }, frameUrl);

          // Check if this frame has our requestComponentData function
          const hasFunction = await frame.evaluate('typeof window.requestComponentData === "function"');

          await this.page.evaluate((url, has) => {
            console.log(`[DESKTOP_CONNECTOR] Frame ${url} has requestComponentData: ${has}`);
          }, frameUrl, hasFunction);

          if (hasFunction) {
            logger.info({ frameUrl }, 'Found frame with requestComponentData function');

            await this.page.evaluate((url) => {
              console.log(`[DESKTOP_CONNECTOR] ✅ SUCCESS! Found plugin UI with requestComponentData: ${url}`);
            }, frameUrl);

            // Call the function with the nodeId - it returns a Promise
            // Use JSON.stringify to safely pass the nodeId as a string literal
            const result = await frame.evaluate(`window.requestComponentData(${JSON.stringify(nodeId)})`) as any;

            logger.info(
              {
                nodeId,
                componentName: result.component?.name,
                hasDescription: !!result.component?.description
              },
              'Successfully retrieved component from plugin UI'
            );

            await this.page.evaluate((name, hasDesc) => {
              console.log(`[DESKTOP_CONNECTOR] ✅ Retrieved component "${name}", has description: ${hasDesc}`);
            }, result.component?.name, !!result.component?.description);

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

      // If no frame found with function, throw error
      throw new Error('No plugin UI found with requestComponentData function. Make sure the Desktop Bridge plugin is running.');
    } catch (error) {
      logger.error({ error, nodeId }, 'Failed to get component from plugin UI');

      await this.page.evaluate((msg) => {
        console.error('[DESKTOP_CONNECTOR] ❌ getComponentFromPluginUI failed:', msg);
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

  /**
   * Get component data by node ID using Plugin API
   * This bypasses the REST API bug where descriptions are missing
   */
  async getComponentByNodeId(nodeId: string): Promise<any> {
    await this.page.evaluate((id) => {
      console.log(`[DESKTOP_CONNECTOR] 🎯 getComponentByNodeId() called, nodeId: ${id}`);
    }, nodeId);

    logger.info({ nodeId }, 'Getting component via Desktop Plugin API');

    const code = `
      (async () => {
        try {
          // Check if we're in the right context
          if (typeof figma === 'undefined') {
            throw new Error('Figma API not available in this context');
          }

          // Get the node by ID
          const node = figma.getNodeById('${nodeId}');
          
          if (!node) {
            throw new Error('Node not found with ID: ${nodeId}');
          }

          // Check if it's a component-like node
          if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET' && node.type !== 'INSTANCE') {
            throw new Error('Node is not a component, component set, or instance. Type: ' + node.type);
          }

          // Detect if this is a variant (COMPONENT inside a COMPONENT_SET)
          const isVariant = node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET';

          // Extract component data including description fields
          const result = {
            success: true,
            timestamp: Date.now(),
            component: {
              id: node.id,
              name: node.name,
              type: node.type,
              // Variants CAN have their own description
              description: node.description || null,
              descriptionMarkdown: node.descriptionMarkdown || null,
              // Include other useful properties
              visible: node.visible,
              locked: node.locked,
              // Flag to indicate if this is a variant
              isVariant: isVariant,
              // For component sets and non-variant components only (variants cannot access this)
              componentPropertyDefinitions: node.type === 'COMPONENT_SET' || (node.type === 'COMPONENT' && !isVariant)
                ? node.componentPropertyDefinitions
                : undefined,
              // Get children info (lightweight)
              children: node.children ? node.children.map(child => ({
                id: child.id,
                name: child.name,
                type: child.type
              })) : undefined
            }
          };

          return result;
        } catch (error) {
          return {
            success: false,
            error: error.message,
            stack: error.stack
          };
        }
      })()
    `;

    try {
      const result = await this.executeInPluginContext(code);

      if (!result.success) {
        throw new Error(result.error || 'Failed to get component data');
      }

      logger.info(
        {
          nodeId,
          componentName: result.component?.name,
          hasDescription: !!result.component?.description
        },
        'Successfully retrieved component via Desktop Plugin API'
      );

      await this.page.evaluate((name, hasDesc) => {
        console.log(`[DESKTOP_CONNECTOR] ✅ Retrieved component "${name}", has description: ${hasDesc}`);
      }, result.component?.name, !!result.component?.description);

      return result;
    } catch (error) {
      logger.error({ error, nodeId }, 'Failed to get component via Desktop Plugin API');
      
      await this.page.evaluate((id, err) => {
        console.error(`[DESKTOP_CONNECTOR] ❌ getComponentByNodeId failed for ${id}:`, err);
      }, nodeId, error instanceof Error ? error.message : String(error));
      
      throw error;
    }
  }


  async dispose(): Promise<void> {
    logger.info('Figma Desktop connector disposed');
  }
}