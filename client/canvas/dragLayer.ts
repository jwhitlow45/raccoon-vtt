import type Konva from "konva";

/**
 * A local drag in the isometric view moves its nodes into the drag layer
 * (docs/design-v1-isometric-view.md 5.1 and 6.3), so each frame redraws
 * that layer alone and never the relief with its walls and columns. The
 * drag layer's ground group has the relief's transform, so a node keeps its
 * place on screen and its world x and y. react-konva never moves a node to
 * another parent, so each goes back to where it stood among the relief's
 * children, which is the depth order React last laid out, before React
 * next lays out those tokens.
 */

/** The drag layer's ground group, by name (relief/IsoBoard.tsx). */
export const DRAG_GROUND = "dragGround";

/** Where a node stood before the drag: its parent, the siblings after it in order, those before it nearest first, and its index. */
export type Home = { node: Konva.Node; parent: Konva.Container; after: readonly Konva.Node[]; before: readonly Konva.Node[]; index: number };

/** Moves the nodes into the drag layer's ground group (`target`), in the order they drew, and says where each stood. */
export function liftToDragLayer(target: Konva.Container, nodes: readonly Konva.Node[]): Home[] {
  const homes: Home[] = [];
  for (const node of nodes) {
    const parent = node.getParent();
    if (!parent || parent === target || homes.some((h) => h.node === node)) continue;
    const siblings = parent.getChildren();
    const index = node.zIndex();
    homes.push({ node, parent, after: siblings.slice(index + 1), before: siblings.slice(0, index).reverse(), index });
  }
  homes.sort((a, b) => (a.parent === b.parent ? a.index - b.index : 0));
  for (const h of homes) h.node.moveTo(target);
  if (homes.length > 0) {
    target.getLayer()?.batchDraw();
    homes[0]!.parent.getLayer()?.batchDraw();
  }
  return homes;
}

/**
 * Puts each node back where it stood: before the nearest sibling that
 * followed it and is still there, or after the nearest that preceded it,
 * or at its old index when none is. Twice is the same as once, so a drop
 * and a cancel may both ask.
 */
export function returnHome(homes: readonly Home[]): void {
  let moved: Konva.Layer | null = null;
  for (const h of homes) {
    const { node, parent } = h;
    // A node gone with its token, or already home, stays as it is.
    if (!node.getParent() || node.getParent() === parent) continue;
    moved ??= node.getLayer();
    parent.add(node as Konva.Group);
    const there = (n: Konva.Node) => n !== node && n.getParent() === parent;
    const next = h.after.find(there);
    const prev = next ? undefined : h.before.find(there);
    if (next) node.zIndex(next.zIndex());
    else if (prev) node.zIndex(prev.zIndex() + 1);
    else node.zIndex(Math.min(h.index, parent.getChildren().length - 1));
  }
  if (moved) {
    moved.batchDraw();
    homes[0]!.parent.getLayer()?.batchDraw();
  }
}
