/**
 * WebSocket Figma Connector
 *
 * Implements IFigmaConnector using the WebSocket Desktop Bridge transport.
 * Each method sends a command to the plugin UI via WebSocket and waits
 * for the response — same window.* functions, different transport.
 *
 * Data flow: MCP Server ←WebSocket→ ui.html ←postMessage→ code.js ←figma.*→ Figma
 */

import type { IFigmaConnector } from './figma-connector.js';
import type { FigmaWebSocketServer } from './websocket-server.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ component: 'websocket-connector' });

export class WebSocketConnector implements IFigmaConnector {
  private wsServer: FigmaWebSocketServer;

  constructor(wsServer: FigmaWebSocketServer) {
    this.wsServer = wsServer;
  }

  async initialize(): Promise<void> {
    if (!this.wsServer.isClientConnected()) {
      throw new Error(
        'No WebSocket client connected. Make sure the Desktop Bridge plugin is open in Figma.'
      );
    }
    logger.info('WebSocket connector initialized');
  }

  getTransportType(): 'cdp' | 'websocket' {
    return 'websocket';
  }

  // ============================================================================
  // Core execution
  // ============================================================================

  async executeInPluginContext<T = any>(code: string): Promise<T> {
    return this.wsServer.sendCommand('EXECUTE_CODE', { code, timeout: 5000 }, 7000);
  }

  async getVariablesFromPluginUI(fileKey?: string): Promise<any> {
    // Request the cached variables data that the plugin UI holds in window.__figmaVariablesData
    return this.wsServer.sendCommand('GET_VARIABLES_DATA', {}, 10000, fileKey);
  }

  async getVariables(fileKey?: string): Promise<any> {
    // Execute the same variables-fetching code in the plugin worker context
    const code = `
      (async () => {
        try {
          if (typeof figma === 'undefined') {
            throw new Error('Figma API not available in this context');
          }
          const variables = await figma.variables.getLocalVariablesAsync();
          const collections = await figma.variables.getLocalVariableCollectionsAsync();
          return {
            success: true,
            timestamp: Date.now(),
            fileMetadata: { fileName: figma.root.name, fileKey: figma.fileKey || null },
            variables: variables.map(function(v) { return { id: v.id, name: v.name, key: v.key, resolvedType: v.resolvedType, valuesByMode: v.valuesByMode, variableCollectionId: v.variableCollectionId, scopes: v.scopes, description: v.description, hiddenFromPublishing: v.hiddenFromPublishing }; }),
            variableCollections: collections.map(function(c) { return { id: c.id, name: c.name, key: c.key, modes: c.modes, defaultModeId: c.defaultModeId, variableIds: c.variableIds }; })
          };
        } catch (error) {
          return { success: false, error: error.message };
        }
      })()
    `;
    return this.wsServer.sendCommand('EXECUTE_CODE', { code, timeout: 30000 }, 32000, fileKey);
  }

  async executeCodeViaUI(code: string, timeoutMs = 5000): Promise<any> {
    return this.wsServer.sendCommand('EXECUTE_CODE', { code, timeout: timeoutMs }, timeoutMs + 2000);
  }

  // ============================================================================
  // Variable operations
  // ============================================================================

  async updateVariable(variableId: string, modeId: string, value: any): Promise<any> {
    return this.wsServer.sendCommand('UPDATE_VARIABLE', { variableId, modeId, value });
  }

  async createVariable(
    name: string,
    collectionId: string,
    resolvedType: string,
    options?: any
  ): Promise<any> {
    const params: any = { name, collectionId, resolvedType };
    if (options) {
      if (options.valuesByMode) params.valuesByMode = options.valuesByMode;
      if (options.description) params.description = options.description;
      if (options.scopes) params.scopes = options.scopes;
    }
    return this.wsServer.sendCommand('CREATE_VARIABLE', params);
  }

  async deleteVariable(variableId: string): Promise<any> {
    return this.wsServer.sendCommand('DELETE_VARIABLE', { variableId });
  }

  async refreshVariables(): Promise<any> {
    return this.wsServer.sendCommand('REFRESH_VARIABLES', {}, 300000);
  }

  async renameVariable(variableId: string, newName: string): Promise<any> {
    const result = await this.wsServer.sendCommand('RENAME_VARIABLE', { variableId, newName });
    // oldName may be embedded in variable data if ui.html handleResult doesn't pass it through
    if (!result.oldName && result.variable?.oldName) result.oldName = result.variable.oldName;
    return result;
  }

  async setVariableDescription(variableId: string, description: string): Promise<any> {
    return this.wsServer.sendCommand('SET_VARIABLE_DESCRIPTION', { variableId, description });
  }

  // ============================================================================
  // Mode operations
  // ============================================================================

  async addMode(collectionId: string, modeName: string): Promise<any> {
    return this.wsServer.sendCommand('ADD_MODE', { collectionId, modeName });
  }

  async renameMode(collectionId: string, modeId: string, newName: string): Promise<any> {
    const result = await this.wsServer.sendCommand('RENAME_MODE', { collectionId, modeId, newName });
    // oldName may be embedded in collection data if ui.html handleResult doesn't pass it through
    if (!result.oldName && result.collection?.oldName) result.oldName = result.collection.oldName;
    return result;
  }

  // ============================================================================
  // Collection operations
  // ============================================================================

  async createVariableCollection(name: string, options?: any): Promise<any> {
    const params: any = { name };
    if (options) {
      if (options.initialModeName) params.initialModeName = options.initialModeName;
      if (options.additionalModes) params.additionalModes = options.additionalModes;
    }
    return this.wsServer.sendCommand('CREATE_VARIABLE_COLLECTION', params);
  }

  async deleteVariableCollection(collectionId: string): Promise<any> {
    return this.wsServer.sendCommand('DELETE_VARIABLE_COLLECTION', { collectionId });
  }

  // ============================================================================
  // Component operations
  // ============================================================================

  async getComponentFromPluginUI(nodeId: string): Promise<any> {
    return this.wsServer.sendCommand('GET_COMPONENT', { nodeId }, 10000);
  }

  async getLocalComponents(): Promise<any> {
    return this.wsServer.sendCommand('GET_LOCAL_COMPONENTS', {}, 300000);
  }

  async setNodeDescription(nodeId: string, description: string, descriptionMarkdown?: string): Promise<any> {
    return this.wsServer.sendCommand('SET_NODE_DESCRIPTION', { nodeId, description, descriptionMarkdown });
  }

  async addComponentProperty(
    nodeId: string,
    propertyName: string,
    type: string,
    defaultValue: any,
    options?: any
  ): Promise<any> {
    const params: any = { nodeId, propertyName, propertyType: type, defaultValue };
    if (options?.preferredValues) params.preferredValues = options.preferredValues;
    return this.wsServer.sendCommand('ADD_COMPONENT_PROPERTY', params);
  }

  async editComponentProperty(nodeId: string, propertyName: string, newValue: any): Promise<any> {
    return this.wsServer.sendCommand('EDIT_COMPONENT_PROPERTY', { nodeId, propertyName, newValue });
  }

  async deleteComponentProperty(nodeId: string, propertyName: string): Promise<any> {
    return this.wsServer.sendCommand('DELETE_COMPONENT_PROPERTY', { nodeId, propertyName });
  }

  async instantiateComponent(componentKey: string, options?: any): Promise<any> {
    const params: any = { componentKey };
    if (options) {
      if (options.nodeId) params.nodeId = options.nodeId;
      if (options.position) params.position = options.position;
      if (options.size) params.size = options.size;
      if (options.overrides) params.overrides = options.overrides;
      if (options.variant) params.variant = options.variant;
      if (options.parentId) params.parentId = options.parentId;
    }
    return this.wsServer.sendCommand('INSTANTIATE_COMPONENT', params);
  }

  // ============================================================================
  // Node manipulation
  // ============================================================================

  async resizeNode(nodeId: string, width: number, height: number, withConstraints = true): Promise<any> {
    return this.wsServer.sendCommand('RESIZE_NODE', { nodeId, width, height, withConstraints });
  }

  async moveNode(nodeId: string, x: number, y: number): Promise<any> {
    return this.wsServer.sendCommand('MOVE_NODE', { nodeId, x, y });
  }

  async setNodeFills(nodeId: string, fills: any[]): Promise<any> {
    return this.wsServer.sendCommand('SET_NODE_FILLS', { nodeId, fills });
  }

  async setNodeStrokes(nodeId: string, strokes: any[], strokeWeight?: number): Promise<any> {
    const params: any = { nodeId, strokes };
    if (strokeWeight !== undefined) params.strokeWeight = strokeWeight;
    return this.wsServer.sendCommand('SET_NODE_STROKES', params);
  }

  async setNodeOpacity(nodeId: string, opacity: number): Promise<any> {
    return this.wsServer.sendCommand('SET_NODE_OPACITY', { nodeId, opacity });
  }

  async setNodeCornerRadius(nodeId: string, radius: number): Promise<any> {
    return this.wsServer.sendCommand('SET_NODE_CORNER_RADIUS', { nodeId, radius });
  }

  async cloneNode(nodeId: string): Promise<any> {
    return this.wsServer.sendCommand('CLONE_NODE', { nodeId });
  }

  async deleteNode(nodeId: string): Promise<any> {
    return this.wsServer.sendCommand('DELETE_NODE', { nodeId });
  }

  async renameNode(nodeId: string, newName: string): Promise<any> {
    return this.wsServer.sendCommand('RENAME_NODE', { nodeId, newName });
  }

  async setTextContent(nodeId: string, characters: string, options?: any): Promise<any> {
    const params: any = { nodeId, text: characters };
    if (options) {
      if (options.fontSize) params.fontSize = options.fontSize;
      if (options.fontWeight) params.fontWeight = options.fontWeight;
      if (options.fontFamily) params.fontFamily = options.fontFamily;
    }
    return this.wsServer.sendCommand('SET_TEXT_CONTENT', params);
  }

  async createChildNode(parentId: string, nodeType: string, properties?: any): Promise<any> {
    return this.wsServer.sendCommand('CREATE_CHILD_NODE', { parentId, nodeType, properties: properties || {} });
  }

  // ============================================================================
  // Screenshot & instance properties
  // ============================================================================

  async captureScreenshot(nodeId: string, options?: any): Promise<any> {
    const params: any = { nodeId };
    if (options?.format) params.format = options.format;
    if (options?.scale) params.scale = options.scale;
    return this.wsServer.sendCommand('CAPTURE_SCREENSHOT', params, 30000);
  }

  async setInstanceProperties(nodeId: string, properties: any): Promise<any> {
    return this.wsServer.sendCommand('SET_INSTANCE_PROPERTIES', { nodeId, properties });
  }

  // ============================================================================
  // Cache management (no-op for WebSocket — no frame cache)
  // ============================================================================

  clearFrameCache(): void {
    // No frame cache in WebSocket mode
  }
}
