import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { liftAllBut } from "#shared/discoveryTestutil.ts";
import type { RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { linkHolds, overlaps } from "#shared/rules/attach.ts";
import { occupiedHexes, placedOnHex, tokenRefHex } from "#shared/rules/footprint.ts";
import { hexCenter, hexDistance, hexKey, sceneHexes, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "#shared/rules/hexWalls.testkit.ts";
import { hexStandPlace } from "#shared/rules/movement.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { actor, env, P1 } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import { moveOpsOf, stopText, type DropPlan } from "./drop.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { dragStops, type DragDeps } from "./stageHooks.ts";

/*
 * Live play 44's vault on hexes: a warhorse squeezed in a corridor one hex
 * wide, Bree riding it and a Grappled captive in tow behind. Dragged out
 * into the open room, it went nowhere and read "Stopped at a wall. Drop at
 * the corner first, then go on." The route search took the walk along the
 * corridor and the step that stands the warhorse up at its mouth as one
 * piece, and judged the captive by the warhorse's steps, as a creature kept
 * beside its holder whose seat stays put. But the captive keeps its place
 * beside the warhorse's box, which grows as the warhorse stands up, so on
 * that piece the server walks it straight through the rock, and the drop's
 * own check cut the walk back to its start (hexWalk.ts towedPiece).
 */

const CORNER_WORDS = "Stopped at a wall. Drop at the corner first, then go on.";

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

/** A hex as hex rows name it, read on `g`: hex columns are the rows' layout turned on its diagonal, so one layout serves both. */
function on(g: HexGrid, h: Hex): Hex {
  return g === ROWS ? h : { col: h.row, row: h.col };
}

/** The vault: rock rows 11 to 17 from line 16 to 22 but a corridor along row 14, the warhorse squeezed on 19, 14 and the captive behind it on 20, 14. */
function vault(g: HexGrid, fog: boolean): RoomState {
  const rock = (h: Hex) => {
    const r = on(g, h);
    return r.col >= 16 && r.col <= 22 && r.row >= 11 && r.row <= 17 && r.row !== 14;
  };
  const s = hexWallRoom(g === ROWS ? "hexRows" : "hexColumns", 30, 30, wallsRound(g, { w: 30, h: 30 }, rock));
  if (fog) {
    s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true };
    liftAllBut(s, "dm", []);
  }
  const at = on(g, { col: 19, row: 14 });
  const horse = onHex(g, "horse", "large", at, { name: "Warhorse", kind: "npc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor({ speeds: { walk: 60 } }) } });
  s.tokens.horse = { ...horse, ...hexStandPlace(g, horse, { size: "medium", ref: at, squeezed: true }), squeeze: true };
  s.tokens.bree = onHex(g, "bree", "medium", at, { name: "Bree", kind: "pc", disposition: "ally", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
  s.tokens.gob = onHex(g, "gob", "medium", on(g, { col: 20, row: 14 }), { name: "Captive", kind: "monster", disposition: "hostile", actor: { inline: actor({ effects: [{ id: "grab", key: "grappled" }] }) }, attached: { to: "horse", kind: "drag" } });
  return s;
}

/** Pat's drag onto `target`, pressed on Bree (her middle onto the hex's) or on the warhorse (its full box onto the hex), and the server's answer to each op of the plan. */
function dragTo(g: HexGrid, s: RoomState, target: Hex, pressed: "horse" | "bree"): { plan: DropPlan; after: RoomState; refused: string | null } {
  const copy = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
  const horse = s.tokens.horse!;
  const from = hexCenter(g, occupiedHexes(g, s.tokens.bree!)[0]!);
  const to = hexCenter(g, target);
  const box = pressed === "bree" ? { x: horse.x + to.x - from.x, y: horse.y + to.y - from.y } : hexStandPlace(g, horse, { size: "large", ref: target, squeezed: false });
  const plan = planOn(copy, box, pressed);
  let after = s;
  for (const op of moveOpsOf(plan.moves)) {
    const allowed = canApply(op, P1, after, { canUseAsset: () => true });
    if (!allowed.ok) return { plan, after, refused: allowed.message };
    const r = applyOp(after, op, P1, env(1));
    assert.ok(r.ok);
    after = r.state;
  }
  return { plan, after, refused: null };
}

const hexOf = (g: HexGrid, s: RoomState, id: string) => hexKey(occupiedHexes(g, s.tokens[id]!)[0]!);

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  describe(`${name}: a squeezed warhorse dragging a captive out of a corridor one hex wide into the open (live play 44)`, () => {
    test("onto the hex past the mouth, two on and round the corner, pressed on Bree or on the warhorse: it stands up there, the captive in tow on open ground, and the server takes the move", () => {
      for (const target of [{ col: 15, row: 14 }, { col: 14, row: 14 }, { col: 13, row: 13 }].map((h) => on(g, h))) {
        for (const pressed of ["bree", "horse"] as const) {
          const s = vault(g, false);
          const where = `onto ${hexKey(target)}, pressed on ${pressed}`;
          const { plan, after, refused } = dragTo(g, s, target, pressed);
          assert.equal(plan.stop && stopText(plan.stop), null, where);
          assert.equal(refused, null, where);
          assert.equal(hexOf(g, after, "horse"), hexKey(target), `${where}: the warhorse under the finger`);
          assert.equal(after.tokens.horse!.squeeze, undefined, `${where}: full size`);
          assert.equal(after.tokens.gob!.attached?.to, "horse", `${where}: the captive still in tow`);
          // From change format 64 it ends on a hex of its own off the warhorse, in reach (D-261120-006). Before, the half
          // hex the warhorse's box grows by as it stands up left it on a hex corner over the warhorse's hexes (LP45-DRAG-1).
          const gob = after.tokens.gob!;
          const own = placedOnHex(g, gob, tokenRefHex(g, gob));
          assert.ok(Math.abs(own.x - gob.x) < 1e-9 && Math.abs(own.y - gob.y) < 1e-9, `${where}: the captive on its own hex, on ${gob.x}, ${gob.y}`);
          assert.ok(!overlaps(g, gob, after.tokens.horse!), `${where}: the captive off the warhorse, on ${hexOf(g, after, "gob")}`);
          assert.ok(linkHolds(g, after.meta.settings, "drag", gob, after.tokens.horse!), `${where}: the captive in reach`);
        }
      }
    });

    for (const fog of [false, true]) {
      test(`fog ${fog ? "on, every hex revealed" : "off"}: every hex of the room within 4 of the mouth and of the corridor, pressed on Bree or on the warhorse, lands where the server takes it, and a drop that moves nothing never asks for a corner`, () => {
        const s = vault(g, fog);
        const mouth = on(g, { col: 15, row: 14 });
        let landed = 0;
        for (const target of sceneHexes(g, { w: 30, h: 30 })) {
          const r = on(g, target);
          const corridor = r.row === 14 && r.col >= 16 && r.col <= 18;
          if (!corridor && (r.col > 15 || hexDistance(g, target, mouth) > 4)) continue;
          for (const pressed of ["bree", "horse"] as const) {
            const where = `onto ${hexKey(target)}, pressed on ${pressed}`;
            const { plan, refused } = dragTo(g, s, target, pressed);
            assert.equal(refused, null, `${where}: the server refuses what the drop sends (${JSON.stringify(plan.moves)})`);
            if (plan.moves.length === 0) assert.notEqual(plan.stop && stopText(plan.stop), CORNER_WORDS, `${where}: no corner to drop at`);
            else landed++;
          }
        }
        assert.ok(landed >= 60, `drops that land: ${landed}`);
      });
    }
  });
}
