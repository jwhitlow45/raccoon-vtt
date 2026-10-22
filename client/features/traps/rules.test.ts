import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import { CHUNK_CELLS, type BuildChunk, type Trap, type TrapRig } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { applyOp } from "#shared/reducer.ts";
import { LEVEL_BANDS, TRAP_PRESET_IDS } from "#shared/srd/traps.ts";
import { actor, DM, env, room, token } from "#shared/testutil.ts";
import { TRAP_ICON_PATH } from "./icon.ts";
import {
  cleanLine,
  crossedTraps,
  crossesText,
  warnsOf,
  disarmFill,
  newTrapInput,
  presetLine,
  rectBetween,
  saveSummary,
  searchFill,
  START_ALARM,
  START_BLANK,
  tapRect,
  tokensOn,
  trapAt,
  triggerSummary,
  wireBetween,
  wireEnd,
  withRect,
} from "./rules.ts";

const BOUNDS = { w: 30, h: 30 };

/** A chunk at 0,0 with the ground painted at the cells given, in feet. */
function ground(cells: Record<string, number>): Record<string, BuildChunk> {
  const feet = new Array(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (const [key, v] of Object.entries(cells)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    feet[y * CHUNK_CELLS + x] = v;
  }
  return { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: { "6,5,w": { kind: "door", state: "closed", secret: false, discovered: false } }, heights: encodeHeights(feet) } };
}

const valid = (trap: unknown) => clientOpSchema.safeParse({ t: "trap.create", trap });

describe("drawing a trap's zone (docs/design-v1-traps.md 4.1)", () => {
  test("squares snap to whole cells, stay on the scene and stop at 20 a side from where the drag began", () => {
    assert.deepEqual(rectBetween({ x: 2.4, y: 3.9 }, { x: 4.1, y: 3.2 }, BOUNDS), { x: 2, y: 3, w: 3, h: 1 });
    assert.deepEqual(rectBetween({ x: 5.5, y: 5.5 }, { x: 1.2, y: 0.4 }, BOUNDS), { x: 1, y: 0, w: 5, h: 6 }, "dragged up and left");
    assert.deepEqual(rectBetween({ x: 28.5, y: 1 }, { x: 40, y: -3 }, BOUNDS), { x: 28, y: 0, w: 2, h: 2 }, "kept on the scene");
    assert.deepEqual(rectBetween({ x: 25.5, y: 0.5 }, { x: 0, y: 0.5 }, BOUNDS), { x: 6, y: 0, w: LIMITS.trapRectSide, h: 1 }, "20 cells from the start");
    assert.deepEqual(rectBetween({ x: 3.3, y: 3.3 }, { x: 3.3, y: 3.3 }, BOUNDS), { x: 3, y: 3, w: 1, h: 1 }, "a tap is one square");
  });

  test("a tap places a new trap at its preset's size, and one square from Blank, kept on the scene", () => {
    assert.deepEqual(tapRect({ x: 3.3, y: 3.3 }, "hidden-pit", "1-4", BOUNDS), { x: 3, y: 3, w: 2, h: 2 }, "the SRD's 2 x 2 pit");
    assert.deepEqual(tapRect({ x: 3.3, y: 3.3 }, "collapsing-roof", "1-4", BOUNDS), { x: 3, y: 3, w: 1, h: 1 });
    assert.deepEqual(tapRect({ x: 3.3, y: 3.3 }, START_BLANK, "1-4", BOUNDS), { x: 3, y: 3, w: 1, h: 1 });
    assert.deepEqual(tapRect({ x: 29.5, y: 29.5 }, "hidden-pit", "1-4", BOUNDS), { x: 28, y: 28, w: 2, h: 2 }, "at the scene's corner");
  });

  test("a wire's ends land on cell corners and edge midpoints, never a cell's center", () => {
    for (let i = 0; i < 400; i++) {
      const p = { x: (i * 7.3) % 30, y: (i * 3.7) % 30 };
      const [x, y] = wireEnd(p, BOUNDS);
      assert.ok(Number.isInteger(x * 2) && Number.isInteger(y * 2), `${x},${y} on the half lattice`);
      assert.ok(Number.isInteger(x) || Number.isInteger(y), `${x},${y} is no cell's center`);
      assert.ok(Math.hypot(x - p.x, y - p.y) <= 0.5 + 1e-9, "the nearest such spot");
    }
    assert.deepEqual(wireEnd({ x: 2.5, y: 2.5 }, BOUNDS).length, 2);
    assert.deepEqual(wireEnd({ x: 2.1, y: 2.4 }, BOUNDS), [2, 2.5]);
  });

  test("a wire is half a cell to 20 cells long: shorter is none, longer stops at 20", () => {
    assert.equal(wireBetween([3, 3], { x: 3.1, y: 3.1 }, BOUNDS), null);
    assert.deepEqual(wireBetween([3, 3], { x: 3.6, y: 3 }, BOUNDS), { a: [3, 3], b: [3.5, 3] });
    const long = wireBetween([0, 5], { x: 29, y: 5 }, BOUNDS)!;
    assert.deepEqual(long.b, [20, 5]);
    const slant = wireBetween([0, 0], { x: 25, y: 25 }, BOUNDS)!;
    const length = Math.hypot(slant.b[0], slant.b[1]);
    assert.ok(length <= LIMITS.trapWireMax && length > LIMITS.trapWireMax - 1, `${length}`);
    assert.ok(valid({ id: "w", sceneId: "s1", name: "Wire", zone: { wire: slant }, rig: { on: [], who: "party", floor: false, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false } }).success);
  });

  test("squares add up to 8 rectangles and 400 cells", () => {
    let rects = [{ x: 0, y: 0, w: 20, h: 10 }];
    const full = withRect(rects, { x: 0, y: 10, w: 20, h: 10 });
    assert.ok(full.ok);
    assert.equal(withRect(full.ok ? full.rects : [], { x: 20, y: 0, w: 1, h: 1 }).ok, false, "401 cells");
    assert.ok(withRect(rects, { x: 0, y: 0, w: 2, h: 2 }).ok, "cells two rectangles share count once");
    rects = Array.from({ length: LIMITS.trapRects }, (_, i) => ({ x: i, y: 0, w: 1, h: 1 }));
    const nine = withRect(rects, { x: 9, y: 9, w: 1, h: 1 });
    assert.equal(nine.ok, false);
  });
});

describe("the trap under a tap", () => {
  const traps = [
    { id: "a", sceneId: "s1", zone: { cells: [{ x: 2, y: 2, w: 2, h: 2 }] } },
    { id: "b", sceneId: "s1", zone: { cells: [{ x: 3, y: 3, w: 2, h: 2 }] } },
    { id: "w", sceneId: "s1", zone: { wire: { a: [10, 2] as [number, number], b: [10, 8] as [number, number] } } },
    { id: "d", sceneId: "s1", zone: { door: { edge: "6,5,w" } } },
  ] satisfies Pick<Trap, "id" | "sceneId" | "zone">[];
  const chunks = ground({});

  test("squares that hold the point, a wire or door within the slop, the nearest first and then the last made", () => {
    assert.equal(trapAt(traps, chunks, { x: 2.5, y: 2.5 }, 0.3)?.id, "a");
    assert.equal(trapAt(traps, chunks, { x: 3.5, y: 3.5 }, 0.3)?.id, "b", "overlapping squares: the later id");
    assert.equal(trapAt(traps, chunks, { x: 10.2, y: 5 }, 0.3)?.id, "w");
    assert.equal(trapAt(traps, chunks, { x: 10.5, y: 5 }, 0.3), null);
    assert.equal(trapAt(traps, chunks, { x: 6.1, y: 5.5 }, 0.3)?.id, "d");
    assert.equal(trapAt(traps, ground({}), { x: 0.5, y: 0.5 }, 0.3), null);
  });

  test("Set it off with none selected takes the creatures on its squares, and none for a wire", () => {
    const tokens = {
      t1: token("t1", { x: 2, y: 2 }),
      t2: token("t2", { x: 4, y: 2 }),
      t3: token("t3", { x: 3, y: 3, sceneId: "s2" }),
      chest: token("chest", { kind: "object", x: 2, y: 2 }),
      dead: token("dead", { x: 2, y: 2, actor: { inline: actor({ life: "dead" }) } }),
    };
    assert.deepEqual(tokensOn(traps[0]!, { tokens, characters: {} }), ["t1"], "never an object or the dead");
    assert.deepEqual(tokensOn(traps[2]!, { tokens, characters: {} }), []);
  });
});

describe("the drag label's warning (4.5)", () => {
  const pit = { id: "pit", name: "Hidden Pit", sceneId: "s1", zone: { cells: [{ x: 4, y: 0, w: 2, h: 2 }] } };
  const wire = { id: "wire", name: "Falling Net", sceneId: "s1", zone: { wire: { a: [8, 0] as [number, number], b: [8, 3] as [number, number] } } };
  const one = { w: 1, h: 1 };

  test("a walk crosses squares its footprint touches past its start and wires its middle crosses, in the order it meets them", () => {
    assert.deepEqual(crossedTraps([wire, pit], one, [{ x: 0, y: 0 }, { x: 10, y: 0 }]).map((t) => t.id), ["pit", "wire"]);
    assert.deepEqual(crossedTraps([pit], one, [{ x: 0, y: 2 }, { x: 10, y: 2 }]), [], "beside the squares");
    assert.deepEqual(crossedTraps([pit], { w: 2, h: 2 }, [{ x: 0, y: 2.5 }, { x: 10, y: 2.5 }]), [], "a Large token passing under");
    assert.deepEqual(crossedTraps([pit], { w: 2, h: 2 }, [{ x: 0, y: 1 }, { x: 10, y: 1 }]).map((t) => t.id), ["pit"], "its footprint's top half over the squares");
    assert.deepEqual(crossedTraps([wire], one, [{ x: 0, y: 0 }, { x: 7, y: 0 }]), [], "stopping short of the wire");
    assert.deepEqual(crossedTraps([wire], one, [{ x: 7.5, y: 1 }, { x: 9, y: 1 }]), [], "starting with its middle on the wire's line");
    assert.deepEqual(crossedTraps([wire], one, [{ x: 7, y: 4 }, { x: 9, y: 4 }]), [], "past the wire's end");
    assert.deepEqual(crossedTraps([pit, wire], one, [{ x: 0, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 0 }]).map((t) => t.id), ["pit"], "through a corner");
    assert.deepEqual(crossedTraps([pit], one, [{ x: 4, y: 0 }]), [], "no walk");
  });

  test("players are warned of found traps not disarmed, the DM of armed ones", () => {
    assert.equal(warnsOf({ ...pit }, "player"), true, "a player's view holds only found traps");
    assert.equal(warnsOf({ ...pit, disarmed: true }, "player"), false);
    assert.equal(warnsOf({ ...pit, state: "armed" }, "dm"), true);
    assert.equal(warnsOf({ ...pit, state: "sprung" }, "dm"), false);
    assert.equal(crossesText([]), null);
    assert.equal(crossesText(["Hidden Pit"]), "Crosses Hidden Pit");
    assert.equal(crossesText(["Hidden Pit", "Falling Net"]), "Crosses Hidden Pit and Falling Net");
    assert.equal(crossesText(["A", "B", "C"]), "Crosses A and 2 more");
  });
});

describe("a new trap (4.1, Appendix A)", () => {
  const squares = { cells: [{ x: 2, y: 2, w: 2, h: 2 }] };
  const chunks = ground({ "2,2": 5, "3,3": 5 });

  test("Blank goes off for party creatures stepping onto it, stops them and hits them, and nothing more", () => {
    const t = newTrapInput({ id: "t1", sceneId: "s1", start: START_BLANK, band: "1-4", zone: squares, chunks });
    assert.equal(t.name, "Trap");
    assert.deepEqual(t.rig.on, ["enter"]);
    assert.equal(t.rig.stops, true);
    assert.equal(t.rig.hits, "trigger");
    assert.ok(valid(t).success);
  });

  test("Alarm is the DM's alone: it never stops a creature, never marks itself found and arms again", () => {
    const t = newTrapInput({ id: "t1", sceneId: "s1", start: START_ALARM, band: "1-4", zone: { wire: { a: [1, 1], b: [4, 1] } }, chunks });
    assert.equal(t.name, "Alarm");
    assert.equal(t.rig.stops, false);
    assert.equal(t.rig.foundOnSpring, false);
    assert.equal(t.rig.resets, "nextTurn");
    assert.equal(t.rig.message, undefined);
    assert.deepEqual(t.rig.on, [], "a wire goes off when crossed");
    assert.ok(valid(t).success);
  });

  test("Hidden Pit opens under the lid's highest ground less its depth, stopping at -100 ft", () => {
    const low = newTrapInput({ id: "p1", sceneId: "s1", start: "hidden-pit", band: "1-4", zone: squares, chunks });
    assert.deepEqual(low.rig.pit, { floor: -5 }, "5 ft ground, a 10 ft pit");
    assert.ok(valid(low).success);
    const deep = newTrapInput({ id: "p2", sceneId: "s1", start: "hidden-pit", band: "17-20", zone: squares, chunks });
    assert.deepEqual(deep.rig.pit, { floor: -100 });
    assert.equal(presetLine(low.rig), "From Hidden Pit, levels 1–4");
    assert.equal(presetLine(deep.rig), "From Hidden Pit, levels 17–20");
    assert.equal(presetLine({ ...deep.rig, damage: [{ formula: "1d4", type: "bludgeoning" }] }), "From Hidden Pit", "changed past any level");
    assert.equal(presetLine({ ...deep.rig, preset: undefined }), null);
  });

  test("a preset's squares to draw start on its own squares, or the cells under a wire, and its cone at the zone's middle", () => {
    const roof = newTrapInput({ id: "r", sceneId: "s1", start: "collapsing-roof", band: "1-4", zone: { wire: { a: [2, 2.5], b: [6, 2.5] } }, chunks });
    assert.deepEqual(roof.rig.hits, { cells: [{ x: 2, y: 2, w: 4, h: 1 }] });
    assert.ok(valid(roof).success);
    const darts = newTrapInput({ id: "d", sceneId: "s1", start: "poisoned-darts", band: "1-4", zone: squares, chunks });
    assert.deepEqual(darts.rig.hits, { cells: squares.cells });
    const statue = newTrapInput({ id: "f", sceneId: "s1", start: "fire-casting-statue", band: "5-10", zone: { cells: [{ x: 3, y: 3, w: 1, h: 1 }] }, chunks });
    assert.deepEqual(statue.rig.hits, { area: { shape: "cone", size: 30, origin: { x: 3.5, y: 3.5, z: 5 }, yaw: 0, includeOrigin: false } });
    assert.ok(valid(statue).success);
  });

  test("a preset drawn as another kind of zone drops what only squares can do", () => {
    const pitDoor = newTrapInput({ id: "x", sceneId: "s1", start: "hidden-pit", band: "1-4", zone: { door: { edge: "6,5,w" } }, chunks });
    assert.deepEqual(pitDoor.rig.on, []);
    assert.equal(pitDoor.rig.pit, undefined);
    assert.ok(valid(pitDoor).success);
    const needleSquares = newTrapInput({ id: "y", sceneId: "s1", start: "poisoned-needle", band: "1-4", zone: squares, chunks });
    assert.deepEqual(needleSquares.rig.on, ["enter"]);
    assert.ok(valid(needleSquares).success);
  });

  test("every preset at every level makes a trap the server takes, on every kind of zone", () => {
    const zones = [squares, { wire: { a: [1, 1] as [number, number], b: [5, 1] as [number, number] } }, { door: { edge: "6,5,w" } }];
    const state = room({ buildChunks: chunks });
    for (const start of [START_BLANK, START_ALARM, ...TRAP_PRESET_IDS]) {
      for (const band of LEVEL_BANDS) {
        for (const zone of zones) {
          const trap = newTrapInput({ id: "t", sceneId: "s1", start, band, zone, chunks });
          const res = valid(trap);
          assert.ok(res.success, `${start} ${band} ${JSON.stringify(zone)}: ${res.success ? "" : res.error.message}`);
          const applied = applyOp(state, { t: "trap.create", trap }, DM, env(1));
          assert.ok(applied.ok, `${start} ${band} ${JSON.stringify(zone)}: ${applied.ok ? "" : applied.message}`);
        }
      }
    }
  });
});

describe("the pane's lines and its asks for rolls", () => {
  const rig = (over: Partial<TrapRig>): TrapRig => ({ on: ["enter"], who: "party", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, ...over });

  test("what sets it off and what it does read as one line each", () => {
    assert.equal(triggerSummary({ zone: { cells: [{ x: 0, y: 0, w: 1, h: 1 }] }, rig: rig({ on: ["enter", "turnStart"] }) }), "Steps onto it or starts its turn on it, by party creatures, on the floor");
    assert.equal(triggerSummary({ zone: { wire: { a: [0, 0], b: [1, 0] } }, rig: rig({ on: [], who: "any", floor: false, minSize: "small" }) }), "Crossed, by any creature, Small or larger");
    assert.equal(saveSummary(rig({ save: { ability: "dex", dc: 13, onPass: "half" }, damage: [{ formula: "2d10", type: "bludgeoning" }] })), "Dexterity save, DC 13, 2d10 Bludgeoning, half on a pass");
    assert.equal(saveSummary(rig({ damage: [{ formula: "1d6", type: "bludgeoning" }] })), "No save, 1d6 Bludgeoning");
    assert.equal(saveSummary(rig({})), "None");
  });

  test("Ask to search fills its first check and DC with the note Search, never the trap's name, and Ask to disarm its disarm check", () => {
    const statue = rig({
      find: [
        { ability: "wis", skill: "perception", dc: 15, what: "the plate" },
        { ability: "int", skill: "investigation", dc: 15 },
      ],
      disarm: { text: "Wedge the plate", check: { ability: "dex", skill: "sleight-of-hand", dc: 15 } },
    });
    assert.deepEqual(searchFill(statue), {
      test: {
        kind: "check",
        choices: [
          { ability: "wis", skill: "perception" },
          { ability: "int", skill: "investigation" },
        ],
      },
      dc: 15,
      note: "Search",
    });
    assert.deepEqual(disarmFill(statue), { test: { kind: "check", choices: [{ ability: "dex", skill: "sleight-of-hand" }] }, dc: 15, note: "Disarm" });
    assert.equal(searchFill(rig({})), null);
    assert.equal(disarmFill(rig({ disarm: { text: "No check needed" } })), null);
    const twoDcs = searchFill(rig({ find: [{ ability: "wis", skill: "perception", dc: 15 }, { ability: "wis", skill: "perception", dc: 10, what: "the glyph" }] }));
    assert.deepEqual(twoDcs?.test.choices, [{ ability: "wis", skill: "perception" }], "a second check at another DC is not a choice of this one");
  });

  test("a line is trimmed and cut without splitting a character, empty is none", () => {
    assert.equal(cleanLine("  The floor gives way!  ", 200), "The floor gives way!");
    assert.equal(cleanLine("   ", 200), null);
    assert.equal(cleanLine(`${"a".repeat(79)}\u{1F600}`, 80), "a".repeat(79));
  });
});

test("the trap icon is the wolf trap game-icons.net ships, unchanged", () => {
  const svg = readFileSync(new URL("../../../public/game-icons/82d94881/lorc/wolf-trap.svg", import.meta.url), "utf8");
  assert.equal(svg.match(/<path d="([^"]+)"/)?.[1], TRAP_ICON_PATH);
});
