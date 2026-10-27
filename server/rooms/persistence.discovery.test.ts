import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { room, scene } from "#shared/testutil.ts";
import { loadRoom, type Pool } from "./persistence.ts";

/**
 * The map discovery upgrade step on load (docs/design-v1-map-discovery.md
 * 5.5, ASTRA-31, section 10's S3 row), against a pool that answers the two
 * reads a load makes: over a snapshot from before it, the step runs once,
 * over everything stored before it, so a scene older ops made and moved
 * the players to is marked, and never again once a snapshot holds it.
 */

/** A room as a build before map discovery stored it: none of the four collections. */
function before(): RoomState {
  const { memory: _m, memoryBy: _b, playedScenes: _p, memoryShared: _s, ...v26 } = room();
  return v26 as RoomState;
}

const S3 = { id: "s3", name: "Crypt", bounds: { w: 32, h: 32 }, fogEnabled: true, vision: { on: true, light: "dark" as const } };
const bits = Object.values(rasterizeFogOps({}, "s3", S3.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 4, h: 4 } }]))[0]!.bits;
/** An old log: S3 made, the players moved there, its ground explored, and the players moved away. */
const OLD: Op[] = [
  { t: "scene.create", scene: S3 },
  { t: "room.setPlayerScene", sceneId: "s3" },
  { t: "sys.explore", sceneId: "s3", tiles: [{ tx: 0, ty: 0, bits }] },
  { t: "room.setPlayerScene", sceneId: "s1" },
];
/** Newer ops: S4 made and never played, S5 made and the players moved there. */
const NEW: Op[] = [
  { t: "scene.create", scene: { id: "s4", name: "Hall", bounds: { w: 20, h: 20 }, fogEnabled: true, vision: { on: true, light: "dim" } } },
  { t: "scene.create", scene: { id: "s5", name: "Tower", bounds: { w: 20, h: 20 } } },
  { t: "room.setPlayerScene", sceneId: "s5" },
];

type Row = { op: Op; version: number };

function pool(snapshot: { state: unknown; version: number; seq?: number }, rows: Row[]): Pool {
  const start = snapshot.seq ?? 0;
  const snap = { seq: String(start), state: JSON.parse(JSON.stringify(snapshot.state)), schema_version: snapshot.version };
  const ops = rows.map((r, i) => ({ seq: String(start + i + 1), at: new Date(Date.UTC(2026, 9, 26, 20, 0, i)), actor_member_id: "dm1", actor_role: "dm", op: r.op, op_version: r.version }));
  const query = (sql: string) => Promise.resolve({ rows: sql.includes("room_snapshots") ? [snap] : sql.includes("room_log") ? [{ held: true }] : ops });
  return { query, connect: () => Promise.reject(new Error("not used")) } as unknown as Pool;
}

async function load(snapshot: { state: unknown; version: number; seq?: number }, rows: Row[]): Promise<RoomState> {
  const reasons: string[] = [];
  const loaded = await loadRoom(pool(snapshot, rows), "R", (_seq, reason) => reasons.push(reason));
  assert.deepEqual(reasons, []);
  assert.ok(loaded && !loaded.replayFailed);
  return loaded.state;
}

const marks = (state: RoomState) => Object.fromEntries(Object.entries(state.playedScenes ?? {}).map(([id, m]) => [id, m.rev]));

describe("the map discovery upgrade step on load (ASTRA-31)", () => {
  test("an old snapshot and old ops only: the step runs after the last op, so the scene they made and played is marked", async () => {
    const state = await load({ state: before(), version: 26 }, OLD.map((op) => ({ op, version: 25 })));
    assert.equal(state.meta.playerSceneId, "s1");
    // Every mark the step's own, at rev 0: the old moves of the players marked nothing (MD-R6-1).
    assert.deepEqual(marks(state), { s1: 0, s2: 0, s3: 0 });
    assert.deepEqual(Object.keys(state.memoryShared ?? {}), ["s3"]);
    assert.deepEqual([state.memory, state.memoryBy], [{}, {}]);
  });

  test("then newer ops: the step runs just before the first of them, and the scenes they make keep their own rules", async () => {
    const state = await load({ state: before(), version: 26 }, [...OLD.map((op) => ({ op, version: 25 })), ...NEW.map((op) => ({ op, version: 26 }))]);
    // S4 came after the step and was never the players' scene. S5 is marked by the move to it, not by the step.
    assert.deepEqual(marks(state), { s1: 0, s2: 0, s3: 0, s5: 1 });
    assert.deepEqual(Object.keys(state.memoryShared ?? {}), ["s3"]);
  });

  test("a reload from a snapshot written after the step never runs it again", async () => {
    const upgraded = await load({ state: before(), version: 26 }, [...OLD.map((op) => ({ op, version: 25 })), ...NEW.map((op) => ({ op, version: 26 }))]);
    const later: Op[] = [{ t: "scene.create", scene: { id: "s6", name: "Cellar", bounds: { w: 10, h: 10 } } }, { t: "log.chat", text: "hi" }];
    const state = await load({ state: upgraded, version: 27, seq: 7 }, later.map((op) => ({ op, version: 26 })));
    assert.deepEqual(marks(state), { s1: 0, s2: 0, s3: 0, s5: 1 });
    assert.equal(state.scenes.s6?.name, "Cellar");
  });

  test("an old snapshot with no ops after it takes the step at once, and a reload of it before any snapshot takes the same", async () => {
    const legacy = before();
    legacy.scenes.s2 = scene("s2", { order: 1, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
    const first = await load({ state: legacy, version: 26 }, []);
    const again = await load({ state: legacy, version: 26 }, []);
    assert.deepEqual(marks(first), { s1: 0, s2: 0 });
    assert.deepEqual(Object.keys(first.memoryShared ?? {}), ["s2"]);
    assert.deepEqual(again, first);
  });

  test("a room stored before map discovery from an older snapshot still meets the step at the boundary", async () => {
    const { traps: _t, trapLog: _l, trapSeen: _s, ...v18 } = before();
    const state = await load({ state: v18, version: 18 }, [...OLD.map((op) => ({ op, version: 18 })), ...NEW.map((op) => ({ op, version: 26 }))]);
    assert.deepEqual(marks(state), { s1: 0, s2: 0, s3: 0, s5: 1 });
  });
});
