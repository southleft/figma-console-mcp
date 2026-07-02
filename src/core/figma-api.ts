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
 * Branch-aware: for branch URLs (/design/KEY/branch/BRANCHKEY/Name) returns the
 * BRANCH key — the branch is its own file in the REST API, and returning the
 * main key would silently target the wrong file (comments/diffs/file-data).
 * @example https://www.figma.com/design/abc123/My-File -> abc123
 * @example https://www.figma.com/design/abc123/branch/xyz789/My-File -> xyz789
 */
export function extractFileKey(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // Branch URLs: /design/FILE_KEY/branch/BRANCH_KEY — the branch key is the
    // effective file key for all REST API calls.
    const branchMatch = urlObj.pathname.match(/\/(design|file|board|slides)\/[a-zA-Z0-9]+\/branch\/([a-zA-Z0-9]+)/);
    if (branchMatch) {
      return branchMatch[2];
    }
    // Match patterns like /design/FILE_KEY, /file/FILE_KEY, /board/FILE_KEY (FigJam), /slides/FILE_KEY
    const match = urlObj.pathname.match(/\/(design|file|board|slides)\/([a-zA-Z0-9]+)/);
    return match ? match[2] : null;
  } catch (error) {
    logger.error({ error, url }, 'Failed to extract file key from URL');
    return null;
  }
}

/**
 * Normalize a node ID to Figma's canonical colon form.
 * URLs use dashes ("695-313") but the REST API keys response maps by colon
 * form ("695:313") — indexing a response with a dashed ID silently returns
 * undefined, which reads as "node may not exist".
 */
export function normalizeNodeId(nodeId: string): string {
  return nodeId.replace(/-/g, ':');
}

/**
 * Information extracted from a Figma URL
 * Includes file key, optional branch ID, and optional node ID
 */
export interface FigmaUrlInfo {
  fileKey: string;
  branchId?: string;
  nodeId?: string;
}

/**
 * Extract comprehensive URL info including branch and node IDs
 * Supports both URL formats:
 * - Path-based: /design/{fileKey}/branch/{branchKey}/{fileName}
 * - Query-based: /design/{fileKey}/{fileName}?branch-id={branchId}
 *
 * @example https://www.figma.com/design/abc123/branch/xyz789/My-File?node-id=1-2
 *   -> { fileKey: 'abc123', branchId: 'xyz789', nodeId: '1:2' }
 * @example https://www.figma.com/design/abc123/My-File?branch-id=xyz789&node-id=1-2
 *   -> { fileKey: 'abc123', branchId: 'xyz789', nodeId: '1:2' }
 */
export function extractFigmaUrlInfo(url: string): FigmaUrlInfo | null {
  try {
    const urlObj = new URL(url);

    // First try: Path-based branch format /design/{fileKey}/branch/{branchKey}/{fileName}
    const branchPathMatch = urlObj.pathname.match(/\/(design|file|board|slides)\/([a-zA-Z0-9]+)\/branch\/([a-zA-Z0-9]+)/);
    if (branchPathMatch) {
      const fileKey = branchPathMatch[2];
      const branchId = branchPathMatch[3];
      const nodeIdParam = urlObj.searchParams.get('node-id');
      const nodeId = nodeIdParam ? nodeIdParam.replace(/-/g, ':') : undefined;

      return { fileKey, branchId, nodeId };
    }

    // Second try: Standard format /design/{fileKey}/{fileName} with optional ?branch-id=
    const standardMatch = urlObj.pathname.match(/\/(design|file|board|slides)\/([a-zA-Z0-9]+)/);
    if (!standardMatch) return null;

    const fileKey = standardMatch[2];
    const branchId = urlObj.searchParams.get('branch-id') || undefined;
    const nodeIdParam = urlObj.searchParams.get('node-id');
    // Convert node-id from URL format (1-2) to Figma format (1:2)
    const nodeId = nodeIdParam ? nodeIdParam.replace(/-/g, ':') : undefined;

    return { fileKey, branchId, nodeId };
  } catch (error) {
    logger.error({ error, url }, 'Failed to extract Figma URL info');
    return null;
  }
}

/**
 * Wrap a promise with a timeout
 * @param promise The promise to wrap
 * @param ms Timeout in milliseconds
 * @param label Label for error message
 * @returns Promise that rejects if timeout exceeded
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    // Ensure timeout is cleared if promise resolves/rejects first.
    // The .catch() prevents an unhandled rejection when the original
    // promise rejects — .finally() returns a new promise that inherits
    // the rejection, and without .catch() it becomes unhandled.
    promise.finally(() => clearTimeout(timeoutId)).catch(() => {});
  });
  return Promise.race([promise, timeoutPromise]);
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

    // Detect token type and use appropriate authentication header
    // OAuth tokens start with 'figu_' and require Authorization: Bearer header
    // Personal Access Tokens use X-Figma-Token header
    const isOAuthToken = this.accessToken.startsWith('figu_');

    logger.debug({ url, authMethod: isOAuthToken ? 'Bearer' : 'X-Figma-Token' }, 'Making Figma API request');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    // Add authentication header based on token type
    if (isOAuthToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    } else {
      headers['X-Figma-Token'] = this.accessToken;
    }

    // Up to 3 total attempts on 429 (rate limit), honoring Retry-After when
    // present (seconds), else exponential backoff (1s, 2s). Delays here run
    // inside the request promise — callers wrapping with withTimeout() still
    // get their race-based rejection if the overall wait exceeds their budget.
    const MAX_ATTEMPTS = 3;
    let response: Response;
    for (let attempt = 1; ; attempt++) {
      response = await fetch(url, {
        ...options,
        headers,
      });

      if (response.status !== 429 || attempt >= MAX_ATTEMPTS) {
        break;
      }

      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      // Cap Retry-After waits at 30s so a pathological header can't hang callers.
      const delayMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(retryAfterSeconds, 30) * 1000
          : attempt * 1000; // 1s after attempt 1, 2s after attempt 2
      logger.warn(
        { url, attempt, delayMs, retryAfterHeader },
        'Figma API rate limited (429), retrying'
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, statusText: response.statusText, body: errorText },
        'Figma API request failed'
      );

      // The `Figma API error (<status>):` prefix is LOAD-BEARING — downstream
      // tool handlers branch on errorMessage.includes("403") etc. Keep it
      // verbatim at the start of the message; only APPEND guidance after it.
      let message = `Figma API error (${response.status}): ${errorText}`;

      // Token-auth failures (expired/invalid token) get actionable guidance.
      // Plan-gate 403s (e.g. Variables API on non-Enterprise) do NOT match the
      // token pattern and must not be flagged as auth errors.
      const isAuthError =
        (response.status === 401 || response.status === 403) &&
        /invalid token|token expired|unauthorized/i.test(errorText);

      if (isAuthError) {
        message +=
          ' — Your Figma access token is expired or invalid. Generate a new personal access token at figma.com → Settings → Security → Personal access tokens, then update FIGMA_ACCESS_TOKEN in your MCP config. If Figma Desktop is open with the Desktop Bridge plugin running, most tools work without any REST token.';
      } else if (response.status === 429) {
        message += ' Rate limited by Figma — wait a moment and retry.';
      }

      const err = new Error(message);
      (err as any).status = response.status;
      if (isAuthError) {
        (err as any).isAuthError = true;
      }
      throw err;
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
    const response = await this.request(`/files/${fileKey}/variables/local`);
    // Figma API returns {status, error, meta: {variableCollections, variables}}
    // Extract meta to match expected format
    return response.meta || response;
  }

  /**
   * GET /v1/files/:file_key/variables/published
   * Get published variables from a file
   */
  async getPublishedVariables(fileKey: string): Promise<any> {
    const response = await this.request(`/files/${fileKey}/variables/published`);
    // Figma API returns {status, error, meta: {variableCollections, variables}}
    // Extract meta to match expected format
    return response.meta || response;
  }

  /**
   * GET /v1/files/:file_key/nodes
   * Get specific nodes by ID
   *
   * Node IDs are normalized to Figma's colon form ("695-313" -> "695:313")
   * before the request, and the response map is aliased back under any
   * dashed IDs the caller passed — Figma keys the response by colon-format
   * IDs, so without the alias a dashed lookup silently returns undefined.
   */
  async getNodes(fileKey: string, nodeIds: string[], options?: {
    version?: string;
    depth?: number;
    geometry?: 'paths' | 'screen';
    plugin_data?: string;
  }): Promise<any> {
    let endpoint = `/files/${fileKey}/nodes`;

    const normalizedIds = nodeIds.map((id) => normalizeNodeId(id));

    const params = new URLSearchParams();
    params.append('ids', normalizedIds.join(','));
    if (options?.version) params.append('version', options.version);
    if (options?.depth !== undefined) params.append('depth', options.depth.toString());
    if (options?.geometry) params.append('geometry', options.geometry);
    if (options?.plugin_data) params.append('plugin_data', options.plugin_data);

    endpoint += `?${params.toString()}`;

    const response = await this.request(endpoint);

    // Defensive aliasing: let callers index response.nodes by the ID form
    // they originally passed (dashed), not just Figma's colon form.
    if (response?.nodes) {
      for (let i = 0; i < nodeIds.length; i++) {
        const original = nodeIds[i];
        const normalized = normalizedIds[i];
        if (original !== normalized && response.nodes[normalized] !== undefined && response.nodes[original] === undefined) {
          response.nodes[original] = response.nodes[normalized];
        }
      }
    }

    return response;
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
   * GET /v1/components/:key
   * Get metadata for a single published component by its key.
   * Returns { status, error, meta: PublishedComponent } where meta includes
   * file_key, node_id, name, description, containing_frame, user, etc.
   * Use this to resolve a componentKey (from search results) to its source file.
   */
  async getComponentByKey(key: string): Promise<any> {
    return this.request(`/components/${key}`);
  }

  /**
   * GET /v1/component_sets/:key
   * Get metadata for a single published component set (variant container) by its key.
   * Returns { status, error, meta: PublishedComponentSet } with the same fields
   * as getComponentByKey. The node_id points to the parent COMPONENT_SET node.
   */
  async getComponentSetByKey(key: string): Promise<any> {
    return this.request(`/component_sets/${key}`);
  }

	/**
	 * GET /v1/images/:file_key
	 * Renders images for specified nodes
	 * @param fileKey - The file key
	 * @param nodeIds - Node IDs to render (single string or array)
	 * @param options - Rendering options
	 * @returns Map of node IDs to image URLs (URLs expire after 30 days)
	 */
	async getImages(
		fileKey: string,
		nodeIds: string | string[],
		options?: {
			scale?: number; // 0.01-4, default 1
			format?: 'png' | 'jpg' | 'svg' | 'pdf'; // default png
			svg_outline_text?: boolean; // default true
			svg_include_id?: boolean; // default false
			svg_include_node_id?: boolean; // default false
			svg_simplify_stroke?: boolean; // default true
			contents_only?: boolean; // default true
		}
	): Promise<{ images: Record<string, string | null> }> {
		const params = new URLSearchParams();

		// Handle single or multiple node IDs. Normalize to Figma's colon form
		// ("695-313" -> "695:313") — the response map is keyed by colon IDs, so
		// a dashed request ID would otherwise never match its own result.
		const originalIds = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
		const normalizedIds = originalIds.map((id) => normalizeNodeId(id));
		const ids = normalizedIds.join(',');
		params.append('ids', ids);

		// Add optional parameters
		if (options?.scale !== undefined) params.append('scale', options.scale.toString());
		if (options?.format) params.append('format', options.format);
		if (options?.svg_outline_text !== undefined)
			params.append('svg_outline_text', options.svg_outline_text.toString());
		if (options?.svg_include_id !== undefined)
			params.append('svg_include_id', options.svg_include_id.toString());
		if (options?.svg_include_node_id !== undefined)
			params.append('svg_include_node_id', options.svg_include_node_id.toString());
		if (options?.svg_simplify_stroke !== undefined)
			params.append('svg_simplify_stroke', options.svg_simplify_stroke.toString());
		if (options?.contents_only !== undefined)
			params.append('contents_only', options.contents_only.toString());

		const endpoint = `/images/${fileKey}?${params.toString()}`;

		logger.info({ fileKey, ids, options }, 'Rendering images');

		const response = await this.request(endpoint);

		// Defensive aliasing: callers may index the images map by the dashed
		// ID they passed. Figma keys it by colon-format ID — alias both forms.
		if (response?.images) {
			for (let i = 0; i < originalIds.length; i++) {
				const original = originalIds[i];
				const normalized = normalizedIds[i];
				if (original !== normalized && response.images[normalized] !== undefined && response.images[original] === undefined) {
					response.images[original] = response.images[normalized];
				}
			}
		}

		return response;
	}

  /**
   * GET /v1/files/:file_key/comments
   * Get comments on a file
   */
  async getComments(fileKey: string, options?: { as_md?: boolean }): Promise<any> {
    const params = new URLSearchParams();
    if (options?.as_md) params.set('as_md', 'true');
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/files/${fileKey}/comments${query}`);
  }

  /**
   * POST /v1/files/:file_key/comments
   * Post a comment on a file
   */
  async postComment(
    fileKey: string,
    message: string,
    clientMeta?: { node_id?: string; node_offset?: { x: number; y: number } },
    commentId?: string,
  ): Promise<any> {
    return this.request(`/files/${fileKey}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        message,
        ...(clientMeta && { client_meta: clientMeta }),
        ...(commentId && { comment_id: commentId }),
      }),
    });
  }

  /**
   * DELETE /v1/files/:file_key/comments/:comment_id
   * Delete a comment on a file
   */
  async deleteComment(fileKey: string, commentId: string): Promise<any> {
    return this.request(`/files/${fileKey}/comments/${commentId}`, {
      method: 'DELETE',
    });
  }

  /**
   * GET /v1/files/:file_key/versions
   * List a file's version history. Cursor-style pagination via before/after
   * (cursors are version IDs). Response includes pagination.prev_page and
   * pagination.next_page as full URLs — Figma recommends following those
   * directly rather than reconstructing cursors. Requires the
   * `file_versions:read` OAuth scope (or PAT "Versions" Read permission).
   */
  async getFileVersions(
    fileKey: string,
    options?: {
      page_size?: number;  // 1–50, default 30
      before?: string;     // version id cursor — returns earlier versions
      after?: string;      // version id cursor — returns later versions
    },
  ): Promise<{
    versions: Array<{
      id: string;
      created_at: string;
      label: string;
      description: string;
      user: { id: string; handle: string; img_url: string };
    }>;
    pagination?: {
      prev_page?: string;
      next_page?: string;
    };
  }> {
    const params = new URLSearchParams();
    if (options?.page_size !== undefined) params.set('page_size', String(options.page_size));
    if (options?.before) params.set('before', options.before);
    if (options?.after) params.set('after', options.after);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/files/${fileKey}/versions${query}`);
  }

  /**
   * Helper: Get all design tokens (variables) with formatted output
   * Both local and published can fail gracefully (e.g., 403 without Enterprise plan)
   */
  async getAllVariables(fileKey: string): Promise<{
    local: any;
    published: any;
    localError?: string;
    publishedError?: string;
  }> {
    // Wrap both in catch handlers to prevent unhandled promise rejections
    // which can crash the server when REST API returns 403
    const [localResult, publishedResult] = await Promise.all([
      this.getLocalVariables(fileKey).catch((err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ fileKey, error: errorMsg }, 'getLocalVariables failed; returning empty fallback');
        return { error: errorMsg, variables: {}, variableCollections: {} };
      }),
      this.getPublishedVariables(fileKey).catch((err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ fileKey, error: errorMsg }, 'getPublishedVariables failed; returning empty fallback');
        return { error: errorMsg, variables: {} };
      }),
    ]);

    // Fallback shape must match the success path (already-unwrapped meta):
    // { variables, variableCollections } — NOT { meta: {...} } — so consumers
    // like formatVariables() see a consistent shape either way.
    return {
      local: 'error' in localResult ? { variables: {}, variableCollections: {} } : localResult,
      published: 'error' in publishedResult ? { variables: {} } : publishedResult,
      ...(('error' in localResult) && { localError: localResult.error }),
      ...(('error' in publishedResult) && { publishedError: publishedResult.error }),
    };
  }

  /**
   * Helper: Get component metadata with properties
   * Normalizes dashed node IDs ("695-313") to colon form ("695:313") so the
   * response-map lookup matches Figma's colon-keyed response.
   */
  async getComponentData(fileKey: string, nodeId: string, depth = 4): Promise<any> {
    const normalizedId = normalizeNodeId(nodeId);
    const response = await this.getNodes(fileKey, [normalizedId], { depth });
    return response.nodes?.[normalizedId] ?? response.nodes?.[nodeId];
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
      variableCollectionId: variable.variableCollectionId,
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
  description?: string;
  descriptionMarkdown?: string;
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
    description: componentNode.description,
    descriptionMarkdown: componentNode.descriptionMarkdown,
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
