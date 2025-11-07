# Remote Mode vs Local Mode - Complete Comparison

This document clarifies the differences between Remote and Local deployment modes to help you choose the right setup.

## 🎯 Quick Decision Guide

### Use Remote Mode if you:
- ✅ Want zero-setup installation (no Node.js, no build steps)
- ✅ Need design system extraction via Figma REST API
- ✅ Are using Claude Desktop with the new Connectors UI
- ✅ Don't need the Figma Desktop Bridge plugin
- ✅ Want automatic OAuth authentication

### Use Local Mode if you:
- ✅ Are developing Figma plugins (need console debugging)
- ✅ Need variables without Enterprise API (via Desktop Bridge plugin)
- ✅ Need reliable component descriptions (Figma API has bugs)
- ✅ Want zero-latency console log capture
- ✅ Need direct access to Figma Desktop state

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

### All 14 Tools Available in Both Modes

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

### Remote Mode
**Prerequisites:** None

**Setup Time:** 2 minutes

**Steps:**
1. Open Claude Desktop → Settings → Connectors
2. Click "Add Custom Connector"
3. Paste URL: `https://figma-console-mcp.southleft.com/sse`
4. Done ✅

### Local Mode
**Prerequisites:**
- Node.js 18+
- Git
- Terminal access
- Figma Desktop installed

**Setup Time:** 10-15 minutes

**Steps:**
1. Clone repository
2. Run `npm install && npm run build:local`
3. Configure MCP client JSON config
4. Set `FIGMA_ACCESS_TOKEN` environment variable
5. Quit and restart Figma with `--remote-debugging-port=9222`
6. Verify http://localhost:9222 is accessible

---

## Authentication Comparison

### Remote Mode - OAuth (Automatic)

**How it works:**
1. First design system tool call triggers OAuth
2. Browser opens automatically to Figma authorization page
3. User authorizes app (one-time)
4. Token stored in Cloudflare KV (persistent across sessions)
5. Automatic token refresh when expired

**Benefits:**
- ✅ No manual token creation
- ✅ Per-user authentication
- ✅ Automatic token refresh
- ✅ Works with Free, Pro, and Enterprise Figma plans

**Limitations:**
- ⚠️ Requires internet connection
- ⚠️ Initial authorization flow required

### Local Mode - Personal Access Token (Manual)

**How it works:**
1. User creates PAT at https://www.figma.com/developers/api#access-tokens
2. Set as `FIGMA_ACCESS_TOKEN` environment variable
3. MCP server uses PAT for all API calls
4. No automatic refresh (token valid for 90 days)

**Benefits:**
- ✅ Works offline
- ✅ No browser-based OAuth flow
- ✅ Simpler for single-user setups

**Limitations:**
- ❌ Manual token creation required
- ❌ Must manually refresh every 90 days
- ❌ Single shared token (no per-user auth)

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

## When to Switch Modes

### Switch from Remote → Local if:
- ❌ You need variables but don't have Enterprise plan
- ❌ Component descriptions are missing in API responses
- ❌ You're developing Figma plugins (need console debugging)
- ❌ You need instant console log feedback

### Switch from Local → Remote if:
- ✅ You got Enterprise plan (Variables API now available)
- ✅ You're no longer developing plugins
- ✅ You want zero-maintenance setup
- ✅ You want per-user OAuth authentication

---

## Cost Comparison

### Remote Mode (Free - Hosted by Project)
- ✅ Free to use
- ✅ Hosted on Cloudflare Workers
- ✅ No infrastructure costs for users
- ⚠️ Shared rate limits (fair use)

### Local Mode (Free - Self-Hosted)
- ✅ Free to use
- ✅ Runs on your machine
- ✅ No external dependencies after setup
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

**For most users: Start with Remote Mode**
- Zero setup, just paste URL
- Perfect for design system extraction
- OAuth authentication is seamless

**Upgrade to Local Mode when:**
- You need the Desktop Bridge plugin features
- You're developing Figma plugins
- You don't have Enterprise plan but need variables
- You need maximum performance

Both modes provide the same 14 MCP tools - the difference is in capabilities, setup complexity, and plugin access.
