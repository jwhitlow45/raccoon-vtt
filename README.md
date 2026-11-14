<p align="center">
  <img src="public/icon.svg" alt="RaccoonVTT logo" width="128" height="128">
</p>

<h1 align="center">raccoon-vtt</h1>

<p align="center">
  <a href="https://hub.docker.com/r/jwhitlow45/raccoon-vtt"><img src="docs/images/docker-hub-button.png" width="240" alt="Get it on Docker Hub"></a>
</p>

<p align="center">
  <a href="https://github.com/jwhitlow45/raccoon-vtt/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/jwhitlow45/raccoon-vtt/ci.yml?branch=main&amp;label=CI&amp;logo=githubactions&amp;logoColor=white" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/jwhitlow45/raccoon-vtt"><img src="https://api.scorecard.dev/projects/github.com/jwhitlow45/raccoon-vtt/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://www.bestpractices.dev/projects/16184"><img src="https://www.bestpractices.dev/projects/16184/badge" alt="OpenSSF Best Practices"></a>
  <a href="https://hub.docker.com/r/jwhitlow45/raccoon-vtt"><img src="https://img.shields.io/docker/pulls/jwhitlow45/raccoon-vtt?logo=docker&amp;logoColor=white&amp;label=pulls" alt="Docker pulls"></a>
  <a href="https://hub.docker.com/r/jwhitlow45/raccoon-vtt/tags"><img src="https://img.shields.io/docker/image-size/jwhitlow45/raccoon-vtt/latest?logo=docker&amp;logoColor=white&amp;label=size" alt="Docker image size"></a>
  <img src="https://img.shields.io/badge/platforms-amd64%20%7C%20arm64-blue?logo=linux&amp;logoColor=white" alt="Platforms: amd64 and arm64">
  <img src="https://img.shields.io/badge/rules-5.5e-c0392b" alt="Rules: D&amp;D 5.5e (2024)">
</p>

A self-hosted virtual tabletop for D&D groups playing the 2024 rules
(5.5e) on squares or hexes. It is made for phones first and also runs on
tablets, laptops and a TV at the table, with every device kept in sync
live. The DM sees everything, while players' devices receive only what the
DM has revealed and what the party can see. The map image is the
exception: it reaches every device whole, with the fog drawn over it, so a
group has to trust its players with that.

One server hosts many groups at once, each campaign in a room of its own.
Whoever creates a room becomes its DM through a private DM link, and
players join with the room's ID and password, or by asking the DM to let
them in, as the DM chooses. A group can sit around one table, play from
elsewhere, or both, and a group that plays apart talks over a call of its
own.

- Maps from an image, a blank grid, the openly licensed starter maps, the
  built-in map builder, a generated dungeon, or a Universal VTT file
  (Dungeondraft, Dungeon Alchemist, Arkenforge, DungeonFog). Top-down or
  isometric.
- Fog of war, party vision with walls, doors, lights, darkvision and raised
  ground, and weather.
- Tokens with HP, conditions, elevation and lights, that can ride, carry or
  drag each other. Rulers, movement tracking, traps, and areas of effect
  that count height.
- An Initiative tracker, roll requests, group saves, an encounter builder,
  and the SRD 5.2.1 monsters, conditions and spell areas built in.
- Dice roll on the server, so everyone sees the same result. Anyone can
  still roll real dice and type the total.
- Character stat blocks, with an import from a public D&D Beyond character.
- A journal with secrets, map pins, chat and whispers, handouts, an in-game
  clock, music and sound, an X-card, and a table display for a TV.

<p align="center">
  <img src="docs/images/readme-map.webp" width="600" alt="The DM's view of a fight in a cavern: the party's tokens and three monsters on the map, fog over the ground the party has not seen yet, and the initiative tracker beside it">
  <img src="docs/images/readme-phone.webp" width="173" alt="A player's phone during the same fight: the map above, and Bree's stat block raised over it with an Arcana check just rolled">
</p>
<p align="center">
  <img src="docs/images/readme-stat-block.webp" width="400" alt="A player's character stat block, with a Perception check just rolled from its Wisdom box">
  <img src="docs/images/readme-dice.webp" width="400" alt="The DM's Dice panel, with a goblin's attack and damage rolled in secret and the players' recent rolls under them">
</p>
<p align="center"><sub>Art in these screenshots is credited, with its licenses, in <a href="CREDITS.md#readme-screenshots">CREDITS.md</a>.</sub></p>

One Node 24 process serves the React app, the JSON API and the WebSocket,
while Postgres 17 holds the rooms and the `/data/assets` volume holds
uploaded images, map videos and sounds. Map videos stay off until the
server sets `ANIMATED_MAPS=1`, and uploaded sounds until it sets
`ROOM_SOUND=1`. In production it runs with Docker Compose behind any HTTPS
reverse proxy or tunnel that passes WebSockets through, reaches the
internet only through an egress proxy, and backs up every night (04:00 UTC
by default). The desktop app runs the same server and a PostgreSQL 17 of its
own on one computer, for players on the same network
([Run it on your computer](#run-it-on-your-computer)).

[FEATURES.md](FEATURES.md) lists everything it does today, by area, and the
[DM guide](docs/dm-guide.md) teaches the DM tools step by step, from a
quick start to building maps, running fights and worked scenarios. The
guide is also in the app, on the Docs page (`/docs`) linked from Home.

## Quick start

To try it on one computer with Docker, run the published image from
[Docker Hub](https://hub.docker.com/r/jwhitlow45/raccoon-vtt) beside a
Postgres container:

```bash
mkdir raccoon-vtt-try && cd raccoon-vtt-try
cat > compose.yml <<'EOF'
name: raccoon-try
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: raccoon
      POSTGRES_PASSWORD: raccoon
      POSTGRES_DB: raccoon
    volumes:
      - db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U raccoon -d raccoon"]
      interval: 5s
      timeout: 5s
      retries: 10
  raccoon:
    image: docker.io/jwhitlow45/raccoon-vtt:latest
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: development
      DATABASE_URL: postgres://raccoon:raccoon@postgres:5432/raccoon
      PUBLIC_ORIGIN: http://127.0.0.1:9180
    ports:
      - "127.0.0.1:9180:3000"
    volumes:
      - assets:/data/assets
volumes:
  db:
  assets:
EOF
docker compose up -d
```

Open http://127.0.0.1:9180, exactly that address and not `localhost`,
because the WebSocket checks Origin exactly. Create a room on the Home
page. To see the player's side, copy the player link from the room's Menu
and open it in a private window or another browser.

This runs with `NODE_ENV=development` and listens only on this computer.
Production refuses to start without an `https` origin, both egress proxies
and `ROOM_SECRET_KEY`. `docker compose down` stops it and keeps your rooms.
`docker compose down -v` deletes them too. To put it on the internet, follow
[Self-hosting with the published image](#self-hosting-with-the-published-image).

## Run it on your computer

The desktop app runs RaccoonVTT on one computer, with a database of its own,
and players on the same network join from their browsers. Installing it
needs no Docker, Postgres, Node or terminal. It runs on Windows 10 or 11
(x64), macOS 15 or later (Apple silicon and Intel), and Linux with glibc
2.36 or later (x64 and arm64), which covers Ubuntu 24.04, Debian 12 and
Fedora 37 and up. From v0.5.0 on, each
[release](https://github.com/jwhitlow45/raccoon-vtt/releases) carries one
download per system.

The installers are not signed with an Apple or Windows identity yet, so each
system asks you to approve the first run:

- **Windows**: run `raccoon-vtt-X.Y.Z-windows-x64-setup.exe`. At "Windows
  protected your PC", choose **More info**, then **Run anyway**. Then answer
  **Yes** to the prompt for an unknown publisher. The installer adds a
  Windows Firewall rule that lets devices on private networks reach
  RaccoonVTT.
- **macOS**: open `raccoon-vtt-X.Y.Z-macos-arm64.dmg` (Apple silicon) or
  `raccoon-vtt-X.Y.Z-macos-x64.dmg` (Intel) and drag RaccoonVTT to
  Applications, then open it. When "Apple could not verify..." appears,
  choose **Done**. In System Settings, Privacy & Security, under Security,
  press **Open Anyway** for RaccoonVTT and confirm with your password. If the
  window then says macOS blocked part of RaccoonVTT, run this in Terminal and
  open it again:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/RaccoonVTT.app"
  ```

- **Linux**: on Ubuntu 24.04 or later and Debian 12 or later, install the
  deb (`_arm64.deb` on an arm64 computer):

  ```bash
  sudo apt install ./raccoon-vtt_X.Y.Z_amd64.deb
  ```

  On other distributions, use the AppImage:

  ```bash
  chmod +x raccoon-vtt-X.Y.Z-linux-x86_64.AppImage
  ./raccoon-vtt-X.Y.Z-linux-x86_64.AppImage
  ```

  It needs FUSE 2 (the `fuse2` or `libfuse2` package on most
  distributions). On Ubuntu 24.04 its sandbox cannot start, so use the deb
  there.

Opening RaccoonVTT shows its window and opens your browser at
`http://localhost:3170` (the next free port on the first run, if 3170 is
taken). The window shows the address players type and its QR code, and
**Players on this network can join** is on at first. Players open the
address over plain HTTP, so play on a network you trust. What that means is
in [what the desktop app guarantees](docs/self-hosting.md#what-the-desktop-app-guarantees).
The DM guide's [Hosting from your computer](docs/dm-guide.md#hosting-from-your-computer)
covers a night's play, and [docs/self-hosting.md](docs/self-hosting.md#the-desktop-app)
covers where the data lives, backups, updates and going back.

## Self-hosting with the published image

Each release is an image on Docker Hub, `docker.io/jwhitlow45/raccoon-vtt`,
for linux/amd64 and linux/arm64, so a server needs only two files from the
release, `compose.yml` and `.env`. You also need a Linux server with Docker
Engine 28 or later and the Docker Compose plugin 2.31 or later, and a
hostname for the site.

Pick a release from the repository's
[tags](https://github.com/jwhitlow45/raccoon-vtt/tags), `vX.Y.Z`, and download
its two files into a folder of their own:

```bash
mkdir ~/raccoon-vtt && cd ~/raccoon-vtt
tag=vX.Y.Z
curl -fsSLo compose.yml "https://github.com/jwhitlow45/raccoon-vtt/raw/$tag/selfhost/compose.yml"
curl -fsSLo .env "https://github.com/jwhitlow45/raccoon-vtt/raw/$tag/selfhost/env.example"
chmod 600 .env
sed -i "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s|^ROOM_SECRET_KEY=$|ROOM_SECRET_KEY=$(openssl rand -base64 32)|" .env
```

In `.env`, set `PUBLIC_ORIGIN` to `https://` plus the hostname. Uncomment
`COMPOSE_PROFILES=https` to have Caddy serve HTTPS, or leave it commented
for your own reverse proxy or tunnel. Then start it:

```bash
docker compose up -d
docker compose ps
```

`raccoon`, `postgres`, `egress` and, with the `https` profile, `caddy`
should show `(healthy)` within about 30 seconds, and `backup` should show
`Up`, since it has no health check.
[docs/self-hosting.md](docs/self-hosting.md#self-hosting-with-the-published-image)
has every step, including HTTPS, the firewall rules, updates and backups.

## Docs

- [FEATURES.md](FEATURES.md): what the app does today, by area.
- [docs/dm-guide.md](docs/dm-guide.md): the DM guide, also in the app.
- [docs/self-hosting.md](docs/self-hosting.md): installing a server, its
  settings, HTTPS and the reverse proxy, updating, backups, verifying the
  image and removing it, and the desktop app's data, backups and updates.
- [docs/operations.md](docs/operations.md): running it day to day: the admin
  commands, the admin page and the logs.
- [docs/development.md](docs/development.md): local development, the checks
  and tests, the coding standards, and continuous integration.
- [docs/releasing.md](docs/releasing.md): tagging a release, the image
  workflow, the changelog and the Docker Hub overview.
- [docs/design/](docs/design/README.md): the technical design and the note
  behind each feature.
- [docs/assurance-case.md](docs/assurance-case.md): what the app protects
  and what it leaves to you, its threat model, and how it counters common
  weaknesses.
- [ROADMAP.md](ROADMAP.md): what comes next, over the next year, and what
  the project has decided not to do.
- [GOVERNANCE.md](GOVERNANCE.md): how decisions are made and who does what.
- [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md),
  [SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md).

## License

The code is under the GNU Affero General Public License v3.0 (AGPL-3.0),
in the [LICENSE](LICENSE) file. You may use, change and share it, and if
you run a changed copy as a site that other people use, you must offer
those people the source code of your changed version.

The third-party art, the common-password list and the SRD 5.2.1 text that
ship with the app keep their own licenses, which [CREDITS.md](CREDITS.md)
lists with each one's source, and
[shared/srd/NOTICE.md](shared/srd/NOTICE.md) holds the SRD's notice. None
of the art is AI generated.
