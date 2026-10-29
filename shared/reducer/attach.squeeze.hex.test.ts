import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { opSchema, type Op, type OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { getOffSpot } from "../rules/attach.ts";
import { occupiedHexes, placedOnHex, tokenRefHex } from "../rules/footprint.ts";
import { hexCenter, hexKey, type Hex } from "../rules/hex.ts";
import { findRouteOn } from "../rules/hexWalk.ts";
import { hexStandPlace, onSqueezedLattice, ownWalk } from "../rules/movement.ts";
import { planMove } from "../rules/moveLeg.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "../rules/hexWalls.testkit.ts";
import { DM, P1, character, env, template } from "../testutil.ts";

/**
 * What sits on a holder whose walk squeezes on a hex scene (D-261029-52,
 * LP24-A-HEXFIGHT-1): at each point of the walk it takes the seat nearest
 * it on the hexes the holder stands on there, so a rider squeezes through
 * a corridor on its mount's hex, and takes its nearest full seat again
 * where the mount stands up. Its link reads the full footprint, so it never
 * lets go, and Get off from a squeezed mount lands in the corridor. Ops
 * stored before version 29 replay by the offset they were written under.
 */

for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const bounds = g.orient === "rows" ? { w: 22, h: 16 } : { w: 16, h: 22 };
  const rules = { feetPerCell: 5, diagonal: "five" as const };

  /** Rock across the scene from 6 to 12 along, a corridor through it on the rows across `open`, a mount west of it. */
  function corridor(open: readonly number[], mount: Token["size"], ref: Hex): { s: RoomState; solid: (h: Hex) => boolean } {
    const solid = (h: Hex) => {
      const along = g.orient === "rows" ? h.col : h.row;
      const across = g.orient === "rows" ? h.row : h.col;
      return along >= 6 && along <= 12 && !open.includes(across);
    };
    const s = hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, solid));
    s.characters.brom = character("brom", { name: "Brom", ownerIds: ["p1"] });
    s.tokens.horse = onHex(g, "horse", mount, ref, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    return { s, solid };
  }

  /** `who` of `size` seated on the holder's hex `seat`, by a link of `kind`. */
  function seated(s: RoomState, who: string, size: Token["size"], seat: Hex, kind: "ride" | "carry"): RoomState {
    const extra: Partial<Token> = who === "brom" ? { name: "Brom", kind: "pc", actor: { ref: "brom" }, ownerIds: ["p1"] } : { name: "Kobold", kind: "npc" };
    return { ...s, tokens: { ...s.tokens, [who]: onHex(g, who, size, seat, { ...extra, attached: { to: "horse", kind } }) } };
  }

  function routeTo(s: RoomState, to: { x: number; y: number }): [number, number, number, 0 | 1][] {
    const found = findRouteOn({ build: s, token: ownWalk(s.tokens.horse!), rules, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } }, to);
    assert.ok(found && found !== "none", "a way through the corridor");
    return found.pieces.map(([x, y, extra, swim]) => [x, y, extra, swim]);
  }

  function applied(s: RoomState, op: Op, who: Viewer = DM, opVersion?: number) {
    const parsed = opSchema.parse(op);
    const allowed = canApply(parsed, who, s, { canUseAsset: () => true });
    assert.ok(allowed.ok, allowed.ok ? "" : allowed.message);
    const r = applyOp(s, parsed, who, opVersion === undefined ? env(1) : { ...env(1), opVersion });
    assert.ok(r.ok, r.ok ? "" : r.message);
    return r;
  }

  function run(s: RoomState, op: Op, who: Viewer = DM, opVersion?: number): RoomState {
    return applied(s, op, who, opVersion).state;
  }

  const keys = (hexes: readonly Hex[]) => hexes.map(hexKey).sort();

  /**
   * Every point of the carried token's walk sits on a seat: its box where its own hexes put it (placedOnHex), each of
   * them one the holder stands on at that point, as the walk has it there: as it stood at the start, by its lattice past
   * it, and at the end as the move leaves it.
   */
  function sitsOnTheStand(s: RoomState, op: OpOf<"token.move">, who: string, solid: (h: Hex) => boolean): void {
    const plan = planMove(op, s, DM, {});
    const holder = plan.find((m) => m.tokenId === "horse")!;
    const carried = plan.find((m) => m.tokenId === who)!;
    assert.equal(carried.route.length, holder.route.length);
    let squeezes = 0;
    holder.route.forEach((p, i) => {
      const last = i === holder.route.length - 1;
      const squeezed = i === 0 ? s.tokens.horse!.squeeze === true : last ? op.squeeze === true : onSqueezedLattice(g, s.tokens.horse!, p);
      if (squeezed) squeezes++;
      const stand = new Set(occupiedHexes(g, { ...s.tokens.horse!, x: p.x, y: p.y, ...(squeezed ? { squeeze: true as const } : {}) }).map(hexKey));
      const box = { ...s.tokens[who]!, x: carried.route[i]!.x, y: carried.route[i]!.y };
      const hexes = occupiedHexes(g, box);
      assert.ok(hexes.every((h) => stand.has(hexKey(h))), `point ${i}: ${keys(hexes)} on the holder's ${[...stand].sort()}`);
      assert.ok(hexes.every((h) => !solid(h)), `point ${i}: never in the rock`);
      if (i > 0) {
        const place = placedOnHex(g, box, tokenRefHex(g, box));
        assert.ok(Math.abs(place.x - box.x) < 1e-9 && Math.abs(place.y - box.y) < 1e-9, `point ${i}: on its seat's anchor`);
      }
    });
    assert.ok(squeezes > 0, "the walk squeezes");
  }

  describe(`${name}: a rider on a Large mount through a one-hex corridor`, () => {
    test("each seat it starts on gives way to the mount's one hex in the corridor and a full seat again past it, and the move puts it there", () => {
      const { s, solid } = corridor([6], "large", at(2, 5));
      const out = placedOnHex(g, s.tokens.horse!, at(16, 6));
      const route = routeTo(s, out);
      for (const seat of occupiedHexes(g, s.tokens.horse!)) {
        for (const [who, size, kind] of [["brom", "medium", "ride"], ["kob", "small", "carry"]] as const) {
          const state = seated(s, who, size, seat, kind);
          const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...out, route };
          sitsOnTheStand(state, op, who, solid);
          const after = run(state, op);
          const placed = after.tokens[who]!;
          assert.deepEqual(placed.attached, { to: "horse", kind }, "never let go mid-corridor");
          const full = new Set(occupiedHexes(g, after.tokens.horse!).map(hexKey));
          assert.ok(occupiedHexes(g, placed).every((h) => full.has(hexKey(h))), "on a full seat past the corridor");
        }
      }
    });

    test("a walk that ends in the corridor leaves it on the mount's hex, by a route or a straight leg", () => {
      const { s, solid } = corridor([6], "large", at(2, 5));
      const inside = hexStandPlace(g, s.tokens.horse!, { size: "medium", ref: at(9, 6), squeezed: true });
      for (const seat of occupiedHexes(g, s.tokens.horse!)) {
        const state = seated(s, "brom", "medium", seat, "ride");
        const routed: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...inside, squeeze: true, route: routeTo(state, inside) };
        sitsOnTheStand(state, routed, "brom", solid);
        const after = run(state, routed);
        assert.deepEqual(keys(occupiedHexes(g, after.tokens.brom!)), [hexKey(at(9, 6))]);
        assert.equal(after.tokens.brom!.attached?.to, "horse");
        assert.equal(after.tokens.brom!.squeeze, undefined, "a rider never squeezes itself");
      }
      // A straight leg into the corridor from beside its mouth, squeezed where it ends as the op says.
      const mouth = { ...s, tokens: { ...s.tokens, horse: onHex(g, "horse", "large", at(4, 6), s.tokens.horse!) } };
      const near = seated(mouth, "brom", "medium", occupiedHexes(g, mouth.tokens.horse!)[2]!, "ride");
      const into: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...hexStandPlace(g, near.tokens.horse!, { size: "medium", ref: at(7, 6), squeezed: true }), squeeze: true };
      sitsOnTheStand(near, into, "brom", solid);
      assert.deepEqual(keys(occupiedHexes(g, run(near, into).tokens.brom!)), [hexKey(at(7, 6))]);
      // A squeeze the op asks for off the squeezed lattice, the box's middle on a corner of the corridor's hex: the op decides, as the reducer stores it.
      const { squeeze: _flag, ...full } = near.tokens.horse!;
      const offLattice: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...placedOnHex(g, full, at(9, 6)), squeeze: true };
      const crafted = run(near, offLattice);
      assert.deepEqual(keys(occupiedHexes(g, crafted.tokens.horse!)), [hexKey(at(9, 6))], "the warhorse squeezed onto the corridor's hex");
      assert.deepEqual(keys(occupiedHexes(g, crafted.tokens.brom!)), [hexKey(at(9, 6))]);
      // A straight leg along the corridor, from the mount's one hex to another.
      const inState = run(seated(s, "brom", "medium", at(2, 5), "ride"), { t: "token.move", tokenId: "horse", ...inside, squeeze: true, route: routeTo(s, inside) });
      const further = hexStandPlace(g, inState.tokens.horse!, { size: "medium", ref: at(11, 6), squeezed: true });
      const straight: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...further, squeeze: true };
      sitsOnTheStand(inState, straight, "brom", solid);
      assert.deepEqual(keys(occupiedHexes(g, run(inState, straight).tokens.brom!)), [hexKey(at(11, 6))]);
      // And on out of it from there, standing up past the rock on a full seat.
      const { squeeze: _squeeze, ...standing } = inState.tokens.horse!;
      const out = placedOnHex(g, standing, at(16, 6));
      // The straight leg out is open, so it is walked as one, squeezed while it leaves the corridor.
      const leaving: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...out };
      sitsOnTheStand(inState, leaving, "brom", solid);
      const outside = run(inState, leaving);
      assert.ok(occupiedHexes(g, outside.tokens.brom!).every((h) => occupiedHexes(g, outside.tokens.horse!).some((f) => hexKey(f) === hexKey(h))));
    });

    test("an op stored at version 28 replays to the offset it was written under, version 29 and a live op to the mount's hex", () => {
      const { s } = corridor([6], "large", at(2, 5));
      const inside = hexStandPlace(g, s.tokens.horse!, { size: "medium", ref: at(9, 6), squeezed: true });
      const seat = occupiedHexes(g, s.tokens.horse!)[2]!;
      const state = seated(s, "brom", "medium", seat, "ride");
      const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...inside, squeeze: true, route: routeTo(state, inside) };
      const old = run(state, op, DM, 28).tokens.brom!;
      const horse = state.tokens.horse!;
      const brom = state.tokens.brom!;
      assert.equal(old.x, inside.x + (brom.x - horse.x));
      assert.equal(old.y, inside.y + (brom.y - horse.y));
      assert.notDeepEqual(keys(occupiedHexes(g, old)), [hexKey(at(9, 6))], "the old offset leaves it off the mount's hex");
      for (const opVersion of [29, undefined]) assert.deepEqual(keys(occupiedHexes(g, run(state, op, DM, opVersion).tokens.brom!)), [hexKey(at(9, 6))]);
    });

    test("an area in the rock beside the corridor never meets the rider squeezed through on its mount's hex, which the offset of version 28 walked it through", () => {
      const { s: room } = corridor([6], "large", at(2, 5));
      // Area reminders are a fight's.
      const s = run(run(room, { t: "encounter.start", entries: [{ id: "n1", tokenId: "horse", value: 20 }] }), { t: "encounter.next" });
      for (const across of [5, 7]) {
        const c = hexCenter(g, at(9, across));
        s.templates[`g${across}`] = template(`g${across}`, { shape: "sphere", size: 1, origin: { x: c.x, y: c.y, z: 0 }, spell: "Grease", triggers: ["enter"] });
      }
      const out = placedOnHex(g, s.tokens.horse!, at(16, 6));
      const route = routeTo(s, out);
      const met = (opVersion: number | undefined) =>
        occupiedHexes(g, s.tokens.horse!).map((seat) => applied(seated(s, "brom", "medium", seat, "ride"), { t: "token.move", tokenId: "horse", ...out, route }, DM, opVersion).log.filter((e) => e.data?.type === "area").length);
      assert.deepEqual(met(undefined), [0, 0, 0], "from every seat it passes beside them");
      assert.ok(met(28).some((n) => n > 0), "the old offset swept a seat through the rock");
    });

    test("Get off from the squeezed mount lands on a hex of the corridor beside it, for the DM and for the rider's player", () => {
      // Two corridors: on half of the hexes, those of the first, the full footprint's reference hex is another than the one it squeezes onto.
      for (const across of [5, 6]) {
        const { s, solid } = corridor([across], "large", at(2, across - 1));
        const inside = hexStandPlace(g, s.tokens.horse!, { size: "medium", ref: at(9, across), squeezed: true });
        const state = run(seated(s, "brom", "medium", occupiedHexes(g, s.tokens.horse!)[1]!, "ride"), { t: "token.move", tokenId: "horse", ...inside, squeeze: true, route: routeTo(s, inside) });
        const spot = getOffSpot(g, state.meta.settings, state.scenes.s1!.bounds, state.tokens.brom!, state.tokens.horse!);
        assert.ok(spot, "room to get off");
        const off = { ...state.tokens.brom!, ...spot };
        assert.ok(occupiedHexes(g, off).every((h) => !solid(h)), `${keys(occupiedHexes(g, off))} lies in the corridor`);
        for (const who of [DM, P1]) {
          const after = run(state, { t: "token.detach", tokenId: "brom", x: spot.x, y: spot.y, elevation: 0 }, who);
          assert.equal(after.tokens.brom!.attached, undefined);
        }
      }
    });
  });

  describe(`${name}: a Huge mount through a corridor two hexes wide`, () => {
    test("a Medium rider and a Large one sit on the Large three it squeezes onto, and on full seats past it", () => {
      const { s, solid } = corridor([6, 7], "huge", at(2, 6));
      const out = placedOnHex(g, s.tokens.horse!, at(16, 6));
      const route = routeTo(s, out);
      const mount = new Set(occupiedHexes(g, s.tokens.horse!).map(hexKey));
      for (const [size, seats] of [["medium", occupiedHexes(g, s.tokens.horse!)], ["large", occupiedHexes(g, s.tokens.horse!)]] as const) {
        let tried = 0;
        for (const seat of seats) {
          const state = seated(s, "brom", size, seat, "ride");
          // A Large rider's three hexes from that top hex, where they all lie on the mount's seven.
          if (!occupiedHexes(g, state.tokens.brom!).every((h) => mount.has(hexKey(h)))) continue;
          tried++;
          const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...out, route };
          sitsOnTheStand(state, op, "brom", solid);
          assert.equal(run(state, op).tokens.brom!.attached?.to, "horse");
        }
        assert.equal(tried, size === "medium" ? 7 : 3, `every ${size} seat`);
      }
    });
  });
}
