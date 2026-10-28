import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "../keys.ts";
import type { RoomState, Viewer } from "../model.ts";
import { opSchema, type Op, type RestoreEntry, type TrapInput } from "../protocol.ts";
import { applyOp, type ApplyResult } from "../reducer.ts";
import { env, member, room, token, trap } from "../testutil.ts";

/*
 * A restore keeps the grid shape's invariant (docs/design-v1-hex-grids.md
 * HX-D14), by its stamp check, its phase check and the check of a scene it
 * changes the shape of, and a switch, its undo and its redo reproject (HX-D21).
 */

const A: Viewer = { memberId: "dmA", role: "dm" };
const B: Viewer = { memberId: "dmB", role: "dm" };

function twoDms(overrides: Partial<RoomState> = {}): RoomState {
  return room({ members: { dmA: member("dmA", "dm"), dmB: member("dmB", "dm"), p1: member("p1") }, ...overrides });
}

let seq = 1;
function step(state: RoomState, op: Op, who: Viewer = A): ApplyResult {
  return applyOp(state, opSchema.parse(op), who, env(seq++));
}

function run(state: RoomState, op: Op, who: Viewer = A): { state: RoomState; inverse: RestoreEntry[]; global: boolean } {
  const r = step(state, op, who);
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : `${r.code}: ${r.message}`}`);
  return { state: r.state, inverse: r.inverse ?? [], global: r.global };
}

function refusal(state: RoomState, op: Op, who: Viewer = A): string {
  const r = step(state, op, who);
  assert.ok(!r.ok, `${op.t} should be refused`);
  return r.message;
}

const toHex = (sceneId = "s1", shape: "hexRows" | "hexColumns" | "squares" = "hexRows"): Op => ({ t: "scene.update", sceneId, patch: { gridShape: shape } });
const undo = (entries: RestoreEntry[]): Op => ({ t: "sys.restore", entries, from: "undo", deps: true });
const redo = (entries: RestoreEntry[]): Op => ({ t: "sys.restore", entries, from: "redo", deps: true });

function trapInput(id: string): TrapInput {
  const { rev: _rev, state: _state, rig, ...rest } = trap(id);
  return { ...rest, rig: rig! } as TrapInput;
}

const wall = { id: "w00000000001", a: [2, 2] as [number, number], b: [5, 2] as [number, number], f: { kind: "wall" as const } };

describe("the switch reprojects (HX-D21)", () => {
  test("a switch, its undo and its redo are global changes, and a rename is not", () => {
    const switched = run(room(), toHex());
    assert.equal(switched.global, true);
    const undone = run(switched.state, undo(switched.inverse));
    assert.equal(undone.global, true);
    assert.equal(run(undone.state, redo(undone.inverse)).global, true);
    assert.equal(run(room(), { t: "scene.update", sceneId: "s1", patch: { name: "Crypt" } }).global, false);
    assert.equal(run(switched.state, toHex("s1", "hexColumns")).global, true, "rows to columns too");
  });
});

describe("a restore keeps the shape's invariant (HX-D14)", () => {
  test("two DMs: A erases difficult ground, B switches to hexes, A's undo is refused", () => {
    const marked = run(twoDms(), { t: "build.rough", sceneId: "s1", cells: ["1,1"], on: true }).state;
    const erased = run(marked, { t: "build.rough", sceneId: "s1", cells: ["1,1"], on: false });
    const switched = run(erased.state, toHex(), B).state;
    assert.equal(refusal(switched, undo(erased.inverse)), "Can't undo that: difficult ground on squares can't stand on this scene's hexes.");
  });

  test("two DMs: A deletes a square trap, B switches to hexes, A's undo is refused", () => {
    const trapped = run(twoDms(), { t: "trap.create", trap: trapInput("t1") }).state;
    const deleted = run(trapped, { t: "trap.delete", trapId: "t1" });
    const switched = run(deleted.state, toHex(), B).state;
    assert.equal(refusal(switched, undo(deleted.inverse)), "Can't undo that: a trap on squares can't stand on this scene's hexes.");
  });

  test("H2: the last free wall deleted, the empty scene switched to hexes, the delete undone: accepted, a free wall stands on any grid", () => {
    const walled = run(twoDms(), { t: "build.walls", sceneId: "s1", put: [wall] }).state;
    const removed = run(walled, { t: "build.walls", sceneId: "s1", remove: [{ cx: 0, cy: 0, id: wall.id }] });
    const switched = run(removed.state, toHex(), B).state;
    assert.deepEqual(run(switched, undo(removed.inverse)).state.buildChunks[chunkKey("s1", 0, 0)]?.walls, [wall]);
  });

  test("H2: a Wall line undone after a rows-to-columns switch is accepted", () => {
    const rows = twoDms({ scenes: { ...room().scenes, s1: { ...room().scenes.s1!, gridShape: "hexRows" } } });
    const drawn = run(rows, { t: "build.walls", sceneId: "s1", put: [wall] });
    const switched = run(drawn.state, { t: "scene.update", sceneId: "s1", patch: { gridShape: "hexColumns" } }, B).state;
    assert.equal(run(switched, undo(drawn.inverse)).state.buildChunks[chunkKey("s1", 0, 0)], undefined);
  });

  test("a rider's undone dismount on a scene switched since is refused", () => {
    const ridden = twoDms({ tokens: { horse: token("horse", { size: "large", x: 4, y: 4 }), bree: token("bree", { kind: "pc", x: 4, y: 4, attached: { to: "horse", kind: "ride" } }) } });
    const off = run(ridden, { t: "token.detach", tokenId: "bree", x: 6, y: 5 });
    const switched = run(off.state, toHex(), B).state;
    assert.equal(refusal(switched, undo(off.inverse)), "Can't undo that: an attached creature on squares can't stand on this scene's hexes.");
  });

  test("H2: a squeezed token restored onto a hex scene is accepted, as squeezing works on hexes", () => {
    const hex = twoDms({ scenes: { ...room().scenes, s1: { ...room().scenes.s1!, gridShape: "hexColumns" } }, tokens: { ogre: token("ogre", { size: "large" }) } });
    const moved = run(hex, { t: "token.update", tokenId: "ogre", patch: { x: 6 } });
    const squeezed: RestoreEntry[] = moved.inverse.map((e) => (e.key === "token:ogre" ? { ...e, value: { ...(e.value as object), squeeze: true } } : e));
    assert.equal(run(moved.state, undo(squeezed)).state.tokens.ogre?.squeeze, true);
  });

  test("H1 fog drafts on a hex scene: a draft, its publish and its discard, each undone and redone", () => {
    const hex = twoDms({ scenes: { ...room().scenes, s1: { ...room().scenes.s1!, gridShape: "hexRows", fogEnabled: true } } });
    const drafted = run(hex, { t: "fog.draft", sceneId: "s1", add: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 1, y: 1, w: 3, h: 3 } }] });
    for (const done of [drafted, run(drafted.state, { t: "fog.publish", sceneId: "s1" }), run(drafted.state, { t: "fog.discard", sceneId: "s1" })]) {
      const undone = run(done.state, undo(done.inverse));
      run(undone.state, redo(undone.inverse));
    }
  });

  test("a draft of world shapes undone onto a scene switched since is accepted: it holds no grid keys", () => {
    const drafted = run(twoDms(), { t: "fog.draft", sceneId: "s1", add: [{ id: "f1", mode: "reveal", shape: { kind: "poly", points: [0, 0, 4, 0, 4, 4] } }] }).state;
    const discarded = run(drafted, { t: "fog.discard", sceneId: "s1" });
    const switched = run(discarded.state, toHex(), B).state;
    assert.equal(run(switched, undo(discarded.inverse)).state.fogDrafts.s1?.ops.length, 1);
  });

  test("a switch's undo that would leave hex data on squares is refused, by the scene it changes", () => {
    const switched = run(twoDms(), toHex());
    // H2 writes stamped hex cell data. H1 writes none, so the room stands in for it.
    const later: RoomState = {
      ...switched.state,
      buildChunks: { [chunkKey("s1", 0, 0)]: { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, rough: "d".padEnd(256, "."), grid: "hexRows" } },
    };
    assert.equal(refusal(later, undo(switched.inverse)), "Can't undo that: difficult ground on hexes can't stand on this scene's squares.");
    assert.ok(run(switched.state, undo(switched.inverse)).state, "with nothing there the undo goes through");
  });

  test("a redo names itself", () => {
    const marked = run(twoDms(), { t: "build.rough", sceneId: "s1", cells: ["1,1"], on: true });
    const undone = run(marked.state, undo(marked.inverse));
    const switched = run(undone.state, toHex(), B).state;
    assert.equal(refusal(switched, redo(undone.inverse)), "Can't redo that: difficult ground on squares can't stand on this scene's hexes.");
  });

  test("in H2 a value stamped with the hex scene's own shape is refused too, for every grid-keyed kind but difficult ground (D-261026-8)", () => {
    const hex = twoDms({ scenes: { ...room().scenes, s1: { ...room().scenes.s1!, gridShape: "hexRows" } } });
    const key = "chunk:s1:0,0";
    const kinds: [object, string][] = [
      [{ cells: { "1,1": "stone" } }, "painted ground"],
      [{ edges: { "1,1,n": { kind: "wall" } } }, "walls and doors"],
      [{ heights: "A".repeat(683) + "=" }, "heights"],
      [{ up: ".".repeat(256) }, "stairs"],
    ];
    for (const [content, words] of kinds) {
      const value = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, ...content, grid: "hexRows" };
      assert.equal(refusal(hex, redo([{ key, value, expectRev: null }])), `Can't redo that: ${words} can't stand on this scene's hexes.`);
    }
    const rough = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, rough: "d".padEnd(256, "."), grid: "hexRows" };
    assert.equal(run(hex, redo([{ key, value: rough, expectRev: null }])).state.buildChunks[chunkKey("s1", 0, 0)]?.rough, rough.rough);
    const draft = { sceneId: "s1", rev: 0, grid: "hexRows", ops: [{ id: "f1", mode: "reveal", shape: { kind: "cells", cells: ["1,1"] } }] };
    assert.equal(refusal(hex, undo([{ key: "fogDraft:s1", value: draft, expectRev: null }])), "Can't undo that: Reveal room in its fog draft can't stand on this scene's hexes.");
    const stamped = { ...trap("t1"), grid: "hexRows" };
    assert.equal(refusal(hex, undo([{ key: "trap:t1", value: stamped, expectRev: null }])), "Can't undo that: a trap can't stand on this scene's hexes.");
  });
});
