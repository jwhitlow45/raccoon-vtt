import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "#shared/keys.ts";
import { LIMITS, serializedBytes, utf8Bytes } from "#shared/limits.ts";
import { CHUNK_CELLS, type LogEntry, type RoomState, type Trap, type TrapDue } from "#shared/model.ts";
import { applyOp } from "#shared/reducer.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { dmLine, playersLine } from "#shared/reducer/traps.ts";
import { Tx } from "#shared/reducer/tx.ts";
import { DM, room, scene, token, trap } from "#shared/testutil.ts";
import { DUE_RESERVE, growthBound, measuredFromStored, measuredStateBytes, pitReserve, roomLevelBytes, sceneOwnBytes, TRAP_LOG_RESERVE, TRAP_SEEN_RESERVE } from "./sizeGuard.ts";

const SEQ = 9_999_999_999_999_999;
const AT = "2026-10-12T20:00:00.000Z";
const longId = (i: number) => `${"t".repeat(62)}${String(i).padStart(2, "0")}`;

/** The same room after any number of springings: what the reducer writes on its traps and both trap logs. */
function sprung(state: RoomState): RoomState {
  const traps: Record<string, Trap> = {};
  for (const [id, t] of Object.entries(state.traps)) {
    const due: TrapDue[] = [{ id: `${SEQ}:0`, at: AT, how: "turnStart", by: [longId(1)], hits: Array.from({ length: 50 }, (_, i) => longId(i)), hitsMore: 7, perceived: true, acted: true }];
    traps[id] = { ...t, rev: SEQ, state: "disarmed", found: true, rig: { ...t.rig!, usesLeft: 0, noticedBy: longId(3), due } };
  }
  const line = (i: number): LogEntry => ({ id: `${SEQ}:${i}`, at: AT, kind: "event", data: { type: "trapSeen", by: [longId(i)], message: "A click underfoot." } });
  return { ...state, traps, trapLog: [line(0), line(1)], trapSeen: [line(2)] };
}

function trapped(): RoomState {
  const state = room();
  state.traps.plate = trap("plate", { rig: { ...trap("plate").rig!, message: "A click underfoot.", find: [{ ability: "wis", skill: "perception", dc: 15 }] } });
  state.traps.wire = trap("wire", { zone: { wire: { a: [2, 2], b: [6, 2] } } });
  const pit = trap("pit", { zone: { cells: [{ x: 14, y: 14, w: 4, h: 4 }] } });
  pit.rig = { ...pit.rig!, pit: { floor: -20 } };
  state.traps.pit = pit;
  return state;
}

describe("a springing never moves a measure (docs/design-v1-traps.md 6.7)", () => {
  test("the room's measure, its stored bytes' measure and every DM projection part are the same however often a trap went off", () => {
    const quiet = trapped();
    const busy = sprung(quiet);
    assert.notEqual(serializedBytes(quiet), serializedBytes(busy), "the real bytes differ");
    assert.equal(measuredStateBytes(busy), measuredStateBytes(quiet));
    assert.equal(measuredFromStored(serializedBytes(busy), busy), measuredStateBytes(busy));
    assert.equal(measuredFromStored(serializedBytes(quiet), quiet), measuredStateBytes(quiet));
    assert.equal(roomLevelBytes(busy), roomLevelBytes(quiet));
    assert.equal(sceneOwnBytes(busy, "s1"), sceneOwnBytes(quiet, "s1"));
    assert.ok(measuredStateBytes(busy) >= serializedBytes(busy), "the measure holds the real bytes");
  });

  test("a room without traps measures exactly, and its first trap brings the room's reserves into the op's growth", () => {
    const empty = room();
    assert.equal(measuredStateBytes(empty), serializedBytes(empty));
    const result = applyOp(empty, { t: "trap.create", trap: { id: "plate", sceneId: "s1", name: "Plate", zone: { cells: [{ x: 1, y: 1, w: 1, h: 1 }] }, rig: trap("plate").rig! } }, DM, { seq: 1, at: AT });
    assert.ok(result.ok);
    const growth = growthBound(empty, result.state, result.touched);
    assert.ok(growth >= DUE_RESERVE + TRAP_LOG_RESERVE + TRAP_SEEN_RESERVE, `growth ${growth}`);
    assert.ok(growth >= measuredStateBytes(result.state) - measuredStateBytes(empty), "the growth bounds the measure's change");
  });

  test("a pit trap's growth bounds its scene's pit reserve", () => {
    const state = room();
    const pit = trap("pit", { zone: { cells: [{ x: 14, y: 14, w: 4, h: 4 }] } });
    pit.rig = { ...pit.rig!, pit: { floor: -20 } };
    const { id: _id, rev: _rev, state: _state, ...rest } = pit;
    const result = applyOp(state, { t: "trap.create", trap: { ...rest, id: "pit", rig: pit.rig! } }, DM, { seq: 1, at: AT });
    assert.ok(result.ok);
    const before = sceneOwnBytes(state, "s1");
    assert.ok(growthBound(state, result.state, result.touched) >= sceneOwnBytes(result.state, "s1") - before);
  });
});

describe("the reserves hold the largest writes (Appendix B)", () => {
  test("a trap's small fields and who noticed it fit 160 bytes", () => {
    const own = { rev: SEQ, state: "disarmed", found: false, usesLeft: 99, noticedBy: longId(0) };
    // Each as a field of the trap or its rig, with its comma.
    const bytes = Object.entries(own).reduce((n, [k, v]) => n + utf8Bytes(JSON.stringify(k)) + 1 + serializedBytes(v) + 1, 0);
    assert.ok(bytes <= 160, `${bytes} bytes`);
  });

  test("ten occurrences at their largest fit 42 KiB, a trap's list going when its last is settled", () => {
    const due: TrapDue = { id: `${SEQ}:999999`, at: AT, how: "turnStart", by: Array.from({ length: LIMITS.trapBy }, (_, i) => longId(i)), more: 99, hits: Array.from({ length: LIMITS.trapHits }, (_, i) => longId(i)), hitsMore: 999, perceived: true, hidden: true, acted: true };
    const one = serializedBytes(due) + 1;
    assert.ok(one <= 4_191, `${one} bytes`);
    // With the list's own field and brackets on each of ten traps.
    const list = utf8Bytes(JSON.stringify("due")) + 1 + 2 + 1;
    assert.ok(LIMITS.trapDuePerRoom * (one + list) <= DUE_RESERVE, `${LIMITS.trapDuePerRoom * (one + list)} bytes`);
  });

  test("every line is cut to 1,536 bytes when written, so both trap logs at their bounds fit their reserves", () => {
    const state = room();
    const ids = Array.from({ length: 10 }, (_, i) => longId(i));
    for (const id of ids) state.tokens[id] = token(id, { name: "Goblin" });
    const t = trap("t".repeat(64), { name: "€".repeat(80), rig: { ...trap("x").rig!, message: "€".repeat(200), sound: "rumble" } });
    state.traps[t.id] = t;
    const tx = new Tx(state, DM, { seq: SEQ, at: AT });
    for (let i = 0; i < LIMITS.trapLogLines + 3; i++) {
      dmLine(tx, t, { how: "turnStart", by: ids, more: 99, hits: 50, did: Array.from({ length: 8 }, (_, a) => ({ action: a, ok: false })), seen: new Set(ids), hidden: true });
    }
    // A scene id escaping to its most, 386 bytes, costs a DM line some of its creatures, never its bound, and fits a hint's line whole.
    const far = { ...t, sceneId: "\u0001".repeat(64) };
    const cut = dmLine(tx, far, { how: "turnStart", by: ids, more: 99, hits: 50, did: Array.from({ length: 8 }, (_, a) => ({ action: a, ok: false })), seen: new Set(ids), hidden: true });
    assert.ok(cut.data?.type === "trap" && cut.data.by.length > 0 && cut.data.by.length < ids.length, "some creatures kept, some counted");
    const notice: LogEntry = { id: `${SEQ}:999999`, at: AT, kind: "event", data: { type: "trapNotice", trapId: t.id, sceneId: far.sceneId, tokenId: longId(0), passive: 60, dc: 30 } };
    assert.ok(serializedBytes(notice) <= LIMITS.trapLineBytes, `${serializedBytes(notice)} bytes`);
    for (let i = 0; i < LIMITS.trapSeenLines + 3; i++) playersLine(tx, t, ids);
    for (const line of [...tx.state.trapLog, ...tx.state.trapSeen]) assert.ok(serializedBytes(line) <= LIMITS.trapLineBytes, `${serializedBytes(line)} bytes`);
    assert.equal(tx.state.trapLog.length, LIMITS.trapLogLines);
    assert.equal(tx.state.trapSeen.length, LIMITS.trapSeenLines);
    assert.ok(serializedBytes(tx.state.trapLog) <= TRAP_LOG_RESERVE);
    assert.ok(serializedBytes(tx.state.trapSeen) <= TRAP_SEEN_RESERVE);
  });

  test("a pit's whole new chunk, map key and envelope included, fits 2K + 780 bytes", () => {
    for (const sceneId of ["s1", "x".repeat(36), "y".repeat(64)]) {
      const k = utf8Bytes(JSON.stringify(sceneId));
      const heights = encodeHeights(Array.from({ length: CHUNK_CELLS * CHUNK_CELLS }, () => -100))!;
      const chunk = { sceneId, cx: 12, cy: 12, rev: SEQ, cells: {}, edges: {}, heights };
      const bytes = utf8Bytes(JSON.stringify(chunkKey(sceneId, 12, 12))) + 1 + serializedBytes(chunk) + 1 + 1;
      assert.ok(bytes <= 2 * k + 780, `${bytes} bytes for a scene id of ${k}`);
    }
  });

  test("the review's probe: eight 2 x 2 pits across 32 new chunks stay inside their scene's reserve", () => {
    const sceneId = "0".repeat(8) + "-" + "0".repeat(4) + "-" + "0".repeat(4) + "-" + "0".repeat(4) + "-" + "0".repeat(12);
    const state = room({ scenes: { [sceneId]: scene(sceneId, { bounds: { w: 200, h: 200 } }) } });
    const written: number[] = [];
    for (let i = 0; i < 8; i++) {
      // Each 2 x 2 pit sits on the corner of four chunks.
      const x = (2 * i + 1) * CHUNK_CELLS - 1;
      const y = CHUNK_CELLS - 1;
      const pit = trap(`pit${i}`, { sceneId, zone: { cells: [{ x, y, w: 2, h: 2 }] } });
      pit.rig = { ...pit.rig!, pit: { floor: -100 } };
      state.traps[pit.id] = pit;
      for (const [cx, cy] of [[2 * i, 0], [2 * i + 1, 0], [2 * i, 1], [2 * i + 1, 1]] as const) {
        const heights = encodeHeights(Array.from({ length: CHUNK_CELLS * CHUNK_CELLS }, () => -100))!;
        written.push(utf8Bytes(JSON.stringify(chunkKey(sceneId, cx, cy))) + 1 + serializedBytes({ sceneId, cx, cy, rev: SEQ, cells: {}, edges: {}, heights }) + 1);
      }
    }
    const bytes = written.reduce((a, b) => a + b, 0);
    assert.equal(written.length, 32);
    assert.ok(bytes <= pitReserve(state, sceneId) - 4 * 1024, `${bytes} bytes written, ${pitReserve(state, sceneId) - 4 * 1024} reserved for chunks`);
  });
});
