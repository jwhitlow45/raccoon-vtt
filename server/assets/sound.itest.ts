import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import yauzl from "yauzl";
import yazl from "yazl";
import { SOUND_LIMITS } from "#shared/limits.ts";
import type { RoomState, SoundFacts } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { concat, framesFor, id3v1, id3v2, silentFrames, withTagFrame } from "#shared/audio/mp3Testutil.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import type { ExportManifest } from "../rooms/exportRoom.ts";
import type { Logger } from "../rooms/actor.ts";
import { importRoom } from "../rooms/importRoom.ts";
import { startEngine, type Engine, type TestClient } from "../rooms/testing.ts";
import { sweepOrphanFiles, sweepUnnamed } from "./cleanup.ts";
import { SOUND_PIPELINE } from "./kinds.ts";
import { roomStoredBytes } from "./quota.ts";
import { variantPath } from "./store.ts";
import { solid } from "./testImages.ts";

/**
 * Sound files on the server (docs/design/design-v1-music.md 7 and 12,
 * Integration): the switch on and off, uploads checked frame by frame in a
 * worker, refusals by code, reuse, serving by ranges, players' and
 * displays' 404s, the quota and its headroom, deletion, the storage route,
 * cleanup, and backups with and without sounds.
 */

const MiB = 1024 * 1024;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const HANG = new URL("./audio/hangWorker.testutil.ts", import.meta.url);

type Uploaded = { id: string; kind: string; width: number; height: number; variants: string[]; audio?: SoundFacts; created?: boolean };

function upload(client: TestClient, roomId: string, body: Uint8Array, opts: { type?: string; kind?: string } = {}) {
  return client.request("PUT", `/api/rooms/${roomId}/assets?kind=${opts.kind ?? "sound"}`, undefined, { "content-type": opts.type ?? "audio/mpeg" }, Buffer.from(body));
}

async function uploaded(client: TestClient, roomId: string, body: Uint8Array): Promise<Uploaded> {
  const res = await upload(client, roomId, body);
  assert.equal(res.statusCode, 200, res.body);
  return res.json<Uploaded>();
}

const read = (client: TestClient, id: string, headers: Record<string, string> = {}) => client.request("GET", `/api/assets/${id}/full`, undefined, headers);

async function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  const zip = await yauzl.fromBufferPromise(buf);
  const out = new Map<string, Buffer>();
  for await (const entry of zip.eachEntry()) {
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
    out.set(entry.fileName, Buffer.concat(chunks));
  }
  return out;
}

async function zipOf(files: Map<string, Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of files) zip.addBuffer(data, name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks);
}

/** The new room's id and answer from POST /api/rooms/import. */
async function imported(t: Engine, zip: Buffer): Promise<{ roomId: string; soundsLeftOut?: number }> {
  const form = Buffer.from(JSON.stringify({ playerPassword: "owlbear-druid-wand", dmName: "Importer" })).toString("base64url");
  const res = await t.client().request("POST", "/api/rooms/import", undefined, { "content-type": "application/zip", "x-import-form": form }, zip);
  assert.equal(res.statusCode, 201, res.body);
  const answer = res.json<{ roomId: string; soundsLeftOut?: number }>();
  t.track(answer.roomId);
  return answer;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** A distinct sound of `ms`, its bytes told apart by which frames carry the private bit. */
function sound(ms = 3_000, seed = Math.floor(Math.random() * 1e9), shape: Parameters<typeof silentFrames>[1] = {}): Uint8Array {
  return silentFrames(framesFor(ms, shape.rateHz), { ...shape, bits: (i) => ({ private: ((seed >> i % 30) & 1) === 1 }) });
}

/** Turns on Only DM devices play in a room through its DM's socket, then sends these ops too. */
async function dmOnly(t: Engine, dm: TestClient, roomId: string, ...ops: Op[]): Promise<void> {
  const socket = await t.connect(roomId, dm);
  await socket.snapshot("dm");
  for (const op of [{ t: "room.update", settings: { soundDmOnly: true } } as Op, ...ops]) assert.equal((await socket.apply(op)).rejects, undefined, op.t);
  socket.close();
}

async function storedState(t: Engine, roomId: string): Promise<RoomState> {
  const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
  return rows[0]!.state;
}

describe("sound files with the switch on", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ env: { ROOM_SOUND: "1" } });
  });
  after(async () => {
    await t.close();
  });

  test("a DM's upload stores the bytes the walk took as one .mp3, and answers its facts and created", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const bytes = withTagFrame(sound(4_000));
    const first = await uploaded(dm, roomId, bytes);
    assert.deepEqual({ kind: first.kind, width: first.width, height: first.height, variants: first.variants, created: first.created }, { kind: "sound", width: 0, height: 0, variants: ["full"], created: true });
    assert.deepEqual(first.audio, { ms: Math.floor((framesFor(4_000) * 1152 * 1000) / 44_100), channels: 2, kbps: 128 });
    const { rows } = await t.pool.query<{ media: string; audio: unknown; video: unknown; pipeline: number; bytes: string }>("select media, audio, video, pipeline, bytes from assets where id = $1", [first.id]);
    assert.deepEqual({ ...rows[0], bytes: Number(rows[0]!.bytes) }, { media: "mp3", audio: first.audio, video: null, pipeline: SOUND_PIPELINE, bytes: bytes.length });
    const file = await readFile(variantPath(t.assetDir, sha(bytes), "sound", "full", SOUND_PIPELINE, "mp3"));
    assert.ok(file.equals(bytes), "kept as it came");
    // The same bytes again reuse the row, so two sounds may name one file.
    const again = await uploaded(dm, roomId, bytes);
    assert.deepEqual({ id: again.id, created: again.created }, { id: first.id, created: false });
    assert.deepEqual(await readdir(join(t.assetDir, "tmp")), []);
    // No library lists a sound: the room's sounds name them.
    const library = await dm.get(`/api/rooms/${roomId}/assets`);
    assert.deepEqual(library.json<{ assets: unknown[] }>().assets, []);
  });

  test("served as audio/mpeg with the image headers and a strong ETag, by ranges", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const bytes = sound(2_000, 7, { kbps: 64, mode: 3, rateHz: 48_000 });
    const s = await uploaded(dm, roomId, bytes);
    assert.deepEqual(s.audio, { ms: Math.floor((framesFor(2_000, 48_000) * 1152 * 1000) / 48_000), channels: 1, kbps: 64 });
    const whole = await read(dm, s.id);
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers["content-type"], "audio/mpeg");
    assert.equal(whole.headers["x-content-type-options"], "nosniff");
    assert.equal(whole.headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.equal(whole.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(whole.headers["cache-control"], "private, max-age=31536000, immutable");
    assert.equal(whole.headers["accept-ranges"], "bytes");
    assert.equal(whole.headers.etag, `"${sha(bytes)}-v${SOUND_PIPELINE}"`);
    assert.ok(whole.rawPayload.equals(Buffer.from(bytes)));
    const part = await read(dm, s.id, { range: "bytes=100-299" });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers["content-range"], `bytes 100-299/${bytes.length}`);
    assert.ok(part.rawPayload.equals(Buffer.from(bytes.subarray(100, 300))));
    assert.equal((await read(dm, s.id, { range: `bytes=${bytes.length}-` })).statusCode, 416);
    assert.equal((await read(dm, s.id, { range: "bytes=0-9", "if-range": whole.headers.etag as string })).statusCode, 206);
    assert.equal((await read(dm, s.id, { range: "bytes=0-9", "if-range": '"another"' })).statusCode, 200);
  });

  test("the upload pairs audio/mpeg with the sound kind, before a byte is read, and only a DM adds one", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const bytes = sound();
    for (const [type, kind] of [["audio/mpeg", "map"], ["audio/mpeg", "video"], ["image/png", "sound"], ["video/webm", "sound"], ["video/mp4", "sound"]] as const) {
      const res = await upload(dm, roomId, bytes, { type, kind });
      assert.equal(res.statusCode, 415, `${type} as ${kind}: ${res.body}`);
      assert.deepEqual(res.json(), { error: "unsupported_type" });
      assert.equal(res.headers.connection, "close", "the body is never read");
    }
    for (const type of ["audio/ogg", "audio/wav", "application/octet-stream"]) assert.equal((await upload(dm, roomId, bytes, { type })).statusCode, 415, type);
    const player = t.client();
    await player.join(roomId);
    assert.equal((await upload(player, roomId, bytes)).statusCode, 403);
    // Link and Search the web take images only.
    const linked = await dm.post(`/api/rooms/${roomId}/assets/import`, { url: "https://example.com/rain.mp3", kind: "sound" });
    assert.equal(linked.statusCode, 415, linked.body);
    assert.equal((await t.pool.query("select 1 from assets where room_id = $1", [roomId])).rowCount, 0);
  });

  test("a refused sound answers its code and stores nothing", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const good = sound();
    const twoRates = concat(good, silentFrames(20, { kbps: 160 }));
    const cases: Array<[Uint8Array, number, string]> = [
      [concat(id3v2(200), good), 415, "sound_type"],
      [concat(good, id3v1()), 415, "sound_type"],
      [twoRates, 415, "sound_type"],
      [silentFrames(framesFor(3_000, 32_000), { rateHz: 32_000 }), 415, "sound_type"],
      [concat(good, new Uint8Array([0])), 415, "sound_type"],
      [good.subarray(0, good.length - 1), 415, "sound_type"],
      [new TextEncoder().encode("<svg onload=alert(1)>"), 415, "sound_type"],
      // An Info and LAME frame after the first frame, its fields holding text (MUS-SOL-01).
      [concat(good, withTagFrame(good, { lame: { name: "LAMEAlice" } })), 415, "sound_type"],
      [silentFrames(framesFor(16 * 60_000), { kbps: 64 }), 422, "sound_length"],
      [silentFrames(5), 422, "sound_length"],
    ];
    for (const [bytes, status, code] of cases) {
      const res = await upload(dm, roomId, bytes);
      assert.equal(res.statusCode, status, res.body);
      assert.deepEqual(res.json(), { error: code });
    }
    assert.equal((await t.pool.query("select 1 from assets where room_id = $1", [roomId])).rowCount, 0);
    assert.deepEqual(await readdir(join(t.assetDir, "tmp")), []);
    // Over the size cap by its Content-Length: refused before the body.
    const huge = await dm.request("PUT", `/api/rooms/${roomId}/assets?kind=sound`, undefined, { "content-type": "audio/mpeg", "content-length": String(SOUND_LIMITS.fileBytes + 1) }, Buffer.alloc(16));
    assert.equal(huge.statusCode, 413);
  });

  test("players and a table display read no sound that what plays does not name", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const s = await uploaded(dm, roomId, sound());
    const player = t.client();
    await player.join(roomId);
    const playerSocket = await t.connect(roomId, player);
    await playerSocket.snapshot("p");
    assert.equal((await read(player, s.id)).statusCode, 404);
    assert.equal((await read(player, s.id, { range: "bytes=0-99" })).statusCode, 404);
    const minted = await dm.post(`/api/rooms/${roomId}/display/code`);
    const tv = t.client();
    assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(minted.json<{ code: string }>().code) })).statusCode, 200);
    assert.equal((await tv.request("GET", `/api/rooms/${roomId}/display/assets/${s.id}/full`, undefined, { range: "bytes=0-99" })).statusCode, 404);
    // Nor any other room's DM.
    const other = t.client();
    await other.createRoom();
    assert.equal((await read(other, s.id)).statusCode, 404);
  });

  test("a player and a table display read a sound by ranges while what plays names it, and not before or after", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const bytes = sound(3_000, 71);
    const s = await uploaded(dm, roomId, bytes);
    const socket = await t.connect(roomId, dm);
    await socket.snapshot("dm");
    assert.equal((await socket.apply({ t: "sound.create", id: "rain", assetId: s.id, name: "Rain", use: "loop", ms: s.audio!.ms })).rejects, undefined);
    const player = t.client();
    await player.join(roomId);
    const minted = await dm.post(`/api/rooms/${roomId}/display/code`);
    const tv = t.client();
    assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(minted.json<{ code: string }>().code) })).statusCode, 200);
    const shown = (headers: Record<string, string>) => tv.request("GET", `/api/rooms/${roomId}/display/assets/${s.id}/full`, undefined, headers);
    assert.equal((await read(player, s.id, { range: "bytes=0-99" })).statusCode, 404, "in the library only");
    assert.equal((await shown({ range: "bytes=0-99" })).statusCode, 404);

    assert.equal((await socket.apply({ t: "loop.start", id: "loop1", soundId: "rain", volume: 70 })).rejects, undefined);
    const part = await read(player, s.id, { range: "bytes=100-299" });
    assert.equal(part.statusCode, 206, part.body);
    assert.equal(part.headers["content-type"], "audio/mpeg");
    assert.equal(part.headers["content-range"], `bytes 100-299/${bytes.length}`);
    assert.ok(part.rawPayload.equals(Buffer.from(bytes.subarray(100, 300))));
    const onScreen = await shown({ range: "bytes=0-99" });
    assert.equal(onScreen.statusCode, 206, onScreen.body);
    assert.ok(onScreen.rawPayload.equals(Buffer.from(bytes.subarray(0, 100))));

    assert.equal((await socket.apply({ t: "loop.stop", id: "loop1" })).rejects, undefined);
    assert.equal((await read(player, s.id, { range: "bytes=0-99" })).statusCode, 404, "stopped, it is the library's again");
    assert.equal((await shown({ range: "bytes=0-99" })).statusCode, 404);
    socket.close();
  });

  test("the storage line: the DM's alone, read again after an upload or a delete, and a delete sends the file to the trash as .mp3", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const storage = async () => {
      const res = await dm.get(`/api/rooms/${roomId}/storage`);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers["cache-control"], "no-store");
      return res.json<{ used: number; quota: number; sounds: number }>();
    };
    const before = await storage();
    assert.deepEqual({ quota: before.quota, sounds: before.sounds }, { quota: 1024 * MiB, sounds: 0 });
    const bytes = sound(5_000);
    const s = await uploaded(dm, roomId, bytes);
    const withSound = await storage();
    assert.equal(withSound.sounds, bytes.length);
    assert.equal(withSound.used, await roomStoredBytes(t.pool, roomId));
    // An image counts in what the room uses, never in its sounds.
    const image = await dm.request("PUT", `/api/rooms/${roomId}/assets?kind=token`, undefined, { "content-type": "image/png" }, await solid(64, 64).png().toBuffer());
    assert.equal(image.statusCode, 200);
    const afterImage = await storage();
    assert.ok(afterImage.used > withSound.used);
    assert.equal(afterImage.sounds, bytes.length);
    const player = t.client();
    await player.join(roomId);
    assert.equal((await player.get(`/api/rooms/${roomId}/storage`)).statusCode, 403);

    const gone = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [s.id] });
    assert.equal(gone.statusCode, 200, gone.body);
    assert.equal((await storage()).sounds, 0, "read again at once after the delete");
    assert.equal(await exists(variantPath(t.assetDir, sha(bytes), "sound", "full", SOUND_PIPELINE, "mp3")), false);
    const day = new Date().toISOString().slice(0, 10);
    assert.ok(await exists(join(t.assetDir, "trash", day, sha(bytes).slice(0, 2), `${sha(bytes)}-sound-full-v${SOUND_PIPELINE}.mp3`)));
  });

  test("the storage line is kept 10 seconds between reads, so a burst of asks makes one query", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const first = (await dm.get(`/api/rooms/${roomId}/storage`)).json<{ sounds: number }>();
    // A row written behind the service's back is not seen until the line is read again.
    await t.pool.query(`insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants, media, audio) values ($1, $2, $3, 'sound', 1, 0, 0, 1000, '{full}', 'mp3', $4)`, [
      randomUUID(),
      roomId,
      Buffer.alloc(32, 3),
      JSON.stringify({ ms: 3000, channels: 2, kbps: 128 }),
    ]);
    const asks = await Promise.all(Array.from({ length: 5 }, () => dm.get(`/api/rooms/${roomId}/storage`)));
    for (const ask of asks) assert.equal(ask.json<{ sounds: number }>().sounds, first.sounds);
    t.app.assets.forgetStorage(roomId);
    assert.equal((await dm.get(`/api/rooms/${roomId}/storage`)).json<{ sounds: number }>().sounds, 1000);
  });

  test("a live upload must leave 32 MiB of the quota free, checked again at commit, while an image needs only the quota", async () => {
    const small = await startEngine({ env: { ROOM_SOUND: "1", ROOM_QUOTA_MB: "40" } });
    try {
      const dm = small.client();
      const { roomId } = await dm.createRoom();
      const bytes = sound(3_000, 11);
      const stored = await roomStoredBytes(small.pool, roomId);
      // A byte more than the room can hold beside this sound's file and the headroom.
      const filler = 40 * MiB - stored - SOUND_LIMITS.quotaHeadroomBytes - bytes.length + 1;
      await small.pool.query(`insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants) values ($1, $2, $3, 'map', 1, 1, 1, $4, '{full}')`, [randomUUID(), roomId, Buffer.alloc(32, 9), filler]);
      const refused = await upload(dm, roomId, bytes);
      assert.equal(refused.statusCode, 413, refused.body);
      assert.deepEqual(refused.json(), { error: "quota_exceeded" });
      assert.equal((await dm.request("PUT", `/api/rooms/${roomId}/assets?kind=token`, undefined, { "content-type": "image/png" }, await solid(64, 64).png().toBuffer())).statusCode, 200);
      assert.equal((await small.pool.query("select 1 from assets where room_id = $1 and kind = 'sound'", [roomId])).rowCount, 0);
    } finally {
      await small.close();
    }
  });

  test("cleanup: a sound no state names is marked, and goes a day later, while one the stored state names stays", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const named = await uploaded(dm, roomId, sound(3_000, 21));
    const unnamed = await uploaded(dm, roomId, sound(3_000, 22));
    const unnamedBytes = (await read(dm, unnamed.id)).rawPayload;
    // Unloaded, the stored state is read as text, where any mention of an id counts as a use.
    assert.equal(t.manager.get(roomId), null, "the room is not loaded");
    await t.pool.query("update room_snapshots set state = jsonb_set(state, '{meta,name}', to_jsonb($2::text)) where room_id = $1", [roomId, `kept ${named.id}`]);
    const deps = { pool: t.pool, manager: t.manager, assetDir: t.assetDir, quotaBytes: 0, log: { info: () => undefined, debug: () => undefined, warn: () => undefined, error: console.error } };
    const first = await sweepUnnamed(deps, roomId);
    assert.equal(first.deleted, 0);
    const marks = await t.pool.query<{ id: string; unused: boolean }>("select id::text as id, unused_since is not null as unused from assets where room_id = $1 order by id", [roomId]);
    assert.deepEqual(Object.fromEntries(marks.rows.map((r) => [r.id, r.unused])), { [named.id]: false, [unnamed.id]: true });
    await t.pool.query("update assets set unused_since = now() - interval '2 days' where id = $1", [unnamed.id]);
    const second = await sweepUnnamed(deps, roomId);
    assert.equal(second.deleted, 1);
    assert.equal((await t.pool.query("select 1 from assets where id = $1", [unnamed.id])).rowCount, 0);
    assert.equal((await t.pool.query("select 1 from assets where id = $1", [named.id])).rowCount, 1);
    assert.equal(await exists(variantPath(t.assetDir, sha(unnamedBytes), "sound", "full", SOUND_PIPELINE, "mp3")), false);
  });

  test("a backup carries each sound as .mp3 with its facts, and the import walks it again and trusts its own", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const bytes = withTagFrame(sound(4_000, 31), { name: "Xing" });
    const s = await uploaded(dm, roomId, bytes);
    assert.equal((await dm.request("PUT", `/api/rooms/${roomId}/assets?kind=token`, undefined, { "content-type": "image/png" }, await solid(64, 64).png().toBuffer())).statusCode, 200);
    const exported = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(exported.statusCode, 200, exported.body);
    const files = await unzip(exported.rawPayload);
    const manifest = JSON.parse(files.get("assets.json")!.toString()) as ExportManifest;
    const entry = manifest.assets.find((a) => a.kind === "sound");
    assert.deepEqual({ media: entry?.media, audio: entry?.audio, sha256: entry?.sha256 }, { media: "mp3", audio: s.audio, sha256: sha(bytes) });
    assert.ok(files.get(`assets/${sha(bytes)}-sound-full.mp3`)?.equals(Buffer.from(bytes)), "the sound's entry, its bytes as stored");

    // The manifest's facts are untrusted: a hand-edited one claims an hour.
    entry!.audio = { ms: 3_600_000, channels: 1, kbps: 192 };
    files.set("assets.json", Buffer.from(JSON.stringify(manifest)));
    const into = await imported(t, await zipOf(files));
    assert.equal(into.soundsLeftOut, undefined, "a room with no sounds in its state leaves none out");
    const { rows } = await t.pool.query<{ media: string; audio: unknown; bytes: string }>("select media, audio, bytes from assets where room_id = $1 and kind = 'sound'", [into.roomId]);
    assert.deepEqual(rows.map((r) => ({ ...r, bytes: Number(r.bytes) })), [{ media: "mp3", audio: s.audio, bytes: bytes.length }]);
  });

  test("a backup's sounds come back with their rows' lengths, and one whose file is missing or too short for its use is left out with its places and counted", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const files = { rain: sound(3_000, 81), wind: sound(3_000, 82), boom: sound(10_000, 83) };
    const rows = { rain: await uploaded(dm, roomId, files.rain), wind: await uploaded(dm, roomId, files.wind), boom: await uploaded(dm, roomId, files.boom) };
    const socket = await t.connect(roomId, dm);
    const sceneId = ((await socket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    for (const [id, use] of [["rain", "loop"], ["wind", "loop"], ["boom", "effect"]] as const) {
      assert.equal((await socket.apply({ t: "sound.create", id, assetId: rows[id].id, name: id, use, ms: rows[id].audio!.ms })).rejects, undefined, id);
    }
    const places = { music: null, loops: [{ soundId: "rain", volume: 40 }, { soundId: "wind", volume: 50 }] };
    assert.equal((await socket.apply({ t: "scene.update", sceneId, patch: { sound: places } })).rejects, undefined);
    assert.equal((await socket.apply({ t: "loop.start", id: "loop1", soundId: "rain", volume: 70 })).rejects, undefined);
    socket.close();
    await socket.waitClosed();

    const zip = await unzip((await dm.get(`/api/rooms/${roomId}/export`)).rawPayload);
    zip.delete(`assets/${sha(files.wind)}-sound-full.mp3`);
    // A hand-edited room.json: a minute of music for a 10 s file, and another length for Rain. The rows' walks decide both.
    const room = JSON.parse(zip.get("room.json")!.toString()) as { state: RoomState };
    const sounds = room.state.sounds!;
    sounds.boom = { ...sounds.boom!, use: "music", ms: 60_000 };
    sounds.rain = { ...sounds.rain!, ms: 2_500 };
    zip.set("room.json", Buffer.from(JSON.stringify(room)));
    const into = await imported(t, await zipOf(zip));
    assert.equal(into.soundsLeftOut, 2, "Wind's file and Boom's use, each once");

    const { rows: stored } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [into.roomId]);
    const state = stored[0]!.state;
    const { rows: rain } = await t.pool.query<{ id: string }>("select id::text as id from assets where room_id = $1 and sha256 = $2", [into.roomId, Buffer.from(sha(files.rain), "hex")]);
    const kept = Object.values(state.sounds ?? {});
    assert.deepEqual(
      kept.map((s) => ({ name: s.name, use: s.use, ms: s.ms, assetId: s.assetId })),
      [{ name: "rain", use: "loop", ms: rows.rain.audio!.ms, assetId: rain[0]!.id }],
    );
    const scene = Object.values(state.scenes).find((s) => s.sound !== undefined);
    assert.deepEqual(scene?.sound, { music: null, loops: [{ soundId: kept[0]!.id, volume: 40 }] }, "Wind's place goes with it");
    assert.equal(state.playing, null, "the room starts silent");
  });

  test("Include sounds off, the backup holds no sound file and nothing about sound but Only DM devices play, and its images still go", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const bytes = sound(3_000, 41);
    await uploaded(dm, roomId, bytes);
    await dmOnly(t, dm, roomId);
    assert.equal((await dm.request("PUT", `/api/rooms/${roomId}/assets?kind=token`, undefined, { "content-type": "image/png" }, await solid(64, 64).png().toBuffer())).statusCode, 200);
    const head = await dm.request("HEAD", `/api/rooms/${roomId}/export?sounds=0`);
    assert.equal(head.statusCode, 200);
    const exported = await dm.get(`/api/rooms/${roomId}/export?sounds=0`);
    assert.equal(exported.statusCode, 200, exported.body);
    const files = await unzip(exported.rawPayload);
    const names = [...files.keys()];
    assert.equal(names.some((n) => n.endsWith(".mp3")), false, names.join(" "));
    assert.ok(names.some((n) => n.endsWith("-token-full.webp")));
    const manifest = JSON.parse(files.get("assets.json")!.toString()) as ExportManifest;
    assert.deepEqual(manifest.assets.map((a) => a.kind), ["token"]);
    const into = await imported(t, exported.rawPayload);
    assert.equal((await t.pool.query("select 1 from assets where room_id = $1 and kind = 'sound'", [into.roomId])).rowCount, 0);
    assert.equal((await storedState(t, into.roomId)).meta.settings.soundDmOnly, true, "the DM's choice comes back");
  });

  test("a backup of a room with only built-in effects keeps Only DM devices play through its import (docs/design/design-v1-sound-dm-only.md 7)", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    await dmOnly(t, dm, roomId, { t: "effect.fire", id: "fx1", builtin: "click" });
    const exported = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(exported.statusCode, 200, exported.body);
    const manifest = JSON.parse((await unzip(exported.rawPayload)).get("assets.json")!.toString()) as ExportManifest;
    assert.equal(manifest.assets.some((a) => a.kind === "sound"), false, "no sound file, so the import keeps no sound");
    const into = await imported(t, exported.rawPayload);
    const state = await storedState(t, into.roomId);
    assert.equal(state.meta.settings.soundDmOnly, true);
    assert.equal(state.playing ?? null, null, "the room starts silent");
  });

  test("an import skips a sound entry that fails the walk, and one whose entry is missing", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const kept = sound(3_000, 51);
    const tampered = sound(3_000, 52);
    const missing = sound(3_000, 53);
    for (const b of [kept, tampered, missing]) await uploaded(dm, roomId, b);
    const files = await unzip((await dm.get(`/api/rooms/${roomId}/export`)).rawPayload);
    files.set(`assets/${sha(tampered)}-sound-full.mp3`, Buffer.from(concat(tampered, id3v1())));
    files.delete(`assets/${sha(missing)}-sound-full.mp3`);
    const into = await imported(t, await zipOf(files));
    const { rows } = await t.pool.query<{ sha: string }>("select encode(sha256, 'hex') as sha from assets where room_id = $1 and kind = 'sound'", [into.roomId]);
    assert.deepEqual(rows.map((r) => r.sha), [sha(kept)]);
    assert.deepEqual(await readdir(join(t.assetDir, "tmp")).then((n) => n.filter((x) => x.startsWith("intake-"))), []);
  });

  test("the orphan sweep takes an .mp3 no row names, and leaves a sound's name with another extension", async () => {
    const hex = sha(Buffer.from(randomUUID()));
    const path = variantPath(t.assetDir, hex, "sound", "full", SOUND_PIPELINE, "mp3");
    await mkdir(join(t.assetDir, hex.slice(0, 2)), { recursive: true });
    await writeFile(path, sound());
    const other = sha(Buffer.from(randomUUID()));
    await mkdir(join(t.assetDir, other.slice(0, 2)), { recursive: true });
    const wrong = join(t.assetDir, other.slice(0, 2), `${other}-sound-full-v1.webp`);
    await writeFile(wrong, Buffer.alloc(10));
    const imageAsMp3 = join(t.assetDir, other.slice(0, 2), `${other}-map-full-v1.mp3`);
    await writeFile(imageAsMp3, Buffer.alloc(10));
    assert.ok((await sweepOrphanFiles(t.pool, t.assetDir, Date.now() + 3 * 24 * 3600_000)) >= 1);
    assert.equal(await exists(path), false);
    assert.equal(await exists(wrong), true);
    assert.equal(await exists(imageAsMp3), true);
  });
});

describe("the sound check off the main thread (D-261102-539)", () => {
  test("while a check hangs, the server keeps answering, and the upload ends busy at the deadline with nothing stored", async () => {
    const t = await startEngine({ env: { ROOM_SOUND: "1" }, assets: { soundCheck: { workerUrl: HANG, deadlineMs: 1_500 } } });
    try {
      // The DM and a player at one table, behind one address.
      const dm = t.client("2001:db8:5:5::5");
      const { roomId } = await dm.createRoom();
      const player = t.client("2001:db8:5:5::5");
      await player.join(roomId);
      const started = performance.now();
      const pending = upload(dm, roomId, sound());
      // Let the upload reach its worker, then ask the server something else.
      await new Promise((r) => setTimeout(r, 200));
      const asked = performance.now();
      const health = await t.app.inject({ method: "GET", url: "/healthz" });
      assert.equal(health.statusCode, 200);
      assert.ok(performance.now() - asked < 500, `healthz took ${performance.now() - asked} ms`);
      // A sound's slot is counted by session, so the player's token goes up beside it from the same address.
      const token = await player.request("PUT", `/api/rooms/${roomId}/assets?kind=token`, undefined, { "content-type": "image/png" }, await solid(64, 64).png().toBuffer());
      assert.equal(token.statusCode, 200, token.body);
      const res = await pending;
      assert.equal(res.statusCode, 503, res.body);
      assert.deepEqual(res.json(), { error: "busy" });
      assert.ok(performance.now() - started >= 1_400);
      assert.equal((await t.pool.query("select 1 from assets where room_id = $1 and kind = 'sound'", [roomId])).rowCount, 0);
      assert.deepEqual(await readdir(join(t.assetDir, "tmp")), []);
    } finally {
      await t.close();
    }
  });
});

describe("sound files with the switch off (D-261102-513)", () => {
  let off: Engine;
  let on: Engine;
  before(async () => {
    off = await startEngine();
    on = await startEngine({ env: { ROOM_SOUND: "1" } });
  });
  after(async () => {
    await off.close();
    await on.close();
  });

  test("an import skips every sound unread but keeps Only DM devices play, and a backup made here leaves the room's sounds out", async () => {
    const dm = on.client();
    const { roomId } = await dm.createRoom();
    const bytes = sound(3_000, 61);
    await uploaded(dm, roomId, bytes);
    const zip = (await dm.get(`/api/rooms/${roomId}/export`)).rawPayload;
    assert.ok((await unzip(zip)).has(`assets/${sha(bytes)}-sound-full.mp3`));
    const into = await imported(off, zip);
    assert.equal((await off.pool.query("select 1 from assets where room_id = $1 and kind = 'sound'", [into.roomId])).rowCount, 0);
    assert.equal("soundDmOnly" in (await storedState(off, into.roomId)).meta.settings, false, "a room without it imports without it");
    await dmOnly(on, dm, roomId);
    const kept = await imported(off, (await dm.get(`/api/rooms/${roomId}/export`)).rawPayload);
    assert.equal((await storedState(off, kept.roomId)).meta.settings.soundDmOnly, true, "Only DM devices play survives the import here (docs/design/design-v1-sound-dm-only.md 7)");
    // Unread, not read and then refused: nothing is skipped as a refused file.
    const zipPath = join(off.assetDir, "import", `${randomUUID()}.zip`);
    await mkdir(join(off.assetDir, "import"), { recursive: true });
    await writeFile(zipPath, zip);
    const warned: string[] = [];
    const log = {
      info: () => undefined,
      debug: () => undefined,
      error: console.error,
      warn: (...args: unknown[]) => void warned.push(JSON.stringify(args)),
    } as unknown as Logger;
    const direct = await importRoom({ pool: off.pool, assets: off.app.assets, gateway: off.app.gateway, log }, zipPath, { playerPwHash: "x", dmName: "Importer", dmColor: "#3e8ef7", createdIp: null });
    off.track(direct.roomId);
    assert.deepEqual(warned, []);

    // A room that holds a sound from when the switch was on: the server serves no sound bytes, its backups included.
    const offDm = off.client();
    const held = await offDm.createRoom();
    await off.pool.query(`insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants, media, audio) values ($1, $2, $3, 'sound', 1, 0, 0, $4, '{full}', 'mp3', $5)`, [
      randomUUID(),
      held.roomId,
      Buffer.from(sha(bytes), "hex"),
      bytes.length,
      JSON.stringify({ ms: 3000, channels: 2, kbps: 128 }),
    ]);
    await mkdir(join(off.assetDir, sha(bytes).slice(0, 2)), { recursive: true });
    await writeFile(variantPath(off.assetDir, sha(bytes), "sound", "full", SOUND_PIPELINE, "mp3"), bytes);
    const files = await unzip((await offDm.get(`/api/rooms/${held.roomId}/export`)).rawPayload);
    assert.equal([...files.keys()].some((n) => n.endsWith(".mp3")), false);
    assert.deepEqual((JSON.parse(files.get("assets.json")!.toString()) as ExportManifest).assets, []);
  });

  test("an upload is sound_off before a byte is read, and nothing is stored", async () => {
    const dm = off.client();
    const { roomId } = await dm.createRoom();
    const res = await upload(dm, roomId, sound());
    assert.equal(res.statusCode, 403, res.body);
    assert.deepEqual(res.json(), { error: "sound_off" });
    assert.equal(res.headers.connection, "close");
    assert.equal((await off.pool.query("select 1 from assets where room_id = $1", [roomId])).rowCount, 0);
  });

  test("the service refuses a sound on its own, so no import or command stores one either", async () => {
    const dm = off.client();
    const { roomId } = await dm.createRoom();
    const bytes = sound();
    const path = join(off.assetDir, "tmp", `intake-${randomUUID()}`);
    await writeFile(path, bytes);
    const reservation = await off.app.assets.quota.reserve(roomId, bytes.length);
    try {
      await assert.rejects(
        off.app.assets.ingest({ roomId, uploaderIds: [], kind: "sound", tempPath: path, sha256: Buffer.from(sha(bytes), "hex"), reservation }),
        (err: unknown) => (err as { code?: string }).code === "sound_off",
      );
    } finally {
      reservation.release();
    }
    assert.equal((await off.pool.query("select 1 from assets where room_id = $1", [roomId])).rowCount, 0);
  });

  test("a sound the room already holds answers 404 to everyone, its DM too, by ranges or whole", async () => {
    const dm = off.client();
    const { roomId } = await dm.createRoom();
    const bytes = sound();
    const id = randomUUID();
    await off.pool.query(`insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants, media, audio) values ($1, $2, $3, 'sound', $4, 0, 0, $5, '{full}', 'mp3', $6)`, [
      id,
      roomId,
      Buffer.from(sha(bytes), "hex"),
      SOUND_PIPELINE,
      bytes.length,
      JSON.stringify({ ms: 3000, channels: 2, kbps: 128 }),
    ]);
    const path = variantPath(off.assetDir, sha(bytes), "sound", "full", SOUND_PIPELINE, "mp3");
    await mkdir(join(off.assetDir, sha(bytes).slice(0, 2)), { recursive: true });
    await writeFile(path, bytes);
    assert.equal((await read(dm, id)).statusCode, 404);
    assert.equal((await read(dm, id, { range: "bytes=0-9" })).statusCode, 404);
  });
});
