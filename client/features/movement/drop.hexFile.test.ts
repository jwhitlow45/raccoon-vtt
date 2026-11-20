import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { occupiedHexes } from "#shared/rules/footprint.ts";
import { hexCenter, hexKey, hexNeighbors, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "#shared/rules/hexWalls.testkit.ts";
import { findRouteOn, routeWorld } from "#shared/rules/hexWalk.ts";
import { planWalks } from "#shared/rules/moveLeg.ts";
import { hexStandAt, hexStandPlace, ownWalk } from "#shared/rules/movement.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { groupWalkWorld } from "#shared/rules/walkWorld.ts";
import { actor, env, P1 } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import { walkersFor } from "../attach/walk.ts";
import { cutForWalkers, dropView, moveOpsOf, stopText, type DropPlan } from "./drop.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { dragStops, type DragDeps } from "./stageHooks.ts";

/*
 * Live play 40 (LP40-HEXFILE-1 and -2): a warhorse squeezed in a corridor
 * one hex wide, dragging a goblin or carrying Bree who drags it, took no
 * step round a turn ("Goblin can't follow through there."), and on hex
 * columns none along line 6, which zigzags there. The goblin's walk went
 * straight from its hex to the warhorse's first corner, through the rock.
 * Now it walks onto the hex the warhorse starts on and on along the
 * warhorse's own hexes, one point a hex (migrate.ts followsHexByHex), on
 * the board's drag as in the server's move.
 */

class Hand implements Frames {
  queue: (() => void)[] = [];
  now(): number {
    return 0;
  }
  request(run: () => void): number {
    this.queue.push(run);
    return this.queue.length;
  }
  cancel(): void {}
  frame(): void {
    for (const run of this.queue.splice(0)) run();
  }
}

/** A drag of the warhorse, pressed on it or on Bree, its node let go at `box`, as the board plans it on Pat's copy. */
function planOn(copy: RoomState, box: { x: number; y: number }, pressed: "horse" | "bree"): DropPlan {
  const frames = new Hand();
  const stops = dragStops({
    store: { getState: () => ({ view: copy, floorView: copy }) } as unknown as DragDeps["store"],
    actions: { dispatch: () => 1, newId: () => "id" } as unknown as DragDeps["actions"],
    ui: { notify: () => {}, showActions: () => {} } as unknown as DragDeps["ui"],
    scope: new RoomScope(),
    role: "player",
    work: new RouteWork(frames, () => new WorkBudget({ limit: 400_000 })),
  });
  const horse = copy.tokens.horse!;
  const node = { x: () => box.x, y: () => box.y, position: () => {} };
  stops.start(horse.id, pressed === "bree" ? copy.tokens.bree : undefined);
  for (let i = 0; i < 20; i++) {
    stops.frame(node, horse);
    frames.frame();
  }
  let plan: DropPlan | null = null;
  stops.drop(node, horse, [horse], (p) => (plan = p));
  for (let i = 0; i < 50 && !plan; i++) frames.frame();
  stops.end();
  assert.ok(plan, "the drop landed");
  return plan;
}

/** Live play 40's keep: east from 7, 6 along line 6 for five hexes, then four down, rock round it (route.hexFile.test.ts keepOf). */
function keep(g: HexGrid, at: number, goblin: number, by: "horse" | "bree"): { s: RoomState; path: Hex[] } {
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
  const horse = onHex(g, "horse", "large", on, { name: "Warhorse", kind: "npc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor({ speeds: { walk: 60 } }) } });
  s.tokens.horse = { ...horse, ...hexStandPlace(g, horse, { size: "medium", ref: on, squeezed: true }), squeeze: true };
  if (by === "bree") s.tokens.bree = onHex(g, "bree", "medium", on, { name: "Bree", kind: "pc", disposition: "ally", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
  s.tokens.gob = onHex(g, "gob", "medium", path[goblin]!, { name: "Goblin", kind: "monster", disposition: "hostile", actor: { inline: actor({ effects: [{ id: "grab", key: "grappled" }] }) }, attached: { to: by, kind: "drag" } });
  return { s, path };
}

/**
 * The drag onto `target`, then the server's answer to each op of its plan:
 * pressed on Bree, her middle onto the hex's, and on the warhorse, its box
 * onto its squeezed stand there.
 */
function dragTo(g: HexGrid, s: RoomState, target: Hex, pressed: "horse" | "bree"): { plan: DropPlan; after: RoomState } {
  const copy = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
  const horse = s.tokens.horse!;
  const from = hexCenter(g, occupiedHexes(g, s.tokens.bree ?? horse)[0]!);
  const to = hexCenter(g, target);
  const box = pressed === "bree" ? { x: horse.x + to.x - from.x, y: horse.y + to.y - from.y } : hexStandPlace(g, horse, { size: "medium", ref: target, squeezed: true });
  const plan = planOn(copy, box, pressed);
  let after = s;
  for (const op of moveOpsOf(plan.moves)) {
    const allowed = canApply(op, P1, after, { canUseAsset: () => true });
    assert.ok(allowed.ok, allowed.ok ? "" : allowed.message);
    const r = applyOp(after, op, P1, env(1));
    assert.ok(r.ok);
    after = r.state;
  }
  return { plan, after };
}

const hexOf = (g: HexGrid, s: RoomState, id: string) => hexKey(occupiedHexes(g, s.tokens[id]!)[0]!);

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  describe(`${name}: a drag from a squeezed start takes the goblin in single file (LP40-HEXFILE-1, -2)`, () => {
    test("one hex on from each hex of the corridor, round its corner and along its zigzag, Bree dragged: the warhorse goes, the goblin on the hex it left", () => {
      for (let at = 1; at < 7; at++) {
        const { s, path } = keep(g, at, at - 1, "bree");
        const { plan, after } = dragTo(g, s, path[at + 1]!, "bree");
        const where = `from ${at}`;
        assert.equal(plan.stop && stopText(plan.stop), null, where);
        assert.equal(hexOf(g, after, "horse"), hexKey(path[at + 1]!), `${where}: the warhorse under the finger`);
        assert.equal(hexOf(g, after, "gob"), hexKey(path[at]!), `${where}: the goblin behind it`);
        assert.equal(after.tokens.gob!.attached?.to, "bree", where);
      }
    });

    test("the warhorse dragged by its own box onto the hexes of the corridor ahead lands where the drop aims, the goblin on the corridor's hex before it", () => {
      let moved = 0;
      for (let at = 1; at < 6; at++) {
        for (let to = at + 1; to < 8; to++) {
          const { s, path } = keep(g, at, at - 1, "horse");
          const { plan, after } = dragTo(g, s, path[to]!, "horse");
          const where = `from ${at} to ${to}`;
          assert.equal(plan.stop && stopText(plan.stop), null, where);
          const k = path.findIndex((h) => hexKey(h) === hexOf(g, after, "horse"));
          if (k === at) continue;
          assert.ok(k > at, `${where}: on along the corridor`);
          assert.equal(hexOf(g, after, "gob"), hexKey(path[k - 1]!), `${where}: the goblin behind it`);
          moved++;
        }
      }
      assert.ok(moved >= 12, `moves: ${moved}`);
    });

    test("a hex back, pressed on the warhorse or on Bree, the goblin lands on the hex the warhorse left, not under it", () => {
      for (const pressed of ["horse", "bree"] as const) {
        const { s, path } = keep(g, 4, 3, pressed);
        const { plan, after } = dragTo(g, s, path[3]!, pressed);
        assert.equal(plan.stop, null);
        assert.deepEqual([hexOf(g, after, "horse"), hexOf(g, after, "gob")], [hexKey(path[3]!), hexKey(path[4]!)], pressed);
      }
    });
  });
}

describe("the board holds a walk in single file hex by hex to as many points as its heights, as the move holds it (drop.ts followersOf, hexWalk.ts fileBlocked, review HEXFILE-ASTRA-5)", () => {
  for (const [name, g] of [
    ["hex rows", ROWS],
    ["hex columns", COLUMNS],
  ] as const) {
    test(`${name}: the warhorse flies down from 40 ft into the corridor dragging the goblin, which drags a rat from the corridor's mouth, and the board lets the drop go where the server takes the move`, () => {
      const { s, path } = keep(g, 1, 0, "horse");
      s.tokens.rat = onHex(g, "rat", "tiny", path[0]!, { name: "Rat", kind: "npc", ownerIds: ["p1"], attached: { to: "gob", kind: "drag" } });
      for (const id of Object.keys(s.tokens)) s.tokens[id] = { ...s.tokens[id]!, elevation: 40 };
      const horse = s.tokens.horse!;
      const inside = hexStandPlace(g, horse, { size: hexStandAt(g, horse, horse, true).size, ref: path[4]!, squeezed: true });
      const found = findRouteOn({ ...groupWalkWorld(s, ownWalk(horse), { role: "player" }).input, towed: [] }, inside);
      assert.ok(found && found !== "none", "a way in for the warhorse alone");
      const route = found.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]);
      const op = { t: "token.move" as const, tokenId: "horse", ...inside, squeeze: true as const, elevation: 0, route };
      const allowed = canApply(op, P1, s, { canUseAsset: () => true });
      assert.ok(allowed.ok, allowed.ok ? "" : allowed.message);
      // The rat's walk has fewer points than the goblin's, which the move holds it to at its end, coming down there. From op 63
      // the goblin holds its last hex to the warhorse's end (HEXFILE-054), and the rat with it.
      const rat = planWalks(op, s, P1, {}).find((m) => m.tokenId === "rat")!;
      assert.deepEqual(rat.route.map((p) => Math.round(p.elevation * 1e9) / 1e9), [40, 30, 20, 0, 0]);
      const old = planWalks(op, s, P1, { opVersion: 62 }).find((m) => m.tokenId === "rat")!;
      assert.deepEqual(old.route.map((p) => Math.round(p.elevation * 1e9) / 1e9), [40, 30, 20, 0], "op 62 replays as it ran");
      const copy = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
      const plan: DropPlan = { moves: [{ tokenId: "horse", x: inside.x, y: inside.y, elevation: 0, squeeze: true, route }], stop: null, held: [] };
      const cut = cutForWalkers(dropView(copy, "player"), copy.tokens.horse!, plan, walkersFor(copy, "horse", "player"), "walk");
      assert.equal(cut.stop, null, `the drop's own check: ${JSON.stringify(cut.stop)}`);
      const points = [{ x: horse.x, y: horse.y }, ...route.map(([x, y]) => ({ x, y }))];
      assert.equal(routeWorld(groupWalkWorld(copy, ownWalk(copy.tokens.horse!), { role: "player" }).input).fileBlocked(points), null, "the route search's own check");
    });
  }
});
