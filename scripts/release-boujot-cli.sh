#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/release-boujot-cli.sh <version> [--tag <beta|latest>] [--skip-test] [--skip-build] [--publish]

What it does:
  - Requires a clean git working tree
  - Creates a release branch from current HEAD:
      boujot-cli-release/<version>
  - Bumps packages/happy-cli/package.json version to <version>
  - Runs: yarn rebrand
  - Optionally runs: npm run build, npm test
  - Commits the rebrand output with a traceable message
  - Optionally runs: npm publish --access public --tag <tag>

Notes:
  - This script is intended to be run on the non-rebranded source branch (usually `master`).
  - It will NOT push to any remote.
  - For publishing, ensure you're authenticated to npm (e.g. `npm whoami`) or provide NPM_TOKEN.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

VERSION="$1"
shift

TAG="beta"
SKIP_TEST="0"
SKIP_BUILD="0"
DO_PUBLISH="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --skip-test)
      SKIP_TEST="1"
      shift
      ;;
    --skip-build)
      SKIP_BUILD="1"
      shift
      ;;
    --publish)
      DO_PUBLISH="1"
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$TAG" != "beta" && "$TAG" != "latest" ]]; then
  echo "Invalid --tag: $TAG (expected beta|latest)" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
CLI_DIR="$REPO_ROOT/packages/happy-cli"

if [[ ! -d "$CLI_DIR" ]]; then
  echo "Expected CLI dir at: $CLI_DIR" >&2
  exit 1
fi

cd "$REPO_ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit/stash changes before releasing." >&2
  git status --short
  exit 1
fi

BASE_BRANCH="$(git branch --show-current)"
BASE_SHA="$(git rev-parse --short HEAD)"

RELEASE_BRANCH="boujot-cli-release/$VERSION"

if git show-ref --verify --quiet "refs/heads/$RELEASE_BRANCH"; then
  echo "Branch already exists: $RELEASE_BRANCH" >&2
  exit 1
fi

echo "Base branch: $BASE_BRANCH"
echo "Base commit: $BASE_SHA"
echo "Release branch: $RELEASE_BRANCH"
echo "Version: $VERSION"
echo "Publish tag: $TAG"

git checkout -b "$RELEASE_BRANCH"

cd "$CLI_DIR"

echo "Bumping version..."
npm version "$VERSION" --no-git-tag-version >/dev/null

echo "Rebranding..."
yarn rebrand >/dev/null

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "Building..."
  npm run build
else
  echo "Skipping build."
fi

if [[ "$SKIP_TEST" != "1" ]]; then
  echo "Testing..."
  npm test
else
  echo "Skipping tests."
fi

cd "$REPO_ROOT"

git add -A "$CLI_DIR"
git commit -m "release: @boujot/cli $VERSION (rebrand from $BASE_BRANCH@$BASE_SHA)" >/dev/null

echo
echo "Release commit created on $RELEASE_BRANCH:"
git log --oneline -1
echo

PUBLISH_CMD="(cd \"$CLI_DIR\" && npm publish --access public --tag $TAG)"
if [[ "$DO_PUBLISH" == "1" ]]; then
  echo "Publishing..."
  eval "$PUBLISH_CMD"
else
  echo "Not publishing (dry run). To publish, run:"
  echo "  $PUBLISH_CMD"
  echo
  echo "Or rerun this script with --publish."
fi

