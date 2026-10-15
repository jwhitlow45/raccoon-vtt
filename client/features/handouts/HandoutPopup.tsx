import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/Button.tsx";
import { Dialog, DIALOG_PHONE_MAX } from "../../components/Dialog.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help } from "../../components/Panel.tsx";
import { useBackClose } from "../../lib/backClose.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useAssets, useRoomView } from "../../state/view.ts";
import { closedSlot, closedStorageKey, closeHandout, loadClosed } from "./closed.ts";
import { layoutWidth } from "../device/layout.ts";
import { useXCard } from "../xcard/XCardHost.tsx";
import { downloadHandout, saveSettled, type SaveState } from "./download.ts";
import { nextPopup, popupShows, showingKey } from "./handouts.ts";
import { doubleTapView, FIT, isDoubleTap, panView, pinchView, zoomAround, type Point, type ZoomView } from "./zoom.ts";

/**
 * A handout the DM shows pops up over the map for the players it was shown
 * to (features section 16). Closing it hides it on this device only, and
 * it stays closed across a reload (closed.ts). The Library panel opens it
 * again. The DM closes a handout for everyone from the DM panel, and then
 * it simply leaves this view. Mounted once by the Room page.
 *
 * DMs get no popup: the DM chose the handout, and the DM panel lists what
 * is showing.
 *
 * It is the shared dialog (docs/design-v1-visual.md 3.5): the whole screen
 * on a phone, a wide card on a computer, with the close icon in its header.
 * It keeps a deeper backdrop than other dialogs, since a dim map helps the
 * handout read, and a tap beside the card does not close it, so a pinch
 * that strays past the picture never loses it. It stays open while one
 * handout follows another. Its image pans and pinches under the finger,
 * which a zoomed box would put in other units than the pointer, so it
 * keeps 100% whatever the interface size. Download, beside the close
 * button, saves the image to the device (download.ts).
 */
export function HandoutPopup() {
  const role = useRoomView((s) => s.you?.role);
  const roomId = useRoomView((s) => s.roomId);
  const memberId = useRoomView((s) => s.you?.memberId ?? null);
  const handouts = useRoomView((s) => s.view?.handouts);
  const assets = useAssets();
  const closedStore = useScoped(closedSlot);
  const { storageKey, closed, preferId } = useStore(closedStore);
  const [failed, setFailed] = useState<string | null>(null);
  const wantKey = memberId ? closedStorageKey(roomId, memberId) : null;
  // Nothing pops up until this device's closed list is read, or a reload would flash every handout.
  const next = role === "player" && handouts && storageKey === wantKey && wantKey ? nextPopup(handouts, closed, preferId) : null;
  // Whether the dialog was open after the last render, so a handout that would open under the X-card waits for it (handouts.ts popupShows).
  const openRef = useRef(false);
  const xcard = useXCard();
  const shows = popupShows({ handout: next !== null, open: openRef.current, xcard: xcard.showing });
  useEffect(() => {
    openRef.current = shows;
  });
  const handout = shows ? next : null;
  const key = handout ? showingKey(handout) : null;

  useEffect(() => {
    if (wantKey) loadClosed(closedStore, wantKey);
  }, [closedStore, wantKey]);

  const close = () => {
    if (key && handouts) closeHandout(closedStore, key, handouts);
  };

  // Download's state, for the handout it was pressed for: under way, or failed (download.ts SaveState).
  const [saving, setSaving] = useState<SaveState>(null);
  const lastOp = useRef(0);
  /*
   * A download under way goes on when the popup closes, since the player
   * asked for the file, and the same handout opened again from the Library
   * shows it still working until it ends (P3R-6). Cancelled instead, it
   * left that Download busy for good. A failure belongs to the popup that
   * saw it, so the handout opened again starts clean.
   */
  useEffect(() => () => setSaving((s) => (s?.state === "failed" ? null : s)), [key]);
  const busy = saving?.key === key && saving.state === "busy";
  const download = async () => {
    if (!handout || !key || busy) return;
    const op = ++lastOp.current;
    setSaving({ op, key, state: "busy" });
    let outcome: "done" | "failed" = "done";
    try {
      await downloadHandout(assets.url(handout.assetId, "full"), handout.title);
    } catch {
      outcome = "failed";
    }
    setSaving((s) => saveSettled(s, op, outcome));
  };

  // Android's Back closes the handout before it leaves the room, one Back for each handout shown in turn.
  useBackClose(key, close);

  if (!handout || !key) return null;
  return (
    <Dialog
      title={handout.title}
      onClose={close}
      width="lg"
      phone="fill"
      scrim={theme.color.overlay}
      dismissOnBackdrop={false}
      zoom={false}
      headerActions={
        // A busy button says so in its own words at once, and takes no second tap (components/Loading.tsx).
        <Button size="sm" busy={busy} onClick={() => void download()}>
          {busy ? "Downloading…" : "Download"}
        </Button>
      }
      bodyStyle={{ display: "grid", alignContent: "start", gap: theme.space(2) }}
    >
      <Help>The DM shows you</Help>
      {saving?.key === key && saving.state === "failed" ? (
        <div role="alert" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), fontSize: theme.font.body14, color: theme.color.dangerText }}>
          <span style={{ flex: "1 1 200px" }}>The handout could not be downloaded. Check your connection.</span>
          <Button size="sm" onClick={() => void download()}>
            Try again
          </Button>
        </div>
      ) : null}
      {failed === key ? (
        <p role="alert" style={{ margin: 0, fontSize: theme.font.body14, color: theme.color.textMuted }}>
          The image could not be loaded. Check your connection.
        </p>
      ) : (
        <ZoomableImage key={key} src={assets.url(handout.assetId, "full")} alt={handout.title} maxHeight={imageMaxHeight()} onError={() => setFailed(key)} />
      )}
    </Dialog>
  );
}

/**
 * The dialog's header, the body's padding and the "The DM shows you" line
 * above the picture, so the whole picture fits the card as it opens.
 */
const AROUND_IMAGE_PX = 120;

/**
 * The tallest the picture may be: the card's height less what sits around
 * it. The card is the whole screen inside the safe areas on a phone, and
 * at most 760 px with a margin on a computer (components/Dialog.tsx). The
 * dialog keeps 100% (`zoom={false}`), so viewport units mean what they say.
 */
function imageMaxHeight(): string {
  if (layoutWidth() < DIALOG_PHONE_MAX) return `calc(100dvh - ${theme.safe.top} - ${theme.safe.bottom} - ${AROUND_IMAGE_PX}px)`;
  return `calc(min(100dvh - ${theme.space(8)}px, 760px) - ${AROUND_IMAGE_PX}px)`;
}

/**
 * The handout image with its own zoom (zoom.ts): two fingers pinch and pan,
 * one finger pans once zoomed, a double tap or double click zooms in on the
 * spot or back out, and the wheel zooms on a desktop. touch-action: none
 * hands every touch here, so the page itself never zooms.
 */
function ZoomableImage(props: { src: string; alt: string; maxHeight: string; onError(): void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  // A handout is up to 2048 px, seconds on a slow phone, and the dialog
  // showed only its title until the image arrived.
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<ZoomView>(FIT);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<
    { kind: "pan"; view: ZoomView; start: Point } | { kind: "pinch"; view: ZoomView; mid: Point; dist: number } | null
  >(null);
  const lastTap = useRef<{ at: number; p: Point } | null>(null);
  const moved = useRef(false);

  const box = () => {
    const el = boxRef.current;
    return el ? { width: el.clientWidth, height: el.clientHeight } : { width: 1, height: 1 };
  };
  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = boxRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
  };
  /** A new baseline whenever a finger lands or lifts, so the image never jumps. */
  const rebase = () => {
    const pts = [...pointers.current.values()];
    if (pts.length === 1) gesture.current = { kind: "pan", view: viewRef.current, start: pts[0]! };
    else if (pts.length === 2) {
      const [a, b] = pts as [Point, Point];
      gesture.current = { kind: "pinch", view: viewRef.current, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    } else gesture.current = null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) moved.current = false;
    rebase();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > 8) moved.current = true;
      if (g.view.scale > 1) setView(panView(g.view, p.x - g.start.x, p.y - g.start.y, box()));
    } else {
      moved.current = true;
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      setView(pinchView(g, { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) }, box()));
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size === 0 && !moved.current && e.type === "pointerup") {
      const tap = { at: e.timeStamp, p: local(e) };
      if (isDoubleTap(lastTap.current, tap)) {
        setView(doubleTapView(viewRef.current, tap.p, box()));
        lastTap.current = null;
      } else lastTap.current = tap;
    }
    rebase();
  };
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    setView(zoomAround(viewRef.current, local(e), Math.exp(-Math.max(-200, Math.min(200, e.deltaY)) * 0.002), box()));
  };

  const zoomed = view.scale > 1;
  return (
    <div style={{ position: "relative", minHeight: 0 }}>
      {loaded ? null : <Loading text="Loading the image…" style={{ justifyContent: "center", minHeight: 120 }} />}
      <div
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{
          width: "fit-content",
          maxWidth: "100%",
          margin: "0 auto",
          overflow: "hidden",
          borderRadius: theme.radius.md,
          touchAction: "none",
          cursor: zoomed ? "grab" : "zoom-in",
          // Out of the layout until it has a size, so the dialog fits the notice meanwhile.
          ...(loaded ? null : { position: "absolute", visibility: "hidden" }),
        }}
      >
        <img
          src={props.src}
          alt={props.alt}
          draggable={false}
          onLoad={() => setLoaded(true)}
          ref={(img) => {
            // An image the browser already holds can finish before React listens.
            if (img?.complete && img.naturalWidth > 0) setLoaded(true);
          }}
          onError={props.onError}
          style={{
            display: "block",
            maxWidth: "100%",
            maxHeight: props.maxHeight,
            objectFit: "contain",
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: "0 0",
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
        />
      </div>
      {zoomed ? (
        <Button size="sm" onClick={() => setView(FIT)} style={{ position: "absolute", right: theme.space(2), bottom: theme.space(2), background: theme.color.overlay }}>
          Reset zoom
        </Button>
      ) : null}
    </div>
  );
}
