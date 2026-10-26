import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { checkOps, checkPair, dragged, type Drag, type OpPair, type Pair } from "./differential.ts";
import { chunkKey, holderTileKey } from "./keys.ts";
import type { EdgeFeature, ExploredTile, PathStop, RoomState, Scene, Viewer } from "./model.ts";
import { cellVision } from "./perPlayerTestutil.ts";
import { projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { visionRules } from "./ruleHooks.ts";
import { rasterizeFogOps } from "./rules/fog.ts";
import { publicCounters } from "./rules/path.ts";
import { DM, P1, P2, apply, deepClone, env, member, reveal, room, token } from "./testutil.ts";

/**
 * Per-player vision's generators for the shared differential test
 * (docs/design-v1-per-player-vision.md section 10, lane PV1): pairs of
 * rooms on a per-player scene that differ only in what Thorn's player's
 * creatures see or explored, so every other player and a table display
 * must observe the same of every drag and op. Then the co-owners' route
 * corners and the regression of a public leg's corners after a hide. The
 * room is movement's: a wall along x = 6 leaves a gap below y = 12. Thorn
 * is p1's, Bree p2's, and p3 owns nothing. p1 and p2 see for themselves,
 * by the stub sight of perPlayerTestutil.ts.
 */
const P3: Viewer = { memberId: "p3", role: "player" };

const real = { ...visionRules };
before(() => Object.assign(visionRules, cellVision));
after(() => Object.assign(visionRules, real));

const WALL: EdgeFeature = { kind: "wall" };

function base(vision: Scene["vision"], fog: boolean): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") } });
  s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true, autoWalls: "off", fogEnabled: fog, vision };
  const edges: Record<string, EdgeFeature> = {};
  for (let y = 0; y < 12; y++) edges[`6,${y},w`] = WALL;
  s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges };
  s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] };
  s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: ["p1"], x: 2, y: 5 });
  s.tokens.bree = token("bree", { kind: "pc", name: "Bree", disposition: "ally", ownerIds: ["p2"], x: 2, y: 14 });
  return s;
}

/** Thorn's turn of a fight with Bree. */
function fight(s: RoomState): RoomState {
  const started = apply(s, { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "eb", tokenId: "bree", value: 10 }] });
  return apply(started, { t: "encounter.next" });
}

/** Ground every player shares, all but the gap below the wall. */
function sharedButGap(s: RoomState): void {
  reveal(s, "s1", { x: 0, y: 0, w: 40, h: 12 });
  reveal(s, "s1", { x: 0, y: 14, w: 40, h: 16 });
}

/** A holder's layer revealing a rectangle, but for the cells of `holes`. */
function layer(s: RoomState, memberId: string, rect: { x: number; y: number; w: number; h: number }, holes: readonly [number, number][] = []): void {
  const ops = [{ id: "r", mode: "reveal" as const, shape: { kind: "rect" as const, ...rect } }, ...holes.map(([x, y], i) => ({ id: `h${i}`, mode: "hide" as const, shape: { kind: "rect" as const, x, y, w: 1, h: 1 } }))];
  for (const tile of Object.values(rasterizeFogOps({}, "s1", s.scenes.s1!.bounds, ops))) {
    if (!tile) continue;
    s.exploredBy[holderTileKey("s1", memberId, tile.tx, tile.ty)] = { ...tile, memberId } as ExploredTile;
  }
}

const GAP = { x: 0, y: 12, w: 12, h: 2 };
const thornAcross: Drag = { who: P1, tokenId: "thorn", to: { x: 9, y: 5 } };
const dmThornAcross: Drag = { who: DM, tokenId: "thorn", to: { x: 9, y: 5 } };
const breeAcross: Drag = { who: P2, tokenId: "bree", to: { x: 9, y: 14 } };
const dmBreeAcross: Drag = { who: DM, tokenId: "bree", to: { x: 9, y: 15 } };

/** A step by a player that drags their creature as their device does, the op its route search sends. */
function dragStep(drag: Drag, note: string): OpPair["steps"][number] {
  return { who: drag.who, op: (_view, state) => dragged(state, drag)?.op ?? null, note };
}

describe("pairs that differ only in what Thorn's player's creatures see or explored", () => {
  test("a goblin only Thorn sees: every drag sends the same, his player's included, and no one else observes a difference", () => {
    const a = fight(base({ on: true, light: "bright", perPlayer: true }, false));
    const b = deepClone(a);
    a.tokens.gob = token("gob", { name: "Goblin", x: 0, y: 3 });
    assert.ok((projectState(a, P1, { sceneId: "s1" }) as unknown as RoomState).tokens.gob, "Thorn's player sees the goblin");
    const pair: Pair = { name: "a goblin in Thorn's sight", a, b, drags: [thornAcross, dmThornAcross, breeAcross, dmBreeAcross], ownSightDiffers: true };
    checkPair(pair);
    checkOps({ name: "a goblin in Thorn's sight, as ops", a, b, ownSightDiffers: true, steps: [dragStep(thornAcross, "Thorn round the wall"), { who: DM, op: { t: "encounter.next" } }, dragStep(breeAcross, "Bree across")] });
  });

  test("ground only Thorn's player remembers: every other viewer observes the same of every drag and of a hide", () => {
    const a = fight(base({ on: true, light: "dark", perPlayer: true }, true));
    sharedButGap(a);
    const b = deepClone(a);
    layer(b, "p1", GAP);
    const pair: Pair = { name: "Thorn's player remembers the gap", a, b, drags: [dmThornAcross, breeAcross, dmBreeAcross] };
    checkPair(pair);
    const hide: Op = { t: "fog.live", sceneId: "s1", ops: [{ id: "h", mode: "hide", shape: { kind: "rect", x: 0, y: 10, w: 12, h: 6 } }] };
    assert.throws(() => checkPair({ ...pair, drags: [thornAcross], ownSightDiffers: true }), /the acting player's copies differ/, "the variant still holds the mover's own fog equal");
    checkOps({ name: "Thorn's player remembers the gap, as ops", a, b, steps: [{ who: DM, op: { t: "encounter.next" } }, dragStep(breeAcross, "Bree across"), { who: DM, op: hide, note: "a hide over the gap" }, dragStep({ ...breeAcross, to: { x: 2, y: 16 } }, "Bree back")] });
  });
});

/** The stops of Thorn's path as a viewer's copy holds them. */
function stopsFor(state: RoomState, viewer: Viewer): readonly PathStop[] {
  const view = viewer.role === "dm" ? state : (projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState);
  return view.tokens.thorn?.path?.stops ?? [];
}

function move(state: RoomState, who: Viewer, drag: Drag): RoomState {
  const sent = dragged(state, drag);
  assert.ok(sent && Array.isArray(sent.route), `${drag.tokenId} finds a route`);
  const r = applyOp(state, sent.op, who, env(40));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.state;
}

describe("an owner's route corners (6.5)", () => {
  test("a co-owner gets the mover's private corners only on ground they remember", () => {
    const s = fight(base({ on: false, light: "bright", perPlayer: true }, true));
    sharedButGap(s);
    s.tokens.thorn = { ...s.tokens.thorn!, ownerIds: ["p1", "p2"] };
    layer(s, "p1", GAP);
    const moved = move(s, P1, thornAcross);
    const leg = stopsFor(moved, DM)[1]!;
    assert.ok(leg.via && leg.via.some((v, i) => i % 2 === 1 && v >= 12), "the route went through the gap");
    assert.notEqual(leg.routeSeen, true, "a leg on ground only Thorn's player remembers is private");
    assert.deepEqual(stopsFor(moved, P1)[1]!.via, leg.via, "the mover keeps their corners");
    assert.equal(stopsFor(moved, P2)[1]!.via, undefined, "the co-owner never explored the gap");
    assert.equal(stopsFor(moved, P3)[1]?.via, undefined);
    const remembers = deepClone(moved);
    layer(remembers, "p2", GAP);
    assert.deepEqual(stopsFor(remembers, P2)[1]!.via, leg.via, "once the co-owner remembers it they get them");
  });

  test("a resize never thins a private leg's samples, so a co-owner who never saw a cell the Tiny walk crossed still gets no corners (PV1-ASTRA-1)", () => {
    const s = base({ on: false, light: "bright", perPlayer: true }, true);
    s.tokens.thorn = { ...s.tokens.thorn!, ownerIds: ["p1", "p2"], size: "tiny", x: 0.5, y: 0 };
    const fought = fight(s);
    layer(fought, "p1", { x: 0, y: 0, w: 5, h: 5 });
    // Every cell a whole-cell walk of the leg meets, but not (1, 0) or (2, 1), which the half-cell walk of a Tiny creature crosses.
    layer(fought, "p2", { x: 0, y: 0, w: 5, h: 5 }, [[1, 0], [2, 1]]);
    const r = applyOp(fought, { t: "token.move", tokenId: "thorn", x: 2.5, y: 3, route: [[2.5, 2, 0, 0], [2.5, 3, 0, 0]] }, P1, env(40));
    assert.ok(r.ok, r.ok ? "" : r.message);
    const leg = stopsFor(r.state, DM)[1]!;
    assert.deepEqual(leg.via, [2.5, 2]);
    assert.notEqual(leg.routeSeen, true);
    assert.deepEqual(stopsFor(r.state, P1)[1]!.via, [2.5, 2]);
    assert.equal(stopsFor(r.state, P2)[1]!.via, undefined, "Tiny, the walk crossed ground p2 never saw");
    const grown = apply(r.state, { t: "token.update", tokenId: "thorn", patch: { size: "medium" } });
    assert.equal(grown.tokens.thorn!.size, "medium");
    assert.equal(stopsFor(grown, P2)[1]!.via, undefined, "Medium now, the leg was still walked at half cells");
    assert.deepEqual(stopsFor(grown, P1)[1]!.via, [2.5, 2]);
  });

  test("a public routed leg keeps its corners for its owner after a hide, so the next diagonal costs the same on every device and the server", () => {
    const s = fight(base({ on: false, light: "bright", perPlayer: true }, true));
    s.meta.settings = { ...s.meta.settings, diagonal: "fiveTen" };
    reveal(s, "s1", { x: 0, y: 0, w: 40, h: 30 });
    const moved = move(s, P1, thornAcross);
    const leg = stopsFor(moved, DM)[1]!;
    assert.equal(leg.routeSeen, true, "every player saw the leg whole");
    for (const op of [
      { t: "fog.live", sceneId: "s1", ops: [{ id: "h", mode: "hide", shape: { kind: "rect", x: 0, y: 0, w: 12, h: 16 } }] },
      { t: "fog.reset", sceneId: "s1", to: "hidden" },
    ] as Op[]) {
      const hidden = apply(moved, op);
      const thorn = hidden.tokens.thorn!;
      const server = publicCounters(thorn, stopsFor(hidden, DM), hidden.meta.settings, true);
      assert.ok(server.h + server.v > 0, `${op.t}: the leg counted its diagonals`);
      assert.deepEqual(publicCounters(thorn, stopsFor(hidden, P1), hidden.meta.settings, false), server, `${op.t}: the owner's device`);
      assert.deepEqual(publicCounters(thorn, stopsFor(hidden, P3), hidden.meta.settings, false), server, `${op.t}: a non-owner's device`);
      assert.deepEqual(stopsFor(hidden, P1)[1]!.via, leg.via);
    }
  });
});

