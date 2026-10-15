import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createInitialState } from "#shared/initial.ts";
import { OP_VERSION, SNAPSHOT_VERSION, opMigrations, type MigrationStep } from "#shared/migrate.ts";
import type { Member, RoomState, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { stableStringify } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, actor, character, env, member, reveal, room, token } from "#shared/testutil.ts";
import { assetIdsOf, loadRoom, type Pool } from "./persistence.ts";

/**
 * Replay of stored ops (design 16.2), against a pool that answers the two
 * reads a load makes. The op below was stored under a looser name rule than
 * today's, which refuses line separators in names.
 */
const dm: Member = { id: "dm", rev: 0, name: "DM", color: "#f38400", kind: "dm", createdAt: "2026-10-12T00:00:00.000Z" };
const looseJoin = {
  t: "sys.memberJoin",
  member: { id: "p1", name: "Sa\u2028m", color: "#336699", kind: "player", createdAt: "2026-10-12T00:00:00.000Z" },
};

function pool(opVersion: number): Pool {
  const snapshot = { seq: "0", state: createInitialState({ roomName: "Old", dm }), schema_version: SNAPSHOT_VERSION };
  const row = { seq: "1", at: new Date("2026-10-12T00:00:01.000Z"), actor_member_id: "server", actor_role: "dm", op: looseJoin, op_version: opVersion };
  const query = (sql: string) => Promise.resolve({ rows: sql.includes("room_snapshots") ? [snapshot] : [row] });
  return { query, connect: () => Promise.reject(new Error("not used")) } as unknown as Pool;
}

describe("replaying stored ops", () => {
  test("an op stored under an older rule replays once a migration step brings it within today's", async () => {
    const reasons: string[] = [];
    const unmigrated = await loadRoom(pool(0), "R", (_seq, reason) => reasons.push(reason), [{ from: 0, to: 1, apply: (op) => op }, ...opMigrations]);
    assert.equal(unmigrated?.replayFailed, true);
    assert.match(reasons[0] ?? "", /does not validate/);

    const steps: MigrationStep[] = [
      {
        from: 0,
        to: 1,
        apply: (op) => {
          const join = op as typeof looseJoin;
          return { ...join, member: { ...join.member, name: join.member.name.replace(/[\u2028\u2029]/g, " ") } };
        },
      },
      ...opMigrations,
    ];
    const migrated = await loadRoom(pool(0), "R", undefined, steps);
    assert.equal(migrated?.replayFailed, false);
    assert.equal(migrated?.state.members.p1?.name, "Sa m");
  });

  test("a snapshot written before custom monsters loads with none, and its ops replay on top", async () => {
    const { monsters: _monsters, ...v1 } = createInitialState({ roomName: "Old", dm });
    const row = { seq: "1", at: new Date("2026-10-12T00:00:01.000Z"), actor_member_id: "server", actor_role: "dm", op: { ...looseJoin, member: { ...looseJoin.member, name: "Sam" } }, op_version: 1 };
    const query = (sql: string) => Promise.resolve({ rows: sql.includes("room_snapshots") ? [{ seq: "0", state: v1, schema_version: 1 }] : [row] });
    const loaded = await loadRoom({ query, connect: () => Promise.reject(new Error("not used")) } as unknown as Pool, "R");
    assert.equal(loaded?.replayFailed, false);
    assert.deepEqual(loaded?.state.monsters, {});
    assert.equal(loaded?.state.members.p1?.name, "Sam");
  });

  test("a room from before who may move any token loads with the switch's answer, and its older settings changes and their undo replay", async () => {
    // The snapshot and the ops as an older build stored them, with the switch.
    const { playersMoveAny: _new, ...settings } = room().meta.settings;
    const old = { ...room(), meta: { ...room().meta, settings: { ...settings, playersMoveAnyToken: true } } } as unknown as RoomState;
    const turnOff = { t: "room.update", settings: { playersMoveAnyToken: false } } as unknown as Op;
    const off = applyOp(old, turnOff, { memberId: "dm1", role: "dm" }, env(1));
    assert.ok(off.ok);
    const undo = { t: "sys.restore", entries: off.inverse!, from: "undo", deps: true };
    const rows = [turnOff, undo, { t: "view.follow", follow: true }].map((op, i) => ({ seq: String(i + 1), at: new Date(env(i + 1).at), actor_member_id: "dm1", actor_role: "dm", op, op_version: 1 }));
    const query = (sql: string) => Promise.resolve({ rows: sql.includes("room_snapshots") ? [{ seq: "0", state: old, schema_version: 3 }] : rows });
    const reasons: string[] = [];
    const loaded = await loadRoom({ query, connect: () => Promise.reject(new Error("not used")) } as unknown as Pool, "R", (_seq, reason) => reasons.push(reason));
    assert.deepEqual(reasons, []);
    assert.equal(loaded?.replayFailed, false);
    assert.equal(loaded?.seq, 3);
    assert.equal(loaded?.state.meta.settings.playersMoveAny, "all", "the undo put the switch's on back, as every player");
    assert.equal("playersMoveAnyToken" in (loaded?.state.meta.settings ?? {}), false);
    assert.equal(loaded?.state.meta.view.follow, true);
  });

  test("an op with no migration path stops the replay read-only rather than failing the load", async () => {
    const reasons: string[] = [];
    const loaded = await loadRoom(pool(7), "R", (_seq, reason) => reasons.push(reason));
    assert.equal(loaded?.replayFailed, true);
    assert.equal(loaded?.seq, 0);
    assert.match(reasons[0] ?? "", /cannot be migrated/);
  });

  test("a restore stored before restores checked references replays as it applied, and only a marked one is checked", async () => {
    // Another DM put a token on the new scene, then the first DM undid the scene's creation.
    // The older build accepted that undo and stranded the token, and the op log holds it.
    const A: Viewer = { memberId: "dmA", role: "dm" };
    const B: Viewer = { memberId: "dmB", role: "dm" };
    const snapshot = room({ members: { dmA: member("dmA", "dm"), dmB: member("dmB", "dm") } });
    const load = async (deps: boolean) => {
      let state: RoomState = snapshot;
      const rows: unknown[] = [];
      const store = (op: Op, who: Viewer) => {
        rows.push({ seq: String(rows.length + 1), at: new Date(env(rows.length + 1).at), actor_member_id: who.memberId, actor_role: who.role, op, op_version: OP_VERSION });
      };
      const act = (op: Op, who: Viewer) => {
        const r = applyOp(state, op, who, env(rows.length + 1));
        assert.ok(r.ok);
        state = r.state;
        store(op, who);
        return r.inverse ?? [];
      };
      const created = act({ t: "scene.create", scene: { id: "crypt", name: "Crypt", bounds: { w: 30, h: 30 } } }, A);
      act({ t: "token.create", token: { id: "rat", sceneId: "crypt", kind: "monster", name: "Rat", size: "tiny", x: 1, y: 1, actor: { inline: actor() } } }, B);
      store({ t: "sys.restore", entries: created, from: "undo", ...(deps ? { deps: true as const } : {}) }, A);
      store({ t: "log.chat", text: "after the undo" }, B);
      const query = (sql: string) => Promise.resolve({ rows: sql.includes("room_snapshots") ? [{ seq: "0", state: snapshot, schema_version: SNAPSHOT_VERSION }] : rows });
      const reasons: string[] = [];
      const loaded = await loadRoom({ query, connect: () => Promise.reject(new Error("not used")) } as unknown as Pool, "R", (_seq, reason) => reasons.push(reason));
      return { loaded, reasons };
    };

    const legacy = await load(false);
    assert.deepEqual(legacy.reasons, []);
    assert.equal(legacy.loaded?.replayFailed, false, "the room stays writable");
    assert.equal(legacy.loaded?.seq, 4);
    assert.equal(legacy.loaded?.state.scenes.crypt, undefined);
    assert.equal(legacy.loaded?.state.tokens.rat?.sceneId, "crypt", "the token the older build stranded");

    const marked = await load(true);
    assert.equal(marked.loaded?.replayFailed, true);
    assert.equal(marked.loaded?.seq, 2);
    assert.match(marked.reasons[0] ?? "", /op 3 \(sys\.restore\) was refused on replay: other work depends on it/);
  });
});

describe("replaying ops stored before op version 4", () => {
  /*
   * A hidden creature revealed on its turn in the fog, its move undone and
   * made again, a hit, and a turn passed and taken back. The build before
   * op version 4 marked the creature seen wherever it stood, and its
   * restore's guard hashes the token as the move left it, path marks and
   * all.
   */
  const ops: Op[] = [
    { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }] },
    { t: "encounter.next" },
    { t: "encounter.next" },
    { t: "token.move", tokenId: "gob1", x: 29, y: 20 },
    { t: "token.move", tokenId: "gob1", x: 28, y: 20 },
    { t: "actor.hp", target: { tokenId: "gob1" }, change: { kind: "damage", amount: 3 } },
    { t: "encounter.next" },
    { t: "encounter.prev" },
  ];

  function snapshot(): RoomState {
    const state = room({ characters: { c1: character("c1", { ownerIds: ["p1"] }) } });
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    state.tokens.pc1 = token("pc1", { kind: "pc", name: "Ayla", actor: { ref: "c1" }, x: 1, y: 1 });
    state.tokens.gob1 = token("gob1", { name: "Lurker", x: 30, y: 20, visibility: "dm" });
    reveal(state, "s1", { x: 0, y: 0, w: 4, h: 4 });
    return state;
  }

  /** The rows that build stored, the first move undone right away, and the state it made. */
  function stored(opVersion: number): { rows: unknown[]; made: RoomState } {
    let state = snapshot();
    const rows: unknown[] = [];
    const act = (op: Op) => {
      const seq = rows.length + 1;
      const r = applyOp(state, op, DM, { ...env(seq), opVersion: 3 });
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      state = r.state;
      rows.push({ seq: String(seq), at: new Date(env(seq).at), actor_member_id: DM.memberId, actor_role: DM.role, op, op_version: opVersion });
      return r;
    };
    for (const [i, op] of ops.entries()) {
      const r = act(op);
      if (i === 3) act({ t: "sys.restore", entries: r.inverse!, from: "undo", deps: true });
    }
    return { rows, made: state };
  }

  async function replay(rows: unknown[]): Promise<{ loaded: Awaited<ReturnType<typeof loadRoom>>; reasons: string[] }> {
    const query = (sql: string) => Promise.resolve({ rows: sql.includes("room_snapshots") ? [{ seq: "0", state: snapshot(), schema_version: SNAPSHOT_VERSION }] : rows });
    const reasons: string[] = [];
    const loaded = await loadRoom({ query, connect: () => Promise.reject(new Error("not used")) } as unknown as Pool, "R", (_seq, reason) => reasons.push(reason));
    return { loaded, reasons };
  }

  test("replay to the very state they made, the revealed creature marked seen in the fog as that build showed it", async () => {
    const { rows, made } = stored(3);
    const { loaded, reasons } = await replay(rows);
    assert.deepEqual(reasons, []);
    assert.equal(loaded?.replayFailed, false, "the undo's guard still matches");
    assert.equal(loaded?.seq, rows.length);
    assert.ok(loaded);
    assert.equal(stableStringify(loaded.state), stableStringify(made));
    const state = loaded.state;
    assert.equal(state.tokens.gob1!.fogExemptAuto, true);
    assert.equal(state.encounter!.turnStart!.seen, true);
    assert.deepEqual(state.tokens.gob1!.path!.stops.map((stop) => stop.seen), [true, true]);
    const marks = state.log.flatMap((e) => (e.data?.type === "turn" || e.data?.type === "hp" ? [e.data.seen ?? false] : []));
    assert.deepEqual(marks, [true, true, true, true, true]);
  });

  test("a player's guarded Next on a row of their character's, whose token is a revealed creature in the fog, ends the turn as it did then", async () => {
    // The row names the monster's token and the player's character, which the protocol allows. That build's player
    // saw the row, so their press ended the turn. Today they would not see it, and the press would move nothing.
    const start = room({ characters: { c1: character("c1", { ownerIds: ["p1"] }) } });
    start.scenes.s1 = { ...start.scenes.s1!, fogEnabled: true };
    start.tokens.pc = token("pc", { kind: "pc", actor: { ref: "c1" }, x: 1, y: 1 });
    start.tokens.lurker = token("lurker", { x: 20, y: 20, visibility: "dm" });
    reveal(start, "s1", { x: 0, y: 0, w: 6, h: 6 });
    const pressed: [Op, Viewer][] = [
      [{ t: "encounter.start", entries: [{ id: "e-pc", tokenId: "pc", value: 20 }, { id: "e-l", tokenId: "lurker", characterId: "c1", value: 10, hidden: true }] }, DM],
      [{ t: "encounter.next" }, DM],
      [{ t: "encounter.next" }, DM],
      [{ t: "encounter.next", from: { entry: "e-l", round: 1 } }, { memberId: "p1", role: "player" }],
    ];
    const load = async (opVersion: number) => {
      const rows = pressed.map(([op, who], i) => ({ seq: String(i + 1), at: new Date(env(i + 1).at), actor_member_id: who.memberId, actor_role: who.role, op, op_version: opVersion }));
      const query = (sql: string) => Promise.resolve({ rows: sql.includes("room_snapshots") ? [{ seq: "0", state: start, schema_version: SNAPSHOT_VERSION }] : rows });
      const loaded = await loadRoom({ query, connect: () => Promise.reject(new Error("not used")) } as unknown as Pool, "R");
      assert.ok(loaded && !loaded.replayFailed);
      assert.equal(loaded.state.tokens.lurker!.fogExemptAuto, true);
      return loaded.state.encounter!;
    };
    assert.deepEqual(await load(3).then((e) => [e.activeEntryId, e.round]), ["e-pc", 2]);
    assert.deepEqual(await load(4).then((e) => [e.activeEntryId, e.round]), ["e-l", 1]);
  });

  test("would not, run by today's rule: the undo's guard no longer matches, which is why replay passes the stored version", async () => {
    const { reasons, loaded } = await replay(stored(4).rows);
    assert.equal(loaded?.replayFailed, true);
    assert.match(reasons[0] ?? "", /op 5 \(sys\.restore\) was refused on replay/);
  });
});

describe("asset ids an op names", () => {
  test("a scene's thumbnail is looked up with every assetId, a phase's and a stamp's included", () => {
    const a = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const b = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const c = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
    assert.deepEqual(assetIdsOf({ t: "scene.update", sceneId: "s", patch: { thumb: a.toUpperCase(), phases: [{ id: "p", name: "Day", assetId: b, widthPx: 1, heightPx: 1 }] } }), [a, b]);
    assert.deepEqual(assetIdsOf({ t: "build.stamps", sceneId: "s", put: [{ id: "st", art: { assetId: c } }] }), [c]);
    assert.deepEqual(assetIdsOf({ t: "scene.update", sceneId: "s", patch: { thumb: "not-a-uuid" } }), []);
  });
});
