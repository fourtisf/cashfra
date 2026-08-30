#!/usr/bin/env sh
# Bump the service-worker cache name. Run this before every deploy — the shell
# is served cache-first, so a new cache name is what makes the new build land.
#
#   ./bump-version.sh            -> 2026-08-30-1  (next number for today)
#   ./bump-version.sh 1.4.0      -> that exact string
set -eu

cd "$(dirname "$0")"
SW=sw.js
[ -f "$SW" ] || { echo "no $SW here" >&2; exit 1; }

current=$(sed -n "s/^var BUILD = '\(.*\)';$/\1/p" "$SW")
[ -n "$current" ] || { echo "could not read BUILD from $SW" >&2; exit 1; }

if [ $# -gt 0 ]; then
  next=$1
else
  today=$(date +%Y-%m-%d)
  case "$current" in
    "$today"-*) next="$today-$(( ${current##*-} + 1 ))" ;;
    *)          next="$today-1" ;;
  esac
fi

sed -i.bak "s/^var BUILD = '.*';$/var BUILD = '$next';/" "$SW" && rm -f "$SW.bak"
echo "BUILD $current -> $next"
