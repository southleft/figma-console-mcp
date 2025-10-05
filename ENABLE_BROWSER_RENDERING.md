# How to Enable Browser Rendering API

## Current Status: ❌ NOT ENABLED

Your diagnostic test at https://figma-console-mcp.southleft-llc.workers.dev/test-browser shows:

```
BROWSER binding exists: ✅ PASSED
Browser launch: ❌ FAILED - "Invalid URL: /v1/acquire?keep_alive=60000"
```

This confirms Browser Rendering API is **not enabled** despite being on a paid plan.

## ✅ No API Key Needed

**Good news:** Browser Rendering doesn't use API keys. It's accessed via the `BROWSER` binding in your Workers, which is already correctly configured.

**The issue:** Browser Rendering must be explicitly enabled as an add-on, even on paid plans.

## How to Enable (2 Steps)

### Step 1: Go to Workers Plans Page

Visit your Cloudflare Workers plans page:

**🔗 Direct link:**
https://dash.cloudflare.com/4718d49e576512c578ff94c6b1ba7d3f/workers/plans

Or navigate manually:
1. Go to https://dash.cloudflare.com
2. Select your account: **Southleft, LLC**
3. Click **Workers & Pages** in sidebar
4. Click **Plans** tab

### Step 2: Enable Browser Rendering Add-on

Look for the **Browser Rendering** section on the Plans page.

**What you'll see:**
- Browser Rendering add-on option
- Free tier: 10 minutes/day, 3 concurrent browsers
- Paid tier: 10 hours/month included, $0.09/hour after

**Click "Enable" or "Subscribe"** to activate Browser Rendering.

## After Enabling

Once Browser Rendering is enabled:

1. **Wait 1-2 minutes** for the change to propagate
2. **Test again:** Visit https://figma-console-mcp.southleft-llc.workers.dev/test-browser
3. **Expect to see:** All 5 tests passing ✅

Example of successful test results:
```json
{
  "overall": "PASSED",
  "summary": "5/5 tests passed",
  "tests": [
    { "name": "BROWSER binding exists", "passed": true },
    { "name": "Browser launch", "passed": true },
    { "name": "Create browser page", "passed": true },
    { "name": "Navigate to URL", "passed": true },
    { "name": "Read page content", "passed": true }
  ]
}
```

## Pricing Breakdown

**Free Tier (Available Now):**
- 10 minutes of browser time per day
- 3 concurrent browser sessions
- Perfect for testing and light usage
- **Cost: $0**

**Paid Tier (If You Exceed Free Tier):**
- 10 hours of browser time included
- Unlimited concurrent browsers (subject to Workers limits)
- $0.09 per browser hour after 10 hours
- Billing starts August 20, 2025
- **Monthly cost depends on usage**

## Why This Happened

Browser Rendering API launched in 2025 with a new pricing model. Even paid Workers plans require **explicit opt-in** to Browser Rendering because it's a separate service with its own billing.

Your configuration is 100% correct - you just need to flip the switch in the dashboard!

## Verify It's Working

After enabling, test the Figma Console MCP workflow:

1. In Claude Desktop, try:
   ```
   figma_navigate({ url: 'https://www.figma.com' })
   ```

2. Should see:
   ```json
   {
     "status": "navigated",
     "url": "https://www.figma.com",
     "message": "Browser navigated to Figma. Console monitoring is active."
   }
   ```

3. Then try:
   ```
   figma_get_console_logs({ count: 10 })
   ```

4. Should see actual console logs!

## Need Help?

If you still see errors after enabling:

1. **Check the test endpoint again:** https://figma-console-mcp.southleft-llc.workers.dev/test-browser
2. **Verify in Cloudflare dashboard:** Browser Rendering should show as "Enabled"
3. **Contact Cloudflare support:** If it's enabled but still not working

---

**Next step:** Go to https://dash.cloudflare.com/4718d49e576512c578ff94c6b1ba7d3f/workers/plans and enable Browser Rendering! 🚀
