# Security assurance case

This page sets out what raccoon-vtt promises about security, what it does
not promise, and why there is good reason to believe the promises hold. It
covers who might attack a server, where trust changes hands, the design
principles the app follows and the common weaknesses it guards against,
with links to the code that does the work. The full technical detail lives
in section 10 of the [design](design/design.md#10-rooms-access-and-security),
and [SECURITY.md](../SECURITY.md) explains how to report a vulnerability.

## What you can expect

These are the app's security requirements. The sections below show how
the code meets each one, and section 10 of the design has the detail.

1. **Players see only what the DM allows.** Hidden tokens, DM-only notes,
   the ground under the fog and anything else a player should not see
   never leave the server for that player's device. A reload, a slow
   connection or the browser's developer tools reveal nothing more.
2. **Only the right people get in.** Joining a room as a player takes its
   player password or player link. Acting as its DM takes its DM link or a
   one-time invite from a DM device. Every change anyone makes is checked
   on the server against their role in that room, never trusted from the
   device.
3. **Secrets are stored safely.** Player passwords are kept as argon2id
   hashes. Session tokens, DM keys and invites are 256-bit random values,
   table display codes are 50-bit ones, and the server keeps only their
   SHA-256 hashes. The copy of the player password that lets the DM show
   the player link again is encrypted with AES-256-GCM under a key that
   never enters the database.
4. **One room or one visitor cannot take the server down.** Rate limits,
   room quotas, size limits and socket caps bound what any address,
   session or room can cost.
5. **The server cannot be turned against its own network.** The app has no
   direct route to the internet. It reaches out only through a proxy that
   allows a short list of hosts for searches and refuses every private
   address for image imports.
6. **Uploaded and imported files are treated as hostile.** Images are
   checked by their contents, decoded only by a short list of image
   loaders, re-encoded and stripped of metadata. An animated map's video,
   where the server's owner allows them, is never re-encoded. The server
   reads only its headers, keeps what an allowlist names and zeroes the rest
   in place, padding included. Each value it keeps is read and checked,
   once, so no copy it did not read survives. No write the server makes
   reaches the media data: each one is checked against it before it runs.
   Nothing is decoded on the server. A video's length is its whole
   presentation timeline, held to the ten-minute cap whatever the file's
   durations say. The check runs in
   a worker thread with a 5 second budget and is ended at its deadline, so
   a crafted file cannot stall the server for the other rooms. A sound file,
   where the server's owner allows them, must be a constant bitrate MP3 from
   its first byte to its last, with no tag and no other byte, which the
   server checks by walking its frame headers and never decodes. Room imports are
   validated and bounded before anything is kept, and the changes an
   imported map or character turns into are checked like any other.
7. **Browsers get the usual protections.** A strict Content Security
   Policy, HSTS, `SameSite=Strict` cookies, cross-site request checks and
   an exact Origin check on the WebSocket.
8. **Releases can be verified.** Every release's source archive and SBOM
   are signed in GitHub Actions and carry build provenance, and every image
   from v0.3.0 on is signed too, as
   [releasing.md](releasing.md#verify-a-releases-assets) and
   [self-hosting.md](self-hosting.md#verify-the-image) explain.

## What you cannot expect

Some things are left out on purpose, and it is better to know them before
you rely on the app.

- **Players in a room trust each other.** Everyone in a room shares one
  password, so anyone who knows it can continue as any player in that room
  and read that player's whispers (design section 10.2). The maintainer
  chose this trade for the sake of easy joining at the table.
- **The server's operator can read everything.** Rooms are not end-to-end
  encrypted. Whoever runs the server, or anyone who can read both its
  database and its environment, can read every room and every player
  password. Play on a server run by someone you trust.
- **HTTPS is the front end's job.** The app speaks plain HTTP on a private
  Docker network and relies on the reverse proxy or tunnel in front of it
  for TLS. A production server refuses to start with an origin that is not
  `https://`.
- **A DM link is the DM.** Anyone holding a room's DM link or an unused
  invite has the DM's full power in that room until the DM replaces the
  link. Room IDs, on the other hand, are not secrets at all.
- **Limits are not a shield against a large flood.** They bound what each
  address, session and room can spend, but a large attack from many
  addresses needs help from the front end, such as Cloudflare.
- **A video reaches players' decoders.** An animated map's video is not
  re-encoded, so a DM could send players' browsers bytes aimed at their
  video decoder, which images never reach. Browsers decode media in a
  sandboxed process, the DM is already trusted with the players, and a
  player who sets Animated maps to Still downloads no video. Text inside a
  video's own frames, such as H.264 user data, and an MP4's timecode track
  are left as they are, since the server never writes inside the media
  data. Animated maps are off unless the server's owner turns them on.
- **A sound reaches players' decoders too.** The server walks a sound's
  MP3 frame headers and decodes nothing, so a crafted frame inside an
  otherwise valid file can still reach the audio decoder of a player's
  browser, inside its media sandbox, and only in the room of the DM who
  added it. A sound is served as `audio/mpeg` with a fixed type and never
  runs as a page. A player hears only what plays now, and a device with
  Room sound off plays none. Room sound is off unless the server's
  owner turns it on.
- **Only the latest release is fixed.** Older releases do not receive
  security fixes, so keep your server updated
  ([Updating](self-hosting.md#updating)).

## Threat model

**What is worth protecting:** the hidden parts of each room (fog, hidden
tokens, DM notes and secret rolls), the secrets that grant access (player
passwords, DM links, invites and session tokens), the server's
availability, the host and network the server runs on, and the integrity
of the releases people install.

**Who might attack it:**

| Actor | Can do | Trusted with |
| --- | --- | --- |
| Anyone on the internet | Reach the site, create rooms, try passwords, send any request they like | Nothing |
| A player in a room | Everything a player may do, plus inspect and replay their own traffic | What the DM shows players, and the other players' trust |
| A DM of a room | Everything in their own room | Their own room only |
| A hostile file | Arrive as an upload, a URL import, a room import, a Universal VTT file or a D&D Beyond character | Nothing |
| A compromised dependency or CI step | Run code at build or release time | As little as possible (see below) |
| The server's operator | Everything on their server | Everything: they are outside this model |

The attacks considered include password guessing, stolen or planted
sessions, cross-site requests and WebSocket hijacking, script injection,
SQL injection, server-side request forgery, path tricks in file names,
decompression bombs and oversized inputs, resource exhaustion, and leaks
of hidden data through the sync protocol.

## Trust boundaries

| Boundary | What crosses it | How it is guarded |
| --- | --- | --- |
| The internet to the front end | Every request and WebSocket message | TLS at the front end, then every check below |
| The front end to the app (`raccoon-edge`) | Requests and the client's address | The app believes a forwarded client address only when `TRUST_CF_CONNECTING_IP=1` says the front end overwrites it ([clientIp.ts](../server/auth/clientIp.ts)) |
| The app to Postgres (`raccoon-data`) | Queries | An internal network with nothing else on it, and parameterized SQL |
| The app to the internet (`raccoon-proxy`, then the egress proxy) | Searches, image imports, character imports | Two proxy ports with their own allowlists ([squid.conf](../docker/squid.conf)), and responses treated as hostile |
| One room to another, and one role to another | Ops, snapshots and HTTP actions | A grant per session and room, checked on every action ([grants.ts](../server/auth/grants.ts), [permissions.ts](../shared/permissions.ts)), and a projection per viewer ([project.ts](../shared/project.ts)) |
| The admin page | Room listings and deletions | A separate password hash, a separate session cookie, and its own login limits ([adminSessions.ts](../server/auth/adminSessions.ts)) |
| Source to release | Code, dependencies and signatures | Pinned dependencies and actions, read-only workflow tokens by default, and an approval before an image is published ([image.yml](../.github/workflows/image.yml)), and builds anyone can repeat: one commit gives byte-identical client files and the same image ([vite.config.ts](../vite.config.ts), [Dockerfile](../Dockerfile)) |

Every Docker network in the stack is internal except the egress proxy's
way out (and Caddy's, with the `https` profile), so a container that is
taken over has no route of its own to the internet or the host's network
([selfhost/compose.yml](../selfhost/compose.yml)).

## Secure design principles

The app follows the classic principles of Saltzer and Schroeder:

- **Economy of mechanism.** One Node process, one writer per room, and one
  pure reducer that the server and the client share. Hand-written SQL in
  one schema file, with no ORM, and few dependencies.
- **Fail-safe defaults.** A player's view is built from an allowlist, so a
  field added to the data model later stays private until someone allows
  it on purpose ([project.ts](../shared/project.ts)). The fog fails closed
  (design section 13.3). The admin page does not exist until its password
  hash is set. A production server refuses to start without its required
  settings or with development cookies ([config.ts](../server/config.ts),
  [sessions.ts](../server/auth/sessions.ts)). A Turnstile check that cannot
  reach Cloudflare refuses rather than lets through.
- **Complete mediation.** Every op is validated, deduplicated, authorized
  and only then applied, on the server. A socket's grant is checked again
  every minute and on every epoch change, so a kicked player or a replaced
  DM link takes effect at once ([actor.ts](../server/rooms/actor.ts)).
- **Open design.** The code is public. Security rests on secrets (keys,
  passwords and tokens), never on the code being hidden.
- **Separation of privilege.** The player password, the DM link, table
  display codes and the admin password each grant something different, and
  one never stands in for another. Publishing a release's image needs an
  approval on top of a tag.
- **Least privilege.** Every container drops all Linux capabilities and
  sets `no-new-privileges`, every long-running one has a read-only root
  filesystem, and the app runs as an unprivileged user. The backup service
  never receives the room secret key. Workflows start with a read-only
  token or none, and each job asks only for what it needs.
- **Least common mechanism.** Each room runs in its own actor with its own
  limits, and the expensive limits count per session, per address and per
  room, so one busy room does not starve another.
- **Psychological acceptability.** Security should not get in the way of a
  game night. The app suggests easy three-word passphrases, hands out
  player links and QR codes, and keeps secrets out of the address bar.

## Common weaknesses and how they are countered

This follows the OWASP Top 10 (2021), with the CWE entries that matter most
for a web app like this one.

| Weakness | How raccoon-vtt counters it |
| --- | --- |
| Broken access control (A01, CWE-862, CWE-863) | Authority comes only from the server's grant for that session and room. [permissions.ts](../shared/permissions.ts) decides every op, and [project.ts](../shared/project.ts) decides what each viewer receives. |
| Cryptographic failures (A02) | Only published algorithms from Node's crypto and argon2: argon2id at OWASP's parameters ([passwords.ts](../server/auth/passwords.ts)), SHA-256 of 256-bit tokens with a timing-safe compare ([tokens.ts](../server/auth/tokens.ts)), and AES-256-GCM ([playerSecret.ts](../server/auth/playerSecret.ts)). No SHA-1, MD5 or CBC. |
| Injection (A03, CWE-89, CWE-79) | Every SQL statement takes its values as parameters. React escapes all text, the app never sets raw HTML, and the Content Security Policy allows scripts only from the site itself ([security.ts](../server/http/security.ts)). |
| Insecure design (A04) | Features are designed in public notes that state their rules, the security ones included, and the cases the tests check ([design notes](design/README.md)). Property tests throw thousands of generated inputs at the parsers and the protocol ([development.md](development.md#property-tests)). |
| Security misconfiguration (A05) | Settings are validated once at boot, and a bad one stops the server ([config.ts](../server/config.ts)). The shipped compose files set the container hardening, and every response carries the security headers. |
| Vulnerable components (A06) | Dependabot proposes updates every week and raises alerts, every release carries an SBOM, and base images and actions are pinned by digest or commit. |
| Authentication failures (A07, CWE-307) | Wrong passwords are limited per address and room, with growing delays, and the admin login has its own limits ([ratelimit.ts](../server/auth/ratelimit.ts)). Common passwords are refused. Sessions rotate when a device becomes a DM, and cookies are `__Host-`, `Secure`, `HttpOnly` and `SameSite=Strict`. |
| Integrity failures (A08) | Source archives and SBOMs, and images from v0.3.0 on, are signed with Cosign, and the archives and SBOMs carry provenance. A room import is checked against the room state's schema and the room limits before anything is kept. |
| Logging failures (A09) | The server logs every request and every admin sign-in, failed sign-in, pin and deletion. Request logs carry the method, path and address but no headers or bodies, and secrets travel in bodies, cookies and URL fragments, so they stay out of the logs. |
| Server-side request forgery (A10, CWE-918) | Outbound requests go only through the egress proxy. Image imports are `https` on port 443 only, with every redirect checked again and private, loopback and reserved addresses refused ([fetchPublic.ts](../server/assets/fetchPublic.ts)). |
| Cross-site request forgery (CWE-352) and WebSocket hijacking (CWE-1385) | Every request that changes anything must come from the site itself, by `Sec-Fetch-Site` or an exact Origin. The WebSocket upgrade needs an exact Origin match. No CORS headers are sent. |
| Unrestricted upload (CWE-434) | Images are recognized by their bytes, never their names, and SVG is always refused. Each is re-encoded to WebP and stored under a name made from its hash, so no file name a user sends ever reaches the disk ([process.ts](../server/assets/process.ts), [store.ts](../server/assets/store.ts)). A video is taken only as WebM or MP4 with `kind=video`, recognized by its bytes, checked by a bounded header parser with no decoder, served under the type its row records, and stored by hash like an image ([server/assets/video](../server/assets/video)). |
| Resource exhaustion (CWE-400) | Body limits on every route, room limits on every kind of content (design section 10.5), a bounded queue for password hashing, socket caps, and counted entries and bytes when a zip is read ([importRoom.ts](../server/rooms/importRoom.ts)). A video's header check runs in a worker thread, with every loop under its 5 second budget and the worker ended at the deadline ([check.ts](../server/assets/video/check.ts)). |
| Input validation (CWE-20) | Every message and op is checked against a zod schema with explicit bounds before it is used ([protocol.ts](../shared/protocol.ts)). The same schemas type the client, so the two never drift apart. |

## How this is checked

- CodeQL scans every push to `main` and every pull request, and OpenSSF
  Scorecard checks the repository's own practices. Both also run weekly.
- Secret scanning with push protection, Dependabot alerts and private
  vulnerability reporting are on for the repository.
- Unit and integration tests cover the permission rules, the projection,
  the rate limits and the HTTP and WebSocket checks, and browser tests play
  through the app as a DM and as players. All of them run in CI on every
  change ([development.md](development.md#continuous-integration)).
