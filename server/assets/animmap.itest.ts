import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import yauzl from "yauzl";
import { VIDEO_LIMITS } from "#shared/limits.ts";
import type { MapVideo, RoomState, VideoFacts } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import type { ExportManifest } from "../rooms/exportRoom.ts";
import { importRoom } from "../rooms/importRoom.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "../rooms/testing.ts";
import { VIDEO_PIPELINE } from "./kinds.ts";
import { sweepOrphanFiles } from "./cleanup.ts";
import { roomStoredBytes } from "./quota.ts";
import { variantPath } from "./store.ts";
import { solid } from "./testImages.ts";
import { SECRETS, appleLocationMeta, bx, defaultSoundTrack, defaultVideoTrack, encodeWebm, locationUdta, mp4File, mp4WithSecretsFrom, webmFile, webmWithSecrets, webmWithSecretsFrom } from "./video/videoTestutil.ts";

/**
 * Animated maps on the server (docs/design/design-v1-animated-maps.md 12,
 * Integration): the switch on and off, uploads by session slot, serving by
 * ranges to the DM, players and a table display, players' 404s, the quota
 * and its headroom for live uploads only, deletion, the backup round trip
 * and the refill, and zeroed metadata in the served bytes.
 */

const MiB = 1024 * 1024;
const FIXTURES = new URL("../../e2e/fixtures/", import.meta.url);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Uploaded = { id: string; kind: string; width: number; height: number; variants: string[]; video?: VideoFacts; created?: boolean };

function upload(client: TestClient, roomId: string, body: Buffer, opts: { type?: string; kind?: string; name?: string } = {}) {
  const query = `kind=${opts.kind ?? "video"}${opts.name ? `&name=${encodeURIComponent(opts.name)}` : ""}`;
  return client.request("PUT", `/api/rooms/${roomId}/assets?${query}`, undefined, { "content-type": opts.type ?? "video/webm" }, body);
}

async function uploaded(client: TestClient, roomId: string, body: Buffer, opts: { type?: string; kind?: string; name?: string } = {}): Promise<Uploaded> {
  const res = await upload(client, roomId, body, opts);
  assert.equal(res.statusCode, 200, res.body);
  return res.json<Uploaded>();
}

const read = (client: TestClient, id: string, headers: Record<string, string> = {}) => client.request("GET", `/api/assets/${id}/full`, undefined, headers);

/** A placeholder the server overwrites from the row, as the client sends it. */
const sent = (assetId: string): MapVideo => ({ assetId, widthPx: 640, heightPx: 360, container: "mp4", video: "vp8", fps: 1, durationMs: 1_000, kbps: 1 });

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** A room with a DM socket, a 640 x 360 still and its scene, ready for a video map. */
async function roomWithStill(t: Engine): Promise<{ dm: TestClient; roomId: string; socket: Socket; sceneId: string; still: Uploaded }> {
  const dm = t.client();
  const { roomId } = await dm.createRoom("Animated");
  const still = await uploaded(dm, roomId, await solid(640, 360, "#264").png().toBuffer(), { kind: "map", type: "image/png" });
  const socket = await t.connect(roomId, dm);
  const sceneId = ((await socket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
  return { dm, roomId, socket, sceneId, still };
}

async function setMap(socket: Socket, sceneId: string, stillId: string, videoId?: string): Promise<void> {
  const ev = await socket.apply({ t: "scene.setMap", sceneId, map: { assetId: stillId, widthPx: 640, heightPx: 360, cellPx: 40, originPx: { x: 0, y: 0 }, ...(videoId ? { video: sent(videoId) } : {}) } });
  assert.deepEqual(ev.rejects ?? [], []);
}

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

async function storedState(t: Engine, roomId: string): Promise<RoomState> {
  const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
  return rows[0]!.state;
}

const quietLog = { info: () => undefined, debug: () => undefined, warn: () => undefined, error: console.error };

describe("animated maps with the switch on", () => {
  let t: Engine;
  let scratch: string;
  before(async () => {
    t = await startEngine({ env: { ANIMATED_MAPS: "1" } });
    scratch = await mkdtemp(join(tmpdir(), "rvtt-animmap-"));
  });
  after(async () => {
    await t.close();
    await rm(scratch, { recursive: true, force: true });
  });

  test("a DM's WebM upload stores one zeroed file under its real extension, and answers its facts and created", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const bytes = encodeWebm(webmWithSecrets());
    const first = await uploaded(dm, roomId, bytes, { name: "crypt_16x9.webm" });
    assert.equal(first.kind, "video");
    assert.deepEqual(first.variants, ["full"]);
    assert.deepEqual(first.video, { widthPx: 640, heightPx: 360, container: "webm", video: "vp09.00.21.08", fps: 30, durationMs: 2001, kbps: Math.round((bytes.length * 8) / 2001) });
    assert.equal(first.created, true);
    const { rows } = await t.pool.query<{ media: string; video: unknown; pipeline: number; bytes: string }>("select media, video, pipeline, bytes from assets where id = $1", [first.id]);
    assert.equal(rows[0]!.media, "webm");
    assert.deepEqual(rows[0]!.video, { video: "vp09.00.21.08", fps: 30, durationMs: 2001, kbps: first.video!.kbps });
    assert.equal(Number(rows[0]!.bytes), bytes.length);
    assert.equal(rows[0]!.pipeline, VIDEO_PIPELINE);
    const file = await readFile(variantPath(t.assetDir, sha(bytes), "video", "full", VIDEO_PIPELINE, "webm"));
    assert.equal(file.length, bytes.length, "zeroed in place, at the same length");
    for (const secret of [SECRETS.title, SECRETS.tag, SECRETS.void, SECRETS.name, SECRETS.chapter]) assert.equal(file.includes(secret), false, secret);
    // The same bytes again reuse the row, and say this upload made none.
    const again = await uploaded(dm, roomId, bytes);
    assert.equal(again.id, first.id);
    assert.equal(again.created, false);
    assert.deepEqual(await readdir(join(t.assetDir, "tmp")), []);
  });

  test("an MP4 the same way, served as video/mp4 with the image headers, a strong ETag and no identifying text", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const bytes = mp4File({ tracks: [defaultVideoTrack(), defaultSoundTrack()], inMoov: [locationUdta(), appleLocationMeta()], beforeMoov: [bx("free", Buffer.from(SECRETS.free))] });
    const video = await uploaded(dm, roomId, bytes, { type: "video/mp4" });
    assert.equal(video.video?.container, "mp4");
    assert.equal(video.video?.audio, "mp4a.40.2");
    const res = await read(dm, video.id);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "video/mp4");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.equal(res.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(res.headers["cache-control"], "private, max-age=31536000, immutable");
    assert.equal(res.headers["accept-ranges"], "bytes");
    assert.equal(res.headers.etag, `"${sha(bytes)}-v${VIDEO_PIPELINE}"`);
    assert.equal(res.rawPayload.length, bytes.length);
    for (const secret of [SECRETS.location, SECRETS.free, "com.apple.quicktime.location.ISO6709"]) assert.equal(res.rawPayload.includes(secret), false, secret);
    assert.ok(bytes.includes(SECRETS.location));
  });

  test("the e2e fixtures, rebuilt with a phone's location and an editor's text, are stored and served with none of it", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    for (const [file, type, rebuild] of [["map-loop.webm", "video/webm", webmWithSecretsFrom], ["map-loop.mp4", "video/mp4", mp4WithSecretsFrom]] as const) {
      const plain = await readFile(new URL(file, FIXTURES));
      const plainFacts = (await uploaded(dm, roomId, plain, { type })).video!;
      assert.deepEqual({ w: plainFacts.widthPx, h: plainFacts.heightPx, fps: plainFacts.fps, ms: plainFacts.durationMs }, { w: 640, h: 360, fps: 30, ms: 2000 }, file);
      const bytes = rebuild(plain);
      const secrets = Object.values(SECRETS).filter((x) => bytes.includes(x));
      assert.ok(secrets.length >= 4, `${file} carries ${secrets.length} secrets`);
      const video = await uploaded(dm, roomId, bytes, { type });
      const served = (await read(dm, video.id)).rawPayload;
      assert.equal(served.length, bytes.length);
      for (const secret of secrets) assert.equal(served.includes(secret), false, `${file}: ${secret}`);
    }
  });

  test("the upload pairs video types with the video kind, before a byte is read", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const webm = webmFile();
    for (const [type, kind] of [["video/webm", "map"], ["image/png", "video"], ["video/mp4", "token"]] as const) {
      const res = await upload(dm, roomId, webm, { type, kind });
      assert.equal(res.statusCode, 415, `${type} as ${kind}: ${res.body}`);
      assert.deepEqual(res.json(), { error: "unsupported_type" });
      assert.equal(res.headers.connection, "close", "the body is never read");
    }
    // A type the route has no parser for, MOV here, is Fastify's 415 before the handler runs.
    const mov = await upload(dm, roomId, webm, { type: "video/quicktime" });
    assert.equal(mov.statusCode, 415, mov.body);
    assert.deepEqual(mov.json(), { error: "unsupported_type" });
    // A player may not add one at all.
    const player = t.client();
    await player.join(roomId);
    assert.equal((await upload(player, roomId, webm)).statusCode, 403);
    assert.equal((await t.pool.query("select 1 from assets where room_id = $1 and kind = 'video'", [roomId])).rowCount, 0);
  });

  test("a refused video answers its 4.5 code and stores nothing", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const cases: Array<[Buffer, string, number, string]> = [
      [webmFile({ durationMs: null }), "video/webm", 422, "video_unfinished"],
      [mp4File({ brand: "qt  " }), "video/mp4", 415, "video_type"],
      [webmFile({ width: 4097, height: 2000 }), "video/webm", 422, "video_size"],
      [Buffer.from("not a video at all"), "video/webm", 415, "video_type"],
    ];
    for (const [bytes, type, status, code] of cases) {
      const res = await upload(dm, roomId, bytes, { type });
      assert.equal(res.statusCode, status, res.body);
      assert.deepEqual(res.json(), { error: code });
    }
    assert.equal((await t.pool.query("select 1 from assets where room_id = $1", [roomId])).rowCount, 0);
    assert.deepEqual(await readdir(join(t.assetDir, "tmp")), []);
  });

  test("ranges: one range is 206, past the end 416, several ranges the whole file, and If-Range by the ETag", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const bytes = webmFile({ frameBytes: 2000 });
    const video = await uploaded(dm, roomId, bytes);
    const whole = (await read(dm, video.id)).rawPayload;
    const size = whole.length;
    const part = await read(dm, video.id, { range: "bytes=100-199" });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers["content-range"], `bytes 100-199/${size}`);
    assert.equal(part.headers["content-length"], "100");
    assert.ok(part.rawPayload.equals(whole.subarray(100, 200)));
    const open = await read(dm, video.id, { range: `bytes=${size - 10}-` });
    assert.equal(open.statusCode, 206);
    assert.ok(open.rawPayload.equals(whole.subarray(size - 10)));
    const suffix = await read(dm, video.id, { range: "bytes=-5" });
    assert.equal(suffix.headers["content-range"], `bytes ${size - 5}-${size - 1}/${size}`);
    const past = await read(dm, video.id, { range: `bytes=${size}-` });
    assert.equal(past.statusCode, 416);
    assert.equal(past.headers["content-range"], `bytes */${size}`);
    const several = await read(dm, video.id, { range: "bytes=0-9,20-29" });
    assert.equal(several.statusCode, 200);
    assert.equal(several.rawPayload.length, size);
    const etag = part.headers.etag as string;
    assert.equal((await read(dm, video.id, { range: "bytes=0-9", "if-range": etag })).statusCode, 206);
    const stale = await read(dm, video.id, { range: "bytes=0-9", "if-range": '"another"' });
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.rawPayload.length, size);
    // A HEAD answers the length and the range support, for players that probe first.
    const head = await dm.request("HEAD", `/api/assets/${video.id}/full`);
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers["content-length"], String(size));
  });

  test("players and a table display read only the showing video, each range request checked again as ops land", async () => {
    const { dm, roomId, socket, sceneId, still } = await roomWithStill(t);
    const shown = await uploaded(dm, roomId, webmFile({ frameBytes: 400 }));
    const other = await uploaded(dm, roomId, webmFile({ frameBytes: 401 }));
    await setMap(socket, sceneId, still.id, shown.id);
    const player = t.client();
    await player.join(roomId);
    const playerSocket = await t.connect(roomId, player);
    await playerSocket.snapshot("p");
    assert.equal((await read(player, shown.id, { range: "bytes=0-99" })).statusCode, 206);
    assert.equal((await read(player, other.id)).statusCode, 404, "a video the players' scene does not show");
    assert.equal((await read(player, other.id, { range: "bytes=0-99" })).statusCode, 404);
    const minted = await dm.post(`/api/rooms/${roomId}/display/code`);
    const tv = t.client();
    assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(minted.json<{ code: string }>().code) })).statusCode, 200);
    const tvRead = (id: string, range = "bytes=0-99") => tv.request("GET", `/api/rooms/${roomId}/display/assets/${id}/full`, undefined, { range });
    assert.equal((await tvRead(shown.id)).statusCode, 206);
    assert.equal((await tvRead(other.id)).statusCode, 404);
    // 64 range requests with the map's video switched between every eight: each answer follows the op before it.
    let showing = shown.id;
    for (let i = 0; i < 64; i++) {
      if (i % 8 === 7) {
        showing = showing === shown.id ? other.id : shown.id;
        await setMap(socket, sceneId, still.id, showing);
      }
      const hidden = showing === shown.id ? other.id : shown.id;
      const range = `bytes=${i * 10}-${i * 10 + 9}`;
      assert.equal((await read(player, showing, { range })).statusCode, 206, `request ${i}`);
      assert.equal((await read(player, hidden, { range })).statusCode, 404, `request ${i}`);
    }
    // Use the still only: the video leaves the players' set at once.
    await setMap(socket, sceneId, still.id);
    assert.equal((await read(player, showing, { range: "bytes=0-9" })).statusCode, 404);
    assert.equal((await tvRead(showing)).statusCode, 404);
    assert.equal((await read(player, still.id)).statusCode, 200);
  });

  test("a live upload must leave 32 MiB of the quota free, and a delete frees it, its file to the trash as .webm", async () => {
    const small = await startEngine({ env: { ANIMATED_MAPS: "1", ROOM_QUOTA_MB: "40" } });
    try {
      const { dm, roomId, socket, sceneId, still } = await roomWithStill(small);
      const bytes = webmFile({ frameBytes: 1000 });
      const video = await uploaded(dm, roomId, bytes);
      // Fill the room until a video of this size would leave a byte under 32 MiB free.
      const stored = await roomStoredBytes(small.pool, roomId);
      const filler = 40 * MiB - stored - VIDEO_LIMITS.quotaHeadroomBytes - bytes.length + 1;
      await small.pool.query(`insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants) values ($1, $2, $3, 'map', 1, 1, 1, $4, '{full}')`, [randomUUID(), roomId, Buffer.alloc(32, 9), filler]);
      const refused = await upload(dm, roomId, webmFile({ frameBytes: 1001 }));
      assert.equal(refused.statusCode, 413, refused.body);
      assert.deepEqual(refused.json(), { error: "quota_exceeded" });
      // An image needs only the quota.
      assert.equal((await upload(dm, roomId, await solid(64, 64).png().toBuffer(), { kind: "token", type: "image/png" })).statusCode, 200);

      // In use, the delete is refused. Once the map is a still, it goes, freeing its bytes.
      await setMap(socket, sceneId, still.id, video.id);
      const inUse = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [video.id] });
      assert.equal(inUse.statusCode, 409, inUse.body);
      await setMap(socket, sceneId, still.id);
      const before = await roomStoredBytes(small.pool, roomId);
      const gone = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [video.id] });
      assert.equal(gone.statusCode, 200, gone.body);
      assert.equal(before - (await roomStoredBytes(small.pool, roomId)), bytes.length);
      assert.equal(await exists(variantPath(small.assetDir, sha(bytes), "video", "full", VIDEO_PIPELINE, "webm")), false);
      const day = new Date().toISOString().slice(0, 10);
      assert.ok(await exists(join(small.assetDir, "trash", day, sha(bytes).slice(0, 2), `${sha(bytes)}-video-full-v${VIDEO_PIPELINE}.webm`)));
    } finally {
      await small.close();
    }
  });

  test("the orphan sweep takes a video file no row names", async () => {
    const hex = sha(Buffer.from(randomUUID()));
    const path = variantPath(t.assetDir, hex, "video", "full", VIDEO_PIPELINE, "mp4");
    await mkdir(join(t.assetDir, hex.slice(0, 2)), { recursive: true });
    await writeFile(path, Buffer.alloc(100));
    // A video's name with an image's extension is no file this server made, so it stays.
    const wrong = join(t.assetDir, hex.slice(0, 2), `${hex}-video-full-v1.webp`);
    await writeFile(wrong, Buffer.alloc(10));
    const moved = await sweepOrphanFiles(t.pool, t.assetDir, Date.now() + 3 * 24 * 3600_000);
    assert.ok(moved >= 1);
    assert.equal(await exists(path), false);
    assert.equal(await exists(wrong), true);
    await rm(wrong);
  });

  test("the backup round trip: the export names the video by its container, and the import checks it again and refills the map", async () => {
    const { dm, roomId, socket, sceneId, still } = await roomWithStill(t);
    const bytes = encodeWebm(webmWithSecrets({ sound: { blocks: Array.from({ length: 100 }, (_, i) => ({ ms: i * 20 })) } }));
    const video = await uploaded(dm, roomId, bytes);
    await setMap(socket, sceneId, still.id, video.id);
    const exported = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(exported.statusCode, 200, exported.body);
    const files = await unzip(exported.rawPayload);
    const manifest = JSON.parse(files.get("assets.json")!.toString()) as ExportManifest;
    const entry = manifest.assets.find((a) => a.kind === "video");
    assert.deepEqual({ media: entry?.media, sha256: entry?.sha256 }, { media: "webm", sha256: sha(bytes) });
    const stored = files.get(`assets/${sha(bytes)}-video-full.webm`);
    assert.ok(stored, "the video's entry");
    assert.equal(stored.includes(SECRETS.title), false);

    const importer = t.client();
    const form = Buffer.from(JSON.stringify({ playerPassword: "owlbear-druid-wand", dmName: "Importer" })).toString("base64url");
    const imported = await importer.request("POST", "/api/rooms/import", undefined, { "content-type": "application/zip", "x-import-form": form }, exported.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const newRoom = imported.json<{ roomId: string }>().roomId;
    t.track(newRoom);
    const { rows } = await t.pool.query<{ id: string; media: string; video: unknown }>("select id, media, video from assets where room_id = $1 and kind = 'video'", [newRoom]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.media, "webm");
    const state = await storedState(t, newRoom);
    const map = Object.values(state.scenes).find((s) => s.map?.video)?.map;
    assert.equal(map?.video?.assetId, rows[0]!.id, "the map names the new row");
    assert.deepEqual(map?.video, { assetId: rows[0]!.id, ...video.video! });
  });

  test("an import's video reserves its entry's size, not the kind's cap, and no headroom (AM-ASTRA-22)", async () => {
    // A room 976 MiB full of its 1 GiB, with a 1 MiB video last: a 64 MiB reservation would refuse it.
    const { dm, roomId, socket, sceneId, still } = await roomWithStill(t);
    const bytes = webmFile({ frameBytes: 18_000 });
    assert.ok(bytes.length > MiB && bytes.length < 1.2 * MiB);
    const video = await uploaded(dm, roomId, bytes);
    await setMap(socket, sceneId, still.id, video.id);
    const zipPath = join(scratch, "room.zip");
    await writeFile(zipPath, (await dm.get(`/api/rooms/${roomId}/export`)).rawPayload);
    const fill = (bytesFull: number) => async (tx: { query: (sql: string, values: unknown[]) => Promise<unknown> }, newRoom: string) => {
      t.track(newRoom);
      await tx.query(`insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants) values ($1, $2, $3, 'map', 1, 1, 1, $4, '{full}')`, [randomUUID(), newRoom, Buffer.alloc(32, 7), bytesFull]);
    };
    const deps = { pool: t.pool, assets: t.app.assets, gateway: t.app.gateway, log: quietLog };
    const form = { playerPwHash: "x", dmName: "Importer", dmColor: "#3e8ef7", createdIp: null };
    const full = await importRoom(deps, zipPath, form, { beforeImages: fill(976 * MiB) });
    assert.equal((await t.pool.query("select 1 from assets where room_id = $1 and kind = 'video'", [full.roomId])).rowCount, 1);
    // At its quota less 10 MiB, an import passes where a live upload, which keeps 32 MiB free, would not.
    const near = await importRoom(deps, zipPath, form, { beforeImages: fill(1024 * MiB - 10 * MiB) });
    assert.equal((await t.pool.query("select 1 from assets where room_id = $1 and kind = 'video'", [near.roomId])).rowCount, 1);
    await t.pool.query(`insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants) values ($1, $2, $3, 'map', 1, 1, 1, $4, '{full}')`, [
      randomUUID(),
      roomId,
      Buffer.alloc(32, 8),
      1024 * MiB - 10 * MiB - (await roomStoredBytes(t.pool, roomId)),
    ]);
    const live = await upload(dm, roomId, webmFile({ frameBytes: 18_001 }));
    assert.equal(live.statusCode, 413, live.body);
    assert.deepEqual(live.json(), { error: "quota_exceeded" });
  });

  test("an import skips a video entry that fails the check, and its map keeps the still", async () => {
    const { dm, roomId, socket, sceneId, still } = await roomWithStill(t);
    const bytes = webmFile({ frameBytes: 300 });
    const video = await uploaded(dm, roomId, bytes);
    await setMap(socket, sceneId, still.id, video.id);
    const files = await unzip((await dm.get(`/api/rooms/${roomId}/export`)).rawPayload);
    // The entry swapped for a file the check refuses.
    files.set(`assets/${sha(bytes)}-video-full.webm`, webmFile({ durationMs: null }));
    const yazl = (await import("yazl")).default;
    const zip = new yazl.ZipFile();
    for (const [name, data] of files) zip.addBuffer(data, name);
    zip.end();
    const chunks: Buffer[] = [];
    for await (const c of zip.outputStream as AsyncIterable<Buffer>) chunks.push(c);
    const zipPath = join(scratch, "tampered.zip");
    await writeFile(zipPath, Buffer.concat(chunks));
    const room = await importRoom({ pool: t.pool, assets: t.app.assets, gateway: t.app.gateway, log: quietLog }, zipPath, { playerPwHash: "x", dmName: "Importer", dmColor: "#3e8ef7", createdIp: null });
    t.track(room.roomId);
    assert.equal((await t.pool.query("select 1 from assets where room_id = $1 and kind = 'video'", [room.roomId])).rowCount, 0);
    const scene = Object.values((await storedState(t, room.roomId)).scenes).find((s) => s.map);
    assert.ok(scene?.map, "the map came through as its still");
    assert.equal(scene.map.video, undefined);
  });
});

describe("animated maps with the switch off (D-261102-510)", () => {
  let off: Engine;
  let on: Engine;
  before(async () => {
    off = await startEngine();
    on = await startEngine({ env: { ANIMATED_MAPS: "1" } });
  });
  after(async () => {
    await off.close();
    await on.close();
  });

  test("an upload is video_off before a byte is read, and nothing is stored", async () => {
    const dm = off.client();
    const { roomId } = await dm.createRoom();
    const res = await upload(dm, roomId, webmFile());
    assert.equal(res.statusCode, 403, res.body);
    assert.deepEqual(res.json(), { error: "video_off" });
    assert.equal(res.headers.connection, "close");
    assert.equal((await off.pool.query("select 1 from assets where room_id = $1", [roomId])).rowCount, 0);
  });

  test("a video the room already holds answers 404 to everyone, and its map shows its still", async () => {
    const dm = off.client();
    const { roomId } = await dm.createRoom();
    const bytes = webmFile();
    const id = randomUUID();
    await off.pool.query(
      `insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants, media, video) values ($1, $2, $3, 'video', $4, 640, 360, $5, '{full}', 'webm', $6)`,
      [id, roomId, Buffer.from(sha(bytes), "hex"), VIDEO_PIPELINE, bytes.length, JSON.stringify({ video: "vp09.00.21.08", fps: 30, durationMs: 2001, kbps: 11 })],
    );
    const path = variantPath(off.assetDir, sha(bytes), "video", "full", VIDEO_PIPELINE, "webm");
    await mkdir(join(off.assetDir, sha(bytes).slice(0, 2)), { recursive: true });
    await writeFile(path, bytes);
    assert.equal((await read(dm, id)).statusCode, 404);
    assert.equal((await read(dm, id, { range: "bytes=0-9" })).statusCode, 404);
  });

  test("an import keeps every map's still and skips its videos unread", async () => {
    const { dm, roomId, socket, sceneId, still } = await roomWithStill(on);
    const video = await uploaded(dm, roomId, webmFile());
    await setMap(socket, sceneId, still.id, video.id);
    const zip = (await dm.get(`/api/rooms/${roomId}/export`)).rawPayload;
    const importer = off.client();
    const form = Buffer.from(JSON.stringify({ playerPassword: "owlbear-druid-wand", dmName: "Importer" })).toString("base64url");
    const imported = await importer.request("POST", "/api/rooms/import", undefined, { "content-type": "application/zip", "x-import-form": form }, zip);
    assert.equal(imported.statusCode, 201, imported.body);
    const newRoom = imported.json<{ roomId: string }>().roomId;
    off.track(newRoom);
    assert.equal((await off.pool.query("select 1 from assets where room_id = $1 and kind = 'video'", [newRoom])).rowCount, 0);
    const scene = Object.values((await storedState(off, newRoom)).scenes).find((s) => s.map);
    assert.ok(scene?.map);
    assert.equal(scene.map.video, undefined);
  });
});
