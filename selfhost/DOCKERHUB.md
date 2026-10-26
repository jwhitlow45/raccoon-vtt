# raccoon-vtt

A self-hosted virtual tabletop for D&D groups playing the 2024 rules (5.5e),
made for phones first. It works on tablets, laptops and a TV at the table
too, and every device stays in sync live. The DM sees everything, and
players see only what the fog and the DM allow. It is free software under
the GNU AGPL v3.0.

The source, the docs and the issue tracker are in
[the raccoon-vtt repository on GitHub]({{REPOSITORY_URL}}).

## Features

- One server hosts many groups. Each room is one campaign, with its own
  room ID, player password and private DM link. There are no accounts.
- Maps from an image, a blank grid, the built-in map builder, or a
  Universal VTT file from Dungeondraft, Dungeon Alchemist or DungeonFog.
- Fog of war, and party vision with walls, doors, lights, darkvision and
  raised ground. Players' devices never receive what they may not see.
- Tokens with HP, conditions, elevation and lights. Rulers, movement
  tracking, and areas of effect that count height.
- An initiative tracker, roll requests, an encounter builder, and the SRD
  5.2.1 monsters, conditions and spell areas built in.
- Dice roll on the server, so everyone sees the same result.
- A journal with secrets, map pins, chat and whispers, handouts, an X-card,
  and a table display for a TV.
- Nightly backups of the database and the images.

[FEATURES.md]({{REPOSITORY_URL}}/blob/main/FEATURES.md)
lists everything it does today, and the
[DM guide]({{REPOSITORY_URL}}/blob/main/docs/dm-guide.md)
teaches the DM tools step by step.

## Tags

Every tag is for `linux/amd64` and `linux/arm64`.

- `X.Y.Z`, such as `0.1.0`: one release. It never changes.
- `X.Y`, such as `0.1`: the newest patch of that minor release. The compose
  file runs this tag unless you pin another, so `docker compose pull` brings
  its patches.
- `latest`: the newest release.

`X.Y` and `latest` only ever move forward to a newer release.

## Run it

The app needs more than this one container: Postgres, and an egress proxy
that is its only way to the internet. The repository's
[selfhost/compose.yml]({{REPOSITORY_URL}}/blob/main/selfhost/compose.yml)
runs the whole stack, with nightly backups and an optional Caddy for HTTPS.
That file and an `.env` next to it are all a server needs.

You need:

- A Linux server with Docker Engine 28 or later and the Docker Compose
  plugin 2.31 or later.
- A hostname for the site, such as `vtt.example.com`, and a way to serve it
  over HTTPS. Either the compose file's `https` profile, which runs Caddy
  and needs ports 80 and 443 open, or your own reverse proxy or tunnel that
  passes WebSockets through.

**1. Download the files.** Pick a release from the repository's
[tags]({{REPOSITORY_URL}}/tags), `vX.Y.Z`, and put it
in `tag=`:

```bash
mkdir ~/raccoon-vtt && cd ~/raccoon-vtt
tag=vX.Y.Z
curl -fsSLo compose.yml "{{REPOSITORY_URL}}/raw/$tag/selfhost/compose.yml"
curl -fsSLo .env "{{REPOSITORY_URL}}/raw/$tag/selfhost/env.example"
chmod 600 .env
```

**2. Write the .env file.** This fills in the two secrets:

```bash
sed -i "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s|^ROOM_SECRET_KEY=$|ROOM_SECRET_KEY=$(openssl rand -base64 32)|" .env
```

Then open `.env` in an editor and set `PUBLIC_ORIGIN`, such as
`https://vtt.example.com`. To have Caddy serve HTTPS, uncomment
`COMPOSE_PROFILES=https`. The file explains every other setting.

**3. Start it:**

```bash
docker compose up -d
docker compose ps
```

`raccoon`, `postgres`, `egress` and, with the profile, `caddy` show
`(healthy)` within about 30 seconds. Without the `https` profile, point
your own proxy or tunnel at `http://raccoon:3000` on the `raccoon-edge`
network. Then `https://<your host>/healthz` answers `{"status":"ok"}`.

**4. Make your group's room:**

```bash
docker compose exec raccoon node scripts/admin.ts create-room "Game Night" "Dana"
```

It prints the room's ID, its player password, the player link and the DM
link. Anyone who reaches the site can also create a room from its Home
page, a few a day per address.

The README's
[Self-hosting with the published image]({{REPOSITORY_URL}}/blob/main/README.md#self-hosting-with-the-published-image)
has the rest: firewall rules for the proxy's network, updates, backups and
restore, and running behind Cloudflare.

## What the container needs

`selfhost/compose.yml` sets all of this up. To run the image some other
way, give it the same.

- **Postgres**, which holds the rooms. The compose file runs Postgres 17.
- **The egress proxy.** In production the app makes every outbound request
  through a proxy and refuses to start without one: image search, importing
  an image from a link, the D&D Beyond character import and the human
  check. The compose file runs squid with the rules of
  [docker/squid.conf]({{REPOSITORY_URL}}/blob/main/docker/squid.conf):
  one port for a short list of hosts, one for any public host on port 443,
  and both refuse private addresses.
- **A volume at `/data/assets`** for uploaded images, writable by uid 1000,
  the user the app runs as. Nothing else needs to be writable, so the root
  filesystem can be read-only, with an in-memory `/tmp`.
- **Port 3000**, plain HTTP, behind an HTTPS front end that passes
  WebSockets through. `/healthz` answers while the server runs.
- **These environment variables:**
  - `DATABASE_URL`: the Postgres connection URL.
  - `PUBLIC_ORIGIN`: the site's exact address, `https://` and the hostname
    with no trailing slash. The WebSocket and CSRF checks compare against
    it.
  - `ROOM_SECRET_KEY`: 32 random bytes in base64, from
    `openssl rand -base64 32`. It keeps each room's player password
    readable for its DM. Keep it: a new key makes the stored passwords
    unreadable.
  - `EGRESS_STRICT_PROXY` and `EGRESS_PUBLIC_PROXY`: the proxy's two ports,
    such as `http://egress:3128` and `http://egress:3129`.
  - Optional: `SERPAPI_KEY` for web image search, `TURNSTILE_SITE_KEY` and
    `TURNSTILE_SECRET` for Cloudflare Turnstile, `OPENVERSE_CLIENT_ID` and
    `OPENVERSE_CLIENT_SECRET`, `ADMIN_PASSWORD_HASH` for the admin page,
    `TRUST_CF_CONNECTING_IP`, and the limits `ROOMS_PER_IP_PER_DAY`,
    `ROOMS_PER_DAY` and `ROOM_QUOTA_MB`.
    [selfhost/env.example]({{REPOSITORY_URL}}/blob/main/selfhost/env.example)
    explains each one.

## Links

- Source code: [the raccoon-vtt repository]({{REPOSITORY_URL}})
- Self-hosting guide: [README.md, Self-hosting with the published image]({{REPOSITORY_URL}}/blob/main/README.md#self-hosting-with-the-published-image)
- What it does: [FEATURES.md]({{REPOSITORY_URL}}/blob/main/FEATURES.md)
- For DMs: [the DM guide]({{REPOSITORY_URL}}/blob/main/docs/dm-guide.md)
- Bugs and requests: [the issue tracker]({{REPOSITORY_URL}}/issues)
- License: [GNU AGPL v3.0]({{REPOSITORY_URL}}/blob/main/LICENSE).
  The art and the SRD text that ship with the app keep their own licenses,
  listed in [CREDITS.md]({{REPOSITORY_URL}}/blob/main/CREDITS.md).
