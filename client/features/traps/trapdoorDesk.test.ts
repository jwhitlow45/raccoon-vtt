import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GROUND, UPPER, tower, trapdoor } from "#shared/floorLinksTestutil.ts";
import { didLines } from "./desk.ts";

/*
 * A trapdoor's line on the DM's card (docs/design/design-v1-floors.md phase
 * 4, 4.6): its opening is the pit's place in the line's outcomes, and it
 * drops what stood on it to the floor below, so it names that floor rather
 * than a pit.
 */

describe("a trapdoor's outcome on the DM's card", () => {
  test("opened onto the floor below, by its name", () => {
    const s = tower();
    assert.deepEqual(didLines(trapdoor("td1", { sceneId: UPPER }), [{ action: -1, ok: true }], s, new Map()), ["Opened the trapdoor onto Ground floor."]);
  });

  test("on the lowest floor it says there is none below, and anywhere else it fails plainly", () => {
    const s = tower();
    assert.deepEqual(didLines(trapdoor("td1", { sceneId: GROUND }), [{ action: -1, ok: false }], s, new Map()), ["Could not open the trapdoor: there is no floor below Ground floor."]);
    assert.deepEqual(didLines(trapdoor("td1", { sceneId: UPPER }), [{ action: -1, ok: false }], s, new Map()), ["Could not open the trapdoor."]);
  });

  test("a pit keeps its own words", () => {
    const s = tower();
    const pit = trapdoor("p1", { sceneId: UPPER });
    const { below: _below, ...rig } = pit.rig!;
    assert.deepEqual(didLines({ ...pit, rig: { ...rig, pit: { floor: -10 } } }, [{ action: -1, ok: true }], s, new Map()), ["Opened the pit."]);
  });
});
