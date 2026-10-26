import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Konva from "konva";
import { liftToDragLayer, returnHome } from "./dragLayer.ts";

function relief(ids: string[]): { ground: Konva.Group; nodes: Map<string, Konva.Group> } {
  const ground = new Konva.Group();
  const nodes = new Map<string, Konva.Group>();
  for (const id of ids) {
    const n = new Konva.Group({ id });
    nodes.set(id, n);
    ground.add(n);
  }
  return { ground, nodes };
}

const order = (g: Konva.Container) => g.getChildren().map((n) => n.id());

describe("the drag layer (docs/design-v1-isometric-view.md 6.3)", () => {
  test("a group of 4 goes into the drag layer in its draw order, and each comes back to its place", () => {
    const { ground, nodes } = relief(["wall1", "a", "col", "b", "c", "wall2", "d", "e"]);
    const drag = new Konva.Group();
    const moving = ["d", "b", "a", "c"].map((id) => nodes.get(id)!);
    const homes = liftToDragLayer(drag, moving);
    assert.deepEqual(order(drag), ["a", "b", "c", "d"]);
    assert.deepEqual(order(ground), ["wall1", "col", "wall2", "e"]);
    returnHome(homes);
    assert.deepEqual(order(ground), ["wall1", "a", "col", "b", "c", "wall2", "d", "e"]);
    assert.deepEqual(order(drag), []);
    // Twice is once: a drop and a cancel may both ask.
    returnHome(homes);
    assert.deepEqual(order(ground), ["wall1", "a", "col", "b", "c", "wall2", "d", "e"]);
  });

  test("neighbors that came and went during the drag: each goes back beside one still there", () => {
    const { ground, nodes } = relief(["p", "q", "rider", "mount", "s"]);
    const drag = new Konva.Group();
    const homes = liftToDragLayer(drag, [nodes.get("mount")!, nodes.get("rider")!]);
    // Meanwhile q is culled away and a new piece comes in before s.
    nodes.get("q")!.destroy();
    const fresh = new Konva.Group({ id: "fresh" });
    ground.add(fresh);
    fresh.zIndex(1);
    returnHome(homes);
    // Each before the nearest sibling that followed it and is still there, in the order they drew.
    assert.deepEqual(order(ground), ["p", "fresh", "rider", "mount", "s"]);
  });

  test("its old index no longer means its place: it goes back beside the neighbors it had", () => {
    const { ground, nodes } = relief(["a", "b", "c", "x", "d"]);
    const drag = new Konva.Group();
    const homes = liftToDragLayer(drag, [nodes.get("x")!]);
    nodes.get("a")!.destroy();
    nodes.get("b")!.destroy();
    returnHome(homes);
    assert.deepEqual(order(ground), ["c", "x", "d"], "before the one that followed it");
    const second = relief(["a", "x", "b", "c"]);
    const back = liftToDragLayer(drag, [second.nodes.get("x")!]);
    second.nodes.get("b")!.destroy();
    second.nodes.get("c")!.destroy();
    const fresh = new Konva.Group({ id: "fresh" });
    second.ground.add(fresh);
    fresh.zIndex(0);
    returnHome(back);
    assert.deepEqual(order(second.ground), ["fresh", "a", "x"], "after the one that preceded it, when none that followed is left");
  });

  test("a node already back, or gone with its token, stays as it is", () => {
    const { ground, nodes } = relief(["a", "b", "c"]);
    const drag = new Konva.Group();
    const homes = liftToDragLayer(drag, [nodes.get("b")!]);
    nodes.get("b")!.destroy();
    returnHome(homes);
    assert.deepEqual(order(ground), ["a", "c"]);
  });
});
