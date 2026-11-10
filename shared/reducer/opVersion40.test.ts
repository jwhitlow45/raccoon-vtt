import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadRoom, type Pool } from "#server/rooms/persistence.ts";
import { SNAPSHOT_VERSION } from "../migrate.ts";
import type { RoomState, Viewer } from "../model.ts";
import { hash128, projectState, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp, type Applied, type Env } from "../reducer.ts";
import { ownEntry, readsOwnKeys, withRecordReads } from "../records.ts";
import { storedFogOff } from "../secretDoorTestutil.ts";
import { DM, P1, P2, room, token } from "../testutil.ts";

/**
 * Ops stored at op version 40 or lower that named a member of
 * Object.prototype replay as the build before own-key reads applied them
 * (records.ts readsOwnKeys), junk included: the ops and undos stored after
 * them were applied to what they wrote. Each sequence here is one a review
 * found broken by replaying such an op as a step that changes nothing
 * (FU48-ASTRA-01, FU48-SR-001), loaded through `loadRoom` from a snapshot
 * taken before, between and after its ops. The hashes are what that build
 * (5948c7e0) left, its state after each op and the players' copies of the
 * room at the end.
 */

const STORED = 40;
const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
const hashOf = (value: unknown) => hash128(stableStringify(value));
const start = () => room({ tokens: { real: token("real", { x: 2, y: 2 }), other: token("other", { x: 6, y: 6 }) } });

type Stored = Op | ((before: Applied) => Op);
/** The restore an undo of the op before stored, built as the server builds one from that op's inverse. */
const undoOfLast: Stored = (before) => ({ t: "sys.restore", entries: before.inverse!, from: "undo", deps: true });

const SEQUENCES: { name: string; ops: Stored[]; steps: string[]; /** Either player's copy of the room at the end: neither owns a token, so the two are alike. */ players: string }[] = [
  {
    name: "a delete of many that named a real token and \"constructor\" deletes the real one",
    ops: [{ t: "token.deleteMany", tokenIds: ["real", "constructor"] }],
    steps: ["78e1bf1f4bcb0061f2e4aaca6039baf1"],
    players: "e84f0e82551f835ab95c279856778446",
  },
  {
    name: "an update of many that hid a real token and \"constructor\" hides the real one",
    ops: [{ t: "token.updateMany", tokenIds: ["real", "constructor"], patch: { visibility: "dm" } }],
    steps: ["fd8de7c7f3fcf26f9ab499bbd94414ae"],
    players: "e84f0e82551f835ab95c279856778446",
  },
  {
    name: "an update of \"constructor\" writes the token keyed \"undefined\" a later delete names",
    ops: [{ t: "token.update", tokenId: "constructor", patch: { name: "X" } }, { t: "token.delete", tokenId: "undefined" }],
    steps: ["65bee1b8977c48e1ddbf8f6ba2ba4ab1", "1ad0aa7a82c2c5099313c29d18ca247b"],
    players: "7db3273f5a737bda3cf2912f131bf694",
  },
  {
    name: "an update of \"constructor\" and its undo",
    ops: [{ t: "token.update", tokenId: "constructor", patch: { name: "X" } }, undoOfLast],
    steps: ["65bee1b8977c48e1ddbf8f6ba2ba4ab1", "1ad0aa7a82c2c5099313c29d18ca247b"],
    players: "7db3273f5a737bda3cf2912f131bf694",
  },
  {
    name: "the players moved to scene \"constructor\" and that undone, whose guard hashes the meta the move wrote",
    ops: [{ t: "room.setPlayerScene", sceneId: "constructor" }, undoOfLast],
    steps: ["90905b83dc38fd491c7690022f3cb3b1", "50b214e679cc7707ea4f1bbf6469d451"],
    players: "7db3273f5a737bda3cf2912f131bf694",
  },
];

type Row = { seq: string; at: Date; actor_member_id: string; actor_role: Viewer["role"]; op: unknown; op_version: number };

/** The ops as the server stored them, and the room after each, applied by the rules of their version. */
function stored(ops: Stored[], who: Viewer = DM): { rows: Row[]; states: RoomState[] } {
  let state = start();
  const states = [state];
  const rows: Row[] = [];
  let last: Applied | null = null;
  for (const [i, item] of ops.entries()) {
    const op = typeof item === "function" ? item(last!) : item;
    const result = applyOp(state, op, who, { seq: i + 1, at: at(i), opVersion: STORED });
    assert.ok(result.ok, `${op.t} applies by the rules of version ${STORED}`);
    rows.push({ seq: String(i + 1), at: new Date(at(i)), actor_member_id: who.memberId, actor_role: who.role, op: JSON.parse(JSON.stringify(op)), op_version: STORED });
    last = result;
    state = result.state;
    states.push(state);
  }
  return { rows, states };
}

/** Loads a room from the snapshot taken after `taken` ops and the rows after it, as a database holds them. */
async function load(rows: Row[], states: RoomState[], taken: number): Promise<{ loaded: NonNullable<Awaited<ReturnType<typeof loadRoom>>>; reasons: string[] }> {
  const snapshot = { seq: String(taken), state: JSON.parse(JSON.stringify(states[taken])), schema_version: SNAPSHOT_VERSION, imported_seq: null };
  const query = (sql: string) => Promise.resolve({ rows: sql.includes("room_snapshots") ? [snapshot] : rows.slice(taken) });
  const reasons: string[] = [];
  const loaded = await loadRoom({ query, connect: () => Promise.reject(new Error("not used")) } as unknown as Pool, "R", (_seq, reason) => reasons.push(reason));
  assert.ok(loaded);
  return { loaded, reasons };
}

// Read as players got scenes with fog off when the hashes were recorded, before D-261110-530 (storedFogOff).
const playersOf = (state: RoomState) => [P1, P2].map((viewer) => hashOf(storedFogOff(state, projectState(state, viewer, { sceneId: null }))));

describe("ops stored at version 40 that named Object.prototype's members (FU48-ASTRA-01, FU48-SR-001)", () => {
  for (const sequence of SEQUENCES) {
    test(`${sequence.name}, loaded from a snapshot before, between and after its ops`, async () => {
      const { rows, states } = stored(sequence.ops);
      assert.deepEqual(states.slice(1).map(hashOf), sequence.steps, "each op leaves the room the build before own-key reads left");
      for (let taken = 0; taken <= rows.length; taken++) {
        const { loaded, reasons } = await load(rows, states, taken);
        assert.deepEqual(reasons, [], `the room loads from the snapshot after ${taken} ops`);
        assert.equal(loaded.replayFailed, false);
        assert.equal(loaded.seq, rows.length);
        assert.equal(hashOf(loaded.state), sequence.steps.at(-1), `the snapshot after ${taken} ops gives the same room`);
        assert.deepEqual(playersOf(loaded.state), [sequence.players, sequence.players], `the players' copies from the snapshot after ${taken} ops are the build's`);
      }
    });
  }

  test("what the players see: the deleted and the hidden token never reach them, and an undone move takes them back", async () => {
    const seen = (state: RoomState) => Object.keys(projectState(state, P1, { sceneId: null }).tokens);
    assert.deepEqual(seen(start()).sort(), ["other", "real"]);
    const [deleted, hidden, , , moved] = await Promise.all(SEQUENCES.map(async (s) => {
      const { rows, states } = stored(s.ops);
      return (await load(rows, states, 0)).loaded.state;
    }));
    assert.equal(ownEntry(deleted!.tokens, "real"), undefined);
    assert.deepEqual(seen(deleted!), ["other"]);
    assert.equal(ownEntry(hidden!.tokens, "real")?.visibility, "dm");
    assert.deepEqual(seen(hidden!), ["other"]);
    assert.equal(moved!.meta.playerSceneId, "s1");
    assert.deepEqual(seen(moved!).sort(), ["other", "real"]);
  });

  test("a stored op today's reducer refuses still stops the room, whatever names it holds", async () => {
    // Free text that names a member, which no rule reads as an id, under an op refused for its own reason.
    const { rows, states } = stored([{ t: "token.update", tokenId: "real", patch: { name: "constructor" } }]);
    rows.push({ ...rows[0]!, seq: "2", op: { t: "token.update", tokenId: "gone", patch: { name: "constructor" } } });
    const { loaded, reasons } = await load(rows, states, 0);
    assert.equal(loaded.replayFailed, true);
    assert.equal(loaded.seq, 1);
    assert.deepEqual(reasons, ["op 2 (token.update) was refused on replay: token is not here"]);
  });
});

describe("the version that reads records by own key (records.ts readsOwnKeys)", () => {
  const live: Env = { seq: 2, at: at(2) };
  const update: Op = { t: "token.update", tokenId: "constructor", patch: { name: "X" } };

  test("version 40 and below read as the build before, 41 and live ops by own key", () => {
    assert.deepEqual([undefined, 1, 39, 40, 41, 42].map(readsOwnKeys), [true, false, false, false, true, true]);
    assert.equal(applyOp(start(), update, DM, { ...live, opVersion: 40 }).ok, true);
    for (const env of [live, { ...live, opVersion: 41 }]) {
      const result = applyOp(start(), update, DM, env);
      assert.deepEqual(result.ok ? null : result.message, "token is not here", `opVersion ${env.opVersion ?? "live"} finds only the room's own tokens`);
    }
  });

  test("the reads go back to own keys after an older op, whether it applied, refused or threw", () => {
    const state = start();
    const after = () => {
      const result = applyOp(state, update, DM, live);
      assert.equal(result.ok, false, "a live op that names \"constructor\" still finds no token");
      assert.equal(ownEntry(state.tokens, "constructor"), undefined);
    };
    assert.ok(applyOp(state, update, DM, { ...live, opVersion: STORED }).ok);
    after();
    assert.equal(applyOp(state, { t: "token.delete", tokenId: "gone" }, DM, { ...live, opVersion: STORED }).ok, false);
    after();
    // An actor named "constructor" on the build before was Object, whose missing HP threw. Such an op was never stored.
    assert.throws(() => applyOp(state, { t: "actor.hp", target: { tokenId: "constructor" }, change: { kind: "damage", amount: 3 } }, DM, { ...live, opVersion: STORED }));
    after();
  });

  test("a read inside an older op's apply, nested or after a nested one, keeps the rule of the apply around it", () => {
    const empty: Record<string, unknown> = {};
    const read = () => ownEntry(empty, "constructor");
    assert.equal(read(), undefined);
    // The trap step applies the op again without its traps, inside the op's own apply (reducer.ts applyOnce).
    const outer = withRecordReads(STORED, () => {
      const inner = withRecordReads(STORED, read);
      const live = withRecordReads(undefined, read);
      return [inner, live, read()];
    });
    assert.deepEqual(outer, [Object, undefined, Object]);
    assert.equal(read(), undefined);
  });

  test("the undo of an older op is worked out by the op's rules, after the op has returned", () => {
    const result = applyOp(start(), { t: "drawing.delete", drawingId: "constructor" }, DM, { ...live, opVersion: STORED });
    assert.ok(result.ok);
    // The build before found Object's constructor still there after the delete and guarded the undo by its hash. Read by own key, it would guard the drawing as absent.
    assert.deepEqual(result.inverse, [{ key: "drawing:constructor", value: Object, expectHash: "2adb43e0dbee2542dc1e519bdc1e519b" }]);
  });
});
