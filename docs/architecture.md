---
title: "Technical Architecture"
description: "Deep dive into Figma Console MCP's architecture, deployment modes, component details, and data flows."
---

# Figma Console MCP - Technical Architecture

## Overview

Figma Console MCP provides AI assistants with real-time access to Figma for debugging, design system extraction, and design creation. The server supports two deployment modes with different capabilities.

## Deployment Modes

### Remote Mode (SSE/OAuth)

**Best for:** Design system extraction, API-based operations, zero-setup experience

```mermaid
flowchart TB
    AI[AI Assistant]
    AI -->|SSE| WORKER
    WORKER[Cloudflare Worker]
    WORKER --> MCP[MCP Protocol]
    MCP --> CLIENT[REST Client]
    CLIENT -->|HTTPS| API[Figma API]
```

**Capabilities:**
- Design system extraction (variables, styles, components)
- File structure queries
- Component images
- Console log capture (requires local)
- Design creation (requires Desktop Bridge)
- Variable management (requires Desktop Bridge)

---

### Local Mode (Desktop Bridge)

**Best for:** Plugin debugging, design creation, variable management, full capabilities

```mermaid
flowchart TB
    AI[AI Assistant]
    AI -->|stdio| SERVER[Local MCP Server]

    SERVER --> REST[REST Client]
    SERVER --> WS[WebSocket Client]
    SERVER --> CDP[CDP Client]

    REST -->|HTTPS| API[Figma API]
    WS -->|"WebSocket :9223<br/>(preferred)"| PLUGIN[Desktop Bridge Plugin]
    CDP -->|"CDP :9222<br/>(fallback)"| FIGMA[Figma Desktop]

    PLUGIN --> FILE[Design File]
    FIGMA --> PLUGIN
    FIGMA --> FILE
```

**Transport Priority:**
1. **WebSocket (preferred)** — via Desktop Bridge Plugin on port 9223. Instant availability check, no debug flags needed. Supports real-time selection tracking, document change monitoring, and console capture.
2. **CDP (fallback)** — via Chrome DevTools Protocol on port 9222. Requires launching Figma with `--remote-debugging-port=9222`. Provides full-page console monitoring and browser-level navigation.

The MCP server checks WebSocket first (instant). If no plugin client is connected, it falls back to CDP. Both transports can be active simultaneously — all 56+ tools work identically through either.

**Capabilities:**
- Everything in Remote Mode, plus:
- Console log capture (real-time)
- Design creation via Plugin API
- Variable CRUD operations
- Component arrangement and organization
- Real-time selection and document change tracking (WebSocket)
- Zero-latency local execution

---

## Component Details

### MCP Server Core (`src/local.ts`)

The main server implements the Model Context Protocol with stdio transport for local mode.

**Key Responsibilities:**
- Tool registration (56+ tools in Local Mode, 18 in Remote Mode)
- Request routing and validation
- Figma API client management
- Desktop Bridge communication
- Chrome DevTools Protocol connection

**Tool Categories:**

| Category | Tools | Transport |
|----------|-------|-----------|
| Navigation | `figma_navigate`, `figma_get_status` | WebSocket / CDP |
| Console | `figma_get_console_logs`, `figma_watch_console`, `figma_clear_console` | WebSocket / CDP |
| Screenshots | `figma_take_screenshot`, `figma_capture_screenshot` | WebSocket / CDP |
| Design System | `figma_get_variables`, `figma_get_styles`, `figma_get_component` | REST API |
| Design Creation | `figma_execute`, `figma_arrange_component_set` | WebSocket / CDP (Plugin) |
| Variables | `figma_create_variable`, `figma_update_variable`, etc. | WebSocket / CDP (Plugin) |
| Real-Time | `figma_get_selection`, `figma_get_design_changes` | WebSocket only |

---

### Desktop Bridge Plugin

The Desktop Bridge is a Figma plugin that runs inside Figma Desktop and provides access to the full Figma Plugin API.

**Architecture:**

```mermaid
flowchart TB
    MSG[Message Handler]
    MSG --> EXEC[Execute]
    MSG --> VARS[Variables]
    MSG --> COMP[Components]
    EXEC --> API[Figma Plugin API]
    VARS --> API
    COMP --> API
```

**Communication Protocol:**

The MCP server communicates with the Desktop Bridge via either transport:

**Via WebSocket (preferred):**
1. **MCP Server** sends JSON command via WebSocket (port 9223)
2. **Plugin UI** receives and forwards via `postMessage` to plugin code
3. **Plugin Code** executes Figma Plugin API calls
4. **Plugin Code** returns result via `figma.ui.postMessage`
5. **Plugin UI** sends response back via WebSocket
6. **MCP Server** receives correlated response

**Via CDP (fallback):**
1. **MCP Server** sends command via CDP `Runtime.evaluate`
2. **Bridge Plugin** receives via `figma.ui.onmessage`
3. **Bridge Plugin** executes Figma Plugin API calls
4. **Bridge Plugin** returns result via `figma.ui.postMessage`
5. **MCP Server** receives response via CDP

---

### Transport Layer

The MCP server uses a transport abstraction (`IFigmaConnector` interface) that supports two backends:

#### WebSocket Transport (Preferred)

The Desktop Bridge Plugin connects via WebSocket on port 9223. This is the recommended transport — it requires no special Figma launch flags and provides additional real-time capabilities.

**Features unique to WebSocket:**
- Real-time selection tracking (`figma_get_selection`)
- Document change monitoring (`figma_get_design_changes`)
- File identity tracking (file key, name, current page)
- Plugin-context console capture
- Instant availability check (no network timeout)

**Communication flow:**
```
MCP Server ←WebSocket (port 9223)→ Plugin UI (ui.html) ←postMessage→ Plugin Code (code.js) ←figma.*→ Figma
```

#### CDP Transport (Fallback)

Chrome DevTools Protocol connects on port 9222 when Figma is launched with `--remote-debugging-port=9222`.

**Features unique to CDP:**
- Full-page console monitoring (captures all page-level logs, not just plugin context)
- Browser-level navigation (`figma_navigate` to different files)
- Viewport screenshot capture

**Console Monitoring via CDP:**

```typescript
// Connect to Figma Desktop's DevTools port
const client = await CDP({ port: 9222 });

// Enable console domain
await client.Console.enable();
await client.Runtime.enable();

// Listen for console messages
client.Runtime.on('consoleAPICalled', (params) => {
  const entry = {
    timestamp: Date.now(),
    level: params.type,
    message: formatMessage(params.args),
    stackTrace: params.stackTrace
  };
  logBuffer.push(entry);
});
```

#### Transport Auto-Detection

The MCP server selects the best transport automatically per-command:

1. Check if a WebSocket client is connected (instant, under 1ms)
2. If yes, route through WebSocket
3. If no, attempt CDP connection (has network timeout)
4. If neither is available, return setup instructions

Both transports can be active simultaneously. All 56+ tools work through either transport.

---

### Figma REST API Client

Used for design system extraction and file queries.

**Endpoints Used:**

| Endpoint | Purpose |
|----------|---------|
| `GET /v1/files/:key` | File structure and metadata |
| `GET /v1/files/:key/nodes` | Specific node data |
| `GET /v1/files/:key/styles` | Style definitions |
| `GET /v1/files/:key/variables/local` | Variable collections (Enterprise) |
| `GET /v1/images/:key` | Rendered images |

**Authentication:**
- **Remote Mode:** OAuth 2.0 with automatic token refresh
- **Local Mode:** Personal Access Token via environment variable

---

## Data Flow Examples

### Design Creation Flow

```mermaid
sequenceDiagram
    participant U as User
    participant A as AI
    participant M as MCP
    participant B as Bridge
    participant F as Figma

    U->>A: Create button
    A->>M: figma_execute()
    M->>B: Send code
    B->>F: createComponent()
    F-->>B: Node created
    B-->>M: {nodeId}
    A->>M: capture_screenshot()
    M-->>A: Image
    A-->>U: Done
```

### Variable Management Flow

```mermaid
sequenceDiagram
    participant U as User
    participant A as AI
    participant M as MCP
    participant B as Bridge
    participant F as Figma

    U->>A: Create variable
    A->>M: create_variable()
    M->>B: Send command
    B->>F: createVariable()
    F-->>B: Created
    B-->>M: Variable ID
    M-->>A: Success
    A-->>U: Done
```

### Console Debugging Flow

```mermaid
sequenceDiagram
    participant U as User
    participant P as Plugin
    participant C as CDP
    participant M as MCP
    participant A as AI

    U->>P: Run plugin
    P->>C: console.log()
    C->>M: Log event
    M->>M: Buffer entry
    U->>A: Show logs
    A->>M: get_console_logs()
    M-->>A: Logs
    A-->>U: Display
```

---

## Security Considerations

### Authentication

- **Personal Access Tokens:** Stored in environment variables, never logged
- **OAuth Tokens:** Encrypted at rest, automatic refresh
- **No credential storage:** Tokens passed per-request

### Sandboxing

- **Plugin Execution:** Runs in Figma's sandboxed plugin environment
- **Code Validation:** Basic validation before execution
- **No filesystem access:** Plugin code cannot access local files

### Data Privacy

- **Console Logs:** Stored in memory only, cleared on restart
- **Screenshots:** Temporary files with automatic cleanup
- **No telemetry:** No data sent to external services

---

## Performance Considerations

### Latency Targets

| Operation | Target | Actual |
|-----------|--------|--------|
| Console log retrieval | under 100ms | ~50ms |
| Screenshot capture | under 2s | ~1s |
| Design creation | under 5s | 1-3s |
| Variable operations | under 500ms | ~200ms |

### Memory Management

- **Log Buffer:** Circular buffer, configurable size (default: 1000 entries)
- **Screenshots:** Disk-based with 1-hour TTL cleanup
- **Connection Pooling:** Single CDP connection reused

### Optimization Strategies

- Batch operations where possible
- Lazy loading of component data
- Efficient JSON serialization
- Connection keepalive for CDP

---

## Development

### Local Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev:local

# Build for production
npm run build:local
```

### Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage
```

### Project Structure

```
figma-console-mcp/
├── src/
│   ├── local.ts          # Main MCP server (local mode)
│   ├── index.ts          # Cloudflare Workers entry (remote mode)
│   └── types/            # TypeScript definitions
├── figma-desktop-bridge/
│   ├── code.ts           # Plugin main code
│   ├── ui.html           # Plugin UI
│   └── manifest.json     # Plugin manifest
├── docs/                 # Documentation
└── tests/                # Test suites
```
