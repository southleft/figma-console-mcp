# Deployment Mode Comparison: Local vs Remote (Cloudflare)

Quick reference guide to understand the differences between Local Mode (Figma Desktop) and Remote Mode (Cloudflare Workers).

---

## TL;DR Decision Matrix

| If you need... | Use This Mode |
|----------------|---------------|
| **Component descriptions from local/unpublished components** | 🏠 Local (Desktop Bridge required) |
| **Variables without Figma Enterprise plan** | 🏠 Local (Desktop Bridge required) |
| **Plugin console debugging and logs** | Either mode works |
| **Screenshots and visual debugging** | ☁️ Remote (better) or Local |
| **Team-wide access without Figma Desktop** | ☁️ Remote only |
| **Works in CI/CD pipelines** | ☁️ Remote only |
| **File data, components, styles (REST API only)** | Either mode works |

---

## Architecture Comparison

### 🏠 Local Mode (Figma Desktop Connection)

```
Claude Desktop/Code
  ↓ stdio transport
MCP Server (local Node.js process)
  ↓ Chrome DevTools Protocol (port 9222)
Figma Desktop Application
  ↓ Plugin API
Desktop Bridge Plugin (when needed)
  ↓ Direct access
Figma Variables + Component Descriptions
```

**Connects to:** Figma Desktop via `localhost:9222` (remote debugging port)

### ☁️ Remote Mode (Cloudflare Workers)

```
Claude Desktop/Code
  ↓ HTTPS
MCP Agent (Cloudflare Worker)
  ↓ Browser Rendering API
Headless Chromium (Cloudflare managed)
  ↓ HTTPS
Figma Web App
  ↓ REST API fallback
Figma Cloud Data
```

**Connects to:** Figma web app via Cloudflare's Browser Rendering API

---

## Feature Comparison Table

| Feature | Local Mode | Remote Mode | Notes |
|---------|------------|-------------|-------|
| **REST API Access** ||||
| File data (structure, nodes) | ✅ | ✅ | Both use Figma REST API |
| Components metadata | ✅ | ✅ | Both use REST API |
| Styles data | ✅ | ✅ | Both use REST API |
| Variables (with Enterprise) | ✅ | ✅ | Requires Figma Enterprise plan |
| **Desktop Bridge Features** ||||
| Variables (NO Enterprise needed) | ✅ | ❌ | Local only - requires Desktop Bridge plugin |
| Component descriptions (reliable) | ✅ | ❌ | Local only - bypasses REST API bug |
| Local/unpublished components | ✅ | ❌ | Local only - Desktop Bridge access |
| **Console & Debugging** ||||
| Plugin console logs | ✅ | ✅ | Both support console monitoring |
| Real-time log streaming | ✅ | ✅ | Both can watch logs live |
| Console error capture | ✅ | ✅ | Both capture errors with stack traces |
| **Visual & Screenshots** ||||
| Page screenshots | ✅ | ✅ | Both support screenshots |
| Component screenshots | ✅ | ✅ | Both can capture specific nodes |
| Screenshot quality | Good | Better | Cloudflare has higher limits |
| **Deployment & Access** ||||
| Setup complexity | Medium | High | Local: Desktop setup / Remote: Cloudflare account |
| Team accessibility | One machine | Global | Local: requires local Figma / Remote: URL-based |
| CI/CD integration | ❌ | ✅ | Remote can be called from automation |
| Requires Figma Desktop | ✅ Required | ❌ Not needed | Local needs desktop app running |
| Works offline | ❌ | ❌ | Both need internet for Figma API |

---

## Key Differences Explained

### 1. Desktop Bridge Plugin (Local Only)

**What it is:** A Figma plugin that runs in Figma Desktop and exposes data that's not available via REST API.

**Why it matters:**
- ✅ **Variables without Enterprise:** Access all local variables without paying for Figma Enterprise plan
- ✅ **Reliable component descriptions:** Bypass REST API bug where descriptions are missing
- ✅ **Local team components:** Access unpublished components in team project files

**How it works:**
```javascript
// Local Mode with Desktop Bridge
Plugin Worker → postMessage → Plugin UI iframe → Puppeteer → MCP → AI

// Remote Mode (no Desktop Bridge)
REST API only → MCP → AI  // Descriptions often missing
```

**Limitation:** Desktop Bridge ONLY works in Local Mode because it requires:
1. Figma Desktop application running
2. Plugin installed and active
3. Chrome DevTools Protocol connection (port 9222)

Remote Mode (Cloudflare) connects to Figma **web app** in a browser, which doesn't support plugins.

---

### 2. Browser Context

**Local Mode:**
- Uses your actual Figma Desktop application
- Full Plugin API access when Desktop Bridge is running
- Direct access to design files on your machine
- Requires `--remote-debugging-port=9222` flag

**Remote Mode:**
- Uses Cloudflare's Browser Rendering API (headless Chromium)
- Connects to `figma.com` web app (not desktop app)
- No plugin support (web app limitation)
- REST API only for data access

---

### 3. Console Debugging Capabilities

**Both modes support:**
- ✅ Console log capture (`console.log`, `console.error`, etc.)
- ✅ Real-time monitoring
- ✅ Error stack traces
- ✅ Performance warnings

**Key difference:**
- **Local:** Monitors YOUR Figma Desktop plugin console
- **Remote:** Monitors Figma web app console (less useful for plugin development)

---

### 4. Use Case: Component Descriptions

This is a common pain point that illustrates the difference perfectly.

**Scenario:** You want AI to read component descriptions to understand usage guidelines.

**Local Mode (Recommended):**
```bash
# 1. Launch Figma Desktop with debugging
open -a "Figma" --args --remote-debugging-port=9222

# 2. Run Desktop Bridge plugin in your file

# 3. Ask Claude:
"What does the Button component description say?"

# Result: Full description from Desktop Bridge ✅
```

**Remote Mode:**
```bash
# 1. Deploy to Cloudflare

# 2. Ask Claude:
"What does the Button component description say?"

# Result: Description missing (REST API bug) ⚠️
# Shows: "Retrieved via REST API - description field may be missing"
```

---

## Setup Requirements

### Local Mode

**Required:**
```bash
# 1. Figma Desktop installed
# 2. Launch with debug flag
open -a "Figma" --args --remote-debugging-port=9222

# 3. MCP configuration
{
  "mcpServers": {
    "figma-console": {
      "command": "node",
      "args": ["/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_...",
        "FIGMA_MODE": "local"
      }
    }
  }
}

# 4. Desktop Bridge plugin (optional but recommended)
# Install via: Plugins → Development → Import plugin from manifest
```

**Pros:**
- ✅ Access to Desktop Bridge features
- ✅ Full plugin development workflow
- ✅ Reliable component descriptions
- ✅ Variables without Enterprise plan

**Cons:**
- ❌ Requires Figma Desktop running
- ❌ Only works on your local machine
- ❌ Can't use in CI/CD
- ❌ Manual plugin installation needed

---

### Remote Mode (Cloudflare)

**Required:**
```bash
# 1. Cloudflare account with Browser Rendering API enabled
# 2. Deploy MCP to Cloudflare Workers
npm run deploy

# 3. MCP configuration (points to your Cloudflare Worker URL)
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "@southleft/figma-console-mcp"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_...",
        "CLOUDFLARE_WORKER_URL": "https://your-worker.workers.dev"
      }
    }
  }
}
```

**Pros:**
- ✅ Team-wide access via URL
- ✅ Works in CI/CD pipelines
- ✅ No Figma Desktop required
- ✅ Easier for remote teams

**Cons:**
- ❌ No Desktop Bridge (no variables without Enterprise)
- ❌ Component descriptions may be missing
- ❌ Can't debug local plugins
- ❌ Cloudflare Browser Rendering costs

---

## Cost Comparison

| Mode | Costs |
|------|-------|
| **Local** | Free (uses your Figma Desktop) |
| **Remote** | Cloudflare Browser Rendering API usage (pay-per-use) |

**Cloudflare Pricing:**
- Free tier: 10,000 requests/month
- Paid: $5/million browser requests
- [Pricing details](https://developers.cloudflare.com/workers/platform/pricing/)

---

## Performance Comparison

| Operation | Local Mode | Remote Mode |
|-----------|------------|-------------|
| First connection | ~2-3 seconds | ~5-10 seconds (browser launch) |
| Component query | ~100-500ms | ~200-800ms |
| Screenshot | ~500ms-2s | ~1-3s |
| Console monitoring | Real-time | Real-time |
| Variables (Desktop Bridge) | ~200ms | N/A |

**Network impact:** Remote mode requires internet for Cloudflare → Figma → Your MCP client round trip.

---

## Choosing the Right Mode

### Choose Local Mode if:
- 🎯 You need **reliable component descriptions** from local/unpublished components
- 🎯 You want **variables without Figma Enterprise plan**
- 🎯 You're doing **plugin development** (need console debugging)
- 🎯 You have **Figma Desktop** and can run it locally
- 🎯 You're the **primary user** (not sharing with remote team)

### Choose Remote Mode if:
- 🌐 You need **team-wide access** without everyone having Figma Desktop
- 🤖 You want **CI/CD integration** or automation
- 📊 You're only using **REST API data** (files, basic components, styles)
- 💰 You have **Figma Enterprise** (for variables via REST API)
- 🌍 Your team is **remote/distributed**

### Use Both Modes if:
- 💡 **Local** for plugin development and design system work
- ☁️ **Remote** for team collaboration and automation
- Set up both configurations in your MCP settings with different names

---

## Migration Between Modes

You can switch between modes easily:

### Local → Remote

**What you'll lose:**
- Desktop Bridge features (variables without Enterprise, reliable descriptions)
- Plugin console debugging capability

**What you'll gain:**
- Team accessibility
- CI/CD integration
- No local Figma Desktop requirement

### Remote → Local

**What you'll lose:**
- Team-wide URL access
- CI/CD automation

**What you'll gain:**
- Desktop Bridge features
- Plugin development workflow
- Reliable component descriptions

---

## FAQ

**Q: Can I use both modes simultaneously?**
A: Yes! Configure two separate MCP servers in your Claude Desktop config:
```json
{
  "mcpServers": {
    "figma-local": { "command": "node", "args": ["/path/to/local.js"], ... },
    "figma-remote": { "command": "npx", "args": ["@southleft/figma-console-mcp"], ... }
  }
}
```

**Q: Does Remote Mode support variables?**
A: Only if you have Figma Enterprise plan (REST API access). Local Mode with Desktop Bridge bypasses this requirement.

**Q: Can Remote Mode access my local Figma files?**
A: No, Remote Mode only accesses files via Figma's cloud (figma.com). All files must be saved to Figma cloud.

**Q: Which mode is better for component descriptions?**
A: Local Mode with Desktop Bridge is FAR better for component descriptions, especially for local/unpublished components. Remote Mode often returns missing descriptions due to REST API limitations.

**Q: Can Remote Mode run the Desktop Bridge plugin?**
A: No. Desktop Bridge requires Figma Desktop application, which Remote Mode doesn't have access to (it uses web app in browser).

**Q: Does Local Mode work offline?**
A: Partially. You can access Figma Desktop features (plugin console, screenshots) offline, but REST API calls (file data, components, styles) require internet.

---

## Summary

| Aspect | Local Mode | Remote Mode |
|--------|------------|-------------|
| **Best for** | Plugin development, Design system work | Team collaboration, Automation |
| **Key advantage** | Desktop Bridge access | Global accessibility |
| **Key limitation** | Requires local Figma Desktop | No plugin support |
| **Setup effort** | Medium | High |
| **Ongoing cost** | Free | Cloudflare usage fees |
| **Component descriptions** | ✅ Reliable via Desktop Bridge | ⚠️ Often missing (REST API) |
| **Variables (no Enterprise)** | ✅ Yes via Desktop Bridge | ❌ No |

**Recommendation:** Start with **Local Mode** if you're working on design systems or need reliable component descriptions. Switch to **Remote Mode** when you need team-wide access or CI/CD integration.

---

## Getting Help

- **Local Mode issues:** Check Figma Desktop is running with `--remote-debugging-port=9222`
- **Remote Mode issues:** Verify Cloudflare Browser Rendering API is enabled
- **Desktop Bridge not working:** Ensure plugin is actively running in Figma Desktop

For detailed setup instructions, see [README.md](README.md).
