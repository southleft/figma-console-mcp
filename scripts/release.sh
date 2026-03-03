#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
# Figma Console MCP — Release Automation Script
#
# Handles mechanical version/count updates across all files.
# Run BEFORE manual content edits (banners, changelog entries).
#
# Usage:
#   ./scripts/release.sh --version 1.12.0 --local-tools 58 --remote-tools 23
#   ./scripts/release.sh --version 1.12.0 --local-tools 58 --remote-tools 23 --dry-run
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
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --version)     VERSION="$2";       shift 2 ;;
    --local-tools) LOCAL_TOOLS="$2";   shift 2 ;;
    --remote-tools) REMOTE_TOOLS="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=true;       shift ;;
    -h|--help)
      echo "Usage: ./scripts/release.sh --version X.Y.Z --local-tools N --remote-tools M [--dry-run]"
      echo ""
      echo "Options:"
      echo "  --version       New version number (e.g., 1.12.0)"
      echo "  --local-tools   Total local mode tool count (e.g., 58)"
      echo "  --remote-tools  Total remote mode tool count (e.g., 23)"
      echo "  --dry-run       Show what would change without modifying files"
      exit 0
      ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
  esac
done

# ── Validate required args ──────────────────────────────
if [[ -z "$VERSION" || -z "$LOCAL_TOOLS" || -z "$REMOTE_TOOLS" ]]; then
  echo -e "${RED}Error: --version, --local-tools, and --remote-tools are all required${NC}"
  echo "Run with --help for usage"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo -e "${RED}Error: Version must be in semver format (e.g., 1.12.0)${NC}"
  exit 1
fi

# ── Resolve paths ───────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Preflight checks ───────────────────────────────────
echo -e "${BOLD}${CYAN}Figma Console MCP — Release Script${NC}"
echo -e "${CYAN}Version: ${BOLD}$VERSION${NC}  Local tools: ${BOLD}$LOCAL_TOOLS${NC}  Remote tools: ${BOLD}$REMOTE_TOOLS${NC}"
echo ""

if $DRY_RUN; then
  echo -e "${YELLOW}DRY RUN — no files will be modified${NC}"
  echo ""
fi

# Read current version from package.json
CURRENT_VERSION=$(node -p "require('$ROOT/package.json').version")
echo -e "Current version: ${BOLD}$CURRENT_VERSION${NC}"
echo ""

# Detect current tool counts from docs/tools.md frontmatter
CURRENT_LOCAL=$(grep -oE '[0-9]+\+ MCP tools' "$ROOT/docs/tools.md" | head -1 | grep -oE '[0-9]+' || echo "?")
echo -e "Current local tool count: ${BOLD}${CURRENT_LOCAL}+${NC} → ${BOLD}${LOCAL_TOOLS}+${NC}"

# Detect current remote tool count from docs/tools.md
CURRENT_REMOTE=$(grep -oE '[0-9]+ read-only tools' "$ROOT/docs/tools.md" | head -1 | grep -oE '[0-9]+' || echo "?")
echo -e "Current remote tool count: ${BOLD}${CURRENT_REMOTE}${NC} → ${BOLD}${REMOTE_TOOLS}${NC}"
echo ""

# ── Helper: replace in file ─────────────────────────────
# Usage: replace_in_file <file> <pattern> <replacement> <description>
CHANGES=()
replace_in_file() {
  local file="$1" pattern="$2" replacement="$3" desc="$4"
  local relpath="${file#$ROOT/}"

  if ! [[ -f "$file" ]]; then
    echo -e "  ${RED}SKIP${NC} $relpath — file not found"
    return
  fi

  local count
  count=$(grep -cE "$pattern" "$file" 2>/dev/null || true)
  count=${count:-0}

  if [[ "$count" -eq 0 ]]; then
    echo -e "  ${YELLOW}SKIP${NC} $relpath — pattern not found: $desc"
    return
  fi

  if $DRY_RUN; then
    echo -e "  ${CYAN}WOULD${NC} $relpath — $desc ($count match(es))"
  else
    sedi -E "s|$pattern|$replacement|g" "$file"
    echo -e "  ${GREEN}DONE${NC} $relpath — $desc ($count match(es))"
  fi
  CHANGES+=("$relpath: $desc")
}

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

# ── 4. Local tool count replacement ─────────────────────
echo -e "${BOLD}4. Local tool count ($CURRENT_LOCAL+ → $LOCAL_TOOLS+)${NC}"

TOOL_FILES=(
  "docs/tools.md"
  "docs/index.mdx"
  "docs/introduction.md"
  "docs/architecture.md"
  "docs/mode-comparison.md"
  "docs/setup.md"
  "docs/use-cases.md"
  "docs/mint.json"
  "README.md"
  "src/index.ts"
)

for f in "${TOOL_FILES[@]}"; do
  replace_in_file "$ROOT/$f" \
    "${CURRENT_LOCAL}\+ tools" \
    "${LOCAL_TOOLS}+ tools" \
    "local tool count"
done

# Also handle "**N+**" pattern (bold count in markdown tables)
echo -e "${BOLD}5. Bold tool count patterns${NC}"
for f in "${TOOL_FILES[@]}"; do
  replace_in_file "$ROOT/$f" \
    "\*\*${CURRENT_LOCAL}\+\*\*" \
    "**${LOCAL_TOOLS}+**" \
    "bold tool count"
done

# ── 6. Remote tool count replacement ────────────────────
echo -e "${BOLD}6. Remote tool count ($CURRENT_REMOTE → $REMOTE_TOOLS)${NC}"

REMOTE_FILES=(
  "docs/tools.md"
  "docs/index.mdx"
  "docs/introduction.md"
  "docs/architecture.md"
  "docs/mode-comparison.md"
  "docs/setup.md"
  "README.md"
)

# Patterns found in codebase (most specific first to avoid double-replacement):
# "22 read-only tools"      → docs/tools.md, introduction.md, setup.md, README.md
# "22 tools"                → index.mdx (x2), introduction.md, mode-comparison.md
# "**22**"                  → introduction.md (table), setup.md (table), README.md (table)
# ", 22 in Remote"          → architecture.md
for f in "${REMOTE_FILES[@]}"; do
  # "N read-only tools" (e.g. "22 read-only tools")
  replace_in_file "$ROOT/$f" \
    "${CURRENT_REMOTE} read-only tools" \
    "${REMOTE_TOOLS} read-only tools" \
    "remote tool count (read-only tools)"

  # "with N tools" (e.g. "with 22 tools")
  replace_in_file "$ROOT/$f" \
    "with ${CURRENT_REMOTE} tools" \
    "with ${REMOTE_TOOLS} tools" \
    "remote tool count (with N tools)"

  # "— N tools" (e.g. "— 22 tools")
  replace_in_file "$ROOT/$f" \
    "— ${CURRENT_REMOTE} tools" \
    "— ${REMOTE_TOOLS} tools" \
    "remote tool count (— N tools)"

  # "Only N tools" (e.g. "Only 22 tools")
  replace_in_file "$ROOT/$f" \
    "Only ${CURRENT_REMOTE} tools" \
    "Only ${REMOTE_TOOLS} tools" \
    "remote tool count (Only N)"

  # "(N tools)" (e.g. "(22 tools)")
  replace_in_file "$ROOT/$f" \
    "(${CURRENT_REMOTE} tools)" \
    "(${REMOTE_TOOLS} tools)" \
    "remote tool count (parenthesized)"

  # "only has N read-only" (e.g. "only has 22 read-only")
  replace_in_file "$ROOT/$f" \
    "has ${CURRENT_REMOTE} read-only" \
    "has ${REMOTE_TOOLS} read-only" \
    "remote tool count (has N read-only)"

  # ", N in Remote" (e.g. ", 22 in Remote Mode")
  replace_in_file "$ROOT/$f" \
    ", ${CURRENT_REMOTE} in Remote" \
    ", ${REMOTE_TOOLS} in Remote" \
    "remote tool count (N in Remote)"

  # ":** N tools" (e.g. ":** 22 tools")
  replace_in_file "$ROOT/$f" \
    ":\*\* ${CURRENT_REMOTE} tools" \
    ":** ${REMOTE_TOOLS} tools" \
    "remote tool count (bold label)"

  # Table cells: "| **N**" or "| **N** (read-only)"
  replace_in_file "$ROOT/$f" \
    "\| \*\*${CURRENT_REMOTE}\*\*" \
    "| **${REMOTE_TOOLS}**" \
    "remote tool count (table cell)"
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
    # Insert new version section after the header comment block
    # Find the line with the first ## and insert before it
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
  echo -e "${BOLD}${YELLOW}DRY RUN COMPLETE${NC} — ${#CHANGES[@]} changes identified"
else
  echo -e "${BOLD}${GREEN}AUTOMATED STEPS COMPLETE${NC} — ${#CHANGES[@]} changes made"
fi
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════${NC}"
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
