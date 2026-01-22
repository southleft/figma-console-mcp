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

### Use Remote SSE (Recommended for Most Users)
- ✅ **TRUE zero-setup** - Just paste a URL
- ✅ **OAuth authentication** - Automatic browser flow, no manual tokens
- ✅ Works without Figma Desktop restart
- ✅ No local installation required
- ❌ Cannot use Desktop Bridge plugin

### Use NPX (For Local Execution Without Source Code)
- ✅ No git clone required (npm handles it)
- ✅ Automatic updates with `@latest`
- ✅ Desktop Bridge plugin support
- ⚠️ Requires `FIGMA_ACCESS_TOKEN` (manual)
- ⚠️ Requires Figma Desktop restart with `--remote-debugging-port=9222`

### Use Local Git (For Development & Testing)
- ✅ Full source code access
- ✅ Modify and test changes
- ✅ Desktop Bridge plugin support
- ⚠️ Requires `FIGMA_ACCESS_TOKEN` (manual)
- ⚠️ Requires Figma Desktop restart with `--remote-debugging-port=9222`
- ⚠️ Manual updates via `git pull && npm run build`

---

## Installation Methods Comparison

| Aspect | Remote SSE | NPX | Local Git |
|--------|-----------|-----|-----------|
| **Execution** | Cloudflare Workers | Local Node.js | Local Node.js |
| **Code** | `src/index.ts` | `dist/local.js` (npm) | `dist/local.js` (source) |
| **Authentication** | OAuth (automatic) | PAT (manual) | PAT (manual) |
| **Setup Complexity** | ⭐ Zero-setup | ⚠️ Manual token + restart | ⚠️ Manual token + restart |
| **Distribution** | URL only | npm package | git clone |
| **Updates** | Automatic (server-side) | `@latest` auto-updates | Manual `git pull + build` |
| **Figma Desktop** | Not required | Required with debug port | Required with debug port |
| **Desktop Bridge** | ❌ Not available | ✅ Available | ✅ Available |
| **Source Access** | No | No | Yes |
| **Use Case** | Most users | Local execution users | Developers |

---

## Feature Availability Matrix

| Feature | Remote Mode | Local Mode | Notes |
|---------|-------------|------------|-------|
| **Console Logs** | ✅ | ✅ | Remote uses Browser Rendering API, Local uses Chrome DevTools Protocol |
| **Screenshots** | ✅ | ✅ | Both use Figma REST API |
| **Design System Extraction** | ✅ | ✅ | Variables, components, styles via Figma API |
| **OAuth Authentication** | ✅ | ❌ | Remote has automatic OAuth, Local requires Personal Access Token |
| **Zero Setup** | ✅ | ❌ | Remote: just paste URL. Local: requires Node.js, build, Figma restart |
| **Figma Desktop Bridge Plugin** | ❌ | ✅ | **Plugin ONLY works in Local Mode** |
| **Variables without Enterprise API** | ❌ | ✅ | Requires Desktop Bridge plugin (Local only) |
| **Reliable Component Descriptions** | ⚠️ | ✅ | API has bugs, plugin method (Local) is reliable |
| **Zero-Latency Console Logs** | ❌ | ✅ | Local connects directly to Figma Desktop via localhost:9222 |
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
- Cannot access `localhost:9222` on your machine
- OAuth tokens stored in Cloudflare KV
- ~10-30s cold start for first request

### Local Mode Architecture
```
Claude Desktop/Code
    ↓ (stdio transport)
Local MCP Server (Node.js)
    ↓ (Chrome DevTools Protocol)
Figma Desktop (localhost:9222)
    ↓ (Plugin API)
Figma Desktop Bridge Plugin
    ↓ (Direct memory access)
Variables & Components Data
```

**Key Points:**
- Direct connection to Figma Desktop
- Instant console log capture
- Plugin can access local variables (no Enterprise API needed)
- Requires Figma Desktop restart with debug flag

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
- Figma Personal Access Token ([get one](https://www.figma.com/developers/api#access-tokens))

**Setup Time:** 10 minutes

**Steps:**
1. Get Figma Personal Access Token
2. Add to MCP config with `FIGMA_ACCESS_TOKEN` env var
3. Quit and restart Figma with `--remote-debugging-port=9222`
4. Verify http://localhost:9222 is accessible

### Local Git
**Prerequisites:**
- Node.js 18+
- Git
- Figma Desktop installed
- Figma Personal Access Token ([get one](https://www.figma.com/developers/api#access-tokens))

**Setup Time:** 15 minutes

**Steps:**
1. Clone repository: `git clone https://github.com/southleft/figma-console-mcp.git`
2. Run `npm install && npm run build:local`
3. Get Figma Personal Access Token
4. Configure MCP client JSON config with path to `dist/local.js`
5. Set `FIGMA_ACCESS_TOKEN` environment variable
6. Quit and restart Figma with `--remote-debugging-port=9222`
7. Verify http://localhost:9222 is accessible

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
1. User creates PAT at https://www.figma.com/developers/api#access-tokens
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
- ❌ **Requires Figma Desktop restart** with debug port

**Why NPX ≠ Simpler:** Despite being distributed via npm, NPX has identical authentication complexity to Local Git. The only difference is distribution method, not setup complexity.

---

## Figma Desktop Bridge Plugin

### ⚠️ CRITICAL: Plugin Only Works in Local Mode

**Why it doesn't work remotely:**

The Desktop Bridge plugin requires:
1. **Direct Chrome DevTools Protocol connection** to `localhost:9222`
2. **Access to plugin UI iframe's `window` object** via Puppeteer
3. **Local filesystem access** to read plugin code

Remote mode runs in Cloudflare Workers which:
- ❌ Cannot connect to `localhost:9222` on your machine
- ❌ Has no access to your Figma Desktop instance
- ❌ Uses Browser Rendering API (cloud browser, not local)

**What the plugin provides (Local Mode only):**

| Feature | Without Plugin | With Plugin (Local Only) |
|---------|----------------|--------------------------|
| Variables API | Enterprise plan required | ✅ Free/Pro plans work |
| Variable data | REST API (limited) | ✅ Full local variables |
| Component descriptions | Often missing (API bug) | ✅ Always present |
| Data freshness | Cache + API limits | ✅ Real-time from Figma |
| Multi-mode support | Limited | ✅ All modes (Light/Dark/etc) |

**Plugin Setup (Local Mode):**
1. Install Local Mode MCP server
2. Download `figma-desktop-bridge.zip` from releases
3. Import plugin in Figma: Plugins → Development → Import plugin from manifest
4. Run plugin in your Figma file
5. Query variables/components via MCP

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
- **"Failed to connect to Figma Desktop"** → Restart Figma with `--remote-debugging-port=9222`
- **"No plugin UI found"** → Make sure Desktop Bridge plugin is running
- **"ECONNREFUSED localhost:9222"** → Verify http://localhost:9222 is accessible
- **"Variables cache empty"** → Close and reopen Desktop Bridge plugin

---

## Summary

**For most users: Start with Remote SSE** ⭐
- Zero setup, just paste URL
- OAuth authentication (automatic)
- Perfect for design system extraction
- No Figma Desktop restart required

**Use NPX when:**
- You need Desktop Bridge plugin features
- You want local execution without source code
- You don't have Enterprise plan but need variables
- You prefer npm distribution over git

**Use Local Git when:**
- You're developing the MCP server
- You want to modify source code
- You need unreleased features
- You're testing changes before contributing

**Key Takeaway:** All three methods provide the same 40+ MCP tools. The difference is in:
- **Authentication**: OAuth (Remote SSE) vs PAT (NPX + Local Git)
- **Distribution**: URL (Remote SSE) vs npm (NPX) vs git (Local Git)
- **Execution**: Cloud (Remote SSE) vs Local (NPX + Local Git)
