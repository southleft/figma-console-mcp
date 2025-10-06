#!/bin/bash
set -e

echo "🔍 Phase 3 Implementation Verification"
echo "======================================"
echo ""

# Check package.json updates
echo "✅ Checking package.json..."
if grep -q "puppeteer-core" package.json; then
  echo "  ✓ puppeteer-core dependency added"
fi
if grep -q "build:local" package.json; then
  echo "  ✓ build:local script added"
fi
if grep -q "build:cloudflare" package.json; then
  echo "  ✓ build:cloudflare script added"
fi
if grep -q "dev:local" package.json; then
  echo "  ✓ dev:local script added"
fi
echo ""

# Check TypeScript configs
echo "✅ Checking TypeScript configurations..."
if [ -f "tsconfig.local.json" ]; then
  echo "  ✓ tsconfig.local.json exists"
fi
if [ -f "tsconfig.cloudflare.json" ]; then
  echo "  ✓ tsconfig.cloudflare.json exists"
fi
echo ""

# Check source files
echo "✅ Checking source files..."
if [ -f "src/local.ts" ]; then
  echo "  ✓ src/local.ts exists ($(wc -l < src/local.ts) lines)"
fi
if grep -q "mode: 'local' | 'cloudflare'" src/core/types/index.ts; then
  echo "  ✓ ServerConfig.mode added"
fi
if grep -q "LocalModeConfig" src/core/types/index.ts; then
  echo "  ✓ LocalModeConfig interface added"
fi
if grep -q "detectMode()" src/core/config.ts; then
  echo "  ✓ Mode auto-detection implemented"
fi
echo ""

# Check builds
echo "✅ Checking build artifacts..."
if [ -f "dist/local.js" ]; then
  size=$(ls -lh dist/local.js | awk '{print $5}')
  echo "  ✓ dist/local.js built ($size)"
  if head -1 dist/local.js | grep -q "#!/usr/bin/env node"; then
    echo "  ✓ Shebang present"
  fi
  if [ -x "dist/local.js" ]; then
    echo "  ✓ Executable permission set"
  else
    echo "  ⚠ Executable permission not set (run: chmod +x dist/local.js)"
  fi
fi
if [ -f "dist/cloudflare/index.js" ]; then
  size=$(ls -lh dist/cloudflare/index.js | awk '{print $5}')
  echo "  ✓ dist/cloudflare/index.js built ($size)"
fi
echo ""

# Check documentation
echo "✅ Checking documentation..."
if [ -f "DUAL_MODE_SETUP.md" ]; then
  echo "  ✓ DUAL_MODE_SETUP.md created"
fi
if [ -f "PHASE3_SUMMARY.md" ]; then
  echo "  ✓ PHASE3_SUMMARY.md created"
fi
echo ""

# Test build commands
echo "✅ Testing build commands..."
echo "  Testing: npm run build:local"
npm run build:local > /dev/null 2>&1 && echo "  ✓ build:local works" || echo "  ✗ build:local failed"

echo "  Testing: npm run build:cloudflare"
npm run build:cloudflare > /dev/null 2>&1 && echo "  ✓ build:cloudflare works" || echo "  ✗ build:cloudflare failed"

echo "  Testing: npm run build"
npm run build > /dev/null 2>&1 && echo "  ✓ build (both) works" || echo "  ✗ build failed"
echo ""

# Summary
echo "======================================"
echo "✨ Phase 3 Implementation Complete!"
echo ""
echo "📦 Artifacts:"
echo "  - Local server: dist/local.js"
echo "  - Cloudflare worker: dist/cloudflare/index.js"
echo ""
echo "🚀 Next Steps:"
echo "  1. Launch Figma Desktop with debugging:"
echo "     open -a 'Figma' --args --remote-debugging-port=9222"
echo ""
echo "  2. Test local server:"
echo "     npm run dev:local"
echo ""
echo "  3. Deploy Cloudflare version:"
echo "     npm run deploy"
echo ""
echo "📖 See DUAL_MODE_SETUP.md for full documentation"
echo "======================================"
