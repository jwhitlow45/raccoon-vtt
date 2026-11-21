import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { opKind } from "#shared/farLine.ts";
import { FAR } from "#shared/limits.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, character, DM, entry, env, P1, room, token, trap } from "#shared/testutil.ts";
import { parked } from "./copyTwinsTesting.ts";
import { exactBuilds, growthBound, measuredStateBytes, SizeGuard, touchedScenes } from "./sizeGuard.ts";

/*
 * D-261121-065 and 076 (design 2): a player's far check builds their copy
 * before and after on every op that meets the line, at every line, and
 * reuses none across ops. Twins apart only in the DM's hidden ops
 * between P1's, or in a hidden pit under P1's move, count alike on every
 * op of P1's, at half the room's line, just under it and just past it.
 */

let seq = 5_000;

/** P1's table: their hero on its turn, the DM's goblin, room to walk. */
function table(): RoomState {
  const state = room();
  state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ notes: "", dmNotes: "", speeds: { walk: 300 } }) });
  state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
  state.tokens.gob = token("gob", { x: 9, y: 9, visibility: "dm" });
  state.encounter = { rev: 0, round: 1, activeEntryId: "rhero", entries: [entry("rhero", { tokenId: "hero", value: 20 }), entry("rgob", { tokenId: "gob", value: 5 })], turnStart: { entryId: "rhero", tokenId: "hero", sceneId: "s1", x: 2, y: 2, elevation: 0, seen: true, seq: 7 } };
  return state;
}

/** P1's ops: walks, a create, a chat line, an edit of their notes. */
const P1_OPS: Op[] = [
  { t: "token.move", tokenId: "hero", x: 4, y: 2 },
  { t: "drawing.create", drawing: { id: "t-line", sceneId: "s1", kind: "line", points: [1, 1, 3, 3], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } } as Op,
  { t: "log.chat", text: "onward" },
  { t: "character.update", characterId: "c1", patch: { actor: { notes: "n".repeat(300) } } } as Op,
  { t: "token.move", tokenId: "hero", x: 6, y: 3 },
];

/** The DM's hidden op between P1's ops in one twin: notes on the hidden goblin, which P1's copy does not hold. */
const hidden = (i: number): Op => ({ t: "token.update", tokenId: "gob", patch: { notes: "h".repeat(40_000 + i * 20_000) } }) as Op;

/**
 * The copy builds of each of P1's ops on `start`, through one guard as the
 * actor keeps it across a room's ops, with the DM's hidden op before each
 * where `withHidden`.
 */
function builds(start: RoomState, withHidden: boolean, ops: readonly Op[] = P1_OPS): number[] {
  const guard = new SizeGuard({ stateLimit: 64 * 1024 * 1024, sceneLimit: 64 * 1024 * 1024 });
  guard.stateMeasured(measuredStateBytes(start), start);
  let state = start;
  const out: number[] = [];
  const apply = (op: Op, who: Viewer) => {
    const r = applyOp(state, op, who, env(++seq));
    assert.ok(r.ok, r.ok ? "" : `${op.t}: ${r.message}`);
    const measured = r.withoutTraps ? r.withoutTraps() : r;
    assert.ok(measured.ok);
    const scenes = touchedScenes(state, measured.state, measured.touched);
    const growth = growthBound(state, measured.state, measured.touched);
    if (who.role === "player") {
      const at = exactBuilds.count;
      guard.check(measured.state, scenes, growth, state, "player", "widest", opKind(op).far === "exempt", who.memberId);
      out.push(exactBuilds.count - at);
    } else guard.counted(measured.state, scenes, growth, state);
    state = r.state;
  };
  for (const [i, op] of ops.entries()) {
    if (withHidden) apply(hidden(i), DM);
    apply(op, P1);
  }
  return out;
}

describe("a player's far check builds both copies on every op (design 2)", () => {
  for (const [what, offset] of [["at half the room's line", -FAR.roomBytes / 2], ["just under it", -40_000], ["just past it", 40_000]] as const) {
    test(`${what}, twins with the DM's hidden ops between P1's or none count two builds on each of P1's ops`, () => {
      const state = table();
      parked([state], "room", "s1", offset);
      const [a, b] = [builds(structuredClone(state), true), builds(structuredClone(state), false)];
      assert.deepEqual(a, b);
      assert.deepEqual(a, P1_OPS.map(() => 2));
    });
  }

  test("a hidden pit springing under P1's move, against no pit, counts alike just under the line and just past it", () => {
    for (const offset of [-40_000, 40_000]) {
      const plain = table();
      const pit = structuredClone(plain);
      pit.traps = { t1: trap("t1", { sceneId: "s1", zone: { cells: [{ x: 4, y: 2, w: 1, h: 1 }] }, rig: { ...trap("t1").rig!, pit: { floor: -10 } } }) };
      parked([plain, pit], "room", "s1", offset);
      assert.deepEqual(builds(pit, false), builds(plain, false), `${offset} from the line`);
    }
  });
});
