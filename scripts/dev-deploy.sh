#!/bin/bash
# dev-deploy.sh — Build happy-cli and deploy to the globally installed @boujot location.
#
# Usage: yarn dev:deploy
#
# No rebrand needed — runtime flavor detection handles branding automatically.
# When the built code runs from a @boujot/* install path, it detects
# the '@boujot' in its own path and activates boujot branding.
#
# This enables the modify → build → test → fix cycle without committing
# or switching branches. Your working tree is preserved exactly as-is.
set -e

cd "$(dirname "$0")/.."

# Find installed @boujot package (supports @boujot/happy-coder, @boujot/happy-cli, @boujot/cli)
if [ -d "/opt/homebrew/lib/node_modules/@boujot/happy-coder" ]; then
    INSTALL_DIR="/opt/homebrew/lib/node_modules/@boujot/happy-coder/dist"
elif [ -d "/opt/homebrew/lib/node_modules/@boujot/happy-cli" ]; then
    INSTALL_DIR="/opt/homebrew/lib/node_modules/@boujot/happy-cli/dist"
elif [ -d "/opt/homebrew/lib/node_modules/@boujot/cli" ]; then
    INSTALL_DIR="/opt/homebrew/lib/node_modules/@boujot/cli/dist"
else
    echo "Error: No @boujot package found globally."
    echo "Install it first: npm install -g @boujot/happy-coder"
    exit 1
fi

echo "Building and deploying to $INSTALL_DIR..."

npx tsc --noEmit && npx pkgroll
cp -r dist/* "$INSTALL_DIR/"

echo "Deployed to $INSTALL_DIR"
echo ""
echo "Next: restart the daemon to pick up changes:"
echo "  ./bin/happy.mjs daemon stop && ./bin/happy.mjs daemon start"
