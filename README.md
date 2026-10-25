<p align="center">
  <img src="public/icon.svg" alt="RaccoonVTT logo" width="128" height="128">
</p>

<h1 align="center">raccoon-vtt</h1>

A self-hosted virtual tabletop for D&D groups playing the 2024 rules
(5.5e), on a square grid. It is made for phones first, and works on
tablets, laptops and a TV at the table too. Every device stays in sync
live. The DM sees everything, and players see only what the fog and the DM
allow.

One server hosts many groups at once. Each room is one campaign, with its
own room ID, player password and DM. Whoever creates a room becomes its DM
through a private DM link. There are no accounts.

- Maps from an image, a blank grid, the built-in map builder, or a
  Universal VTT file from Dungeondraft, Dungeon Alchemist or DungeonFog.
- Fog of war, and party vision with walls, doors, lights, darkvision and
  raised ground.
- Tokens with HP, conditions, elevation and lights. Rulers, movement
  tracking, and areas of effect that count height.
- An initiative tracker, roll requests, an encounter builder, and the SRD
  5.2.1 monsters, conditions and spell areas built in.
- A journal with secrets, map pins, chat and whispers, handouts, an X-card,
  and a table display for a TV.

Dice roll on the server, so everyone sees the same result. Anyone can still
roll real dice and type the total.

One Node 24 process serves the React app, the JSON API and the WebSocket.
Postgres holds the rooms, and uploaded images live on a volume. In
production it runs with Docker Compose behind any HTTPS reverse proxy or
tunnel that passes WebSockets through.

- [docs/design.md](docs/design.md) is the technical design.
- [CREDITS.md](CREDITS.md) lists every piece of third-party art, its source
  and its license. None of the art is AI generated.
- [License](#license): the code is under the GNU AGPL v3.0.

## Features

[FEATURES.md](FEATURES.md) lists what RaccoonVTT does today, grouped by
area, in plain words for the DM and the players. [docs/features.md](docs/features.md)
is the planning list behind it, with what comes next and what was skipped.
Update FEATURES.md in the same change that adds, changes or removes a
feature.

The app lists its written docs on a Docs page at `/docs`, linked from Home.
The [DM guide](docs/dm-guide.md) teaches the DM tools step by step, from a
quick start to building maps, running fights and worked scenarios. Update it
too when a change alters a step it describes.

## Quick start

To try it with nothing but Docker:

```bash
git clone <this repository's URL> raccoon-vtt
cd raccoon-vtt
docker compose up --build raccoon
```

This builds the production image and starts it next to a development
postgres, on http://127.0.0.1:9180. Open exactly that address, not
`localhost`, because the WebSocket checks Origin exactly. Create a room on
the Home page. To see the player's side, copy the player link from the
room's Menu and open it in a private window or another browser. It runs with `NODE_ENV=development`, because
production insists on an https origin. To put it on the internet, follow
[Deploying](#deploying).

## Local development

You need Node 24.7 or later, Docker, and pnpm through corepack
(`corepack enable` once). `package.json` pins the pnpm version.

```bash
pnpm install
pnpm db:up                  # postgres in docker, on 127.0.0.1:5434
cp .env.example .env.local
pnpm dev                    # http://localhost:5173
```

`pnpm dev` runs the API server with `--watch` and Vite in one terminal. Vite
proxies `/api` and `/ws` to the server, so the browser sees one origin, as it
does in production. The schema applies itself on the first connection, so
there is no migration step.

Postgres listens on 5434, not the usual 5432, so it can run beside a
postgres already on your machine. `RACCOON_DB_PORT` overrides it. The API
server listens on 3000, and `PORT` in `.env.local` moves it. Vite's proxy
follows `PORT`.

| Command | What it does |
| --- | --- |
| `pnpm dev` | API server and Vite, with reload |
| `pnpm dev:db` | `pnpm db:up`, then `pnpm dev` |
| `pnpm typecheck` | `tsc --noEmit` for the server and the client |
| `pnpm test` | unit tests (`*.test.ts`) |
| `pnpm test:int` | integration tests against the dev postgres (`*.itest.ts`). Run `pnpm db:up` first |
| `pnpm test:e2e` | builds the client, then runs the browser tests (`e2e/*.e2e.ts`) against a server on port 3100 (`E2E_PORT`) and the dev postgres, one file at a time as a single shard of [continuous integration](#continuous-integration): the join limits' counts are cleared before each file, and a failing file runs once more. Needs Google Chrome installed. Screenshots go to `test-results/e2e-screenshots` (gitignored), or to the folder in `E2E_SCREENSHOT_DIR`, and `E2E_SCREENSHOT_DIR=0` takes none. Run it alone, not beside `pnpm test:int`, since both use the same database |
| `pnpm test:e2e:shard <index> <count>` | one shard of the browser tests, as [continuous integration](#continuous-integration) runs them. Run `pnpm build` first |
| `pnpm build` | the client into `dist/` |
| `pnpm db:psql` | a psql shell in the dev postgres |
| `pnpm db:down` | stop the dev postgres, keeping its data |
| `pnpm db:reset` | drop the dev database volume and start fresh |
| `pnpm admin <command>` | the admin commands below, against the dev database |
| `pnpm test:backup` | the backup check (`scripts/backup-check.ts`): `docker/backup.sh` through its compose services, in a compose project and postgres of its own (port 5235). Needs Docker, takes about 5 minutes. Run it before a release that touches backups |

`docker compose up --build raccoon`, from the [Quick start](#quick-start),
is also how to try a build of the production image before it goes to a
server.

## Continuous integration

GitHub Actions runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
on every push to `main` or to a branch under `ci/`, and by hand from the
Actions tab. It needs no secrets and deploys nothing.

These jobs run on Ubuntu:

- **build**: `pnpm build` once, kept for the e2e shards.
- **typecheck-int**: `pnpm typecheck` and `pnpm test:int`, the second
  against a postgres service container like the one in `docker-compose.yml`.
- **unit**: `pnpm test`, which needs no database.
- **e2e**, 13 shards at once: each shard installs, downloads the build,
  gets a postgres service container of its own and runs its share of
  `e2e/*.e2e.ts`, one file at a time, in Google Chrome.

The app draws its text in Inter, which it serves itself from
`public/fonts/`, so a page lays out the same on the Linux shards as on a
phone or a Mac. Each shard still installs Roboto and makes it the system
font with `e2e/fonts.conf`, as the fallback font. It draws only before
Inter loads and for the few characters Inter's subset lacks, as on an
Android phone. A file that still fails on Linux from font metrics alone,
and cannot be made tolerant without losing what it guards, goes in
`e2e/macos-only.json` with the reason. The Linux shards leave those files
out, and an **e2e-macos** job runs them on a Mac. The list is empty, and
the macOS job runs only when it is not.

A newer push to a `ci/` branch cancels that branch's run in progress. Every
push to `main` runs to the end, so each commit there is tested. A failing
e2e file runs once more, and its shard fails only if the rerun fails too.
The rerun leaves out the tests that passed after the file's last failure,
since any test before it may set up what a failure needs, and runs the
whole file when the first run timed out, crashed or failed in a hook. A
file that passed only on its rerun shows as a warning on the run. A shard
that failed, was cancelled or reran keeps its logs and screenshots as an
artifact for two weeks.

Each shard has a deadline 5 minutes inside its job's time limit
(`--deadline`). A run's limit leaves time for a rerun and for the files
after it, a rerun that would not fit is skipped, and the shard reports
what ran either way. So a file that hangs every time still fails with its
logs kept, rather than the job being cut off.

`scripts/e2e-shard.ts` decides which files each shard runs, by the times in
`e2e/durations.json`: the longest file first, each onto the shard with the
least time so far. A file missing there counts as `defaultSeconds`. Each
shard prints the time every file took. After a file grows or a new one
lands, rewrite the list from a few green runs with
`node scripts/e2e-durations.ts <run id> ...`, which reads those times
through `gh`. The list holds CI seconds, the largest of the runs given, and
the shard count is chosen so the longest shard plans about 8 minutes. A run
is 16 jobs and peaks at 15 at once, of the account's 20 Linux jobs, so a
second run that overlaps it queues part of its shards.

A file that takes much over 5 minutes in CI holds its shard up, so a long
one is split into files that each build their own room from a module they
share, as `e2e/alignmentRoom.ts` does for the alignment sweep's three files
and `e2e/barrestRoom.ts` for the resting bar's four.

A shard runs on a laptop too, against the dev postgres. Build first, then
give the shard's number and the shard count. `--list` prints what every
shard would run, without running it. On a Mac a shard includes the files
of `e2e/macos-only.json`, and `--macos-only` shards only those.

```bash
pnpm build
pnpm test:e2e:shard 1 3
pnpm test:e2e:shard 1 3 --list
```

It reads `E2E_PORT`, `DATABASE_URL` and `E2E_SCREENSHOT_DIR` as
`pnpm test:e2e` does. Each file's output also goes to
`test-results/e2e-logs`, and its screenshots to a folder of its own. Shards
can run side by side on one machine when each has its own database and its
own `E2E_PORT`, at least 30 apart: a file uses ports up to `E2E_PORT` plus
23, and the join limits count every run from one address in the database.

## Deploying

The production stack is `docker-compose.server.yml`. It runs four
containers, and none of them publishes a port:

- `raccoon`, the app. Read-only root filesystem, no capabilities, runs as the
  `node` user (uid 1000). It can write only to `/data/assets` (the
  `raccoon-assets` volume) and an in-memory `/tmp`.
- `postgres`, reachable only from the app, on the `raccoon-db` volume.
- `backup`, which backs up the database and the images every night onto the
  `raccoon-backups` volume (see Backups below). It reaches postgres and
  nothing else.
- `egress`, a squid proxy and the app's only way to the internet. Port 3128
  allows only `serpapi.com`, `api.openverse.org`,
  `character-service.dndbeyond.com` and `challenges.cloudflare.com`. Port
  3129 allows any public host on port 443 (for "import an image from a URL").
  Both refuse every private, loopback and link-local address. The rules and
  their reasons are in [docker/squid.conf](docker/squid.conf).
  `character-service.dndbeyond.com` is for importing a public D&D Beyond
  character into a stat block. To turn that off, remove it from the
  `strict_hosts` line of docker/squid.conf and restart the `egress`
  container: the link import then says D&D Beyond did not answer, and
  pasting the character's JSON still works.

Your HTTPS front end (a reverse proxy or a tunnel) reaches the app over the
`raccoon-edge` network at `http://raccoon:3000`. The header of
`docker-compose.server.yml` has the full picture.

On the server, always pass `-f docker-compose.server.yml`. A bare
`docker compose up` starts the development stack instead.

### Before the first deploy

- A Linux server with Docker Engine 28 or later. The internal networks use
  `gateway_mode_ipv4: isolated`, which older engines reject with
  `unknown gateway mode isolated`. Check with
  `docker version --format '{{.Server.Version}}'`.
- The Docker Compose v2 plugin.
- A hostname for the site, for example `vtt.example.com`, and a way to serve
  it over HTTPS: a reverse proxy such as Caddy, nginx or Traefik, or a tunnel
  such as Cloudflare Tunnel. It must pass WebSockets through.
- Optionally, `iptables-persistent` (it provides `netfilter-persistent`), to
  keep the firewall rules of step 4 across reboots.

The internal networks have pinned subnets (192.168.206.0/24 to
192.168.208.0/24, and 172.31.243.0/28 for egress), so host firewall rules can
name them. If they clash with networks on your host, change them in
`docker-compose.server.yml`.

### 1. Get the code

```bash
git clone <this repository's URL> ~/raccoon-vtt
cd ~/raccoon-vtt
```

Every command from here on runs in that directory.

### 2. Write the .env file

Compose reads `.env` next to `docker-compose.server.yml`. It is gitignored.

```bash
cp docker/server.env.example .env
chmod 600 .env
sed -i "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s|^ROOM_SECRET_KEY=$|ROOM_SECRET_KEY=$(openssl rand -base64 32)|" .env
```

`ROOM_SECRET_KEY` is the key the server keeps each room's player password
under, so a DM can show the player link and its QR code at any time. Keep
it: a new key makes every stored player password unreadable, and each DM then
changes the player password once to get a shareable link again. The second
`sed` uses `|` because a base64 key can contain `/`.

Then open `.env` in an editor and fill in:

- `PUBLIC_ORIGIN`: `https://` plus the hostname, no trailing slash.
- `TZ` and `BACKUP_AT`: optional, the server's time zone (an IANA name such
  as `America/Chicago`) and the time of the nightly backup in it. Unset,
  backups run at 04:00 UTC.
- `SERPAPI_KEY`: optional, enables image search.
- `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`: optional, both or neither.
  They turn on Cloudflare Turnstile, a free and usually invisible human
  check, on the create-room and import forms. They also turn on the join
  challenge: once a room sees 20 wrong passwords in an hour, joining it with
  the password needs the check too, instead of anyone being locked out.
  Without the keys there is no check anywhere.

To get the Turnstile keys, open the Cloudflare dashboard, then Turnstile,
then Add widget:

- Widget name: anything, for example `raccoon-vtt`.
- Hostname: the host from `PUBLIC_ORIGIN`.
- Widget mode: Managed.

Create it, then copy its site key into `TURNSTILE_SITE_KEY` and its secret
key into `TURNSTILE_SECRET`. The widget's hostname must be the host in
`PUBLIC_ORIGIN`: in production a token solved anywhere else is refused, so
room creation would fail with a mismatch.

Paste keys in the editor rather than on a command line, so they stay out of
the shell history. Compose refuses to start while `POSTGRES_PASSWORD`,
`PUBLIC_ORIGIN` or `ROOM_SECRET_KEY` is empty.

### 3. Build and start

```bash
docker compose -f docker-compose.server.yml up -d --build
docker compose -f docker-compose.server.yml ps
```

`raccoon`, `postgres` and `egress` should show `(healthy)` within about 30
seconds, and `backup` should show `Up` (it has no health check: it sleeps
until the nightly backup). The image
builds on the server itself, so it gets the server's CPU architecture and the
matching native binaries for sharp and argon2.

If `raccoon` keeps restarting, its log says why:

```bash
docker compose -f docker-compose.server.yml logs raccoon
```

A missing or wrong variable shows up as `Refusing to start in production
without ...` or `Invalid environment`.

### 4. Firewall rules (recommended, once)

The `egress` container is the only one with a real gateway, so it could
address the host itself. squid refuses private addresses already, and these
two rules back that up in case squid is compromised or a DNS answer changes
between squid's check and its connect (design section 15.3).

```bash
sudo iptables -I INPUT 1 -i br-rvtt-egress -j DROP
sudo iptables -I DOCKER-USER -i br-rvtt-egress -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16 -j DROP
sudo netfilter-persistent save
```

Run them once. Running them again adds duplicate rules. To see what is there:

```bash
sudo iptables -S INPUT | grep br-rvtt-egress
sudo iptables -S DOCKER-USER | grep br-rvtt-egress
```

The bridge keeps the name `br-rvtt-egress` when the network is recreated, so
the rules stay valid across deploys.

### 5. Put HTTPS in front of it

The app speaks plain HTTP on port 3000 inside the `raccoon-edge` network and
expects HTTPS outside: it refuses to start in production unless
`PUBLIC_ORIGIN` is an `https://` origin, and its WebSocket checks the Origin
header against it exactly. Whatever serves the site must:

- Terminate TLS for the hostname in `PUBLIC_ORIGIN`.
- Forward every path, `/ws` included, to `http://raccoon:3000`, with
  WebSocket upgrades passed through.
- Keep the `Origin` header as the browser sent it. Most proxies do by
  default.

Run the proxy or tunnel as a container that joins `raccoon-edge`. A proxy
installed on the host itself cannot reach the app: it publishes no port,
and its networks have no address on the host. `raccoon-edge` is created by
step 3. In the proxy's own compose file, add it as an external network.
Keep the network that gives the proxy its internet access, usually `default`:
`raccoon-edge` is internal, and a service's `networks:` list replaces the
implicit default network, so listing `raccoon-edge` alone would cut the proxy
off (no tunnel, no certificates):

```yaml
services:
  proxy:                # your reverse proxy or tunnel service
    networks:
      - default         # its way to the internet, kept
      - raccoon-edge

networks:
  default: {}
  raccoon-edge:
    external: true
```

Then recreate the proxy (`docker compose up -d` in its project) and check
that both containers are on the network:

```bash
docker network inspect raccoon-edge --format '{{range .Containers}}{{.Name}} {{end}}'
```

**Client addresses and rate limits.** Every per-address limit keys on the
address the app takes from the `CF-Connecting-IP` header, because
`docker-compose.server.yml` sets `TRUST_CF_CONNECTING_IP=1`. That covers
joins, wrong room passwords, room creation, admin sign-in, image search,
uploads, open sockets, and the request limit for visitors who are not
signed in to a room. Cloudflare always overwrites that header, so behind
Cloudflare it is exact, as long as the server can be reached only through
Cloudflare (a tunnel, or a firewall that admits only Cloudflare). Behind
any other front end you must make the proxy overwrite it with the real
client address too. If the proxy passes it through, anyone can send a
made-up `CF-Connecting-IP` with each request and get around every limit,
including the limit on guessing a room's password. If your front end
cannot set the header, change that line in `docker-compose.server.yml` to
`TRUST_CF_CONNECTING_IP=0`. The limits then see every visitor as the
proxy's one address, which is safe but strict. That edit is a local change
to a tracked file. If an update changes the same file, `git pull` stops,
and `git stash`, `git pull`, then `git stash pop` carry the edit across.

For example, with Caddy, which gets a certificate on its own:

```
vtt.example.com {
    reverse_proxy raccoon:3000 {
        header_up CF-Connecting-IP {remote_host}
    }
}
```

With nginx, inside the `location` that proxies to `http://raccoon:3000`, set
`proxy_set_header CF-Connecting-IP $remote_addr;` along with the usual
`Upgrade` and `Connection` headers for WebSockets.

With Cloudflare Tunnel, add a public hostname (newer dashboards call it a
published application route) for the host with service type `HTTP` and URL
`raccoon:3000`, or this ingress rule above the catch-all in a local
`config.yml`:

```yaml
- hostname: vtt.example.com
  service: http://raccoon:3000
```

Until the front end is in place, nothing outside the server can reach the
app.

### 6. If you use Cloudflare

These zone settings keep Cloudflare from breaking the app (design section
15.6):

- Network: WebSockets on.
- SSL/TLS, Edge Certificates: Always Use HTTPS on.
- Speed: Rocket Loader off.
- Scrape Shield: Email Obfuscation off.
- Security, Bots: Bot Fight Mode off.
- Caching, Configuration: Browser Cache TTL set to "Respect Existing Headers".
- Security, WAF: no challenge or managed-challenge rule that matches `/api/*`
  or `/ws`. A challenge breaks the WebSocket and every API call.

### 7. Check it and make your group's room

`https://<your host>/healthz` should answer `{"status":"ok"}`.

Anyone with the site's address can create a room, within daily limits. You
can also create your group's room from the server, so the limits never get
in the way, and pin it so it is never unloaded to make space:

```bash
docker compose -f docker-compose.server.yml exec raccoon node scripts/admin.ts create-room "Game Night" "Dana"
docker compose -f docker-compose.server.yml exec raccoon node scripts/admin.ts pin ABCD-EFGH
```

`create-room` takes the room's name and the DM's name, and prints the room
ID, a generated player password, the player link and the DM link. Open the
DM link on the DM's device, then add more DM devices from inside the app.
Send the player link to the players: it carries the password, so opening it
joins without typing anything. Replace `ABCD-EFGH` with the printed room ID.

## Admin commands

All of them run inside the app container:

```bash
docker compose -f docker-compose.server.yml exec raccoon node scripts/admin.ts help
```

| Command | What it does |
| --- | --- |
| `list-rooms` | every room with its last activity and size |
| `create-room <name> <dmName>` | a new room, bypassing the creation limits. Prints the password, the player link and the DM link |
| `pin <roomId>` / `unpin <roomId>` | a pinned room is never unloaded to make space |
| `dm-link <roomId>` | replaces the DM link and prints the new one. Every DM device is signed out. Use it when every DM device and the link are lost |
| `import <file.zip> [dmName]` | restores a room export, for exports too big for the site's 95 MB upload limit |
| `hash-password` | makes the `ADMIN_PASSWORD_HASH` line that turns on the admin page (below) |

Room IDs work with or without the dash.

To import an export, copy it onto the asset volume first, import it, then
delete the copy:

```bash
docker compose -f docker-compose.server.yml exec raccoon mkdir -p /data/assets/import
docker compose -f docker-compose.server.yml cp ./room-export.zip raccoon:/data/assets/import/room-export.zip
docker compose -f docker-compose.server.yml exec raccoon node scripts/admin.ts import /data/assets/import/room-export.zip "Dana"
docker compose -f docker-compose.server.yml exec raccoon rm /data/assets/import/room-export.zip
```

The import makes a new room with a new ID, a new player password and a new
DM link, and prints them with the player link. It uses a temporary folder of
its own, so it is safe to run while the site is in use.

## Admin page

The page at `https://<your host>/admin` lists every room with its size,
images, last activity and whether it is loaded, shows the storage the server
uses and the last backups, and pins, unpins or deletes rooms. It never shows
what is in a room and cannot enter one. It is off until the server has an
admin password: without one, `/admin` is the not-found page.

To turn it on:

1. Make the password's hash. It asks for a password of 16 or more
   characters twice, without showing it, or makes one when you press Enter:

   ```bash
   cd ~/raccoon-vtt
   docker compose -f docker-compose.server.yml run --rm --no-deps raccoon node scripts/admin.ts hash-password
   ```

2. Open `.env` in an editor and paste the line it printed, as it is. It
   looks like `ADMIN_PASSWORD_HASH='$argon2id$v=19$...'`. The single quotes
   keep Compose from reading the `$` signs as variables.
3. Restart the app with the new setting:

   ```bash
   docker compose -f docker-compose.server.yml up -d
   ```

4. Open `https://<your host>/admin` and sign in. A session lasts 12 hours.

Five wrong passwords from one address close the login to it for a while,
and 50 from anywhere in an hour close it for an hour. The CLI always works.
Changing the hash signs every admin out. To turn the page off, delete the
line from `.env` and run `docker compose -f docker-compose.server.yml up -d`
again.

Deleting a room there is the same as the DM's delete: its players are sent
out at once, and its images go too unless another room uses them.

## Updating

Back up first, then update:

```bash
cd ~/raccoon-vtt
docker compose -f docker-compose.server.yml exec backup sh /backup/backup.sh once
git pull
docker compose -f docker-compose.server.yml up -d --build
docker compose -f docker-compose.server.yml restart egress
```

The backup prints one line ending in `good` when it worked. The last line
is there because squid reads docker/squid.conf only when it starts, and
Compose does not count a change to that file as a change to the `egress`
container, so without it an update that allows a new host leaves the old
list in force. Image search and imports fail for the second or two squid
takes to start again.

After the update that stands ruler stops on raised ground
(docs/design-v1-heights-readout.md section 3), reload every page left open
across it, table displays included. Until it reloads, an old page does not
show live rulers that carry heights, and reads kept ones as if on flat
ground, so its numbers differ from everyone else's.

The update that adds PDF handouts (docs/design-v1-pdf-handouts.md) saves
rooms in a format the builds before it cannot read: they answer "Something
went wrong" for every room. To go back, check out the commit you ran before
(`git log` lists it), rebuild with
`docker compose -f docker-compose.server.yml up -d --build`, then follow
Restore under Backups with the backup taken just before the update. Every
room loses what changed after that backup. Reload every page left open
across the update, table displays included. Until it reloads, an old page
shows only the first page of a handout of several pages, and an old DM page
cannot upload a PDF.

The update that adds companion stat blocks
(docs/design-v1-companion-stat-blocks.md) saves rooms at snapshot version 10
and stores changes at op version 6, which the builds before it cannot read:
they answer "Something went wrong" for every room. Going back is the same
restore: check out the commit you ran before (`git log` lists it), rebuild
with `docker compose -f docker-compose.server.yml up -d --build`, then follow
Restore under Backups with the backup taken just before the update. Every
room loses what changed after that backup. Reload every page left open
across the update, table displays included. Until it reloads, an old page
fails on the first change to a companion's stat block it receives, and DM
pages and the pages of that companion's players receive them. A DM's room
snapshot can now be up to 6 MiB, 3 MiB more than before for the stat blocks,
so a DM's page may take a few seconds longer to load a room that holds many.

The update that adds dice rolled on the server (docs/design-v1-dice.md), the
first of wave 7, saves rooms at snapshot version 11 and stores changes at op
version 7, which the builds before it cannot read: they answer "Something
went wrong" for every room. It also adds the `roll_receipts` table, which
the app creates on its own at start, and which older builds leave alone.
The wave also adds `character-service.dndbeyond.com` to docker/squid.conf
for the D&D Beyond import, which the recipe's `restart egress` puts in force.
Going back is the same restore: check out the commit you ran before (`git
log` lists it), rebuild with
`docker compose -f docker-compose.server.yml up -d --build`, run
`docker compose -f docker-compose.server.yml restart egress` so squid drops
the host again, then follow Restore under Backups with the backup taken just
before the update. Every room loses what changed after that backup. Reload
every page left open across the update, table displays included. Until it
reloads, an old page has no Dice panel and shows each roll as an empty line
in the Log.

The update that fixes the dragon turtle's SRD id (`dragon-tur-t-le` became
`dragon-turtle`) saves rooms at snapshot version 14 and stores changes at op
version 10, which the builds before it cannot read: they answer "Something
went wrong" for every room. Rooms, backups and stored changes from before it
take the new id as they load. Going back is the same restore: check out the
commit you ran before (`git log` lists it), rebuild with
`docker compose -f docker-compose.server.yml up -d --build`, then follow
Restore under Backups with the backup taken just before the update. Every
room loses what changed after that backup. Reload every page left open
across the update, table displays included. Until it reloads, an old page
finds no stat block for a dragon turtle. A dragon turtle an old DM page
places, saves in an encounter or gives an image is stored under the new id,
so it has its stat block once the page reloads.

Compose rebuilds the image and replaces only the containers that changed. On
the way down the app closes every WebSocket with code 1012, finishes each
room's current write and saves a snapshot, so phones reconnect on their own
within a few seconds and lose nothing (design section 15.4).

Images are pinned by digest: the Node base in `Dockerfile`, and postgres and
squid in `docker-compose.server.yml`. They do not update on their own. To
take base image fixes, look up the new digest, change the pin and redeploy:

```bash
docker buildx imagetools inspect node:24-trixie-slim
docker buildx imagetools inspect postgres:17-alpine
docker buildx imagetools inspect ubuntu/squid:latest
```

Keep postgres on major version 17. Moving to 18 needs a dump and restore,
not just a new tag.

## Logs

```bash
docker compose -f docker-compose.server.yml logs -f raccoon
docker compose -f docker-compose.server.yml logs egress
docker compose -f docker-compose.server.yml logs backup
```

The backup log has one line per run, `good` or why it was not.

The egress log lists every outbound destination the app asked for, allowed
(`TCP_TUNNEL`) or refused (`TCP_DENIED`). The pairs of
`error:transaction-end-before-headers` lines from 127.0.0.1 every 30 seconds
are its health check. Containers use Docker's `local` log driver, which
rotates on its own.

## Backups

The `backup` service backs up every night at `BACKUP_AT` (04:00 by default)
in the server's `TZ`, onto the `raccoon_raccoon-backups` volume. Each run
dumps the database with `pg_dump`, reads the whole dump back, lists the
images the dump names and copies the ones the volume lacks. Only a run that
passed every step writes the completion record (`<name>.good`) that makes
the dump count. It keeps the newest 7 good backups and the newest of each of
the last 4 weeks, and the images all of them need. A run that cannot finish
(the disk too full, a dump that fails) deletes nothing, so the last good
backup always remains. It always leaves 2 GiB free on the disk for the app
and postgres. The admin page shows the last run and warns when the last one
was not good or no good one has run for 36 hours.

The dumps hold everything in the database: every room, the password hashes
and the sealed player passwords (which only `ROOM_SECRET_KEY` opens). They
are as private as the database volume. Keep `ROOM_SECRET_KEY` somewhere
safe too: a restore on a new server needs the same key for DMs to see their
player links.

The app never deletes an image file at once. A deleted room's files, and
whatever cleanup removes, wait 48 hours in a `trash` folder on the image
volume, so a backup that is running always finds them. Cleanup runs in the
app once a day, starting 10 minutes after it starts: it deletes scene
thumbnails a day after their scene stops using them. The first run after a
start, and every seventh after that, also deletes the files no database row
names. DMs delete the rest from their image library, where unused images
are marked "Not in use".

### Run one now

Before an update, or whenever you like:

```bash
cd ~/raccoon-vtt
docker compose -f docker-compose.server.yml exec backup sh /backup/backup.sh once
```

It prints one line with the backup's name, such as
`backup raccoon-2026-10-14-090000-abcd1234: good, 52431 byte dump, 3 images copied`,
or says `A backup is running`.

### Sizing

The backups volume holds about the image volume's size plus 11 dumps, and
each run keeps 2 GiB free. Before the first backup, see how big both are,
and how much the disk has free:

```bash
cd ~/raccoon-vtt
docker compose -f docker-compose.server.yml exec raccoon du -sh /data/assets
docker compose -f docker-compose.server.yml exec postgres psql -U raccoon -d raccoon -Atc "select pg_size_pretty(pg_database_size('raccoon'))"
df -h /var/lib/docker
```

A dump is a fraction of the database's size. If the disk cannot hold the
image volume twice plus 2 GiB, the runs end as partial and say so in the log
and on the admin page.

### Copy the backups off the server

The backups live on the same disk as everything else, so a failing disk takes
them too. Now and then, copy the volume somewhere else:

```bash
cd ~/raccoon-vtt
docker compose -f docker-compose.server.yml exec -T backup tar -C /backups --exclude='*.part' -cf - . > raccoon-backups-$(date +%F).tar
```

Then move the file off the server, for example with `scp` from another
machine, and delete it here.

### Restore

A restore replaces the whole database with a backup's and puts back the
images it needs. List the good backups:

```bash
cd ~/raccoon-vtt
docker compose -f docker-compose.server.yml exec backup ls /backups
```

The names ending in `.good` are the good ones. Use a name without its
ending, such as `raccoon-2026-10-14-090000-abcd1234`.

On a new server, first follow steps 1 to 3 of Deploying, with the same
`ROOM_SECRET_KEY` in `.env`, and wait until `raccoon` is healthy. That
creates the image volume owned by the app and sets up the database. Then
put the copied backups onto the new backups volume:

```bash
cd ~/raccoon-vtt
docker compose -f docker-compose.server.yml exec -T backup tar -C /backups -xf - < raccoon-backups-2026-10-14.tar
```

Then, on either server, in this order:

1. Stop the app:

   ```bash
   docker compose -f docker-compose.server.yml stop raccoon
   ```

2. Restore. Replace the name with the backup's:

   ```bash
   docker compose -f docker-compose.server.yml --profile restore run --rm restore sh /backup/backup.sh restore raccoon-2026-10-14-090000-abcd1234
   ```

   It waits for nothing: if a backup is running it says so, and you run it
   again later. It ends with `Restored ...` when it worked. If it says the
   image volume is not the app's yet, or that the backup service has not
   started, start the stack once with
   `docker compose -f docker-compose.server.yml up -d`, then go back to step 1.

3. Start the app and wait until `raccoon` shows `(healthy)`:

   ```bash
   docker compose -f docker-compose.server.yml start raccoon
   docker compose -f docker-compose.server.yml ps
   ```

4. Run a backup, which rebuilds the backup log the admin page reads:

   ```bash
   docker compose -f docker-compose.server.yml exec backup sh /backup/backup.sh once
   ```

Until step 4, the admin page warns that there is no good backup. A backup
started before step 3 stops with "The database has no backup log yet",
which is expected on a new server.

### The drill (once)

Check once that restores work, before you need one, at a time nobody plays:

1. Make a test room and add an image to it. Then back up, and note the name
   the backup prints (A):

   ```bash
   cd ~/raccoon-vtt
   docker compose -f docker-compose.server.yml exec backup sh /backup/backup.sh once
   ```

2. Delete the test room, as its DM or on the admin page, and back up again
   with the same command (B).
3. Restore A with the four steps above. The test room is back, and its image
   shows.
4. In the test room, upload a new image, and delete the restored one from
   the image library (it says "Not in use" once no token wears it). The
   delete moves the restored file to the trash, so this lists a folder named
   for today's date in UTC:

   ```bash
   docker compose -f docker-compose.server.yml exec raccoon ls /data/assets/trash
   ```

5. Back up again, then check that B still restores, into a scratch database
   so the live one is untouched. Replace the name with B's:

   ```bash
   docker compose -f docker-compose.server.yml exec postgres createdb -U raccoon drill
   docker compose -f docker-compose.server.yml --profile restore run --rm -e PGDATABASE=drill restore sh /backup/backup.sh restore raccoon-2026-10-14-090000-abcd1234
   docker compose -f docker-compose.server.yml exec postgres dropdb -U raccoon drill
   ```

   The second command ends with `Restored ...`.

Then do it once more on a fresh server, following the new-server steps from
`docker compose -f docker-compose.server.yml up -d`.

### By hand

For a one-off copy outside the backup service, these two commands still
work while the site is up. Back up the database first, then the images: an
image saved without its database row is harmless, but a row whose image is
missing shows a broken picture.

```bash
cd ~/raccoon-vtt
docker compose -f docker-compose.server.yml exec -T postgres pg_dump -U raccoon -d raccoon --format=custom > raccoon-db-$(date +%F).dump
docker compose -f docker-compose.server.yml exec -T raccoon tar -C /data/assets --exclude=./tmp --exclude=./trash -czf - . > raccoon-assets-$(date +%F).tgz
```

## Changing the database password

Postgres reads `POSTGRES_PASSWORD` only when it creates the database, so
changing `.env` alone breaks the app's login. Change it in postgres first:

```bash
docker compose -f docker-compose.server.yml exec postgres psql -U raccoon -d raccoon -c '\password raccoon'
```

Then put the same value in `.env` as `POSTGRES_PASSWORD` and restart the app:

```bash
docker compose -f docker-compose.server.yml up -d raccoon
```

## Building for another architecture

The server builds its own image, for its own CPU architecture. This is
only for trying another architecture's image on your own machine, for
example linux/amd64 on an Apple Silicon Mac:

```bash
docker buildx build --platform linux/amd64 -t raccoon-vtt:amd64 --load .
```

The client build runs natively and only the production dependency install
runs under emulation. pnpm installs the native packages that match the
target, so the image gets `@img/sharp-linux-x64` and
`@node-rs/argon2-linux-x64-gnu`.

## License

The code is under the GNU Affero General Public License v3.0 (AGPL-3.0),
in the [LICENSE](LICENSE) file. In plain words: you may use, change and
share it. If you run a changed copy as a site that other people use, you
must offer those people the source code of your changed version.

The third-party art, the common-password list and the SRD 5.2.1 text that
ship with the app keep their own licenses. [CREDITS.md](CREDITS.md) lists
each one, and [shared/srd/NOTICE.md](shared/srd/NOTICE.md) holds the SRD's
notice.
