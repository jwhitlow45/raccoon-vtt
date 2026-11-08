import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { heights, wall } from "#shared/discoveryTestutil.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { linkHolds, onHolder } from "#shared/rules/attach.ts";
import { footprintSize, occupiedHexes } from "#shared/rules/footprint.ts";
import { gridOfShape, SQUARES } from "#shared/rules/grid.ts";
import { hexCenter, hexKey, hexNeighbors, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { hexWallRoom, onHex, wallsRound } from "#shared/rules/hexWalls.testkit.ts";
import type { Point } from "#shared/rules/geom.ts";
import { chance, env, int, member, P1, pick, rng, room, scene, token, trap } from "#shared/testutil.ts";
import { copyFor } from "../attach/testing.ts";
import { dragOf } from "./dragTesting.ts";

/**
 * Random drags of a mount into a corridor on squares, for single file
 * (D-261101-250, D-261101-397, review FU45BR-OPUS-1 and FU45BR-OPUS-3): a
 * Large or Huge mount with riders, one to three creatures it drags, some
 * dragged by those in turn or led by a rider, over raised ground, dropped
 * in a corridor one or two squares wide, some with a goblin carrying an
 * owl that drags a rat, and some with traps players have not found on the
 * way in. Every op the board sends is one the server takes, and a walk
 * that ends squeezed keeps every link, cut by a trap or not: one the file
 * would leave out of its holder's reach holds the drag instead. Where no
 * trap goes off, the player's copy lands every token where the server
 * does and the preview holds the mount where it lands. On every walk a
 * rider keeps its seat and the prisoner it leads, a mount off its grid
 * carrying them by its snapped box (RIDER-LED-HALF-SEAT, op version 41).
 * Other links are asserted on the squeezed walks single file changed: a
 * creature the mount drags by its place, at another snap than the mount's,
 * can still let go on a full-size walk by half a square.
 */

function corridorRoom(wide: 1 | 2, top: number): RoomState {
  const state = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") }, scenes: { s1: scene("s1", { bounds: { w: 26, h: 18 }, blockMovement: true, autoWalls: "off" }) } });
  state.buildChunks = {};
  const bottom = top + wide;
  const runs: [[number, number], [number, number]][] = [[[8, 0], [8, top]], [[8, bottom], [8, 18]], [[16, 0], [16, top]], [[16, bottom], [16, 18]], [[8, top], [16, top]], [[8, bottom], [16, bottom]]];
  runs.forEach(([a, b], i) => wall(state, `fu45bz${String(i).padStart(6, "0")}`, a, b));
  return state;
}

/** A seed's room: the mount west of the corridor, its riders, what it drags and what those drag, on ground some of which is raised. */
function roomOf(seed: number): { state: RoomState; top: number } | null {
  const r = rng(seed * 104729 + 7);
  const wide = pick(r, [1, 1, 2] as const);
  const top = int(r, 5, 9);
  const state = corridorRoom(wide, top);
  const size = wide === 1 ? "large" : pick(r, ["large", "huge"] as const);
  const side = size === "large" ? 2 : 3;
  const mx = int(r, 1, 4) + (chance(r, 0.2) ? 0.5 : 0);
  const my = top - int(r, 0, side) + (chance(r, 0.2) ? 0.5 : 0);
  state.tokens.mount = token("mount", { size, x: mx, y: my, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  const riders = size === "huge" ? int(r, 0, 3) : int(r, 0, 1);
  const seats: [number, number][] = [];
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) seats.push([x, y]);
  for (let i = 0; i < riders; i++) {
    const [sx, sy] = seats.splice(int(r, 0, seats.length - 1), 1)[0]!;
    state.tokens[`rider${i}`] = token(`rider${i}`, { x: Math.floor(mx) + sx, y: Math.floor(my) + sy, name: `Rider ${i}`, kind: "pc", ownerIds: ["p1"], attached: { to: "mount", kind: "ride", ...(i === 0 ? { steer: true } : {}) } });
  }
  const towed = int(r, 1, 3);
  for (let i = 0; i < towed; i++) {
    const big = chance(r, 0.2);
    const tiny = !big && chance(r, 0.15);
    const spot = pick(r, [
      [mx - (big ? 2 : 1), my + int(r, 0, side - 1)],
      [mx + int(r, 0, side - 1), my + side],
      [mx + int(r, 0, side - 1), my - (big ? 2 : 1)],
      [mx - 1, my - 1],
      [mx - 1, my + side],
    ] as const);
    // Some are dragged by the one before them, which the file lines up behind it.
    const by = i > 0 && chance(r, 0.3) ? `tow${i - 1}` : "mount";
    const extra: Partial<Token> = chance(r, 0.25) ? { elevation: 5 } : {};
    state.tokens[`tow${i}`] = token(`tow${i}`, { size: big ? "large" : tiny ? "tiny" : "medium", x: spot[0], y: spot[1], name: `Goblin ${i}`, kind: "npc", attached: { to: by, kind: "drag" }, ...extra });
  }
  if (riders > 0 && chance(r, 0.3)) state.tokens.led = token("led", { x: mx - 1, y: my + side - 1, name: "Prisoner", kind: "npc", attached: { to: "rider0", kind: "drag" } });
  // Raised ground west of the corridor, under the walks in and around them, some of it a low ledge.
  for (let k = int(r, 0, 2); k > 0; k--) heights(state, { x: int(r, 0, 7), y: int(r, top - 3, top + 3), w: int(r, 1, 4), h: int(r, 1, 2) }, pick(r, [2, 5, 10]));
  // A Tiny owl the first goblin carries, which may drag a rat: a carried link inside the file's chains (review FU45B-ASTRA-05).
  const carrier = state.tokens.tow0!;
  if (carrier.size === "medium" && chance(r, 0.5)) {
    state.tokens.owl = token("owl", { size: "tiny", x: carrier.x, y: carrier.y, elevation: carrier.elevation, name: "Owl", kind: "npc", attached: { to: "tow0", kind: "carry" } });
    if (chance(r, 0.6)) state.tokens.rat = token("rat", { size: "tiny", x: carrier.x - 0.5, y: carrier.y, name: "Rat", kind: "npc", attached: { to: "owl", kind: "drag" } });
  }
  // Traps players have not found on the way in: one that stops a walk, and one on the floor, so cuts land on raised ground too.
  if (chance(r, 0.35)) state.traps.stop = trap("stop", { zone: { cells: [{ x: int(r, 3, 12), y: top - 1, w: 1, h: wide + 2 }] } });
  if (chance(r, 0.3)) state.traps.floor = trap("floor", { zone: { cells: [{ x: int(r, 0, 8), y: int(r, top - 2, top + 2), w: 2, h: 2 }] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false } });
  const holds = Object.values(state.tokens).every((t) => !t!.attached || linkHolds(SQUARES, state.meta.settings, t!.attached.kind, t!, state.tokens[t!.attached.to]!));
  return holds ? { state, top } : null;
}

/** Whether a token sits on the mount, or a token sitting on it leads it: a rider, and its prisoner (RIDER-LED-HALF-SEAT). */
function onMount(state: RoomState, token: Token): boolean {
  const link = token.attached;
  if (!link) return false;
  if (link.to === "mount") return onHolder(link.kind);
  const holder = state.tokens[link.to]?.attached;
  return holder?.to === "mount" && onHolder(holder.kind);
}

describe("squares: random drags into a corridor with creatures in tow (D-261101-250, D-261101-397)", () => {
  test("what the board sends the server takes, lands alike on the player's copy, and a walk that ends squeezed keeps every link", () => {
    let squeezed = 0;
    let lined = 0;
    let named = 0;
    let cut = 0;
    let carried = 0;
    let offGrid = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const made = roomOf(seed);
      if (!made) continue;
      const { state, top } = made;
      const r = rng(seed * 7919 + 3);
      const side = state.tokens.mount!.size === "large" ? 2 : 3;
      // The finger near the corridor's middle row, so the mount's box lands squeezed in it or holds at its mouth.
      const raw = { x: int(r, 9, 14) + r() * 0.9, y: top - (side - 1) / 2 - 0.5 + (r() - 0.5) * 0.8 };
      const copy = copyFor(state, P1);
      const drag = dragOf(copy, "player", "mount", raw);
      if (drag.plan.stop?.follower !== undefined) named++;
      if (!drag.op) continue;
      const op = drag.op as Op;
      const at = `seed ${seed}: ${JSON.stringify(op)}`;
      const allowed = canApply(op, P1, state, { canUseAsset: () => true });
      assert.ok(allowed.ok, `${at}: ${allowed.ok ? "" : allowed.message}`);
      const server = applyOp(state, op, P1, env(10));
      const device = applyOp(copy, op, P1, env(10));
      if (!server.ok || !device.ok) assert.fail(at);
      // A trap players have not found is the server's alone, so where one goes off the copy does not know of it.
      const sprung = Object.values(server.state.traps).some((t) => t!.state !== state.traps[t!.id]!.state);
      if (!sprung) {
        for (const id of Object.keys(copy.tokens)) {
          const a: Token = server.state.tokens[id]!;
          const b: Token = device.state.tokens[id]!;
          assert.deepEqual([b.x, b.y, b.elevation, b.attached?.to], [a.x, a.y, a.elevation, a.attached?.to], `${at}: ${id} on the player's copy`);
        }
        const landed = server.state.tokens.mount!;
        assert.deepEqual([drag.preview.to.x, drag.preview.to.y], [landed.x, landed.y], `${at}: the preview holds where it lands`);
      }
      // On every walk a rider keeps its seat and its prisoner: one on a mount off its grid goes by the mount's snapped box (op version 41).
      const mount = state.tokens.mount!;
      if (state.tokens.rider0 && (op.t !== "token.move" || op.squeeze !== true) && (!Number.isInteger(mount.x) || !Number.isInteger(mount.y))) offGrid++;
      for (const t of Object.values(state.tokens)) if (onMount(state, t!)) assert.equal(server.state.tokens[t!.id]!.attached?.to, t!.attached?.to, `${at}: ${t!.id} still held`);
      if (op.t !== "token.move" || op.squeeze !== true) continue;
      squeezed++;
      if (server.state.tokens.mount!.squeeze !== true || server.state.tokens.mount!.x !== op.x) cut++;
      if (state.tokens.owl) carried++;
      const inFile = Object.values(state.tokens).filter((t) => t!.attached?.kind === "drag").length;
      if (inFile >= 2) lined++;
      for (const t of Object.values(state.tokens)) if (t!.attached) assert.equal(server.state.tokens[t!.id]!.attached?.to, t!.attached.to, `${at}: ${t!.id} still held`);
    }
    // Enough of each kind that the rules above meet them: walks that end squeezed, with two or more in the file, drags held for one,
    // walks a trap cut, and walks with a carried owl in the chains.
    assert.ok(squeezed >= 75, `walks that end squeezed: ${squeezed}`);
    assert.ok(lined >= 30, `with two or more in the file: ${lined}`);
    assert.ok(named >= 96, `held, naming the one that cannot follow: ${named}`);
    assert.ok(cut >= 16, `walks that end squeezed a trap cut: ${cut}`);
    assert.ok(carried >= 17, `with a goblin carrying an owl: ${carried}`);
    assert.ok(offGrid >= 18, `full-size walks of a ridden mount off its grid: ${offGrid}`);
  });
});


/**
 * The same on hexes (RIDE-SINGLE-FILE-HEX and SEAT-TIE-HEX, D-261107-172,
 * D-261107-173, op version 51): a Large mount into a corridor one hex wide
 * or a Huge one into one two hexes wide, its riders, one to three
 * creatures it drags, of one hex mostly and some Large, some dragged by
 * those in turn, and traps players have not found on the way in. Every op
 * the board sends the server takes, a walk that ends squeezed keeps every
 * link, and where no trap goes off the player's copy lands every token
 * where the server does and the preview holds the mount where it lands.
 */
function hexRoomOf(seed: number, g: HexGrid): { state: RoomState; mid: Point } | null {
  const r = rng(seed * 15485863 + 11);
  const wide = pick(r, [1, 1, 2] as const);
  const size = wide === 1 ? "large" : pick(r, ["large", "huge"] as const);
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const top = int(r, 6, 9);
  const solid = (h: Hex) => {
    const along = g.orient === "rows" ? h.col : h.row;
    const across = g.orient === "rows" ? h.row : h.col;
    return along >= 9 && along <= 17 && (across < top || across >= top + wide);
  };
  const bounds = g.orient === "rows" ? { w: 26, h: 18 } : { w: 18, h: 26 };
  const state = hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, solid));
  state.members = { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") };
  state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: false };
  const start = at(int(r, 2, 5), top + int(r, -1, 1));
  state.tokens.mount = onHex(g, "mount", size, start, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  const own = occupiedHexes(g, state.tokens.mount);
  const riders = size === "huge" ? pick(r, [0, 1, 2, 2, 3, 3] as const) : int(r, 0, 1);
  const seats = [...own];
  for (let i = 0; i < riders; i++) {
    const seat = seats.splice(int(r, 0, seats.length - 1), 1)[0]!;
    state.tokens[`rider${i}`] = onHex(g, `rider${i}`, "medium", seat, { name: `Rider ${i}`, kind: "pc", ownerIds: ["p1"], attached: { to: "mount", kind: "ride", ...(i === 0 ? { steer: true } : {}) } });
  }
  const taken = new Set(own.map(hexKey));
  const around = [...new Map(own.flatMap((h) => hexNeighbors(g, h)).filter((h) => !taken.has(hexKey(h)) && !solid(h)).map((h) => [hexKey(h), h] as const)).values()];
  const towed = pick(r, [1, 2, 2, 3] as const);
  for (let i = 0; i < towed && around.length > 0; i++) {
    const big = chance(r, 0.2);
    const hex = around.splice(int(r, 0, around.length - 1), 1)[0]!;
    const by = i > 0 && chance(r, 0.3) ? `tow${i - 1}` : "mount";
    state.tokens[`tow${i}`] = onHex(g, `tow${i}`, big ? "large" : pick(r, ["medium", "medium", "small", "tiny"] as const), hex, { name: `Goblin ${i}`, kind: "npc", attached: { to: by, kind: "drag" } });
  }
  // A prisoner the first rider leads, which walks beside the rider's seat as the seats part on the squeezed mount (route.ts seatShift).
  if (riders > 0 && around.length > 0 && chance(r, 0.5)) state.tokens.led = onHex(g, "led", "medium", around.splice(int(r, 0, around.length - 1), 1)[0]!, { name: "Prisoner", kind: "npc", attached: { to: "rider0", kind: "drag" } });
  if (chance(r, 0.35)) state.traps.stop = trap("stop", { zone: { cells: [{ x: int(r, 4, 14), y: int(r, 4, 14), w: 2, h: 2 }] } });
  const holds = Object.values(state.tokens).every((t) => !t!.attached || linkHolds(g, state.meta.settings, t!.attached.kind, t!, state.tokens[t!.attached.to]!));
  return holds ? { state, mid: hexCenter(g, at(int(r, 11, 16), top + (wide - 1) * int(r, 0, 1))) } : null;
}

for (const [name, g] of [
  ["hex rows", gridOfShape("hexRows") as HexGrid],
  ["hex columns", gridOfShape("hexColumns") as HexGrid],
] as const) {
  describe(`${name}: random drags into a corridor with creatures in tow (D-261107-172, D-261107-173)`, () => {
    test("what the board sends the server takes, lands alike on the player's copy, and a walk that ends squeezed keeps every link", () => {
      let squeezed = 0;
      let lined = 0;
      let named = 0;
      let seated = 0;
      for (let seed = 1; seed <= 500; seed++) {
        const made = hexRoomOf(seed, g);
        if (!made) continue;
        const { state, mid } = made;
        const mount = state.tokens.mount!;
        const { w, h } = footprintSize(mount);
        const copy = copyFor(state, P1);
        const drag = dragOf(copy, "player", "mount", { x: mid.x - w / 2, y: mid.y - h / 2 });
        if (drag.plan.stop?.follower !== undefined) named++;
        if (!drag.op) continue;
        const op = drag.op as Op;
        const at = `${name} seed ${seed}: ${JSON.stringify(op)}`;
        const allowed = canApply(op, P1, state, { canUseAsset: () => true });
        assert.ok(allowed.ok, `${at}: ${allowed.ok ? "" : allowed.message}`);
        const server = applyOp(state, op, P1, env(10));
        const device = applyOp(copy, op, P1, env(10));
        if (!server.ok || !device.ok) assert.fail(at);
        const sprung = Object.values(server.state.traps).some((t) => t!.state !== state.traps[t!.id]!.state);
        if (!sprung) {
          for (const id of Object.keys(copy.tokens)) {
            const a: Token = server.state.tokens[id]!;
            const b: Token = device.state.tokens[id]!;
            assert.deepEqual([b.x, b.y, b.elevation, b.attached?.to], [a.x, a.y, a.elevation, a.attached?.to], `${at}: ${id} on the player's copy`);
          }
          const landed = server.state.tokens.mount!;
          assert.deepEqual([drag.preview.to.x, drag.preview.to.y], [landed.x, landed.y], `${at}: the preview holds where it lands`);
        }
        if (op.t !== "token.move" || op.squeeze !== true) continue;
        squeezed++;
        if (Object.values(state.tokens).filter((t) => t!.attached?.kind === "drag").length >= 2) lined++;
        if (Object.values(state.tokens).filter((t) => t!.attached?.to === "mount" && t!.attached.kind === "ride").length >= 2) seated++;
        for (const t of Object.values(state.tokens)) if (t!.attached) assert.equal(server.state.tokens[t!.id]!.attached?.to, t!.attached.to, `${at}: ${t!.id} still held`);
      }
      // Enough of each kind that the rules above meet them: walks that end squeezed, with two or more in tow, drags held for one, and
      // squeezed mounts with two riders or more.
      assert.ok(squeezed >= 80, `walks that end squeezed: ${squeezed}`);
      assert.ok(lined >= 26, `with two or more in tow: ${lined}`);
      assert.ok(named >= 165, `held, naming the one that cannot follow: ${named}`);
      assert.ok(seated >= 6, `with two riders or more on a squeezed mount: ${seated}`);
    });
  });
}
