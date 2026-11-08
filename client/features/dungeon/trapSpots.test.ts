import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AoeCoverage, AoeInclusion, RoomState, TerrainId, Trap } from "#shared/model.ts";
import { clientOpSchema, type Op } from "#shared/protocol.ts";
import { stampCells } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { trapHits } from "#shared/rules/traps.ts";
import { trapPreset } from "#shared/srd/traps.ts";
import { builderScene } from "../scenes/create.ts";
import { blankToken } from "../tokens/factory.ts";
import { doorLines } from "./dress.ts";
import { planDungeon } from "./plan.ts";
import { paintedOf, seeds } from "./plan.samples.ts";
import { landDungeon, previewScene } from "./scratch.ts";
import { clampSettings, trapCount, type DungeonSettings } from "./settings.ts";
import { FIRE_STATUE, ROLLING_STONE, STATUE_STAMP, stepYaw, statueReaches, type Reach } from "./trapSpots.ts";

/*
 * Where the traps go (phase 2, 5.4): the Fire-Casting Statue's reach,
 * asked through the trap's own rules under every pair of area rules, its
 * footprint against a wall, and the Rolling Stone's stretch in feet.
 */

const PAIRS: [AoeCoverage, AoeInclusion][] = (["half", "any", "center"] as const).flatMap((c) => (["anyCell", "center", "majority"] as const).map((i): [AoeCoverage, AoeInclusion] => [c, i]));

describe("how many traps", () => {
  test("Traps in twelfths of the rooms: None none, Few one per six, Some one per three, Many one per two, the steps between, at least one and at most 20", () => {
    assert.equal(trapCount(0, 40), 0);
    assert.equal(trapCount(2, 2), 1);
    assert.equal(trapCount(2, 12), 2);
    assert.equal(trapCount(2, 17), 2);
    assert.equal(trapCount(2, 40), 6);
    assert.equal(trapCount(4, 2), 1);
    assert.equal(trapCount(4, 12), 4);
    assert.equal(trapCount(4, 40), 13);
    assert.equal(trapCount(6, 12), 6);
    assert.equal(trapCount(6, 40), 20);
    assert.deepEqual([1, 3, 5].map((t) => trapCount(t, 12)), [1, 3, 5]);
    assert.equal(trapCount(1, 6), 1, "at least one");
  });
});

/** A room 7 by 6 at 2, 2 on a 12 by 12 map, every square stone at 0 ft but `rock` and any `raised`. */
function room(rock: [number, number][] = [], raised: [number, number, number][] = []): Pick<Reach, "w" | "h" | "terrain" | "ground"> {
  const terrain = new Map<number, TerrainId>();
  const ground = new Map<number, number>();
  for (let y = 2; y < 8; y++) {
    for (let x = 2; x < 9; x++) {
      if (rock.some(([rx, ry]) => rx === x && ry === y)) continue;
      terrain.set(y * 12 + x, "stone");
      ground.set(y * 12 + x, 0);
    }
  }
  for (const [x, y, ft] of raised) ground.set(y * 12 + x, ft);
  return { w: 12, h: 12, terrain, ground };
}

// A statue's block against the north wall at 5, 2 (1 by 2), its middle at 5.5, 3: the cone points south.
const SOUTH = { origin: [5.5, 3] as [number, number], yaw: 90 };

function apply(state: RoomState, raw: unknown, seq: number): RoomState {
  const done = applyOp(state, clientOpSchema.parse(raw) as Op, { memberId: Object.keys(state.members)[0]!, role: "dm" }, { seq, at: "2026-01-01T00:00:00.000Z" });
  assert.ok(done.ok, done.ok ? "" : done.message);
  return done.state;
}

/** The hand room landed through the scratch room's own path, written apart from statueReaches. */
function handRoom(r: Pick<Reach, "w" | "h" | "terrain" | "ground">): RoomState {
  const plan = { version: 0, theme: "dungeon" as const, w: r.w, h: r.h, asked: 0, rooms: [], paint: {}, doors: [], heights: [], stairs: [], stamps: [], lights: [], stones: [], traps: [], entrance: { x: 0, y: 0, w: 0, h: 0 }, key: null };
  const scratch = landDungeon(plan, previewScene(builderScene({ id: "hand", name: "Hand", w: r.w, h: r.h }), plan), "1-4", { feetPerCell: 5 }, null);
  assert.ok(scratch.ok);
  let state = scratch.room;
  const sceneId = Object.keys(state.scenes)[0]!;
  state = apply(state, { t: "build.paint", sceneId, terrain: "stone", cells: [...r.terrain.keys()].map((k) => `${k % r.w},${Math.floor(k / r.w)}`) }, 100);
  const raised = [...r.ground].filter(([, ft]) => ft !== 0);
  if (raised.length > 0) state = apply(state, { t: "build.height", sceneId, cells: raised.map(([k]) => `${k % r.w},${Math.floor(k / r.w)}`), height: raised[0]![1] }, 101);
  return state;
}

function withProbe(state: RoomState, [x, y]: [number, number], elevation: number): RoomState {
  const sceneId = Object.keys(state.scenes)[0]!;
  return apply(state, { t: "token.create", token: { ...blankToken({ id: "probe-2", sceneId, kind: "npc", at: { x, y } }), elevation } }, 200);
}

function hitsIn(state: RoomState, r: Pick<Reach, "plate" | "cone" | "band" | "feetPerCell">, [aoeCoverage, aoeInclusion]: [AoeCoverage, AoeInclusion], z: number): boolean {
  const preset = trapPreset(FIRE_STATUE, r.band)!;
  const size = (preset.hits as { cone: number }).cone;
  const sceneId = Object.keys(state.scenes)[0]!;
  const trap: Trap = { id: "t", rev: 1, sceneId, name: "Statue", zone: { cells: [{ x: r.plate[0], y: r.plate[1], w: 1, h: 1 }] }, state: "armed", found: false, rig: { ...preset.rig, hits: { area: { shape: "cone", size, origin: { x: r.cone.origin[0], y: r.cone.origin[1], z }, yaw: r.cone.yaw, includeOrigin: false } } } };
  const moment = { ...state, meta: { ...state.meta, settings: { ...state.meta.settings, feetPerCell: r.feetPerCell, aoeCoverage, aoeInclusion } } };
  return trapHits(trap, moment, []).includes("probe-2");
}

/** Whether the trap's own `trapHits` catches a creature on the plate under one pair, in the hand room. */
function directHit(r: Reach, pair: [AoeCoverage, AoeInclusion]): boolean {
  const at = (x: number, y: number) => r.ground.get(y * r.w + x) ?? 0;
  return hitsIn(withProbe(handRoom(r), r.plate, at(...r.plate)), r, pair, at(Math.floor(r.cone.origin[0] - 0.5), Math.floor(r.cone.origin[1] - 0.5)));
}

describe("the Fire-Casting Statue's reach", () => {
  test("a plate 2 squares out reaches at 5 ft a square, not at 100, and not past a wall", () => {
    assert.equal(statueReaches({ ...room(), plate: [5, 5], cone: SOUTH, band: "1-4", feetPerCell: 5 }), true);
    assert.equal(statueReaches({ ...room(), plate: [5, 5], cone: SOUTH, band: "1-4", feetPerCell: 100 }), false, "a 15 ft cone is a sixth of a square there");
    assert.equal(statueReaches({ ...room([[5, 4]]), plate: [5, 5], cone: SOUTH, band: "1-4", feetPerCell: 5 }), false, "rock between");
  });

  test("the band's cone sets the reach: at 10 ft a square a 15 ft cone falls short of a plate a 30 ft one reaches", () => {
    assert.equal(statueReaches({ ...room(), plate: [5, 5], cone: SOUTH, band: "1-4", feetPerCell: 10 }), false);
    assert.equal(statueReaches({ ...room(), plate: [5, 5], cone: SOUTH, band: "5-10", feetPerCell: 10 }), true);
  });

  test("a plate the cone misses under any one pair of area rules is dropped, whatever the others say", () => {
    let mixed = 0;
    // 5, 3 has a creature's middle and a corner in the cone but not most of it, and 4, 4 is caught only by any cell under any coverage.
    for (const plate of [
      [5, 3],
      [4, 4],
      [7, 4],
      [7, 5],
      [3, 4],
      [8, 5],
      [6, 7],
      [7, 6],
      [4, 6],
    ] as [number, number][]) {
      const r: Reach = { ...room(), plate, cone: SOUTH, band: "5-10", feetPerCell: 5 };
      const each = PAIRS.map((pair) => directHit(r, pair));
      assert.equal(statueReaches(r), each.every(Boolean), `plate ${plate.join(",")}: ${each.join(" ")}`);
      if (each.some(Boolean) && !each.every(Boolean)) mixed++;
    }
    assert.ok(mixed > 0, "a plate some pairs reach and others miss");
  });

  test("a dais beside the spot is asked as it stands: a creature on a raised plate at the dais's height", () => {
    const flat: Reach = { ...room(), plate: [5, 5], cone: SOUTH, band: "1-4", feetPerCell: 5 };
    const dais: Reach = { ...room([], [[5, 5, 5], [6, 5, 5], [5, 6, 5], [6, 6, 5]]), plate: [5, 5], cone: SOUTH, band: "1-4", feetPerCell: 5 };
    assert.equal(statueReaches(flat), true);
    assert.equal(statueReaches(dais), PAIRS.every((pair) => directHit(dais, pair)));
  });

  test("yaws come in 45 degree steps, an axis within 22.5 degrees of it", () => {
    assert.deepEqual([stepYaw(4, 0), stepYaw(4, 1), stepYaw(0, 4), stepYaw(-4, 1), stepYaw(1, -4), stepYaw(3, 3), stepYaw(-3, 3), stepYaw(-3, -3), stepYaw(3, -3), stepYaw(5, 2)], [0, 0, 90, 180, 270, 45, 135, 225, 315, 0]);
    assert.equal(stepYaw(5, 3), 45);
  });
});

describe("the new traps in generated plans", () => {
  const plans = (label: number, settings: Partial<DungeonSettings>, feetPerCell: number, n = 8) =>
    seeds(label, n).map((seed) => {
      const s = clampSettings({ traps: 6, w: 80, h: 80, rooms: 30, ...settings });
      return { s, seed, p: planDungeon(s, seed, { feetPerCell }) };
    });

  test("each statue stands against a wall inside its stone room, its box in the room's squares, turned to face the room, every wall side seen, with Dressing None", () => {
    const turns = new Set<number>();
    for (const theme of ["dungeon", "crypt"] as const) {
      for (const { p, seed } of plans(theme === "dungeon" ? 121 : 122, { theme, dressing: "none", band: "5-10" }, 5)) {
        const statues = p.plan.traps.filter((t) => t.preset === FIRE_STATUE);
        assert.equal(p.plan.stamps.filter((st) => st.key === "ph-statue").length, statues.length, `${seed}: a stamp per statue`);
        for (const st of p.plan.stamps.filter((x) => x.key === STATUE_STAMP.key)) {
          const box = stampCells(st);
          const rooms = new Set<number>();
          for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) rooms.add(p.board.roomAt[y * p.plan.w + x]! - 1);
          assert.equal(rooms.size, 1, `${seed}: a statue's box straddles a wall`);
          const i = [...rooms][0]!;
          assert.ok(i >= 0 && i !== p.entrance, `${seed}: a statue outside a room or in the entrance`);
          const r = p.board.rooms[i]!;
          // Its back to the wall it is turned from: 0 the north, 90 the east, 180 the south, 270 the west.
          const against = { 0: box.y0 === r.y, 90: box.x1 === r.x + r.w, 180: box.y1 === r.y + r.h, 270: box.x0 === r.x }[st.rotation];
          assert.ok(against, `${seed}: a statue turned ${st.rotation} off its wall`);
          if (theme === "dungeon") assert.equal(p.plan.rooms[p.kept.indexOf(i)]!.floor, "stone", "a Dungeon's statues stand in its stone rooms");
          turns.add(st.rotation);
        }
      }
    }
    assert.deepEqual([...turns].sort((a, b) => a - b), [0, 90, 180, 270]);
  });

  test("a statue's plate is an ordinary doorway line square of its room, and its cone, in a 45 degree step, reaches it in the landed dungeon under all nine pairs at 5 and 10 ft a square", () => {
    let statues = 0;
    for (const fpc of [5, 10]) {
      for (const { s, p, seed } of plans(123 + fpc, { theme: "crypt", band: "11-16" }, fpc, 6)) {
        const W = p.plan.w;
        const secret = new Set(p.secret.map((c) => c.doorway.id));
        const landed = landDungeon(p.plan, previewScene(builderScene({ id: "x", name: "D", w: W, h: p.plan.h }), p.plan), s.band, { feetPerCell: fpc }, null);
        assert.ok(landed.ok);
        const ground = (x: number, y: number) => p.plan.heights.find((h) => h.cells.includes(`${x},${y}`))?.ft ?? 0;
        for (const t of p.plan.traps) {
          if (t.preset !== FIRE_STATUE) continue;
          statues++;
          const z = "cells" in t.zone ? t.zone.cells[0]! : null;
          assert.ok(z && t.cone);
          const i = p.board.roomAt[z.y * W + z.x]! - 1;
          assert.ok(doorLines(p.board, i, (d) => secret.has(d.id)).has(z.y * W + z.x), `${seed}: a plate off the ordinary lines`);
          assert.equal(t.cone.yaw % 45, 0);
          const probe = withProbe(landed.room, [z.x, z.y], ground(z.x, z.y));
          const at = ground(Math.floor(t.cone.origin[0] - 0.5), Math.floor(t.cone.origin[1] - 0.5));
          for (const pair of PAIRS) assert.ok(hitsIn(probe, { plate: [z.x, z.y], cone: t.cone, band: s.band, feetPerCell: fpc }, pair, at), `${seed}: ${pair.join(" ")} misses the plate at ${fpc} ft`);
        }
      }
    }
    assert.ok(statues > 10, `${statues} statues`);
  });

  test("no statue at 100 ft a square, where no cone reaches a square, and none in a Cave, Mine or Sewer", () => {
    for (const { p } of plans(127, { theme: "dungeon", band: "17-20" }, 100, 4)) assert.ok(!p.plan.traps.some((t) => t.preset === FIRE_STATUE));
    for (const theme of ["cave", "mine", "sewer"] as const) for (const { p } of plans(128, { theme }, 5, 4)) assert.ok(!p.plan.traps.some((t) => t.preset === FIRE_STATUE) && !p.plan.stamps.some((st) => st.key === "ph-statue"));
  });

  test("Rolling Stone: only Wide at levels 11 and up, its 2 by 2 squares at one end of a straight stretch and its plate 25 ft past them", () => {
    let stones = 0;
    for (const fpc of [5, 10]) {
      for (const band of ["1-4", "5-10", "11-16", "17-20"] as const) {
        for (const wide of [false, true]) {
          for (const { p, seed } of plans(130 + fpc, { wide, band, corridors: "straight" }, fpc, 6)) {
            const W = p.plan.w;
            const painted = paintedOf(p);
            const rolling = p.plan.traps.filter((t) => t.preset === ROLLING_STONE);
            if (!wide || band === "1-4" || band === "5-10") assert.equal(rolling.length, 0);
            assert.ok(rolling.length <= 2);
            assert.equal(p.plan.stones.length, rolling.length);
            for (const t of rolling) {
              stones++;
              const [sx, sy] = p.plan.stones[t.stone!]!;
              const z = "cells" in t.zone ? t.zone.cells[0]! : null;
              assert.ok(z);
              for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) assert.ok(painted.has((sy + dy) * W + sx + dx) && p.board.roomAt[(sy + dy) * W + sx + dx] === 0, `${seed}: the stone off its corridor`);
              // The plate lies in the stone's first lane, 25 ft past the stone in whole squares.
              assert.ok(z.x === sx || z.y === sy, `${seed}: the plate off the stone's lane`);
              const along = z.y === sy ? z.x - sx : z.y - sy;
              const beyond = along > 0 ? along - 1 : -along;
              assert.equal(beyond, Math.ceil(25 / fpc), `${seed}: the plate ${beyond} squares past the stone at ${fpc} ft`);
            }
          }
        }
      }
    }
    assert.ok(stones > 4, `${stones} stones`);
  });
});
