import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wall } from "../discoveryTestutil.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState } from "../project.ts";
import { opSchema, type Op, type OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { getOffSpot } from "../rules/attach.ts";
import { footprintRect, footprintSize } from "../rules/footprint.ts";
import { SQUARES } from "../rules/grid.ts";
import { findRouteOn } from "../rules/hexWalk.ts";
import { ownWalk } from "../rules/movement.ts";
import { planMove } from "../rules/moveLeg.ts";
import { DM, P1, character, env, member, room, scene, token } from "../testutil.ts";

/**
 * What sits on a holder whose walk squeezes on squares (D-261029-53, as
 * D-261029-52 on hexes): at each point where the holder stands squeezed it
 * takes the seat nearest it on the squares the squeeze stands on, and its
 * own seat where the holder stands full size (D-261029-80). So a rider in a
 * corridor one square wide sits on its mount's square there, never
 * straddling the corridor's wall, and its torch lights the corridor for
 * the party from every seat. Get off from a squeezed mount lands in the
 * corridor. Ops stored before version 29 replay by the offset.
 */

/** Rock from x 8 to 16 but for a corridor along rows `top` to `top + wide`, walled round, on a dark scene with fog and party vision. */
function corridor(wide: 1 | 2): { s: RoomState; rock: (x: number, y: number) => boolean; top: number } {
  const top = 10;
  const bottom = top + wide;
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off", fogEnabled: true, vision: { on: true, light: "dark" } }) } });
  s.buildChunks = {};
  const runs: [[number, number], [number, number]][] = [
    [[8, 0], [8, top]],
    [[8, bottom], [8, 20]],
    [[16, 0], [16, top]],
    [[16, bottom], [16, 20]],
    [[8, top], [16, top]],
    [[8, bottom], [16, bottom]],
  ];
  runs.forEach(([a, b], i) => wall(s, `fu35sq${String(i).padStart(6, "0")}`, a, b));
  s.characters.brom = character("brom", { name: "Brom", ownerIds: ["p1"] });
  return { s, rock: (x, y) => x >= 8 && x < 16 && (y < top || y >= bottom), top };
}

function withMount(s: RoomState, size: Token["size"], x: number, y: number): RoomState {
  return { ...s, tokens: { ...s.tokens, horse: token("horse", { size, x, y, name: "Warhorse", kind: "npc", disposition: "ally", ownerIds: ["p1"] }) } };
}

/** `who` of `size` on the holder at `x`, `y`, by a link of `kind`, Brom with his torch. */
function seated(s: RoomState, who: string, size: Token["size"], x: number, y: number, kind: "ride" | "carry"): RoomState {
  const extra: Partial<Token> = who === "brom" ? { name: "Brom", kind: "pc", actor: { ref: "brom" }, ownerIds: ["p1"], disposition: "ally", light: { bright: 10, dim: 10 } } : { name: "Kobold", kind: "npc" };
  return { ...s, tokens: { ...s.tokens, [who]: token(who, { size, x, y, ...extra, attached: { to: "horse", kind } }) } };
}

/** Every seat on the holder for a carried token of `size`: the spots on its snap grid inside the holder's box. */
function seats(holder: Token, size: Token["size"]): [number, number][] {
  const h = footprintSize(holder);
  const c = footprintSize({ size, x: 0, y: 0 });
  const out: [number, number][] = [];
  for (let y = holder.y; y + c.h <= holder.y + h.h; y++) for (let x = holder.x; x + c.w <= holder.x + h.w; x++) out.push([x, y]);
  return out;
}

function routeTo(s: RoomState, to: { x: number; y: number }): [number, number, number, 0 | 1][] | undefined {
  const found = findRouteOn({ build: s, token: ownWalk(s.tokens.horse!), rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } }, to);
  assert.ok(found !== "none", "a way into the corridor");
  return found ? found.pieces.map(([x, y, extra, swim]) => [x, y, extra, swim]) : undefined;
}

function run(s: RoomState, op: Op, who: Viewer = DM, opVersion?: number): RoomState {
  const parsed = opSchema.parse(op);
  const allowed = canApply(parsed, who, s, { canUseAsset: () => true });
  assert.ok(allowed.ok, allowed.ok ? "" : allowed.message);
  const r = applyOp(s, parsed, who, opVersion === undefined ? env(1) : { ...env(1), opVersion });
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.state;
}

/** The squares a box covers, as "x,y". */
function squares(t: { x: number; y: number; w: number; h: number }): string[] {
  const out: string[] = [];
  for (let y = Math.floor(t.y); y < Math.ceil(t.y + t.h - 1e-9); y++) for (let x = Math.floor(t.x); x < Math.ceil(t.x + t.w - 1e-9); x++) out.push(`${x},${y}`);
  return out;
}

/**
 * Every point of the carried token's walk is out of the rock, and where the walk ends it sits on its own snap grid inside
 * its holder's full box. Past the start a route may bend half a square off the grid in open ground, which no seat reads.
 */
function sitsClear(s: RoomState, op: OpOf<"token.move">, who: string, rock: (x: number, y: number) => boolean): void {
  const plan = planMove(op, s, DM, {});
  const holder = plan.find((m) => m.tokenId === "horse")!;
  const carried = plan.find((m) => m.tokenId === who)!;
  assert.equal(carried.route.length, holder.route.length);
  const size = footprintSize(s.tokens[who]!);
  carried.route.forEach((q, i) => {
    const box = { x: q.x, y: q.y, ...size };
    assert.ok(squares(box).every((k) => !rock(...(k.split(",").map(Number) as [number, number]))), `point ${i}: ${squares(box)} never in the rock`);
  });
  const end = carried.route.at(-1)!;
  const full = footprintRect(SQUARES, { ...s.tokens.horse!, x: holder.route.at(-1)!.x, y: holder.route.at(-1)!.y, squeeze: undefined });
  assert.ok(Number.isInteger(end.x) && Number.isInteger(end.y), `${end.x}, ${end.y} on its own grid`);
  assert.ok(end.x >= full.x && end.y >= full.y && end.x + size.w <= full.x + full.w && end.y + size.h <= full.y + full.h, "on its holder");
}

describe("squares: a rider on a Large mount in a corridor one square wide", () => {
  const inside = { x: 11.5, y: 9.5 };

  test("from every seat a walk into the corridor leaves it on the mount's one square there, by a route or a straight leg, and out again on a full seat", () => {
    const { s: base, rock } = corridor(1);
    const s = withMount(base, "large", 3, 9);
    for (const [x, y] of seats(s.tokens.horse!, "medium")) {
      for (const [who, size, kind] of [["brom", "medium", "ride"], ["kob", "small", "carry"]] as const) {
        const state = seated(s, who, size, x, y, kind);
        const route = routeTo(state, inside);
        for (const op of [{ t: "token.move", tokenId: "horse", ...inside, squeeze: true, ...(route ? { route } : {}) }, { t: "token.move", tokenId: "horse", ...inside, squeeze: true }] as OpOf<"token.move">[]) {
          sitsClear(state, op, who, rock);
          const after = run(state, op);
          assert.deepEqual(squares({ ...after.tokens[who]!, ...footprintSize(after.tokens[who]!) }), ["12,10"], `${who} from ${x}, ${y} on the mount's square`);
          assert.equal(after.tokens[who]!.attached?.to, "horse", "never let go");
        }
        // A route that stops in the corridor on its way, by the squeeze rule there, and on out of it.
        const through: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 18, y: 9, route: [[11.5, 9.5, 0, 0], [18, 9, 0, 0]] };
        sitsClear(state, through, who, rock);
        const mid = planMove(through, state, DM, {}).find((m) => m.tokenId === who)!.route[1]!;
        assert.deepEqual([mid.x, mid.y], [12, 10], `${who} from ${x}, ${y} on the mount's square where the route stops in the corridor`);
        // Along the corridor and out of it from there.
        const there = run(state, { t: "token.move", tokenId: "horse", ...inside, squeeze: true });
        const along: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 13.5, y: 9.5, squeeze: true };
        sitsClear(there, along, who, rock);
        const out: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 18, y: 9 };
        sitsClear(there, out, who, rock);
        const outside = run(there, out);
        assert.equal(outside.tokens[who]!.attached?.to, "horse");
      }
    }
  });

  test("his torch lights the corridor for the party from every seat: Pat sees the goblin down it", () => {
    const { s: base } = corridor(1);
    const s = withMount(base, "large", 3, 9);
    s.tokens.gob = token("gob", { x: 14, y: 10, name: "Goblin", kind: "monster", disposition: "hostile" });
    for (const [x, y] of seats(s.tokens.horse!, "medium")) {
      const state = seated(s, "brom", "medium", x, y, "ride");
      assert.equal(projectState(state, P1, { sceneId: "s1" }).tokens.gob, undefined, "in the dark before");
      const after = run(state, { t: "token.move", tokenId: "horse", ...inside, squeeze: true });
      assert.ok(projectState(after, P1, { sceneId: "s1" }).tokens.gob, `Pat sees the goblin with Brom on seat ${x}, ${y}`);
    }
  });

  test("an op stored at version 28 replays to the offset it was written under, version 29 and a live op to the mount's square", () => {
    const { s: base } = corridor(1);
    const s = withMount(base, "large", 3, 9);
    for (const [x, y] of seats(s.tokens.horse!, "medium")) {
      const state = seated(s, "brom", "medium", x, y, "ride");
      const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...inside, squeeze: true };
      const old = run(state, op, DM, 28).tokens.brom!;
      assert.deepEqual([old.x, old.y], [inside.x + (x - 3), inside.y + (y - 9)], "the old offset, straddling the corridor's wall");
      for (const opVersion of [29, undefined]) assert.deepEqual([run(state, op, DM, opVersion).tokens.brom!.x, run(state, op, DM, opVersion).tokens.brom!.y], [12, 10]);
    }
  });

  test("Get off from the squeezed mount lands in the corridor beside it, for the DM and for the rider's player", () => {
    const { s: base, rock } = corridor(1);
    const s = withMount(base, "large", 3, 9);
    for (const [x, y] of seats(s.tokens.horse!, "medium")) {
      const state = run(seated(s, "brom", "medium", x, y, "ride"), { t: "token.move", tokenId: "horse", ...inside, squeeze: true });
      const spot = getOffSpot(SQUARES, state.meta.settings, state.scenes.s1!.bounds, state.tokens.brom!, state.tokens.horse!);
      assert.ok(spot, "room to get off");
      assert.ok(!rock(spot.x, spot.y) && spot.y === 10, `${spot.x}, ${spot.y} in the corridor`);
      for (const who of [DM, P1]) assert.equal(run(state, { t: "token.detach", tokenId: "brom", x: spot.x, y: spot.y, elevation: 0 }, who).tokens.brom!.attached, undefined);
    }
  });
});

describe("squares: a Huge mount in a corridor two squares wide", () => {
  test("a Medium rider and a Large one sit on the two by two squares it squeezes onto, from every seat", () => {
    const { s: base, rock } = corridor(2);
    const s = withMount(base, "huge", 2, 9);
    const inside = { x: 10.5, y: 9.5 };
    for (const size of ["medium", "large"] as const) {
      const all = seats(s.tokens.horse!, size);
      assert.equal(all.length, size === "medium" ? 9 : 4);
      for (const [x, y] of all) {
        const state = seated(s, "brom", size, x, y, "ride");
        const route = routeTo(state, inside);
        const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...inside, squeeze: true, ...(route ? { route } : {}) };
        sitsClear(state, op, "brom", rock);
        const after = run(state, op);
        const stand = new Set(squares(footprintRect(SQUARES, after.tokens.horse!)));
        assert.ok(squares({ ...after.tokens.brom!, ...footprintSize(after.tokens.brom!) }).every((k) => stand.has(k)), `${size} from ${x}, ${y} on the squeezed squares`);
        assert.equal(after.tokens.brom!.attached?.to, "horse");
      }
    }
  });
});
