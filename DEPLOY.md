# Deploying Cashfra

The short version, for whoever — or whatever — opens this repo next and needs
the app live. `README.md` explains every path this repo supports; this file
says which one is actually in use and what to type.

## The live setup

| | |
| --- | --- |
| Site | `https://cashfra.com` |
| Host | Ubuntu VPS, nginx + certbot |
| Git clone on the server | `/opt/cashfra` |
| Web root nginx serves | `/var/www/cashfra` |
| Previous build, kept for rollback | `/var/www/cashfra.prev` |
| Branch deployed | `main` |

The server IP is not written down here because this repository is public. It
is the VPS that already has `/opt/cashfra` on it — `ls -d /opt/cashfra`
answers that in one line, and the deploy refuses to run anywhere else.

## Deploying

On the server, from any directory:

```sh
cashfra-deploy
```

That is the whole thing. It pulls `main` from GitHub, publishes to
`/var/www/cashfra`, reloads nginx, and then checks its own work:

```
==> pulling
==> 2026-09-10-17 -> 2026-09-12-1
==> publishing to /var/www/cashfra
==> checking https://cashfra.com
    page            200  ok
    sw.js cache     no-cache  ok
    noindex         set  ok
    build live      2026-09-12-1  ok
```

Four `ok` means it is done. Anything else, read what it says — the script
reports the failure rather than exiting quietly.

`cashfra-deploy` is a small wrapper at `/usr/local/bin/cashfra-deploy` that
runs `deploy/vps-update.sh`. If it is missing on a rebuilt server, reinstall it
with `sudo bash /opt/cashfra/deploy/install-command.sh`.

## Before you deploy: bump the build

The shell is served cache-first by the service worker, so a deploy that does
not change the cache name never reaches a phone that already has the app
installed. **In the repo, not on the server:**

```sh
./bump-version.sh          # 2026-09-12-1 -> 2026-09-12-2
```

Commit that with the change and push. `vps-update.sh` prints the old and new
build so you can see it move; if it says `build is still <same>`, the bump was
forgotten and installed phones will keep the old app.

Never run `bump-version.sh` on the server. It edits tracked files, which dirties
the checkout and blocks the next `git pull --ff-only`.

## Verifying by hand

```sh
curl -sS https://cashfra.com/sw.js | grep BUILD
```

Then open the site and check the actual change. On a phone that already has
Cashfra installed, the new version downloads in the background and takes over
when the app is next backgrounded and reopened — so if the change is not there
yet, close the app fully and open it again before assuming the deploy failed.

## Rolling back

Each deploy builds beside the live copy and swaps, so the build that was live
before the last one is kept — one deep, replaced every time:

```sh
rm -rf /var/www/cashfra && mv /var/www/cashfra.prev /var/www/cashfra && systemctl reload nginx
```

That restores the files only. The repo at `/opt/cashfra` stays where the pull
left it, so the next `cashfra-deploy` will publish the new build again — fix or
revert the commit on `main` first.

## Mistakes that have actually been made here

- **Running `git pull` from `/root`.** There is no repo there. You never need
  to pull by hand; `cashfra-deploy` does it inside `/opt/cashfra`.
- **Running `deploy/upload-ftp.sh` on the VPS.** That script is for Hostinger
  shared hosting, which this site does not use. On this server it does nothing
  useful.
- **Pasting a placeholder path.** `/path/to/cashfra` in an instruction means
  substitute the real one, which is `/opt/cashfra`. Angle brackets like
  `<ftp-host>` are placeholders too, and bash reads them as redirection.
- **Bumping the build on the server.** See above — it blocks the next pull.

## Warnings that are fine to ignore

`duplicate MIME type "text/html"` during the nginx reload. Harmless — nginx
gzips HTML whether or not it is listed. `deploy/nginx.conf` no longer lists it,
but the site file on the server was installed before that and the deploy leaves
it alone on purpose, because certbot has edited it since. To silence it, drop
`text/html` from the `gzip_types` line in `/etc/nginx/sites-enabled/cashfra`,
then `nginx -t && systemctl reload nginx`.

## If the deploy stops with "has local edits"

Something was edited directly on the server, and the script refuses to
fast-forward over it rather than silently discarding it. Look at what it is
before deciding:

```sh
git -C /opt/cashfra status --short
git -C /opt/cashfra diff
```

If it is a real change, it belongs in a commit on `main`, not on the server.
If it is junk, `git -C /opt/cashfra checkout -- .` clears it.

## The other paths

`README.md` documents Hostinger over FTP and a first-time VPS bootstrap. They
work, but neither is what this site runs on today. Use them only when moving
the site somewhere new.
