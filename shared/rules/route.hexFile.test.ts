import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CreatureSize, RoomState, Token } from "../model.ts";
import { canApply } from "../permissions.ts";
import type { OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { movementRules } from "../ruleHooks.ts";
import { DM, env, P1, token, trap } from "../testutil.ts";
import { linkHolds } from "./attach.ts";
import { footprintSize, occupiedHexes, placedOnHex } from "./footprint.ts";
import { hexCenter, hexDistance, hexKey, hexLine, hexNeighbors, type Hex, type HexGrid } from "./hex.ts";
import { findRouteOn } from "./hexWalk.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, sideWall, wallsRound } from "./hexWalls.testkit.ts";
import { planMove, planWalks } from "./moveLeg.ts";
import { hexStandAt, hexStandHexes, hexStandPlace, ownWalk } from "./movement.ts";
import { hexFileClasses, hexFileRoutes, seatShift } from "./route.ts";
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
      assert.equal(gob.route.length, op.route!.length + 1, "one point per point of the horse's walk");
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
  test("the rat a hidden goblin drags stops as far along its own walk as the goblin got along its own, on a hex of its own lattice", () => {
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
      const walks = planWalks(op, s, P1, {});
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
