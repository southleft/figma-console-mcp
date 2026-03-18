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

while [[ $# -gt 0 ]]; do
  case $1 in
    --version)      VERSION="$2";       shift 2 ;;
    --local-tools)  LOCAL_TOOLS="$2";   shift 2 ;;
    --remote-tools) REMOTE_TOOLS="$2";  shift 2 ;;
    --cloud-tools)  CLOUD_TOOLS="$2";   shift 2 ;;
    --dry-run)      DRY_RUN=true;       shift ;;
    -h|--help)
      echo "Usage: ./scripts/release.sh --version X.Y.Z [--local-tools N] [--remote-tools M] [--cloud-tools C] [--dry-run]"
      echo ""
      echo "Options:"
      echo "  --version       New version number (required, e.g., 1.14.0)"
      echo "  --local-tools   Override local mode tool count (auto-detected from source if omitted)"
      echo "  --remote-tools  Override remote mode tool count (auto-detected if omitted)"
      echo "  --cloud-tools   Override cloud mode tool count (auto-detected if omitted)"
      echo "  --dry-run       Show what would change without modifying files"
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

# ── Resolve paths ───────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Auto-detect tool counts from source code ────────────
auto_count_local() {
  # All unique figma_* tool names across all source files (local mode has everything)
  grep -roh '"figma_[a-z_]*"' "$ROOT/src/" \
    2>/dev/null | sort -u | wc -l | tr -d ' '
}

auto_count_remote() {
  # Remote/SSE mode: only read-only REST API tools
  grep -roh '"figma_[a-z_]*"' \
    "$ROOT/src/core/figma-tools.ts" \
    2>/dev/null | sort -u | wc -l | tr -d ' '
}

auto_count_cloud() {
  # Cloud mode: write-tools + figma-tools + design-system-tools + comment-tools + design-code-tools + index.ts cloud-specific
  grep -roh '"figma_[a-z_]*"' \
    "$ROOT/src/core/write-tools.ts" \
    "$ROOT/src/core/figma-tools.ts" \
    "$ROOT/src/core/design-system-tools.ts" \
    "$ROOT/src/core/comment-tools.ts" \
    "$ROOT/src/core/design-code-tools.ts" \
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

# ── 4. Local tool count (N+ tools) ─────────────────────
# Matches any number followed by + and "tool(s)" in context of local/full mode
# Patterns: "60+ tools", "the full 60+", "All 59+ tools", "**59+**"
echo -e "${BOLD}4. Local tool count → ${LOCAL_TOOLS}+${NC}"

for f in "${ALL_DOC_FILES[@]}"; do
  # "N+ tools" — the most common pattern (e.g., "60+ tools", "59+ tools")
  replace_in_file "$ROOT/$f" \
    "[0-9]+\+ tools" \
    "${LOCAL_TOOLS}+ tools" \
    "N+ tools"

  # "full N+" — e.g., "the full 60+" at end of sentence
  replace_in_file "$ROOT/$f" \
    "full [0-9]+\+" \
    "full ${LOCAL_TOOLS}+" \
    "full N+"

  # "**N+**" — bold markdown pattern in tables
  replace_in_file "$ROOT/$f" \
    "\*\*[0-9]+\+\*\*" \
    "**${LOCAL_TOOLS}+**" \
    "**N+** bold"

  # "All N+" — e.g., "All 59+ tools"
  replace_in_file "$ROOT/$f" \
    "All [0-9]+\+" \
    "All ${LOCAL_TOOLS}+" \
    "All N+"

  # "N+ tool " (singular with trailing space, e.g., "57+ tool access")
  replace_in_file "$ROOT/$f" \
    "[0-9]+\+ tool " \
    "${LOCAL_TOOLS}+ tool " \
    "N+ tool (singular)"
done

# ── 5. Remote tool count (read-only SSE mode) ──────────
echo -e "${BOLD}5. Remote tool count → ${REMOTE_TOOLS}${NC}"

for f in "${ALL_DOC_FILES[@]}"; do
  # "N read-only tools"
  replace_in_file "$ROOT/$f" \
    "[0-9]+ read-only tools" \
    "${REMOTE_TOOLS} read-only tools" \
    "N read-only tools"

  # "Only N tools"
  replace_in_file "$ROOT/$f" \
    "Only [0-9]+ tools" \
    "Only ${REMOTE_TOOLS} tools" \
    "Only N tools"

  # ", N in Remote"
  replace_in_file "$ROOT/$f" \
    ", [0-9]+ in Remote" \
    ", ${REMOTE_TOOLS} in Remote" \
    "N in Remote"

  # "(N tools)" in remote context — be careful not to match cloud tools
  # Only match in files that discuss remote mode specifically
  if [[ "$f" == "docs/mode-comparison.md" || "$f" == "docs/setup.md" || "$f" == "docs/introduction.md" ]]; then
    # "22 tools" on lines mentioning "read-only" or "remote" or "SSE"
    :
  fi
done

# ── 6. Cloud tool count ────────────────────────────────
echo -e "${BOLD}6. Cloud tool count → ${CLOUD_TOOLS}${NC}"

for f in "${ALL_DOC_FILES[@]}"; do
  # "(N tools)" — cloud mode parenthesized pattern, e.g., "(44 tools)"
  # This is the primary cloud mode pattern used in mode-comparison.md
  replace_in_file "$ROOT/$f" \
    "\\(([0-9]+) tools\\)" \
    "(${CLOUD_TOOLS} tools)" \
    "(N tools) cloud"

  # "N tools including full write" — cloud mode in README
  replace_in_file "$ROOT/$f" \
    "[0-9]+ tools including full write" \
    "${CLOUD_TOOLS} tools including full write" \
    "N tools including full write"

  # "get N tools"
  replace_in_file "$ROOT/$f" \
    "get [0-9]+ tools" \
    "get ${CLOUD_TOOLS} tools" \
    "get N tools"

  # "— N tools" in cloud context
  replace_in_file "$ROOT/$f" \
    "— [0-9]+ tools" \
    "— ${CLOUD_TOOLS} tools" \
    "— N tools"
done

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
