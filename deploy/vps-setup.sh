#!/usr/bin/env bash
# Deploy Cashfra to an Ubuntu/Debian VPS. Safe to re-run: first install and
# every later update take the same path.
#
#     sudo bash deploy/vps-setup.sh [source-dir] [domain]
#
# source-dir defaults to the repo this script sits in, domain to cashfra.com.
# Point the domain's A record at this server BEFORE running it — the script
# checks, and certbot cannot issue a certificate until that resolves.
set -euo pipefail

SRC=${1:-"$(cd "$(dirname "$0")/.." && pwd)"}
DOMAIN=${2:-cashfra.com}
ROOT=/var/www/cashfra
SITE=/etc/nginx/sites-available/cashfra

[ "$(id -u)" = 0 ] || { echo "run this with sudo" >&2; exit 1; }
for f in index.html manifest.json sw.js favicon.ico robots.txt deploy/nginx.conf; do
  [ -e "$SRC/$f" ] || { echo "$SRC/$f is missing — is $SRC the unpacked app?" >&2; exit 1; }
done
[ -d "$SRC/icons" ] || { echo "$SRC/icons is missing" >&2; exit 1; }

BUILD=$(sed -n "s/^var BUILD = '\(.*\)';$/\1/p" "$SRC/sw.js")
echo "==> Cashfra build $BUILD -> https://$DOMAIN"

# ── is port 80 free, or nginx's? ────────────────────────────────────────────
if command -v ss >/dev/null; then
  holder=$(ss -tlnp 2>/dev/null | awk '$4 ~ /:80$/ {print; exit}' || true)
  if [ -n "$holder" ] && ! printf '%s' "$holder" | grep -q nginx; then
    echo "!!  something other than nginx already listens on port 80:"
    echo "    $holder"
    echo "    nginx cannot start behind it. Stop that service, or put cashfra.com"
    echo "    behind whatever is already there, and run this again."
    exit 1
  fi
fi

# ── packages ────────────────────────────────────────────────────────────────
if ! command -v nginx >/dev/null || ! command -v certbot >/dev/null; then
  echo "==> installing nginx + certbot"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx certbot python3-certbot-nginx curl >/dev/null
fi

# ── is the domain actually pointed here? ───────────────────────────────────
here=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
there=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)
if [ -n "$there" ] && [ "$there" != "$here" ]; then
  echo "!!  $DOMAIN resolves to $there but this server is $here."
  echo "    Fix the A record first, or certbot will fail to issue a certificate."
  printf '    Continue anyway (no TLS will be issued)? (y/N) '; read -r a
  [ "$a" = y ] || exit 1
  SKIP_TLS=1
elif [ -z "$there" ]; then
  echo "!!  $DOMAIN does not resolve yet — DNS may still be propagating."
  SKIP_TLS=1
fi

# ── files: build beside the live copy, then swap, keeping a rollback ───────
echo "==> publishing to $ROOT"
NEW=$(mktemp -d /var/www/.cashfra-new-XXXXXX)
cp -a "$SRC/index.html" "$SRC/manifest.json" "$SRC/sw.js" "$SRC/favicon.ico" \
      "$SRC/robots.txt" "$SRC/icons" "$NEW/"
[ -f "$SRC/.htaccess" ] || true          # apache-only; nginx does not need it
chown -R www-data:www-data "$NEW"
find "$NEW" -type d -exec chmod 755 {} +
find "$NEW" -type f -exec chmod 644 {} +
if [ -d "$ROOT" ]; then
  rm -rf "$ROOT.prev"
  mv "$ROOT" "$ROOT.prev"               # previous build stays for rollback
fi
mv "$NEW" "$ROOT"

# ── nginx ───────────────────────────────────────────────────────────────────
if [ ! -f "$SITE" ]; then
  echo "==> installing the nginx site"
  cp "$SRC/deploy/nginx.conf" "$SITE"
  sed -i "s/cashfra\.com/$DOMAIN/g; s/www\.$DOMAIN/www.$DOMAIN/g" "$SITE"
  ln -sf "$SITE" /etc/nginx/sites-enabled/cashfra
  rm -f /etc/nginx/sites-enabled/default
else
  echo "==> nginx site already installed, leaving it alone (certbot has edited it)"
fi
nginx -t
systemctl reload nginx

# ── TLS ─────────────────────────────────────────────────────────────────────
if [ -z "${SKIP_TLS:-}" ] && [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "==> requesting a certificate (answer certbot's prompts)"
  certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --redirect || {
    echo "!!  certbot failed. The app is up on http://$DOMAIN but a service worker"
    echo "    will not register without https, so there is no offline and no install."
    echo "    Fix DNS, then: certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect"
  }
fi

# ── did it actually work? ───────────────────────────────────────────────────
echo
echo "==> checking https://$DOMAIN"
say() { printf '    %-26s %s\n' "$1" "$2"; }
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/" 2>/dev/null || echo 000)
say "page"        "$code$([ "$code" = 200 ] && echo '  ok' || echo '  not 200 — see: journalctl -u nginx -n 40')"
hdr=$(curl -sSI --max-time 15 "https://$DOMAIN/sw.js" 2>/dev/null || true)
say "sw.js cache" "$(echo "$hdr" | grep -qi 'cache-control:.*no-cache' && echo 'no-cache  ok' || echo 'MISSING — updates will stall')"
say "noindex"     "$(curl -sSI --max-time 15 "https://$DOMAIN/" 2>/dev/null | grep -qi 'x-robots-tag' && echo 'set  ok' || echo 'missing')"
say "build live"  "$(curl -sS --max-time 15 "https://$DOMAIN/sw.js" 2>/dev/null | grep -q "var BUILD = '$BUILD';" && echo "$BUILD  ok" || echo 'old build still served')"
echo
echo "    Open https://$DOMAIN/ and unlock with 162007, then change the code in Settings."
if [ -d "$ROOT.prev" ]; then
  echo "    Rollback to the previous build:"
  echo "      rm -rf $ROOT && mv $ROOT.prev $ROOT && systemctl reload nginx"
fi
