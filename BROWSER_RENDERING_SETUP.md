# Browser Rendering API Setup

## Important: Browser Rendering API Must Be Enabled

The Figma Console MCP server requires **Cloudflare Browser Rendering API** to be enabled on your Cloudflare Workers account.

## Current Status

❌ **Browser Rendering API appears to be NOT enabled on your account**

This is why you're seeing initialization errors when trying to use the tools.

## How to Enable Browser Rendering API

### Step 1: Check if it's available

Browser Rendering is a **paid add-on** for Cloudflare Workers:

- **Cost:** $5/month for up to 30 concurrent browsers
- **Included:** 2 million requests/month
- **Requirement:** Workers Paid plan ($5/month minimum)

### Step 2: Enable Browser Rendering

1. Go to your Cloudflare Dashboard
2. Navigate to **Workers & Pages**
3. Select your account
4. Go to **Plans** section
5. Look for **Browser Rendering** add-on
6. Enable it ($5/month)

**Direct link:**
https://dash.cloudflare.com/?to=/:account/workers/plans

### Step 3: Verify in wrangler.jsonc

The configuration is already correct in `wrangler.jsonc`:

```jsonc
{
  "browser": {
    "binding": "BROWSER"
  }
}
```

### Step 4: Redeploy

After enabling Browser Rendering:

```bash
npm run deploy
```

## Alternative: Test Locally First

You can test the MCP server locally without Browser Rendering API:

### Option 1: Use Local Puppeteer

**Not recommended** - The server is designed for Cloudflare Workers and won't work well locally due to the McpAgent pattern.

### Option 2: Wait for Browser Rendering

The tools are designed to work with Cloudflare's Browser Rendering API. Local testing would require significant refactoring.

## Verify Setup

After enabling Browser Rendering and redeploying, test with:

```bash
# In Claude Desktop:
figma_get_status()
```

Should show:
```json
{
  "browser": {
    "running": false,  // Not started yet
    "currentUrl": null
  },
  "initialized": false
}
```

Then try:
```bash
figma_navigate({ url: 'https://www.figma.com' })
```

Should succeed and show:
```json
{
  "status": "navigated",
  "url": "https://www.figma.com",
  "message": "Browser navigated to Figma. Console monitoring is active."
}
```

## Cost Breakdown

**Minimum Monthly Cost:**

- Workers Paid: $5/month (required for Browser Rendering)
- Browser Rendering: $5/month (required for this MCP server)
- **Total: $10/month**

**Included:**
- 30 concurrent browser sessions
- 2 million requests/month
- 10ms CPU time per request

**Additional costs only if you exceed:**
- More than 30 concurrent browsers
- More than 2M requests/month

For development and moderate usage, $10/month should be sufficient.

## Checking Your Current Plan

Run this to check your account details:

```bash
npx wrangler whoami
```

Then check your plan at:
https://dash.cloudflare.com/?to=/:account/workers/plans

## What If I Don't Want to Pay?

Unfortunately, Browser Rendering is **required** for this MCP server to work. There's no free tier.

**Alternatives:**

1. **Use Figma Dev Mode API instead** (free)
   - Limited to reading design data
   - No console log capture
   - No screenshot capability
   - Can still be useful for AI assistants

2. **Build a Chrome Extension** (free but different architecture)
   - Requires user to install extension
   - Runs in their local browser
   - Different integration approach

3. **Wait and test later** when you're ready to enable Browser Rendering

## Next Steps

1. ✅ Enable Browser Rendering API in Cloudflare Dashboard ($5/month)
2. ✅ Redeploy: `npm run deploy`
3. ✅ Test: `figma_navigate({ url: 'https://www.figma.com' })`
4. ✅ Use all 7 tools successfully!

---

**Status Check:** After enabling Browser Rendering, try the test workflow again and it should work!
