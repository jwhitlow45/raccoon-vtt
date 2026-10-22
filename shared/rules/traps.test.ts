import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "../keys.ts";
import type { BuildChunk, RoomState, Token, Trap, TrapRig } from "../model.ts";
import type { Op } from "../protocol.ts";
import { DM, P1, actor, room, token } from "../testutil.ts";
import { sizeCategory } from "./footprint.ts";
import { encodeHeights } from "./heights.ts";
import { compareProgress, planTrapMove, planTurn, setsOff, trapWalks, wireCells, zoneRanges, type Springing, type TrapRoom } from "./traps.ts";

/**
 * The trap rules (docs/design-v1-traps.md section 5 and 11, "Rules"): spots
 * and steps, what sets a trap off and where, the order of events, stops,
 * and who a springing hits at its moment. P1 plays Thorn, a PC, and the DM
 * runs everything else.
 */

function rig(overrides: Partial<TrapRig> = {}): TrapRig {
  return { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, ...overrides };
}

function trap(id: string, zone: Trap["zone"], overrides: Partial<TrapRig> = {}, extra: Partial<Trap> = {}): Trap {
  return { id, rev: 0, sceneId: "s1", name: id, zone, state: "armed", found: false, rig: rig(overrides), ...extra };
}

const square = (x: number, y: number, w = 1, h = 1): Trap["zone"] => ({ cells: [{ x, y, w, h }] });

function world(tokens: Token[], traps: Trap[], tweak: (s: RoomState) => void = () => {}): TrapRoom {
  const state = room();
  for (const t of tokens) state.tokens[t.id] = t;
  tweak(state);
  return { ...state, traps: Object.fromEntries(traps.map((t) => [t.id, t])) };
}

const thorn = (over: Partial<Token> = {}) => token("thorn", { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 0, y: 5, ...over });

function plan(state: TrapRoom, op: Op, who = DM) {
  return planTrapMove(op, state, who, {});
}

function summary(springings: readonly Springing[]): string[] {
  return springings.map((s) => `${s.trap.id}:${s.how}:${s.pass}:${s.by.join("+")}`);
}

describe("stepping onto and off a trap", () => {
  test("a walk steps onto a square and off it, each its own trap, in order", () => {
    const state = world([thorn()], [trap("plate", square(3, 5)), trap("lever", square(3, 5), { on: ["leave"] })]);
    const p = plan(state, { t: "token.move", tokenId: "thorn", x: 6, y: 5 });
    assert.deepEqual(summary(p.springings), ["plate:enter:public:thorn", "lever:leave:public:thorn"]);
  });

  test("a creature already on a trap that moves within it sets nothing off", () => {
    const state = world([thorn({ x: 3 })], [trap("pit", square(3, 5, 3, 1))]);
    assert.deepEqual(plan(state, { t: "token.move", tokenId: "thorn", x: 5, y: 5 }).springings, []);
  });

  test("a trap goes off at most once a move, with every creature whose event falls at the same moment", () => {
    const bree = token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 0, y: 6 });
    const state = world([thorn(), bree], [trap("plate", square(3, 5, 1, 2))]);
    const op: Op = { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 6, y: 5 }, { tokenId: "bree", x: 6, y: 6 }] };
    assert.deepEqual(summary(plan(state, op).springings), ["plate:enter:public:bree+thorn"]);
  });

  test("a flier landing on a trap steps onto it", () => {
    const state = world([thorn({ x: 3, elevation: 10 })], [trap("plate", square(3, 5))]);
    const op: Op = { t: "token.update", tokenId: "thorn", patch: { elevation: 0 } };
    assert.deepEqual(summary(plan(state, op).springings), ["plate:enter:public:thorn"]);
  });

  test("a teleport is tested only where it lands", () => {
    const state = world([thorn()], [trap("plate", square(3, 5)), trap("end", square(6, 5))]);
    const op: Op = { t: "token.move", tokenId: "thorn", x: 6, y: 5, teleport: "wall" };
    assert.deepEqual(summary(plan(state, op).springings), ["end:enter:public:thorn"]);
  });

  test("traps go off only on the players' scene, and not behind a blackout", () => {
    const off = world([thorn({ sceneId: "s2" })], [trap("plate", square(3, 5), {}, { sceneId: "s2" })]);
    assert.deepEqual(plan(off, { t: "token.move", tokenId: "thorn", x: 6, y: 5 }).springings, []);
    const dark = world([thorn()], [trap("plate", square(3, 5))], (s) => (s.meta = { ...s.meta, view: { ...s.meta.view, blackout: true } }));
    assert.deepEqual(plan(dark, { t: "token.move", tokenId: "thorn", x: 6, y: 5 }).springings, []);
  });
});

describe("the footprint a walk has (route.ts onTrace, as an area's sweep reads it)", () => {
  // Squeezed at 3.5, 3.5, a Large ogre fills square 4,4 alone. Full size it fills 4,4 to 5,5.
  const ogre = (over: Partial<Token> = {}) => token("ogre", { name: "Ogre", size: "large", x: 3.5, y: 3.5, squeeze: true, ...over });
  const land = { t: "token.update", tokenId: "ogre", patch: { elevation: 0 } } as Op;

  test("a squeezed flier landing from the height controls keeps its squeeze, so it lands on no square only its full footprint covers", () => {
    assert.deepEqual(summary(plan(world([ogre({ elevation: 10 })], [trap("plate", square(5, 5))]), land).springings), []);
    assert.deepEqual(summary(plan(world([ogre({ elevation: 10, squeeze: undefined, x: 4, y: 4 })], [trap("plate", square(5, 5))]), land).springings), ["plate:enter:public:ogre"], "full size, it lands on the plate");
  });

  test("a walk that starts squeezed is squeezed on its first piece only: at that piece's end it stands full size, as its trace has it", () => {
    // Down to the corner 3.5, 6.5 and back west: only the full footprint at the corner covers square 5,7.
    const op: Op = { t: "token.move", tokenId: "ogre", x: 0.5, y: 6.5, route: [[3.5, 6.5, 0, 0], [0.5, 6.5, 0, 0]] };
    assert.deepEqual(summary(plan(world([ogre()], [trap("plate", square(5, 7))]), op).springings), ["plate:enter:public:ogre"]);
    assert.deepEqual(summary(plan(world([ogre()], [trap("plate", square(5, 5))]), op).springings), [], "squeezed down its first piece, it never reaches column 5");
  });

  test("a walk that starts squeezed is squeezed along its first piece, so it passes a square only its full footprint covers", () => {
    // Squeezed along row 4 the whole straight leg, it ends full size at 10, 4 to 11, 5, past the plate.
    assert.deepEqual(plan(world([ogre()], [trap("plate", square(6, 5))]), { t: "token.move", tokenId: "ogre", x: 9.5, y: 3.5 }).springings, []);
    assert.deepEqual(summary(plan(world([ogre({ squeeze: undefined, x: 4, y: 4 })], [trap("plate", square(6, 5))]), { t: "token.move", tokenId: "ogre", x: 10, y: 4 }).springings), ["plate:enter:public:ogre"], "full size, it steps onto it");
  });

  test("a walk that squeezes only where it ends steps onto the squares it passes with its full footprint", () => {
    const state = world([token("ogre", { name: "Ogre", size: "large", x: 0, y: 4 })], [trap("plate", square(3, 5))]);
    assert.deepEqual(summary(plan(state, { t: "token.move", tokenId: "ogre", x: 6.5, y: 3.5, squeeze: true }).springings), ["plate:enter:public:ogre"]);
  });
});

describe("trip wires", () => {
  const wire = (a: [number, number], b: [number, number]): Trap["zone"] => ({ wire: { a, b } });

  test("a walk across a wire crosses it between the two spots its centers pass", () => {
    const state = world([thorn()], [trap("wire", wire([3, 0], [3, 10]), { on: [] })]);
    assert.deepEqual(summary(plan(state, { t: "token.move", tokenId: "thorn", x: 6, y: 5 }).springings), ["wire:cross:public:thorn"]);
  });

  test("a center passing through a wire's end on a corner crosses it", () => {
    const ogre = token("ogre", { name: "Ogre", size: "large", x: 1, y: 3 });
    const state = world([ogre], [trap("wire", wire([3, 4], [3, 6]), { on: [] })]);
    assert.deepEqual(summary(plan(state, { t: "token.move", tokenId: "ogre", x: 4, y: 3 }).springings), ["wire:cross:public:ogre"]);
  });

  test("a walk along a wire's line never crosses it", () => {
    const ogre = token("ogre", { name: "Ogre", size: "large", x: 2, y: 0 });
    const state = world([ogre], [trap("wire", wire([3, 0], [3, 10]), { on: [] })]);
    assert.deepEqual(plan(state, { t: "token.move", tokenId: "ogre", x: 2, y: 8 }).springings, []);
  });

  test("a teleport crosses nothing", () => {
    const state = world([thorn()], [trap("wire", wire([3, 0], [3, 10]), { on: [] })]);
    assert.deepEqual(plan(state, { t: "token.move", tokenId: "thorn", x: 6, y: 5, teleport: "wall" }).springings, []);
  });

  test("the cells a wire passes over, which the fog rule reads", () => {
    assert.deepEqual(wireCells({ a: [3, 4], b: [3, 6] }).map((c) => `${c.x},${c.y}`).sort(), ["2,3", "2,4", "2,5", "2,6", "3,3", "3,4", "3,5", "3,6"]);
    assert.deepEqual(zoneRanges({ buildChunks: {} }, "s1", { door: { edge: "4,2,w" } }), [{ x0: 4, y0: 2, x1: 5, y1: 3 }, { x0: 3, y0: 2, x1: 4, y1: 3 }]);
    assert.ok(wireCells({ a: [0, 0], b: [5.5, 15] }).some((c) => c.x === 4 && c.y === 10), "a cell it cuts a corner of (review TR-ASTRA-04)");
  });

  test("the cells a wire passes over are exactly the closed squares it meets, for every wire from ends near the origin", () => {
    // Liang-Barsky on each closed square, its fractions compared by cross-multiplying, in half cells so all on integers.
    const meets = (a: readonly [number, number], b: readonly [number, number], x: number, y: number): boolean => {
      const [ax, ay, bx, by] = [a[0] * 2, a[1] * 2, b[0] * 2, b[1] * 2];
      let lo: [number, number] = [0, 1];
      let hi: [number, number] = [1, 1];
      for (const [p, q] of [[ax - bx, ax - 2 * x], [bx - ax, 2 * x + 2 - ax], [ay - by, ay - 2 * y], [by - ay, 2 * y + 2 - ay]] as const) {
        if (p === 0) {
          if (q < 0) return false;
        } else if (p < 0 && q * lo[1] < lo[0] * p) lo = [-q, -p];
        else if (p > 0 && q * hi[1] < hi[0] * p) hi = [q, p];
      }
      return lo[0] * hi[1] <= hi[0] * lo[1];
    };
    const onLattice = (x: number, y: number) => Number.isInteger(x) || Number.isInteger(y);
    let wires = 0;
    for (let ax = 0; ax <= 4; ax += 0.5) for (let ay = 0; ay <= 4; ay += 0.5) for (let bx = 0; bx <= 12; bx += 0.5) for (let by = 0; by <= 12; by += 0.5) {
      const a = [ax, ay] as const;
      const b = [bx, by] as const;
      const length = Math.hypot(bx - ax, by - ay);
      if (!onLattice(ax, ay) || !onLattice(bx, by) || length < 0.5 || length > 20) continue;
      wires++;
      const want: string[] = [];
      for (let y = 0; y <= 13; y++) for (let x = 0; x <= 13; x++) if (meets(a, b, x, y)) want.push(`${x},${y}`);
      const got = wireCells({ a, b }).map((c) => `${c.x},${c.y}`);
      assert.deepEqual(got.sort(), want.sort(), `${a} to ${b}`);
    }
    assert.ok(wires > 30_000, `${wires} wires`);
  });
});

describe("who sets a trap off (5.2)", () => {
  test("party is a token a player owns or plays, never one the DM lends the party's sight", () => {
    const state = world([thorn(), token("gob", { x: 0, y: 6 }), token("ally", { x: 0, y: 7, partyVision: true })], []);
    const party = rig({ who: "party" });
    const others = rig({ who: "others" });
    assert.equal(setsOff(party, state, state.tokens.thorn!), true);
    assert.equal(setsOff(party, state, state.tokens.gob!), false);
    assert.equal(setsOff(party, state, state.tokens.ally!), false);
    assert.equal(setsOff(others, state, state.tokens.gob!), true);
    assert.equal(setsOff(others, state, state.tokens.thorn!), false);
  });

  test("objects and the dead set nothing off", () => {
    const state = world([token("chest", { kind: "object" }), token("dead", { actor: { inline: actor({ life: "dead" }) } })], []);
    assert.equal(setsOff(rig(), state, state.tokens.chest!), false);
    assert.equal(setsOff(rig(), state, state.tokens.dead!), false);
  });

  test("Small or larger leaves Tiny out, a custom size counted by its longer side", () => {
    const state = world([token("rat", { size: "tiny" }), token("mite", { size: "custom", w: 0.5, h: 0.5 }), token("eel", { size: "custom", w: 1, h: 0.5 })], []);
    const small = rig({ minSize: "small" });
    assert.equal(sizeCategory(state.tokens.mite!), "tiny");
    assert.equal(setsOff(small, state, state.tokens.rat!), false);
    assert.equal(setsOff(small, state, state.tokens.mite!), false);
    assert.equal(setsOff(small, state, state.tokens.eel!), true);
  });
});

describe("the floor (5.2)", () => {
  const plate = trap("plate", square(3, 5));

  test("a flier above it and a burrower below it set off nothing on the floor", () => {
    for (const elevation of [10, -10]) {
      const state = world([thorn({ elevation })], [plate]);
      assert.deepEqual(plan(state, { t: "token.move", tokenId: "thorn", x: 6, y: 5 }).springings, [], `elevation ${elevation}`);
    }
  });

  test("a mount sets off a plate and its rider does not, though a glyph without the floor rule catches both", () => {
    const horse = token("horse", { name: "Warhorse", size: "large", disposition: "ally", ownerIds: ["p1"], x: 0, y: 5 });
    // The rider sits on the horse's leading half, so the two reach the glyph at the same moment.
    const rider = thorn({ x: 1, attached: { to: "horse", kind: "ride" } });
    const op: Op = { t: "token.move", tokenId: "horse", x: 5, y: 5 };
    assert.deepEqual(summary(plan(world([horse, rider], [plate]), op).springings), ["plate:enter:public:horse"]);
    const glyph = trap("glyph", square(3, 5), { floor: false });
    assert.deepEqual(summary(plan(world([horse, rider], [glyph]), op).springings), ["glyph:enter:public:horse+thorn"]);
  });

  test("a dragged creature a flier lifts is off the floor", () => {
    const griffon = token("griffon", { name: "Griffon", size: "large", x: 0, y: 4, elevation: 10 });
    const goblin = token("gob", { x: 2, y: 5, elevation: 10, attached: { to: "griffon", kind: "drag" } });
    const state = world([griffon, goblin], [trap("plate", square(5, 5))]);
    assert.deepEqual(plan(state, { t: "token.move", tokenId: "griffon", x: 4, y: 4 }).springings, []);
    // On the ground behind a walker, it steps onto the plate.
    const walker = world([{ ...griffon, elevation: 0 }, { ...goblin, elevation: 0 }], [trap("plate", square(5, 5))]);
    assert.deepEqual(summary(plan(walker, { t: "token.move", tokenId: "griffon", x: 4, y: 4 }).springings), ["plate:enter:public:gob"]);
  });

  test("a dragged creature walks full size, even one squeezed where it stood, as its holder takes it along (route.ts followerTrace)", () => {
    const griffon = token("griffon", { name: "Griffon", size: "large", x: 0, y: 4 });
    // Squeezed at 1.5, 5.5 it fills square 2,6 alone, so only its full footprint ever reaches row 7.
    const ogre = token("ogre", { name: "Ogre", size: "large", x: 1.5, y: 5.5, squeeze: true, attached: { to: "griffon", kind: "drag" } });
    const state = world([griffon, ogre], [trap("plate", square(5, 7))]);
    assert.deepEqual(summary(plan(state, { t: "token.move", tokenId: "griffon", x: 4, y: 4 }).springings), ["plate:enter:public:ogre"]);
  });
});

describe("steps and passes (5.3)", () => {
  test("a group's public members share the finest step among them", () => {
    const familiar = token("owl", { name: "Owl", kind: "npc", size: "tiny", ownerIds: ["p1"], x: 0, y: 5, attached: { to: "thorn", kind: "perch" } });
    const state = world([thorn(), familiar], []);
    const walks = trapWalks({ t: "token.move", tokenId: "thorn", x: 4, y: 5 }, state, P1, {});
    assert.deepEqual(walks.map((w) => [w.tokenId, w.isPublic, w.step, w.spots.length]), [
      ["owl", true, 0.5, 9],
      ["thorn", true, 0.5, 9],
    ]);
  });

  test("a mover's own Tiny familiar hidden from the others leaves the step at whole squares", () => {
    const familiar = token("owl", { name: "Owl", kind: "npc", size: "tiny", ownerIds: ["p1"], x: 0, y: 5, visibility: "dm", attached: { to: "thorn", kind: "perch" } });
    const state = world([thorn(), familiar], []);
    const walks = trapWalks({ t: "token.move", tokenId: "thorn", x: 4, y: 5 }, state, P1, {});
    assert.deepEqual(walks.map((w) => [w.tokenId, w.isPublic, w.step, w.spots.length]), [
      ["owl", false, 0.5, 9],
      ["thorn", true, 1, 5],
    ]);
  });

  test("a visible rider on a hidden mount walks as itself, and its trap stops the hidden mount with it", () => {
    const horse = token("horse", { name: "Nightmare", size: "large", x: 0, y: 5, visibility: "dm" });
    const rider = thorn({ attached: { to: "horse", kind: "ride" } });
    const state = world([horse, rider], [trap("pit", square(3, 5), { stops: true })]);
    const op: Op = { t: "token.move", tokenId: "horse", x: 6, y: 5 };
    const walks = trapWalks(op, state, DM, {});
    assert.deepEqual(walks.map((w) => [w.tokenId, w.isPublic, w.walker]), [
      ["horse", false, false],
      ["thorn", true, true],
    ]);
    const p = plan(state, op);
    assert.deepEqual(summary(p.springings), ["pit:enter:public:thorn"]);
    assert.deepEqual(p.op.t === "token.move" ? [p.op.x, p.op.y] : null, [3, 5]);
  });

  test("named moves walk once each, whatever the order they are named in", () => {
    const horse = token("horse", { name: "Warhorse", size: "large", disposition: "ally", ownerIds: ["p1"], x: 0, y: 4 });
    const rider = thorn({ y: 4, attached: { to: "horse", kind: "ride" } });
    const torch = token("torch", { name: "Torch", kind: "object", size: "tiny", ownerIds: ["p1"], x: 0, y: 4, attached: { to: "thorn", kind: "carry" } });
    const state = world([horse, rider, torch], []);
    const a: Op = { t: "token.moveMany", moves: [{ tokenId: "horse", x: 4, y: 4 }, { tokenId: "thorn", x: 0, y: 8 }] };
    const b: Op = { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 0, y: 8 }, { tokenId: "horse", x: 4, y: 4 }] };
    const ends = (op: Op) => trapWalks(op, state, DM, {}).map((w) => [w.tokenId, w.spots[w.spots.length - 1]!.x, w.spots[w.spots.length - 1]!.y]);
    assert.deepEqual(ends(a), [["horse", 4, 4], ["thorn", 0, 8], ["torch", 0, 8]]);
    assert.deepEqual(ends(b), ends(a));
  });

  test("a loop the rules let stand walks each token once", () => {
    const a = token("a", { x: 0, y: 5, attached: { to: "b", kind: "carry" } });
    const b = token("b", { x: 0, y: 5, attached: { to: "a", kind: "carry" } });
    const state = world([a, b], []);
    assert.deepEqual(trapWalks({ t: "token.move", tokenId: "a", x: 3, y: 5 }, state, DM, {}).map((w) => w.tokenId), ["a", "b"]);
  });
});

describe("the order of events (5.4)", () => {
  test("a token.moveMany's legs of different lengths order by how far along each leg it is", () => {
    const quick = token("quick", { x: 0, y: 2 });
    const slow = token("slow", { x: 0, y: 8 });
    // Quick's trap is at the end of a 2-square leg, slow's halfway along a 6-square one.
    const state = world([quick, slow], [trap("a", square(2, 2)), trap("b", square(3, 8))]);
    const op: Op = { t: "token.moveMany", moves: [{ tokenId: "quick", x: 2, y: 2 }, { tokenId: "slow", x: 6, y: 8 }] };
    assert.deepEqual(summary(plan(state, op).springings), ["b:enter:public:slow", "a:enter:public:quick"]);
  });

  test("progress compares exactly, piece first", () => {
    assert.ok(compareProgress([0, 1, 3], [0, 2, 6]) === 0);
    assert.ok(compareProgress([0, 2, 3], [0, 3, 6]) > 0);
    assert.ok(compareProgress([1, 0, 4], [0, 4, 4]) > 0);
  });

  test("of two stopping traps on a route the earlier stops the group, and its later events are dropped", () => {
    const state = world([thorn()], [trap("near", square(2, 5), { stops: true }), trap("far", square(4, 5), { stops: true })]);
    const p = plan(state, { t: "token.move", tokenId: "thorn", x: 6, y: 5 });
    assert.deepEqual(summary(p.springings), ["near:enter:public:thorn"]);
    assert.deepEqual(p.op.t === "token.move" ? [p.op.x, p.op.y] : null, [2, 5]);
  });
});

describe("stops (5.5)", () => {
  function walled(): BuildChunk {
    return { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls: [{ id: "wallwallwall", a: [1.25, 1.25], b: [1.75, 1.25], f: { kind: "wall" } }] };
  }

  test("a snapped spot that clips a wall the leg passed is no stand, so a later spot is taken, here the walk's end, which is no stop", () => {
    const gob = token("gob", { x: 0, y: 0 });
    const state = world([gob], [trap("snare", square(1, 1), { stops: true })], (s) => {
      s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true, autoWalls: "off" };
      s.buildChunks[chunkKey("s1", 0, 0)] = walled();
    });
    const op: Op = { t: "token.move", tokenId: "gob", x: 2, y: 1 };
    const p = plan(state, op);
    assert.deepEqual(summary(p.springings), ["snare:enter:public:gob"]);
    assert.equal(p.op, op);
  });

  test("a Large creature's half step onto a stopping trap goes on to its next whole square, on the trap (review LP13-TR-2)", () => {
    // The ogre steps by half squares, as a creature that squeezes does, and first meets the plate's column at x 2.5.
    const ogre = token("ogre", { name: "Ogre", size: "large", x: 0, y: 4 });
    const state = world([ogre], [trap("pit", square(4, 4, 2, 2), { stops: true })]);
    const p = plan(state, { t: "token.move", tokenId: "ogre", x: 9, y: 4 });
    assert.deepEqual(summary(p.springings), ["pit:enter:public:ogre"]);
    assert.deepEqual(p.op.t === "token.move" ? [p.op.x, p.op.y] : null, [3, 4], "not at 2, beside the lid");
  });

  test("a group with a Tiny member every player sees, on its half steps, stops on the trap too (review LP13-TR-2)", () => {
    const owl = token("owl", { name: "Owl", size: "tiny", x: 0, y: 5, attached: { to: "thorn", kind: "perch" } });
    const state = world([thorn(), owl], [trap("plate", square(3, 5), { stops: true })]);
    const p = plan(state, { t: "token.move", tokenId: "thorn", x: 6, y: 5 });
    assert.deepEqual(summary(p.springings), ["plate:enter:public:thorn"]);
    assert.deepEqual(p.op.t === "token.move" ? [p.op.x, p.op.y] : null, [3, 5], "not at 2, beside the plate");
  });

  test("a group that walks on to its stop still meets what lies between, and nothing past it", () => {
    // Thorn sets the plate off at x 2.5 and walks on to x 3, where the owl on Thorn's shoulder first covers the glyph's square.
    const owl = token("owl", { name: "Owl", size: "tiny", x: 0, y: 5, attached: { to: "thorn", kind: "perch" } });
    const glyph = (id: string, x: number) => trap(id, square(x, 5), { who: "others", floor: false });
    const state = world([thorn(), owl], [trap("plate", square(3, 5), { stops: true }), glyph("glyph", 3), glyph("past", 4)]);
    const p = plan(state, { t: "token.move", tokenId: "thorn", x: 6, y: 5 });
    assert.deepEqual(summary(p.springings), ["plate:enter:public:thorn", "glyph:enter:public:owl"]);
  });

  test("a taut route is cut at its stop, a piece's extra kept", () => {
    const gob = token("gob", { x: 0, y: 4 });
    // The second piece's first spot snaps to 3,5.
    const state = world([gob], [trap("snare", square(3, 5), { stops: true })]);
    const p = plan(state, { t: "token.move", tokenId: "gob", x: 6, y: 6, route: [[2, 4, 0, 0], [6, 6, 1, 0]] });
    assert.deepEqual(p.op.t === "token.move" ? [p.op.x, p.op.y, p.op.route] : null, [3, 5, [[2, 4, 0, 0], [3, 5, 1, 0]]]);
  });

  test("a taut route's snapped spot that clips a wall is no stand, so the stop goes on to the next it may stop at", () => {
    const gob = token("gob", { x: 0, y: 4 });
    const state = world([gob], [trap("snare", square(3, 5), { stops: true })], (s) => {
      s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true, autoWalls: "off" };
      s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls: [{ id: "wallwallwall", a: [3.25, 5.25], b: [3.75, 5.25], f: { kind: "wall" } }] };
    });
    const p = plan(state, { t: "token.move", tokenId: "gob", x: 6, y: 6, route: [[2, 4, 0, 0], [6, 6, 1, 0]] });
    assert.deepEqual(summary(p.springings), ["snare:enter:public:gob"]);
    assert.deepEqual(p.op.t === "token.move" ? [p.op.x, p.op.y, p.op.route] : null, [4, 5, [[2, 4, 0, 0], [4, 5, 1, 0]]]);
  });

  test("with no spot it may stop at past the trap, the walk goes on to its end, so a stop never refuses the op", () => {
    const gob = token("gob", { x: 1, y: 0 });
    const state = world([gob], [trap("snare", square(1, 1), { stops: true })], (s) => {
      s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true, autoWalls: "off" };
      s.buildChunks[chunkKey("s1", 0, 0)] = walled();
    });
    const op: Op = { t: "token.move", tokenId: "gob", x: 1, y: 2 };
    assert.equal(plan(state, op).op, op);
  });

  test("a stop squeezed in a corridor lands on the ground under its squeezed footprint, not the raised ground its full one would cover", () => {
    // A one-square corridor along row 5, walled above and below, with the row south of it raised 10 ft past x = 3.
    const ogre = token("ogre", { name: "Ogre", size: "large", x: 0, y: 5 });
    const heights = new Array(256).fill(0);
    for (let x = 3; x < 16; x++) heights[6 * 16 + x] = 10;
    const state = world([ogre], [trap("snare", square(5, 5), { stops: true })], (s) => {
      s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true, autoWalls: "off" };
      s.buildChunks[chunkKey("s1", 0, 0)] = {
        sceneId: "s1",
        cx: 0,
        cy: 0,
        rev: 1,
        cells: {},
        edges: {},
        heights: encodeHeights(heights)!,
        walls: [
          { id: "corridornort", a: [3, 5], b: [10, 5], f: { kind: "wall" } },
          { id: "corridorsout", a: [3, 6], b: [10, 6], f: { kind: "wall" } },
        ],
      };
    });
    const p = plan(state, { t: "token.move", tokenId: "ogre", x: 8.5, y: 4.5, squeeze: true, route: [[1.5, 4.5, 0, 0], [8.5, 4.5, 0, 0]] });
    assert.deepEqual(summary(p.springings), ["snare:enter:public:ogre"]);
    assert.ok(p.op.t === "token.move");
    assert.deepEqual([p.op.x, p.op.y, p.op.squeeze, p.op.elevation], [3.5, 4.5, true, 0], "its full footprint first reaches the plate there");
  });

  test("a trap that does not stop leaves the move as it is", () => {
    const state = world([thorn()], [trap("alarm", square(3, 5))]);
    const op: Op = { t: "token.move", tokenId: "thorn", x: 6, y: 5 };
    assert.equal(plan(state, op).op, op);
  });
});

describe("who it hits, frozen at the moment (5.6)", () => {
  test("a crossing caught by the statue's cone hits the creature where it crossed, past the cone at the end", () => {
    const cone = { shape: "cone" as const, size: 15, origin: { x: 3, y: 6, z: 0 }, yaw: 270, includeOrigin: true };
    const state = world([thorn({ x: 2, y: 9 })], [trap("statue", { wire: { a: [2, 4], b: [5, 4] } }, { on: [], hits: { area: cone } })]);
    const p = plan(state, { t: "token.move", tokenId: "thorn", x: 2, y: 0 });
    assert.deepEqual(summary(p.springings), ["statue:cross:public:thorn"]);
    assert.deepEqual(p.springings[0]!.hits, ["thorn"]);
  });

  test("everyone on the trap is hit, who and the floor deciding only who sets it off", () => {
    const flier = token("bat", { name: "Bat", x: 4, y: 5, elevation: 10 });
    const state = world([thorn(), flier], [trap("roof", square(3, 5, 2, 1), { who: "party", hits: "zone" })]);
    const p = plan(state, { t: "token.move", tokenId: "thorn", x: 3, y: 5 });
    assert.deepEqual(p.springings[0]!.hits, ["bat", "thorn"]);
  });
});

describe("turns (5.1)", () => {
  test("the creature whose turn starts on a plate sets it off, public when every player sees it", () => {
    const state = world([thorn({ x: 3 }), token("shade", { x: 3, y: 6, visibility: "dm" })], [trap("statue", square(3, 5, 1, 2), { on: ["turnStart"] })]);
    assert.deepEqual(summary(planTurn(state, "thorn", "turnStart", {})), ["statue:turnStart:public:thorn"]);
    assert.deepEqual(summary(planTurn(state, "shade", "turnStart", {})), ["statue:turnStart:private:shade"]);
    assert.deepEqual(planTurn(state, "thorn", "turnEnd", {}), []);
  });
});
