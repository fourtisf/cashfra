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
BROWSER_SUITES='smoke rates features analytics landing rules brands shill'
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
    if grep -qE '  (FAIL|CRASH)  ' "$out"; then
      grep -E '  (FAIL|CRASH)  ' "$out" | sed 's/^/      /'
    else
      # It exited non-zero without reporting a failed check, so it died before
      # it could — a crash, a bad import, a browser that would not start. The
      # grep printed nothing at all for that, which is a failure you cannot
      # act on; the last lines of its output are all there is to go on.
      echo "      (no check failed \u2014 the suite itself died. last lines:)"
      tail -8 "$out" | sed 's/^/      /'
    fi
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
# Something else on the port is the worst kind of green: our server fails to
# bind, exits, and every suite quietly tests whatever IS answering there —
# another checkout, a stale server from an earlier run — while reporting on
# this one. Refuse instead of guessing which it was.
if python3 -c "import socket,sys; sys.exit(0 if socket.socket().connect_ex(('127.0.0.1',$PORT))==0 else 1)" 2>/dev/null; then
  echo "  FAIL  :$PORT is already serving something else."
  echo "        Stop it, or run: PORT=8124 ./run-tests.sh"
  exit 1
fi
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
