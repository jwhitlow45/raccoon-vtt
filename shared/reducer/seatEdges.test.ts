import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { heights } from "../discoveryTestutil.ts";
import type { LogEvent, RoomState, Token } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { footprintInScene, linkHolds, overlaps } from "../rules/attach.ts";
import { footprintSize, occupiedHexes, placedOnHex, snapStep, tokenRefHex } from "../rules/footprint.ts";
import type { Point } from "../rules/geom.ts";
import { isHex, SQUARES, type Grid } from "../rules/grid.ts";
import { footprintGround } from "../rules/heights.ts";
import { hexKey, hexNeighbors } from "../rules/hex.ts";
import { COLUMNS, onHex, ROWS } from "../rules/hexWalls.testkit.ts";
import { dismountCost } from "../rules/dismount.ts";
import { hexStandHexes, hexStandPlace, ownWalk } from "../rules/movement.ts";
import { routePoints } from "../rules/route.ts";
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
 * (HEXOP-ASTRA-5, HEXOP-OPUS4C-1), and so does a token's own route
 * (HEXOP-ASTRA-7). Review round 5 searches every spot in her reach,
 * whatever the sizes (HEXOP-ASTRA-6).
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

/**
 * The goblin as change format 64 leaves it (D-261120-006): on its own squares or hexes inside the scene, off the warhorse, and
 * where it is still dragged, in Bree's reach. Whether it is still dragged.
 */
function endHolds(g: Grid, s: RoomState, where: string): boolean {
  const gob = s.tokens.gob!;
  assert.ok(footprintInScene(g, s.scenes.s1!.bounds, gob), `${where}: the goblin inside the scene, on ${gob.x}, ${gob.y}`);
  const own = isHex(g) ? placedOnHex(g, gob, tokenRefHex(g, gob)) : { x: Math.round(gob.x / snapStep(gob)) * snapStep(gob), y: Math.round(gob.y / snapStep(gob)) * snapStep(gob) };
  assert.ok(Math.abs(own.x - gob.x) < 1e-9 && Math.abs(own.y - gob.y) < 1e-9, `${where}: the goblin on its own grid, on ${gob.x}, ${gob.y}`);
  assert.ok(!overlaps(g, gob, s.tokens.horse!), `${where}: off the warhorse`);
  if (gob.attached?.to !== "bree") return false;
  assert.ok(linkHolds(g, s.meta.settings, "drag", gob, s.tokens.bree!), `${where}: in her reach`);
  return true;
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

  test("squares, by a rise or a pit on 11, 0 beside the seat: it lands at the height a drag takes it to there, never inside the ground, and never across a ledge", () => {
    // Its walk ends on 12, 3, and 11, 1 is the nearest spot in her reach off the warhorse. Where walls block, the rise's or the
    // pit's edge is a ledge in the way, so it goes round to 9, 3. Where nothing blocks, it stands on a 5 ft rise's top or a 5 ft
    // pit's floor, and 10 ft up or down is out of her reach, so it takes 10, 1.
    const landing: Record<string, [number, number, number]> = { "10 true": [9, 3, 0], "-10 true": [9, 3, 0], "5 true": [9, 3, 0], "-5 true": [9, 3, 0], "10 false": [10, 1, 0], "-10 false": [10, 1, 0], "5 false": [11, 1, 5], "-5 false": [11, 1, -5] };
    for (const rise of [10, -10, 5, -5]) {
      for (const block of [true, false]) {
        const where = `${rise} ft, ${block ? "walls block" : "nothing blocks"}`;
        const s = squareRide(20, 10, "large", [2, 2], [3, 3], [4, 3], block);
        heights(s, { x: 11, y: 0, w: 2, h: 2 }, rise);
        const after = twinned(s, { t: "token.move", tokenId: "horse", x: 10, y: 2, seat: { tokenId: "bree", x: 10, y: 2 } }, where);
        assert.ok(besideHer(SQUARES, after, where), `${where}: still dragged`);
        const gob = after.tokens.gob!;
        assert.equal(gob.elevation, footprintGround(after.buildChunks, gob), `${where}: on its ground, at ${at(after, "gob")}`);
        assert.deepEqual([gob.x, gob.y, gob.elevation], landing[`${rise} ${block}`], where);
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

/** Every place the goblin can take in the scene on its own grid: each square or half square its size snaps to, or each hex. */
function placesOf(g: Grid, s: RoomState, gob: Token): Point[] {
  const { w, h } = s.scenes.s1!.bounds;
  const out: Point[] = [];
  if (isHex(g)) {
    for (let row = -2; row <= 2 * Math.max(w, h) + 2; row++) {
      for (let col = -2; col <= 2 * Math.max(w, h) + 2; col++) {
        const { x, y } = onHex(g, gob.id, gob.size, { col, row });
        out.push({ x, y });
      }
    }
  } else {
    const step = snapStep(gob);
    const size = footprintSize(gob);
    for (let y = 0; y + size.h <= h; y += step) for (let x = 0; x + size.w <= w; x += step) out.push({ x, y });
  }
  return out.filter((p) => footprintInScene(g, s.scenes.s1!.bounds, { ...gob, x: p.x, y: p.y }));
}

/**
 * Where the goblin must land on a seat in an empty scene, read with no help from moveLeg.ts: where its walk ends (`end`, as with
 * no seat) where that is in Bree's reach off the warhorse and inside the scene, else the nearest such place of all in the scene
 * (`places`), or none, where it stays where its walk ends.
 */
function oracle(g: Grid, after: RoomState, places: readonly Point[], end: Point): Point | null {
  const bree = after.tokens.bree!;
  const horse = after.tokens.horse!;
  const gob = after.tokens.gob!;
  const valid = (p: Point) => {
    const placed = { ...gob, x: p.x, y: p.y };
    return footprintInScene(g, after.scenes.s1!.bounds, placed) && linkHolds(g, after.meta.settings, "drag", placed, bree) && !overlaps(g, placed, horse);
  };
  // A place 12 cells or more from her, far past any Gargantuan pair's reach, is skipped only to keep the sweep quick.
  const near = (p: Point) => Math.abs(p.x - bree.x) < 12 && Math.abs(p.y - bree.y) < 12;
  if (valid(end)) return end;
  const d = (p: Point) => (p.x - end.x) ** 2 + (p.y - end.y) ** 2;
  return places.filter((p) => near(p) && valid(p)).sort((a, b) => d(a) - d(b) || a.y - b.y || a.x - b.x)[0] ?? null;
}

const SIZES = ["small", "medium", "large", "huge", "gargantuan"] as const;
type Size = (typeof SIZES)[number];

/**
 * The size sweep's rides on `g`, in a 24 by 16 scene: every mount of Large to Gargantuan with every smaller rider and every
 * goblin of Small to Gargantuan, the rider on her mount's first and last seats, the goblin on the first places beside her off
 * the mount in her reach, and the mount's move to a stand in the open and at the scene's edge with every place it holds her.
 */
function* rides(g: Grid): Generator<{ s: RoomState; to: Point; seats: Point[]; where: string }> {
  const ride = { name: "Bree", kind: "pc" as const, ownerIds: ["p1"], attached: { to: "horse", kind: "ride" as const, steer: true as const } };
  const dragged = { name: "Goblin", kind: "monster" as const, visibility: "dm" as const, attached: { to: "bree", kind: "drag" as const } };
  const place = (id: string, size: Size, p: Point | { col: number; row: number }, extra: Partial<Token> = {}): Token => ("col" in p && isHex(g) ? onHex(g, id, size, p, extra) : token(id, { size, ...(p as Point), ...extra }));
  for (const [m, mount] of SIZES.entries()) {
    if (m < 2) continue;
    for (const riderSize of SIZES.slice(0, m)) {
      for (const goblin of SIZES) {
        const base = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { ...(isHex(g) ? { gridShape: g.orient === "rows" ? ("hexRows" as const) : ("hexColumns" as const) } : {}), bounds: { w: 24, h: 16 }, blockMovement: true, autoWalls: "off" }) } });
        base.buildChunks = {};
        const horse = place("horse", mount, isHex(g) ? { col: 7, row: 7 } : { x: 6, y: 5 }, { name: "Mount", kind: "npc", ownerIds: ["p1"] });
        base.tokens.horse = horse;
        const seated = seatsOn(g, horse, riderSize).map((p) => place("bree", riderSize, p, ride));
        for (const rider of new Set([seated[0]!, seated[seated.length - 1]!])) {
          const near = isHex(g) ? [...new Set(occupiedHexes(g, rider).flatMap((h) => hexNeighbors(g, h)).flatMap((h) => hexNeighbors(g, h)).flatMap((h) => hexNeighbors(g, h)).map(hexKey))].map((k) => ({ col: Number(k.split(",")[0]), row: Number(k.split(",")[1]) })) : around(rider, goblin);
          const starts = near.map((p) => place("gob", goblin, p, dragged)).filter((t) => !overlaps(g, t, horse) && linkHolds(g, base.meta.settings, "drag", t, rider) && footprintInScene(g, base.scenes.s1!.bounds, t));
          for (const gob of starts.slice(0, isHex(g) ? 1 : 2)) {
            const s = structuredClone(base);
            s.tokens.bree = rider;
            s.tokens.gob = gob;
            const stands = isHex(g) ? [{ col: 15, row: 8 }, { col: 21, row: 3 }, { col: 2, row: 14 }] : [{ x: 14, y: 6 }, { x: 24 - footprintSize(horse).w, y: 0 }];
            for (const stand of stands) {
              const to = "col" in stand && isHex(g) ? hexStandPlace(g, horse, { size: mount, ref: stand, squeezed: false }) : (stand as Point);
              const seats = seatsOn(g, { ...horse, ...to }, riderSize);
              yield { s, to, seats: seats.map((p) => ("col" in p ? place("bree", riderSize, p) : p)), where: `${mount} mount, ${riderSize} rider on ${rider.x}, ${rider.y}, ${goblin} goblin on ${gob.x}, ${gob.y}, stand ${JSON.stringify(stand)}` };
            }
          }
        }
      }
    }
  }
}

/** The places a rider of `size` sits on `horse`: on squares each box inside its own, on hexes each hex of it that holds hers. */
function seatsOn(g: Grid, horse: Token, size: Size): (Point | { col: number; row: number })[] {
  const probe = token("bree", { size, x: 0, y: 0 });
  if (isHex(g)) {
    const own = new Set(occupiedHexes(g, horse).map(hexKey));
    return occupiedHexes(g, horse).filter((h) => occupiedHexes(g, onHex(g, "bree", size, h)).every((o) => own.has(hexKey(o))));
  }
  const span = footprintSize(horse).w - footprintSize(probe).w;
  const out: Point[] = [];
  for (let dy = 0; dy <= span; dy++) for (let dx = 0; dx <= span; dx++) out.push({ x: horse.x + dx, y: horse.y + dy });
  return out;
}

/** The squares round a rider a goblin of `size` may start on, every one of its size's places touching her box, in scan order. */
function around(rider: Token, size: Size): Point[] {
  const side = footprintSize(token("gob", { size, x: 0, y: 0 })).w;
  const box = footprintSize(rider);
  const out: Point[] = [];
  for (let y = rider.y - side; y <= rider.y + box.h; y++) for (let x = rider.x - side; x <= rider.x + box.w; x++) out.push({ x, y });
  return out;
}

describe("the spot beside her seat is found wherever her reach holds one, whatever the sizes (HEXOP-ASTRA-6)", () => {
  test("squares, a Gargantuan mount, a Huge rider and a Gargantuan goblin: dropped on 21, 10, the goblin goes round onto 17, 6 and stays dragged", () => {
    const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { bounds: { w: 24, h: 30 }, blockMovement: true, autoWalls: "off" }) } });
    s.buildChunks = {};
    s.tokens.horse = token("horse", { size: "gargantuan", x: 10, y: 10, name: "Mount", kind: "npc", ownerIds: ["p1"] });
    s.tokens.bree = token("bree", { size: "huge", x: 10, y: 11, name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
    s.tokens.gob = token("gob", { size: "gargantuan", x: 6, y: 11, name: "Goblin", kind: "monster", visibility: "dm", attached: { to: "bree", kind: "drag" } });
    const after = twinned(s, { t: "token.move", tokenId: "horse", x: 20, y: 10, seat: { tokenId: "bree", x: 21, y: 10 } }, "gargantuan");
    assert.deepEqual(at(after, "bree"), [21, 10]);
    assert.ok(besideHer(SQUARES, after, "gargantuan"), "still dragged");
    assert.deepEqual(at(after, "gob"), [17, 6]);
    assert.deepEqual(oracle(SQUARES, after, placesOf(SQUARES, after, after.tokens.gob!), { x: 16, y: 11 }), { x: 17, y: 6 });
  });

  test("hex rows, the same sizes: dropped on the stand's reference hex, the goblin goes round above the mount and stays dragged", () => {
    const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { gridShape: "hexRows", bounds: { w: 24, h: 30 }, blockMovement: true, autoWalls: "off" }) } });
    s.buildChunks = {};
    s.tokens.horse = onHex(ROWS, "horse", "gargantuan", { col: 8, row: 10 }, { name: "Mount", kind: "npc", ownerIds: ["p1"] });
    s.tokens.bree = onHex(ROWS, "bree", "huge", { col: 8, row: 11 }, { name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
    s.tokens.gob = onHex(ROWS, "gob", "gargantuan", { col: 11, row: 11 }, { name: "Goblin", kind: "monster", visibility: "dm", attached: { to: "bree", kind: "drag" } });
    const to = hexStandPlace(ROWS, s.tokens.horse, { size: "gargantuan", ref: { col: 18, row: 10 }, squeezed: false });
    const plain = applyOp(s, { t: "token.move", tokenId: "horse", ...to }, P1, env(1));
    assert.ok(plain.ok && plain.state.tokens.gob!.attached?.to === "bree", "with no seat, dragged beside her own");
    const seat = onHex(ROWS, "bree", "huge", { col: 18, row: 10 });
    const after = twinned(s, { t: "token.move", tokenId: "horse", ...to, seat: { tokenId: "bree", x: seat.x, y: seat.y } }, "hex rows");
    assert.deepEqual(at(after, "bree"), [seat.x, seat.y]);
    assert.ok(besideHer(ROWS, after, "hex rows"), "still dragged");
    const end = plain.state.tokens.gob!;
    assert.deepEqual(at(after, "gob"), [20, 6.953125]);
    assert.deepEqual(oracle(ROWS, after, placesOf(ROWS, after, after.tokens.gob!), { x: end.x, y: end.y }), { x: 20, y: 6.953125 });
  });

  for (const [name, g] of [
    ["squares", SQUARES],
    ["hex rows", ROWS],
    ["hex columns", COLUMNS],
  ] as const) {
    test(`${name}, 1 ft cells, so her 5 ft reach spans five: a Gargantuan creature at the far edge of her reach, her seat dropped across a Gargantuan mount, goes round to the nearest spot in her reach`, () => {
      const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { ...(isHex(g) ? { gridShape: g.orient === "rows" ? ("hexRows" as const) : ("hexColumns" as const) } : {}), bounds: { w: 40, h: 30 }, blockMovement: true, autoWalls: "off" }) } });
      s.buildChunks = {};
      s.meta.settings = { ...s.meta.settings, feetPerCell: 1 };
      const ride = { name: "Bree", kind: "pc" as const, ownerIds: ["p1"], attached: { to: "horse", kind: "ride" as const, steer: true as const } };
      s.tokens.horse = isHex(g) ? onHex(g, "horse", "gargantuan", { col: 14, row: 12 }, { name: "Mount", kind: "npc", ownerIds: ["p1"] }) : token("horse", { size: "gargantuan", x: 14, y: 12, name: "Mount", kind: "npc", ownerIds: ["p1"] });
      const seats = seatsOn(g, s.tokens.horse, "medium");
      const place = (p: Point | { col: number; row: number }) => ("col" in p && isHex(g) ? onHex(g, "bree", "medium", p) : (p as Point));
      // She rides the mount's westmost seat, and the creature stands the farthest west her reach allows by her row.
      const west = seats.map(place).sort((a, b) => a.x - b.x || a.y - b.y)[0]!;
      s.tokens.bree = { ...token("bree", { x: 0, y: 0, ...ride }), x: west.x, y: west.y };
      const gob = placesOf(g, s, token("gob", { size: "gargantuan", x: 0, y: 0 }))
        .map((p) => ({ ...token("gob", { size: "gargantuan", name: "Ogre", kind: "monster", visibility: "dm", attached: { to: "bree", kind: "drag" } }), x: p.x, y: p.y }))
        .filter((t) => Math.abs(t.y - west.y) < 1.6 && t.x < west.x && !overlaps(g, t, s.tokens.horse!) && linkHolds(g, s.meta.settings, "drag", t, s.tokens.bree!))
        .sort((a, b) => a.x - b.x)[0]!;
      s.tokens.gob = gob;
      const to = isHex(g) ? hexStandPlace(g, s.tokens.horse, { size: "gargantuan", ref: { col: 18, row: 12 }, squeezed: false }) : { x: 18, y: 12 };
      const plain = applyOp(s, { t: "token.move", tokenId: "horse", ...to }, P1, env(1));
      assert.ok(plain.ok && plain.state.tokens.gob!.attached?.to === "bree", "with no seat, still dragged");
      const end = { x: plain.state.tokens.gob!.x, y: plain.state.tokens.gob!.y };
      // Her seat dropped on the mount's eastmost seat there, across it from her own.
      const east = seatsOn(g, { ...s.tokens.horse, ...to }, "medium").map(place).sort((a, b) => b.x - a.x || a.y - b.y)[0]!;
      const after = twinned(s, { t: "token.move", tokenId: "horse", ...to, seat: { tokenId: "bree", x: east.x, y: east.y } }, name);
      assert.deepEqual(at(after, "bree"), [east.x, east.y]);
      const want = oracle(g, after, placesOf(g, after, after.tokens.gob!), end);
      assert.ok(want && want !== end, `a spot in her reach away from where its walk ends, ${JSON.stringify(want)}`);
      assert.ok(besideHer(g, after, name), "still dragged");
      assert.deepEqual(at(after, "gob"), [want.x, want.y], "the nearest spot in her reach");
      assert.ok(Math.abs(want.x - east.x) > 6, `more than six cells from her, past a fixed radius: ${want.x} from her ${east.x}`);
    });

    test(`${name}: every Small to Gargantuan goblin, rider and mount, to every seat in the open and at the scene's edge, lands on the nearest spot in her reach the scene holds, or where its walk ends where it holds none`, () => {
      let checked = 0;
      let moved = 0;
      let stayed = 0;
      let held = 0;
      let letGo = 0;
      const places = new Map<Size, Point[]>();
      for (const { s, to, seats, where: ride } of rides(g)) {
        const gob = s.tokens.gob!;
        if (!places.has(gob.size as Size)) places.set(gob.size as Size, placesOf(g, s, gob));
        // The oracle reads the seat's search as op 63 ran it. From 64 every end holds besides (`endHolds`).
        const old = { ...env(1), opVersion: 63 };
        const plain = applyOp(s, { t: "token.move", tokenId: "horse", x: to.x, y: to.y }, P1, old);
        if (!plain.ok || plain.state.tokens.gob!.attached?.to !== "bree") continue;
        const end = { x: plain.state.tokens.gob!.x, y: plain.state.tokens.gob!.y };
        for (const seat of seats) {
          const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: to.x, y: to.y, seat: { tokenId: "bree", x: seat.x, y: seat.y } };
          if (!canApply(op, P1, s, deps).ok) continue;
          const r = applyOp(s, op, P1, old);
          assert.ok(r.ok);
          const now = applyOp(s, op, P1, env(1));
          assert.ok(now.ok);
          if (endHolds(g, now.state, `${ride}, seat ${seat.x}, ${seat.y}, from 64`)) held++;
          else letGo++;
          // A place that is no seat of the stand is ignored, and she keeps her own.
          if (at(r.state, "bree").join() === at(plain.state, "bree").join()) continue;
          const where = `${ride}, seat ${seat.x}, ${seat.y}`;
          const want = oracle(g, r.state, places.get(gob.size as Size)!, end);
          checked++;
          if (!want) {
            // Its walk may end outside the scene, as with no seat, and the link holds there where that is in her reach.
            stayed++;
            assert.deepEqual(at(r.state, "gob"), [end.x, end.y], `${where}: no spot in her reach, where its walk ends`);
            continue;
          }
          assert.ok(besideHer(g, r.state, where), `${where}: still dragged`);
          assert.deepEqual(at(r.state, "gob"), [want.x, want.y], `${where}: the nearest spot in her reach`);
          if (want !== end) moved++;
        }
      }
      assert.ok(checked >= (isHex(g) ? 600 : 2000) && moved >= (isHex(g) ? 400 : 1000) && stayed >= 100, `checked ${checked}, moved ${moved}, stayed where its walk ends ${stayed}`);
      assert.ok(held >= (isHex(g) ? 600 : 1000) && letGo >= 100, `from 64: still dragged ${held}, let go ${letGo}`);
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

  test("the warhorse's own route out by 8, 2 and back records its leg and its feet on its path, as one ending on 3, 2 does (HEXOP-ASTRA-7)", () => {
    const s = loop(false);
    const back = applyOp(s, { t: "token.move", tokenId: "horse", x: 2, y: 2, route: [[8, 2, 0, 0], [2, 2, 0, 0]] }, P1, env(2));
    const on = applyOp(s, { t: "token.move", tokenId: "horse", x: 3, y: 2, route: [[8, 2, 0, 0], [3, 2, 0, 0]] }, P1, env(2));
    assert.ok(back.ok && on.ok);
    const leg = (t: Token) => t.path?.stops.at(-1);
    assert.deepEqual([at(back.state, "horse"), leg(back.state.tokens.horse!)?.moved, leg(back.state.tokens.horse!)?.cost], [[2, 2], 60, 60], "back on its start");
    assert.deepEqual([leg(on.state.tokens.horse!)?.moved, leg(on.state.tokens.horse!)?.cost], [55, 55], "on 3, 2");
    const down = applyOp(s, { t: "token.move", tokenId: "horse", x: 2, y: 2, route: [[2, 6, 0, 0], [2, 2, 0, 0]] }, P1, env(2));
    assert.ok(down.ok);
    assert.deepEqual([leg(down.state.tokens.horse!)?.moved, leg(down.state.tokens.horse!)?.cost], [40, 40], "out by 2, 6 and back");
    // Op 62 replays the loop as it ran: no path for the warhorse.
    const old = applyOp(s, { t: "token.move", tokenId: "horse", x: 2, y: 2, route: [[8, 2, 0, 0], [2, 2, 0, 0]] }, P1, { ...env(2), opVersion: 62 });
    assert.ok(old.ok);
    assert.equal(old.state.tokens.horse!.path, undefined);
  });

  test("Bree's own walk off the warhorse out by 8, 3 and back to 4, 3, the first square clear of it, records the rest of the walk, as the ruler reads it (HEXOP-ASTRA-7)", () => {
    const s = loop(false);
    const route: [number, number, number, 0 | 1][] = [
      [8, 3, 0, 0],
      [4, 3, 0, 0],
    ];
    const op: OpOf<"token.move"> = { t: "token.move", tokenId: "bree", x: 4, y: 3, route };
    const r = applyOp(s, op, P1, env(2));
    assert.ok(r.ok);
    const stops = (t: Token) => t.path!.stops.map((p) => [p.x, p.y, p.moved ?? 0, p.cost ?? 0]);
    // Getting off costs half her Speed, 15 ft, for the square off it, then 40 ft out and back.
    assert.deepEqual(stops(r.state.tokens.bree!), [
      [3, 3, 0, 0],
      [4, 3, 5, 15],
      [4, 3, 40, 40],
    ]);
    const down = applyOp(s, { t: "token.move", tokenId: "bree", x: 3, y: 4, route: [[3, 7, 0, 0], [3, 4, 0, 0]] }, P1, env(2));
    assert.ok(down.ok);
    assert.deepEqual(stops(down.state.tokens.bree!).at(-1), [3, 4, 30, 30], "off by 3, 4, out to 3, 7 and back");
    const walker = ownWalk(s.tokens.bree!);
    const ruler = dismountCost(SQUARES, s, walker, s.tokens.horse!, routePoints(s.buildChunks, walker, route, 0), route, s.meta.settings, { h: 0, v: 0 }, 15, false);
    assert.deepEqual([ruler.moved, ruler.cost], [45, 55], "the ruler's feet");
    // Op 62 replays it as it ran: the walk off and nothing more.
    const old = applyOp(s, op, P1, { ...env(2), opVersion: 62 });
    assert.ok(old.ok);
    assert.deepEqual(stops(old.state.tokens.bree!), [
      [3, 3, 0, 0],
      [4, 3, 5, 15],
    ]);
  });
});
