import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { heights, lift, wall } from "../discoveryTestutil.ts";
import { OP_VERSION, opMigrations, runMigrations, stopsByCoveredSquares } from "../migrate.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import { opSchema, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { occupiedRange } from "./footprint.ts";
import { SQUARES } from "./grid.ts";
import { pendingGround } from "./held.ts";
import { planTrapMove, trapWalks, type TrapRoom } from "./traps.ts";
import { sceneWalls } from "./walls.ts";
import { chance, DM, env, int, member, P1, P2, pick, rng, room, scene, token, trap } from "../testutil.ts";

/**
 * A stop between a walk's ends on the edge of ground every player sees
 * (TRAP-EDGE-RULE, live play LP29-B-TRAP-1, D-261107-177 and 255, migrate.ts
 * stopsByCoveredSquares). From op version 52 a creature whose core is a
 * point, one square or less, is judged by op 35's stand test where its
 * line from its piece's start to the spot and the squares its footprint
 * covers at the spot and at the piece's start lie on that ground, so a
 * Falling Net on the last revealed column catches a Medium walker that
 * walks along it at a slant. Before, a footprint that only touched the
 * dark column beside it put the spot off that ground. Box cores keep op
 * 37's reach. Two rooms that differ only in walls and heights off that
 * ground stop alike.
 */

const deps = { canUseAsset: () => true };
const versioned = (opVersion: number | undefined) => ({ ...env(5), ...(opVersion !== undefined ? { opVersion } : {}) });
const snare = () => ({ on: ["enter" as const], who: "any" as const, floor: false, resets: "never" as const, stops: true, foundOnSpring: true, hits: "trigger" as const, actions: [], find: [], notice: false });

/** Every player's copy of the scene, as one string. */
const copies = (s: RoomState) => [P1, P2].map((v) => stableStringify(projectState(s, v, { sceneId: "s1" }))).join("\n");

function squares(bounds: { w: number; h: number }, vision = false): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") }, scenes: { s1: scene("s1", { bounds, blockMovement: true, autoWalls: "off", fogEnabled: true, ...(vision ? { vision: { on: true, light: "dark" as const } } : {}) }) } });
  s.buildChunks = {};
  return s;
}

/** Where the op leaves `id` at `opVersion`, the trap's state with it, the op through the mover's own check first. */
function landing(s: RoomState, op: Op, opVersion: number | undefined, id = "brom", who: Viewer = P1): [number, number, string] {
  if (who.role === "player") assert.ok(canApply(op, who, s, deps).ok, "the mover's own check takes the walk");
  const r = applyOp(structuredClone(s), op, who, versioned(opVersion));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return [r.state.tokens[id]!.x, r.state.tokens[id]!.y, r.state.traps.net!.state];
}

/** LP29-B's room: 16 by 8, columns 0 to 7 revealed by hand, a Falling Net on 7,2 and 7,3, the last revealed column. */
function revealedEdge(walker: Partial<Token>): RoomState {
  const s = squares({ w: 16, h: 8 });
  lift(s, "dm", { x: 0, y: 0, w: 8, h: 8 });
  s.tokens.brom = token("brom", { name: "Brom", kind: "pc", ownerIds: ["p1"], disposition: "ally", ...walker });
  s.traps = { net: trap("net", { zone: { cells: [{ x: 7, y: 2, w: 1, h: 2 }] }, rig: snare() }) };
  return s;
}

describe("op version 52: a point core's stop reads the squares it covers", () => {
  test("the op step is the identity, and ops stored at the current version take the new rule", () => {
    assert.ok(OP_VERSION >= 52);
    const ops: unknown[] = [{ t: "token.move", tokenId: "brom", x: 13, y: 5 }, { t: "log.chat", text: "hi" }];
    for (const op of ops) assert.equal(runMigrations(op, 51, 52, opMigrations), op);
    assert.deepEqual([stopsByCoveredSquares(1), stopsByCoveredSquares(51), stopsByCoveredSquares(52), stopsByCoveredSquares(OP_VERSION), stopsByCoveredSquares(undefined)], [false, false, true, true, true]);
  });

  test("LP29-B: Brom walking from 5,2 to 13,5 stops on the net at 7,3, where at op 51 he walked on into the dark", () => {
    const s = revealedEdge({ x: 5, y: 2 });
    const op: Op = { t: "token.move", tokenId: "brom", x: 13, y: 5 };
    assert.deepEqual(landing(s, op, 51), [13, 5, "sprung"]);
    assert.deepEqual(landing(s, op, undefined), [7, 3, "sprung"]);
    const cut = planTrapMove(op, s as TrapRoom, P1, {}).op;
    assert.ok(canApply(cut, P1, s, deps).ok, "the cut is one Pat's own check takes");
  });

  test("its torch twin: in the dark with a 10 ft torch, Brom stops on the lit net at 7,5, where at op 51 he stopped at 8,5", () => {
    const s = squares({ w: 20, h: 12 }, true);
    s.tokens.brom = token("brom", { x: 6, y: 4, name: "Brom", kind: "pc", ownerIds: ["p1"], disposition: "ally", light: { bright: 10, dim: 0 } });
    s.traps = { net: trap("net", { zone: { cells: [{ x: 7, y: 4, w: 1, h: 2 }] }, rig: snare() }) };
    const op: Op = { t: "token.move", tokenId: "brom", x: 14, y: 8 };
    assert.deepEqual(landing(s, op, 51), [8, 5, "sprung"]);
    assert.deepEqual(landing(s, op, undefined), [7, 5, "sprung"]);
  });

  test("a Large walker there keeps op 37's reach and walks on at both versions", () => {
    const s = revealedEdge({ size: "large", x: 4, y: 2 });
    const op: Op = { t: "token.move", tokenId: "brom", x: 12, y: 5 };
    assert.deepEqual(landing(s, op, 51), [12, 5, "sprung"]);
    assert.deepEqual(landing(s, op, undefined), [12, 5, "sprung"]);
  });

  test("a dark square on a Medium walker's line between seen ones keeps its spots past it off that ground, a wall inside it or not", () => {
    // Every square seen but 6,2, which Brom's line from 5,2 crosses on its way to 7,3: the squares he covers there are seen, his line is not.
    const twin = (walled: boolean) => {
      const s = revealedEdge({ x: 5, y: 2 });
      lift(s, "dm", { x: 0, y: 0, w: 16, h: 8 });
      lift(s, "dm", { x: 6, y: 2, w: 1, h: 1 }, "s1", false);
      s.traps = { net: trap("net", { zone: { cells: [{ x: 7, y: 3, w: 1, h: 1 }] }, rig: snare() }) };
      if (walled) wall(s, "rc50ed000001", [6.25, 2.5], [6.25, 2.9375]);
      return s;
    };
    const [open, walled] = [twin(false), twin(true)];
    assert.equal(sceneWalls(walled.scenes.s1!, walled.buildChunks).stored.xy.length, 4, "the wall is stored");
    assert.equal(copies(walled), copies(open), "the players' copies start the same");
    // The DM's walk, which the wall stops no more than any.
    const op: Op = { t: "token.move", tokenId: "brom", x: 13, y: 5 };
    assert.deepEqual(landing(open, op, undefined, "brom", DM), [13, 5, "sprung"]);
    assert.deepEqual(landing(walled, op, undefined, "brom", DM), [13, 5, "sprung"]);
  });

  test("a custom 0.75 square walker whose spot covers a dark square beside its line stands only where its line proves", () => {
    // From 2,2 toward 12.5,5.5 it sets the net on 5,3 off at 4.5,3, off its line, where it covers 4,3 and the dark 5,3. Its line and
    // the square under its middle are seen, the square beside them not, so it stops at 5,3, a spot on its line.
    const s = squares({ w: 20, h: 12 });
    lift(s, "dm", { x: 0, y: 0, w: 20, h: 12 });
    lift(s, "dm", { x: 5, y: 3, w: 1, h: 1 }, "s1", false);
    s.tokens.w = token("w", { size: "custom", w: 0.75, h: 0.75, x: 2, y: 2, name: "W", kind: "pc", ownerIds: ["p1"], disposition: "ally" });
    s.traps = { net: trap("net", { zone: { cells: [{ x: 5, y: 3, w: 1, h: 1 }] }, rig: snare() }) };
    const op: Op = { t: "token.move", tokenId: "w", x: 12.5, y: 5.5 };
    assert.deepEqual(landing(s, op, undefined, "w"), [5, 3, "sprung"]);
  });

  test("a custom 0.75 square flier stops alike whatever the dark square under its piece's start holds", () => {
    // Its corner at 5.5, 5.5 covers 5,5 to 6,6, and 6,6 is dark: the line from there misses it, but the stand test reads the ground
    // under that footprint for its ledges (movement.ts ledgeFloor). The raised ground from x 9 on is seen. In the second room 6,6 is
    // raised too, so the flier at 5 ft is inside the ground there, where no ledge stops it.
    const twin = (raised: boolean) => {
      const s = squares({ w: 20, h: 12 });
      lift(s, "dm", { x: 0, y: 0, w: 20, h: 12 });
      lift(s, "dm", { x: 6, y: 6, w: 1, h: 1 }, "s1", false);
      heights(s, { x: 9, y: 0, w: 11, h: 12 }, 10);
      if (raised) heights(s, { x: 6, y: 6, w: 1, h: 1 }, 10);
      s.tokens.pix = token("pix", { size: "custom", w: 0.75, h: 0.75, x: 2, y: 5.5, elevation: 5, name: "Pix", kind: "pc", ownerIds: ["p1"], disposition: "ally" });
      s.traps = { net: trap("net", { zone: { cells: [{ x: 10, y: 2, w: 2, h: 3 }] }, rig: snare() }) };
      return s;
    };
    const [plain, raised] = [twin(false), twin(true)];
    assert.equal(copies(raised), copies(plain), "the players' copies start the same");
    const op: Op = { t: "token.move", tokenId: "pix", x: 13.5, y: 1.5, elevation: 5, route: [[5.5, 5.5, 0, 0], [13.5, 1.5, 0, 0]] };
    // At 52 the dark square puts every spot of the second piece off that ground, so it stops where its line proves: 9.5, 3.5.
    assert.deepEqual(landing(plain, op, undefined, "pix", DM), [9.5, 3.5, "sprung"]);
    assert.deepEqual(landing(raised, op, undefined, "pix", DM), [9.5, 3.5, "sprung"]);
    // At 51 the hidden height decided whether the ledge at x 9 stopped the stand test, so the rooms parted.
    assert.notDeepEqual(landing(raised, op, 51, "pix", DM), landing(plain, op, 51, "pix", DM));
  });
});

/**
 * Random rooms in pairs on squares, fog on: the ground revealed by hand up
 * to an edge, or lit by the walker's own torch on a dark vision scene. A
 * point core (Tiny, Small, Medium, or custom of one square or less) walks
 * at a slant along or across the edge past stopping snares on and beside
 * it. The second room adds short walls inside dark squares near the walk
 * and heights on dark squares no spot of it covers.
 */
type Pair = { open: RoomState; closed: RoomState; op: Op; who: Viewer; vision: boolean; changes: number };

function edgePair(r: () => number, n: number): Pair {
  const N = 16;
  const vision = chance(r, 0.4);
  // The edge runs along a column or a row, the seen side low or high: u across it, v along it.
  const across = chance(r, 0.5);
  const flip = chance(r, 0.5);
  const at = (u: number, v: number, side: number): { x: number; y: number } => {
    const uu = flip ? N - u - side : u;
    return across ? { x: uu, y: v } : { x: v, y: uu };
  };
  const s = squares({ w: N, h: N }, vision);
  const kind = pick(r, ["tiny", "small", "medium", "medium", "c0.5", "c0.75", "c1"] as const);
  const side = kind === "tiny" || kind === "c0.5" ? 0.5 : kind === "c0.75" ? 0.75 : 1;
  const step = side < 1 ? 0.5 : 1;
  const E = int(r, 5, 9);
  // Most start flush with the edge, their footprint touching the dark beside it.
  const u0 = E + 1 - side - (chance(r, 0.6) ? 0 : step * int(r, 1, 3));
  const v0 = int(r, 3, 12);
  const start = at(u0, v0, side);
  const size = kind.startsWith("c") ? { size: "custom" as const, w: side, h: side } : { size: kind as Token["size"] };
  s.tokens.w = token("w", { ...size, ...start, name: "W", kind: "pc", ownerIds: ["p1"], disposition: "ally", ...(vision ? { light: { bright: pick(r, [10, 15, 20]), dim: 0 } } : {}) });
  if (!vision) {
    const seen = at(0, 0, 0);
    const far = at(E + 1, N, 0);
    lift(s, "dm", { x: Math.min(seen.x, far.x), y: Math.min(seen.y, far.y), w: Math.abs(far.x - seen.x), h: Math.abs(far.y - seen.y) });
  }
  // One or two pieces, mostly at a slant along the edge, else out across it, every end on the walker's own grid.
  const pieces = chance(r, 0.6) ? 1 : 2;
  const route: [number, number, number, 0 | 1][] = [];
  let [u, v] = [u0, v0];
  for (let k = 0; k < pieces; k++) {
    u = Math.max(1, Math.min(N - 2, u + step * (chance(r, 0.7) ? int(r, -2, 1) : int(r, 1, 6))));
    v = Math.max(1, Math.min(N - 2, v + (chance(r, 0.5) ? 1 : -1) * int(r, 3, 9)));
    const p = at(u, v, side);
    route.push([p.x, p.y, 0, 0]);
  }
  const end = at(u, v, side);
  const op: Op = pieces === 1 && chance(r, 0.5) ? { t: "token.move", tokenId: "w", x: end.x, y: end.y } : { t: "token.move", tokenId: "w", x: end.x, y: end.y, route };
  let walk: { x: number; y: number }[] = [];
  try {
    walk = trapWalks(opSchema.parse(op), s as TrapRoom, DM, {})[0]?.spots ?? [];
  } catch {
    walk = [];
  }
  // Snares under a square some spot of the walk covers, or on the edge's columns near it.
  for (let i = int(r, 1, 3); i > 0; i--) {
    const sp = walk.length > 2 && chance(r, 0.6) ? walk[int(r, 1, walk.length - 2)] : undefined;
    const range = sp ? occupiedRange(SQUARES, { ...s.tokens.w!, x: sp.x, y: sp.y }) : null;
    const c = range ? { x: int(r, range.x0, range.x1 - 1), y: int(r, range.y0, range.y1 - 1) } : at(E + int(r, -1, 1), Math.max(0, Math.min(N - 1, v0 + int(r, -6, 6))), 1);
    s.traps = { ...s.traps, [`net${i}`]: trap(`net${i}`, { zone: { cells: [{ ...c, w: 1, h: 1 }] }, rig: snare() }) };
  }
  // The squares no spot's footprint covers, which a height may take without lifting the walker anywhere it stands.
  const covered = new Set<string>();
  for (const sp of walk) {
    const range = occupiedRange(SQUARES, { ...s.tokens.w!, x: sp.x, y: sp.y });
    for (let y = range.y0; y < range.y1; y++) for (let x = range.x0; x < range.x1; x++) covered.add(`${x},${y}`);
  }
  const ground = pendingGround(s, "s1", null)!;
  const dark: [number, number][] = [];
  for (const sp of walk) {
    for (let d = 0; d < 3; d++) {
      const x = Math.floor(sp.x) + int(r, -1, 2);
      const y = Math.floor(sp.y) + int(r, -1, 2);
      if (x >= 0 && y >= 0 && x < N && y < N && !ground.live(x, y)) dark.push([x, y]);
    }
  }
  const closed = structuredClone(s);
  let changes = 0;
  for (let i = int(r, 1, 6); i > 0 && dark.length > 0; i--) {
    const [cx, cy] = pick(r, dark);
    if (chance(r, 0.6)) {
      const pt = (): [number, number] => [cx + int(r, 1, 15) / 16, cy + int(r, 1, 15) / 16];
      const a = pt();
      const b = chance(r, 0.4) ? ([cx + 1 - (a[0] - cx), cy + 1 - (a[1] - cy)] as [number, number]) : pt();
      if (a[0] === b[0] && a[1] === b[1]) continue;
      wall(closed, `rc50e${String(n).padStart(5, "0")}${changes++}`, a, b);
    } else if (!covered.has(`${cx},${cy}`)) {
      heights(closed, { x: cx, y: cy, w: 1, h: 1 }, pick(r, [-10, -5, 5, 10]));
      changes++;
    }
  }
  return { open: s, closed, op, who: chance(r, 0.5) ? P1 : DM, vision, changes };
}

describe("random rooms in pairs along the edge of seen ground: the same stop in both, every cut one Pat's own check takes", () => {
  test("squares, revealed by hand and lit by a torch", () => {
    let [taken, moved, checked, stops] = [0, 0, 0, 0];
    const apart: string[] = [];
    const illegal: string[] = [];
    for (let n = 0; n < 800; n++) {
      const { open, closed, op, who, vision, changes } = edgePair(rng(0x52e + n), n);
      const parsed = opSchema.safeParse(op);
      if (!parsed.success || changes === 0) continue;
      assert.equal(copies(closed), copies(open), `seed ${n}: the players' copies start the same`);
      // Pat's walk reaches the trap step only as his check takes it. A DM's is taken as sent, its cuts checked only where Pat's check takes the walk.
      const legal = [canApply(parsed.data, P1, open, deps).ok, canApply(parsed.data, P1, closed, deps).ok];
      if (who.role === "player" && !(legal[0] && legal[1])) continue;
      taken++;
      const [a, b] = [open, closed].map((s) => {
        const r = applyOp(structuredClone(s), parsed.data, who, versioned(undefined));
        assert.ok(r.ok, `seed ${n}: ${r.ok ? "" : r.message}`);
        return r;
      });
      const plans = [open, closed].map((s) => planTrapMove(parsed.data, s as TrapRoom, who, {}));
      const decided = (i: number) => stableStringify({ op: plans[i]!.op, springings: plans[i]!.springings.map((x) => [x.trap.id, x.how, x.pass, x.by, x.hits]) });
      // A torch that moves with the walker may light a wall of the second room once it stops, so there the stop is compared, and by hand the whole copy.
      const same = decided(0) === decided(1) && stableStringify([a!.log, a!.trapped]) === stableStringify([b!.log, b!.trapped]) && (vision || copies(a!.state) === copies(b!.state));
      if (!same) apart.push(`seed ${n}`);
      if (plans[0]!.op !== parsed.data) stops++;
      if (stableStringify(plans[0]!.op) !== stableStringify(planTrapMove(parsed.data, open as TrapRoom, who, { opVersion: 51 }).op)) moved++;
      for (const [i, s] of [open, closed].entries()) {
        if (plans[i]!.op === parsed.data || !legal[i]) continue;
        checked++;
        if (!canApply(plans[i]!.op, P1, s, deps).ok) illegal.push(`seed ${n} ${JSON.stringify(plans[i]!.op)}`);
      }
    }
    assert.deepEqual(apart, [], `of ${taken}`);
    assert.deepEqual(illegal, []);
    assert.ok(taken >= 550, `${taken} pairs taken`);
    assert.ok(stops >= 380, `${stops} stops`);
    assert.ok(moved >= 60, `${moved} stops op 51 made elsewhere`);
    assert.ok(checked >= 700, `${checked} cuts checked`);
  });
});
