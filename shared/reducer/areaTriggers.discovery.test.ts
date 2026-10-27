import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { lift, liftAllBut, wall } from "../discoveryTestutil.ts";
import { MAP_DISCOVERY_OP_VERSION } from "../migrate.ts";
import { FOG_SUBCELLS, type LogEvent, type RoomState } from "../model.ts";
import { cellVision } from "../perPlayerTestutil.ts";
import { projectState, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { visionRules } from "../ruleHooks.ts";
import { isHex, sceneGrid } from "../rules/grid.ts";
import { hexAt, hexCenter, hexInScene, hexKey, hexNeighbors, hexSubcells, parseHexKey, sceneHexes, type HexGrid } from "../rules/hex.ts";
import { convexLive, groundOf, pendingGround } from "../rules/held.ts";
import { clearVisionCache, visionCacheReport } from "../rules/vision.ts";
import { DM, P1, P2, entry, env, member, room, template, token } from "../testutil.ts";

/**
 * Area reminders by each receiver's live ground (docs/design-v1-map-discovery.md
 * decision 13): a player reads a reminder only when every ray its
 * inclusion test reads, from where the area starts to the creature, lies
 * on their sight or the DM's reveals, or on revealed ground with fog on and
 * vision off. Sight is perPlayerTestutil.ts's stub: in the dark each
 * creature sees one cell around it.
 */
const real = { ...visionRules };
before(() => Object.assign(visionRules, cellVision));
after(() => Object.assign(visionRules, real));

/** A goblin's turn at (12, 5) inside a DM's Cloudkill centered on cell (8, 5), on a scene with fog on. */
function fight(vision?: "dark"): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } });
  s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true, ...(vision ? { vision: { on: true, light: vision } } : {}) };
  s.tokens.g1 = token("g1", { name: "Goblin", number: 1, x: 12, y: 5 });
  s.templates.cloud = template("cloud", { size: 40, origin: { x: 8.5, y: 5.5, z: 0 }, spell: "Cloudkill", ownerId: "dm1", triggers: ["turnEnd"] });
  s.encounter = { rev: 0, round: 1, activeEntryId: "e-g1", entries: [entry("e-g1", { tokenId: "g1", value: 15 })] };
  return s;
}

/** Ends the goblin's turn and returns the reminder written, and the state. */
function turnEnd(s: RoomState, opVersion?: number): { reminder: LogEvent | undefined; state: RoomState } {
  const r = applyOp(s, { t: "encounter.next" } as Op, DM, { ...env(5), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, r.ok ? "" : r.message);
  return { reminder: r.log.find((e) => e.data?.type === "area")?.data, state: r.state };
}

function reads(state: RoomState, who = P1): boolean {
  return projectState(state, who, { sceneId: "s1" }).log.some((e) => e.data?.type === "area");
}

describe("an area's reminder by the receiver's live ground (decision 13)", () => {
  test("an area aimed past unrevealed ground, nothing moving: no reminder for players, revealed whole it reaches them", () => {
    const open = fight();
    lift(open, "dm", { x: 0, y: 0, w: 24, h: 16 });
    const seen = turnEnd(open);
    assert.equal(seen.reminder?.type === "area" && seen.reminder.hidden, undefined);
    assert.ok(reads(seen.state), "on revealed ground every player reads it");
    // One cell between the cloud's middle and the goblin left under fog: a wall the DM never revealed may stand there.
    const gap = fight();
    lift(gap, "dm", { x: 0, y: 0, w: 24, h: 16 });
    lift(gap, "dm", { x: 10, y: 5, w: 1, h: 1 }, "s1", false);
    const hidden = turnEnd(gap);
    assert.equal(hidden.reminder?.type === "area" && hidden.reminder.hidden, true);
    assert.equal(reads(hidden.state), false);
  });

  test("an 8 x 8 revealed room around the cloud and a goblin against its far side: the goblin's own edge does not count, the room's does", () => {
    const s = fight();
    s.tokens.g1 = { ...s.tokens.g1!, x: 11, y: 5 };
    lift(s, "dm", { x: 5, y: 2, w: 7, h: 8 });
    // The goblin's cell is the room's last column: the ground past its east side stays under fog.
    assert.ok(reads(turnEnd(s).state), "rays end inside the footprint, short of the cells beside it");
    const short = fight();
    short.tokens.g1 = { ...short.tokens.g1!, x: 11, y: 5 };
    lift(short, "dm", { x: 5, y: 2, w: 6, h: 8 });
    assert.equal(reads(turnEnd(short).state), false, "the goblin's own cell under fog");
  });

  test("ops from before map discovery replay with the reminders they wrote", () => {
    const gap = fight();
    lift(gap, "dm", { x: 0, y: 0, w: 24, h: 16 });
    lift(gap, "dm", { x: 10, y: 5, w: 1, h: 1 }, "s1", false);
    const old = turnEnd(gap, MAP_DISCOVERY_OP_VERSION - 1);
    assert.equal(old.reminder?.type === "area" && old.reminder.hidden, undefined);
  });

  test("with vision on, ground the party only explored does not carry a reminder, ground in its sight does", () => {
    const s = fight("dark");
    lift(s, "party", { x: 0, y: 0, w: 24, h: 16 });
    // The scout sees cells 10 to 12 of row 5, the goblin's among them.
    s.tokens.scout = token("scout", { kind: "pc", name: "Scout", disposition: "ally", ownerIds: ["p1"], x: 11, y: 5 });
    const explored = turnEnd(s);
    assert.equal(reads(explored.state), false, "the cloud's middle and the cell after it only explored");
    lift(s, "dm", { x: 8, y: 5, w: 2, h: 1 });
    assert.ok(reads(turnEnd(s).state), "the DM revealed cells 8 and 9");
  });

  test("per player: a witness of an area reads its reminder only by their own live ground", () => {
    const s = fight("dark");
    s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "dark", perPlayer: true } };
    s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] };
    // p1's scout sees cells 10 to 12 of row 5, p2's Bree the goblin's cell from the east, and the DM revealed cells 8 and 9.
    s.tokens.scout = token("scout", { kind: "pc", name: "Scout", disposition: "ally", ownerIds: ["p1"], x: 11, y: 5 });
    s.tokens.bree = token("bree", { kind: "pc", name: "Bree", disposition: "ally", ownerIds: ["p2"], x: 13, y: 5 });
    lift(s, "dm", { x: 8, y: 5, w: 2, h: 1 });
    // Sight is live only on ground its explore step has added to the explored layers, here all of it.
    lift(s, "party", { x: 0, y: 0, w: 24, h: 16 });
    const { reminder, state } = turnEnd(s);
    assert.ok(reminder?.type === "area");
    assert.ok(reads(state, P1), "the rays cross only ground p1 sees or the DM revealed");
    assert.equal(reads(state, P2), false, "p2 sees the goblin and the cloud, but not cells 10 and 11");
    const before = turnEnd(s, MAP_DISCOVERY_OP_VERSION - 1);
    assert.ok(reads(before.state, P2), "before map discovery the witness read it");
  });

  test("with vision on, ground the op brought into sight counts though the explore step has not yet added it (MD2-O-3)", () => {
    const s = fight("dark");
    // The party explored only up to x = 10, short of the scout's sight of cells 10 to 12, and the DM revealed cells 8 and 9.
    lift(s, "party", { x: 0, y: 0, w: 10, h: 16 });
    lift(s, "dm", { x: 8, y: 5, w: 2, h: 1 });
    s.tokens.scout = token("scout", { kind: "pc", name: "Scout", disposition: "ally", ownerIds: ["p1"], x: 11, y: 5 });
    const { reminder } = turnEnd(s);
    assert.ok(reminder?.type === "area");
    assert.equal(reminder.hidden, undefined, "the rays cross only ground in sight or revealed");
    // Without the scout nothing sees cells 10 to 12, explored or not.
    const { scout: _, ...rest } = s.tokens;
    assert.equal((turnEnd({ ...s, tokens: rest }).reminder as { hidden?: true } | undefined)?.hidden, true);
  });

  for (const gridShape of ["hexRows", "hexColumns"] as const) {
    test(`${gridShape}: a wall inside one unrevealed hex the rays cross, and no wall there: the same projection and the same reminder (MD2-ASTRA-3)`, () => {
      const make = (at: { x: number; y: number }, withWall: boolean) => {
        const s = fight();
        s.scenes.s1 = { ...s.scenes.s1!, gridShape };
        const grid = sceneGrid(s.scenes.s1) as HexGrid;
        const hex = hexAt(grid, at);
        // Every square cell round it is partly revealed, so only the hex itself says the ground is unheld.
        liftAllBut(s, "dm", [hexKey(hex)]);
        const c = hexCenter(grid, hex);
        const lattice = (v: number) => Math.round(v * 64) / 64;
        if (withWall) wall(s, "abcdefghijkl", [lattice(c.x), lattice(c.y - 0.25)], [lattice(c.x), lattice(c.y + 0.25)]);
        return s;
      };
      // Astra's Cloudkill: the hex its origin stands in, and one the rays to the goblin cross.
      for (const at of [{ x: 8.5, y: 5.5 }, { x: 10.5, y: 5.5 }]) {
        const [a, b] = [make(at, true), make(at, false)];
        assert.equal(stableStringify(projectState(a, P1, { sceneId: "s1" })), stableStringify(projectState(b, P1, { sceneId: "s1" })), "p1 cannot tell the rooms apart");
        assert.equal(reads(turnEnd(a).state), false);
        assert.equal(reads(turnEnd(b).state), false, `a hex at ${at.x}, ${at.y} under fog keeps the line the DM's`);
      }
      // Revealed whole, the line reaches players.
      const open = fight();
      open.scenes.s1 = { ...open.scenes.s1!, gridShape };
      liftAllBut(open, "dm", []);
      assert.ok(reads(turnEnd(open).state));
    });
  }

  test("an emanation reads the cells beside the corners of the creature it surrounds, where a probe stepped off a wall would start (MD2-LK-5)", () => {
    const make = (hidden: boolean) => {
      const s = fight();
      s.tokens.cleric = token("cleric", { kind: "pc", name: "Cleric", disposition: "ally", ownerIds: ["p1"], x: 10, y: 5 });
      s.templates.cloud = template("cloud", { shape: "emanation", size: 15, attachedTo: "cleric", casterId: "cleric", includeOrigin: false, spell: "Spirit Guardians", ownerId: "p1", triggers: ["turnEnd"], origin: { x: 10.5, y: 5.5, z: 0 } });
      lift(s, "dm", { x: 0, y: 0, w: 24, h: 16 });
      // The cell off the cleric's north-west corner, which no ray to the goblin in the east crosses but a probe moved off a wall there may start in.
      if (hidden) lift(s, "dm", { x: 9, y: 4, w: 1, h: 1 }, "s1", false);
      return s;
    };
    assert.ok(reads(turnEnd(make(false)).state));
    assert.equal(reads(turnEnd(make(true)).state), false);
  });

  test("an origin within 1/64 cell of a cell's side reads the cell past it, where a probe moved off a wall would start (MD2-LK-5)", () => {
    const make = (hidden: boolean) => {
      const s = fight();
      s.templates.cloud = { ...s.templates.cloud!, origin: { x: 8.5, y: 5 + 1 / 128, z: 0 } };
      lift(s, "dm", { x: 0, y: 0, w: 24, h: 16 });
      if (hidden) lift(s, "dm", { x: 8, y: 4, w: 1, h: 1 }, "s1", false);
      return s;
    };
    assert.ok(reads(turnEnd(make(false)).state));
    assert.equal(reads(turnEnd(make(true)).state), false);
  });

  test("a Tiny goblin is judged by samples across the whole cell it stands in, so the rays to its far side count (MD2-LK-5)", () => {
    const make = (hidden: boolean) => {
      const s = fight();
      s.tokens.g1 = { ...s.tokens.g1!, size: "tiny" };
      s.templates.cloud = { ...s.templates.cloud!, origin: { x: 16.5, y: 0.5, z: 0 } };
      lift(s, "dm", { x: 0, y: 0, w: 24, h: 16 });
      // Only the rays to the east half of cell (12, 5), past the goblin's own half, cross cell (14, 4).
      if (hidden) lift(s, "dm", { x: 14, y: 4, w: 1, h: 1 }, "s1", false);
      return s;
    };
    assert.ok(reads(turnEnd(make(false)).state));
    assert.equal(reads(turnEnd(make(true)).state), false);
  });

  test("an attached emanation whose stored origin lies far off the scene reads only the ground round its token (MD2-ASTRA-7)", () => {
    for (const gridShape of [undefined, "hexRows", "hexColumns"] as const) {
      const s = fight();
      s.scenes.s1 = { ...s.scenes.s1!, bounds: { w: 40, h: 30 }, ...(gridShape ? { gridShape } : {}) };
      s.tokens.cleric = token("cleric", { kind: "pc", name: "Cleric", disposition: "ally", ownerIds: ["p1"], x: 10, y: 5 });
      s.templates.cloud = template("cloud", { shape: "emanation", size: 15, attachedTo: "cleric", casterId: "cleric", includeOrigin: false, spell: "Spirit Guardians", ownerId: "p1", triggers: ["turnEnd"], origin: { x: 400, y: 400, z: 0 } });
      if (gridShape) liftAllBut(s, "dm", []);
      else lift(s, "dm", { x: 0, y: 0, w: 40, h: 30 });
      // The far rows toward the stored origin under fog: the area never reads them.
      lift(s, "dm", { x: 0, y: 26, w: 40, h: 4 }, "s1", false);
      assert.ok(reads(turnEnd(s).state), gridShape ?? "squares");
    }
  });

  test("a hull reaching far off the scene costs no more than the scene, on squares and both hex orientations (MD2-ASTRA-7)", () => {
    for (const gridShape of [undefined, "hexRows", "hexColumns"] as const) {
      const s = fight();
      s.scenes.s1 = { ...s.scenes.s1!, bounds: { w: 40, h: 30 }, ...(gridShape ? { gridShape } : {}) };
      if (gridShape) liftAllBut(s, "dm", []);
      else lift(s, "dm", { x: 0, y: 0, w: 40, h: 30 });
      const ground = groundOf(s, "s1", null)!;
      const into = { n: 0 };
      assert.ok(convexLive(ground, [{ x: 10, y: 5 }, { x: 400, y: 400 }], into));
      // The clipped box at most, on a half-cell grid for hexes.
      assert.ok(into.n <= 83 * 63, `${gridShape ?? "squares"}: ${into.n} visited`);
      const off = { n: 0 };
      assert.ok(convexLive(ground, [{ x: 300, y: 300 }, { x: 400, y: 400 }], off));
      assert.equal(off.n, 0, "a hull wholly off the scene visits nothing");
      // Still conservative at the scene's edge: a hidden cell there the hull crosses says no.
      lift(s, "dm", { x: 32, y: 28, w: 3, h: 2 }, "s1", false);
      assert.equal(convexLive(groundOf(s, "s1", null)!, [{ x: 10, y: 5 }, { x: 400, y: 400 }]), false);
    }
  });
});

describe("the ray test's live ground asked of the point query", () => {
  /*
   * Real sight, not the stub: a moment of a walk asks each holder's sight
   * cell by cell, and the answers must be the ones its tiles give, which
   * only a projection draws.
   */
  function lit(gridShape?: "hexRows" | "hexColumns"): RoomState {
    const s = fight("dark");
    s.scenes.s1 = { ...s.scenes.s1!, ...(gridShape ? { gridShape } : {}), vision: { on: true, light: "dark", perPlayer: true } };
    s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] };
    s.tokens.scout = token("scout", { kind: "pc", name: "Scout", disposition: "ally", ownerIds: ["p1"], x: 11, y: 5, light: { bright: 10, dim: 5 } });
    // In the scene's south-east corner, so hexes lit there reach past its sides.
    s.tokens.bree = token("bree", { kind: "pc", name: "Bree", disposition: "ally", ownerIds: ["p2"], x: 38, y: 28, light: { bright: 10, dim: 5 } });
    s.tokens.owl = token("owl", { name: "Owl", disposition: "ally", partyVision: true, x: 3, y: 12, light: { bright: 5, dim: 5 } });
    // Dark ground the DM revealed, and lit ground beside the scout.
    lift(s, "dm", { x: 4, y: 2, w: 4, h: 4 });
    lift(s, "dm", { x: 10, y: 4, w: 2, h: 1 });
    return s;
  }

  for (const gridShape of [undefined, "hexRows", "hexColumns"] as const) {
    test(`${gridShape ?? "squares"}: every class's live cells are its sight tiles' and the DM's reveals', and asking them draws no raster`, () => {
      const stub = { ...visionRules };
      Object.assign(visionRules, real);
      try {
        clearVisionCache();
        const at = lit(gridShape);
        const scene = at.scenes.s1!;
        const grid = sceneGrid(scene);
        // Hexes just past the scene's sides too, some of whose sub-cells lie on it.
        const cells = isHex(grid)
          ? [...new Set(sceneHexes(grid, scene.bounds).flatMap((hx) => [hx, ...hexNeighbors(grid, hx)]).map(hexKey))]
          : Array.from({ length: scene.bounds.w * scene.bounds.h }, (_, i) => `${i % scene.bounds.w},${Math.floor(i / scene.bounds.w)}`);
        const subsOf = (key: string): [number, number][] => {
          if (isHex(grid)) {
            const hx = parseHexKey(key)!;
            return hexInScene(grid, scene.bounds, hx) ? hexSubcells(grid, hx) : [];
          }
          const [x, y] = key.split(",").map(Number) as [number, number];
          return Array.from({ length: FOG_SUBCELLS * FOG_SUBCELLS }, (_, i) => [x * FOG_SUBCELLS + (i % FOG_SUBCELLS), y * FOG_SUBCELLS + Math.floor(i / FOG_SUBCELLS)]);
        };
        const revealed = groundOf(at, "s1", null)!;
        const grounds = [null, "p1", "p2"].map((holder) => pendingGround(at, "s1", holder)!);
        const asked = grounds.map((g) => cells.map((key) => g.keyLive(key)));
        assert.equal(visionCacheReport().rasters, 0, "a cell's sight asked of the point query draws no raster");
        let bySight = 0;
        let byDm = 0;
        for (const [i, g] of grounds.entries()) {
          for (const [j, key] of cells.entries()) {
            // Sub-cells read the tiles, each holder's raster drawn.
            assert.equal(asked[i]![j], subsOf(key).some(([sx, sy]) => g.subLive(sx, sy)), `class ${i}, ${key}`);
            if (asked[i]![j]) revealed.keyHeld(key) ? byDm++ : bySight++;
          }
        }
        assert.ok(visionCacheReport().rasters > 0, "the tiles read after drew the rasters");
        assert.ok(bySight > 60 && byDm > 30, `${bySight} cells live by sight alone, ${byDm} the DM revealed`);
        // The DM's dark corner, which no light reaches, is live by their reveal alone.
        const corner = isHex(grid) ? hexKey(hexAt(grid, { x: 4.5, y: 2.5 })) : "4,2";
        assert.deepEqual(grounds.map((g) => g.keyLive(corner)), [true, true, true]);
      } finally {
        Object.assign(visionRules, stub);
      }
    });
  }
});
