import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { BuildChunk, FogTile, Scene } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { Help } from "../../components/Panel.tsx";
import { PaneHeader } from "../../components/SheetHeader.tsx";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { footAnchor } from "../../canvas/anchors.ts";
import { flatPick, groundUnder, type BoardPick } from "../../canvas/boardPick.ts";
import { footprint } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { PANE_WIDTH } from "../builder/labelEdit.ts";
import { noteDoor } from "../doors/doors.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { cardPlace } from "./anchor.ts";
import { dropView, stopText } from "./drop.ts";
import { stopNoteSlot } from "./store.ts";
import { runTeleport } from "./teleport.ts";

const NO_CHUNKS: Readonly<Record<string, BuildChunk>> = {};
const NO_FOG: Readonly<Record<string, FogTile>> = {};
/** The note's height until it has been laid out and measured. */
const UNMEASURED = 156;
/** Lines the stopping sentence may take: more than the longest ("Too far to work out a way around. Stopped at a wall. …") needs at the note's width, so it always shows whole. */
const TITLE_LINES = 6;
/** The card's padding top and foot, its borders, and the gap between its rows. */
const PAD_TOP = theme.space(1);
const PAD_FOOT = theme.space(3);
const GAP = theme.space(2);

/**
 * The least room between the bars in which the note keeps its usual look,
 * the sentence in its header over Teleport here and the help: a header of
 * all TITLE_LINES, the action, a line of the help, and the card's padding,
 * borders and gaps. In less, as at 480 x 320 at 130%, those rows cannot
 * all show, so the note is compact (StopNoteHost).
 */
export const FULL_NOTE_ROOM = Math.ceil(
  Math.max(48, TITLE_LINES * theme.font.input * theme.leading.tight) + theme.touch + theme.font.small * theme.leading.body + PAD_TOP + PAD_FOOT + 2 * theme.line.border + 2 * GAP,
);

/**
 * The least room in which the compact note keeps Close beside its body
 * and Teleport here under them: Close's touch target over the action's,
 * and the card's padding, borders and gap. In less, as at 480 x 320 at
 * 130% over a phone's home bar, Close would run over Teleport here, so the
 * two stand side by side in one row under the body (review LP2L2-ASTRA-3).
 */
export const COMPACT_NOTE_ROOM = Math.ceil(2 * theme.touch + GAP + PAD_TOP + PAD_FOOT + 2 * theme.line.border);

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
export function StopNoteHost(props: { scene: Scene; camera: Camera; viewport: Size; insets: Insets; pick?: BoardPick }) {
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
  const helpId = useId();

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
  // Under the ghost where the walk stopped: in Isometric under its ring, on the ground drawn there (docs/design-v1-isometric-view.md 5.3).
  const pick = props.pick ?? flatPick(props.camera);
  const anchor = footAnchor(props.camera, pick, { x: note.ghost.x, y: note.ghost.y, w: fp.w, h: fp.h }, groundUnder(pick, { ...token, x: note.ghost.x, y: note.ghost.y, squeeze: undefined }));
  // A card over the map as wide as a map pane, inside the canvas's 8 px margins.
  const width = Math.min(PANE_WIDTH, props.viewport.width - 2 * theme.space(2));
  /*
   * No taller than the map the bars leave, inside the same margins, so on a
   * short screen its foot never runs under the toolbar. cardPlace gets the
   * capped height, its first frame's guess included, since it only keeps
   * the top in bounds. Where the usual rows fit (FULL_NOTE_ROOM), the help
   * under Teleport here is what scrolls. Where they cannot, the note is
   * compact: the sentence and the help scroll together as its body, with
   * Close beside them and Teleport here under them, both always in view
   * (reviews LP2L2-ASTRA-2 and LP2L2-OPUS-10). Under COMPACT_NOTE_ROOM,
   * Close and Teleport here share one row under the body.
   */
  const room = Math.max(0, props.viewport.height - props.insets.top - props.insets.bottom - 2 * theme.space(2));
  const compact = room < FULL_NOTE_ROOM;
  const oneRow = room < COMPACT_NOTE_ROOM;
  const place = cardPlace({ anchor, viewport: props.viewport, insets: props.insets, width, height: Math.min(height, room), gap: theme.space(3), prefer: "below" });
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
      undo: (options) => actions.undo(options),
      notify: (text, tone) => ui.notify(text, tone),
      done: close,
    });
  };

  // The whole sentence, wrapped: it says what stopped the walk. It alone is the status a screen reader hears when the note comes, not Close or the help.
  const status = (
    <span role="status" aria-live="polite">
      {stopText({ blocker: note.blocker, door: noteDoor(chunks, note.sceneId, note.door, fog, sceneGrid(props.scene)), searched: note.searched, capped: note.capped, follower: note.follower })}
    </span>
  );
  // The note's one action, so the primary (docs/design-v1-visual.md 2.3). The help is its description, read with it.
  const action = (
    <Button variant="primary" size="sm" busy={busy} onClick={teleport} aria-describedby={helpId} style={oneRow ? { flex: 1, minWidth: 0 } : undefined}>
      {busy ? "Teleporting…" : "Teleport here"}
    </Button>
  );
  const closeButton = <IconButton icon="close" label="Close" onClick={close} style={oneRow ? undefined : { alignSelf: "flex-start" }} />;
  const body = (
    <div data-stop-note-body="" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", paddingTop: oneRow ? theme.space(2) : theme.space(3) }}>
      <strong style={{ display: "block", fontSize: theme.font.input, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>{status}</strong>
      <Help id={helpId} style={{ marginTop: theme.space(1) }}>
        {HELP}
      </Help>
    </div>
  );

  return (
    <div
      ref={ref}
      data-stop-note=""
      style={{
        position: "absolute",
        left: place.left,
        top: place.top,
        width,
        maxHeight: room,
        zIndex: theme.z.pane,
        display: "grid",
        gridTemplateRows: compact ? "minmax(0, 1fr) auto" : "auto auto minmax(0, 1fr)",
        gap: GAP,
        padding: `${PAD_TOP}px ${theme.space(3)}px ${PAD_FOOT}px`,
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.lg,
        boxShadow: theme.shadow.pane,
        color: theme.color.text,
        fontSize: theme.font.body14,
      }}
    >
      {oneRow ? (
        <>
          {body}
          <div data-stop-note-actions="" style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
            {action}
            {closeButton}
          </div>
        </>
      ) : compact ? (
        <>
          <div style={{ display: "flex", alignItems: "stretch", gap: theme.space(1), minHeight: 0 }}>
            {body}
            {closeButton}
          </div>
          {action}
        </>
      ) : (
        <>
          <PaneHeader title={status} lines={TITLE_LINES} onClose={close} />
          {action}
          <div style={{ minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
            <Help id={helpId}>{HELP}</Help>
          </div>
        </>
      )}
    </div>
  );
}

const HELP = "For Misty Step and anything else that passes walls. The walk to the wall is taken back, and the teleport does not count against Speed.";
