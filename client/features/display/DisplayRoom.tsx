import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useStore } from "zustand";
import type { Handout } from "#shared/model.ts";
import { MapStage } from "../../canvas/Stage.tsx";
import { SceneLoadingOverlay } from "../../canvas/SceneLoading.tsx";
import { Button, destructiveStyle } from "../../components/Button.tsx";
import { ConnectionDot } from "../../components/ConnectionStatus.tsx";
import { Loading } from "../../components/Loading.tsx";
import { choiceLook } from "../../components/looks.ts";
import { Notice } from "../../components/Notice.tsx";
import { api, ApiError, displayAssetUrl, type AssetVariant } from "../../lib/api.ts";
import { fitRect, NO_INSETS, type Camera, type Rect, type Size } from "../../lib/camera.ts";
import { BANNER_DELAY_MS, type ConnectionState } from "../../lib/connection.ts";
import { revealedMask } from "../../lib/fogTiles.ts";
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
import { nextPopup, showingKey } from "../handouts/handouts.ts";
import { useXCard, XCardHost } from "../xcard/XCardHost.tsx";
import { UI_SCALES, uiScaleLabel, useUiScale } from "../device/settings.ts";
import { displayPress, endedText, fitMapTarget, followCamera, MENU_MS, refitAt, turnText, type DisplayMode, type Overlay } from "./logic.ts";
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

const fullscreenAvailable = () => typeof document !== "undefined" && document.fullscreenEnabled === true;

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
  // The X-card shows over a handout, so a tap closes the card first and the handout with the next.
  const xcard = useXCard();
  const overlay: Overlay = xcard.showing ? "xcard" : handout.current ? "handout" : null;
  const menu = useMenu();
  const cursorHidden = useIdleCursor();

  const press = useCallback(
    (key: boolean) => {
      const what = displayPress({ overlay, menu: menu.open, key });
      if (what === "closeOverlay") {
        if (overlay === "xcard") xcard.dismiss();
        else handout.close();
      } else if (what === "openMenu") menu.show(key);
      else if (what === "closeMenu") menu.hide();
      else menu.touch();
    },
    [overlay, menu, handout, xcard],
  );

  // Any key shows the menu, as a TV remote's OK button would. Inside the menu the keys move between its buttons.
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
      if (e.key === "Tab") return;
      e.preventDefault();
      press(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, overlay, press]);

  const camera = useDisplayCamera(gate, mode);
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
          if (e.button === 0) press(false);
        }}
        style={{ position: "absolute", inset: 0, zIndex: 10, touchAction: "none", cursor: cursorHidden ? "none" : "default" }}
      />
      {turn && gate.kind === "ready" ? <TurnPill text={turn} /> : null}
      <DisplayBanner state={connection} />
      {handout.current ? <HandoutView handout={handout.current} onClose={handout.close} /> : null}
      <XCardHost tapCloses card={xcard} />
      {menu.open ? (
        <DisplayMenu
          roomId={props.roomId}
          menuRef={menu.ref}
          mode={mode}
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
 */
function useDisplayCamera(gate: ReturnType<typeof sceneGate>, mode: DisplayMode): ((viewport: Size) => Camera) | null {
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
  return useMemo(() => {
    if (mode === "follow" && dmView) {
      const v = { x: dmView.x, y: dmView.y, w: dmView.w, h: dmView.h };
      return (viewport: Size) => followCamera(viewport, v);
    }
    if (!fitRectNow) return null;
    return (viewport: Size) => fitRect(viewport, fitRectNow, 24);
  }, [mode, dmView, fitRectNow]);
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
 * Follow the DM, Fit the map, whose turn it is, the text size, Full screen
 * and Leave. Big targets, readable from the couch, and reachable with a
 * remote's arrow keys. Leave signs the display out for good, so it asks for
 * a second press.
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
  showTurn: boolean;
  onMode(mode: DisplayMode): void;
  onTurn(on: boolean): void;
  onTouch(): void;
  onClose(): void;
}) {
  const [armed, setArmed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(() => document.fullscreenElement !== null);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    setError(null);
    try {
      await api.leaveDisplay();
      forgetDisplayRoom(props.roomId);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
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
      <MenuButton role="menuitemcheckbox" checked={props.showTurn} onClick={() => props.onTurn(!props.showTurn)}>
        Show whose turn it is: {props.showTurn ? "on" : "off"}
      </MenuButton>
      <TextSize onTouch={props.onTouch} />
      {fullscreenAvailable() ? (
        <MenuButton
          role="menuitem"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
            else void document.documentElement.requestFullscreen().catch(() => {});
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
  role: "menuitem" | "menuitemradio" | "menuitemcheckbox";
  checked?: boolean;
  danger?: boolean;
  armed?: boolean;
  disabled?: boolean;
  /** Less room each side, for a row of several. */
  compact?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  const on = props.checked === true;
  return (
    <button
      type="button"
      role={props.role}
      aria-checked={props.role === "menuitem" ? undefined : on}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
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
      }}
    >
      {props.children}
    </button>
  );
}

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
