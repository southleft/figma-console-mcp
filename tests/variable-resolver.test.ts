/**
 * Tests for bridge-first variable resolution.
 * Verifies the Desktop Bridge / cloud relay is preferred (works on any plan) and
 * the Enterprise-only REST Variables API is used only as a fallback — and that a
 * non-Enterprise 403 surfaces a bridge-pointing error instead of a dead end.
 */

import { resolveFormattedVariables } from '../src/core/variable-resolver.js';

// The Desktop Bridge returns variables/collections as ARRAYS (plugin shape).
const BRIDGE_PAYLOAD = {
  success: true,
  timestamp: 123,
  variables: [
    {
      id: 'VariableID:1', name: 'color/primary', key: 'k1', resolvedType: 'COLOR',
      valuesByMode: { m1: { r: 1, g: 0, b: 0, a: 1 } },
      variableCollectionId: 'VariableCollectionId:1', scopes: ['ALL_FILLS'], description: '',
    },
    {
      id: 'VariableID:2', name: 'space/sm', key: 'k2', resolvedType: 'FLOAT',
      valuesByMode: { m1: 8 },
      variableCollectionId: 'VariableCollectionId:1', scopes: [], description: '',
    },
  ],
  variableCollections: [
    {
      id: 'VariableCollectionId:1', name: 'Base', key: 'ck1',
      modes: [{ modeId: 'm1', name: 'Light' }], defaultModeId: 'm1',
      variableIds: ['VariableID:1', 'VariableID:2'],
    },
  ],
};

// REST returns variables/collections as OBJECTS keyed by id.
const REST_LOCAL = {
  variables: {
    'VariableID:9': {
      name: 'radius/lg', key: 'k9', resolvedType: 'FLOAT', valuesByMode: { m1: 16 },
      variableCollectionId: 'c9', scopes: [], description: '',
    },
  },
  variableCollections: {
    c9: { name: 'Radii', key: 'ck9', modes: [{ modeId: 'm1', name: 'Default' }], variableIds: ['VariableID:9'] },
  },
};

describe('resolveFormattedVariables', () => {
  it('prefers the Desktop Bridge when a connector is present (any plan), never touching REST', async () => {
    const connector = { getVariables: jest.fn().mockResolvedValue(BRIDGE_PAYLOAD) };
    const getFigmaAPI = jest.fn();

    const result = await resolveFormattedVariables({
      getDesktopConnector: async () => connector,
      getFigmaAPI: getFigmaAPI as any,
      fileKey: 'FILE',
    });

    expect(result.source).toBe('desktop_bridge');
    expect(result.variables).toHaveLength(2);
    expect(result.collections).toHaveLength(1);
    expect(result.summary.totalVariables).toBe(2);
    expect(result.summary.variablesByType).toEqual({ COLOR: 1, FLOAT: 1 });
    // arrays → keyed → formatVariables output carries the expected fields
    expect(result.variables[0]).toMatchObject({ id: 'VariableID:1', name: 'color/primary', resolvedType: 'COLOR' });
    expect(result.collections[0]).toMatchObject({ id: 'VariableCollectionId:1', name: 'Base' });
    expect(connector.getVariables).toHaveBeenCalledWith('FILE');
    expect(getFigmaAPI).not.toHaveBeenCalled(); // REST never reached
  });

  it('unwraps EXECUTE_CODE-nested responses ({ result: {...} })', async () => {
    const connector = { getVariables: jest.fn().mockResolvedValue({ success: true, result: BRIDGE_PAYLOAD }) };
    const result = await resolveFormattedVariables({
      getDesktopConnector: async () => connector,
      getFigmaAPI: (async () => { throw new Error('REST should not be called'); }) as any,
      fileKey: 'FILE',
    });
    expect(result.source).toBe('desktop_bridge');
    expect(result.variables).toHaveLength(2);
  });

  it('falls back to REST when no connector is provided', async () => {
    const api = { getLocalVariables: jest.fn().mockResolvedValue(REST_LOCAL) };
    const result = await resolveFormattedVariables({
      getFigmaAPI: (async () => api) as any,
      fileKey: 'FILE',
    });
    expect(result.source).toBe('rest_api');
    expect(result.variables).toHaveLength(1);
    expect(result.variables[0]).toMatchObject({ name: 'radius/lg', resolvedType: 'FLOAT' });
    expect(api.getLocalVariables).toHaveBeenCalledWith('FILE');
  });

  it('falls back to REST when the bridge returns no variables', async () => {
    const connector = { getVariables: jest.fn().mockResolvedValue({ success: false, error: 'plugin not connected' }) };
    const api = { getLocalVariables: jest.fn().mockResolvedValue(REST_LOCAL) };
    const result = await resolveFormattedVariables({
      getDesktopConnector: async () => connector,
      getFigmaAPI: (async () => api) as any,
      fileKey: 'FILE',
    });
    expect(result.source).toBe('rest_api');
    expect(api.getLocalVariables).toHaveBeenCalled();
  });

  it('falls back to REST when the bridge throws', async () => {
    const connector = { getVariables: jest.fn().mockRejectedValue(new Error('ws closed')) };
    const api = { getLocalVariables: jest.fn().mockResolvedValue(REST_LOCAL) };
    const result = await resolveFormattedVariables({
      getDesktopConnector: async () => connector,
      getFigmaAPI: (async () => api) as any,
      fileKey: 'FILE',
    });
    expect(result.source).toBe('rest_api');
  });

  it('throws a bridge-pointing error when no bridge AND REST 403s', async () => {
    const api = { getLocalVariables: jest.fn().mockRejectedValue(new Error('Figma API error: 403 Forbidden')) };
    await expect(
      resolveFormattedVariables({
        getFigmaAPI: (async () => api) as any,
        fileKey: 'FILE',
      }),
    ).rejects.toThrow(/Desktop Bridge|Cloud Mode|any plan/i);
  });

  it('throws the bridge-pointing error when bridge fails AND REST 403s (non-Enterprise, plugin off)', async () => {
    const connector = { getVariables: jest.fn().mockRejectedValue(new Error('no relay session')) };
    const api = { getLocalVariables: jest.fn().mockRejectedValue(new Error('403')) };
    await expect(
      resolveFormattedVariables({
        getDesktopConnector: async () => connector,
        getFigmaAPI: (async () => api) as any,
        fileKey: 'FILE',
      }),
    ).rejects.toThrow(/any plan/i);
  });
});
