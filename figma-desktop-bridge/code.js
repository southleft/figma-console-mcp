// Figma Desktop Bridge - MCP Plugin
// Bridges Figma API to MCP clients via plugin UI window
// Supports: Variables, Components, Styles, and more
// Uses postMessage to communicate with UI, bypassing worker sandbox limitations
// Puppeteer can access UI iframe's window context to retrieve data

// Plugin version — sent in FILE_INFO for server-side version compatibility checks.
// The server compares this against its own version to detect stale cached plugins.
var PLUGIN_VERSION = '1.14.0';

console.log('🌉 [Desktop Bridge] Plugin loaded (v' + PLUGIN_VERSION + ')');

// Show minimal UI - compact status indicator
figma.showUI(__html__, { width: 140, height: 50, visible: true, themeColors: true });

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

// Detect editor type (figma | figjam | slides | dev)
var __editorType = figma.editorType || 'figma';
console.log('🌉 [Desktop Bridge] Editor type:', __editorType);

// Shared sticky color map — used by CREATE_STICKY and CREATE_STICKIES
var __stickyColors = {
  'YELLOW': { r: 1, g: 0.85, b: 0.4 },
  'BLUE': { r: 0.53, g: 0.78, b: 1 },
  'GREEN': { r: 0.55, g: 0.87, b: 0.53 },
  'PINK': { r: 1, g: 0.6, b: 0.78 },
  'ORANGE': { r: 1, g: 0.71, b: 0.42 },
  'PURPLE': { r: 0.78, g: 0.65, b: 1 },
  'RED': { r: 1, g: 0.55, b: 0.55 },
  'LIGHT_GRAY': { r: 0.9, g: 0.9, b: 0.9 },
  'GRAY': { r: 0.7, g: 0.7, b: 0.7 }
};

// Immediately fetch and send variables data to UI (skip in FigJam — no variables API)
(async () => {
  if (__editorType === 'figjam' || __editorType === 'slides') {
    console.log('🌉 [Desktop Bridge] ' + __editorType + ' mode — skipping variables fetch');
    figma.ui.postMessage({
      type: 'VARIABLES_DATA',
      data: { success: true, timestamp: Date.now(), fileKey: figma.fileKey || null, variables: [], variableCollections: [], editorType: __editorType }
    });
    return;
  }
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
        codeSyntax: v.codeSyntax || {},
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
    codeSyntax: v.codeSyntax || {},
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
  // BOOT_LOAD_UI - Bootloader fetched fresh UI HTML from the MCP server.
  // Replace the bootloader with the full, always-up-to-date plugin UI.
  // This uses figma.showUI() with the HTML string directly — no redirects,
  // no cross-origin, no CSP issues.
  // ============================================================================
  if (msg.type === 'BOOT_LOAD_UI' && msg.html) {
    console.log('🌉 [Desktop Bridge] Bootloader delivered fresh UI (' + msg.html.length + ' bytes), loading...');
    figma.showUI(msg.html, { width: 140, height: 50, visible: true, themeColors: true });

    // Re-send variables data to the fresh UI — the original send went to the
    // bootloader which discarded it. The fresh UI needs it to show "ready" status.
    (async function() {
      try {
        var variables = await figma.variables.getLocalVariablesAsync();
        var collections = await figma.variables.getLocalVariableCollectionsAsync();
        figma.ui.postMessage({
          type: 'VARIABLES_DATA',
          data: {
            success: true,
            timestamp: Date.now(),
            fileKey: figma.fileKey || null,
            variables: variables.map(function(v) { return {
              id: v.id, name: v.name, key: v.key, resolvedType: v.resolvedType,
              valuesByMode: v.valuesByMode, variableCollectionId: v.variableCollectionId,
              scopes: v.scopes, codeSyntax: v.codeSyntax || {}, description: v.description, hiddenFromPublishing: v.hiddenFromPublishing
            }; }),
            variableCollections: collections.map(function(c) { return {
              id: c.id, name: c.name, key: c.key, modes: c.modes,
              defaultModeId: c.defaultModeId, variableIds: c.variableIds
            }; })
          }
        });
        console.log('🌉 [Desktop Bridge] Re-sent variables to fresh UI (' + variables.length + ' vars)');
      } catch (e) {
        console.log('🌉 [Desktop Bridge] Could not re-send variables:', e.message || e);
      }
    })();
    return;
  }

  // ============================================================================
  // BOOT_FALLBACK - Bootloader found an old server that doesn't support the
  // bootloader protocol. Fall back to reloading the cached __html__ which
  // contains the full UI (for users who haven't switched to the bootloader yet,
  // __html__ IS the full UI; for bootloader users, this is a no-op reload).
  // ============================================================================
  if (msg.type === 'BOOT_FALLBACK') {
    console.log('🌉 [Desktop Bridge] Old server detected on port ' + msg.port + ', using cached UI');
    figma.showUI(__html__, { width: 140, height: 50, visible: true, themeColors: true });
    return;
  }

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
          // Get children info (lightweight) — skip unresolvable slot sublayers
          children: node.children ? node.children.reduce((acc, child) => {
            try {
              acc.push({ id: child.id, name: child.name, type: child.type });
            } catch (e) { /* slot sublayer or table cell — skip */ }
            return acc;
          }, []) : undefined
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

        // Parse variant properties from children names — skip unresolvable slot sublayers
        if (node.children) {
          node.children.forEach(function(child) {
            try {
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
            } catch (e) { /* slot sublayer — skip */ }
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

        // Recurse into children — skip unresolvable slot sublayers
        if (node.children) {
          node.children.forEach(function(child) {
            try { findComponents(child); } catch (e) { /* slot sublayer — skip */ }
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
        // Try importComponentByKeyAsync first (for COMPONENT nodes)
        try {
          var importResult = await Promise.race([
            figma.importComponentByKeyAsync(msg.componentKey),
            new Promise(function(_, reject) {
              setTimeout(function() { reject(new Error('Import timed out after 15s — component may not be published to a team library')); }, 15000);
            })
          ]);
          component = importResult;
        } catch (importError) {
          var importErrMsg = importError && importError.message ? importError.message : String(importError);
          console.log('🌉 [Desktop Bridge] importComponentByKeyAsync failed: ' + importErrMsg);
        }

        // If that failed, try importComponentSetByKeyAsync (for COMPONENT_SET nodes)
        if (!component) {
          try {
            var setResult = await Promise.race([
              figma.importComponentSetByKeyAsync(msg.componentKey),
              new Promise(function(_, reject) {
                setTimeout(function() { reject(new Error('ComponentSet import timed out after 15s')); }, 15000);
              })
            ]);
            // Got the component set — use its default variant (first child)
            if (setResult && setResult.type === 'COMPONENT_SET') {
              console.log('🌉 [Desktop Bridge] Imported component set "' + setResult.name + '" with ' + setResult.children.length + ' variants');
              component = setResult.defaultVariant || setResult.children[0];
            }
          } catch (setError) {
            var setErrMsg = setError && setError.message ? setError.message : String(setError);
            console.log('🌉 [Desktop Bridge] importComponentSetByKeyAsync also failed: ' + setErrMsg + ', trying local...');
          }
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
  // SET_IMAGE_FILL - Set an image fill on one or more nodes
  // Receives raw image bytes (as Array) from ui.html which decodes base64
  // ============================================================================
  else if (msg.type === 'SET_IMAGE_FILL') {
    try {
      console.log('🌉 [Desktop Bridge] Setting image fill, bytes:', msg.imageBytes.length);

      // Convert the plain array back to Uint8Array
      var bytes = new Uint8Array(msg.imageBytes);

      // Create the image in Figma
      var image = figma.createImage(bytes);
      var imageHash = image.hash;

      var fill = {
        type: 'IMAGE',
        scaleMode: msg.scaleMode || 'FILL',
        imageHash: imageHash
      };

      // Resolve target nodes
      var nodeIds = msg.nodeIds || (msg.nodeId ? [msg.nodeId] : []);
      var updatedCount = 0;
      var updatedNodes = [];

      for (var i = 0; i < nodeIds.length; i++) {
        var node = await figma.getNodeByIdAsync(nodeIds[i]);
        if (node && 'fills' in node) {
          node.fills = [fill];
          updatedCount++;
          updatedNodes.push({ id: node.id, name: node.name });
        }
      }

      console.log('🌉 [Desktop Bridge] Image fill applied to', updatedCount, 'node(s), hash:', imageHash);

      figma.ui.postMessage({
        type: 'SET_IMAGE_FILL_RESULT',
        requestId: msg.requestId,
        success: true,
        imageHash: imageHash,
        updatedCount: updatedCount,
        nodes: updatedNodes
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set image fill error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_IMAGE_FILL_RESULT',
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
          selectionCount: selection ? selection.length : 0,
          pluginVersion: PLUGIN_VERSION,
          editorType: __editorType
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
  // RESIZE_UI - Dynamically resize the plugin window (e.g., Cloud Mode toggle)
  // ============================================================================
  else if (msg.type === 'RESIZE_UI') {
    figma.ui.resize(msg.width || 120, msg.height || 36);
  }

  // ============================================================================
  // STORE_CLOUD_CONFIG - Persist cloud pairing config in clientStorage
  // ============================================================================
  else if (msg.type === 'STORE_CLOUD_CONFIG') {
    figma.clientStorage.setAsync('cloudConfig', { code: msg.code, timestamp: Date.now() })
      .catch(function() { /* non-critical */ });
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
        figma.showUI(__html__, { width: 140, height: 50, visible: true, themeColors: true });
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

  // ============================================================================
  // LINT_DESIGN - Accessibility and design quality checks on node tree
  // ============================================================================
  else if (msg.type === 'LINT_DESIGN') {
    try {
      console.log('🌉 [Desktop Bridge] Running design lint...');

      // ---- Helper functions ----

      // sRGB linearization
      function lintLinearize(c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      }

      // Relative luminance (r, g, b in 0-1 range)
      function lintLuminance(r, g, b) {
        return 0.2126 * lintLinearize(r) + 0.7152 * lintLinearize(g) + 0.0722 * lintLinearize(b);
      }

      // Contrast ratio between two colors (each r, g, b in 0-1)
      function lintContrastRatio(r1, g1, b1, r2, g2, b2) {
        var l1 = lintLuminance(r1, g1, b1);
        var l2 = lintLuminance(r2, g2, b2);
        var lighter = Math.max(l1, l2);
        var darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      }

      // Convert 0-1 RGB to hex string
      function lintRgbToHex(r, g, b) {
        var rr = Math.round(r * 255).toString(16);
        var gg = Math.round(g * 255).toString(16);
        var bb = Math.round(b * 255).toString(16);
        if (rr.length === 1) rr = '0' + rr;
        if (gg.length === 1) gg = '0' + gg;
        if (bb.length === 1) bb = '0' + bb;
        return '#' + rr.toUpperCase() + gg.toUpperCase() + bb.toUpperCase();
      }

      // Walk up ancestors to find nearest solid fill background color
      function lintGetEffectiveBg(node) {
        var current = node.parent;
        while (current) {
          try {
            if (current.fills && current.fills.length > 0) {
              // Iterate reverse (last = topmost visible fill in Figma's stack)
              for (var fi = current.fills.length - 1; fi >= 0; fi--) {
                var fill = current.fills[fi];
                if (fill.type === 'SOLID' && fill.visible !== false) {
                  var opacity = (fill.opacity !== undefined) ? fill.opacity : 1;
                  return { r: fill.color.r, g: fill.color.g, b: fill.color.b, opacity: opacity };
                }
              }
            }
          } catch (e) {
            // Slot sublayer — skip
          }
          current = current.parent;
        }
        // Default to white if no bg found
        return { r: 1, g: 1, b: 1, opacity: 1 };
      }

      // Check if text qualifies as "large" per WCAG (18pt=24px regular, 14pt≈18.66px bold 700+)
      function lintIsLargeText(fontSize, fontWeight) {
        if (fontSize >= 24) return true;
        if (fontSize >= 18.66 && fontWeight && (fontWeight === 'Bold' || fontWeight === 'Black' || fontWeight === 'ExtraBold')) return true;
        return false;
      }

      // ---- Rule configuration ----
      var allRuleIds = [
        'wcag-contrast', 'wcag-text-size', 'wcag-target-size', 'wcag-line-height',
        'hardcoded-color', 'no-text-style', 'default-name', 'detached-component',
        'no-autolayout', 'empty-container'
      ];

      var ruleGroups = {
        'all': allRuleIds,
        'wcag': ['wcag-contrast', 'wcag-text-size', 'wcag-target-size', 'wcag-line-height'],
        'design-system': ['hardcoded-color', 'no-text-style', 'default-name', 'detached-component'],
        'layout': ['no-autolayout', 'empty-container']
      };

      var severityMap = {
        'wcag-contrast': 'critical',
        'wcag-target-size': 'critical',
        'wcag-text-size': 'warning',
        'wcag-line-height': 'warning',
        'hardcoded-color': 'warning',
        'no-text-style': 'warning',
        'default-name': 'warning',
        'detached-component': 'warning',
        'no-autolayout': 'warning',
        'empty-container': 'info'
      };

      var ruleDescriptions = {
        'wcag-contrast': 'Text does not meet WCAG AA contrast ratio (4.5:1 normal, 3:1 large)',
        'wcag-text-size': 'Text size is below 12px minimum',
        'wcag-target-size': 'Interactive element is smaller than 24x24px minimum target size',
        'wcag-line-height': 'Line height is less than 1.5x the font size',
        'hardcoded-color': 'Fill color is not bound to a variable or style',
        'no-text-style': 'Text node is not using a text style',
        'default-name': 'Node has a default Figma name (e.g., "Frame 1")',
        'detached-component': 'Frame uses component naming convention but is not a component or instance',
        'no-autolayout': 'Frame with multiple children does not use auto-layout',
        'empty-container': 'Frame has no children'
      };

      var defaultNameRegex = /^(Frame|Rectangle|Ellipse|Line|Text|Group|Component|Instance|Vector|Polygon|Star|Section)(\s+\d+)?$/;
      var interactiveNameRegex = /button|link|input|checkbox|radio|switch|toggle|tab|menu-item/i;

      // ---- Resolve active rules ----
      var requestedRules = msg.rules || ['all'];
      var activeRuleSet = {};
      for (var ri = 0; ri < requestedRules.length; ri++) {
        var ruleOrGroup = requestedRules[ri];
        if (ruleGroups[ruleOrGroup]) {
          var groupRules = ruleGroups[ruleOrGroup];
          for (var gi = 0; gi < groupRules.length; gi++) {
            activeRuleSet[groupRules[gi]] = true;
          }
        } else if (severityMap[ruleOrGroup]) {
          activeRuleSet[ruleOrGroup] = true;
        }
      }

      var maxDepth = typeof msg.maxDepth === 'number' ? msg.maxDepth : 10;
      var maxFindings = typeof msg.maxFindings === 'number' ? msg.maxFindings : 100;

      // ---- Resolve root node ----
      var rootNode;
      if (msg.nodeId) {
        rootNode = await figma.getNodeByIdAsync(msg.nodeId);
        if (!rootNode) {
          throw new Error('Node not found: ' + msg.nodeId);
        }
      } else {
        rootNode = figma.currentPage;
      }

      // ---- Collect context (styles and variables for design-system rules) ----
      var paintStyleIds = {};
      var textStyleIds = {};
      var variableIds = {};

      if (activeRuleSet['hardcoded-color'] || activeRuleSet['no-text-style']) {
        try {
          var paintStyles = await figma.getLocalPaintStylesAsync();
          for (var pi = 0; pi < paintStyles.length; pi++) {
            paintStyleIds[paintStyles[pi].id] = true;
          }
        } catch (e) { /* ignore */ }

        try {
          var textStyles = await figma.getLocalTextStylesAsync();
          for (var ti = 0; ti < textStyles.length; ti++) {
            textStyleIds[textStyles[ti].id] = true;
          }
        } catch (e) { /* ignore */ }

        try {
          var localVars = await figma.variables.getLocalVariablesAsync();
          for (var vi = 0; vi < localVars.length; vi++) {
            variableIds[localVars[vi].id] = true;
          }
        } catch (e) { /* ignore */ }
      }

      // ---- Findings storage ----
      var findings = {};
      for (var ai = 0; ai < allRuleIds.length; ai++) {
        if (activeRuleSet[allRuleIds[ai]]) {
          findings[allRuleIds[ai]] = [];
        }
      }
      var totalFindings = 0;
      var nodesScanned = 0;
      var truncated = false;

      // ---- Tree walk ----
      function walkNode(node, depth) {
        if (depth > maxDepth) return;
        if (truncated) return;

        nodesScanned++;

        var nodeType, nodeName, nodeId;
        try {
          nodeType = node.type;
          nodeName = node.name;
          nodeId = node.id;
        } catch (e) {
          return; // Slot sublayer — skip entirely
        }

        // Skip pages for most checks but still recurse into their children
        var isPage = nodeType === 'PAGE';
        var isSection = nodeType === 'SECTION';

        // ---- WCAG checks ----

        // wcag-contrast: TEXT nodes
        if (activeRuleSet['wcag-contrast'] && nodeType === 'TEXT' && !truncated) {
          try {
            var fills = node.fills;
            if (fills && fills.length > 0) {
              for (var fci = 0; fci < fills.length; fci++) {
                if (fills[fci].type === 'SOLID' && fills[fci].visible !== false) {
                  var fg = fills[fci].color;
                  var bg = lintGetEffectiveBg(node);
                  var ratio = lintContrastRatio(fg.r, fg.g, fg.b, bg.r, bg.g, bg.b);
                  var fontSize = 16;
                  var fontWeight = null;
                  try { fontSize = node.fontSize; } catch (e) { /* mixed */ }
                  try { fontWeight = node.fontWeight; } catch (e) { /* mixed */ }
                  if (typeof fontSize !== 'number') fontSize = 16;
                  var isLarge = lintIsLargeText(fontSize, fontWeight);
                  var required = isLarge ? 3.0 : 4.5;
                  var fgOpacity = (fills[fci].opacity !== undefined) ? fills[fci].opacity : 1;
                  var approximate = fgOpacity < 1 || bg.opacity < 1;
                  if (ratio < required) {
                    if (totalFindings < maxFindings) {
                      var finding = {
                        id: nodeId,
                        name: nodeName,
                        ratio: ratio.toFixed(1) + ':1',
                        required: required.toFixed(1) + ':1',
                        fg: lintRgbToHex(fg.r, fg.g, fg.b),
                        bg: lintRgbToHex(bg.r, bg.g, bg.b)
                      };
                      if (approximate) finding.approximate = true;
                      findings['wcag-contrast'].push(finding);
                      totalFindings++;
                    } else {
                      truncated = true;
                    }
                  }
                  break; // Only check the first visible solid fill
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-text-size: TEXT nodes with fontSize < 12
        if (activeRuleSet['wcag-text-size'] && nodeType === 'TEXT' && !truncated) {
          try {
            var ts = node.fontSize;
            if (typeof ts === 'number' && ts < 12) {
              if (totalFindings < maxFindings) {
                findings['wcag-text-size'].push({
                  id: nodeId,
                  name: nodeName,
                  fontSize: ts
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // wcag-target-size: Interactive elements < 24x24
        if (activeRuleSet['wcag-target-size'] && !isPage && !isSection && !truncated) {
          try {
            if ((nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'INSTANCE' || nodeType === 'COMPONENT_SET') && interactiveNameRegex.test(nodeName)) {
              var tw = node.width;
              var th = node.height;
              if ((typeof tw === 'number' && tw < 24) || (typeof th === 'number' && th < 24)) {
                if (totalFindings < maxFindings) {
                  findings['wcag-target-size'].push({
                    id: nodeId,
                    name: nodeName,
                    width: tw,
                    height: th
                  });
                  totalFindings++;
                } else {
                  truncated = true;
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-line-height: TEXT nodes where lineHeight < 1.5 * fontSize
        if (activeRuleSet['wcag-line-height'] && nodeType === 'TEXT' && !truncated) {
          try {
            var lh = node.lineHeight;
            var fs = node.fontSize;
            var effectiveLh = null;
            if (lh && typeof fs === 'number' && typeof lh === 'object' && typeof lh.value === 'number') {
              if (lh.unit === 'PIXELS') {
                effectiveLh = lh.value;
              } else if (lh.unit === 'PERCENT') {
                effectiveLh = fs * (lh.value / 100);
              }
            }
            if (effectiveLh !== null && effectiveLh < 1.5 * fs) {
              if (totalFindings < maxFindings) {
                findings['wcag-line-height'].push({
                  id: nodeId,
                  name: nodeName,
                  lineHeight: effectiveLh,
                  fontSize: fs,
                  recommended: (1.5 * fs).toFixed(1)
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // ---- Design System checks ----

        // hardcoded-color: Solid fills without variable binding or style
        if (activeRuleSet['hardcoded-color'] && !isPage && !isSection && !truncated) {
          try {
            var hcFills = node.fills;
            if (hcFills && hcFills.length > 0) {
              var hasFillStyle = false;
              try {
                hasFillStyle = node.fillStyleId && node.fillStyleId !== '';
              } catch (e) { /* mixed fill styles */ }

              if (!hasFillStyle) {
                for (var hci = 0; hci < hcFills.length; hci++) {
                  var hcFill = hcFills[hci];
                  if (hcFill.type === 'SOLID' && hcFill.visible !== false) {
                    var hasBoundVar = false;
                    try {
                      if (hcFill.boundVariables && hcFill.boundVariables.color) {
                        hasBoundVar = true;
                      }
                    } catch (e) { /* no bound vars */ }

                    if (!hasBoundVar) {
                      if (totalFindings < maxFindings) {
                        findings['hardcoded-color'].push({
                          id: nodeId,
                          name: nodeName,
                          color: lintRgbToHex(hcFill.color.r, hcFill.color.g, hcFill.color.b)
                        });
                        totalFindings++;
                      } else {
                        truncated = true;
                      }
                      break; // One finding per node
                    }
                  }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // no-text-style: TEXT nodes without textStyleId
        if (activeRuleSet['no-text-style'] && nodeType === 'TEXT' && !truncated) {
          try {
            var hasTextStyle = node.textStyleId && node.textStyleId !== '';
            if (!hasTextStyle) {
              if (totalFindings < maxFindings) {
                findings['no-text-style'].push({
                  id: nodeId,
                  name: nodeName
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // default-name: Nodes with default Figma names
        if (activeRuleSet['default-name'] && !isPage && !truncated) {
          try {
            if (defaultNameRegex.test(nodeName)) {
              if (totalFindings < maxFindings) {
                findings['default-name'].push({
                  id: nodeId,
                  name: nodeName,
                  type: nodeType
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // detached-component: Frames with "/" in name but not component/instance
        if (activeRuleSet['detached-component'] && nodeType === 'FRAME' && !truncated) {
          try {
            if (nodeName.indexOf('/') !== -1) {
              if (totalFindings < maxFindings) {
                findings['detached-component'].push({
                  id: nodeId,
                  name: nodeName
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // ---- Layout checks ----

        // no-autolayout: Frames with 2+ children and no auto-layout
        if (activeRuleSet['no-autolayout'] && !isPage && !isSection && !truncated) {
          try {
            if (nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'COMPONENT_SET') {
              var childCount = 0;
              try { childCount = node.children ? node.children.length : 0; } catch (e) { /* skip */ }
              if (childCount >= 2) {
                var layoutMode = 'NONE';
                try { layoutMode = node.layoutMode; } catch (e) { /* skip */ }
                if (!layoutMode || layoutMode === 'NONE') {
                  if (totalFindings < maxFindings) {
                    findings['no-autolayout'].push({
                      id: nodeId,
                      name: nodeName,
                      childCount: childCount
                    });
                    totalFindings++;
                  } else {
                    truncated = true;
                  }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // empty-container: Frames with zero children
        if (activeRuleSet['empty-container'] && !isPage && !isSection && !truncated) {
          try {
            if (nodeType === 'FRAME') {
              var ec = 0;
              try { ec = node.children ? node.children.length : 0; } catch (e) { /* skip */ }
              if (ec === 0) {
                if (totalFindings < maxFindings) {
                  findings['empty-container'].push({
                    id: nodeId,
                    name: nodeName
                  });
                  totalFindings++;
                } else {
                  truncated = true;
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // ---- Recurse into children ----
        try {
          if (node.children) {
            for (var ci = 0; ci < node.children.length; ci++) {
              if (truncated) break;
              walkNode(node.children[ci], depth + 1);
            }
          }
        } catch (e) { /* no children or slot sublayer */ }
      }

      // ---- Execute walk ----
      walkNode(rootNode, 0);

      // ---- Build response ----
      var categories = [];
      var summaryObj = { critical: 0, warning: 0, info: 0, total: 0 };

      for (var rk = 0; rk < allRuleIds.length; rk++) {
        var ruleId = allRuleIds[rk];
        if (!findings[ruleId] || findings[ruleId].length === 0) continue;
        var sev = severityMap[ruleId];
        categories.push({
          rule: ruleId,
          severity: sev,
          count: findings[ruleId].length,
          description: ruleDescriptions[ruleId],
          nodes: findings[ruleId]
        });
        summaryObj[sev] = (summaryObj[sev] || 0) + findings[ruleId].length;
        summaryObj.total += findings[ruleId].length;
      }

      var responseData = {
        rootNodeId: rootNode.id,
        rootNodeName: rootNode.name,
        nodesScanned: nodesScanned,
        categories: categories,
        summary: summaryObj
      };

      if (truncated) {
        responseData.warning = 'Showing first ' + maxFindings + ' findings...';
      }

      console.log('🌉 [Desktop Bridge] Lint complete: ' + summaryObj.total + ' findings across ' + nodesScanned + ' nodes');

      figma.ui.postMessage({
        type: 'LINT_DESIGN_RESULT',
        requestId: msg.requestId,
        success: true,
        data: responseData
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Lint design error:', errorMsg);
      figma.ui.postMessage({
        type: 'LINT_DESIGN_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // FIGJAM TOOLS — Only functional when editorType === 'figjam'
  // ============================================================================

  // CREATE_STICKY - Create a sticky note
  else if (msg.type === 'CREATE_STICKY') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_STICKY is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Creating sticky note');

      var sticky = figma.createSticky();
      await figma.loadFontAsync(sticky.text.fontName);
      sticky.text.characters = msg.text || '';

      if (typeof msg.x === 'number') sticky.x = msg.x;
      if (typeof msg.y === 'number') sticky.y = msg.y;

      // Set sticky color if provided
      if (msg.color) {
        var stickyColor = __stickyColors[msg.color.toUpperCase()];
        if (stickyColor) {
          sticky.fills = [{ type: 'SOLID', color: stickyColor }];
        }
      }

      figma.ui.postMessage({
        type: 'CREATE_STICKY_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: sticky.id, type: sticky.type, name: sticky.name, x: sticky.x, y: sticky.y }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create sticky error:', error);
      figma.ui.postMessage({
        type: 'CREATE_STICKY_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_STICKIES - Batch create sticky notes
  else if (msg.type === 'CREATE_STICKIES') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_STICKIES is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Batch creating sticky notes:', msg.stickies.length);

      var created = [];
      var failed = [];

      // Load font once for all stickies (they all share the same default font)
      var stickyFontLoaded = false;

      for (var si = 0; si < msg.stickies.length; si++) {
        try {
          var spec = msg.stickies[si];
          var sticky = figma.createSticky();
          if (!stickyFontLoaded) {
            await figma.loadFontAsync(sticky.text.fontName);
            stickyFontLoaded = true;
          }
          sticky.text.characters = spec.text || '';

          if (typeof spec.x === 'number') sticky.x = spec.x;
          if (typeof spec.y === 'number') sticky.y = spec.y;

          if (spec.color) {
            var sc = __stickyColors[spec.color.toUpperCase()];
            if (sc) {
              sticky.fills = [{ type: 'SOLID', color: sc }];
            }
          }

          created.push({ id: sticky.id, type: sticky.type, name: sticky.name, x: sticky.x, y: sticky.y });
        } catch (e) {
          failed.push({ index: si, error: e.message || String(e) });
        }
      }

      figma.ui.postMessage({
        type: 'CREATE_STICKIES_RESULT',
        requestId: msg.requestId,
        success: failed.length === 0,
        data: { created: created.length, failed: failed.length, results: created, errors: failed }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Batch create stickies error:', error);
      figma.ui.postMessage({
        type: 'CREATE_STICKIES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_CONNECTOR - Connect two nodes with a connector
  else if (msg.type === 'CREATE_CONNECTOR') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_CONNECTOR is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Creating connector');

      var connector = figma.createConnector();

      // Set start and end endpoints
      var startNode = await figma.getNodeByIdAsync(msg.startNodeId);
      var endNode = await figma.getNodeByIdAsync(msg.endNodeId);

      if (!startNode) throw new Error('Start node not found: ' + msg.startNodeId);
      if (!endNode) throw new Error('End node not found: ' + msg.endNodeId);

      connector.connectorStart = {
        endpointNodeId: msg.startNodeId,
        magnet: 'AUTO'
      };
      connector.connectorEnd = {
        endpointNodeId: msg.endNodeId,
        magnet: 'AUTO'
      };

      // Set label text if provided
      if (msg.label) {
        try {
          await figma.loadFontAsync(connector.text.fontName);
        } catch (e) {
          // Connector default font may not be loadable — fall back to Inter
          await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
          connector.text.fontName = { family: 'Inter', style: 'Medium' };
        }
        connector.text.characters = msg.label;
      }

      figma.ui.postMessage({
        type: 'CREATE_CONNECTOR_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: connector.id, type: connector.type, name: connector.name }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create connector error:', error);
      figma.ui.postMessage({
        type: 'CREATE_CONNECTOR_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_SHAPE_WITH_TEXT - Create a labeled shape
  else if (msg.type === 'CREATE_SHAPE_WITH_TEXT') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_SHAPE_WITH_TEXT is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Creating shape with text');

      var shape = figma.createShapeWithText();

      // Set shape type if provided
      if (msg.shapeType) {
        shape.shapeType = msg.shapeType;
      }

      // Set text
      if (msg.text) {
        try {
          await figma.loadFontAsync(shape.text.fontName);
        } catch (e) {
          await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
          shape.text.fontName = { family: 'Inter', style: 'Medium' };
        }
        shape.text.characters = msg.text;
      }

      if (typeof msg.x === 'number') shape.x = msg.x;
      if (typeof msg.y === 'number') shape.y = msg.y;

      figma.ui.postMessage({
        type: 'CREATE_SHAPE_WITH_TEXT_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: shape.id, type: shape.type, name: shape.name, x: shape.x, y: shape.y }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create shape with text error:', error);
      figma.ui.postMessage({
        type: 'CREATE_SHAPE_WITH_TEXT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_TABLE - Create a table with data
  else if (msg.type === 'CREATE_TABLE') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_TABLE is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Creating table:', msg.rows, 'x', msg.columns);

      var table = figma.createTable(msg.rows, msg.columns);

      if (typeof msg.x === 'number') table.x = msg.x;
      if (typeof msg.y === 'number') table.y = msg.y;

      // Populate cells if data provided
      if (msg.data && Array.isArray(msg.data)) {
        for (var row = 0; row < msg.data.length && row < msg.rows; row++) {
          for (var col = 0; col < msg.data[row].length && col < msg.columns; col++) {
            var cell = table.cellAt(row, col);
            if (cell && msg.data[row][col] != null) {
              await figma.loadFontAsync(cell.text.fontName);
              cell.text.characters = String(msg.data[row][col]);
            }
          }
        }
      }

      figma.ui.postMessage({
        type: 'CREATE_TABLE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: table.id, type: table.type, name: table.name, rows: msg.rows, columns: msg.columns }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create table error:', error);
      figma.ui.postMessage({
        type: 'CREATE_TABLE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_CODE_BLOCK - Create a code block
  else if (msg.type === 'CREATE_CODE_BLOCK') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_CODE_BLOCK is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Creating code block');

      var codeBlock = figma.createCodeBlock();

      // Code blocks require Source Code Pro font, fall back to Inter if unavailable
      try {
        await figma.loadFontAsync({ family: 'Source Code Pro', style: 'Medium' });
      } catch (e) {
        await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
      }

      if (msg.code) {
        codeBlock.code = msg.code;
      }
      if (msg.language) {
        codeBlock.codeLanguage = msg.language;
      }

      if (typeof msg.x === 'number') codeBlock.x = msg.x;
      if (typeof msg.y === 'number') codeBlock.y = msg.y;

      figma.ui.postMessage({
        type: 'CREATE_CODE_BLOCK_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: codeBlock.id, type: codeBlock.type, name: codeBlock.name, x: codeBlock.x, y: codeBlock.y }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create code block error:', error);
      figma.ui.postMessage({
        type: 'CREATE_CODE_BLOCK_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_BOARD_CONTENTS - Read all FigJam nodes from the current page
  else if (msg.type === 'GET_BOARD_CONTENTS') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('GET_BOARD_CONTENTS is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Reading board contents');

      var maxNodes = msg.maxNodes || 500;
      var filterTypes = msg.nodeTypes || null;

      // FigJam node types we care about
      var figjamTypes = ['STICKY', 'SHAPE_WITH_TEXT', 'CONNECTOR', 'TABLE', 'CODE_BLOCK', 'SECTION', 'FRAME', 'TEXT'];

      var allNodes = figma.currentPage.children;
      var results = [];
      var truncated = false;

      for (var ni = 0; ni < allNodes.length && results.length < maxNodes; ni++) {
        var node = allNodes[ni];

        // Skip if filtering and this type isn't in the filter list
        if (filterTypes && filterTypes.indexOf(node.type) === -1) continue;
        // Skip if not a FigJam-relevant type
        if (!filterTypes && figjamTypes.indexOf(node.type) === -1) continue;

        var entry = {
          id: node.id,
          type: node.type,
          name: node.name,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height
        };

        // Extract text content based on node type
        if (node.type === 'STICKY') {
          entry.text = node.text ? node.text.characters : '';
          if (node.fills && node.fills.length > 0 && node.fills[0].color) {
            entry.color = node.fills[0].color;
          }
        } else if (node.type === 'SHAPE_WITH_TEXT') {
          entry.text = node.text ? node.text.characters : '';
          entry.shapeType = node.shapeType || 'ROUNDED_RECTANGLE';
        } else if (node.type === 'CONNECTOR') {
          entry.connectorStart = node.connectorStart || null;
          entry.connectorEnd = node.connectorEnd || null;
          entry.text = node.text ? node.text.characters : '';
        } else if (node.type === 'CODE_BLOCK') {
          entry.code = node.code || '';
          entry.codeLanguage = node.codeLanguage || '';
        } else if (node.type === 'TABLE') {
          entry.numRows = node.numRows;
          entry.numColumns = node.numColumns;
          // Read first 10 rows of cell data to avoid huge payloads
          var cellData = [];
          var maxCellRows = Math.min(node.numRows, 10);
          for (var row = 0; row < maxCellRows; row++) {
            var rowData = [];
            for (var col = 0; col < node.numColumns; col++) {
              try {
                var cell = node.cellAt(row, col);
                rowData.push(cell && cell.text ? cell.text.characters : '');
              } catch (e) {
                rowData.push('');
              }
            }
            cellData.push(rowData);
          }
          entry.cellData = cellData;
          if (node.numRows > 10) entry.cellDataTruncated = true;
        } else if (node.type === 'SECTION') {
          entry.childCount = node.children ? node.children.length : 0;
        } else if (node.type === 'TEXT') {
          entry.text = node.characters || '';
        }

        results.push(entry);
      }

      if (results.length >= maxNodes) truncated = true;

      figma.ui.postMessage({
        type: 'GET_BOARD_CONTENTS_RESULT',
        requestId: msg.requestId,
        success: true,
        data: {
          nodes: results,
          totalFound: results.length,
          truncated: truncated,
          page: figma.currentPage.name
        }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get board contents error:', error);
      figma.ui.postMessage({
        type: 'GET_BOARD_CONTENTS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_CONNECTIONS - Read the connection graph from the board
  else if (msg.type === 'GET_CONNECTIONS') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('GET_CONNECTIONS is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Reading connection graph');

      var connectors = figma.currentPage.findAll(function(n) { return n.type === 'CONNECTOR'; });
      var edges = [];
      var nodeMap = {};

      for (var ci = 0; ci < connectors.length; ci++) {
        var conn = connectors[ci];
        var startId = conn.connectorStart ? conn.connectorStart.endpointNodeId : null;
        var endId = conn.connectorEnd ? conn.connectorEnd.endpointNodeId : null;
        var label = conn.text ? conn.text.characters : '';

        edges.push({
          connectorId: conn.id,
          startNodeId: startId,
          endNodeId: endId,
          label: label
        });

        // Build a lookup of connected nodes with their names/types
        if (startId && !nodeMap[startId]) {
          var startNode = await figma.getNodeByIdAsync(startId);
          if (startNode) {
            nodeMap[startId] = {
              id: startId,
              type: startNode.type,
              name: startNode.name,
              text: startNode.text ? startNode.text.characters : (startNode.characters || '')
            };
          }
        }
        if (endId && !nodeMap[endId]) {
          var endNode = await figma.getNodeByIdAsync(endId);
          if (endNode) {
            nodeMap[endId] = {
              id: endId,
              type: endNode.type,
              name: endNode.name,
              text: endNode.text ? endNode.text.characters : (endNode.characters || '')
            };
          }
        }
      }

      figma.ui.postMessage({
        type: 'GET_CONNECTIONS_RESULT',
        requestId: msg.requestId,
        success: true,
        data: {
          edges: edges,
          connectedNodes: nodeMap,
          totalConnectors: connectors.length,
          totalConnectedNodes: Object.keys(nodeMap).length
        }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get connections error:', error);
      figma.ui.postMessage({
        type: 'GET_CONNECTIONS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }
  // ==========================================================================
  // SLIDES TOOLS — Figma Slides command handlers
  // ==========================================================================

  // LIST_SLIDES - List all slides in the presentation
  else if (msg.type === 'LIST_SLIDES') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('LIST_SLIDES is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Listing slides');

      var grid = figma.getSlideGrid();
      var slides = [];
      for (var rowIdx = 0; rowIdx < grid.length; rowIdx++) {
        var row = grid[rowIdx];
        // SlideGrid rows are array-like (iterable with numeric indices), not objects with .children
        for (var colIdx = 0; colIdx < row.length; colIdx++) {
          var slide = row[colIdx];
          slides.push({
            id: slide.id,
            name: slide.name,
            row: rowIdx,
            col: colIdx,
            isSkippedSlide: slide.isSkippedSlide,
            childCount: slide.children ? slide.children.length : 0
          });
        }
      }

      figma.ui.postMessage({
        type: 'LIST_SLIDES_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { slides: slides, totalSlides: slides.length, totalRows: grid.length }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] List slides error:', error);
      figma.ui.postMessage({
        type: 'LIST_SLIDES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_SLIDE_CONTENT - Get node tree of a slide
  else if (msg.type === 'GET_SLIDE_CONTENT') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('GET_SLIDE_CONTENT is only available in Slides files');
      }
      var slideNode = await figma.getNodeByIdAsync(msg.slideId);
      if (!slideNode || slideNode.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Getting slide content:', slideNode.name);

      function serializeNode(n) {
        var result = { id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height };
        if (n.type === 'TEXT') {
          result.characters = n.characters;
          result.fontSize = n.fontSize;
        }
        if (n.children && n.children.length > 0) {
          result.children = [];
          for (var i = 0; i < n.children.length; i++) {
            result.children.push(serializeNode(n.children[i]));
          }
        }
        return result;
      }

      figma.ui.postMessage({
        type: 'GET_SLIDE_CONTENT_RESULT',
        requestId: msg.requestId,
        success: true,
        data: serializeNode(slideNode)
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get slide content error:', error);
      figma.ui.postMessage({
        type: 'GET_SLIDE_CONTENT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_SLIDE - Create a new slide
  else if (msg.type === 'CREATE_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('CREATE_SLIDE is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Creating slide');

      var newSlide;
      if (typeof msg.row === 'number' && typeof msg.col === 'number') {
        newSlide = figma.createSlide({ row: msg.row, col: msg.col });
      } else {
        newSlide = figma.createSlide();
      }

      figma.ui.postMessage({
        type: 'CREATE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: newSlide.id, name: newSlide.name }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create slide error:', error);
      figma.ui.postMessage({
        type: 'CREATE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // DELETE_SLIDE - Delete a slide
  else if (msg.type === 'DELETE_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('DELETE_SLIDE is only available in Slides files');
      }
      var delSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!delSlide || delSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Deleting slide:', delSlide.name);

      var delName = delSlide.name;
      delSlide.remove();

      figma.ui.postMessage({
        type: 'DELETE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { deleted: msg.slideId, name: delName }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Delete slide error:', error);
      figma.ui.postMessage({
        type: 'DELETE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // DUPLICATE_SLIDE - Clone a slide
  else if (msg.type === 'DUPLICATE_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('DUPLICATE_SLIDE is only available in Slides files');
      }
      var srcSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!srcSlide || srcSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Duplicating slide:', srcSlide.name);

      var clone = srcSlide.clone();

      figma.ui.postMessage({
        type: 'DUPLICATE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { originalId: msg.slideId, newId: clone.id, name: clone.name }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Duplicate slide error:', error);
      figma.ui.postMessage({
        type: 'DUPLICATE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_SLIDE_GRID - Get 2D grid layout
  else if (msg.type === 'GET_SLIDE_GRID') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('GET_SLIDE_GRID is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Getting slide grid');

      var slideGrid = figma.getSlideGrid();
      var gridData = [];
      for (var ri = 0; ri < slideGrid.length; ri++) {
        var gridRow = slideGrid[ri];
        var rowSlides = [];
        // SlideGrid rows are array-like (iterable with numeric indices)
        for (var ci = 0; ci < gridRow.length; ci++) {
          var gs = gridRow[ci];
          rowSlides.push({ id: gs.id, name: gs.name, col: ci, isSkippedSlide: gs.isSkippedSlide });
        }
        gridData.push({ rowIndex: ri, slides: rowSlides });
      }

      figma.ui.postMessage({
        type: 'GET_SLIDE_GRID_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { grid: gridData, totalRows: gridData.length }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get slide grid error:', error);
      figma.ui.postMessage({
        type: 'GET_SLIDE_GRID_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // REORDER_SLIDES - Reorder slides via 2D grid of slide IDs
  else if (msg.type === 'REORDER_SLIDES') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('REORDER_SLIDES is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Reordering slides');

      var newGrid = msg.grid; // 2D array of slide IDs

      // Build a lookup: slideId → SlideNode from the current grid
      var currentGrid = figma.getSlideGrid();
      var slideMap = {};
      for (var gri = 0; gri < currentGrid.length; gri++) {
        var grow = currentGrid[gri];
        for (var gci = 0; gci < grow.length; gci++) {
          slideMap[grow[gci].id] = grow[gci];
        }
      }

      // Build new grid as arrays of SlideNode references
      var reorderedRows = [];
      for (var rri = 0; rri < newGrid.length; rri++) {
        var rowIds = newGrid[rri];
        var rowSlides = [];
        for (var cci = 0; cci < rowIds.length; cci++) {
          var slideRef = slideMap[rowIds[cci]];
          if (!slideRef) throw new Error('Slide not found in current grid: ' + rowIds[cci]);
          rowSlides.push(slideRef);
        }
        reorderedRows.push(rowSlides);
      }

      figma.setSlideGrid(reorderedRows);

      figma.ui.postMessage({
        type: 'REORDER_SLIDES_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { success: true, rows: reorderedRows.length }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Reorder slides error:', error);
      figma.ui.postMessage({
        type: 'REORDER_SLIDES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // SET_SLIDE_TRANSITION - Set transition on a slide
  else if (msg.type === 'SET_SLIDE_TRANSITION') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('SET_SLIDE_TRANSITION is only available in Slides files');
      }
      var transSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!transSlide || transSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Setting slide transition:', transSlide.name);

      var transConfig = {
        style: msg.style,
        duration: msg.duration,
        curve: msg.curve,
        timing: { type: 'ON_CLICK' }
      };
      if (msg.timing) {
        transConfig.timing = msg.timing;
      }
      transSlide.setSlideTransition(transConfig);

      figma.ui.postMessage({
        type: 'SET_SLIDE_TRANSITION_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: transSlide.id, transition: transSlide.getSlideTransition() }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Set slide transition error:', error);
      figma.ui.postMessage({
        type: 'SET_SLIDE_TRANSITION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_SLIDE_TRANSITION - Read transition from a slide
  else if (msg.type === 'GET_SLIDE_TRANSITION') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('GET_SLIDE_TRANSITION is only available in Slides files');
      }
      var readTransSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!readTransSlide || readTransSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Getting slide transition:', readTransSlide.name);

      figma.ui.postMessage({
        type: 'GET_SLIDE_TRANSITION_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: readTransSlide.id, transition: readTransSlide.getSlideTransition() }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get slide transition error:', error);
      figma.ui.postMessage({
        type: 'GET_SLIDE_TRANSITION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // SET_SLIDES_VIEW_MODE - Toggle between grid and single-slide view
  else if (msg.type === 'SET_SLIDES_VIEW_MODE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('SET_SLIDES_VIEW_MODE is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Setting slides view mode:', msg.mode);

      figma.viewport.slidesView = msg.mode;

      figma.ui.postMessage({
        type: 'SET_SLIDES_VIEW_MODE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { mode: figma.viewport.slidesView }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Set slides view mode error:', error);
      figma.ui.postMessage({
        type: 'SET_SLIDES_VIEW_MODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_FOCUSED_SLIDE - Get currently focused slide
  else if (msg.type === 'GET_FOCUSED_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('GET_FOCUSED_SLIDE is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Getting focused slide');

      var focused = figma.currentPage.focusedSlide;
      var focusData = focused ? { id: focused.id, name: focused.name } : { focused: null };

      figma.ui.postMessage({
        type: 'GET_FOCUSED_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: focusData
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get focused slide error:', error);
      figma.ui.postMessage({
        type: 'GET_FOCUSED_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // FOCUS_SLIDE - Navigate to a specific slide
  else if (msg.type === 'FOCUS_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('FOCUS_SLIDE is only available in Slides files');
      }
      var focusTarget = await figma.getNodeByIdAsync(msg.slideId);
      if (!focusTarget || focusTarget.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Focusing slide:', focusTarget.name);

      figma.viewport.slidesView = 'single-slide';
      figma.currentPage.focusedSlide = focusTarget;

      figma.ui.postMessage({
        type: 'FOCUS_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { focused: focusTarget.id, name: focusTarget.name }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Focus slide error:', error);
      figma.ui.postMessage({
        type: 'FOCUS_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // SKIP_SLIDE - Toggle skip on a slide
  else if (msg.type === 'SKIP_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('SKIP_SLIDE is only available in Slides files');
      }
      var skipSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!skipSlide || skipSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Toggling slide skip:', skipSlide.name, '→', msg.skip);

      skipSlide.isSkippedSlide = !!msg.skip;

      figma.ui.postMessage({
        type: 'SKIP_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: skipSlide.id, isSkippedSlide: skipSlide.isSkippedSlide }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Skip slide error:', error);
      figma.ui.postMessage({
        type: 'SKIP_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ADD_TEXT_TO_SLIDE - Add a text node to a slide
  else if (msg.type === 'ADD_TEXT_TO_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('ADD_TEXT_TO_SLIDE is only available in Slides files');
      }
      var textSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!textSlide || textSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Adding text to slide:', textSlide.name);

      var textNode = figma.createText();
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      textNode.characters = msg.text || '';
      textNode.fontSize = msg.fontSize || 24;
      textNode.x = typeof msg.x === 'number' ? msg.x : 100;
      textNode.y = typeof msg.y === 'number' ? msg.y : 100;
      textSlide.appendChild(textNode);

      figma.ui.postMessage({
        type: 'ADD_TEXT_TO_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: textNode.id, text: textNode.characters }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Add text to slide error:', error);
      figma.ui.postMessage({
        type: 'ADD_TEXT_TO_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ADD_SHAPE_TO_SLIDE - Add a shape to a slide
  else if (msg.type === 'ADD_SHAPE_TO_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('ADD_SHAPE_TO_SLIDE is only available in Slides files');
      }
      var shapeSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!shapeSlide || shapeSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Adding shape to slide:', shapeSlide.name);

      var shape;
      if (msg.shapeType === 'ELLIPSE') {
        shape = figma.createEllipse();
      } else {
        shape = figma.createRectangle();
      }
      shape.x = typeof msg.x === 'number' ? msg.x : 100;
      shape.y = typeof msg.y === 'number' ? msg.y : 100;
      shape.resize(typeof msg.width === 'number' ? msg.width : 200, typeof msg.height === 'number' ? msg.height : 200);

      if (msg.color && typeof msg.color === 'string') {
        var hex = msg.color.replace('#', '');
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
          shape.fills = [{
            type: 'SOLID',
            color: {
              r: parseInt(hex.substring(0, 2), 16) / 255,
              g: parseInt(hex.substring(2, 4), 16) / 255,
              b: parseInt(hex.substring(4, 6), 16) / 255
            }
          }];
        }
      }
      shapeSlide.appendChild(shape);

      figma.ui.postMessage({
        type: 'ADD_SHAPE_TO_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: shape.id, type: shape.type }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Add shape to slide error:', error);
      figma.ui.postMessage({
        type: 'ADD_SHAPE_TO_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
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
      try {
        var node = selection[i];
        selectedNodes.push({
          id: node.id,
          name: node.name,
          type: node.type,
          width: node.width,
          height: node.height
        });
      } catch (e) {
        // Slot sublayers and table cells may not be fully resolvable —
        // accessing .name throws "does not exist" for these node types.
        // Skip silently rather than crashing the plugin.
      }
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
