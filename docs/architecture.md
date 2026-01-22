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
    subgraph AI["AI Coding Assistant"]
        direction TB
        A1["Claude Desktop, Cursor, etc."]
    end

    subgraph CF["Cloudflare Workers (Remote Server)"]
        direction TB
        subgraph MCP["MCP Protocol Layer (SSE Transport)"]
            M1["OAuth token management"]
            M2["Request routing"]
        end
        subgraph REST["Figma REST API Client"]
            R1["Design system extraction"]
            R2["Component/style retrieval"]
            R3["File structure queries"]
        end
        MCP --> REST
    end

    subgraph FIG["Figma REST API"]
        F1["api.figma.com"]
    end

    AI -->|"SSE Connection"| CF
    CF -->|"HTTPS"| FIG
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
    subgraph AI["AI Coding Assistant"]
        A1["Claude Desktop, Cursor, etc."]
    end

    subgraph LOCAL["Local MCP Server (Node.js)"]
        subgraph MCPL["MCP Protocol Layer (stdio)"]
            ML1["Tool registration & dispatch"]
            ML2["Request/response handling"]
        end
        subgraph CLIENTS["Client Modules"]
            subgraph RESTC["Figma REST API"]
                RC1["File queries"]
                RC2["Component data"]
                RC3["Style extraction"]
            end
            subgraph BRIDGE["Desktop Bridge Client"]
                BC1["Plugin API execution"]
                BC2["Variable management"]
                BC3["Design creation"]
            end
        end
        subgraph PROTO["Protocol Clients"]
            subgraph CDP["Chrome DevTools Protocol"]
                CD1["Console capture"]
                CD2["Screenshot"]
            end
            subgraph WS["WebSocket Connection"]
                WS1["localhost:9222"]
            end
        end
        MCPL --> CLIENTS
        CLIENTS --> PROTO
    end

    subgraph FIGMA["Figma Desktop Application"]
        direction TB
        FD1["--remote-debugging-port=9222"]
        subgraph PLUGIN["Desktop Bridge Plugin"]
            subgraph RUNTIME["Plugin Runtime (Figma Plugin API)"]
                PR1["figma.createFrame()"]
                PR2["figma.variables.*"]
                PR3["Full Plugin API access"]
            end
        end
        subgraph FILE["User's Design File"]
            UF1["Components, frames, styles"]
            UF2["Variables and collections"]
        end
    end

    AI -->|"MCP Protocol (stdio)"| LOCAL
    CDP -->|"CDP WebSocket"| FIGMA
    WS -->|"Plugin Message"| FIGMA
```

**Capabilities:**
- Everything in Remote Mode, plus:
- Console log capture (real-time)
- Design creation via Plugin API
- Variable CRUD operations
- Component arrangement and organization
- Zero-latency local execution

---

## Component Details

### MCP Server Core (`src/local.ts`)

The main server implements the Model Context Protocol with stdio transport for local mode.

**Key Responsibilities:**
- Tool registration (40+ tools)
- Request routing and validation
- Figma API client management
- Desktop Bridge communication
- Chrome DevTools Protocol connection

**Tool Categories:**

| Category | Tools | Transport |
|----------|-------|-----------|
| Navigation | `figma_navigate`, `figma_get_status` | CDP |
| Console | `figma_get_console_logs`, `figma_watch_console`, `figma_clear_console` | CDP |
| Screenshots | `figma_take_screenshot`, `figma_capture_screenshot` | CDP / Plugin |
| Design System | `figma_get_variables`, `figma_get_styles`, `figma_get_component` | REST API |
| Design Creation | `figma_execute`, `figma_arrange_component_set` | Plugin |
| Variables | `figma_create_variable`, `figma_update_variable`, etc. | Plugin |

---

### Desktop Bridge Plugin

The Desktop Bridge is a Figma plugin that runs inside Figma Desktop and provides access to the full Figma Plugin API.

**Architecture:**

```mermaid
flowchart TB
    subgraph BRIDGE["Desktop Bridge Plugin"]
        subgraph HANDLER["Message Handler"]
            H1["Receives commands from MCP server"]
            H2["Routes to appropriate handler"]
            H3["Returns results via postMessage"]
        end

        subgraph COMMANDS["Command Handlers"]
            subgraph EXEC["Execute"]
                E1["Run code"]
                E2["Return results"]
            end
            subgraph VARS["Variables"]
                V1["CRUD ops"]
                V2["Modes"]
                V3["Bindings"]
            end
            subgraph COMP["Components"]
                C1["Search"]
                C2["Instantiate"]
                C3["Arrange"]
            end
        end

        subgraph API["Figma Plugin API Access"]
            A1["figma.currentPage"]
            A2["figma.variables.*"]
            A3["figma.createFrame(), figma.createComponent()"]
            A4["Full async API support"]
        end

        HANDLER --> COMMANDS
        COMMANDS --> API
    end
```

**Communication Protocol:**

The MCP server communicates with the Desktop Bridge via Chrome DevTools Protocol:

1. **MCP Server** sends command via CDP `Runtime.evaluate`
2. **Bridge Plugin** receives via `figma.ui.onmessage`
3. **Bridge Plugin** executes Figma Plugin API calls
4. **Bridge Plugin** returns result via `figma.ui.postMessage`
5. **MCP Server** receives response via CDP

---

### Chrome DevTools Protocol Integration

Used for console log capture and screenshot functionality.

**Console Monitoring:**

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

**Screenshot Capture:**

```typescript
// Via CDP (viewport screenshot)
const { data } = await client.Page.captureScreenshot({
  format: 'png',
  quality: 100
});

// Via Plugin (node-specific screenshot)
const result = await executeInPlugin(`
  const node = figma.currentPage.selection[0];
  const bytes = await node.exportAsync({ format: 'PNG', scale: 2 });
  return Array.from(bytes);
`);
```

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
    participant User
    participant AI as AI Assistant
    participant MCP as MCP Server
    participant Bridge as Desktop Bridge
    participant Figma as Figma Plugin API

    User->>AI: "Create a button component"
    AI->>MCP: figma_execute({ code: "..." })
    MCP->>Bridge: Send code via CDP
    Bridge->>Figma: figma.createComponent()
    Bridge->>Figma: figma.createText()
    Bridge->>Figma: Set properties, styles, auto-layout
    Figma-->>Bridge: Node created
    Bridge-->>MCP: { nodeId, name }
    AI->>MCP: figma_capture_screenshot({ nodeId })
    MCP-->>AI: Screenshot image
    AI->>AI: Validate result, iterate if needed
    AI-->>User: "Button created successfully"
```

### Variable Management Flow

```mermaid
sequenceDiagram
    participant User
    participant AI as AI Assistant
    participant MCP as MCP Server
    participant Bridge as Desktop Bridge
    participant Figma as Figma Variables API

    User->>AI: "Create a color variable for primary brand"
    AI->>MCP: figma_create_variable({<br/>name: "colors/primary",<br/>collectionId: "...",<br/>resolvedType: "COLOR",<br/>valuesByMode: { "1:0": "#3B82F6" }})
    MCP->>Bridge: Send command
    Bridge->>Figma: figma.variables.createVariable(...)
    Bridge->>Figma: variable.setValueForMode(...)
    Figma-->>Bridge: Variable created
    Bridge-->>MCP: Variable with ID
    MCP-->>AI: Success response
    AI-->>User: "Created colors/primary variable"
```

### Console Debugging Flow

```mermaid
sequenceDiagram
    participant User
    participant Plugin as User's Figma Plugin
    participant CDP as Chrome DevTools Protocol
    participant MCP as MCP Server
    participant AI as AI Assistant

    User->>Plugin: Run plugin
    Plugin->>CDP: console.log("[Main] Starting...")
    CDP->>MCP: Runtime.consoleAPICalled event
    MCP->>MCP: Buffer log entry
    User->>AI: "Show me console logs"
    AI->>MCP: figma_get_console_logs()
    MCP-->>AI: Timestamped, filtered logs
    AI-->>User: Display formatted logs
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
