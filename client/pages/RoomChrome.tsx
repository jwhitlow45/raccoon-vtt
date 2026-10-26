import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { largerEach } from "../canvas/barDock.ts";
import { fitSlot } from "../canvas/fitSlot.ts";
import { ReconnectBanner } from "../components/ConnectionStatus.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { Popover, usePopover, type Rect } from "../components/Popover.tsx";
import { addsWords, useTooltip } from "../components/Tooltip.tsx";
import { useLayoutSize } from "../features/device/layout.ts";
import { uiScale } from "../features/device/settings.ts";
import { usePreview } from "../features/dm/previewContext.ts";
import { findCamera, findRect, nextOwnToken, sheetCover, type OpenSheet } from "../features/find/findToken.ts";
import { badgeText } from "../features/log/unread.ts";
import { SheetDialog } from "../features/tokens/SheetDialog.tsx";
import { VIEW_GROUP, VIEW_TIP, viewButtonLabel } from "../features/view/choice.ts";
import { useRoomViewChoice, useViewVoice, ViewMenuBody, ViewVoice, type ViewChoiceState } from "../features/view/ViewMenu.tsx";
import { XCardButton } from "../features/xcard/XCardButton.tsx";
import type { Turn } from "../lib/view.ts";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { accentVars } from "../lib/accent.ts";
import { escapeTarget } from "../lib/escape.ts";
import { toggleFullscreen, useFullscreen } from "../lib/fullscreen.ts";
import { takeReopen } from "../lib/reopen.ts";
import { preloadLazies } from "../lib/retryableLazy.ts";
import { theme } from "../lib/theme.ts";
import { APP_TITLE, roomTitle } from "../lib/title.ts";
import { useAccent } from "../state/accent.ts";
import { barDismiss, dismissal } from "../state/selection.ts";
import { useScoped } from "../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../state/view.ts";

/*
 * Pieces of the Room page's shell (Room.tsx) that hold no layout of their
 * own: the tab's title, the page that never zooms, Escape, panels loading
 * in the background, the blackout's pause screen, the top bar's buttons,
 * and the toolbar's labels and unread badge. Room.tsx places them, and
 * stays about the layout.
 */

/**
 * The tab reads `RaccoonVTT · <room name>` while the room is open, and
 * follows a rename (lib/title.ts). "View as a player" draws a second Room
 * page over the DM's, and leaves the title to the DM's: two pages setting
 * it would race, and the one closed first would put the plain title back
 * while the DM's page is still open.
 */
export function useRoomTitle(): void {
  const name = useRoomView((s) => s.view?.meta.name ?? "");
  const preview = usePreview() !== null;
  useEffect(() => {
    if (preview) return;
    document.title = roomTitle(name);
    return () => {
      document.title = APP_TITLE;
    };
  }, [name, preview]);
}

/**
 * The viewing member's accent (lib/accent.ts) as CSS variables, for the
 * Room page's root element. Outside a "view as a player" preview they go on
 * the document too, for sheets and dialogs portaled to the body and for the
 * focus ring and selection in globals.css. A preview keeps them to its own
 * page, so the DM's room behind it keeps the DM's color. Leaving the room
 * puts the crest yellow back. A layout effect, so the first paint already
 * has the color.
 */
export function useAccentVars(): CSSProperties {
  const accent = useAccent();
  const preview = usePreview() !== null;
  const vars = useMemo(() => accentVars(accent), [accent]);
  useLayoutEffect(() => {
    if (preview) return;
    const style = document.documentElement.style;
    for (const [name, value] of Object.entries(vars)) style.setProperty(name, value);
    return () => {
      for (const name of Object.keys(vars)) style.removeProperty(name);
    };
  }, [vars, preview]);
  return vars as CSSProperties;
}

/**
 * The page never zooms while a room is open. A pinch that lands on the top
 * bar, a sheet or a handout instead of the map zoomed the whole page on
 * Android and left the player stuck in it, with the toolbar off screen.
 * The map (Stage.tsx) and a handout (HandoutPopup.tsx) have zooms of their
 * own, which is all a room needs.
 *
 * - Android Chrome: the viewport's user-scalable=no, set only while a room
 *   is open so Home and the join page still zoom.
 * - iOS Safari ignores that, and touch-action does not stop its pinch, so
 *   its own gesture events are prevented.
 * - The room's root also has touch-action: pan-x pan-y (Room.tsx), which
 *   lets sheets scroll but not pinch.
 */
export function useNoPageZoom(): void {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const before = meta?.content ?? null;
    if (meta && before !== null && !/user-scalable/.test(before)) meta.content = `${before}, maximum-scale=1, user-scalable=no`;
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", prevent, { passive: false });
    document.addEventListener("gesturechange", prevent, { passive: false });
    return () => {
      if (meta && before !== null) meta.content = before;
      document.removeEventListener("gesturestart", prevent);
      document.removeEventListener("gesturechange", prevent);
    };
  }, []);
}

/**
 * Escape closes a phone's sheet, then the token action bar, then lets go
 * of a Multi-select group whose bar is hidden, then of a token whose bar
 * is hidden (lib/escape.ts), unless the token's panel shows the selection
 * (`tokenPanelShown`, state/selection.ts dismissal). While the panel shows
 * the token, the bar hides and keeps it (barDismiss), through `hideBar`,
 * which also sends focus to the panel. A map pane (a label, pin or light
 * pane) takes Escape before a token is let go, and closes on it.
 */
export function useEscape(sheetOpen: boolean, closeSheets: () => void, tokenPanelShown: boolean, hideBar: () => void): void {
  const ui = useRoomUi();
  const store = useRoomStore();
  const latest = useRef({ sheetOpen, closeSheets, tokenPanelShown, hideBar });
  latest.current = { sheetOpen, closeSheets, tokenPanelShown, hideBar };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const local = store.getState().local;
      const away = dismissal(local, latest.current.tokenPanelShown, document.querySelector("[data-map-pane]") !== null);
      const what = escapeTarget({
        dialogOpen: document.querySelector('[aria-modal="true"]') !== null,
        editing: target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)),
        sheetOpen: latest.current.sheetOpen,
        actionBar: away === "bar",
        group: away === "group",
        token: away === "token",
      });
      if (what === "sheet") latest.current.closeSheets();
      else if (what === "actionBar") {
        if (barDismiss(local, latest.current.tokenPanelShown) === "hide") latest.current.hideBar();
        else ui.select(null);
      } else if (what === "group") ui.doneSelecting();
      else if (what === "token") ui.select(null);
      // Marked as used, so the label pane (features/builder/LabelPane.tsx), which listens after this, stays open.
      if (what) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, ui]);
}

/** How long after the room connects its panels start loading in the background. */
const PRELOAD_DELAY_MS = 2_000;

/**
 * Once the room is connected, the panels and tool options this role may
 * open load in the background (lib/retryableLazy.ts), so one opened later
 * offline, or after a redeploy, still opens. A reload that a failed load
 * asked for opens the same panel or tool again (lib/reopen.ts).
 */
export function usePreloadAndReopen(role: "dm" | "player"): void {
  const ui = useRoomUi();
  const roomId = useRoomView((s) => s.roomId);
  const connected = useRoomView((s) => s.connection === "open");
  useEffect(() => {
    const again = takeReopen(roomId);
    if (again?.tool) ui.setTool(again.tool);
    if (again?.panel) ui.openPanel(again.panel);
  }, [roomId, ui]);
  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(() => preloadLazies(role), PRELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connected, role]);
}

/**
 * A player's whole screen during a blackout. The connection banner stays,
 * since it says nothing about the table. Toasts that arrive meanwhile are
 * dropped rather than kept for later, so nothing from the pause shows when
 * the game resumes. The X-card stays within reach, since the Menu that
 * holds it is gone and a pause may follow what someone needs edited out
 * (docs/design-v1-dm-tools.md 3.11).
 */
export function PauseScreen() {
  const toasts = useRoomView((s) => s.toasts);
  const connection = useRoomView((s) => s.connection);
  const ui = useRoomUi();
  useEffect(() => {
    for (const t of toasts) ui.dismissToast(t.id);
  }, [toasts, ui]);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        height: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: theme.space(6),
        background: theme.color.stage,
        color: theme.color.textMuted,
        fontFamily: theme.font.body,
        fontSize: theme.font.body14,
        textAlign: "center",
      }}
    >
      <div style={{ position: "absolute", top: `calc(${theme.safe.top} + ${theme.space(3)}px)`, left: theme.space(3), right: theme.space(3), display: "flex", justifyContent: "center" }}>
        <div style={{ width: "100%", maxWidth: 520, minWidth: 0 }}>
          <ReconnectBanner state={connection} />
        </div>
      </div>
      <div style={{ display: "grid", gap: theme.space(6), justifyItems: "center", width: "100%", maxWidth: 360 }}>
        <p style={{ margin: 0 }}>The DM has paused the game.</p>
        <XCardButton />
      </div>
    </div>
  );
}

/**
 * The DM's Undo and Redo, one click or tap away in the top bar on every
 * layout (docs/design-v1-layout-hierarchy.md M2): Undo is used every
 * scene, and a DM with a mouse had only the DM panel's copy or Ctrl+Z.
 * Redo leaves (`redo` false) where a phone's row has no room even with the
 * chip as its dot, as on a 320 px phone at 130% with the View button.
 * They undo this member's own changes (design 7.7), and the server
 * answers an empty stack with a notice, so both stay enabled: knowing the
 * depth here would need a new field on the socket for each member.
 */
export function UndoButtons(props: { redo?: boolean }) {
  const actions = useRoomActions();
  return (
    <span style={{ flex: "none", display: "flex", marginRight: -theme.space(2) }}>
      <IconButton label="Undo" title="Undo your last change" draw="undo" onClick={() => actions.undo()} />
      {props.redo === false ? null : <IconButton label="Redo" title="Redo what you undid" draw="redo" onClick={() => actions.redo()} />}
    </span>
  );
}

/**
 * A 44 px square icon button for the top bar, in the shape of
 * components/IconButton.tsx. Its own, since Fit and Find draw shapes of
 * their own beside Undo, Redo and Full screen from Icon.tsx, and all of
 * them keep the text color: they are the bar's actions, not a header's
 * close.
 */
function IconButton(props: {
  label: string;
  title: string;
  draw: IconName | { path: string };
  onClick(e: { detail: number }): void;
  /** On the icon, such as the View button's flip to the view's turn. */
  iconStyle?: CSSProperties;
  /** What a popover's anchor adds (components/Popover.tsx anchorProps). */
  anchor?: Pick<ButtonHTMLAttributes<HTMLButtonElement>, "aria-haspopup" | "aria-expanded" | "aria-controls" | "onKeyDown"> & { ref?(el: HTMLElement | null): void };
}) {
  // The name on hover, keyboard focus and a long press, never the native title (docs/design-v1-icons.md 3.2).
  const tooltip = useTooltip(props.title, { describes: addsWords(props.title, props.label) });
  return (
    <>
      <button
        type="button"
        aria-label={props.label}
        {...props.anchor}
        {...tooltip.anchor()}
        onClick={props.onClick}
        style={{
          flex: "none",
          display: "grid",
          placeItems: "center",
          width: theme.touch,
          height: theme.touch,
          padding: 0,
          border: `${theme.line.border}px solid transparent`,
          borderRadius: theme.radius.md,
          background: "transparent",
          color: theme.color.text,
          cursor: "pointer",
        }}
      >
        {typeof props.draw === "string" ? (
          <Icon name={props.draw} style={props.iconStyle} />
        ) : (
          <svg aria-hidden viewBox="0 0 24 24" width={theme.icon.md} height={theme.icon.md} style={{ display: "block" }}>
            <path d={props.draw.path} fill="currentColor" />
          </svg>
        )}
      </button>
      {tooltip.tip}
    </>
  );
}

/**
 * The View button (docs/design-v1-isometric-view.md 7), before Fit in the
 * top bar on every layout, for the DM and players, once Isometric is
 * offered (features/view/choice.ts isoOffered). Named and drawn for the
 * view the board shows: a square grid in Top-down, and in Isometric a
 * diamond with the map's top edge marked, flipped to face where that edge
 * faces at the view's turn. It opens the View menu, a popover from 900 px
 * up and a bottom sheet on a phone. `onOpen` hears whether the popover is
 * open, so the bar can stand over the notices while it is
 * (docs/design-v1-tool-options.md 7.6). It also says each change of the
 * view in the polite status, whatever made it.
 */
export function ViewButton(props: { onOpen?(open: boolean): void }) {
  const choice = useRoomViewChoice();
  useViewVoice(choice);
  const wide = useLayoutSize().width >= theme.layout.wideMinWidth;
  // No tuck into the bar's padding, as the last button has: Fit always follows it, and a phone's 6 px gap would leave the two overlapping.
  return (
    <span style={{ flex: "none", display: "flex" }}>
      {wide ? <ViewPopover choice={choice} onOpen={props.onOpen} /> : <ViewSheet choice={choice} />}
    </span>
  );
}

/** Where the marked edge faces at each turn: the drawing's up and to the right, flipped (Icon.tsx viewIsometric). */
const ISO_FLIP: Readonly<Record<Turn, CSSProperties | undefined>> = { 0: undefined, 1: { transform: "scaleY(-1)" }, 2: { transform: "scale(-1, -1)" }, 3: { transform: "scaleX(-1)" } };

function ViewIconButton(props: { choice: ViewChoiceState; onClick(e: { detail: number }): void; anchor?: Parameters<typeof IconButton>[0]["anchor"] }) {
  const { shown } = props.choice;
  return (
    <IconButton
      label={viewButtonLabel(shown)}
      title={VIEW_TIP}
      draw={shown.kind === "isometric" ? "viewIsometric" : "viewTopDown"}
      iconStyle={shown.kind === "isometric" ? ISO_FLIP[shown.turn] : undefined}
      onClick={props.onClick}
      anchor={props.anchor}
    />
  );
}

function ViewPopover(props: { choice: ViewChoiceState; onOpen?(open: boolean): void }) {
  const handle = usePopover({ kind: "dialog" });
  const { onOpen } = props;
  const open = handle.open;
  useEffect(() => {
    onOpen?.(open);
  }, [open, onOpen]);
  useEffect(() => () => onOpen?.(false), [onOpen]);
  const { onClick, ...anchor } = handle.anchorProps;
  return (
    <>
      <ViewIconButton choice={props.choice} onClick={onClick} anchor={anchor} />
      <Popover handle={handle} side="below" bound={viewportBound} title={VIEW_GROUP}>
        <ViewMenuBody choice={props.choice} reserveTurns />
      </Popover>
      {open ? null : <ViewVoice />}
    </>
  );
}

function ViewSheet(props: { choice: ViewChoiceState }) {
  const opener = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <ViewIconButton
        choice={props.choice}
        onClick={() => setOpen(true)}
        anchor={{
          ref: (el) => void (opener.current = el),
          "aria-haspopup": "dialog",
          "aria-expanded": open,
        }}
      />
      {open ? (
        <SheetDialog title={VIEW_GROUP} opener={opener} onClose={() => setOpen(false)} width={theme.layout.dialog.sm}>
          <ViewMenuBody choice={props.choice} />
        </SheetDialog>
      ) : (
        <ViewVoice />
      )}
    </>
  );
}

function viewportBound(): Rect {
  const scale = uiScale();
  return { left: 0, top: 0, right: window.innerWidth / scale, bottom: window.innerHeight / scale };
}

/**
 * Fits the map to the screen (UP-20): the way back after zooming or
 * panning into the dark, which before took a reload. In the top bar, where
 * it never covers the map or the tool options.
 */
export function FitButton() {
  const slot = useScoped(fitSlot);
  return (
    <span style={{ flex: "none", display: "flex", marginRight: -theme.space(2) }}>
      <IconButton
        label="Fit the map to the screen"
        title="Fit the map to the screen"
        draw={{ path: "M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z" }}
        onClick={() => slot.fit?.()}
      />
    </span>
  );
}

/**
 * The whole page in full screen and back (lib/fullscreen.ts), last in the
 * top bar on a computer, for the DM and players. The Room page leaves it
 * out where the browser cannot go full screen. Named for what a press
 * does, with an icon for each.
 */
export function FullscreenButton() {
  const on = useFullscreen();
  const label = on ? "Leave full screen" : "Full screen";
  return (
    <span style={{ flex: "none", display: "flex", marginRight: -theme.space(2) }}>
      <IconButton label={label} title={label} draw={on ? "leaveFullScreen" : "fullScreen"} onClick={() => void toggleFullscreen()} />
    </span>
  );
}

/**
 * "Find my token" (features section 5), beside Fit map on a player's top
 * bar: each press pans and zooms to the next token they own on this scene
 * (features/find/findToken.ts), and says so when they have none here. The
 * DM has none: their top bar is already full on a phone, and a tracker row
 * or "follow the turn" already brings any creature into view.
 */
export function FindButton(props: { openSheet(): OpenSheet | null }) {
  const slot = useScoped(fitSlot);
  const store = useRoomStore();
  const ui = useRoomUi();
  const lastRef = useRef<string | null>(null);
  const find = () => {
    const { view, you, sceneId } = store.getState();
    if (!view || !you || !sceneId) return;
    const token = nextOwnToken({ view, sceneId, memberId: you.memberId, lastId: lastRef.current });
    if (!token) {
      ui.notify("You have no token on this scene.");
      return;
    }
    lastRef.current = token.id;
    const target = findRect(token);
    const cover = sheetCover(props.openSheet());
    // The open sheet's cover and the token bar's, the larger on each side.
    slot.show?.((viewport, bars, bar) => findCamera(viewport, target, bars, largerEach(cover, bar)));
  };
  return (
    <span style={{ flex: "none", display: "flex", marginRight: -theme.space(2) }}>
      <IconButton
        label="Find my token"
        title="Find my token"
        draw={{ path: "M11 1h2v4h-2zm0 18h2v4h-2zM1 11h4v2H1zm18 0h4v2h-4zM12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14zm0 2a5 5 0 1 1 0 10a5 5 0 1 1 0-10zm0 2.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z" }}
        onClick={find}
      />
    </span>
  );
}

/**
 * An icon with its name under it, for the phone toolbar. Icons alone left
 * the DM guessing which of nine was the fog and which the grid (UD-13).
 * The name stays readable to screen readers: a tool button's own label
 * replaces it anyway, and the Panels button has no other, so hiding it
 * left that button named only by its badge ("3 unread").
 */
export function Stacked(props: { icon: ReactNode; text: string }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
      {props.icon}
      <span style={{ fontSize: theme.font.tiny, lineHeight: 1, whiteSpace: "nowrap" }}>
        {props.text}
      </span>
    </span>
  );
}

/**
 * A small count of unread messages beside a panel's name, or on the
 * corner of the Panels button so the toolbar keeps its width. Screen
 * readers hear "3 unread", or `label` where the count is of something
 * else, such as "1 upload waiting" (docs/design-v1-pdf-handouts.md 4.1.1).
 * A count is a status, so it never wears the accent: text-colored with
 * dark digits, the same for every member (docs/design-v1-visual.md 2.2).
 */
export function Badge(props: {
  count: number;
  corner?: boolean;
  label?: string;
  /**
   * False leaves out its hidden "N unread", for a button whose name may
   * be another panel's title while its count covers several panels: the
   * side panel's More says its count in its description instead.
   */
  spoken?: boolean;
}) {
  const text = badgeText(props.count);
  if (!text) return null;
  return (
    <span
      style={{
        ...(props.corner ? { position: "absolute" as const, top: -6, right: -4 } : null),
        display: "inline-grid",
        placeItems: "center",
        minWidth: 18,
        height: 18,
        marginLeft: props.corner ? 0 : theme.space(1.5),
        padding: `0 ${theme.space(1)}px`,
        borderRadius: theme.radius.pill,
        background: theme.color.text,
        color: theme.color.bg,
        fontSize: theme.font.tiny,
        fontWeight: theme.weight.bold,
        lineHeight: 1,
        verticalAlign: "middle",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span aria-hidden>{text}</span>
      {props.spoken === false ? null : <span style={VISUALLY_HIDDEN}>{props.label || `${props.count} unread`}</span>}
    </span>
  );
}
