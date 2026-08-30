#!/usr/bin/env bash
# Upload Cashfra to Hostinger over FTPS, from bash (WSL, Git Bash, macOS, Linux).
#
#   FTP_PASS='...' ./deploy/upload-ftp.sh <ftp-host> <ftp-user> [domain]
#
# Leave FTP_PASS unset and it prompts. Only the files listed below are sent, so
# running this from the repo root never pushes README.md, test/ or .git.
set -eu

FTP_HOST=${1:?usage: upload-ftp.sh <ftp-host> <ftp-user> [domain]}
FTP_USER=${2:?usage: upload-ftp.sh <ftp-host> <ftp-user> [domain]}
DOMAIN=${3:-cashfra.com}
REMOTE=${REMOTE:-public_html}

FILES="index.html manifest.json sw.js favicon.ico robots.txt .htaccess"

for f in $FILES; do
  [ -f "$f" ] || { echo "$f is not here — run this from the folder holding index.html" >&2; exit 1; }
done
[ -d icons ] || { echo "icons/ is not here" >&2; exit 1; }

local_build=$(sed -n "s/^var BUILD = '\(.*\)';$/\1/p" sw.js)
live_build=$(curl -sS --max-time 15 "https://$DOMAIN/sw.js" 2>/dev/null |
             sed -n "s/^var BUILD = '\(.*\)';$/\1/p" || true)
if [ -n "${live_build:-}" ] && [ "$live_build" = "$local_build" ]; then
  echo "Build $local_build is already live. Run ./bump-version.sh first, or this"
  echo "deploy will not reach copies already installed on a phone."
  printf 'Upload anyway? (y/N) '; read -r a
  [ "$a" = y ] || exit 1
fi

if [ -z "${FTP_PASS:-}" ]; then
  printf 'FTP password for %s: ' "$FTP_USER"
  stty -echo 2>/dev/null || true; read -r FTP_PASS; stty echo 2>/dev/null || true; echo
fi

send() {
  if ! curl -sS --ssl-reqd --ftp-create-dirs -u "$FTP_USER:$FTP_PASS" -T "$1" "ftp://$FTP_HOST/$REMOTE/$2"; then
    echo >&2
    echo "  FAILED on $2" >&2
    echo "  Check the host, username and password under hPanel -> Files -> FTP Accounts." >&2
    echo "  On a certificate error, Hostinger's FTP cert does not match the host you" >&2
    echo "  passed: use the server name hPanel shows, or deploy over SSH instead." >&2
    exit 1
  fi
  echo "  sent  $2"
}

echo "Uploading build $local_build to $DOMAIN ..."
for f in $FILES; do send "$f" "$f"; done
for f in icons/*; do send "$f" "$f"; done

echo
echo "Checking $DOMAIN ..."
code=$(curl -sS -o /dev/null -w '%{http_code}' "https://$DOMAIN/")
echo "  https://$DOMAIN/         $code$([ "$code" = 200 ] && echo ' ok' || echo '  NOT 200 — check SSL and the document root in hPanel')"
curl -sSI "https://$DOMAIN/sw.js" | grep -qi 'cache-control:.*no-cache' \
  && echo '  sw.js cache-control     no-cache — good' \
  || echo '  sw.js cache-control     MISSING — .htaccess did not upload; updates will stall'
curl -sSI "https://$DOMAIN/" | grep -qi 'x-robots-tag' \
  && echo '  noindex header          set' \
  || echo '  noindex header          missing — .htaccess did not upload'
curl -sS "https://$DOMAIN/sw.js" | grep -q "var BUILD = '$local_build';" \
  && echo "  build live              $local_build" \
  || echo '  build live              still the old build — clear the browser cache and re-check'

echo
echo "Open https://$DOMAIN/ and unlock with 162007, then change the code in Settings."
