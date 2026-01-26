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
    - Runs entirely on localhost via stdio
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
    - Scoped permissions based on token configuration
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
- `localhost` — Local Desktop Bridge communication
- `*.workers.dev` — Remote mode only (HTTPS)

<Check>
**No external dependencies at runtime** — No third-party analytics, CDNs, or external API calls beyond Figma.
</Check>

## Enterprise Considerations

### Compliance

| Standard | Status |
|----------|--------|
| **SOC 2** | Minimal surface (no data storage) |
| **GDPR** | No personal data collection |
| **HIPAA** | Not applicable |

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
