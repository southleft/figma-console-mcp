---
title: "Self-Hosting"
description: "Deploy your own instance of Figma Console MCP on Cloudflare Workers for enterprise requirements or custom configurations."
---

# Self-Hosting Guide

Deploy your own instance of Figma Console MCP on Cloudflare Workers.

## Why Self-Host?

**Use the public server** (`https://figma-console-mcp.southleft.com`) for most use cases.

**Self-host when:**
- You need guaranteed uptime/SLA
- You want custom rate limits
- You need enterprise security/compliance
- You want to modify the code
- You're processing sensitive design data

## Quick Deploy

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/southleft/figma-console-mcp)

Or via CLI:

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
npm run deploy
```

## Prerequisites

1. **Cloudflare Account** (free or paid)
   - Sign up at https://dash.cloudflare.com/sign-up

2. **Wrangler CLI** (installed automatically via `npm install`)
   - Cloudflare's deployment tool

3. **Browser Rendering API Access**
   - **Free tier:** 10 minutes/day, 3 concurrent browsers
   - **Paid tier:** 10 hours/month, then $0.09/browser hour
   - Automatically available on Workers

## Step-by-Step Deployment

### 1. Clone and Install

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
```

### 2. Authenticate Wrangler

```bash
npx wrangler login
```

This opens a browser to authenticate with Cloudflare.

### 3. Configure Your Deployment

Edit `wrangler.jsonc` (optional):

```jsonc
{
  "name": "figma-console-mcp",  // Change to your preferred name
  "main": "dist/index.js",
  "compatibility_date": "2024-01-01",
  "browser": {
    "binding": "BROWSER"
  },
  "limits": {
    "cpu_ms": 30000  // Adjust if needed
  }
}
```

### 4. Set Environment Variables

#### Required: Figma Access Token

```bash
npx wrangler secret put FIGMA_ACCESS_TOKEN
# Paste your token when prompted
```

Get your token at: https://www.figma.com/developers/api#access-tokens

#### Optional: Custom Configuration

```bash
# Log level (default: info)
npx wrangler secret put LOG_LEVEL
# Enter: trace, debug, info, warn, error, or fatal

# Browser timeout (default: 120000ms)
npx wrangler secret put BROWSER_TIMEOUT
# Enter milliseconds
```

### 5. Build and Deploy

```bash
# Build for production
npm run build:cloudflare

# Deploy to Cloudflare Workers
npm run deploy
```

Expected output:

```
( Built successfully!
  Uploading...
( Deployment complete!

https://figma-console-mcp.<your-subdomain>.workers.dev
```

### 6. Test Your Deployment

```bash
# Health check
curl https://figma-console-mcp.<your-subdomain>.workers.dev/health

# Should return:
{
  "status": "healthy",
  "service": "Figma Console MCP",
  "version": "0.1.0",
  "endpoints": ["/sse", "/mcp", "/test-browser"]
}
```

### 7. Configure Your MCP Client

Update your AI client config to use your instance:

**Claude Desktop:**

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["mcp-remote", "https://figma-console-mcp.<your-subdomain>.workers.dev/sse"]
    }
  }
}
```

**Important:** Replace `<your-subdomain>` with your actual Cloudflare Workers subdomain.

---

## Custom Domain (Optional)

### 1. Add Custom Domain in Cloudflare Dashboard

1. Go to Workers & Pages � figma-console-mcp
2. Click "Custom Domains"
3. Click "Add Custom Domain"
4. Enter your domain (e.g., `mcp.example.com`)
5. Cloudflare handles DNS automatically

### 2. Update MCP Client Config

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.example.com/sse"]
    }
  }
}
```

---

## Environment Configuration

### All Available Secrets

Set these via `npx wrangler secret put SECRET_NAME`:

| Secret | Required | Default | Description |
|--------|----------|---------|-------------|
| `FIGMA_ACCESS_TOKEN` | Yes | - | Your Figma API token |
| `LOG_LEVEL` | No | `info` | Logging verbosity (trace/debug/info/warn/error/fatal) |
| `BROWSER_TIMEOUT` | No | `120000` | Browser operation timeout (ms) |
| `MAX_CONSOLE_LOGS` | No | `1000` | Max console logs to buffer |

### Setting Secrets

```bash
# Interactive (recommended)
npx wrangler secret put FIGMA_ACCESS_TOKEN

# Via file (less secure)
echo "figd_your_token" | npx wrangler secret put FIGMA_ACCESS_TOKEN
```

### Viewing Secrets

```bash
# List all secrets (values hidden)
npx wrangler secret list
```

### Deleting Secrets

```bash
npx wrangler secret delete SECRET_NAME
```

---

## Monitoring & Logs

### Real-Time Logs

```bash
# Tail production logs
npx wrangler tail

# Filter for errors
npx wrangler tail --format pretty | grep ERROR

# Filter by level
npx wrangler tail --status error
```

### Analytics

View analytics in Cloudflare Dashboard:
1. Go to Workers & Pages � figma-console-mcp
2. Click "Analytics" tab
3. See:
   - Request count
   - Error rate
   - CPU time used
   - Duration percentiles

---

## Costs

### Browser Rendering API

- **Free Tier:**
  - 10 minutes/day
  - 3 concurrent browsers
  - Perfect for personal use

- **Paid Tier:**
  - 10 hours/month included
  - Then $0.09/browser hour
  - Auto-scales

### Workers

- **Free Tier:**
  - 100,000 requests/day
  - 10ms CPU time per request
  - More than enough for most users

- **Paid Tier ($5/month):**
  - 10 million requests/month
  - 50ms CPU time per request
  - Better for teams

**Estimated monthly cost for typical usage:**
- Solo developer: **$0** (free tier)
- Small team (5 people): **$5-15/month**
- Medium team (20 people): **$20-50/month**

---

## Updating Your Deployment

### Update Code

```bash
cd figma-console-mcp
git pull origin main
npm install
npm run build:cloudflare
npm run deploy
```

### Rollback to Previous Version

```bash
npx wrangler rollback
```

### View Deployment History

```bash
npx wrangler deployments list
```

---

## Security Best Practices

### 1. Protect Your Secrets

-  Use `wrangler secret put` (encrypted at rest)
- L Don't commit secrets to git
- L Don't put secrets in `wrangler.jsonc`

### 2. Token Permissions

- Use a dedicated Figma access token for the MCP
- Scope token to minimum required permissions
- Rotate tokens periodically

### 3. Rate Limiting (Advanced)

For rate limiting, use Cloudflare's built-in Rate Limiting rules:

1. Go to Cloudflare Dashboard → **Security** → **WAF** → **Rate limiting rules**
2. Create a rule to limit requests per IP (e.g., 100 requests/minute)
3. Apply to your worker's route

Alternatively, use Cloudflare's **Rate Limiting binding** for programmatic control - see [Cloudflare Rate Limiting docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

### 4. Access Control (Advanced)

Add authentication:

```typescript
// Require API key
const authKey = request.headers.get('X-API-Key');
if (authKey !== env.API_KEY) {
  return new Response('Unauthorized', { status: 401 });
}
```

Then set the API key:

```bash
npx wrangler secret put API_KEY
```

---

## Troubleshooting

### Deployment Fails

**Error:** "Authentication required"

```bash
npx wrangler login
```

**Error:** "Browser Rendering not enabled"

1. Go to Cloudflare Dashboard
2. Workers & Pages � Settings
3. Enable Browser Rendering
4. Try deploying again

### Browser Launch Fails

**Check logs:**

```bash
npx wrangler tail --format pretty
```

**Common issues:**
- Browser Rendering API quota exceeded � Upgrade plan
- Timeout too short � Increase `BROWSER_TIMEOUT`
- Cold start delay � Normal, wait and retry

### High Costs

**Check usage:**

```bash
npx wrangler metrics --worker figma-console-mcp
```

**Reduce costs:**
- Implement request caching
- Add rate limiting
- Reduce browser timeout
- Close browser sessions faster

---

## Advanced Configuration

### Custom Worker Name

```jsonc
// wrangler.jsonc
{
  "name": "my-custom-mcp",  // Change this
  "main": "dist/index.js",
  ...
}
```

### Multiple Environments

**Production:**

```bash
npx wrangler deploy --env production
```

**Staging:**

```bash
npx wrangler deploy --env staging
```

**Configure in `wrangler.jsonc`:**

```jsonc
{
  "name": "figma-console-mcp",
  "env": {
    "production": {
      "name": "figma-console-mcp-prod",
      "vars": {
        "ENVIRONMENT": "production"
      }
    },
    "staging": {
      "name": "figma-console-mcp-staging",
      "vars": {
        "ENVIRONMENT": "staging"
      }
    }
  }
}
```

### Durable Objects (Persistent Sessions)

For multi-user sessions, enable Durable Objects:

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "SESSIONS",
        "class_name": "BrowserSession",
        "script_name": "figma-console-mcp"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["BrowserSession"]
    }
  ]
}
```

---

## CI/CD Integration

### GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Cloudflare Workers

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '18'

      - run: npm ci
      - run: npm run build:cloudflare

      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Set secrets in GitHub:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

---

## Support

For self-hosting issues:

- =� [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- =� [GitHub Discussions](https://github.com/southleft/figma-console-mcp/discussions)
- = [Report Issues](https://github.com/southleft/figma-console-mcp/issues)

For Cloudflare-specific issues:
- [Cloudflare Community](https://community.cloudflare.com/)
- [Cloudflare Support](https://support.cloudflare.com/)
