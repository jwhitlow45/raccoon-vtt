import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useStore } from "zustand";
import { handoutPages } from "#shared/handouts.ts";
import type { Handout } from "#shared/model.ts";
import { MapStage } from "../../canvas/Stage.tsx";
import { SceneLoadingOverlay } from "../../canvas/SceneLoading.tsx";
import { Button, destructiveStyle } from "../../components/Button.tsx";
import { ConnectionDot } from "../../components/ConnectionStatus.tsx";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Loading } from "../../components/Loading.tsx";
import { choiceLook } from "../../components/looks.ts";
import { Notice } from "../../components/Notice.tsx";
import { useTooltip } from "../../components/Tooltip.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { api, ApiError, displayAssetUrl, type AssetVariant } from "../../lib/api.ts";
import { fitRect, NO_INSETS, type Camera, type Rect, type Size } from "../../lib/camera.ts";
import { viewBox, type View } from "../../lib/view.ts";
import { BANNER_DELAY_MS, type ConnectionState } from "../../lib/connection.ts";
import { revealedMask } from "../../lib/fogTiles.ts";
import { liftIn } from "../../canvas/boardPick.ts";
import { exitFullscreen, fullscreenSupported, toggleFullscreen, useFullscreen } from "../../lib/fullscreen.ts";
import { navigate } from "../../lib/navigation.ts";
import { sceneGate } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useWakeLock } from "../../lib/wakeLock.ts";
import { createRoomActions } from "../../state/actions.ts";
import { RoomScope, RoomScopeProvider, useRoomScope } from "../../state/scope.ts";
import { browserEnv, createRoomSocket, roomSocketUrl } from "../../state/socket.ts";
import { createRoomStore, type RoomStore } from "../../state/store.ts";
import type { Ended, RoomActions, You } from "../../state/types.ts";
import { RoomProvider, useAssets, useRoomView, type AssetSource } from "../../state/view.ts";
import { closedSlot, closedStorageKey, closeHandout, loadClosed } from "../handouts/closed.ts";
import { nextPopup, pageName, showingKey } from "../handouts/handouts.ts";
import { useXCard, XCardHost } from "../xcard/XCardHost.tsx";
import { UI_SCALES, uiScaleLabel, useUiScale } from "../device/settings.ts";
import { choiceOf, choiceWords, isoOffered, pickOf, TURN_LEFT, TURN_LEFT_DESCRIPTION, TURN_RIGHT, TURN_RIGHT_DESCRIPTION, VIEW_CHOICES, VIEW_GROUP } from "../view/choice.ts";
import { displayViewKey } from "../view/store.ts";
import { SuggestionHelp, useViewChoice, useViewVoice, ViewVoice, type ViewChoiceState } from "../view/ViewMenu.tsx";
import {
  BAR_BUTTONS,
  barFirstFocus,
  barFocusAfter,
  barMove,
  containRect,
  displayPress,
  endedText,
  displaySeen,
  fitMapTarget,
  followCamera,
  MENU_MS,
  pageLine,
  refitAt,
  stepPage,
  turnText,
  type BarButton,
  type DisplayMode,
  type DisplayPaging,
  type Overlay,
} from "./logic.ts";
import { chooseDisplayUiScale, forgetDisplayRoom, readDisplayMode, readDisplayTurn, rememberedDisplayRoom, saveDisplayChoices, useDisplayTextSize } from "./remember.ts";
import { TV_BUTTON_HEIGHT, TV_HANDOUT_SCRIM, TV_TEXT } from "./tvType.ts";

/**
 * A table display's room (docs/design-v1-dm-tools.md 3.1): the player scene
 * full screen, as a player who owns nothing gets it, with no bars, toolbar,
 * panels, chips, toasts, log, roll requests or initiative strip. It mounts
 * the room's own canvas, and reads everything through the display's session
 * alone: its socket asks for `as=display`, and its images come through the
 * display route, so what it draws is exactly what players get.
 */

/** Who this display is, asked again after a 4001 close. A display grant still on file means the socket reconnects. */
async function recheck(roomId: string): Promise<You | null> {
  try {
    const me = await api.getDisplayMe(roomId);
    return { memberId: me.memberId, role: "player" };
  } catch (err) {
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) return null;
    throw err;
  }
}

type Live = { room: RoomStore; actions: RoomActions };

export default function DisplayRoom(props: { roomId: string; memberId: string }) {
  const { roomId, memberId } = props;
  const [live, setLive] = useState<Live | null>(null);
  useDisplayTextSize();
  useEffect(() => {
    // A display's projection is a player's who owns nothing, so its store holds the player role (state/store.ts).
    const room = createRoomStore({ roomId, you: { memberId, role: "player" } });
    const socket = createRoomSocket({ url: `${roomSocketUrl(roomId)}&as=display`, room, env: browserEnv(), recheck: () => recheck(roomId) });
    socket.start();
    setLive({ room, actions: createRoomActions(room, socket) });
    return () => {
      socket.dispose();
      room.dispose();
      setLive(null);
    };
  }, [roomId, memberId]);
  const assets = useMemo<AssetSource>(() => ({ url: (assetId: string, variant: AssetVariant) => displayAssetUrl(roomId, assetId, variant) }), [roomId]);
  if (!live) return <div style={{ position: "fixed", inset: 0, background: theme.color.stage }} />;
  return (
    <RoomProvider store={live.room.store} actions={live.actions} ui={live.room.ui} assets={assets} display>
      <DisplayScreen roomId={roomId} />
    </RoomProvider>
  );
}

function DisplayScreen(props: { roomId: string }) {
  const [scope] = useState(() => new RoomScope());
  useEffect(() => () => scope.dispose(), [scope]);
  const ended = useRoomView((s) => s.ended);
  useWakeLock();
  useNoGestureZoom();
  if (ended) return <DisplayEnded ended={ended} roomId={props.roomId} />;
  return (
    <RoomScopeProvider scope={scope}>
      <DisplayTable roomId={props.roomId} />
    </RoomScopeProvider>
  );
}

function DisplayTable(props: { roomId: string }) {
  const view = useRoomView((s) => s.view);
  const sceneId = useRoomView((s) => s.sceneId);
  const connection = useRoomView((s) => s.connection);
  const memberId = useRoomView((s) => s.you?.memberId ?? null);
  const gate = useMemo(() => sceneGate({ view, sceneId, role: "player" }), [view, sceneId]);
  const [mode, setMode] = useState<DisplayMode>(readDisplayMode);
  const [showTurn, setShowTurn] = useState(readDisplayTurn);
  useEffect(() => saveDisplayChoices({ mode, turn: showTurn }), [mode, showTurn]);

  const handout = useDisplayHandout(props.roomId, memberId);
  const paging = useHandoutPaging(handout.current);
  // The X-card shows over a handout, so a tap closes the card first and the handout with the next.
  const xcard = useXCard();
  const overlay: Overlay = xcard.showing ? "xcard" : handout.current ? "handout" : null;
  const menu = useMenu();
  const cursorHidden = useIdleCursor();
  // The display's own pick, apart from a member's in the same browser (docs/design-v1-isometric-view.md ISO-D16).
  const suggested = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId]?.suggestedView : undefined));
  const viewChoice = useViewChoice({ key: displayViewKey(props.roomId), sceneId, suggested });
  useViewVoice(viewChoice);

  // A handout takes every tap and key, and its bar takes the menu's place, so a menu open when one comes up goes.
  const showing = handout.current ? showingKey(handout.current) : null;
  useEffect(() => {
    if (showing !== null) menu.hide();
  }, [showing, menu]);

  /** Acts on a tap (`key` null) or a key, and says whether the key may go on to do its own work: Enter or Space pressing the bar's button with focus. */
  const press = useCallback(
    (key: string | null): boolean => {
      const what = displayPress({ overlay, menu: menu.open, key, paging: paging.state });
      // Any key while the bar shows is a use of it, as in the menu.
      if (key !== null && paging.state?.bar) paging.touch();
      switch (what) {
        case "closeOverlay":
          if (overlay === "xcard") xcard.dismiss();
          else handout.close();
          return false;
        case "openMenu":
          menu.show(key !== null);
          return false;
        case "closeMenu":
          menu.hide();
          return false;
        case "menuKey":
          menu.touch();
          return false;
        case "nextPage":
        case "previousPage":
          paging.step(what === "nextPage" ? 1 : -1);
          return false;
        case "openBar":
          paging.openBar(key !== null);
          return false;
        case "hideBar":
          paging.hideBar();
          return false;
        case "barFocusNext":
        case "barFocusPrevious":
          paging.move(what === "barFocusNext" ? 1 : -1);
          return false;
        case "barKey":
          return key !== null && paging.barKey(key);
        case "none":
          return false;
      }
    },
    [overlay, menu, handout, xcard, paging],
  );

  // Any key shows the menu, as a TV remote's OK button would. Inside the menu the keys move between its buttons.
  // A handout of pages takes the keys for its pages and its bar instead (displayPress).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (menu.open && !overlay) {
        if (e.key === "Escape") {
          e.preventDefault();
          menu.hide();
          return;
        }
        if (/^Arrow/.test(e.key)) {
          e.preventDefault();
          menu.step(e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1);
        }
        menu.touch();
        return;
      }
      if (e.key === "Tab") {
        if (paging.state?.bar) paging.touch();
        return;
      }
      if (!press(e.key)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, overlay, press, paging]);

  const camera = useDisplayCamera(gate, mode, viewChoice.shown);
  const turn = useRoomView((s) => (showTurn && s.view ? turnText({ encounter: s.view.encounter, tokens: s.view.tokens, characters: s.view.characters }) : null));

  return (
    <div style={{ position: "fixed", inset: 0, height: "100dvh", overflow: "hidden", background: theme.color.stage, color: theme.color.text, fontFamily: theme.font.body }}>
      {gate.kind === "ready" ? (
        <>
          <MapStage
            scene={gate.scene}
            fog={gate.fog}
            role="player"
            actionBar={false}
            insets={NO_INSETS}
            onSelect={noop}
            onOpenDetails={noop}
            controlledCamera={camera}
            ignoreFocus={mode !== "follow"}
            view={viewChoice.shown}
          />
          <SceneLoadingOverlay insets={NO_INSETS} />
        </>
      ) : (
        <Centered>
          {gate.kind === "blackout" ? (
            "The DM has paused the game."
          ) : gate.kind === "noScene" ? (
            "Waiting for the DM to choose a scene."
          ) : (
            <Loading text="Loading the scene…" />
          )}
        </Centered>
      )}
      {/* Every tap lands here first: a display takes no input on the map. */}
      <div
        aria-hidden
        onPointerUp={(e) => {
          if (e.button === 0) press(null);
        }}
        style={{ position: "absolute", inset: 0, zIndex: 10, touchAction: "none", cursor: cursorHidden ? "none" : "default" }}
      />
      {turn && gate.kind === "ready" ? <TurnPill text={turn} /> : null}
      <DisplayBanner state={connection} />
      {handout.current ? (
        paging.state ? (
          <HandoutPagesView key={showing} handout={handout.current} paging={paging} onTap={() => press(null)} onClose={handout.close} />
        ) : (
          <HandoutView handout={handout.current} onClose={handout.close} />
        )
      ) : null}
      <XCardHost tapCloses card={xcard} />
      {isoOffered ? <ViewVoice /> : null}
      {menu.open ? (
        <DisplayMenu
          roomId={props.roomId}
          menuRef={menu.ref}
          mode={mode}
          view={viewChoice}
          showTurn={showTurn}
          onMode={(m) => {
            setMode(m);
            menu.touch();
          }}
          onTurn={(on) => {
            setShowTurn(on);
            menu.touch();
          }}
          onTouch={menu.touch}
          onClose={menu.hide}
        />
      ) : null}
    </div>
  );
}

function noop(): void {}

function Centered(props: { children: ReactNode }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: theme.space(6), textAlign: "center", color: theme.color.textMuted, fontSize: TV_TEXT.message }}>
      {props.children}
    </div>
  );
}

/**
 * The display's camera mode, as a function of the canvas size for the map
 * (canvas/Stage.tsx controlledCamera):
 *
 * - Fit the map fits what players can see and the party, and fits again
 *   when that area changes, at most once every 2 s.
 * - Follow the DM fits the area a DM device sends (`view`), and until one
 *   arrives on this scene it fits the map. When the DM leaves for another
 *   scene the display keeps its last view.
 *
 * Each fits in the display's own view (`shown`), raised by the heights the
 * display has seen, through its shared fog (docs/design-v1-isometric-view.md
 * 4.2): never a height hidden from the players.
 */
function useDisplayCamera(gate: ReturnType<typeof sceneGate>, mode: DisplayMode, shown: View): ((viewport: Size) => Camera) | null {
  const scene = gate.kind === "ready" ? gate.scene : null;
  const fog = gate.kind === "ready" && gate.fog;
  const tokens = useRoomView((s) => s.view?.tokens);
  const fogTiles = useRoomView((s) => s.view?.fogTiles);
  const dmView = useRoomView((s) => s.ephemeral.view ?? null);
  const sceneId = scene?.id ?? null;
  const bounds = scene?.bounds;

  const revealed = useMemo(() => (scene && fog && fogTiles ? revealedMask(scene.bounds, scene.id, fogTiles) : null), [scene, fog, fogTiles]);
  const target = useMemo(
    () => (sceneId && bounds ? fitMapTarget({ bounds, revealed, tokens: Object.values(tokens ?? {}), sceneId }) : null),
    [sceneId, bounds, revealed, tokens],
  );

  // The fit applied last and when, per scene: a new scene fits at once.
  const [applied, setApplied] = useState<{ sceneId: string; rect: Rect; at: number } | null>(null);
  const current = applied && applied.sceneId === sceneId ? applied : null;
  useEffect(() => {
    if (!target || !sceneId) return;
    const now = Date.now();
    const at = refitAt({ target, applied: current?.rect ?? null, appliedAt: current?.at ?? 0, now });
    if (at === null) return;
    const apply = () => setApplied({ sceneId, rect: target, at: Date.now() });
    if (at <= now) {
      apply();
      return;
    }
    const timer = setTimeout(apply, at - now);
    return () => clearTimeout(timer);
  }, [target, sceneId, current]);

  const fitRectNow = current?.rect ?? null;
  const room = useRoomView((s) => s.view);
  // Every height the display may see, whatever its zoom, read only where a view is Isometric: the display's own or the DM's it follows.
  const isoInPlay = shown.kind === "isometric" || (mode === "follow" && dmView?.iso !== undefined);
  // Made again only when the build, the fog or the feet a cell change, not on every change to the room.
  const chunks = room?.buildChunks;
  const feet = room?.meta.settings.feetPerCell;
  const seen = useMemo(() => (isoInPlay && scene && room ? displaySeen({ room, scene, fog }) : null), [isoInPlay, scene, chunks, fogTiles, feet, fog]);
  return useMemo(() => {
    if (mode === "follow" && dmView) {
      const v = { x: dmView.x, y: dmView.y, w: dmView.w, h: dmView.h, ...(dmView.iso ? { iso: dmView.iso } : {}) };
      return (viewport: Size) => followCamera(viewport, v, shown, seen);
    }
    if (!fitRectNow) return null;
    return (viewport: Size) => fitRect(viewport, viewBox(shown, fitRectNow, seen ? liftIn(seen, fitRectNow) : 0), 24);
  }, [mode, dmView, fitRectNow, shown, seen]);
}

/** The menu a tap or a key shows for 5 s, and its timer. */
function useMenu() {
  const [open, setOpen] = useState(false);
  const [stamp, setStamp] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const focusFirst = useRef(false);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setOpen(false), MENU_MS);
    return () => clearTimeout(timer);
  }, [open, stamp]);
  useEffect(() => {
    if (!open || !focusFirst.current) return;
    focusFirst.current = false;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);
  return useMemo(
    () => ({
      open,
      ref,
      show(withKeys: boolean) {
        focusFirst.current = withKeys;
        setOpen(true);
        setStamp((n) => n + 1);
      },
      hide() {
        setOpen(false);
      },
      touch() {
        setStamp((n) => n + 1);
      },
      /** Moves focus among the menu's buttons, for a remote's arrow keys. */
      step(by: number) {
        const buttons = [...(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
        if (buttons.length === 0) return;
        const at = buttons.indexOf(document.activeElement as HTMLElement);
        buttons[(at + by + buttons.length) % buttons.length]?.focus();
      },
    }),
    [open],
  );
}

/** A mouse pointer left on a TV hides after a few seconds, and comes back when it moves. */
function useIdleCursor(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
      setHidden(false);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setHidden(true), 3_000);
    };
    wake();
    window.addEventListener("pointermove", wake);
    return () => {
      window.removeEventListener("pointermove", wake);
      if (timer) clearTimeout(timer);
    };
  }, []);
  return hidden;
}

/** A phone used as a display never zooms the page: the map has no gestures here, and iOS ignores touch-action for its pinch. */
function useNoGestureZoom(): void {
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", prevent, { passive: false });
    return () => document.removeEventListener("gesturestart", prevent);
  }, []);
}

/**
 * Handouts shown to everyone, the newest first, as players get them. A tap
 * on the display closes the one showing, on this device only, and the DM
 * closing it takes it away (the projection drops it). The closed ones are
 * kept per room and display, as a player's are (handouts/closed.ts).
 */
function useDisplayHandout(roomId: string, memberId: string | null): { current: Handout | null; close(): void } {
  const handouts = useRoomView((s) => s.view?.handouts);
  const store = useRoomScope().get(closedSlot);
  const { storageKey, closed, preferId } = useStore(store);
  const wantKey = memberId ? closedStorageKey(roomId, memberId) : null;
  useEffect(() => {
    if (wantKey) loadClosed(store, wantKey);
  }, [store, wantKey]);
  const current = handouts && wantKey && storageKey === wantKey ? nextPopup(handouts, closed, preferId) : null;
  const close = useCallback(() => {
    if (current && handouts) closeHandout(store, showingKey(current), handouts);
  }, [current, handouts, store]);
  return { current, close };
}

/** The handout over the map, whole and still: a display has no pinch. A tap anywhere closes it. */
function HandoutView(props: { handout: Handout; onClose(): void }) {
  const assets = useAssets();
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const key = showingKey(props.handout);
  return (
    <div
      role="dialog"
      aria-label={props.handout.title}
      onPointerUp={props.onClose}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 20,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        gap: theme.space(3),
        padding: `calc(${theme.safe.top} + ${theme.space(4)}px) ${theme.space(4)}px calc(${theme.safe.bottom} + ${theme.space(4)}px)`,
        background: TV_HANDOUT_SCRIM,
        cursor: "pointer",
      }}
    >
      <h2 style={{ margin: 0, textAlign: "center", fontSize: TV_TEXT.title, fontWeight: theme.weight.bold, overflowWrap: "anywhere" }}>{props.handout.title}</h2>
      <div style={{ position: "relative", minHeight: 0, display: "grid", placeItems: "center" }}>
        {failed === key ? (
          <p style={{ margin: 0, color: theme.color.textMuted, fontSize: TV_TEXT.message }}>The picture could not be loaded.</p>
        ) : (
          <>
            {loaded !== key ? <Loading text="Loading the handout…" style={{ position: "absolute", fontSize: TV_TEXT.body }} /> : null}
            <img
              key={key}
              src={assets.url(props.handout.assetId, "full")}
              alt={props.handout.title}
              onLoad={() => setLoaded(key)}
              onError={() => setFailed(key)}
              // A TV shows a small picture large: it fills the screen's room either way, its shape kept. It is
              // placed over the area rather than in its flow, since a percentage height in an area sized by its
              // content resolves to nothing, and the picture then took its height from its width and ran off the
              // bottom of a wide screen.
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", opacity: loaded === key ? 1 : 0 }}
            />
          </>
        )}
      </div>
    </div>
  );
}

type Paging = ReturnType<typeof useHandoutPaging>;

/**
 * The page a handout of two or more pages shows on this display, and its
 * bar (docs/design-v1-pdf-handouts.md 7). The page is kept per showing for
 * as long as the display shows the room, and never stored: a resync of the
 * same showing keeps it, a blackout lifting finds it again, a new showing
 * starts at page 1, and a reload starts again. The DM's device never moves
 * it. `state` is null for one page, which keeps the one-image rules.
 */
function useHandoutPaging(handout: Handout | null) {
  const key = handout ? showingKey(handout) : null;
  const pages = handout ? handoutPages(handout).length : 0;
  const [kept, setKept] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [barFor, setBarFor] = useState<string | null>(null);
  const [stamp, setStamp] = useState(0);
  // A new object each time, so asking for the same button twice still moves focus there.
  const [focusTo, setFocusTo] = useState<{ button: BarButton } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const page = key === null ? 0 : Math.min(kept.get(key) ?? 0, Math.max(0, pages - 1));
  const bar = key !== null && barFor === key;
  const state = useMemo<DisplayPaging | null>(() => (key !== null && pages > 1 ? { pages, page, bar } : null), [key, pages, page, bar]);

  useEffect(() => {
    if (!bar) return;
    const timer = setTimeout(() => setBarFor(null), MENU_MS);
    return () => clearTimeout(timer);
  }, [bar, stamp]);
  // After the render that shows the bar or changes the page, so the button is there and enabled.
  useEffect(() => {
    if (focusTo) barButtons(barRef.current)[BAR_BUTTONS.indexOf(focusTo.button)]?.focus();
  }, [focusTo]);

  return useMemo(() => {
    const focused = (): BarButton | null => BAR_BUTTONS[barButtons(barRef.current).indexOf(document.activeElement as HTMLButtonElement)] ?? null;
    const touch = () => setStamp((n) => n + 1);
    return {
      state,
      barRef,
      touch,
      step(by: 1 | -1) {
        if (key === null || !state) return;
        const next = stepPage(state.page, state.pages, by);
        if (next === state.page) return;
        const handOn = state.bar ? barFocusAfter(focused(), next, state.pages) : null;
        setKept((m) => new Map(m).set(key, next));
        if (handOn) setFocusTo({ button: handOn });
        if (state.bar) touch();
      },
      /** Shows the bar, with focus on its first button when a key opened it. */
      openBar(withKeys: boolean) {
        if (key === null || !state) return;
        setBarFor(key);
        touch();
        if (withKeys) setFocusTo({ button: barFirstFocus(state.page, state.pages) });
      },
      hideBar() {
        setBarFor(null);
      },
      /** A remote's arrows: focus to the bar's next or previous button. */
      move(by: 1 | -1) {
        if (!state) return;
        setFocusTo({ button: barMove(state.page, state.pages, focused(), by) });
        touch();
      },
      /**
       * Any other key while the bar shows. Enter or Space presses the button
       * with focus, so it goes on. With focus outside the bar, as after a tap
       * opened it, the key puts focus where opening it by a key would have.
       */
      barKey(name: string): boolean {
        if (!state) return false;
        if (focused() === null) {
          setFocusTo({ button: barFirstFocus(state.page, state.pages) });
          return false;
        }
        return name === "Enter" || name === " ";
      },
    };
  }, [key, state]);
}

function barButtons(bar: HTMLElement | null): HTMLButtonElement[] {
  return [...(bar?.querySelectorAll("button") ?? [])];
}

/** An element's box, kept current as the window resizes or a phone turns. */
function useBoxSize(ref: RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((s) => (s && s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * A handout of two or more pages on the TV (docs/design-v1-pdf-handouts.md
 * 7): one page at a time, fitted whole as one image is, with "Page 2 of 5"
 * under the title. The page showing and the next one load, so Next page is
 * usually instant. A tap shows the bar, and a tap beside it hides it.
 */
function HandoutPagesView(props: { handout: Handout; paging: Paging; onTap(): void; onClose(): void }) {
  const assets = useAssets();
  const pages = handoutPages(props.handout);
  const { page, bar } = props.paging.state ?? { page: 0, bar: false };
  const title = props.handout.title;
  const areaRef = useRef<HTMLDivElement>(null);
  const area = useBoxSize(areaRef);
  const shown = pages[page];
  const drawn = area && shown?.width && shown.height ? containRect(area, { width: shown.width, height: shown.height }) : null;
  return (
    <div
      role="dialog"
      aria-label={title}
      onPointerUp={props.onTap}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 20,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        gap: theme.space(3),
        padding: `calc(${theme.safe.top} + ${theme.space(4)}px) ${theme.space(4)}px calc(${theme.safe.bottom} + ${theme.space(4)}px)`,
        background: TV_HANDOUT_SCRIM,
        cursor: "pointer",
      }}
    >
      <div style={{ display: "grid", gap: theme.space(1), textAlign: "center" }}>
        <h2 style={{ margin: 0, fontSize: TV_TEXT.title, fontWeight: theme.weight.bold, overflowWrap: "anywhere" }}>{title}</h2>
        <p style={{ margin: 0, color: theme.color.textMuted, fontSize: TV_TEXT.body }}>{pageLine(page, pages.length)}</p>
      </div>
      <div ref={areaRef} style={{ position: "relative", minHeight: 0, display: "grid", placeItems: "center" }}>
        {[page, page + 1].flatMap((i) => {
          const p = pages[i];
          return p ? [<DisplayPage key={i} src={assets.url(p.assetId, "full")} alt={pageName(title, i, pages.length)} current={i === page} />] : [];
        })}
        {bar ? (
          <HandoutBar
            barRef={props.paging.barRef}
            page={page}
            pages={pages.length}
            below={area && drawn ? Math.max(0, area.height - drawn.y - drawn.height) : 0}
            onStep={props.paging.step}
            onTouch={props.paging.touch}
            onClose={props.onClose}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * One page in its place, as one image shows: "Loading the handout…" until
 * it loads, and the one image's failure line in its place if it fails. The
 * next page loads here too, unseen and hidden from screen readers.
 */
function DisplayPage(props: { src: string; alt: string; current: boolean }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  if (state === "failed") {
    return props.current ? <p style={{ margin: 0, color: theme.color.textMuted, fontSize: TV_TEXT.message }}>The picture could not be loaded.</p> : null;
  }
  return (
    <>
      {props.current && state === "loading" ? <Loading text="Loading the handout…" style={{ position: "absolute", fontSize: TV_TEXT.body }} /> : null}
      <img
        src={props.src}
        alt={props.alt}
        aria-hidden={props.current ? undefined : true}
        onLoad={() => setState("loaded")}
        onError={() => setState("failed")}
        // Placed over the area as one image is (HandoutView), so the bar over it never changes its size.
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", opacity: props.current && state === "loaded" ? 1 : 0 }}
      />
    </>
  );
}

/**
 * The handout's bar: Previous page, Next page and Close in the menu's
 * TV-sized buttons, over the page's bottom edge. It lies over the page and
 * takes no room from it, and its buttons wrap onto a second row on a screen
 * too narrow for one, such as a phone used as a display. A press on it
 * keeps it up, and a tap beside it falls through to the handout, which
 * hides it.
 *
 * It sits in a box from the area's top down to the page's bottom edge, as
 * far below as the page's shape leaves of the area. Its auto top margin
 * puts it at that box's foot, and in a box too short for it, gives way so
 * that it hangs from the area's top rather than rising over the title.
 */
function HandoutBar(props: {
  barRef: RefObject<HTMLDivElement | null>;
  page: number;
  pages: number;
  below: number;
  onStep(by: 1 | -1): void;
  onTouch(): void;
  onClose(): void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: props.below,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: theme.space(3),
        pointerEvents: "none",
      }}
    >
      <div
        ref={props.barRef}
        role="toolbar"
        aria-label="Handout pages"
        onPointerDown={props.onTouch}
        onPointerUp={(e) => e.stopPropagation()}
        style={{
          marginTop: "auto",
          maxWidth: "100%",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: theme.space(2),
          padding: theme.space(3),
          borderRadius: theme.radius.lg,
          background: theme.color.surface,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          boxShadow: theme.shadow.dialog,
          pointerEvents: "auto",
          cursor: "default",
        }}
      >
        <MenuButton grow icon="back" disabled={props.page <= 0} onClick={() => props.onStep(-1)}>
          Previous page
        </MenuButton>
        <MenuButton grow icon="chevronRight" disabled={props.page >= props.pages - 1} onClick={() => props.onStep(1)}>
          Next page
        </MenuButton>
        <MenuButton grow icon="close" onClick={props.onClose}>
          Close
        </MenuButton>
      </div>
    </div>
  );
}

function TurnPill(props: { text: string }) {
  return (
    <div
      role="status"
      style={{
        position: "absolute",
        top: `calc(${theme.safe.top} + ${theme.space(3)}px)`,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 12,
        maxWidth: "80%",
        padding: `${theme.space(2)}px ${theme.space(4)}px`,
        borderRadius: theme.radius.pill,
        background: theme.color.overlay,
        border: `${theme.line.border}px solid ${theme.color.accentSoft}`,
        color: theme.color.accentSoft,
        fontSize: TV_TEXT.turn,
        fontWeight: theme.weight.bold,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        pointerEvents: "none",
      }}
    >
      {props.text}
    </div>
  );
}

/** The connection banner, after 3 s without one, worded for a screen that changes nothing. It shows over a handout, which would hide it. */
function DisplayBanner(props: { state: ConnectionState }) {
  const connected = props.state === "open";
  const [due, setDue] = useState(false);
  useEffect(() => {
    setDue(false);
    if (connected) return;
    const timer = setTimeout(() => setDue(true), BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connected]);
  if (connected || !due) return null;
  return (
    <div
      role="status"
      style={{
        position: "absolute",
        top: `calc(${theme.safe.top} + ${theme.space(3)}px)`,
        left: theme.space(3),
        right: theme.space(3),
        zIndex: 25,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <Notice
        tone={props.state === "offline" ? "danger" : "warning"}
        leading={<ConnectionDot state={props.state} />}
        style={{ padding: `${theme.space(2)}px ${theme.space(4)}px`, fontSize: TV_TEXT.body }}
      >
        {props.state === "offline" ? "This display is offline. It reconnects on its own." : "Reconnecting to the room…"}
      </Notice>
    </div>
  );
}

/**
 * Follow the DM, Fit the map, the view once Isometric is offered, whose
 * turn it is, the text size, Full screen and Leave. Big targets, readable
 * from the couch, and reachable with a remote's arrow keys. Leave signs
 * the display out for good, so it asks for a second press.
 *
 * The text size is this device's interface size (features/device), which
 * the display has no This device page to set: a 1280 x 720 TV across a room
 * draws names and chips at about 10 px. It is kept on the device, as every
 * display choice is.
 */
function DisplayMenu(props: {
  roomId: string;
  menuRef: RefObject<HTMLDivElement | null>;
  mode: DisplayMode;
  view: ViewChoiceState;
  showTurn: boolean;
  onMode(mode: DisplayMode): void;
  onTurn(on: boolean): void;
  onTouch(): void;
  onClose(): void;
}) {
  const [armed, setArmed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fullscreen = useFullscreen();
  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    setError(null);
    try {
      await api.leaveDisplay();
      forgetDisplayRoom(props.roomId);
      void exitFullscreen();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign this display out. Try again.");
      setLeaving(false);
    }
  };
  return (
    <div
      ref={props.menuRef}
      role="menu"
      aria-label="Table display"
      onPointerDown={props.onTouch}
      style={{
        position: "absolute",
        left: "50%",
        bottom: `calc(${theme.safe.bottom} + ${theme.space(6)}px)`,
        transform: "translateX(-50%)",
        zIndex: 30,
        width: "min(560px, calc(100% - 32px))",
        // With the View rows it is taller than a small phone held upright at 130%, so past the screen it scrolls, as far from the top as from the foot. Every box is border-box (globals.css), so its padding and border are inside the height.
        ...(isoOffered ? { maxHeight: `calc(100% - ${theme.safe.top} - ${theme.safe.bottom} - ${2 * theme.space(6)}px)`, overflowY: "auto" as const, overscrollBehavior: "contain" as const } : null),
        display: "grid",
        gap: theme.space(2),
        padding: theme.space(3),
        borderRadius: theme.radius.lg,
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        boxShadow: theme.shadow.dialog,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: theme.space(2) }}>
        <MenuButton role="menuitemradio" checked={props.mode === "follow"} onClick={() => props.onMode("follow")}>
          Follow the DM
        </MenuButton>
        <MenuButton role="menuitemradio" checked={props.mode === "fit"} onClick={() => props.onMode("fit")}>
          Fit the map
        </MenuButton>
      </div>
      {isoOffered ? <DisplayView choice={props.view} onTouch={props.onTouch} /> : null}
      <MenuButton role="menuitemcheckbox" checked={props.showTurn} onClick={() => props.onTurn(!props.showTurn)}>
        Show whose turn it is: {props.showTurn ? "on" : "off"}
      </MenuButton>
      <TextSize onTouch={props.onTouch} />
      {fullscreenSupported() ? (
        <MenuButton
          role="menuitem"
          onClick={() => {
            void toggleFullscreen();
            props.onTouch();
          }}
        >
          {fullscreen ? "Leave full screen" : "Full screen"}
        </MenuButton>
      ) : null}
      <MenuButton
        role="menuitem"
        danger
        armed={armed}
        disabled={leaving}
        onClick={() => {
          props.onTouch();
          if (armed) void leave();
          else setArmed(true);
        }}
      >
        {leaving ? "Signing out…" : armed ? "Sign this display out? Press again" : "Leave"}
      </MenuButton>
      {armed && !leaving ? (
        <p style={{ margin: 0, color: theme.color.textMuted, fontSize: TV_TEXT.small, lineHeight: theme.leading.body }}>
          Leave signs this display out for good. To show the room here again, the DM makes a new code.
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={{ margin: 0, color: theme.color.dangerText, fontSize: TV_TEXT.small }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The View menu's rows at the TV's size (docs/design-v1-isometric-view.md
 * 7): Follow the scene with the scene's suggestion under it, Top-down and
 * Isometric, kept for this display apart from any member's pick in the
 * same browser, then Turn left and Turn right while it shows Isometric.
 */
function DisplayView(props: { choice: ViewChoiceState; onTouch(): void }) {
  const { choice } = props;
  const helpId = useId();
  const leftId = useId();
  const rightId = useId();
  const value = choiceOf(choice.stored.pick);
  const turn = (by: 1 | -1) => {
    choice.turn(by);
    props.onTouch();
  };
  return (
    <div role="group" aria-label={VIEW_GROUP} style={{ display: "grid", gap: theme.space(2) }}>
      <span style={{ fontSize: TV_TEXT.small, fontWeight: theme.weight.bold }}>{VIEW_GROUP}</span>
      {/* The three share a line where it holds them, and Follow the scene takes a line of its own where it does not. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        {VIEW_CHOICES.map((c) => (
          <MenuButton
            key={c}
            role="menuitemradio"
            checked={c === value}
            grow
            describedBy={c === "follow" ? helpId : undefined}
            onClick={() => {
              choice.pick(pickOf(c));
              props.onTouch();
            }}
          >
            {choiceWords(c)}
          </MenuButton>
        ))}
      </div>
      <p id={helpId} style={{ margin: 0, color: theme.color.textMuted, fontSize: TV_TEXT.small, lineHeight: theme.leading.body }}>
        <SuggestionHelp suggested={choice.suggested} />
      </p>
      {choice.shown.kind === "isometric" ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          <MenuButton role="menuitem" grow describedBy={leftId} onClick={() => turn(-1)}>
            {TURN_LEFT}
          </MenuButton>
          <MenuButton role="menuitem" grow describedBy={rightId} onClick={() => turn(1)}>
            {TURN_RIGHT}
          </MenuButton>
          <span id={leftId} style={VISUALLY_HIDDEN}>
            {TURN_LEFT_DESCRIPTION}
          </span>
          <span id={rightId} style={VISUALLY_HIDDEN}>
            {TURN_RIGHT_DESCRIPTION}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** One row: the names, chips and badges on the map at 85% to 130%. */
function TextSize(props: { onTouch(): void }) {
  const scale = useUiScale();
  return (
    <div role="group" aria-label="Text size" style={{ display: "grid", gridTemplateColumns: "auto repeat(4, minmax(0, 1fr))", alignItems: "center", gap: theme.space(2) }}>
      <span style={{ padding: `0 ${theme.space(1)}px`, fontSize: TV_TEXT.small, fontWeight: theme.weight.bold }}>Text size</span>
      {UI_SCALES.map((s) => (
        <MenuButton
          key={s}
          role="menuitemradio"
          checked={scale === s}
          compact
          onClick={() => {
            chooseDisplayUiScale(s);
            props.onTouch();
          }}
        >
          {uiScaleLabel(s)}
        </MenuButton>
      ))}
    </div>
  );
}

function MenuButton(props: {
  /** None for a plain button, as on a handout's bar. */
  role?: "menuitem" | "menuitemradio" | "menuitemcheckbox";
  checked?: boolean;
  danger?: boolean;
  armed?: boolean;
  disabled?: boolean;
  /** Less room each side, for a row of several. */
  compact?: boolean;
  /** Grows to fill its row in a wrapping bar. */
  grow?: boolean;
  /** The icon alone, at the TV's size, its words (`children`) its name and tooltip (docs/design-v1-icons.md 3.1 rule 1). */
  icon?: IconName;
  /** The id of a line that says what it means, such as Follow the scene's suggestion. */
  describedBy?: string;
  onClick(): void;
  children: ReactNode;
}) {
  const on = props.checked === true;
  const words = typeof props.children === "string" ? props.children : "";
  const tooltip = useTooltip(words);
  const button = (
    <button
      type="button"
      role={props.role}
      aria-checked={props.role === undefined || props.role === "menuitem" ? undefined : on}
      aria-label={props.icon ? words : undefined}
      aria-describedby={props.describedBy}
      {...(props.icon ? tooltip.anchor() : null)}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        flex: props.grow ? "1 1 auto" : undefined,
        minHeight: TV_BUTTON_HEIGHT,
        minWidth: 0,
        padding: `0 ${theme.space(props.compact ? 1 : 4)}px`,
        borderRadius: theme.radius.md,
        // A disabled Leave is signing out: it keeps its red, as a busy button keeps its color.
        ...choiceLook(on, props.disabled === true && props.danger !== true),
        fontSize: props.compact ? TV_TEXT.small : TV_TEXT.body,
        fontWeight: theme.weight.bold,
        fontFamily: theme.font.body,
        cursor: props.disabled ? "default" : "pointer",
        ...(props.danger ? destructiveStyle(props.armed === true) : null),
        ...(props.icon ? { display: "inline-grid", placeItems: "center", minWidth: TV_BUTTON_HEIGHT } : null),
      }}
    >
      {props.icon ? <Icon name={props.icon} size={TV_ICON} /> : props.children}
    </button>
  );
  if (!props.icon) return button;
  return (
    <>
      {button}
      {tooltip.tip}
    </>
  );
}

/** An icon in a TV button, a little larger than its 18 px words, so it reads across a room. */
const TV_ICON = 28;

/** A terminal close: signed out (Leave elsewhere, the DM's Sign out, a new player password, or pairing with another room), refused, or the room deleted. */
function DisplayEnded(props: { ended: Ended; roomId: string }) {
  const movedTo = useMovedTo(props.roomId);
  const { title, body } = endedText(props.ended.kind, movedTo);
  useEffect(() => {
    forgetDisplayRoom(props.roomId);
  }, [props.roomId]);
  return (
    <div style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", padding: theme.space(6), background: theme.color.stage, color: theme.color.text, fontFamily: theme.font.body, textAlign: "center" }}>
      <div style={{ display: "grid", gap: theme.space(4), maxWidth: 520 }}>
        <h1 style={{ margin: 0, fontSize: TV_TEXT.title }}>{title}</h1>
        <p style={{ margin: 0, color: theme.color.textMuted, fontSize: TV_TEXT.body, lineHeight: 1.5 }}>{body}</p>
        <div style={{ display: "flex", gap: theme.space(3), justifyContent: "center" }}>
          <EndButton primary onClick={() => navigate("/display", { replace: true })}>
            Set up again
          </EndButton>
          <EndButton onClick={() => navigate("/", { replace: true })}>Home</EndButton>
        </div>
      </div>
    </div>
  );
}

/**
 * The room another tab or window of this browser paired this device with,
 * if it did: the room it remembers (remember.ts) is then another one. That
 * tab may write it only after this one was closed, so a later change counts
 * too.
 */
function useMovedTo(roomId: string): string | null {
  const other = (remembered: string | null) => (remembered !== null && remembered !== roomId ? remembered : null);
  const [movedTo, setMovedTo] = useState(() => other(rememberedDisplayRoom()));
  useEffect(() => {
    const onStorage = () => {
      const moved = other(rememberedDisplayRoom());
      if (moved !== null) setMovedTo(moved);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [roomId]);
  return movedTo;
}

function EndButton(props: { primary?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <Button variant={props.primary ? "primary" : "secondary"} onClick={props.onClick} style={{ minHeight: TV_BUTTON_HEIGHT, fontSize: TV_TEXT.body }}>
      {props.children}
    </Button>
  );
}
