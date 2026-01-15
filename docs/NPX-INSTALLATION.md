# NPX Installation Method

After publishing to npm, users can install via `npx` without cloning the repository.

## Claude Desktop Configuration

Add this to your `.claude.json` (or `claude_desktop_config.json` on some systems):

```json
{
  "mcpServers": {
    "figma-console": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "figma-console-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your_figma_access_token_here"
      }
    }
  }
}
```

Replace `your_figma_access_token_here` with your actual Figma access token.

## Benefits

✅ No source code clone required (npm handles distribution)
✅ Always uses the latest version with `@latest`
✅ Automatic updates when new versions are published
✅ Same functionality as Local Mode (uses `dist/local.js`)

**Note:** NPX and Local Git modes have **identical authentication requirements**. Both require:
- `FIGMA_ACCESS_TOKEN` environment variable
- Figma Desktop restart with `--remote-debugging-port=9222`

For true zero-setup with OAuth authentication, use [Remote Mode](SETUP.md#remote-mode-setup-recommended) instead.

## Pinning to a Specific Version

If you prefer version stability:

```json
{
  "mcpServers": {
    "figma-console": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "figma-console-mcp@0.1.0"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your_figma_access_token_here"
      }
    }
  }
}
```

## First-Time Setup

The first time Claude Code runs `npx figma-console-mcp`, it will:
1. Download the package from npm
2. Cache it locally
3. Start the MCP server

Subsequent runs will use the cached version unless you specify `@latest`.

## Comparison to Local Git Installation

| Method | Configuration | Updates | Use Case |
|--------|--------------|---------|----------|
| **NPX** | npm package path | Automatic with `@latest` | Users who want local execution without source code |
| **Local Git** | Source code path | Manual `git pull && npm run build` | Development/testing unreleased features |

**Both methods:**
- ✅ Use the same code (`dist/local.js`)
- ✅ Require `FIGMA_ACCESS_TOKEN` (Personal Access Token)
- ✅ Require Figma Desktop with `--remote-debugging-port=9222`
- ✅ Support Desktop Bridge plugin

**For most users:** [Remote Mode](SETUP.md#remote-mode-setup-recommended) offers zero-setup with OAuth authentication.

## Prerequisites

**Required:**
- Node.js 18+
- Figma Desktop installed
- **Figma Personal Access Token** - [Generate one here](https://www.figma.com/developers/api#access-tokens)
- **Figma Desktop must be restarted** with `--remote-debugging-port=9222`

**Setup Steps:**
1. Get your Figma Personal Access Token (PAT)
2. Quit Figma Desktop completely
3. Relaunch with debug flag:
   - **macOS:** `open -a "Figma" --args --remote-debugging-port=9222`
   - **Windows:** `cmd /c "%LOCALAPPDATA%\Figma\Figma.exe" --remote-debugging-port=9222`
4. Verify http://localhost:9222 is accessible
5. Add `FIGMA_ACCESS_TOKEN` to your MCP config (see above)

**Authentication Note:** This method uses Personal Access Tokens, same as Local Git mode. For automatic OAuth authentication without manual token setup, use [Remote Mode](SETUP.md#remote-mode-setup-recommended).

## Publishing the Package

To enable this installation method, the maintainer needs to:

```bash
# 1. Ensure you're logged into npm
npm login

# 2. Build and publish
npm publish

# 3. Verify publication
npm view figma-console-mcp
```

## Updating the Package

For maintainers:

```bash
# 1. Update version in package.json
npm version patch  # or minor/major

# 2. Build and publish
npm publish

# 3. Users with @latest will get the update automatically
```
