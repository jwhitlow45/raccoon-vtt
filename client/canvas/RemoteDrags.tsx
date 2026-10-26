import { memo, useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useLowPower } from "../features/device/settings.ts";
import { Pill } from "../features/measure/Pill.tsx";
import type { ViewToken } from "../lib/scene.ts";
import { approach } from "../state/ephemeral.ts";
import type { DragPreview } from "../state/types.ts";
import { useRoomView } from "../state/view.ts";
import { dragTag, dragTagPill } from "./dragTag.ts";
import { TokenGhost, type IsoToken } from "./TokenNode.tsx";
import { useTreeShown } from "./relief/context.ts";

const NO_DRAGS: Readonly<Record<string, DragPreview>> = {};

/**
 * Other members' token drags (design sections 7.6 and 13.3). In Top-down
 * they draw on the tokens layer, under the fog, so a creature dragged into
 * the dark stays hidden there even between the server's checks. In
 * Isometric they draw in the drag layer over everything, so the stand rule
 * judges each frame instead (`iso`, docs/design-v1-isometric-view.md 5.2):
 * a ghost stands only where all of it is revealed, and otherwise lies flat,
 * clipped to the revealed sub-cells.
 *
 * Each ghost carries a tag with the name of who is dragging it, in their
 * color (dragTag.ts). In Top-down it is drawn here with the ghost, under
 * the fog, so a tag never shows where a creature in the dark is being
 * moved. In Isometric it stands only where the whole pill Top-down would
 * draw is revealed.
 *
 * Frames arrive at up to 30 a second. Each ghost glides toward the latest
 * one, eased by the one clock (RemoteDragClock), which stops as soon as
 * every ghost arrives, so a preview at rest costs nothing (design 14.2). In
 * low power (docs/design-v1-dm-tools.md 3.15) it shows each frame as it
 * arrives, with no loop at all.
 */
export const RemoteDrags = memo(function RemoteDrags(props: {
  tokens: readonly ViewToken[];
  scale: number;
  youId: string | null;
  /** The token this device is dragging, which Konva already shows under the finger. */
  draggingId: string | null;
  /** Where each ghost stands now, eased by the one clock (RemoteDragClock). */
  eased: EasedDrags;
  /**
   * In the isometric view: how each ghost draws at its eased spot, standing
   * or flat and clipped by the stand rule (docs/design-v1-isometric-view.md
   * 5.2), and where its tag goes, or null to leave the tag out.
   */
  iso?: ((token: ViewToken, at: { x: number; y: number }, name: string) => IsoGhost) | null;
  /** In the isometric view the ghosts draw in the ground group and their tags in view space, so each place draws its part. */
  part?: "ghost" | "tag";
}) {
  // A hidden tree reads no drags, so its ghosts unmount and nothing there works each frame.
  const shown = useTreeShown();
  const drags = useRoomView((s) => (shown ? s.ephemeral.drags : NO_DRAGS));
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
        return <Ghost key={key} id={key} drag={drag} token={token} scale={props.scale} color={tag.color} name={tag.text} eased={props.eased} iso={props.iso ?? null} part={props.part ?? null} />;
      })}
    </>
  );
});

/** How a ghost draws in the isometric view at one eased spot. */
export type IsoGhost = {
  /** A standee's placing, when it stands. */
  standee: IsoToken | null;
  /** When it lies flat: the revealed sub-cells of its box, the only place it shows. */
  clip: readonly { x: number; y: number; w: number; h: number }[] | null;
  /** Where its tag stands in view units, or null when the tag lies under fog and is left out. */
  tag: { x: number; y: number } | null;
};

/** The eased spot of each other member's drag, by its key in the room's drags. */
export type EasedDrags = StoreApi<Readonly<Record<string, { x: number; y: number }>>>;

export function createEasedDrags(): EasedDrags {
  return createStore<Readonly<Record<string, { x: number; y: number }>>>(() => ({}));
}

/**
 * The one clock that eases every ghost (design section 7.6): frames arrive
 * at up to 30 a second, and each ghost glides toward the latest with a short
 * animation loop that stops once every ghost arrives, so a preview at rest
 * costs nothing (design 14.2). In low power it shows each frame as it
 * arrives, with no loop at all. It draws nothing and mounts once, outside
 * both of the board's drawing trees, which read the store
 * (docs/design-v1-isometric-view.md 5.1).
 */
export function RemoteDragClock(props: { eased: EasedDrags }) {
  const { eased } = props;
  const drags = useRoomView((s) => s.ephemeral.drags);
  const lowPower = useLowPower();
  const frameRef = useRef(0);
  useEffect(() => {
    const targets = new Map(Object.entries(drags).map(([key, d]) => [key, { x: d.x, y: d.y }]));
    const now = eased.getState();
    const start: Record<string, { x: number; y: number }> = {};
    // A new drag starts where its first frame is. One that ended is dropped.
    for (const [key, target] of targets) start[key] = lowPower ? target : (now[key] ?? target);
    eased.setState(start, true);
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    if (lowPower) return;
    let last = performance.now();
    const step = (time: number) => {
      const dt = time - last;
      last = time;
      const prev = eased.getState();
      const next: Record<string, { x: number; y: number }> = {};
      let moving = false;
      for (const [key, target] of targets) {
        const was = prev[key] ?? target;
        const p = approach(was, target, dt);
        next[key] = was.x === p.x && was.y === p.y ? was : { x: p.x, y: p.y };
        if (!p.done) moving = true;
      }
      eased.setState(next, true);
      frameRef.current = moving ? requestAnimationFrame(step) : 0;
    };
    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [drags, lowPower, eased]);
  return null;
}

function Ghost(props: {
  id: string;
  drag: DragPreview;
  token: ViewToken;
  scale: number;
  color: string;
  name: string;
  eased: EasedDrags;
  iso: ((token: ViewToken, at: { x: number; y: number }, name: string) => IsoGhost) | null;
  part: "ghost" | "tag" | null;
}) {
  const { drag, token, scale, color } = props;
  const eased = useStore(props.eased, (s) => s[props.id]);
  // Low power shows each frame as it arrives, with no wait for the clock's store.
  const lowPower = useLowPower();
  const shown = lowPower || !eased ? { x: drag.x, y: drag.y } : eased;
  if (props.iso) {
    const ghost = props.iso(token, shown, props.name);
    if (props.part === "tag") return ghost.tag ? <Pill x={ghost.tag.x} y={ghost.tag.y - 4 / scale} scale={scale} name={props.name} size="map" color={color} small above /> : null;
    return <TokenGhost token={token} x={shown.x} y={shown.y} scale={scale} color={color} iso={ghost.standee} clip={ghost.clip} />;
  }
  return (
    <>
      <TokenGhost token={token} x={shown.x} y={shown.y} scale={scale} color={color} />
      <Pill {...dragTagPill(token, shown, props.name, scale)} color={color} />
    </>
  );
}
