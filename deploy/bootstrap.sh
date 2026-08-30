#!/usr/bin/env bash
# One paste, start to finish: give this server read access to the repo, clone
# it, deploy it. Safe to run again — it picks up wherever it left off.
#
#   bash /root/cashfra-bootstrap.sh
set -euo pipefail

REPO=${REPO:-fourtisf/cashfra}
BRANCH=${BRANCH:-claude/new-session-ct09rd}
DOMAIN=${DOMAIN:-cashfra.com}
DIR=${DIR:-/opt/cashfra}
ALIAS=github-cashfra
KEY=$HOME/.ssh/cashfra_deploy

[ "$(id -u)" = 0 ] || { echo "run this as root" >&2; exit 1; }
[ -t 0 ] || { echo "run this from a file, not by pasting the script into the shell:" >&2
              echo "  bash /root/cashfra-bootstrap.sh" >&2; exit 1; }

command -v git >/dev/null || { echo "==> installing git"; apt-get update -qq; apt-get install -y -qq git; }

mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
[ -f "$KEY" ] || { echo "==> making a key for this server"; ssh-keygen -t ed25519 -C cashfra-vps -f "$KEY" -N '' >/dev/null; }
grep -q "Host $ALIAS" "$HOME/.ssh/config" 2>/dev/null || \
  printf '\nHost %s\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$ALIAS" "$KEY" >> "$HOME/.ssh/config"
chmod 600 "$HOME/.ssh/config"

github_knows_us() {
  ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -T "git@$ALIAS" 2>&1 |
    grep -q 'successfully authenticated'
}

# The one step that cannot be automated: the key has to be pasted into GitHub.
# So stop here and wait for it, instead of failing three commands later.
while ! github_knows_us; do
  echo
  echo '  ===================== COPY THE WHOLE LINE BELOW ====================='
  echo
  cat "$KEY.pub"
  echo
  echo '  ===================================================================='
  echo
  echo "  1.  open   https://github.com/$REPO/settings/keys"
  echo '  2.  click  Add deploy key       title: cashfra-vps'
  echo '  3.  paste the line above, leave "Allow write access" UNCHECKED, Add key'
  echo
  read -r -p '  press Enter once it is saved (Ctrl-C to give up) ' _
  echo '  checking...'
done
echo "==> GitHub recognises this server"

if [ -d "$DIR/.git" ]; then
  echo "==> updating $DIR"
  git -C "$DIR" remote set-url origin "git@$ALIAS:$REPO.git"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  echo "==> cloning into $DIR"
  rm -rf "$DIR"
  git clone --quiet --branch "$BRANCH" --single-branch "git@$ALIAS:$REPO.git" "$DIR"
fi

echo
exec bash "$DIR/deploy/vps-setup.sh" "$DIR" "$DOMAIN"
