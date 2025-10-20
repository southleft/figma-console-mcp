# Release Notes

## What's Included

This release includes the **Figma Variables Bridge** plugin, which enables AI assistants to access your Figma design system data (variables, styles, components) without requiring Figma Enterprise.

### 📦 Package Contents

- `figma-variables-bridge.zip` - Ready-to-install Figma plugin

### ✨ Features

- **Zero Configuration**: Works immediately after installation
- **Enterprise API Bypass**: Access variables without Figma Enterprise plan
- **Real-time Updates**: Changes in Figma instantly available to AI
- **Southleft Branded**: Made with ❤️ by Southleft

## 🚀 Quick Install (3 Steps)

### Step 1: Install MCP Server

```bash
claude mcp add --transport sse figma-console https://figma-console-mcp.southleft.com/sse
```

### Step 2: Download & Unzip Plugin

1. Download `figma-variables-bridge.zip` from this release
2. Unzip the file to any location

### Step 3: Install in Figma

1. Open Figma Desktop
2. Go to **Plugins → Development → Import plugin from manifest**
3. Select the `manifest.json` file from your unzipped folder

**Done!** ✅

## 🎯 How to Use

1. Open any Figma file with design tokens (variables)
2. Right-click → **Plugins → Development → Figma Variables Bridge**
3. Plugin shows "✓ Variables ready"
4. Ask Claude: **"Show me the primary font for [your theme name]"**

## 📖 Full Documentation

- **Main README**: [Installation & Setup](https://github.com/southleft/figma-console-mcp)
- **Plugin Docs**: [Variables Bridge Documentation](https://github.com/southleft/figma-console-mcp/blob/main/figma-variables-bridge/README.md)

## 🐛 Issues?

Report issues at: https://github.com/southleft/figma-console-mcp/issues

---

**Made with ❤️ by [Southleft](https://southleft.com)**
