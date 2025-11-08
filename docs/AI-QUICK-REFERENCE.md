# Figma Console MCP - AI Quick Reference

## TL;DR - Most Important Rules

1. **NEVER hop between MCPs for Figma data** - Stay in Figma console MCP
2. **NEVER use Playwright for Figma queries** - Use `figma_get_*` tools
3. **ALWAYS check `response.source`** - Tells you if Desktop Bridge was used
4. **Desktop Bridge = Reliable Descriptions** - Plugin API access beats REST API

## One-Line Tool Selection

```
Component description     → figma_get_component
Variables/tokens          → figma_get_variables
File structure            → figma_get_file_data
Styles (colors/text)      → figma_get_styles
Component image           → figma_get_component_image
Code generation context   → figma_get_component_for_development
```

## The Desktop Bridge Pattern

```
User: "Get component description"
  ↓
You: Call figma_get_component
  ↓
Response source="rest_api" + no description?
  ↓
You: "Please run Desktop Bridge plugin:
     Figma Desktop → Right-click → Plugins → Development → Desktop Bridge"
  ↓
User: Runs plugin
  ↓
You: Retry figma_get_component
  ↓
Response source="desktop_bridge_plugin" ✓
```

## Response Checklist

- [ ] Check `source` field (`"desktop_bridge_plugin"` vs `"rest_api"`)
- [ ] Check `warning` field for known limitations
- [ ] Check `action_required` field for user instructions
- [ ] If REST API and missing data → instruct user to run Desktop Bridge

## Common Mistakes

| ❌ Wrong | ✓ Correct |
|---------|----------|
| Try figma_get_component, then switch to figma-official MCP | Stay in figma_get_component, check response.source |
| Use Playwright to query Figma UI | Use figma_get_* tools (they handle browser internally) |
| Assume description always available | Check source=="desktop_bridge_plugin" for reliable descriptions |

## When Description is Missing

```javascript
// Check response
if (response.source === "rest_api" && !response.component.description) {
  // Tell user to run Desktop Bridge, don't switch tools
  return instructionsForDesktopBridge();
}
```

## Desktop Bridge Plugin

**What it does:** Accesses Figma Plugin API for data not in REST API (like component.description)

**How it works:**
1. Runs as Figma plugin (`code.js`)
2. Exposes data via UI iframe (`ui.html`)
3. Puppeteer reads data from iframe
4. MCP tools get reliable data

**Console logs to look for:**
```
✓ 🌉 [Desktop Bridge] Plugin loaded and ready
✓ 🌉 [Desktop Bridge] Ready to handle component requests
```

## Tool Priority

```
Always use:     Figma console MCP tools (figma_get_*)
Fallback if fails: Figma official MCP (mcp__figma-official__)
Never use:      Playwright/browser automation for Figma data
```

## Example: Good vs Bad Workflow

### ❌ Bad (Tool Hopping)
```
1. figma_get_component (console MCP)
2. No description → Try figma-official MCP
3. Still no description → Try Playwright
4. Give up
```

### ✓ Good (Stay in Console MCP)
```
1. figma_get_component (console MCP)
2. Check response.source
3. If "rest_api" → Instruct user to run Desktop Bridge
4. User runs plugin
5. Retry figma_get_component
6. Success with source="desktop_bridge_plugin"
```

## Remember

- **This MCP is comprehensive** - it has proper fallbacks and error handling
- **Trust the response metadata** - `source`, `warning`, `action_required` tell you what to do
- **Don't work around the tool** - if it says "run Desktop Bridge", that's the solution
- **Stay in one MCP** - tool hopping creates confusion, not solutions

## When in Doubt

```python
if task.involves_figma_data:
    use_figma_console_mcp_tools()  # THIS MCP
    check_response_metadata()
    follow_action_required_if_present()
else:
    use_appropriate_mcp()  # Serena, Context7, etc.
```

---

**Bottom line:** The Figma console MCP works. Use it properly, check responses, follow instructions. Don't hop tools.
