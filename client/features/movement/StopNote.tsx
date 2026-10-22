import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { BuildChunk, FogTile, Scene } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { PaneHeader } from "../../components/SheetHeader.tsx";
import { worldToScreen, type Camera, type Insets, type Size } from "../../lib/camera.ts";
import { footprint } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { noteDoor } from "../doors/doors.ts";
import { cardPlace } from "./anchor.ts";
import { dropView, stopText } from "./drop.ts";
import { stopNoteSlot } from "./store.ts";
import { runTeleport } from "./teleport.ts";

const NO_CHUNKS: Readonly<Record<string, BuildChunk>> = {};
const NO_FOG: Readonly<Record<string, FogTile>> = {};
const WIDTH = 288;
/** The note's height until it has been laid out and measured. */
const UNMEASURED = 112;

/**
 * The note after a stopped drop (docs/design-v1-maps-vision.md 4.1), beside
 * the ghost that marks where the player dropped the token: what stopped the
 * walk, and "Teleport here" for Misty Step and anything else that passes
 * walls or ledges. It goes when the player closes it, the teleport is done,
 * the token is dragged again, or the token stands anywhere else than where
 * its walk stopped, since the note is about that walk. While a token's
 * action bar is open it steps aside, so one card floats over the map at a
 * time, and it comes back when the bar closes. The stopped drop itself
 * closes the bar (send.ts), so the note wins after a drag.
 */
export function StopNoteHost(props: { scene: Scene; camera: Camera; viewport: Size; insets: Insets }) {
  const slot = useScoped(stopNoteSlot);
  const note = useStore(slot, (s) => s.note);
  const busy = useStore(slot, (s) => s.busy);
  const token = useRoomView((s) => (note ? s.view?.tokens[note.tokenId] : undefined));
  const barOpen = useRoomView((s) => s.local.actionBar && s.local.selectedId !== null);
  const chunks = useRoomView((s) => s.view?.buildChunks ?? NO_CHUNKS);
  // The fog a door tap is held to (doors/tap.ts), so the note names only a door the player can tap.
  const fog = useRoomView((s) => (s.you?.role === "player" && props.scene.fogEnabled !== false ? (s.view?.fogTiles ?? NO_FOG) : null));
  const actions = useRoomActions();
  const ui = useRoomUi();
  const store = useRoomStore();
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(UNMEASURED);

  const stale = note !== null && (!token || token.sceneId !== note.sceneId || token.x !== note.at.x || token.y !== note.at.y);
  useEffect(() => {
    if (stale && !busy) slot.setState({ note: null });
  }, [stale, busy, slot]);

  const shown = note !== null && token !== undefined && note.sceneId === props.scene.id && (busy || (!stale && !barOpen));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!shown || !el) return;
    const observer = new ResizeObserver(([entry]) => entry && setHeight(entry.target.scrollHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);

  if (!shown || !note || !token) return null;

  const fp = footprint(token);
  const anchor = worldToScreen(props.camera, { x: note.ghost.x + fp.w / 2, y: note.ghost.y + fp.h });
  const width = Math.min(WIDTH, props.viewport.width - 16);
  const place = cardPlace({ anchor, viewport: props.viewport, insets: props.insets, width, height, gap: 12, prefer: "below" });
  const close = () => slot.setState({ note: null, busy: false });
  const teleport = () => {
    if (slot.getState().busy) return;
    slot.setState({ busy: true });
    runTeleport(note, {
      // As the drop reads the room: a teleport off a holder every player sees lands by it (drop.ts dropLanding).
      view: () => {
        const state = store.getState();
        return state.view ? dropView(state.view, state.you?.role ?? "player") : null;
      },
      dispatch: (op, opts) => actions.dispatch(op, opts),
      notify: (text, tone) => ui.notify(text, tone),
      done: close,
    });
  };

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      style={{
        position: "absolute",
        left: place.left,
        top: place.top,
        width,
        zIndex: theme.z.pane,
        display: "grid",
        gap: theme.space(2),
        padding: `${theme.space(1)}px ${theme.space(3)}px ${theme.space(3)}px`,
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.lg,
        boxShadow: theme.shadow.pane,
        color: theme.color.text,
        fontSize: theme.font.body14,
      }}
    >
      <PaneHeader
        // The whole sentence, wrapped: it says what stopped the walk.
        title={<span style={{ display: "block", whiteSpace: "normal" }}>{stopText({ blocker: note.blocker, door: noteDoor(chunks, note.sceneId, note.door, fog), searched: note.searched, capped: note.capped, follower: note.follower })}</span>}
        onClose={close}
      />
      {/* The note's one action, so the primary (docs/design-v1-visual.md 2.3). */}
      <Button
        variant="primary"
        size="sm"
        busy={busy}
        onClick={teleport}
        title="For Misty Step and anything else that passes walls: the walk to the wall is taken back, and the teleport does not count against Speed"
      >
        {busy ? "Teleporting…" : "Teleport here"}
      </Button>
    </div>
  );
}
