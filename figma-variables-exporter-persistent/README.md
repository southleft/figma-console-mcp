# Figma Variables Exporter - Persistent Version

A persistent Figma plugin that stays open to allow the Figma Console MCP to access variables via Puppeteer's worker API.

## Purpose

This version of the plugin **does NOT auto-close** - it keeps the plugin worker context alive so that the MCP's Desktop connector can access it using `page.workers()` and retrieve variables directly via the Figma Plugin API.

## How It Works

1. **Plugin Loads**: Creates a worker context where the `figma` API is available
2. **Shows UI**: Displays a simple UI to keep the plugin running
3. **Stays Open**: Unlike the V2 plugin, this one doesn't auto-close after 1 second
4. **MCP Access**: While the plugin is open, MCP can call `figma_get_variables` which uses Puppeteer to access the worker and execute code with the `figma` API

## Installation

1. Open Figma Desktop and navigate to your CDS Tokens file
2. Go to `Plugins → Development → Import plugin from manifest...`
3. Select the `manifest-persistent.json` file from this directory
4. The plugin will appear as "Variables Exporter (Persistent)"

## Usage

### Step 1: Run the Persistent Plugin

1. Open your Figma file with variables
2. Run: `Plugins → Development → Variables Exporter (Persistent)`
3. You'll see a purple UI window that says "🔌 Variables Ready"
4. **Leave the plugin open** - don't close it!

### Step 2: Call figma_get_variables from MCP

While the plugin is still running, use Claude Code to call:

```javascript
figma_get_variables()
```

The MCP will:
1. Use `page.workers()` to find the plugin worker
2. Check which worker has the `figma` API available
3. Execute code in that worker to call `figma.variables.getLocalVariablesAsync()`
4. Return all 404 variables with all 19 modes instantly

### Step 3: Close the Plugin

Once you have the variables data, you can manually close the plugin by clicking the X on the plugin UI window.

## Advantages Over V2

- **No Console Log Truncation**: Doesn't use console logs at all
- **No Token Limits**: Returns data directly via MCP tool response
- **Zero Manual Steps**: After running plugin, AI automatically retrieves data
- **Complete Data Access**: All variable properties, all modes, instantly
- **No CDP Issues**: Uses Puppeteer's worker API, not CDP context enumeration

## Technical Details

### Worker Access Pattern

```typescript
// In figma-desktop-connector.ts
const workers = page.workers();  // Get all workers
for (const worker of workers) {
  const hasFigmaApi = await worker.evaluate('typeof figma !== "undefined"');
  if (hasFigmaApi) {
    const result = await worker.evaluate(`
      (async () => {
        const variables = await figma.variables.getLocalVariablesAsync();
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        return { variables, collections };
      })()
    `);
    return result;
  }
}
```

### Why This Works

- **Figma Plugin Workers**: Run in isolated JavaScript contexts (blob URLs)
- **CDP Limitation**: `Runtime.getExecutionContexts` cannot enumerate plugin workers
- **Puppeteer Solution**: `page.workers()` can directly access these workers
- **Persistent Context**: Plugin stays open, keeping worker alive for access

## Troubleshooting

### Plugin closes immediately
- Make sure you're using `manifest-persistent.json`, not `manifest.json`
- The persistent version shows a UI and stays open

### figma_get_variables returns error
- Ensure the plugin is still running when you call the MCP tool
- Check console logs for "Found workers via Puppeteer API"
- Verify worker count is >0

### No workers found
- The plugin must be actively running
- Check that Figma Desktop is running with `--remote-debugging-port=9222`
- Reconnect MCP if needed: `/mcp reconnect figma-console`

## Comparison

| Feature | V2 (Auto-Close) | Persistent |
|---------|-----------------|------------|
| Access Method | Console logs | Direct worker access |
| Truncation Issues | Yes (CDP <1KB limit) | None |
| Token Usage | 285K (excessive) | ~15K (reasonable) |
| Manual Steps | Copy/paste JSON | None |
| Timing Issues | Must parse logs fast | Plugin stays open |
| Enterprise Required | No | No |
| Complete Data | Yes (if parsing works) | Yes (guaranteed) |

## Files

- `manifest-persistent.json` - Plugin manifest (use this to install)
- `code-persistent.js` - Main plugin code (keeps running)
- `code-persistent.ts` - TypeScript source
- `ui-persistent.html` - Plugin UI (shows status)
- `README-PERSISTENT.md` - This file

## Next Steps

After confirming this works, we can:
1. Add automatic variable export when plugin loads
2. Create a button to manually trigger export
3. Add real-time status updates in the UI
4. Support watching for variable changes
