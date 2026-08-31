#!/usr/bin/env bash
# Turn on ledger sync for Cashfra: one small service on ALFA's own VPS, so the
# phone and the laptop show the same book. Safe to re-run — a second run
# updates the service and prints the same token back.
#
#     sudo bash deploy/vps-sync-setup.sh [domain] [token]
#
# domain defaults to cashfra.com; leave the token out and one is generated.
# Run deploy/vps-setup.sh first — this script edits the nginx site that one
# installs.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN=${1:-cashfra.com}
TOKEN=${2:-}
DATA=/var/lib/cashfra
LIB=/usr/local/lib/cashfra
SITE=/etc/nginx/sites-available/cashfra
SNIP=/etc/nginx/snippets/cashfra-sync.conf
PORT=8787

[ "$(id -u)" = 0 ] || { echo "run this with sudo" >&2; exit 1; }
[ -f "$SRC/deploy/sync-server.js" ] || { echo "$SRC/deploy/sync-server.js is missing" >&2; exit 1; }
[ -f "$SITE" ] || { echo "$SITE is missing — run deploy/vps-setup.sh first" >&2; exit 1; }

if ! command -v node >/dev/null; then
  echo "==> installing node"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
fi
command -v node >/dev/null || { echo "node is still missing — install it and re-run" >&2; exit 1; }

# ── the service runs as its own user and can read nothing else ──────────────
id cashfra >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin cashfra
install -d -m 700 -o cashfra -g cashfra "$DATA"
install -d -m 755 "$LIB"
install -m 644 "$SRC/deploy/sync-server.js" "$LIB/sync-server.js"

# ── the token: a file in $DATA is an account, and there is no other way in ──
existing=$(find "$DATA" -maxdepth 1 -name '*.json' -printf '%f\n' 2>/dev/null | head -1 || true)
if [ -n "$TOKEN" ]; then
  case "$TOKEN" in
    *[!A-Za-z0-9_-]*|"" ) echo "a token may only use letters, digits, _ and -" >&2; exit 1 ;;
  esac
  [ ${#TOKEN} -ge 16 ] || { echo "a token must be at least 16 characters" >&2; exit 1; }
elif [ -n "$existing" ]; then
  TOKEN=${existing%.json}
  echo "==> reusing the token already on this server"
else
  TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '=+/' | cut -c1-32)
fi
if [ ! -f "$DATA/$TOKEN.json" ]; then
  printf '{"version":0,"at":0,"data":null}' > "$DATA/$TOKEN.json"
  chown cashfra:cashfra "$DATA/$TOKEN.json"; chmod 600 "$DATA/$TOKEN.json"
fi

# ── systemd ─────────────────────────────────────────────────────────────────
cat > /etc/systemd/system/cashfra-sync.service <<UNIT
[Unit]
Description=Cashfra ledger sync
After=network.target

[Service]
ExecStart=$(command -v node) $LIB/sync-server.js
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=DATA_DIR=$DATA
Environment=ORIGIN=https://$DOMAIN
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
systemctl daemon-reload
systemctl enable --now cashfra-sync >/dev/null 2>&1 || systemctl enable cashfra-sync >/dev/null
systemctl restart cashfra-sync
sleep 1
systemctl is-active --quiet cashfra-sync || {
  echo "!!  the sync service did not start:"; journalctl -u cashfra-sync -n 20 --no-pager; exit 1; }

# ── nginx: one exact location, ahead of every deny rule in the site ────────
install -d -m 755 /etc/nginx/snippets
cat > "$SNIP" <<CONF
# Cashfra ledger sync — written by deploy/vps-sync-setup.sh
location = /sync {
    # a token must never cross the wire in the clear, and certbot leaves a
    # plain :80 block behind that this snippet is also included in
    if (\$scheme != "https") { return 301 https://\$host\$request_uri; }
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
  echo "==> nginx already routes /sync"
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
say() { printf '    %-24s %s\n' "$1" "$2"; }
good=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
       -H "X-Cashfra-Token: $TOKEN" "https://$DOMAIN/sync" 2>/dev/null || echo 000)
bad=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
       -H "X-Cashfra-Token: nope_nope_nope_nope" "https://$DOMAIN/sync" 2>/dev/null || echo 000)
say "your token"    "$good$([ "$good" = 200 ] && echo '  ok' || echo '  expected 200')"
say "a wrong token" "$bad$([ "$bad" = 401 ] && echo '  refused, ok' || echo '  expected 401')"
echo
echo "    On every device: Menu -> Settings -> Sync, then enter"
echo
echo "      Server   https://$DOMAIN/sync"
echo "      Token    $TOKEN"
echo
echo "    The access code never leaves the phone — it is not part of what syncs,"
echo "    so each device keeps its own code."
echo "    Another token (a second book):  sudo -u cashfra tee $DATA/<token>.json <<< '{\"version\":0,\"at\":0,\"data\":null}'"
echo "    Revoke one:                     sudo rm $DATA/<token>.json"
echo "    Logs:                           journalctl -u cashfra-sync -f"
