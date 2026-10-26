import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The self-host compose file and its .env template (README.md, "Self-hosting
 * with the published image"), made from the server stack:
 *
 *   node scripts/selfhost-compose.ts           writes selfhost/compose.yml and selfhost/env.example
 *   node scripts/selfhost-compose.ts --check   exits 1 while either differs from what this makes
 *
 * `pnpm selfhost` runs the first. scripts/selfhost-compose.test.ts fails
 * while the committed files differ, so they cannot drift from
 * docker-compose.server.yml, docker/squid.conf, docker/backup.sh,
 * docker/server.env.example or package.json's version.
 *
 * The edits are text edits, so every comment of the server stack carries
 * over. Each one names the exact text it replaces and throws when that text
 * is gone, so a change to the server stack that this does not understand
 * stops the generator instead of slipping through.
 */

/**
 * The published image, without its tag. .github/workflows/image.yml pushes
 * to it and fails unless its own Docker Hub repository is this one.
 */
export const IMAGE = "docker.io/jwhitlow45/raccoon-vtt";

/**
 * The https profile's Caddy, pinned by digest as the server stack's images
 * are, to a release at least two weeks past its release date. 2.11.7 fixes
 * 2.11.6's HTTP/2 crash in reverse_proxy. Refresh deliberately with
 * `docker buildx imagetools inspect caddy:<version>-alpine`.
 */
const CADDY_IMAGE = "caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f";

export type Sources = {
  serverCompose: string;
  serverEnv: string;
  squidConf: string;
  backupSh: string;
  /** package.json's version, X.Y.Z. */
  version: string;
};

export type Output = { compose: string; env: string };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const COMPOSE_PATH = "selfhost/compose.yml";
export const ENV_PATH = "selfhost/env.example";

export function readSources(root = ROOT): Sources {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const pkg = JSON.parse(read("package.json")) as { version?: unknown };
  return {
    serverCompose: read("docker-compose.server.yml"),
    serverEnv: read("docker/server.env.example"),
    squidConf: read("docker/squid.conf"),
    backupSh: read("docker/backup.sh"),
    version: String(pkg.version),
  };
}

/** The tag a host runs by default: the minor release, so `docker compose pull` takes its patches. */
export function minorOf(version: string): string {
  const m = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  if (!m) throw new Error(`package.json's version must be X.Y.Z, not ${JSON.stringify(version)}`);
  return `${m[1]}.${m[2]}`;
}

/**
 * `content` as a YAML literal block scalar whose lines start at `indent`
 * spaces, under a key at `indent - 2`, read back by Compose as exactly these
 * bytes: every $ doubled so Compose does not interpolate it, and the
 * chomping indicator chosen from how the text ends.
 */
export function blockScalar(content: string, indent: number): string {
  if (content === "") throw new Error("an empty config has no block scalar");
  // YAML turns CRLF into LF and forbids most control characters, so either
  // would make the mounted file differ from its source.
  if (/[\r\u0000-\u0008\u000b-\u001f\u007f\ufeff]/.test(content)) {
    throw new Error("a config may hold only printable text, tabs and LF line ends");
  }
  const chomp = !content.endsWith("\n") ? "-" : content.endsWith("\n\n") ? "+" : "";
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  // A function, because a replacement string would read "$$" as one $.
  const lines = body.replaceAll("$", () => "$$").split("\n");
  // A first line that starts with a space or a tab would otherwise set the block's
  // indentation itself. The indicator counts from the key, two spaces out.
  const indicator = /^[ \t]/.test(lines.find((l) => l !== "") ?? "") ? "2" : "";
  const pad = " ".repeat(indent);
  return `|${indicator}${chomp}\n${lines.map((l) => (l === "" ? "" : pad + l)).join("\n")}\n`;
}

/** `text` with the one occurrence of `from` replaced. Throws on none or several. */
function replaceOnce(text: string, from: string, to: string, what: string): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) {
    throw new Error(`${what}: expected exactly one ${JSON.stringify(from.slice(0, 80))}. Update scripts/selfhost-compose.ts to match the source.`);
  }
  return text.slice(0, at) + to + text.slice(at + from.length);
}

function expectOnce(text: string, what: string, where: string): void {
  replaceOnce(text, what, what, where);
}

/** The edit `edit` applied inside one service's block of the services section. */
function inService(text: string, service: string, edit: (block: string) => string): string {
  const start = text.indexOf(`\n  ${service}:\n`);
  if (start < 0) throw new Error(`the server stack has no service ${service}`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n\S/);
  const end = next < 0 ? text.length : start + 1 + 1 + next;
  return text.slice(0, start + 1) + edit(text.slice(start + 1, end)) + text.slice(end);
}

const HEADER = `# Self-hosting raccoon-vtt with the published image (README.md,
# "Self-hosting with the published image"). This file and an .env next to it
# are all a host needs:
#
#   docker compose up -d
#   docker compose --profile https up -d      with Caddy as the HTTPS front end
#
# GENERATED by scripts/selfhost-compose.ts from docker-compose.server.yml,
# docker/squid.conf and docker/backup.sh. Do not edit it: change those and
# run \`pnpm selfhost\`. A unit test fails while this file differs from what
# the generator makes.
#
# It is the server stack, docker-compose.server.yml in the repository, whose
# header draws the whole picture, with these changes:
#
#   - \`raccoon\` runs the published image instead of building one.
#   - squid.conf and backup.sh are inline, in the configs at the end. The
#     one-shot \`config-files\` service copies them onto the raccoon-config
#     volume, and each service that reads one mounts it from there,
#     read-only, at the path where the server stack bind-mounts the file.
#   - An optional \`https\` profile adds Caddy, which publishes ports 80 and
#     443 and gets the certificate itself.
#   - TRUST_CF_CONNECTING_IP comes from .env and is 0 unless .env sets it,
#     the app's own default. Most hosts are not behind Cloudflare, and
#     trusting the header anywhere else lets a visitor pick an address.
#
# Without the profile nothing publishes a port, as in the server stack: your
# own proxy or tunnel joins raccoon-edge and sends the site's hostname to
# http://raccoon:3000 (README.md, "Put HTTPS in front of it").
#
# The internal networks set \`gateway_mode_ipv4: isolated\`, which needs Docker
# Engine 28 or later. The inline configs, the volume \`subpath\` mounts and
# \`restart\` in depends_on need Docker Compose 2.31 or later, the oldest
# tested.
#
# Secrets come from .env, which compose reads for the \${...} substitutions
# below. The required ones use \`:?\`, so compose refuses to start without
# them instead of booting half configured.

`;

const CADDYFILE = `# The https profile's front end (selfhost/compose.yml). SITE_ADDRESS is
# PUBLIC_ORIGIN unless .env sets it, and Caddy gets and renews the
# certificate for its host on its own. reverse_proxy passes WebSockets
# through and keeps the browser's Origin and Host headers.
{$SITE_ADDRESS} {
\treverse_proxy raccoon:3000 {
\t\t# With TRUST_CF_CONNECTING_IP=1 in .env, every per-address limit
\t\t# in the app keys on this header. Overwriting it with the address
\t\t# that connected means no client can make one up.
\t\theader_up CF-Connecting-IP {remote_host}
\t}
}
`;

const DEPENDS_ON_CONFIG = `      config-files:
        condition: service_completed_successfully
        restart: true
`;

/** A volume list entry that mounts one file of raccoon-config, read-only. */
function configMount(target: string, subpath: string, anchor = ""): string {
  const head = anchor ? `      - &${anchor}\n        type: volume\n` : "      - type: volume\n";
  return `${head}        source: raccoon-config
        target: ${target}
        read_only: true
        volume:
          subpath: ${subpath}
`;
}

function configsSection(s: Sources): string {
  return `
# The files the services read, inline so this file is all a host needs. Every
# $ is doubled, which Compose reads as one $ and never as a variable.
# config-files copies them onto the raccoon-config volume.
configs:
  # docker/squid.conf, byte for byte.
  squid-conf:
    content: ${blockScalar(s.squidConf, 6)}
  # docker/backup.sh, byte for byte.
  backup-sh:
    content: ${blockScalar(s.backupSh, 6)}
  # The https profile's Caddy.
  caddyfile:
    content: ${blockScalar(CADDYFILE, 6)}`;
}

function extraServices(configHash: string): string {
  return `
  # -------------------------------------------------------- config files
  # Copies squid.conf, backup.sh and the Caddyfile from the configs at the
  # end of this file onto the raccoon-config volume, then exits.
  #
  # Compose can put an inline config only into a container whose root
  # filesystem it can write, and refuses to for a read-only service. So
  # this copier is the one service here that is not read-only. It has no
  # network and no capabilities, and it ends within a second. Root on
  # purpose, as the backup service is: a new named volume comes up root's.
  #
  # Compose does not count a config's content as part of a service, so the
  # label holds the configs' hash: a changed file changes the label, and
  # \`docker compose up -d\` recreates this copier. \`restart: true\` in each
  # reader's depends_on then restarts the reader, which is what makes it
  # read the new file. A file is replaced rather than rewritten, because the
  # backup loop's shell reads its script as it runs. A copy left behind by a
  # run that died is removed first. It is read-only, and root without
  # capabilities cannot write into it, so the copy must not depend on cp
  # replacing it (busybox's does, other cps need -f).
  config-files:
    image: *postgres-image
    labels:
      raccoon.config-sha256: "${configHash}"
    command:
      - sh
      - -c
      - |
        set -eu
        for f in squid.conf backup.sh Caddyfile; do
          cmp -s "/src/$$f" "/config/$$f" && continue
          rm -f "/config/.$$f.new"
          cp "/src/$$f" "/config/.$$f.new"
          mv -f "/config/.$$f.new" "/config/$$f"
        done
    user: "0:0"
    network_mode: none
    configs:
      - source: squid-conf
        target: /src/squid.conf
      - source: backup-sh
        target: /src/backup.sh
      - source: caddyfile
        target: /src/Caddyfile
    volumes:
      - raccoon-config:/config
    restart: "no"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    logging:
      driver: local
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: 64m
          pids: 16

  # --------------------------------------------------------------- https
  # The optional HTTPS front end, for a host with ports 80 and 443 open to
  # the internet and a DNS record for the site pointing at it. It starts
  # only with the \`https\` profile: \`--profile https\` on every command, or
  # COMPOSE_PROFILES=https in .env. Leave it off when your own proxy or
  # tunnel serves the site.
  caddy:
    image: ${CADDY_IMAGE}
    profiles: ["https"]
    networks:
      # raccoon-edge to reach the app, as any front end does. raccoon-https
      # for the internet: the published ports and the certificate
      # authority, which the internal raccoon-edge cannot carry.
      - raccoon-edge
      - raccoon-https
    ports:
      - "80:80"
      - "443:443"
      # HTTP/3.
      - "443:443/udp"
    # Names resolve through Cloudflare, as squid's do, rather than through the
    # host's resolver, which may sit on the LAN that README.md's firewall
    # rules for this bridge keep Caddy away from. Docker's own DNS still
    # answers for raccoon.
    dns:
      - 1.1.1.1
      - 1.0.0.1
    environment:
      # The Caddyfile's {$SITE_ADDRESS}.
      SITE_ADDRESS: \${SITE_ADDRESS:-\${PUBLIC_ORIGIN:?set PUBLIC_ORIGIN in .env, for example https://vtt.example.com}}
    volumes:
${configMount("/etc/caddy/Caddyfile", "Caddyfile").trimEnd()}
      # The certificates and the ACME account. Losing them costs only a new
      # certificate, within the certificate authority's rate limits.
      - raccoon-caddy:/data
    depends_on:
${DEPENDS_ON_CONFIG.trimEnd()}
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      # Caddy runs as root in its image, and binding ports 80 and 443 takes
      # this. Without the rest, root writes only what root owns: its volume
      # and the in-memory folders below.
      - NET_BIND_SERVICE
    read_only: true
    tmpfs:
      # Caddy's autosave of the config it runs (XDG_CONFIG_HOME).
      - /config:mode=0700,size=8m
      - /tmp:mode=1777,size=16m
    healthcheck:
      # The admin API, which listens on the container's own loopback only,
      # answers once a config is loaded. busybox wget, as the image has no
      # curl.
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:2019/config/"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    logging:
      driver: local
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 256m
          pids: 128
`;
}

const EXTRA_NETWORK = `
  # The https profile's way to the internet, with a real gateway like
  # raccoon-egress, and Caddy alone on it. Pinned beside raccoon-egress for
  # the same reasons. Change it if it clashes with a network on your host.
  raccoon-https:
    name: raccoon-https
    driver: bridge
    enable_ipv6: false
    driver_opts:
      com.docker.network.bridge.name: br-rvtt-https
      com.docker.network.bridge.enable_icc: "false"
    ipam:
      config:
        - subnet: 172.31.243.16/28
`;

const EXTRA_VOLUMES = `  # The files config-files copies. Safe to delete while the stack is down:
  # the next \`up\` writes them again.
  raccoon-config:
  # Caddy's certificates, for the https profile.
  raccoon-caddy:
`;

export function renderCompose(s: Sources): string {
  const minor = minorOf(s.version);
  let body = s.serverCompose;
  const nameAt = body.indexOf("\nname: raccoon\n");
  if (nameAt < 0) throw new Error("docker-compose.server.yml: expected a `name: raccoon` line");
  body = body.slice(nameAt + 1);

  // The commands in its comments, as a host types them next to this file.
  if (!body.includes("docker compose -f docker-compose.server.yml ")) {
    throw new Error("docker-compose.server.yml: expected commands with -f docker-compose.server.yml in its comments");
  }
  body = body.replaceAll("docker compose -f docker-compose.server.yml ", "docker compose ");

  body = inService(body, "raccoon", (b) => {
    b = replaceOnce(
      b,
      "    build: .\n",
      `    # The published image. RACCOON_VERSION in .env pins another release.
    image: \${RACCOON_IMAGE:-${IMAGE}}:\${RACCOON_VERSION:-${minor}}
`,
      "raccoon's build",
    );
    // The server stack's comment explains its fixed 1, which this file does not have.
    return replaceOnce(
      b,
      `      # Safe only while the front end is the only way in and overwrites this
      # header with the real client address, as Cloudflare does. Behind a
      # proxy that does not overwrite it, set it to 0 or configure the proxy
      # to (README, "Put HTTPS in front of it").
      - TRUST_CF_CONNECTING_IP=1
`,
      `      # From .env, and 0 unless .env sets it, the app's own default: limits
      # key on the address that connected. env.example says when 1, which
      # takes the address from the CF-Connecting-IP header, is safe.
      - TRUST_CF_CONNECTING_IP=\${TRUST_CF_CONNECTING_IP:-0}
`,
      "raccoon's TRUST_CF_CONNECTING_IP",
    );
  });

  const dependsOnPostgres = "    depends_on:\n      postgres:\n        condition: service_healthy\n";
  body = inService(body, "backup", (b) => {
    b = replaceOnce(b, "      - &backup-script ./docker/backup.sh:/backup/backup.sh:ro\n", configMount("/backup/backup.sh", "backup.sh", "backup-script"), "backup's script mount");
    return replaceOnce(b, dependsOnPostgres, dependsOnPostgres + DEPENDS_ON_CONFIG, "backup's depends_on");
  });
  body = inService(body, "restore", (b) => {
    // Its `- *backup-script` volume is the mount above, so it follows on its own.
    expectOnce(b, "      - *backup-script\n", "restore's script mount");
    return replaceOnce(b, dependsOnPostgres, dependsOnPostgres + DEPENDS_ON_CONFIG, "restore's depends_on");
  });
  body = inService(body, "egress", (b) =>
    replaceOnce(
      b,
      "    volumes:\n      - ./docker/squid.conf:/etc/squid/squid.conf:ro\n",
      `    volumes:\n${configMount("/etc/squid/squid.conf", "squid.conf")}    depends_on:\n${DEPENDS_ON_CONFIG}`,
      "egress's squid.conf mount",
    ),
  );

  const configs = configsSection(s);
  const hash = createHash("sha256").update(configs).digest("hex");
  body = replaceOnce(body, "\nnetworks:\n", `${extraServices(hash)}\nnetworks:\n`, "the networks section");
  body = replaceOnce(body, "\nvolumes:\n", `${EXTRA_NETWORK}\nvolumes:\n`, "the volumes section");
  if (!body.endsWith("\n")) throw new Error("docker-compose.server.yml must end with a newline");
  // Checked before the configs go in, which are the sources byte for byte.
  for (const left of ["build:", "./docker/", "-f docker-compose.server.yml"]) {
    if (body.includes(left)) throw new Error(`the self-host compose file still holds ${JSON.stringify(left)}`);
  }
  return HEADER + body + EXTRA_VOLUMES + configs;
}

const ENV_HEADER = `# The settings and secrets of selfhost/compose.yml. Save this file as .env
# next to compose.yml, make it readable to you alone, and fill it in
# (README.md, "Self-hosting with the published image"):
#
#   chmod 600 .env
#
# GENERATED by scripts/selfhost-compose.ts from docker/server.env.example.
# Nothing in it is a real value. docker compose reads .env for the \${...}
# substitutions in compose.yml. Each container receives only the variables
# compose.yml names, never the whole of .env.
#
# The three marked REQUIRED are enforced by compose itself: it refuses to
# start while any of them is missing or empty.
`;

function envExtra(minor: string): string {
  return `
# Optional. The release to run. Unset, the minor release this compose.yml
# came with, ${minor}, which \`docker compose pull\` moves to its newest patch.
# Pin an exact release, such as ${minor}.0, to update only when you change this
# line. A new minor release can come with a new compose.yml: download the
# one at its tag before you move to it.
# RACCOON_VERSION=${minor}
# Optional. The image without its tag, for a mirror or a fork.
# RACCOON_IMAGE=${IMAGE}

# Optional. Starts Caddy, the HTTPS front end, with every docker compose
# command, so \`up\`, \`pull\` and \`down\` all include it. It needs ports 80
# and 443 open and a DNS record for the host pointing at this server. Leave
# it unset when your own proxy or tunnel serves the site.
# COMPOSE_PROFILES=https
# Optional. What Caddy serves and gets a certificate for. Unset, it is
# PUBLIC_ORIGIN.
# SITE_ADDRESS=https://vtt.example.com

# Optional. Where each visitor's address comes from, which every
# per-address limit keys on (joins, wrong passwords, room creation,
# uploads, open sockets). Unset or 0, the address that connected, so behind
# a front end every visitor counts as the front end's one address: safe, but
# strict. 1 takes it from the CF-Connecting-IP header instead. Set 1 only
# when every request reaches the app through something that overwrites that
# header with the visitor's address: Cloudflare, or the https profile's
# Caddy. Anywhere else, anyone could send the header and pick an address
# (README.md, "Put HTTPS in front of it"). Behind Cloudflare, use a tunnel or
# your own proxy on raccoon-edge, not the https profile: Caddy would replace
# the header with a Cloudflare address.
# TRUST_CF_CONNECTING_IP=1
`;
}

export function renderEnv(s: Sources): string {
  const end = s.serverEnv.indexOf("\n\n");
  if (end < 0) throw new Error("docker/server.env.example: expected a header paragraph");
  let body = s.serverEnv.slice(end + 1);
  body = body.replaceAll("docker compose -f docker-compose.server.yml ", "docker compose ");
  if (body.includes("docker-compose.server.yml")) {
    throw new Error("docker/server.env.example: a mention of docker-compose.server.yml this does not rewrite");
  }
  return ENV_HEADER + body + envExtra(minorOf(s.version));
}

export function render(s: Sources): Output {
  return { compose: renderCompose(s), env: renderEnv(s) };
}

if (import.meta.main) {
  const out = render(readSources());
  const files: [string, string][] = [
    [COMPOSE_PATH, out.compose],
    [ENV_PATH, out.env],
  ];
  if (process.argv.includes("--check")) {
    const stale = files.filter(([file, text]) => {
      try {
        return readFileSync(path.join(ROOT, file), "utf8") !== text;
      } catch {
        return true;
      }
    });
    for (const [file] of stale) console.error(`${file} differs from its sources. Run \`pnpm selfhost\` and commit the result.`);
    process.exitCode = stale.length > 0 ? 1 : 0;
  } else {
    mkdirSync(path.join(ROOT, "selfhost"), { recursive: true });
    for (const [file, text] of files) writeFileSync(path.join(ROOT, file), text);
    console.log(`Wrote ${files.map(([f]) => f).join(" and ")}.`);
  }
}
