---
title: "Mode Comparison"
description: "Understand the differences between Remote, Local, and NPX installation methods and when to use each."
---

# Installation Methods & Execution Modes - Complete Comparison

This document clarifies the differences between installation methods and execution modes to help you choose the right setup.

## Understanding the Architecture

The MCP server has **two execution modes** but **three installation methods**:

### Execution Modes (Where Code Runs)
1. **Remote Mode** - Runs in Cloudflare Workers (cloud)
2. **Local Mode** - Runs on your machine (Node.js)

### Installation Methods (How You Install)
1. **Remote SSE** - URL-based connection (uses Remote Mode)
2. **NPX** - npm package distribution (uses Local Mode)
3. **Local Git** - Source code clone (uses Local Mode)

### Authentication Methods (How You Authenticate)
1. **OAuth** - Automatic browser-based auth (Remote Mode only)
2. **Personal Access Token (PAT)** - Manual token setup (NPX + Local Git)

**Key Insight:** Authentication method, NOT installation method, determines setup complexity.

## 🎯 Quick Decision Guide

### ⚠️ Critical: Tool Count Differences

| Mode | Tools Available | Capabilities |
|------|-----------------|--------------|
| **Local Mode** (NPX or Git) | **56+** | Full read/write — create, edit, delete |
| **Remote Mode** (SSE) | **21** | Read-only — view data, screenshots, logs |

> **Bottom line:** Remote SSE has ~34% of the tools and cannot create or modify designs.

### Use NPX Setup (Recommended for Most Users)
- ✅ **All 56+ tools** including design creation
- ✅ Automatic updates with `@latest`
- ✅ Desktop Bridge Plugin support (recommended connection — no debug flags needed)
- ✅ Variables without Enterprise plan
- ⚠️ Requires `FIGMA_ACCESS_TOKEN` (manual, one-time)

### Use Local Git (For Contributors)
- ✅ **All 56+ tools** including design creation
- ✅ Full source code access
- ✅ Modify and test changes
- ⚠️ Requires `FIGMA_ACCESS_TOKEN` (manual)
- ⚠️ Manual updates via `git pull && npm run build`

### Use Remote SSE (Read-Only Exploration)
- ✅ **TRUE zero-setup** - Just paste a URL
- ✅ **OAuth authentication** - No manual tokens
- ✅ Works without Figma Desktop restart
- ❌ **Only 21 tools** — cannot create or modify designs
- ❌ Cannot use Desktop Bridge plugin
- ❌ Variables require Enterprise plan

---

## Installation Methods Comparison

| Aspect | Remote SSE | NPX | Local Git |
|--------|-----------|-----|-----------|
| **Execution** | Cloudflare Workers | Local Node.js | Local Node.js |
| **Code** | `src/index.ts` | `dist/local.js` (npm) | `dist/local.js` (source) |
| **Authentication** | OAuth (automatic) | PAT (manual) | PAT (manual) |
| **Setup Complexity** | ⭐ Zero-setup | ⚠️ Manual token + plugin install | ⚠️ Manual token + plugin install |
| **Distribution** | URL only | npm package | git clone |
| **Updates** | Automatic (server-side) | `@latest` auto-updates | Manual `git pull + build` |
| **Figma Desktop** | Not required | Required (Desktop Bridge Plugin) | Required (Desktop Bridge Plugin) |
| **Desktop Bridge** | ❌ Not available | ✅ Available | ✅ Available |
| **Source Access** | No | No | Yes |
| **Use Case** | Most users | Local execution users | Developers |

---

## Feature Availability Matrix

| Feature | Remote Mode | Local Mode | Notes |
|---------|-------------|------------|-------|
| **Console Logs** | ✅ | ✅ | Remote uses Browser Rendering API, Local uses WebSocket via Desktop Bridge Plugin |
| **Screenshots** | ✅ | ✅ | Both use Figma REST API |
| **Design System Extraction** | ✅ | ✅ | Variables, components, styles via Figma API |
| **OAuth Authentication** | ✅ | ❌ | Remote has automatic OAuth, Local requires Personal Access Token |
| **Zero Setup** | ✅ | ❌ | Remote: just paste URL. Local: requires Node.js, build, Figma restart |
| **Figma Desktop Bridge Plugin** | ❌ | ✅ | **Plugin ONLY works in Local Mode** |
| **Variables without Enterprise API** | ❌ | ✅ | Requires Desktop Bridge plugin (Local only) |
| **Reliable Component Descriptions** | ⚠️ | ✅ | API has bugs, plugin method (Local) is reliable |
| **Zero-Latency Console Logs** | ❌ | ✅ | Local connects via WebSocket (ports 9223–9232) |
| **Works Behind Corporate Firewall** | ⚠️ | ✅ | Remote requires internet, Local works offline |
| **Multi-User Shared Token** | ✅ | ❌ | Remote uses per-user OAuth, Local uses single PAT |

### Legend
- ✅ Available
- ❌ Not Available
- ⚠️ Limited/Conditional

---

## Architecture Comparison

### Remote Mode Architecture
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

### Local Mode Architecture
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
- All 56+ tools work through WebSocket
- Plugin can access local variables (no Enterprise API needed)
- Instant console log capture via WebSocket

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

### Remote SSE
**Prerequisites:** None

**Setup Time:** 2 minutes

**Steps:**
1. Open Claude Desktop → Settings → Connectors
2. Click "Add Custom Connector"
3. Paste URL: `https://figma-console-mcp.southleft.com/sse`
4. Done ✅ (OAuth happens automatically on first API use)

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

### Remote SSE - OAuth (Automatic) ⭐ Recommended

**Method:** Remote Mode only

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

**Limitations:**
- ❌ **Manual token creation required**
- ❌ Must manually refresh every 90 days
- ❌ Single shared token (no per-user auth)
- ❌ **Requires Desktop Bridge Plugin** (one-time import)

**Why NPX ≠ Simpler:** Despite being distributed via npm, NPX has identical authentication complexity to Local Git. The only difference is distribution method, not setup complexity.

---

## Figma Desktop Bridge Plugin

### Recommended Connection Method (Local Mode)

The Desktop Bridge Plugin is the **recommended way** to connect Figma to the MCP server. It communicates via WebSocket (port 9223) — no special Figma launch flags needed, and it persists across Figma restarts.

**Plugin Setup:**
1. Open Figma Desktop (normal launch — no debug flags needed)
2. Go to **Plugins → Development → Import plugin from manifest...**
3. Select `figma-desktop-bridge/manifest.json` from the figma-console-mcp directory
4. Run the plugin in your Figma file — it auto-connects via WebSocket

> **One-time import.** Once imported, the plugin stays in your Development plugins list.

**What the plugin provides (Local Mode only):**

| Feature | Without Plugin | With Plugin (Local Only) |
|---------|----------------|--------------------------|
| Variables API | Enterprise plan required | ✅ Free/Pro plans work |
| Variable data | REST API (limited) | ✅ Full local variables |
| Component descriptions | Often missing (API bug) | ✅ Always present |
| Data freshness | Cache + API limits | ✅ Real-time from Figma |
| Multi-mode support | Limited | ✅ All modes (Light/Dark/etc) |
| Selection tracking | ❌ | ✅ Real-time via WebSocket |
| Document change monitoring | ❌ | ✅ Real-time via WebSocket |

**Transport:** The MCP server communicates via WebSocket through the Desktop Bridge Plugin. The server automatically selects an available port in the range 9223–9232, supporting multiple simultaneous MCP instances. All 56+ tools work through the WebSocket transport.

### Plugin Only Works in Local Mode

Remote mode runs in Cloudflare Workers which cannot connect to `localhost` on your machine. The Desktop Bridge Plugin requires a local MCP server (NPX or Local Git setup).

---

## When to Switch Installation Methods

### Switch from Remote SSE → NPX/Local Git if:
- ❌ You need variables but don't have Enterprise plan
- ❌ Component descriptions are missing in API responses
- ❌ You're developing Figma plugins (need console debugging)
- ❌ You need instant console log feedback
- ❌ You need Desktop Bridge plugin features

### Switch from NPX/Local Git → Remote SSE if:
- ✅ You got Enterprise plan (Variables API now available)
- ✅ You're no longer developing plugins
- ✅ You want zero-maintenance OAuth setup
- ✅ You want per-user authentication
- ✅ You don't need Desktop Bridge plugin

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

All three installation methods are completely free:

### Remote SSE (Free - Hosted by Project)
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
- **"Variables API 403 error"** → Enterprise plan required (use Local Mode instead)

### Local Mode Common Issues
- **"Failed to connect to Figma Desktop"** → Install the Desktop Bridge Plugin (Plugins → Development → Import from manifest) and run it in your file
- **"No plugin UI found"** → Make sure the Desktop Bridge Plugin is running in your Figma file
- **"Variables cache empty"** → Close and reopen Desktop Bridge plugin
- **Plugin shows "Disconnected"** → Make sure the MCP server is running (start/restart your MCP client)

---

## Summary

**For most users: Start with NPX Setup** ⭐
- All 56+ tools including design creation
- Automatic updates with `@latest`
- Desktop Bridge plugin support
- Variables without Enterprise plan

**Use Local Git when:**
- You're developing the MCP server
- You want to modify source code
- You need unreleased features
- You're testing changes before contributing

**Use Remote SSE when:**
- You just want to explore/evaluate the tool
- You only need read-only access to design data
- You want zero-setup experience
- You don't need design creation capabilities

**Key Takeaway:** Remote SSE and Local modes have **different tool counts**:
- **Remote Mode (SSE):** 21 tools — read-only operations
- **Local Mode (NPX/Git):** 56+ tools — full read/write operations

The difference is not just authentication, but **fundamental capabilities**:
- **Remote:** Cannot create, modify, or delete anything in Figma
- **Local:** Full design creation, variable management, and component manipulation
