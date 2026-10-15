import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useLowPower } from "../features/device/settings.ts";
import { Pill } from "../features/measure/Pill.tsx";
import { footprint, type ViewToken } from "../lib/scene.ts";
import { approach } from "../state/ephemeral.ts";
import type { DragPreview } from "../state/types.ts";
import { useRoomView } from "../state/view.ts";
import { dragTag } from "./dragTag.ts";
import { TokenGhost } from "./TokenNode.tsx";

/**
 * Other members' token drags (design sections 7.6 and 13.3), drawn on the
 * tokens layer, under the fog, so a creature dragged into the dark stays
 * hidden there even between the server's checks.
 *
 * Each ghost carries a tag with the name of who is dragging it, in their
 * color (dragTag.ts). It is drawn here with the ghost, under the fog, so a
 * tag never shows where a creature in the dark is being moved.
 *
 * Frames arrive at up to 30 a second. Each ghost glides toward the latest
 * one with a short animation loop that stops as soon as it arrives, so a
 * preview at rest costs nothing (design 14.2). In low power
 * (docs/design-v1-dm-tools.md 3.15) it shows each frame as it arrives,
 * with no loop at all.
 */
export const RemoteDrags = memo(function RemoteDrags(props: {
  tokens: readonly ViewToken[];
  scale: number;
  youId: string | null;
  /** The token this device is dragging, which Konva already shows under the finger. */
  draggingId: string | null;
}) {
  const drags = useRoomView((s) => s.ephemeral.drags);
  const members = useRoomView((s) => s.view?.members);
  const byId = useMemo(() => new Map(props.tokens.map((t) => [t.id, t])), [props.tokens]);
  const list = Object.entries(drags);
  if (list.length === 0) return null;
  return (
    <>
      {list.map(([key, drag]) => {
        const token = byId.get(drag.tokenId);
        if (!token || drag.tokenId === props.draggingId) return null;
        // Another device of this same member shows as a ghost too, which is what that person sees on the table.
        const tag = dragTag(drag.from, members);
        return <Ghost key={key} drag={drag} token={token} scale={props.scale} color={tag.color} name={tag.text} />;
      })}
    </>
  );
});

function Ghost(props: { drag: DragPreview; token: ViewToken; scale: number; color: string; name: string }) {
  const { drag, token, scale, color } = props;
  const [eased, setShown] = useState(() => ({ x: drag.x, y: drag.y }));
  const shownRef = useRef(eased);
  const frameRef = useRef(0);
  const lowPower = useLowPower();
  const shown = lowPower ? { x: drag.x, y: drag.y } : eased;

  useEffect(() => {
    const target = { x: drag.x, y: drag.y };
    if (lowPower) {
      shownRef.current = target;
      return;
    }
    let last = performance.now();
    const step = (now: number) => {
      const next = approach(shownRef.current, target, now - last);
      last = now;
      shownRef.current = { x: next.x, y: next.y };
      setShown(shownRef.current);
      frameRef.current = next.done ? 0 : requestAnimationFrame(step);
    };
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [drag.x, drag.y, lowPower]);

  return (
    <>
      <TokenGhost token={token} x={shown.x} y={shown.y} scale={scale} color={color} />
      <Pill x={shown.x + footprint(token).w / 2} y={shown.y - 4 / scale} scale={scale} name={props.name} size="map" color={color} small above />
    </>
  );
}
