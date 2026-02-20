#!/bin/bash
# publish-boujot.sh — Publish happy-cli as @boujot/happy-coder to npm.
#
# Usage: bash scripts/publish-boujot.sh [--dry-run]
#
# Only patches package.json (name + bin fields) before building and publishing.
# No source file modifications needed — runtime flavor detection handles branding.
#
# Prerequisites:
#   - Create a granular npm access token at https://www.npmjs.com/settings/tokens/create
#   - Set it: export NPM_TOKEN=<your-token>
#   - Or pass it inline: NPM_TOKEN=<token> bash scripts/publish-boujot.sh
set -e

cd "$(dirname "$0")/.."

DRY_RUN=""
if [ "$1" = "--dry-run" ]; then
    DRY_RUN="--dry-run"
    echo "Dry run mode — will not publish"
fi

echo "Patching package.json for @boujot/happy-coder..."

# Save original package.json
cp package.json package.json.bak

# Patch name and bin fields
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.name = '@boujot/happy-coder';
pkg.bin = { 'boujot': './bin/happy.mjs', 'boujot-mcp': './bin/happy-mcp.mjs' };
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "Building..."
npx tsc --noEmit && npx pkgroll

echo "Publishing @boujot/happy-coder..."
npm publish --access public $DRY_RUN

# Restore original package.json
mv package.json.bak package.json

echo "Done. package.json restored to original."
