---
title: Security & Privacy
description: Security architecture, data handling, and compliance information
---

Figma Console MCP is designed with security as a priority. The project is **fully open source** (MIT licensed), allowing complete code auditing by security teams.

## Architecture Security

### Deployment Modes

<CardGroup cols={2}>
  <Card title="Local Mode" icon="laptop">
    **Recommended for security-sensitive environments**
    - Runs entirely on localhost via stdio (optional loopback-only HTTP)
    - Zero external network calls
    - All communication stays local
  </Card>
  <Card title="Remote Mode" icon="cloud">
    **For browser-based MCP clients**
    - SSE transport via Cloudflare Workers
    - OAuth tokens handled server-side
    - All traffic encrypted (HTTPS)
  </Card>
</CardGroup>

### Data Handling

| Aspect | Details |
|--------|---------|
| **Data Storage** | None. No design data is persisted or cached to disk. |
| **Telemetry** | None. No analytics, tracking, or usage data collection. |
| **Logging** | Local only. Logs stay on your machine. |
| **Credentials** | Stored in your local MCP config, never transmitted to third parties. |

## Authentication

Figma Console MCP uses **Figma's native authentication**:

<AccordionGroup>
  <Accordion title="Personal Access Tokens (PATs)" icon="key">
    - Generated in Figma account settings
    - Stored locally in your MCP client config
    - Never transmitted except to `api.figma.com`
    - Limited to the scopes you grant: Figma Console MCP needs only read scopes plus comment write ([list](/setup#step-1-get-your-figma-token-2-min)). Note that a PAT can reach every file your account can; Figma doesn't allow narrowing it to specific files.
  </Accordion>
  <Accordion title="OAuth (Remote Mode)" icon="right-to-bracket">
    - Uses Figma's official OAuth 2.0 flow
    - Tokens managed via Figma's authorization servers
    - No custom credential handling
  </Accordion>
</AccordionGroup>

## Code Execution (`figma_execute`)

The `figma_execute` tool runs JavaScript in Figma's plugin context:

<Warning>
Code runs in Figma's **plugin sandbox**, not your system. It cannot access your filesystem, network, or other applications.
</Warning>

**Sandbox limitations:**
- No filesystem access
- No network access outside Figma's plugin APIs
- Cannot access other browser tabs or system resources
- Can only modify the currently open Figma file

**Mitigations:**
- Desktop Bridge must be manually started
- All execution is user-initiated
- Changes covered by Figma's version history

## Data Access Scope

<Tabs>
  <Tab title="Can Access">
    | Data Type | Access |
    |-----------|--------|
    | Variables/Tokens | Read |
    | Components | Read |
    | Styles | Read |
    | File Structure | Read |
    | Console Logs | Read |
    | Design Modifications | Write (via Desktop Bridge) |
  </Tab>
  <Tab title="Cannot Access">
    - Your filesystem
    - Other applications
    - Browser data
    - Network resources outside Figma
    - Other Figma files (only current file)
  </Tab>
</Tabs>

## Network Security

All network communication is limited to:
- `api.figma.com` — Figma's official REST API (HTTPS)
- `localhost:9223–9232` — WebSocket Bridge (Desktop Bridge Plugin communication, port range for multi-instance support)
- `127.0.0.1:<FIGMA_MCP_HTTP_PORT>` — Optional local MCP over HTTP, only when you set that variable
- `*.workers.dev` — Remote mode only (HTTPS)

### WebSocket Bridge Security
- **Localhost-only binding** — The WebSocket server binds to `localhost` only, not accessible from external networks
- **No authentication required** — Since it's localhost-only, the attack surface is limited to local processes
- **Request/response correlation** — Each command uses a unique correlation ID to prevent response confusion
- **Per-file isolation** — Multiple connected Figma files maintain independent state (selection, changes, console logs)

### Optional HTTP Endpoint (Local Mode)
- **Off by default** — Only `FIGMA_MCP_HTTP_PORT` turns on MCP over Streamable HTTP
- **Loopback only** — Binds `127.0.0.1`; requests must name a localhost `Host` (blocks DNS rebinding) and may not come from a non-localhost browser `Origin` (blocks web pages)
- **Optional bearer token** — `FIGMA_MCP_HTTP_TOKEN` requires `Authorization: Bearer <token>`, compared in constant time

<Check>
**No external dependencies at runtime** — No third-party analytics, CDNs, or external API calls beyond Figma.
</Check>

## Vendor Trust & Compliance

### Vendor Identity

Figma Console MCP is built and maintained by **Southleft, LLC**. For security or legal inquiries that require a direct contact (vendor questionnaires, DPAs, procurement reviews), email **info@southleft.com**. For vulnerability reports, prefer the [private security advisory](https://github.com/southleft/figma-console-mcp/security/advisories/new) flow.

### Formal Attestations

Southleft does **not currently hold SOC 2, ISO 27001, or equivalent third-party attestations** for Figma Console MCP. The product is intentionally designed so that — particularly in Local mode — there is no vendor-side data processing that would require such attestations:

- No Southleft-hosted service in the data path
- No data persistence, telemetry, or analytics
- No accounts, no user database, no logs leaving your machine

The complete source is MIT-licensed and available for audit on [GitHub](https://github.com/southleft/figma-console-mcp). Releases are published to npm as [`figma-console-mcp`](https://www.npmjs.com/package/figma-console-mcp).

### Data Processing & DPA

| Mode | Southleft's Role | DPA Applicability |
|------|------------------|-------------------|
| **Local Mode** | Not a data processor. Southleft has no access to design data, credentials, or user information. All traffic is between your machine and Figma. | A DPA is not applicable — Southleft does not receive or process customer data. |
| **Remote Mode** | Operates the Cloudflare Worker that brokers OAuth and proxies requests to Figma. No design data is persisted. | A DPA can be provided on request. Email info@southleft.com. |

### Sub-processors

| Mode | Sub-processors |
|------|----------------|
| **Local Mode** | None. |
| **Remote Mode** | Cloudflare (Workers hosting, traffic transit), Figma (authentication and design API). |

Figma is always in scope as the upstream platform regardless of mode, since Figma Console MCP is a client to the Figma API.

### Compliance Posture

| Standard | Status |
|----------|--------|
| **SOC 2 / ISO 27001** | Not currently attested. Minimal surface in Local mode (no vendor-side data storage or processing). |
| **GDPR** | No personal data collected or processed by Southleft. Customers remain controllers of any data they choose to send to Figma via the tool. |
| **HIPAA** | Not applicable. The product is not designed for or marketed to handle PHI. |

## Enterprise Considerations

### Recommended Enterprise Setup

<Steps>
  <Step title="Use Local Mode">
    Deploy with stdio transport for zero external network calls
  </Step>
  <Step title="Self-Host (Optional)">
    Run your own Cloudflare Worker instance. See [Self-Hosting Guide](/self-hosting).
  </Step>
  <Step title="Allowlist Figma API">
    Only `api.figma.com` needs network access
  </Step>
  <Step title="Audit Source Code">
    Complete source available on [GitHub](https://github.com/southleft/figma-console-mcp)
  </Step>
</Steps>

## Vulnerability Reporting

To report a security vulnerability:

1. Open a [private security advisory](https://github.com/southleft/figma-console-mcp/security/advisories/new) on GitHub
2. Include steps to reproduce and potential impact
3. We aim to respond within 48 hours

<Note>
Please use GitHub's private security advisory feature rather than public issues.
</Note>

## Security Checklist

<CheckList>
- Open source and auditable (MIT license)
- No data persistence or storage
- No telemetry or analytics
- Platform-native authentication (Figma OAuth/PATs)
- Code execution sandboxed in Figma plugin environment
- Local-only deployment option available
- All network traffic encrypted (HTTPS)
- No third-party runtime dependencies
</CheckList>

## Questions?

For security inquiries, open a [GitHub Discussion](https://github.com/southleft/figma-console-mcp/discussions) or use the [private security advisory](https://github.com/southleft/figma-console-mcp/security/advisories/new) feature for sensitive matters.
