#!/usr/bin/env bash
# Turn on ledger sync for Cashfra: one small service on ALFA's own VPS, so the
# phone and the laptop show the same book. Safe to re-run — a second run
# updates the service and prints the same token back.
#
#     sudo ALLOW=you@gmail.com bash deploy/vps-sync-setup.sh [domain]
#
# ALLOW is the list of addresses that may sign in, comma separated. There is
# no sign-up: an address not on it is turned away. On a re-run the list, the
# mail settings and the port are all read back from the installed service, so
# a plain `sudo bash deploy/vps-sync-setup.sh` keeps everything as it was.
#
# To send the codes through Gmail, add an app password (myaccount.google.com ->
# Security -> App passwords — the normal password will not work):
#
#     sudo ALLOW=you@gmail.com MAIL_MODE=smtp SMTP_HOST=smtp.gmail.com \
#          SMTP_USER=you@gmail.com SMTP_PASS='abcd efgh ijkl mnop' \
#          bash deploy/vps-sync-setup.sh
#
# With no mail settings the code is written to /var/lib/cashfra/outbox instead
# of sent. That is a working way in over SSH, not a finished setup.
#
# The port is picked from what is free — this box runs other things too — or
# set PORT=8790 to name one. Run deploy/vps-setup.sh first: this script edits
# the nginx site that one installs.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN=${1:-cashfra.com}
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

# ── who may sign in, and how the code reaches them ──────────────────────────
# A re-run with no arguments must not quietly wipe the settings, so anything
# not given is read back out of the unit file that is already installed.
from_unit(){ [ -f "$UNIT" ] && sed -n "s/^Environment=$1=\\(.*\\)$/\\1/p" "$UNIT" | head -1 || true; }
ALLOW=${ALLOW:-$(from_unit ALLOW)}
MAIL_MODE=${MAIL_MODE:-$(from_unit MAIL_MODE)}
SMTP_HOST=${SMTP_HOST:-$(from_unit SMTP_HOST)}
SMTP_PORT=${SMTP_PORT:-$(from_unit SMTP_PORT)}
SMTP_USER=${SMTP_USER:-$(from_unit SMTP_USER)}
SMTP_PASS=${SMTP_PASS:-$(from_unit SMTP_PASS)}
RESEND_KEY=${RESEND_KEY:-$(from_unit RESEND_KEY)}
MAIL_FROM=${MAIL_FROM:-$(from_unit MAIL_FROM)}

if [ -z "$ALLOW" ]; then
  echo
  echo "Which email address should be able to sign in?"
  echo "(several: separate them with commas. Nobody else can get in.)"
  printf '  > '; read -r ALLOW
fi
ALLOW=$(printf '%s' "$ALLOW" | tr -d '[:space:]')
case "$ALLOW" in
  *@*.*) : ;;
  *) echo "that does not look like an email address: $ALLOW" >&2; exit 1 ;;
esac

if [ -n "$SMTP_HOST" ] && [ -n "$SMTP_USER" ] && [ -n "$SMTP_PASS" ]; then
  MAIL_MODE=smtp
elif [ -n "$RESEND_KEY" ]; then
  MAIL_MODE=resend
else
  MAIL_MODE=file
fi
MAIL_FROM=${MAIL_FROM:-${SMTP_USER:-cashfra@$DOMAIN}}
SMTP_PORT=${SMTP_PORT:-465}

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
Environment=ALLOW=$ALLOW
Environment=MAIL_MODE=$MAIL_MODE
Environment=MAIL_FROM=$MAIL_FROM
Environment=SMTP_HOST=$SMTP_HOST
Environment=SMTP_PORT=$SMTP_PORT
Environment=SMTP_USER=$SMTP_USER
Environment=SMTP_PASS=$SMTP_PASS
Environment=RESEND_KEY=$RESEND_KEY
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
location ^~ /sync {
    # a token must never cross the wire in the clear, and certbot leaves a
    # plain :80 block behind that this snippet is also included in
    if (\$scheme != "https") { return 301 https://\$host\$request_uri; }
    # no trailing slash: the whole path goes through, and the service strips
    # its own mount point, so /sync and /sync/auth/start both land right
    proxy_pass http://127.0.0.1:$PORT;
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
say() { printf '    %-24s %s\n' "$1" "$2"; }
code(){ curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || echo 000; }
JSON='Content-Type: application/json'

# a token nobody was issued must be refused, and an address nobody allowed too
badtok=$(code -H "X-Cashfra-Token: never_issued_aaaaaa" "https://$DOMAIN/sync")
badmail=$(code -X POST -H "$JSON" -d '{"email":"nobody@example.invalid"}' "https://$DOMAIN/sync/auth/start")
say "an unknown token"  "$badtok$([ "$badtok" = 401 ] && echo '  refused, ok' || echo '  expected 401')"
say "an unknown address" "$badmail$([ "$badmail" = 403 ] && echo '  refused, ok' || echo '  expected 403')"

if [ "$badtok" != 401 ] || [ "$badmail" != 403 ]; then
  echo
  echo "!!  /sync is not answering as the sync service. Do NOT sign in yet —"
  echo "    it would fail, or worse, look like it worked."
  echo
  echo "    Straight at the service, bypassing nginx (expect 401 then 403):"
  d1=$(code -H "X-Cashfra-Token: never_issued_aaaaaa" "http://127.0.0.1:$PORT/")
  d2=$(code -X POST -H "$JSON" -d '{"email":"nobody@example.invalid"}' "http://127.0.0.1:$PORT/auth/start")
  say "  direct, token"   "$d1"
  say "  direct, address" "$d2"
  echo
  if [ "$d1" = 401 ] && [ "$d2" = 403 ]; then
    echo "    The service is fine on 127.0.0.1:$PORT, so nginx is not routing /sync"
    echo "    to it — the include did not land in the block serving $DOMAIN over"
    echo "    https. Find where it went:"
    echo
    echo "      grep -n 'listen\\|server_name\\|cashfra-sync' /etc/nginx/sites-available/cashfra"
    echo "      curl -s https://$DOMAIN/sync | head -c 120"
    echo
    echo "    HTML from that second line means nginx is still serving the app there."
  else
    echo "    The service is not answering on 127.0.0.1:$PORT either:"
    journalctl -u cashfra-sync -n 15 --no-pager
  fi
  exit 1
fi

echo
echo "    Sign in on every device: Menu -> Settings -> Sign in"
echo
echo "      Server   https://$DOMAIN/sync   (already filled in for you)"
echo "      Email    ${ALLOW%%,*}"
echo
echo "    A six-digit code arrives by email; it lasts ten minutes. Every device"
echo "    signed in to the same address shares one book."
echo "    Your app access code is NOT part of what syncs — each device keeps its own."
echo
if [ "$MAIL_MODE" = file ]; then
  echo "!!  No mail is configured, so codes are NOT being sent. They are written to"
  echo "    $DATA/outbox instead — readable over SSH, which is a way in but not a"
  echo "    finished setup. To send them through Gmail, make an app password at"
  echo "    myaccount.google.com -> Security -> App passwords, then re-run:"
  echo
  echo "      sudo MAIL_MODE=smtp SMTP_HOST=smtp.gmail.com \\"
  echo "           SMTP_USER=${ALLOW%%,*} SMTP_PASS='the app password' \\"
  echo "           bash $0"
  echo
  echo "    Read a code meanwhile:  sudo cat $DATA/outbox/*.txt"
else
  echo "    Mail goes out over $MAIL_MODE as $MAIL_FROM."
fi
echo "    Who may sign in:      $ALLOW  (re-run with ALLOW=... to change)"
echo "    Lost a device:        sudo -u cashfra node $LIB/sync-server.js --rotate ${ALLOW%%,*}"
echo "                          Moves the book to a new token, so the lost device is"
echo "                          locked out and the others sign in again. Nothing is lost."
echo "    Logs:                 journalctl -u cashfra-sync -f"
