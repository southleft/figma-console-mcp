#!/bin/bash
#
# Launch Figma Desktop with Remote Debugging Enabled
# This script starts Figma with Chrome Remote Debugging Protocol enabled,
# allowing the Figma Console MCP to capture plugin console logs.
#

set -e

# Configuration
DEBUG_PORT="${FIGMA_DEBUG_PORT:-9222}"
FIGMA_APP="/Applications/Figma.app"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Figma Desktop Debug Launcher${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo

# Check if Figma is installed
if [ ! -d "$FIGMA_APP" ]; then
    echo -e "${RED}✗ Figma Desktop not found at: $FIGMA_APP${NC}"
    echo
    echo "Please install Figma Desktop from:"
    echo "  https://www.figma.com/downloads/"
    exit 1
fi

# Check if Figma is already running
if pgrep -x "Figma" > /dev/null; then
    echo -e "${YELLOW}⚠ Figma is already running${NC}"
    echo
    echo "To enable debug mode, you need to quit and relaunch Figma."
    echo
    read -p "Do you want to quit Figma and relaunch with debugging? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}→ Quitting Figma...${NC}"
        osascript -e 'quit app "Figma"'
        sleep 2
    else
        echo -e "${RED}✗ Aborted${NC}"
        exit 1
    fi
fi

# Launch Figma with remote debugging
echo -e "${GREEN}→ Launching Figma Desktop with remote debugging...${NC}"
echo -e "  Debug Port: ${BLUE}$DEBUG_PORT${NC}"
echo

open -a "Figma" --args --remote-debugging-port="$DEBUG_PORT"

# Wait for Figma to start
echo -e "${YELLOW}→ Waiting for Figma to start...${NC}"
sleep 3

# Verify debugging is enabled
echo -e "${YELLOW}→ Verifying debug port...${NC}"
if curl -s "http://localhost:$DEBUG_PORT/json/version" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Debug port accessible at http://localhost:$DEBUG_PORT${NC}"
    echo
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  Figma Desktop is ready for debugging!${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo
    echo -e "${BLUE}Next steps:${NC}"
    echo "  1. Enable Developer VM:"
    echo "     ${YELLOW}Plugins → Development → Use Developer VM${NC}"
    echo
    echo "  2. Run your plugin in Figma"
    echo
    echo "  3. Start the Figma Console MCP:"
    echo "     ${YELLOW}npm run dev:local${NC}"
    echo
    echo "     Or in Claude Desktop, your MCP will automatically connect!"
    echo
else
    echo -e "${RED}✗ Failed to verify debug port${NC}"
    echo
    echo "Figma may still be starting. Try checking manually:"
    echo "  curl http://localhost:$DEBUG_PORT/json/version"
    exit 1
fi
