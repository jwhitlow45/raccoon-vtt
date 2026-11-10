import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState } from "#shared/model.ts";
import { tableNumber } from "#shared/numbering.ts";
import { scene, token } from "#shared/testutil.ts";
import { scopeActor, scopeFixture } from "./undoScopeTesting.ts";

/*
 * A DM's Undo and Redo of a creature's move to another scene, where the
 * table numbered it afresh (shared/numbering.ts): each puts back the
 * number the creature has on the scene it returns to, and a meeting or a
 * note edit since never stops the pose from adapting (undoDm.ts).
 *
 * The players stand on scene B, whose Goblins (group 2) have given three
 * numbers. On scene A the moved Goblin is Goblin 2 of group 1.
 */
function twoScenes() {
  const f = scopeFixture();
  const a = f.sceneId;
  const b = uuidv7();
  const state: RoomState = f.state;
  state.scenes[b] = scene(b, { name: "Hall", order: 1, numbers: { names: { Goblin: [2, 3] } } });
  state.scenes[a] = { ...state.scenes[a]!, numbers: { names: { "Goblin 2": [1, 1], Goblin: [3, 2] } } };
  state.numbering = { rev: 0, groups: 3 };
  state.meta = { ...state.meta, playerSceneId: b };
  const g = uuidv7();
  state.tokens[g] = token(g, { sceneId: a, name: "Goblin", met: 3, number: 2 });
  for (const [id, number] of [[uuidv7(), 1], [uuidv7(), 3]] as const) state.tokens[id] = token(id, { sceneId: b, name: "Goblin", met: 2, number, x: 6 + number });
  return { f, a, b, g, state };
}

const number = (state: RoomState, id: string) => tableNumber(state, state.tokens[id]!);

describe("a DM's undo of a move to another scene", () => {
  test("Undo puts back the first scene's number and Redo the other's", async (t) => {
    const { f, a, b, g, state } = twoScenes();
    const h = await scopeActor(t, state);
    const dm = await h.connect(f.dm);
    await dm.apply({ t: "token.update", tokenId: g, patch: { sceneId: b } });
    assert.equal(number(h.actor.committed.state, g), 4, "met on the players' scene");
    await dm.restore("play", "undo");
    let now = h.actor.committed.state;
    assert.deepEqual([now.tokens[g]!.sceneId, number(now, g)], [a, 2]);
    await dm.restore("play", "redo");
    now = h.actor.committed.state;
    assert.deepEqual([now.tokens[g]!.sceneId, number(now, g)], [b, 4]);
  });

  test("a note edit between Undo and Redo is kept, and Redo and the next Undo are taken", async (t) => {
    const { f, a, b, g, state } = twoScenes();
    const h = await scopeActor(t, state);
    const dm = await h.connect(f.dm);
    await dm.apply({ t: "token.update", tokenId: g, patch: { sceneId: b } });
    await dm.restore("play", "undo");
    await dm.apply({ t: "token.update", tokenId: g, patch: { notes: "limps" } });
    const redone = await dm.restore("play", "redo");
    assert.equal(redone.rejects, undefined, "the redo is taken");
    let now = h.actor.committed.state;
    assert.deepEqual([now.tokens[g]!.sceneId, number(now, g), now.tokens[g]!.notes], [b, 4, "limps"]);
    const undone = await dm.restore("play", "undo");
    assert.equal(undone.rejects, undefined, "the next undo is taken");
    now = h.actor.committed.state;
    assert.deepEqual([now.tokens[g]!.sceneId, number(now, g), now.tokens[g]!.notes], [a, 2, "limps"]);
  });
});
