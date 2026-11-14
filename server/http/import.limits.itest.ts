import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import yauzl from "yauzl";
import yazl from "yazl";
import { uuidv7 } from "#shared/ids.ts";
import { FAR, LIMITS } from "#shared/limits.ts";
import type { Effect, RoomState } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "#shared/rules/hp.ts";
import { entry } from "#shared/testutil.ts";
import { CLOSE } from "../rooms/connection.ts";
import type { RoomExport } from "../rooms/exportRoom.ts";
import { fullRoom, markedRoom } from "../rooms/limitsTesting.ts";
import { startEngine, type Engine, type TestClient } from "../rooms/testing.ts";

/*
 * An import and the player limits (docs/design/design-v1-player-limits.md
 * 3.4, 8): a file comes by today's checks or by the far lines, every
 * condition but the bare automatic Unconscious gets a fresh id, and every
 * id the import made is recorded as the server's, so none can be brought
 * again while it is dated near the clock.
 */

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

function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.from(data), name);
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

describe("an import and the player limits", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ export: { perHour: 100 } });
  });
  after(() => t.close());

  async function exported(client: TestClient, name: string): Promise<{ roomId: string; file: RoomExport }> {
    const { roomId } = await client.createRoom(name);
    const res = await client.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    return { roomId, file: JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport };
  }

  async function importFile(file: RoomExport): Promise<{ status: number; roomId?: string; reason?: string }> {
    const fields = { playerPassword: "owlbear-druid-wand", dmName: "Importer" };
    const headers = { "content-type": "application/zip", "x-import-form": Buffer.from(JSON.stringify(fields)).toString("base64url") };
    const res = await t.client().request("POST", "/api/rooms/import", undefined, headers, await zipOf({ "room.json": JSON.stringify(file) }));
    if (res.statusCode !== 201) return { status: res.statusCode, reason: res.body };
    const roomId = res.json<{ roomId: string }>().roomId;
    t.track(roomId);
    return { status: 201, roomId };
  }

  async function stored(roomId: string): Promise<RoomState> {
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    return rows[0]!.state;
  }

  async function serverRows(roomId: string): Promise<Map<string, string>> {
    const { rows } = await t.pool.query<{ id: string; member_id: string }>("select id, member_id from room_ids where room_id = $1", [roomId]);
    return new Map(rows.map((r) => [r.id, r.member_id]));
  }

  test("a condition comes back under a fresh id the copy records as the server's, so the source's id is not the copy's", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Conditions");
    const socket = await t.connect(roomId, dm);
    const sceneId = ((await socket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const tokenId = uuidv7();
    const actor = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    await socket.apply({ t: "token.create", token: { id: tokenId, sceneId, kind: "monster", name: "Goblin", size: "small", x: 1, y: 1, ownerIds: [], actor: { inline: actor } } });
    const effectId = uuidv7();
    const added = await socket.apply({ t: "actor.effect.add", target: { tokenId }, effect: { id: effectId, key: "poisoned" } });
    assert.ok(added.acks?.length, JSON.stringify(added.rejects));
    socket.close();
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    const file = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    const copy = await importFile(file);
    assert.equal(copy.status, 201, copy.reason);
    const state = await stored(copy.roomId!);
    const goblin = Object.values(state.tokens).find((tk) => tk.name === "Goblin")!;
    const effects = "inline" in goblin.actor ? goblin.actor.inline.effects : [];
    assert.equal(effects.length, 1);
    assert.notEqual(effects[0]!.id, effectId);
    const rows = await serverRows(copy.roomId!);
    assert.equal(rows.get(effects[0]!.id), "server", "the copy's condition id is the server's");
    assert.equal(rows.get(goblin.id), "server", "and so is its creature's");
    assert.equal(rows.has(effectId), false, "the source's id is no row of the copy's");
  });

  test("a creature at both classes' caps with the automatic Unconscious comes back with 65, no id shared with its source but the automatic one", async () => {
    const { file } = await exported(t.client(), "Full classes");
    const sceneId = file.state.meta.playerSceneId!;
    const effects: Effect[] = [
      ...Array.from({ length: 32 }, (_, i): Effect => ({ id: uuidv7(), key: "custom", label: `Shown ${i}` })),
      ...Array.from({ length: 32 }, (_, i): Effect => ({ id: uuidv7(), key: "custom", label: `Hidden ${i}`, hiddenFromPlayers: true })),
      { id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" },
    ];
    const tokenId = uuidv7();
    const goblin = { id: tokenId, rev: 0, sceneId, kind: "monster", name: "Goblin", nameHidden: false, size: "small", x: 1, y: 1, elevation: 0, rotation: 0, disposition: "hostile", visibility: "all", fogExempt: false, fogExemptAuto: false, locked: false, layer: "token", ownerIds: [], hpVisibility: "label", actor: { inline: { hp: { cur: 0, max: 7, temp: 0 }, life: "dying", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects, deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" } } };
    const copy = await importFile({ ...file, state: { ...file.state, tokens: { ...file.state.tokens, [tokenId]: goblin as RoomState["tokens"][string] } } });
    assert.equal(copy.status, 201, copy.reason);
    const back = Object.values((await stored(copy.roomId!)).tokens).find((tk) => tk.name === "Goblin")!;
    const list = "inline" in back.actor ? back.actor.inline.effects : [];
    assert.equal(list.length, 65);
    const source = new Set(effects.map((e) => e.id));
    assert.deepEqual(list.filter((e) => source.has(e.id)).map((e) => e.id), [ZERO_HP_UNCONSCIOUS_ID]);
  });

  test("a fight past today's 2,000 rows comes back, and one past the far rows is refused as too big", async () => {
    const { file } = await exported(t.client(), "Rows");
    const fight = (rows: number): RoomExport => ({ ...file, state: { ...file.state, encounter: { rev: 0, round: 1, activeEntryId: null, entries: Array.from({ length: rows }, () => entry(uuidv7(), { label: "Lair" })) } } });
    const taken = await importFile(fight(LIMITS.encounterRows + 1));
    assert.equal(taken.status, 201, taken.reason);
    assert.equal((await stored(taken.roomId!)).encounter?.entries.length, LIMITS.encounterRows + 1);
    const refused = await importFile(fight(FAR.rows + 1));
    assert.equal(refused.status, 413, refused.reason);
  });

  test("a room at the far lines with 49 members comes back with what an import keeps", async () => {
    const { file } = await exported(t.client(), "Far");
    const full = fullRoom({ members: LIMITS.membersPerRoom - 1 });
    const copy = await importFile({ ...file, state: full.state, dmMemberIds: full.dms });
    assert.equal(copy.status, 201, copy.reason);
    const state = await stored(copy.roomId!);
    const counts = (s: RoomState) => [Object.keys(s.tokens).length, s.encounter?.entries.length, Object.keys(s.characters).length, Object.keys(s.drawings).length, Object.keys(s.companionBlocks).length, Object.keys(s.members).length];
    assert.deepEqual(counts(state), [...counts(full.state).slice(0, 5), LIMITS.membersPerRoom]);
  });

  test("a backup today's checks take comes back though the far line reads it past, with six players' widest maps", async () => {
    const { file } = await exported(t.client(), "Marked");
    const marked = markedRoom(96);
    assert.equal(marked.under, false);
    const copy = await importFile({ ...file, state: marked.state, dmMemberIds: [Object.values(marked.state.members).find((m) => m.kind === "dm")!.id] });
    assert.equal(copy.status, 201, copy.reason);
    assert.equal(Object.keys((await stored(copy.roomId!)).scenes).length, 20);
  });

  test("a device's ids ask reaches the room after its hello, and one before it closes the socket", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Ids ask");
    const early = await t.connect(roomId, dm);
    early.send({ t: "ids", k: 1, ids: [uuidv7()] });
    assert.equal((await early.waitClosed()).code, CLOSE.authFailure);
    const socket = await t.connect(roomId, dm);
    await socket.snapshot("dm");
    const id = uuidv7();
    socket.send({ t: "ids", k: 2, ids: [id] });
    const answer = await socket.next("ids", (m) => m.k === 2);
    assert.deepEqual([...answer.held, ...answer.notHeld, ...answer.pending], [id]);
    socket.close();
  });
});
