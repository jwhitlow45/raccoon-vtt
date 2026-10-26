import { memo } from "react";
import { Ellipse, Group } from "react-konva";
import { Lift, MarkPill } from "../../canvas/IsoParts.tsx";
import { boxGround } from "../../canvas/isoPlace.ts";
import { useIsoGround, useTreeShownStore, useTreeShownView, type IsoGround } from "../../canvas/relief/context.ts";
import { TokenGhost } from "../../canvas/TokenNode.tsx";
import { boardSizes } from "../../lib/boardScale.ts";
import { footprint, type ViewToken } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import type { LayerProps } from "../layers.ts";
import { holdLabel, type Point } from "./drop.ts";
import { holdSlot, stopNoteSlot } from "./store.ts";

/**
 * Walls and ledges on the overlay layer (docs/design-v1-maps-vision.md
 * 4.1): while a drag is held at a wall or a ledge, a red outline round the
 * spot it stays on and a label naming what is in the way, and after a
 * stopped drop, a faint ghost of the token where the player dropped it.
 * Both are of a token this member is moving, which they see, so they may
 * draw above the fog. Nothing here moves at rest.
 *
 * In Isometric both draw in the drag layer on the ground at the drawn
 * height under the token, the label standing over the ring
 * (docs/design-v1-isometric-view.md 5.3).
 *
 * The DM's teleport toasts (toasts.ts) run as one of the board's
 * controllers, mounted once whichever view shows.
 */
export const MoveLayer = memo(function MoveLayer(props: LayerProps) {
  const hold = useTreeShownStore(useScoped(holdSlot), (s) => s.hold);
  const note = useTreeShownStore(useScoped(stopNoteSlot), (s) => s.note);
  const held = useTreeShownView((s) => (hold ? s.view?.tokens[hold.tokenId] : undefined));
  const ghosted = useTreeShownView((s) => (note ? s.view?.tokens[note.tokenId] : undefined));
  const iso = useIsoGround();
  return (
    <>
      {note && ghosted && note.sceneId === props.scene.id ? (
        <Lift z={iso ? groundUnder(iso, ghosted, note.ghost) : 0}>
          <Group opacity={0.6} listening={false}>
            <TokenGhost token={ghosted} x={note.ghost.x} y={note.ghost.y} scale={props.scale} color={theme.color.danger} />
          </Group>
        </Lift>
      ) : null}
      {hold && held && held.sceneId === props.scene.id ? <HoldMark token={held} at={hold.at} scale={props.scale} text={holdLabel(hold.blocker, hold.noWay === true)} iso={iso} /> : null}
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

/** The drawn ground under a token's footprint at a spot, where its marks stand in Isometric. */
function groundUnder(iso: IsoGround, token: ViewToken, at: Point): number {
  const { w, h } = footprint(token);
  return boxGround(iso, { x0: at.x, y0: at.y, x1: at.x + w, y1: at.y + h });
}

/**
 * A red ring a few pixels outside the held token, the way a selected token
 * is ringed, and the label over it (movement/boardText.tsx BoardLabel's
 * pill). In Isometric the ring lies on the ground and the label stands over
 * the ring's far edge, the ring's half height in view units being about an
 * eighth of the footprint's width and height together.
 */
function HoldMark(props: { token: ViewToken; at: Point; scale: number; text: string; iso: IsoGround | null }) {
  const { w, h } = footprint(props.token);
  const sizes = holdMarkSizes(props.scale);
  const gap = sizes.gapPx / props.scale;
  const z = props.iso ? groundUnder(props.iso, props.token, props.at) : 0;
  const label = props.iso
    ? { x: props.at.x + w / 2, y: props.at.y + h / 2, offsetPx: sizes.liftPx + ((w + h) / 8) * props.scale }
    : { x: props.at.x + w / 2, y: props.at.y - sizes.liftPx / props.scale };
  return (
    <Group listening={false}>
      <Lift z={z}>
        <Ellipse
          x={props.at.x + w / 2}
          y={props.at.y + h / 2}
          radiusX={w / 2 + gap}
          radiusY={h / 2 + gap}
          stroke={theme.color.danger}
          strokeWidth={sizes.ringPx}
          strokeScaleEnabled={false}
        />
      </Lift>
      <MarkPill {...label} z={z} scale={props.scale} value={props.text} size="screen" color={theme.color.danger} small above />
    </Group>
  );
}
