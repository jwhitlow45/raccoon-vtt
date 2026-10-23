import { memo } from "react";
import { Ellipse, Group } from "react-konva";
import { useStore } from "zustand";
import { TokenGhost } from "../../canvas/TokenNode.tsx";
import { boardSizes } from "../../lib/boardScale.ts";
import { footprint, type ViewToken } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { BoardLabel } from "./boardText.tsx";
import { holdLabel, type Point } from "./drop.ts";
import { holdSlot, stopNoteSlot } from "./store.ts";
import { useTeleportToasts } from "./toasts.ts";

/**
 * Walls and ledges on the overlay layer (docs/design-v1-maps-vision.md
 * 4.1): while a drag is held at a wall or a ledge, a red outline round the
 * spot it stays on and a label naming what is in the way, and after a
 * stopped drop, a faint ghost of the token where the player dropped it.
 * Both are of a token this member is moving, which they see, so they may
 * draw above the fog. Nothing here moves at rest.
 *
 * The board is always on screen in a room, so the DM's teleport toasts
 * (toasts.ts) run from here too.
 */
export const MoveLayer = memo(function MoveLayer(props: LayerProps) {
  useTeleportToasts(props.role);
  const hold = useStore(useScoped(holdSlot), (s) => s.hold);
  const note = useStore(useScoped(stopNoteSlot), (s) => s.note);
  const held = useRoomView((s) => (hold ? s.view?.tokens[hold.tokenId] : undefined));
  const ghosted = useRoomView((s) => (note ? s.view?.tokens[note.tokenId] : undefined));
  return (
    <>
      {note && ghosted && note.sceneId === props.scene.id ? (
        <Group opacity={0.6} listening={false}>
          <TokenGhost token={ghosted} x={note.ghost.x} y={note.ghost.y} scale={props.scale} color={theme.color.danger} />
        </Group>
      ) : null}
      {hold && held && held.sceneId === props.scene.id ? <HoldMark token={held} at={hold.at} scale={props.scale} text={holdLabel(hold.blocker, hold.noWay === true)} /> : null}
    </>
  );
});

/**
 * The hold mark's ring and label in screen px at a zoom. The ring is drawn
 * as a selected token's is (canvas/TokenNode.tsx Outline): it grows with
 * the token's own ring, and never gets thinner than its old 3 px, since it
 * exists to be seen. The label stands where a label over the token would
 * (canvas/tokenMarks.ts aboveY): over the chips and the elevation badge,
 * which the dragged token carries along its top edge and which grow with
 * the zoom and the interface size.
 */
export function holdMarkSizes(scale: number): { ringPx: number; gapPx: number; liftPx: number } {
  const sizes = boardSizes(scale);
  const k = sizes.ringPx / 3;
  return { ringPx: Math.max(3, 3 * k), gapPx: 3 * Math.max(0.5, k), liftPx: Math.max(sizes.chipPx, Math.ceil(sizes.badgeTextPx + 7)) / 2 + sizes.gapPx };
}

/** A red ring a few pixels outside the held token, the way a selected token is ringed, and the label over it. */
function HoldMark(props: { token: ViewToken; at: Point; scale: number; text: string }) {
  const { w, h } = footprint(props.token);
  const sizes = holdMarkSizes(props.scale);
  const gap = sizes.gapPx / props.scale;
  return (
    <Group listening={false}>
      <Ellipse
        x={props.at.x + w / 2}
        y={props.at.y + h / 2}
        radiusX={w / 2 + gap}
        radiusY={h / 2 + gap}
        stroke={theme.color.danger}
        strokeWidth={sizes.ringPx}
        strokeScaleEnabled={false}
      />
      <BoardLabel x={props.at.x + w / 2} y={props.at.y - sizes.liftPx / props.scale} scale={props.scale} text={props.text} color={theme.color.danger} />
    </Group>
  );
}
