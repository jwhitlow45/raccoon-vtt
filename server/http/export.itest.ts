import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import yauzl from "yauzl";
import yazl from "yazl";
import { uuidv7 } from "#shared/ids.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { CustomMonster, LogEntry, RoomState, SrdImage } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import { blockOf, customMonster } from "#shared/testutil.ts";
import { variantPath } from "../assets/store.ts";
import { solid, SVG } from "../assets/testImages.ts";
import type { RoomExport, ExportManifest } from "../rooms/exportRoom.ts";
import { startEngine, type Engine, type TestClient } from "../rooms/testing.ts";
import { imageAssetId } from "#shared/imageRef.ts";

/**
 * Export and import (design 16.4): the round trip with the asset manifest, a
 * hostile manifest, whispers filtered from the export, and the limits that
 * make both safe to expose.
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

function zipOf(entries: Record<string, Buffer | string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), name);
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

function form(fields: Record<string, unknown>): Record<string, string> {
  return { "x-import-form": Buffer.from(JSON.stringify(fields)).toString("base64url") };
}

async function upload(client: TestClient, roomId: string, kind: string, png: Buffer): Promise<{ id: string; width: number; height: number }> {
  const res = await client.request("PUT", `/api/rooms/${roomId}/assets?kind=${kind}`, undefined, { "content-type": "image/png" }, png);
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

async function importZip(client: TestClient, zip: Buffer, fields: Record<string, unknown> = { playerPassword: "owlbear-druid-wand", dmName: "Importer" }) {
  return client.request("POST", "/api/rooms/import", undefined, { "content-type": "application/zip", ...form(fields) }, zip);
}

describe("room export and import", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ export: { perHour: 3 } });
  });
  after(() => t.close());

  test("round trip: state, assets and uploaders come back under new ids, whispers the DM may not read stay out", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Original");
    const p1 = t.client();
    const p1Id = await p1.join(roomId, "Pip");
    const p2 = t.client();
    const p2Id = await p2.join(roomId, "Quin");
    const map = await upload(dm, roomId, "map", await solid(640, 400).png().toBuffer());
    const face = await upload(p1, roomId, "token", await solid(64, 64, "#a33").png().toBuffer());
    const dmSocket = await t.connect(roomId, dm);
    const sceneId = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const p1Socket = await t.connect(roomId, p1);
    await p1Socket.snapshot("p1");
    await dmSocket.apply({ t: "scene.setMap", sceneId, map: { assetId: map.id, widthPx: 1, heightPx: 1, cellPx: 40, originPx: { x: 0, y: 0 } } });
    const tokenId = uuidv7();
    await p1Socket.apply({ t: "log.whisper", to: [p2Id], text: "secret between players" });
    await p1Socket.apply({ t: "log.whisper", to: [(await dm.me(roomId)).memberId!], text: "for the dm" });
    await dmSocket.apply({ t: "token.create", token: { id: tokenId, sceneId, kind: "pc", name: "Pip", size: "medium", x: 1, y: 1, ownerIds: [p1Id], image: { assetId: face.id, crop: { cx: 0, cy: 0, zoom: 1 } }, actor: { inline: actor } } });
    await dmSocket.apply({ t: "handout.show", handout: { id: uuidv7(), assetId: map.id, title: "The map", to: "all" } });
    const monsterId = uuidv7();
    const lurker = blockOf(customMonster(monsterId, { sizeAlt: "medium", xpInLair: 700 }));
    await dmSocket.apply({ t: "monster.create", monster: { id: monsterId, ...lurker } });

    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["content-type"], "application/zip");
    const files = await unzip(res.rawPayload);
    const room = JSON.parse(files.get("room.json")!.toString()) as RoomExport;
    const manifest = JSON.parse(files.get("assets.json")!.toString()) as ExportManifest;
    assert.equal(room.format, "raccoon-vtt-room");
    assert.equal(room.schemaVersion, SNAPSHOT_VERSION);
    assert.deepEqual(blockOf(room.state.monsters[monsterId]!), lurker);
    assert.equal(room.state.scenes[sceneId]?.map?.assetId, map.id);
    // The row's canonical size won over what the client sent.
    assert.equal(room.state.scenes[sceneId]?.map?.widthPx, 640);
    assert.equal(room.state.scenes[sceneId]?.map?.heightPx, 400);
    assert.ok(!room.state.log.some((e) => e.text === "secret between players"));
    assert.ok(room.state.log.some((e) => e.text === "for the dm"));
    assert.equal(manifest.assets.length, 2);
    const faceRow = manifest.assets.find((a) => a.id === face.id)!;
    assert.deepEqual(faceRow.uploaders, [p1Id]);
    for (const a of manifest.assets) for (const v of a.variants) assert.ok(files.has(`assets/${a.sha256}-${a.kind}-${v}.webp`), `${a.kind} ${v}`);
    assert.equal((await p1.get(`/api/rooms/${roomId}/export`)).statusCode, 403);

    const importer = t.client();
    const imported = await importZip(importer, res.rawPayload, { playerPassword: "wyvern-staff-rune", dmName: "Importer", name: "Copy" });
    assert.equal(imported.statusCode, 201, imported.body);
    const { roomId: newId } = imported.json<{ roomId: string }>();
    t.track(newId);
    assert.notEqual(newId, roomId);
    assert.equal((await importer.me(newId)).role, "dm");
    const copy = await t.connect(newId, importer);
    const state = (await copy.snapshot("i")).state as ProjectedState;
    assert.equal(state.meta.name, "Copy");
    const scenes = Object.values(state.scenes);
    assert.equal(scenes.length, 1);
    assert.notEqual(scenes[0]!.id, sceneId);
    assert.equal(scenes[0]!.map?.widthPx, 640);
    assert.notEqual(scenes[0]!.map?.assetId, map.id);
    const tokens = Object.values(state.tokens);
    assert.equal(tokens.length, 1);
    assert.notEqual(tokens[0]!.id, tokenId);
    assert.ok(tokens[0]!.image && imageAssetId(tokens[0]!.image) !== face.id);
    const members = Object.values(state.members);
    assert.equal(members.filter((m) => m.kind === "dm").length, 1);
    assert.equal(members.length, 4);
    // Ownership followed the member remap, and the new asset rows name the new member as uploader.
    const owner = members.find((m) => m.name === "Pip")!;
    assert.deepEqual(tokens[0]!.ownerIds, [owner.id]);
    const uploaders = await t.pool.query<{ member_id: string }>("select u.member_id from asset_uploaders u join assets a on a.id = u.asset_id where a.room_id = $1 and a.kind = 'token'", [newId]);
    assert.deepEqual(uploaders.rows.map((r) => r.member_id), [owner.id]);
    assert.equal(state.log.length, 2);
    assert.ok(state.log.every((e) => e.id.startsWith("0:")));
    // The room's own monsters travel in the backup, under new ids like everything else.
    const monsters = Object.values(state.monsters);
    assert.equal(monsters.length, 1);
    assert.notEqual(monsters[0]!.id, monsterId);
    assert.deepEqual(blockOf(monsters[0]!), lurker);
    const assets = await importer.get(`/api/rooms/${newId}/assets`);
    assert.equal(assets.json<{ assets: unknown[] }>().assets.length, 2);
    // Both rooms share the files on disk, so the original still serves them.
    assert.equal((await dm.get(`/api/assets/${map.id}/thumb`)).statusCode, 200);
    copy.close();
    dmSocket.close();
    p1Socket.close();
  });

  test("an Openverse image's credit travels in assets.json, and the import keeps it only when it reads as a credit", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Credited");
    const art = await upload(dm, roomId, "token", await solid(48, 48, "#3a3").png().toBuffer());
    const credit = {
      creator: "Dunechaser",
      license: "by-nc-sa",
      licenseVersion: "2.0",
      landingUrl: "https://www.flickr.com/photos/dunechaser/1",
      attribution: '"Goblins and a Troll" by Dunechaser is licensed under CC BY-NC-SA 2.0.',
      originalWidth: 1024,
      originalHeight: 768,
    };
    await t.pool.query("update assets set credit = $2 where id = $1", [art.id, JSON.stringify(credit)]);
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    const files = await unzip(res.rawPayload);
    const manifest = JSON.parse(files.get("assets.json")!.toString()) as ExportManifest;
    assert.deepEqual(manifest.assets.find((a) => a.id === art.id)?.credit, credit);

    const importer = t.client();
    const imported = await importZip(importer, res.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const { roomId: copyId } = imported.json<{ roomId: string }>();
    t.track(copyId);
    const rows = await t.pool.query<{ credit: unknown }>("select credit from assets where room_id = $1", [copyId]);
    assert.deepEqual(rows.rows.map((r) => r.credit), [credit]);

    // A hand-made file's credit that does not read as one stays behind, and the image still comes through.
    const hostile = { ...manifest, assets: manifest.assets.map((a) => ({ ...a, credit: { ...credit, landingUrl: "javascript:alert(1)" } })) };
    const entries: Record<string, Buffer> = {};
    for (const [name, data] of files) entries[name] = name === "assets.json" ? Buffer.from(JSON.stringify(hostile)) : data;
    const second = await importZip(t.client(), await zipOf(entries));
    assert.equal(second.statusCode, 201, second.body);
    const { roomId: hostileId } = second.json<{ roomId: string }>();
    t.track(hostileId);
    const kept = await t.pool.query<{ credit: unknown }>("select credit from assets where room_id = $1", [hostileId]);
    assert.deepEqual(kept.rows.map((r) => r.credit), [null]);
  });

  test("a room's journal, pins, roll requests, icons and room monster links come through an export and an import (docs/design-v1-dm-tools.md 2.5)", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Wave five");
    const player = t.client();
    const pipId = await player.join(roomId, "Pip");
    const dmSocket = await t.connect(roomId, dm);
    const sceneId = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const monsterId = uuidv7();
    const characterId = uuidv7();
    const tokenId = uuidv7();
    const ops: Record<string, unknown>[] = [
      { t: "monster.create", monster: { id: monsterId, ...blockOf(customMonster(monsterId)) } },
      { t: "character.create", character: { id: characterId, name: "Pip", size: "medium", ownerIds: [pipId], defaultImage: { icon: "lorc/wolf-head", color: "#336699" }, actor } },
      { t: "token.create", token: { id: tokenId, sceneId, kind: "monster", name: "Lurker", size: "medium", x: 2, y: 2, image: { icon: "delapouite/goblin-head", color: "#000000" }, actor: { inline: { ...actor, monsterId } } } },
      { t: "journal.create", page: { id: "pg1", title: "For Pip", access: { member: pipId }, blocks: [{ id: "abcdefghijkl", text: "Hush.", secret: true }] } },
      { t: "pin.put", pin: { id: "pin1", sceneId, x: 3, y: 3, color: "#ff8800", visibility: "all", pageId: "pg1" } },
      { t: "roll.ask", request: { id: "r1", test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 12, dcShown: true, resultShown: true, targets: [{ characterId }] } },
      { t: "room.update", settings: { playersDraw: [pipId] } },
    ];
    for (const op of ops) {
      const ev = await dmSocket.apply(op);
      assert.deepEqual(ev.rejects ?? [], [], String(op.t));
    }
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    assert.ok(room.state.rolls.r1, "the export is the stored state, open requests included");

    const importer = t.client();
    const imported = await importZip(importer, res.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const { roomId: copyId } = imported.json<{ roomId: string }>();
    t.track(copyId);
    const copy = await t.connect(copyId, importer);
    const state = (await copy.snapshot("i")).state as ProjectedState;
    const pip = Object.values(state.members).find((m) => m.name === "Pip")!;
    const [page] = Object.values(state.journal);
    assert.ok(page && page.id !== "pg1");
    assert.deepEqual(page.access, { member: pip.id });
    assert.deepEqual(page.blocks, [{ id: "abcdefghijkl", text: "Hush.", secret: { revealed: false } }]);
    const [pin] = Object.values(state.pins);
    assert.ok(pin && pin.id !== "pin1");
    assert.equal(pin.pageId, page.id);
    assert.deepEqual(state.rolls, {}, "open requests stay behind");
    assert.deepEqual(state.meta.settings.playersDraw, [pip.id]);
    const [lurker] = Object.values(state.tokens);
    const [monster] = Object.values(state.monsters);
    assert.deepEqual(lurker?.image, { icon: "delapouite/goblin-head", color: "#000000" });
    assert.equal((lurker?.actor as { inline: { monsterId?: string } }).inline.monsterId, monster?.id);
    assert.deepEqual(Object.values(state.characters)[0]?.defaultImage, { icon: "lorc/wolf-head", color: "#336699" });
    copy.close();
    dmSocket.close();
  });

  test("an import drops a player's open asks for saves, as it drops open requests, and keeps their lines on the caster's new id (docs/design-v1-player-save-spell.md 5.7)", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Save spell");
    const player = t.client();
    const pipId = await player.join(roomId, "Pip");
    const dmSocket = await t.connect(roomId, dm);
    const sceneId = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const characterId = uuidv7();
    const tokenId = uuidv7();
    const ops: Record<string, unknown>[] = [
      { t: "character.create", character: { id: characterId, name: "Thorn", size: "medium", ownerIds: [pipId], actor } },
      { t: "token.create", token: { id: tokenId, sceneId, kind: "pc", name: "Thorn", size: "medium", x: 2, y: 2, actor: { ref: characterId } } },
    ];
    for (const op of ops) assert.deepEqual((await dmSocket.apply(op)).rejects ?? [], [], String(op.t));
    const pipSocket = await t.connect(roomId, player);
    await pipSocket.snapshot("pip");
    const asked = await pipSocket.apply({ t: "cast.ask", cast: { id: uuidv7(), caster: tokenId, sceneId, spell: "Hold Person", slot: 2, targets: [tokenId] } });
    assert.deepEqual(asked.rejects ?? [], []);
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    assert.equal(Object.keys(room.state.casts).length, 1, "the export is the stored state, open asks included");

    const importer = t.client();
    const imported = await importZip(importer, res.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const { roomId: copyId } = imported.json<{ roomId: string }>();
    t.track(copyId);
    const copy = await t.connect(copyId, importer);
    const state = (await copy.snapshot("i")).state as ProjectedState;
    assert.deepEqual(state.casts, {}, "open asks stay behind");
    const thorn = Object.values(state.tokens).find((tk) => tk.name === "Thorn")!;
    const lines = state.log.flatMap((e) => (e.data?.type === "cast" ? [e.data] : []));
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.tokenId, thorn.id);
    assert.notEqual(thorn.id, tokenId);
    for (const s of [copy, pipSocket, dmSocket]) s.close();
  });

  test("a hostile manifest cannot smuggle a non-image, lie about a kind, or escape the asset folder", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Hostile source");
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200);
    const files = await unzip(res.rawPayload);
    const roomJson = files.get("room.json")!;
    const sha = "ab".repeat(32);
    const png = await solid(32, 32).png().toBuffer();
    const zip = await zipOf({
      "room.json": roomJson,
      "assets.json": JSON.stringify({
        formatVersion: 1,
        assets: [
          { id: "svg", sha256: sha, kind: "token", width: 1, height: 1, variants: ["full"], uploaders: [] },
          { id: "lying", sha256: "cd".repeat(32), kind: "map", width: 99_999, height: 99_999, variants: ["full"], uploaders: ["nobody"] },
          { id: "bad-kind", sha256: "ef".repeat(32), kind: "../../etc", width: 1, height: 1, variants: ["full"], uploaders: [] },
        ],
      }),
      [`assets/${sha}-token-full.webp`]: SVG,
      [`assets/${"cd".repeat(32)}-map-full.webp`]: png,
    });
    const importer = t.client();
    const imported = await importZip(importer, zip);
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const rows = await t.pool.query<{ kind: string; width: number }>("select kind, width from assets where room_id = $1", [newId]);
    // The SVG was refused, the "map" was re-measured by sharp, the bad kind never existed.
    assert.deepEqual(rows.rows, [{ kind: "map", width: 32 }]);
    const uploaders = await t.pool.query("select 1 from asset_uploaders u join assets a on a.id = u.asset_id where a.room_id = $1", [newId]);
    assert.equal(uploaders.rowCount, 0);

    // yazl refuses to write such a name, so the bytes are patched in after the fact, as an attacker would.
    const escaping = await zipOf({ "room.json": roomJson, "zzzroom.json": roomJson });
    const patched = Buffer.from(escaping);
    for (let i = patched.indexOf("zzzroom.json"); i >= 0; i = patched.indexOf("zzzroom.json", i + 1)) patched.write("../room.json", i, "latin1");
    assert.equal((await importZip(importer, patched)).statusCode, 400);
    const broken = await zipOf({ "room.json": JSON.stringify({ format: "raccoon-vtt-room", formatVersion: 1, schemaVersion: 1, state: { meta: {} } }) });
    const bad = await importZip(importer, broken);
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json<{ error: string }>().error, "bad_room_json");
    const future = await zipOf({ "room.json": JSON.stringify({ format: "raccoon-vtt-room", formatVersion: 1, schemaVersion: 99, state: {} }) });
    assert.equal((await importZip(importer, future)).json<{ error: string }>().error, "unsupported_schema_version");
    assert.equal((await importZip(importer, Buffer.from("not a zip"))).statusCode, 400);
    const noForm = await importer.request("POST", "/api/rooms/import", undefined, { "content-type": "application/zip" }, zip);
    assert.equal(noForm.statusCode, 400);
    const weak = await importZip(importer, zip, { playerPassword: "password", dmName: "X" });
    assert.equal(weak.json<{ error: string }>().error, "weak_password");
    const wrongType = await importer.request("POST", "/api/rooms/import", undefined, { "content-type": "application/octet-stream", ...form({ playerPassword: "owlbear-druid-wand", dmName: "X" }) }, zip);
    assert.equal(wrongType.statusCode, 415);
    // No room row is left behind by a refused import.
    const count = await t.pool.query("select count(*)::int as n from rooms where created_ip = $1", [importer.ip.replace(/::.*$/, "")]);
    assert.ok(count.rows[0].n <= 1);
  });

  test("exports are counted per hour and import counts as a room creation", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Counted");
    for (let i = 0; i < 3; i++) assert.equal((await dm.get(`/api/rooms/${roomId}/export`)).statusCode, 200);
    const fourth = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(fourth.statusCode, 429);
    assert.ok(Number(fourth.headers["retry-after"]) > 0);
    const limited = await startEngine({ env: { ROOMS_PER_IP_PER_DAY: "1" } });
    try {
      const c = limited.client();
      const { roomId: first } = await c.createRoom("One");
      const res = await c.get(`/api/rooms/${first}/export`);
      const refused = await c.request("POST", "/api/rooms/import", undefined, { "content-type": "application/zip", ...form({ playerPassword: "owlbear-druid-wand", dmName: "X" }) }, res.rawPayload);
      assert.equal(refused.statusCode, 429);
    } finally {
      await limited.close();
    }
  });

  test("a HEAD runs the export's checks without counting toward the limit or making a zip", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Checked");
    const head = () => dm.request("HEAD", `/api/rooms/${roomId}/export`);
    for (let i = 0; i < 5; i++) {
      const res = await head();
      assert.equal(res.statusCode, 200);
      assert.equal(res.rawPayload.length, 0);
    }
    for (let i = 0; i < 3; i++) assert.equal((await dm.get(`/api/rooms/${roomId}/export`)).statusCode, 200);
    const limited = await head();
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers["retry-after"]) > 0);
    const player = t.client();
    await player.join(roomId, "Pip");
    assert.equal((await player.request("HEAD", `/api/rooms/${roomId}/export`)).statusCode, 403);
  });

  test("nobody can continue as an imported room's old DM", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Old table");
    const pipId = await t.client().join(roomId, "Pip");
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200);
    const importer = t.client();
    const imported = await importZip(importer, res.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [newId]);
    const members = Object.values(rows[0]!.state.members);
    const oldDm = members.find((m) => m.name === "Dungeon Master")!;
    const pip = members.find((m) => m.name === "Pip")!;
    assert.equal(oldDm.kind, "player");
    assert.notEqual(pip.id, pipId);

    const phone = t.client();
    const step1 = await phone.post(`/api/rooms/${newId}/join`, { password: "owlbear-druid-wand" });
    assert.equal(step1.statusCode, 200, step1.body);
    const { ticket, players } = step1.json<{ ticket: string; players: Array<{ id: string }> }>();
    assert.deepEqual(players.map((p) => p.id), [pip.id]);
    const refused = await phone.post(`/api/rooms/${newId}/join/complete`, { ticket, memberId: oldDm.id });
    assert.equal(refused.statusCode, 403);
    assert.equal((await phone.post(`/api/rooms/${newId}/join/complete`, { ticket, memberId: pip.id })).statusCode, 200);
  });

  test("a co-DM removed as DM before the export stays barred from continue as after import", async () => {
    const dm = t.client();
    const { roomId, dmKey } = await dm.createRoom("Two DMs");
    const ownerId = (await dm.me(roomId)).memberId!;
    const coDm = t.client();
    const coDmId = await coDm.claimDm(roomId, dmKey, "Co-DM");
    const coSocket = await t.connect(roomId, coDm);
    await coSocket.snapshot("co");
    assert.equal((await coSocket.apply({ t: "log.whisper", to: [ownerId], text: "the lich is the innkeeper" })).rejects, undefined);
    coSocket.close();
    assert.equal((await dm.delete(`/api/rooms/${roomId}/dm/members/${coDmId}`)).statusCode, 204);

    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    // The state alone no longer says the co-DM ever was one.
    assert.equal(room.state.members[coDmId]?.kind, "player");
    assert.deepEqual(room.dmMemberIds, [ownerId, coDmId].sort());

    const imported = await importZip(t.client(), res.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [newId]);
    const state = rows[0]!.state;
    const newCoDm = Object.values(state.members).find((m) => m.name === "Co-DM")!;
    assert.equal(newCoDm.kind, "player");
    // The whisper came along, so continuing as the co-DM would reach it.
    assert.ok(state.log.some((e) => e.kind === "whisper" && e.from === newCoDm.id && e.text === "the lich is the innkeeper"));

    const phone = t.client();
    const step1 = await phone.post(`/api/rooms/${newId}/join`, { password: "owlbear-druid-wand" });
    assert.equal(step1.statusCode, 200, step1.body);
    const { ticket, players } = step1.json<{ ticket: string; players: Array<{ id: string }> }>();
    assert.ok(!players.some((p) => p.id === newCoDm.id));
    const refused = await phone.post(`/api/rooms/${newId}/join/complete`, { ticket, memberId: newCoDm.id });
    assert.equal(refused.statusCode, 403);
  });

  test("the former-DM marks are read with the room row, so a room deleted after its state was copied gives no backup", async () => {
    const dm = t.client();
    const { roomId, dmKey } = await dm.createRoom("Deleted mid-export");
    const ownerId = (await dm.me(roomId)).memberId!;
    const coDmId = await t.client().claimDm(roomId, dmKey, "Co-DM");
    const { formerDmsOfLiveRoom } = await import("../auth/grants.ts");
    assert.deepEqual([...(await formerDmsOfLiveRoom(t.pool, roomId))!].sort(), [ownerId, coDmId].sort());
    assert.equal((await dm.delete(`/api/rooms/${roomId}`, { name: "Deleted mid-export" })).statusCode, 204);
    // Before this, the marks query alone answered an empty set here, which an import trusts as "no former DMs".
    assert.equal(await formerDmsOfLiveRoom(t.pool, roomId), null);
  });

  test("an export made before DM marks were exported bars every member from continue as, since any could be a former DM", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Old format");
    await t.client().join(roomId, "Pip");
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as Partial<RoomExport>;
    delete room.dmMemberIds;
    const imported = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify(room) }));
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [newId]);
    const pip = Object.values(rows[0]!.state.members).find((m) => m.name === "Pip")!;
    assert.equal(pip.kind, "player");

    const phone = t.client();
    const step1 = await phone.post(`/api/rooms/${newId}/join`, { password: "owlbear-druid-wand" });
    assert.equal(step1.statusCode, 200, step1.body);
    const { ticket, players } = step1.json<{ ticket: string; players: Array<{ id: string }> }>();
    assert.deepEqual(players, []);
    assert.equal((await phone.post(`/api/rooms/${newId}/join/complete`, { ticket, memberId: pip.id })).statusCode, 403);
    assert.equal((await phone.post(`/api/rooms/${newId}/join/complete`, { ticket, name: "Pip again", color: "#112233" })).statusCode, 200);
  });

  test("a backup from before custom monsters imports with none", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Before monsters");
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    const { monsters: _monsters, ...v1 } = room.state;
    const imported = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify({ ...room, schemaVersion: 1, state: v1 }) }));
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const { rows } = await t.pool.query<{ state: RoomState; schema_version: number }>("select state, schema_version from room_snapshots where room_id = $1", [newId]);
    assert.deepEqual(rows[0]!.state.monsters, {});
    assert.equal(rows[0]!.schema_version, SNAPSHOT_VERSION);
  });

  test("a backup from before SRD monster images imports with none", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Before monster images");
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    const { srdImages: _srdImages, ...v2 } = room.state;
    const imported = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify({ ...room, schemaVersion: 2, state: v2 }) }));
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [newId]);
    assert.deepEqual(rows[0]!.state.srdImages, {});
  });

  test("a backup from before saved encounters imports with none", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Before saved encounters");
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    const { savedEncounters: _saved, ...v4 } = room.state;
    const imported = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify({ ...room, schemaVersion: 4, state: v4 }) }));
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [newId]);
    assert.deepEqual(rows[0]!.state.savedEncounters, {});
  });

  test("a document and a showing handout of pages come back with every page row, under new ids, in order and as handout images (docs/design-v1-pdf-handouts.md 3.6)", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Pdf handouts");
    const dmSocket = await t.connect(roomId, dm);
    await dmSocket.snapshot("dm");
    const [a, b, c] = [await upload(dm, roomId, "handout", await solid(60, 80, "#a11").png().toBuffer()), await upload(dm, roomId, "handout", await solid(80, 60, "#1a1").png().toBuffer()), await upload(dm, roomId, "handout", await solid(50, 70, "#11a").png().toBuffer())];
    const page = (u: { id: string; width: number; height: number }) => ({ assetId: u.id, width: u.width, height: u.height });
    const docId = uuidv7();
    const handoutId = uuidv7();
    for (const op of [
      { t: "handoutDoc.create", doc: { id: docId, title: "Strange letter", pages: [c, a, b, a].map(page) } },
      { t: "handout.show", handout: { id: handoutId, pages: [a!, b!, c!].map(page), title: "Strange letter", to: "all" } },
    ]) {
      const ev = await dmSocket.apply(op);
      assert.deepEqual(ev.rejects ?? [], [], op.t);
    }
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    const importer = t.client();
    const imported = await importZip(importer, res.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const { roomId: copyId } = imported.json<{ roomId: string }>();
    t.track(copyId);
    // Each page's new row, found by its size, which differs for each: a new id, still a handout image.
    const { rows } = await t.pool.query<{ id: string; kind: string; width: number; height: number }>("select id, kind, width, height from assets where room_id = $1", [copyId]);
    assert.equal(rows.length, 3);
    for (const row of rows) assert.equal(row.kind, "handout");
    const moved = (u: { id: string; width: number; height: number }) => {
      const row = rows.find((r) => r.width === u.width && r.height === u.height)!;
      assert.notEqual(row.id, u.id);
      return { assetId: row.id, width: row.width, height: row.height };
    };
    const copy = await t.connect(copyId, importer);
    const state = (await copy.snapshot("i")).state as ProjectedState;
    const [doc] = Object.values(state.handoutDocs);
    assert.ok(doc && doc.id !== docId);
    assert.equal(doc.title, "Strange letter");
    assert.deepEqual(doc.pages, [c!, a!, b!, a!].map(moved));
    const [shown] = Object.values(state.handouts);
    assert.ok(shown && shown.id !== handoutId);
    assert.deepEqual(shown.pages, [a!, b!, c!].map(moved));
    assert.equal(shown.assetId, moved(a!).assetId);
    for (const s of [dmSocket, copy]) s.close();
  });

  test("a backup from before pdf handouts imports with no documents", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Before pdf handouts");
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    const { handoutDocs: _docs, ...v8 } = room.state;
    const imported = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify({ ...room, schemaVersion: 8, state: v8 }) }));
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [newId]);
    assert.deepEqual(rows[0]!.state.handoutDocs, {});
  });

  test("a backup from before the dragon turtle's id was fixed imports with the new id everywhere it named the old one, its fight's group keys kept as stored", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Shell game");
    const dmSocket = await t.connect(roomId, dm);
    const sceneId = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const tokenId = uuidv7();
    const image = { icon: "lorc/turtle", color: "#30a46c" };
    for (const op of [
      { t: "monster.setSrdImage", srdId: "dragon-turtle", image },
      { t: "token.create", token: { id: tokenId, sceneId, kind: "monster", name: "Dragon Turtle", size: "gargantuan", x: 2, y: 2, image, actor: { inline: { ...actor, srdId: "dragon-turtle" } } } },
      { t: "savedEncounter.create", encounter: { id: uuidv7(), name: "Shell game", monsters: [{ srdId: "dragon-turtle", count: 1 }] } },
      { t: "encounter.start", entries: [{ id: uuidv7(), tokenId }] },
    ]) {
      assert.equal((await dmSocket.apply(op)).rejects, undefined, op.t);
    }
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    assert.equal(room.state.encounter?.entries[0]?.groupKey, "dragon-turtle");
    // The same room as a build from before the fix exported it, the old id wherever it named the dragon turtle.
    const v13 = JSON.parse(JSON.stringify(room.state).replaceAll('"dragon-turtle"', '"dragon-tur-t-le"')) as RoomState;
    assert.ok(v13.srdImages["dragon-tur-t-le"]);
    const imported = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify({ ...room, schemaVersion: 13, state: v13 }) }));
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const { rows } = await t.pool.query<{ state: RoomState; schema_version: number }>("select state, schema_version from room_snapshots where room_id = $1", [newId]);
    const state = rows[0]!.state;
    assert.equal(rows[0]!.schema_version, SNAPSHOT_VERSION);
    // The fight's rows keep their group keys, which the tracker reads as today's id (rowGroup), and nothing else names the old one.
    const { encounter: _encounter, encounterHistory: _history, ...rest } = state;
    assert.equal(JSON.stringify(rest).includes("dragon-tur-t-le"), false);
    assert.deepEqual(Object.keys(state.srdImages), ["dragon-turtle"]);
    assert.equal(state.srdImages["dragon-turtle"]?.id, "dragon-turtle");
    assert.deepEqual(state.srdImages["dragon-turtle"]?.image, image);
    const [turtle] = Object.values(state.tokens);
    assert.ok(turtle && "inline" in turtle.actor);
    assert.equal(turtle.actor.inline.srdId, "dragon-turtle");
    assert.deepEqual(Object.values(state.savedEncounters)[0]?.monsters, [{ srdId: "dragon-turtle", count: 1 }]);
    assert.equal(state.encounter?.entries[0]?.groupKey, "dragon-tur-t-le");
    dmSocket.close();
  });

  test("a saved encounter is the DM's alone, and a backup brings it back pointing at the room's monsters under their new ids", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Saved encounters");
    const player = t.client();
    await player.join(roomId, "Pip");
    const dmSocket = await t.connect(roomId, dm);
    await dmSocket.snapshot("dm");
    const p = await t.connect(roomId, player);
    await p.snapshot("p");

    const monsterId = uuidv7();
    assert.equal((await dmSocket.apply({ t: "monster.create", monster: { id: monsterId, ...blockOf(customMonster(monsterId)) } })).rejects, undefined);
    const encounterId = uuidv7();
    const encounter = { id: encounterId, name: "Lurkers in the dark", monsters: [{ srdId: "goblin-warrior", count: 3 }, { monsterId, count: 1, inLair: true }], party: [{ count: 4, level: 3 }] };
    const created = await dmSocket.apply({ t: "savedEncounter.create", encounter });
    assert.equal(created.rejects, undefined);
    assert.ok(created.changes.some((c) => c.key === `savedEncounter:${encounterId}`));
    // A player may not save one, and never hears of the DM's, in an ev or a snapshot.
    const refused = await p.apply({ t: "savedEncounter.create", encounter: { ...encounter, id: uuidv7() } });
    assert.equal(refused.rejects?.[0]?.code, "forbidden");
    assert.equal(await p.maybe("ev", (m) => m.changes.some((c) => c.key.startsWith("savedEncounter:")), 300), null);
    const fresh = await t.connect(roomId, player);
    const ps = (await fresh.snapshot("p2")).state as ProjectedState;
    assert.deepEqual(ps.savedEncounters, {});
    assert.equal(JSON.stringify(ps).includes("Lurkers in the dark"), false);

    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    assert.deepEqual(room.state.savedEncounters[encounterId], { ...encounter, rev: 1 });

    const importer = t.client();
    const imported = await importZip(importer, res.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const copy = await t.connect(newId, importer);
    const state = (await copy.snapshot("i")).state as ProjectedState;
    const [saved] = Object.values(state.savedEncounters);
    const [lurker] = Object.values(state.monsters);
    assert.ok(saved && lurker && saved.id !== encounterId && lurker.id !== monsterId);
    assert.deepEqual(saved.monsters, [{ srdId: "goblin-warrior", count: 3 }, { monsterId: lurker.id, count: 1, inLair: true }]);
    assert.deepEqual(saved.party, encounter.party);
    for (const s of [dmSocket, p, fresh, copy]) s.close();
  });

  test("an image used only as a monster's default is the DM's alone, counts as the room's, and a backup brings it back under a new id", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Monster images");
    const player = t.client();
    await player.join(roomId, "Pip");
    const lurkerPic = await upload(dm, roomId, "token", await solid(48, 48, "#2a6").png().toBuffer());
    const goblinPic = await upload(dm, roomId, "token", await solid(48, 48, "#6a2").png().toBuffer());
    const dmSocket = await t.connect(roomId, dm);
    const sceneId = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const p = await t.connect(roomId, player);
    await p.snapshot("p");

    const image = (assetId: string) => ({ assetId, crop: { cx: 0, cy: 0, zoom: 1.2 } });
    const monsterId = uuidv7();
    const created = await dmSocket.apply({ t: "monster.create", monster: { id: monsterId, ...blockOf(customMonster(monsterId)), defaultImage: image(lurkerPic.id) } });
    assert.equal(created.rejects, undefined);
    const set = await dmSocket.apply({ t: "monster.setSrdImage", srdId: "goblin-warrior", image: image(goblinPic.id) });
    assert.deepEqual((set.changes.find((c) => c.key === "srdImage:goblin-warrior") as { value: SrdImage }).value.image, image(goblinPic.id));
    // An image of another room, or none at all, is refused like a token's.
    const stranger = t.client();
    const { roomId: otherRoom } = await stranger.createRoom("Elsewhere");
    const foreign = await upload(stranger, otherRoom, "token", await solid(48, 48, "#26a").png().toBuffer());
    assert.equal((await dmSocket.apply({ t: "monster.setSrdImage", srdId: "owlbear", image: image(foreign.id) })).rejects?.[0]?.code, "gone");
    assert.equal((await dmSocket.apply({ t: "monster.update", monsterId, patch: { defaultImage: image(uuidv7()) } })).rejects?.[0]?.code, "gone");

    // Players get neither choice, in an ev or a snapshot, and may read neither image while no token they see wears it.
    assert.equal(await p.maybe("ev", (m) => m.changes.some((c) => c.key.startsWith("srdImage:") || c.key.startsWith("monster:")), 300), null);
    const fresh = await t.connect(roomId, player);
    const ps = (await fresh.snapshot("p2")).state as ProjectedState;
    assert.deepEqual(ps.srdImages, {});
    assert.deepEqual(ps.monsters, {});
    for (const id of [lurkerPic.id, goblinPic.id]) {
      assert.equal(JSON.stringify(ps).includes(id), false);
      assert.equal((await player.get(`/api/assets/${id}/thumb`)).statusCode, 404);
    }
    assert.deepEqual((await player.get(`/api/rooms/${roomId}/assets`)).json<{ assets: unknown[] }>().assets, []);
    const listed = (await dm.get(`/api/rooms/${roomId}/assets`)).json<{ assets: Array<{ id: string }> }>().assets.map((a) => a.id);
    assert.deepEqual(listed.sort(), [lurkerPic.id, goblinPic.id].sort());
    // A goblin placed with its default image is what shows the image to players.
    const goblin = uuidv7();
    await dmSocket.apply({ t: "token.create", token: { id: goblin, sceneId, kind: "monster", name: "Goblin Warrior", size: "small", x: 2, y: 2, image: image(goblinPic.id), actor: { inline: { ...actor, srdId: "goblin-warrior" } } } });
    await p.next("ev", (m) => m.changes.some((c) => c.key === `token:${goblin}`));
    assert.equal((await player.get(`/api/assets/${goblinPic.id}/thumb`)).statusCode, 200);
    assert.equal((await player.get(`/api/assets/${lurkerPic.id}/thumb`)).statusCode, 404);
    // The room's stored bytes, which its quota counts, include both images.
    const counted = await t.pool.query<{ id: string }>("select id from assets where room_id = $1 and bytes > 0", [roomId]);
    assert.deepEqual(counted.rows.map((r) => r.id).sort(), [lurkerPic.id, goblinPic.id].sort());

    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    const files = await unzip(res.rawPayload);
    const room = JSON.parse(files.get("room.json")!.toString()) as RoomExport;
    const manifest = JSON.parse(files.get("assets.json")!.toString()) as ExportManifest;
    assert.deepEqual(manifest.assets.map((a) => a.id).sort(), [lurkerPic.id, goblinPic.id].sort());
    assert.deepEqual(room.state.monsters[monsterId]?.defaultImage, image(lurkerPic.id));
    assert.deepEqual(room.state.srdImages["goblin-warrior"]?.image, image(goblinPic.id));

    const importer = t.client();
    const imported = await importZip(importer, res.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const copy = await t.connect(newId, importer);
    const state = (await copy.snapshot("i")).state as ProjectedState;
    const newAssets = (await importer.get(`/api/rooms/${newId}/assets`)).json<{ assets: Array<{ id: string }> }>().assets.map((a) => a.id);
    assert.equal(newAssets.length, 2);
    const lurker = Object.values(state.monsters)[0] as CustomMonster;
    const lurkerImage = lurker.defaultImage;
    assert.ok(lurkerImage && "assetId" in lurkerImage && newAssets.includes(lurkerImage.assetId) && lurkerImage.assetId !== lurkerPic.id);
    assert.deepEqual(lurkerImage.crop, image(lurkerPic.id).crop);
    const srd = state.srdImages["goblin-warrior"];
    assert.ok(srd && newAssets.includes(imageAssetId(srd.image)!) && imageAssetId(srd.image) !== goblinPic.id);
    // The copy's goblin and the SRD choice share one new asset, as they shared the old one.
    assert.equal(imageAssetId(Object.values(state.tokens)[0]?.image), imageAssetId(srd.image));
    for (const s of [dmSocket, p, fresh, copy]) s.close();
  });

  test("a backup with a full roster is refused, because the importer would be one member too many", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Full roster");
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    for (let i = Object.keys(room.state.members).length; i < 50; i++) {
      const id = uuidv7();
      room.state.members[id] = { id, rev: 0, name: `Player ${i}`, color: "#336699", kind: "player", createdAt: new Date().toISOString() };
    }
    const importer = t.client();
    const full = await importZip(importer, await zipOf({ "room.json": JSON.stringify(room) }));
    assert.equal(full.statusCode, 413, full.body);
    assert.equal(full.json<{ error: string }>().error, "over_room_limits");
    delete room.state.members[Object.keys(room.state.members).at(-1)!];
    const fits = await importZip(importer, await zipOf({ "room.json": JSON.stringify(room) }));
    assert.equal(fits.statusCode, 201, fits.body);
    const newId = fits.json<{ roomId: string }>().roomId;
    t.track(newId);
    // The room works: the importer's first op is accepted, not refused for the roster.
    const socket = await t.connect(newId, importer);
    await socket.snapshot("i");
    const ev = await socket.apply({ t: "log.chat", text: "still under the limits" });
    assert.equal(ev.rejects, undefined);
    socket.close();
  });

  test("an image that cannot be read mid-export ends that download only, and the export slot comes back", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Vanishing image");
    const face = await upload(dm, roomId, "token", await solid(64, 64, "#3a3").png().toBuffer());
    const { rows } = await t.pool.query<{ sha256: Buffer; pipeline: number }>("select sha256, pipeline from assets where id = $1", [face.id]);
    const row = rows[0]!;
    // A directory where the file was passes the export's existence check but
    // fails yazl's own read, the same failure as a file deleted under it.
    const path = variantPath(t.assetDir, row.sha256.toString("hex"), "token", "full", row.pipeline);
    const saved = await readFile(path);
    await rm(path);
    await mkdir(path);
    try {
      const broken = await dm.get(`/api/rooms/${roomId}/export`).catch(() => null);
      if (broken) await assert.rejects(unzip(broken.rawPayload));
    } finally {
      await rm(path, { recursive: true });
      await writeFile(path, saved);
    }
    // The server is still up, and the failed export gave its slot back.
    const again = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(again.statusCode, 200, again.body);
    const files = await unzip(again.rawPayload);
    assert.ok([...files.keys()].some((name) => name.endsWith("-token-full.webp")));
  });

  test("scene.setMap takes the size from the asset row and refuses the wrong kind", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Sizes");
    const map = await upload(dm, roomId, "map", await solid(300, 200).png().toBuffer());
    const token = await upload(dm, roomId, "token", await solid(50, 50).png().toBuffer());
    const s = await t.connect(roomId, dm);
    const sceneId = ((await s.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const ev = await s.apply({ t: "scene.setMap", sceneId, map: { assetId: map.id, widthPx: 7, heightPx: 7, cellPx: 50, originPx: { x: 0, y: 0 } } });
    const scene = ev.changes.find((c) => c.key === `scene:${sceneId}`);
    assert.ok(scene && "value" in scene);
    assert.deepEqual((scene.value as { map: { widthPx: number; heightPx: number } }).map, { assetId: map.id, widthPx: 300, heightPx: 200, cellPx: 50, originPx: { x: 0, y: 0 } });
    const wrong = await s.apply({ t: "scene.setMap", sceneId, map: { assetId: token.id, widthPx: 7, heightPx: 7, cellPx: 50, originPx: { x: 0, y: 0 } } });
    assert.equal(wrong.rejects?.[0]?.code, "gone");
    const foreign = await s.apply({ t: "scene.setMap", sceneId, map: { assetId: uuidv7().replace(/^.{14}/, (m) => m.slice(0, 13) + "4"), widthPx: 7, heightPx: 7, cellPx: 50, originPx: { x: 0, y: 0 } } });
    assert.equal(foreign.rejects?.[0]?.code, "gone");
    s.close();
  });

  test("a player may use only assets they uploaded or can see", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Assets");
    const player = t.client();
    await player.join(roomId, "Pip");
    const theirs = await upload(player, roomId, "token", await solid(40, 40, "#36a").png().toBuffer());
    const dms = await upload(dm, roomId, "token", await solid(40, 40, "#a63").png().toBuffer());
    const dmSocket = await t.connect(roomId, dm);
    const sceneId = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const p = await t.connect(roomId, player);
    await p.snapshot("p");
    const mine = uuidv7();
    const memberId = (await player.me(roomId)).memberId!;
    await dmSocket.apply({ t: "token.create", token: { id: mine, sceneId, kind: "pc", name: "Pip", size: "medium", x: 1, y: 1, ownerIds: [memberId], actor: { inline: actor } } });
    await p.next("ev", (m) => m.changes.some((c) => c.key === `token:${mine}`));
    const ok = await p.apply({ t: "token.update", tokenId: mine, patch: { image: { assetId: theirs.id, crop: { cx: 0, cy: 0, zoom: 1 } } } });
    assert.equal(ok.rejects, undefined);
    const refused = await p.apply({ t: "token.update", tokenId: mine, patch: { image: { assetId: dms.id, crop: { cx: 0, cy: 0, zoom: 1 } } } });
    assert.equal(refused.rejects?.[0]?.code, "gone");
    // Once the DM puts that image on a visible token, the player may reuse it.
    const shown = uuidv7();
    await dmSocket.apply({ t: "token.create", token: { id: shown, sceneId, kind: "monster", name: "Orc", size: "medium", x: 3, y: 3, image: { assetId: dms.id, crop: { cx: 0, cy: 0, zoom: 1 } }, actor: { inline: actor } } });
    await p.next("ev", (m) => m.changes.some((c) => c.key === `token:${shown}`));
    const now = await p.apply({ t: "token.update", tokenId: mine, patch: { image: { assetId: dms.id, crop: { cx: 0, cy: 0, zoom: 1 } } } });
    assert.equal(now.rejects, undefined);
    assert.equal((await player.get(`/api/assets/${dms.id}/thumb`)).statusCode, 200);
    p.close();
    dmSocket.close();
  });

  /** Joins an imported room as the member named `name`, as "continue as" does. */
  async function continueAs(client: TestClient, roomId: string, name: string): Promise<string> {
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    const member = Object.values(rows[0]!.state.members).find((m) => m.name === name)!;
    const step1 = await client.post(`/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" });
    assert.equal(step1.statusCode, 200, step1.body);
    const done = await client.post(`/api/rooms/${roomId}/join/complete`, { ticket: step1.json<{ ticket: string }>().ticket, memberId: member.id });
    assert.equal(done.statusCode, 200, done.body);
    return member.id;
  }

  test("a hostile manifest cannot make a player the uploader of a thumbnail or a map, and no uploader row lets a player read one", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Uploader source");
    const pipId = await t.client().join(roomId, "Pip");
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200);
    const roomJson = (await unzip(res.rawPayload)).get("room.json")!;
    // Pip is named the uploader of a scene's thumbnail and of a map no scene shows, which only a hand-made file says.
    const images = { thumb: "a1", map: "b2", token: "c3" } as const;
    const files: Record<string, Buffer | string> = { "room.json": roomJson };
    const assets = [];
    for (const [kind, hex] of Object.entries(images)) {
      const sha = hex.repeat(32);
      files[`assets/${sha}-${kind}-full.webp`] = await solid(48, 32, `#${hex}${hex}${hex}`).png().toBuffer();
      assets.push({ id: `old-${kind}`, sha256: sha, kind, width: 48, height: 32, variants: ["full"], uploaders: [pipId] });
    }
    files["assets.json"] = JSON.stringify({ formatVersion: 1, assets });
    const importer = t.client();
    const imported = await importZip(importer, await zipOf(files));
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const rows = await t.pool.query<{ id: string; kind: string }>("select id, kind from assets where room_id = $1", [newId]);
    const idOf = (kind: string) => rows.rows.find((r) => r.kind === kind)!.id;
    const pip = t.client();
    const newPip = await continueAs(pip, newId, "Pip");
    const uploaded = await t.pool.query<{ kind: string; member_id: string }>(
      "select a.kind, u.member_id from asset_uploaders u join assets a on a.id = u.asset_id where a.room_id = $1",
      [newId],
    );
    assert.deepEqual(uploaded.rows, [{ kind: "token", member_id: newPip }], "only the kind a player can upload keeps its uploader");
    const listed = () => pip.get(`/api/rooms/${newId}/assets`).then((r) => r.json<{ assets: Array<{ kind: string }> }>().assets.map((a) => a.kind));
    assert.deepEqual(await listed(), ["token"]);
    assert.equal((await pip.get(`/api/assets/${idOf("token")}/full`)).statusCode, 200);
    for (const kind of ["thumb", "map"]) assert.equal((await pip.get(`/api/assets/${idOf(kind)}/full`)).statusCode, 404, kind);

    // An uploader row on a DM-only kind, as an import before this check could leave, still gives a player nothing.
    await t.pool.query("insert into asset_uploaders (asset_id, member_id) values ($1, $3), ($2, $3)", [idOf("thumb"), idOf("map"), newPip]);
    assert.deepEqual(await listed(), ["token"]);
    for (const kind of ["thumb", "map"]) assert.equal((await pip.get(`/api/assets/${idOf(kind)}/full`)).statusCode, 404, kind);
    // The DM reads them all.
    for (const kind of ["thumb", "map", "token"]) assert.equal((await importer.get(`/api/assets/${idOf(kind)}/full`)).statusCode, 200, kind);
  });

  test("a player's own token upload still reads after an export and import round trip", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Uploads travel");
    const player = t.client();
    await player.join(roomId, "Pip");
    // Uploaded and never placed, so only the upload lets Pip read it.
    await upload(player, roomId, "token", await solid(40, 40, "#c84").png().toBuffer());
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200);
    const importer = t.client();
    const imported = await importZip(importer, res.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const pip = t.client();
    await continueAs(pip, newId, "Pip");
    const listed = (await pip.get(`/api/rooms/${newId}/assets`)).json<{ assets: Array<{ id: string; kind: string }> }>().assets;
    assert.deepEqual(listed.map((a) => a.kind), ["token"]);
    assert.equal((await pip.get(`/api/assets/${listed[0]!.id}/full`)).statusCode, 200);
  });
});

describe("an imported log in the archive (shared/logRings.ts)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  /** An export of a new room whose log is `lines`, imported, as its new id and its importer. */
  async function importWithLog(lines: (i: number) => LogEntry, count: number): Promise<{ roomId: string; importer: TestClient }> {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Long log");
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    const dmId = Object.values(room.state.members).find((m) => m.kind === "dm")!.id;
    room.state.log = Array.from({ length: count }, (_, i) => ({ ...lines(i), from: dmId }));
    const importer = t.client();
    const imported = await importZip(importer, await zipOf({ "room.json": JSON.stringify(room) }));
    assert.equal(imported.statusCode, 201, imported.body);
    const { roomId: newId } = imported.json<{ roomId: string }>();
    t.track(newId);
    return { roomId: newId, importer };
  }

  /** Every line the archive's pages hold for a member, oldest first. */
  async function pages(client: TestClient, roomId: string): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    let before: string | null = null;
    for (let n = 0; n < 50; n++) {
      const res = await client.get(`/api/rooms/${roomId}/log?limit=100${before ? `&before=${before}` : ""}`);
      assert.equal(res.statusCode, 200, res.body);
      const page = res.json<{ entries: LogEntry[]; nextBefore: string | null }>();
      out.unshift(...page.entries);
      before = page.nextBefore;
      if (before === null) break;
    }
    return out;
  }

  test("an import writes its whole log to the archive with the room, so Show older reaches every line past the live log's 200", async () => {
    const { roomId, importer } = await importWithLog((i) => ({ id: `${i + 1}:0`, at: "2026-10-01T00:00:00.000Z", kind: "chat", text: `line ${i}` }), 250);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    assert.equal(rows[0]!.state.log.length, 200, "the room holds its newest 200");
    const archived = await pages(importer, roomId);
    assert.deepEqual(archived.map((e) => e.text), Array.from({ length: 250 }, (_, i) => `line ${i}`));
  });

  test("a room imported before imports wrote the archive gets its seq-0 lines there when it loads", async () => {
    const { roomId, importer } = await importWithLog((i) => ({ id: `${i + 1}:0`, at: "2026-10-01T00:00:00.000Z", kind: "chat", text: `line ${i}` }), 20);
    await t.pool.query("delete from room_log where room_id = $1", [roomId]);
    const socket = await t.connect(roomId, importer);
    await socket.snapshot("i");
    const { rows } = await t.pool.query<{ n: number }>("select count(*)::int as n from room_log where room_id = $1 and split_part(id, ':', 1) = '0'", [roomId]);
    assert.equal(rows[0]!.n, 20);
    socket.close();
  });

  test("a load writes no seq-0 line again once the archive holds the import's, so rows a snapshot pruned stay pruned", async () => {
    const { roomId, importer } = await importWithLog((i) => ({ id: `${i + 1}:0`, at: "2026-10-01T00:00:00.000Z", kind: "chat", text: `line ${i}` }), 20);
    // As a snapshot's prune takes the oldest rows past the stored cap.
    await t.pool.query("delete from room_log where room_id = $1 and id = any($2::text[])", [roomId, ["0:0", "0:1", "0:2"]]);
    const socket = await t.connect(roomId, importer);
    await socket.snapshot("i");
    const { rows } = await t.pool.query<{ n: number }>("select count(*)::int as n from room_log where room_id = $1 and split_part(id, ':', 1) = '0'", [roomId]);
    assert.equal(rows[0]!.n, 17);
    socket.close();
  });
});

describe("room import with Turnstile", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ env: { TURNSTILE_SECRET: "test-secret", TURNSTILE_SITE_KEY: "site-key" } });
  });
  after(() => t.close());

  test("a busy answer comes before the token is checked, so a retry can still spend it", async () => {
    const held: Array<() => void> = [];
    for (;;) {
      const release = t.app.assets.slots.tryAcquire({ kind: "roomImport", ip: "2001:db8::1", sessionId: "", pinned: false });
      if (!release) break;
      held.push(release);
    }
    const importer = t.client();
    const zip = await zipOf({ "room.json": "{}" });
    try {
      const busy = await importZip(importer, zip);
      assert.equal(busy.statusCode, 503);
      assert.equal(busy.json<{ error: string }>().error, "busy");
    } finally {
      for (const release of held) release();
    }
    const refused = await importZip(importer, zip);
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json<{ error: string }>().error, "turnstile_failed");
  });
});
