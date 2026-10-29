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
import { apply, DM, env, P1, room, scene, token } from "#shared/testutil.ts";
import { detachOp, getOffPlace } from "./detach.ts";

/**
 * Getting off a squeezed mount crosses only the ledges inside what the
 * mount stands on, its squeezed squares or hexes, as a walk off it reads
 * the mount's footprint for that from op version 29 (review DP34-ASTRA-02).
 * The full footprint takes in a band beside the squeeze, so a ledge there
 * is the ground's, and stops the rider as it stops any walk. An op stored
 * before version 29 replays by the full footprint it was taken under.
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
 * walk off reads the ledge into `low` at op version 29 and live, and a
 * version 28 op replays as it did: on squares its walk crosses the ledge by
 * the full footprint, and on hexes, where a walk off a holder takes no
 * ledge as its own (docs/design-v1-hex-grids.md), it meets it as ever.
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
  const old = takes(s, off, P1, 28);
  assert.ok(old, "a stored version 28 Get off replays");
  assert.deepEqual([old.tokens.brom!.x, old.tokens.brom!.y, old.tokens.brom!.elevation, old.tokens.brom!.attached], [low.x, low.y, 0, undefined]);
}

describe("squares: a rider gets off a Huge mount squeezed into a corridor two squares wide", () => {
  test("the square beside the squeeze inside the mount's full box, 5 ft down, is the ground's ledge", () => {
    let s = room({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
    s.buildChunks = {};
    const runs: [[number, number], [number, number]][] = [[[8, 0], [8, 10]], [[8, 12], [8, 20]], [[16, 0], [16, 10]], [[16, 12], [16, 20]], [[8, 10], [16, 10]], [[8, 12], [16, 12]]];
    runs.forEach(([a, b], i) => wall(s, `fu35fy${String(i).padStart(6, "0")}`, a, b));
    const cells: string[] = [];
    for (let y = 7; y < 16; y++) for (let x = 8; x < 18; x++) cells.push(`${x},${y}`);
    s = painted(s, cells, "14,11");
    // The squeeze stands on 12 to 14 by 10 to 12, its full box 12 to 15 by 10 to 13: Brom on its lower right square.
    s.tokens.horse = token("horse", { size: "huge", x: 11.5, y: 9.5, squeeze: true, elevation: 5, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    s.tokens.brom = token("brom", { x: 13, y: 11, elevation: 5, name: "Brom", ownerIds: ["p1"], attached: { to: "horse", kind: "ride" } });
    getsOffClear(s, { x: 14, y: 11 }, true);
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
  });
}
