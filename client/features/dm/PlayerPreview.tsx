import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { Button } from "../../components/Button.tsx";
import { Notice } from "../../components/Notice.tsx";
import { useModalDialog } from "../../lib/modalDialog.ts";
import { useUiScale } from "../device/settings.ts";
import { theme } from "../../lib/theme.ts";
import { Room } from "../../pages/Room.tsx";
import { browserEnv, createRoomSocket, previewSocketUrl } from "../../state/socket.ts";
import { createRoomStore, type RoomStore } from "../../state/store.ts";
import { useScoped } from "../../state/scope.ts";
import { RoomProvider, useAssets, useRoomView } from "../../state/view.ts";
import { SHORT_LANDSCAPE_MAX, useTopBars } from "../encounter/band.ts";
import { useLayoutSize } from "../device/layout.ts";
import { createPreview, watchPreviewLoad, type Preview, type PreviewLoad } from "./preview.ts";
import { PreviewContext, type PreviewNotice } from "./previewContext.ts";
import { PreviewWait } from "./PreviewWait.tsx";
import { viewAsSlot } from "./viewAs.tsx";

const FLASH_MS = 2_000;

/** The preview's own store, and the read-only room drawn from it. */
type Live = { room: RoomStore; preview: Preview };

/**
 * The DM's one preview, wherever it was opened from (viewAs.tsx): the DM
 * panel's picker, a token's bar or its panel. The Room page mounts it for
 * the DM only. It reads the player's name from the room as it changes.
 */
export function ViewAsHost() {
  const viewAs = useScoped(viewAsSlot);
  const target = useStore(viewAs.store, (s) => s.target);
  const liveName = useRoomView((s) => (target ? s.view?.members[target.memberId]?.name : undefined));
  const returnFocus = useMemo(() => ({ current: target?.returnFocus ?? null }), [target]);
  if (!target) return null;
  return <PlayerPreview memberId={target.memberId} name={liveName ?? target.name} onExit={viewAs.exit} returnFocus={returnFocus} />;
}

/**
 * "View as a player": the whole Room page again, over the DM's, drawn from
 * that player's own projection, which a socket of its own asks the server
 * for (docs/design-v1-per-player-vision.md 7.4, preview.ts), with every
 * action refused. It is the real page, top bar, toolbar and panels
 * included, so the DM sees what that player can see on any scene, fog
 * and all, and nothing more. It keeps its own framing, so it is not a
 * mirror of the player's screen. The DM's own socket and tools stay as
 * they are. Until the player's snapshot lands it says it is loading,
 * after the shared delay, and after 10 s, or a socket that closed first,
 * that it could not load, with Try again, and Exit in the banner.
 *
 * The page always fills the viewport, so the banner floats over the map
 * just under the top bar, and a cream frame marks the whole screen as a
 * preview. A refused tap makes the banner say so, in place of a toast.
 * The banner is a Notice in the highlight tone, which keeps the cream
 * whatever the DM's color and puts the focus ring on Exit in ink.
 *
 * The banner stays here, outside the previewed page, so a blackout and the
 * ended screen keep its Exit. The page places it among its own notices
 * (pages/Room.tsx, docs/design-v1-bar-dock.md 1.3): it hears the banner's
 * height and answers with where it goes, left of the lane the token bar
 * and the alerts column share, so it never covers a card (LPD-DESK-6).
 * While the page answers nothing (a blackout, the ended screen, the first
 * frame) or wants it spanning, it sits centered under the top bars, and
 * the page's own notices and the column start below it.
 */
export function PlayerPreview(props: {
  memberId: string;
  name: string;
  onExit(): void;
  /** Where focus goes on Exit: the control that opened it (viewAs.tsx), which may not be what held focus as it opened. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const roomId = useRoomView((s) => s.roomId);
  const assets = useAssets();
  const [live, setLive] = useState<Live | null>(null);
  const [load, setLoad] = useState<PreviewLoad>("loading");
  const [flash, setFlash] = useState(false);
  // Each Try again opens the preview anew, with a fresh store and socket.
  const [attempt, setAttempt] = useState(0);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { memberId, name, onExit } = props;
  // The bars the previewed page draws over the map, the top bar and a phone's turn band, as the DM's own view has them: a fight shows in both or neither, outside a blackout.
  const topBars = useTopBars();
  const noticeRef = useRef<HTMLDivElement>(null);
  const [noticeHeight, setNoticeHeight] = useState(0);
  const [placed, setPlaced] = useState<{ left: number; width: number } | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = noticeRef.current;
    if (!el) return;
    const measure = () => setNoticeHeight(el.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const notice = useMemo<PreviewNotice>(
    () => ({
      height: noticeHeight,
      place: (box) => setPlaced((prev) => (prev === box || (prev && box && prev.left === box.left && prev.width === box.width) ? prev : box)),
      slot: setSlot,
    }),
    [noticeHeight],
  );
  const context = useMemo(() => ({ memberId, name, notice }), [memberId, name, notice]);

  // Made in an effect, so a development double mount disposes the first one. Another player means a new socket, a new name does not.
  const nameRef = useRef(name);
  nameRef.current = name;
  useEffect(() => {
    const room = createRoomStore({ roomId, you: { memberId, role: "player" } });
    const socket = createRoomSocket({ url: previewSocketUrl(roomId, memberId), room, env: browserEnv(), previewOf: memberId });
    socket.start();
    const preview = createPreview(room.store, memberId, {
      name: nameRef.current,
      onRefuse: () => {
        setFlash(true);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(false), FLASH_MS);
      },
    });
    // Until the snapshot lands the socket retries nothing (state/socket.ts previewOf), so the wait ends in its close or here.
    setLoad("loading");
    const wait = watchPreviewLoad(room.store, { stop: () => socket.dispose(), onChange: setLoad });
    setLive({ room, preview });
    return () => {
      wait.dispose();
      preview.dispose();
      socket.dispose();
      room.dispose();
      if (flashTimer.current) clearTimeout(flashTimer.current);
      setLive(null);
    };
  }, [roomId, memberId, attempt]);

  // A modal dialog (lib/modalDialog.ts), so the DM's own room behind it is inert and Escape leaves the preview.
  // It holds a whole Room page, whose chrome takes the interface size itself and whose map must not.
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(dialog, { onClose: onExit, returnFocus: props.returnFocus, zoom: false });
  const zoom = useUiScale();
  // One line on a short screen, as the room's own lasting notices (components/Notice.tsx).
  const compact = useLayoutSize().height < SHORT_LANDSCAPE_MAX;
  const banner = (
    <Notice
      tone="highlight"
      float
      compact={compact}
      role="status"
      action={
        <Button size="sm" onClick={onExit}>
          Exit
        </Button>
      }
    >
      <strong>Viewing as {name}.</strong> {flash ? <strong>Read-only: nothing you do here is saved.</strong> : "Nothing here is saved."} Whispers between players are not shown.
    </Notice>
  );

  return createPortal(
    <dialog
      ref={dialog}
      aria-modal="true"
      aria-label={`Viewing as ${name}`}
      tabIndex={-1}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        maxWidth: "none",
        maxHeight: "none",
        margin: 0,
        padding: 0,
        border: "none",
        background: theme.color.stage,
        color: theme.color.text,
        outline: "none",
        overflow: "hidden",
      }}
    >
      {live && load === "loaded" ? (
        <PreviewContext.Provider value={context}>
          <RoomProvider store={live.preview.store} actions={live.preview.actions} ui={live.preview.ui} assets={assets}>
            <Room />
          </RoomProvider>
        </PreviewContext.Provider>
      ) : (
        <PreviewWait name={name} failed={load === "failed"} zoom={zoom} onRetry={() => setAttempt((n) => n + 1)} />
      )}
      <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 1, pointerEvents: "none", border: `4px solid ${theme.color.accentSoft}` }} />
      <div
        ref={noticeRef}
        style={{
          position: "fixed",
          zIndex: 2,
          // Just under the Room page's top bar and its turn band, which take the interface size.
          top: `calc(${theme.safe.top} * ${zoom} + ${(topBars + 8) * zoom}px)`,
          ...(placed ? { left: placed.left, width: placed.width } : { left: "50%", transform: "translateX(-50%)", width: `min(520px, calc(100% - ${theme.space(6)}px))` }),
          fontFamily: theme.font.body,
        }}
      >
        {slot ? null : banner}
      </div>
      {slot ? createPortal(<div style={{ width: "100%", maxWidth: 520, pointerEvents: "auto", fontFamily: theme.font.body }}>{banner}</div>, slot) : null}
    </dialog>,
    document.body,
  );
}
