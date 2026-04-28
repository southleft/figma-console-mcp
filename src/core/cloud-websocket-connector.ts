/**
 * Cloud WebSocket Connector
 *
 * Implements IFigmaConnector by routing commands through the PluginRelayDO
 * Durable Object. Each method maps to a command sent via fetch() RPC to
 * the relay, which forwards it to the Figma Desktop Bridge plugin over
 * WebSocket.
 *
 * Structurally mirrors WebSocketConnector — same methods, different transport.
 */

import type { IFigmaConnector } from './figma-connector.js';

interface RelayStub {
	fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export class CloudWebSocketConnector implements IFigmaConnector {
	private relayStub: RelayStub;

	constructor(relayStub: RelayStub) {
		this.relayStub = relayStub;
	}

	async initialize(): Promise<void> {
		const res = await this.relayStub.fetch('https://relay/relay/status');
		const status = await res.json() as { connected: boolean };
		if (!status.connected) {
			throw new Error(
				'No plugin connected to cloud relay. User must pair the Desktop Bridge plugin first (use figma_pair_plugin tool).'
			);
		}
	}

	getTransportType(): 'cdp' | 'websocket' {
		return 'websocket';
	}

	// ============================================================================
	// Core execution
	// ============================================================================

	async executeInPluginContext<T = any>(code: string): Promise<T> {
		return this.sendCommand('EXECUTE_CODE', { code, timeout: 5000 }, 7000);
	}

	async getVariablesFromPluginUI(fileKey?: string): Promise<any> {
		return this.sendCommand('GET_VARIABLES_DATA', {}, 10000);
	}

	async getVariables(fileKey?: string): Promise<any> {
		// IMPORTANT: bare try/catch with top-level `return`, NO inner IIFE.
		// See issue #68 + the matching note in websocket-connector.ts. The plugin
		// (code.js) wraps every EXECUTE_CODE payload in its own async IIFE; nesting
		// another swallows the inner return and silently drops the variables.
		const code = `
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
    `;
		return this.sendCommand('EXECUTE_CODE', { code, timeout: 30000 }, 32000);
	}

	async executeCodeViaUI(code: string, timeoutMs = 5000): Promise<any> {
		return this.sendCommand('EXECUTE_CODE', { code, timeout: timeoutMs }, timeoutMs + 2000);
	}

	// ============================================================================
	// Variable operations
	// ============================================================================

	async updateVariable(variableId: string, modeId: string, value: any): Promise<any> {
		return this.sendCommand('UPDATE_VARIABLE', { variableId, modeId, value });
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
		return this.sendCommand('CREATE_VARIABLE', params);
	}

	async deleteVariable(variableId: string): Promise<any> {
		return this.sendCommand('DELETE_VARIABLE', { variableId });
	}

	async refreshVariables(): Promise<any> {
		return this.sendCommand('REFRESH_VARIABLES', {}, 300000);
	}

	async renameVariable(variableId: string, newName: string): Promise<any> {
		const result = await this.sendCommand('RENAME_VARIABLE', { variableId, newName });
		if (!result.oldName && result.variable?.oldName) result.oldName = result.variable.oldName;
		return result;
	}

	async setVariableDescription(variableId: string, description: string): Promise<any> {
		return this.sendCommand('SET_VARIABLE_DESCRIPTION', { variableId, description });
	}

	// ============================================================================
	// Mode operations
	// ============================================================================

	async addMode(collectionId: string, modeName: string): Promise<any> {
		return this.sendCommand('ADD_MODE', { collectionId, modeName });
	}

	async renameMode(collectionId: string, modeId: string, newName: string): Promise<any> {
		const result = await this.sendCommand('RENAME_MODE', { collectionId, modeId, newName });
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
		return this.sendCommand('CREATE_VARIABLE_COLLECTION', params);
	}

	async deleteVariableCollection(collectionId: string): Promise<any> {
		return this.sendCommand('DELETE_VARIABLE_COLLECTION', { collectionId });
	}

	// ============================================================================
	// Component operations
	// ============================================================================

	async getComponentFromPluginUI(nodeId: string): Promise<any> {
		return this.sendCommand('GET_COMPONENT', { nodeId }, 10000);
	}

	async getLocalComponents(): Promise<any> {
		return this.sendCommand('GET_LOCAL_COMPONENTS', {}, 300000);
	}

	async setNodeDescription(nodeId: string, description: string, descriptionMarkdown?: string): Promise<any> {
		return this.sendCommand('SET_NODE_DESCRIPTION', { nodeId, description, descriptionMarkdown });
	}

	// ============================================================================
	// Annotation operations
	// ============================================================================

	async getAnnotations(nodeId: string, includeChildren?: boolean, depth?: number): Promise<any> {
		return this.sendCommand('GET_ANNOTATIONS', { nodeId, includeChildren, depth }, 10000);
	}

	async setAnnotations(nodeId: string, annotations: any[], mode?: 'replace' | 'append'): Promise<any> {
		return this.sendCommand('SET_ANNOTATIONS', { nodeId, annotations, mode: mode || 'replace' });
	}

	async getAnnotationCategories(): Promise<any> {
		return this.sendCommand('GET_ANNOTATION_CATEGORIES', {}, 5000);
	}

	async deepGetComponent(nodeId: string, depth?: number): Promise<any> {
		return this.sendCommand('DEEP_GET_COMPONENT', { nodeId, depth: depth || 10 }, 30000);
	}

	async analyzeComponentSet(nodeId: string): Promise<any> {
		return this.sendCommand('ANALYZE_COMPONENT_SET', { nodeId }, 30000);
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
		return this.sendCommand('ADD_COMPONENT_PROPERTY', params);
	}

	async editComponentProperty(nodeId: string, propertyName: string, newValue: any): Promise<any> {
		return this.sendCommand('EDIT_COMPONENT_PROPERTY', { nodeId, propertyName, newValue });
	}

	async deleteComponentProperty(nodeId: string, propertyName: string): Promise<any> {
		return this.sendCommand('DELETE_COMPONENT_PROPERTY', { nodeId, propertyName });
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
		return this.sendCommand('INSTANTIATE_COMPONENT', params);
	}

	// ============================================================================
	// Node manipulation
	// ============================================================================

	async resizeNode(nodeId: string, width: number, height: number, withConstraints = true): Promise<any> {
		return this.sendCommand('RESIZE_NODE', { nodeId, width, height, withConstraints });
	}

	async moveNode(nodeId: string, x: number, y: number): Promise<any> {
		return this.sendCommand('MOVE_NODE', { nodeId, x, y });
	}

	async setNodeFills(nodeId: string, fills: any[]): Promise<any> {
		return this.sendCommand('SET_NODE_FILLS', { nodeId, fills });
	}

	async setNodeStrokes(nodeId: string, strokes: any[], strokeWeight?: number): Promise<any> {
		const params: any = { nodeId, strokes };
		if (strokeWeight !== undefined) params.strokeWeight = strokeWeight;
		return this.sendCommand('SET_NODE_STROKES', params);
	}

	async setNodeOpacity(nodeId: string, opacity: number): Promise<any> {
		return this.sendCommand('SET_NODE_OPACITY', { nodeId, opacity });
	}

	async setNodeCornerRadius(nodeId: string, radius: number): Promise<any> {
		return this.sendCommand('SET_NODE_CORNER_RADIUS', { nodeId, radius });
	}

	async cloneNode(nodeId: string): Promise<any> {
		return this.sendCommand('CLONE_NODE', { nodeId });
	}

	async deleteNode(nodeId: string): Promise<any> {
		return this.sendCommand('DELETE_NODE', { nodeId });
	}

	async renameNode(nodeId: string, newName: string): Promise<any> {
		return this.sendCommand('RENAME_NODE', { nodeId, newName });
	}

	async setTextContent(nodeId: string, characters: string, options?: any): Promise<any> {
		const params: any = { nodeId, text: characters };
		if (options) {
			if (options.fontSize) params.fontSize = options.fontSize;
			if (options.fontWeight) params.fontWeight = options.fontWeight;
			if (options.fontFamily) params.fontFamily = options.fontFamily;
		}
		return this.sendCommand('SET_TEXT_CONTENT', params);
	}

	async createChildNode(parentId: string, nodeType: string, properties?: any): Promise<any> {
		return this.sendCommand('CREATE_CHILD_NODE', { parentId, nodeType, properties: properties || {} });
	}

	// ============================================================================
	// Screenshot & instance properties
	// ============================================================================

	async captureScreenshot(nodeId: string, options?: any): Promise<any> {
		const params: any = { nodeId };
		if (options?.format) params.format = options.format;
		if (options?.scale) params.scale = options.scale;
		return this.sendCommand('CAPTURE_SCREENSHOT', params, 30000);
	}

	async setInstanceProperties(nodeId: string, properties: any): Promise<any> {
		return this.sendCommand('SET_INSTANCE_PROPERTIES', { nodeId, properties });
	}

	// ============================================================================
	// Image fill
	// ============================================================================

	async setImageFill(nodeIds: string[], imageData: string, scaleMode = 'FILL'): Promise<any> {
		return this.sendCommand('SET_IMAGE_FILL', { nodeIds, imageData, scaleMode }, 60000);
	}

	// ============================================================================
	// Design lint
	// ============================================================================

	async lintDesign(nodeId?: string, rules?: string[], maxDepth?: number, maxFindings?: number): Promise<any> {
		const params: any = {};
		if (nodeId) params.nodeId = nodeId;
		if (rules) params.rules = rules;
		if (maxDepth !== undefined) params.maxDepth = maxDepth;
		if (maxFindings !== undefined) params.maxFindings = maxFindings;
		return this.sendCommand('LINT_DESIGN', params, 120000);
	}

	// ============================================================================
	// Component accessibility audit
	// ============================================================================

	async auditComponentAccessibility(nodeId?: string, targetSize?: number): Promise<any> {
		const params: any = {};
		if (nodeId) params.nodeId = nodeId;
		if (targetSize !== undefined) params.targetSize = targetSize;
		return this.sendCommand('AUDIT_COMPONENT_ACCESSIBILITY', params, 120000);
	}

	// ============================================================================
	// FigJam operations
	// ============================================================================

	async createSticky(params: { text: string; color?: string; x?: number; y?: number }): Promise<any> {
		return this.sendCommand('CREATE_STICKY', params);
	}

	async createStickies(params: { stickies: Array<{ text: string; color?: string; x?: number; y?: number }> }): Promise<any> {
		return this.sendCommand('CREATE_STICKIES', params, 30000);
	}

	async createConnector(params: { startNodeId: string; endNodeId: string; label?: string; startMagnet?: string; endMagnet?: string }): Promise<any> {
		return this.sendCommand('CREATE_CONNECTOR', params);
	}

	async createShapeWithText(params: { text?: string; shapeType?: string; x?: number; y?: number; width?: number; height?: number; fillColor?: string; strokeColor?: string; fontSize?: number; strokeDashPattern?: string }): Promise<any> {
		return this.sendCommand('CREATE_SHAPE_WITH_TEXT', params);
	}

	async createSection(params: { name?: string; x?: number; y?: number; width?: number; height?: number; fillColor?: string }): Promise<any> {
		return this.sendCommand('CREATE_SECTION', params);
	}

	async createTable(params: { rows: number; columns: number; data?: string[][]; x?: number; y?: number }): Promise<any> {
		return this.sendCommand('CREATE_TABLE', params, 30000);
	}

	async createCodeBlock(params: { code: string; language?: string; x?: number; y?: number }): Promise<any> {
		return this.sendCommand('CREATE_CODE_BLOCK', params);
	}

	async getBoardContents(params: { nodeTypes?: string[]; maxNodes?: number }): Promise<any> {
		return this.sendCommand('GET_BOARD_CONTENTS', params, 30000);
	}

	async getConnections(): Promise<any> {
		return this.sendCommand('GET_CONNECTIONS', {}, 15000);
	}

	// ============================================================================
	// Slides operations
	// ============================================================================

	async listSlides(): Promise<any> {
		return this.sendCommand('LIST_SLIDES', {}, 10000);
	}

	async getSlideContent(params: { slideId: string }): Promise<any> {
		return this.sendCommand('GET_SLIDE_CONTENT', params, 10000);
	}

	async createSlide(params: { row?: number; col?: number }): Promise<any> {
		return this.sendCommand('CREATE_SLIDE', params, 10000);
	}

	async deleteSlide(params: { slideId: string }): Promise<any> {
		return this.sendCommand('DELETE_SLIDE', params, 5000);
	}

	async duplicateSlide(params: { slideId: string }): Promise<any> {
		return this.sendCommand('DUPLICATE_SLIDE', params, 5000);
	}

	async getSlideGrid(): Promise<any> {
		return this.sendCommand('GET_SLIDE_GRID', {}, 10000);
	}

	async reorderSlides(params: { grid: string[][] }): Promise<any> {
		return this.sendCommand('REORDER_SLIDES', params, 15000);
	}

	async setSlideTransition(params: { slideId: string; style: string; duration: number; curve: string }): Promise<any> {
		return this.sendCommand('SET_SLIDE_TRANSITION', params, 5000);
	}

	async getSlideTransition(params: { slideId: string }): Promise<any> {
		return this.sendCommand('GET_SLIDE_TRANSITION', params, 5000);
	}

	async setSlidesViewMode(params: { mode: string }): Promise<any> {
		return this.sendCommand('SET_SLIDES_VIEW_MODE', params, 5000);
	}

	async getFocusedSlide(): Promise<any> {
		return this.sendCommand('GET_FOCUSED_SLIDE', {}, 5000);
	}

	async focusSlide(params: { slideId: string }): Promise<any> {
		return this.sendCommand('FOCUS_SLIDE', params, 5000);
	}

	async skipSlide(params: { slideId: string; skip: boolean }): Promise<any> {
		return this.sendCommand('SKIP_SLIDE', params, 5000);
	}

	async addTextToSlide(params: { slideId: string; text: string; x?: number; y?: number; fontSize?: number; fontFamily?: string; fontStyle?: string; color?: string; textAlign?: string; width?: number; lineHeight?: number; letterSpacing?: number; textCase?: string }): Promise<any> {
		return this.sendCommand('ADD_TEXT_TO_SLIDE', params, 10000);
	}

	async addShapeToSlide(params: { slideId: string; shapeType: string; x: number; y: number; width: number; height: number; fillColor?: string }): Promise<any> {
		return this.sendCommand('ADD_SHAPE_TO_SLIDE', params, 5000);
	}

	async setSlideBackground(params: { slideId: string; color: string }): Promise<any> {
		return this.sendCommand('SET_SLIDE_BACKGROUND', params, 5000);
	}

	async getTextStyles(): Promise<any> {
		return this.sendCommand('GET_TEXT_STYLES', {}, 5000);
	}

	// ============================================================================
	// Cache management (no-op for cloud relay)
	// ============================================================================

	clearFrameCache(): void {
		// No frame cache in cloud relay mode
	}

	// ============================================================================
	// Transport — fetch-based RPC to the relay DO
	// ============================================================================

	private async sendCommand(
		method: string,
		params: Record<string, any> = {},
		timeoutMs = 15000,
	): Promise<any> {
		const res = await this.relayStub.fetch('https://relay/relay/command', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ method, params, timeoutMs }),
		});

		const data = await res.json() as { result?: any; error?: string };

		if (data.error) {
			throw new Error(data.error);
		}

		return data.result;
	}
}
