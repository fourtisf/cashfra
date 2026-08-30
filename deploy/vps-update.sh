#!/usr/bin/env bash
# Pull the latest build and redeploy. Run on the VPS, in the clone:
#
#     sudo bash /opt/cashfra/deploy/vps-update.sh
#
# The service-worker cache name is bumped in the repo and committed, never
# here — bumping on the server would dirty the checkout and block the next
# fast-forward pull.
set -euo pipefail

DIR=${1:-"$(cd "$(dirname "$0")/.." && pwd)"}
DOMAIN=${2:-cashfra.com}

[ -d "$DIR/.git" ] || { echo "$DIR is not a git checkout" >&2; exit 1; }
cd "$DIR"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "!!  $DIR has local edits. Commit or discard them first:" >&2
  git status --short >&2
  exit 1
fi

was=$(sed -n "s/^var BUILD = '\(.*\)';$/\1/p" sw.js)
echo "==> pulling"
git pull --ff-only
now=$(sed -n "s/^var BUILD = '\(.*\)';$/\1/p" sw.js)

if [ "$was" = "$now" ]; then
  echo "==> build is still $now — nothing new to publish"
  echo "    (deploying anyway is fine, but installed phones already have it)"
else
  echo "==> $was -> $now"
fi

exec bash "$DIR/deploy/vps-setup.sh" "$DIR" "$DOMAIN"
