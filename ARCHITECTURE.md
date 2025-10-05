# Figma Console MCP - Technical Architecture

## Overview

This document describes the technical architecture of the Figma Console MCP server, which enables AI coding assistants to access console logs and screenshots from Figma plugins in real-time.

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                  AI Coding Assistant                 │
│              (Cursor, Claude Code, etc.)             │
└───────────────────┬─────────────────────────────────┘
                    │ MCP Protocol (stdio/HTTP)
                    │
┌───────────────────▼─────────────────────────────────┐
│              Figma Console MCP Server                │
│                                                      │
│  ┌─────────────────────────────────────────────┐   │
│  │  MCP Protocol Layer                         │   │
│  │  - Tool registration & dispatch             │   │
│  │  - Request/response handling                │   │
│  │  - Error handling & validation              │   │
│  └──────────────────┬──────────────────────────┘   │
│                     │                               │
│  ┌──────────────────▼──────────────────────────┐   │
│  │  Tool Implementations                       │   │
│  │  - figma_get_console_logs()                 │   │
│  │  - figma_take_screenshot()                  │   │
│  │  - figma_watch_console()                    │   │
│  │  - figma_reload_plugin()                    │   │
│  │  - figma_clear_console()                    │   │
│  └──┬────────────┬────────────┬─────────────┬──┘   │
│     │            │            │             │       │
│  ┌──▼────────┐ ┌▼──────────┐ ┌▼───────────┐ │      │
│  │  Console  │ │Screenshot │ │   Figma    │ │      │
│  │  Monitor  │ │  Manager  │ │  Manager   │ │      │
│  └──┬────────┘ └┬──────────┘ └┬───────────┘ │      │
│     │           │             │             │       │
│     │  ┌────────▼─────────────▼─────────────▼───┐  │
│     │  │    Chrome DevTools Protocol Client    │  │
│     │  │         (chrome-remote-interface)      │  │
│     │  └────────────────┬───────────────────────┘  │
│     │                   │                          │
│  ┌──▼───────────────────▼───────────────────────┐  │
│  │         Puppeteer Browser Controller         │  │
│  │  - Launch/connect to Chrome                  │  │
│  │  - Navigate to Figma                         │  │
│  │  - Page management                           │  │
│  └────────────────────┬─────────────────────────┘  │
└───────────────────────┼─────────────────────────────┘
                        │ WebSocket (CDP)
                        │
┌───────────────────────▼─────────────────────────────┐
│              Chrome Browser (Controlled)             │
│  ┌─────────────────────────────────────────────┐   │
│  │         Figma Web Application               │   │
│  │  ┌───────────────────────────────────────┐ │   │
│  │  │   Figma Plugin (User's Code)          │ │   │
│  │  │   - Executes in sandboxed iframe      │ │   │
│  │  │   - console.log/warn/error → DevTools │ │   │
│  │  └───────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## Architectural Decisions

### Why Puppeteer + CDP over Chrome Extension?

This implementation uses **Puppeteer + Chrome DevTools Protocol** (similar to ChromeDevTools MCP) rather than a **Chrome Extension + Node Server** approach (like AgentDesk browser-tools-mcp).

**Rationale:**
1. **Zero User Setup**: No browser extension installation required
2. **Automation-First**: Can navigate to Figma and reload plugins programmatically
3. **Full Control**: Complete browser automation for testing workflows
4. **Figma-Specific**: Can detect plugin iframes and filter logs automatically
5. **Simpler Architecture**: Fewer components to maintain

**Incorporated from AgentDesk:**
- Intelligent log truncation to prevent overwhelming AI context
- WebSocket-based streaming for real-time console monitoring
- Configurable limits on log buffer size and content length
- Smart filtering to reduce noise from Figma application logs

## Component Details

### 1. MCP Server Core (`src/server.ts`)

**Responsibility:** MCP protocol implementation and server lifecycle

**Key Functions:**
```typescript
class FigmaConsoleMCPServer {
  // Initialize server and register tools
  async start(): Promise<void>

  // Handle incoming MCP tool calls
  async handleToolCall(name: string, args: any): Promise<any>

  // Graceful shutdown
  async stop(): Promise<void>

  // Health check
  async ping(): Promise<boolean>
}
```

**Dependencies:**
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- Tool modules for each MCP tool
- Configuration manager

**Configuration:**
```typescript
interface ServerConfig {
  // Puppeteer launch options
  browser: {
    headless: boolean;
    args: string[];
    executablePath?: string;
  };

  // Console monitoring options
  console: {
    bufferSize: number; // Max logs to keep in memory
    filterLevels: ('log' | 'info' | 'warn' | 'error' | 'debug')[];
  };

  // Screenshot options
  screenshots: {
    defaultFormat: 'png' | 'jpeg';
    quality: number; // 0-100 for JPEG
    storePath: string;
  };
}
```

### 2. Figma Manager (`src/figma-manager.ts`)

**Responsibility:** Browser automation and Figma-specific logic

**Key Functions:**
```typescript
class FigmaManager {
  private browser: Browser;
  private page: Page;

  // Launch Chrome and navigate to Figma
  async initialize(figmaUrl?: string): Promise<void>

  // Detect if a plugin is currently running
  async isPluginRunning(): Promise<boolean>

  // Get plugin context information
  async getPluginContext(): Promise<PluginContext>

  // Reload the current plugin
  async reloadPlugin(): Promise<void>

  // Navigate to specific Figma file/plugin
  async navigateToFile(fileKey: string): Promise<void>

  // Close browser
  async close(): Promise<void>
}
```

**Plugin Detection Strategy:**
```typescript
// Check for plugin iframe in DOM
await page.evaluate(() => {
  const pluginIframe = document.querySelector('iframe[name="plugin"]');
  return {
    isRunning: !!pluginIframe,
    pluginName: pluginIframe?.getAttribute('data-plugin-name'),
    pluginId: pluginIframe?.getAttribute('data-plugin-id')
  };
});
```

**Error Recovery:**
- Automatic reconnection on browser crash
- Retry navigation with exponential backoff
- Graceful degradation if Figma UI changes

### 3. Console Monitor (`src/console-monitor.ts`)

**Responsibility:** Capture and filter console logs via Chrome DevTools Protocol

**Key Functions:**
```typescript
class ConsoleMonitor {
  private client: CDPClient;
  private logBuffer: CircularBuffer<ConsoleLogEntry>;

  // Connect to Chrome DevTools Protocol
  async connect(page: Page): Promise<void>

  // Start monitoring console events
  async startMonitoring(): Promise<void>

  // Get buffered console logs
  getRecentLogs(count?: number): ConsoleLogEntry[]

  // Clear log buffer
  clearLogs(): void

  // Filter logs by level or source
  filterLogs(filter: LogFilter): ConsoleLogEntry[]

  // Stream logs in real-time
  watchLogs(callback: (log: ConsoleLogEntry) => void): void
}
```

**Console Log Filtering:**
```typescript
// Identify plugin-specific logs by checking stack traces
function isPluginLog(consoleMessage: Protocol.Runtime.ConsoleAPICalledEvent): boolean {
  const stackTrace = consoleMessage.stackTrace;

  // Check if call originated from plugin iframe
  if (stackTrace?.callFrames) {
    return stackTrace.callFrames.some(frame =>
      frame.url.includes('/plugin/') ||
      frame.url.includes('data:text/javascript') // Plugin code
    );
  }

  // Fallback: check execution context
  return consoleMessage.executionContextId !== 1; // Not main frame
}
```

**Intelligent Log Truncation (from AgentDesk):**
```typescript
interface TruncationConfig {
  maxStringLength: number;      // Truncate long strings (default: 500 chars)
  maxArrayLength: number;        // Limit array elements (default: 10)
  maxObjectDepth: number;        // Limit object nesting (default: 3)
  removeDuplicates: boolean;     // Remove duplicate objects (default: true)
}

function truncateLogArgs(args: any[], config: TruncationConfig): any[] {
  return args.map(arg => truncateValue(arg, config, 0));
}

function truncateValue(value: any, config: TruncationConfig, depth: number): any {
  // Truncate strings
  if (typeof value === 'string' && value.length > config.maxStringLength) {
    return value.slice(0, config.maxStringLength) + '... [truncated]';
  }

  // Limit object depth
  if (depth >= config.maxObjectDepth) {
    return '[Object: max depth reached]';
  }

  // Truncate arrays
  if (Array.isArray(value) && value.length > config.maxArrayLength) {
    return [
      ...value.slice(0, config.maxArrayLength),
      `... [${value.length - config.maxArrayLength} more items]`
    ];
  }

  // Recursively truncate objects
  if (typeof value === 'object' && value !== null) {
    const truncated: any = {};
    for (const [key, val] of Object.entries(value)) {
      truncated[key] = truncateValue(val, config, depth + 1);
    }
    return truncated;
  }

  return value;
}
```

**Data Structure:**
```typescript
interface ConsoleLogEntry {
  timestamp: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  args: any[]; // Serialized arguments
  stackTrace?: {
    callFrames: {
      functionName: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    }[];
  };
  source: 'plugin' | 'figma' | 'unknown';
}
```

**Circular Buffer Implementation:**
```typescript
class CircularBuffer<T> {
  private buffer: T[];
  private size: number;
  private index: number = 0;

  constructor(size: number) {
    this.size = size;
    this.buffer = [];
  }

  push(item: T): void {
    if (this.buffer.length < this.size) {
      this.buffer.push(item);
    } else {
      this.buffer[this.index] = item;
      this.index = (this.index + 1) % this.size;
    }
  }

  getAll(): T[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
    this.index = 0;
  }
}
```

### 4. Screenshot Manager (`src/screenshot-manager.ts`)

**Responsibility:** Capture and manage screenshots

**Key Functions:**
```typescript
class ScreenshotManager {
  private storagePath: string;

  // Capture full page screenshot
  async captureFullPage(format?: 'png' | 'jpeg'): Promise<Screenshot>

  // Capture specific element
  async captureElement(selector: string): Promise<Screenshot>

  // Capture plugin UI area
  async capturePluginUI(): Promise<Screenshot>

  // Get screenshot by ID
  async getScreenshot(id: string): Promise<Buffer>

  // Clean up old screenshots
  async cleanup(olderThanMs: number): Promise<void>
}
```

**Screenshot Metadata:**
```typescript
interface Screenshot {
  id: string; // UUID
  timestamp: number;
  path: string; // File path on disk
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  selector?: string; // If element screenshot
  base64?: string; // For MCP transport
  metadata: {
    pluginName?: string;
    pluginId?: string;
    figmaFileKey?: string;
  };
}
```

**Storage Strategy:**
```typescript
// Screenshots stored in temp directory with cleanup
const screenshotPath = path.join(
  os.tmpdir(),
  'figma-console-mcp',
  'screenshots',
  `${Date.now()}-${uuid()}.${format}`
);

// Automatic cleanup of screenshots older than 1 hour
setInterval(() => {
  screenshotManager.cleanup(60 * 60 * 1000);
}, 10 * 60 * 1000); // Every 10 minutes
```

### 5. MCP Tools (`src/tools/`)

Each tool is a separate module implementing the MCP tool interface.

#### Tool: `figma_get_console_logs`

```typescript
export const getConsoleLogsTool = {
  name: 'figma_get_console_logs',
  description: 'Retrieve recent console logs from the Figma plugin',
  inputSchema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description: 'Number of recent logs to retrieve (default: 100)',
        default: 100
      },
      level: {
        type: 'string',
        enum: ['log', 'info', 'warn', 'error', 'debug', 'all'],
        description: 'Filter by log level (default: all)',
        default: 'all'
      },
      since: {
        type: 'number',
        description: 'Only logs after this timestamp (Unix ms)',
        optional: true
      }
    }
  },

  async handler(args: any) {
    const logs = consoleMonitor.getRecentLogs(args.count);

    // Filter by level if specified
    const filtered = args.level !== 'all'
      ? logs.filter(log => log.level === args.level)
      : logs;

    // Filter by timestamp if specified
    const final = args.since
      ? filtered.filter(log => log.timestamp >= args.since)
      : filtered;

    return {
      logs: final,
      totalCount: final.length,
      oldestTimestamp: final[0]?.timestamp,
      newestTimestamp: final[final.length - 1]?.timestamp
    };
  }
};
```

#### Tool: `figma_take_screenshot`

```typescript
export const takeScreenshotTool = {
  name: 'figma_take_screenshot',
  description: 'Capture a screenshot of the Figma plugin UI',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['plugin', 'full-page', 'viewport'],
        description: 'What to screenshot (default: plugin)',
        default: 'plugin'
      },
      format: {
        type: 'string',
        enum: ['png', 'jpeg'],
        description: 'Image format (default: png)',
        default: 'png'
      },
      quality: {
        type: 'number',
        description: 'JPEG quality 0-100 (default: 90)',
        default: 90
      }
    }
  },

  async handler(args: any) {
    let screenshot: Screenshot;

    if (args.target === 'plugin') {
      screenshot = await screenshotManager.capturePluginUI();
    } else if (args.target === 'full-page') {
      screenshot = await screenshotManager.captureFullPage(args.format);
    } else {
      screenshot = await screenshotManager.captureViewport(args.format);
    }

    // Return base64-encoded image for MCP transport
    const imageBuffer = await fs.readFile(screenshot.path);
    screenshot.base64 = imageBuffer.toString('base64');

    return screenshot;
  }
};
```

#### Tool: `figma_watch_console`

```typescript
export const watchConsoleTool = {
  name: 'figma_watch_console',
  description: 'Stream console logs in real-time (returns immediately, logs sent as notifications)',
  inputSchema: {
    type: 'object',
    properties: {
      duration: {
        type: 'number',
        description: 'How long to watch in seconds (default: 30)',
        default: 30
      },
      level: {
        type: 'string',
        enum: ['log', 'info', 'warn', 'error', 'debug', 'all'],
        description: 'Filter by log level (default: all)',
        default: 'all'
      }
    }
  },

  async handler(args: any, sendNotification: (log: any) => void) {
    const startTime = Date.now();
    const endTime = startTime + (args.duration * 1000);

    const unsubscribe = consoleMonitor.watchLogs((log) => {
      // Filter by level
      if (args.level !== 'all' && log.level !== args.level) {
        return;
      }

      // Stop if duration exceeded
      if (Date.now() >= endTime) {
        unsubscribe();
        return;
      }

      // Send log as MCP notification
      sendNotification({
        method: 'notifications/message',
        params: {
          level: log.level,
          message: log.message,
          timestamp: log.timestamp
        }
      });
    });

    // Auto-unsubscribe after duration
    setTimeout(unsubscribe, args.duration * 1000);

    return {
      status: 'watching',
      duration: args.duration,
      endsAt: endTime
    };
  }
};
```

#### Tool: `figma_reload_plugin`

```typescript
export const reloadPluginTool = {
  name: 'figma_reload_plugin',
  description: 'Reload the currently running Figma plugin',
  inputSchema: {
    type: 'object',
    properties: {
      clearConsole: {
        type: 'boolean',
        description: 'Clear console logs before reload (default: true)',
        default: true
      }
    }
  },

  async handler(args: any) {
    if (args.clearConsole) {
      consoleMonitor.clearLogs();
    }

    await figmaManager.reloadPlugin();

    // Wait for plugin to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));

    return {
      status: 'reloaded',
      timestamp: Date.now(),
      pluginContext: await figmaManager.getPluginContext()
    };
  }
};
```

#### Tool: `figma_clear_console`

```typescript
export const clearConsoleTool = {
  name: 'figma_clear_console',
  description: 'Clear the console log buffer',
  inputSchema: {
    type: 'object',
    properties: {}
  },

  async handler() {
    const clearedCount = consoleMonitor.getRecentLogs().length;
    consoleMonitor.clearLogs();

    return {
      status: 'cleared',
      clearedCount,
      timestamp: Date.now()
    };
  }
};
```

## Data Flow

### Console Log Capture Flow

```
1. Plugin executes: console.log('Hello')
   ↓
2. Browser DevTools captures message
   ↓
3. CDP sends Console.messageAdded event
   ↓
4. ConsoleMonitor receives event via WebSocket
   ↓
5. Filter: Is this from plugin context?
   ↓
6. Parse message and stack trace
   ↓
7. Create ConsoleLogEntry object
   ↓
8. Add to circular buffer
   ↓
9. AI calls figma_get_console_logs()
   ↓
10. Return buffered logs via MCP
```

### Screenshot Capture Flow

```
1. AI calls figma_take_screenshot({target: 'plugin'})
   ↓
2. ScreenshotManager identifies plugin iframe
   ↓
3. Puppeteer captures element screenshot
   ↓
4. Save PNG/JPEG to temp directory
   ↓
5. Generate metadata (timestamp, size, etc.)
   ↓
6. Read file and encode as base64
   ↓
7. Return Screenshot object via MCP
   ↓
8. Cleanup old screenshots (background task)
```

## Performance Considerations

### Memory Management

**Console Log Buffer:**
- Circular buffer with configurable size (default: 1000 logs)
- Automatic eviction of oldest logs
- Memory usage: ~1MB per 1000 logs

**Screenshot Storage:**
- Stored on disk, not in memory
- Automatic cleanup of screenshots older than 1 hour
- Disk usage: ~100KB per screenshot (PNG)

### Network Efficiency

**CDP Connection:**
- Single persistent WebSocket connection
- Selective event subscription (only Console domain)
- Binary protocol for efficiency

**MCP Communication:**
- JSON-based request/response
- Base64 encoding for screenshots (necessary for MCP)
- Batch operations where possible

### Latency Optimization

**Console Log Retrieval:**
- Target: < 1 second end-to-end
- In-memory buffer for instant access
- Pre-filtered by plugin context

**Screenshot Capture:**
- Target: < 2 seconds end-to-end
- Puppeteer built-in optimization
- Async I/O for file operations

## Security Considerations

### Browser Automation

**Sandboxing:**
- Puppeteer runs browser with `--no-sandbox` flag (optional)
- Isolated user data directory per session
- No persistent browser state

**Permissions:**
- Read-only access to console logs
- Screenshot capability limited to visible content
- No code injection into Figma or plugins

### Data Privacy

**Console Logs:**
- Stored only in memory (not persisted)
- Automatic eviction after buffer fills
- No external transmission (local MCP only)

**Screenshots:**
- Stored in OS temp directory
- Automatic cleanup after 1 hour
- No cloud upload or external sharing

### MCP Security

**Tool Authorization:**
- All tools are opt-in via MCP client
- AI must explicitly call tools
- No automatic data exfiltration

## Error Handling

### Browser Connection Failures

```typescript
async function connectWithRetry(maxAttempts = 3): Promise<Browser> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await puppeteer.launch(config.browser);
    } catch (error) {
      if (attempt === maxAttempts) throw error;

      const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

### CDP Disconnection

```typescript
client.on('disconnect', async () => {
  console.warn('CDP connection lost, attempting reconnect...');

  try {
    await consoleMonitor.connect(figmaManager.page);
    console.info('CDP reconnected successfully');
  } catch (error) {
    console.error('CDP reconnection failed:', error);
    // Notify AI via MCP error response
  }
});
```

### Plugin Not Found

```typescript
async function ensurePluginRunning(): Promise<void> {
  const isRunning = await figmaManager.isPluginRunning();

  if (!isRunning) {
    throw new Error(
      'No Figma plugin is currently running. ' +
      'Please start your plugin in Figma first.'
    );
  }
}
```

## Testing Strategy

### Unit Tests

- Tool input validation
- Console log filtering logic
- Circular buffer implementation
- Screenshot metadata generation

### Integration Tests

- Full MCP server lifecycle
- Puppeteer browser automation
- CDP connection and events
- Tool execution end-to-end

### E2E Tests

- Launch real browser + Figma
- Run sample plugin
- Verify console log capture
- Verify screenshot accuracy

**Test Framework:** Jest with Puppeteer helpers

```typescript
describe('Console Monitor', () => {
  let browser: Browser;
  let page: Page;
  let monitor: ConsoleMonitor;

  beforeEach(async () => {
    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    monitor = new ConsoleMonitor();
    await monitor.connect(page);
  });

  afterEach(async () => {
    await browser.close();
  });

  test('captures console.log messages', async () => {
    await page.evaluate(() => console.log('Test message'));

    await new Promise(resolve => setTimeout(resolve, 100));

    const logs = monitor.getRecentLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Test message');
    expect(logs[0].level).toBe('log');
  });
});
```

## Deployment Architecture

### Local Deployment (Typical)

```
User's Machine
├── Claude Code / Cursor (MCP Client)
├── Figma Console MCP Server (Node.js process)
└── Chrome Browser (Puppeteer-controlled)
    └── Figma Web App
        └── User's Plugin
```

### Configuration File

**`~/.config/figma-console-mcp/config.json`:**
```json
{
  "browser": {
    "headless": false,
    "args": ["--disable-blink-features=AutomationControlled"],
    "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  },
  "console": {
    "bufferSize": 1000,
    "filterLevels": ["log", "info", "warn", "error"]
  },
  "screenshots": {
    "defaultFormat": "png",
    "quality": 90,
    "storePath": "/tmp/figma-console-mcp/screenshots"
  }
}
```

### MCP Client Configuration

**Claude Code (`~/.config/claude-code/mcp-servers.json`):**
```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["figma-console-mcp"],
      "env": {
        "FIGMA_CONSOLE_CONFIG": "~/.config/figma-console-mcp/config.json"
      }
    }
  }
}
```

## Monitoring & Observability

### Logging

**Log Levels:**
- `DEBUG`: Detailed CDP events, buffer operations
- `INFO`: Server lifecycle, tool calls, plugin detection
- `WARN`: Reconnection attempts, missing plugins
- `ERROR`: Fatal errors, crashes

**Log Output:**
```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
});

// Usage
logger.info({ toolName: 'figma_get_console_logs', count: 50 }, 'Tool called');
logger.error({ error: err.message, stack: err.stack }, 'Browser connection failed');
```

### Metrics

**Key Metrics to Track:**
- Tool call latency (p50, p95, p99)
- Console log capture rate (logs/second)
- Screenshot capture success rate
- Browser connection uptime
- Memory usage (buffer size, heap)

### Health Checks

```typescript
export async function healthCheck(): Promise<HealthStatus> {
  return {
    status: 'healthy',
    timestamp: Date.now(),
    components: {
      browser: await figmaManager.ping(),
      cdp: consoleMonitor.isConnected(),
      mcp: server.isRunning()
    },
    metrics: {
      logBufferSize: consoleMonitor.getRecentLogs().length,
      screenshotCount: await screenshotManager.count(),
      uptime: process.uptime()
    }
  };
}
```

---

**Document Version:** 1.0
**Last Updated:** 2025-10-05
**Status:** Implementation Ready
