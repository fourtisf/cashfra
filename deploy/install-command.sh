#!/usr/bin/env bash
# Install the `cashfra-deploy` command on this server, so deploying is one
# word instead of a path nobody remembers. Safe to re-run.
#
#     sudo bash /opt/cashfra/deploy/install-command.sh
#
# The wrapper hard-codes the clone path on purpose. vps-update.sh works out
# which repo to deploy from where the script itself sits, so a symlink in
# /usr/local/bin would make it look for the app in /usr/local and fail.
set -euo pipefail

DIR=${1:-/opt/cashfra}
DOMAIN=${2:-cashfra.com}
BIN=/usr/local/bin/cashfra-deploy

[ "$(id -u)" = 0 ] || { echo "run this with sudo" >&2; exit 1; }
[ -x "$DIR/deploy/vps-update.sh" ] || {
  echo "$DIR/deploy/vps-update.sh is not there — is $DIR the clone?" >&2; exit 1; }

cat > "$BIN" <<EOF
#!/usr/bin/env bash
# Deploy Cashfra: pull main, publish, check. Installed by deploy/install-command.sh.
exec bash $DIR/deploy/vps-update.sh $DIR $DOMAIN
EOF
chmod +x "$BIN"

echo "==> installed $BIN -> $DIR (for $DOMAIN)"
echo "    deploy from now on with:  cashfra-deploy"
