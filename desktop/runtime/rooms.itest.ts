import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { Platform, RoomId } from "../contract.ts";
import { listRooms, newDmLink, type AdminOptions } from "./rooms.ts";
import { ROOT, startTestCluster, type TestCluster } from "./testing/cluster.ts";
import { createRoom, query } from "./testing/dataFixture.ts";

/**
 * Rooms on this computer (docs/design/design-v1-local-app.md 8.6): the
 * supervisor's calls of scripts/admin.ts with `--no-schema --json`, on a
 * real cluster. `--no-schema` is what keeps the list from waiting on, or
 * taking, the locks applySchema's `alter table` lines take during play.
 */

const PORT = 40430;
let t: TestCluster;
let opts: AdminOptions;
let rooms: string[] = [];

before(async () => {
  t = await startTestCluster("rvtt-rooms-");
  await query(t.cluster.url("postgres"), "create database raccoon template template0");
  rooms = [await createRoom(t.cluster.url(), "Lost Mine"), await createRoom(t.cluster.url(), 'A "quoted" name <b>')];
  opts = { node: process.execPath, appRoot: ROOT, databaseUrl: t.cluster.url(), port: PORT, platform: Platform.parse(process.platform) };
});

after(async () => {
  await t?.stop();
});

test("list-rooms gives every room as the contract's RoomSummary, names as they are", async () => {
  const listed = await listRooms(opts);
  assert.deepEqual(listed.map((r) => r.id).sort(), [...rooms].sort());
  for (const r of listed) {
    assert.ok(RoomId.safeParse(r.id).success, r.id);
    assert.ok(r.lastActiveAt && !Number.isNaN(Date.parse(r.lastActiveAt)));
  }
  assert.ok(listed.some((r) => r.name === 'A "quoted" name <b>'));
});

test("dm-link replaces the DM key and answers a whole link on this computer", async () => {
  const id = rooms[0] as string;
  const keyBefore = await query<{ dm_key_hash: Buffer }>(t.cluster.url(), "select dm_key_hash from rooms where id = $1", [id]);
  const link = await newDmLink(opts, id);
  assert.ok(link.startsWith(`http://localhost:${PORT}/r/${id.slice(0, 4)}-${id.slice(4)}#dm=`), link);
  const keyAfter = await query<{ dm_key_hash: Buffer }>(t.cluster.url(), "select dm_key_hash from rooms where id = $1", [id]);
  assert.notDeepEqual(keyAfter[0]?.dm_key_hash, keyBefore[0]?.dm_key_hash);
  await assert.rejects(newDmLink(opts, "ZZZZZZZZ"));
});

function adminRaw(args: string[], timeoutMs: number): Promise<"answered" | "timed out"> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, "scripts", "admin.ts"), ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", DATABASE_URL: t.cluster.url() }, timeout: timeoutMs }, (err) => {
      resolve(err && (err as { killed?: boolean }).killed ? "timed out" : "answered");
    });
  });
}

test("--no-schema answers while play holds a lock that applySchema's alter table would wait on", async () => {
  const holder = new pg.Client({ connectionString: t.cluster.url() });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query("lock table rooms in access share mode");
    const started = Date.now();
    const listed = await listRooms(opts);
    assert.equal(listed.length, 2);
    assert.ok(Date.now() - started < 15_000);
    // The same list without the flag waits on the lock, which is the stall the flag avoids.
    assert.equal(await adminRaw(["--json", "list-rooms"], 4_000), "timed out");
  } finally {
    await holder.query("rollback").catch(() => undefined);
    await holder.end();
  }
});
