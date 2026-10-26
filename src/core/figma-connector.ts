/**
 * Figma Connector Interface
 *
 * Transport abstraction for the WebSocket Desktop Bridge plugin.
 * Allows getDesktopConnector() to return the active WebSocket transport.
 */

/**
 * The outcome of a figma_execute script that finished AFTER its request was
 * already answered with a timeout. The plugin cannot cancel a running script,
 * so a timed-out figma_execute usually keeps going and applies its changes;
 * figma_execute returns these as `lateResults` on the next call.
 */
export interface LateExecuteResult {
  /** The request id named in the timeout error. */
  executionId: string;
  fileKey: string;
  /** Start of the script, whitespace-collapsed, so the caller can tell which run this was. */
  codePreview: string;
  success: boolean;
  result?: any;
  /** Set instead of `result` when the value was too large to keep. */
  resultOmitted?: string;
  error?: string;
  /** How long the script actually ran, when known. */
  durationMs?: number;
  timeoutMs?: number;
  receivedAt: number;
}

export interface ExecuteCodeOptions {
  /**
   * Keep this run's outcome if it arrives after the timeout, for
   * drainLateExecuteResults(). For user scripts (figma_execute); internal
   * callers leave it off so their late outcomes are not handed to the user.
   */
  reportLateResult?: boolean;
}

/** The timeout messages of the plugin (code.js) and its UI hop (ui.html), for plugins that predate the `timedOut` flag. */
const PLUGIN_TIMEOUT_MESSAGE = /^(?:Error: )?Execution timed out after \d+ms|^EXECUTE_CODE request timed out after \d+ms/;

/** True for an EXECUTE_CODE result that only reports a plugin-side timeout and carries no outcome of its own. */
export function isExecuteTimeoutReport(payload: any): boolean {
  if (!payload || payload.success !== false) return false;
  if (payload.timedOut === true) return true;
  return typeof payload.error === 'string' && PLUGIN_TIMEOUT_MESSAGE.test(payload.error);
}

export interface IFigmaConnector {
  // Lifecycle
  initialize(): Promise<void>;
  getTransportType(): 'websocket';

  // Core execution
  executeInPluginContext<T = any>(code: string): Promise<T>;
  getVariablesFromPluginUI(fileKey?: string): Promise<any>;
  getVariables(fileKey?: string): Promise<any>;
  executeCodeViaUI(code: string, timeoutMs?: number, fileKey?: string, options?: ExecuteCodeOptions): Promise<any>;
  /**
   * Outcomes of timed-out scripts run with `reportLateResult` that finished
   * afterwards, since the last call. Optional: Cloud Mode doesn't receive them.
   */
  drainLateExecuteResults?(): LateExecuteResult[];

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
  /**
   * Read a component through the plugin. Pass `fileKey` whenever the caller knows
   * which file it means: node ids are only unique WITHIN a file, so without it
   * the ACTIVE file answers — possibly with a different component that happens
   * to share the id. Rejects if that file isn't connected (callers fall back to REST).
   */
  getComponentFromPluginUI(nodeId: string, fileKey?: string): Promise<any>;
  getLocalComponents(): Promise<any>;
  setNodeDescription(nodeId: string, description: string, descriptionMarkdown?: string): Promise<any>;
  addComponentProperty(nodeId: string, propertyName: string, type: string, defaultValue: any, options?: any): Promise<any>;
  editComponentProperty(nodeId: string, propertyName: string, newValue: any): Promise<any>;
  deleteComponentProperty(nodeId: string, propertyName: string): Promise<any>;
  instantiateComponent(componentKey: string, options?: any): Promise<any>;
  createComponentSet(params: {
    baseComponentId?: string;
    properties?: Record<string, string[]>;
    componentIds?: string[];
    variantProperties?: Array<Record<string, string>>;
    name?: string;
    parentId?: string;
    position?: { x: number; y: number };
  }): Promise<any>;

  // Slot operations (Figma Slots open beta)
  createSlot(nodeId: string, options?: { name?: string; width?: number; height?: number; layoutMode?: string }, fileKey?: string): Promise<any>;
  getSlots(nodeId: string, fileKey?: string): Promise<any>;
  appendToSlot(params: {
    slotId?: string;
    instanceId?: string;
    slotName?: string;
    sourceNodeId?: string;
    nodeType?: string;
    properties?: Record<string, string | number>;
    clone?: boolean;
    clearExisting?: boolean;
  }, fileKey?: string): Promise<any>;
  resetSlot(params: { slotId?: string; instanceId?: string; slotName?: string }, fileKey?: string): Promise<any>;

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
  getAnnotations(nodeId: string, includeChildren?: boolean, depth?: number, fileKey?: string): Promise<any>;
  setAnnotations(nodeId: string, annotations: any[], mode?: 'replace' | 'append'): Promise<any>;
  getAnnotationCategories(): Promise<any>;

  // Deep component extraction (full visual tree with tokens, interactions, instance refs)
  deepGetComponent(nodeId: string, depth?: number): Promise<any>;

  // Component set analysis (variant state machine + cross-variant diff)
  analyzeComponentSet(nodeId: string): Promise<any>;

  // Cache management
  clearFrameCache(): void;
}
