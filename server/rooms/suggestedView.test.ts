import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DM, room, scene } from "#shared/testutil.ts";
import { parseRoomState } from "./stateSchema.ts";
import { describeOp } from "./undoLabels.ts";
import { UndoTable } from "./undoTesting.ts";

/** A scene's suggested view in stored state and on the undo stack (docs/design-v1-isometric-view.md 7, lane ISO-1). */
describe("a scene's suggested view, stored and undone", () => {
  const crypt = () => room({ scenes: { s1: scene("s1", { name: "Crypt" }) } });

  test("a room with one loads as it was, a backup from before it has none, and only Isometric is ever stored", () => {
    const parsed = parseRoomState(room({ scenes: { s1: scene("s1", { suggestedView: "isometric" }) } }));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.equal(parsed.state.scenes.s1!.suggestedView, "isometric");
    const old = parseRoomState(crypt());
    assert.ok(old.ok);
    assert.ok(!("suggestedView" in old.state.scenes.s1!));
    for (const bad of ["topDown", "iso", 1]) {
      const s = crypt();
      (s.scenes.s1 as unknown as Record<string, unknown>).suggestedView = bad;
      assert.equal(parseRoomState(s).ok, false, String(bad));
    }
  });

  test("its undo step is named, and only when the patch holds nothing else", () => {
    const state = crypt();
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { suggestedView: "isometric" } }, state), "changing the suggested view of the scene Crypt");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { suggestedView: "topDown" } }, state), "changing the suggested view of the scene Crypt");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { suggestedView: "topDown", name: "Tomb" } }, state), "changing the scene Crypt");
  });

  test("undo takes it back and redo puts it again, each way", () => {
    const table = new UndoTable(crypt());
    assert.equal(table.play(DM, { t: "scene.update", sceneId: "s1", patch: { suggestedView: "isometric" } }), "ok");
    assert.equal(table.undo(DM), "ok");
    assert.ok(!("suggestedView" in table.state.scenes.s1!));
    assert.equal(table.redo(DM), "ok");
    assert.equal(table.state.scenes.s1!.suggestedView, "isometric");
    assert.equal(table.play(DM, { t: "scene.update", sceneId: "s1", patch: { suggestedView: "topDown" } }), "ok");
    assert.ok(!("suggestedView" in table.state.scenes.s1!));
    assert.equal(table.undo(DM), "ok");
    assert.equal(table.state.scenes.s1!.suggestedView, "isometric", "restored");
  });
});
