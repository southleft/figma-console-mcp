/**
 * Figma REST API Client
 * Handles HTTP calls to Figma's REST API for file data, variables, components, and styles
 */

import { createChildLogger } from './logger.js';

const logger = createChildLogger({ component: 'figma-api' });

const FIGMA_API_BASE = 'https://api.figma.com/v1';

/**
 * Figma API Client Configuration
 */
export interface FigmaAPIConfig {
  accessToken: string;
}

/**
 * Extract file key from Figma URL
 * @example https://www.figma.com/design/abc123/My-File -> abc123
 */
export function extractFileKey(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // Match patterns like /design/FILE_KEY or /file/FILE_KEY
    const match = urlObj.pathname.match(/\/(design|file)\/([a-zA-Z0-9]+)/);
    return match ? match[2] : null;
  } catch (error) {
    logger.error({ error, url }, 'Failed to extract file key from URL');
    return null;
  }
}

/**
 * Figma API Client
 * Makes authenticated requests to Figma REST API
 */
export class FigmaAPI {
  private accessToken: string;

  constructor(config: FigmaAPIConfig) {
    this.accessToken = config.accessToken;
  }

  /**
   * Make authenticated request to Figma API
   */
  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `${FIGMA_API_BASE}${endpoint}`;

    // Debug logging to verify token is being used
    const tokenPreview = this.accessToken ? `${this.accessToken.substring(0, 10)}...` : 'NO TOKEN';
    logger.info({
      url,
      tokenPreview,
      hasToken: !!this.accessToken,
      tokenLength: this.accessToken?.length
    }, 'Making Figma API request with token');

    const response = await fetch(url, {
      ...options,
      headers: {
        'X-Figma-Token': this.accessToken,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, statusText: response.statusText, body: errorText },
        'Figma API request failed'
      );
      throw new Error(`Figma API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return data;
  }

  /**
   * GET /v1/files/:file_key
   * Get full file data including document tree, components, and styles
   */
  async getFile(fileKey: string, options?: {
    version?: string;
    ids?: string[];
    depth?: number;
    geometry?: 'paths' | 'screen';
    plugin_data?: string;
    branch_data?: boolean;
  }): Promise<any> {
    let endpoint = `/files/${fileKey}`;

    const params = new URLSearchParams();
    if (options?.version) params.append('version', options.version);
    if (options?.ids) params.append('ids', options.ids.join(','));
    if (options?.depth !== undefined) params.append('depth', options.depth.toString());
    if (options?.geometry) params.append('geometry', options.geometry);
    if (options?.plugin_data) params.append('plugin_data', options.plugin_data);
    if (options?.branch_data) params.append('branch_data', 'true');

    if (params.toString()) {
      endpoint += `?${params.toString()}`;
    }

    return this.request(endpoint);
  }

  /**
   * GET /v1/files/:file_key/variables/local
   * Get local variables (design tokens) from a file
   */
  async getLocalVariables(fileKey: string): Promise<any> {
    return this.request(`/files/${fileKey}/variables/local`);
  }

  /**
   * GET /v1/files/:file_key/variables/published
   * Get published variables from a file
   */
  async getPublishedVariables(fileKey: string): Promise<any> {
    return this.request(`/files/${fileKey}/variables/published`);
  }

  /**
   * GET /v1/files/:file_key/nodes
   * Get specific nodes by ID
   */
  async getNodes(fileKey: string, nodeIds: string[], options?: {
    version?: string;
    depth?: number;
    geometry?: 'paths' | 'screen';
    plugin_data?: string;
  }): Promise<any> {
    let endpoint = `/files/${fileKey}/nodes`;

    const params = new URLSearchParams();
    params.append('ids', nodeIds.join(','));
    if (options?.version) params.append('version', options.version);
    if (options?.depth !== undefined) params.append('depth', options.depth.toString());
    if (options?.geometry) params.append('geometry', options.geometry);
    if (options?.plugin_data) params.append('plugin_data', options.plugin_data);

    endpoint += `?${params.toString()}`;

    return this.request(endpoint);
  }

  /**
   * GET /v1/files/:file_key/styles
   * Get styles from a file
   */
  async getStyles(fileKey: string): Promise<any> {
    return this.request(`/files/${fileKey}/styles`);
  }

  /**
   * GET /v1/files/:file_key/components
   * Get components from a file
   */
  async getComponents(fileKey: string): Promise<any> {
    return this.request(`/files/${fileKey}/components`);
  }

  /**
   * GET /v1/files/:file_key/component_sets
   * Get component sets (variants) from a file
   */
  async getComponentSets(fileKey: string): Promise<any> {
    return this.request(`/files/${fileKey}/component_sets`);
  }

  /**
   * Helper: Get all design tokens (variables) with formatted output
   */
  async getAllVariables(fileKey: string): Promise<{
    local: any;
    published: any;
  }> {
    // Don't catch errors - let them bubble up so proper error messages are shown
    const [local, published] = await Promise.all([
      this.getLocalVariables(fileKey),
      this.getPublishedVariables(fileKey).catch(() => ({ variables: {} })), // Published can fail gracefully
    ]);

    return { local, published };
  }

  /**
   * Helper: Get component metadata with properties
   */
  async getComponentData(fileKey: string, nodeId: string): Promise<any> {
    const response = await this.getNodes(fileKey, [nodeId], { depth: 2 });
    return response.nodes?.[nodeId];
  }

  /**
   * Helper: Search for components by name
   */
  async searchComponents(fileKey: string, searchTerm: string): Promise<any[]> {
    const { meta } = await this.getComponents(fileKey);
    const components = meta?.components || [];

    return components.filter((comp: any) =>
      comp.name?.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }
}

/**
 * Helper function to format variables for display
 */
export function formatVariables(variablesData: any): {
  collections: any[];
  variables: any[];
  summary: {
    totalCollections: number;
    totalVariables: number;
    variablesByType: Record<string, number>;
  };
} {
  const collections = Object.entries(variablesData.variableCollections || {}).map(
    ([id, collection]: [string, any]) => ({
      id,
      name: collection.name,
      key: collection.key,
      modes: collection.modes,
      variableIds: collection.variableIds,
    })
  );

  const variables = Object.entries(variablesData.variables || {}).map(
    ([id, variable]: [string, any]) => ({
      id,
      name: variable.name,
      key: variable.key,
      resolvedType: variable.resolvedType,
      valuesByMode: variable.valuesByMode,
      scopes: variable.scopes,
      description: variable.description,
    })
  );

  const variablesByType = variables.reduce((acc, v) => {
    acc[v.resolvedType] = (acc[v.resolvedType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return {
    collections,
    variables,
    summary: {
      totalCollections: collections.length,
      totalVariables: variables.length,
      variablesByType,
    },
  };
}

/**
 * Helper function to format component data for display
 */
export function formatComponentData(componentNode: any): {
  id: string;
  name: string;
  type: string;
  properties?: any;
  children?: any[];
  bounds?: any;
  fills?: any[];
  strokes?: any[];
  effects?: any[];
} {
  return {
    id: componentNode.id,
    name: componentNode.name,
    type: componentNode.type,
    properties: componentNode.componentPropertyDefinitions,
    children: componentNode.children?.map((child: any) => ({
      id: child.id,
      name: child.name,
      type: child.type,
    })),
    bounds: componentNode.absoluteBoundingBox,
    fills: componentNode.fills,
    strokes: componentNode.strokes,
    effects: componentNode.effects,
  };
}
