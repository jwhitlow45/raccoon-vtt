import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import { doorEdge } from "./layout.ts";
import { generate, planDungeon, type Planned } from "./plan.ts";
import { planProblems } from "./plan.testkit.ts";
import { Stream } from "./random.ts";
import { CROCKFORD, newSeed, versionChar, type Seed } from "./seed.ts";
import { clampSettings, DEFAULT_SETTINGS, defaultRooms, GENERATOR_VERSION, HEIGHT_PRESETS, HEIGHTS_MAX, HEIGHTS_STEP, roomCap, SEARCH_BUDGET, SIZE_SIDES, TRAPS_MAX, type DungeonSettings } from "./settings.ts";

/*
 * Property tests of the dungeon generator (docs/design/design-v1-dungeon-generator.md
 * 5.1 to 5.4, section 13): every plan keeps the invariants the landing lane
 * relies on, whatever the choices and seed, and every drop branch keeps
 * them too. plan.testkit.ts reads the invariants from the plan alone.
 */

const seedArb: fc.Arbitrary<Seed> = fc.array(fc.constantFrom(...CROCKFORD), { minLength: 15, maxLength: 15 }).map((c) => versionChar() + c.join(""));

const settingsArb: fc.Arbitrary<DungeonSettings> = fc
  .record({
    w: fc.oneof(fc.constantFrom(20, 30, 50, 80, 100), fc.integer({ min: 20, max: 100 })),
    h: fc.oneof(fc.constantFrom(20, 30, 50, 80, 100), fc.integer({ min: 20, max: 100 })),
    rooms: fc.integer({ min: 2, max: 40 }),
    density: fc.constantFrom("sparse", "normal", "dense"),
    corridors: fc.constantFrom("straight", "bending", "winding"),
    wide: fc.boolean(),
    loops: fc.boolean(),
    theme: fc.constantFrom("dungeon", "crypt"),
    heights: fc.integer({ min: 0, max: HEIGHTS_MAX / HEIGHTS_STEP }).map((n) => n * HEIGHTS_STEP),
    traps: fc.integer({ min: 0, max: TRAPS_MAX }),
    band: fc.constantFrom("1-4", "5-10", "11-16", "17-20"),
  } as const)
  .map((s) => clampSettings({ ...s, rooms: Math.min(s.rooms, roomCap(s.w, s.h)) }));

/** Seeds from a fixed stream, so a test that searches for a case finds the same one every run. */
function seeds(label: number): () => Seed {
  const key = new Uint8Array(32);
  key[0] = label;
  const stream = new Stream(key, new Uint8Array(12));
  return () => newSeed((b) => b.forEach((_, i) => (b[i] = stream.below(256))));
}

const ok = (p: Planned, s: DungeonSettings) => assert.deepEqual(planProblems(p, s), []);

describe("dungeon plans", () => {
  test("the same seed and choices make the same plan, which JSON keeps whole", () => {
    holds(
      fc.property(settingsArb, seedArb, (s, seed) => {
        const a = generate(s, seed);
        assert.deepEqual(generate(s, seed), a);
        assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
      }),
      15,
    );
  });

  test("every plan keeps the invariants: bounds, gaps, doors on sides, automatic walls, no corridor ledge, every room reached, Reveal room exact, traps placed by the rules", () => {
    holds(
      fc.property(settingsArb, seedArb, (s, seed) => {
        const p = planDungeon(s, seed);
        ok(p, s);
        assert.equal(p.plan.version, GENERATOR_VERSION);
        assert.equal(p.plan.asked, s.rooms);
        // The fitted count is the rooms kept, read after the drops.
        assert.equal(p.plan.rooms.length, p.board.rooms.filter((r) => !r.dropped).length);
        // No rubble or trap on a run, its far landing, a flattened run or a doorway's outside square.
        const kept = p.board.doorways.filter((d) => !d.removed);
        const runs = new Set(kept.flatMap((d) => [...d.outside, ...(d.run ? [...d.run.near, ...d.run.stairs.map((st) => st.cell), ...d.run.far] : []), ...(d.flat ?? [])]));
        const key = (k: number) => `${k % s.w},${Math.floor(k / s.w)}`;
        for (const c of p.plan.paint.rubble ?? []) assert.ok(![...runs].some((k) => key(k) === c), `rubble on a run at ${c}`);
        for (const t of p.plan.traps) {
          if (!("cells" in t.zone)) continue;
          const r = t.zone.cells[0]!;
          for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) assert.ok(!runs.has(y * s.w + x), `trap on a run at ${x},${y}`);
        }
        // The way in is always closed, never locked.
        if (p.stub) {
          const k = p.stub.inside[0]!;
          assert.equal(p.plan.doors.find((d) => d.edge === doorEdge(k % s.w, Math.floor(k / s.w), p.stub!.side))?.state, "closed");
        }
      }),
      60,
    );
  });

  test("the largest choices keep the invariants and the door cap", () => {
    for (const wide of [false, true]) {
      for (const density of ["sparse", "dense"] as const) {
        const s = clampSettings({ w: 100, h: 100, rooms: 40, density, corridors: "winding", wide, loops: true, theme: "crypt", heights: HEIGHTS_MAX, traps: TRAPS_MAX, band: "17-20" });
        const next = seeds(wide ? 1 : 2);
        for (let i = 0; i < 3; i++) ok(planDungeon(s, next()), s);
      }
    }
  });

  test("more rooms than fit: fewer kept, and a map that fits under two still makes a well-formed plan", () => {
    const crowded = clampSettings({ ...DEFAULT_SETTINGS, w: 30, h: 30, rooms: 10, density: "dense", wide: true });
    const next = seeds(3);
    let fewer = 0;
    for (let i = 0; i < 20; i++) {
      const p = planDungeon(crowded, next());
      ok(p, crowded);
      if (p.plan.rooms.length < p.plan.asked) fewer++;
    }
    assert.ok(fewer > 0);
    const tiny = clampSettings({ ...DEFAULT_SETTINGS, w: 20, h: 20, rooms: 4, density: "sparse", wide: true });
    const more = seeds(4);
    let under = 0;
    for (let i = 0; i < 200 && under === 0; i++) {
      const p = planDungeon(tiny, more());
      ok(p, tiny);
      if (p.plan.rooms.length < 2) under++;
    }
    assert.ok(under > 0, "a 20 by 20 Wide Sparse map sometimes fits only one room");
  });

  test("default choices fit every asked room in at least 95% of 200 seeds at each size preset", () => {
    for (const size of ["small", "medium", "large"] as const) {
      const side = SIZE_SIDES[size];
      const s = { ...DEFAULT_SETTINGS, w: side, h: side, rooms: defaultRooms(size, side, side) };
      const next = seeds(10 + side);
      let all = 0;
      for (let i = 0; i < 200; i++) if (generate(s, next()).rooms.length === s.rooms) all++;
      assert.ok(all >= 190, `${size}: ${all} of 200`);
    }
  });
});

describe("the mix", () => {
  /** Turns along a corridor's way, a block's square counted once. */
  const turns = (path: readonly number[], W: number) => {
    let n = 0;
    for (let i = 2; i < path.length; i++) {
      const d1 = path[i - 1]! - path[i - 2]!;
      const d2 = path[i]! - path[i - 1]!;
      if (d1 !== d2 && Math.abs(d1) <= W && Math.abs(d2) <= W) n++;
    }
    return n;
  };

  test("doors lock about 15% of the time in a Dungeon and 25% in a Crypt, and about a fifth of a Dungeon's rooms are wood", () => {
    for (const theme of ["dungeon", "crypt"] as const) {
      const s = { ...DEFAULT_SETTINGS, theme, w: 80, h: 80, rooms: 30 };
      const next = seeds(theme === "dungeon" ? 30 : 31);
      let doors = 0;
      let locked = 0;
      let rooms = 0;
      let wood = 0;
      for (let i = 0; i < 40; i++) {
        const p = generate(s, next());
        doors += p.doors.length;
        locked += p.doors.filter((d) => d.state === "locked").length;
        rooms += p.rooms.length;
        wood += p.rooms.filter((r) => r.floor === "wood").length;
      }
      const rate = locked / doors;
      if (theme === "dungeon") {
        assert.ok(rate > 0.11 && rate < 0.19, `dungeon locks ${rate}`);
        assert.ok(wood / rooms > 0.15 && wood / rooms < 0.25, `wood ${wood / rooms}`);
      } else {
        assert.ok(rate > 0.21 && rate < 0.29, `crypt locks ${rate}`);
        assert.equal(wood, 0);
        assert.ok(!generate(s, next()).paint.rubble);
      }
    }
  });

  test("Straight corridors turn least and Winding most, and only about a quarter of the rooms at most are raised or sunk", () => {
    const mean: number[] = [];
    let raised = 0;
    let rooms = 0;
    for (const corridors of ["straight", "bending", "winding"] as const) {
      const s = { ...DEFAULT_SETTINGS, corridors, w: 80, h: 80, rooms: 25 };
      const next = seeds(40);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 20; i++) {
        const p = planDungeon(s, next());
        for (const path of p.paths) if (path) (sum += turns(path, s.w)), n++;
        raised += p.plan.rooms.filter((r) => r.ground !== 0).length;
        rooms += p.plan.rooms.length;
      }
      mean.push(sum / n);
    }
    assert.ok(mean[0]! < mean[1]! && mean[1]! < mean[2]!, `turns ${mean.join(", ")}`);
    // Straight corridors keep to about an L: one or two turns.
    assert.ok(mean[0]! < 1.6, `Straight turns ${mean[0]}`);
    assert.ok(raised > 0 && raised / rooms <= 0.25, `raised ${raised / rooms}`);
  });
});

describe("the drops (5.4)", () => {
  /** The rooms whose tree path to the entrance runs through `room`, itself included. */
  function branchOf(p: Planned, room: number): number[] {
    const tree = p.links.filter((l) => l.kind === "tree");
    const out = [room];
    for (let i = 0; i < out.length; i++) for (const l of tree) if (l.a === out[i]) out.push(l.b);
    return out.sort((a, b) => a - b);
  }

  test("an empty budget: every tree link fails, every room but the entrance goes, and no door is left", () => {
    const s = { ...DEFAULT_SETTINGS };
    const next = seeds(20);
    for (let i = 0; i < 5; i++) {
      const p = planDungeon(s, next(), 0);
      ok(p, s);
      assert.equal(p.plan.rooms.length, 1);
      assert.ok(p.plan.rooms[0]!.entrance);
      assert.deepEqual(p.plan.doors, []);
      assert.ok(p.trace.stubFailed);
      assert.equal(p.trace.dropped.length, p.links.filter((l) => l.kind === "tree" && l.a === p.entrance).length);
    }
  });

  test("a budget that runs out partway drops the failed link's room and every room past it, and reads the count after", () => {
    const s = { ...DEFAULT_SETTINGS, heights: HEIGHT_PRESETS.Flat };
    const next = seeds(21);
    let seen = 0;
    for (let i = 0; i < 20; i++) {
      const seed = next();
      const full = planDungeon(s, seed);
      // Half what the tree took: some links are built, then the budget is gone.
      const p = planDungeon(s, seed, Math.floor((SEARCH_BUDGET - full.trace.treeLeft) / 2));
      ok(p, s);
      if (p.trace.dropped.length === 0) continue;
      seen++;
      const gone = new Set<number>();
      for (const d of p.trace.dropped) {
        assert.deepEqual([...d.rooms].sort((a, b) => a - b), branchOf(p, p.links[d.link]!.b));
        for (const r of d.rooms) gone.add(r);
      }
      assert.equal(p.plan.rooms.length, p.board.rooms.length - gone.size);
      // Every link built before the budget ran out stands as it was.
      p.paths.forEach((path, li) => {
        if (path && p.links[li]!.kind === "tree") assert.deepEqual(path, full.paths[li]);
      });
    }
    assert.ok(seen >= 10, `${seen} of 20 dropped a branch`);
  });

  test("a tree link that fails is retried once with its raised or sunk end rooms flat, and their runs turn to flat corridor", () => {
    // Budget to the end of the tree on a plan with raised rooms, less a little: the last links fail, and those to raised rooms are retried flat.
    // Straight and Wide, where a run most often stands in a link's way. Bending and Winding move their doorways, and a styled link that finds no way also tries the plain ones (corridors.prop.test.ts).
    const s = { ...DEFAULT_SETTINGS, w: 80, h: 80, rooms: 30, corridors: "straight" as const, wide: true };
    const next = seeds(22);
    let retried = 0;
    let rescued = 0;
    for (let i = 0; i < 300 && (retried < 5 || rescued < 1); i++) {
      const seed = next();
      const p = planDungeon(s, seed);
      if (p.trace.retried.length > 0) {
        // A retry the full budget met: a raised room's run blocked its own corridor, and flat it went through.
        ok(p, s);
        for (const li of p.trace.retried) {
          const l = p.links[li]!;
          for (const r of [l.a, l.b]) assert.equal(p.board.rooms[r]!.ground, 0);
          if (p.paths[li]) rescued++;
        }
        retried++;
      }
      const raised = p.board.rooms.some((r) => r.ground !== 0);
      if (!raised) continue;
      const short = planDungeon(s, seed, SEARCH_BUDGET - p.trace.treeLeft - 50);
      ok(short, s);
      for (const li of short.trace.retried) {
        const l = short.links[li]!;
        for (const r of [l.a, l.b]) if (!short.board.rooms[r]!.dropped) assert.equal(short.board.rooms[r]!.ground, 0);
      }
      if (short.trace.retried.length > 0) retried++;
    }
    assert.ok(retried >= 5, `${retried} plans retried a link`);
    assert.ok(rescued >= 1, "a flat retry that went through");
  });

  test("DG-R1-07: only a tree link the search found no way for is retried flat, never one with no doorway or an empty budget", () => {
    const s = { ...DEFAULT_SETTINGS, w: 80, h: 80, rooms: 30, corridors: "straight" as const, wide: true };
    const next = seeds(24);
    const whys = new Set<string>();
    let raisedBudget = 0;
    for (let i = 0; i < 60; i++) {
      const seed = next();
      const full = planDungeon(s, seed);
      for (const budget of [SEARCH_BUDGET, 0, Math.floor((SEARCH_BUDGET - full.trace.treeLeft) / 2)]) {
        const p = planDungeon(s, seed, budget);
        ok(p, s);
        const why = new Map(p.trace.failed.map((f) => [f.link, f.why]));
        for (const f of p.trace.failed) whys.add(f.why);
        for (const li of p.trace.retried) assert.equal(why.get(li), "none", `link ${li} retried after ${why.get(li)}`);
        // A link with a raised end that failed on the budget is dropped at once, its rooms keeping their ground.
        for (const f of p.trace.failed) {
          if (f.why === "none") continue;
          const l = p.links[f.link]!;
          if (full.board.rooms[l.a]!.ground !== 0 || full.board.rooms[l.b]!.ground !== 0) raisedBudget++;
          assert.ok(!p.trace.retried.includes(f.link));
        }
      }
    }
    assert.ok(whys.has("budget") && whys.has("none"), `failures seen: ${[...whys].join(", ")}`);
    assert.ok(raisedBudget >= 5, `${raisedBudget} failures on a raised room not retried`);
  });

  test("loops that fail are skipped with their doorways, doors and runs", () => {
    const s = { ...DEFAULT_SETTINGS };
    const next = seeds(23);
    let skipped = 0;
    for (let i = 0; i < 10; i++) {
      const seed = next();
      const full = planDungeon(s, seed);
      if (full.links.every((l) => l.kind === "tree")) continue;
      // Exactly the tree's budget: every tree link is built, the loops and the stub find none left.
      const p = planDungeon(s, seed, SEARCH_BUDGET - full.trace.treeLeft);
      ok(p, s);
      assert.deepEqual(p.trace.dropped, []);
      assert.equal(p.plan.rooms.length, full.plan.rooms.length);
      const loops = p.links.flatMap((l, li) => (l.kind === "loop" ? [li] : []));
      assert.deepEqual(p.trace.skipped, loops);
      for (const li of loops) assert.equal(p.paths[li], null);
      // Every door left belongs to a tree link.
      const loopDoors = p.board.doorways.filter((d) => d.link >= 0 && p.links[d.link]!.kind === "loop");
      assert.ok(loopDoors.every((d) => d.removed && (d.run === null || p.board.runAt.every((v) => v !== d.id + 1))));
      assert.equal(p.plan.doors.length, full.plan.doors.length - (full.links.length - p.links.filter((l) => l.kind === "tree").length - full.trace.skipped.length) * 2 * (s.wide ? 2 : 1) - (full.trace.stubFailed ? 0 : 1));
      skipped++;
    }
    assert.ok(skipped >= 5);
  });

  test("a stub that fails takes its doorway: the entrance keeps its other doors and no stairs at the edge", () => {
    const s = { ...DEFAULT_SETTINGS };
    const next = seeds(24);
    for (let i = 0; i < 5; i++) {
      const seed = next();
      const full = planDungeon(s, seed);
      assert.equal(full.trace.stubFailed, false);
      const p = planDungeon(s, seed, SEARCH_BUDGET - full.trace.loopsLeft);
      ok(p, s);
      assert.ok(p.trace.stubFailed);
      assert.equal(p.stub, null);
      assert.equal(p.plan.doors.length, full.plan.doors.length - 1);
      assert.equal(p.plan.rooms.length, full.plan.rooms.length);
      const W = p.plan.w;
      const edge = p.plan.stairs.flatMap((st) => st.cells).filter((c) => {
        const [x, y] = c.split(",").map(Number) as [number, number];
        return x === 0 || y === 0 || x === W - 1 || y === p.plan.h - 1;
      });
      assert.deepEqual(edge, []);
    }
  });
});
