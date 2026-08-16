#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
# Figma Console MCP — Release Automation Script
#
# Handles mechanical version/count updates across all files.
# Run BEFORE manual content edits (banners, changelog entries).
#
# Tool counts are auto-detected from the source code unless
# overridden with --local-tools / --remote-tools / --cloud-tools.
#
# Usage:
#   ./scripts/release.sh --version 1.14.0
#   ./scripts/release.sh --version 1.14.0 --dry-run
#   ./scripts/release.sh --version 1.14.0 --local-tools 60 --remote-tools 22 --cloud-tools 44
# ─────────────────────────────────────────────────────────

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Platform-aware sed ──────────────────────────────────
if [[ "$(uname)" == "Darwin" ]]; then
  sedi() { sed -i '' "$@"; }
else
  sedi() { sed -i "$@"; }
fi

# ── Argument parsing ────────────────────────────────────
VERSION=""
LOCAL_TOOLS=""
REMOTE_TOOLS=""
CLOUD_TOOLS=""
DRY_RUN=false
GH_RELEASE=""  # "auto" (default), "yes" (--release), "no" (--no-release)

while [[ $# -gt 0 ]]; do
  case $1 in
    --version)      VERSION="$2";       shift 2 ;;
    --local-tools)  LOCAL_TOOLS="$2";   shift 2 ;;
    --remote-tools) REMOTE_TOOLS="$2";  shift 2 ;;
    --cloud-tools)  CLOUD_TOOLS="$2";   shift 2 ;;
    --dry-run)      DRY_RUN=true;       shift ;;
    --release)      GH_RELEASE="yes";   shift ;;
    --no-release)   GH_RELEASE="no";    shift ;;
    -h|--help)
      echo "Usage: ./scripts/release.sh --version X.Y.Z [--local-tools N] [--remote-tools M] [--cloud-tools C] [--dry-run]"
      echo ""
      echo "Options:"
      echo "  --version       New version number (required, e.g., 1.14.0)"
      echo "  --local-tools   Override local mode tool count (auto-detected from source if omitted)"
      echo "  --remote-tools  Override remote mode tool count (auto-detected if omitted)"
      echo "  --cloud-tools   Override cloud mode tool count (auto-detected if omitted)"
      echo "  --dry-run       Show what would change without modifying files"
      echo "  --release       Create GitHub Release (auto for minor/major, skip for patch)"
      echo "  --no-release    Skip GitHub Release creation"
      exit 0
      ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
  esac
done

# ── Validate required args ──────────────────────────────
if [[ -z "$VERSION" ]]; then
  echo -e "${RED}Error: --version is required${NC}"
  echo "Run with --help for usage"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo -e "${RED}Error: Version must be in semver format (e.g., 1.14.0)${NC}"
  exit 1
fi

# ── npm auth precheck (advisory) ────────────────────────
# Publishing runs in CI via Trusted Publishing / OIDC on a `v*` tag push
# (.github/workflows/publish.yml) — no local token, no 2FA prompt. A stale
# or missing ~/.npmrc token therefore does NOT block a release, so this is
# a warning rather than the hard gate it used to be when the maintainer
# ran `npm publish` by hand.
#
# The token still matters for the manual fallback (`npm publish` from a
# real TTY), so an expired one is worth flagging — just not worth aborting
# a release that will never touch it.
if [[ "$DRY_RUN" == false ]]; then
  if ! NPM_USER=$(npm whoami 2>/dev/null); then
    echo -e "${YELLOW}Note: npm auth unavailable${NC} — ${BOLD}npm whoami${NC} returned 401."
    echo -e "  Not a blocker: publishing runs in CI via OIDC on the ${BOLD}v${VERSION}${NC} tag push."
    echo -e "  Only refresh the token if you need the manual ${BOLD}npm publish${NC} fallback:"
    echo -e "  ${CYAN}https://www.npmjs.com/settings/~/tokens${NC}"
    echo ""
  else
    echo -e "${CYAN}npm auth:${NC} ${BOLD}$NPM_USER${NC} (verified)"
  fi
fi

# ── Resolve paths ───────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Auto-detect tool counts from source code ────────────
auto_count_local() {
  # All unique figma_* and figjam_* tool names in local mode sources (core + local.ts),
  # plus plain (non-app) tools registered inside MCP App modules. Only names
  # passed to server.tool(...) count — registerAppTool(...) names are app-only
  # (invisible to standard MCP clients) and must NOT inflate the local count.
  {
    grep -roh '"fig\(ma\|jam\)_[a-z_]*"' \
      "$ROOT/src/core/" "$ROOT/src/local.ts" 2>/dev/null
    grep -rA1 'server\.tool(' "$ROOT/src/apps/" 2>/dev/null \
      | grep -oh '"fig\(ma\|jam\)_[a-z_]*"'
  } | sort -u | wc -l | tr -d ' '
}

auto_count_remote() {
  # Remote/SSE mode (no plugin pairing): the REST-API-backed read tools that
  # work over OAuth alone, without a paired Desktop Bridge plugin. These all
  # live in figma-tools.ts. This count gets surfaced as the "N read-only
  # tools" claim across the docs.
  grep -roh '"figma_[a-z_]*"' \
    "$ROOT/src/core/figma-tools.ts" \
    2>/dev/null | sort -u | wc -l | tr -d ' '
}

auto_count_cloud() {
  # Cloud mode (Cloud Mode after pairing): every registrar invoked by src/index.ts
  # plus index.ts's own direct tool registrations. Mirror this list with the
  # actual register*() calls in src/index.ts.
  grep -roh '"fig\(ma\|jam\)_[a-z_]*"' \
    "$ROOT/src/core/write-tools.ts" \
    "$ROOT/src/core/figma-tools.ts" \
    "$ROOT/src/core/design-system-tools.ts" \
    "$ROOT/src/core/comment-tools.ts" \
    "$ROOT/src/core/design-code-tools.ts" \
    "$ROOT/src/core/figjam-tools.ts" \
    "$ROOT/src/core/slides-tools.ts" \
    "$ROOT/src/core/annotation-tools.ts" \
    "$ROOT/src/core/deep-component-tools.ts" \
    "$ROOT/src/core/version-tools.ts" \
    "$ROOT/src/core/accessibility-tools.ts" \
    "$ROOT/src/core/diagnose-tool.ts" \
    "$ROOT/src/core/tokens-tools.ts" \
    "$ROOT/src/core/slot-tools.ts" \
    "$ROOT/src/index.ts" \
    2>/dev/null | sort -u | wc -l | tr -d ' '
}

if [[ -z "$LOCAL_TOOLS" ]]; then
  LOCAL_TOOLS=$(auto_count_local)
fi
if [[ -z "$REMOTE_TOOLS" ]]; then
  REMOTE_TOOLS=$(auto_count_remote)
fi
if [[ -z "$CLOUD_TOOLS" ]]; then
  CLOUD_TOOLS=$(auto_count_cloud)
fi

# ── Preflight ───────────────────────────────────────────
echo -e "${BOLD}${CYAN}Figma Console MCP — Release Script${NC}"
echo -e "${CYAN}Version: ${BOLD}$VERSION${NC}"
echo -e "${CYAN}Local tools:  ${BOLD}$LOCAL_TOOLS${NC} (auto-detected from source)"
echo -e "${CYAN}Remote tools: ${BOLD}$REMOTE_TOOLS${NC} (auto-detected from source)"
echo -e "${CYAN}Cloud tools:  ${BOLD}$CLOUD_TOOLS${NC} (auto-detected from source)"
echo ""

if $DRY_RUN; then
  echo -e "${YELLOW}DRY RUN — no files will be modified${NC}"
  echo ""
fi

# Read current version from package.json
CURRENT_VERSION=$(node -p "require('$ROOT/package.json').version")
echo -e "Current version: ${BOLD}$CURRENT_VERSION${NC}"
echo ""

# ── Helper: replace in file ─────────────────────────────
CHANGES=()
CHANGE_COUNT=0

replace_in_file() {
  local file="$1" pattern="$2" replacement="$3" desc="$4"
  local relpath="${file#$ROOT/}"

  if ! [[ -f "$file" ]]; then
    echo -e "  ${RED}MISS${NC} $relpath — file not found"
    return
  fi

  local count
  count=$(grep -cE "$pattern" "$file" 2>/dev/null || true)
  count=${count:-0}

  if [[ "$count" -eq 0 ]]; then
    return
  fi

  if $DRY_RUN; then
    echo -e "  ${CYAN}WOULD${NC} $relpath — $desc ($count match(es))"
  else
    sedi -E "s|$pattern|$replacement|g" "$file"
    echo -e "  ${GREEN}DONE${NC} $relpath — $desc ($count match(es))"
  fi
  CHANGES+=("$relpath: $desc")
  CHANGE_COUNT=$((CHANGE_COUNT + count))
}

# ── Files to update tool counts in ──────────────────────
ALL_DOC_FILES=(
  "README.md"
  "docs/tools.md"
  "docs/index.mdx"
  "docs/introduction.md"
  "docs/architecture.md"
  "docs/mode-comparison.md"
  "docs/setup.md"
  "docs/use-cases.md"
  "docs/mint.json"
  "docs/figma-mcp-vs-figma-console-mcp.md"
  "src/index.ts"
)

# ── 1. Version bump in package.json ─────────────────────
echo -e "${BOLD}1. Version bump${NC}"
if $DRY_RUN; then
  echo -e "  ${CYAN}WOULD${NC} package.json — $CURRENT_VERSION → $VERSION"
  CHANGES+=("package.json: version bump")
else
  (cd "$ROOT" && npm version "$VERSION" --no-git-tag-version --allow-same-version > /dev/null 2>&1)
  echo -e "  ${GREEN}DONE${NC} package.json — $CURRENT_VERSION → $VERSION"
  CHANGES+=("package.json: version bump")
fi

# ── 2. Version sync in docs/mint.json ───────────────────
echo -e "${BOLD}2. docs/mint.json version${NC}"
replace_in_file "$ROOT/docs/mint.json" \
  "\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"" \
  "\"version\": \"$VERSION\"" \
  "version field"

# ── 3. Version sync in src/index.ts (3 occurrences) ────
echo -e "${BOLD}3. src/index.ts version strings${NC}"
replace_in_file "$ROOT/src/index.ts" \
  "version: \"[0-9]+\.[0-9]+\.[0-9]+\"" \
  "version: \"$VERSION\"" \
  "all McpServer + health version strings"

# ── 3c. MCP_VERSION sync in src/core/tokens-tools.ts ───
# The token sync tools stamp this version into DTCG $extensions.mcpVersion
# on every export so token files record which MCP build produced them.
echo -e "${BOLD}3c. src/core/tokens-tools.ts MCP_VERSION${NC}"
replace_in_file "$ROOT/src/core/tokens-tools.ts" \
  "const MCP_VERSION = \"[0-9]+\.[0-9]+\.[0-9]+\"" \
  "const MCP_VERSION = \"$VERSION\"" \
  "MCP_VERSION constant"

# ── 3b. PLUGIN_VERSION sync in figma-desktop-bridge/code.js ──
# Bumped ONLY when plugin files actually changed since the last release.
# When they did change, the bump busts Figma's plugin-file cache and marks
# older imported plugins stale (issue #62). When they did NOT change
# (server-only release: deps, docs, server code), the constant must stay
# put — the server's FILE_INFO handshake compares the plugin's reported
# version against THIS constant, and bumping it would falsely flag every
# connected plugin as needing a re-import.
echo -e "${BOLD}3b. figma-desktop-bridge PLUGIN_VERSION${NC}"
PLUGIN_FILES_CHANGED=true
if git -C "$ROOT" rev-parse -q --verify "v$CURRENT_VERSION" > /dev/null 2>&1; then
  # -I ignores the PLUGIN_VERSION line itself (a prior bump must not read as a
  # "plugin change" next release) and JS comment lines (comment-only edits
  # don't require a re-import).
  if git -C "$ROOT" diff --quiet -I '^var PLUGIN_VERSION' -I '^//' "v$CURRENT_VERSION" -- figma-desktop-bridge/; then
    PLUGIN_FILES_CHANGED=false
  fi
fi
if $PLUGIN_FILES_CHANGED; then
  replace_in_file "$ROOT/figma-desktop-bridge/code.js" \
    "var PLUGIN_VERSION = '[0-9]+\.[0-9]+\.[0-9]+'" \
    "var PLUGIN_VERSION = '$VERSION'" \
    "PLUGIN_VERSION constant"
else
  echo -e "  ${CYAN}SKIP${NC} figma-desktop-bridge/code.js — no plugin file changes since v$CURRENT_VERSION (server-only release; keeping PLUGIN_VERSION so connected plugins aren't falsely flagged stale)"
fi

# ── 4. Tool counts (Local / Remote / Cloud) ────────────
# Delegated to scripts/update-tool-counts.mjs — a manifest that knows the MODE
# of every count reference explicitly ({file, pattern, mode} entries). This
# replaced the old sed approach, which shipped wrong-mode counts in three
# consecutive releases (v1.33.0, v1.33.1, v1.34.0). The script self-audits
# after applying (Phase 3.5 Block D) and exits nonzero on any wrong-mode
# count or unclassified "N tools" reference.
echo -e "${BOLD}4. Tool counts (local/remote/cloud) — update-tool-counts.mjs${NC}"
COUNT_ARGS=(--local "$LOCAL_TOOLS" --remote "$REMOTE_TOOLS" --cloud "$CLOUD_TOOLS")
if $DRY_RUN; then
  COUNT_ARGS+=(--dry-run)
fi
if node "$SCRIPT_DIR/update-tool-counts.mjs" "${COUNT_ARGS[@]}"; then
  CHANGES+=("tool counts: manifest-driven update (update-tool-counts.mjs)")
else
  echo -e "${RED}Tool-count update/verify FAILED.${NC}"
  echo -e "  A count is inconsistent or a new/changed doc sentence with a tool count"
  echo -e "  isn't classified. Fix the docs, or update MANIFEST/ALLOWLIST in"
  echo -e "  ${CYAN}scripts/update-tool-counts.mjs${NC}, then re-run."
  exit 1
fi

# ── 7. Lockfile sync ───────────────────────────────────
echo -e "${BOLD}7. Lockfile sync${NC}"
if $DRY_RUN; then
  echo -e "  ${CYAN}WOULD${NC} package-lock.json — npm install --package-lock-only"
else
  (cd "$ROOT" && npm install --package-lock-only > /dev/null 2>&1)
  echo -e "  ${GREEN}DONE${NC} package-lock.json — synced"
fi

# ── 8. CHANGELOG scaffold ──────────────────────────────
echo -e "${BOLD}8. CHANGELOG.md scaffold${NC}"

CHANGELOG="$ROOT/CHANGELOG.md"
TODAY=$(date +%Y-%m-%d)
NEW_HEADER="## [$VERSION] - $TODAY"
COMPARISON_LINK="[$VERSION]: https://github.com/southleft/figma-console-mcp/compare/v${CURRENT_VERSION}...v${VERSION}"

if grep -qF "## [$VERSION]" "$CHANGELOG" 2>/dev/null; then
  echo -e "  ${YELLOW}SKIP${NC} CHANGELOG.md — version $VERSION header already exists"
else
  if $DRY_RUN; then
    echo -e "  ${CYAN}WOULD${NC} CHANGELOG.md — insert $NEW_HEADER section"
    echo -e "  ${CYAN}WOULD${NC} CHANGELOG.md — add comparison link"
  else
    # Insert new version section before the first existing ## entry
    FIRST_ENTRY_LINE=$(grep -n '^## \[' "$CHANGELOG" | head -1 | cut -d: -f1)
    if [[ -n "$FIRST_ENTRY_LINE" ]]; then
      sedi "${FIRST_ENTRY_LINE}i\\
${NEW_HEADER}\\
\\
### Added\\
\\
### Changed\\
\\
### Fixed\\
\\
" "$CHANGELOG"
      echo -e "  ${GREEN}DONE${NC} CHANGELOG.md — inserted $NEW_HEADER section"
    else
      echo -e "  ${RED}ERROR${NC} CHANGELOG.md — could not find insertion point"
    fi

    # Add comparison link at the top of the link block
    FIRST_LINK_LINE=$(grep -n '^\[' "$CHANGELOG" | head -1 | cut -d: -f1)
    if [[ -n "$FIRST_LINK_LINE" ]]; then
      sedi "${FIRST_LINK_LINE}i\\
${COMPARISON_LINK}" "$CHANGELOG"
      echo -e "  ${GREEN}DONE${NC} CHANGELOG.md — added comparison link"
    fi
  fi
  CHANGES+=("CHANGELOG.md: version scaffold")
fi

# ── Step 9: GitHub Release (optional) ──────────────────
# Auto-creates for minor/major bumps (x.Y.0 or X.0.0), skips for patches.
# Override with --release or --no-release.
PATCH_PART="${VERSION##*.}"
CREATE_RELEASE=false

if [[ "$GH_RELEASE" == "yes" ]]; then
  CREATE_RELEASE=true
elif [[ "$GH_RELEASE" == "no" ]]; then
  CREATE_RELEASE=false
elif [[ "$PATCH_PART" == "0" ]]; then
  # Minor or major release (x.Y.0 or X.0.0) — auto-create
  CREATE_RELEASE=true
fi

echo -e "${BOLD}9. GitHub Release${NC}"
if $CREATE_RELEASE; then
  if $DRY_RUN; then
    echo -e "  ${CYAN}WOULD${NC} create GitHub Release v${VERSION} (--latest)"
  else
    if ! command -v gh &>/dev/null; then
      echo -e "  ${YELLOW}SKIP${NC} GitHub Release — gh CLI not installed"
    elif ! git rev-parse "v${VERSION}" &>/dev/null; then
      # This script runs at Phase 2 — BEFORE the version bump is committed and
      # tagged (Phase 5). `gh release create` on a tag that doesn't exist yet
      # makes one from the REMOTE default branch head, which is the commit
      # *without* the version bump. That tag push then fires
      # .github/workflows/publish.yml against a tree whose package.json still
      # holds the previous version. It also captures the CHANGELOG section
      # while it's still an empty Phase 3 scaffold.
      #
      # So: never create it here. Print the command to run after the tag is
      # pushed, when the notes are written and the tag points at the release.
      echo -e "  ${YELLOW}DEFER${NC} GitHub Release — tag v${VERSION} doesn't exist yet"
      echo -e "         Creating it now would tag the wrong commit and trigger publish early."
      echo -e "         After committing, tagging, and pushing, run:"
      echo -e "         ${CYAN}gh release create v${VERSION} -t v${VERSION} --latest --notes-from-tag${NC}"
      echo -e "         (or pass -F with the finished CHANGELOG section)"
    else
      # Tag exists locally — safe to publish notes from the finished CHANGELOG.
      RELEASE_NOTES=$(awk "/^## \\[${VERSION}\\]/{found=1; next} /^## \\[/{if(found) exit} found" "$ROOT/CHANGELOG.md" | sed '/^$/d')
      if [[ -z "$RELEASE_NOTES" ]]; then
        RELEASE_NOTES="See [CHANGELOG](https://github.com/southleft/figma-console-mcp/blob/main/CHANGELOG.md) for details."
      fi
      RELEASE_NOTES="${RELEASE_NOTES}

**${LOCAL_TOOLS}+ tools.** Full changelog: https://github.com/southleft/figma-console-mcp/blob/main/CHANGELOG.md"

      gh release create "v${VERSION}" \
        -t "v${VERSION}" \
        --latest \
        -n "$RELEASE_NOTES" 2>/dev/null && \
        echo -e "  ${GREEN}DONE${NC} GitHub Release v${VERSION} created" || \
        echo -e "  ${YELLOW}SKIP${NC} GitHub Release — already exists or gh not authenticated"
    fi
  fi
  CHANGES+=("GitHub Release: v${VERSION}")
else
  echo -e "  ${CYAN}SKIP${NC} Patch release — use --release to create anyway"
fi

# ── Summary ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════${NC}"
if $DRY_RUN; then
  echo -e "${BOLD}${YELLOW}DRY RUN COMPLETE${NC} — ${#CHANGES[@]} file changes, $CHANGE_COUNT replacements"
else
  echo -e "${BOLD}${GREEN}AUTOMATED STEPS COMPLETE${NC} — ${#CHANGES[@]} file changes, $CHANGE_COUNT replacements"
fi
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════${NC}"
echo ""

echo -e "${CYAN}Tool counts applied:${NC}"
echo -e "  Local:  ${BOLD}${LOCAL_TOOLS}+${NC} tools (NPX/Local Git)"
echo -e "  Cloud:  ${BOLD}${CLOUD_TOOLS}${NC} tools (Cloud Write Relay)"
echo -e "  Remote: ${BOLD}${REMOTE_TOOLS}${NC} tools (SSE read-only)"
echo ""

# ── Remaining manual steps ──────────────────────────────
echo -e "${BOLD}${YELLOW}Remaining manual steps:${NC}"
echo -e "  1. ${CYAN}README.md${NC} — Update banner text (release-specific messaging)"
echo -e "  2. ${CYAN}docs/index.mdx${NC} — Update <Note> banner"
echo -e "  3. ${CYAN}CHANGELOG.md${NC} — Fill in Added/Changed/Fixed entries"
echo -e "  4. ${CYAN}docs/tools.md${NC} — Add new tool quick-ref row + full docs"
echo -e "  5. ${CYAN}docs/index.mdx${NC} — Update capabilities accordion (if new tools)"
echo -e "  6. ${CYAN}README.md${NC} — Update feature descriptions / comparison tables"
echo -e "  7. ${CYAN}.notes/ROADMAP.md${NC} — Move items, update status"
echo -e "  8. Build, test, commit, tag, push, publish (see .notes/RELEASING.md)"
echo ""
