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

## 🚀 Quick Install (5 Steps)

### Step 1: Get Your Figma Access Token

1. Go to: https://www.figma.com/developers/api#access-tokens
2. Click "Create new token"
3. Copy the token (starts with `figd_`)

### Step 2: Configure Claude Desktop

**Open Claude Desktop settings:**
- **Mac**: Claude menu → Settings → Developer
- **Windows**: File menu → Settings → Developer

Click **"Edit Config"** and add:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://figma-console-mcp.southleft.com/sse"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_token_here"
      }
    }
  }
}
```

**Save and restart Claude Desktop**

### Step 3: Download & Unzip Plugin

1. Download `figma-variables-bridge.zip` from this release
2. Unzip the file to any location

### Step 4: Install in Figma

1. Open Figma Desktop
2. Go to **Plugins → Development → Import plugin from manifest**
3. Select the `manifest.json` file from your unzipped folder

### Step 5: Use It!

1. Open any Figma file with design tokens
2. Right-click → **Plugins → Development → Figma Variables Bridge**
3. Ask Claude: **"Show me the primary font for [your theme]"**

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
