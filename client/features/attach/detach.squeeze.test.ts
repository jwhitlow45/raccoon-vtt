import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wall } from "#shared/discoveryTestutil.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { walkerFor } from "#shared/rules/attach.ts";
import { occupiedHexes } from "#shared/rules/footprint.ts";
import { hexKey, hexNeighbors, type Hex } from "#shared/rules/hex.ts";
import { COLUMNS, onHex, ROWS } from "#shared/rules/hexWalls.testkit.ts";
import { hexStandPlace, legStop } from "#shared/rules/movement.ts";
import { apply, env, P1, room, scene, token } from "#shared/testutil.ts";
import { onTurn } from "../movement/testing.ts";
import { detachOp, getOffPlace } from "./detach.ts";

/**
 * Getting off a squeezed mount crosses only the ledges inside what the
 * mount stands on, its squeezed squares or hexes, as a walk off it reads
 * the mount's footprint for that from op version 29 (review DP34-ASTRA-02).
 * The full footprint takes in a band beside the squeeze, so a ledge there
 * is the ground's, and stops the rider as it stops any walk. An op stored
 * before version 29 replays by the full footprint it was taken under. A Get
 * off into that band leaves the mount as any Get off does, so its walk
 * starts on the ground under the rider, not at the seat's height (review
 * DP34-ASTRA-05).
 */

const p1 = { role: "player" as const, memberId: P1.memberId };
const ALL = () => true;

/** `cells` raised to 5 ft, but `low`, through the reducer as the builder paints them. */
function painted(s: RoomState, cells: readonly string[], low: string): RoomState {
  return apply(s, { t: "build.height", sceneId: "s1", cells: cells.filter((k) => k !== low), height: 5 } as Op);
}

/** Whether the server takes the op from `who` and stores it, at `opVersion` when given. */
function takes(s: RoomState, op: Op, who: Viewer, opVersion?: number): RoomState | null {
  if (opVersion === undefined && !canApply(op, who, s, { canUseAsset: () => true }).ok) return null;
  const r = applyOp(s, op, who, opVersion === undefined ? env(1) : { ...env(1), opVersion });
  return r.ok ? r.state : null;
}

/**
 * The rider's player gets off onto the band at `low` by no ledge: refused
 * live, never the place their device picks, which the server takes. The
 * walk off reads the ledge into `low` at op version 29 and live, and at
 * version 28 as it did: on squares its walk crosses the ledge by the full
 * footprint, and on hexes, where a walk off a holder takes no ledge as its
 * own (docs/design-v1-hex-grids.md), it meets it as ever.
 */
function getsOffClear(s: RoomState, low: { x: number; y: number }, oldCrosses: boolean): void {
  const there = { ...low, elevation: 0 };
  const off = detachOp("brom", there) as Op;
  assert.equal(takes(s, off, P1), null, "the walk off into the band is stopped at its ledge");
  const place = getOffPlace(s, p1, s.tokens.brom!);
  assert.ok(place, "room to get off");
  assert.notDeepEqual([place.x, place.y], [low.x, low.y], "the device picks another place");
  assert.ok(takes(s, detachOp("brom", place) as Op, P1), `the server takes ${place.x}, ${place.y}`);
  const rider = s.tokens.brom!;
  for (const opVersion of [29, undefined]) assert.equal(legStop(s, walkerFor(s, rider, ALL, { ...(opVersion ? { opVersion } : {}), to: there }), there)?.blocker, "ledge", `at ${opVersion ?? "live"}`);
  assert.equal(legStop(s, walkerFor(s, rider, ALL, { opVersion: 28, to: there }), there)?.blocker ?? null, oldCrosses ? null : "ledge", "at 28");
}

/** A corridor two squares wide from x 8 to 16 along rows 10 and 11, walled round, with no heights yet. */
function corridor(): RoomState {
  const s = room({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
  s.buildChunks = {};
  const runs: [[number, number], [number, number]][] = [[[8, 0], [8, 10]], [[8, 12], [8, 20]], [[16, 0], [16, 10]], [[16, 12], [16, 20]], [[8, 10], [16, 10]], [[8, 12], [16, 12]]];
  runs.forEach(([a, b], i) => wall(s, `fu35fw${String(i).padStart(6, "0")}`, a, b));
  return s;
}

/** The Huge mount squeezed into the corridor at 5 ft, standing on 12 to 14 by 10 to 12 with its full box 12 to 15 by 10 to 13, and Brom on its lower right square. */
function mounted(s: RoomState): RoomState {
  s.tokens.horse = token("horse", { size: "huge", x: 11.5, y: 9.5, squeeze: true, elevation: 5, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  s.tokens.brom = token("brom", { x: 13, y: 11, elevation: 5, name: "Brom", ownerIds: ["p1"], attached: { to: "horse", kind: "ride" } });
  return s;
}

/** The feet the rider's last leg moved, by the path its turn stored for the Get off to `to`. */
function movedOff(s: RoomState, to: { x: number; y: number }): number | undefined {
  const turn = onTurn(s, "brom");
  const op = detachOp("brom", { ...to, elevation: 0 }) as Op;
  const after = takes(turn, op, P1);
  assert.ok(after, "the server takes the Get off");
  assert.equal(after.tokens.brom!.attached, undefined);
  return after.tokens.brom!.path?.stops.at(-1)?.moved;
}

describe("squares: a rider gets off a Huge mount squeezed into a corridor two squares wide", () => {
  const cells: string[] = [];
  for (let y = 7; y < 16; y++) for (let x = 8; x < 18; x++) cells.push(`${x},${y}`);

  test("the square beside the squeeze inside the mount's full box, 5 ft down, is the ground's ledge", () => {
    getsOffClear(mounted(painted(corridor(), cells, "14,11")), { x: 14, y: 11 }, true);
  });

  test("a Get off the base build took past the full box, over a ledge in the band, replays at version 28 to the state and guards it stored (review DP34-DATA-02)", () => {
    // The ground is 5 ft but for 14 and 15 on row 11, so the walk to 15, 11 steps down 5 ft at x 14, inside the full box and on the squeeze's side.
    const low = cells.filter((k) => k !== "15,11");
    const s = onTurn(mounted(painted(corridor(), low, "14,11")), "brom");
    const op = detachOp("brom", { x: 15, y: 11, elevation: 0 }) as Op;
    assert.equal(takes(s, op, P1), null, "live, the band's ledge is the ground's");
    const r = applyOp(s, op, P1, { ...env(9), opVersion: 28 });
    assert.ok(r.ok, r.ok ? "" : r.message);
    // As the base build (op version 28, before the squeeze's seat and footprint rules) stores it.
    const brom = r.state.tokens.brom!;
    assert.deepEqual([brom.x, brom.y, brom.elevation, brom.attached], [15, 11, 0, undefined]);
    assert.deepEqual(brom.path?.stops, [
      { x: 13, y: 11, elevation: 5, seen: true },
      { x: 15, y: 11, elevation: 0, seen: true, moved: 10, cost: 15, routeSeen: true },
    ]);
    assert.deepEqual(r.inverse?.map((e) => [e.key, e.expectHash]), [["token:brom", "0c0084e0b328095c2f9ed82f7fa1ce28"]]);
  });

  test("a Get off into the band beside the squeeze walks from the ground under Brom, as off any mount", () => {
    // Only 12, 10 is raised, so the mount stands at 5 ft while Brom's square and the band beside it are on the ground at 0.
    const s = mounted(apply(corridor(), { t: "build.height", sceneId: "s1", cells: ["12,10"], height: 5 } as Op));
    s.meta.settings = { ...s.meta.settings, diagonal: "euclid" };
    assert.equal(movedOff(s, { x: 14, y: 11 }), 5, "one square on the ground, never down from the seat");
    // An op stored before version 29 read a walk into the band by the full footprint, as keeping its seat.
    const to = { x: 14, y: 11 };
    assert.equal(walkerFor(s, s.tokens.brom!, ALL, { opVersion: 28, to }).groundStart, undefined);
    for (const opVersion of [29, undefined]) assert.equal(walkerFor(s, s.tokens.brom!, ALL, { ...(opVersion ? { opVersion } : {}), to }).groundStart, true);
  });
});

for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
  describe(`${name}: a rider gets off a Huge mount squeezed onto three hexes`, () => {
    test("a hex of the mount's full footprint beside the squeeze, 5 ft down, is the ground's ledge", () => {
      const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
      let s = room({ scenes: { s1: scene("s1", { gridShape: shape, bounds: { w: 20, h: 20 }, blockMovement: true }) } });
      const base = onHex(g, "horse", "huge", { col: 9, row: 9 }, { elevation: 5, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      const horse: Token = { ...base, ...hexStandPlace(g, base, { size: "large", ref: { col: 9, row: 9 }, squeezed: true }), squeeze: true };
      const stand = occupiedHexes(g, horse);
      const taken = new Set(stand.map(hexKey));
      const full = occupiedHexes(g, { ...horse, squeeze: undefined });
      // A hex of the full footprint off the squeeze, beside a squeezed hex Brom sits on.
      const seat = stand.find((h) => hexNeighbors(g, h).some((n) => !taken.has(hexKey(n)) && full.some((f) => hexKey(f) === hexKey(n))))!;
      const low = hexNeighbors(g, seat).find((n) => !taken.has(hexKey(n)) && full.some((f) => hexKey(f) === hexKey(n)))!;
      const ring = new Set<string>();
      for (const h of full) for (const n of [h, ...hexNeighbors(g, h)]) for (const m of [n, ...hexNeighbors(g, n)]) ring.add(hexKey(m));
      s = painted(s, [...ring], hexKey(low));
      s.tokens.horse = horse;
      s.tokens.brom = onHex(g, "brom", "medium", seat, { elevation: 5, name: "Brom", ownerIds: ["p1"], attached: { to: "horse", kind: "ride" } });
      const spot = onHex(g, "spot", "medium", low as Hex);
      getsOffClear(s, { x: spot.x, y: spot.y }, false);
    });

    test("a Get off onto a hex of the full footprint beside the squeeze walks from the ground under Brom, as off any mount (review DP34-OPUS-11)", () => {
      const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
      const base = onHex(g, "horse", "huge", { col: 9, row: 9 }, { elevation: 5, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      const horse: Token = { ...base, ...hexStandPlace(g, base, { size: "large", ref: { col: 9, row: 9 }, squeezed: true }), squeeze: true };
      const stand = occupiedHexes(g, horse);
      const taken = new Set(stand.map(hexKey));
      const full = new Set(occupiedHexes(g, { ...horse, squeeze: undefined }).map(hexKey));
      const band = (n: Hex) => !taken.has(hexKey(n)) && full.has(hexKey(n));
      const seat = stand.find((h) => hexNeighbors(g, h).some(band))!;
      const low = hexNeighbors(g, seat).find(band)!;
      // One hex of the squeeze raised to 5 ft, where the mount stands, and Brom's hex and the band on the ground at 0.
      const raised = stand.find((h) => hexKey(h) !== hexKey(seat))!;
      const s = apply(room({ scenes: { s1: scene("s1", { gridShape: shape, bounds: { w: 20, h: 20 }, blockMovement: true }) } }), { t: "build.height", sceneId: "s1", cells: [hexKey(raised)], height: 5 } as Op);
      s.meta.settings = { ...s.meta.settings, diagonal: "euclid" };
      s.tokens.horse = horse;
      s.tokens.brom = onHex(g, "brom", "medium", seat, { elevation: 5, name: "Brom", ownerIds: ["p1"], attached: { to: "horse", kind: "ride" } });
      const spot = onHex(g, "spot", "medium", low);
      assert.equal(movedOff(s, { x: spot.x, y: spot.y }), 5, "one hex on the ground, never down from the seat");
    });
  });
}
