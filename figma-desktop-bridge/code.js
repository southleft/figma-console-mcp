// Figma Desktop Bridge - MCP Plugin
// Bridges Figma API to MCP clients via plugin UI window
// Supports: Variables, Components, Styles, and more
// Uses postMessage to communicate with UI, bypassing worker sandbox limitations
// Puppeteer can access UI iframe's window context to retrieve data

console.log('🌉 [Desktop Bridge] Plugin loaded and ready');

// Show minimal UI - compact status indicator
figma.showUI(__html__, { width: 120, height: 36, visible: true, themeColors: true });

// ============================================================================
// CONSOLE CAPTURE — Intercept console.* in the QuickJS sandbox and forward
// to ui.html via postMessage so the WebSocket bridge can relay them to the MCP
// server. This enables console monitoring without CDP.
// ============================================================================
(function() {
  var levels = ['log', 'info', 'warn', 'error', 'debug'];
  var originals = {};
  for (var i = 0; i < levels.length; i++) {
    originals[levels[i]] = console[levels[i]];
  }

  function safeSerialize(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return val;
    try {
      // Attempt JSON round-trip for objects/arrays (catches circular refs)
      return JSON.parse(JSON.stringify(val));
    } catch (e) {
      return String(val);
    }
  }

  for (var i = 0; i < levels.length; i++) {
    (function(level) {
      console[level] = function() {
        // Call the original so output still appears in Figma DevTools
        originals[level].apply(console, arguments);

        // Serialize arguments safely
        var args = [];
        for (var j = 0; j < arguments.length; j++) {
          args.push(safeSerialize(arguments[j]));
        }

        // Build message text from all arguments
        var messageParts = [];
        for (var j = 0; j < arguments.length; j++) {
          messageParts.push(typeof arguments[j] === 'string' ? arguments[j] : String(arguments[j]));
        }

        figma.ui.postMessage({
          type: 'CONSOLE_CAPTURE',
          level: level,
          message: messageParts.join(' '),
          args: args,
          timestamp: Date.now()
        });
      };
    })(levels[i]);
  }
})();

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

      // Analyze result for potential silent failures
      var resultAnalysis = {
        type: typeof result,
        isNull: result === null,
        isUndefined: result === undefined,
        isEmpty: false,
        warning: null
      };

      // Check for empty results that might indicate a failed search/operation
      if (Array.isArray(result)) {
        resultAnalysis.isEmpty = result.length === 0;
        if (resultAnalysis.isEmpty) {
          resultAnalysis.warning = 'Code returned an empty array. If you were searching for nodes, none were found.';
        }
      } else if (result !== null && typeof result === 'object') {
        var keys = Object.keys(result);
        resultAnalysis.isEmpty = keys.length === 0;
        if (resultAnalysis.isEmpty) {
          resultAnalysis.warning = 'Code returned an empty object. The operation may not have found what it was looking for.';
        }
        // Check for common "found nothing" patterns
        if (result.length === 0 || result.count === 0 || result.foundCount === 0 || (result.nodes && result.nodes.length === 0)) {
          resultAnalysis.warning = 'Code returned a result indicating nothing was found (count/length is 0).';
        }
      } else if (result === null) {
        resultAnalysis.warning = 'Code returned null. The requested node or resource may not exist.';
      } else if (result === undefined) {
        resultAnalysis.warning = 'Code returned undefined. Make sure your code has a return statement.';
      }

      if (resultAnalysis.warning) {
        console.warn('🌉 [Desktop Bridge] ⚠️ Result warning:', resultAnalysis.warning);
      }

      figma.ui.postMessage({
        type: 'EXECUTE_CODE_RESULT',
        requestId: msg.requestId,
        success: true,
        result: result,
        resultAnalysis: resultAnalysis,
        // Include file context so users know which file this executed against
        fileContext: {
          fileName: figma.root.name,
          fileKey: figma.fileKey || null
        }
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

      // Check if value is a variable alias (string starting with "VariableID:")
      if (typeof value === 'string' && value.startsWith('VariableID:')) {
        // Convert to VARIABLE_ALIAS format
        value = {
          type: 'VARIABLE_ALIAS',
          id: value
        };
        console.log('🌉 [Desktop Bridge] Converting to variable alias:', value.id);
      } else if (variable.resolvedType === 'COLOR' && typeof value === 'string') {
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

      var serializedVar = serializeVariable(variable);
      serializedVar.oldName = oldName;
      figma.ui.postMessage({
        type: 'RENAME_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: true,
        variable: serializedVar,
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
  // SET_VARIABLE_DESCRIPTION - Set description on a variable
  // ============================================================================
  else if (msg.type === 'SET_VARIABLE_DESCRIPTION') {
    try {
      console.log('🌉 [Desktop Bridge] Setting description on variable:', msg.variableId);

      var variable = await figma.variables.getVariableByIdAsync(msg.variableId);
      if (!variable) {
        throw new Error('Variable not found: ' + msg.variableId);
      }

      variable.description = msg.description || '';

      console.log('🌉 [Desktop Bridge] Variable description set successfully');

      figma.ui.postMessage({
        type: 'SET_VARIABLE_DESCRIPTION_RESULT',
        requestId: msg.requestId,
        success: true,
        variable: serializeVariable(variable)
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set variable description error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_VARIABLE_DESCRIPTION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
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

      var serializedCol = serializeCollection(collection);
      serializedCol.oldName = oldName;
      figma.ui.postMessage({
        type: 'RENAME_MODE_RESULT',
        requestId: msg.requestId,
        success: true,
        collection: serializedCol,
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

      // Process pages in batches with event loop yields to prevent UI freeze
      // This is critical for large design systems that could otherwise crash
      var pages = figma.root.children;
      var PAGE_BATCH_SIZE = 3;  // Process 3 pages at a time
      var totalPages = pages.length;

      console.log('🌉 [Desktop Bridge] Processing ' + totalPages + ' pages in batches of ' + PAGE_BATCH_SIZE + '...');

      for (var pageIndex = 0; pageIndex < totalPages; pageIndex += PAGE_BATCH_SIZE) {
        var batchEnd = Math.min(pageIndex + PAGE_BATCH_SIZE, totalPages);
        var batchPages = [];
        for (var j = pageIndex; j < batchEnd; j++) {
          batchPages.push(pages[j]);
        }

        // Process this batch of pages
        batchPages.forEach(function(page) {
          findComponents(page);
        });

        // Log progress for large files
        if (totalPages > PAGE_BATCH_SIZE) {
          console.log('🌉 [Desktop Bridge] Processed pages ' + (pageIndex + 1) + '-' + batchEnd + ' of ' + totalPages + ' (found ' + components.length + ' components so far)');
        }

        // Yield to event loop between batches to prevent UI freeze and allow cancellation
        if (batchEnd < totalPages) {
          await new Promise(function(resolve) { setTimeout(resolve, 0); });
        }
      }

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
          // Include file metadata for context verification
          fileName: figma.root.name,
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

        if (msg.componentKey && !msg.nodeId) {
          errorParts.push('Component key "' + msg.componentKey + '" not found. Note: componentKey only works for components from published libraries. For local/unpublished components, you must provide nodeId instead.');
        } else if (msg.componentKey && msg.nodeId) {
          errorParts.push('Neither componentKey "' + msg.componentKey + '" nor nodeId "' + msg.nodeId + '" resolved to a valid component. The identifiers may be stale from a previous session.');
        } else if (msg.nodeId) {
          errorParts.push('NodeId "' + msg.nodeId + '" does not exist in this file. NodeIds are session-specific and become stale when Figma restarts or the file is closed.');
        } else {
          errorParts.push('No componentKey or nodeId was provided.');
        }

        errorParts.push('SOLUTION: Call figma_search_components to get fresh identifiers, then pass BOTH componentKey AND nodeId together for reliable instantiation.');

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

  // ============================================================================
  // SET_NODE_DESCRIPTION - Set description on component/style
  // ============================================================================
  else if (msg.type === 'SET_NODE_DESCRIPTION') {
    try {
      console.log('🌉 [Desktop Bridge] Setting description on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      // Check if node supports description
      if (!('description' in node)) {
        throw new Error('Node type ' + node.type + ' does not support description');
      }

      // Set description (and markdown if supported)
      node.description = msg.description || '';
      if (msg.descriptionMarkdown && 'descriptionMarkdown' in node) {
        node.descriptionMarkdown = msg.descriptionMarkdown;
      }

      console.log('🌉 [Desktop Bridge] Description set successfully');

      figma.ui.postMessage({
        type: 'SET_NODE_DESCRIPTION_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, description: node.description }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set description error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_NODE_DESCRIPTION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // ADD_COMPONENT_PROPERTY - Add property to component
  // ============================================================================
  else if (msg.type === 'ADD_COMPONENT_PROPERTY') {
    try {
      console.log('🌉 [Desktop Bridge] Adding component property:', msg.propertyName, 'type:', msg.propertyType);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') {
        throw new Error('Node must be a COMPONENT or COMPONENT_SET. Got: ' + node.type);
      }

      // Check if it's a variant (can't add properties to variants)
      if (node.type === 'COMPONENT' && node.parent && node.parent.type === 'COMPONENT_SET') {
        throw new Error('Cannot add properties to variant components. Add to the parent COMPONENT_SET instead.');
      }

      // Build options if preferredValues provided
      var options = undefined;
      if (msg.preferredValues) {
        options = { preferredValues: msg.preferredValues };
      }

      // Use msg.propertyType (not msg.type which is the message type 'ADD_COMPONENT_PROPERTY')
      var propertyNameWithId = node.addComponentProperty(msg.propertyName, msg.propertyType, msg.defaultValue, options);

      console.log('🌉 [Desktop Bridge] Property added:', propertyNameWithId);

      figma.ui.postMessage({
        type: 'ADD_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: true,
        propertyName: propertyNameWithId
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Add component property error:', errorMsg);
      figma.ui.postMessage({
        type: 'ADD_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // EDIT_COMPONENT_PROPERTY - Edit existing component property
  // ============================================================================
  else if (msg.type === 'EDIT_COMPONENT_PROPERTY') {
    try {
      console.log('🌉 [Desktop Bridge] Editing component property:', msg.propertyName);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') {
        throw new Error('Node must be a COMPONENT or COMPONENT_SET. Got: ' + node.type);
      }

      var propertyNameWithId = node.editComponentProperty(msg.propertyName, msg.newValue);

      console.log('🌉 [Desktop Bridge] Property edited:', propertyNameWithId);

      figma.ui.postMessage({
        type: 'EDIT_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: true,
        propertyName: propertyNameWithId
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Edit component property error:', errorMsg);
      figma.ui.postMessage({
        type: 'EDIT_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // DELETE_COMPONENT_PROPERTY - Delete a component property
  // ============================================================================
  else if (msg.type === 'DELETE_COMPONENT_PROPERTY') {
    try {
      console.log('🌉 [Desktop Bridge] Deleting component property:', msg.propertyName);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') {
        throw new Error('Node must be a COMPONENT or COMPONENT_SET. Got: ' + node.type);
      }

      node.deleteComponentProperty(msg.propertyName);

      console.log('🌉 [Desktop Bridge] Property deleted');

      figma.ui.postMessage({
        type: 'DELETE_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: true
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Delete component property error:', errorMsg);
      figma.ui.postMessage({
        type: 'DELETE_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // RESIZE_NODE - Resize any node
  // ============================================================================
  else if (msg.type === 'RESIZE_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Resizing node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('resize' in node)) {
        throw new Error('Node type ' + node.type + ' does not support resize');
      }

      if (msg.withConstraints) {
        node.resize(msg.width, msg.height);
      } else {
        node.resizeWithoutConstraints(msg.width, msg.height);
      }

      console.log('🌉 [Desktop Bridge] Node resized to:', msg.width, 'x', msg.height);

      figma.ui.postMessage({
        type: 'RESIZE_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, width: node.width, height: node.height }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Resize node error:', errorMsg);
      figma.ui.postMessage({
        type: 'RESIZE_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // MOVE_NODE - Move/position a node
  // ============================================================================
  else if (msg.type === 'MOVE_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Moving node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('x' in node)) {
        throw new Error('Node type ' + node.type + ' does not support positioning');
      }

      node.x = msg.x;
      node.y = msg.y;

      console.log('🌉 [Desktop Bridge] Node moved to:', msg.x, ',', msg.y);

      figma.ui.postMessage({
        type: 'MOVE_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, x: node.x, y: node.y }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Move node error:', errorMsg);
      figma.ui.postMessage({
        type: 'MOVE_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_NODE_FILLS - Set fills (colors) on a node
  // ============================================================================
  else if (msg.type === 'SET_NODE_FILLS') {
    try {
      console.log('🌉 [Desktop Bridge] Setting fills on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('fills' in node)) {
        throw new Error('Node type ' + node.type + ' does not support fills');
      }

      // Process fills - convert hex colors if needed
      var processedFills = msg.fills.map(function(fill) {
        if (fill.type === 'SOLID' && typeof fill.color === 'string') {
          // Convert hex to RGB
          var rgb = hexToFigmaRGB(fill.color);
          return {
            type: 'SOLID',
            color: { r: rgb.r, g: rgb.g, b: rgb.b },
            opacity: rgb.a !== undefined ? rgb.a : (fill.opacity !== undefined ? fill.opacity : 1)
          };
        }
        return fill;
      });

      node.fills = processedFills;

      console.log('🌉 [Desktop Bridge] Fills set successfully');

      figma.ui.postMessage({
        type: 'SET_NODE_FILLS_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set fills error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_NODE_FILLS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_NODE_STROKES - Set strokes on a node
  // ============================================================================
  else if (msg.type === 'SET_NODE_STROKES') {
    try {
      console.log('🌉 [Desktop Bridge] Setting strokes on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('strokes' in node)) {
        throw new Error('Node type ' + node.type + ' does not support strokes');
      }

      // Process strokes - convert hex colors if needed
      var processedStrokes = msg.strokes.map(function(stroke) {
        if (stroke.type === 'SOLID' && typeof stroke.color === 'string') {
          var rgb = hexToFigmaRGB(stroke.color);
          return {
            type: 'SOLID',
            color: { r: rgb.r, g: rgb.g, b: rgb.b },
            opacity: rgb.a !== undefined ? rgb.a : (stroke.opacity !== undefined ? stroke.opacity : 1)
          };
        }
        return stroke;
      });

      node.strokes = processedStrokes;

      if (msg.strokeWeight !== undefined) {
        node.strokeWeight = msg.strokeWeight;
      }

      console.log('🌉 [Desktop Bridge] Strokes set successfully');

      figma.ui.postMessage({
        type: 'SET_NODE_STROKES_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set strokes error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_NODE_STROKES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_NODE_OPACITY - Set opacity on a node
  // ============================================================================
  else if (msg.type === 'SET_NODE_OPACITY') {
    try {
      console.log('🌉 [Desktop Bridge] Setting opacity on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('opacity' in node)) {
        throw new Error('Node type ' + node.type + ' does not support opacity');
      }

      node.opacity = Math.max(0, Math.min(1, msg.opacity));

      console.log('🌉 [Desktop Bridge] Opacity set to:', node.opacity);

      figma.ui.postMessage({
        type: 'SET_NODE_OPACITY_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, opacity: node.opacity }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set opacity error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_NODE_OPACITY_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_NODE_CORNER_RADIUS - Set corner radius on a node
  // ============================================================================
  else if (msg.type === 'SET_NODE_CORNER_RADIUS') {
    try {
      console.log('🌉 [Desktop Bridge] Setting corner radius on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('cornerRadius' in node)) {
        throw new Error('Node type ' + node.type + ' does not support corner radius');
      }

      node.cornerRadius = msg.radius;

      console.log('🌉 [Desktop Bridge] Corner radius set to:', msg.radius);

      figma.ui.postMessage({
        type: 'SET_NODE_CORNER_RADIUS_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, cornerRadius: node.cornerRadius }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set corner radius error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_NODE_CORNER_RADIUS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // CLONE_NODE - Clone/duplicate a node
  // ============================================================================
  else if (msg.type === 'CLONE_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Cloning node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('clone' in node)) {
        throw new Error('Node type ' + node.type + ' does not support cloning');
      }

      var clonedNode = node.clone();

      console.log('🌉 [Desktop Bridge] Node cloned:', clonedNode.id);

      figma.ui.postMessage({
        type: 'CLONE_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: clonedNode.id, name: clonedNode.name, x: clonedNode.x, y: clonedNode.y }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Clone node error:', errorMsg);
      figma.ui.postMessage({
        type: 'CLONE_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // DELETE_NODE - Delete a node
  // ============================================================================
  else if (msg.type === 'DELETE_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Deleting node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      var deletedInfo = { id: node.id, name: node.name };

      node.remove();

      console.log('🌉 [Desktop Bridge] Node deleted');

      figma.ui.postMessage({
        type: 'DELETE_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        deleted: deletedInfo
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Delete node error:', errorMsg);
      figma.ui.postMessage({
        type: 'DELETE_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // RENAME_NODE - Rename a node
  // ============================================================================
  else if (msg.type === 'RENAME_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Renaming node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      var oldName = node.name;
      node.name = msg.newName;

      console.log('🌉 [Desktop Bridge] Node renamed from "' + oldName + '" to "' + msg.newName + '"');

      figma.ui.postMessage({
        type: 'RENAME_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, oldName: oldName }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Rename node error:', errorMsg);
      figma.ui.postMessage({
        type: 'RENAME_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_TEXT_CONTENT - Set text on a text node
  // ============================================================================
  else if (msg.type === 'SET_TEXT_CONTENT') {
    try {
      console.log('🌉 [Desktop Bridge] Setting text content on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (node.type !== 'TEXT') {
        throw new Error('Node must be a TEXT node. Got: ' + node.type);
      }

      // Load the font first
      await figma.loadFontAsync(node.fontName);

      node.characters = msg.text;

      // Apply font properties if specified
      if (msg.fontSize) {
        node.fontSize = msg.fontSize;
      }

      console.log('🌉 [Desktop Bridge] Text content set');

      figma.ui.postMessage({
        type: 'SET_TEXT_CONTENT_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, characters: node.characters }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set text content error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_TEXT_CONTENT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // CREATE_CHILD_NODE - Create a new child node
  // ============================================================================
  else if (msg.type === 'CREATE_CHILD_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Creating child node of type:', msg.nodeType);

      var parent = await figma.getNodeByIdAsync(msg.parentId);
      if (!parent) {
        throw new Error('Parent node not found: ' + msg.parentId);
      }

      if (!('appendChild' in parent)) {
        throw new Error('Parent node type ' + parent.type + ' does not support children');
      }

      var newNode;
      var props = msg.properties || {};

      switch (msg.nodeType) {
        case 'RECTANGLE':
          newNode = figma.createRectangle();
          break;
        case 'ELLIPSE':
          newNode = figma.createEllipse();
          break;
        case 'FRAME':
          newNode = figma.createFrame();
          break;
        case 'TEXT':
          newNode = figma.createText();
          // Load default font
          await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
          newNode.fontName = { family: 'Inter', style: 'Regular' };
          if (props.text) {
            newNode.characters = props.text;
          }
          break;
        case 'LINE':
          newNode = figma.createLine();
          break;
        case 'POLYGON':
          newNode = figma.createPolygon();
          break;
        case 'STAR':
          newNode = figma.createStar();
          break;
        case 'VECTOR':
          newNode = figma.createVector();
          break;
        default:
          throw new Error('Unsupported node type: ' + msg.nodeType);
      }

      // Apply common properties
      if (props.name) newNode.name = props.name;
      if (props.x !== undefined) newNode.x = props.x;
      if (props.y !== undefined) newNode.y = props.y;
      if (props.width !== undefined && props.height !== undefined) {
        newNode.resize(props.width, props.height);
      }

      // Apply fills if specified
      if (props.fills) {
        var processedFills = props.fills.map(function(fill) {
          if (fill.type === 'SOLID' && typeof fill.color === 'string') {
            var rgb = hexToFigmaRGB(fill.color);
            return {
              type: 'SOLID',
              color: { r: rgb.r, g: rgb.g, b: rgb.b },
              opacity: rgb.a !== undefined ? rgb.a : 1
            };
          }
          return fill;
        });
        newNode.fills = processedFills;
      }

      // Add to parent
      parent.appendChild(newNode);

      console.log('🌉 [Desktop Bridge] Child node created:', newNode.id);

      figma.ui.postMessage({
        type: 'CREATE_CHILD_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        node: {
          id: newNode.id,
          name: newNode.name,
          type: newNode.type,
          x: newNode.x,
          y: newNode.y,
          width: newNode.width,
          height: newNode.height
        }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Create child node error:', errorMsg);
      figma.ui.postMessage({
        type: 'CREATE_CHILD_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // CAPTURE_SCREENSHOT - Capture node screenshot using plugin exportAsync
  // This captures the CURRENT plugin runtime state (not cloud state like REST API)
  // ============================================================================
  else if (msg.type === 'CAPTURE_SCREENSHOT') {
    try {
      console.log('🌉 [Desktop Bridge] Capturing screenshot for node:', msg.nodeId);

      var node = msg.nodeId ? await figma.getNodeByIdAsync(msg.nodeId) : figma.currentPage;
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      // Verify node supports export
      if (!('exportAsync' in node)) {
        throw new Error('Node type ' + node.type + ' does not support export');
      }

      // Configure export settings
      var format = msg.format || 'PNG';
      var scale = msg.scale || 2;

      var exportSettings = {
        format: format,
        constraint: { type: 'SCALE', value: scale }
      };

      // Export the node
      var bytes = await node.exportAsync(exportSettings);

      // Convert to base64
      var base64 = figma.base64Encode(bytes);

      // Get node bounds for context
      var bounds = null;
      if ('absoluteBoundingBox' in node) {
        bounds = node.absoluteBoundingBox;
      }

      console.log('🌉 [Desktop Bridge] Screenshot captured:', bytes.length, 'bytes');

      figma.ui.postMessage({
        type: 'CAPTURE_SCREENSHOT_RESULT',
        requestId: msg.requestId,
        success: true,
        image: {
          base64: base64,
          format: format,
          scale: scale,
          byteLength: bytes.length,
          node: {
            id: node.id,
            name: node.name,
            type: node.type
          },
          bounds: bounds
        }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Screenshot capture error:', errorMsg);
      figma.ui.postMessage({
        type: 'CAPTURE_SCREENSHOT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // GET_FILE_INFO - Report which file this plugin instance is running in
  // Used by WebSocket bridge to identify the connected file
  // ============================================================================
  else if (msg.type === 'GET_FILE_INFO') {
    try {
      var selection = figma.currentPage.selection;
      figma.ui.postMessage({
        type: 'GET_FILE_INFO_RESULT',
        requestId: msg.requestId,
        success: true,
        fileInfo: {
          fileName: figma.root.name,
          fileKey: figma.fileKey || null,
          currentPage: figma.currentPage.name,
          currentPageId: figma.currentPage.id,
          selectionCount: selection ? selection.length : 0
        }
      });
    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      figma.ui.postMessage({
        type: 'GET_FILE_INFO_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // RELOAD_UI - Reload the plugin UI iframe (re-establishes WebSocket connection)
  // Uses figma.showUI(__html__) to reload without restarting code.js
  // ============================================================================
  else if (msg.type === 'RELOAD_UI') {
    try {
      console.log('🌉 [Desktop Bridge] Reloading plugin UI');
      figma.ui.postMessage({
        type: 'RELOAD_UI_RESULT',
        requestId: msg.requestId,
        success: true
      });
      // Short delay to let the response message be sent before reload
      setTimeout(function() {
        figma.showUI(__html__, { width: 120, height: 36, visible: true, themeColors: true });
      }, 100);
    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      figma.ui.postMessage({
        type: 'RELOAD_UI_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_INSTANCE_PROPERTIES - Update component properties on an instance
  // Uses instance.setProperties() to update TEXT, BOOLEAN, INSTANCE_SWAP, VARIANT
  // ============================================================================
  else if (msg.type === 'SET_INSTANCE_PROPERTIES') {
    try {
      console.log('🌉 [Desktop Bridge] Setting instance properties on:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (node.type !== 'INSTANCE') {
        throw new Error('Node must be an INSTANCE. Got: ' + node.type);
      }

      // Load main component first (required for documentAccess: dynamic-page)
      var mainComponent = await node.getMainComponentAsync();

      // Get current properties for reference
      var currentProps = node.componentProperties;
      console.log('🌉 [Desktop Bridge] Current properties:', JSON.stringify(Object.keys(currentProps)));

      // Build the properties object
      // Note: TEXT, BOOLEAN, INSTANCE_SWAP properties use the format "PropertyName#nodeId"
      // VARIANT properties use just "PropertyName"
      var propsToSet = {};
      var propUpdates = msg.properties || {};

      for (var propName in propUpdates) {
        var newValue = propUpdates[propName];

        // Check if this exact property name exists
        if (currentProps[propName] !== undefined) {
          propsToSet[propName] = newValue;
          console.log('🌉 [Desktop Bridge] Setting property:', propName, '=', newValue);
        } else {
          // Try to find a matching property with a suffix (for TEXT/BOOLEAN/INSTANCE_SWAP)
          var foundMatch = false;
          for (var existingProp in currentProps) {
            // Check if this is the base property name with a node ID suffix
            if (existingProp.startsWith(propName + '#')) {
              propsToSet[existingProp] = newValue;
              console.log('🌉 [Desktop Bridge] Found suffixed property:', existingProp, '=', newValue);
              foundMatch = true;
              break;
            }
          }

          if (!foundMatch) {
            console.warn('🌉 [Desktop Bridge] Property not found:', propName, '- Available:', Object.keys(currentProps).join(', '));
          }
        }
      }

      if (Object.keys(propsToSet).length === 0) {
        throw new Error('No valid properties to set. Available properties: ' + Object.keys(currentProps).join(', '));
      }

      // Apply the properties
      node.setProperties(propsToSet);

      // Get updated properties
      var updatedProps = node.componentProperties;

      console.log('🌉 [Desktop Bridge] Instance properties updated');

      figma.ui.postMessage({
        type: 'SET_INSTANCE_PROPERTIES_RESULT',
        requestId: msg.requestId,
        success: true,
        instance: {
          id: node.id,
          name: node.name,
          componentId: mainComponent ? mainComponent.id : null,
          propertiesSet: Object.keys(propsToSet),
          currentProperties: Object.keys(updatedProps).reduce(function(acc, key) {
            acc[key] = {
              type: updatedProps[key].type,
              value: updatedProps[key].value
            };
            return acc;
          }, {})
        }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set instance properties error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_INSTANCE_PROPERTIES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }
};

// ============================================================================
// DOCUMENT CHANGE LISTENER - Forward change events for cache invalidation
// Fires when variables, styles, or nodes change (by any means — user edits, API, etc.)
// Requires figma.loadAllPagesAsync() in dynamic-page mode before registering.
// ============================================================================
figma.loadAllPagesAsync().then(function() {
  figma.on('documentchange', function(event) {
    var hasStyleChanges = false;
    var hasNodeChanges = false;
    var changedNodeIds = [];

    for (var i = 0; i < event.documentChanges.length; i++) {
      var change = event.documentChanges[i];
      if (change.type === 'STYLE_CREATE' || change.type === 'STYLE_DELETE' || change.type === 'STYLE_PROPERTY_CHANGE') {
        hasStyleChanges = true;
      } else if (change.type === 'CREATE' || change.type === 'DELETE' || change.type === 'PROPERTY_CHANGE') {
        hasNodeChanges = true;
        if (change.id && changedNodeIds.length < 50) {
          changedNodeIds.push(change.id);
        }
      }
    }

    if (hasStyleChanges || hasNodeChanges) {
      figma.ui.postMessage({
        type: 'DOCUMENT_CHANGE',
        data: {
          hasStyleChanges: hasStyleChanges,
          hasNodeChanges: hasNodeChanges,
          changedNodeIds: changedNodeIds,
          changeCount: event.documentChanges.length,
          timestamp: Date.now()
        }
      });
    }
  });
  // Selection change listener — tracks what the user has selected in Figma
  figma.on('selectionchange', function() {
    var selection = figma.currentPage.selection;
    var selectedNodes = [];
    for (var i = 0; i < Math.min(selection.length, 50); i++) {
      var node = selection[i];
      selectedNodes.push({
        id: node.id,
        name: node.name,
        type: node.type,
        width: node.width,
        height: node.height
      });
    }
    figma.ui.postMessage({
      type: 'SELECTION_CHANGE',
      data: {
        nodes: selectedNodes,
        count: selection.length,
        page: figma.currentPage.name,
        timestamp: Date.now()
      }
    });
  });

  // Page change listener — tracks which page the user is viewing
  figma.on('currentpagechange', function() {
    figma.ui.postMessage({
      type: 'PAGE_CHANGE',
      data: {
        pageId: figma.currentPage.id,
        pageName: figma.currentPage.name,
        timestamp: Date.now()
      }
    });
  });

  console.log('🌉 [Desktop Bridge] Document change, selection, and page listeners registered');
}).catch(function(err) {
  console.warn('🌉 [Desktop Bridge] Could not register event listeners:', err);
});

console.log('🌉 [Desktop Bridge] Ready to handle component requests');
console.log('🌉 [Desktop Bridge] Plugin will stay open until manually closed');

// Plugin stays open - no auto-close
// UI iframe remains accessible for Puppeteer to read data from window object
