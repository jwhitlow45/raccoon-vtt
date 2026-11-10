import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import yauzl from "yauzl";
import yazl from "yazl";
import { uuidv7 } from "#shared/ids.ts";
import { NUMBERING_OP_VERSION, NUMBERING_SNAPSHOT_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { RoomState, Token } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import type { RoomExport } from "./exportRoom.ts";
import { snapshotJson } from "./persistence.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/**
 * Creature numbers over Postgres: an old room's numbers settled at its
 * load and its first commit storing a snapshot at today's version with its
 * rows, a backup's group count kept across an import, and a DM's Undo of a
 * move to another scene that a meeting followed.
 */

const inline = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };

function goblin(id: string, sceneId: string, x: number, over: Partial<Token> = {}): Token {
  return { id, rev: 0, sceneId, kind: "monster", name: "Goblin", nameHidden: false, size: "medium", x, y: 2, elevation: 0, rotation: 0, disposition: "hostile", visibility: "all", fogExempt: false, fogExemptAuto: false, locked: false, layer: "token", ownerIds: [], actor: { inline: structuredClone(inline) } as Token["actor"], hpVisibility: "label", ...over };
}

const create = (t: Token): Op => {
  const { rev: _rev, fogExemptAuto: _auto, ...made } = t;
  return { t: "token.create", token: made } as Op;
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

describe("creature numbers over a stored room", () => {
  let t: Engine;
  let builds = 0;
  let failBuilds = 0;
  before(async () => {
    t = await startEngine({
      rooms: {
        idleUnloadMs: 60_000,
        actor: {
          snapshotOps: 1_000,
          snapshotIdleMs: 60_000,
          snapshotJson: (state: RoomState) => {
            builds++;
            if (failBuilds > 0) {
              failBuilds--;
              throw new Error("a build that fails on purpose");
            }
            return snapshotJson(state);
          },
        },
      },
    });
  });
  after(() => t.close());

  async function stateOf(roomId: string): Promise<RoomState> {
    const actor = await t.manager.acquire(roomId);
    return actor.read((s) => s);
  }

  async function opened(name: string): Promise<{ roomId: string; dm: Socket; owner: TestClient; mat: string; player: TestClient; playerId: string }> {
    const owner = t.client();
    const { roomId } = await owner.createRoom(name);
    const player = t.client();
    const playerId = await player.join(roomId, "Pat");
    const dm = await t.connect(roomId, owner);
    const mat = ((await dm.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    return { roomId, dm, owner, mat, player, playerId };
  }

  /** The room stored as a build before creature numbers stored it: its snapshot at the older format, with the creatures given. */
  async function storedOld(roomId: string, tokens: Token[]): Promise<number> {
    await t.manager.unload(roomId);
    const { rows } = await t.pool.query<{ state: RoomState; seq: string }>("select state, seq::text from room_snapshots where room_id = $1", [roomId]);
    const state = rows[0]!.state;
    for (const tok of tokens) state.tokens[tok.id] = tok;
    await t.pool.query("update room_snapshots set state = $2::jsonb, schema_version = $3 where room_id = $1", [roomId, JSON.stringify(state), NUMBERING_SNAPSHOT_VERSION - 1]);
    const tail = await t.pool.query<{ n: string }>("select count(*)::text as n from room_ops where room_id = $1 and seq > $2", [roomId, rows[0]!.seq]);
    assert.equal(tail.rows[0]!.n, "0", "the old room's snapshot is its newest");
    return Number(rows[0]!.seq);
  }

  test("K12, K43: an old room keeps the numbers players see, its first commit stores today's snapshot with its rows, and a build that fails holds the commit until one succeeds", async () => {
    const { roomId, dm, mat, player, owner } = await opened("Old numbers");
    dm.close();
    await dm.waitClosed();
    const ids = Array.from({ length: 6 }, () => uuidv7()).sort();
    const oldSeq = await storedOld(roomId, [
      goblin(ids[0]!, mat, 2, { number: 1 }),
      goblin(ids[1]!, mat, 4, { number: 2 }),
      ...[3, 4, 5, 6].map((n, i) => goblin(ids[2 + i]!, mat, 6 + i, { number: n, visibility: "dm" })),
    ]);
    const pat = await t.connect(roomId, player);
    const first = (await pat.snapshot("pat")).state as ProjectedState;
    const shown = Object.fromEntries(Object.values(first.tokens as Record<string, Partial<Token>>).filter((x) => x.number !== undefined).map((x) => [x.id, x.number]));
    assert.deepEqual(shown, { [ids[0]!]: 1, [ids[1]!]: 2 }, "P1's first snapshot carries the numbers players saw");
    assert.ok(!JSON.stringify(first).includes('"met"'), "and no group mark");
    // Nothing is stored at the load: the snapshot at today's version goes with the first commit.
    const loaded = await t.pool.query<{ schema_version: number }>("select schema_version from room_snapshots where room_id = $1", [roomId]);
    assert.equal(loaded.rows[0]!.schema_version, NUMBERING_SNAPSHOT_VERSION - 1);

    const again = await t.connect(roomId, owner);
    await again.snapshot("dm-again");
    builds = 0;
    failBuilds = 3;
    const fresh = goblin(uuidv7(), mat, 16);
    const answered = again.apply(create(fresh));
    // While the build fails, the batch waits and stores no row.
    while (builds < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    const waiting = await t.pool.query<{ n: string }>("select count(*)::text as n from room_ops where room_id = $1 and seq > $2", [roomId, oldSeq]);
    assert.equal(waiting.rows[0]!.n, "0", "no row while the build fails");
    const ev = await answered;
    assert.equal(ev.rejects, undefined, "the op is taken once a build succeeds");
    assert.equal(builds, 4, "the build was tried until it succeeded, once more than it failed");
    const stored = await t.pool.query<{ seq: string; schema_version: number }>("select seq::text, schema_version from room_snapshots where room_id = $1", [roomId]);
    assert.equal(stored.rows[0]!.schema_version, SNAPSHOT_VERSION, "the first commit stored today's snapshot");
    const newest = await t.pool.query<{ seq: string }>("select max(seq)::text as seq from room_ops where room_id = $1 and seq > $2 and op_version >= $3", [roomId, oldSeq, NUMBERING_OP_VERSION]);
    assert.equal(stored.rows[0]!.seq, newest.rows[0]!.seq, "in the transaction of the rows it holds");
    const after = await stateOf(roomId);
    assert.equal(after.tokens[fresh.id]?.number, 3, "the next Goblin met is 3");
    assert.equal(after.tokens[ids[2]!]?.met, undefined, "a hidden old number was not adopted");
    pat.close();
    again.close();
  });

  test("K43: a snapshot at a format past this build's own is refused, as an older build refuses today's", async () => {
    const { roomId, dm } = await opened("Too new");
    dm.close();
    await dm.waitClosed();
    await t.manager.unload(roomId);
    await t.pool.query("update room_snapshots set schema_version = $2 where room_id = $1", [roomId, SNAPSHOT_VERSION + 1]);
    await assert.rejects(t.manager.acquire(roomId), "a snapshot newer than the build is refused");
  });

  test("K37: a backup keeps the group count, new groups take ids past it, and a file whose count is below a group id is refused", async () => {
    const { roomId, dm, mat, owner } = await opened("Backup");
    const g = Array.from({ length: 2 }, () => uuidv7()).sort();
    await dm.apply(create(goblin(g[0]!, mat, 2)));
    await dm.apply(create(goblin(g[1]!, mat, 4)));
    dm.close();
    const res = await owner.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    const exported = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    assert.equal(exported.state.numbering?.groups, 1, "the file holds the group count");
    const file: RoomExport = { ...exported, state: { ...exported.state, numbering: { rev: 0, groups: 7 } } };
    const { state, roomId: copy, client } = await imported(file);
    assert.equal(state.numbering?.groups, 7, "the import keeps the count");
    const copyMat = state.meta.playerSceneId!;
    assert.deepEqual(Object.values(state.scenes[copyMat]!.numbers!.names), [[1, 2]], "the register comes back as it was");
    // A new name met in the copy takes a group past the count, and the Goblins keep theirs across a rename out of sight, a move to another scene and back, and a restart.
    const host = await t.connect(copy, client);
    await host.snapshot("host");
    const orcs = [uuidv7(), uuidv7()].sort();
    for (const [i, id] of orcs.entries()) assert.equal((await host.apply(create(goblin(id, copyMat, 8 + 2 * i, { name: "Orc" })))).rejects, undefined);
    // An import gives every creature a new id, so the Goblins go by their numbers.
    const goblins = Object.values(state.tokens).filter((x) => x.name === "Goblin").sort((x, y) => x.number! - y.number!).map((x) => x.id);
    const other = Object.keys(state.scenes).find((id) => id !== copyMat)!;
    const g2 = goblins[1]!;
    for (const op of [
      { t: "token.update", tokenId: g2, patch: { visibility: "dm" } },
      { t: "token.update", tokenId: g2, patch: { name: "Hobgoblin" } },
      { t: "token.update", tokenId: g2, patch: { sceneId: other, x: 3, y: 3 } },
      { t: "token.update", tokenId: g2, patch: { sceneId: copyMat, x: 4, y: 2 } },
      { t: "token.update", tokenId: g2, patch: { name: "Goblin" } },
      { t: "token.update", tokenId: g2, patch: { visibility: "all" } },
    ] as Op[]) {
      assert.equal((await host.apply(op)).rejects, undefined, JSON.stringify(op));
    }
    host.close();
    await t.restart();
    const after = await stateOf(copy);
    assert.equal(after.numbering?.groups, 8, "the Orcs took the group after the count");
    assert.deepEqual(after.scenes[copyMat]!.numbers!.names.Orc, [8, 2]);
    assert.deepEqual([after.tokens[orcs[0]!]?.number, after.tokens[orcs[1]!]?.number], [1, 2]);
    assert.deepEqual([after.tokens[goblins[0]!]?.number, after.tokens[g2]?.number], [1, 2], "the Goblins keep their numbers");
    // A file whose count is below a group id it holds.
    const broken: RoomExport = { ...exported, state: { ...exported.state, numbering: { rev: 0, groups: 0 } } };
    const refused = await importRequest(broken);
    assert.equal(refused.res.statusCode, 400, refused.res.body);
  });

  test("K38: the DM's Undo of a move to another scene where Goblin 2 was met brings it back as Goblin 2, Redo gives the other scene's number, and a note edit between keeps both taken", async () => {
    const { roomId, dm, mat } = await opened("Pose undo");
    const cave = uuidv7();
    assert.equal((await dm.apply({ t: "scene.create", scene: { id: cave, name: "Cave", bounds: { w: 20, h: 14 }, fogEnabled: false } })).rejects, undefined);
    const [g1, g2, h1, h2] = Array.from({ length: 4 }, () => uuidv7()).sort();
    for (const op of [create(goblin(g1!, mat, 2)), create(goblin(g2!, mat, 4)), create(goblin(h1!, cave, 2)), create(goblin(h2!, cave, 4)), { t: "room.setPlayerScene", sceneId: cave }] as Op[]) {
      assert.equal((await dm.apply(op)).rejects, undefined, JSON.stringify(op));
    }
    const read = async () => (await stateOf(roomId)).tokens[g2!]!;
    assert.equal((await read()).number, 2, "Goblin 2 on the mat");
    const goes = { t: "token.update", tokenId: g2!, patch: { sceneId: cave, x: 6, y: 2 } } as Op;
    for (const round of [1, 2]) {
      // A second trip is a new meeting there: the cave never gives a number twice.
      const caveNumber = round === 1 ? 3 : 4;
      assert.equal((await dm.apply(goes)).rejects, undefined);
      assert.deepEqual([(await read()).sceneId, (await read()).number], [cave, caveNumber], `round ${round}: met in the cave`);
      assert.equal((await dm.step("undo", "play")).rejects, undefined, `round ${round}: Undo taken`);
      assert.deepEqual([(await read()).sceneId, (await read()).number], [mat, 2], `round ${round}: back on the mat as Goblin 2`);
      const before = (await stateOf(roomId)).scenes[mat]!.numbers;
      if (round === 2) assert.equal((await dm.apply({ t: "token.update", tokenId: g2!, patch: { notes: "Watches the door." } } as Op)).rejects, undefined);
      assert.equal((await dm.step("redo", "play")).rejects, undefined, `round ${round}: Redo taken`);
      const there = await read();
      assert.deepEqual([there.sceneId, there.number], [cave, caveNumber], `round ${round}: the cave's number again`);
      if (round === 2) {
        assert.equal(there.notes, "Watches the door.", "the note edit kept");
        assert.equal((await dm.apply({ t: "token.update", tokenId: g2!, patch: { notes: "Asleep." } } as Op)).rejects, undefined);
        assert.equal((await dm.step("undo", "play")).rejects, undefined, "the next Undo taken");
        const back = await read();
        assert.deepEqual([back.sceneId, back.number, back.notes], [mat, 2, "Asleep."], "back as Goblin 2 with the newest note");
      } else {
        assert.deepEqual((await stateOf(roomId)).scenes[mat]!.numbers, before, "the mat's register stands");
        assert.equal((await dm.step("undo", "play")).rejects, undefined);
        assert.equal((await dm.step("redo", "play")).rejects, undefined);
        assert.equal((await dm.step("undo", "play")).rejects, undefined);
        assert.equal((await read()).sceneId, mat);
      }
    }
    dm.close();
  });

  async function importRequest(file: RoomExport) {
    const client = t.client();
    const fields = { playerPassword: "owlbear-druid-wand", dmName: "Importer" };
    const headers = { "content-type": "application/zip", "x-import-form": Buffer.from(JSON.stringify(fields)).toString("base64url") };
    const res = await client.request("POST", "/api/rooms/import", undefined, headers, await zipOf({ "room.json": JSON.stringify(file) }));
    return { res, client };
  }

  async function imported(file: RoomExport): Promise<{ state: RoomState; roomId: string; client: TestClient }> {
    const { res, client } = await importRequest(file);
    assert.equal(res.statusCode, 201, res.body);
    const roomId = res.json<{ roomId: string }>().roomId;
    t.track(roomId);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    return { state: rows[0]!.state, roomId, client };
  }
});
