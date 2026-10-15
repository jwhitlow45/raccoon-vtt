import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../components/Button.tsx";
import { Notice } from "../../components/Notice.tsx";
import { useModalDialog } from "../../lib/modalDialog.ts";
import { useUiScale } from "../device/settings.ts";
import { theme } from "../../lib/theme.ts";
import { Room } from "../../pages/Room.tsx";
import { RoomProvider, useAssets, useRoomStore } from "../../state/view.ts";
import { useTopBars } from "../encounter/band.ts";
import { createPreview, type Preview } from "./preview.ts";
import { PreviewContext, type PreviewNotice } from "./previewContext.ts";

const FLASH_MS = 2_000;

/**
 * "View as a player": the whole Room page again, over the DM's, drawn from
 * one player's projection of the DM's view (preview.ts) with every action
 * refused. It is the real page, top bar, toolbar and panels included, so
 * the DM sees exactly what that player sees, fog and all.
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
export function PlayerPreview(props: { memberId: string; name: string; onExit(): void }) {
  const source = useRoomStore();
  const assets = useAssets();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { memberId, name, onExit } = props;
  // The bars the previewed page draws over the map, the top bar and a phone's turn band, as the DM's own view has them: a fight shows in both or neither, outside a blackout.
  const topBars = useTopBars();
  const noticeRef = useRef<HTMLDivElement>(null);
  const [noticeHeight, setNoticeHeight] = useState(0);
  const [placed, setPlaced] = useState<{ left: number; width: number } | null>(null);
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
    }),
    [noticeHeight],
  );
  const context = useMemo(() => ({ memberId, name, notice }), [memberId, name, notice]);

  // Made in an effect, so a development double mount disposes the first one.
  useEffect(() => {
    const p = createPreview(source, memberId, {
      name,
      onRefuse: () => {
        setFlash(true);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(false), FLASH_MS);
      },
    });
    setPreview(p);
    return () => {
      p.dispose();
      if (flashTimer.current) clearTimeout(flashTimer.current);
      setPreview(null);
    };
  }, [source, memberId, name]);

  // A modal dialog (lib/modalDialog.ts), so the DM's own room behind it is inert and Escape leaves the preview.
  // It holds a whole Room page, whose chrome takes the interface size itself and whose map must not.
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(dialog, { onClose: onExit, zoom: false });
  const zoom = useUiScale();

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
      {preview ? (
        <PreviewContext.Provider value={context}>
          <RoomProvider store={preview.store} actions={preview.actions} ui={preview.ui} assets={assets}>
            <Room />
          </RoomProvider>
        </PreviewContext.Provider>
      ) : null}
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
        <Notice
          tone="highlight"
          float
          role="status"
          action={
            <Button size="sm" onClick={onExit}>
              Exit
            </Button>
          }
        >
          <strong>Viewing as {name}.</strong> {flash ? <strong>Read-only: nothing you do here is saved.</strong> : "Nothing here is saved."}
        </Notice>
      </div>
    </dialog>,
    document.body,
  );
}
