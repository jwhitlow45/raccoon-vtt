import { memo, useMemo } from "react";
import { Line } from "react-konva";
import { useStore } from "zustand";
import type { Token } from "#shared/model.ts";
import { boardSizes } from "../../lib/boardScale.ts";
import { theme } from "../../lib/theme.ts";
import { DISPOSITION_RING } from "../../lib/tokenView.ts";
import { localDragSlot } from "../../state/localDrags.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { tethers } from "./groups.ts";

const EMPTY: Record<string, Token> = {};

/**
 * Who holds whom at the table (docs/design-v1-attach.md 4.4): a thin
 * dashed line from each dragged creature's center to its holder's, in the
 * holder's ring color at half opacity, on the board layer under the
 * tokens. It is drawn again only when the tokens change or a drag on this
 * device crosses into another cell (state/localDrags.ts), and never
 * animates.
 *
 * The DM's falling off reminder (4.5) runs in the board's tether controller
 * (TetherController.ts), mounted once outside both drawing trees
 * (docs/design-v1-isometric-view.md 5.1).
 */
export const TetherLayer = memo(function TetherLayer(props: LayerProps) {
  const tokens = useRoomView((s) => s.view?.tokens ?? EMPTY);
  const spots = useStore(useScoped(localDragSlot), (s) => s.spots);
  const lines = useMemo(() => tethers(tokens, props.scene.id, (t) => spots[t.id] ?? t), [tokens, props.scene.id, spots]);
  if (lines.length === 0) return null;
  const px = Math.max(1.5, boardSizes(props.scale).ringPx / 2);
  return (
    <>
      {lines.map((l) => {
        const holder = tokens[l.holderId];
        return (
          <Line
            key={l.id}
            points={[l.from.x, l.from.y, l.to.x, l.to.y]}
            stroke={holder ? DISPOSITION_RING[holder.disposition] : theme.color.neutral}
            opacity={0.5}
            strokeWidth={px}
            strokeScaleEnabled={false}
            dash={[(6 * px) / props.scale, (4 * px) / props.scale]}
            lineCap="round"
            listening={false}
          />
        );
      })}
    </>
  );
});
