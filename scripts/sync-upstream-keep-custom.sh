#!/usr/bin/env bash
set -euo pipefail

# Sync custom branch with upstream main while preserving local custom commits.
# Usage:
#   scripts/sync-upstream-keep-custom.sh
#   scripts/sync-upstream-keep-custom.sh <branch>

BRANCH="${1:-codex/bridge-ui-context-copy-link}"
UPSTREAM_REMOTE="origin"
UPSTREAM_MAIN="main"
FORK_REMOTE="builtbysang"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

current_branch="$(git branch --show-current)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit/stash first."
  exit 1
fi

if ! git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "Branch '$BRANCH' not found"
  exit 1
fi

echo "Fetching upstream ($UPSTREAM_REMOTE/$UPSTREAM_MAIN) and fork ($FORK_REMOTE)..."
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_MAIN"
git fetch "$FORK_REMOTE" || true

echo "Switching to $BRANCH"
git checkout "$BRANCH"

echo "Rebasing $BRANCH onto $UPSTREAM_REMOTE/$UPSTREAM_MAIN"
git rebase "$UPSTREAM_REMOTE/$UPSTREAM_MAIN"

echo "Pushing rebased branch to $FORK_REMOTE/$BRANCH"
git push --force-with-lease "$FORK_REMOTE" "$BRANCH"

echo "Done. Your custom branch now includes latest upstream + your local patches."

echo "Tip: Run build + stable plugin sync after rebase if UI/account logic changed."

git checkout "$current_branch" >/dev/null 2>&1 || true
