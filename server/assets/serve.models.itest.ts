import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import yauzl from "yauzl";
import yazl from "yazl";
import { uuidv7 } from "#shared/ids.ts";
import type { ImageRef, ModelRef, RoomState } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import { customMonster } from "#shared/testutil.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import type { ExportManifest } from "../rooms/exportRoom.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "../rooms/testing.ts";
import { solid } from "./testImages.ts";

/**
 * 3D model sheets on the server (docs/design/design-v1-token-models.md 4.3
 * to 4.6, 10): the `model` kind's upload and its shape check, the asset
 * route's twin (a player's or a table display's read of a sheet their copy
 * does not name answers exactly as an unknown id does), the kind checks on
 * the ops, the backup round trip with the sheet checked again on import,
 * and the database step that adds the kind.
 */

const actor = {
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
};

const BOXES: ModelRef["boxes"] = Array.from({ length: 8 }, (_, i) => [20 + i, 10, 80 - i, 95]);
const model = (assetId: string): ModelRef => ({ assetId, side: 1.4, anchorY: 0.82, boxes: BOXES.map((b) => [...b]) });
const wearing = (picture: string, sheet: string): ImageRef => ({ assetId: picture, crop: { cx: 0, cy: 0, zoom: 1 }, model: model(sheet) });

/** A clear sheet of 8 frames, each with a figure of its own color, so two sheets made with other seeds are other bytes. */
async function sheetPng(width = 2048, seed = 0, height = width / 2): Promise<Buffer> {
  const frame = width / 4;
  const figures = Array.from({ length: 8 }, (_, i) => ({
    input: { create: { width: frame / 2, height: frame / 2, channels: 4 as const, background: { r: (seed * 37 + i * 20) % 256, g: 120, b: 200, alpha: 1 } } },
    left: (i % 4) * frame + frame / 4,
    top: Math.floor(i / 4) * frame + frame / 4,
  }));
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(height === width / 2 ? figures : [])
    .png()
    .toBuffer();
}

type Uploaded = { id: string; kind: string; width: number; height: number; variants: string[] };

function upload(client: TestClient, roomId: string, kind: string, body: Buffer) {
  return client.request("PUT", `/api/rooms/${roomId}/assets?kind=${kind}`, undefined, { "content-type": "image/png" }, body);
}

async function uploaded(client: TestClient, roomId: string, kind: string, body: Buffer): Promise<Uploaded> {
  const res = await upload(client, roomId, kind, body);
  assert.equal(res.statusCode, 200, res.body);
  return res.json<Uploaded>();
}

/** A read as the asset route answers it: the status, the body and the type, all a refusal can tell apart. */
async function read(client: TestClient, id: string, variant = "full"): Promise<{ status: number; body: string; type: string | undefined }> {
  const res = await client.request("GET", `/api/assets/${id}/${variant}`);
  return { status: res.statusCode, body: res.statusCode === 200 ? "(image)" : res.body, type: res.headers["content-type"]?.toString() };
}

async function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await yauzl.fromBufferPromise(buffer);
  const out = new Map<string, Buffer>();
  for await (const entry of zip.eachEntry()) {
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
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

async function storedState(t: Engine, roomId: string): Promise<RoomState> {
  const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
  return rows[0]!.state;
}

/** A room with a DM socket, a player socket and the players' scene. */
async function table(t: Engine): Promise<{ dm: TestClient; player: TestClient; playerId: string; roomId: string; dmSocket: Socket; playerSocket: Socket; sceneId: string }> {
  const dm = t.client();
  const { roomId } = await dm.createRoom("Models");
  const player = t.client();
  const playerId = await player.join(roomId, "Pip");
  const dmSocket = await t.connect(roomId, dm);
  const sceneId = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
  const playerSocket = await t.connect(roomId, player);
  await playerSocket.snapshot("p");
  return { dm, player, playerId, roomId, dmSocket, playerSocket, sceneId };
}

async function applied(socket: Socket, op: Record<string, unknown>): Promise<void> {
  const ev = await socket.apply(op);
  assert.deepEqual(ev.rejects ?? [], [], JSON.stringify(op.t));
}

function tokenOp(sceneId: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { t: "token.create", token: { id: uuidv7(), sceneId, kind: "monster", name: "Lurker", size: "medium", x: 2, y: 2, actor: { inline: actor }, ...fields } };
}

describe("3D model sheets on the server", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a DM's and a player's sheet is a model row of full, mobile and thumb copies, each a WebP with its alpha", async () => {
    const { dm, player, roomId } = await table(t);
    const mine = await uploaded(dm, roomId, "model", await sheetPng(2048, 1));
    assert.deepEqual({ kind: mine.kind, width: mine.width, height: mine.height, variants: mine.variants }, { kind: "model", width: 2048, height: 1024, variants: ["full", "mobile", "thumb"] });
    const theirs = await uploaded(player, roomId, "model", await sheetPng(1024, 2));
    assert.deepEqual([theirs.kind, theirs.width, theirs.height], ["model", 1024, 512]);
    const { rows } = await t.pool.query<{ kind: string; media: string | null; variants: string[] }>("select kind, media, variants from assets where id = $1", [mine.id]);
    assert.deepEqual(rows, [{ kind: "model", media: null, variants: ["full", "mobile", "thumb"] }]);
    // The uploader reads their own sheet, as a WebP with its clear ground.
    const res = await dm.request("GET", `/api/assets/${mine.id}/mobile`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/webp");
    // The server blocks sharp's buffer loaders, so the answer is read back from a file, as the pipeline reads.
    const scratch = await mkdtemp(join(tmpdir(), "rvtt-models-"));
    const served = join(scratch, "served.webp");
    await writeFile(served, res.rawPayload);
    const meta = await sharp(served).metadata();
    await rm(scratch, { recursive: true, force: true });
    assert.deepEqual([meta.width, meta.height, meta.hasAlpha], [1024, 512, true]);
    assert.equal((await player.request("GET", `/api/assets/${theirs.id}/full`)).statusCode, 200, "a player's own upload");
  });

  test("a sheet of another shape is 422 bad_model_sheet and stores nothing, and a picture of that shape is still a token", async () => {
    const { dm, player, roomId } = await table(t);
    for (const [client, png] of [
      [dm, await sheetPng(2000, 0, 1000)],
      [player, await sheetPng(1536, 0, 512)],
      [dm, await solid(2048, 2048).png().toBuffer()],
    ] as const) {
      const res = await upload(client, roomId, "model", png);
      assert.equal(res.statusCode, 422, res.body);
      assert.deepEqual(res.json(), { error: "bad_model_sheet" });
    }
    assert.equal((await t.pool.query("select 1 from assets where room_id = $1", [roomId])).rowCount, 0);
    assert.equal((await upload(dm, roomId, "token", await sheetPng(2000, 0, 1000))).statusCode, 200);
  });

  test("a player and a table display read a hidden creature's, a disguise's and a monster's sheet exactly as an unknown id, until the image reaches them", async () => {
    const { dm, player, roomId, dmSocket, sceneId } = await table(t);
    const face = await uploaded(dm, roomId, "token", await solid(64, 64, "#a33").png().toBuffer());
    const hiddenSheet = await uploaded(dm, roomId, "model", await sheetPng(512, 3));
    const trueSheet = await uploaded(dm, roomId, "model", await sheetPng(512, 4));
    const monsterSheet = await uploaded(dm, roomId, "model", await sheetPng(512, 5));
    const hidden = tokenOp(sceneId, { visibility: "dm", image: wearing(face.id, hiddenSheet.id) });
    const hiddenId = (hidden.token as { id: string }).id;
    await applied(dmSocket, hidden);
    await applied(dmSocket, tokenOp(sceneId, { name: "Mask", x: 4, image: { icon: "lorc/wolf-head", color: "#336699" }, altImages: [wearing(face.id, trueSheet.id)] }));
    const { rev: _rev, ...monster } = customMonster(uuidv7(), { defaultImage: wearing(face.id, monsterSheet.id) });
    await applied(dmSocket, { t: "monster.create", monster });
    const minted = await dm.post(`/api/rooms/${roomId}/display/code`);
    const tv = t.client();
    assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(minted.json<{ code: string }>().code) })).statusCode, 200);
    const tvRead = async (id: string) => {
      const res = await tv.request("GET", `/api/rooms/${roomId}/display/assets/${id}/full`);
      return { status: res.statusCode, body: res.statusCode === 200 ? "(image)" : res.body, type: res.headers["content-type"]?.toString() };
    };
    const unknown = randomUUID();
    const nobody = await read(player, unknown);
    assert.equal(nobody.status, 404);
    for (const sheet of [hiddenSheet, trueSheet, monsterSheet]) {
      for (const variant of ["full", "mobile", "thumb"]) assert.deepEqual(await read(player, sheet.id, variant), await read(player, unknown, variant), `${sheet.id} ${variant}`);
      assert.deepEqual(await tvRead(sheet.id), await tvRead(unknown), `the display's read of ${sheet.id}`);
    }
    const listed = (await player.get(`/api/rooms/${roomId}/assets`)).json<{ assets: { id: string }[] }>().assets.map((a) => a.id);
    for (const sheet of [hiddenSheet, trueSheet, monsterSheet]) assert.equal(listed.includes(sheet.id), false, "nor does the player's list name it");

    // Shown, the creature brings its sheet to the table, and hidden again it takes it away.
    await applied(dmSocket, { t: "token.update", tokenId: hiddenId, patch: { visibility: "all" } });
    assert.equal((await read(player, hiddenSheet.id)).status, 200);
    assert.equal((await tvRead(hiddenSheet.id)).status, 200);
    assert.ok((await player.get(`/api/rooms/${roomId}/assets`)).json<{ assets: { id: string }[] }>().assets.some((a) => a.id === hiddenSheet.id));
    await applied(dmSocket, { t: "token.update", tokenId: hiddenId, patch: { visibility: "dm" } });
    assert.deepEqual(await read(player, hiddenSheet.id), nobody);
    assert.deepEqual(await tvRead(hiddenSheet.id), await tvRead(unknown));
    // The DM reads every sheet.
    for (const sheet of [hiddenSheet, trueSheet, monsterSheet]) assert.equal((await read(dm, sheet.id)).status, 200);
  });

  test("an op naming a picture as a model, or a sheet as a picture, is refused, and a player wears a sheet of their own", async () => {
    const { dm, player, playerId, roomId, dmSocket, playerSocket, sceneId } = await table(t);
    const face = await uploaded(player, roomId, "token", await solid(64, 64, "#3a6").png().toBuffer());
    const sheet = await uploaded(dm, roomId, "model", await sheetPng(512, 6));
    const own = tokenOp(sceneId, { kind: "pc", name: "Pip", ownerIds: [playerId], image: { assetId: face.id, crop: { cx: 0, cy: 0, zoom: 1 } } });
    const ownId = (own.token as { id: string }).id;
    await applied(dmSocket, own);
    const refused = async (socket: Socket, image: ImageRef) => {
      const ev = await socket.apply({ t: "token.update", tokenId: ownId, patch: { image } });
      return ev.rejects?.[0]?.code;
    };
    assert.equal(await refused(dmSocket, wearing(face.id, face.id)), "gone", "a picture is no sheet");
    assert.equal(await refused(dmSocket, { assetId: sheet.id, crop: { cx: 0, cy: 0, zoom: 1 } }), "gone", "a sheet is no picture");
    assert.equal(await refused(dmSocket, wearing(face.id, randomUUID())), "gone", "no row at all");
    const mine = await uploaded(player, roomId, "model", await sheetPng(512, 7));
    assert.equal(await refused(playerSocket, wearing(face.id, mine.id)), undefined, "the owner's own sheet");
    // The DM's sheet is the player's to wear only once an image their copy holds names it, as a picture is.
    const onIcon: ImageRef = { icon: "lorc/wolf-head", color: "#336699", model: model(sheet.id) };
    assert.equal(await refused(playerSocket, onIcon), "gone", "a sheet no image of theirs names");
    await applied(dmSocket, tokenOp(sceneId, { name: "Shown", x: 6, image: wearing(face.id, sheet.id) }));
    assert.equal(await refused(playerSocket, onIcon), undefined, "a sheet a creature in sight wears, on an icon");
    assert.deepEqual(t.manager.get(roomId)!.committed.state.tokens[ownId]?.image, onIcon);
  });

  test("the backup round trip: each sheet travels, is checked again, and every model follows it to its new row, and a sheet the check refuses leaves its picture", async () => {
    const { dm, roomId, dmSocket, sceneId } = await table(t);
    const face = await uploaded(dm, roomId, "token", await solid(64, 64, "#a33").png().toBuffer());
    const sheet = await uploaded(dm, roomId, "model", await sheetPng(1024, 8));
    const iconSheet = await uploaded(dm, roomId, "model", await sheetPng(512, 9));
    await applied(dmSocket, tokenOp(sceneId, { name: "Knight", image: wearing(face.id, sheet.id) }));
    await applied(dmSocket, tokenOp(sceneId, { name: "Wolf", x: 4, image: { icon: "lorc/wolf-head", color: "#336699", model: model(iconSheet.id) } }));
    const exported = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(exported.statusCode, 200, exported.body);
    const files = await unzip(exported.rawPayload);
    const manifest = JSON.parse(files.get("assets.json")!.toString()) as ExportManifest;
    const sheets = manifest.assets.filter((a) => a.kind === "model");
    assert.equal(sheets.length, 2);
    for (const a of sheets) for (const v of a.variants) assert.ok(files.has(`assets/${a.sha256}-model-${v}.webp`), `${a.id} ${v}`);

    const importInto = async (zip: Buffer): Promise<RoomState> => {
      const importer = t.client();
      const form = Buffer.from(JSON.stringify({ playerPassword: "owlbear-druid-wand", dmName: "Importer" })).toString("base64url");
      const res = await importer.request("POST", "/api/rooms/import", undefined, { "content-type": "application/zip", "x-import-form": form }, zip);
      assert.equal(res.statusCode, 201, res.body);
      const newRoom = res.json<{ roomId: string }>().roomId;
      t.track(newRoom);
      return storedState(t, newRoom);
    };
    const byName = (state: RoomState) => Object.fromEntries(Object.values(state.tokens).map((tok) => [tok.name, tok]));
    const copy = await importInto(exported.rawPayload);
    const tokens = byName(copy);
    const knight = tokens.Knight!.image as ImageRef & { assetId: string };
    const wolf = tokens.Wolf!.image!;
    const rows = new Map((await t.pool.query<{ id: string; kind: string; width: number }>("select id, kind, width from assets where id = any($1::uuid[])", [[knight.assetId, knight.model!.assetId, wolf.model!.assetId]])).rows.map((r) => [r.id, r]));
    assert.deepEqual(rows.get(knight.model!.assetId), { id: knight.model!.assetId, kind: "model", width: 1024 });
    assert.deepEqual(rows.get(wolf.model!.assetId), { id: wolf.model!.assetId, kind: "model", width: 512 });
    assert.equal(rows.get(knight.assetId)?.kind, "token");
    assert.notEqual(knight.model!.assetId, sheet.id);
    assert.deepEqual({ ...knight.model!, assetId: "x" }, { ...model(sheet.id), assetId: "x" }, "the side, anchor and boxes come through as they were");
    assert.equal("icon" in wolf && wolf.icon, "lorc/wolf-head");

    // A hand-edited file whose sheet is the wrong shape: the import refuses that one image and keeps the picture.
    const knightSheet = sheets.find((a) => a.id === sheet.id)!;
    const bad = new Map(files);
    bad.set(`assets/${knightSheet.sha256}-model-full.webp`, await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer());
    const damaged = byName(await importInto(await zipOf(bad)));
    const kept = damaged.Knight!.image as ImageRef & { assetId: string };
    assert.equal(kept.model, undefined, "the model went with its sheet");
    assert.equal((await t.pool.query<{ kind: string }>("select kind from assets where id = $1", [kept.assetId])).rows[0]?.kind, "token", "the picture stayed");
    assert.ok(damaged.Wolf!.image?.model, "the other sheet came through");
  });

  test("the database step adds the model kind to an older check once, and the older check refused it", async () => {
    const { roomId } = await table(t);
    const client = await t.pool.connect();
    const row = (kind: string) =>
      client.query("insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants) values ($1, $2, $3, $4, 1, 512, 256, 100, '{full}')", [randomUUID(), roomId, randomBytes(32), kind]);
    const definition = async () => (await client.query<{ oid: string; def: string }>("select oid::text as oid, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'assets'::regclass and conname = 'assets_kind_check'")).rows[0]!;
    // In a transaction rolled back after, so the shared database never keeps the older check.
    try {
      await client.query("begin");
      // A database from before models holds no sheet, so the sheets earlier tests made go first.
      await client.query("delete from assets where kind = 'model'");
      await client.query("alter table assets drop constraint assets_kind_check, add constraint assets_kind_check check (kind in ('map', 'token', 'handout', 'thumb', 'video', 'sound'))");
      await client.query("savepoint before_model");
      await assert.rejects(row("model"), /assets_kind_check/);
      await client.query("rollback to savepoint before_model");
      // What a start runs.
      await client.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
      const first = await definition();
      assert.match(first.def, /'model'/);
      for (const kind of ["map", "token", "handout", "thumb", "model"]) await row(kind);
      await client.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
      assert.equal((await definition()).oid, first.oid, "a second start leaves the check as it is");
      await client.query("savepoint unknown_kind");
      await assert.rejects(row("mesh"), /assets_kind_check/);
      await client.query("rollback to savepoint unknown_kind");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
