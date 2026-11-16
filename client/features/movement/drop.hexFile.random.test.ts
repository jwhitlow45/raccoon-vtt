import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { caseOf, insideCaseOf, keepOf, raised, wayInto, withImpAhead, withMouse, type Case } from "#shared/reducer/hexFile.testkit.ts";
import { routeWorld } from "#shared/rules/hexWalk.ts";
import { COLUMNS, onHex, ROWS } from "#shared/rules/hexWalls.testkit.ts";
import { ownWalk } from "#shared/rules/movement.ts";
import { groupWalkWorld } from "#shared/rules/walkWorld.ts";
import { P1 } from "#shared/testutil.ts";
import { walkersFor } from "../attach/walk.ts";
import { cutForWalkers, dropView, type DropPlan } from "./drop.ts";

/*
 * The board's two checks of a drag in single file hex by hex, the drop's
 * own (drop.ts cutForWalkers, through walkersStop) and the route search's
 * (hexWalk.ts fileBlocked), against the server, over the random rooms of
 * hexFile.random.test.ts raised 40 ft and flying on level, brought down or
 * climbing from the ground, chains of two and three in tow and an imp ahead
 * of the holder among them: each holds the drag only where the server
 * refuses the move, and wherever the server refuses it for one that cannot
 * follow (review HEXFILE-ASTRA-5). The route search walks a flier level at
 * its own height (hexWalk.ts elevationOf), so it is held to the server's
 * answer on the level flights, the drop on every one.
 */

const HEIGHTS = [
  [40, 40],
  [40, 0],
  [40, 25],
  [0, 30],
] as const;

/**
 * The drop's and, on a level flight, the route search's answers for a drag
 * of `made`'s holder against the server's, as the tests below ask, and
 * whether there was one: the holder drags some creature on Pat's copy.
 */
function compared(made: Case, level: boolean, at: string): { cannot: boolean; drags: boolean } {
  const { state: s, op } = made;
  const copy = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
  const walkers = walkersFor(copy, "horse", "player");
  const allowed = canApply(op, P1, s, { canUseAsset: () => true });
  const cannot = !allowed.ok && allowed.message.endsWith("can't follow through there.");
  if (walkers.length === 0) return { cannot, drags: false };
  const plan: DropPlan = { moves: [{ tokenId: "horse", x: op.x, y: op.y, elevation: op.elevation!, squeeze: true, ...(op.route ? { route: op.route } : {}) }], stop: null, held: [] };
  const drop = cutForWalkers(dropView(copy, "player"), copy.tokens.horse!, plan, walkers, "walk").stop;
  const horse = copy.tokens.horse!;
  const points = [{ x: horse.x, y: horse.y }, ...(op.route ?? []).map(([x, y]) => ({ x, y }))];
  const search = level ? routeWorld(groupWalkWorld(copy, ownWalk(horse), { role: "player" }).input).fileBlocked(points) : null;
  for (const [what, held, why] of [
    ["the drop", drop !== null, JSON.stringify(drop)],
    ...(level ? [["the route search", search !== null, search] as const] : []),
  ] as const) {
    assert.ok(!held || !allowed.ok, `${at}: ${what} holds a drag the server takes (${why})`);
    assert.ok(!cannot || held, `${at}: ${what} lets go a drag the server refuses (${allowed.ok ? "" : allowed.message})`);
  }
  return { cannot, drags: true };
}

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  describe(`${name}: the board's checks of a drag in single file hex by hex, against the server's (review HEXFILE-ASTRA-5)`, () => {
    test("raised and flying on level, brought down or climbing, chains in tow and an imp ahead among them: the drop, and on the level the route search, each hold the drag exactly where the server refuses it for one that cannot follow", () => {
      let drags = 0;
      let refused = 0;
      for (const [kind, made] of [
        ["", caseOf],
        ["inside ", insideCaseOf],
      ] as const) {
        for (let seed = 1; seed <= 300; seed++) {
          const room = made(seed, g);
          if (!room) continue;
          for (const [ahead, start] of [
            ["", room],
            ["imp ahead, ", withImpAhead(room, seed)],
            ["mouse in tow, ", withMouse(room, seed)],
          ] as const) {
            if (!start) continue;
            for (const [up, down] of HEIGHTS) {
              const { cannot, drags: one } = compared(raised(start, up, down), up === down, `${kind}seed ${seed}, ${ahead}${up} to ${down} ft`);
              if (!one) continue;
              drags++;
              if (cannot) refused++;
            }
          }
        }
      }
      assert.ok(drags >= 1000 && refused >= 50, `drags compared ${drags}, refused for one that cannot follow ${refused}`);
    });

    test("through the keep's corridor from each hex to each hex on, raised and flying level, brought down or climbing, the warhorse or Bree on it dragging the goblin, and the goblin a rat or not: the drop, and on the level the route search, each hold the drag exactly where the server refuses it for one that cannot follow", () => {
      let drags = 0;
      for (let at = 1; at < 7; at++) {
        for (let to = at + 1; to < 9; to++) {
          for (const by of ["horse", "bree"] as const) {
            for (const rat of [false, true]) {
              for (const [up, down] of HEIGHTS) {
                const { s, path } = keepOf(g, at, at - 1, by);
                if (rat) s.tokens.rat = onHex(g, "rat", "tiny", path[at - 1]!, { name: "Rat", kind: "npc", ownerIds: ["p1"], attached: { to: "gob", kind: "drag" } });
                const op = wayInto(g, s, path[to]!);
                if (!op) continue;
                compared(raised({ state: s, op, g }, up, down), up === down, `from ${at} to ${to}, ${by}${rat ? ", a rat" : ""}, ${up} to ${down} ft`);
                drags++;
              }
            }
          }
        }
      }
      assert.ok(drags >= 300, `drags compared ${drags}`);
    });
  });
}
