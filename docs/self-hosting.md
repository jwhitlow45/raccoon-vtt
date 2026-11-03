# Self-hosting

How to run RaccoonVTT on your own server, keep it up to date and back it
up. The simplest way runs the image each release publishes, as
[Self-hosting with the published image](#self-hosting-with-the-published-image)
describes. [Deploying](#deploying) builds the image on the server from a
copy of the repository instead, and the published image's steps refer back
to it for the parts the two share. Running the site day to day, its admin
commands, admin page and logs, is in [operations.md](operations.md).

## Deploying

This section builds the image on the server from a copy of the repository.
To run the image each release publishes instead, with no copy and no build,
see [Self-hosting with the published image](#self-hosting-with-the-published-image).

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
  their reasons are in [docker/squid.conf](../docker/squid.conf).
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
git clone https://github.com/jwhitlow45/raccoon-vtt.git ~/raccoon-vtt
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
  as `Europe/Berlin`) and the time of the nightly backup in it. Unset,
  backups run at 04:00 UTC.
- `SERPAPI_KEY`: optional, enables image search.
- `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`: optional, both or neither.
  They turn on Cloudflare Turnstile, a free and usually invisible human
  check, on the create-room and import forms. They also turn on the join
  challenge: once a room sees 20 wrong passwords in an hour, joining it with
  the password needs the check too, instead of anyone being locked out.
  Without the keys there is no check anywhere.
- `ANIMATED_MAPS`: optional, `1` lets a DM use a WebM or MP4 video as an
  animated map. Unset or `0`, the server refuses video uploads, serves no
  video and every map shows its still. Read
  [If you use Cloudflare](#6-if-you-use-cloudflare) before you turn it on
  behind Cloudflare.

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
- Allow a response at least 30 seconds to arrive. A newcomer waiting for a
  DM to let them in holds a request open for up to 25 seconds. Cloudflare
  allows 125 seconds, and nginx 60 by default.

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

Animated maps serve each map's video, up to 64 MB, through the same
hostname. Cloudflare's
[Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/)
say that a plan below Enterprise may serve video and other large files
through its CDN only with Cloudflare's paid services for them, and that
Cloudflare may limit a site that does otherwise. The limit would fall on
the whole site, not only on the videos, so `ANIMATED_MAPS` is off unless
you set it to `1`. Turn it on behind Cloudflare only if you accept that,
or if you serve the site another way.

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

## Self-hosting with the published image

Each release is also an image on Docker Hub,
`docker.io/jwhitlow45/raccoon-vtt`, for linux/amd64 and linux/arm64. With
it a server needs no copy of this repository and builds nothing: two files
are the whole setup. `selfhost/compose.yml` is the stack of
[Deploying](#deploying) with the published image in place of the build, so
what that section says about the containers, the networks and the egress
proxy holds here too. It adds two things:

- `config-files`, which copies the egress proxy's rules, the backup script
  and Caddy's settings onto a volume, then exits. All three are written
  into `compose.yml` itself, so there is nothing else to download.
- An optional `https` profile that runs Caddy as the HTTPS front end.

Its project, network and volume names are the same as
`docker-compose.server.yml`'s, so the two cannot run on one host at once.

### Verify the image

Images published with signing enabled carry a keyless Cosign signature for
their multi-architecture digest. With [Cosign v3 or later](https://docs.sigstore.dev/cosign/verifying/verify/)
installed, replace `X.Y.Z` in both places with the release version and verify its release
workflow identity before running it. Older releases may be unsigned.

```sh
cosign verify \
  --certificate-identity 'https://github.com/jwhitlow45/raccoon-vtt/.github/workflows/image.yml@refs/tags/vX.Y.Z' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  docker.io/jwhitlow45/raccoon-vtt:X.Y.Z
```

### What you need

- A Linux server with Docker Engine 28 or later, as in
  [Before the first deploy](#before-the-first-deploy).
- The Docker Compose plugin, 2.31 or later, the oldest tested. Older ones
  cannot read the file's inline configs, its volume `subpath` mounts or
  `restart` in `depends_on`. Check with `docker compose version`.
- A hostname for the site, for example `vtt.example.com`.
- One way to serve it over HTTPS:
  - The `https` profile. The hostname's DNS record points at the server,
    and ports 80 and 443 are open to the internet. Caddy gets and renews
    the certificate on its own.
  - Or your own reverse proxy or tunnel, set up as in
    [Put HTTPS in front of it](#5-put-https-in-front-of-it). Behind
    Cloudflare, use this, a tunnel or your own proxy, rather than the
    `https` profile: Caddy would see every visitor as a Cloudflare address.

The networks use the subnets listed in Before the first deploy, and Caddy's
adds 172.31.243.16/28. If any of them clash with a network on your host,
do not edit `compose.yml`, which every update replaces. Put new subnets in
a file named `compose.override.yml` next to it, which Compose reads on its
own, for example:

```yaml
networks:
  raccoon-edge:
    ipam:
      config: !override
        - subnet: 10.89.6.0/24
  raccoon-data:
    ipam:
      config: !override
        - subnet: 10.89.7.0/24
  raccoon-proxy:
    ipam:
      config: !override
        - subnet: 10.89.8.0/24
  raccoon-egress:
    ipam:
      config: !override
        - subnet: 10.89.9.0/28
  raccoon-https:
    ipam:
      config: !override
        - subnet: 10.89.9.16/28
```

List only the networks you move. `!override` replaces the subnet instead
of adding a second one. The firewall rules name the bridges, not their
subnets, so they need no change.

### 1. Download the files

Pick a release from the repository's
[tags](https://github.com/jwhitlow45/raccoon-vtt/tags), `vX.Y.Z`, and download
its two files into a folder of their own:

```bash
mkdir ~/raccoon-vtt && cd ~/raccoon-vtt
tag=vX.Y.Z
curl -fsSLo compose.yml "https://github.com/jwhitlow45/raccoon-vtt/raw/$tag/selfhost/compose.yml"
curl -fsSLo .env "https://github.com/jwhitlow45/raccoon-vtt/raw/$tag/selfhost/env.example"
chmod 600 .env
```

Every command from here on runs in that folder. `compose.yml` is the only
compose file in it, so no command needs `-f`.

### 2. Write the .env file

```bash
sed -i "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s|^ROOM_SECRET_KEY=$|ROOM_SECRET_KEY=$(openssl rand -base64 32)|" .env
```

Then open `.env` in an editor. Set `PUBLIC_ORIGIN` and the optional
settings as in [Write the .env file](#2-write-the-env-file), which also says
why to keep `ROOM_SECRET_KEY`. Three more lines are new here, and the file
explains each:

- `COMPOSE_PROFILES=https`: uncomment it to run Caddy. Every
  `docker compose` command then includes it, `pull` and `down` too.
- `RACCOON_VERSION`: the release to run. Unset, it is the minor release the
  file came with, such as `0.1`, so updates bring its newest patch.
- `TRUST_CF_CONNECTING_IP`: 0 unless you set it, unlike the server stack.
  Set it to 1 only when every request reaches the app through something that
  overwrites the `CF-Connecting-IP` header with the visitor's address:
  Cloudflare, or the `https` profile's Caddy. Anywhere else, 1 would let
  anyone pick their address and get around every per-address limit. At 0
  those limits see the front end's one address, which is safe but strict
  (Client addresses and rate limits, in
  [Put HTTPS in front of it](#5-put-https-in-front-of-it)).

### 3. Start it

```bash
docker compose up -d
docker compose ps
```

`raccoon`, `postgres`, `egress` and, with the profile, `caddy` should show
`(healthy)` within about 30 seconds. `backup` shows `Up`, and
`config-files` shows `Exited (0)` once it has copied its files. A missing
variable stops compose before anything starts, and
`docker compose logs raccoon` says why the app will not start.

Without the `https` profile, put your own front end on `raccoon-edge`, as
in [Put HTTPS in front of it](#5-put-https-in-front-of-it). Either way, add
the [firewall rules](#4-firewall-rules-recommended-once) once, and if the
site is behind Cloudflare, check [its settings](#6-if-you-use-cloudflare).

With the `https` profile, Caddy's bridge, `br-rvtt-https`, has a real
gateway too, so a compromised Caddy could reach the host and your network.
Two more rules, once, keep it to the internet. They match only connections
Caddy starts, so the answers to visitors on ports 80 and 443 still pass:

```bash
sudo iptables -I INPUT 1 -i br-rvtt-https -m conntrack --ctstate NEW -j DROP
sudo iptables -I DOCKER-USER -i br-rvtt-https -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16 -m conntrack --ctstate NEW -j DROP
sudo netfilter-persistent save
```

Caddy resolves names through Cloudflare's 1.1.1.1, as the egress proxy
does, so these rules never cut off its DNS.

### 4. Make your group's room

`https://<your host>/healthz` should answer `{"status":"ok"}`. Then, as in
[Check it and make your group's room](#7-check-it-and-make-your-groups-room):

```bash
docker compose exec raccoon node scripts/admin.ts create-room "Game Night" "Dana"
docker compose exec raccoon node scripts/admin.ts pin ABCD-EFGH
```

The [Admin commands](operations.md#admin-commands) and the [Admin page](operations.md#admin-page) work
the same way here. Write each of their commands without
`-f docker-compose.server.yml`.

### Update to a new release

Back up first, then pull the release and recreate what changed:

```bash
cd ~/raccoon-vtt
docker compose exec backup sh /backup/backup.sh once
docker compose pull
docker compose up -d
```

`pull` brings the newest image of the release in `RACCOON_VERSION`. Left
unset, that is the newest patch of the file's minor release. Set an exact
release such as `RACCOON_VERSION=0.1.2` to change versions only when you
edit that line.

A new minor or major release can come with a new `compose.yml`. Download
the one at its tag, as in step 1, but keep your `.env`. Then run the three
commands above. When the new file changes the proxy's rules or the backup
script, `up -d` restarts `egress` and `backup` with them on its own. Read
[Updating](#updating) for the release you move to: some updates change how
rooms are saved, and older releases cannot read them. Going back to one is
a restore.

### Back up and restore

[Backups](#backups) applies as it is, with the same volumes. Run its
commands in this folder and without `-f docker-compose.server.yml`, for
example:

```bash
docker compose exec backup sh /backup/backup.sh once
docker compose exec backup ls /backups
docker compose --profile restore run --rm restore sh /backup/backup.sh restore raccoon-2026-10-14-090000-abcd1234
```

On a new server, follow steps 1 to 3 above with the same `ROOM_SECRET_KEY`,
then [Restore](#restore) from putting the copied backups onto the volume.

### Remove it

Removing raccoon-vtt deletes every room, every image and every backup on
the server, so first copy off anything you want to keep, as
[Copy the backups off the server](#copy-the-backups-off-the-server) shows.
Then stop the stack, delete its containers, networks, volumes and images,
and delete its folder:

```bash
cd ~/raccoon-vtt
docker compose down --volumes --rmi all
cd ~ && rm -r ~/raccoon-vtt
```

A server that builds its own image, as in [Deploying](#deploying), is
removed the same way, with `-f docker-compose.server.yml` added to the
`down` command. If you added the firewall rules, remove each one by
running its `iptables -I` line again with `-D` in place of `-I` and
without the rule number `1`, then save them with
`sudo netfilter-persistent save`.

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
(docs/design/design-v1-heights-readout.md section 3), reload every page left open
across it, table displays included. Until it reloads, an old page does not
show live rulers that carry heights, and reads kept ones as if on flat
ground, so its numbers differ from everyone else's.

The update that adds PDF handouts (docs/design/design-v1-pdf-handouts.md) saves
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
(docs/design/design-v1-companion-stat-blocks.md) saves rooms at snapshot version 10
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

The update that adds dice rolled on the server (docs/design/design-v1-dice.md), the
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

Hex grids, phase H1 (docs/design/design-v1-hex-grids.md), came in two updates.
The first, just before the isometric view, saves rooms at snapshot version 25
and stores changes at op version 24, which the builds before it cannot read:
they answer "Something went wrong" for every room. Back up first. Going back
is the same restore: check out the commit you ran before (`git log` lists
it), rebuild with `docker compose -f docker-compose.server.yml up -d --build`,
then follow Restore under Backups with the backup taken just before the
update. Every room loses what changed after that backup. The second adds the
settings that make a hex scene (Grid on new scenes, the new scene form's Grid
row and a scene's Grid shape) and changes no version. Reload every page left
open across either update, table displays included, since there is no client
version check and no version step makes an open page reload. Until it
reloads, an old page treats a hex scene as squares: it draws and snaps to the
wrong grid and counts distances wrongly. Scenes made before the update stay
squares.

The update that adds the isometric view (docs/design/design-v1-isometric-view.md)
saves rooms at snapshot version 26 and stores changes at op version 25,
which the builds before it cannot read: they answer "Something went wrong"
for every room. Going back is the same restore: check out the commit you ran
before (`git log` lists it), rebuild with
`docker compose -f docker-compose.server.yml up -d --build`, then follow
Restore under Backups with the backup taken just before the update. Every
room loses what changed after that backup. Reload every page left open
across the update, table displays included, since no version step makes an
open page reload. Until it reloads, an old page has no View button, and an
old table display drops what a DM in Isometric shows it, so Follow the DM
stands still there.

The update that splits Undo into Play and Setup history
(docs/design/design-v1-undo-scope.md, batch A) saves rooms at snapshot version 30
and stores changes at op version 34, which the builds before it cannot read:
they answer "Something went wrong" for every room, even a room whose stored
changes hold none of the new ones. Back up first. Rooms, backups and stored
changes from before it take the new versions as they load, through identity
migration steps (33 to 34 for changes, 29 to 30 for rooms). There is no
database table migration and no manual conversion of rooms. The restart that
deploys it clears every DM's and player's in-memory undo history, since those
histories are never stored, so nothing that was undoable before the update
can be undone after it. Going back is the same restore: check out the commit
you ran before (`git log` lists it), rebuild with
`docker compose -f docker-compose.server.yml up -d --build`, then follow
Restore under Backups with the backup taken just before the update. Only that
backup works: a build before this update refuses a room saved after it, so
the restore cannot be skipped. Every room loses what changed after that
backup. Reload every page left open across the update, table displays
included, since there is no client version check and no version step makes an
open page reload. Until it reloads, an old page's Undo or Redo gets a
terminal "Reload to use Undo" refusal and takes nothing back, and its other
queued changes that this build still accepts may still arrive. An old page
shows no Setup history.

The update that lets an undone group save open again
(docs/design/design-v1-undo-scope.md, batch B) saves rooms at snapshot version 31
and stores changes at op version 35, which the builds before it, batch A's
included, cannot read: they answer "Something went wrong" for every room,
even a room that holds no group save yet. Back up first. Rooms, backups and
stored changes from before it take the new versions as they load, through
identity migration steps (34 to 35 for changes, 30 to 31 for rooms), and an
older room gains no group save records it never had. There is no database
table migration and no manual conversion of rooms. The restart that deploys
it clears every in-memory undo history again. Going back is the same
restore, and each of the two Undo updates is its own boundary: to return to
batch A's build, restore the backup taken just before this update, and to
go back past batch A as well, restore the one taken just before batch A.
Every room loses what changed after the backup you restore. Reload every
page left open across the update, table displays included, since no version
step makes an open page reload. Until it reloads, an old DM page applies a
group save as before, once, but untracked: its page stays locked, and Undo
takes the outcome back without ever opening that page again.

The update that keeps riders' seats and trap stops off the walls between a
walk's ends, and lets a square trip wire with older, finer end points be
renamed or edited again, stores changes at op version 36, which the builds
before it cannot read. Snapshots keep their version, so a room whose saved
snapshot holds all its changes still opens in an older build. Back up first,
and reload every page left open across the update, table displays included.
Until it reloads, an old page plans a drag for what a rider pulls by the old
seat.

Going back needs the backup only for a room with changes stored since its last
snapshot. An older build refuses to open such a room, and refuses a rename or
an edit of a trip wire with older, finer end points that sits in those
changes. To avoid that, stop the server cleanly first, with
`docker compose -f docker-compose.server.yml stop raccoon`
(`docker compose stop raccoon` for the published image) or an ordinary update,
because that saves a snapshot of every room. Then check out the commit you ran
before (`git log` lists it), rebuild with
`docker compose -f docker-compose.server.yml up -d --build`, and every room
loads in the older build. A server that crashed or was killed before it saved
can leave such changes. In that case follow Restore under Backups with the
backup taken just before the update. Every room loses what changed after that
backup.

Two later updates each step the op version again, and the builds before each
cannot read what it stores. The update that has a trap stop a creature between
a walk's ends by the ground every player sees, and clips a creature on hexes by
the walls the viewer holds, stores changes at op version 37. The update that
has dragged creatures follow a squeezing holder in single file, seats its
passengers apart, and stands a hidden creature in tow clear of walls stores
changes at op version 38. Snapshots keep their version for both. Back up
first, and reload every page left open across each update, table displays
included. Until it reloads, an old page plans a drag by the old rules, and the
server's answer moves the tokens where they go. Going back is the same as for
op version 36 above: stop the server cleanly first so every room saves a
snapshot, then rebuild the commit you ran before, or restore the backup taken
just before the update if the server stopped without saving.

The update that adds join requests (docs/design/design-v1-join-requests.md)
changes no op or snapshot version. It adds two columns to `rooms`
(`join_mode` and `player_pw_hash_held`) and the `ask_sessions` table, which
the app creates on its own at start, and which older builds leave alone. A
newcomer's page holds its wait open for up to 25 seconds, so a reverse proxy's
response (read) timeout must be longer than that. Cloudflare allows 125
seconds, and nginx 60 by default. Going back needs no restore. An older build
checks player passwords against the room's usual column, which in a room set
to Only by asking holds a marker that no password matches, so in such a room
nobody new joins by password, and nobody can ask either. Devices already in
stay in. The DM can open password joins again on the older build by changing
the player password there. Coming forward again closes them at start and keeps
that new password for when the room leaves Only by asking. A newcomer's ask
cookie is an unknown cookie to an older build, so it gains nothing there.
This build writes a new player's member before signing the device in, so a
server stopped between the two leaves a member nobody plays, which the DM can
remove.

The update that lets a token be drawn between squares
(docs/design/design-v1-snap-off.md) saves rooms at snapshot version 34 and
stores changes at op version 44, which the builds before it cannot read. Back
up the database just before the update, and reload every page left open across
it, table displays included, since no version step makes an open page reload.
Rooms, backups and stored changes from before it take the new versions as they
load, through identity migration steps, and there is no database table
migration. An older build refuses a version 34 snapshot or a version 44 op, so
going back needs that backup: follow Restore under Backups with the backup
taken just before the update. Every room loses what changed after that backup.

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
