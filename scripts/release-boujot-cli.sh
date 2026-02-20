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
  - For publishing, ensure you're authenticated to npm (e.g. `npm whoami`) or provide a token:
    - NPM_TOKEN (preferred)
    - NPM_GRANULAR_ACCESS_TOKEN (will be mapped to NPM_TOKEN)
    - If packages/happy-cli/.env contains NPM_GRANULAR_ACCESS_TOKEN=..., this script will read it.
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

read_dotenv_value() {
  # Read KEY=VALUE from a dotenv-like file without executing it.
  # Supports optional surrounding quotes on the value.
  # Usage: read_dotenv_value <file> <key>
  local file="$1"
  local key="$2"
  if [[ ! -f "$file" ]]; then
    return 1
  fi

  local line=""
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | head -n 1 || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi

  local val="${line#*=}"
  # Trim whitespace
  val="$(echo "$val" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  # Trim optional surrounding quotes
  val="$(echo "$val" | sed -E 's/^"(.+)"$/\\1/; s/^'\''(.+)'\''$/\\1/')"
  if [[ -z "$val" ]]; then
    return 1
  fi
  echo "$val"
}

ensure_npm_token() {
  # Prefer NPM_TOKEN; fall back to NPM_GRANULAR_ACCESS_TOKEN or .env.
  if [[ -n "${NPM_TOKEN:-}" ]]; then
    return 0
  fi
  if [[ -n "${NPM_GRANULAR_ACCESS_TOKEN:-}" ]]; then
    export NPM_TOKEN="$NPM_GRANULAR_ACCESS_TOKEN"
    return 0
  fi

  local dotenv="$CLI_DIR/.env"
  local tok=""
  tok="$(read_dotenv_value "$dotenv" "NPM_TOKEN" || true)"
  if [[ -n "$tok" ]]; then
    export NPM_TOKEN="$tok"
    return 0
  fi
  tok="$(read_dotenv_value "$dotenv" "NPM_GRANULAR_ACCESS_TOKEN" || true)"
  if [[ -n "$tok" ]]; then
    export NPM_TOKEN="$tok"
    return 0
  fi
  return 1
}

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
git commit -m "release: @boujot/happy-coder $VERSION (rebrand from $BASE_BRANCH@$BASE_SHA)" >/dev/null

echo
echo "Release commit created on $RELEASE_BRANCH:"
git log --oneline -1
echo

PUBLISH_CMD="(cd \"$CLI_DIR\" && npm publish --access public --tag $TAG)"
if [[ "$DO_PUBLISH" == "1" ]]; then
  echo "Publishing..."
  if ensure_npm_token; then
    tmpcfg="$(mktemp -t npmrc-boujot-release.XXXXXX)"
    cleanup() {
      rm -f "$tmpcfg"
    }
    trap cleanup EXIT

    # Avoid printing the token.
    printf "//registry.npmjs.org/:_authToken=%s\n" "$NPM_TOKEN" >"$tmpcfg"
    (cd "$CLI_DIR" && npm --userconfig "$tmpcfg" publish --access public --tag "$TAG")
  else
    # Fall back to the user's existing npm login/session.
    eval "$PUBLISH_CMD"
  fi
else
  echo "Not publishing (dry run). To publish, run:"
  echo "  $PUBLISH_CMD"
  echo
  echo "Or rerun this script with --publish."
fi
