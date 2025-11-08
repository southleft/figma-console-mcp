# Troubleshooting: Missing Component Descriptions

## The Issue

When calling `figma_get_component`, the component description field is missing or null, even though the Desktop Bridge plugin appears to be running.

## Root Cause Analysis

### Why Descriptions Go Missing

Component descriptions can be retrieved through two paths:

```
Path 1: Desktop Bridge Plugin (RELIABLE)
├─ Accesses Figma Plugin API
├─ node.description available ✓
├─ node.descriptionMarkdown available ✓
└─ Response includes: source="desktop_bridge_plugin"

Path 2: REST API Fallback (UNRELIABLE)
├─ Uses Figma's public REST API
├─ description field often missing due to known Figma API bug
├─ descriptionMarkdown not available
└─ Response includes: source="rest_api"
```

### The figma_get_component Priority Logic

The tool attempts sources in this order:

```typescript
// src/core/figma-tools.ts:2022-2130

// PRIORITY 1: Try Desktop Bridge plugin UI
if (browserManager && ensureInitialized) {
  try {
    const connector = new FigmaDesktopConnector(page);
    const result = await connector.getComponentFromPluginUI(nodeId);

    if (result.success && result.component) {
      // ✓ Has description
      return { source: "desktop_bridge_plugin", component: result.component };
    }
  } catch (desktopError) {
    logger.warn("Desktop Bridge plugin failed, falling back to REST API");
  }
}

// FALLBACK: Use REST API (may have missing description)
const componentData = await api.getComponentData(fileKey, nodeId);
return {
  source: "rest_api",
  component: componentData,
  warning: "description field may be missing due to known Figma API bug"
};
```

## Diagnostic Steps

### Step 1: Check Response Source

```javascript
const response = await figma_get_component({ nodeId: "729:229" });

if (response.source === "desktop_bridge_plugin") {
  // ✓ Desktop Bridge was used successfully
  // Description should be present and reliable
} else if (response.source === "rest_api") {
  // ⚠ Fell back to REST API
  // Description may be missing due to API limitations
}
```

### Step 2: Verify Desktop Bridge is Actually Running

Check console logs for these messages:

```
✓ Required:
  🌉 [Desktop Bridge] Plugin loaded and ready
  🌉 [Desktop Bridge] Ready to handle component requests

✓ When component is requested:
  [DESKTOP_CONNECTOR] 🎯 getComponentFromPluginUI() called, nodeId: 729:229
  [DESKTOP_CONNECTOR] ✅ SUCCESS! Found plugin UI with requestComponentData
  [DESKTOP_CONNECTOR] ✅ Retrieved component "Banner", has description: true
```

### Step 3: Check for Silent Failures

Desktop Bridge can fail silently if:

1. **Plugin UI iframe not found**
   ```
   Error: "No plugin UI found with requestComponentData function"
   ```

2. **browserManager not available**
   - The browser/Puppeteer connection isn't established
   - Falls back to REST API immediately

3. **ensureInitialized not provided**
   - Browser initialization function missing
   - Can't establish Puppeteer connection

4. **Plugin UI function not ready**
   ```javascript
   // ui.html:104-130 defines window.requestComponentData
   // If this function doesn't exist, Desktop Bridge fails
   ```

## Common Scenarios

### Scenario 1: Plugin Running But Not Connected

**Symptoms:**
- Console shows "🌉 [Desktop Bridge] Ready"
- Response shows `source="rest_api"`
- No error logs

**Cause:** Browser/Puppeteer not connected to Figma Desktop

**Solution:**
```bash
# Check if browser is running
ps aux | grep "figma.*remote-debugging-port"

# If not, restart Figma Desktop with debugging enabled
/Applications/Figma.app/Contents/MacOS/Figma --remote-debugging-port=9222
```

### Scenario 2: Plugin Not Running

**Symptoms:**
- No "🌉 [Desktop Bridge]" logs
- Response shows `source="rest_api"`

**Cause:** Desktop Bridge plugin not launched in Figma

**Solution:**
1. Open Figma Desktop
2. Right-click in canvas
3. Plugins → Development → Figma Desktop Bridge
4. Wait for "Desktop Bridge active" message

### Scenario 3: Wrong MCP Mode

**Symptoms:**
- Desktop Bridge runs fine locally
- Fails when deployed/remote

**Cause:** Browser manager not available in deployment mode

**Solution:**
Check the MCP configuration:
```typescript
// Local mode (has browser)
registerFigmaAPITools(
  server,
  getFigmaAPI,
  getCurrentUrl,
  getConsoleMonitor,
  getBrowserManager,  // ✓ Available
  ensureInitialized
);

// Cloudflare mode (no browser)
registerFigmaAPITools(
  server,
  getFigmaAPI,
  getCurrentUrl,
  getConsoleMonitor,
  undefined,           // ✗ Not available
  undefined
);
```

## The User's Case: What Likely Happened

Looking at the original interaction:

1. User called `figma_get_component` for node `729:229`
2. Response showed:
   ```json
   {
     "fileKey": "y83n4o9LOGs74oAoguFcGS",
     "nodeId": "729:229",
     "component": { ... },  // No description field
     "enriched": false
     // No "source" field visible in output
   }
   ```

3. Desktop Bridge logs showed it was running:
   ```
   🌉 [Desktop Bridge] Plugin loaded and ready
   🌉 [Desktop Bridge] Ready to handle component requests
   ```

**Hypothesis:** Desktop Bridge failed silently (caught exception), fell back to REST API, but the response wrapper wasn't showing the `source` field clearly.

**Why the AI hopped to Playwright:**
- Didn't check `response.source` field
- Assumed Desktop Bridge wasn't working
- Tried to "fix" by using browser automation directly
- This violated the "stay in one MCP" principle

## Prevention: How AI Should Handle This

### Correct Workflow

```
1. Call figma_get_component
   ↓
2. Check response.source field
   ↓
3a. If "desktop_bridge_plugin" → Use description ✓
   ↓
3b. If "rest_api" → Check for action_required field
   ↓
4. If action_required present:
   → Provide user instructions from action_required
   → Wait for user to run Desktop Bridge
   → Retry figma_get_component
   ↓
5. Success: source="desktop_bridge_plugin" ✓
```

### Incorrect Workflow (What Happened)

```
1. Call figma_get_component
   ↓
2. No description in response
   ↓
3. ❌ Try figma-official MCP
   ↓
4. ❌ Try Playwright browser automation
   ↓
5. ❌ Give up or ask user for help
```

## Testing the Fix

To verify Desktop Bridge is working properly:

```typescript
// Test script
const response = await figma_get_component({
  fileUrl: "https://figma.com/design/abc123",
  nodeId: "729:229"
});

console.assert(response.source === "desktop_bridge_plugin",
  "Should use Desktop Bridge");
console.assert(response.component.description !== null,
  "Should have description");
console.assert(response.component.descriptionMarkdown !== null,
  "Should have description markdown");
```

Expected success output:
```json
{
  "fileKey": "abc123",
  "nodeId": "729:229",
  "component": {
    "id": "729:229",
    "name": "Banner",
    "description": "A banner component for notifications",
    "descriptionMarkdown": "**Banner** component\n- Supports 4 variants",
    ...
  },
  "source": "desktop_bridge_plugin",
  "note": "Retrieved via Desktop Bridge plugin - description fields are reliable and current"
}
```

## Key Takeaways

1. **Always check `response.source`** - This tells you which path was used
2. **Desktop Bridge failures are caught** - Tool falls back gracefully to REST API
3. **REST API limitations are documented** - Warning messages explain what's missing
4. **Don't hop MCPs** - Stay in Figma console MCP, follow action_required instructions
5. **Trust the tool** - It has proper error handling and fallbacks built in

## Related Documentation

- [AI Decision-Making Guide](./AI-DECISION-MAKING-GUIDE.md) - Comprehensive tool selection guide
- [AI Quick Reference](./AI-QUICK-REFERENCE.md) - TL;DR version for quick lookups
- [Desktop Bridge README](../figma-desktop-bridge/README.md) - Plugin implementation details
