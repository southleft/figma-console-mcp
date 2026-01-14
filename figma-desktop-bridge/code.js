// Figma Desktop Bridge - MCP Plugin
// Bridges Figma API to MCP clients via plugin UI window
// Supports: Variables, Components, Styles, and more
// Uses postMessage to communicate with UI, bypassing worker sandbox limitations
// Puppeteer can access UI iframe's window context to retrieve data

console.log('🌉 [Desktop Bridge] Plugin loaded and ready');

// Show UI to keep plugin running and receive data
figma.showUI(__html__, { width: 320, height: 240, visible: true });

// Immediately fetch and send variables data to UI
(async () => {
  try {
    console.log('🌉 [Desktop Bridge] Fetching variables...');

    // Get all local variables and collections
    const variables = await figma.variables.getLocalVariablesAsync();
    const collections = await figma.variables.getLocalVariableCollectionsAsync();

    console.log(`🌉 [Desktop Bridge] Found ${variables.length} variables in ${collections.length} collections`);

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

    console.log('🌉 [Desktop Bridge] Variables data sent to UI successfully');
    console.log('🌉 [Desktop Bridge] UI iframe now has variables data accessible via window.__figmaVariablesData');

  } catch (error) {
    console.error('🌉 [Desktop Bridge] Error fetching variables:', error);
    figma.ui.postMessage({
      type: 'ERROR',
      error: error.message || String(error)
    });
  }
})();

// Helper function to serialize a variable for response
function serializeVariable(v) {
  return {
    id: v.id,
    name: v.name,
    key: v.key,
    resolvedType: v.resolvedType,
    valuesByMode: v.valuesByMode,
    variableCollectionId: v.variableCollectionId,
    scopes: v.scopes,
    description: v.description,
    hiddenFromPublishing: v.hiddenFromPublishing
  };
}

// Helper function to serialize a collection for response
function serializeCollection(c) {
  return {
    id: c.id,
    name: c.name,
    key: c.key,
    modes: c.modes,
    defaultModeId: c.defaultModeId,
    variableIds: c.variableIds
  };
}

// Helper to convert hex color to Figma RGB (0-1 range)
function hexToFigmaRGB(hex) {
  // Remove # if present
  hex = hex.replace(/^#/, '');

  // Validate hex characters BEFORE parsing (prevents NaN values)
  if (!/^[0-9A-Fa-f]+$/.test(hex)) {
    throw new Error('Invalid hex color: "' + hex + '" contains non-hex characters. Use only 0-9 and A-F.');
  }

  // Parse hex values
  var r, g, b, a = 1;

  if (hex.length === 3) {
    // #RGB format
    r = parseInt(hex[0] + hex[0], 16) / 255;
    g = parseInt(hex[1] + hex[1], 16) / 255;
    b = parseInt(hex[2] + hex[2], 16) / 255;
  } else if (hex.length === 4) {
    // #RGBA format (CSS4 shorthand)
    r = parseInt(hex[0] + hex[0], 16) / 255;
    g = parseInt(hex[1] + hex[1], 16) / 255;
    b = parseInt(hex[2] + hex[2], 16) / 255;
    a = parseInt(hex[3] + hex[3], 16) / 255;
  } else if (hex.length === 6) {
    // #RRGGBB format
    r = parseInt(hex.substring(0, 2), 16) / 255;
    g = parseInt(hex.substring(2, 4), 16) / 255;
    b = parseInt(hex.substring(4, 6), 16) / 255;
  } else if (hex.length === 8) {
    // #RRGGBBAA format
    r = parseInt(hex.substring(0, 2), 16) / 255;
    g = parseInt(hex.substring(2, 4), 16) / 255;
    b = parseInt(hex.substring(4, 6), 16) / 255;
    a = parseInt(hex.substring(6, 8), 16) / 255;
  } else {
    throw new Error('Invalid hex color format: "' + hex + '". Expected 3, 4, 6, or 8 hex characters (e.g., #RGB, #RGBA, #RRGGBB, #RRGGBBAA).');
  }

  return { r: r, g: g, b: b, a: a };
}

// Listen for requests from UI (e.g., component data requests, write operations)
figma.ui.onmessage = async (msg) => {

  // ============================================================================
  // EXECUTE_CODE - Arbitrary code execution (Power Tool)
  // ============================================================================
  if (msg.type === 'EXECUTE_CODE') {
    try {
      console.log('🌉 [Desktop Bridge] Executing code, length:', msg.code.length);

      // Use eval with async IIFE wrapper instead of AsyncFunction constructor
      // AsyncFunction is restricted in Figma's plugin sandbox, but eval works
      // See: https://developers.figma.com/docs/plugins/resource-links

      // Wrap user code in an async IIFE that returns a Promise
      // This allows async/await in user code while using eval
      var wrappedCode = "(async function() {\n" + msg.code + "\n})()";

      console.log('🌉 [Desktop Bridge] Wrapped code for eval');

      // Execute with timeout
      var timeoutMs = msg.timeout || 5000;
      var timeoutPromise = new Promise(function(_, reject) {
        setTimeout(function() {
          reject(new Error('Execution timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);
      });

      var codePromise;
      try {
        // eval returns the Promise from the async IIFE
        codePromise = eval(wrappedCode);
      } catch (syntaxError) {
        // Log the actual syntax error message
        var syntaxErrorMsg = syntaxError && syntaxError.message ? syntaxError.message : String(syntaxError);
        console.error('🌉 [Desktop Bridge] Syntax error in code:', syntaxErrorMsg);
        figma.ui.postMessage({
          type: 'EXECUTE_CODE_RESULT',
          requestId: msg.requestId,
          success: false,
          error: 'Syntax error: ' + syntaxErrorMsg
        });
        return;
      }

      var result = await Promise.race([
        codePromise,
        timeoutPromise
      ]);

      console.log('🌉 [Desktop Bridge] Code executed successfully, result type:', typeof result);

      figma.ui.postMessage({
        type: 'EXECUTE_CODE_RESULT',
        requestId: msg.requestId,
        success: true,
        result: result
      });

    } catch (error) {
      // Extract error message explicitly - don't rely on console.error serialization
      var errorName = error && error.name ? error.name : 'Error';
      var errorMsg = error && error.message ? error.message : String(error);
      var errorStack = error && error.stack ? error.stack : '';

      // Log error details as strings so they show up properly in Puppeteer
      console.error('🌉 [Desktop Bridge] Code execution error: [' + errorName + '] ' + errorMsg);
      if (errorStack) {
        console.error('🌉 [Desktop Bridge] Stack:', errorStack);
      }

      figma.ui.postMessage({
        type: 'EXECUTE_CODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorName + ': ' + errorMsg
      });
    }
  }

  // ============================================================================
  // UPDATE_VARIABLE - Update a variable's value in a specific mode
  // ============================================================================
  else if (msg.type === 'UPDATE_VARIABLE') {
    try {
      console.log('🌉 [Desktop Bridge] Updating variable:', msg.variableId);

      var variable = await figma.variables.getVariableByIdAsync(msg.variableId);
      if (!variable) {
        throw new Error('Variable not found: ' + msg.variableId);
      }

      // Convert value based on variable type
      var value = msg.value;
      if (variable.resolvedType === 'COLOR' && typeof value === 'string') {
        // Convert hex string to Figma color
        value = hexToFigmaRGB(value);
      }

      // Set the value for the specified mode
      variable.setValueForMode(msg.modeId, value);

      console.log('🌉 [Desktop Bridge] Variable updated successfully');

      figma.ui.postMessage({
        type: 'UPDATE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: true,
        variable: serializeVariable(variable)
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Update variable error:', error);
      figma.ui.postMessage({
        type: 'UPDATE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // CREATE_VARIABLE - Create a new variable in a collection
  // ============================================================================
  else if (msg.type === 'CREATE_VARIABLE') {
    try {
      console.log('🌉 [Desktop Bridge] Creating variable:', msg.name);

      // Get the collection
      var collection = await figma.variables.getVariableCollectionByIdAsync(msg.collectionId);
      if (!collection) {
        throw new Error('Collection not found: ' + msg.collectionId);
      }

      // Create the variable
      var variable = figma.variables.createVariable(msg.name, collection, msg.resolvedType);

      // Set initial values if provided
      if (msg.valuesByMode) {
        for (var modeId in msg.valuesByMode) {
          var value = msg.valuesByMode[modeId];
          // Convert hex colors
          if (msg.resolvedType === 'COLOR' && typeof value === 'string') {
            value = hexToFigmaRGB(value);
          }
          variable.setValueForMode(modeId, value);
        }
      }

      // Set description if provided
      if (msg.description) {
        variable.description = msg.description;
      }

      // Set scopes if provided
      if (msg.scopes) {
        variable.scopes = msg.scopes;
      }

      console.log('🌉 [Desktop Bridge] Variable created:', variable.id);

      figma.ui.postMessage({
        type: 'CREATE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: true,
        variable: serializeVariable(variable)
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create variable error:', error);
      figma.ui.postMessage({
        type: 'CREATE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // CREATE_VARIABLE_COLLECTION - Create a new variable collection
  // ============================================================================
  else if (msg.type === 'CREATE_VARIABLE_COLLECTION') {
    try {
      console.log('🌉 [Desktop Bridge] Creating collection:', msg.name);

      // Create the collection
      var collection = figma.variables.createVariableCollection(msg.name);

      // Rename the default mode if a name is provided
      if (msg.initialModeName && collection.modes.length > 0) {
        collection.renameMode(collection.modes[0].modeId, msg.initialModeName);
      }

      // Add additional modes if provided
      if (msg.additionalModes && msg.additionalModes.length > 0) {
        for (var i = 0; i < msg.additionalModes.length; i++) {
          collection.addMode(msg.additionalModes[i]);
        }
      }

      console.log('🌉 [Desktop Bridge] Collection created:', collection.id);

      figma.ui.postMessage({
        type: 'CREATE_VARIABLE_COLLECTION_RESULT',
        requestId: msg.requestId,
        success: true,
        collection: serializeCollection(collection)
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create collection error:', error);
      figma.ui.postMessage({
        type: 'CREATE_VARIABLE_COLLECTION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // DELETE_VARIABLE - Delete a variable
  // ============================================================================
  else if (msg.type === 'DELETE_VARIABLE') {
    try {
      console.log('🌉 [Desktop Bridge] Deleting variable:', msg.variableId);

      var variable = await figma.variables.getVariableByIdAsync(msg.variableId);
      if (!variable) {
        throw new Error('Variable not found: ' + msg.variableId);
      }

      var deletedInfo = {
        id: variable.id,
        name: variable.name
      };

      variable.remove();

      console.log('🌉 [Desktop Bridge] Variable deleted');

      figma.ui.postMessage({
        type: 'DELETE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: true,
        deleted: deletedInfo
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Delete variable error:', error);
      figma.ui.postMessage({
        type: 'DELETE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // DELETE_VARIABLE_COLLECTION - Delete a variable collection
  // ============================================================================
  else if (msg.type === 'DELETE_VARIABLE_COLLECTION') {
    try {
      console.log('🌉 [Desktop Bridge] Deleting collection:', msg.collectionId);

      var collection = await figma.variables.getVariableCollectionByIdAsync(msg.collectionId);
      if (!collection) {
        throw new Error('Collection not found: ' + msg.collectionId);
      }

      var deletedInfo = {
        id: collection.id,
        name: collection.name,
        variableCount: collection.variableIds.length
      };

      collection.remove();

      console.log('🌉 [Desktop Bridge] Collection deleted');

      figma.ui.postMessage({
        type: 'DELETE_VARIABLE_COLLECTION_RESULT',
        requestId: msg.requestId,
        success: true,
        deleted: deletedInfo
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Delete collection error:', error);
      figma.ui.postMessage({
        type: 'DELETE_VARIABLE_COLLECTION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // RENAME_VARIABLE - Rename a variable
  // ============================================================================
  else if (msg.type === 'RENAME_VARIABLE') {
    try {
      console.log('🌉 [Desktop Bridge] Renaming variable:', msg.variableId, 'to', msg.newName);

      var variable = await figma.variables.getVariableByIdAsync(msg.variableId);
      if (!variable) {
        throw new Error('Variable not found: ' + msg.variableId);
      }

      var oldName = variable.name;
      variable.name = msg.newName;

      console.log('🌉 [Desktop Bridge] Variable renamed from "' + oldName + '" to "' + msg.newName + '"');

      figma.ui.postMessage({
        type: 'RENAME_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: true,
        variable: serializeVariable(variable),
        oldName: oldName
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Rename variable error:', error);
      figma.ui.postMessage({
        type: 'RENAME_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // ADD_MODE - Add a mode to a variable collection
  // ============================================================================
  else if (msg.type === 'ADD_MODE') {
    try {
      console.log('🌉 [Desktop Bridge] Adding mode to collection:', msg.collectionId);

      var collection = await figma.variables.getVariableCollectionByIdAsync(msg.collectionId);
      if (!collection) {
        throw new Error('Collection not found: ' + msg.collectionId);
      }

      // Add the mode (returns the new mode ID)
      var newModeId = collection.addMode(msg.modeName);

      console.log('🌉 [Desktop Bridge] Mode "' + msg.modeName + '" added with ID:', newModeId);

      figma.ui.postMessage({
        type: 'ADD_MODE_RESULT',
        requestId: msg.requestId,
        success: true,
        collection: serializeCollection(collection),
        newMode: {
          modeId: newModeId,
          name: msg.modeName
        }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Add mode error:', error);
      figma.ui.postMessage({
        type: 'ADD_MODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // RENAME_MODE - Rename a mode in a variable collection
  // ============================================================================
  else if (msg.type === 'RENAME_MODE') {
    try {
      console.log('🌉 [Desktop Bridge] Renaming mode:', msg.modeId, 'in collection:', msg.collectionId);

      var collection = await figma.variables.getVariableCollectionByIdAsync(msg.collectionId);
      if (!collection) {
        throw new Error('Collection not found: ' + msg.collectionId);
      }

      // Find the current mode name
      var currentMode = collection.modes.find(function(m) { return m.modeId === msg.modeId; });
      if (!currentMode) {
        throw new Error('Mode not found: ' + msg.modeId);
      }

      var oldName = currentMode.name;
      collection.renameMode(msg.modeId, msg.newName);

      console.log('🌉 [Desktop Bridge] Mode renamed from "' + oldName + '" to "' + msg.newName + '"');

      figma.ui.postMessage({
        type: 'RENAME_MODE_RESULT',
        requestId: msg.requestId,
        success: true,
        collection: serializeCollection(collection),
        oldName: oldName
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Rename mode error:', error);
      figma.ui.postMessage({
        type: 'RENAME_MODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // REFRESH_VARIABLES - Re-fetch and send all variables data
  // ============================================================================
  else if (msg.type === 'REFRESH_VARIABLES') {
    try {
      console.log('🌉 [Desktop Bridge] Refreshing variables data...');

      var variables = await figma.variables.getLocalVariablesAsync();
      var collections = await figma.variables.getLocalVariableCollectionsAsync();

      var variablesData = {
        success: true,
        timestamp: Date.now(),
        fileKey: figma.fileKey || null,
        variables: variables.map(serializeVariable),
        variableCollections: collections.map(serializeCollection)
      };

      // Update the UI's cached data
      figma.ui.postMessage({
        type: 'VARIABLES_DATA',
        data: variablesData
      });

      // Also send as a response to the request
      figma.ui.postMessage({
        type: 'REFRESH_VARIABLES_RESULT',
        requestId: msg.requestId,
        success: true,
        data: variablesData
      });

      console.log('🌉 [Desktop Bridge] Variables refreshed:', variables.length, 'variables in', collections.length, 'collections');

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Refresh variables error:', error);
      figma.ui.postMessage({
        type: 'REFRESH_VARIABLES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // GET_COMPONENT - Existing read operation
  // ============================================================================
  else if (msg.type === 'GET_COMPONENT') {
    try {
      console.log(`🌉 [Desktop Bridge] Fetching component: ${msg.nodeId}`);

      const node = await figma.getNodeByIdAsync(msg.nodeId);

      if (!node) {
        throw new Error(`Node not found: ${msg.nodeId}`);
      }

      if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET' && node.type !== 'INSTANCE') {
        throw new Error(`Node is not a component. Type: ${node.type}`);
      }

      // Detect if this is a variant (COMPONENT inside a COMPONENT_SET)
      // Note: Can't use optional chaining (?.) - Figma plugin sandbox doesn't support it
      const isVariant = node.type === 'COMPONENT' && node.parent && node.parent.type === 'COMPONENT_SET';

      // Extract component data including description fields and annotations
      const componentData = {
        success: true,
        timestamp: Date.now(),
        nodeId: msg.nodeId,
        component: {
          id: node.id,
          name: node.name,
          type: node.type,
          // Variants CAN have their own description
          description: node.description || null,
          descriptionMarkdown: node.descriptionMarkdown || null,
          visible: node.visible,
          locked: node.locked,
          // Dev Mode annotations
          annotations: node.annotations || [],
          // Flag to indicate if this is a variant
          isVariant: isVariant,
          // For component sets and non-variant components only (variants cannot access this)
          componentPropertyDefinitions: (node.type === 'COMPONENT_SET' || (node.type === 'COMPONENT' && !isVariant))
            ? node.componentPropertyDefinitions
            : undefined,
          // Get children info (lightweight)
          children: node.children ? node.children.map(child => ({
            id: child.id,
            name: child.name,
            type: child.type
          })) : undefined
        }
      };

      console.log(`🌉 [Desktop Bridge] Component data ready. Has description: ${!!componentData.component.description}, annotations: ${componentData.component.annotations.length}`);

      // Send to UI
      figma.ui.postMessage({
        type: 'COMPONENT_DATA',
        requestId: msg.requestId, // Echo back the request ID
        data: componentData
      });

    } catch (error) {
      console.error(`🌉 [Desktop Bridge] Error fetching component:`, error);
      figma.ui.postMessage({
        type: 'COMPONENT_ERROR',
        requestId: msg.requestId,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // GET_LOCAL_COMPONENTS - Get all local components for design system manifest
  // ============================================================================
  else if (msg.type === 'GET_LOCAL_COMPONENTS') {
    try {
      console.log('🌉 [Desktop Bridge] Fetching all local components for manifest...');

      // Find all component sets and standalone components in the file
      var components = [];
      var componentSets = [];

      // Helper to extract component data
      function extractComponentData(node, isPartOfSet) {
        var data = {
          key: node.key,
          nodeId: node.id,
          name: node.name,
          type: node.type,
          description: node.description || null,
          width: node.width,
          height: node.height
        };

        // Get property definitions for non-variant components
        if (!isPartOfSet && node.componentPropertyDefinitions) {
          data.properties = [];
          var propDefs = node.componentPropertyDefinitions;
          for (var propName in propDefs) {
            if (propDefs.hasOwnProperty(propName)) {
              var propDef = propDefs[propName];
              data.properties.push({
                name: propName,
                type: propDef.type,
                defaultValue: propDef.defaultValue
              });
            }
          }
        }

        return data;
      }

      // Helper to extract component set data with all variants
      function extractComponentSetData(node) {
        var variantAxes = {};
        var variants = [];

        // Parse variant properties from children names
        if (node.children) {
          node.children.forEach(function(child) {
            if (child.type === 'COMPONENT') {
              // Parse variant name (e.g., "Size=md, State=default")
              var variantProps = {};
              var parts = child.name.split(',').map(function(p) { return p.trim(); });
              parts.forEach(function(part) {
                var kv = part.split('=');
                if (kv.length === 2) {
                  var key = kv[0].trim();
                  var value = kv[1].trim();
                  variantProps[key] = value;

                  // Track all values for each axis
                  if (!variantAxes[key]) {
                    variantAxes[key] = [];
                  }
                  if (variantAxes[key].indexOf(value) === -1) {
                    variantAxes[key].push(value);
                  }
                }
              });

              variants.push({
                key: child.key,
                nodeId: child.id,
                name: child.name,
                description: child.description || null,
                variantProperties: variantProps,
                width: child.width,
                height: child.height
              });
            }
          });
        }

        // Convert variantAxes object to array format
        var axes = [];
        for (var axisName in variantAxes) {
          if (variantAxes.hasOwnProperty(axisName)) {
            axes.push({
              name: axisName,
              values: variantAxes[axisName]
            });
          }
        }

        return {
          key: node.key,
          nodeId: node.id,
          name: node.name,
          type: 'COMPONENT_SET',
          description: node.description || null,
          variantAxes: axes,
          variants: variants,
          defaultVariant: variants.length > 0 ? variants[0] : null,
          properties: node.componentPropertyDefinitions ? Object.keys(node.componentPropertyDefinitions).map(function(propName) {
            var propDef = node.componentPropertyDefinitions[propName];
            return {
              name: propName,
              type: propDef.type,
              defaultValue: propDef.defaultValue
            };
          }) : []
        };
      }

      // Recursively search for components
      function findComponents(node) {
        if (!node) return;

        if (node.type === 'COMPONENT_SET') {
          componentSets.push(extractComponentSetData(node));
        } else if (node.type === 'COMPONENT') {
          // Only add standalone components (not variants inside component sets)
          if (!node.parent || node.parent.type !== 'COMPONENT_SET') {
            components.push(extractComponentData(node, false));
          }
        }

        // Recurse into children
        if (node.children) {
          node.children.forEach(function(child) {
            findComponents(child);
          });
        }
      }

      // Load all pages first (required before accessing children)
      console.log('🌉 [Desktop Bridge] Loading all pages...');
      await figma.loadAllPagesAsync();
      console.log('🌉 [Desktop Bridge] All pages loaded, searching for components...');

      // Search through all pages
      var pages = figma.root.children;
      pages.forEach(function(page) {
        findComponents(page);
      });

      console.log('🌉 [Desktop Bridge] Found ' + components.length + ' components and ' + componentSets.length + ' component sets');

      figma.ui.postMessage({
        type: 'GET_LOCAL_COMPONENTS_RESULT',
        requestId: msg.requestId,
        success: true,
        data: {
          components: components,
          componentSets: componentSets,
          totalComponents: components.length,
          totalComponentSets: componentSets.length,
          fileKey: figma.fileKey || null,
          timestamp: Date.now()
        }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Get local components error:', errorMsg);
      figma.ui.postMessage({
        type: 'GET_LOCAL_COMPONENTS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // INSTANTIATE_COMPONENT - Create a component instance with overrides
  // ============================================================================
  else if (msg.type === 'INSTANTIATE_COMPONENT') {
    try {
      console.log('🌉 [Desktop Bridge] Instantiating component:', msg.componentKey || msg.nodeId);

      var component = null;
      var instance = null;

      // Try published library first (by key), then fall back to local component (by nodeId)
      if (msg.componentKey) {
        try {
          component = await figma.importComponentByKeyAsync(msg.componentKey);
        } catch (importError) {
          console.log('🌉 [Desktop Bridge] Not a published component, trying local...');
        }
      }

      // Fall back to local component by nodeId
      if (!component && msg.nodeId) {
        var node = await figma.getNodeByIdAsync(msg.nodeId);
        if (node) {
          if (node.type === 'COMPONENT') {
            component = node;
          } else if (node.type === 'COMPONENT_SET') {
            // For component sets, find the right variant or use default
            if (msg.variant && node.children && node.children.length > 0) {
              // Build variant name from properties (e.g., "Type=Simple, State=Default")
              var variantParts = [];
              for (var prop in msg.variant) {
                if (msg.variant.hasOwnProperty(prop)) {
                  variantParts.push(prop + '=' + msg.variant[prop]);
                }
              }
              var targetVariantName = variantParts.join(', ');
              console.log('🌉 [Desktop Bridge] Looking for variant:', targetVariantName);

              // Find matching variant
              for (var i = 0; i < node.children.length; i++) {
                var child = node.children[i];
                if (child.type === 'COMPONENT' && child.name === targetVariantName) {
                  component = child;
                  console.log('🌉 [Desktop Bridge] Found exact variant match');
                  break;
                }
              }

              // If no exact match, try partial match
              if (!component) {
                for (var i = 0; i < node.children.length; i++) {
                  var child = node.children[i];
                  if (child.type === 'COMPONENT') {
                    var matches = true;
                    for (var prop in msg.variant) {
                      if (msg.variant.hasOwnProperty(prop)) {
                        var expected = prop + '=' + msg.variant[prop];
                        if (child.name.indexOf(expected) === -1) {
                          matches = false;
                          break;
                        }
                      }
                    }
                    if (matches) {
                      component = child;
                      console.log('🌉 [Desktop Bridge] Found partial variant match:', child.name);
                      break;
                    }
                  }
                }
              }
            }

            // Default to first variant if no match
            if (!component && node.children && node.children.length > 0) {
              component = node.children[0];
              console.log('🌉 [Desktop Bridge] Using default variant:', component.name);
            }
          }
        }
      }

      if (!component) {
        // Build detailed error message with actionable guidance
        var errorParts = ['Component not found.'];

        if (msg.componentKey) {
          errorParts.push('Published component key "' + msg.componentKey + '" could not be imported - it may have been unpublished or deleted from the library.');
        }

        if (msg.nodeId) {
          errorParts.push('Local nodeId "' + msg.nodeId + '" does not exist in this file - nodeIds are session-specific and may be stale.');
        }

        if (!msg.componentKey && !msg.nodeId) {
          errorParts.push('No componentKey or nodeId was provided.');
        }

        errorParts.push('SUGGESTION: Use figma_search_components to get current component identifiers before instantiating.');

        throw new Error(errorParts.join(' '));
      }

      // Create the instance
      instance = component.createInstance();

      // Apply position if specified
      if (msg.position) {
        instance.x = msg.position.x || 0;
        instance.y = msg.position.y || 0;
      }

      // Apply size override if specified
      if (msg.size) {
        instance.resize(msg.size.width, msg.size.height);
      }

      // Apply property overrides
      if (msg.overrides) {
        for (var propName in msg.overrides) {
          if (msg.overrides.hasOwnProperty(propName)) {
            try {
              instance.setProperties({ [propName]: msg.overrides[propName] });
            } catch (propError) {
              console.warn('🌉 [Desktop Bridge] Could not set property ' + propName + ':', propError.message);
            }
          }
        }
      }

      // Apply variant selection if specified
      if (msg.variant) {
        try {
          instance.setProperties(msg.variant);
        } catch (variantError) {
          console.warn('🌉 [Desktop Bridge] Could not set variant:', variantError.message);
        }
      }

      // Append to parent if specified
      if (msg.parentId) {
        var parent = await figma.getNodeByIdAsync(msg.parentId);
        if (parent && 'appendChild' in parent) {
          parent.appendChild(instance);
        }
      }

      console.log('🌉 [Desktop Bridge] Component instantiated:', instance.id);

      figma.ui.postMessage({
        type: 'INSTANTIATE_COMPONENT_RESULT',
        requestId: msg.requestId,
        success: true,
        instance: {
          id: instance.id,
          name: instance.name,
          x: instance.x,
          y: instance.y,
          width: instance.width,
          height: instance.height
        }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Instantiate component error:', errorMsg);
      figma.ui.postMessage({
        type: 'INSTANTIATE_COMPONENT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }
};

console.log('🌉 [Desktop Bridge] Ready to handle component requests');
console.log('🌉 [Desktop Bridge] Plugin will stay open until manually closed');

// Plugin stays open - no auto-close
// UI iframe remains accessible for Puppeteer to read data from window object
