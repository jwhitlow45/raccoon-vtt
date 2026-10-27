import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dragged, type Drag } from "./differential.ts";
import { edge, lift, paint, remember, wall } from "./discoveryTestutil.ts";
import { chunkKey, holderChunkKey, holderTileKey, keys } from "./keys.ts";
import type { EdgeFeature, ExploredTile, PathStop, RoomState, Viewer } from "./model.ts";
import { SOMETHING_BLOCKS, canApply, touchLanding, type PermissionDeps } from "./permissions.ts";
import type { Op } from "./protocol.ts";
import { cellVision } from "./perPlayerTestutil.ts";
import { dependents, projectState } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { visionRules } from "./ruleHooks.ts";
import { rasterizeFogOps } from "./rules/fog.ts";
import { DM, P1, actor, apply, deepClone, env, member, reveal, room, token } from "./testutil.ts";

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

describe("route corners follow the sight and ground they read (decision 12, 5.6)", () => {
  test("sight or the party's ground changing away from the token brings it again, on per-player and whole-party scenes alike", () => {
    const m = moved(base());
    const whole = deepClone(m);
    whole.scenes.s1 = { ...whole.scenes.s1!, vision: { on: true, light: "dark" } };
    // Thorn stands in tile 0,0. Tile 1,0 is far from him, and his leg could cross it.
    for (const [s, label] of [
      [m, "per player"],
      [whole, "whole party"],
    ] as const) {
      for (const key of [keys.sight("s1", 1, 0), keys.sightAll("s1", 1, 0), keys.explored("s1", 1, 0)]) {
        assert.ok(dependents(s, [key]).includes(keys.token("thorn")), `${label}: ${key} brings Thorn's path again`);
      }
    }
    // Fog on without vision reads no sight, so a sight write brings nothing.
    const off = deepClone(whole);
    off.scenes.s1 = { ...off.scenes.s1!, vision: { on: false, light: "dark" } };
    assert.ok(!dependents(off, [keys.sight("s1", 1, 0)]).includes(keys.token("thorn")));
  });
});

const deps: PermissionDeps = { canUseAsset: () => true };

/**
 * What the server answers a player's op on a scene with fog on: taken as
 * sent, landed by the touch rule (the op it stores and the words), or
 * refused in what words.
 */
function answer(state: RoomState, op: Op, who: Viewer = P1): unknown {
  const landed = touchLanding(op, who, state, deps);
  if (landed) return { landed: landed.op, words: landed.words };
  const d = canApply(op, who, state, deps);
  return d.ok ? "taken" : { refused: d.message };
}

/** A dark scene, whole party, Thorn (p1's) at (2, 5) seeing one cell around him, the party having explored the cells beside him. */
function touchRoom(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } });
  s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true, autoWalls: "off", fogEnabled: true, vision: { on: true, light: "dark" } };
  s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: ["p1"], x: 2, y: 5 });
  paint(s, { x: 0, y: 0, w: 24, h: 16 });
  lift(s, "party", { x: 0, y: 3, w: 8, h: 5 });
  return s;
}

/** Asserts the two rooms are the same in p1's copy, so the pair tests only what p1 cannot see. */
function samePlayerCopy(a: RoomState, b: RoomState): void {
  assert.deepEqual(projectState(a, P1, { sceneId: "s1" }), projectState(b, P1, { sceneId: "s1" }), "p1 cannot tell the rooms apart");
}

describe("the touch rule's pairs (decision 11)", () => {
  const east: Op = { t: "token.move", tokenId: "thorn", x: 12, y: 5 };

  test("a blocker just past a held cell's side, paired with none there: the same words for the stopping step", () => {
    // Cells 0 to 7 held: a free wall a quarter cell into cell 8, and in the other room one further on.
    const a = touchRoom();
    wall(a, "w1", [8.25, 4], [8.25, 7]);
    const b = touchRoom();
    wall(b, "w1", [10.25, 4], [10.25, 7]);
    samePlayerCopy(a, b);
    const [ra, rb] = [answer(a, east), answer(b, east)] as { words: string }[];
    assert.equal(ra!.words, SOMETHING_BLOCKS);
    assert.equal(rb!.words, ra!.words);
  });

  test("paired worlds differing only on unheld cells the core never touches: the same landing and words", () => {
    for (const revealed of [false, true]) {
      const a = touchRoom();
      if (revealed) lift(a, "dm", { x: 0, y: 3, w: 16, h: 5 });
      edge(a, "8,5,w", WALL);
      const b = deepClone(a);
      edge(b, "9,12,w", WALL);
      edge(b, "8,9,n", { kind: "door", state: "closed", secret: false, discovered: false });
      samePlayerCopy(a, b);
      assert.deepEqual(answer(b, east), answer(a, east), revealed ? "on revealed ground" : "in the dark");
    }
  });

  test("a crafted squeeze to a far dark or remembered spot is never refused there: it lands unsqueezed or short", () => {
    const large = (s: RoomState) => {
      s.tokens.thorn = { ...s.tokens.thorn!, size: "large", x: 2, y: 4 };
      return s;
    };
    const squeeze: Op = { t: "token.move", tokenId: "thorn", x: 14, y: 9, squeeze: true };
    // The dark: open ground in one room, a real narrow opening there in the other.
    const a = large(touchRoom());
    const b = large(touchRoom());
    for (let y = 0; y < 16; y++) if (y !== 9 && y !== 10) edge(b, `14,${y},w`, WALL);
    edge(b, "14,9,w", WALL);
    samePlayerCopy(a, b);
    for (const s of [a, b]) {
      const r = answer(s, squeeze);
      assert.ok(r === "taken" || (typeof r === "object" && r !== null && "landed" in r), `never refused: ${JSON.stringify(r)}`);
    }
    // Remembered: the party remembers ground that is open, the DM built a wall into it out of sight.
    const c = large(touchRoom());
    lift(c, "party", { x: 0, y: 0, w: 24, h: 16 });
    edge(c, "10,9,w", WALL);
    remember(c, null, 0, 0, { edges: { "10,9,w": null } });
    const r = answer(c, squeeze) as { landed?: Op };
    assert.ok(r.landed, "landed, not refused");
    assert.equal((r.landed as { squeeze?: true }).squeeze, undefined, "unsqueezed");
  });

  test("resize or companion placement on remembered ground, paired worlds: lands elsewhere, refused only where nothing fits", () => {
    const blind = (s: RoomState) => {
      s.tokens.thorn = { ...s.tokens.thorn!, x: 5, y: 5, actor: { inline: actor({ effects: [{ id: "e1", key: "blinded", name: "Blinded" } as never] }) } };
      lift(s, "party", { x: 0, y: 0, w: 24, h: 16 });
      return s;
    };
    const grow: Op = { t: "token.update", tokenId: "thorn", patch: { size: "large", x: 5, y: 5 } };
    const a = blind(touchRoom());
    const b = blind(touchRoom());
    // A wall the DM drew where the party remembers open ground.
    edge(b, "6,5,w", WALL);
    remember(b, null, 0, 0, { edges: { "6,5,w": null } });
    samePlayerCopy(a, b);
    assert.equal(answer(a, grow), "taken");
    const rb = answer(b, grow) as { landed?: Op; words?: string };
    assert.ok(rb.landed && rb.landed.t === "token.update", "landed at another spot");
    assert.equal(rb.words, SOMETHING_BLOCKS);
    // Walled in on every side: nothing fits, so it is refused, naming nothing.
    const c = blind(touchRoom());
    for (const key of ["5,5,n", "5,5,w", "6,5,w", "5,6,n", "4,4,n", "4,4,w", "6,4,w", "7,4,w", "4,6,w", "4,7,n", "5,7,n", "6,6,w"]) {
      edge(c, key, WALL);
      remember(c, null, 0, 0, { edges: { [key]: null } });
    }
    assert.deepEqual(answer(c, grow), { refused: SOMETHING_BLOCKS });
  });
});
