// Figma Variables Bridge - MCP Plugin
// Bridges Figma Variables API to MCP clients via plugin UI window
// Uses postMessage to communicate with UI, bypassing worker sandbox limitations
// Puppeteer can access UI iframe's window context to retrieve variables data

console.log('🌉 [Variables Bridge] Plugin loaded and ready');

// Show UI to keep plugin running and receive data
figma.showUI(__html__, { width: 320, height: 200, visible: true });

// Immediately fetch and send variables data to UI
(async () => {
  try {
    console.log('🌉 [Variables Bridge] Fetching variables...');

    // Get all local variables and collections
    const variables = await figma.variables.getLocalVariablesAsync();
    const collections = await figma.variables.getLocalVariableCollectionsAsync();

    console.log(`🌉 [Variables Bridge] Found ${variables.length} variables in ${collections.length} collections`);

    // Format the data
    const variablesData = {
      success: true,
      timestamp: Date.now(),
      fileKey: figma.fileKey || null,
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

    // Send to UI via postMessage
    figma.ui.postMessage({
      type: 'VARIABLES_DATA',
      data: variablesData
    });

    console.log('🌉 [Variables Bridge] Data sent to UI successfully');
    console.log('🌉 [Variables Bridge] UI iframe now has variables data accessible via window.__figmaVariablesData');
    console.log('🌉 [Variables Bridge] Plugin will stay open until manually closed');

  } catch (error) {
    console.error('🌉 [Variables Bridge] Error fetching variables:', error);
    figma.ui.postMessage({
      type: 'ERROR',
      error: error.message || String(error)
    });
  }
})();

// Plugin stays open - no auto-close
// UI iframe remains accessible for Puppeteer to read data from window object
