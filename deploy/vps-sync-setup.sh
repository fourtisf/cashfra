#!/usr/bin/env bash
# Turn on ledger sync for Cashfra: one small service on ALFA's own VPS, so the
# phone and the laptop show the same book. Safe to re-run — a second run
# updates the service and prints the same token back.
#
#     sudo bash deploy/vps-sync-setup.sh [domain] [access-code]
#
# The access code IS the login. Type it on any phone or laptop and the book is
# there; type it wrong and there is no way in. It defaults to 162007, which is
# also what a fresh app seeds — so with no arguments at all this just works.
#
# The code is never stored here. What is stored is 200,000 rounds of PBKDF2
# over it, the same value the app computes in the browser, which cannot be
# turned back into the code.
#
# The port is picked from what is free — this box runs other things too — or
# set PORT=8790 to name one. Run deploy/vps-setup.sh first: this script edits
# the nginx site that one installs.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN=${1:-cashfra.com}
CODE=${2:-${CODE:-162007}}
DATA=/var/lib/cashfra
LIB=/usr/local/lib/cashfra
SITE=/etc/nginx/sites-available/cashfra
SNIP=/etc/nginx/snippets/cashfra-sync.conf
UNIT=/etc/systemd/system/cashfra-sync.service

[ "$(id -u)" = 0 ] || { echo "run this with sudo" >&2; exit 1; }
[ -f "$SRC/deploy/sync-server.js" ] || { echo "$SRC/deploy/sync-server.js is missing" >&2; exit 1; }
[ -f "$SITE" ] || { echo "$SITE is missing — run deploy/vps-setup.sh first" >&2; exit 1; }

if ! command -v node >/dev/null; then
  echo "==> installing node"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
fi
command -v node >/dev/null || { echo "node is still missing — install it and re-run" >&2; exit 1; }

# ── a port that is actually free ────────────────────────────────────────────
# The first run of this script assumed 8787 was ours to take. On a box that
# also runs PM2 and a code server it was not, and the service died on start
# with EADDRINUSE — so ask first, the way vps-setup.sh asks about port 80.
# Ask by binding it, exactly as the service will. Reading `ss` would be neater
# but it is not on every box, and a check that quietly answers "free" when the
# tool is missing is worse than no check at all — it repeats the same failure.
inuse(){
  node -e '
    var s=require("net").createServer();
    s.once("error",function(){process.exit(0);});                 /* taken */
    s.once("listening",function(){s.close(function(){process.exit(1);});});
    s.listen(+process.argv[1],"127.0.0.1");
  ' "$1"
}
holder(){
  command -v ss >/dev/null || { echo "another program"; return; }
  ss -tlnp 2>/dev/null | awk -v p=":$1\$" 'NR>1 && $4 ~ p {print $NF; exit}' | grep . || echo "another program"
}

# Our own service holds the port on a re-run, and that is not a conflict — so
# stand it down while we look. If this script then bails for any reason, put
# back what was running: a failed re-run must not leave sync switched off.
WAS_ACTIVE=0
systemctl is-active --quiet cashfra-sync 2>/dev/null && WAS_ACTIVE=1 || true
restore(){ [ "$WAS_ACTIVE" = 1 ] && systemctl start cashfra-sync 2>/dev/null || true; }
trap restore EXIT
systemctl stop cashfra-sync 2>/dev/null || true
WANT=${PORT:-}
if [ -z "$WANT" ] && [ -f "$UNIT" ]; then
  WANT=$(sed -n 's/^Environment=PORT=\([0-9]\+\)$/\1/p' "$UNIT" | head -1)
fi
if [ -n "$WANT" ] && inuse "$WANT"; then
  echo "!!  port $WANT is taken by $(holder "$WANT")"
  [ -n "${PORT:-}" ] && { echo "    You asked for that one, so nothing was changed." >&2; exit 1; }
  WANT=''
fi
if [ -z "$WANT" ]; then
  for p in $(seq 8787 8799); do
    if ! inuse "$p"; then WANT=$p; break; fi
  done
fi
[ -n "$WANT" ] || { echo "no free port between 8787 and 8799 — pass one: PORT=9123 sudo -E bash $0" >&2; exit 1; }
PORT=$WANT
echo "==> sync will listen on 127.0.0.1:$PORT"

# ── the service runs as its own user and can read nothing else ──────────────
id cashfra >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin cashfra
install -d -m 700 -o cashfra -g cashfra "$DATA"
install -d -m 755 "$LIB"
install -m 644 "$SRC/deploy/sync-server.js" "$LIB/sync-server.js"

# ── the key, made from the access code ──────────────────────────────────────
# The service owns these numbers; asking it rather than repeating them here is
# what stops the two drifting apart and locking ALFA out of his own ledger.
# It also adopts a book left over from an earlier way in, rather than starting
# an empty one beside it.
KEY=$(DATA_DIR="$DATA" node "$LIB/sync-server.js" --ensure "$CODE") || {
  echo "!!  could not set up the book for that access code" >&2; exit 1; }
case "$KEY" in
  [0-9a-f]*) : ;;
  *) echo "could not derive the key from the access code" >&2; exit 1 ;;
esac
chown cashfra:cashfra "$DATA/$KEY.json"; chmod 600 "$DATA/$KEY.json"

# ── systemd ─────────────────────────────────────────────────────────────────
cat > "$UNIT" <<UNIT
[Unit]
Description=Cashfra ledger sync
After=network.target

[Service]
ExecStart=$(command -v node) $LIB/sync-server.js
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=DATA_DIR=$DATA
Environment=ORIGIN=https://$DOMAIN
Environment=ALLOW=
User=cashfra
Group=cashfra
Restart=always
RestartSec=2
# it needs one directory and the loopback, nothing else
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT
chmod 600 "$UNIT"          # it holds a mail password
systemctl daemon-reload
systemctl enable --now cashfra-sync >/dev/null 2>&1 || systemctl enable cashfra-sync >/dev/null
systemctl restart cashfra-sync
sleep 1
trap - EXIT          # the new unit is up; the old one is not coming back
systemctl is-active --quiet cashfra-sync || {
  echo "!!  the sync service did not start:"; journalctl -u cashfra-sync -n 20 --no-pager
  echo
  echo "    If that says EADDRINUSE, something else grabbed port $PORT between"
  echo "    the check above and now. Name a different one and run it again:"
  echo "      PORT=9123 sudo -E bash $0"
  exit 1; }

# ── nginx: one exact location, ahead of every deny rule in the site ────────
install -d -m 755 /etc/nginx/snippets
cat > "$SNIP" <<CONF
# Cashfra ledger sync — written by deploy/vps-sync-setup.sh
location = /sync {
    # a token must never cross the wire in the clear, and certbot leaves a
    # plain :80 block behind that this snippet is also included in
    if (\$scheme != "https") { return 301 https://\$host\$request_uri; }
    # One exact address carries everything — reading, writing and signing in,
    # which arrives as a POST. A prefix would also have to be routed right,
    # and on at least one real server it was not.
    proxy_pass http://127.0.0.1:$PORT/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_read_timeout 30s;
    client_max_body_size 8m;
    add_header Cache-Control "no-store" always;
    add_header X-Robots-Tag  "noindex, nofollow" always;
}
CONF
if grep -q 'cashfra-sync.conf' "$SITE"; then
  echo "==> nginx already routes /sync to 127.0.0.1:$PORT"
else
  echo "==> adding /sync to the nginx site"
  cp "$SITE" "$SITE.bak.$(date +%s)"
  # after each server_name line, so both the :80 and the certbot :443 block get it
  awk '{print} /^[[:space:]]*server_name[[:space:]]/ {print "    include snippets/cashfra-sync.conf;"}' \
      "$SITE" > "$SITE.new" && mv "$SITE.new" "$SITE"
fi
nginx -t
systemctl reload nginx

# ── did it actually work? ───────────────────────────────────────────────────
echo
say() { printf '    %-26s %s\n' "$1" "$2"; }
code(){ curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || echo 000; }

good=$(code -H "X-Cashfra-Token: $KEY" "https://$DOMAIN/sync")
bad=$(code -H "X-Cashfra-Token: 0000000000000000000000000000000000000000000000000000000000000000" "https://$DOMAIN/sync")
say "your access code"  "$good$([ "$good" = 200 ] && echo '  ok' || echo '  expected 200')"
say "a wrong one"       "$bad$([ "$bad" = 401 ] && echo '  refused, ok' || echo '  expected 401')"

if [ "$good" != 200 ] || [ "$bad" != 401 ]; then
  echo
  echo "!!  /sync is not answering as the sync service. Do NOT rely on sync yet —"
  echo "    the app would look like it was working."
  echo
  echo "    Straight at the service, bypassing nginx (expect 200 then 401):"
  say "  direct, your code" "$(code -H "X-Cashfra-Token: $KEY" "http://127.0.0.1:$PORT/")"
  say "  direct, a wrong one" "$(code -H 'X-Cashfra-Token: 0000000000000000' "http://127.0.0.1:$PORT/")"
  echo
  echo "    If those two are right, nginx is not routing /sync. Find where it went:"
  echo "      grep -n 'listen\\|server_name\\|cashfra-sync' /etc/nginx/sites-available/cashfra"
  echo "      curl -s https://$DOMAIN/sync | head -c 120"
  echo "    HTML from that second line means nginx is still serving the app there."
  echo
  echo "    Otherwise the service is down:"
  journalctl -u cashfra-sync -n 12 --no-pager | sed 's/^/      /'
  exit 1
fi

echo
echo "    Done. On every phone and laptop:"
echo
echo "      1. open  https://$DOMAIN/"
echo "      2. type  $CODE"
echo
echo "    That is the whole of it. The same code everywhere means the same book"
echo "    everywhere; a wrong code cannot reach it at all."
echo
echo "    The code never leaves the device — the server holds a one-way scramble"
echo "    of it and could not tell you what the code is."
echo "    Change the code:      in the app, Settings -> App lock -> Change code."
echo "                          The book moves with it; other devices then need the"
echo "                          new code. Do NOT re-run this script to change it."
echo "    Guessing is limited:  20 wrong keys an hour from one address, then blocked."
echo "    Logs:                 journalctl -u cashfra-sync -f"
