# Figma Desktop Bridge

<video src="https://github.com/user-attachments/assets/5fbb5099-476b-47e0-a61a-95d28299d0db" controls width="100%"></video>

A Figma plugin that connects your AI assistant directly to Figma, giving it live access to your variables, components, and design file while you work. No Enterprise plan required.

> **Part of [figma-console-mcp](../README.md)** - the full MCP server with 103 tools for design extraction, creation, and token sync. Installation, setup, architecture, and troubleshooting are covered there.

## Plugin UI

### v0.2.1 (current) - compact by default, show more when you need it

Stays out of the way until you need a closer look. Tap + to expand the sub-toolbar and switch between Info and Log panels to see what's happening under the hood.

The log panel has been redesigned from the ground up. Every entry shows a human-readable label derived from a leading comment in the code, so the log tells the story of what the AI did rather than listing raw API calls. Errors turn red and are prefixed with `[!]`, unrecognised code blocks show a `<Code>` prefix, and duplicate consecutive calls collapse to a single line with a repeat count. The full session log exports as clean plain text with timestamps - errors flagged, everything else undecorated.

<table>
<tr>
<td valign="top"><strong>Ready</strong><br><img src="./screenshots/v0-2-1/collapsed-light.png" width="240" alt="Collapsed: READY status, Pause, Cloud, expand"></td>
<td valign="top"><strong>Disconnected</strong><br><img src="./screenshots/v0-2-1/disconnected-light.png" width="240" alt="Collapsed: DISCONNECTED status, Resume"></td>
<td valign="top"><strong>Sub-toolbar</strong><br><img src="./screenshots/v0-2-1/sub-toolbar-light.png" width="240" alt="Sub-toolbar expanded: Info and Log tabs"></td>
<td valign="top"><strong>Cloud pairing</strong><br><img src="./screenshots/v0-2-1/cloud-pair-light.png" width="240" alt="Cloud Mode: pairing code input"></td>
</tr>
</table>

<table>
<tr>
<td valign="top"><strong>Info panel (masked)</strong><br><img src="./screenshots/v0-2-1/info-panel-masked-light.png" width="240" alt="Info panel, filename hidden"></td>
<td valign="top"><strong>Info panel (visible)</strong><br><img src="./screenshots/v0-2-1/info-panel-visible-light.png" width="240" alt="Info panel showing file and page name"></td>
<td valign="top"><strong>Cloud pairing help</strong><br><img src="./screenshots/v0-2-1/cloud-pair-help-light.png" width="240" alt="Cloud Mode: pairing help text"></td>
</tr>
</table>

<table>
<tr>
<td valign="top"><strong>Log panel</strong><br><img src="./screenshots/v0-2-1/log-panel-light.png" width="240" alt="Log panel with timestamped intent-labelled entries"></td>
<td valign="top"><strong>Errors filter</strong><br><img src="./screenshots/v0-2-1/log-errors-filter-light.png" width="240" alt="Errors-only filter active, three red error entries"></td>
<td valign="top"><strong>Copy to clipboard</strong><br><img src="./screenshots/v0-2-1/log-copy-success-light.png" width="240" alt="Log copied to clipboard, green success entry"></td>
</tr>
</table>

**Session log exported to text**

<img src="./screenshots/v0-2-1/log-export-text.png" width="500" alt="Session log exported as plain text: timestamps, intent labels, errors flagged with [!]">

---

### v0.2.0 - light and dark mode, text toolbar, full log panel

Introduced light and dark mode, named toolbar actions (Info, Hide log, Errors, Copy log), and the full log panel with version label and multi-server count.

<table>
<tr>
<td valign="top"><strong>Connected</strong><br><img src="./screenshots/v0-2-0/collapsed-light.png" width="220" alt="Connected, light mode"></td>
<td valign="top"><strong>Sub-toolbar</strong><br><img src="./screenshots/v0-2-0/collapsed-in-situ-light.png" width="220" alt="Sub-toolbar visible"></td>
<td valign="top"><strong>Info panel (masked)</strong><br><img src="./screenshots/v0-2-0/info-filename-hidden-light.png" width="220" alt="Info panel, filename masked"></td>
<td valign="top"><strong>Info panel (visible)</strong><br><img src="./screenshots/v0-2-0/info-filename-visible-light.png" width="220" alt="Info panel, filename visible"></td>
</tr>
</table>

<table>
<tr>
<td valign="top"><strong>Log panel</strong><br><img src="./screenshots/v0-2-0/log-panel-light.png" width="220" alt="Log panel, 5 servers"></td>
<td valign="top"><strong>Errors filter</strong><br><img src="./screenshots/v0-2-0/log-errors-filter-light.png" width="220" alt="Error filter active"></td>
<td valign="top"><strong>Audit log exported</strong><br><img src="./screenshots/v0-2-0/audit-export-text.png" width="340" alt="Audit log exported to text editor"></td>
</tr>
</table>

---

### v0.1.0 - initial release

First version: full-width info panel with connection status guide (Off / Scanning / Connected / Error), light/dark toggle, and live log output.

<table>
<tr>
<td valign="top"><strong>Connected</strong><br><img src="./screenshots/v0-1-0/connected-light.png" width="220" alt="v0.1.0 connected state"></td>
<td valign="top"><strong>Info panel</strong><br><img src="./screenshots/v0-1-0/info-panel-light.png" width="220" alt="Info panel with status guide"></td>
<td valign="top"><strong>Info panel (masked)</strong><br><img src="./screenshots/v0-1-0/info-masked-light.png" width="220" alt="Info panel, filename hidden"></td>
<td valign="top"><strong>Log panel</strong><br><img src="./screenshots/v0-1-0/log-panel-light.png" width="220" alt="Log panel"></td>
</tr>
</table>
