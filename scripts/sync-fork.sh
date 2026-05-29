#!/usr/bin/env bash
# Sync upstream (southleft/figma-console-mcp) into fork branch.
# Run from repo root. Requires: git remote 'upstream' pointing to southleft repo.
set -e

echo "=== Fetching upstream ==="
git fetch upstream

echo "=== Fast-forwarding main ==="
git checkout main
git merge --ff-only upstream/main
git push origin main

echo "=== Rebasing fork branch ==="
git checkout ui-improvements-desktop-bridge
git rebase main

echo ""
echo "=== ui.html delta from upstream (should be CSS/HTML only, no JS) ==="
git diff HEAD upstream/main -- figma-desktop-bridge/ui.html || true

echo ""
echo "=== Sync ui-full.html mirror ==="
cp figma-desktop-bridge/ui.html figma-desktop-bridge/ui-full.html
echo "ui-full.html updated."

echo ""
echo "=== Done. Review diff above, then: ==="
echo "  git push origin ui-improvements-desktop-bridge --force-with-lease"
