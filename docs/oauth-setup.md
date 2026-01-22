---
title: "OAuth Setup"
description: "Configure OAuth authentication for the Figma Console MCP server, enabling automatic browser-based authentication."
---

# OAuth Setup Guide

This guide explains how to set up OAuth authentication for the Figma Console MCP server, allowing users to authenticate with their own Figma accounts.

## Overview

OAuth authentication enables:
- ✅ **Per-user authentication** - Each user authenticates with their own Figma account
- ✅ **Secure token storage** - Tokens stored securely in Cloudflare Workers KV (encrypted at rest)
- ✅ **No credential sharing** - No need to share personal access tokens
- ✅ **Browser-based flow** - Seamless authentication experience
- ✅ **Automatic token management** - Tokens managed transparently

## Architecture

```
User → Claude Code → Remote MCP Server
                    ↓
        Browser OAuth Flow → Figma Authorization
                    ↓
        Token stored in Workers KV (per-session)
                    ↓
        All API calls use user's personal token
```

---

## For Server Administrators

### Step 1: Create a Figma OAuth App

1. Go to [Figma Developers](https://www.figma.com/developers)
2. Click **"My Apps"** → **"Create new app"**
3. Fill in app details:
   - **App name**: `Figma Console MCP` (or your preferred name)
   - **App description**: `AI-powered Figma debugging and design system tools`
   - **App website**: `https://github.com/southleft/figma-console-mcp`

4. Add **Redirect URL**:
   ```
   https://figma-console-mcp.southleft.com/oauth/callback
   ```

   Replace `figma-console-mcp.southleft.com` with your actual deployment URL.

5. **Save** and copy:
   - ✅ **Client ID** (public)
   - ✅ **Client Secret** (private - only shown once!)

### Step 2: Configure Cloudflare Secrets

Set the OAuth credentials as Cloudflare Workers secrets:

```bash
# Set Client ID
wrangler secret put FIGMA_OAUTH_CLIENT_ID
# Paste your Client ID when prompted

# Set Client Secret
wrangler secret put FIGMA_OAUTH_CLIENT_SECRET
# Paste your Client Secret when prompted
```

**Important**: Never commit these secrets to version control!

### Step 3: Deploy Your MCP Server

```bash
npm run deploy
```

Or via Cloudflare Dashboard:
1. Go to **Workers & Pages** → **figma-console-mcp**
2. Navigate to **Settings** → **Variables**
3. Add encrypted environment variables:
   - `FIGMA_OAUTH_CLIENT_ID`
   - `FIGMA_OAUTH_CLIENT_SECRET`

### Step 4: Verify Configuration

Check your deployment's health endpoint:

```bash
curl https://figma-console-mcp.southleft.com/health
```

Response should include:
```json
{
  "status": "healthy",
  "oauth_configured": true,
  "endpoints": ["/oauth/authorize", "/oauth/callback", ...]
}
```

---

## For End Users

### Installation

Users simply connect to your remote MCP server - no OAuth setup needed on their end!

```bash
claude mcp add --transport sse figma-console https://figma-console-mcp.southleft.com/sse
```

### Authentication Flow

1. **First API Call**: When a user calls a Figma API tool for the first time, they'll receive an error with an authentication URL

2. **Browser Opens**: Their browser automatically opens the Figma OAuth page

3. **User Authorizes**: User logs in with Figma and authorizes the app

4. **Success**: Browser shows success message and closes automatically

5. **All Set**: Subsequent API calls work seamlessly with their personal token

### Example User Experience

```
User: "Get variables from my Figma file"

Claude: Authentication required. Opening browser...
        [Browser opens → User logs in → Success!]

Claude: ✅ Retrieved 247 design variables from your file
```

---

## Security Considerations

### Token Storage
- Tokens stored in Cloudflare Workers KV (encrypted at rest)
- Scoped per-session (not shared between users)
- Automatically cleaned up when tokens expire (90-day TTL)

### OAuth Scopes
Currently requesting:
- `file_content:read` - Read access to Figma file content
- `library_content:read` - Read access to library/component content
- `file_variables:read` - Read access to design variables (for Enterprise accounts)

### Token Refresh
- ✅ Automatic token refresh implemented
- Tokens are automatically refreshed when expired using the refresh token
- Users only need to re-authenticate if refresh fails or after extended inactivity

### Best Practices
✅ **DO**:
- Keep Client Secret confidential
- Use HTTPS for all OAuth callbacks
- Rotate secrets periodically
- Monitor OAuth usage via Figma dashboard

❌ **DON'T**:
- Commit secrets to version control
- Share Client Secret publicly
- Use OAuth for untrusted deployments

---

## Troubleshooting

### "OAuth not configured" Error

**Symptom**: Users see `OAuth not configured` error

**Solution**: Ensure `FIGMA_OAUTH_CLIENT_ID` and `FIGMA_OAUTH_CLIENT_SECRET` are set in Cloudflare Workers secrets

```bash
# Check if secrets are set
wrangler secret list

# Set missing secrets
wrangler secret put FIGMA_OAUTH_CLIENT_ID
```

### "Invalid redirect_uri" Error

**Symptom**: OAuth callback fails with redirect URI mismatch

**Solution**: Ensure redirect URL in Figma app settings exactly matches your deployment URL:
```
https://your-domain.com/oauth/callback
```

### Token Expired

**Symptom**: Users see "Token expired. Please re-authenticate."

**Solution**: User needs to call any Figma API tool to trigger re-authentication flow

### Debugging OAuth Flow

Enable debug logging:
```bash
# Check Cloudflare Workers logs
wrangler tail
```

---

## Migration from Personal Access Tokens

If you're currently using `FIGMA_ACCESS_TOKEN` (deprecated):

1. Set up OAuth as described above
2. Keep `FIGMA_ACCESS_TOKEN` for backward compatibility
3. New users will automatically use OAuth
4. Existing token-based users can continue until tokens expire
5. Eventually remove `FIGMA_ACCESS_TOKEN` when all users migrated

---

## OAuth App Settings

### Scopes Requested
- `file_content:read` - Read Figma file content
- `library_content:read` - Read library/component data
- `file_variables:read` - Read design variables (Enterprise)

### Webhook Configuration (Optional)
Future enhancement: Set up webhooks for token revocation notifications

---

## Support

- **Documentation**: https://github.com/southleft/figma-console-mcp
- **Issues**: https://github.com/southleft/figma-console-mcp/issues
- **Figma OAuth Docs**: https://www.figma.com/developers/api#oauth2
