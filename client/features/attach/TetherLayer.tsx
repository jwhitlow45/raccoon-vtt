import { memo, useMemo } from "react";
import { Line } from "react-konva";
import type { Token } from "#shared/model.ts";
import { useDraggedIds } from "../../canvas/draggedIds.ts";
import { useIsoGround, useTreeShownStore, useTreeShownView } from "../../canvas/relief/context.ts";
import { boardSizes } from "../../lib/boardScale.ts";
import { theme } from "../../lib/theme.ts";
import { DISPOSITION_RING } from "../../lib/tokenView.ts";
import { localDragSlot } from "../../state/localDrags.ts";
import { useScoped } from "../../state/scope.ts";
import type { LayerProps } from "../layers.ts";
import { tethers, type Tether } from "./groups.ts";

const EMPTY: Record<string, Token> = {};
const NO_SPOTS: Readonly<Record<string, { x: number; y: number }>> = {};

/**
 * Who holds whom at the table (docs/design-v1-attach.md 4.4): a thin
 * dashed line from each dragged creature's center to its holder's, in the
 * holder's ring color at half opacity, on the board layer under the
 * tokens. It is drawn again only when the tokens change or a drag on this
 * device crosses into another cell (state/localDrags.ts), and never
 * animates.
 *
 * In Isometric the tethers lie on the ground stage under the fog, and one
 * with an end on a token being dragged leaves it for the drag's moving
 * marks until the drop (canvas/DragMarks.tsx), so a drag never redraws the
 * ground (docs/design-v1-isometric-view.md 5.1).
 *
 * The DM's falling off reminder (4.5) runs in the board's tether controller
 * (TetherController.ts), mounted once outside both drawing trees
 * (docs/design-v1-isometric-view.md 5.1).
 */
export const TetherLayer = memo(function TetherLayer(props: LayerProps) {
  const iso = useIsoGround();
  const tokens = useTreeShownView((s) => s.view?.tokens ?? EMPTY);
  // The isometric ground reads where tokens stand: what a drag moves is the drag's own.
  const spots = useTreeShownStore(useScoped(localDragSlot), (s) => (iso ? NO_SPOTS : s.spots));
  const dragged = useDraggedIds();
  const lines = useMemo(() => {
    const all = tethers(tokens, props.scene.id, (t) => spots[t.id] ?? t);
    return iso ? all.filter((l) => !dragged.all.has(l.id) && !dragged.all.has(l.holderId)) : all;
  }, [tokens, props.scene.id, spots, iso, dragged]);
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((l) => (
        <TetherLine key={l.id} line={l} holder={tokens[l.holderId]} scale={props.scale} />
      ))}
    </>
  );
});

/** One tether, its points and dash kept while the line and the zoom are the same, so a render for anything else redraws nothing. */
export const TetherLine = memo(function TetherLine(props: { line: Tether; holder: Token | undefined; scale: number }) {
  const { line: l, holder, scale } = props;
  const px = Math.max(1.5, boardSizes(scale).ringPx / 2);
  const points = useMemo(() => [l.from.x, l.from.y, l.to.x, l.to.y], [l.from.x, l.from.y, l.to.x, l.to.y]);
  const dash = useMemo(() => [(6 * px) / scale, (4 * px) / scale], [px, scale]);
  return (
    <Line
      points={points}
      stroke={holder ? DISPOSITION_RING[holder.disposition] : theme.color.neutral}
      opacity={0.5}
      strokeWidth={px}
      strokeScaleEnabled={false}
      dash={dash}
      lineCap="round"
      listening={false}
    />
  );
});
