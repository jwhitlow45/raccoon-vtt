import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "../rooms/testing.ts";
import { sweepOrphanFiles, sweepThumbnails, type CleanupDeps } from "./cleanup.ts";
import { PIPELINE } from "./kinds.ts";
import { trashDay, variantPath } from "./store.ts";
import { solid } from "./testImages.ts";

/**
 * Image cleanup (docs/design-v1-dm-tools.md 3.19) against the real server
 * and Postgres: the trash, scene thumbnails on loaded and unloaded rooms,
 * files no row names, the DM's library marks and delete, the quota
 * re-check, and an undo that would bring back a deleted image.
 */

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const DAY_MS = 24 * 3600_000;

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

type Uploaded = { id: string; bytes: Buffer };

async function upload(dm: TestClient, roomId: string, kind: string, color: string, width = 64): Promise<Uploaded> {
  const bytes = await solid(width, width, color).png().toBuffer();
  const res = await dm.request("PUT", `/api/rooms/${roomId}/assets?kind=${kind}`, undefined, { "content-type": "image/png" }, bytes);
  assert.equal(res.statusCode, 200, res.body);
  return { id: res.json<{ id: string }>().id, bytes };
}

function randomColor(): string {
  return `#${randomBytes(3).toString("hex")}`;
}

function tokenOp(sceneId: string, assetId: string): Extract<Op, { t: "token.create" }> {
  return {
    t: "token.create",
    token: {
      id: uuidv7(),
      sceneId,
      kind: "monster",
      name: "Goblin",
      size: "medium",
      x: 2,
      y: 2,
      image: { assetId, crop: { cx: 0.5, cy: 0.5, zoom: 1 } },
      actor: {
        inline: {
          hp: { cur: 7, max: 7, temp: 0 },
          life: "alive",
          ac: 15,
          speeds: { walk: 30 },
          initBonus: 2,
          passivePerception: 9,
          senses: "",
          effects: [],
          deathSaves: { ok: 0, fail: 0 },
          notes: "",
          dmNotes: "",
        },
      },
    },
  } as Extract<Op, { t: "token.create" }>;
}

describe("image cleanup", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { actor: { batchMs: 10 } } });
  });
  after(() => t.close());

  function deps(): CleanupDeps {
    return { pool: t.pool, manager: t.manager, assetDir: t.assetDir, quotaBytes: 0, log: t.app.log };
  }

  async function room(name = "Cleanup"): Promise<{ roomId: string; sceneId: string; socket: Socket; dm: TestClient }> {
    const dm = t.client();
    const { roomId } = await dm.createRoom(name);
    const socket = await t.connect(roomId, dm);
    const snap = await socket.snapshot("dm");
    return { roomId, sceneId: (snap.state as ProjectedState).meta.playerSceneId!, socket, dm };
  }

  async function unloaded(roomId: string, socket: Socket): Promise<void> {
    socket.close();
    await socket.waitClosed();
    await t.manager.unload(roomId);
    assert.equal(t.manager.get(roomId), null);
  }

  function filePath(u: Uploaded, kind: string, variant: "full" | "mobile" | "thumb" = "full"): string {
    return variantPath(t.assetDir, sha(u.bytes), kind as "token", variant, PIPELINE);
  }

  function trashed(u: Uploaded, kind: string, variant: "full" | "mobile" | "thumb" = "full"): string {
    const live = filePath(u, kind, variant);
    return join(t.assetDir, "trash", trashDay(new Date()), dirname(live).slice(-2), live.slice(dirname(live).length + 1));
  }

  async function rowExists(id: string): Promise<boolean> {
    return ((await t.pool.query("select 1 from assets where id = $1", [id])).rowCount ?? 0) > 0;
  }

  test("a room's deletion moves its files to the trash, where the backup still finds them", async () => {
    const { roomId, socket, dm } = await room();
    const img = await upload(dm, roomId, "token", randomColor());
    socket.close();
    assert.ok(await exists(filePath(img, "token")));
    const res = await dm.delete(`/api/rooms/${roomId}`, { name: "Cleanup" });
    assert.equal(res.statusCode, 204, res.body);
    assert.equal(await exists(filePath(img, "token")), false);
    assert.ok(await exists(trashed(img, "token")));
    assert.ok(await exists(trashed(img, "token", "thumb")));
  });

  test("files the app writes, and their folders, are readable by others, as the backup's user reads them", async () => {
    const { roomId, socket, dm } = await room();
    const img = await upload(dm, roomId, "map", randomColor(), 300);
    socket.close();
    for (const variant of ["full", "mobile", "thumb"] as const) {
      const s = await stat(filePath(img, "map", variant));
      assert.equal(s.mode & 0o004, 0o004, `${variant} is readable by others`);
    }
    const folder = await stat(dirname(filePath(img, "map")));
    assert.equal(folder.mode & 0o005, 0o005, "its folder is readable and searchable by others");
  });

  test("thumbnails a loaded room no longer names are marked, cleared when named again, and deleted after a day", async () => {
    const { roomId, sceneId, socket, dm } = await room();
    const first = await upload(dm, roomId, "thumb", randomColor());
    const second = await upload(dm, roomId, "thumb", randomColor());
    assert.equal((await socket.apply({ t: "scene.update", sceneId, patch: { thumb: first.id } })).rejects, undefined);

    let sweep = await sweepThumbnails(deps(), roomId);
    assert.deepEqual(sweep, { marked: 1, cleared: 0, deleted: 0, skipped: false });
    const mark = async (id: string) =>
      (await t.pool.query<{ unused_since: Date | null }>("select unused_since from assets where id = $1", [id])).rows[0]?.unused_since ?? null;
    assert.equal(await mark(first.id), null);
    assert.ok(await mark(second.id));

    // Named again, as a DM device does when it sets a thumbnail.
    assert.equal((await socket.apply({ t: "scene.update", sceneId, patch: { thumb: second.id } })).rejects, undefined);
    sweep = await sweepThumbnails(deps(), roomId);
    assert.deepEqual(sweep, { marked: 1, cleared: 1, deleted: 0, skipped: false });
    assert.equal(await mark(second.id), null);

    // Less than a day unused is kept.
    await t.pool.query("update assets set unused_since = now() - interval '23 hours' where id = $1", [first.id]);
    assert.equal((await sweepThumbnails(deps(), roomId)).deleted, 0);
    await t.pool.query("update assets set unused_since = now() - interval '25 hours' where id = $1", [first.id]);
    sweep = await sweepThumbnails(deps(), roomId);
    assert.equal(sweep.deleted, 1);
    assert.equal(await rowExists(first.id), false);
    assert.ok(await rowExists(second.id));
    assert.equal(await exists(filePath(first, "thumb")), false);
    assert.ok(await exists(trashed(first, "thumb")));
    assert.ok(await exists(filePath(second, "thumb")));
  });

  test("on a room that is not loaded, any mention in the snapshot or a later op keeps a thumbnail", async () => {
    const { roomId, sceneId, socket, dm } = await room();
    const inSnapshot = await upload(dm, roomId, "thumb", randomColor());
    const inOp = await upload(dm, roomId, "thumb", randomColor());
    const unused = await upload(dm, roomId, "thumb", randomColor());
    await socket.apply({ t: "scene.update", sceneId, patch: { thumb: inSnapshot.id } });
    await unloaded(roomId, socket);
    // An op stored after the snapshot, as a crash before the next snapshot leaves it.
    const { rows } = await t.pool.query<{ seq: string }>("select seq from room_snapshots where room_id = $1", [roomId]);
    const seq = Number(rows[0]!.seq) + 1;
    await t.pool.query(
      `insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version)
       values ($1, $2, now(), 'x', 'dm', $3::jsonb, 3)`,
      [roomId, seq, JSON.stringify({ t: "scene.update", sceneId, patch: { thumb: inOp.id.toUpperCase() } })],
    );
    await t.pool.query("update assets set unused_since = now() - interval '2 days' where room_id = $1", [roomId]);
    const sweep = await sweepThumbnails(deps(), roomId);
    assert.equal(sweep.deleted, 1);
    assert.ok(await rowExists(inSnapshot.id));
    assert.ok(await rowExists(inOp.id), "an op after the snapshot counts, whatever its case");
    assert.equal(await rowExists(unused.id), false);
    // The room was never loaded for it.
    assert.equal(t.manager.get(roomId), null);
    await t.pool.query("delete from room_ops where room_id = $1 and seq = $2", [roomId, seq]);
  });

  test("files no row names are moved to the trash after a day, and nothing else is touched", async () => {
    const { roomId, socket, dm } = await room();
    const named = await upload(dm, roomId, "token", randomColor());
    socket.close();
    const old = Date.now() - 2 * DAY_MS;
    const orphanHex = randomBytes(32).toString("hex");
    const youngHex = randomBytes(32).toString("hex");
    const orphan = variantPath(t.assetDir, orphanHex, "token", "full", 1);
    const orphanThumb = variantPath(t.assetDir, orphanHex, "token", "thumb", 1);
    const young = variantPath(t.assetDir, youngHex, "token", "full", 1);
    const odd = join(dirname(orphan), "notes.txt");
    const inTmp = join(t.assetDir, "tmp", `${orphanHex}-token-full-v1.webp`);
    const inImport = join(t.assetDir, "import", `${orphanHex}-token-full-v1.webp`);
    for (const p of [orphan, orphanThumb, young, odd, inTmp, inImport]) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, "x");
    }
    for (const p of [orphan, orphanThumb, odd, inTmp, inImport, filePath(named, "token")]) await utimes(p, old / 1000, old / 1000);

    const moved = await sweepOrphanFiles(t.pool, t.assetDir);
    assert.equal(moved, 2);
    assert.equal(await exists(orphan), false);
    assert.equal(await exists(orphanThumb), false);
    assert.ok(await exists(join(t.assetDir, "trash", trashDay(new Date()), orphanHex.slice(0, 2), `${orphanHex}-token-full-v1.webp`)));
    for (const p of [young, odd, inTmp, inImport, filePath(named, "token")]) assert.ok(await exists(p), p);
  });

  test("the daily pass sweeps thumbnails, walks for orphans on its first run, and purges trash days past 48 hours", async () => {
    const { roomId, sceneId, socket, dm } = await room();
    const kept = await upload(dm, roomId, "thumb", randomColor());
    const old = await upload(dm, roomId, "thumb", randomColor());
    await socket.apply({ t: "scene.update", sceneId, patch: { thumb: kept.id } });
    await t.pool.query("update assets set unused_since = now() - interval '2 days' where id = $1", [old.id]);
    const stale = join(t.assetDir, "trash", "2020-01-01", "ab", "f.webp");
    await mkdir(dirname(stale), { recursive: true });
    await writeFile(stale, "x");
    const report = await t.app.cleanup.run();
    assert.ok(report.thumbsDeleted >= 1);
    assert.notEqual(report.orphanFiles, null, "the first pass walks the folders");
    assert.ok(report.trashDaysPurged >= 1);
    assert.equal(await exists(stale), false);
    assert.equal(await rowExists(old.id), false);
    assert.ok(await rowExists(kept.id));
    assert.equal((await t.app.cleanup.run()).orphanFiles, null, "the walk waits for the seventh pass");
  });

  test("a DM's library marks what the state uses, a player's carries no mark", async () => {
    const { roomId, sceneId, socket, dm } = await room();
    const used = await upload(dm, roomId, "token", randomColor());
    const spare = await upload(dm, roomId, "token", randomColor());
    const map = await upload(dm, roomId, "map", randomColor(), 200);
    const handout = await upload(dm, roomId, "handout", randomColor());
    await socket.apply(tokenOp(sceneId, used.id));
    const setMap = await socket.apply({ t: "scene.setMap", sceneId, map: { assetId: map.id, widthPx: 200, heightPx: 200, cellPx: 50, originPx: { x: 0, y: 0 } } });
    assert.equal(setMap.rejects, undefined);
    const res = await dm.get(`/api/rooms/${roomId}/assets`);
    const assets = res.json<{ assets: Array<{ id: string; kind: string; inUse?: boolean; bytes?: number }> }>().assets;
    assert.equal(assets.find((a) => a.id === used.id)?.inUse, true);
    assert.equal(assets.find((a) => a.id === spare.id)?.inUse, false);
    // Every kind is marked, and sized as the quota counts it.
    assert.equal(assets.find((a) => a.id === map.id)?.inUse, true);
    assert.equal(assets.find((a) => a.id === handout.id)?.inUse, false);
    for (const a of assets) {
      const row = (await t.pool.query<{ bytes: string }>("select bytes from assets where id = $1", [a.id])).rows[0]!;
      assert.equal(a.bytes, Number(row.bytes), `${a.kind} carries its bytes`);
    }

    const player = t.client();
    await player.join(roomId, "Pip");
    const theirs = await upload(player, roomId, "token", randomColor());
    const listed = (await player.get(`/api/rooms/${roomId}/assets`)).json<{ assets: Array<Record<string, unknown>> }>().assets;
    assert.ok(listed.some((a) => a.id === theirs.id));
    assert.ok(listed.every((a) => !("inUse" in a) && !("bytes" in a)));
  });

  test("the library delete refuses players, bad bodies and images in use, and deletes the rest whole", async () => {
    const { roomId, sceneId, socket, dm } = await room();
    const used = await upload(dm, roomId, "token", randomColor());
    const spare = await upload(dm, roomId, "token", randomColor());
    const spare2 = await upload(dm, roomId, "handout", randomColor());
    await socket.apply(tokenOp(sceneId, used.id));
    const url = `/api/rooms/${roomId}/assets/delete`;

    const player = t.client();
    await player.join(roomId, "Pip");
    assert.equal((await player.post(url, { ids: [spare.id] })).statusCode, 403);
    assert.equal((await t.client().post(url, { ids: [spare.id] })).statusCode, 403);
    assert.equal((await dm.post(url, { ids: [] })).statusCode, 400);
    assert.equal((await dm.post(url, { ids: ["not-an-id"] })).statusCode, 400);
    const tooMany = Array.from({ length: 501 }, () => crypto.randomUUID());
    assert.equal((await dm.post(url, { ids: tooMany })).statusCode, 400);

    const refused = await dm.post(url, { ids: [spare.id, used.id] });
    assert.equal(refused.statusCode, 409);
    assert.deepEqual(refused.json(), { error: "asset_in_use", inUse: [used.id] });
    assert.ok(await rowExists(spare.id), "nothing is deleted when one is in use");

    const ok = await dm.post(url, { ids: [spare.id, spare2.id.toUpperCase(), crypto.randomUUID()] });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(new Set(ok.json<{ deleted: string[] }>().deleted), new Set([spare.id, spare2.id]));
    assert.equal(await rowExists(spare.id), false);
    assert.equal(await exists(filePath(spare, "token")), false);
    assert.ok(await exists(trashed(spare, "token")));
    assert.ok(await exists(filePath(used, "token")));

    // On a room that is not loaded, a mention anywhere keeps an image.
    await unloaded(roomId, socket);
    const refusedCold = await dm.post(url, { ids: [used.id] });
    assert.equal(refusedCold.statusCode, 409);
    assert.equal(t.manager.get(roomId), null, "the delete never loads the room");
  });

  test("on a room whose replay failed, the library carries no marks and the delete answers state_unknown", async () => {
    const { roomId, socket, dm } = await room();
    const img = await upload(dm, roomId, "token", randomColor());
    await unloaded(roomId, socket);
    // An op that does not follow the snapshot stops the replay.
    const { rows } = await t.pool.query<{ seq: string }>("select seq from room_snapshots where room_id = $1", [roomId]);
    await t.pool.query(
      `insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version)
       values ($1, $2, now(), 'x', 'dm', '{"t":"log.chat","text":"lost"}'::jsonb, 3)`,
      [roomId, Number(rows[0]!.seq) + 2],
    );
    // A socket keeps the room loaded while the requests run.
    const held = await t.connect(roomId, dm);
    await held.snapshot("dm-held");
    assert.equal(t.manager.get(roomId)?.replayFailed, true);
    const listed = (await dm.get(`/api/rooms/${roomId}/assets`)).json<{ assets: Array<Record<string, unknown>> }>().assets;
    assert.ok(listed.every((a) => !("inUse" in a)), "nothing is marked on a guess");
    const res = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [img.id] });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: "state_unknown" });
    assert.ok(await rowExists(img.id));
    held.close();
  });

  test("an image shared with another room keeps its file when one room deletes it", async () => {
    const a = await room("Shared A");
    const b = await room("Shared B");
    const color = randomColor();
    const inA = await upload(a.dm, a.roomId, "token", color);
    await upload(b.dm, b.roomId, "token", color);
    const res = await a.dm.post(`/api/rooms/${a.roomId}/assets/delete`, { ids: [inA.id] });
    assert.equal(res.statusCode, 200);
    assert.ok(await exists(filePath(inA, "token")), "room B still names the file");
  });

  test("undoing the deletion of a token whose image was deleted since is refused", async () => {
    const { roomId, sceneId, socket, dm } = await room();
    const img = await upload(dm, roomId, "token", randomColor());
    const create = tokenOp(sceneId, img.id);
    await socket.apply(create);
    await socket.apply({ t: "token.delete", tokenId: create.token.id });
    const res = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [img.id] });
    assert.equal(res.statusCode, 200, res.body);
    const undo = await socket.apply({ t: "undo" });
    assert.equal(undo.rejects?.[0]?.code, "gone");
    assert.match(undo.rejects?.[0]?.message ?? "", /its image was deleted since/);
  });
});

describe("the quota re-check after a deletion", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { actor: { batchMs: 10, quotaBytes: 200_000 } } });
  });
  after(() => t.close());

  async function fill(): Promise<{ roomId: string; dm: TestClient; socket: Socket; big: string }> {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Quota");
    const socket = await t.connect(roomId, dm);
    await socket.snapshot("dm");
    // Noise does not compress, so its variants are large.
    const noise = await import("sharp").then(({ default: sharp }) =>
      sharp(randomBytes(400 * 400 * 3), { raw: { width: 400, height: 400, channels: 3 } }).png().toBuffer(),
    );
    const res = await dm.request("PUT", `/api/rooms/${roomId}/assets?kind=handout`, undefined, { "content-type": "image/png" }, noise);
    assert.equal(res.statusCode, 200, res.body);
    await t.pool.query("update rooms set read_only = true where id = $1", [roomId]);
    return { roomId, dm, socket, big: res.json<{ id: string }>().id };
  }

  const readOnly = async (roomId: string) => (await t.pool.query<{ read_only: boolean }>("select read_only from rooms where id = $1", [roomId])).rows[0]?.read_only;

  test("a room that is not loaded takes edits again once a deletion brings it under its quota", async () => {
    const { roomId, dm, socket, big } = await fill();
    socket.close();
    await socket.waitClosed();
    await t.manager.unload(roomId);
    assert.equal(await readOnly(roomId), true);
    const res = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [big] });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await readOnly(roomId), false);
  });

  test("a loaded room does too, through its actor", async () => {
    const { roomId, dm, socket, big } = await fill();
    // Loaded with the flag set, as a room that reached its quota is.
    socket.close();
    await socket.waitClosed();
    await t.manager.unload(roomId);
    const actor = await t.manager.acquire(roomId);
    assert.equal(actor.readOnly, true);
    const res = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [big] });
    assert.equal(res.statusCode, 200, res.body);
    // The actor checks after the step settles, so the answer can come first.
    for (let i = 0; i < 100 && (actor.readOnly || (await readOnly(roomId))); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(actor.readOnly, false);
    assert.equal(await readOnly(roomId), false);
  });
});
