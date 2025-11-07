# Figma Plugin Console Logging Bridge

## Problem

Figma plugins run in a sandboxed context separate from the main page. The Figma Console MCP can only access the main page console, not the plugin sandbox console.

## Solution: Bridge Plugin Logs to Main Page

### Step 1: Add Logging Bridge to Your Plugin Code

In your plugin's **code.ts** (sandbox context):

```typescript
// Add this at the top of your plugin code
function logToMainPage(level: 'log' | 'info' | 'warn' | 'error', ...args: any[]) {
  // Log to plugin console (visible in Figma DevTools)
  console[level](...args);

  // Bridge to main page console (visible to MCP)
  figma.ui.postMessage({
    type: 'CONSOLE_LOG',
    level: level,
    args: args.map(arg => {
      // Serialize objects for transfer
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          return String(arg);
        }
      }
      return arg;
    }),
    timestamp: Date.now()
  });
}

// Replace your console.log calls with these
const pluginLog = {
  log: (...args: any[]) => logToMainPage('log', ...args),
  info: (...args: any[]) => logToMainPage('info', ...args),
  warn: (...args: any[]) => logToMainPage('warn', ...args),
  error: (...args: any[]) => logToMainPage('error', ...args),
};

// Usage:
pluginLog.log('[PropertyFilter] Starting analysis...');
pluginLog.error('[ClaudeClient] Token mapping failed:', error);
```

### Step 2: Add Message Handler to Your UI Code

In your plugin's **ui.html** or **ui.tsx** (main thread context):

```typescript
// Listen for console messages from plugin sandbox
window.onmessage = (event) => {
  const msg = event.data.pluginMessage;

  if (msg?.type === 'CONSOLE_LOG') {
    const { level, args, timestamp } = msg;

    // Log to main page console (where MCP can see it)
    const prefix = `[PLUGIN ${new Date(timestamp).toISOString()}]`;
    console[level](prefix, ...args);
  }
};
```

### Step 3: Update Your Plugin Code

Replace all instances of:
```typescript
// OLD - only visible in plugin sandbox
console.log('[PropertyFilter]', data);
console.error('[ClaudeClient]', error);

// NEW - visible to both plugin sandbox AND MCP
pluginLog.log('[PropertyFilter]', data);
pluginLog.error('[ClaudeClient]', error);
```

## Testing

1. Run your plugin
2. Use the Figma Console MCP to capture logs:
   ```javascript
   figma_get_console_logs({ count: 100, level: 'all' })
   ```
3. You should now see messages prefixed with `[PLUGIN ...]`

## Example Output

**Before (MCP sees nothing):**
```json
{
  "logs": [],
  "totalCount": 0
}
```

**After (MCP sees bridged logs):**
```json
{
  "logs": [
    {
      "level": "log",
      "message": "[PLUGIN 2025-01-15T10:30:45.123Z] [PropertyFilter] Starting analysis...",
      "timestamp": 1705318245123
    },
    {
      "level": "error",
      "message": "[PLUGIN 2025-01-15T10:30:46.456Z] [ClaudeClient] Token mapping failed: {...}",
      "timestamp": 1705318246456
    }
  ],
  "totalCount": 2
}
```

## Advanced: Automatic Console Patching

For a more seamless experience, you can patch the console globally:

```typescript
// In your plugin code.ts
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

// Override console to bridge all logs automatically
console.log = (...args) => {
  originalConsole.log(...args);
  logToMainPage('log', ...args);
};

console.info = (...args) => {
  originalConsole.info(...args);
  logToMainPage('info', ...args);
};

console.warn = (...args) => {
  originalConsole.warn(...args);
  logToMainPage('warn', ...args);
};

console.error = (...args) => {
  originalConsole.error(...args);
  logToMainPage('error', ...args);
};
```

Now all your existing `console.log()` calls will automatically bridge to the main page!

## Limitations

- **Structured data**: Complex objects will be stringified for transfer
- **Performance**: Adds slight overhead for message passing
- **Message size**: Very large objects may exceed postMessage limits

## Alternative: Use Figma's Built-in Console

If you prefer not to modify your plugin code, you can:
1. Open Figma's DevTools: **Plugins → Development → Open Console**
2. Manually copy logs from there
3. Paste them into Claude Code for analysis

But the bridge approach enables **autonomous debugging** where the AI can directly read your plugin logs without manual intervention.
