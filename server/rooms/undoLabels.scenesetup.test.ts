import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { ClientOp, RestoreEntry } from "#shared/protocol.ts";
import { apply, room, scene } from "#shared/testutil.ts";
import { UndoStacks } from "./undo.ts";
import { describeOp, tallyOf } from "./undoLabels.ts";

/** Scene setup's undo names (docs/design-v1-map-discovery.md 8.1 and 8.3, lane MS1). */

const inverse = (n: number): RestoreEntry[] => [{ key: `scene:x${n}`, value: null, expectRev: n }];
const copy = { fogEnabled: true, vision: { on: true, light: "dark" as const, perPlayer: false } };

/** Pushes each op as the actor does, on the state before it, under one group, and gives back the step's name. */
function stepName(start: RoomState, ops: ClientOp[], group: string | undefined = "g"): string | undefined {
  const s = new UndoStacks();
  let state = start;
  ops.forEach((op, i) => {
    s.push("dm", inverse(i + 1), describeOp(op, state), group, undefined, undefined, tallyOf(op, state));
    state = apply(state, op);
  });
  return s.popUndo("dm")?.label;
}

describe("undo step labels, scene setup", () => {
  const rooms = (extra: Record<string, ReturnType<typeof scene>> = {}) =>
    room({
      scenes: {
        s1: scene("s1", { name: "Crypt", fogEnabled: true, vision: { on: true, light: "dark" } }),
        s2: scene("s2", { name: "Hall", order: 1 }),
        s3: scene("s3", { name: "Tomb", order: 2 }),
        s4: scene("s4", { name: "Town", order: 3, fogEnabled: true }),
        ...extra,
      },
    });
  const to = (sceneId: string): ClientOp => ({ t: "scene.update", sceneId, patch: copy });

  test("the copy is one step named for its source and how many scenes it went to", () => {
    assert.equal(stepName(rooms(), [to("s2"), to("s3"), to("s4")]), "using Crypt's vision settings on 3 scenes");
    assert.equal(stepName(rooms(), [to("s2")]), "using Crypt's vision settings on the scene Hall");
  });

  test("a step whose source cannot be told apart from another scene with the same settings says only what it did", () => {
    const twin = { s5: scene("s5", { name: "Vault", order: 4, fogEnabled: true, vision: { on: true, light: "dark" } }) };
    assert.equal(stepName(rooms(twin), [to("s2"), to("s3")]), "copying vision settings to 2 scenes");
    // A twin the copy goes to is no longer a possible source.
    assert.equal(stepName(rooms(twin), [to("s2"), to("s5")]), "using Crypt's vision settings on 2 scenes");
  });

  test("other patches are no copy, and a group mixing a copy with something else keeps its first op's phrase", () => {
    const state = rooms();
    assert.equal(tallyOf({ t: "scene.update", sceneId: "s2", patch: { fogEnabled: true, vision: { on: true, light: "dark" } } }, state), undefined, "Players see names no Sight");
    assert.equal(tallyOf({ t: "scene.update", sceneId: "s2", patch: { vision: { on: true, light: "dark", perPlayer: true } } }, state), undefined, "the Sight row names no fog");
    assert.equal(tallyOf({ t: "scene.update", sceneId: "s2", patch: { ...copy, name: "x" } }, state), undefined);
    const other: ClientOp = { t: "scene.update", sceneId: "s3", patch: { ...copy, vision: { ...copy.vision, light: "dim" } } };
    assert.equal(stepName(state, [to("s2"), other]), "turning on party vision on the scene Hall");
  });

  test("Players see names the choice it went to", () => {
    const state = rooms();
    assert.equal(describeOp({ t: "scene.update", sceneId: "s2", patch: { fogEnabled: true, vision: { on: true, light: "bright" } } }, state), "setting Players see on the scene Hall to Explore");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { fogEnabled: true, vision: { on: false, light: "dark" } } }, state), "setting Players see on the scene Crypt to Reveal by hand");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s4", patch: { fogEnabled: false, vision: { on: false, light: "bright" } } }, state), "setting Players see on the scene Town to Everything");
    // The Party vision switch alone keeps its own words.
    assert.equal(describeOp({ t: "scene.update", sceneId: "s2", patch: { vision: { on: true, light: "bright" } } }, state), "turning on party vision on the scene Hall");
  });
});
