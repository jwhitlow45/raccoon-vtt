import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { blockScalar, COMPOSE_PATH, ENV_PATH, IMAGE, minorOf, readSources, render, renderCompose, type Sources } from "./selfhost-compose.ts";

/** The self-host compose file against its generator and the server stack (scripts/selfhost-compose.ts). */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

describe("the self-host compose file", () => {
  test("is what the generator makes from the server stack today", () => {
    const out = render(readSources());
    const hint = "differs from its sources: run `pnpm selfhost` and commit the result";
    assert.ok(read(COMPOSE_PATH) === out.compose, `${COMPOSE_PATH} ${hint}`);
    assert.ok(read(ENV_PATH) === out.env, `${ENV_PATH} ${hint}`);
  });

  test("pins the minor release of package.json's version", () => {
    const s = readSources();
    assert.equal(minorOf("12.34.5"), "12.34");
    assert.throws(() => minorOf("1.2"), /X\.Y\.Z/);
    assert.throws(() => minorOf("1.2.3-rc.1"), /X\.Y\.Z/);
    const compose = renderCompose({ ...s, version: "7.8.9" });
    assert.ok(compose.includes(`image: \${RACCOON_IMAGE:-${IMAGE}}:\${RACCOON_VERSION:-7.8}\n`));
    assert.ok(render({ ...s, version: "7.8.9" }).env.includes("# RACCOON_VERSION=7.8\n"));
  });

  test("stops on a server stack whose shape it does not know", () => {
    const s = readSources();
    const without = (from: string, to = ""): Sources => {
      assert.ok(s.serverCompose.includes(from), `the fixture expects ${JSON.stringify(from)} in docker-compose.server.yml`);
      return { ...s, serverCompose: s.serverCompose.replace(from, to) };
    };
    assert.throws(() => renderCompose(without("    build: .\n")), /raccoon's build/);
    assert.throws(() => renderCompose(without("      - TRUST_CF_CONNECTING_IP=1\n")), /TRUST_CF_CONNECTING_IP/);
    assert.throws(() => renderCompose(without("./docker/backup.sh:/backup/backup.sh:ro", "./docker/backup.sh:/backup/b.sh:ro")), /backup's script mount/);
    assert.throws(() => renderCompose(without("      - ./docker/squid.conf:/etc/squid/squid.conf:ro\n")), /squid\.conf mount/);
    assert.throws(() => renderCompose(without("\nname: raccoon\n", "\nname: other\n")), /name: raccoon/);
    // A new bind mount of a file under docker/ would need a config of its own.
    assert.throws(() => renderCompose(without("      - raccoon-db:/var/lib/postgresql/data\n", "      - raccoon-db:/var/lib/postgresql/data\n      - ./docker/x.conf:/x.conf:ro\n")), /\.\/docker\//);
  });

  test("changes the copier's label whenever a config changes, so compose recreates it", () => {
    const s = readSources();
    const label = (x: Sources) => /raccoon\.config-sha256: "([0-9a-f]{64})"/.exec(renderCompose(x))?.[1];
    const base = label(s);
    assert.ok(base);
    assert.notEqual(label({ ...s, squidConf: `${s.squidConf}# one more line\n` }), base);
    assert.notEqual(label({ ...s, backupSh: s.backupSh.replace("DAILY=7", "DAILY=8") }), base);
    assert.equal(label({ ...s, version: "9.9.9" }), base);
  });

  test("refuses config text that YAML would not carry byte for byte", () => {
    assert.throws(() => blockScalar("a\r\nb\n", 6), /LF line ends/);
    assert.throws(() => blockScalar("a\u0000b\n", 6), /printable/);
    assert.throws(() => blockScalar("", 6), /empty/);
  });
});

// The tests below read the files as Compose does, so they need its plugin. CI's runners have it.
const haveCompose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

/** `docker compose config --format json` of a file, with the three required variables set. */
function composeConfig(file: string, args: string[] = []): ComposeModel {
  const dir = mkdtempSync(path.join(tmpdir(), "selfhost-compose-"));
  try {
    // An empty env file, so a .env a developer keeps next to either file cannot change the result.
    const envFile = path.join(dir, "empty.env");
    writeFileSync(envFile, "");
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG, POSTGRES_PASSWORD: "pw", PUBLIC_ORIGIN: "https://vtt.example.com", ROOM_SECRET_KEY: "key" };
    const r = spawnSync("docker", ["compose", "-f", file, "--env-file", envFile, ...args, "config", "--format", "json"], { encoding: "utf8", env, cwd: ROOT });
    assert.equal(r.status, 0, `docker compose config ${file} failed: ${r.stderr}`);
    return JSON.parse(r.stdout) as ComposeModel;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Service = Record<string, unknown> & {
  image?: string;
  volumes?: { type: string; source?: string; target: string; read_only?: boolean; volume?: { subpath?: string } }[];
  depends_on?: Record<string, { condition: string; restart?: boolean }>;
  ports?: { target: number; published: string; protocol: string }[];
};
type ComposeModel = {
  services: Record<string, Service>;
  networks: Record<string, unknown>;
  volumes: Record<string, unknown>;
  configs?: Record<string, { content: string }>;
};

/** A config's content as the container receives it: compose's JSON keeps the $$ escapes. */
const unescape = (content: string) => content.replaceAll("$$", "$");

describe("the self-host compose file as compose reads it", { skip: haveCompose ? false : "needs docker compose" }, () => {
  test("carries any text as a config byte for byte", () => {
    const samples = ["a $b ${c} $$d $\n", "no final newline", "two final newlines\n\n", "\tleading tab\n  two spaces\n", "  first line indented\nnext\n", "trailing spaces  \n\n\nafter blank lines\n", "$"];
    const dir = mkdtempSync(path.join(tmpdir(), "selfhost-scalar-"));
    try {
      const file = path.join(dir, "compose.yml");
      const configs = samples.map((s, i) => `  c${i}:\n    content: ${blockScalar(s, 6)}`).join("");
      // Compose leaves out a config no service uses.
      const uses = samples.map((_, i) => `      - c${i}\n`).join("");
      writeFileSync(file, `services:\n  x:\n    image: scratch\n    configs:\n${uses}configs:\n${configs}`);
      const model = composeConfig(file);
      samples.forEach((s, i) => assert.equal(unescape(model.configs?.[`c${i}`]?.content ?? ""), s, `sample ${i}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const server = haveCompose ? composeConfig("docker-compose.server.yml", ["--profile", "restore"]) : null;
  const selfhost = haveCompose ? composeConfig(COMPOSE_PATH, ["--profile", "restore", "--profile", "https"]) : null;

  test("mounts squid.conf and backup.sh as the sources, byte for byte", () => {
    assert.equal(unescape(selfhost!.configs!["squid-conf"]!.content), read("docker/squid.conf"));
    assert.equal(unescape(selfhost!.configs!["backup-sh"]!.content), read("docker/backup.sh"));
    const mount = (service: string, target: string) => selfhost!.services[service]!.volumes!.find((v) => v.target === target);
    for (const [service, target, subpath] of [
      ["egress", "/etc/squid/squid.conf", "squid.conf"],
      ["backup", "/backup/backup.sh", "backup.sh"],
      ["restore", "/backup/backup.sh", "backup.sh"],
      ["caddy", "/etc/caddy/Caddyfile", "Caddyfile"],
    ] as const) {
      assert.deepEqual(mount(service, target), { type: "volume", source: "raccoon-config", target, read_only: true, volume: { subpath } }, `${service}'s ${target}`);
    }
  });

  test("keeps every setting of the server stack's services but the image and the config mounts", () => {
    const minor = minorOf(readSources().version);
    for (const [name, s] of Object.entries(server!.services)) {
      const h = selfhost!.services[name];
      assert.ok(h, `the self-host file has no ${name}`);
      for (const key of new Set([...Object.keys(s), ...Object.keys(h)])) {
        if (key === "build" || key === "image") continue;
        if (key === "volumes") {
          const kept = (v: NonNullable<Service["volumes"]>[number]) => !(v.type === "bind" && v.source?.includes("/docker/"));
          assert.deepEqual(h.volumes!.filter((v) => v.source !== "raccoon-config"), s.volumes!.filter(kept), `${name}'s volumes`);
          assert.deepEqual(h.volumes!.filter((v) => v.source === "raccoon-config").map((v) => v.target), s.volumes!.filter((v) => !kept(v)).map((v) => v.target), `${name}'s config mounts`);
          continue;
        }
        if (key === "depends_on") {
          const deps: NonNullable<Service["depends_on"]> = h.depends_on!;
          const rest = Object.fromEntries(Object.entries(deps).filter(([dep]) => dep !== "config-files"));
          assert.deepEqual(rest, s.depends_on ?? {}, `${name}'s depends_on`);
          const copier = deps["config-files"];
          if (copier) assert.deepEqual({ condition: copier.condition, restart: copier.restart }, { condition: "service_completed_successfully", restart: true });
          continue;
        }
        assert.deepEqual(h[key], s[key], `${name}'s ${key}`);
      }
      if (s.image) assert.equal(h.image, s.image, `${name}'s image`);
      // Each reader of a config waits for the copier, and restarts after it changes.
      if (h.volumes?.some((v) => v.source === "raccoon-config")) assert.ok(h.depends_on?.["config-files"], `${name} waits for config-files`);
    }
    assert.equal(selfhost!.services.raccoon!.image, `${IMAGE}:${minor}`);
    for (const [name, n] of Object.entries(server!.networks)) assert.deepEqual(selfhost!.networks[name], n, `the ${name} network`);
    for (const name of Object.keys(server!.volumes)) assert.ok(name in selfhost!.volumes, `the ${name} volume`);
  });

  test("publishes ports only from Caddy, which is locked down as the others are", () => {
    for (const [name, s] of Object.entries(selfhost!.services)) if (name !== "caddy") assert.equal(s.ports, undefined, `${name} publishes a port`);
    const caddy = selfhost!.services.caddy!;
    assert.deepEqual(caddy.profiles, ["https"]);
    assert.deepEqual(
      caddy.ports!.map((p) => `${p.published}:${p.target}/${p.protocol}`),
      ["80:80/tcp", "443:443/tcp", "443:443/udp"],
    );
    assert.equal(caddy.read_only, true);
    assert.deepEqual(caddy.cap_drop, ["ALL"]);
    assert.deepEqual(caddy.cap_add, ["NET_BIND_SERVICE"]);
    assert.deepEqual(caddy.security_opt, ["no-new-privileges:true"]);
    assert.deepEqual(Object.keys(caddy.networks as object).sort(), ["raccoon-edge", "raccoon-https"]);
    assert.equal((caddy.environment as Record<string, string>).SITE_ADDRESS, "https://vtt.example.com");

    const copier = selfhost!.services["config-files"]!;
    assert.equal(copier.network_mode, "none");
    assert.deepEqual(copier.cap_drop, ["ALL"]);
    assert.deepEqual(copier.security_opt, ["no-new-privileges:true"]);
  });

  test("leaves Caddy out without the https profile", () => {
    const plain = composeConfig(COMPOSE_PATH);
    assert.equal(plain.services.caddy, undefined);
    assert.equal(plain.services.restore, undefined);
  });
});
