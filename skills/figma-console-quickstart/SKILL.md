---
name: figma-console-quickstart
description: Spike placeholder. How to connect Figma Console MCP to Figma Desktop and verify the bridge before running write tools.
---

# Figma Console quickstart

1. Call `figma_get_status` and confirm the Desktop Bridge plugin is connected.
2. If not connected, open the Desktop Bridge plugin in Figma Desktop and call `figma_reconnect`.
3. Before creating components, call `figma_search_components` to get fresh node IDs.
