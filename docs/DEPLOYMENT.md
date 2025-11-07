# Deployment Guide

This document tracks deployment procedures for both Local and Remote (Cloudflare) modes.

---

## Deployment Targets

### 🏠 Local Mode
- **Build output:** `dist/local.js`
- **Deployment:** Users install locally via npm or git clone
- **Distribution:** Via git repository and npm package
- **Auto-updates:** No (users must pull/reinstall)

### ☁️ Remote Mode (Cloudflare Workers)
- **Build output:** Cloudflare Workers deployment
- **URL:** https://figma-console-mcp.southleft-llc.workers.dev
- **Account:** Southleft, LLC (`4718d49e576512c578ff94c6b1ba7d3f`)
- **Auto-updates:** Yes (deploy updates to live URL)

---

## When to Deploy to Cloudflare

**ALWAYS deploy to Cloudflare when:**
- ✅ Tool descriptions change (affects Remote Mode UX)
- ✅ Tool defaults change (verbosity, depth, parameters)
- ✅ REST API integration changes
- ✅ Error messages or user-facing text updates
- ✅ Performance improvements in shared code
- ✅ Bug fixes in core functionality

**NO need to deploy to Cloudflare for:**
- ❌ Desktop Bridge plugin changes (Local Mode only)
- ❌ Documentation-only updates (README, guides)
- ❌ Local Mode specific features
- ❌ Development tooling changes

---

## Deployment Checklist

### Before Deployment

- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles without errors
- [ ] Changes committed to git
- [ ] Version bumped if needed (see Versioning section)

### Cloudflare Deployment Steps

**1. Build Cloudflare Worker:**
```bash
npm run build:cloudflare
```

**2. Deploy to Cloudflare:**
```bash
npm run deploy
```

**3. Verify deployment:**
- Check output for successful deployment message
- Note the Version ID
- Test the deployed URL: https://figma-console-mcp.southleft-llc.workers.dev

**4. Test Remote Mode:**
```bash
# Test with curl or Postman
curl https://figma-console-mcp.southleft-llc.workers.dev/health
```

**5. Update deployment tracking:**
Add entry to deployment log below

### Local Build (for npm/git distribution)

**1. Build local version:**
```bash
npm run build:local
```

**2. Verify build:**
```bash
ls -la dist/local.js
```

**3. Test locally:**
```bash
node dist/local.js --help
```

---

## Recent Deployments

### 2025-10-31 - Tool Description Improvements
**Version ID:** `72828490-8250-45d9-b292-65863ab93038`
**Commit:** `d2580d9`
**Changes:**
- Improved `figma_get_component` tool description to mention Desktop Bridge requirement
- Optimized `figma_get_file_data` defaults (depth=1, verbosity=summary)
- Added actionable error messages when REST API returns missing descriptions
- Enhanced Claude Desktop UX for both Local and Remote modes

**Impact:** Remote Mode users will see better guidance on tool usage and clearer error messages.

---

## Versioning Strategy

We follow semantic versioning: `MAJOR.MINOR.PATCH`

**When to bump versions:**

### PATCH (0.1.X → 0.1.Y)
- Bug fixes
- Documentation updates
- Minor performance improvements
- No breaking changes

### MINOR (0.X.0 → 0.Y.0)
- New features (tools, capabilities)
- Backward-compatible changes
- New tool parameters (optional)
- Significant performance improvements

### MAJOR (X.0.0 → Y.0.0)
- Breaking API changes
- Removed tools or features
- Changed tool signatures (required params)
- Major architectural changes

**Current version:** `0.1.0`

---

## Rollback Procedure

If a deployment introduces issues:

**1. Check deployment history in Cloudflare:**
```bash
wrangler deployments list
```

**2. Rollback to previous version:**
```bash
wrangler rollback [VERSION_ID]
```

**3. Investigate issue locally:**
```bash
git log --oneline -10
git diff [PREVIOUS_COMMIT] [CURRENT_COMMIT]
```

**4. Fix issue and redeploy**

---

## Environment Variables

### Cloudflare (Remote Mode)
Set in Cloudflare Dashboard or wrangler.jsonc:
- `FIGMA_ACCESS_TOKEN` - Required for Figma REST API access

### Local Mode
Set in Claude Desktop config or environment:
- `FIGMA_ACCESS_TOKEN` - Required for Figma REST API access
- `FIGMA_MODE` - Set to "local" to enable Desktop features

---

## Deployment URL

**Production:** https://figma-console-mcp.southleft-llc.workers.dev

**SSE Endpoint:** https://figma-console-mcp.southleft.com/sse

**Health Check:** https://figma-console-mcp.southleft-llc.workers.dev/health

---

## Common Issues

### "Account ID not found"
**Solution:** Ensure `account_id` is set in wrangler.jsonc (already configured)

### "BROWSER binding not found"
**Solution:** Browser Rendering API must be enabled on Cloudflare account

### "Build fails"
**Solution:** Run `npm install` to ensure dependencies are up to date

### "Deployment succeeds but changes not visible"
**Possible causes:**
- Browser cache (hard refresh)
- Cloudflare cache (wait 60 seconds)
- Wrong deployment URL being tested

---

## Testing After Deployment

### Remote Mode Test Checklist

**1. Health check:**
```bash
curl https://figma-console-mcp.southleft-llc.workers.dev/health
```

**2. Tool availability:**
Connect Claude Desktop to remote URL and test:
- `figma_get_file_data` with summary verbosity
- `figma_get_component` with a test component
- Verify tool descriptions are clear
- Check error messages are helpful

**3. Performance:**
- Tool response time < 3 seconds
- No timeout errors
- Proper error handling

### Local Mode Test Checklist

**1. Build verification:**
```bash
node dist/local.js
# Should start MCP server without errors
```

**2. Desktop Bridge compatibility:**
- Launch Figma Desktop with debug port
- Run Desktop Bridge plugin
- Test `figma_get_component` returns descriptions
- Test `figma_get_variables` without Enterprise plan

**3. Claude Desktop integration:**
```json
{
  "mcpServers": {
    "figma-local": {
      "command": "node",
      "args": ["/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "...",
        "FIGMA_MODE": "local"
      }
    }
  }
}
```

---

## Monitoring

**Cloudflare Dashboard:**
- Monitor request counts
- Check error rates
- Review execution time
- Browser Rendering API usage

**Logs:**
```bash
wrangler tail
```

---

## Future Improvements

- [ ] Automated deployment on git push (GitHub Actions)
- [ ] Staging environment for testing
- [ ] Automated rollback on error rate spike
- [ ] Version tracking in deployment metadata
- [ ] Deployment notifications (Slack/Discord)

---

## Support

For deployment issues:
1. Check Cloudflare Workers logs
2. Review this deployment guide
3. Consult [DEPLOYMENT_COMPARISON.md](DEPLOYMENT_COMPARISON.md) for mode-specific details
4. Create GitHub issue with deployment logs
