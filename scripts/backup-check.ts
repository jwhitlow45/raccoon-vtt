import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { variantFileName, variantPath } from "../server/assets/store.ts";
import type { AssetKind, Variant } from "../server/assets/kinds.ts";

/**
 * The backup check (docs/design-v1-dm-tools.md 3.17): docker/backup.sh in
 * the pinned postgres image, through the backup and restore services of
 * the development compose file, against a postgres of its own.
 *
 *   node scripts/backup-check.ts
 *
 * It needs Docker, so it is a check before a release, like the server-box
 * benchmark. It runs the compose file under a project of its own
 * (BACKUP_CHECK_PROJECT, raccoon-backup-check by default) with postgres on
 * BACKUP_CHECK_DB_PORT (5235), so it never touches the development
 * database or its volumes, and removes its containers and volumes when it
 * ends. Each part starts from empty volumes.
 *
 * Image files here are random bytes under real asset names: the backup
 * copies by name and length and never looks inside. Where the real app's
 * behavior matters (an upload into a restored folder, cleanup moving a
 * restored file to the trash), the check acts as the app does, as UID 1000
 * through the restore service's mount. README's drill does it with the app.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROJECT = process.env.BACKUP_CHECK_PROJECT ?? "raccoon-backup-check";
const PORT = process.env.BACKUP_CHECK_DB_PORT ?? "5235";
const NO_LOG = "The database has no backup log yet. Start raccoon first, then run backup.sh once.";
const MiB = 1024 * 1024;

type Result = { code: number; stdout: string; stderr: string };

function exec(cmd: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...opts.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One compose project: the dev compose file, plus an override a part may need. */
class Stack {
  override: string | null = null;
  #dir!: string;

  async init(): Promise<void> {
    this.#dir = await mkdtemp(join(tmpdir(), "raccoon-backup-check-"));
  }

  async cleanup(): Promise<void> {
    await this.down();
    await rm(this.#dir, { recursive: true, force: true });
  }

  /** Extra compose YAML for the next parts, or null for the plain file. */
  async setOverride(yaml: string | null): Promise<void> {
    if (yaml === null) {
      this.override = null;
      return;
    }
    this.override = join(this.#dir, `override-${randomBytes(4).toString("hex")}.yml`);
    await writeFile(this.override, yaml);
  }

  compose(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<Result> {
    const files = ["-f", "docker-compose.yml", ...(this.override ? ["-f", this.override] : [])];
    return exec("docker", ["compose", "-p", PROJECT, ...files, "--profile", "backup", ...args], {
      input: opts.input,
      env: { RACCOON_DB_PORT: PORT, ...opts.env },
    });
  }

  async down(): Promise<void> {
    await this.compose(["down", "-v", "--remove-orphans", "--timeout", "1"]);
  }

  /** Empty volumes, postgres up, and the image volume made the app's, as the app's image makes it. */
  async fresh(opts: { appVolume?: boolean } = {}): Promise<void> {
    await this.down();
    const up = await this.compose(["up", "-d", "--wait", "postgres"]);
    assert.equal(up.code, 0, up.stderr);
    if (opts.appVolume ?? true) {
      const own = await this.compose(["run", "--rm", "--no-deps", "--user", "0:0", "--cap-add", "CHOWN", "--entrypoint", "chown", "restore", "1000:1000", "/data/assets"]);
      assert.equal(own.code, 0, own.stderr);
    }
  }

  backup(args: string[] = ["once"], env: Record<string, string> = {}): Promise<Result> {
    return this.compose(["run", "--rm", "-T", ...envArgs(env), "backup", "sh", "/backup/backup.sh", ...args]);
  }

  restore(name: string, env: Record<string, string> = {}): Promise<Result> {
    return this.compose(["run", "--rm", "-T", ...envArgs(env), "restore", "sh", "/backup/backup.sh", "restore", name]);
  }

  /** A shell in the backup service (root, the backups volume writable, the images read-only at /assets). */
  async asBackup(script: string): Promise<string> {
    const r = await this.compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "sh", "backup", "-s"], { input: script });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout;
  }

  /** A shell as the app's user, UID 1000, with the image volume writable at /data/assets. */
  async asApp(script: string): Promise<string> {
    const r = await this.compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "sh", "restore", "-s"], { input: script });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout;
  }

  /** A run left going in the background, to pause, kill or resume. */
  async detached(service: "backup" | "restore", args: string[], env: Record<string, string>): Promise<Detached> {
    const name = `${PROJECT}-run-${randomBytes(4).toString("hex")}`;
    const r = await this.compose(["run", "-d", "--name", name, ...envArgs(env), service, "sh", "/backup/backup.sh", ...args]);
    assert.equal(r.code, 0, r.stderr);
    return new Detached(name);
  }
}

class Detached {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }

  async pausedAt(point: string, timeoutMs = 30_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if ((await exec("docker", ["exec", this.name, "test", "-e", `/tmp/.test-paused-${point}`])).code === 0) return;
      await sleep(100);
    }
    throw new Error(`${this.name} never paused at ${point}: ${(await this.logs()).slice(-2000)}`);
  }

  async resume(): Promise<void> {
    assert.equal((await exec("docker", ["exec", this.name, "touch", "/tmp/.test-resume"])).code, 0);
  }

  async kill(): Promise<void> {
    await exec("docker", ["kill", this.name]);
    await this.remove();
  }

  /** Waits for the run to end, then removes its container. */
  async done(): Promise<{ code: number; logs: string }> {
    const waited = await exec("docker", ["wait", this.name]);
    const logs = await this.logs();
    await this.remove();
    return { code: Number(waited.stdout.trim()), logs };
  }

  async logs(): Promise<string> {
    const r = await exec("docker", ["logs", this.name]);
    return r.stdout + r.stderr;
  }

  async remove(): Promise<void> {
    await exec("docker", ["rm", "-f", this.name]);
  }
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

// The database ----------------------------------------------------------------

const DB_URL = (db = "raccoon") => `postgres://raccoon:raccoon@127.0.0.1:${PORT}/${db}`;

async function withDb<T>(fn: (c: pg.Client) => Promise<T>, db = "raccoon"): Promise<T> {
  const client = new pg.Client({ connectionString: DB_URL(db) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** What the app does at boot: db/schema.sql, which defines backup_runs among the rest. */
async function applySchema(db = "raccoon"): Promise<void> {
  const schema = await readFile(join(ROOT, "db/schema.sql"), "utf8");
  await withDb((c) => c.query(schema), db);
}

/** A database as a new volume holds it: nothing in it at all. */
async function emptyDatabase(db = "raccoon"): Promise<void> {
  await withDb(async (c) => {
    await c.query(`drop database if exists ${db} with (force)`);
    await c.query(`create database ${db}`);
  }, "postgres");
}

type Image = { id: string; roomId: string; hex: string; kind: AssetKind; variants: Variant[]; sizes: number[] };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const roomId = () => Array.from(randomBytes(8), (b) => CROCKFORD[b % 32]).join("");

/** A room with a snapshot and `n` token images of `size` bytes each, rows and files. */
async function addRoom(stack: Stack, n: number, size = 2048): Promise<{ roomId: string; images: Image[] }> {
  const id = roomId();
  const images: Image[] = Array.from({ length: n }, () => ({
    id: randomUUID(),
    roomId: id,
    hex: randomBytes(32).toString("hex"),
    kind: "token" as const,
    variants: ["full", "thumb"] as Variant[],
    sizes: [size, Math.max(1, Math.floor(size / 8))],
  }));
  await withDb(async (c) => {
    await c.query("insert into rooms (id, name, player_pw_hash, dm_key_hash) values ($1, $2, 'x', '\\x00')", [id, `Room ${id}`]);
    await c.query("insert into room_snapshots (room_id, seq, state, schema_version) values ($1, 0, $2, 8)", [id, JSON.stringify({ note: randomBytes(64).toString("hex") })]);
    for (const img of images) {
      await c.query(
        `insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants)
         values ($1, $2, $3, $4, 1, 64, 64, $5, $6)`,
        [img.id, id, Buffer.from(img.hex, "hex"), img.kind, img.sizes.reduce((a, b) => a + b, 0), img.variants],
      );
    }
  });
  await writeImages(stack, images);
  return { roomId: id, images };
}

/** The image files, written as the app writes them: by UID 1000, under the default umask. */
async function writeImages(stack: Stack, images: Image[]): Promise<void> {
  const lines = images.flatMap((img) =>
    img.variants.map((v, i) => {
      const rel = variantPath("", img.hex, img.kind, v, 1);
      return `mkdir -p /data/assets/${img.hex.slice(0, 2)} && head -c ${img.sizes[i]} /dev/urandom > /data/assets/${rel}`;
    }),
  );
  for (let i = 0; i < lines.length; i += 200) await stack.asApp(["set -e", ...lines.slice(i, i + 200)].join("\n"));
}

/** As the app deletes a room: rows gone, its files moved into today's trash folder. */
async function deleteRoom(stack: Stack, room: { roomId: string; images: Image[] }): Promise<void> {
  await withDb((c) => c.query("delete from rooms where id = $1", [room.roomId]));
  const day = new Date().toISOString().slice(0, 10);
  const moves = room.images.flatMap((img) =>
    img.variants.map((v) => {
      const rel = variantPath("", img.hex, img.kind, v, 1);
      return `mkdir -p /data/assets/trash/${day}/${img.hex.slice(0, 2)} && mv /data/assets/${rel} /data/assets/trash/${day}/${rel}`;
    }),
  );
  await stack.asApp(["set -e", ...moves].join("\n"));
}

const listLines = (images: Image[]) => images.flatMap((img) => img.variants.map((v) => variantPath("", img.hex, img.kind, v, 1))).sort();

type BackupsState = { names: string[]; good: string[]; parts: string[]; files: string[] };

/** What is on the backups volume. */
async function backups(stack: Stack): Promise<BackupsState> {
  const out = await stack.asBackup(
    `cd /backups && ls -1 | grep '^raccoon-' || true; echo '--'; find /backups -name '*.part' | sort; echo '--'; cd /backups/assets 2>/dev/null && find . -type f | sed 's|^./||' | sort`,
  );
  const [top = "", parts = "", files = ""] = out.split("--\n");
  const names = top.split("\n").filter(Boolean);
  return {
    names,
    good: names.filter((n) => n.endsWith(".good")).map((n) => n.slice(0, -5)),
    parts: parts.split("\n").filter(Boolean),
    files: files.split("\n").filter(Boolean),
  };
}

/** A whole listing of the volume, to show nothing changed. */
async function snapshotVolume(stack: Stack): Promise<string> {
  return stack.asBackup("cd /backups && find . | sort | while read -r f; do printf '%s %s\\n' \"$f\" \"$(stat -c '%s %Y' \"$f\")\"; done");
}

async function newestGood(stack: Stack): Promise<string> {
  const { good } = await backups(stack);
  const name = good.sort().at(-1);
  assert.ok(name, "a good backup exists");
  return name;
}

async function runs(): Promise<Array<{ id: string; outcome: string; error: string | null; dump: string | null }>> {
  return withDb(async (c) => (await c.query("select id, outcome, error, dump from backup_runs order by started_at")).rows);
}

async function rowCounts(db: string): Promise<Record<string, number>> {
  return withDb(async (c) => {
    const { rows } = await c.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and tablename <> 'backup_runs' order by tablename");
    const out: Record<string, number> = {};
    for (const { tablename } of rows) out[tablename] = Number((await c.query(`select count(*) from ${tablename}`)).rows[0].count);
    return out;
  }, db);
}

async function goodOnce(stack: Stack, env: Record<string, string> = {}): Promise<string> {
  const r = await stack.backup(["once"], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /: good, /);
  return newestGood(stack);
}

// The parts ---------------------------------------------------------------------

describe("backup.sh", { concurrency: false }, () => {
  const stack = new Stack();
  before(async () => {
    const docker = await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
    assert.equal(docker.code, 0, "the backup check needs Docker");
    await stack.init();
  });
  after(() => stack.cleanup());

  test("the compose services: the postgres image, root with no capabilities, UID 1000 for restore, no secret key", async () => {
    const r = await exec("docker", ["compose", "-f", "docker-compose.server.yml", "--profile", "restore", "config", "--format", "json"], {
      env: { POSTGRES_PASSWORD: "check", PUBLIC_ORIGIN: "https://vtt.example.com", ROOM_SECRET_KEY: "x" },
    });
    assert.equal(r.code, 0, r.stderr);
    type Service = Record<string, any>;
    const config = JSON.parse(r.stdout) as { services: { postgres: Service; backup: Service; restore: Service; raccoon: Service } };
    const { postgres, backup, restore, raccoon } = config.services;
    for (const [name, s] of [["backup", backup], ["restore", restore]] as const) {
      assert.equal(s.image, postgres.image, `${name} runs the postgres image`);
      assert.deepEqual(s.cap_drop, ["ALL"]);
      assert.equal(s.cap_add, undefined);
      assert.deepEqual(s.security_opt, ["no-new-privileges:true"]);
      assert.equal(s.read_only, true);
      assert.deepEqual(Object.keys(s.networks), ["raccoon-data"]);
      assert.equal(s.environment.ROOM_SECRET_KEY, undefined, `${name} never sees ROOM_SECRET_KEY`);
      for (const k of ["PGHOST", "PGUSER", "PGDATABASE", "PGPASSWORD", "TZ"]) assert.equal(s.environment[k], backup.environment[k], k);
      const script = s.volumes.find((v: { target: string }) => v.target === "/backup/backup.sh");
      assert.equal(script.read_only, true);
    }
    assert.equal(backup.user, "0:0");
    assert.equal(restore.user, "1000:1000");
    assert.deepEqual(restore.profiles, ["restore"]);
    const mounts = (s: Record<string, any>) => Object.fromEntries(s.volumes.filter((v: { type: string }) => v.type === "volume").map((v: { source: string; target: string; read_only?: boolean }) => [v.target, `${v.source}${v.read_only ? ":ro" : ""}`]));
    assert.deepEqual(mounts(backup), { "/backups": "raccoon-backups", "/assets": "raccoon-assets:ro" });
    assert.deepEqual(mounts(restore), { "/backups": "raccoon-backups:ro", "/data/assets": "raccoon-assets" });
    assert.ok("ADMIN_PASSWORD_HASH" in raccoon.environment);
    assert.equal(backup.environment.ADMIN_PASSWORD_HASH, undefined);
  });

  test("a run on a fresh database before the app starts stops, writes nothing and releases the lock", async () => {
    await stack.fresh();
    await stack.backup(["once"]).then((r) => assert.equal(r.code, 1, r.stdout));
    const before = await snapshotVolume(stack);
    const r = await stack.backup(["once"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(NO_LOG.replace(/\./g, "\\.")));
    assert.equal(await snapshotVolume(stack), before);
    // And again: the lock was released.
    assert.match((await stack.backup(["once"])).stderr, /no backup log yet/);
  });

  test("a good run: lists match the app's file names, the copy is whole, and a restore into a scratch database has every row", async () => {
    await stack.fresh();
    await applySchema();
    const a = await addRoom(stack, 3);
    const b = await addRoom(stack, 2);
    const name = await goodOnce(stack);
    const list = (await stack.asBackup(`cat /backups/${name}.files`)).split("\n").filter(Boolean);
    // Every line is what variantPath builds from the dump's own rows.
    assert.deepEqual(list, listLines([...a.images, ...b.images]));
    for (const line of list) {
      const [prefix, file] = line.split("/");
      const [hex, kind, variant] = file!.split("-");
      assert.equal(file, variantFileName(hex!, kind as AssetKind, variant as Variant, 1));
      assert.equal(prefix, hex!.slice(0, 2));
    }
    const state = await backups(stack);
    assert.deepEqual(state.files, list);
    assert.deepEqual(state.parts, []);
    const record = await stack.asBackup(`cat /backups/${name}.good`);
    assert.match(record, new RegExp(`^count=${list.length}$`, "m"));

    // The dump leaves the backup log out, data and definition both.
    const toc = await stack.asBackup(`pg_restore --list /backups/${name}.dump`);
    assert.doesNotMatch(toc, /backup_runs/);
    assert.match(toc, /TABLE DATA public assets/);

    await withDb((c) => c.query("create database scratch"), "postgres");
    const restored = await stack.restore(name, { PGDATABASE: "scratch" });
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
    assert.deepEqual(await rowCounts("scratch"), await rowCounts("raccoon"));
    assert.equal(await withDb(async (c) => (await c.query("select to_regclass('public.backup_runs') as t")).rows[0].t, "scratch"), null);
    const rows = await runs();
    assert.equal(rows.at(-1)?.outcome, "good");
    assert.equal(rows.at(-1)?.dump, `${name}.dump`);
  });

  test("a room deleted between the dump and the copy is copied from the trash", async () => {
    await stack.fresh();
    await applySchema();
    const kept = await addRoom(stack, 1);
    const doomed = await addRoom(stack, 2);
    const run = await stack.detached("backup", ["once"], { BACKUP_TEST_PAUSE: "listed" });
    await run.pausedAt("listed");
    await deleteRoom(stack, doomed);
    await run.resume();
    const done = await run.done();
    assert.equal(done.code, 0, done.logs);
    const state = await backups(stack);
    assert.deepEqual(state.files, listLines([...kept.images, ...doomed.images]));
  });

  test("backup A, a room's deletion, backup B, then a restore of A finds every image A lists", async () => {
    await stack.fresh();
    await applySchema();
    await addRoom(stack, 1);
    const doomed = await addRoom(stack, 2);
    const a = await goodOnce(stack);
    await deleteRoom(stack, doomed);
    const b = await goodOnce(stack);
    assert.notEqual(a, b);
    // The app is stopped for a restore, and the trash has been purged meanwhile.
    await stack.asApp("rm -rf /data/assets/trash");
    const r = await stack.restore(a);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(await withDb(async (c) => (await c.query("select count(*)::int as n from rooms where id = $1", [doomed.roomId])).rows[0].n), 1);
    const present = await stack.asApp(`cd /data/assets && find . -type f | sed 's|^./||' | sort`);
    for (const line of listLines(doomed.images)) assert.ok(present.includes(line), line);
  });

  test("a volume too small for the images ends as a partial run that keeps the older backup", async () => {
    await stack.setOverride(`volumes:\n  raccoon-dev-backups:\n    driver_opts:\n      type: tmpfs\n      device: tmpfs\n      o: "size=24m"\n`);
    // A tmpfs volume lives only while some container has it mounted, so one holds it for the whole part.
    let holder: Detached | null = null;
    try {
      await stack.fresh();
      const name = `${PROJECT}-holder`;
      const held = await stack.compose(["run", "-d", "--no-deps", "--name", name, "--entrypoint", "sleep", "backup", "3600"]);
      assert.equal(held.code, 0, held.stderr);
      holder = new Detached(name);
      await applySchema();
      await addRoom(stack, 2);
      const env = { BACKUP_TEST_FLOOR_BYTES: String(4 * MiB) };
      const first = await goodOnce(stack, env);
      await addRoom(stack, 10, 2 * MiB);
      const r = await stack.backup(["once"], env);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /partial: not enough space for the images/);
      const state = await backups(stack);
      assert.deepEqual(state.good, [first]);
      assert.ok(state.names.includes(`${first}.dump`));
      assert.equal((await runs()).at(-1)?.outcome, "partial");
      // The older backup still restores.
      await withDb((c) => c.query("create database scratch2"), "postgres");
      assert.equal((await stack.restore(first, { PGDATABASE: "scratch2" })).code, 0);
    } finally {
      await holder?.kill();
      await stack.setOverride(null);
    }
  });

  test("a copy stopped midway leaves a .part, which the next run removes and copies again, counting only then as good", async () => {
    await stack.fresh();
    await applySchema();
    const room = await addRoom(stack, 3);
    const run = await stack.detached("backup", ["once"], { BACKUP_TEST_PAUSE: "copying" });
    await run.pausedAt("copying");
    await run.kill();
    let state = await backups(stack);
    assert.equal(state.parts.length, 1, state.parts.join(","));
    assert.deepEqual(state.good, []);
    assert.equal((await runs()).at(-1)?.outcome, "running");
    const name = await goodOnce(stack);
    state = await backups(stack);
    assert.deepEqual(state.parts, []);
    assert.deepEqual(state.good, [name]);
    assert.deepEqual(state.files, listLines(room.images));
    const rows = await runs();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.outcome, "failed", "the killed run's row is marked failed at the next start");
    assert.equal(rows[0]?.error, "stopped before it finished");
    assert.equal(rows[1]?.outcome, "good");
  });

  test("a run stopped between the list and the dump's rename leaves nothing that counts", async () => {
    await stack.fresh();
    await applySchema();
    await addRoom(stack, 1);
    const run = await stack.detached("backup", ["once"], { BACKUP_TEST_PAUSE: "listed" });
    await run.pausedAt("listed");
    await run.kill();
    let state = await backups(stack);
    assert.deepEqual(state.good, []);
    assert.ok(state.names.some((n) => n.endsWith(".files")));
    assert.ok(state.parts.some((p) => p.endsWith(".dump.part")));
    const name = await goodOnce(stack);
    state = await backups(stack);
    assert.deepEqual(state.names.sort(), [`${name}.dump`, `${name}.files`, `${name}.good`]);
  });

  test("a pg_dump killed, a producer failing below the budget, and a dump past its budget each fail, leaving no .part", async () => {
    await stack.fresh();
    await applySchema();
    await addRoom(stack, 1);
    // Enough incompressible data that the real dump is far past a 64 KiB budget.
    await withDb((c) =>
      c.query(
        "insert into room_log (room_id, id, at, entry) select (select id from rooms limit 1), g::text, now(), jsonb_build_object('t', md5(random()::text) || md5(random()::text) || md5(random()::text)) from generate_series(1, 4000) g",
      ),
    );
    for (const [env, error] of [
      [{ BACKUP_TEST_DUMP: "kill" }, /pg_dump failed with status 137/],
      [{ BACKUP_TEST_DUMP: "fail" }, /pg_dump failed with status 3/],
      [{ BACKUP_TEST_DUMP_LIMIT_BYTES: String(64 * 1024) }, /pg_dump failed with status (153|1)\b/],
    ] as const) {
      const r = await stack.backup(["once"], env);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stdout, error);
      const state = await backups(stack);
      assert.deepEqual(state.parts, []);
      assert.deepEqual(state.good, []);
      const last = (await runs()).at(-1);
      assert.equal(last?.outcome, "failed");
      assert.match(last?.error ?? "", error);
    }
    // And a real one still goes through.
    await goodOnce(stack);
  });

  test("the first backup survives its own retention, and a run with new images keeps them", async () => {
    await stack.fresh();
    await applySchema();
    const first = await addRoom(stack, 1);
    const a = await goodOnce(stack);
    assert.deepEqual((await backups(stack)).good, [a]);
    const second = await addRoom(stack, 2);
    const b = await goodOnce(stack);
    const state = await backups(stack);
    assert.deepEqual(state.good, [a, b]);
    assert.deepEqual(state.files, listLines([...first.images, ...second.images]));
  });

  test("retention keeps this run, the 6 other newest and the newest of each of the last 4 weeks, by the records alone", async () => {
    await stack.fresh();
    await applySchema();
    await addRoom(stack, 1);
    const now = Math.floor(Date.now() / 1000);
    const day = 86400;
    const fake = (daysAgo: number) => {
      const started = now - daysAgo * day - 60;
      const stamp = new Date(started * 1000).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      const name = `raccoon-${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}-${stamp.slice(9, 15)}-old${String(daysAgo).padStart(5, "0")}`;
      return { name, daysAgo, started };
    };
    const olds = Array.from({ length: 40 }, (_, i) => fake(i + 1));
    // Their image is one that only they name, so it goes with them.
    await stack.asBackup(
      olds
        .map((o) =>
          [
            `printf 'run=%s\\nstarted=%s\\ndump=%s.dump\\nbytes=100\\nfiles=%s.files\\ncount=1\\ncopied=0\\nfinished=%s\\n' old${String(o.daysAgo).padStart(5, "0")} ${o.started} ${o.name} ${o.name} ${o.started + 30} > /backups/${o.name}.good`,
            `: > /backups/${o.name}.dump`,
            `echo ff/${"f".repeat(64)}-token-full-v${o.daysAgo}.webp > /backups/${o.name}.files`,
            `mkdir -p /backups/assets/ff && echo x > /backups/assets/ff/${"f".repeat(64)}-token-full-v${o.daysAgo}.webp`,
          ].join("\n"),
        )
        .join("\n"),
    );
    // A row the log calls good whose record is gone.
    await withDb((c) => c.query("insert into backup_runs (id, started_at, finished_at, outcome, dump) values ('ghost123', now() - interval '3 days', now() - interval '3 days', 'good', 'raccoon-ghost.dump')"));
    const current = await goodOnce(stack);
    const kept = new Set((await backups(stack)).good);
    const expected = new Set([current, ...[1, 2, 3, 4, 5, 6, 7, 14, 21].map((d) => olds[d - 1]!.name)]);
    assert.deepEqual([...kept].sort(), [...expected].sort());
    const files = (await backups(stack)).files.filter((f) => f.startsWith("ff/"));
    assert.deepEqual(files.sort(), [1, 14, 2, 21, 3, 4, 5, 6, 7].map((d) => `ff/${"f".repeat(64)}-token-full-v${d}.webp`).sort());
    // The log knows the kept ones as good, and a good row without a record as gone.
    const rows = new Map((await runs()).map((r) => [r.id, r.outcome]));
    assert.equal(rows.get("old00007"), "good");
    assert.equal(rows.get("old00008"), undefined);
    assert.equal(rows.get("ghost123"), "gone");
  });

  test("backup A, backup B, a restore of A, then backup C: B is still restorable and the log lists all three", async () => {
    await stack.fresh();
    await applySchema();
    await addRoom(stack, 1);
    const a = await goodOnce(stack);
    const roomB = await addRoom(stack, 1);
    const b = await goodOnce(stack);
    assert.equal((await stack.restore(a)).code, 0);
    const c = await goodOnce(stack);
    const state = await backups(stack);
    assert.deepEqual(state.good, [a, b, c]);
    const log = new Map((await runs()).map((r) => [r.dump, r.outcome]));
    for (const n of [a, b, c]) assert.equal(log.get(`${n}.dump`), "good", n);
    assert.equal((await stack.restore(b)).code, 0);
    assert.equal(await withDb(async (cl) => (await cl.query("select count(*)::int as n from rooms where id = $1", [roomB.roomId])).rows[0].n), 1);
  });

  test("a manual run while the scheduled one copies says a backup is running and touches nothing", async () => {
    await stack.fresh();
    await applySchema();
    await addRoom(stack, 2);
    // The nightly loop, due a minute or two from now in UTC.
    const at = new Date(Date.now() + 70_000);
    const backupAt = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
    await stack.setOverride(`services:\n  backup:\n    environment:\n      BACKUP_TEST_PAUSE: copying\n`);
    try {
      const up = await stack.compose(["up", "-d", "backup"], { env: { BACKUP_AT: backupAt, TZ: "UTC" } });
      assert.equal(up.code, 0, up.stderr);
      const id = (await stack.compose(["ps", "-q", "backup"])).stdout.trim();
      await new Detached(id).pausedAt("copying", 180_000);
      const before = await snapshotVolume(stack);
      const rowsBefore = await runs();
      const r = await stack.compose(["exec", "-T", "backup", "sh", "/backup/backup.sh", "once"]);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /^A backup is running\.$/m);
      assert.equal(await snapshotVolume(stack), before);
      assert.deepEqual(await runs(), rowsBefore);
      await exec("docker", ["exec", id, "touch", "/tmp/.test-resume"]);
      const until = Date.now() + 60_000;
      while ((await backups(stack)).good.length === 0 && Date.now() < until) await sleep(500);
      assert.equal((await backups(stack)).good.length, 1, "the scheduled run finished good");
      // And the loop then sleeps until tomorrow's time instead of running again.
      await sleep(5000);
      assert.equal((await backups(stack)).good.length, 1, "one run a day");
      const logs = (await stack.compose(["logs", "backup"])).stdout;
      assert.match(logs, new RegExp(`Backups run every day at ${backupAt}`));
      assert.equal(logs.match(/backup raccoon-/g)?.length, 1, logs);
    } finally {
      await stack.compose(["stop", "-t", "1", "backup"]);
      await stack.setOverride(null);
    }
  });

  test("a restore holds the lock, so a backup whose retention would prune the chosen dump waits, and every image is found", async () => {
    await stack.fresh();
    await applySchema();
    const oldest = await addRoom(stack, 2);
    const names = [await goodOnce(stack)];
    await deleteRoom(stack, oldest);
    await stack.asApp("rm -rf /data/assets/trash");
    for (let i = 0; i < 6; i++) {
      await addRoom(stack, 1);
      names.push(await goodOnce(stack));
    }
    const chosen = names[0]!;
    const restore = await stack.detached("restore", ["restore", chosen], { BACKUP_TEST_PAUSE: "restoring" });
    await restore.pausedAt("restoring");
    const before = await snapshotVolume(stack);
    const blocked = await stack.backup(["once"]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stdout, /A backup is running/);
    assert.equal(await snapshotVolume(stack), before);
    await restore.resume();
    const done = await restore.done();
    assert.equal(done.code, 0, done.logs);
    const present = await stack.asApp(`cd /data/assets && find . -type f | sed 's|^./||'`);
    for (const line of listLines(oldest.images)) assert.ok(present.includes(line), line);
    // Afterwards the backup prunes it, as its retention says.
    await goodOnce(stack);
    assert.ok(!(await backups(stack)).good.includes(chosen));
  });

  test("a restore onto an existing image volume and onto a fresh one leaves every folder the app's, writable by it", async () => {
    for (const fresh of [false, true]) {
      await stack.fresh();
      await applySchema();
      const room = await addRoom(stack, 3);
      const name = await goodOnce(stack);
      if (fresh) {
        // A new server with the backups volume brought along: a new image
        // volume, made the app's by its first start, and an empty database
        // the app has set up.
        await stack.compose(["rm", "-f", "-s"]);
        assert.equal((await exec("docker", ["volume", "rm", `${PROJECT}_raccoon-dev-assets`])).code, 0);
        assert.equal((await stack.compose(["up", "-d", "--wait", "postgres"])).code, 0);
        const own = await stack.compose(["run", "--rm", "--no-deps", "--user", "0:0", "--cap-add", "CHOWN", "--entrypoint", "chown", "restore", "1000:1000", "/data/assets"]);
        assert.equal(own.code, 0, own.stderr);
        await emptyDatabase();
        await applySchema();
      } else {
        await stack.asApp("rm -rf /data/assets/" + room.images[0]!.hex.slice(0, 2));
      }
      const r = await stack.restore(name);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const day = new Date().toISOString().slice(0, 10);
      const img = room.images[0]!;
      const restoredPath = variantPath("", img.hex, img.kind, "full", 1);
      const out = await stack.asApp(
        [
          "set -e",
          // An upload into a restored folder.
          `head -c 100 /dev/urandom > /data/assets/${img.hex.slice(0, 2)}/${"0".repeat(64)}-token-full-v1.webp`,
          // Cleanup moving a restored file to the trash.
          `mkdir -p /data/assets/trash/${day}/${img.hex.slice(0, 2)}`,
          `mv /data/assets/${restoredPath} /data/assets/trash/${day}/${restoredPath}`,
          "find /data/assets ! -uid 1000 | wc -l",
        ].join("\n"),
      );
      assert.equal(out.trim(), "0", `every folder and file belongs to UID 1000 (${fresh ? "fresh" : "existing"} volume)`);
    }
  });

  test("the documented order on a fresh database: restore, start the app, then backup.sh once rebuilds the log", async () => {
    await stack.fresh();
    await applySchema();
    await addRoom(stack, 1);
    const a = await goodOnce(stack);
    await emptyDatabase();
    assert.equal((await stack.restore(a)).code, 0);
    // Before the app has started, a backup changes nothing.
    const before = await snapshotVolume(stack);
    const early = await stack.backup(["once"]);
    assert.equal(early.code, 1);
    assert.match(early.stderr, /no backup log yet/);
    assert.equal(await snapshotVolume(stack), before);
    // The app starts and applies db/schema.sql.
    await applySchema();
    const b = await goodOnce(stack);
    const log = new Map((await runs()).map((r) => [r.dump, r.outcome]));
    assert.equal(log.get(`${a}.dump`), "good");
    assert.equal(log.get(`${b}.dump`), "good");
  });

  test("a restore is refused, writing nothing, when the image volume is not the app's or the backup service never started", async () => {
    await stack.fresh();
    await applySchema();
    await addRoom(stack, 1);
    const name = await goodOnce(stack);
    const marker = randomBytes(4).toString("hex");
    await withDb((c) => c.query("insert into rooms (id, name, player_pw_hash, dm_key_hash) values ('ZZZZZZZZ', $1, 'x', '\\x00')", [marker]));
    // A brand new image volume first mounted by the restore service is root's.
    await stack.compose(["rm", "-f", "-s"]);
    assert.equal((await exec("docker", ["volume", "rm", `${PROJECT}_raccoon-dev-assets`])).code, 0);
    const r = await stack.restore(name);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /The image volume is not the app's yet\. Start the stack once with docker compose up -d, then stop raccoon and restore\./);
    assert.equal(await withDb(async (c) => (await c.query("select name from rooms where id = 'ZZZZZZZZ'")).rows[0]?.name), marker);
    assert.equal((await stack.compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "sh", "restore", "-c", "ls -A /data/assets | wc -l"])).stdout.trim(), "0");

    // A backups volume the backup service never started on has no lock.
    await stack.fresh();
    const noLock = await stack.restore(name);
    assert.equal(noLock.code, 2);
    assert.match(noLock.stderr, /The backup service has not started yet\. Start the stack once, then restore\./);
  });

  test("a restore whose dump names an image neither volume holds is refused before the database changes", async () => {
    await stack.fresh();
    await applySchema();
    const room = await addRoom(stack, 2);
    const name = await goodOnce(stack);
    const img = room.images[0]!;
    const lost = variantPath("", img.hex, img.kind, "full", 1);
    // Gone from the backups volume, and from the image volume too, as after a lost disk.
    await stack.asBackup(`rm /backups/assets/${lost}`);
    await stack.asApp(`rm /data/assets/${lost}`);
    const marker = randomBytes(4).toString("hex");
    await withDb((c) => c.query("insert into rooms (id, name, player_pw_hash, dm_key_hash) values ('ZZZZZZZZ', $1, 'x', '\\x00')", [marker]));
    const before = await stack.asApp("cd /data/assets && find . | sort");
    const r = await stack.restore(name);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`^1 of the 4 images ${name} lists are missing from the backups volume, so it cannot be restored whole\\. Nothing was restored\\.`, "m"));
    assert.doesNotMatch(r.stdout, /Restored /);
    assert.equal(await withDb(async (c) => (await c.query("select name from rooms where id = 'ZZZZZZZZ'")).rows[0]?.name), marker, "the database is untouched");
    assert.equal(await stack.asApp("cd /data/assets && find . | sort"), before, "no image was copied");

    // A file the image volume still holds counts, since the restore never overwrites one.
    await stack.asApp(`head -c ${img.sizes[0]} /dev/urandom > /data/assets/${lost}`);
    const ok = await stack.restore(name);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(await withDb(async (c) => (await c.query("select count(*)::int as n from rooms where id = 'ZZZZZZZZ'")).rows[0].n), 0, "the dump's rooms replaced the marker");
  });

  test("an image the backup's user cannot read makes the run partial, so a change to the app's file modes shows here", async () => {
    await stack.fresh();
    await applySchema();
    const room = await addRoom(stack, 1);
    const img = room.images[0]!;
    await stack.asApp(`chmod 600 /data/assets/${variantPath("", img.hex, img.kind, "full", 1)}`);
    const r = await stack.backup(["once"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /partial: 1 of 2 listed images are not in the copy \(1 could not be read or copied whole\)/);
    await stack.asApp(`chmod 644 /data/assets/${variantPath("", img.hex, img.kind, "full", 1)}`);
    await goodOnce(stack);
  });
});

