# Phase 5 Testing Instructions - Fixed Implementation

## What Was Fixed

### 1. Authentication Configuration
- ✅ Confirmed our MCP uses the correct `X-Figma-Token` header (same as Figma-Context-MCP)
- ✅ The local.js properly reads from `process.env.FIGMA_ACCESS_TOKEN`
- ✅ Claude Desktop config correctly passes the token through environment

### 2. Debug Logging Added
Added detailed logging to track token usage:
- `src/local.ts`: Logs when token is initialized from environment
- `src/core/figma-api.ts`: Logs every API request with token preview

### 3. Build System Verified
- Local build (`npm run build:local`) compiles TypeScript correctly
- Compiled `dist/local.js` properly reads environment variables
- Claude Desktop uses the compiled version with the token

## How to Test the Fixed Implementation

### Step 1: Rebuild with Debug Logging
```bash
npm run build:local
```

### Step 2: Restart Claude Desktop
1. Quit Claude Desktop completely (Cmd+Q on macOS)
2. Start Claude Desktop again
3. The MCP will automatically load with your configuration

### Step 3: Test in a NEW Claude Desktop Chat
Start a fresh chat and try these commands:

#### Test 1: Variables API (Expected: 403 then fallback)
```
I have a Figma file at:
https://www.figma.com/design/y83n4o9LOGs74oAoguFcGS/Altitude-Design-System

Can you extract the design variables from this file?
```

**Expected Behavior:**
1. Tool will attempt Variables API → Get 403 (Enterprise required)
2. Automatically fall back to style extraction
3. Return extracted colors, typography, spacing
4. Source will show as "style_extraction"

#### Test 2: Direct File Data Request
```
Can you get the file structure from:
https://www.figma.com/design/EJhOnWMmRvZnogULvkwZbB/Altitude-Design-System
```

**Expected Behavior:**
- Should return file structure with components, frames, and pages

## Troubleshooting

### If Still Getting 404 Errors
The file key `EJhOnWMmRvZnogULvkwZbB` returns 404, which means:
1. The file doesn't exist at that key
2. The file is private and requires specific permissions
3. The URL structure has changed

**Solution:** Try with a known public file:
```
https://www.figma.com/community/file/1035203688168086460
```

### If Getting "NO TOKEN" in Logs
Check Claude Desktop config has the token:
```json
{
  "mcpServers": {
    "Figma Console": {
      "command": "node",
      "args": ["/Users/tjbackup/Sites/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your_actual_token_here"
      }
    }
  }
}
```

### Viewing Debug Logs
To see the debug output with token information:
```bash
# Run the MCP manually with logging
FIGMA_ACCESS_TOKEN="your_token" LOG_LEVEL=info node dist/local.js
```

Then send it test commands via stdin.

## Key Differences from Previous Implementation

1. **Correct Entry Point**: Using `dist/local.js` (not wrangler/cloudflare mode)
2. **Token from Environment**: Reads from `process.env.FIGMA_ACCESS_TOKEN`
3. **Proper Headers**: Uses `X-Figma-Token` header (not Bearer)
4. **Debug Logging**: Now logs token usage for verification

## Status Summary

✅ **Fixed:**
- API authentication headers match Figma-Context-MCP
- Local mode properly reads environment token
- Debug logging shows token is being used

⚠️ **Known Issues:**
- The Altitude Design System file (EJhOnWMmRvZnogULvkwZbB) returns 404
- This might be a file permission issue or incorrect file key
- Community files may need different handling

## Next Steps

1. Test with your actual Figma files that you know are accessible
2. If 404 persists, verify the file URL is correct and accessible
3. Check debug logs to confirm token is being passed correctly