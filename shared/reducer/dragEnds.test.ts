import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wall } from "../discoveryTestutil.ts";
import { GROUND, tower, UPPER } from "../floorLinksTestutil.ts";
import { chunkKey } from "../keys.ts";
import { dragsEndClear } from "../migrate.ts";
import { CHUNK_CELLS, type RoomState, type Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import type { Op, OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { footprintInScene, linkHolds, overlaps } from "../rules/attach.ts";
import { occupiedHexes, placedOnHex, snapStep, tokenRefHex } from "../rules/footprint.ts";
import { isHex, SQUARES, type Grid } from "../rules/grid.ts";
import { encodeHeights } from "../rules/heights.ts";
import { hexKey, type Hex, type HexGrid } from "../rules/hex.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "../rules/hexWalls.testkit.ts";
import { caseOf, insideCaseOf, intoCorridor, keepOf, withImpAhead, withMouse, withOgre } from "./hexFile.testkit.ts";
import { hexStandPlace } from "../rules/movement.ts";
import { planMove, planWalks, wayOf } from "../rules/moveLeg.ts";
import { DM, env, P1, P2, room, scene, token } from "../testutil.ts";

/*
 * Where a creature a move drags along ends, from change format 64
 * (D-261120-006, migrate.ts dragsEndClear, moveLeg.ts dragEnd): on its own
 * squares or hexes, inside the scene and off its holder's space, else on
 * the nearest such spot in its holder's reach, or let go. One rule for the
 * owner and the DM, shown or hidden, and canApply judges the move the
 * reducer makes. Each repro is pinned with the place op 63 and earlier
 * left it, as they replay.
 */

const deps = { canUseAsset: () => true };
const at = (s: RoomState, id: string) => [s.tokens[id]!.x, s.tokens[id]!.y];
const hexesOf = (g: HexGrid, s: RoomState, id: string) => occupiedHexes(g, s.tokens[id]!).map(hexKey);

function run(s: RoomState, op: Op, who: Viewer, opVersion?: number): RoomState {
  const r = applyOp(s, op, who, { ...env(1), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.state;
}

/** That the dragged `id` ends on its own grid inside the scene, off each of `holders`, and where it is still dragged, in reach. */
function holds(g: Grid, s: RoomState, id: string, holders: readonly string[], where: string): void {
  const t = s.tokens[id]!;
  assert.ok(footprintInScene(g, s.scenes.s1!.bounds, t), `${where}: inside the scene, on ${t.x}, ${t.y}`);
  const step = snapStep(t);
  const own = isHex(g) ? placedOnHex(g, t, tokenRefHex(g, t)) : { x: Math.round(t.x / step) * step, y: Math.round(t.y / step) * step };
  assert.ok(Math.abs(own.x - t.x) < 1e-9 && Math.abs(own.y - t.y) < 1e-9, `${where}: on its own grid, on ${t.x}, ${t.y}`);
  for (const h of holders) assert.ok(!overlaps(g, t, s.tokens[h]!), `${where}: off ${h}`);
  if (t.attached) assert.ok(linkHolds(g, s.meta.settings, "drag", t, s.tokens[t.attached.to]!), `${where}: in reach`);
}

/** Pat's move of `s` with the hidden `id` and without it: the same answer and the same copy. The state after it. */
function twinned(s: RoomState, op: OpOf<"token.move">, id: string, where: string): RoomState {
  const alone = structuredClone(s);
  delete alone.tokens[id];
  assert.deepEqual(canApply(op, P1, s, deps), canApply(op, P1, alone, deps), `${where}: the answer`);
  const r = run(s, op, P1);
  assert.equal(stableStringify(projectState(r, P1, { sceneId: "s1" })), stableStringify(projectState(run(alone, op, P1), P1, { sceneId: "s1" })), `${where}: Pat's copy`);
  return r;
}

describe("a creature a move drags along ends where it can stand, from change format 64 (D-261120-006)", () => {
  test("the rule is gated at 64", () => {
    assert.deepEqual([dragsEndClear(1), dragsEndClear(63), dragsEndClear(64), dragsEndClear(undefined)], [false, false, true, true]);
  });

  describe("at the scene's edge (HEXOP-EDGE-1)", () => {
    /** A Large mount on 22, 2 of Pat's, dragging a goblin on 22, 1, shown or hidden, in a scene 30 by 20. */
    function edge(hidden: boolean): RoomState {
      return room({
        scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 } }) },
        tokens: {
          horse: token("horse", { name: "Warhorse", kind: "pc", size: "large", x: 22, y: 2, ownerIds: ["p1"] }),
          gob: token("gob", { name: "Goblin", x: 22, y: 1, attached: { to: "horse", kind: "drag" }, ...(hidden ? { visibility: "dm" as const } : {}) }),
        },
      });
    }
    const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 22, y: 0 };

    test("onto 22, 0 the goblin lands on 21, 0 in reach, where ops 62 and 63 left it dragged on 22, -1, past the edge", () => {
      for (const hidden of [false, true]) {
        for (const [who, actor] of [["Pat", P1], ["the DM", DM]] as const) {
          const where = `${hidden ? "hidden" : "shown"}, ${who}`;
          for (const v of [62, 63]) assert.deepEqual([...at(run(edge(hidden), op, actor, v), "gob"), run(edge(hidden), op, actor, v).tokens.gob!.attached?.to], [22, -1, "horse"], `${where}, op ${v}`);
          const after = run(edge(hidden), op, actor);
          assert.deepEqual([...at(after, "gob"), after.tokens.gob!.attached?.to], [21, 0, "horse"], where);
          holds(SQUARES, after, "gob", ["horse"], where);
        }
      }
      assert.deepEqual(canApply(op, P1, edge(false), deps), canApply(op, P1, edge(true), deps), "Pat's answer, shown or hidden");
      twinned(edge(true), op, "gob", "hidden");
    });

    test("boxed in by walls, the goblin is let go on the nearest spot that holds, and its walk stays the one past the edge", () => {
      const s = room({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
      s.buildChunks = {};
      wall(s, "dragend00001", [22, 0], [22, 2]);
      wall(s, "dragend00002", [24, 0], [24, 2]);
      wall(s, "dragend00003", [22, 2], [24, 2]);
      s.tokens.horse = token("horse", { size: "large", x: 22, y: 1, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      s.tokens.gob = token("gob", { x: 22, y: 0, name: "Goblin", attached: { to: "horse", kind: "drag" } });
      for (const [who, actor] of [["Pat", P1], ["the DM", DM]] as const) {
        assert.ok(canApply(op, actor, s, deps).ok, who);
        assert.deepEqual([...at(run(s, op, actor, 63), "gob"), run(s, op, actor, 63).tokens.gob!.attached?.to], [22, -1, "horse"], `${who}, op 63`);
        const after = run(s, op, actor);
        assert.deepEqual([...at(after, "gob"), after.tokens.gob!.attached], [20, 0, undefined], `${who}: let go`);
        holds(SQUARES, after, "gob", ["horse"], who);
        const way = wayOf(planMove(op, s, actor, {}).find((m) => m.tokenId === "gob")!).route;
        assert.deepEqual([way.at(-1)!.x, way.at(-1)!.y], [22, -1], `${who}: its walk`);
      }
    });
  });

  test("with no spot a step from its end, the DM's move lets the goblin go where its walk ends", () => {
    const s = room({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
    s.buildChunks = {};
    wall(s, "dragend00006", [16, 0], [24, 0]);
    wall(s, "dragend00007", [24, 0], [30, 0]);
    s.tokens.horse = token("horse", { size: "large", x: 22, y: 2, name: "Warhorse", kind: "npc" });
    s.tokens.gob = token("gob", { x: 22, y: 1, name: "Goblin", attached: { to: "horse", kind: "drag" } });
    const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 22, y: 0 };
    assert.ok(canApply(op, DM, s, deps).ok);
    assert.deepEqual([...at(run(s, op, DM, 63), "gob"), run(s, op, DM, 63).tokens.gob!.attached?.to], [22, -1, "horse"], "op 63");
    const after = run(s, op, DM);
    assert.deepEqual([...at(after, "gob"), after.tokens.gob!.attached], [22, -1, undefined], "let go");
  });

  test("one every player sees on a link they cannot see ends where its place carries it, wherever the hidden holder stands, as beside a dropped seat (HEXOP-OPUS4-2)", () => {
    // Bree rides Pat's warhorse with a hidden owl perched on her, which drags a goblin every player sees off the scene's top edge.
    const ends = [0, 0.5].map((dx) => {
      const s = room({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 } }) } });
      s.tokens.horse = token("horse", { size: "large", x: 22, y: 2, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      s.tokens.bree = token("bree", { x: 22, y: 2, name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
      s.tokens.owl = token("owl", { size: "tiny", x: 22 + dx, y: 2, name: "Owl", kind: "npc", visibility: "dm", attached: { to: "bree", kind: "perch" } });
      s.tokens.gob = token("gob", { x: 22, y: 1, name: "Goblin", attached: { to: "owl", kind: "drag" } });
      const after = run(s, { t: "token.move", tokenId: "horse", x: 22, y: 0 }, P1);
      return at(after, "gob");
    });
    assert.deepEqual(ends, [[22, -1], [22, -1]]);
  });

  test("over the random hex rooms, Pat's moves with the creatures he cannot see that nothing hangs from and without them: the same answer, and the same copy of every walk every player sees", () => {
    let moves = 0;
    let hiddenSettled = 0;
    for (const [name, g] of [
      ["hex rows", ROWS],
      ["hex columns", COLUMNS],
    ] as const) {
      for (const make of [caseOf, insideCaseOf]) {
        for (let seed = 1; seed <= 300; seed++) {
          const room = make(seed, g);
          if (!room) continue;
          for (const made of [room, withImpAhead(room, seed), withMouse(room, seed), withOgre(room, seed)]) {
            if (!made) continue;
            const s = made.state;
            // Those Pat cannot see that nothing hangs from. One seen on a link he cannot see walks the private pass, which reads them.
            const hidden = Object.values(s.tokens).filter((t) => t!.visibility === "dm" && !t!.ownerIds.includes("p1") && !Object.values(s.tokens).some((o) => o!.attached?.to === t!.id)).map((t) => t!.id);
            if (hidden.length === 0) continue;
            const alone = structuredClone(s);
            for (const id of hidden) delete alone.tokens[id];
            const at = `${name} ${make.name} seed ${seed}`;
            const answer = canApply(made.op, P1, s, deps);
            assert.deepEqual(answer, canApply(made.op, P1, alone, deps), `${at}: the answer`);
            if (!answer.ok) continue;
            const seen = planWalks(made.op, s, P1, {}).filter((m) => m.pass === "public").map((m) => m.tokenId);
            const copy = (state: RoomState, opVersion?: number) => {
              const tokens = projectState(run(state, made.op, P1, opVersion), P1, { sceneId: "s1" }).tokens as Record<string, unknown>;
              return stableStringify(seen.map((id) => tokens[id]));
            };
            // Rooms whose copies already part at op 63 are no twins of this rule.
            if (copy(s, 63) !== copy(alone, 63)) continue;
            assert.equal(copy(s), copy(alone), `${at}: Pat's copy`);
            moves++;
            hiddenSettled += planWalks(made.op, s, P1, {}).filter((m) => hidden.includes(m.tokenId) && m.carried !== undefined).length;
          }
        }
      }
    }
    assert.ok(moves >= 300 && hiddenSettled >= 20, `moves ${moves}, hidden ones landed beside their holders ${hiddenSettled}`);
  });

  describe("onto another floor (FLR4INT-ASTRA-04)", () => {
    /**
     * The tower, every floor walled by the build, Upper floor's ground and
     * the road's 10 ft up: a squeezed warhorse of the DM's on 3.5, 3.5 of
     * Ground floor, dragging a goblin on 5, 4, at `z`, shown or hidden.
     */
    function stable(hidden: boolean, z = 0): RoomState {
      const s = tower();
      s.scenes.r = scene("r", { name: "Road", bounds: { w: 30, h: 20 }, order: 1 });
      for (const id of [GROUND, UPPER, "r"]) s.scenes[id] = { ...s.scenes[id]!, blockMovement: true };
      for (const id of [UPPER, "r"]) s.buildChunks[chunkKey(id, 0, 0)] = { sceneId: id, cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(new Int16Array(CHUNK_CELLS * CHUNK_CELLS).fill(10)) };
      s.tokens.horse = token("horse", { sceneId: GROUND, size: "large", x: 3.5, y: 3.5, squeeze: true, name: "Warhorse", kind: "npc" });
      s.tokens.gob = token("gob", { sceneId: GROUND, x: 5, y: 4, elevation: z, name: "Goblin", attached: { to: "horse", kind: "drag" }, ...(hidden ? { visibility: "dm" as const } : {}) });
      return s;
    }
    // Move to floor's own op for the warhorse alone (client tokens/moveToFloor.ts), onto the ground up there.
    const up: OpOf<"token.update"> = { t: "token.update", tokenId: "horse", patch: { sceneId: UPPER, elevation: 10 } };
    const pose = (s: RoomState, id: string) => [s.tokens[id]!.sceneId, s.tokens[id]!.x, s.tokens[id]!.y, s.tokens[id]!.elevation, s.tokens[id]!.attached?.to];

    test("up to a floor whose ground is 10 ft, the goblin off the warhorse's space lands on 5, 3 on that ground, still dragged, shown or hidden, where op 63 left it on 5, 4 over the warhorse", () => {
      for (const hidden of [false, true]) {
        const where = hidden ? "hidden" : "shown";
        assert.deepEqual(pose(run(stable(hidden), up, DM, 63), "gob"), [UPPER, 5, 4, 10, "horse"], `${where}, op 63`);
        const after = run(stable(hidden), up, DM);
        assert.deepEqual(pose(after, "horse"), [UPPER, 3.5, 3.5, 10, undefined], where);
        assert.deepEqual(pose(after, "gob"), [UPPER, 5, 3, 10, "horse"], where);
        assert.ok(!overlaps(SQUARES, after.tokens.gob!, after.tokens.horse!), `${where}: off the warhorse`);
        assert.ok(linkHolds(SQUARES, after.meta.settings, "drag", after.tokens.gob!, after.tokens.horse!), `${where}: in reach`);
        if (!hidden) continue;
        // The twin with no goblin: every player's copy the same.
        const alone = stable(true);
        delete alone.tokens.gob;
        for (const viewer of [P1, P2]) assert.equal(stableStringify(projectState(after, viewer, { sceneId: UPPER })), stableStringify(projectState(run(alone, up, DM), viewer, { sceneId: UPPER })), `${viewer.memberId}'s copy`);
      }
    });

    test("the walls it steps past are the floor's it lands on: one on Upper floor's line 4 sends it to 6, 4, and one on Ground floor's changes nothing", () => {
      const walled = (sceneId: string) => {
        const s = stable(false);
        wall(s, "dragend00008", [4, 4], [7, 4], { kind: "wall" }, sceneId);
        return run(s, up, DM);
      };
      assert.deepEqual(pose(walled(UPPER), "gob"), [UPPER, 6, 4, 10, "horse"], "a wall up there");
      assert.deepEqual(pose(walled(GROUND), "gob"), [UPPER, 5, 3, 10, "horse"], "a wall left below");
    });

    test("one in the air keeps its height over its holder up there, one on its ground lands on the ground there under a holder flying higher, and on another scene the holder's change of height alone, as op 63 had them", () => {
      for (const v of [63, undefined]) {
        assert.deepEqual(pose(run(stable(false, 15), up, DM, v), "gob").slice(0, 4), [UPPER, 5, v === 63 ? 4 : 3, 25], `op ${v ?? 64}: 15 ft over the warhorse`);
        const flying: OpOf<"token.update"> = { t: "token.update", tokenId: "horse", patch: { sceneId: UPPER, elevation: 15 } };
        assert.deepEqual(pose(run(stable(false), flying, DM, v), "gob"), [UPPER, 5, v === 63 ? 4 : 3, 10, "horse"], `op ${v ?? 64}: on the ground under a warhorse 15 ft up`);
        const road: OpOf<"token.update"> = { t: "token.update", tokenId: "horse", patch: { sceneId: "r" } };
        assert.deepEqual(pose(run(stable(false), road, DM, v), "gob"), ["r", 5, v === 63 ? 4 : 3, 0, "horse"], `op ${v ?? 64}: onto the road`);
      }
    });
  });

  describe("out of a squeeze (LP45-DRAG-1)", () => {
    test("squares: the warhorse squeezed on 8.5, 5.5 onto 5, 5 full size, the goblin it drags from 10, 6 lands on 7, 5, shown or hidden, where op 63 left it on 6.5, 5.5 over the warhorse", () => {
      for (const hidden of [false, true]) {
        const s = room({ scenes: { s1: scene("s1", { bounds: { w: 20, h: 12 } }) } });
        s.tokens.horse = token("horse", { size: "large", x: 8.5, y: 5.5, squeeze: true, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
        s.tokens.gob = token("gob", { x: 10, y: 6, name: "Goblin", attached: { to: "horse", kind: "drag" }, ...(hidden ? { visibility: "dm" as const } : {}) });
        const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 5, y: 5 };
        for (const [who, actor] of [["Pat", P1], ["the DM", DM]] as const) {
          const where = `${hidden ? "hidden" : "shown"}, ${who}`;
          assert.ok(canApply(op, actor, s, deps).ok, where);
          assert.deepEqual(at(run(s, op, actor, 63), "gob"), [6.5, 5.5], `${where}, op 63`);
          const after = run(s, op, actor);
          assert.deepEqual([...at(after, "gob"), after.tokens.gob!.attached?.to], [7, 5, "horse"], where);
          holds(SQUARES, after, "gob", ["horse"], where);
        }
        if (hidden) twinned(s, op, "gob", "hidden");
      }
    });

    for (const [name, g, own] of [
      ["hex rows", ROWS, "6,6"],
      ["hex columns", COLUMNS, "7,6"],
    ] as const) {
      test(`${name}: the warhorse squeezed on a hex's middle onto a stand full size, the captive it drags lands on hex ${own} of its own, where op 63 left it off its grid`, () => {
        const s = hexWallRoom(g === ROWS ? "hexRows" : "hexColumns", 30, 30, []);
        s.scenes.s1!.blockMovement = false;
        const horse = onHex(g, "horse", "medium", { col: 10, row: 10 }, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
        s.tokens.horse = { ...horse, size: "large", x: horse.x - 0.5, y: horse.y - 0.5, squeeze: true };
        s.tokens.cap = onHex(g, "cap", "medium", { col: 11, row: 10 }, { name: "Captive", attached: { to: "horse", kind: "drag" } });
        const to = placedOnHex(g, { ...s.tokens.horse, squeeze: undefined }, { col: 5, row: 6 });
        const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: to.x, y: to.y };
        for (const [who, actor] of [["Pat", P1], ["the DM", DM]] as const) {
          const old = run(s, op, actor, 63).tokens.cap!;
          const snapped = placedOnHex(g, old, tokenRefHex(g, old));
          assert.ok(Math.abs(snapped.x - old.x) + Math.abs(snapped.y - old.y) > 0.1, `${who}, op 63: off its grid, on ${old.x}, ${old.y}`);
          const after = run(s, op, actor);
          assert.deepEqual([hexesOf(g, after, "cap"), after.tokens.cap!.attached?.to], [[own], "horse"], who);
          holds(g, after, "cap", ["horse"], who);
        }
      });
    }
  });

  test("hex columns: with no stand clear of the goblin by the corridor, the DM's move lets the hidden ogre the goblin drags go where it started, and writes it", () => {
    const g = COLUMNS;
    const { s, path } = keepOf(g, 1, 0, "horse");
    for (const id of ["horse", "gob"]) s.tokens[id] = { ...s.tokens[id]!, elevation: 40 };
    s.tokens.ogre = { ...onHex(g, "ogre", "large", { col: 6, row: 6 }, { name: "Ogre", kind: "npc", visibility: "dm", attached: { to: "gob", kind: "drag" } }), elevation: 40 };
    const op = { ...intoCorridor(g, s, path[4]!), elevation: 0 };
    assert.ok(canApply(op, DM, s, deps).ok);
    const old = run(s, op, DM, 63);
    assert.ok(hexesOf(g, old, "ogre").some((h) => hexesOf(g, old, "gob").includes(h)), "op 63: on the goblin's hex");
    assert.equal(old.tokens.ogre!.attached?.to, "gob");
    const after = run(s, op, DM);
    assert.deepEqual([...at(after, "ogre"), after.tokens.ogre!.elevation, after.tokens.ogre!.attached], [s.tokens.ogre.x, s.tokens.ogre.y, 40, undefined], "let go where it started");
    assert.ok(planMove(op, s, DM, {}).some((m) => m.tokenId === "ogre"), "the move writes it");
  });

  describe("on its rider's hex inside the mount (LP45-DRAG-2)", () => {
    for (const [name, g, own] of [
      ["hex rows", ROWS, "6,1"],
      ["hex columns", COLUMNS, "1,6"],
    ] as const) {
      test(`${name}: Pat drops Bree on 7, 2 beside the rock, and the hidden goblin she drags lands on hex ${own}, where op 63 left it on her hex`, () => {
        const turn = (c: number, r: number): Hex => (g === ROWS ? { col: c, row: r } : { col: r, row: c });
        const rock = (h: Hex) => (g === ROWS ? h.col >= 8 && h.col <= 11 : h.row >= 8 && h.row <= 11);
        const s = hexWallRoom(g === ROWS ? "hexRows" : "hexColumns", 16, 12, wallsRound(g, { w: 16, h: 12 }, rock));
        s.tokens.horse = onHex(g, "horse", "large", turn(3, 3), { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
        s.tokens.bree = onHex(g, "bree", "medium", turn(3, 3), { name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
        s.tokens.gob = onHex(g, "gob", "medium", turn(4, 3), { name: "Goblin", visibility: "dm", attached: { to: "bree", kind: "drag" } });
        const to = hexStandPlace(g, s.tokens.horse, { size: "large", ref: turn(7, 2), squeezed: false });
        const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: to.x, y: to.y };
        const old = run(s, op, P1, 63);
        assert.deepEqual(hexesOf(g, old, "gob"), hexesOf(g, old, "bree"), "op 63: on her hex");
        const after = twinned(s, op, "gob", name);
        assert.deepEqual([hexesOf(g, after, "gob"), after.tokens.gob!.attached?.to], [[own], "bree"], "Pat");
        holds(g, after, "gob", ["bree", "horse"], "Pat");
        // The DM's drag never reads the walls of what it drags, so the goblin goes on into the rock, as at op 63.
        const rocked = hexKey(turn(8, 2));
        assert.deepEqual(hexesOf(g, run(s, op, DM, 63), "gob"), [rocked], "the DM, op 63");
        assert.deepEqual(hexesOf(g, run(s, op, DM), "gob"), [rocked], "the DM");
      });
    }

    test("squares: Pat's drop of the warhorse from 3, 3 onto 6, 3 by a wall on line 8 lands the hidden goblin Bree drags on 7, 2, where op 63 left it on her square", () => {
      const s = room({ scenes: { s1: scene("s1", { bounds: { w: 20, h: 12 }, blockMovement: true, autoWalls: "off" }) } });
      s.buildChunks = {};
      // In two pieces, since the build drops a piece longer than 8 cells.
      wall(s, "dragend00004", [8, 0], [8, 8]);
      wall(s, "dragend00005", [8, 8], [8, 12]);
      s.tokens.horse = token("horse", { size: "large", x: 3, y: 3, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      s.tokens.bree = token("bree", { x: 4, y: 3, name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
      s.tokens.gob = token("gob", { x: 5, y: 3, name: "Goblin", visibility: "dm", attached: { to: "bree", kind: "drag" } });
      const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 6, y: 3 };
      const old = run(s, op, P1, 63);
      assert.deepEqual([at(old, "bree"), at(old, "gob")], [[7, 3], [7, 3]], "op 63: on her square");
      const after = twinned(s, op, "gob", "squares");
      assert.deepEqual([at(after, "bree"), at(after, "gob"), after.tokens.gob!.attached?.to], [[7, 3], [7, 2], "bree"]);
      holds(SQUARES, after, "gob", ["bree", "horse"], "Pat");
      for (const v of [63, undefined]) assert.deepEqual(at(run(s, op, DM, v), "gob"), [8, 3], `the DM, op ${v ?? "now"}: past the wall, as before`);
    });
  });

  test("over the random hex rooms in single file, Pat's and the DM's: one that lands beside its holder takes no hex where the move leaves another every player sees, so no two of them share a hex they did not at op 63", () => {
    let moves = 0;
    let settled = 0;
    for (const [name, g] of [
      ["hex rows", ROWS],
      ["hex columns", COLUMNS],
    ] as const) {
      for (const make of [caseOf, insideCaseOf]) {
        for (let seed = 1; seed <= 300; seed++) {
          const room = make(seed, g);
          if (!room) continue;
          for (const made of [room, withImpAhead(room, seed), withMouse(room, seed)]) {
            if (!made) continue;
            for (const actor of [P1, DM]) {
              if (!canApply(made.op, actor, made.state, deps).ok) continue;
              const at = `${name} ${make.name} seed ${seed}, ${actor.memberId}`;
              // The lead and those of the file every player sees with their links, where the move leaves them.
              const shared = (opVersion?: number) => {
                const walks = planWalks(made.op, made.state, actor, opVersion === undefined ? {} : { opVersion });
                const seen = walks.filter((m) => m.tokenId === made.op.tokenId || (m.file === true && m.pass === "public"));
                const hexes = seen.map((m) => [m.tokenId, occupiedHexes(g, { ...made.state.tokens[m.tokenId]!, ...m.to }).map(hexKey)] as const);
                const out = new Set<string>();
                for (const [i, [a, ha]] of hexes.entries()) for (const [b, hb] of hexes.slice(i + 1)) if (ha.some((h) => hb.includes(h))) out.add(`${a}+${b}`);
                return { out, settled: walks.filter((m) => m.carried !== undefined && m.file === true).length };
              };
              const old = shared(63).out;
              const now = shared();
              for (const pair of now.out) assert.ok(old.has(pair), `${at}: ${pair} share a hex only from 64`);
              moves++;
              settled += now.settled;
            }
          }
        }
      }
    }
    assert.ok(moves >= 1000 && settled >= 100, `moves ${moves}, settled ${settled}`);
  });
});
