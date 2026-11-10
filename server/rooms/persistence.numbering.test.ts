import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { migrateOp, migrateSnapshot, NUMBERING_OP_VERSION, NUMBERING_SNAPSHOT_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import { tableNumber } from "#shared/numbering.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { meetCandidates, numberingUpgrade } from "#shared/reducer/numbering.ts";
import { character, DM, room, scene, token } from "#shared/testutil.ts";
import { exportableState, roomExport, type RoomExport } from "./exportRoom.ts";
import { withNumberingUpgrade } from "./importRoom.ts";
import { loadRoom, type Pool } from "./persistence.ts";
import { remapState } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

/*
 * The numbering upgrade on load and import (shared/reducer/numbering.ts):
 * over a snapshot from before creature numbers the table gives, it runs
 * once, just before the first stored op of op version 60, or after the last
 * op when none is that new, so the numbers it keeps are those players saw
 * once every older op replayed. A snapshot of today's version holds its
 * result, and an import carries the room's group count.
 */

/** Goblins 1 and 2 in the party's sight, Goblins 3 and 4 hidden. */
function old(): RoomState {
  return room({
    tokens: {
      a: token("a", { number: 1 }),
      b: token("b", { number: 2, x: 5 }),
      c: token("c", { number: 3, x: 7, visibility: "dm" }),
      d: token("d", { number: 4, x: 9, visibility: "dm" }),
    },
  });
}

type Row = { op: Op; version: number };

function pool(snapshot: { state: unknown; version: number }, rows: Row[]): Pool {
  const snap = { seq: "0", state: JSON.parse(JSON.stringify(snapshot.state)), schema_version: snapshot.version };
  const ops = rows.map((r, i) => ({ seq: String(i + 1), at: new Date(Date.UTC(2026, 10, 10, 12, 0, i)), actor_member_id: "dm1", actor_role: "dm", op: r.op, op_version: r.version, pub: i + 1 }));
  const query = (sql: string) => Promise.resolve({ rows: sql.includes("room_snapshots") ? [snap] : sql.includes("room_log") ? [{ held: true }] : ops });
  return { query, connect: () => Promise.reject(new Error("not used")) } as unknown as Pool;
}

async function load(snapshot: { state: unknown; version: number }, rows: Row[]): Promise<RoomState> {
  const reasons: string[] = [];
  const loaded = await loadRoom(pool(snapshot, rows), "R", (_seq, reason) => reasons.push(reason));
  assert.deepEqual(reasons, []);
  assert.ok(loaded && !loaded.replayFailed);
  return loaded.state;
}

/** A plain replay, with the upgrade where it belongs when `step`. */
function replayed(snapshot: { state: unknown; version: number }, rows: Row[], step: boolean): RoomState {
  let state = migrateSnapshot(JSON.parse(JSON.stringify(snapshot.state)), snapshot.version);
  let pending = step && snapshot.version < NUMBERING_SNAPSHOT_VERSION;
  for (const [i, r] of rows.entries()) {
    if (pending && r.version >= NUMBERING_OP_VERSION) {
      state = numberingUpgrade(state);
      pending = false;
    }
    const result = applyOp(state, migrateOp(r.op, r.version), DM, { seq: i + 1, at: new Date(Date.UTC(2026, 10, 10, 12, 0, i)).toISOString(), opVersion: r.version });
    assert.ok(result.ok, result.ok ? "" : result.message);
    state = result.state;
  }
  return pending ? numberingUpgrade(state) : state;
}

const shown = (id: string): Op => ({ t: "token.update", tokenId: id, patch: { visibility: "all" } });
const numbers = (state: RoomState) => Object.fromEntries(Object.values(state.tokens).map((t) => [t.id, tableNumber(state, t)]));

describe("the numbering upgrade on load", () => {
  test("runs after the older ops replay and before the first new one, so a creature an older op showed keeps its number and one a new op shows does not", async () => {
    const rows: Row[] = [
      { op: shown("c"), version: NUMBERING_OP_VERSION - 1 },
      { op: shown("d"), version: NUMBERING_OP_VERSION },
    ];
    const snapshot = { state: old(), version: NUMBERING_SNAPSHOT_VERSION - 1 };
    const state = await load(snapshot, rows);
    assert.deepEqual(state, replayed(snapshot, rows, true));
    assert.deepEqual(numbers(state), { a: 1, b: 2, c: 3, d: undefined });
  });

  test("runs after the last op when none is new, and a hidden creature keeps no number", async () => {
    const rows: Row[] = [{ op: { t: "token.update", tokenId: "a", patch: { x: 2 } }, version: NUMBERING_OP_VERSION - 1 }];
    const snapshot = { state: old(), version: NUMBERING_SNAPSHOT_VERSION - 1 };
    const state = await load(snapshot, rows);
    assert.deepEqual(state, replayed(snapshot, rows, true));
    assert.deepEqual(numbers(state), { a: 1, b: 2, c: undefined, d: undefined });
  });

  test("a reload before the next snapshot settles the same room", async () => {
    const snapshot = { state: old(), version: NUMBERING_SNAPSHOT_VERSION - 1 };
    const rows: Row[] = [{ op: shown("c"), version: NUMBERING_OP_VERSION }];
    assert.deepEqual(await load(snapshot, rows), await load(snapshot, rows));
  });

  test("a snapshot of today's version is never upgraded again", async () => {
    const state = await load({ state: old(), version: SNAPSHOT_VERSION }, []);
    assert.deepEqual(numbers(state), { a: undefined, b: undefined, c: undefined, d: undefined });
    assert.equal(state.numbering, undefined);
  });
});

describe("an import", () => {
  function throughFile(state: RoomState, version: number): RoomState {
    const file = JSON.parse(JSON.stringify({ ...roomExport("ABCDEFGH", 9, exportableState(state, DM), ["dm1"]), schemaVersion: version })) as RoomExport;
    const parsed = parseRoomState(migrateSnapshot(file.state, file.schemaVersion));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    return withNumberingUpgrade(remapState(parsed.state, { assets: new Map() }), version);
  }

  test("of a file from before settles its numbers on the players' scene", () => {
    const imported = throughFile(old(), NUMBERING_SNAPSHOT_VERSION - 1);
    assert.deepEqual(Object.values(imported.tokens).map((t) => tableNumber(imported, t)).sort(), [1, 2, undefined, undefined]);
  });

  test("keeps the room's group count, so a new group takes an id above every one the file holds", () => {
    const met = numberingUpgrade(old());
    const file = { ...met, numbering: { rev: 4, groups: 7 }, scenes: { ...met.scenes, s2: scene("s2", { order: 1 }) } };
    const imported = throughFile(file, SNAPSHOT_VERSION);
    assert.deepEqual(imported.numbering, { rev: 4, groups: 7 });
    assert.deepEqual(Object.values(imported.tokens).map((t) => tableNumber(imported, t)).sort(), [1, 2, undefined, undefined]);
  });

  test("keeps a numbered companion of a character no player plays whole, so the next batch gives no second 1", () => {
    const state = room();
    state.characters.cap = character("cap", { name: "Captain", ownerIds: [] });
    state.tokens.g1 = token("g1", { name: "Goblin", met: 1, number: 1 });
    state.tokens.g2 = token("g2", { name: "Goblin", met: 1, number: 2, x: 5, companion: { of: "cap", turn: "shared" } });
    state.scenes.s1 = { ...state.scenes.s1!, numbers: { names: { Goblin: [1, 2] } } };
    state.numbering = { rev: 0, groups: 1 };
    const imported = throughFile(state, SNAPSHOT_VERSION);
    const companion = Object.values(imported.tokens).find((t) => t.companion !== undefined)!;
    assert.deepEqual([companion.met, companion.number], [1, 2], "the companion keeps its mark and its number");
    assert.deepEqual(Object.values(imported.tokens).map((t) => tableNumber(imported, t)).sort(), [1, 2]);
    assert.deepEqual(meetCandidates(imported, Object.keys(imported.tokens).map((id) => `token:${id}` as const), {}), [], "the next batch has no one to meet");
  });
});
