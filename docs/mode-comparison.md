---
title: "Mode Comparison"
description: "Understand the differences between Remote, Cloud Mode, Local, and NPX installation methods and when to use each."
---

# Installation Methods & Execution Modes - Complete Comparison

This document clarifies the differences between installation methods and execution modes to help you choose the right setup.

## Understanding the Architecture

The MCP server has **three execution modes** and **four setup methods**:

### Execution Modes (Where Code Runs)
1. **Remote Mode** - Runs in Cloudflare Workers (cloud, read-only)
2. **Cloud Mode** - Runs in Cloudflare Workers + Cloud Write Relay (cloud, read/write)
3. **Local Mode** - Runs on your machine (Node.js, full capabilities)

### Setup Methods (How You Connect)
1. **Remote SSE/HTTP** - URL-based connection (uses Remote Mode, read-only)
2. **Cloud Mode** - Remote endpoint + Cloud Write Relay via Desktop Bridge plugin (uses Cloud Mode)
3. **NPX** - npm package distribution (uses Local Mode)
4. **Local Git** - Source code clone (uses Local Mode)

### Authentication Methods (How You Authenticate)
1. **OAuth** - Automatic browser-based auth (Remote SSE only)
2. **Personal Access Token (PAT)** - Bearer token (Remote `/mcp` endpoint, Cloud Mode)
3. **Personal Access Token (PAT)** - Environment variable (NPX + Local Git)
4. **Pairing Code** - 6-character code to connect Desktop Bridge plugin to cloud relay (Cloud Mode only)

**Key Insight:** Your choice of mode determines both capability level and setup complexity.

## 🎯 Quick Decision Guide

### ⚠️ Critical: Tool Count Differences

| Mode | Tools Available | Write Access | Needs Node.js | Real-time |
|------|-----------------|--------------|---------------|-----------|
| **Local Mode** (NPX or Git) | **87+** | Yes | Yes | Yes |
| **Cloud Mode** (Remote + Relay) | **43** | Yes | No | No |
| **Remote Mode** (read-only) | **22** | No | No | No |

> **Bottom line:** Remote mode is read-only (76 tools). Cloud Mode adds write access ((76 tools)) without Node.js. Local has everything (87+ tools) including real-time monitoring.

### Use NPX Setup (Recommended for Most Users)
- ✅ **All 87+ tools** including design creation and real-time monitoring
- ✅ Automatic updates with `@latest`
- ✅ Desktop Bridge Plugin support (recommended connection — no debug flags needed)
- ✅ Variables without Enterprise plan
- ⚠️ Requires Node.js 18+ and `FIGMA_ACCESS_TOKEN` (manual, one-time)

### Use Cloud Mode (Web AI Clients)
- ✅ **(76 tools)** — full write access (create, edit, delete) plus REST API reads
- ✅ No Node.js required — only Figma Desktop with the Desktop Bridge plugin
- ✅ Works with Claude.ai, v0, Replit, Lovable, any MCP-capable web platform
- ✅ Variables without Enterprise plan (via Plugin API)
- ⚠️ Requires pairing the Desktop Bridge plugin via a 6-character code
- ❌ No real-time selection tracking, document changes, or console streaming

### Use Local Git (For Contributors)
- ✅ **All 87+ tools** including design creation
- ✅ Full source code access
- ✅ Modify and test changes
- ⚠️ Requires `FIGMA_ACCESS_TOKEN` (manual)
- ⚠️ Manual updates via `git pull && npm run build`

### Use Remote Mode (Read-Only Exploration)
- ✅ **TRUE zero-setup** - Just paste a URL
- ✅ **OAuth authentication** - No manual tokens
- ✅ Works without Figma Desktop restart
- ❌ **Only 9 tools** — cannot create or modify designs
- ❌ Cannot use Desktop Bridge plugin
- ❌ Variables require Enterprise plan

---

## Setup Methods Comparison

| Aspect | Remote (read-only) | Cloud Mode | NPX | Local Git |
|--------|-------------------|------------|-----|-----------|
| **Execution** | Cloudflare Workers | Cloudflare Workers + Relay | Local Node.js | Local Node.js |
| **Code** | `src/index.ts` | `src/index.ts` + relay | `dist/local.js` (npm) | `dist/local.js` (source) |
| **Authentication** | OAuth (automatic) | PAT + pairing code | PAT (manual) | PAT (manual) |
| **Setup Complexity** | ⭐ Zero-setup | Moderate (plugin + pairing) | Manual token + plugin install | Manual token + plugin install |
| **Distribution** | URL only | URL + plugin | npm package | git clone |
| **Updates** | Automatic (server-side) | Automatic (server-side) | `@latest` auto-updates | Manual `git pull + build` |
| **Figma Desktop** | Not required | Required (Desktop Bridge) | Required (Desktop Bridge) | Required (Desktop Bridge) |
| **Desktop Bridge** | ❌ Not available | ✅ Required for relay | ✅ Available | ✅ Available |
| **Node.js Required** | No | No | Yes | Yes |
| **Source Access** | No | No | No | Yes |
| **Tools** | 22 (read-only) | 43 (read/write) | 57+ (full) | 57+ (full) |
| **Use Case** | Quick evaluation | Web AI clients | Most users | Developers |

---

## Feature Availability Matrix

| Feature | Remote (read-only) | Cloud Mode | Local Mode | Notes |
|---------|-------------------|------------|------------|-------|
| **Read Design Data** | ✅ | ✅ | ✅ | All modes use Figma REST API |
| **Design Creation (write)** | ❌ | ✅ | ✅ | Cloud via relay, Local via WebSocket |
| **Variable Management** | ⚠️ | ✅ | ✅ | Remote requires Enterprise. Cloud/Local use Plugin API (any plan) |
| **Screenshots** | ✅ | ✅ | ✅ | All use Figma REST API |
| **Design System Extraction** | ✅ | ✅ | ✅ | Variables, components, styles via Figma API |
| **Desktop Bridge Plugin** | ❌ | ✅ (required) | ✅ | Plugin required for Cloud relay and Local write access |
| **Real-time Selection Tracking** | ❌ | ❌ | ✅ | Local-only — requires persistent WebSocket |
| **Document Change Monitoring** | ❌ | ❌ | ✅ | Local-only — requires persistent WebSocket |
| **Console Log Streaming** | ❌ | ❌ | ✅ | Local-only — zero-latency via WebSocket |
| **Console Logs (on-demand)** | ✅ | ✅ | ✅ | Remote uses Browser Rendering API |
| **OAuth Authentication** | ✅ | ❌ | ❌ | Remote SSE only |
| **Zero Setup** | ✅ | ❌ | ❌ | Remote: just paste URL |
| **No Node.js Required** | ✅ | ✅ | ❌ | Cloud Mode only needs Figma Desktop + plugin |
| **Reliable Component Descriptions** | ⚠️ | ✅ | ✅ | API has bugs; plugin method is reliable |
| **Works Behind Corporate Firewall** | ⚠️ | ⚠️ | ✅ | Remote/Cloud require internet, Local works offline |
| **Multi-User Shared Token** | ✅ | ❌ | ❌ | Remote uses per-user OAuth |

### Legend
- ✅ Available
- ❌ Not Available
- ⚠️ Limited/Conditional

---

## Architecture Comparison

### Remote Mode Architecture (Read-Only)
```
Claude Desktop/Code
    ↓ (SSE over HTTPS)
Cloudflare Workers MCP Server
    ↓ (Browser Rendering API)
Puppeteer Browser (in CF Workers)
    ↓ (HTTP)
Figma Web App
    ↓ (REST API)
Figma Files & Design Data
```

**Key Points:**
- Browser runs in Cloudflare's infrastructure
- Cannot access `localhost` on your machine
- OAuth tokens stored in Cloudflare KV
- ~10-30s cold start for first request
- 9 read-only tools

### Cloud Mode Architecture (Read/Write via Relay)
```
Claude.ai / v0 / Replit / Lovable
    ↓ (Streamable HTTP)
Cloudflare Workers MCP Server (/mcp)
    ↓ (fetch RPC)
Plugin Relay Durable Object
    ↓ (WebSocket)
Desktop Bridge Plugin (ui.html)
    ↓ (postMessage)
Plugin Worker (code.js)
    ↓ (Plugin API)
Figma Design Data
```

**Key Points:**
- No Node.js required — relay runs entirely in Cloudflare Workers
- Desktop Bridge plugin connects to the cloud relay via WebSocket
- Pairing flow: AI generates 6-character code → user enters in plugin → connected
- (76 tools): 1 pairing + 27 write tools + 15 REST API reads
- Variables work on any Figma plan (uses Plugin API, not Enterprise REST API)
- Pairing code expires after 5 minutes

### Local Mode Architecture (Full Capabilities)
```
Claude Desktop/Code/Cursor/Windsurf
    ↓ (stdio transport)
Local MCP Server (Node.js)
    ↓ (WebSocket, ports 9223–9232)
Figma Desktop Bridge Plugin
    ↓ (Plugin API)
Variables & Components Data
```

**Key Points:**
- Install the Desktop Bridge Plugin once — no debug flags needed
- Server automatically selects an available port (9223–9232) for multi-instance support
- All 87+ tools work through WebSocket
- Plugin can access local variables (no Enterprise API needed)
- Instant console log capture via WebSocket
- Real-time selection tracking and document change monitoring

---

## Tool Availability by Mode

### Core Tools Available in Both Modes

| Tool | Remote | Local | Notes |
|------|--------|-------|-------|
| `figma_navigate` | ✅ | ✅ | Remote navigates cloud browser, Local navigates Figma Desktop |
| `figma_get_console_logs` | ✅ | ✅ | Both capture logs, Local has lower latency |
| `figma_watch_console` | ✅ | ✅ | Real-time log streaming |
| `figma_take_screenshot` | ✅ | ✅ | Both use Figma REST API |
| `figma_reload_plugin` | ✅ | ✅ | Reloads current page |
| `figma_clear_console` | ✅ | ✅ | Clears log buffer |
| `figma_get_status` | ✅ | ✅ | Check connection status |
| `figma_get_design_system_kit` | ✅ | ✅ | Full design system in one call — tokens, components, styles, visual specs |
| `figma_get_variables` | ✅* | ✅** | *Enterprise API required. **Can use Desktop Bridge plugin |
| `figma_get_component` | ✅* | ✅** | *Descriptions may be missing. **Reliable via plugin |
| `figma_get_styles` | ✅ | ✅ | Both use Figma REST API |
| `figma_get_file_data` | ✅ | ✅ | Both use Figma REST API |
| `figma_get_component_image` | ✅ | ✅ | Both use Figma REST API |
| `figma_get_component_for_development` | ✅ | ✅ | Both use Figma REST API |
| `figma_get_file_for_plugin` | ✅ | ✅ | Both use Figma REST API |

### Key Differences

**Variables API:**
- **Remote Mode:** Requires Figma Enterprise plan for Variables API
- **Local Mode:** Can bypass Enterprise requirement using Desktop Bridge plugin

**Component Descriptions:**
- **Remote Mode:** Figma REST API has known bugs (descriptions often missing)
- **Local Mode:** Desktop Bridge plugin uses `figma.getNodeByIdAsync()` (reliable)

---

## Prerequisites & Setup Time

### Remote (Read-Only)
**Prerequisites:** None

**Setup Time:** 2 minutes

**Steps:**
1. Open Claude Desktop → Settings → Connectors
2. Click "Add Custom Connector"
3. Paste URL: `https://figma-console-mcp.southleft.com/sse`
4. Done ✅ (OAuth happens automatically on first API use)

### Cloud Mode
**Prerequisites:**
- Figma Desktop installed
- Desktop Bridge plugin imported and running in your file
- A web AI client connected to `https://figma-console-mcp.southleft.com/mcp` (with Figma PAT as Bearer token)

**Setup Time:** 5 minutes

**Steps:**
1. Connect your web AI client to the `/mcp` endpoint with your Figma PAT
2. Tell your AI to connect to your Figma plugin (natural language)
3. AI generates a 6-character pairing code
4. In the Desktop Bridge plugin, toggle "Cloud Mode" and enter the code
5. Done ✅ — 76 tools with full write access

### NPX
**Prerequisites:**
- Node.js 18+
- Figma Desktop installed
- Figma Personal Access Token ([get one](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens))

**Setup Time:** 10 minutes

**Steps:**
1. Get Figma Personal Access Token
2. Add to MCP config with `FIGMA_ACCESS_TOKEN` env var
3. Install the Desktop Bridge Plugin (one-time — Plugins → Development → Import from manifest)
4. Restart your MCP client

### Local Git
**Prerequisites:**
- Node.js 18+
- Git
- Figma Desktop installed
- Figma Personal Access Token ([get one](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens))

**Setup Time:** 15 minutes

**Steps:**
1. Clone repository: `git clone https://github.com/southleft/figma-console-mcp.git`
2. Run `npm install && npm run build:local`
3. Get Figma Personal Access Token
4. Configure MCP client JSON config with path to `dist/local.js`
5. Set `FIGMA_ACCESS_TOKEN` environment variable
6. Install the Desktop Bridge Plugin (one-time — Plugins → Development → Import from manifest)
7. Restart your MCP client

---

## Authentication Comparison

### Remote SSE - OAuth (Automatic) ⭐ Simplest

**Method:** Remote read-only mode (SSE endpoint)

**How it works:**
1. First design system tool call triggers OAuth
2. Browser opens automatically to Figma authorization page
3. User authorizes app (one-time)
4. Token stored in Cloudflare KV (persistent across sessions)
5. Automatic token refresh when expired

**Benefits:**
- ✅ **TRUE zero-setup** - No manual token creation
- ✅ Per-user authentication
- ✅ Automatic token refresh
- ✅ Works with Free, Pro, and Enterprise Figma plans

**Limitations:**
- ⚠️ Requires internet connection
- ⚠️ Initial authorization flow required (one-time)
- ❌ Read-only — no write access

### Cloud Mode - PAT + Pairing Code

**Method:** Cloud Mode with write relay

**How it works:**
1. User creates PAT and provides it as Bearer token when connecting to `/mcp` endpoint
2. AI generates a 6-character pairing code (valid for 5 minutes)
3. User enters code in Desktop Bridge plugin (Cloud Mode toggle)
4. Relay authenticates the plugin-to-cloud connection
5. All write operations flow through the authenticated relay

**Benefits:**
- ✅ Write access without Node.js
- ✅ Pairing code adds a second factor of trust (plugin must be in the right file)
- ✅ Variables on any Figma plan via Plugin API

**Limitations:**
- ❌ Manual PAT creation required
- ❌ Pairing code expires after 5 minutes
- ⚠️ Must re-pair if connection drops

### NPX + Local Git - Personal Access Token (Manual)

**Method:** Both NPX and Local Git modes

**How it works:**
1. User creates PAT at https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens
2. Set as `FIGMA_ACCESS_TOKEN` environment variable in MCP config
3. MCP server uses PAT for all API calls
4. No automatic refresh (token valid for 90 days)

**Benefits:**
- ✅ Works offline (for console debugging)
- ✅ No browser-based OAuth flow
- ✅ Simpler for single-user setups
- ✅ Full 87+ tools including real-time monitoring

**Limitations:**
- ❌ **Manual token creation required**
- ❌ Must manually refresh every 90 days
- ❌ Single shared token (no per-user auth)
- ❌ **Requires Desktop Bridge Plugin** (one-time import)

**Why NPX ≠ Simpler:** Despite being distributed via npm, NPX has identical authentication complexity to Local Git. The only difference is distribution method, not setup complexity.

---

## Figma Desktop Bridge Plugin

### Required for Both Local Mode and Cloud Mode

The Desktop Bridge Plugin is the bridge between Figma and the MCP server. It communicates via WebSocket — no special Figma launch flags needed, and it persists across Figma restarts.

- **Local Mode:** Plugin connects directly to the local MCP server via WebSocket (ports 9223-9232)
- **Cloud Mode:** Plugin connects to the Cloudflare relay via WebSocket after pairing with a 6-character code

**Plugin Setup:**
1. Open Figma Desktop (normal launch — no debug flags needed)
2. Go to **Plugins → Development → Import plugin from manifest...**
3. Select `figma-desktop-bridge/manifest.json` from the figma-console-mcp directory
4. Run the plugin in your Figma file — it auto-connects via WebSocket

> **One-time import.** Once imported, the plugin stays in your Development plugins list.

**What the plugin provides:**

| Feature | Without Plugin | With Plugin (Cloud Mode) | With Plugin (Local Mode) |
|---------|----------------|--------------------------|--------------------------|
| Variables API | Enterprise plan required | ✅ Free/Pro plans work | ✅ Free/Pro plans work |
| Variable data | REST API (limited) | ✅ Full local variables | ✅ Full local variables |
| Component descriptions | Often missing (API bug) | ✅ Always present | ✅ Always present |
| Design creation (write) | ❌ | ✅ Via cloud relay | ✅ Via local WebSocket |
| Data freshness | Cache + API limits | Per-request via relay | ✅ Real-time from Figma |
| Selection tracking | ❌ | ❌ | ✅ Real-time via WebSocket |
| Document change monitoring | ❌ | ❌ | ✅ Real-time via WebSocket |

**Local Mode Transport:** The server automatically selects an available port in the range 9223–9232, supporting multiple simultaneous MCP instances. All 87+ tools work through the WebSocket transport.

**Cloud Mode Transport:** The plugin connects to the Cloudflare relay after pairing. Write operations are relayed from the cloud MCP server through the Durable Object to the plugin. (76 tools) are available.

### Plugin Does NOT Work with Remote Read-Only Mode

Remote read-only mode runs in Cloudflare Workers which cannot connect to `localhost` on your machine. The Desktop Bridge Plugin requires either a local MCP server (NPX or Local Git) or Cloud Mode pairing.

---

## When to Switch Modes

### Switch from Remote (read-only) → Cloud Mode if:
- ❌ You need to create or modify designs from a web AI client
- ❌ You need variables but don't have Enterprise plan
- ❌ Component descriptions are missing in API responses

### Switch from Remote (read-only) → NPX/Local Git if:
- ❌ You need real-time selection tracking or document change monitoring
- ❌ You're developing Figma plugins (need console log streaming)
- ❌ You need the full 87+ tool set
- ❌ You need offline access

### Switch from Cloud Mode → NPX/Local Git if:
- ❌ You need real-time selection tracking or document changes
- ❌ You need console log streaming
- ❌ You need MCP Apps (Token Browser, Design System Dashboard)
- ❌ Connection drops between AI turns are disruptive to your workflow

### Switch from NPX/Local Git → Cloud Mode if:
- ✅ You want to use web AI clients (Claude.ai, v0, Replit, Lovable)
- ✅ You don't need real-time monitoring features
- ✅ You can't or don't want to install Node.js

### Switch from NPX/Local Git → Remote (read-only) if:
- ✅ You got Enterprise plan (Variables API now available)
- ✅ You're no longer developing plugins
- ✅ You want zero-maintenance OAuth setup
- ✅ You want per-user authentication
- ✅ You only need read access

### Switch from NPX → Local Git if:
- ✅ You want to modify source code
- ✅ You want to test unreleased features
- ✅ You're developing the MCP server itself

### Switch from Local Git → NPX if:
- ✅ You don't need source code access
- ✅ You want automatic updates
- ✅ You want simpler distribution (no git operations)

---

## Cost Comparison

All setup methods are completely free:

### Remote / Cloud Mode (Free - Hosted by Project)
- ✅ Free to use
- ✅ Hosted on Cloudflare Workers
- ✅ No infrastructure costs for users
- ⚠️ Shared rate limits (fair use)

### NPX (Free - Self-Hosted)
- ✅ Free to use
- ✅ Runs on your machine
- ✅ No external dependencies after setup
- ⚠️ Uses your CPU/memory

### Local Git (Free - Self-Hosted)
- ✅ Free to use
- ✅ Runs on your machine
- ✅ Full source code access
- ⚠️ Uses your CPU/memory

---

## Troubleshooting by Mode

### Remote Mode Common Issues
- **"OAuth authentication failed"** → Try re-authenticating via auth_url
- **"Browser connection timeout"** → Cold start (wait 30s, try again)
- **"Variables API 403 error"** → Enterprise plan required (use Cloud Mode or Local Mode instead)

### Cloud Mode Common Issues
- **Pairing code expired** → Ask your AI to generate a new pairing code (codes expire after 5 minutes)
- **Connection drops between AI turns** → Re-pair by asking your AI to reconnect and entering a fresh code in the plugin
- **"Cloud Mode" toggle not visible** → Re-import the manifest from `~/.figma-console-mcp/plugin/manifest.json` (one-time update to the bootloader version)
- **Plugin shows "Disconnected" in Cloud Mode** → Check your internet connection; the relay requires both the plugin and the cloud server to be online
- **Write operations not working** → Verify the Desktop Bridge plugin is running in the file you want to modify

### Local Mode Common Issues
- **"Failed to connect to Figma Desktop"** → Install the Desktop Bridge Plugin (Plugins → Development → Import from manifest) and run it in your file
- **"No plugin UI found"** → Make sure the Desktop Bridge Plugin is running in your Figma file
- **"Variables cache empty"** → Close and reopen Desktop Bridge plugin
- **Plugin shows "Disconnected"** → Make sure the MCP server is running (start/restart your MCP client)

---

## Summary

**For most users: Start with NPX Setup** ⭐
- All 87+ tools including design creation and real-time monitoring
- Automatic updates with `@latest`
- Desktop Bridge plugin support
- Variables without Enterprise plan

**Use Cloud Mode when:**
- You use web AI clients (Claude.ai, v0, Replit, Lovable)
- You need write access but can't install Node.js
- You don't need real-time selection/document tracking

**Use Local Git when:**
- You're developing the MCP server
- You want to modify source code
- You need unreleased features
- You're testing changes before contributing

**Use Remote (read-only) when:**
- You just want to explore/evaluate the tool
- You only need read-only access to design data
- You want zero-setup experience
- You don't need design creation capabilities

**Key Takeaway:** The three modes offer a clear capability progression:
- **Remote (read-only):** 22 tools — view data, screenshots, design system extraction
- **Cloud Mode:** (76 tools) — adds full write access (create, edit, delete) via relay
- **Local Mode (NPX/Git):** 87+ tools — adds real-time monitoring (selection, changes, console)

The difference is not just authentication, but **fundamental capabilities**:
- **Remote:** Cannot create, modify, or delete anything in Figma
- **Cloud:** Full design creation and variable management via the Desktop Bridge relay
- **Local:** Everything in Cloud, plus real-time selection tracking, document change monitoring, and console log streaming
