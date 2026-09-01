#!/usr/bin/env sh
# Every check in the repo, in one command.
#
#     ./run-tests.sh
#
# The first suite needs nothing at all — no browser, no server, no npm — so it
# runs everywhere, including on the VPS before a deploy. The rest need
# Playwright; if it is not installed they are skipped and said to be skipped,
# rather than quietly not running.
#
# Prints the failures and each suite's own total. Exit 0 means all of it passed.
set -u
cd "$(dirname "$0")"

PORT=${PORT:-8123}
BROWSER_SUITES='smoke rates features analytics landing rules brands'
OWN_SERVER_SUITES='update sync code-login'
fail=0
out=$(mktemp)
trap 'rm -f "$out"; [ -n "${web:-}" ] && kill "$web" 2>/dev/null; exit' EXIT INT TERM

run() {
  name=$1; shift
  if "$@" >"$out" 2>&1; then
    printf '  ok    %-12s %s\n' "$name" "$(grep -c '  PASS  ' "$out") checks"
  else
    fail=1
    printf '  FAIL  %-12s\n' "$name"
    grep -E '  (FAIL|CRASH)  ' "$out" | sed 's/^/      /'
  fi
}

echo "== no dependencies"
run deletes node test/deletes.mjs

if [ ! -d test/node_modules/playwright ]; then
  echo
  echo "== browser suites SKIPPED — Playwright is not installed."
  echo "   cd test && npm install && npx playwright install chromium"
  exit $fail
fi

echo
echo "== browser (dev server on :$PORT)"
python3 dev-server.py "$PORT" >/dev/null 2>&1 &
web=$!
sleep 1
for t in $BROWSER_SUITES; do
  BASE="http://127.0.0.1:$PORT/" run "$t" node "test/$t.mjs"
done
kill "$web" 2>/dev/null; web=

echo
echo "== bring their own server"
for t in $OWN_SERVER_SUITES; do run "$t" node "test/$t.mjs"; done

echo
[ "$fail" = 0 ] && echo "all green" || echo "something is failing — see above"
exit $fail
