/**
 * Figma Connector Interface
 *
 * Transport abstraction that both CDP (FigmaDesktopConnector) and WebSocket
 * (WebSocketConnector) implement. Allows getDesktopConnector() to return
 * whichever transport is available — WebSocket preferred, CDP fallback.
 */

export interface IFigmaConnector {
  // Lifecycle
  initialize(): Promise<void>;
  getTransportType(): 'cdp' | 'websocket';

  // Core execution
  executeInPluginContext<T = any>(code: string): Promise<T>;
  getVariablesFromPluginUI(fileKey?: string): Promise<any>;
  getVariables(fileKey?: string): Promise<any>;
  executeCodeViaUI(code: string, timeoutMs?: number): Promise<any>;

  // Variable operations
  updateVariable(variableId: string, modeId: string, value: any): Promise<any>;
  createVariable(
    name: string,
    collectionId: string,
    resolvedType: string,
    options?: any
  ): Promise<any>;
  deleteVariable(variableId: string): Promise<any>;
  refreshVariables(): Promise<any>;
  renameVariable(variableId: string, newName: string): Promise<any>;
  setVariableDescription(variableId: string, description: string): Promise<any>;

  // Mode operations
  addMode(collectionId: string, modeName: string): Promise<any>;
  renameMode(collectionId: string, modeId: string, newName: string): Promise<any>;

  // Collection operations
  createVariableCollection(name: string, options?: any): Promise<any>;
  deleteVariableCollection(collectionId: string): Promise<any>;

  // Component operations
  getComponentFromPluginUI(nodeId: string): Promise<any>;
  getLocalComponents(): Promise<any>;
  setNodeDescription(nodeId: string, description: string, descriptionMarkdown?: string): Promise<any>;
  addComponentProperty(nodeId: string, propertyName: string, type: string, defaultValue: any, options?: any): Promise<any>;
  editComponentProperty(nodeId: string, propertyName: string, newValue: any): Promise<any>;
  deleteComponentProperty(nodeId: string, propertyName: string): Promise<any>;
  instantiateComponent(componentKey: string, options?: any): Promise<any>;

  // Node manipulation
  resizeNode(nodeId: string, width: number, height: number, withConstraints?: boolean): Promise<any>;
  moveNode(nodeId: string, x: number, y: number): Promise<any>;
  setNodeFills(nodeId: string, fills: any[]): Promise<any>;
  setNodeStrokes(nodeId: string, strokes: any[], strokeWeight?: number): Promise<any>;
  setNodeOpacity(nodeId: string, opacity: number): Promise<any>;
  setNodeCornerRadius(nodeId: string, radius: number): Promise<any>;
  cloneNode(nodeId: string): Promise<any>;
  deleteNode(nodeId: string): Promise<any>;
  renameNode(nodeId: string, newName: string): Promise<any>;
  setTextContent(nodeId: string, characters: string, options?: any): Promise<any>;
  createChildNode(parentId: string, nodeType: string, properties?: any): Promise<any>;

  // Screenshot & instance
  captureScreenshot(nodeId: string, options?: any): Promise<any>;
  setInstanceProperties(nodeId: string, properties: any): Promise<any>;

  // Cache management
  clearFrameCache(): void;
}
