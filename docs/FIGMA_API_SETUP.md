# Figma API Tools Setup

The Figma Console MCP now includes **4 new tools** for extracting data from Figma files using the Figma REST API. These tools allow you to read component properties, variables/tokens, and styles directly from your Figma files.

## New Tools (8-11)

1. **figma_get_file_data** - Get file structure, components, and metadata
2. **figma_get_variables** - Get design tokens and variables
3. **figma_get_component** - Get specific component data and properties
4. **figma_get_styles** - Get color/text/effect styles

## Setup Requirements

### 1. Get a Figma Access Token

Visit: https://www.figma.com/developers/api#access-tokens

1. Log in to Figma
2. Go to **Settings** → **Account** → **Personal Access Tokens**
3. Click **Generate new token**
4. Give it a name (e.g., "Figma Console MCP")
5. Copy the token (you won't see it again!)

**Required scopes:**
- `file_read` or `file_content:read` - Read file data
- `file_variables:read` - Read variables (Enterprise only)

### 2. Configure the Token

#### Option A: For Public Server Users

If you're using `https://figma-console-mcp.southleft.com`, you **cannot** use these tools because we don't have your Figma token. You'll need to deploy your own instance.

#### Option B: Deploy Your Own Instance

**In `wrangler.jsonc`, add the token as an environment variable:**

```jsonc
{
  "name": "figma-console-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2025-03-10",
  "compatibility_flags": ["nodejs_compat"],

  // Add this section:
  "vars": {
    "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE"
  },

  "durable_objects": {
    // ... existing config ...
  },
  "browser": {
    "binding": "BROWSER"
  }
}
```

**Or use environment variables (more secure):**

```bash
# .dev.vars (for local development)
FIGMA_ACCESS_TOKEN=figd_YOUR_TOKEN_HERE

# For production, use wrangler secrets:
npx wrangler secret put FIGMA_ACCESS_TOKEN
# Then paste your token when prompted
```

### 3. Deploy

```bash
npm run deploy
```

## Usage Examples

### Get Variables/Design Tokens

```javascript
// Navigate to your Figma file first
figma_navigate({
  url: 'https://www.figma.com/design/abc123/My-Design-System'
})

// Get all variables (local + published)
figma_get_variables()

// Returns:
{
  "fileKey": "abc123",
  "local": {
    "summary": {
      "totalCollections": 2,
      "totalVariables": 45,
      "variablesByType": {
        "COLOR": 20,
        "FLOAT": 15,
        "STRING": 10
      }
    },
    "collections": [
      {
        "id": "123:456",
        "name": "Semantic Colors",
        "modes": [...]
      }
    ],
    "variables": [
      {
        "id": "123:789",
        "name": "color/primary",
        "resolvedType": "COLOR",
        "valuesByMode": {...}
      }
    ]
  }
}
```

### Get Component Properties

```javascript
// Get data for a specific component by node ID
figma_get_component({
  nodeId: '123:456'  // Get this from the URL: node-id=123-456
})

// Returns:
{
  "fileKey": "abc123",
  "nodeId": "123:456",
  "component": {
    "id": "123:456",
    "name": "Button",
    "type": "COMPONENT",
    "properties": {
      "variant": {
        "type": "VARIANT",
        "defaultValue": "primary",
        "variantOptions": ["primary", "secondary"]
      },
      "size": {
        "type": "VARIANT",
        "defaultValue": "medium",
        "variantOptions": ["small", "medium", "large"]
      }
    },
    "fills": [...],
    "strokes": [...]
  }
}
```

### Get File Metadata

```javascript
// Get full file structure
figma_get_file_data({
  depth: 2  // How many levels deep to traverse
})

// Get specific nodes only
figma_get_file_data({
  nodeIds: ['123:456', '123:789']
})
```

### Get Styles

```javascript
// Get all color/text/effect styles
figma_get_styles()

// Returns:
{
  "fileKey": "abc123",
  "styles": [
    {
      "key": "abc123",
      "name": "Primary Button",
      "styleType": "FILL",
      "description": "Main CTA button style"
    }
  ],
  "totalStyles": 25
}
```

## Combined Workflow

Use these tools with console debugging for powerful plugin development:

```
Ask Claude Code:
"Navigate to my design system, get all color variables, and check if any console errors occurred"

1. figma_navigate() - Open the file
2. figma_get_variables() - Extract all tokens
3. figma_get_console_logs() - Check for errors

Claude can now debug by comparing:
- What variables exist in Figma
- What your plugin is trying to use
- Any errors that occur
```

## Tool Summary

| Tool | Purpose | Requires Token | Enterprise Only |
|------|---------|----------------|-----------------|
| `figma_get_file_data` | File structure & metadata | ✅ Yes | ❌ No |
| `figma_get_variables` | Design tokens | ✅ Yes | ⚠️ Yes (for variables) |
| `figma_get_component` | Component properties | ✅ Yes | ❌ No |
| `figma_get_styles` | Color/text/effect styles | ✅ Yes | ❌ No |

**Note:** Variables API (`figma_get_variables`) requires an Enterprise Figma plan with `file_variables:read` scope. Other tools work on any plan.

## Permissions & Scopes

When creating your Figma access token, you'll need these scopes:

- **file_content:read** - Required for file_data, components, styles
- **file_variables:read** - Required for variables (Enterprise only)

## Error Messages

### "FIGMA_ACCESS_TOKEN not configured"
You need to set up the token as described above.

### "403 Forbidden" when getting variables
Variables API requires:
1. Enterprise Figma plan
2. Token with `file_variables:read` scope

### "Invalid Figma URL"
Make sure you're passing a valid Figma file URL like:
`https://www.figma.com/design/abc123/My-File`

## Security Notes

**Never commit your Figma access token to git!**

✅ Use `wrangler secret` for production
✅ Use `.dev.vars` for local (add to `.gitignore`)
❌ Don't put tokens in `wrangler.jsonc` if you're committing to public repos

## Next Steps

1. Get your Figma access token
2. Configure it as described above
3. Deploy your own instance
4. Start using the new data extraction tools!

Now you can debug plugins by seeing actual Figma data, not just console logs! 🎉
