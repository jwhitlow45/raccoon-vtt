import { memo, useMemo } from "react";
import { Line } from "react-konva";
import { useStore } from "zustand";
import type { Token } from "#shared/model.ts";
import { boardSizes } from "../../lib/boardScale.ts";
import { theme } from "../../lib/theme.ts";
import { localDragSlot } from "../../state/localDrags.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { tethers } from "./groups.ts";
import { useFallReminders } from "./useFallReminders.ts";

const EMPTY: Record<string, Token> = {};

const RING: Record<Token["disposition"], string> = { ally: theme.color.ally, neutral: theme.color.neutral, hostile: theme.color.hostile };

/**
 * Who holds whom at the table (docs/design-v1-attach.md 4.4): a thin
 * dashed line from each dragged creature's center to its holder's, in the
 * holder's ring color at half opacity, on the board layer under the
 * tokens. It is drawn again only when the tokens change or a drag on this
 * device crosses into another cell (state/localDrags.ts), and never
 * animates.
 *
 * The board always holds this layer, so the DM's falling off reminder
 * (4.5) listens from here, as the area reminders do from theirs.
 */
export const TetherLayer = memo(function TetherLayer(props: LayerProps) {
  useFallReminders();
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
            stroke={holder ? RING[holder.disposition] : theme.color.neutral}
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
