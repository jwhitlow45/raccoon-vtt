import { useMemo } from "react";
import type { DragPreview } from "../state/types.ts";
import { localDragSlot } from "../state/localDrags.ts";
import { useScoped } from "../state/scope.ts";
import { useTreeShownStore, useTreeShownView } from "./relief/context.ts";

/**
 * The tokens being dragged now, whose range rings, attached areas and
 * tethers leave the isometric view's ground stage for the drag's moving
 * marks until the drop (docs/design-v1-isometric-view.md 5.1, DragMarks.tsx):
 * this device's own, by the spots the canvas writes for them
 * (state/localDrags.ts), and other members', by the room's drag previews,
 * an ended one included while it holds the drop point. Each list sorted,
 * and a token this device drags is never in the remote list.
 */
export type DraggedIds = { local: readonly string[]; remote: readonly string[]; all: ReadonlySet<string> };

export function draggedIds(spots: Readonly<Record<string, unknown>>, drags: Readonly<Record<string, Pick<DragPreview, "tokenId">>>): DraggedIds {
  const local = Object.keys(spots).sort();
  const mine = new Set(local);
  const remote = [...new Set(Object.values(drags).map((d) => d.tokenId))].filter((id) => !mine.has(id)).sort();
  return { local, remote, all: new Set([...local, ...remote]) };
}

const NONE: DraggedIds = { local: [], remote: [], all: new Set() };

/** The dragged tokens, read as keys of ids so a drag's every frame renders nothing while the set stays the same. Held while the tree is hidden. */
export function useDraggedIds(): DraggedIds {
  const local = useTreeShownStore(useScoped(localDragSlot), (s) => Object.keys(s.spots).sort().join(" "));
  const remote = useTreeShownView((s) => [...new Set(Object.values(s.ephemeral.drags).map((d) => d.tokenId))].sort().join(" "));
  return useMemo(() => {
    if (!local && !remote) return NONE;
    const spots = Object.fromEntries(local ? local.split(" ").map((id) => [id, true]) : []);
    const drags = Object.fromEntries(remote ? remote.split(" ").map((id) => [id, { tokenId: id }]) : []);
    return draggedIds(spots, drags);
  }, [local, remote]);
}
