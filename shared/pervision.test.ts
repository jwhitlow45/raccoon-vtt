import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey } from "./keys.ts";
import { LIMITS } from "./limits.ts";
import type { ExploredTile, FogTile, RoomState, Scene, TurnStart } from "./model.ts";
import { opSchema, type Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { HOLDERS_FULL } from "./reducer/map.ts";
import { decodeTile, rasterizeFogOps } from "./rules/fog.ts";
import { DM, apply, env, member, refused, room, scene, token } from "./testutil.ts";

/**
 * Per-player vision's contract and memory in the reducer
 * (docs/design-v1-per-player-vision.md 6.1, 6.3 and 6.7, lane PV1): the
 * merge rule, the holder list and its joins, every layer under hides and
 * resets, the fold back to Whole party, copies and removals, and members
 * leaving.
 */

const DARK: Scene["vision"] = { on: true, light: "dark", perPlayer: true };

/** A tile of a layer revealing a rectangle of cells, as fog tiles hold it. */
function layerTile(sceneId: string, rect: { x: number; y: number; w: number; h: number }): FogTile {
  const changes = rasterizeFogOps({}, sceneId, { w: 40, h: 30 }, [{ id: "r", mode: "reveal", shape: { kind: "rect", ...rect } }]);
  return Object.values(changes)[0]!;
}

function holderTile(sceneId: string, memberId: string, rect: { x: number; y: number; w: number; h: number }): ExploredTile {
  return { ...layerTile(sceneId, rect), memberId };
}

/** A room with a per-player player scene, p1 and p2 seeing for themselves there, each with a layer. */
function perPlayerRoom(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") } });
  s.scenes.s1 = scene("s1", { fogEnabled: true, vision: DARK });
  s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }, { memberId: "p3", on: false }] };
  s.exploredBy[holderTileKey("s1", "p1", 0, 0)] = holderTile("s1", "p1", { x: 0, y: 0, w: 4, h: 4 });
  s.exploredBy[holderTileKey("s1", "p2", 0, 0)] = holderTile("s1", "p2", { x: 8, y: 8, w: 4, h: 4 });
  return s;
}

function revealed(tile: FogTile | undefined, x: number, y: number): boolean {
  const bits = tile ? decodeTile(tile.bits) : null;
  if (!bits) return false;
  const i = y * 4 * 64 + x * 4;
  return ((bits[i >> 3]! >> (i & 7)) & 1) === 1;
}

describe("the contract (6.7)", () => {
  test("the Sight row's patch, the holder pick and the explore step's shapes", () => {
    assert.ok(opSchema.safeParse({ t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dim", perPlayer: true } } }).success);
    assert.ok(opSchema.safeParse({ t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dim", perPlayer: false } } }).success);
    assert.ok(!opSchema.safeParse({ t: "scene.create", scene: { id: "s9", name: "S", bounds: { w: 10, h: 10 }, vision: { on: true, light: "dim", perPlayer: false } } }).success, "a stored vision never holds false");
    const pick = (on: string[]) => opSchema.safeParse({ t: "vision.holders", sceneId: "s1", on });
    assert.ok(pick(["p1", "p2", "p3", "p4", "p5", "p6"]).success);
    assert.ok(!pick(["p1", "p2", "p3", "p4", "p5", "p6", "p7"]).success, "a seventh is refused");
    assert.ok(!pick(["p1", "p1"]).success, "a player twice is refused");
    assert.ok(!opSchema.safeParse({ t: "sys.explore", sceneId: "s1", tiles: [] }).success, "an explore holds something");
    assert.ok(opSchema.safeParse({ t: "sys.explore", sceneId: "s1", tiles: [], join: [{ memberId: "p1", on: true }] }).success);
    assert.equal(LIMITS.sightHoldersPerScene, 6);
    assert.equal(HOLDERS_FULL, "At most 6 players see for themselves here. Untick one first.");
  });
});

describe("the merge rule and what keeps Per player (6.7, decision F1)", () => {
  test("a vision patch without perPlayer keeps it, false clears it, and it is stored only while true", () => {
    const s = perPlayerRoom();
    const kept = apply(s, { t: "scene.update", sceneId: "s1", patch: { vision: { on: false, light: "bright" } } });
    assert.deepEqual(kept.scenes.s1!.vision, { on: false, light: "bright", perPlayer: true }, "the Party vision switch and the Light control keep it");
    const cleared = apply(kept, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dim", perPlayer: false } } });
    assert.deepEqual(cleared.scenes.s1!.vision, { on: true, light: "dim" });
    const whole = room();
    whole.scenes.s1 = scene("s1", { vision: { on: true, light: "dim" } });
    assert.deepEqual(apply(whole, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: false } } }).scenes.s1!.vision, { on: true, light: "dark" });
    assert.deepEqual(apply(whole, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: true } } }).scenes.s1!.vision, { on: true, light: "dark", perPlayer: true });
  });

  test("switching is global, and a light change is too as before", () => {
    const s = perPlayerRoom();
    const r = applyOp(s, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: false } } }, DM, env(5));
    assert.ok(r.ok && r.global);
    const pick = applyOp(s, { t: "vision.holders", sceneId: "s1", on: ["p1"] }, DM, env(5));
    assert.ok(pick.ok && pick.global, "a change of the holder list changes whose sight every player has");
  });

  test("a phase switch, a phase list change and a phase's light keep Per player", () => {
    const s = perPlayerRoom();
    const map = { assetId: "a1", widthPx: 1000, heightPx: 750, cellPx: 25, originPx: { x: 0, y: 0 } };
    s.scenes.s1 = { ...s.scenes.s1!, map };
    const listed = apply(s, { t: "scene.update", sceneId: "s1", patch: { phases: [{ id: "day", name: "Day", assetId: "a1", widthPx: 1000, heightPx: 750 }, { id: "night", name: "Night", assetId: "a2", widthPx: 1000, heightPx: 750, light: "dark" }] } });
    assert.equal(listed.scenes.s1!.vision?.perPlayer, true);
    const night = apply(listed, { t: "scene.setPhase", sceneId: "s1", phaseId: "night" });
    assert.deepEqual(night.scenes.s1!.vision, { on: true, light: "dark", perPlayer: true });
    const relisted = apply(night, { t: "scene.update", sceneId: "s1", patch: { phases: [{ id: "day", name: "Day", assetId: "a1", widthPx: 1000, heightPx: 750, light: "bright" }] } });
    assert.deepEqual(relisted.scenes.s1!.vision, { on: true, light: "bright", perPlayer: true });
  });
});

describe("the holder list (6.1)", () => {
  test("the DM's pick turns on exactly the players named, adds one with no entry at the end, and refuses what is not a player", () => {
    const s = perPlayerRoom();
    s.members.p4 = member("p4");
    const next = apply(s, { t: "vision.holders", sceneId: "s1", on: ["p3", "p4"] });
    assert.deepEqual(next.holders.s1!.entries, [
      { memberId: "p1", on: false },
      { memberId: "p2", on: false },
      { memberId: "p3", on: true },
      { memberId: "p4", on: true },
    ]);
    assert.match(refused(s, { t: "vision.holders", sceneId: "s1", on: ["dm1"] }).message, /only a player/);
    assert.match(refused(s, { t: "vision.holders", sceneId: "s1", on: ["gone"] }).message, /only a player/);
    const whole = room();
    assert.match(refused(whole, { t: "vision.holders", sceneId: "s1", on: ["p1"] }).message, /whole party/);
  });

  test("unticking a holder forgets their map outside the undo step, so undoing it turns them on from the party's map", () => {
    const s = perPlayerRoom();
    const r = applyOp(s, { t: "vision.holders", sceneId: "s1", on: ["p2"] }, DM, env(5));
    assert.ok(r.ok);
    assert.equal(r.state.exploredBy[holderTileKey("s1", "p1", 0, 0)], undefined, "p1's layer goes");
    assert.ok(r.state.exploredBy[holderTileKey("s1", "p2", 0, 0)], "p2's stays");
    assert.ok(!r.inverse!.some((e) => e.key.startsWith("exploredBy:")), "the layer is no part of the undo");
    const undone = apply(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo" });
    assert.deepEqual(undone.holders.s1!.entries, s.holders.s1!.entries);
    assert.equal(undone.exploredBy[holderTileKey("s1", "p1", 0, 0)], undefined);
  });

  test("the explore step's joins go on in order while fewer than six are on, once each, and only players", () => {
    const s = perPlayerRoom();
    for (const id of ["p4", "p5", "p6", "p7", "p8"]) s.members[id] = member(id);
    const join = ["p4", "p5", "p6", "p7", "p8", "p1", "dm1"].map((memberId) => ({ memberId, on: true }));
    const next = apply(s, { t: "sys.explore", sceneId: "s1", tiles: [], join });
    assert.deepEqual(
      next.holders.s1!.entries.map((e) => `${e.memberId} ${e.on ? "on" : "off"}`),
      ["p1 on", "p2 on", "p3 off", "p4 on", "p5 on", "p6 on", "p7 on", "p8 off"],
      "p8 is the seventh, so stays off; p1 is listed already and the DM is no player",
    );
  });

  test("a holder's layer gains the explore's bits, only a holder whose entry is on explores, and nothing explored changes the list", () => {
    const s = perPlayerRoom();
    const bits = layerTile("s1", { x: 1, y: 1, w: 2, h: 2 }).bits;
    const next = apply(s, { t: "sys.explore", sceneId: "s1", tiles: [{ tx: 0, ty: 0, bits }], members: [{ memberId: "p2", tiles: [{ tx: 1, ty: 1, bits }] }] });
    assert.equal(next.holders.s1, s.holders.s1, "the list is the very same");
    assert.ok(revealed(next.exploredTiles["s1:0,0"], 1, 1));
    assert.ok(revealed(next.exploredBy[holderTileKey("s1", "p2", 1, 1)], 1, 1));
    assert.match(refused(s, { t: "sys.explore", sceneId: "s1", tiles: [], members: [{ memberId: "p3", tiles: [{ tx: 0, ty: 0, bits }] }] }).message, /sees for themselves/);
    const whole = room();
    assert.match(refused(whole, { t: "sys.explore", sceneId: "s1", tiles: [], join: [{ memberId: "p1", on: true }] }).message, /whole party/);
  });
});

describe("hides, resets and the fold (6.3)", () => {
  test("a hide clears the party's layer and every holder's under its shape, outside the undo step", () => {
    const s = perPlayerRoom();
    s.exploredTiles["s1:0,0"] = layerTile("s1", { x: 0, y: 0, w: 12, h: 12 });
    const r = applyOp(s, { t: "fog.live", sceneId: "s1", ops: [{ id: "h", mode: "hide", shape: { kind: "rect", x: 0, y: 0, w: 10, h: 10 } }] }, DM, env(5));
    assert.ok(r.ok && r.global);
    assert.equal(r.state.exploredBy[holderTileKey("s1", "p1", 0, 0)], undefined, "p1's whole layer lay under the hide");
    assert.ok(revealed(r.state.exploredBy[holderTileKey("s1", "p2", 0, 0)], 11, 11) && !revealed(r.state.exploredBy[holderTileKey("s1", "p2", 0, 0)], 8, 8));
    assert.ok(revealed(r.state.exploredTiles["s1:0,0"], 11, 11) && !revealed(r.state.exploredTiles["s1:0,0"], 3, 3));
    assert.ok(!(r.inverse ?? []).some((e) => e.key.startsWith("exploredBy:") || e.key.startsWith("explored:")));
  });

  test("a reset to hidden clears every layer, and one to revealed none", () => {
    const s = perPlayerRoom();
    assert.deepEqual(apply(s, { t: "fog.reset", sceneId: "s1", to: "hidden" }).exploredBy, {});
    assert.deepEqual(apply(s, { t: "fog.reset", sceneId: "s1", to: "revealed" }).exploredBy, s.exploredBy);
  });

  test("Whole party pools every holder's map into the party's and empties the list, and undoing it does not split them again", () => {
    const s = perPlayerRoom();
    const r = applyOp(s, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: false } } }, DM, env(5));
    assert.ok(r.ok);
    assert.equal(r.state.holders.s1, undefined);
    assert.deepEqual(r.state.exploredBy, {});
    const pooled = r.state.exploredTiles["s1:0,0"];
    assert.ok(revealed(pooled, 1, 1) && revealed(pooled, 9, 9), "both maps in the party's");
    assert.ok(!r.inverse!.some((e) => e.key.startsWith("holders:") || e.key.startsWith("exploredBy:") || e.key.startsWith("explored:")));
    const undone = apply(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo" });
    assert.equal(undone.scenes.s1!.vision?.perPlayer, true);
    assert.deepEqual(undone.exploredBy, {}, "each starts from the pooled map");
    assert.equal(undone.exploredTiles["s1:0,0"], pooled);
  });

  test("a scene going takes its list and layers, and a copy with its fog brings them", () => {
    const s = perPlayerRoom();
    s.scenes.s2 = scene("s2", { order: 1 });
    s.meta.playerSceneId = "s2";
    const gone = apply(s, { t: "scene.delete", sceneId: "s1" });
    assert.equal(gone.holders.s1, undefined);
    assert.deepEqual(gone.exploredBy, {});
    const copy = apply(s, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { creatures: false, characters: false, fog: true, drawings: false } });
    assert.deepEqual(copy.holders.s3!.entries, s.holders.s1!.entries);
    assert.equal(copy.exploredBy[holderTileKey("s3", "p1", 0, 0)]!.bits, s.exploredBy[holderTileKey("s1", "p1", 0, 0)]!.bits);
    assert.equal(copy.scenes.s3!.vision?.perPlayer, true);
    const bare = apply(s, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { creatures: false, characters: false, fog: false, drawings: false } });
    assert.equal(bare.holders.s3, undefined);
  });
});

describe("a member leaving (6.8)", () => {
  test("takes them off every list, layer and holder entry", () => {
    const s = perPlayerRoom();
    const start: TurnStart = { entryId: "e1", tokenId: "gob", sceneId: "s1", x: 1, y: 1, elevation: 0, seq: 3, seenBy: ["p1", "p2"] };
    s.tokens.gob = token("gob", { path: { turn: 3, stops: [{ x: 1, y: 1, elevation: 0, seenBy: ["p1", "p2"] }, { x: 2, y: 1, elevation: 0, seenBy: ["p2"] }] } });
    s.encounter = { rev: 1, round: 1, activeEntryId: "e1", entries: [{ id: "e1", tokenId: "gob", value: 10, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false }], turnStart: start };
    s.encounterHistory = [{ encounter: { ...s.encounter }, effects: {}, revealed: [], at: "2026-10-12T20:00:00.000Z" }];
    const op: Op = { t: "sys.memberRemove", memberId: "p2" };
    const next = apply(s, op);
    assert.deepEqual(next.holders.s1!.entries.map((e) => e.memberId), ["p1", "p3"]);
    assert.equal(next.exploredBy[holderTileKey("s1", "p2", 0, 0)], undefined);
    assert.ok(next.exploredBy[holderTileKey("s1", "p1", 0, 0)]);
    assert.deepEqual(next.tokens.gob!.path!.stops.map((st) => st.seenBy), [["p1"], []]);
    assert.deepEqual(next.encounter!.turnStart!.seenBy, ["p1"]);
    assert.deepEqual(next.encounterHistory[0]!.encounter.turnStart!.seenBy, ["p1"]);
  });
});
