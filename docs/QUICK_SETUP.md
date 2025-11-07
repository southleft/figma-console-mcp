# Quick Setup for Testing Style Extraction

## 🚨 IMPORTANT: You Need a Figma Access Token!

The 404 error you're seeing means the MCP needs your Figma Access Token to access the API.

### Step 1: Get Your Figma Access Token

1. Go to: https://www.figma.com/settings
2. Scroll down to "Personal Access Tokens"
3. Click "Create new token"
4. Give it a name like "figma-console-mcp"
5. Copy the token (you'll only see it once!)

### Step 2: Add Token to Environment File

Edit the `.env.local` file in this directory and replace `your_token_here` with your actual token:

```bash
FIGMA_ACCESS_TOKEN=figd_xxxxxxxxxxxxxxxxxxxxxx
```

### Step 3: Restart the Server

```bash
# Stop the current server (Ctrl+C)
# Then restart:
npm start
```

### Step 4: Update Claude Desktop Config

Make sure your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`) has:

```json
{
  "mcpServers": {
    "figma-console-mcp": {
      "command": "npm",
      "args": ["start"],
      "cwd": "/Users/tjbackup/Sites/figma-console-mcp",
      "env": {
        "FIGMA_ACCESS_TOKEN": "your_actual_token_here"
      }
    }
  }
}
```

**OR** if using the .env.local file approach, make sure the server can read it:

```json
{
  "mcpServers": {
    "figma-console-mcp": {
      "command": "npm",
      "args": ["start"],
      "cwd": "/Users/tjbackup/Sites/figma-console-mcp"
    }
  }
}
```

### Step 5: Restart Claude Desktop

After updating the config, fully restart Claude Desktop.

### Step 6: Test Again

Ask Claude Desktop the same question:
```
I have a Figma file at:
https://www.figma.com/design/EJhOnWMmRvZnogULvkwZbB/Altitude-Design-System

Can you extract the design variables from this file?
```

## What Should Happen

With the token configured:
1. Claude will use `figma_get_variables`
2. Get a 403 error (Variables API needs Enterprise)
3. **Automatically fall back to style extraction**
4. Return extracted colors, typography, spacing

## Troubleshooting

If still getting 404:
- Make sure the token is valid
- Check if the file is accessible (try opening in browser)
- The file might be in a team/org that requires specific permissions

If getting 403 on Variables API:
- ✅ This is expected! The tool should automatically fall back to style extraction
- You should see "source": "style_extraction" in the response

## Note on the Fallback

The style extraction fallback will:
- Use the regular `/files` API (no Enterprise needed)
- Extract colors, fonts, spacing from the design
- Return them formatted like variables
- Work with just a Personal Access Token!