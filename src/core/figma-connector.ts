/**
 * Figma Connector Interface
 *
 * Transport abstraction for the WebSocket Desktop Bridge plugin.
 * Allows getDesktopConnector() to return the active WebSocket transport.
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

  // Image fill
  setImageFill(nodeIds: string[], imageData: string, scaleMode?: string): Promise<any>;

  // Design lint
  lintDesign(nodeId?: string, rules?: string[], maxDepth?: number, maxFindings?: number): Promise<any>;

  // Component accessibility audit
  auditComponentAccessibility(nodeId?: string, targetSize?: number): Promise<any>;

  // FigJam operations
  createSticky(params: { text: string; color?: string; x?: number; y?: number }): Promise<any>;
  createStickies(params: { stickies: Array<{ text: string; color?: string; x?: number; y?: number }> }): Promise<any>;
  createConnector(params: { startNodeId: string; endNodeId: string; label?: string; startMagnet?: string; endMagnet?: string }): Promise<any>;
  createShapeWithText(params: { text?: string; shapeType?: string; x?: number; y?: number; width?: number; height?: number; fillColor?: string; strokeColor?: string; fontSize?: number; strokeDashPattern?: string }): Promise<any>;
  createSection(params: { name?: string; x?: number; y?: number; width?: number; height?: number; fillColor?: string }): Promise<any>;
  createTable(params: { rows: number; columns: number; data?: string[][]; x?: number; y?: number }): Promise<any>;
  createCodeBlock(params: { code: string; language?: string; x?: number; y?: number }): Promise<any>;
  getBoardContents(params: { nodeTypes?: string[]; maxNodes?: number }): Promise<any>;
  getConnections(): Promise<any>;

  // Slides operations
  listSlides(): Promise<any>;
  getSlideContent(params: { slideId: string }): Promise<any>;
  createSlide(params: { row?: number; col?: number }): Promise<any>;
  deleteSlide(params: { slideId: string }): Promise<any>;
  duplicateSlide(params: { slideId: string }): Promise<any>;
  getSlideGrid(): Promise<any>;
  reorderSlides(params: { grid: string[][] }): Promise<any>;
  setSlideTransition(params: { slideId: string; style: string; duration: number; curve: string }): Promise<any>;
  getSlideTransition(params: { slideId: string }): Promise<any>;
  setSlidesViewMode(params: { mode: string }): Promise<any>;
  getFocusedSlide(): Promise<any>;
  focusSlide(params: { slideId: string }): Promise<any>;
  skipSlide(params: { slideId: string; skip: boolean }): Promise<any>;
  addTextToSlide(params: { slideId: string; text: string; x?: number; y?: number; fontSize?: number; fontFamily?: string; fontStyle?: string; color?: string; textAlign?: string; width?: number; lineHeight?: number; letterSpacing?: number; textCase?: string }): Promise<any>;
  addShapeToSlide(params: { slideId: string; shapeType: string; x: number; y: number; width: number; height: number; fillColor?: string }): Promise<any>;
  setSlideBackground(params: { slideId: string; color: string }): Promise<any>;
  getTextStyles(): Promise<any>;

  // Annotation operations
  getAnnotations(nodeId: string, includeChildren?: boolean, depth?: number): Promise<any>;
  setAnnotations(nodeId: string, annotations: any[], mode?: 'replace' | 'append'): Promise<any>;
  getAnnotationCategories(): Promise<any>;

  // Deep component extraction (full visual tree with tokens, interactions, instance refs)
  deepGetComponent(nodeId: string, depth?: number): Promise<any>;

  // Component set analysis (variant state machine + cross-variant diff)
  analyzeComponentSet(nodeId: string): Promise<any>;

  // Cache management
  clearFrameCache(): void;
}
