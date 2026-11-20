import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { keepOf } from "#shared/reducer/hexFile.testkit.ts";
import { seatedAt } from "#shared/rules/attach.ts";
import { occupiedHexes, placedOnHex } from "#shared/rules/footprint.ts";
import { hexCenter, hexKey, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { COLUMNS, onHex, ROWS } from "#shared/rules/hexWalls.testkit.ts";
import { hexStandPlace } from "#shared/rules/movement.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { actor, env, P1 } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import { measureWalk } from "../measure/walkRuler.ts";
import { dropView, moveOpsOf, type DropPlan } from "./drop.ts";
import { riderSeat } from "./riderSeat.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { dragStops, type DragDeps } from "./stageHooks.ts";

/*
 * Live play 40's rows drop (LP40-HEX-SEAT, HEXFILE-FOLLOW 1): Pat drags Bree,
 * riding a full-size warhorse on the open ground west of the keep, onto the
 * corridor's first hex, 7, 6. Only one full stand of the warhorse covers it,
 * and her place on the warhorse carried her to the seat beside it, 6, 5. Now
 * the drop sends where she was dropped (riderSeat.ts), the server seats her
 * there, and the walking ruler, which plans and applies the same drop, reads
 * her there too.
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

/** A drag of the warhorse pressed on Bree, her middle let go over `target`, as the board plans it on Pat's copy. */
function dropBree(g: HexGrid, copy: RoomState, target: Hex): DropPlan {
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
  const from = hexCenter(g, occupiedHexes(g, copy.tokens.bree!)[0]!);
  const to = hexCenter(g, target);
  const box = { x: horse.x + to.x - from.x, y: horse.y + to.y - from.y };
  const node = { x: () => box.x, y: () => box.y, position: () => {} };
  stops.start(horse.id, copy.tokens.bree);
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

/** The keep's open ground with the warhorse full size on 4, 6, Bree riding its hex nearest the corridor, an owl perched on her, and a goblin she drags or none. */
function ride(g: HexGrid, goblin: boolean): RoomState {
  const { s } = keepOf(g, 0, 0, "horse");
  delete s.tokens.gob;
  s.tokens.horse = onHex(g, "horse", "large", { col: 4, row: 6 }, { name: "Warhorse", kind: "npc", ownerIds: ["p1"], actor: { inline: actor({ speeds: { walk: 60 } }) } });
  const own = occupiedHexes(g, s.tokens.horse);
  const seat = [...own].sort((a, b) => b.col - a.col || a.row - b.row)[0]!;
  s.tokens.bree = onHex(g, "bree", "medium", seat, { name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
  s.tokens.owl = onHex(g, "owl", "tiny", seat, { name: "Owl", kind: "npc", ownerIds: ["p1"], attached: { to: "bree", kind: "perch" } });
  if (goblin) s.tokens.gob = onHex(g, "gob", "medium", { col: 3, row: 6 }, { name: "Goblin", kind: "monster", actor: { inline: actor({ effects: [{ id: "grab", key: "grappled" }] }) }, attached: { to: "bree", kind: "drag" } });
  return s;
}

/** The plan's ops applied in turn, each taken. */
function served(s: RoomState, plan: DropPlan): RoomState {
  let at = s;
  for (const op of moveOpsOf(plan.moves)) {
    const ok = canApply(op, P1, at, { canUseAsset: () => true });
    assert.ok(ok.ok, ok.ok ? "" : ok.message);
    const r = applyOp(at, op, P1, env(1));
    assert.ok(r.ok);
    at = r.state;
  }
  return at;
}

const hexOf = (g: HexGrid, s: RoomState, id: string) => hexKey(occupiedHexes(g, s.tokens[id]!)[0]!);

describe("hex rows: a rider dropped on a hex of her mount's stand sits on it (LP40-HEX-SEAT)", () => {
  const g = ROWS;
  const mouth: Hex = { col: 7, row: 6 };

  test("Pat drops Bree on the corridor's first hex: the warhorse covers it, she sits on it with her owl, and the drop sends her seat", () => {
    const s = ride(g, false);
    const copy = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
    const plan = dropBree(g, copy, mouth);
    assert.equal(plan.stop, null);
    assert.deepEqual(plan.moves.map((m) => m.seat?.tokenId), ["bree"], "the move carries her seat");
    const after = served(s, plan);
    assert.ok(occupiedHexes(g, after.tokens.horse!).some((h) => hexKey(h) === hexKey(mouth)), "the warhorse covers 7, 6");
    assert.deepEqual([hexOf(g, after, "bree"), hexOf(g, after, "owl")], [hexKey(mouth), hexKey(mouth)], "Bree and her owl on 7, 6");
    // The same move with no seat, as the drop sent it before, carries her to the seat beside it.
    const bare = served(s, { ...plan, moves: plan.moves.map(({ seat: _seat, ...m }) => m) });
    assert.equal(hexOf(g, bare, "bree"), "6,5", "her place alone carries her to 6, 5");
  });

  test("the walking ruler from Bree to the corridor's first hex ends its leg where the drop seats her", () => {
    const s = ride(g, false);
    const m = measureWalk({ view: s, sceneId: "s1", stops: [{ x: 0, y: 0, tokenId: "bree" }, hexCenter(g, mouth)], viewer: { role: "player" }, everything: false })!;
    assert.equal(m.legs.length, 1);
    assert.equal(hexKey(occupiedHexes(g, { size: "medium", ...m.legs[0]!.to })[0]!), hexKey(mouth), "the leg ends on 7, 6");
  });

  test("Bree dragging a goblin keeps the seat her place carries her to, so the goblin stays beside her off the warhorse", () => {
    const s = ride(g, true);
    const copy = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
    const plan = dropBree(g, copy, mouth);
    assert.deepEqual(plan.moves.map((m) => m.seat), [undefined], "no seat");
    const after = served(s, plan);
    assert.equal(hexOf(g, after, "bree"), "6,5");
    assert.ok(!occupiedHexes(g, after.tokens.horse!).some((h) => hexKey(h) === hexOf(g, after, "gob")), "the goblin off the warhorse");
  });
});

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  describe(`${name}: the seat a drop sends (riderSeat.ts)`, () => {
    test("only where the walk ends full size on a stand whose seat it is, her place would not carry her there, and no other rider this copy sees sits there", () => {
      const s = ride(g, false);
      const view = dropView(s, "player");
      const horse = s.tokens.horse!;
      const stand = hexStandPlace(g, horse, { size: "large", ref: { col: 3, row: 10 }, squeezed: false });
      const own = hexKey(occupiedHexes(g, { ...s.tokens.bree!, ...seatedAt(g, s.tokens.bree!, horse, stand, false) })[0]!);
      const other = occupiedHexes(g, { ...horse, ...stand }).find((h) => hexKey(h) !== own)!;
      const aim = (h: Hex) => ({ x: stand.x, y: stand.y, seat: hexCenter(g, h), seated: "bree" });
      const end = { ...stand, squeeze: false };
      assert.deepEqual(riderSeat(view, horse, aim(other), end), { tokenId: "bree", ...placedOnHex(g, s.tokens.bree!, other) }, "a seat of the stand her place does not reach");
      assert.equal(riderSeat(view, horse, aim(other), { ...stand, squeeze: true }), null, "squeezed");
      assert.equal(riderSeat(view, horse, aim(occupiedHexes(g, horse)[0]!), end), null, "off the stand");
      assert.equal(riderSeat(view, horse, aim(occupiedHexes(g, { ...s.tokens.bree!, ...seatedAt(g, s.tokens.bree!, horse, stand, false) })[0]!), end), null, "where her place carries her");
      assert.equal(riderSeat(view, horse, { x: stand.x, y: stand.y }, end), null, "a drag pressed on the warhorse");
      // Another rider her copy sees whose place carries it onto that hex.
      const crowded = structuredClone(s);
      const from = occupiedHexes(g, horse).find((h) => {
        const cal = onHex(g, "cal", "medium", h);
        return hexKey(occupiedHexes(g, { ...cal, ...seatedAt(g, cal, horse, stand, false) })[0]!) === hexKey(other);
      })!;
      crowded.tokens.cal = onHex(g, "cal", "medium", from, { name: "Cal", kind: "pc", attached: { to: "horse", kind: "ride" } });
      assert.equal(riderSeat(dropView(crowded, "player"), horse, aim(other), end), null, "another rider there");
      // One the copy does not hold, as a player's copy of a hidden rider: the seat goes.
      const hidden = projectState({ ...crowded, tokens: { ...crowded.tokens, cal: { ...crowded.tokens.cal!, visibility: "dm" } } }, P1, { sceneId: "s1" }) as unknown as RoomState;
      assert.ok(riderSeat(dropView(hidden, "player"), hidden.tokens.horse!, aim(other), end), "Pat's copy holds no hidden rider");
      // She drags a goblin.
      const towing = ride(g, true);
      assert.equal(riderSeat(dropView(towing, "player"), towing.tokens.horse!, aim(other), end), null, "a goblin in tow");
    });
  });
}
