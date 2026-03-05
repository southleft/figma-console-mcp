/**
 * Supabase Bridge Connector
 *
 * Implements IFigmaConnector using Supabase as a relay (instead of WebSocket).
 * Each method inserts a command into bridge_commands, waits for the plugin to
 * execute it and write back the result, then returns it.
 *
 * Drop-in replacement for WebSocketConnector in remote/Cloudflare mode.
 */

import type { IFigmaConnector } from './figma-connector.js';
import { bridgeRelay, type BridgeEnv } from '../bridge-relay.js';

export class SupabaseBridgeConnector implements IFigmaConnector {
	constructor(
		private readonly sessionId: string,
		private readonly env: BridgeEnv
	) {}

	private async send(type: string, payload: unknown = {}): Promise<any> {
		return bridgeRelay(
			{ id: crypto.randomUUID(), type, payload },
			this.sessionId,
			this.env
		);
	}

	// Lifecycle
	async initialize(): Promise<void> {
		// No persistent connection to establish — relay is stateless
	}

	getTransportType(): 'cdp' | 'websocket' {
		return 'websocket'; // Reported as websocket for compatibility with tool checks
	}

	// Core execution
	async executeInPluginContext<T = any>(code: string): Promise<T> {
		return this.send('EXECUTE_CODE', { code, timeout: 5000 });
	}

	async getVariablesFromPluginUI(fileKey?: string): Promise<any> {
		return this.send('GET_VARIABLES_DATA', fileKey ? { fileKey } : {});
	}

	async getVariables(fileKey?: string): Promise<any> {
		const code = `
      (async () => {
        try {
          if (typeof figma === 'undefined') throw new Error('Figma API not available');
          const variables = await figma.variables.getLocalVariablesAsync();
          const collections = await figma.variables.getLocalVariableCollectionsAsync();
          return {
            success: true,
            timestamp: Date.now(),
            fileMetadata: { fileName: figma.root.name, fileKey: figma.fileKey || null },
            variables: variables.map(v => ({ id: v.id, name: v.name, key: v.key, resolvedType: v.resolvedType, valuesByMode: v.valuesByMode, variableCollectionId: v.variableCollectionId, scopes: v.scopes, description: v.description, hiddenFromPublishing: v.hiddenFromPublishing })),
            variableCollections: collections.map(c => ({ id: c.id, name: c.name, key: c.key, modes: c.modes, defaultModeId: c.defaultModeId, variableIds: c.variableIds }))
          };
        } catch (error) {
          return { success: false, error: error.message };
        }
      })()
    `;
		return this.send('EXECUTE_CODE', { code, timeout: 30000 });
	}

	async executeCodeViaUI(code: string, timeoutMs = 5000): Promise<any> {
		return this.send('EXECUTE_CODE', { code, timeout: timeoutMs });
	}

	// Variable operations
	async updateVariable(variableId: string, modeId: string, value: any): Promise<any> {
		return this.send('UPDATE_VARIABLE', { variableId, modeId, value });
	}

	async createVariable(name: string, collectionId: string, resolvedType: string, options?: any): Promise<any> {
		const params: any = { name, collectionId, resolvedType };
		if (options?.valuesByMode) params.valuesByMode = options.valuesByMode;
		if (options?.description) params.description = options.description;
		if (options?.scopes) params.scopes = options.scopes;
		return this.send('CREATE_VARIABLE', params);
	}

	async deleteVariable(variableId: string): Promise<any> {
		return this.send('DELETE_VARIABLE', { variableId });
	}

	async refreshVariables(): Promise<any> {
		return this.send('REFRESH_VARIABLES', {});
	}

	async renameVariable(variableId: string, newName: string): Promise<any> {
		const result = await this.send('RENAME_VARIABLE', { variableId, newName });
		if (!result.oldName && result.variable?.oldName) result.oldName = result.variable.oldName;
		return result;
	}

	async setVariableDescription(variableId: string, description: string): Promise<any> {
		return this.send('SET_VARIABLE_DESCRIPTION', { variableId, description });
	}

	// Mode operations
	async addMode(collectionId: string, modeName: string): Promise<any> {
		return this.send('ADD_MODE', { collectionId, modeName });
	}

	async renameMode(collectionId: string, modeId: string, newName: string): Promise<any> {
		const result = await this.send('RENAME_MODE', { collectionId, modeId, newName });
		if (!result.oldName && result.collection?.oldName) result.oldName = result.collection.oldName;
		return result;
	}

	// Collection operations
	async createVariableCollection(name: string, options?: any): Promise<any> {
		const params: any = { name };
		if (options?.initialModeName) params.initialModeName = options.initialModeName;
		if (options?.additionalModes) params.additionalModes = options.additionalModes;
		return this.send('CREATE_VARIABLE_COLLECTION', params);
	}

	async deleteVariableCollection(collectionId: string): Promise<any> {
		return this.send('DELETE_VARIABLE_COLLECTION', { collectionId });
	}

	// Component operations
	async getComponentFromPluginUI(nodeId: string): Promise<any> {
		return this.send('GET_COMPONENT', { nodeId });
	}

	async getLocalComponents(): Promise<any> {
		return this.send('GET_LOCAL_COMPONENTS', {});
	}

	async setNodeDescription(nodeId: string, description: string, descriptionMarkdown?: string): Promise<any> {
		return this.send('SET_NODE_DESCRIPTION', { nodeId, description, descriptionMarkdown });
	}

	async addComponentProperty(nodeId: string, propertyName: string, type: string, defaultValue: any, options?: any): Promise<any> {
		const params: any = { nodeId, propertyName, propertyType: type, defaultValue };
		if (options?.preferredValues) params.preferredValues = options.preferredValues;
		return this.send('ADD_COMPONENT_PROPERTY', params);
	}

	async editComponentProperty(nodeId: string, propertyName: string, newValue: any): Promise<any> {
		return this.send('EDIT_COMPONENT_PROPERTY', { nodeId, propertyName, newValue });
	}

	async deleteComponentProperty(nodeId: string, propertyName: string): Promise<any> {
		return this.send('DELETE_COMPONENT_PROPERTY', { nodeId, propertyName });
	}

	async instantiateComponent(componentKey: string, options?: any): Promise<any> {
		const params: any = { componentKey };
		if (options?.nodeId) params.nodeId = options.nodeId;
		if (options?.position) params.position = options.position;
		if (options?.size) params.size = options.size;
		if (options?.overrides) params.overrides = options.overrides;
		if (options?.variant) params.variant = options.variant;
		if (options?.parentId) params.parentId = options.parentId;
		return this.send('INSTANTIATE_COMPONENT', params);
	}

	// Node manipulation
	async resizeNode(nodeId: string, width: number, height: number, withConstraints = true): Promise<any> {
		return this.send('RESIZE_NODE', { nodeId, width, height, withConstraints });
	}

	async moveNode(nodeId: string, x: number, y: number): Promise<any> {
		return this.send('MOVE_NODE', { nodeId, x, y });
	}

	async setNodeFills(nodeId: string, fills: any[]): Promise<any> {
		return this.send('SET_NODE_FILLS', { nodeId, fills });
	}

	async setNodeStrokes(nodeId: string, strokes: any[], strokeWeight?: number): Promise<any> {
		const params: any = { nodeId, strokes };
		if (strokeWeight !== undefined) params.strokeWeight = strokeWeight;
		return this.send('SET_NODE_STROKES', params);
	}

	async setNodeOpacity(nodeId: string, opacity: number): Promise<any> {
		return this.send('SET_NODE_OPACITY', { nodeId, opacity });
	}

	async setNodeCornerRadius(nodeId: string, radius: number): Promise<any> {
		return this.send('SET_NODE_CORNER_RADIUS', { nodeId, radius });
	}

	async cloneNode(nodeId: string): Promise<any> {
		return this.send('CLONE_NODE', { nodeId });
	}

	async deleteNode(nodeId: string): Promise<any> {
		return this.send('DELETE_NODE', { nodeId });
	}

	async renameNode(nodeId: string, newName: string): Promise<any> {
		return this.send('RENAME_NODE', { nodeId, newName });
	}

	async setTextContent(nodeId: string, characters: string, options?: any): Promise<any> {
		const params: any = { nodeId, text: characters };
		if (options?.fontSize) params.fontSize = options.fontSize;
		if (options?.fontWeight) params.fontWeight = options.fontWeight;
		if (options?.fontFamily) params.fontFamily = options.fontFamily;
		return this.send('SET_TEXT_CONTENT', params);
	}

	async createChildNode(parentId: string, nodeType: string, properties?: any): Promise<any> {
		return this.send('CREATE_CHILD_NODE', { parentId, nodeType, properties: properties || {} });
	}

	// Screenshot & instance properties
	async captureScreenshot(nodeId: string, options?: any): Promise<any> {
		const params: any = { nodeId };
		if (options?.format) params.format = options.format;
		if (options?.scale) params.scale = options.scale;
		return this.send('CAPTURE_SCREENSHOT', params);
	}

	async setInstanceProperties(nodeId: string, properties: any): Promise<any> {
		return this.send('SET_INSTANCE_PROPERTIES', { nodeId, properties });
	}

	// Desktop Bridge observability (remote mode)
	async ping(): Promise<any> {
		const res = await this.send('PING', {});
		return res?.data ?? res;
	}

	async getConsoleLogs(options?: { since?: number; level?: string; lines?: number }): Promise<any> {
		return this.send('GET_CONSOLE_LOGS', options ?? {});
	}

	async clearConsole(): Promise<any> {
		return this.send('CLEAR_CONSOLE', {});
	}

	async getDesignChanges(options?: { since?: number; clear?: boolean; count?: number }): Promise<any> {
		return this.send('GET_DESIGN_CHANGES', options ?? {});
	}

	async getSelection(): Promise<any> {
		return this.send('GET_SELECTION', {});
	}

	async reloadPlugin(): Promise<any> {
		return this.send('RELOAD_UI', {});
	}

	// Cache management
	clearFrameCache(): void {
		// No frame cache in Supabase relay mode
	}
}
