import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dmNumbered, lineAudience } from "#shared/logRings.ts";
import type { RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, P2, entry, room, template, token } from "#shared/testutil.ts";
import { UndoTable } from "./undoTesting.ts";

/**
 * Undo and redo across the log's rings (shared/logRings.ts): a player's
 * move into an area players see and one hidden from them, taken back and
 * done again, through the room actor's own steps. The rooms differ only in
 * where the hidden area stands, so every player gets the same answers and
 * the same copy, log included, at every step, and only the DM's log holds
 * the hidden reminder, numbered with the DM's lines.
 */
function fight(glyphX: number): UndoTable {
  const state = room();
  state.tokens.hero = token("hero", { kind: "pc", name: "Ayla", x: 2, y: 5, ownerIds: ["p1"], disposition: "ally" });
  // Its id sorts first, so its reminder is written before the visible one's in the same op.
  state.templates.aglyph = template("aglyph", { shape: "sphere", size: 10, origin: { x: glyphX, y: 5.5, z: 0 }, spell: "Glyph of Warding", visibility: "dm", ownerId: "dm1", triggers: ["enter"] });
  state.templates.web = template("web", { shape: "cube", size: 10, origin: { x: 6, y: 5, z: 0 }, spell: "Web", ownerId: "p2", triggers: ["enter"] });
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: "e-hero",
    entries: [entry("e-hero", { tokenId: "hero", value: 15 })],
    turnStart: { entryId: "e-hero", tokenId: "hero", sceneId: "s1", x: 2, y: 5, elevation: 0, seen: true, seq: 1 },
  };
  const table = new UndoTable(state);
  table.seq = 1;
  return table;
}

const seen = (state: RoomState) => [P1, P2].map((p) => projectState(state, p, { sceneId: "s1" }));

describe("undo and redo across the log's rings", () => {
  test("a move that wrote a hidden reminder undoes and redoes as one that wrote none, for every player", () => {
    const away = fight(9.5);
    const into = fight(6.5);
    const steps: [string, (t: UndoTable) => string][] = [
      ["move", (t) => t.play(P1, { t: "token.move", tokenId: "hero", x: 6, y: 5 })],
      ["undo", (t) => t.undo(P1)],
      ["redo", (t) => t.redo(P1)],
      ["undo again", (t) => t.undo(P1)],
    ];
    for (const [name, step] of steps) {
      assert.equal(step(away), "ok", `${name}, glyph away`);
      assert.equal(step(into), "ok", `${name}, glyph on the way`);
      assert.deepEqual(seen(into.state), seen(away.state), `${name}: a player's copy differs`);
    }
    const areas = (t: UndoTable) => t.state.log.filter((e) => e.data?.type === "area").map((e) => [e.id, lineAudience(e)]);
    assert.deepEqual(areas(away), [["2:0", "shared"]]);
    assert.deepEqual(areas(into), [["2:0", "shared"], ["2:900000", "dm"]], "the hidden reminder counts with the DM's lines, so Web's line keeps its id");
    assert.ok(projectState(into.state, DM, { sceneId: "s1" }).log.some((e) => dmNumbered(e.id)));
    assert.deepEqual(into.state.tokens.hero!.x, 2, "the last undo put the hero back");
  });
});
