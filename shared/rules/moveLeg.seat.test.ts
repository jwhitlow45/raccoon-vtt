import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { seatsWhereDropped } from "../migrate.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import { clientOpSchema, type OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { keepOf } from "../reducer/hexFile.testkit.ts";
import { DM, env, P1, P2, room, scene, token, trap } from "../testutil.ts";
import { linkHolds } from "./attach.ts";
import { occupiedHexes, placedOnHex } from "./footprint.ts";
import { hexKey, type Hex, type HexGrid } from "./hex.ts";
import { COLUMNS, onHex, ROWS } from "./hexWalls.testkit.ts";
import { planWalks } from "./moveLeg.ts";
import { hexStandHexes, hexStandPlace } from "./movement.ts";
import { planTrapMove, trapLandings, trapWalks } from "./traps.ts";

/**
 * A rider sits where she is dropped (LP40-HEX-SEAT, HEXFILE-FOLLOW 1,
 * migrate.ts seatsWhereDropped): a drag pressed on a rider aims her mount at
 * a stand that holds the hex or square she is dropped on, and `token.move`'s
 * `seat` tells the server that place. Where the walk ends full size and the
 * place is a seat of the mount's stand there, she sits on it. It reads her,
 * the mount and the op alone, so no hidden rider moves the shown one, and a
 * player's seat naming a hidden rider is ignored as an unknown id is.
 */

const deps = { canUseAsset: () => true };

/**
 * Live play 40's keep on hexes, the warhorse full size on open ground west of the corridor's mouth, Bree riding it on its hex
 * nearest the corridor, and nothing in tow: the rows report's drop onto the corridor's first hex, 7, 6.
 */
function keepRide(g: HexGrid): { s: RoomState; path: Hex[] } {
  const { s, path } = keepOf(g, 0, 0, "horse");
  delete s.tokens.gob;
  s.tokens.horse = onHex(g, "horse", "large", { col: 4, row: 6 }, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  const own = occupiedHexes(g, s.tokens.horse);
  const seat = [...own].sort((a, b) => b.col - a.col || a.row - b.row)[0]!;
  s.tokens.bree = onHex(g, "bree", "medium", seat, { name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
  return { s, path };
}

/** The warhorse's full stand that covers `hex` and fits clear of the rock, nearest the hex west of it first: one fits at the mouth. */
function standOn(g: HexGrid, s: RoomState, hex: Hex, open: (h: Hex) => boolean): { x: number; y: number } {
  for (let dc = -2; dc <= 2; dc++) {
    for (let dr = -2; dr <= 2; dr++) {
      const stand = { size: "large" as const, ref: { col: hex.col + dc, row: hex.row + dr }, squeezed: false };
      const hexes = hexStandHexes(g, stand);
      if (hexes.some((h) => hexKey(h) === hexKey(hex)) && hexes.every(open)) return hexStandPlace(g, s.tokens.horse!, stand);
    }
  }
  throw new Error("no stand");
}

function hexesOf(g: HexGrid, t: Token): string[] {
  return occupiedHexes(g, t).map(hexKey);
}

/** The move applied, refused or not. */
function applied(s: RoomState, op: OpOf<"token.move">, actor: Viewer, opVersion?: number): RoomState {
  assert.ok(canApply(op, actor, s, deps).ok, `${actor.role}: the move is taken`);
  const r = applyOp(s, op, actor, { ...env(1), ...(opVersion === undefined ? {} : { opVersion }) });
  assert.ok(r.ok);
  return r.state;
}

/**
 * The warhorse's walk in the keep's open ground three hexes on, to a full stand there, with Bree dropped on a hex of that stand
 * her own place does not carry her to: the open-ground twin of the corridor's mouth, on both layouts.
 */
function openDrop(g: HexGrid): { s: RoomState; to: { x: number; y: number }; hex: Hex } {
  const { s } = keepRide(g);
  const open = keepOf(g, 0, 0, "horse").open;
  const stand = { size: "large" as const, ref: { col: 3, row: 10 }, squeezed: false };
  assert.ok(hexStandHexes(g, stand).every(open), "the stand lies on open ground");
  const to = hexStandPlace(g, s.tokens.horse!, stand);
  const r = applyOp(s, { t: "token.move", tokenId: "horse", ...to }, DM, env(1));
  assert.ok(r.ok);
  const carried = hexesOf(g, r.state.tokens.bree!);
  const hex = hexStandHexes(g, stand).find((h) => !carried.includes(hexKey(h)))!;
  return { s, to, hex };
}

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  describe(`${name}: a rider sits on the hex she was dropped on (LP40-HEX-SEAT)`, () => {
    if (g === ROWS) {
      test("the report's drop: Bree dropped on the corridor's first hex, which only one full stand of the warhorse covers, sits on it, where op 62 sat her on the seat beside it", () => {
        const { s, path } = keepRide(g);
        const to = standOn(g, s, path[0]!, keepOf(g, 0, 0, "horse").open);
        const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...to, seat: { tokenId: "bree", ...placedOnHex(g, s.tokens.bree!, path[0]!) } };
        for (const actor of [P1, DM]) {
          assert.deepEqual(hexesOf(g, applied(s, op, actor).tokens.bree!), [hexKey(path[0]!)], `${actor.role}: on 7, 6`);
          assert.deepEqual(hexesOf(g, applied(s, op, actor, 62).tokens.bree!), ["6,5"], `${actor.role}: op 62 on 6, 5, as it ran`);
        }
      });
    }

    test("Bree dropped on a hex of the warhorse's new stand her place does not carry her to sits on it, where op 62 and a move with no seat seat her by her place", () => {
      const { s, to, hex } = openDrop(g);
      const seat = { tokenId: "bree", ...placedOnHex(g, s.tokens.bree!, hex) };
      const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...to, seat };
      assert.ok(clientOpSchema.safeParse(op).success, "a client may send it");
      assert.ok(!clientOpSchema.safeParse({ ...op, teleport: "wall" }).success, "but not on a teleport");
      assert.ok(!clientOpSchema.safeParse({ ...op, seat: { ...seat, tokenId: "horse" } }).success, "nor naming the moved token");
      for (const [who, actor] of [
        ["Pat", P1],
        ["the DM", DM],
      ] as const) {
        const after = applied(s, op, actor);
        assert.deepEqual(hexesOf(g, after.tokens.bree!), [hexKey(hex)], `${who}: Bree on the hex she was dropped on`);
        assert.ok(linkHolds(g, after.meta.settings, "ride", after.tokens.bree!, after.tokens.horse!), `${who}: she still rides`);
        const plain = { ...op };
        delete plain.seat;
        const carried = applied(s, plain, actor);
        assert.notDeepEqual(hexesOf(g, carried.tokens.bree!), [hexKey(hex)], `${who}: without the seat her place carries her elsewhere`);
        assert.deepEqual(applied(s, op, actor, 62).tokens.bree, carried.tokens.bree, `${who}: op 62 replays as it ran`);
      }
    });

    test("the seat is ignored where it is no seat of the stand, the walk ends squeezed, it names a token not riding the mount, or a trap cuts the walk", () => {
      const { s, to, hex } = openDrop(g);
      const plain: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...to };
      const carried = hexesOf(g, applied(s, plain, P1).tokens.bree!);
      const at = placedOnHex(g, s.tokens.bree!, hex);
      const off = occupiedHexes(g, s.tokens.horse!)[0]!;
      for (const [why, seat] of [
        ["a hex off the stand", { tokenId: "bree", ...placedOnHex(g, s.tokens.bree!, off) }],
        ["a place between anchors", { tokenId: "bree", x: at.x + 0.25, y: at.y }],
        ["an unknown id", { tokenId: "nobody", ...at }],
      ] as const) {
        assert.deepEqual(hexesOf(g, applied(s, { ...plain, seat }, P1).tokens.bree!), carried, why);
      }
      // A token that rides nothing stays where it is.
      const loose = { ...s, tokens: { ...s.tokens, imp: onHex(g, "imp", "small", { col: 2, row: 2 }, { name: "Imp", kind: "npc" }) } };
      assert.deepEqual(applied(loose, { ...plain, seat: { tokenId: "imp", ...at } }, DM).tokens.imp, loose.tokens.imp, "a token not on the mount");
      // A walk that ends squeezed seats her by the squeeze: into the corridor, dropped on the corridor's hex.
      const { s: keep, path } = keepRide(g);
      const inside = hexStandPlace(g, keep.tokens.horse!, { size: "medium", ref: path[1]!, squeezed: true });
      const squeezed: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...inside, squeeze: true };
      const plainIn = applyOp(keep, squeezed, DM, env(1));
      const seatIn = applyOp(keep, { ...squeezed, seat: { tokenId: "bree", ...placedOnHex(g, keep.tokens.bree!, path[2]!) } }, DM, env(1));
      assert.ok(plainIn.ok && seatIn.ok);
      assert.deepEqual(seatIn.state.tokens.bree, plainIn.state.tokens.bree, "a squeezed end");
      // A stop trap on the warhorse's way: the cut drops the seat.
      const op: OpOf<"token.move"> = { ...plain, seat: { tokenId: "bree", ...at } };
      const spots = trapWalks(op, s, P1, {}).find((w) => w.tokenId === "horse")!.spots;
      const start = new Set(hexesOf(g, s.tokens.horse!));
      const mid = spots.slice(1, -1).flatMap((p) => occupiedHexes(g, { ...s.tokens.horse!, x: p.x, y: p.y })).find((h) => !start.has(hexKey(h)))!;
      const trapped = structuredClone(s);
      trapped.traps.stop = trap("stop", { grid: g.orient === "rows" ? "hexRows" : "hexColumns", zone: { cells: [{ x: mid.col, y: mid.row, w: 1, h: 1 }] } });
      const cut = planTrapMove(op, trapped, P1, {}).op;
      assert.notEqual(cut, op, "the trap cuts the walk");
      assert.ok(cut.t === "token.move" && cut.seat === undefined, `the cut drops the seat: ${JSON.stringify(cut)}`);
      const r = applyOp(trapped, op, P1, env(1));
      assert.ok(r.ok);
      const landed = trapLandings(op, trapped, P1, {});
      for (const id of ["horse", "bree"]) assert.deepEqual([r.state.tokens[id]!.x, r.state.tokens[id]!.y], [landed.get(id)!.x, landed.get(id)!.y], `${id} where the trap step lands it`);
    });

    test("a rider every player sees sits alike with and without a hidden rider beside her, and a player's seat naming the hidden one is ignored", () => {
      const { s: base, to, hex } = openDrop(g);
      base.scenes.s1 = { ...base.scenes.s1!, fogEnabled: true };
      for (const t of Object.values(base.tokens)) if (t) base.tokens[t.id] = { ...t, fogExempt: true };
      const free = occupiedHexes(g, base.tokens.horse!).find((h) => !hexesOf(g, base.tokens.bree!).includes(hexKey(h)))!;
      const beside = structuredClone(base);
      beside.tokens.spy = onHex(g, "spy", "medium", free, { name: "Spy", kind: "npc", visibility: "dm", attached: { to: "horse", kind: "ride" } });
      const copies = (state: RoomState) => [P1, P2].map((v) => stableStringify(projectState(state, v, { sceneId: "s1" })));
      assert.deepEqual(copies(beside), copies(base), "the copies start the same");
      const at = placedOnHex(g, base.tokens.bree!, hex);
      const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...to, seat: { tokenId: "bree", ...at } };
      assert.equal(canApply(op, P1, beside, deps).ok, canApply(op, P1, base, deps).ok, "the answer");
      assert.deepEqual(copies(applied(beside, op, P1)), copies(applied(base, op, P1)), "every player's copy with the hidden rider");
      // A hidden rider whose place carries it onto the very hex Bree is dropped on: she still sits there, as without it.
      let carriedThere = 0;
      for (const h of occupiedHexes(g, base.tokens.horse!)) {
        if (hexesOf(g, base.tokens.bree!).includes(hexKey(h))) continue;
        const under = structuredClone(base);
        under.tokens.spy = onHex(g, "spy", "medium", h, { name: "Spy", kind: "npc", visibility: "dm", attached: { to: "horse", kind: "ride" } });
        const after = applied(under, op, P1);
        if (hexesOf(g, after.tokens.spy!).join() !== hexKey(hex)) continue;
        carriedThere++;
        assert.deepEqual(copies(after), copies(applied(base, op, P1)), `the hidden rider from ${hexKey(h)} on ${hexKey(hex)} too`);
      }
      assert.equal(carriedThere, 1, "one hidden rider's place carries it onto that hex");
      // Pat names the hidden rider, from a hex its place does not carry it onto that hex from: ignored, as a token that does not
      // exist is.
      const elsewhere = occupiedHexes(g, base.tokens.horse!).map((h) => {
        const state = structuredClone(base);
        state.tokens.spy = onHex(g, "spy", "medium", h, { name: "Spy", kind: "npc", visibility: "dm", attached: { to: "horse", kind: "ride" } });
        return state;
      });
      const spied = elsewhere.find((state) => !hexesOf(g, state.tokens.spy!).some((h) => hexesOf(g, state.tokens.bree!).includes(h)) && hexesOf(g, applied(state, op, P1).tokens.spy!).join() !== hexKey(hex))!;
      assert.ok(spied, "a hex the spy's place carries it elsewhere from");
      const spyAt = placedOnHex(g, spied.tokens.spy!, hex);
      const named = applied(spied, { ...op, seat: { tokenId: "spy", ...spyAt } }, P1);
      const unknown = applied(spied, { ...op, seat: { tokenId: "nobody", ...spyAt } }, P1);
      assert.deepEqual(copies(named), copies(unknown), "the copies alike");
      assert.deepEqual(named.tokens.spy, unknown.tokens.spy, "the spy where its place carries it");
      assert.notDeepEqual(hexesOf(g, named.tokens.spy!), [hexKey(hex)], "not on the hex Pat named");
      // The DM's seat for the hidden rider seats it.
      assert.deepEqual(hexesOf(g, applied(spied, { ...op, seat: { tokenId: "spy", ...spyAt } }, DM).tokens.spy!), [hexKey(hex)], "the DM seats the spy");
    });
  });
}

describe("squares: a rider sits on the square she was dropped on (LP40-HEX-SEAT)", () => {
  /** A Large warhorse on 2, 2 with Bree riding its bottom-right square, and walls round open ground. */
  function squareRide(): RoomState {
    const s = room({ scenes: { s1: scene("s1", { bounds: { w: 20, h: 20 }, blockMovement: true }) } });
    s.tokens.horse = token("horse", { sceneId: "s1", size: "large", x: 2, y: 2, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    s.tokens.bree = token("bree", { sceneId: "s1", size: "medium", x: 3, y: 3, name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
    return s;
  }

  test("Bree dropped on the new stand's top-left square sits there, where her place carried her to its bottom-right", () => {
    const s = squareRide();
    const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 6, y: 2, seat: { tokenId: "bree", x: 6, y: 2 } };
    for (const actor of [P1, DM]) {
      const after = applied(s, op, actor);
      assert.deepEqual([after.tokens.bree!.x, after.tokens.bree!.y], [6, 2], `${actor.role}: on the square she was dropped on`);
      assert.deepEqual([applied(s, op, actor, 62).tokens.bree!.x, applied(s, op, actor, 62).tokens.bree!.y], [7, 3], `${actor.role}: op 62 by her place`);
    }
    // Off the stand, or half a square off her grid, it is no seat.
    for (const seat of [
      { x: 8, y: 2 },
      { x: 6.5, y: 2 },
    ]) {
      const after = applied(s, { ...op, seat: { tokenId: "bree", ...seat } }, P1);
      assert.deepEqual([after.tokens.bree!.x, after.tokens.bree!.y], [7, 3], `${JSON.stringify(seat)}: by her place`);
    }
  });

  test("the walk's trap step reads her on the dropped seat where the walk ends, as the move leaves her", () => {
    const s = squareRide();
    s.traps.mark = trap("mark", { zone: { cells: [{ x: 6, y: 2, w: 1, h: 1 }] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false } });
    const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 6, y: 2, seat: { tokenId: "bree", x: 6, y: 2 } };
    const walk = planWalks(op, s, P1, {}).find((m) => m.tokenId === "bree")!;
    assert.deepEqual([walk.to.x, walk.to.y], [6, 2]);
    const landed = trapLandings(op, s, P1, {});
    assert.deepEqual(landed.get("bree"), { x: 6, y: 2, elevation: 0 }, "the trap step lands her there");
    const after = applied(s, op, P1);
    assert.deepEqual([after.tokens.bree!.x, after.tokens.bree!.y], [6, 2]);
  });
});

test("the seat is gated at 63", () => {
  assert.deepEqual([seatsWhereDropped(1), seatsWhereDropped(62), seatsWhereDropped(63), seatsWhereDropped(undefined)], [false, false, true, true]);
});
