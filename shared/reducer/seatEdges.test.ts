import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { heights } from "../discoveryTestutil.ts";
import type { LogEvent, RoomState, Token } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { footprintInScene, linkHolds, overlaps } from "../rules/attach.ts";
import { occupiedHexes } from "../rules/footprint.ts";
import { SQUARES, type Grid } from "../rules/grid.ts";
import { footprintGround } from "../rules/heights.ts";
import { hexKey, hexNeighbors, type HexGrid } from "../rules/hex.ts";
import { COLUMNS, onHex, ROWS } from "../rules/hexWalls.testkit.ts";
import { hexStandHexes, hexStandPlace } from "../rules/movement.ts";
import { trapLandings } from "../rules/traps.ts";
import { DM, entry, env, member, P1, room, scene, template, token, trap } from "../testutil.ts";

/**
 * A seated rider's edges (review round 4 of HEXOP). A creature players
 * cannot see that she drags lands beside her seat (moveLeg.ts besideSeat),
 * inside the scene at the nearest clear spot in her reach at the height a
 * drag takes it to there, however far that is (HEXOP-ASTRA-4,
 * HEXOP-OPUS4-1, HEXOP-OPUS4C-2). One every player sees under a hidden
 * holder ends where her place carries it (HEXOP-OPUS4-2). A walk that comes
 * back to where it started counts as a walk from op 63, seat or no seat
 * (HEXOP-ASTRA-5, HEXOP-OPUS4C-1).
 */

const deps = { canUseAsset: () => true };
const at = (s: RoomState, id: string) => [s.tokens[id]!.x, s.tokens[id]!.y];

/** A square scene `w` by `h`, a warhorse of `size` on `horse`, Pat's Bree riding on `bree`, and a goblin players cannot see that she drags on `gob`. */
function squareRide(w: number, h: number, size: "large" | "huge", horse: [number, number], bree: [number, number], gob: [number, number], block = true): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { bounds: { w, h }, blockMovement: block, autoWalls: "off" }) } });
  s.buildChunks = {};
  s.tokens.horse = token("horse", { size, x: horse[0], y: horse[1], name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  s.tokens.bree = token("bree", { x: bree[0], y: bree[1], name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
  s.tokens.gob = token("gob", { x: gob[0], y: gob[1], name: "Goblin", kind: "monster", visibility: "dm", attached: { to: "bree", kind: "drag" } });
  return s;
}

/** Pat's move `op` of `s`, taken alike with the goblin and without it, and every player's copy alike: the state after it. */
function twinned(s: RoomState, op: OpOf<"token.move">, where: string): RoomState {
  const alone = structuredClone(s);
  delete alone.tokens.gob;
  assert.deepEqual(canApply(op, P1, s, deps), canApply(op, P1, alone, deps), `${where}: the answer`);
  const r = applyOp(s, op, P1, env(1));
  const t = applyOp(alone, op, P1, env(1));
  assert.ok(r.ok && t.ok, where);
  assert.equal(stableStringify(projectState(r.state, P1, { sceneId: "s1" })), stableStringify(projectState(t.state, P1, { sceneId: "s1" })), `${where}: Pat's copy`);
  return r.state;
}

/** The goblin inside the scene, and where it is still dragged, off the warhorse and in Bree's reach. */
function besideHer(g: Grid, s: RoomState, where: string): boolean {
  const gob = s.tokens.gob!;
  assert.ok(footprintInScene(g, s.scenes.s1!.bounds, gob), `${where}: the goblin inside the scene, on ${gob.x}, ${gob.y}`);
  if (gob.attached?.to !== "bree") return false;
  assert.ok(!overlaps(g, gob, s.tokens.horse!), `${where}: off the warhorse`);
  assert.ok(linkHolds(g, s.meta.settings, "drag", gob, s.tokens.bree!), `${where}: in her reach`);
  return true;
}

describe("a goblin players cannot see lands beside her seat inside the scene, at the nearest clear spot in reach (HEXOP-ASTRA-4, HEXOP-OPUS4-1)", () => {
  test("squares, at the scene's corner: no spot in her reach off the warhorse lies inside the scene, so it stays where her place carries it and lets go", () => {
    const s = squareRide(10, 10, "large", [2, 2], [3, 3], [4, 3]);
    const after = twinned(s, { t: "token.move", tokenId: "horse", x: 0, y: 0, seat: { tokenId: "bree", x: 0, y: 0 } }, "corner");
    assert.deepEqual(at(after, "bree"), [0, 0]);
    assert.equal(besideHer(SQUARES, after, "corner"), false, "let go");
    assert.deepEqual(at(after, "gob"), [2, 1], "where her place carried it");
  });

  test("squares, a Huge warhorse: dropped on a seat across it from her own, the goblin goes round to the nearest spot in her reach, four squares on, and stays dragged", () => {
    const s = squareRide(20, 10, "huge", [2, 2], [2, 4], [1, 4], false);
    const plain = applyOp(s, { t: "token.move", tokenId: "horse", x: 12, y: 2 }, P1, env(1));
    assert.ok(plain.ok);
    assert.deepEqual([...at(plain.state, "gob"), plain.state.tokens.gob!.attached?.to], [11, 4, "bree"], "with no seat, beside her own seat");
    const after = twinned(s, { t: "token.move", tokenId: "horse", x: 12, y: 2, seat: { tokenId: "bree", x: 14, y: 3 } }, "huge");
    assert.deepEqual(at(after, "bree"), [14, 3]);
    assert.ok(besideHer(SQUARES, after, "huge"), "still dragged");
    assert.ok(Math.max(Math.abs(after.tokens.gob!.x - 11), Math.abs(after.tokens.gob!.y - 4)) >= 4, `four squares or more from 11, 4: ${at(after, "gob")}`);
  });

  test("squares, by a rise 10 ft high and a pit 10 ft deep beside the seat: it lands at the height a drag takes it to there, never inside the ground", () => {
    for (const rise of [10, -10]) {
      for (const block of [true, false]) {
        const where = `${rise} ft, ${block ? "walls block" : "nothing blocks"}`;
        const s = squareRide(20, 10, "large", [2, 2], [3, 3], [4, 3], block);
        heights(s, { x: 11, y: 0, w: 2, h: 2 }, rise);
        const after = twinned(s, { t: "token.move", tokenId: "horse", x: 10, y: 2, seat: { tokenId: "bree", x: 10, y: 2 } }, where);
        besideHer(SQUARES, after, where);
        assert.equal(after.tokens.gob!.elevation, footprintGround(after.buildChunks, after.tokens.gob!), `${where}: on its ground, at ${at(after, "gob")}`);
      }
    }
  });

  for (const [name, g] of [
    ["hex rows", ROWS],
    ["hex columns", COLUMNS],
  ] as const) {
    test(`${name}: from every hex beside Bree off the warhorse, to every seat of its stand at the scene's edge and in the open, the goblin lands inside the scene, off the warhorse in her reach or let go`, () => {
      let kept = 0;
      let far = 0;
      for (const ref of [
        { col: 1, row: 1 },
        { col: 5, row: 4 },
      ]) {
        const base = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { gridShape: g.orient === "rows" ? "hexRows" : "hexColumns", bounds: { w: 12, h: 10 }, blockMovement: true, autoWalls: "off" }) } });
        base.buildChunks = {};
        base.tokens.horse = onHex(g, "horse", "large", { col: 6, row: 6 }, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
        const own = occupiedHexes(g, base.tokens.horse);
        const seat = own[0]!;
        base.tokens.bree = onHex(g, "bree", "medium", seat, { name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
        const stand = { size: "large" as const, ref, squeezed: false };
        const to = hexStandPlace(g, base.tokens.horse, stand);
        const mounts = new Set(own.map(hexKey));
        for (const gobHex of hexNeighbors(g, seat).filter((h) => !mounts.has(hexKey(h)))) {
          for (const dropped of hexStandHexes(g, stand)) {
            const where = `stand ${ref.col}, ${ref.row}, goblin ${hexKey(gobHex)}, seat ${hexKey(dropped)}`;
            const s = structuredClone(base);
            s.tokens.gob = onHex(g, "gob", "medium", gobHex, { name: "Goblin", kind: "monster", visibility: "dm", attached: { to: "bree", kind: "drag" } });
            const placed = onHex(g, "bree", "medium", dropped);
            const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...to, seat: { tokenId: "bree", x: placed.x, y: placed.y } };
            if (!canApply(op, P1, s, deps).ok) continue;
            const plain = applyOp(s, { t: "token.move", tokenId: "horse", ...to }, P1, env(1));
            assert.ok(plain.ok);
            const after = twinned(s, op, where);
            if (besideHer(g, after, where)) {
              kept++;
              const was = occupiedHexes(g, plain.state.tokens.gob!)[0]!;
              const now = occupiedHexes(g, after.tokens.gob!)[0]!;
              if (Math.max(Math.abs(was.col - now.col), Math.abs(was.row - now.row)) >= 2) far++;
            }
          }
        }
      }
      assert.ok(kept >= 6 && far >= 1, `kept ${kept}, of them moved two hexes or more ${far}`);
    });
  }
});

describe("one every player sees, dragged by a hidden owl on her, ends where her place carries it (HEXOP-OPUS4-2)", () => {
  test("Pat's seat on 10, 2: the goblin lands on 12, 3 as with no seat, and every player's copy of it is the same", () => {
    const s = squareRide(20, 10, "large", [2, 2], [3, 3], [4, 3]);
    s.tokens.owl = token("owl", { size: "tiny", x: 3, y: 3, name: "Owl", kind: "npc", visibility: "dm", attached: { to: "bree", kind: "perch" } });
    s.tokens.gob = { ...s.tokens.gob!, visibility: "all", attached: { to: "owl", kind: "drag" } };
    const seated = applyOp(s, { t: "token.move", tokenId: "horse", x: 10, y: 2, seat: { tokenId: "bree", x: 10, y: 2 } }, P1, env(1));
    const plain = applyOp(s, { t: "token.move", tokenId: "horse", x: 10, y: 2 }, P1, env(1));
    assert.ok(seated.ok && plain.ok);
    assert.deepEqual([at(seated.state, "bree"), at(seated.state, "gob"), at(plain.state, "gob")], [[10, 2], [12, 3], [12, 3]]);
    const copy = (state: RoomState) => stableStringify(projectState(state, P1, { sceneId: "s1" }).tokens.gob);
    assert.equal(copy(seated.state), copy(plain.state), "Pat's copy of the goblin");
  });
});

describe("a walk that comes back to where it started counts as a walk from op 63 (HEXOP-ASTRA-5, HEXOP-OPUS4C-1)", () => {
  /** A Large warhorse on 2, 2, Bree riding its bottom-right square, in her turn, with a 1 ft sphere on 4.5, 3.5 that reminds on entering, and a stop trap on 7, 2 or none. */
  function loop(stop: boolean): RoomState {
    const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { bounds: { w: 20, h: 10 } }) } });
    s.tokens.horse = token("horse", { size: "large", x: 2, y: 2, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    s.tokens.bree = token("bree", { x: 3, y: 3, name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
    s.templates.ball = template("ball", { shape: "sphere", size: 1, origin: { x: 4.5, y: 3.5, z: 0 }, includeOrigin: true, triggers: ["enter"] });
    s.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-bree", { tokenId: "bree", value: 15 }), entry("e-horse", { tokenId: "horse", value: 10, tieOrder: 1 })] };
    const started = applyOp(s, { t: "encounter.next" }, DM, env(1));
    assert.ok(started.ok);
    if (stop) started.state.traps.t = trap("t", { zone: { cells: [{ x: 7, y: 2, w: 1, h: 1 }] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: false, hits: "trigger", actions: [], find: [], notice: false } });
    return started.state;
  }
  const entered = (log: readonly { data?: unknown }[]) => log.flatMap((e) => (e.data && (e.data as LogEvent).type === "area" ? [(e.data as Extract<LogEvent, { type: "area" }>).tokenId] : [])).sort();
  const moves: [string, OpOf<"token.move">][] = [
    ["her seat her own start, the warhorse a square on", { t: "token.move", tokenId: "horse", x: 3, y: 2, seat: { tokenId: "bree", x: 3, y: 3 } }],
    ["her seat her own start, by 8, 2", { t: "token.move", tokenId: "horse", x: 3, y: 2, route: [[8, 2, 0, 0], [3, 2, 0, 0]], seat: { tokenId: "bree", x: 3, y: 3 } }],
    ["a loop back to the warhorse's start, no seat", { t: "token.move", tokenId: "horse", x: 2, y: 2, route: [[8, 2, 0, 0], [2, 2, 0, 0]] }],
  ];

  test("she crosses the sphere on 4.5, 3.5 and is reminded, and her turn's path records the leg she was carried", () => {
    for (const [name, op] of moves) {
      const s = loop(false);
      const r = applyOp(s, op, P1, env(2));
      assert.ok(r.ok, name);
      assert.deepEqual(at(r.state, "bree"), [3, 3], `${name}: back on her start`);
      assert.ok(entered(r.log).includes("bree"), `${name}: Bree reminded, ${entered(r.log)}`);
      const leg = r.state.tokens.bree!.path?.stops.at(-1);
      assert.ok(leg && (leg.moved ?? 0) > 0, `${name}: a carried leg on her path, ${JSON.stringify(leg)}`);
      // Op 62, which reads no seat, replays the loop as it ran: no reminder.
      if (op.seat) continue;
      const old = applyOp(s, op, P1, { ...env(2), opVersion: 62 });
      assert.ok(old.ok);
      assert.ok(!entered(old.log).includes("bree"), `${name}: op 62 skips her`);
    }
  });

  test("a stop trap on 7, 2 cuts the walk on the way: she lands where the trap step had her", () => {
    for (const [name, op] of moves.slice(1)) {
      const s = loop(true);
      const r = applyOp(s, op, P1, env(2));
      assert.ok(r.ok, name);
      const landed = trapLandings(op, s, P1, {});
      const bree: Token = r.state.tokens.bree!;
      assert.deepEqual(landed.get("bree"), { x: bree.x, y: bree.y, elevation: bree.elevation }, `${name}: where the trap step had her, on ${at(r.state, "bree")}`);
      if (!op.seat) assert.equal(trapLandings(op, s, P1, { opVersion: 62 }).get("bree"), undefined, `${name}: op 62's trap step skips her, as it ran`);
    }
  });
});
