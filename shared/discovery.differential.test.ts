import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dragged, type Drag } from "./differential.ts";
import { chunkKey, holderChunkKey, holderTileKey } from "./keys.ts";
import type { EdgeFeature, ExploredTile, PathStop, RoomState, Viewer } from "./model.ts";
import { cellVision } from "./perPlayerTestutil.ts";
import { projectState } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { visionRules } from "./ruleHooks.ts";
import { rasterizeFogOps } from "./rules/fog.ts";
import { DM, P1, apply, deepClone, env, member, reveal, room, token } from "./testutil.ts";

/**
 * Map discovery's pairs for the shared differential test
 * (docs/design-v1-map-discovery.md section 10): rooms that differ only in
 * what one player remembers of the map or sees for themselves, the same
 * drags made in both, and every other player's copy compared after. The
 * room is movement's: a wall along x = 6 leaves a gap below y = 12. Thorn
 * is p1's and p2's, Bree p2's, and p3 owns nothing. p1 and p2 see for
 * themselves, by the stub sight of perPlayerTestutil.ts, in the dark: each
 * creature sees one cell around it.
 */
const P2: Viewer = { memberId: "p2", role: "player" };
const P3: Viewer = { memberId: "p3", role: "player" };
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

const real = { ...visionRules };
before(() => Object.assign(visionRules, cellVision));
after(() => Object.assign(visionRules, real));

const WALL: EdgeFeature = { kind: "wall" };
const ALL = { x: 0, y: 0, w: 40, h: 30 };

/** Thorn's turn of a fight with Bree, on a per-player scene in the dark that p1 and p2 both explored whole and only they hold. */
function base(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") } });
  s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true, autoWalls: "off", fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } };
  const edges: Record<string, EdgeFeature> = {};
  for (let y = 0; y < 12; y++) edges[`6,${y},w`] = WALL;
  s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges };
  s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] };
  s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: ["p1", "p2"], x: 2, y: 5 });
  s.tokens.bree = token("bree", { kind: "pc", name: "Bree", disposition: "ally", ownerIds: ["p2"], x: 2, y: 20 });
  explored(s, "p1", ALL);
  explored(s, "p2", ALL);
  const started = apply(s, { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "eb", tokenId: "bree", value: 10 }] });
  return apply(started, { t: "encounter.next" });
}

function explored(s: RoomState, memberId: string, rect: { x: number; y: number; w: number; h: number }): void {
  for (const tile of Object.values(rasterizeFogOps({}, "s1", s.scenes.s1!.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", ...rect } }]))) {
    if (tile) s.exploredBy[holderTileKey("s1", memberId, tile.tx, tile.ty)] = { ...tile, memberId } as ExploredTile;
  }
}

/** A wall a holder remembers on an edge the real build leaves open. */
function remembersWall(s: RoomState, memberId: string, key: string): void {
  s.memoryBy = { ...s.memoryBy, [holderChunkKey("s1", memberId, 0, 0)]: { sceneId: "s1", cx: 0, cy: 0, rev: 0, memberId, edges: { [key]: WALL } } };
}

const across: Drag = { who: P1, tokenId: "thorn", to: { x: 9, y: 5 } };

/** p1 drags Thorn across as their device does, and the server applies it. */
function moved(s: RoomState): RoomState {
  const sent = dragged(s, across);
  assert.ok(sent && Array.isArray(sent.route), "Thorn finds a route");
  const r = applyOp(s, sent.op, P1, env(40));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.state;
}

function stopsOf(state: RoomState, viewer: Viewer): readonly PathStop[] {
  const view = viewer.role === "dm" ? state : (projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState);
  return view.tokens.thorn?.path?.stops ?? [];
}

function copyOf(state: RoomState, viewer: Viewer): unknown {
  return projectState(state, viewer, { sceneId: "s1" });
}

describe("route corners on a scene with memory (decision 12)", () => {
  test("co-owners with equal fog and different memories: no corner from the mover's memory", () => {
    const a = base();
    const b = deepClone(a);
    // A wall only p1 remembers turns their route through (2, 9), at the same cost.
    remembersWall(b, "p1", "4,7,n");
    const ma = moved(a);
    const mb = moved(b);
    const [la, lb] = [stopsOf(ma, DM)[1]!, stopsOf(mb, DM)[1]!];
    assert.notDeepEqual(la.via, lb.via, "the mover's memory bent the route");
    assert.deepEqual([la.moved, la.cost], [lb.moved, lb.cost], "and cost the same");
    for (const p of [P2, P3, DISPLAY]) assert.deepEqual(copyOf(ma, p), copyOf(mb, p), `${p.memberId} observes the same`);
    assert.equal(stopsOf(mb, P2)[1]!.via, undefined, "the co-owner explored the route but does not see it now");
    assert.equal(stopsOf(mb, P1)[1]!.via, undefined, "the mover is an owner like any other: their corners lie off their sight");
  });

  test("co-owners with equal fog and memories: no corner from the mover's private sight", () => {
    const a = base();
    remembersWall(a, "p1", "4,7,n");
    remembersWall(a, "p2", "4,7,n");
    a.tokens.scout = token("scout", { kind: "pc", name: "Scout", disposition: "ally", ownerIds: ["p1"], x: 5, y: 9 });
    const b = deepClone(a);
    // With darkvision only p1's scout sees that the remembered wall is gone, which no other player can read off it.
    const scout = b.tokens.scout!.actor;
    assert.ok("inline" in scout);
    scout.inline.senses = "darkvision 60 ft.";
    assert.deepEqual(copyOf(a, P2), copyOf(b, P2), "p2 cannot tell the rooms apart");
    const ma = moved(a);
    const mb = moved(b);
    assert.notDeepEqual(stopsOf(ma, DM)[1]!.via, stopsOf(mb, DM)[1]!.via, "the mover's sight bent the route");
    for (const p of [P2, P3, DISPLAY]) assert.deepEqual(copyOf(ma, p), copyOf(mb, p), `${p.memberId} observes the same`);
  });

  test("corners reach an owner on ground the DM revealed, but not on ground the owner only explored", () => {
    const m = moved(base());
    const leg = stopsOf(m, DM)[1]!;
    assert.ok(leg.via && leg.via.length > 0);
    assert.notEqual(leg.routeSeen, true, "a leg no player saw whole is private");
    assert.equal(stopsOf(m, P2)[1]!.via, undefined);
    const revealed = deepClone(m);
    reveal(revealed, "s1", ALL);
    assert.deepEqual(stopsOf(revealed, P2)[1]!.via, leg.via);
    assert.deepEqual(stopsOf(revealed, P1)[1]!.via, leg.via);
    assert.equal(stopsOf(revealed, P3)[1]?.via, undefined, "a player who does not own Thorn never gets corners");
  });
});
