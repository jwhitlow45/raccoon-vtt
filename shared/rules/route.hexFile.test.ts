import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CreatureSize, RoomState, Token } from "../model.ts";
import { canApply } from "../permissions.ts";
import type { OpOf } from "../protocol.ts";
import { followsHexByHex, HEX_FILE_OP_VERSION, OP_VERSION, opMigrations, runMigrations } from "../migrate.ts";
import { applyOp } from "../reducer.ts";
import { movementRules } from "../ruleHooks.ts";
import { DM, entry, env, P1, template, token, trap } from "../testutil.ts";
import { linkHolds } from "./attach.ts";
import { footprintSize, occupiedHexes, placedOnHex } from "./footprint.ts";
import { hexCenter, hexDistance, hexKey, hexLine, hexNeighbors, type Hex, type HexGrid } from "./hex.ts";
import { findRouteOn } from "./hexWalk.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, sideWall, wallsRound } from "./hexWalls.testkit.ts";
import { checkSetReach, planMove, planWalks } from "./moveLeg.ts";
import { hexStandAt, hexStandHexes, hexStandPlace, ownWalk } from "./movement.ts";
import { compareAlong, hexFileClasses, hexFileRoutes, pieceReach, routeWalkers, seatShift } from "./route.ts";
import { planTrapMove, trapWalks } from "./traps.ts";
import { groupWalkWorld } from "./walkWorld.ts";

/**
 * Single file on hexes (RIDE-SINGLE-FILE-HEX, D-261107-172, D-261107-252,
 * D-261107-254, migrate.ts followsInSingleFileOnHexes): a squeezing holder's
 * own move takes the creatures of one hex it drags behind it, each from its
 * own hex to the holder's file hex at each corner, ending on the latest hex
 * of its walk clear of the holder and those ahead, one point per point of
 * the holder's walk. Each class decides for itself, and reach reads the
 * holder's full footprint as the link pass does.
 */

const GRIDS = [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const;

/**
 * Open ground round `S` and a corridor one hex wide from four steps away in
 * direction `d`, rock beyond: the holder walks into it along the lattice.
 */
function corridorRoom(g: HexGrid, d: number): { s: RoomState; step: (h: Hex, k: number) => Hex; S: Hex } {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const S: Hex = { col: 12, row: 12 };
  const step = (h: Hex, k: number) => {
    let at = h;
    for (let i = 0; i < k; i++) at = hexNeighbors(g, at)[d]!;
    return at;
  };
  const corridor = new Set(Array.from({ length: 8 }, (_, k) => hexKey(step(S, 4 + k))));
  const solid = (h: Hex) => hexDistance(g, h, S) > 3 && !corridor.has(hexKey(h));
  const bounds = { w: 26, h: 26 };
  return { s: hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, solid)), step, S };
}

/** The holder's own way to `ref`, squeezed there, as the device's search finds it alone. */
function intoCorridor(g: HexGrid, s: RoomState, ref: Hex): OpOf<"token.move"> {
  const horse = s.tokens.horse!;
  const inside = hexStandPlace(g, horse, { size: hexStandAt(g, horse, horse, true).size, ref, squeezed: true });
  const found = findRouteOn({ ...groupWalkWorld(s, ownWalk(horse), { role: "player" }).input, towed: [] }, inside);
  assert.ok(found && found !== "none", "a way in for the holder alone");
  return { t: "token.move", tokenId: "horse", ...inside, squeeze: true, route: found.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]) };
}

/** The hexes round a holder's footprint that lie off the rock, farthest from `goal` first: where a creature it drags stands behind it. */
function behind(g: HexGrid, s: RoomState, holder: Token, goal: Hex, open: (h: Hex) => boolean): Hex[] {
  const own = new Set(occupiedHexes(g, holder).map(hexKey));
  const around = new Map<string, Hex>();
  for (const h of occupiedHexes(g, holder)) for (const n of hexNeighbors(g, h)) if (!own.has(hexKey(n)) && open(n)) around.set(hexKey(n), n);
  return [...around.values()].sort((a, b) => hexDistance(g, b, goal) - hexDistance(g, a, goal) || a.row - b.row || a.col - b.col);
}

function refOf(g: HexGrid, t: Pick<Token, "size" | "x" | "y">): string {
  return hexKey(occupiedHexes(g, { size: t.size, x: t.x, y: t.y })[0]!);
}

/** The hex a creature of one hex stands on at `p`. */
function hexOf(g: HexGrid, p: { x: number; y: number }): Hex {
  return occupiedHexes(g, { size: "medium", x: p.x, y: p.y })[0]!;
}

for (const [name, g] of GRIDS) {
  describe(`${name}: single file into a corridor one hex wide`, () => {
    test("a Large warhorse drags a Medium goblin in on Pat's move: the goblin ends on the hex right behind it, every leg clear, its link held", () => {
      const { s, step, S } = corridorRoom(g, 0);
      s.tokens.horse = onHex(g, "horse", "large", S, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      const open = (h: Hex) => hexDistance(g, h, S) <= 3;
      const spot = behind(g, s, s.tokens.horse, step(S, 8), open)[0]!;
      s.tokens.gob = onHex(g, "gob", "medium", spot, { name: "Goblin", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
      const op = intoCorridor(g, s, step(S, 8));
      assert.ok(canApply(op, P1, s, { canUseAsset: () => true }).ok);
      const gob = planWalks(op, s, P1, {}).find((m) => m.tokenId === "gob")!;
      assert.equal(gob.file, true, "in single file");
      assert.ok(gob.route.length >= op.route!.length + 1, "at least one point per point of the horse's walk");
      // From op version 62 one point a hex, from its own hex onto the hex the warhorse starts on (migrate.ts followsHexByHex).
      for (let i = 1; i < gob.route.length; i++) assert.ok(hexDistance(g, hexOf(g, gob.route[i - 1]!), hexOf(g, gob.route[i]!)) <= 1, `leg ${i} one hex step`);
      const from = hexKey(occupiedHexes(g, s.tokens.horse)[0]!);
      assert.ok(gob.route.some((p) => hexKey(hexOf(g, p)) === from), "by the hex the warhorse starts on");
      assert.equal(refOf(g, { size: "medium", ...gob.to }), hexKey(step(S, 7)), "right behind the squeezed warhorse");
      for (let i = 1; i < gob.route.length; i++) assert.equal(movementRules.legBlocker(s, gob.trace[i - 1]!, { ...gob.route[i]!, squeeze: false }), null, `leg ${i}`);
      const r = applyOp(s, op, P1, env(1));
      assert.ok(r.ok);
      assert.equal(r.state.tokens.gob!.attached?.to, "horse", "still in tow");
      assert.equal(refOf(g, r.state.tokens.gob!), hexKey(step(S, 7)));
    });

    test("an op stored at version 50 takes the goblin by its place, and replays so", () => {
      const { s, step, S } = corridorRoom(g, 0);
      s.tokens.horse = onHex(g, "horse", "large", S, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      const spot = behind(g, s, s.tokens.horse, step(S, 8), (h) => hexDistance(g, h, S) <= 3)[0]!;
      s.tokens.gob = onHex(g, "gob", "medium", spot, { name: "Goblin", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
      const op = intoCorridor(g, s, step(S, 8));
      const horse = s.tokens.horse;
      const gob = s.tokens.gob;
      const old = planMove(op, s, DM, { opVersion: 50 }).find((m) => m.tokenId === "gob")!;
      assert.equal(old.file, undefined, "by its place");
      const route = planMove(op, s, DM, { opVersion: 50 }).find((m) => m.tokenId === "horse")!.route;
      assert.deepEqual(old.route.map((p) => [p.x, p.y]), route.map((p) => [p.x + gob.x - horse.x, p.y + gob.y - horse.y]), "the horse's walk offset by its place");
      assert.notDeepEqual(planMove(op, s, DM, { opVersion: 51 }).find((m) => m.tokenId === "gob")!.route, old.route, "op 51 walks it in single file");
    });

    test("two goblins dragged by the warhorse: the second stays only where the warhorse's full footprint keeps it in reach, else Pat's move is held and the DM's lets it go", () => {
      const outcomes: string[] = [];
      for (const d of [0, 3]) {
        const { s, step, S } = corridorRoom(g, d);
        s.tokens.horse = onHex(g, "horse", "large", S, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
        const spots = behind(g, s, s.tokens.horse, step(S, 8), (h) => hexDistance(g, h, S) <= 3);
        s.tokens.gob = onHex(g, "gob", "medium", spots[0]!, { name: "Goblin", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
        s.tokens.gob2 = onHex(g, "gob2", "medium", spots[1]!, { name: "Grik", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
        const op = intoCorridor(g, s, step(S, 8));
        const walks = planWalks(op, s, P1, {});
        const end = (id: string) => ({ ...s.tokens[id]!, ...walks.find((m) => m.tokenId === id)!.to });
        const horse = { ...end("horse"), squeeze: true as const };
        // The link pass reads the full footprints, the squeeze stripped (attach.ts attachDistanceFt).
        const kept = ["gob", "gob2"].map((id) => linkHolds(g, s.meta.settings, "drag", end(id), horse));
        const allowed = canApply(op, P1, s, { canUseAsset: () => true });
        if (kept.every(Boolean)) {
          assert.ok(allowed.ok, `${d}: ${allowed.ok ? "" : allowed.message}`);
          outcomes.push("kept");
        } else {
          const far = s.tokens[kept[0] ? "gob2" : "gob"]!.name;
          assert.equal(allowed.ok ? "" : allowed.message, `${far} can't follow through there.`, `${d}`);
          outcomes.push("held");
        }
        const r = applyOp(s, op, DM, env(1));
        assert.ok(r.ok);
        assert.deepEqual(["gob", "gob2"].map((id) => r.state.tokens[id]!.attached?.to === "horse"), kept, `${d}: the DM's move keeps the links the link pass keeps`);
      }
      // Both corridor directions meet both answers, as the footprint lies along one and across the other.
      assert.deepEqual(outcomes, ["kept", "held"]);
    });

    test("a hidden Large ogre added beside the goblin changes none of the goblin's walk, and walks by its place, stopped off the rock as a hidden creature in tow is", () => {
      const { s, step, S } = corridorRoom(g, 0);
      s.tokens.horse = onHex(g, "horse", "large", S, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      const spots = behind(g, s, s.tokens.horse, step(S, 8), (h) => hexDistance(g, h, S) <= 3);
      s.tokens.gob = onHex(g, "gob", "medium", spots[0]!, { name: "Goblin", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
      const op = intoCorridor(g, s, step(S, 8));
      const alone = planWalks(op, s, P1, {}).find((m) => m.tokenId === "gob")!;
      const twin = structuredClone(s);
      const big = token("ogre", { size: "large", sceneId: "s1", x: 0, y: 0 });
      const at = [...spots].reverse().find((h) => occupiedHexes(g, { ...big, ...placedOnHex(g, big, h) }).every((x) => hexDistance(g, x, S) <= 3 && !occupiedHexes(g, s.tokens.horse!).some((y) => hexKey(y) === hexKey(x))))!;
      twin.tokens.ogre = onHex(g, "ogre", "large", at, { name: "Ogre", kind: "npc", visibility: "dm", attached: { to: "horse", kind: "drag" } });
      assert.ok(linkHolds(g, s.meta.settings, "drag", twin.tokens.ogre, twin.tokens.horse!), "in reach where it starts");
      assert.ok(canApply(op, P1, twin, { canUseAsset: () => true }).ok, "the hidden ogre refuses nothing");
      const walks = planWalks(op, twin, P1, {});
      assert.deepEqual(walks.find((m) => m.tokenId === "gob")!.route, alone.route, "the goblin's walk");
      const ogre = walks.find((m) => m.tokenId === "ogre")!;
      assert.equal(ogre.file, undefined, "the ogre by its place");
      const r = applyOp(twin, op, P1, env(1));
      assert.ok(r.ok);
      assert.ok(occupiedHexes(g, r.state.tokens.ogre!).every((h) => hexDistance(g, h, S) <= 3 || hexLine(g, step(S, 4), step(S, 11)).some((c) => hexKey(c) === hexKey(h))), "the ogre stands off the rock");
    });
  });
}

describe("hex single file's walks (hexFileRoutes)", () => {
  test("a walk whose last piece is one hex ends its file on the corner before, and keeps one point per point of the holder's walk", () => {
    for (const [name, g] of GRIDS) {
      const horse = onHex(g, "horse", "large", { col: 4, row: 8 });
      const corner = hexStandPlace(g, horse, { size: "large", ref: { col: 10, row: 8 }, squeezed: false });
      const endRef = hexNeighbors(g, { col: 10, row: 8 })[0]!;
      const end = hexStandPlace(g, horse, { size: "medium", ref: endRef, squeezed: true });
      const points = [{ x: horse.x, y: horse.y }, corner, end];
      const a = onHex(g, "a", "medium", { col: 2, row: 8 });
      const b = onHex(g, "b", "medium", { col: 1, row: 8 });
      const file = hexFileRoutes(g, horse, points, [[a, b]]);
      for (const id of ["a", "b"]) assert.equal(file.get(id)!.length, points.length, `${name}: ${id} one point per point`);
      const wa = file.get("a")!;
      const wb = file.get("b")!;
      // The holder's last stand is the one squeezed hex, so the first goblin ends on the corner's file hex, which repeats to the end.
      assert.equal(refOf(g, { size: "medium", ...wa[2]! }), hexKey({ col: 10, row: 8 }), `${name}: a ends on the corner's hex`);
      assert.deepEqual(wa[1], wa[2], `${name}: a holds there`);
      // The second ends a hex back along the piece before, held there for the corners after.
      const back = hexLine(g, { col: 10, row: 8 }, { col: 4, row: 8 })[1]!;
      assert.equal(refOf(g, { size: "medium", ...wb[1]! }), hexKey(back), `${name}: b a hex before the corner`);
      assert.deepEqual(wb[1], wb[2], `${name}: b holds there`);
      const all = new Set([...hexStandHexes(g, hexStandAt(g, horse, end, true)).map(hexKey), refOf(g, { size: "medium", ...wa[2]! }), refOf(g, { size: "medium", ...wb[2]! })]);
      assert.equal(all.size, 3, `${name}: no two share a hex`);
    }
  });

  test("the holder's file hex is its stand's hex nearest the stand's middle, ties by the stand's order, for every size, full and squeezed", () => {
    for (const [name, g] of GRIDS) {
      for (const size of ["medium", "large", "huge", "gargantuan"] as CreatureSize[]) {
        for (const squeezed of [false, true]) {
          for (let col = 5; col < 9; col++) {
            for (let row = 5; row < 9; row++) {
              const holder = token("h", { size, x: 0, y: 0 });
              const stand = hexStandAt(g, holder, hexStandPlace(g, holder, { size: hexStandAt(g, holder, holder, squeezed).size, ref: { col, row }, squeezed }), squeezed);
              const hexes = hexStandHexes(g, stand);
              const place = hexStandPlace(g, holder, stand);
              const { w, h } = footprintSize(holder);
              const mid = { x: place.x + w / 2, y: place.y + h / 2 };
              const d = hexes.map((x) => Math.hypot(hexCenter(g, x).x - mid.x, hexCenter(g, x).y - mid.y));
              const least = Math.min(...d);
              // Anchors round to a sixty-fourth of a cell, so hexes alike round the middle tie within that.
              const nearest = hexes.find((_, k) => d[k]! <= least + 1 / 32)!;
              assert.equal(hexKey(stand.ref), hexKey(nearest), `${name} ${size} ${squeezed ? "squeezed" : "full"} at ${col},${row}`);
            }
          }
        }
      }
    }
  });

  test("each class decides for itself: every one every player sees must be of one hex, and a hidden larger one walks by its place", () => {
    const t = (id: string, size: CreatureSize) => token(id, { size });
    const [m1, m2, s1, l1, l2] = [t("m1", "medium"), t("m2", "medium"), t("s1", "small"), t("l1", "large"), t("l2", "large")];
    assert.deepEqual(hexFileClasses([m1, m2], [l1, s1]), [[m1, m2], [s1]], "the shown go, the hidden goblin behind them, the hidden ogre by its place");
    assert.deepEqual(hexFileClasses([m1, l1], [s1]), [[], [s1]], "a shown ogre keeps the shown by their places, and the hidden decide by their own");
    assert.deepEqual(hexFileClasses([], [s1, l2]), [[], []], "with none shown, a hidden ogre keeps the hidden by their places");
    assert.deepEqual(hexFileClasses([], [s1, m2]), [[], [s1, m2]], "with none shown, hidden goblins go");
  });
});

describe("hex seats apart along a walk (SEAT-TIE-HEX, D-261107-173)", () => {
  test("three riders on a Huge mount that squeezes partway take a hex each there from op 51, and two shared one at op 50", () => {
    for (const [name, g] of GRIDS) {
      const s = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", 30, 30, []);
      s.tokens.mount = onHex(g, "mount", "huge", { col: 8, row: 8 }, { kind: "npc" });
      const own = occupiedHexes(g, s.tokens.mount);
      for (const i of [0, 1, 2]) s.tokens[`r${i}`] = onHex(g, `r${i}`, "medium", own[i]!, { attached: { to: "mount", kind: "ride" } });
      // Squeezed onto three hexes halfway, full size where the walk ends.
      const mid = hexStandPlace(g, s.tokens.mount, { size: "large", ref: { col: 13, row: 8 }, squeezed: true });
      const end = hexStandPlace(g, s.tokens.mount, { size: "huge", ref: { col: 18, row: 8 }, squeezed: false });
      const op: OpOf<"token.move"> = { t: "token.move", tokenId: "mount", ...end, route: [[mid.x, mid.y, 1, 0], [end.x, end.y, 0, 0]] };
      const at = (opVersion?: number) =>
        planMove(op, s, DM, opVersion === undefined ? {} : { opVersion })
          .filter((m) => m.tokenId.startsWith("r"))
          .map((m) => refOf(g, { size: "medium", ...m.route[1]! }));
      assert.equal(new Set(at()).size, 3, `${name}: a hex each`);
      assert.equal(new Set(at(50)).size, 2, `${name}: two on one hex at op 50`);
      const r = applyOp(s, op, DM, env(1));
      assert.ok(r.ok);
      for (const i of [0, 1, 2]) assert.equal(r.state.tokens[`r${i}`]!.attached?.to, "mount", `${name}: r${i} still riding`);
    }
  });

  test("a prisoner a rider leads walks beside the rider's seat apart, on the device's walk as in the move (route.ts seatShift)", () => {
    for (const [name, g] of GRIDS) {
      const s = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", 30, 30, []);
      s.tokens.mount = onHex(g, "mount", "huge", { col: 8, row: 8 }, { kind: "npc" });
      const own = occupiedHexes(g, s.tokens.mount);
      for (const i of [0, 1, 2]) s.tokens[`r${i}`] = onHex(g, `r${i}`, "medium", own[i]!, { attached: { to: "mount", kind: "ride" } });
      // The second rider is the one the seats part from the first's hex (the case above).
      s.tokens.led = onHex(g, "led", "medium", hexNeighbors(g, own[1]!).find((h) => !own.some((o) => hexKey(o) === hexKey(h)))!, { attached: { to: "r1", kind: "drag" } });
      const mount = s.tokens.mount;
      const mid = hexStandPlace(g, mount, { size: "large", ref: { col: 13, row: 8 }, squeezed: true });
      const end = hexStandPlace(g, mount, { size: "huge", ref: { col: 18, row: 8 }, squeezed: false });
      const op: OpOf<"token.move"> = { t: "token.move", tokenId: "mount", ...end, route: [[mid.x, mid.y, 1, 0], [end.x, end.y, 0, 0]] };
      const led = planMove(op, s, DM, {}).find((m) => m.tokenId === "led")!;
      const riders = [0, 1, 2].map((i) => s.tokens[`r${i}`]!);
      const by = seatShift(g, mount, (id) => s.tokens[id], "led", mid, true, riders);
      const near = (v: number) => Math.round(v * 1e9) / 1e9;
      assert.deepEqual([led.route[1]!.x, led.route[1]!.y].map(near), [s.tokens.led.x + mid.x - mount.x + by.x, s.tokens.led.y + mid.y - mount.y + by.y].map(near), `${name}: where the move takes it`);
      const alone = seatShift(g, mount, (id) => s.tokens[id], "led", mid, true);
      assert.notDeepEqual(alone, by, `${name}: its rider's seat apart is not the nearest alone`);
    }
  });
});

describe("a trap's stop of single file on hexes (traps.ts fileApart)", () => {
  test("a net in the corridor stops the warhorse, and the goblins behind it step back along their own walks onto hexes none of the others stands on", () => {
    for (const [name, g] of GRIDS) {
      // Along the lattice, and along a slant where the boxes of neighboring hexes overlap though no hex is shared.
      for (const d of [0, 4]) {
        const { s, step, S } = corridorRoom(g, d);
        s.tokens.horse = onHex(g, "horse", "large", S, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
        const spots = behind(g, s, s.tokens.horse, step(S, 8), (h) => hexDistance(g, h, S) <= 3);
        s.tokens.gob = onHex(g, "gob", "medium", spots[0]!, { name: "Goblin", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
        s.tokens.gob2 = onHex(g, "gob2", "medium", spots[1]!, { name: "Grik", kind: "npc", ownerIds: ["p1"], attached: { to: "gob", kind: "drag" } });
        const net = step(S, 6);
        s.traps.net = trap("net", { grid: g.orient === "rows" ? "hexRows" : "hexColumns", zone: { cells: [{ x: net.col, y: net.row, w: 1, h: 1 }] } });
        const op = intoCorridor(g, s, step(S, 9));
        assert.ok(canApply(op, P1, s, { canUseAsset: () => true }).ok, `${name} ${d}`);
        const r = applyOp(s, op, P1, env(1));
        assert.ok(r.ok);
        const after = r.state.tokens;
        assert.deepEqual([after.horse!.squeeze, occupiedHexes(g, after.horse!).map(hexKey)], [true, [hexKey(net)]], `${name} ${d}: the warhorse stopped squeezed on the net`);
        const hexes = ["horse", "gob", "gob2"].flatMap((id) => occupiedHexes(g, after[id]!).map(hexKey));
        assert.equal(new Set(hexes).size, hexes.length, `${name} ${d}: ${hexes.join(" ")} share no hex`);
        assert.deepEqual([after.gob!.attached?.to, after.gob2!.attached?.to], ["horse", "gob"], `${name} ${d}: both still in tow`);
      }
    }
  });
});

describe("a hidden creature in the file a wall stops on hexes (moveLeg.ts behindStop)", () => {
  test("op 61: the rat a hidden goblin drags stops as far along its own walk as the goblin got along its own, on a hex of its own lattice", () => {
    for (const [name, g] of GRIDS) {
      const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
      const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
      const solid = (h: Hex) => {
        const along = g.orient === "rows" ? h.col : h.row;
        const across = g.orient === "rows" ? h.row : h.col;
        return along >= 12 && along <= 18 && across !== 8;
      };
      const wide = g.orient === "rows" ? { w: 26, h: 18 } : { w: 18, h: 26 };
      // A stub on the goblin's way down onto the warhorse's line, three hexes along, clear of the warhorse's own walk.
      const s = hexWallRoom(shape, wide.w, wide.h, [...wallsRound(g, wide, solid), sideWall(g, at(7, 7), 1)]);
      s.tokens.horse = onHex(g, "horse", "large", at(4, 8), { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      s.tokens.gob = onHex(g, "gob", "medium", at(4, 7), { name: "Goblin", kind: "npc", visibility: "dm", attached: { to: "horse", kind: "drag" } });
      s.tokens.rat = onHex(g, "rat", "medium", at(3, 6), { name: "Rat", kind: "npc", visibility: "dm", attached: { to: "gob", kind: "drag" } });
      const op = intoCorridor(g, s, at(15, 8));
      assert.ok(canApply(op, P1, s, { canUseAsset: () => true }).ok, name);
      // The walk straight from its own hex to the warhorse's first corner, as ops before version 62 take it (migrate.ts followsHexByHex).
      const walks = planWalks(op, s, P1, { opVersion: 61 });
      const gob = walks.find((m) => m.tokenId === "gob")!;
      const rat = walks.find((m) => m.tokenId === "rat")!;
      assert.equal(refOf(g, { size: "medium", ...gob.to }), hexKey(at(7, 7)), `${name}: the goblin stopped at the stub`);
      assert.equal(rat.route.length, 2, `${name}: the rat stopped on its first piece too`);
      const end = rat.route[1]!;
      const hex = occupiedHexes(g, { size: "medium", x: end.x, y: end.y })[0]!;
      assert.deepEqual([end.x, end.y], [placedOnHex(g, s.tokens.rat, hex).x, placedOnHex(g, s.tokens.rat, hex).y], `${name}: on its own anchor`);
      const line = hexLine(g, at(3, 6), at(11, 8));
      const k = line.findIndex((h) => hexKey(h) === hexKey(hex));
      assert.ok(k > 0 && k < line.length - 1, `${name}: ${hexKey(hex)} partway along its own way down`);
    }
  });
});

/**
 * Live play 40's keep (LP40-HEXFILE-1 and -2): a corridor one hex wide east
 * from 7, 6 for five hexes along line 6, then four hexes down, rock round
 * it, open ground west of it. On hex rows the way down zigzags, and on hex
 * columns line 6 does. The warhorse stands squeezed on the corridor's hex
 * `at`, and the goblin is dragged from the hex `goblin` by the warhorse, or
 * by Bree riding it.
 */
function keepOf(g: HexGrid, at: number, goblin: number, by: "horse" | "bree"): { s: RoomState; path: Hex[] } {
  const bounds = { w: 22, h: 16 };
  const path: Hex[] = [];
  const step = (from: Hex, pick: (n: Hex) => number) => [...hexNeighbors(g, from)].sort((a, b) => pick(a) - pick(b))[0]!;
  let h: Hex = { col: 7, row: 6 };
  for (let i = 0; i < 5; i++) {
    path.push(h);
    h = step(h, (n) => -(n.col * 10) + Math.abs(n.row - 6) * 100);
  }
  const corner = path[4]!;
  h = corner;
  for (let i = 0; i < 4; i++) {
    h = step(h, (n) => -(n.row * 10) + Math.abs(n.col - corner.col) * 3 - n.col * 0.01);
    path.push(h);
  }
  const inPath = new Set(path.map(hexKey));
  const last = path[path.length - 1]!.row;
  const solid = (q: Hex) => q.col >= 7 && q.col <= 15 && q.row >= 1 && q.row <= last && !inPath.has(hexKey(q));
  const s = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", bounds.w, bounds.h, wallsRound(g, bounds, solid));
  const on = path[at]!;
  const horse = onHex(g, "horse", "large", on, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  s.tokens.horse = { ...horse, ...hexStandPlace(g, horse, { size: "medium", ref: on, squeezed: true }), squeeze: true };
  if (by === "bree") s.tokens.bree = onHex(g, "bree", "medium", on, { name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
  s.tokens.gob = onHex(g, "gob", "medium", path[goblin]!, { name: "Goblin", kind: "npc", ownerIds: ["p1"], attached: { to: by, kind: "drag" } });
  return { s, path };
}

/** Each leg of the goblin's walk as the server's move takes it along: one hex step, clear by the leg test. */
function legsClear(g: HexGrid, s: RoomState, gob: { route: readonly { x: number; y: number }[]; trace: readonly unknown[] }, at: string): void {
  const plan = gob as ReturnType<typeof planWalks>[number];
  for (let i = 1; i < plan.route.length; i++) {
    assert.ok(hexDistance(g, hexOf(g, plan.route[i - 1]!), hexOf(g, plan.route[i]!)) <= 1, `${at}: leg ${i} one hex step`);
    assert.equal(movementRules.legBlocker(s, plan.trace[i - 1]!, { ...plan.route[i]!, squeeze: false }), null, `${at}: leg ${i} clear`);
  }
}

for (const [name, g] of GRIDS) {
  describe(`${name}: single file from a squeezed start (LP40-HEXFILE-1, -2, op 62)`, () => {
    test("one hex on and two from every hex of the corridor, round its corner and along its zigzag, Pat's move takes the goblin onto the hex the warhorse leaves, every leg one hex step and clear", () => {
      let taken = 0;
      for (const by of ["horse", "bree"] as const) {
        // Its last hex opens onto the ground beyond, where the warhorse stands up, so the squeezed walks end by 7.
        for (let at = 1; at < 7; at++) {
          for (const d of [1, 2]) {
            if (at + d > 7) continue;
            const { s, path } = keepOf(g, at, at - 1, by);
            const op = intoCorridor(g, s, path[at + d]!);
            const where = `${by} from ${at} by ${d}`;
            const allowed = canApply(op, P1, s, { canUseAsset: () => true });
            assert.ok(allowed.ok, `${where}: ${allowed.ok ? "" : allowed.message}`);
            const gob = planWalks(op, s, P1, {}).find((m) => m.tokenId === "gob")!;
            assert.equal(gob.file, true, where);
            legsClear(g, s, gob, where);
            const r = applyOp(s, op, P1, env(1));
            assert.ok(r.ok, where);
            assert.equal(r.state.tokens.gob!.attached?.to, by, `${where}: still in tow`);
            assert.equal(refOf(g, r.state.tokens.gob!), hexKey(path[at + d - 1]!), `${where}: on the hex behind the warhorse`);
            taken++;
          }
        }
      }
      assert.equal(taken, 22);
    });

    test("backing up a hex leaves the goblin on the hex the warhorse starts on, behind it, never under it", () => {
      for (const by of ["horse", "bree"] as const) {
        for (let at = 2; at < 8; at++) {
          const { s, path } = keepOf(g, at, at - 1, by);
          const op = intoCorridor(g, s, path[at - 1]!);
          const where = `${by} from ${at}`;
          assert.ok(canApply(op, P1, s, { canUseAsset: () => true }).ok, where);
          const gob = planWalks(op, s, P1, {}).find((m) => m.tokenId === "gob")!;
          legsClear(g, s, gob, where);
          const r = applyOp(s, op, P1, env(1));
          assert.ok(r.ok, where);
          assert.equal(refOf(g, r.state.tokens.gob!), hexKey(path[at]!), `${where}: on the hex the warhorse left`);
          assert.notEqual(refOf(g, r.state.tokens.gob!), refOf(g, { ...r.state.tokens.horse!, size: "medium" }), `${where}: not under the warhorse`);
        }
      }
    });

    test("a second goblin, dragged by the first, follows it through the zigzag hex by hex, by the hex the first starts on", () => {
      for (let at = 2; at < 6; at++) {
        const { s, path } = keepOf(g, at, at - 1, "horse");
        s.tokens.grik = onHex(g, "grik", "medium", path[at - 2]!, { name: "Grik", kind: "npc", ownerIds: ["p1"], attached: { to: "gob", kind: "drag" } });
        const op = intoCorridor(g, s, path[at + 2]!);
        const allowed = canApply(op, P1, s, { canUseAsset: () => true });
        assert.ok(allowed.ok, `from ${at}: ${allowed.ok ? "" : allowed.message}`);
        const walks = planWalks(op, s, P1, {});
        const grik = walks.find((m) => m.tokenId === "grik")!;
        legsClear(g, s, grik, `from ${at}`);
        assert.equal(hexKey(hexOf(g, grik.route[1]!)), hexKey(path[at - 1]!), `from ${at}: first onto the hex the goblin starts on`);
        const r = applyOp(s, op, P1, env(1));
        assert.ok(r.ok);
        assert.deepEqual(["gob", "grik"].map((id) => refOf(g, r.state.tokens[id]!)), [hexKey(path[at + 1]!), hexKey(path[at]!)], `from ${at}: each behind the one before`);
      }
    });

    test("an op stored at version 61 replays as it ran, the goblin under the warhorse after a hex back, and the same op at 62 walks it hex by hex behind it", () => {
      const { s, path } = keepOf(g, 3, 2, "horse");
      const op = intoCorridor(g, s, path[2]!);
      const at = (opVersion: number) => {
        const r = applyOp(s, op, DM, { ...env(1), opVersion });
        assert.ok(r.ok);
        return refOf(g, r.state.tokens.gob!);
      };
      assert.equal(at(61), hexKey(path[2]!), "op 61: on the warhorse's hex, as it ran");
      assert.equal(at(62), hexKey(path[3]!), "op 62: behind it");
      const old = planWalks(op, s, DM, { opVersion: 61 }).find((m) => m.tokenId === "gob")!;
      assert.equal(old.along, undefined, "op 61: one point per point of the warhorse's walk");
      assert.ok(planWalks(op, s, DM, { opVersion: 62 }).find((m) => m.tokenId === "gob")!.along, "op 62: hex by hex");
    });

    test("op 62: the rat a hidden goblin drags stops no further along than the goblin a stub stopped on its way onto the warhorse's hex", () => {
      // On a straight stretch of the corridor, so the goblin's way two hexes onto the warhorse's runs along it: line 6 on rows, the
      // way down on columns.
      const [at, goblin, target] = g.orient === "rows" ? [4, 2, 6] : [6, 4, 7];
      const { s, path } = keepOf(g, at, goblin, "horse");
      s.tokens.gob = { ...s.tokens.gob!, visibility: "dm" };
      s.tokens.rat = onHex(g, "rat", "medium", path[goblin - 1]!, { name: "Rat", kind: "npc", visibility: "dm", attached: { to: "gob", kind: "drag" } });
      // A stub across the corridor between the goblin's next hex and the warhorse's: the goblin's second step, not the warhorse's.
      const d = hexNeighbors(g, path[at - 1]!).findIndex((n) => hexKey(n) === hexKey(path[at]!));
      const stub = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", 22, 16, [sideWall(g, path[at - 1]!, d)]).buildChunks;
      for (const [key, chunk] of Object.entries(stub)) s.buildChunks[key] = { ...(s.buildChunks[key] ?? chunk!), walls: [...(s.buildChunks[key]?.walls ?? []), ...chunk!.walls!] };
      const op = intoCorridor(g, s, path[target]!);
      assert.ok(canApply(op, P1, s, { canUseAsset: () => true }).ok);
      const walks = planWalks(op, s, P1, {});
      const gob = walks.find((m) => m.tokenId === "gob")!;
      const rat = walks.find((m) => m.tokenId === "rat")!;
      assert.equal(refOf(g, { size: "medium", ...gob.to }), hexKey(path[at - 1]!), "the goblin stopped at the stub");
      assert.equal(refOf(g, { size: "medium", ...rat.to }), hexKey(path[goblin]!), "the rat a hex behind it");
      legsClear(g, s, rat, "the rat");
    });

    test("op 62: a hidden imp that a goblin two hexes out drags walks a shorter walk than the goblin, and the rat the imp drags still follows it, each behind the one before", () => {
      // The DM's drag, since the goblin starts out of the warhorse's reach. The imp's walk from the mouth is shorter than the
      // goblin's, so its move holds its last point as long as the goblin's lasts, and the rat behind it reads the imp's own walk
      // held so (moveLeg.ts behindStop).
      const { s, path } = keepOf(g, 1, 0, "horse");
      const last = path[path.length - 1]!.row;
      const inPath = new Set(path.map(hexKey));
      const open = (h: Hex) => inPath.has(hexKey(h)) || !(h.col >= 7 && h.col <= 15 && h.row >= 1 && h.row <= last);
      const mouth = path[0]!;
      const ratAt = hexNeighbors(g, mouth).find((n) => open(n) && hexKey(n) !== hexKey(path[1]!))!;
      const gobAt = hexNeighbors(g, ratAt).find((n) => open(n) && hexDistance(g, n, path[1]!) === 3)!;
      s.tokens.gob = onHex(g, "gob", "medium", gobAt, { name: "Goblin", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
      s.tokens.imp = onHex(g, "imp", "medium", mouth, { name: "Imp", kind: "npc", visibility: "dm", attached: { to: "gob", kind: "drag" } });
      s.tokens.rat = onHex(g, "rat", "medium", ratAt, { name: "Rat", kind: "npc", visibility: "dm", attached: { to: "imp", kind: "drag" } });
      const r = applyOp(s, intoCorridor(g, s, path[2]!), DM, env(1));
      assert.ok(r.ok);
      const at = (id: string) => refOf(g, r.state.tokens[id]!);
      assert.deepEqual([at("gob"), at("imp")], [hexKey(path[1]!), hexKey(mouth)], "the goblin on the hex the warhorse left, the imp where it stood behind it");
      assert.equal(hexDistance(g, hexOf(g, r.state.tokens.rat!), mouth), 1, "the rat beside the imp");
      assert.ok(![at("gob"), at("imp")].includes(at("rat")), "the rat on a hex of its own");
      assert.deepEqual(["gob", "imp", "rat"].map((id) => r.state.tokens[id]!.attached?.to), ["horse", "gob", "imp"]);
    });

    test("backing up a corridor that folds onto itself, two goblins in tow, the second ends on a hex of the file clear of the warhorse, not on its start under it", () => {
      // From the room round C, east four hexes, then a turn of 120 degrees, so the corridor's hexes 2 and 4 touch across the fold.
      const C: Hex = { col: 15, row: 15 };
      const step = (h: Hex, d: number) => hexNeighbors(g, h)[d % 6]!;
      let h = step(step(step(C, 0), 0), 0);
      const corridor: Hex[] = [h];
      for (let k = 1; k < 8; k++) corridor.push((h = step(h, k < 4 ? 0 : 2)));
      assert.equal(hexDistance(g, corridor[2]!, corridor[4]!), 1, "the fold");
      const open = new Set(corridor.map(hexKey));
      const solid = (q: Hex) => hexDistance(g, q, C) > 2 && !open.has(hexKey(q));
      const s = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", 32, 32, wallsRound(g, { w: 32, h: 32 }, solid));
      const horse = onHex(g, "horse", "large", corridor[4]!, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      s.tokens.horse = { ...horse, ...hexStandPlace(g, horse, { size: "medium", ref: corridor[4]!, squeezed: true }), squeeze: true };
      for (const [id, k] of [["gob", 3], ["grik", 2]] as const) s.tokens[id] = onHex(g, id, "medium", corridor[k]!, { name: id, kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
      const op = intoCorridor(g, s, corridor[2]!);
      assert.ok(canApply(op, P1, s, { canUseAsset: () => true }).ok);
      const r = applyOp(s, op, P1, env(1));
      assert.ok(r.ok);
      const at = ["horse", "gob", "grik"].map((id) => hexKey(occupiedHexes(g, r.state.tokens[id]!)[0]!));
      assert.equal(at[0], hexKey(corridor[2]!), "the warhorse where it backed to");
      assert.equal(new Set(at).size, 3, `each on a hex of its own: ${at.join(" ")}`);
      assert.deepEqual(["gob", "grik"].map((id) => r.state.tokens[id]!.attached?.to), ["horse", "horse"]);
    });
  });
}

describe("a walk hex by hex's moments (route.ts FileAlong)", () => {
  test("its hexes up to the holder's first corner are reached evenly over the holder's first piece, then each as the holder's own hex there, so a trap's stop early on finds it near its start", () => {
    for (const [name, g] of GRIDS) {
      // On a straight stretch of the corridor: line 6 on rows, the way down on columns.
      const o = g.orient === "rows" ? 0 : 4;
      const { s, path } = keepOf(g, o + 1, o, "horse");
      const horse = s.tokens.horse!;
      const at = (i: number) => hexStandPlace(g, horse, { size: "medium", ref: path[o + i]!, squeezed: true });
      // The warhorse walks one hex, then two.
      const walk = hexFileRoutes(g, horse, [{ x: horse.x, y: horse.y }, at(2), at(4)], [[s.tokens.gob!]], true).get("gob")!;
      assert.deepEqual(walk.map((p) => hexKey(hexOf(g, p))), [0, 1, 2, 3].map((i) => hexKey(path[o + i]!)), name);
      assert.deepEqual(walk.map((p) => p.along), [[0, 0, 2], [0, 1, 2], [0, 2, 2], [1, 1, 2]], name);
    }
  });

  test("a goblin a flying warhorse drags as it comes down follows its height at each hex, and ends at the height the warhorse ends at", () => {
    const { s, path } = keepOf(ROWS, 1, 0, "horse");
    s.tokens.horse = { ...s.tokens.horse!, elevation: 10 };
    s.tokens.gob = { ...s.tokens.gob!, elevation: 10 };
    const op = { ...intoCorridor(ROWS, s, path[4]!), elevation: 0 };
    assert.equal(op.route!.length, 1, "one piece");
    const gob = planWalks(op, s, DM, {}).find((m) => m.tokenId === "gob")!;
    // The warhorse comes down evenly over its one piece of three hexes, and the goblin is a quarter of the way on at each hex.
    assert.deepEqual(gob.route.map((p) => p.elevation), [10, 7.5, 5, 0]);
  });

  test("the cap on a route's reach counts a walk hex by hex on the holder's pieces its legs end on, so the goblin's three legs and the warhorse's piece of three hexes count once (review HEXFILE-OPUS-2)", () => {
    const { s, path } = keepOf(ROWS, 1, 0, "horse");
    const op = intoCorridor(ROWS, s, path[4]!);
    const horse = s.tokens.horse!;
    const fpc = s.meta.settings.feetPerCell;
    const trace = routeWalkers(s.buildChunks, ownWalk(horse), op.route!, 0);
    const gob = planWalks(op, s, P1, {}).find((m) => m.tokenId === "gob")!.route;
    assert.equal(gob.length, 4, "a point a hex, two more than the warhorse's walk");
    // The warhorse's one piece of three hexes, and the goblin's three legs of one hex each, all on that piece.
    const legs = pieceReach(gob[0]!, gob[1]!, fpc) + pieceReach(gob[1]!, gob[2]!, fpc) + pieceReach(gob[2]!, gob[3]!, fpc);
    assert.equal(checkSetReach(s, horse, trace, () => true, fpc, "player", true), Math.max(pieceReach(trace[0]!, trace[1]!, fpc), legs));
  });
});

describe("the cap on a route's reach over a walk hex by hex round a corner (review HEXFILE-OPUS-2)", () => {
  test("the goblin's legs onto the warhorse's start and along its first piece count on that piece, and those past the corner on the next", () => {
    const { s, path } = keepOf(ROWS, 1, 0, "horse");
    const op = intoCorridor(ROWS, s, path[7]!);
    assert.equal(op.route!.length, 2, "two pieces, round the corner");
    const horse = s.tokens.horse!;
    const fpc = s.meta.settings.feetPerCell;
    const trace = routeWalkers(s.buildChunks, ownWalk(horse), op.route!, 0);
    const gob = planWalks(op, s, P1, {}).find((m) => m.tokenId === "gob")!.route;
    // Its legs to the corridor's hexes 1 to 4 lie on the warhorse's first piece, which ends on hex 4, and the rest on its second.
    const corner = path.findIndex((h) => hexKey(h) === hexKey(path[4]!));
    let first = 0;
    let second = 0;
    for (let k = 1; k < gob.length; k++) {
      const on = path.findIndex((h) => hexKey(h) === hexKey(hexOf(ROWS, gob[k]!)));
      if (on <= corner) first += pieceReach(gob[k - 1]!, gob[k]!, fpc);
      else second += pieceReach(gob[k - 1]!, gob[k]!, fpc);
    }
    assert.ok(first > 0 && second > 0, `legs on both pieces: ${first} and ${second}`);
    const lead = (i: number) => pieceReach(trace[i]!, trace[i + 1]!, fpc);
    assert.equal(checkSetReach(s, horse, trace, () => true, fpc, "player", true), Math.max(lead(0), first) + Math.max(lead(1), second));
  });
});

describe("an area's sweep reads a walk hex by hex at the lead's moments (areaTriggers.ts alongGroups)", () => {
  test("on rows, the goblin a warhorse drags three hexes along line 6 in one piece enters a sphere on a hex it walks through, which a sweep of its own first piece never reaches", () => {
    const { s, path } = keepOf(ROWS, 1, 0, "horse");
    s.templates.orb = template("orb", { shape: "sphere", size: 5, origin: { ...hexCenter(ROWS, path[2]!), z: 0 }, triggers: ["enter"], spell: "Orb" });
    s.encounter = { rev: 0, round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "horse", value: 15 })] };
    const op = intoCorridor(ROWS, s, path[4]!);
    assert.equal(op.route!.length, 1, "one piece");
    const gob = planWalks(op, s, DM, {}).find((m) => m.tokenId === "gob")!;
    assert.ok(gob.route.length > 2, "more points than the warhorse's walk");
    const r = applyOp(s, op, DM, env(1));
    assert.ok(r.ok);
    assert.equal(refOf(ROWS, r.state.tokens.gob!), hexKey(path[3]!), "it ends past the sphere");
    const entered = r.log.flatMap((e) => (e.data?.type === "area" && e.data.trigger === "enter" ? [e.data.tokenId] : []));
    assert.ok(entered.includes("gob"), `entered: ${entered.join(", ")}`);
  });
});

describe("a trap's cut keeps how far along the cut lead's walk each point of a walk hex by hex is reached (traps.ts cutAlong, review HEXFILE-OPUS-1)", () => {
  for (const [name, g] of GRIDS) {
    test(`${name}: a stop trap at the corridor's hex 5 stops the warhorse, and the goblin it drags still enters a sphere on hex 3 that it walks through`, () => {
      const { s, path } = keepOf(g, 1, 0, "horse");
      s.templates.orb = template("orb", { shape: "sphere", size: 5, origin: { ...hexCenter(g, path[3]!), z: 0 }, triggers: ["enter"], spell: "Orb" });
      s.encounter = { rev: 0, round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "horse", value: 15 })] };
      s.traps.stop = trap("stop", { grid: g.orient === "rows" ? "hexRows" : "hexColumns", zone: { cells: [{ x: path[5]!.col, y: path[5]!.row, w: 1, h: 1 }] } });
      const op = intoCorridor(g, s, path[7]!);
      const cut = planTrapMove(op, s, DM, {}).op;
      assert.notEqual(cut, op, "the trap cuts the move");
      const gob = planWalks(cut, s, DM, {}).find((m) => m.tokenId === "gob")!;
      assert.ok(gob.along && gob.route.length > 3, "the cut op's walk goes hex by hex, more points than the warhorse's cut walk");
      const r = applyOp(s, op, DM, env(1));
      assert.ok(r.ok);
      assert.equal(refOf(g, r.state.tokens.gob!), hexKey(path[4]!), "the goblin stops behind the warhorse, past the sphere");
      const entered = r.log.flatMap((e) => (e.data?.type === "area" && e.data.trigger === "enter" ? [e.data.tokenId] : []));
      assert.ok(entered.includes("gob"), `entered: ${entered.join(", ")}`);
    });

    test(`${name}: a stop trap at the corridor's hex 6, partway along the warhorse's second piece: each spot of the goblin's cut walk is read where the warhorse stands as it did there on the walk before the cut`, () => {
      const { s, path } = keepOf(g, 1, 0, "horse");
      s.traps.stop = trap("stop", { grid: g.orient === "rows" ? "hexRows" : "hexColumns", zone: { cells: [{ x: path[6]!.col, y: path[6]!.row, w: 1, h: 1 }] } });
      const op = intoCorridor(g, s, path[7]!);
      const cut = planTrapMove(op, s, DM, {}).op;
      assert.notEqual(cut, op, "the trap cuts the move");
      // Each of the goblin's spots with the warhorse's latest spot at or before its moment, as the trap step reads them.
      const pairs = (o: Parameters<typeof trapWalks>[0]) => {
        const walks = trapWalks(o, s, DM, {});
        const lead = walks.find((w) => w.tokenId === "horse")!.spots;
        return walks
          .find((w) => w.tokenId === "gob")!
          .spots.map((spot) => {
            let at = 0;
            for (let j = 1; j < lead.length && compareAlong(lead[j]!.progress, spot.progress) <= 0; j++) at = j;
            return `${hexKey(hexOf(g, spot))} with the warhorse at ${lead[at]!.x.toFixed(3)}, ${lead[at]!.y.toFixed(3)}`;
          });
      };
      const after = pairs(cut);
      const before = pairs(op).slice(0, after.length);
      assert.ok(after.length > 5, "the goblin walks past the warhorse's first corner before the stop");
      assert.deepEqual(after, before);
    });

    test(`${name}: a hidden goblin's spots on the cut op's private pass never pass the end of the cut warhorse's walk`, () => {
      const { s, path } = keepOf(g, 1, 0, "horse");
      s.tokens.gob = { ...s.tokens.gob!, visibility: "dm" };
      s.traps.stop = trap("stop", { grid: g.orient === "rows" ? "hexRows" : "hexColumns", zone: { cells: [{ x: path[6]!.col, y: path[6]!.row, w: 1, h: 1 }] } });
      const op = intoCorridor(g, s, path[7]!);
      const cut = planTrapMove(op, s, P1, {}, () => false).op;
      assert.notEqual(cut, op, "the trap cuts the move");
      const walks = trapWalks(cut, s, P1, {});
      const spots = (id: string) => walks.find((w) => w.tokenId === id)!.spots.map((spot) => spot.progress);
      const end = spots("horse").at(-1)!;
      const goblin = spots("gob");
      assert.ok(goblin.length > 2, "the goblin walks");
      for (const at of goblin) assert.ok(compareAlong(at, end) <= 0, `${at.join("/")} not past ${end.join("/")}`);
    });
  }
});

describe("change format 62 (HEX_FILE_OP_VERSION)", () => {
  test("the step is the identity, the rule is gated at 62, and a build at 61 refuses a room from this one", () => {
    const op = { t: "token.move", tokenId: "horse", x: 1, y: 2, squeeze: true, route: [[1, 2, 1, 0]] };
    assert.equal(HEX_FILE_OP_VERSION, 62);
    assert.ok(OP_VERSION >= 62);
    assert.equal(runMigrations(op, 61, 62, opMigrations), op);
    assert.deepEqual([followsHexByHex(1), followsHexByHex(61), followsHexByHex(62), followsHexByHex(undefined)], [false, false, true, true]);
    assert.throws(() => runMigrations(op, 62, 61, opMigrations), /down/);
  });
});
