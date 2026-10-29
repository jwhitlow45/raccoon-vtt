import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  barDockSlot,
  barOpening,
  barStack,
  barToastTop,
  columnEdges,
  DEFAULT_CHROME,
  EDGE,
  fitToasts,
  freeArea,
  inToastLayer,
  nextToastPlaces,
  NO_TOAST_PLACES,
  noticePlace,
  paneToastTop,
  restFloor,
  spanToastSlot,
  TOAST_MIN,
  toastsOverBars,
  toastLayerPlace,
  toastsUnderHead,
  toastTop,
  type Chrome,
  type ToastEdges,
  type ToastPlaces,
  type Typing,
} from "../canvas/barDock.ts";
import { BarWidthProbe } from "../canvas/BarWidthProbe.tsx";
import { SCROLL_FOR_MORE_PX, ScrollForMore } from "../canvas/TokenActionBar.tsx";
import { SceneLoadingOverlay } from "../canvas/SceneLoading.tsx";
import { MapStage } from "../canvas/Stage.tsx";
import { Button } from "../components/Button.tsx";
import { ConnectionDot, ReconnectNotice, useReconnectDue } from "../components/ConnectionStatus.tsx";
import { Card, Page } from "../components/Field.tsx";
import { LoadBoundary } from "../components/LoadBoundary.tsx";
import { SectionLabel } from "../components/Panel.tsx";
import { Row } from "../components/Row.tsx";
import { returnFocusAfterSheet, sheetFocusSlot, useAlertsSummaryEntry, useDockSummaryButton } from "../components/sheetFocus.ts";
import { SheetHeader } from "../components/SheetHeader.tsx";
import { NOTICE_TONES } from "../components/tones.ts";
import { addsWords, useTooltip } from "../components/Tooltip.tsx";
import { QuietLoadNotice } from "./QuietLoadNotice.tsx";
import { Loading } from "../components/Loading.tsx";
import { ScrollStrip } from "../components/ScrollStrip.tsx";
import { Sheet, paneBodyPadding, type SheetMode } from "../components/Sheet.tsx";
import { headerStacks, SHEET_HEADER, SHEET_HEADER_STACKED, sheetCap, sheetKeyboard, sheetMode, sheetWidth, sideSheetWidth } from "../components/sheetCap.ts";
import { SHORT_LANDSCAPE_MAX, useRecordOverflow, useTopBars, useTurnPlacement, type TurnPlacement } from "../features/encounter/band.ts";
import { FightWatch, InitiativeStrip, useYourTurnNotice } from "../features/encounter/InitiativeStrip.tsx";
import { panelById, panelSections, panelsFor, panelSubject, subpageBack, usePanelScroll, useSubpageFocus, type PanelClose, type PanelDef, type PanelHeader } from "../features/panels.ts";
import { PartyDock } from "../features/party/PartyDock.tsx";
import type { OpenSheet } from "../features/find/findToken.ts";
import { HandoutPopup } from "../features/handouts/HandoutPopup.tsx";
import { EditorHost } from "../features/monsters/EditorHost.tsx";
import { PcStatsHost } from "../features/pcstats/PcStatsEditor.tsx";
import { useJobWaiting, usePdfJobRoom } from "../features/handouts/pdf/live.ts";
import { useJournalUnread } from "../features/journal/store.ts";
import { useLogUnread } from "../features/log/useLogUnread.ts";
import { D20Icon } from "../features/dice/throw/D20Icon.tsx";
import { useRollToasts } from "../features/dice/useRollToasts.ts";
import { PhaseMenu } from "../features/phases/PhaseMenu.tsx";
import { FrameViewBar } from "../features/scenes/FrameView.tsx";
import { barInset, chromeZoom, layoutWidth, smallUi, useLayoutSize } from "../features/device/layout.ts";
import { uiScale as uiScaleNow, useUiScale } from "../features/device/settings.ts";
import { activeTool, toolsFor, type ToolDef } from "../features/tools.ts";
import { SETUP_BUTTON, SETUP_TOOLS, toolbarButtons } from "../features/toolbarOrder.ts";
import { Icon } from "../components/Icon.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { Menu, type MenuItem, type MenuSection } from "../components/Menu.tsx";
import { Popover, usePopover, type PopoverHandle } from "../components/Popover.tsx";
import { popoverSlot } from "../components/popoverRules.ts";
import { toolbarSlot, toolChanged, toolVoiceSlot, tuckEvent } from "../state/toolbar.ts";
import { useDropHpDraftsOnSelect } from "../features/tokens/hpDraft.ts";
import { useClearStatBlockOnSelect } from "../features/tokens/statBlockOpen.ts";
import { isoOffered, viewFoldSlot } from "../features/view/choice.ts";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { useBackClose } from "../lib/backClose.ts";
import { useWakeLock } from "../lib/wakeLock.ts";
import type { Insets } from "../lib/camera.ts";
import { isCoarsePointer } from "../lib/device.ts";
import { fullscreenSupported } from "../lib/fullscreen.ts";
import { useFocusedFieldInView, useKeyboardView } from "../lib/keyboardInset.ts";
import { sheetStepping } from "../lib/modalDialog.ts";
import { roomPath } from "../lib/roomId.ts";
import { sceneGate, selectionScene } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
import { PanelBody, RoomLoadNotice } from "../panels/Panels.tsx";
import { RoomScope, RoomScopeProvider, scopeSlot, useRoomScope, useScoped } from "../state/scope.ts";
import { toastsLeft } from "../state/store.ts";
import { sidePanelKeysSlot, splitKeysSlot, useKeyHint, useKeyHints, useShortcuts, withKey, type KeyHint } from "../state/shortcuts.ts";
import { usePreview } from "../features/dm/previewContext.ts";
import { ViewAsHost } from "../features/dm/PlayerPreview.tsx";
import { usePasteRouter } from "../features/images/pasteRouter.ts";
import { RoomPasteHost } from "../features/images/RoomPaste.tsx";
import { ShortcutSheetHost } from "../features/device/ShortcutSheet.tsx";
import { sheetOpen as sheetShows, type Ended, type Toast, type ToastDie } from "../state/types.ts";
import { barDismiss, dismissal } from "../state/selection.ts";
import { useRoomStore, useRoomUi, useRoomView } from "../state/view.ts";
import { DmLinkEntry } from "./DmLinkEntry.tsx";
import { endedText } from "./endedText.ts";
import { drawn, dockFits, dockSlot, DOCK_GAP, DOCK_PX, foldsUnderSheet, useSideSheetRoom } from "./fold.ts";
import { mapFocusSlot, panelFocusSlot } from "./mapFocus.ts";
import { firstSidePanel, readSidePanel, writeSidePanel } from "./sidePanel.ts";
import { SideTabs } from "./SideTabs.tsx";
import { SplitBar } from "./SplitBar.tsx";
import { readSplit, roomForTwo, sameSplit, ScrollKeep, shareOf, splitPanes, swapFocus, writeSplit, type SplitEntry } from "./splitPanes.ts";
import { inModal, ModalSlots, useModalSlot } from "./modalSlot.tsx";
import {
  FLOAT_MAX,
  inToolbarRow,
  optionsLift,
  lastToolIn,
  mapWidthOf,
  mergedEdges,
  optionsArrangement,
  PAIR,
  POPOVER_MIN,
  TOOL_BUTTON_ICON,
  TOOL_BUTTON_NAMED,
  TOOL_GAP,
  toolbarShape,
  toolPopoverFrame,
  type Arrangement,
  type OptionsPlace,
} from "./optionsLayout.ts";
import { OptionsFrameContext, type OptionsFrame } from "../features/measure/controls.tsx";
import type { Rect } from "../components/popoverPlace.ts";
import { Badge, FindButton, FitButton, FullscreenButton, PauseScreen, Stacked, UndoButtons, useAccentVars, useEscape, useNoPageZoom, usePreloadAndReopen, useRoomTitle, ViewButton } from "./RoomChrome.tsx";
import { DockHeaderActions, DockRow, FoldStatus, SAFE_PROBE_STYLE, useDockSummary, useLayoutHeight, useSafeAreas, type DockActions } from "./RoomDock.tsx";

/** What the DM panel's count says while a PDF upload waits on the DM. */
const UPLOAD_WAITING = "1 upload waiting";

const { topBar: TOP_BAR, toolbar: TOOLBAR } = theme.layout;
/** "Viewing as Pat" at its widest, in window pixels (features/dm/PlayerPreview.tsx). */
const PREVIEW_NOTICE_MAX = theme.layout.notice;
/** Over the whole map, drawing nothing but its focus ring, inside the map's edge. */
const MAP_FOCUS_STYLE: CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none", outlineOffset: -2 };

/**
 * An element's height as drawn, kept up to date. The bars over the map
 * report theirs so a fitted map keeps clear of them, whatever the safe
 * areas, the interface size and however many rows a tool's options wrap
 * onto. A zoomed bar's own size does not change with the interface size, so
 * a new size measures again (features/device/layout.ts barInset). The
 * height comes rounded, as the map's insets take it, and exact, for the
 * token bar's free area: at a zoomed interface size the rounding can take
 * a third of a pixel from it, enough to open the compact overlay where
 * the strip's 148 px fit (320 x 360 at 130%, docs/design-v1-bar-compact.md 3.1).
 */
function useHeight(scale: number): [(el: HTMLElement | null) => (() => void) | undefined, number, number] {
  const [height, setHeight] = useState({ rounded: 0, exact: 0 });
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return undefined;
      const measure = () => {
        const exact = el.getBoundingClientRect().height;
        setHeight((was) => (was.exact === exact ? was : { rounded: barInset({ height: exact }), exact }));
      };
      const observer = new ResizeObserver(measure);
      // The border box, since the safe areas pad the bars: a home bar or notch that comes or goes leaves their content the same size.
      observer.observe(el, { box: "border-box" });
      measure();
      return () => {
        observer.disconnect();
        setHeight({ rounded: 0, exact: 0 });
      };
    },
    // The scale is read through the element's rectangle, but a change must measure again.
    [scale],
  );
  return [ref, height.rounded, height.exact];
}

/** What the tool's options take from the map's foot, in screen px, measured as drawn (docs/design-v1-tool-options.md 10.2). */
type OptionsBox = {
  /** The row while it stands at the foot: stacked, its box, floating, its box and its gap. 0 in the toolbar's row, tucked or with no row. */
  row: number;
  /** The line's one-line height and its gap, kept at its last measure while a popover hides it or it is open. */
  reserve: number;
  /** Up to the row's highest control, or the line's top where it holds a reading, a warning or a status. */
  controls: number;
};

const NO_OPTIONS: OptionsBox = { row: 0, reserve: 0, controls: 0 };

/**
 * The tool's options as they stand over the map's foot (10.2), measured
 * from the toolbar's top: the row, the line's reserve and the highest
 * control. The line counts at its one-line height whatever it shows, so a
 * popover that hides it or a tap that opens it moves nothing: popovers and
 * an open line are passing overlays. Its controls move without the
 * element changing size, as a tool's state changes the row or the line,
 * so it measures again as they come and go.
 *
 * `lift` is how far the on-screen keyboard lifts the options above the
 * toolbar, in screen px (Room `keyboardLift`). It is taken off, so the
 * map's insets keep what the options take and the map never moves for a
 * keyboard, and the row measures again as it changes, since the row moves
 * without changing size.
 */
function useOptionsBox(scale: number, toolbar: RefObject<HTMLElement | null>, lifts: { foot: number; row: number }): [(el: HTMLElement | null) => (() => void) | undefined, OptionsBox] {
  const [box, setBox] = useState<OptionsBox>(NO_OPTIONS);
  const liftNow = useRef(lifts);
  liftNow.current = lifts;
  const measureNow = useRef<(() => void) | null>(null);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return undefined;
      let line = 0;
      const observer = new ResizeObserver(() => measure());
      const watch = () => {
        observer.disconnect();
        observer.observe(el, { box: "border-box" });
        for (const part of el.querySelectorAll("[data-options-line], [data-options-row]")) observer.observe(part);
      };
      const measure = () => {
        const nav = toolbar.current;
        if (!nav) return;
        // Measured as the row rests, so the keyboard moves neither the map's insets nor the chrome's controls.
        const foot = nav.getBoundingClientRect().top - optionsLift(el.dataset.rvttArrangement, liftNow.current);
        const r = el.getBoundingClientRect();
        const atFoot = el.dataset.rvttArrangement === "stacked" || el.dataset.rvttArrangement === "floating";
        const row = atFoot && r.height > 0 ? Math.max(0, Math.round(foot - r.top)) : 0;
        const pill = el.querySelector<HTMLElement>("[data-options-line]");
        if (!pill) line = 0;
        else if (pill.dataset.optionsLine === "shown") line = pill.getBoundingClientRect().height;
        const reserve = line > 0 ? Math.round(line + theme.layout.options.lineGap * scale) : 0;
        const tops = Array.from(el.querySelectorAll("[data-options-row] button, [data-options-row] input, [data-options-row] select"), (c) => c.getBoundingClientRect()).filter((c) => c.height > 0);
        const highest = tops.length > 0 ? Math.max(0, Math.round(foot - Math.min(...tops.map((c) => c.top)))) : 0;
        const controls = Math.max(highest, pill?.hasAttribute("data-options-reading") ? row + reserve : 0);
        setBox((b) => (b.row === row && b.reserve === reserve && b.controls === controls ? b : { row, reserve, controls }));
      };
      const changes = new MutationObserver(() => {
        watch();
        measure();
      });
      watch();
      changes.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-options-line", "data-options-reading", "hidden", "data-rvtt-arrangement"] });
      measure();
      measureNow.current = measure;
      return () => {
        measureNow.current = null;
        observer.disconnect();
        changes.disconnect();
        setBox(NO_OPTIONS);
      };
    },
    // The scale is read through the element's rectangle, but a change must measure again.
    [scale, toolbar],
  );
  useLayoutEffect(() => measureNow.current?.(), [lifts.foot, lifts.row]);
  return [ref, box];
}

/**
 * The Room page shell (design section 14.4).
 *
 * - Phone portrait: full-screen map, a top bar (room name, connection dot,
 *   the DM's or player's chip, Find my token for a player, Fit map), the
 *   initiative strip as a band under it during a fight, a bottom toolbar,
 *   panels as bottom sheets.
 * - Phone landscape: the same, with sheets docked on the right, and the
 *   initiative strip in the top bar's row when the bar has room for it
 *   (features/encounter/band.ts).
 * - 900 px and wider: a docked side panel with tabs beside the map.
 *
 * The toolbar, the active tool's options and the panels come from the
 * registries in client/features. It reads everything through useRoomView,
 * so the dev fixture and the live store drive it the same way.
 *
 * A DM on a 390 px phone has nine tools and ten panels, which no single
 * row of 44 px buttons holds. So on phones:
 * - The tools scroll sideways in the toolbar, each with its short name
 *   under the icon, and a fade and a chevron on the edge that hides more.
 *   Tools change constantly during play, so each stays one tap away, and
 *   nine of them need only a short swipe or a tap on the chevron.
 * - The panels move behind one Panels button that opens a sheet listing
 *   all of them as large buttons. Panel names are long words, so a row of
 *   them could show three at most, and a list shows every one at once. An
 *   open panel's sheet has a back button to that list.
 * From 900 px up the tools fit, and the side panel's tabs stand in one
 * row, the most used first and the rest behind More, whose menu lists
 * them (pages/SideTabs.tsx).
 *
 * Room makes the page's scope (state/scope.ts) and RoomPage draws inside
 * it, so the page's own hooks read the same per-page state as everything
 * under it, such as where the turn strip goes.
 */
export function Room() {
  // This page's tool state and camera channels (client/state/scope.ts).
  const [scope] = useState(() => new RoomScope());
  useEffect(() => () => scope.dispose(), [scope]);
  return (
    <RoomScopeProvider scope={scope}>
      <RoomPage />
      {/* Beside the page rather than in it, so an open stat block editor keeps its draft through whatever the page shows. */}
      <EditorHost />
      <PcStatsHost />
    </RoomScopeProvider>
  );
}

function RoomPage() {
  // The window in the chrome's own pixels, so a larger interface size reaches the phone layout sooner (features/device/layout.ts).
  const { width, height } = useLayoutSize();
  const zoom = useUiScale();
  const wide = width >= theme.layout.wideMinWidth;
  const landscape = !wide && width > height;
  // A tablet gets the wide layout, but no keyboard for undo.
  const [touchFirst] = useState(isCoarsePointer);
  useWakeLock();
  useNoPageZoom();
  useRoomTitle();
  const accentVars = useAccentVars();
  const scope = useRoomScope();

  const ui = useRoomUi();
  const store = useRoomStore();
  const [topBarRef, topBarHeight, topBarExact] = useHeight(zoom);
  const [toolbarMeasure, toolbarHeight, toolbarExact] = useHeight(zoom);
  const toolbarEl = useRef<HTMLElement | null>(null);
  const toolbarRef = useCallback(
    (el: HTMLElement | null) => {
      toolbarEl.current = el;
      return toolbarMeasure(el);
    },
    [toolbarMeasure],
  );
  /*
   * The on-screen keyboard (lib/keyboardInset.ts), where it reaches above
   * the toolbar: what stands on the toolbar stands on the keyboard instead,
   * by this much more, in screen px. The tool's options, the token bar,
   * the alerts, a roll card at the foot and a map pane all go up together,
   * placed by the room while typing that Room publishes beside its chrome
   * (canvas/barDock.ts Typing) and by the panes' insets. The chrome itself,
   * and every size decision read from it, stays as it was. The toolbar
   * stays under the keyboard, and the map's insets and size do not change.
   */
  const safe = useSafeAreas();
  const keyboard = useKeyboardView();
  const keyboardLift = keyboard ? Math.max(0, keyboard.inset - toolbarExact) : 0;
  const keyboardTop = keyboard?.top ?? 0;
  useFocusedFieldInView(theme.space(2));
  // A row in the toolbar's row stands on the keyboard from the screen's safe area, a toolbar's height lower than the rest (ToolOptions `onKeys`).
  const rowLift = keyboard ? Math.max(0, keyboard.inset - safe.bottom * zoom) : 0;
  const [optionsRef, optionsBox] = useOptionsBox(zoom, toolbarEl, useMemo(() => ({ foot: keyboardLift, row: rowLift }), [keyboardLift, rowLift]));
  const optionsBottom = optionsBox.row + optionsBox.reserve;
  const insets = useMemo<Insets>(() => ({ top: topBarHeight, right: 0, bottom: toolbarHeight + optionsBottom, left: 0 }), [topBarHeight, toolbarHeight, optionsBottom]);
  // A map pane at the foot stands on the options as they stand over the keyboard, and keeps below the visible area's top.
  const paneInsets = useMemo<Insets>(
    () => (keyboard ? { ...insets, top: Math.max(insets.top, keyboardTop), bottom: insets.bottom + keyboardLift } : insets),
    [insets, keyboard, keyboardTop, keyboardLift],
  );
  const role = useRoomView((s) => s.you?.role ?? "player");
  usePreloadAndReopen(role);
  const ended = useRoomView((s) => s.ended);
  const roomId = useRoomView((s) => s.roomId);
  const gate = useRoomView(useShallow((s) => sceneGate({ view: s.view, sceneId: s.sceneId, role })));
  const { selectedId, panel, tab, tool: toolId, actionBar, sidePanelHidden, sheetHidden, sheetExpanded, below, splitFits } = useRoomView(useShallow((s) => s.local));
  // The state this render draws, so a focus request waits for the render that draws the latest (placeFocus).
  const localNow = useRoomView((s) => s.local);
  const select = useCallback((id: string | null, add?: boolean) => ui.tap(id, add), [ui]);

  // A change of scene lets go of the selection, and a blackout does not (lib/scene.ts selectionScene).
  const selectionOn = useRef<string | null>(null);
  const gateKey = gate.kind === "ready" ? `ready:${gate.scene.id}` : gate.kind;
  useEffect(() => {
    const next = selectionScene(selectionOn.current, gate);
    selectionOn.current = next.scene;
    if (next.letGo) ui.select(null);
    // The gate is read through gateKey, which changes exactly when its kind or its scene does.
  }, [gateKey, ui]);
  // A change of scene closes whatever popover is open (docs/design-v1-tool-options.md 13.3): a tool popover's choices and actions belong to the scene it opened on.
  const sceneNow = useRoomView((s) => s.sceneId);
  const sceneBefore = useRef(sceneNow);
  useLayoutEffect(() => {
    if (sceneBefore.current === sceneNow) return;
    sceneBefore.current = sceneNow;
    scope.get(popoverSlot).closeOpen("state");
  }, [sceneNow, scope]);
  // HP typed before a blackout comes back with the token bar after it, and what no entry took back goes with a new selection (features/tokens/hpDraft.ts).
  useDropHpDraftsOnSelect();
  // A stat block a request opened stays open only while its token is the selection (features/tokens/panelFolds.ts).
  useClearStatBlockOnSelect();

  /*
   * Where focus goes once the render that follows a tap has drawn what the
   * tap asked for: the open panel (a phone's sheet at its heading, the side
   * panel's tab panel), or a tile in the list of panels. See the effect
   * after useDockFocus below.
   */
  // A panel's request names it when it may be the bottom of two, whose name takes focus in place of the chosen tab (docs/design-v1-split-panel.md 9.2).
  const focusNext = useRef<{ kind: "panel"; id?: string } | { kind: "tile"; panelId: string } | { kind: "panels" } | null>(null);

  // The action bar steps aside once the token's panel is open, and focus, which went with the bar's Details, goes to the panel.
  const openDetails = useCallback(
    (id: string) => {
      ui.select(id);
      ui.showActions(false);
      ui.openPanel("token");
      focusNext.current = { kind: "panel", id: "token" };
    },
    [ui],
  );

  // What sits over the top of the map: the bar, and in a fight the turn band under it when the strip is not in the bar.
  const topInset = useTopBars();
  const placement = useTurnPlacement();
  const fight = useRoomView((s) => !!s.view?.encounter);
  const panels = panelsFor(role, wide);
  const tools = useRoomView(useShallow((s) => toolsFor(role, s)));
  const tool = activeTool(toolId, role);
  // The keyboard (state/shortcuts.ts) and pasted images (features/images/pasteRouter.ts). A "view as a player" preview answers no key and takes no paste.
  const previewing = usePreview();
  const preview = previewing !== null;
  useShortcuts({ role, tools, scope, preview });
  usePasteRouter({ scope, preview });

  /*
   * The side panel from 900 px up, which can be hidden
   * (docs/design-v1-layout-hierarchy.md 4.1). Its first state on this page
   * is worked out once, the first time the layout is wide, from a phone's
   * sheet open as it turned, this device's choice or the short screen's
   * default (pages/sidePanel.ts), in a layout effect so a panel that starts
   * hidden never paints a frame. It runs before crossWide below, so
   * `wasWide` still says whether the layout was narrow until now.
   */
  const sideShown = wide && !sidePanelHidden;
  const sideFirst = useRef<boolean | null>(null);
  const wasWide = useRef(wide);
  useLayoutEffect(() => {
    if (sideFirst.current !== null || !wide) return;
    const sheet = !wasWide.current && sheetShows(store.getState().local);
    const first = firstSidePanel(null, { wide, height, stored: readSidePanel(), sheet });
    sideFirst.current = first;
    if (first !== null) ui.hideSidePanel(first);
  }, [wide, height, ui, store]);
  // Crossing 900 px, a phone's hidden sheet and the side panel hand over to each other (state/types.ts crossWide).
  useLayoutEffect(() => {
    if (wasWide.current === wide) return;
    wasWide.current = wide;
    ui.crossWide(wide);
  }, [wide, ui]);
  const panelsRef = useRef<HTMLButtonElement>(null);
  const sidePanelRef = useRef<HTMLElement>(null);
  const sidePanelId = useId();
  const setSidePanel = useCallback(
    (hidden: boolean) => {
      ui.hideSidePanel(hidden);
      writeSidePanel(hidden ? "hidden" : "shown", { preview });
    },
    [ui, preview],
  );
  // Each button goes as it acts, so focus moves to the one that takes its place: Hide panels to Panels, Panels to the chosen tab.
  const hideSidePanel = () => {
    focusNext.current = { kind: "panels" };
    setSidePanel(true);
  };
  const showSidePanel = () => {
    focusNext.current = { kind: "panel" };
    setSidePanel(false);
  };
  // S (state/shortcuts.ts) moves focus only where its element disappears: from inside the side panel to Panels, and from Panels to the chosen tab.
  const sidePanelKeys = scope.get(sidePanelKeysSlot);
  useEffect(() => {
    if (!wide) return;
    sidePanelKeys.toggle = () => {
      const hidden = store.getState().local.sidePanelHidden;
      const active = document.activeElement;
      if (!hidden && active && sidePanelRef.current?.contains(active)) focusNext.current = { kind: "panels" };
      else if (hidden && active && active === panelsRef.current) focusNext.current = { kind: "panel" };
      setSidePanel(!hidden);
    };
    return () => {
      sidePanelKeys.toggle = null;
    };
  }, [wide, sidePanelKeys, store, setSidePanel]);
  const optionsShown = useRoomView((s) => (tool.optionsShown ? tool.optionsShown(s) : true));
  // A phone's open panel stays mounted while its sheet is hidden (docs/design-v1-layout-hierarchy.md 4.2): `mounted` is drawn, and `sheet` is it only while it shows.
  const mounted = !wide && panel ? panels.find((p) => p.id === panel) : undefined;
  const sheet = mounted && !sheetHidden ? mounted : undefined;
  const tabId = panelById(tab) && panels.some((p) => p.id === tab) ? tab : (panels[0]?.id ?? "");
  /*
   * The side panel's second panel (docs/design-v1-split-panel.md): kept on
   * a phone and in a side panel too short for two, and on screen only while
   * two show. Everything that reads "the open panel" counts it then (10).
   */
  const belowId = below !== null && below !== tabId && panels.some((p) => p.id === below) ? below : null;
  const twoShown = sideShown && belowId !== null && splitFits === true;
  const sideShows = (id: string) => sideShown && (tabId === id || (twoShown && belowId === id));
  // Outside the side panel there is no room to measure.
  useLayoutEffect(() => {
    if (!wide) ui.fitSplit(false);
  }, [wide, ui]);
  // New chat and whispers mark the Log's button while it is not on screen.
  const unread = useLogUnread(wide ? sideShows("log") : sheet?.id === "log");
  // Others' rolls as toasts while the Dice panel is not on screen (docs/design-v1-dice.md 8.5).
  useRollToasts(wide ? sideShows("dice") : sheet?.id === "dice");
  const journalUnread = useJournalUnread();
  // A PDF upload waiting on the DM badges the DM panel, and on a phone the Panels button too (docs/design-v1-pdf-handouts.md 4.1.1).
  const uploadWaiting = useJobWaiting() && role === "dm" ? 1 : 0;
  const badges: Record<string, number> = { log: unread, journal: journalUnread, dm: uploadWaiting };
  const badgeLabels: Record<string, string> = { dm: UPLOAD_WAITING };
  const panelsLabel = [unread + journalUnread > 0 ? `${unread + journalUnread} unread` : "", uploadWaiting ? UPLOAD_WAITING : ""].filter(Boolean).join(", ");
  usePdfJobRoom();
  // The phone sheet that lists every panel, in the room's local state (state/types.ts sheetOpen), so
  // what floats over the map steps aside for it as for a panel. Opening a panel from anywhere takes its place.
  const picker = useRoomView((s) => s.local.panelList);
  const setPicker = useCallback((open: boolean) => ui.showPanelList(open), [ui]);
  // From 900 px up there is no list to show.
  useEffect(() => {
    if (wide && picker) setPicker(false);
  }, [wide, picker, setPicker]);
  const pickerOpen = !wide && picker && !sheet;
  const closeSheets = useCallback(() => ui.closeSheets(), [ui]);
  // A hidden sheet comes back in one tap, with focus on its title, in place of the list.
  const togglePanels = () => {
    if (mounted && !sheet) {
      focusNext.current = { kind: "panel" };
      ui.hideSheet(false);
    } else if (sheet || pickerOpen) closeSheets();
    else setPicker(true);
  };
  // Android's Back closes the sheet before it leaves the room (lib/backClose.ts).
  const sheetOpen = sheet !== undefined || pickerOpen;
  useBackClose(sheetOpen, closeSheets);
  /*
   * On a phone the token's action bar is the sheet a tap opened, so Back
   * closes it too. With Multi-select on and the group's bar hidden, Back
   * ends the mode as Done does at any width, a wide Android tablet's
   * included, so Back never leaves the room while a group is held. Escape
   * does both everywhere. Neither ends the mode while the token's panel
   * shows the selection (state/selection.ts dismissal).
   */
  const tokenPanelShown = wide ? sideShows("token") : sheet?.id === "token";
  const away = useRoomView((s) => dismissal(s.local, tokenPanelShown));
  /*
   * While the token's panel shows the token, the bar's Close, Escape and
   * Back put the bar away and keep the token, so the panel the DM is
   * reading stays filled (state/selection.ts barDismiss), and focus, which
   * was on the bar or nowhere, goes to the panel.
   */
  const hideBar = useCallback(() => {
    ui.showActions(false);
    focusNext.current = { kind: "panel", id: "token" };
  }, [ui]);
  const putAway = useCallback(() => {
    const local = store.getState().local;
    const what = dismissal(local, tokenPanelShown);
    if (what === "bar" && !wide) {
      if (barDismiss(local, tokenPanelShown) === "hide") hideBar();
      else ui.select(null);
    } else if (what === "group") ui.doneSelecting();
  }, [store, ui, tokenPanelShown, wide, hideBar]);
  useBackClose(away === "group" || (!wide && away === "bar"), putAway);
  useEscape(sheetOpen, closeSheets, tokenPanelShown, hideBar);
  // Where the open sheet stands, read when Find my token is pressed, so the found token lands clear of it.
  const sheetRef = useRef<HTMLElement | null>(null);
  const [sheetEl, setSheetEl] = useState<HTMLElement | null>(null);
  const sheetElRef = useCallback((el: HTMLElement | null) => {
    sheetRef.current = el;
    setSheetEl(el);
  }, []);
  // A hidden sheet's box measures nothing, so it counts as no sheet.
  const sheetShown = sheet !== undefined || pickerOpen;
  const openSheet = useCallback((): OpenSheet | null => {
    const rect = sheetShown ? sheetRef.current?.getBoundingClientRect() : undefined;
    return rect ? { placement: landscape ? "right" : "bottom", width: rect.width, height: rect.height } : null;
  }, [landscape, sheetShown]);
  /*
   * The subpage each panel names (features/panels.ts usePanelHeader), for
   * the sheet's header or its pane's in the side panel. Kept by panel, so
   * a swap of the side panel's two panels carries each pane's header with it.
   */
  const [subpages, setSubpages] = useState<Readonly<Record<string, PanelHeader | null>>>({});
  const headerOf = useCallback((id: string) => (header: PanelHeader | null) => setSubpages((all) => (all[id] === header ? all : { ...all, [id]: header })), []);

  /*
   * What this device remembers of the split (pages/splitPanes.ts): read
   * once per page, once the viewer's role is known, before paint, so a
   * stored split shows from the first frame. Written as the split opens,
   * closes or swaps, as either of its panels changes, and as a drag or a
   * key step ends. One panel's tab presses write nothing. A store
   * subscription, so every path that changes the panels writes, whatever
   * called it.
   */
  const splitRole = useRoomView((s) => s.you?.role ?? null);
  const [share, setShare] = useState<number | null>(null);
  const shareRef = useRef<number | null>(null);
  const splitStored = useRef<SplitEntry | null>(null);
  const saveSplit = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (splitStored.current !== null || splitRole === null) return;
    const has = new Set(panelsFor(splitRole, true).map((p) => p.id));
    const entry = readSplit(splitRole, (id) => has.has(id));
    splitStored.current = entry;
    shareRef.current = entry.share;
    setShare(entry.share);
    if (entry.pair) ui.splitPanels(true, entry.pair);
  }, [splitRole, ui]);
  useEffect(() => {
    if (splitRole === null) return;
    const save = () => {
      const l = store.getState().local;
      const entry: SplitEntry = { share: shareRef.current, pair: l.below !== null ? { top: l.tab, below: l.below } : null };
      if (splitStored.current && sameSplit(entry, splitStored.current)) return;
      splitStored.current = entry;
      writeSplit(splitRole, entry, { preview });
    };
    saveSplit.current = save;
    const unsubscribe = store.subscribe((s, prev) => {
      if (s.local.tab === prev.local.tab && s.local.below === prev.local.below) return;
      if (s.local.below === null && prev.local.below === null) return;
      save();
    });
    return () => {
      unsubscribe();
      saveSplit.current = null;
    };
  }, [splitRole, store, preview]);
  const placeShare = useCallback((next: number) => {
    shareRef.current = next;
    setShare(next);
    saveSplit.current?.();
  }, []);
  /*
   * A panel's `close` in the side panel (features/panels.ts PanelClose). A
   * panel closes its phone's sheet to clear the map, as Add and place does,
   * and the side panel stands beside the map, so the panel stays open in the
   * room's state: a turn below 900 px then opens it as a sheet
   * (state/types.ts crossWide), as the side panel showed it. A place button
   * says `placing` (Place a token, Pin to the map): its tool's options wait
   * for a tap on the map, so then the panel is kept tucked away, as a
   * phone's Hide does, and the turn keeps the map and the options in view.
   * Panels brings the panel back. The press says so itself, since a tool
   * already active, such as the Ruler during Add and place, tells nothing.
   */
  const closeSidePanel = useCallback<PanelClose>(
    (options) => {
      if (options?.placing) ui.hideSheet(true);
    },
    [ui],
  );
  // The bar's Close, whose bar goes with the bottom panel: focus goes to the chosen tab (9.2).
  const closeBelow = useCallback(() => {
    focusNext.current = { kind: "panel" };
    ui.splitPanels(false);
  }, [ui]);

  // ------------------------------------------------ the dock (pages/fold.ts)
  const dockStore = scope.get(dockSlot);
  const hasBar = useStore(dockStore, (s) => s.bar !== null);
  // A map pane's bottom sheet folds the alerts column too (fold.ts useFoldUnderPane), and their summary row docks on the pane's top edge where it has room (RoomDock.tsx usePaneDock), so what arrives under it is still read out.
  const underPane = useStore(dockStore, (s) => s.paneSheets > 0);
  const summary = useDockSummary();
  /*
   * Where a sheet stands: at the foot of an upright phone, on the right of
   * one held sideways, or, where that would leave its body under 88 px, in
   * the very short mode over the whole screen (components/sheetCap.ts).
   * Worked out from the layout, the safe areas and the bars, never measured.
   */
  const sideWidth = sideSheetWidth(width);
  const sideHeader = headerStacks({ width: sideWidth - safe.right - 2 * theme.line.border, buttons: mounted ? 3 : 1, actions: false }) ? SHEET_HEADER_STACKED : SHEET_HEADER;
  const sheetModeNow: SheetMode = !landscape ? "bottom" : sheetMode({ height, safeTop: safe.top, safeBottom: safe.bottom, topBars: topInset, header: sideHeader });
  // An upright sheet swiped up fills the screen in the very short mode's shape (docs/design-v1-sheet-swipe.md 4.7), so all that follows from that shape follows from either: the dock's buttons in the header, the fold, the notices inside.
  const filled = sheetModeNow === "bottom" && sheetExpanded;
  const full = (sheetModeNow === "full" || filled) && sheetOpen;
  // Less a 1 px border on each side, which the very short mode does not draw (Sheet.tsx).
  const headerWidth = (sheetModeNow === "side" ? sideWidth - safe.right : sheetWidth(sheetModeNow, width) - safe.left - safe.right) - (sheetModeNow === "full" || filled ? 0 : 2 * theme.line.border);
  const fullMode = sheetModeNow === "full";
  useLayoutEffect(() => {
    const now = dockStore.getState();
    if (now.sheetFull !== full || now.sheetFullMode !== fullMode) dockStore.setState({ sheetFull: full, sheetFullMode: fullMode });
  }, [dockStore, full, fullMode]);
  useLayoutEffect(() => () => dockStore.setState({ sheetFull: false, sheetFullMode: false }), [dockStore]);
  /*
   * Where the tool's options stand (docs/design-v1-tool-options.md 4): on
   * a phone's toolbar or floating above a computer's, decided from the
   * layout, the role's toolbar and the side panel before paint, never from
   * a measurement, so picking a tool never moves a button.
   */
  const mapWidth = mapWidthOf({ width, sidePanel: sideShown });
  const optionsDrawn = tool.Options !== undefined && optionsShown && !sheet && !pickerOpen;
  const named = !wide || touchFirst;
  const arrangementInput = { width, height, sidePanel: sideShown, safeLeft: safe.left, safeRight: safe.right, toolbar: toolbarShape(tools, wide), named, dm: role === "dm" };
  const optionsPlaceNow = optionsArrangement(arrangementInput);
  const optionsEdges = mergedEdges(arrangementInput, optionsPlaceNow.arrangement === "pair" ? PAIR : arrangementInput.toolbar);
  /*
   * The pair's last tool and tuck (docs/design-v1-tool-options.md 5.2, 5.4),
   * this page's own, in its scope. Any way a tool becomes active makes it
   * the last tool, Select aside, and ends another tool's tuck.
   */
  const toolbarState = useStore(scope.get(toolbarSlot));
  useLayoutEffect(() => toolChanged(scope, tool.id), [scope, tool.id]);
  const lastShown = lastToolIn(toolbarState.last, tools);
  const tucked = toolbarState.tucked === tool.id;
  const pressTool = useCallback(
    (id: string) => {
      if (id === store.getState().local.tool) tuckEvent(scope, id, { kind: "press", tool: id });
      else ui.setTool(id);
    },
    [scope, store, ui],
  );
  const showOptions = useCallback(() => tuckEvent(scope, tool.id, { kind: "show", tool: tool.id }), [scope, tool.id]);
  const [toolbarMenu, setToolbarMenu] = useState(false);
  const optionsId = useId();
  const sideRoom = useSideSheetRoom();
  const folded = foldsUnderSheet({ width, height, sheetOpen, full, sideRoom });
  const docked = folded && (hasBar || summary !== null);
  // Over the whole screen there is no edge to dock on, nor beside a sideways sheet that leaves a window too little room, so the dock's buttons join the header, as where the dock has no room.
  /*
   * While someone types, the dock rides the sheet raised onto the keyboard
   * (Sheet.tsx), so it fits only if it stays below the bars and the visible
   * area's top there, and a sheet that took the visible area's height to
   * show its field (`sheetTall`) leaves it no edge at all: its buttons join
   * the header.
   */
  const sheetKeys = sheetKeyboard(keyboard, zoom);
  // The page as it is: shorter than the room's steady height where a browser shrank it for its keyboard, whose view then hides nothing more.
  const pageHeight = keyboard ? (keyboard.top + keyboard.height + keyboard.inset) / zoom : height;
  const [sheetTall, setSheetTall] = useState(false);
  const dockInHeader = docked && (full || landscape || sheetTall || !dockFits({ height: pageHeight, safeTop: safe.top, safeBottom: safe.bottom, insetTop: topInset, insetBottom: TOOLBAR, keyboard: sheetKeys }));
  const sheetHeight = useLayoutHeight(sheetEl, zoom);
  // The dock's row rides the sheet's swipe (lib/sheetSwipe.ts).
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const riders = useMemo(() => [dockEl], [dockEl]);
  const backRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef<HTMLButtonElement>(null);
  useDockSummaryButton(summaryRef);
  /** What the tap that closed the sheets asked to show, for where focus goes once they are gone. */
  const showing = useRef<DockShowing | null>(null);
  const rolls = useAlertsSummaryEntry();
  const dockActions: DockActions = {
    showBar: () => {
      showing.current = { kind: "bar" };
      closeSheets();
    },
    closeBar: () => {
      dockStore.getState().bar?.close();
      // The sheet stays open, and focus stays in it.
      (backRef.current ?? closeRef.current)?.focus({ preventScroll: true });
    },
    showAlerts: (s) => {
      /*
       * The alerts column meets the ask once the sheets are gone, as its own
       * row's tap would (pages/fold.ts DockState.showAsk): the token bar
       * steps aside where it holds the row's lane, the cards open over the
       * tool's options or the screen where they have no room, then a roll
       * waiting for this viewer's answer opens with focus in its card
       * (features/rolls, 3.3.1), else the alert it names takes focus.
       */
      showing.current = { kind: "alerts" };
      dockStore.setState({ showAsk: rolls?.waiting ? { kind: "rolls" } : { kind: "alert", first: s.first } });
      closeSheets();
    },
  };
  useDockFocus({ folded, sheetOpen, store: dockStore, registry: scope.get(sheetFocusSlot), showing, showRef, summaryRef });

  // ------------------------------------------------ the docked token bar (canvas/barDock.ts)
  // The bars as drawn, in the chrome's own pixels, so the token bar keeps to the part of the map they leave free.
  const barDock = scope.get(barDockSlot);
  const sheetRight = landscape && sheetOpen && !full ? sideWidth : 0;
  // Until both bars have a height, the bar keeps its defaults rather than reaching under them.
  const chrome = useMemo<Chrome | null>(
    () =>
      topBarExact > 0 && toolbarExact > 0
        ? {
            top: topBarExact / zoom,
            bottom: (toolbarExact + optionsBottom) / zoom,
            controls: (toolbarExact + optionsBox.controls) / zoom,
            toolbar: toolbarExact / zoom,
            // Beside the side panel the map never touches the right edge, so its free area keeps no right inset.
            safe: { top: safe.top, right: sideShown ? 0 : safe.right, bottom: safe.bottom, left: safe.left },
            sheet: sheetRight,
          }
        : null,
    [topBarExact, toolbarExact, optionsBottom, optionsBox.controls, zoom, safe.top, safe.right, safe.bottom, safe.left, sheetRight, sideShown],
  );
  const typing = useMemo<Typing | null>(
    () => (keyboard ? { top: keyboard.top / zoom, bottom: (keyboard.top + keyboard.height) / zoom, lift: keyboardLift / zoom, page: (keyboard.top + keyboard.height + keyboard.inset) / zoom } : null),
    [keyboard, keyboardLift, zoom],
  );
  useLayoutEffect(() => {
    barDock.setState({ chrome, typing });
  }, [barDock, chrome, typing]);

  /*
   * The notices over the map (design 1.3): with 320 px or more left of the
   * lane the token bar and the alerts column share, the whole stack, toasts
   * included, centers there, so nothing moves when an alert arrives.
   * Otherwise it spans as before, and the column starts below the notices
   * that last (the offline banner, a layer that did not load, the DM's
   * frame bar and "Viewing as Pat"), while toasts keep their place, so a
   * card never jumps under a finger for a toast. A toast that shows while
   * the column shows a card starts under that card instead (toastLow).
   * "Viewing as Pat" stays in the preview, outside this page, so a blackout
   * and the ended screen keep its Exit: the preview tells this page how
   * tall it is, and this page says where it goes. Spanning, this page's own
   * notices start below it.
   */
  const free = freeArea({ width: mapWidth, height }, chrome ?? DEFAULT_CHROME);
  const beside = chrome ? noticePlace(free) : null;
  const besideLane = beside !== null;
  const noticeBox = beside;
  const previewNotice = previewing?.notice ?? null;
  const previewPush = !beside && previewNotice ? previewNotice.height / zoom + EDGE : 0;
  const reportsPreview = previewNotice !== null && !ended && gate.kind !== "blackout";
  useLayoutEffect(() => {
    if (!previewNotice || !reportsPreview) return;
    // Beside the lane only: spanning, it stands at the top of the map, clear of the tool's options at its foot.
    if (noticeBox) {
      const room = noticeBox.width * zoom;
      const noticeWidth = Math.min(PREVIEW_NOTICE_MAX, room);
      previewNotice.place({ left: noticeBox.left * zoom + (room - noticeWidth) / 2, width: noticeWidth });
    } else {
      previewNotice.place(null);
    }
    return () => previewNotice.place(null);
  }, [previewNotice, reportsPreview, noticeBox?.left, noticeBox?.width, zoom]);
  // While a sheet shows over the whole screen, "Viewing as Pat" renders first inside it, above its content (pages/modalSlot.tsx).
  const previewSlot = useModalSlot("preview");
  useLayoutEffect(() => {
    if (!previewNotice) return;
    previewNotice.slot(previewSlot);
    return () => previewNotice.slot(null);
  }, [previewNotice, previewSlot]);
  const lastingRef = useRef<HTMLDivElement>(null);
  const laneTop = free.top;
  const previewBottom = previewPush > 0 ? laneTop + previewPush - EDGE : null;
  useLayoutEffect(() => {
    const lasting = lastingRef.current;
    if (!lasting) {
      barDock.setState({ notices: null, lasting: null });
      return;
    }
    const measure = () => {
      const area = lasting.parentElement?.parentElement?.getBoundingClientRect();
      let bottom: number | null = previewBottom;
      for (const child of lasting.children) {
        const r = child.getBoundingClientRect();
        if (area && r.height > 0) bottom = Math.max(bottom ?? -Infinity, (r.bottom - area.top) / zoom);
      }
      // Spanning the map, they push the alerts column down. Beside its lane they leave the column be, but the token bar and the tool's options keep clear of them either way.
      const notices = besideLane ? null : bottom;
      const state = barDock.getState();
      if (state.notices !== notices || state.lasting !== bottom) barDock.setState({ notices, lasting: bottom });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(lasting);
    for (const child of lasting.children) observer.observe(child);
    return () => observer.disconnect();
    // The observer hears the stack's size only, so what moves it measures again: the turn band coming or going, the notch, the preview's notice.
  }, [barDock, besideLane, previewBottom, zoom, role, topInset, safe.top, laneTop]);
  // A map pane's card with no room beside the lane has the column's row stand for its cards too (fold.ts drawsPaneRow), so what arrives meanwhile is read out here.
  const columnSummary = useStore(barDock, (s) => s.bar?.lane === "summary" || s.footYields || s.columnCramped || s.columnPaneRow) && summary !== null;
  /*
   * Where a toast that shows now starts (barDock.ts toastTop): on a phone,
   * where the notices span the map over the alerts column and the column
   * shows a card, 8 px under its first card, so a toast never covers the
   * card's buttons. Each toast takes its place as it shows (Toasts), in a
   * layer of its own beside the notices, whose stack would move it. While a
   * map pane stands as a bottom sheet, which folds the column, 8 px under
   * the pane's header instead, which the layer's stack follows while the
   * pane stands, so its header and Close stay in reach (barDock.ts
   * paneToastTop, nextToastPlaces).
   */
  const columnNow = useStore(barDock, (s) => s.column);
  const alertsOverlay = useStore(barDock, (s) => s.alertsOverlay);
  const paneHead = useStore(dockStore, (s) => s.paneHead);
  const cardsShow = !folded && !underPane && !columnSummary && !alertsOverlay;
  /*
   * Beside an upright phone's resting strip the toasts' room ends 8 px
   * above the band's last 44 px over it (barDock.ts restFloor), in place of
   * the tool's highest control, so a toast never stands over the band
   * (docs/design-v1-bar-compact.md 3.5).
   */
  const stripTop = useStore(barDock, (s) => (s.bar?.rests ? s.bar.box.top : null));
  const toastFloor = stripTop === null ? null : restFloor(stripTop);
  const optionsTop = chrome ? Math.min(height - chrome.bottom, toastFloor ?? Infinity) : 0;
  // The alerts column's width as it works it out (features/encounter/InitiativeStrip.tsx): it steps left of a phone's sideways sheet, and beside the side panel no right safe area is the map's.
  const columnSheet = !wide && width > height && sheetOpen ? sideWidth : 0;
  const columnWidth = { mapWidth, sheet: columnSheet, safe: { left: safe.left, right: sideShown ? 0 : safe.right } };
  const toastLow = chrome && !underPane ? toastTop({ spanning: !besideLane, column: columnNow, cards: cardsShow, optionsTop }) : null;
  const toastEdges = columnEdges(columnWidth);
  const toastUnderPane = chrome && underPane ? paneToastTop({ head: paneHead, optionsTop }) : null;
  const [toastLayer, setToastLayer] = useState<HTMLDivElement | null>(null);
  // Where the row and its line would stand above the last lasting notice's foot, they stand over it, so the tool's controls stay in reach (8).
  const lastingBottom = useStore(barDock, (s) => s.lasting);
  const overNotice = chrome !== null && lastingBottom !== null && height - chrome.bottom < lastingBottom;
  // The line floats over the map. Where the map between the top bars and the row is shorter than the line, as at 480 x 320 at 130% in a fight, it would cover the turn band's End turn, so there it hides from sight as under a popover and stays a live region (8). Its reserve keeps its last measure while hidden, so this never flips back and forth.
  const lineCramped = chrome !== null && optionsBox.reserve > 0 && height - chrome.top - chrome.bottom < 0;
  // What the options' popovers read as they open and when the layout moves (7.3), in the chrome's own px.
  const popoverInputs = useRef({ mapWidth, height, safe, sideShown, top: chrome?.top ?? TOP_BAR, lasting: lastingBottom });
  popoverInputs.current = { mapWidth, height, safe, sideShown, top: chrome?.top ?? TOP_BAR, lasting: lastingBottom };
  const mapFocus = scope.get(mapFocusSlot);
  const mapFocusRef = useCallback(
    (el: HTMLDivElement | null) => {
      mapFocus.el = el;
    },
    [mapFocus],
  );

  /*
   * A tile in the list of panels, an open panel's "All panels" and the
   * token bar's Details each unmount as they act, and focus fell to the
   * page. So a panel picked from the list or opened by Details starts at
   * its sheet's heading, or at the side panel's chosen tab, and "All
   * panels" goes back to that panel's tile, as Back from a subpage returns
   * to its row (features/panels.ts useSubpageFocus). The tap asks, and the
   * render that draws the panel answers. After the dock's focus, which a
   * sheet opening may also move.
   */
  const sheetTitleRef = useRef<HTMLHeadingElement>(null);
  const sideTabRef = useRef<HTMLButtonElement>(null);
  const belowNameRef = useRef<HTMLButtonElement>(null);
  const placeFocus = () => {
    const ask = focusNext.current;
    if (!ask) return;
    // The side panel draws no tabs until it has fitted them to its row (pages/SideTabs.tsx), at most one commit later and before paint, and then asks again (onTabsDrawn).
    if (ask.kind === "panel" && wide && sideShown && !sideTabRef.current) return;
    // A panel waiting on the side panel's measure is placed in a commit of its own, before paint (state/types.ts pendingOpen): the request waits for the render that draws it.
    if (ask.kind === "panel" && store.getState().local !== localNow) return;
    focusNext.current = null;
    // A panel's name takes focus: the chosen tab for the top one, the bar's name for the bottom one (docs/design-v1-split-panel.md 9.2).
    if (ask.kind === "panel") (wide ? (ask.id !== undefined && ask.id === belowId && twoShown ? belowNameRef.current : sideTabRef.current) : sheetTitleRef.current)?.focus({ preventScroll: true });
    else if (ask.kind === "panels") panelsRef.current?.focus({ preventScroll: true });
    else sheetRef.current?.querySelector<HTMLElement>(`[data-opener="${panelTile(ask.panelId)}"]`)?.focus();
  };
  useLayoutEffect(placeFocus);
  // The same for a panel opened from outside Room's controls (mapFocus.ts panelFocusSlot): asked now, and answered now or by the render that draws it.
  const placeFocusNow = useRef(placeFocus);
  placeFocusNow.current = placeFocus;
  const panelFocus = scope.get(panelFocusSlot);
  useLayoutEffect(() => {
    panelFocus.focus = (panelId) => {
      focusNext.current = { kind: "panel", ...(panelId !== null ? { id: panelId } : {}) };
      placeFocusNow.current();
    };
    return () => {
      panelFocus.focus = null;
    };
  }, [panelFocus]);

  if (ended) return <EndedScreen ended={ended} roomId={roomId} role={role} />;
  // A blackout is for a break or a reveal (features section 13), so players
  // see nothing of the table: no map, panels, initiative strip, handouts or
  // toasts. sceneGate gives only players this kind, so a DM's room is unchanged.
  if (gate.kind === "blackout") return <PauseScreen />;

  const reserveTop = docked && !dockInHeader ? DOCK_PX + DOCK_GAP : undefined;
  // The cap the sheet takes once it stands at its normal height again, with the dock back on its edge where it fits there, for a long swipe from full screen after a change of layout.
  const normalReserve = docked && !landscape && dockFits({ height: pageHeight, safeTop: safe.top, safeBottom: safe.bottom, insetTop: topInset, insetBottom: TOOLBAR, keyboard: sheetKeys }) ? DOCK_PX + DOCK_GAP : undefined;
  const normalCap = sheetCap({ height, safeTop: safe.top, safeBottom: safe.bottom, insetTop: topInset, insetBottom: TOOLBAR, reserveTop: normalReserve });
  const expandSheet = (on: boolean) => ui.expandSheet(on);
  const headerActions = dockInHeader ? <DockHeaderActions summary={summary} actions={dockActions} showRef={showRef} summaryRef={summaryRef} /> : undefined;
  const headerActionCount = dockInHeader ? (hasBar ? 1 : 0) + (summary ? 1 : 0) : 0;
  const notices = full ? <ModalSlots /> : undefined;
  return (
    <div
      style={{
        ...accentVars,
        position: "fixed",
        inset: 0,
        height: "100dvh",
        display: "flex",
        overflow: "hidden",
        background: theme.color.bg,
        color: theme.color.text,
        fontFamily: theme.font.body,
        touchAction: "pan-x pan-y",
      }}
    >
      <div ref={safe.probe} aria-hidden style={SAFE_PROBE_STYLE} />
      <BarWidthProbe zoom={zoom} />
      {/* The map's chrome pads for the right safe area only where the map reaches that edge: not beside the side panel, which holds it (theme.safe.mapRight). */}
      <div style={{ position: "relative", flex: 1, minWidth: 0, ["--rvtt-map-safe-right" as string]: sideShown ? "0px" : theme.safe.right }}>
        <MapArea gate={gate} role={role} actionBar={actionBar} insets={insets} paneInsets={paneInsets} onSelect={select} onOpenDetails={openDetails} tokenPanelShown={tokenPanelShown} onHideBar={hideBar} />
        {/* The map's focus target (mapFocus.ts): after the map, so its ring draws over it, and before the bars, so Tab from it goes on to them. Taps pass through it. Unlike other places focus lands, it keeps its ring under keys (data-rvtt-ring, globals.css). */}
        <div ref={mapFocusRef} tabIndex={-1} role="img" aria-label="Map" data-rvtt-ring="" style={MAP_FOCUS_STYLE} />
        <TopBar
          ref={topBarRef}
          zoom={zoom}
          canFit={gate.kind === "ready"}
          undo={role === "dm"}
          compact={!wide}
          placement={placement}
          // In the bar a player's chip shows only its dot, so the strip has room: from 900 px up below 1,100 px as before, and on a phone while the strip is there.
          chipDot={wide ? width < theme.layout.chipNameMinWidth : placement === "bar" && fight}
          openSheet={openSheet}
        />
        <div
          {...smallUi(zoom)}
          style={{
            position: "absolute",
            top: `calc(${theme.safe.top} + ${topInset + EDGE + previewPush}px)`,
            ...(noticeBox ? { left: noticeBox.left, width: noticeBox.width, padding: 0 } : { left: 0, right: 0, padding: `0 ${theme.space(3)}px` }),
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: theme.space(2),
            pointerEvents: "none",
            zIndex: theme.z.notices,
            ...chromeZoom(zoom),
          }}
        >
          {/* The notices that last, measured together: the alerts column starts below them while they span the map. */}
          <div ref={lastingRef} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: theme.space(2), width: "100%" }}>
            <Banner />
            {role === "dm" ? <FrameViewBar /> : null}
            <QuietLoadNotice />
          </div>
          <Toasts
            low={toastLow}
            edges={toastEdges}
            pane={toastUnderPane}
            paneStands={underPane}
            layer={toastLayer}
            foot={chrome ? Math.min(height - chrome.controls, toastFloor ?? Infinity) : null}
            optionsTop={chrome ? optionsTop : null}
            restFloor={chrome ? toastFloor : null}
            top={chrome ? Math.max(chrome.top, lastingBottom ?? 0) + EDGE : null}
            safeTop={chrome?.safe.top ?? 0}
          />
        </div>
        <div ref={setToastLayer} data-rvtt-toast-layer="" {...smallUi(zoom)} style={{ position: "absolute", top: 0, left: 0, right: 0, height: 0, pointerEvents: "none", zIndex: theme.z.notices, ...chromeZoom(zoom) }} />
        {mounted ? (
          <Sheet
            // Each panel gets a sheet of its own, so one that replaces another in place, as the turn strip's Initiative replaces Token, never opens at the other's scroll (features/panels.ts usePanelScroll).
            key={mounted.id}
            ref={sheetElRef}
            title={mounted.title}
            scrollKey={mounted.id}
            scrollSubject={panelSubject(mounted.id, selectedId)}
            mode={sheetModeNow}
            shown={sheet !== undefined}
            inset={{ top: topInset, bottom: TOOLBAR }}
            onClose={() => ui.closePanel()}
            onBack={() => {
              focusNext.current = { kind: "tile", panelId: mounted.id };
              ui.closePanel();
              setPicker(true);
            }}
            onHide={() => ui.hideSheet(true)}
            hideFocus={panelsRef}
            backLabel="All panels"
            subpage={subpages[mounted.id] ?? null}
            reserveTop={reserveTop}
            actions={headerActions}
            actionCount={headerActionCount}
            headerWidth={headerWidth}
            notices={notices}
            riders={riders}
            expanded={sheetExpanded}
            onExpand={expandSheet}
            cap={normalCap}
            onTall={setSheetTall}
            backRef={backRef}
            closeRef={closeRef}
            titleRef={sheetTitleRef}
          >
            <PanelBody id={mounted.id} shown={sheet !== undefined} selectedTokenId={selectedId} close={() => ui.closePanel()} onHeader={headerOf(mounted.id)} />
          </Sheet>
        ) : null}
        {pickerOpen ? (
          <Sheet
            ref={sheetElRef}
            title="Panels"
            mode={sheetModeNow}
            inset={{ top: topInset, bottom: TOOLBAR }}
            onClose={() => setPicker(false)}
            reserveTop={reserveTop}
            actions={headerActions}
            actionCount={headerActionCount}
            headerWidth={headerWidth}
            notices={notices}
            riders={riders}
            expanded={sheetExpanded}
            onExpand={expandSheet}
            cap={normalCap}
            onTall={setSheetTall}
            backRef={backRef}
            closeRef={closeRef}
          >
            <PanelPicker
              panels={panels}
              current={panel ?? tabId}
              badges={badges}
              badgeLabels={badgeLabels}
              grouped={role === "dm"}
              onPick={(id) => {
                focusNext.current = { kind: "panel" };
                ui.openPanel(id, { pane: "top" });
              }}
            />
          </Sheet>
        ) : null}
        {/* After the sheet, so a test's or a screen reader's first "Close" in the page is still the sheet's (docs/design-v1-visual.md 5.4). */}
        {docked && !dockInHeader ? <DockRow ref={setDockEl} zoom={zoom} sheetHeight={sheetHeight} summary={summary} actions={dockActions} showRef={showRef} summaryRef={summaryRef} /> : null}
        {/* One element in every arrangement, so a rotation never remounts the tool's options. */}
        {optionsDrawn ? (
          <ToolOptions
            ref={optionsRef}
            id={optionsId}
            edges={optionsEdges}
            tucked={tucked}
            covered={toolbarMenu || lineCramped}
            onShow={showOptions}
            tool={tool}
            role={role}
            zoom={zoom}
            place={optionsPlaceNow}
            wide={wide}
            mapWidth={mapWidth}
            // Beside the side panel the map never touches the right edge.
            safe={{ top: safe.top, right: sideShown ? 0 : safe.right, bottom: safe.bottom, left: safe.left }}
            overNotice={overNotice}
            popover={popoverInputs}
            toolbar={toolbarEl}
            keyboard={keyboard ? keyboard.inset / zoom : null}
          />
        ) : null}
        {/* The toolbar's fill and top edge, under the options, so a row in the toolbar's own row is never painted under them (10.1). */}
        {wide ? null : <ToolbarBackdrop zoom={zoom} />}
        <Toolbar
          ref={toolbarRef}
          zoom={zoom}
          wide={wide}
          tools={tools}
          tool={tool.id}
          arrangement={optionsPlaceNow.arrangement}
          last={lastShown}
          tucked={tucked}
          optionsId={optionsDrawn ? optionsId : undefined}
          onPress={pressTool}
          onPick={pressTool}
          onMenu={setToolbarMenu}
          popover={popoverInputs}
          toolbar={toolbarEl}
          panelsOpen={sheet !== undefined || pickerOpen}
          hiddenSheet={mounted && !sheet ? mounted.title : null}
          onPanels={togglePanels}
          unread={unread + journalUnread + uploadWaiting}
          unreadLabel={panelsLabel}
          panelsRef={panelsRef}
          sideHidden={wide && sidePanelHidden}
          sidePanelId={sidePanelId}
          onShowSide={showSidePanel}
          named={!wide || touchFirst}
        />
        <ToolVoice />
      </div>
      {wide ? (
        <SidePanel
          ref={sidePanelRef}
          id={sidePanelId}
          hidden={!sideShown}
          short={height < SHORT_LANDSCAPE_MAX}
          zoom={zoom}
          tabs={panels}
          tab={tabId}
          below={belowId}
          fits={splitFits}
          share={share}
          badges={badges}
          badgeLabels={badgeLabels}
          grouped={role === "dm"}
          onTab={(id) => ui.openPanel(id, { pane: "top" })}
          onBelow={(id) => ui.openPanel(id, { pane: "below" })}
          onSplit={(on) => ui.splitPanels(on)}
          onSwap={() => ui.swapPanels()}
          onCloseBelow={closeBelow}
          onFits={(fits) => ui.fitSplit(fits)}
          onShare={placeShare}
          onHide={hideSidePanel}
          subpages={subpages}
          panel={(id, shown) => <PanelBody id={id} shown={shown} selectedTokenId={selectedId} close={closeSidePanel} onHeader={headerOf(id)} />}
          scrollSubject={(id) => panelSubject(id, selectedId)}
          tabRef={sideTabRef}
          nameRef={belowNameRef}
          onTabsDrawn={placeFocus}
        />
      ) : null}
      <FoldStatus folded={folded || underPane || columnSummary} />
      <HandoutPopup />
      {/* The DM's one View as a player, from whichever entry opened it. A preview's own page reads as a player and has none. */}
      {role === "dm" && !preview ? <ViewAsHost /> : null}
      <ShortcutSheetHost role={role} />
      <RoomPasteHost />
    </div>
  );
}

/** What a dock button's tap asked to show as it closed the sheets: the token bar, or the alerts column. */
type DockShowing = { kind: "bar" } | { kind: "alerts" };

/**
 * Where focus goes as the dock comes and goes (docs/design-v1-visual.md
 * 3.2.1):
 *
 * - Folding: if focus was in the token bar or the alerts column, which now
 *   take `hidden`, it moves to the dock button that stands for them.
 *   Otherwise it stays where the tap that opened the sheet left it.
 * - Once a sheet has closed by its close button, Escape or Back: a Show
 *   button's tap focuses what it showed. Otherwise, if focus was in the
 *   sheet and went with it, one decision places it (components/sheetFocus.ts):
 *   a roll card the sheet was hiding, else the token bar's frame, else
 *   where it fell, as before. The alerts summary's tap leaves focus to the
 *   alerts column, which moves it to what the tap named once the cards
 *   show (pages/fold.ts DockState.showAsk).
 *
 * Both run after the render that folded or unfolded, when the folded
 * parts have their `hidden` set or cleared.
 */
function useDockFocus(input: {
  folded: boolean;
  sheetOpen: boolean;
  store: ReturnType<typeof dockSlot.create>;
  registry: ReturnType<typeof sheetFocusSlot.create>;
  showing: { current: DockShowing | null };
  showRef: { current: HTMLButtonElement | null };
  summaryRef: { current: HTMLButtonElement | null };
}): void {
  const { folded, sheetOpen, store, registry, showing, showRef, summaryRef } = input;
  // What had focus last, kept past a fold that hid it: a browser may drop focus from a hidden element before this reads it.
  const lastFocus = useRef<Element | null>(null);
  useEffect(() => {
    // A sheet's dialog opening moves focus for the browser's focusing steps, not the viewer's, so those moves never stand for where the viewer was.
    const onIn = (e: FocusEvent) => {
      if (!sheetStepping()) lastFocus.current = e.target instanceof Element ? e.target : null;
    };
    // Focus that moved to the page because of a tap elsewhere, not because its element was folded away.
    const onOut = (e: FocusEvent) => {
      if (!sheetStepping() && e.relatedTarget === null && e.target instanceof Element && drawn(e.target)) lastFocus.current = null;
    };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);

  const wasFolded = useRef(folded);
  useLayoutEffect(() => {
    const was = wasFolded.current;
    wasFolded.current = folded;
    if (was || !folded) return;
    const active = document.activeElement;
    const had = active && active !== document.body ? active : lastFocus.current;
    if (!had) return;
    const { bar, column } = store.getState();
    if (bar?.frame.current?.contains(had)) showRef.current?.focus({ preventScroll: true });
    else if (column?.contains(had)) summaryRef.current?.focus({ preventScroll: true });
  }, [folded, store, showRef, summaryRef]);

  const wasOpen = useRef(sheetOpen);
  useLayoutEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = sheetOpen;
    if (!was || sheetOpen) return;
    const asked = showing.current;
    showing.current = null;
    // The column places focus itself once its cards show, so nothing here may take it first, where a screen reader would read that out on the way.
    if (asked?.kind === "alerts") return;
    if (asked?.kind === "bar") {
      const frame = store.getState().bar?.frame.current;
      if (frame && drawn(frame)) {
        frame.focus({ preventScroll: true });
        return;
      }
    }
    // Focus stayed somewhere else, such as on the Panels button that closed the sheet: it stays there.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    returnFocusAfterSheet(registry);
  }, [sheetOpen, store, registry, showing]);
}

function MapArea(props: {
  gate: ReturnType<typeof sceneGate>;
  role: "dm" | "player";
  actionBar: boolean;
  insets: Insets;
  paneInsets: Insets;
  onSelect(id: string | null, add?: boolean): void;
  onOpenDetails(id: string): void;
  tokenPanelShown: boolean;
  onHideBar(): void;
}) {
  const { gate, role } = props;
  if (gate.kind === "ready") {
    return (
      <>
        <MapStage
          scene={gate.scene}
          fog={gate.fog}
          role={role}
          actionBar={props.actionBar}
          insets={props.insets}
          paneInsets={props.paneInsets}
          onSelect={props.onSelect}
          onOpenDetails={props.onOpenDetails}
          tokenPanelShown={props.tokenPanelShown}
          onHideBar={props.onHideBar}
        />
        <SceneLoadingOverlay insets={props.insets} />
      </>
    );
  }
  // Fail closed: until the gate opens, nothing from any scene is drawn.
  // Black, not the theme's background, so a blackout and a load look alike.
  const message =
    gate.kind === "blackout"
      ? "The DM has paused the game."
      : gate.kind === "noScene"
        ? role === "dm"
          ? "Create a scene to get started."
          : "Waiting for the DM to pick a scene."
        : "Loading the scene…";
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: theme.color.stage,
        display: "grid",
        placeItems: "center",
        color: theme.color.textMuted,
        fontSize: theme.font.body14,
        padding: theme.space(6),
        textAlign: "center",
      }}
    >
      {gate.kind === "wait" ? <Loading text={message} /> : message}
    </div>
  );
}

/**
 * The top bar: the room name beside the DM's or the player's chip, a DM's
 * Undo and Redo, Find my token, the View button once Isometric is offered
 * (features/view/choice.ts), Fit map, and from 900 px up Full screen
 * where the browser can go full screen. The initiative strip sits in
 * its row or in a band of its own under it (`placement`,
 * features/encounter/band.ts). `compact` keeps only the tight gaps, the
 * name's way of giving way first, and the phase menu's absence, which a
 * phone's bar has no room for.
 *
 * A phone's bar checks whether its row overflows (scrollWidth past
 * clientWidth). Where the bar holds the strip, it records it, so the strip
 * goes back to the band until the layout is wider than that. Where the row
 * still overflows without the strip, the DM's chip keeps only its dot, as
 * a player's does, again until the layout is wider: on a 320 px phone at
 * 130% the whole chip pushed Fit off the screen. Once Isometric is offered
 * (features/view/choice.ts isoOffered), where a phone's row still
 * overflows, its gaps tighten from 6 px to 2, and then the View button
 * folds into the room's menu as its "View" row (D-261026-12), each again
 * until the layout is wider: with the View button there, a 320 px phone at
 * 130% had no room for Fit. Undo and Redo never leave (M2 below). Until
 * Isometric is offered the row gives way as it always has. A DM's row from 900 px up
 * checks too, since Undo and Redo sit in it on every layout
 * (docs/design-v1-layout-hierarchy.md M2): there the strip stays, the chip
 * gives way to its dot first, then Full screen leaves the bar, then the
 * Phase menu, and once Isometric is offered the gaps take a phone's 6 px
 * and last the View button folds into the room's menu, each until the
 * layout is wider: at 900 px in a fight on a scene with phases the View
 * button overflowed the row by 5 px. Any row checks once Isometric is
 * offered, a player's too. The Menu and a key still
 * reach full screen, and a scene's "Show a phase" chips still switch
 * phases. A player's row from 900 px up checks while it holds Full screen,
 * which is the only thing in it that gives way: at 900 px with the strip,
 * "Your turn" and End turn beside the side panel, there was no room for it.
 * The row's own box keeps its size when its content grows,
 * so the check runs when the row's size changes (the window), when the
 * strip's size changes (whose turn, "Your turn" and End turn, the timer),
 * and when the bar's other content changes (the room name, the blackout
 * pill, the scene's phases).
 */
function TopBar(props: {
  ref?: Ref<HTMLElement>;
  zoom: number;
  canFit: boolean;
  undo: boolean;
  compact: boolean;
  placement: TurnPlacement;
  chipDot: boolean;
  openSheet(): OpenSheet | null;
}) {
  const name = useRoomView((s) => s.view?.meta.name ?? "");
  const role = useRoomView((s) => s.you?.role);
  const connection = useRoomView((s) => s.connection);
  const blackout = useRoomView((s) => s.view?.meta.view.blackout === true);
  // The alerts it holds may open over the screen (FightAlerts), and then the bar rises over the notices with them.
  const alertsOverlay = useStore(useScoped(barDockSlot), (s) => s.alertsOverlay);
  const activeEntryId = useRoomView((s) => s.view?.encounter?.activeEntryId ?? null);
  const round = useRoomView((s) => s.view?.encounter?.round ?? null);
  const notice = useYourTurnNotice();
  // While the View menu's popover is open, the bar holding it stands over the notices with it (docs/design-v1-tool-options.md 7.6).
  const [viewOpen, setViewOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const recordOverflow = useRecordOverflow();
  const { width } = useLayoutSize();
  // The layout width at which the DM's whole chip last overflowed the row: up to it, the chip is its dot.
  const [dmDotUpTo, setDmDotUpTo] = useState(0);
  const dmDot = role === "dm" && width <= dmDotUpTo;
  // On a phone, the width at which the row still overflowed with the chip's dot: up to it, the gaps tighten.
  const [tightUpTo, setTightUpTo] = useState(0);
  // And the width at which the row still overflowed with tight gaps: up to it, the View button folds into the room's menu.
  const [viewFoldUpTo, setViewFoldUpTo] = useState(0);
  // From 900 px up the same two steps come last, after Full screen and the Phase menu, each with a width of its own so a wide window's steps never reach a phone's layout.
  const [wideTightUpTo, setWideTightUpTo] = useState(0);
  const [wideFoldUpTo, setWideFoldUpTo] = useState(0);
  const tight = isoOffered && width <= (props.compact ? tightUpTo : wideTightUpTo);
  const viewFolded = isoOffered && props.canFit && width <= (props.compact ? viewFoldUpTo : wideFoldUpTo);
  const fold = useScoped(viewFoldSlot);
  useLayoutEffect(() => fold.setState({ folded: viewFolded }), [fold, viewFolded]);
  useEffect(() => () => fold.setState({ folded: false }), [fold]);
  // From 900 px up, the width at which the row still overflowed with the chip's dot: up to it, the Phase menu leaves the bar.
  const [phaseOffUpTo, setPhaseOffUpTo] = useState(0);
  const phaseMenu = !props.compact && width > phaseOffUpTo;
  // From 900 px up, where the browser can go full screen, the width at which the row still overflowed once a DM's chip was its dot, or a player's row did at all: up to it, Full screen leaves the bar.
  const [fullscreenOffUpTo, setFullscreenOffUpTo] = useState(0);
  const fullscreen = !props.compact && fullscreenSupported() && width > fullscreenOffUpTo;
  const phases = useRoomView((s) => (s.sceneId ? (s.view?.scenes[s.sceneId]?.phases?.length ?? 0) : 0));
  // From 900 px up the strip sits in the bar whatever it holds, so only a phone's bar records it.
  const measured = props.placement === "bar" && props.compact;
  // A phone's row, a DM's row from 900 px up, which holds Undo, Redo and the Phase menu, any row that holds Full screen, and once Isometric is offered every row, which holds the View button.
  const checks = props.compact || role === "dm" || fullscreen || isoOffered;
  const check = useCallback(() => {
    const row = rowRef.current;
    if (!checks || !row) return;
    // The last button tucks into the bar's padding by a negative margin (RoomChrome.tsx FitButton), which is room the row has, not overflow.
    const last = row.lastElementChild;
    const tuck = last ? Math.max(0, -parseFloat(getComputedStyle(last).marginRight) || 0) : 0;
    const overflow = row.scrollWidth - row.clientWidth - tuck;
    if (overflow <= 0) return;
    // The strip leaves first. Once it is in the band, this runs again with the row it left. Then the chip's name, then on a phone the gaps' room and then the View button, which the room's menu still reaches, then Full screen, which the Menu and a key still reach, then the Phase menu, and from 900 px up the gaps' room and the View button last.
    if (measured) recordOverflow(layoutWidth(), overflow);
    else if (role === "dm" && !dmDot) setDmDotUpTo(layoutWidth());
    else if (isoOffered && props.compact && !tight) setTightUpTo(layoutWidth());
    else if (isoOffered && props.compact && props.canFit && !viewFolded) setViewFoldUpTo(layoutWidth());
    else if (fullscreen) setFullscreenOffUpTo(layoutWidth());
    else if (phaseMenu) setPhaseOffUpTo(layoutWidth());
    else if (isoOffered && !props.compact && !tight) setWideTightUpTo(layoutWidth());
    else if (isoOffered && !props.compact && props.canFit && !viewFolded) setWideFoldUpTo(layoutWidth());
  }, [checks, measured, recordOverflow, role, dmDot, props.compact, props.canFit, tight, viewFolded, fullscreen, phaseMenu]);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!checks || !row) return;
    const observer = new ResizeObserver(check);
    observer.observe(row);
    if (strip) observer.observe(strip);
    return () => observer.disconnect();
  }, [checks, strip, check]);
  useLayoutEffect(check, [check, name, blackout, role, activeEntryId, round, notice, phases]);
  return (
    <header
      ref={props.ref}
      data-rvtt-topbar=""
      {...smallUi(props.zoom)}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: alertsOverlay ? theme.z.alertsOverlay : viewOpen ? theme.z.popover : theme.z.bars,
        padding: `${theme.safe.top} calc(${theme.safe.mapRight} + ${theme.space(3)}px) 0 calc(${theme.safe.left} + ${theme.space(3)}px)`,
        background: theme.color.overlay,
        borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
        ...chromeZoom(props.zoom),
      }}
    >
      <div
        ref={rowRef}
        style={{
          display: "flex",
          alignItems: "center",
          // A DM's phone fits the name, Undo, Redo and Fit only with tighter gaps, and the narrowest phones the View button only with tighter still. From 900 px up a full row takes a phone's gaps before the View button folds.
          gap: props.compact ? theme.space(tight ? 0.5 : 1.5) : theme.space(tight ? 1.5 : 3),
          height: TOP_BAR,
        }}
      >
        <ConnectionDot state={connection} />
        <h1
          style={{
            margin: 0,
            fontSize: theme.font.input,
            fontWeight: theme.weight.bold,
            // A few letters and the ellipsis always show, so the bar still names the room (the owner's decision).
            minWidth: 40,
            // On a phone the room name gives way to the player's chip (features section 13): it shrinks
            // first, down to those few letters, and the chip only after it, so a long room name never cuts
            // the player's own name to a letter. Flex shares the shortfall by these factors, so the room
            // name's is large enough that the chip's share stays under a layout unit: a thousand left the
            // chip a fraction of a pixel short, which cut a name that fit with an ellipsis.
            flex: props.compact ? "0 100000 auto" : "0 1 auto",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </h1>
        {role ? <YouChip dm={role === "dm"} dot={role === "dm" ? dmDot : props.chipDot} /> : null}
        {role === "dm" && blackout ? (
          <Chip outline={theme.color.danger} color={theme.color.dangerText}>
            Players see black
          </Chip>
        ) : null}
        <div style={{ flex: 1 }} />
        {/* Once Isometric is offered, View or Fit always follows them on a scene, so they keep their whole width. */}
        {props.undo ? <UndoButtons tuck={!(isoOffered && props.canFit)} /> : null}
        {phaseMenu ? <PhaseMenu /> : null}
        {props.placement === "bar" ? <InitiativeStrip placement="bar" notice={notice} stripRef={setStrip} /> : null}
        {props.canFit && role === "player" ? <FindButton openSheet={props.openSheet} /> : null}
        {props.canFit && isoOffered ? <ViewButton onOpen={setViewOpen} folded={viewFolded} /> : null}
        {props.canFit ? <FitButton /> : null}
        {fullscreen ? <FullscreenButton /> : null}
      </div>
      {props.placement === "band" ? <InitiativeStrip placement="band" notice={notice} /> : null}
      <FightWatch />
    </header>
  );
}

/**
 * A chip in the top bar (docs/design-v1-visual.md 3.2): a pill 28 px tall
 * at 13 px weight 700 with a 1 px outline. `shrink` lets a long label give
 * way to the bar's buttons, cut short with an ellipsis, down to the chip's
 * first child.
 */
function Chip(props: { outline: string; color?: string; shrink?: boolean; title?: string; children: ReactNode }) {
  return (
    <span
      title={props.title}
      style={{
        flex: props.shrink ? "0 1 auto" : "none",
        display: "flex",
        alignItems: "center",
        gap: theme.space(1.5),
        minWidth: props.shrink ? 32 : undefined,
        boxSizing: "border-box",
        height: CHIP_PX,
        padding: `0 ${theme.space(2.5)}px`,
        borderRadius: theme.radius.pill,
        border: `${theme.line.border}px solid ${props.outline}`,
        color: props.color ?? theme.color.text,
        fontSize: theme.font.small,
        fontWeight: theme.weight.bold,
        whiteSpace: "nowrap",
      }}
    >
      {props.children}
    </span>
  );
}

const CHIP_PX = 28;

/** The member's color, as the dot in a chip. */
function ChipDot(props: { color: string }) {
  return <span aria-hidden style={{ flex: "none", width: 8, height: 8, borderRadius: theme.radius.round, background: props.color }} />;
}

/**
 * Who this device plays as (features section 13), so a phone passed around
 * the table shows whose it is. One chip shape for the DM and a player: a
 * dot in the member's color and an outline in the accent. The DM's says
 * "DM", the player's their name, in the theme's text color, since some
 * member colors, such as the purple, are too dark to read as small text on
 * the bar. `dot` leaves only the dot, named in its title and label, where
 * the bar is too short for the name.
 */
function YouChip(props: { dm: boolean; dot: boolean }) {
  const member = useRoomView((s) => (s.you ? s.view?.members[s.you.memberId] : undefined));
  if (props.dm && !props.dot) {
    return (
      <Chip outline={theme.color.accent}>
        <ChipDot color={member?.color ?? theme.color.accent} />
        DM
      </Chip>
    );
  }
  if (!member && !props.dm) return null;
  if (props.dot) {
    const says = props.dm ? "You are the DM" : `You are ${member?.name ?? ""}`;
    return (
      <span
        role="img"
        aria-label={says}
        title={says}
        style={{
          flex: "none",
          display: "grid",
          placeItems: "center",
          boxSizing: "border-box",
          width: CHIP_PX,
          height: CHIP_PX,
          borderRadius: theme.radius.round,
          border: `${theme.line.border}px solid ${theme.color.accent}`,
        }}
      >
        <ChipDot color={member?.color ?? theme.color.accent} />
      </span>
    );
  }
  if (!member) return null;
  return (
    <Chip outline={theme.color.accent} shrink title={`You are ${member.name}`}>
      <ChipDot color={member.color} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={VISUALLY_HIDDEN}>You are </span>
        {member.name}
      </span>
    </Chip>
  );
}

/** The connection banner, on one line on a short screen. Inside a very short sheet while one shows, its 3 s count kept here (pages/modalSlot.tsx). */
function Banner() {
  const connection = useRoomView((s) => s.connection);
  const due = useReconnectDue(connection);
  const slot = useModalSlot("connection");
  const compact = useLayoutSize().height < SHORT_LANDSCAPE_MAX;
  // Nothing at all while it is not due: an empty box would still take a gap in the stack, 8 px a short screen does not have.
  if (!due) return null;
  return inModal(
    <div style={{ pointerEvents: "auto", width: "100%", maxWidth: theme.layout.notice, minWidth: 0 }}>
      <ReconnectNotice state={connection} compact={compact} />
    </div>,
    slot,
  );
}

/**
 * Refusals and notices from the store (design 7.4), each gone after a few
 * seconds or a tap, in the Notice look (components/Notice.tsx).
 *
 * While a sheet shows in the very short mode, a new toast shows and is read
 * out inside it, at the top of its body (pages/modalSlot.tsx), since the
 * modal leaves the map's notices out of reach. On a phone whose alerts
 * column shows a card, a new toast starts under that card (`low`,
 * barDock.ts toastTop), in `layer`, and joins any toast already there,
 * below it, so their stack keeps the top its first took, and across the
 * cards' edges as they stand now (`edges`, barDock.ts columnEdges). A toast
 * shown in the sheet goes with the sheet.
 *
 * While a map pane stands as a bottom sheet (`paneStands`), a new toast
 * starts under the pane's header instead (`pane`, barDock.ts
 * paneToastTop), and the layer's one stack keeps under the header: a
 * column stack moves there once, as the pane opens, and so do the toasts
 * at the top of the notices (review FU21B-OP-7). The pane moves the
 * header as it grows, shrinks and makes room for the alerts row on its
 * edge, which a trap going off brings in the same moment as its toast, and
 * a toast left where it showed would then cover the header and Close.
 * Once the pane goes away, the stack stays where the header last stood,
 * until another pane stands (barDock.ts nextToastPlaces).
 *
 * On an upright phone, a toast that shows over the header of the expanded
 * token bar, which can reach the top of the toasts' room, is placed again
 * as if it came now, under that header, so Close and Collapse stay in
 * reach (review LP19-BS-2). Its box is read
 * once it is drawn, since only then is its height known, and the move
 * happens before the browser paints. So is a toast already showing there
 * as the bar opens (review LP19-Q1), and the stack under the header once
 * the header goes down into it, as an alert card that moves the bar down
 * makes it, or a pan (review LP19-OPUS-3). Only the bar's opening whose
 * header placed the stack moves it so: a stack a closed bar, or another
 * token's, left behind stays where it is (barDock.ts barStack, review
 * FU24-OPUS-1). The bar asks for that look through `recheck` (barDock.ts
 * headAsksToasts). Any other move of the bar leaves the toasts where they
 * are.
 *
 * When the screen turns, a toast at the top of the notices that now
 * meets the column's first card is placed again as if it came now, under
 * that card, and again as the column measures the card anew while the
 * turn lasts (review LP17-AW-1), so it never covers the card's buttons.
 * So is a toast that came with its card, as a trap's does, once the
 * column measures that card (review LP18-TO-5), and a toast already at the
 * top of the notices as a turn starts, once the column measures the
 * turn's card or a death save card in a column that showed none (review
 * LP20-CC-2), so neither card's top nor the folded turn card's Show is
 * under it.
 *
 * Each toast over the map renders through a portal into a host of its
 * own, an element with no box, which this moves into the notices' stack
 * or the layer's. So a toast that moves from the notices to the layer is
 * the same toast, never mounted again. No toast is a live region: one
 * hidden status region here says each toast once, as it is pushed
 * (review FU22B-OP-3), so neither a move nor a blackout makes one speak
 * again.
 *
 * A stack that runs past its room, down to the highest of the tool's
 * controls at the screen's foot (`foot`, in the chrome's px, so a hint
 * under them may be covered, as the alerts' summary row may cover it),
 * first drops its oldest toasts whose words the log keeps, never one with
 * a button nor an error the log never sees, and then scrolls there, the
 * newest in view, with "Scroll for more" on the edge that hides toasts
 * but never over the newest (barDock.ts fitToasts, reviews LP16-PT-2 and
 * FU22B-OP-4). `foot` is null until the bars are measured, as on the
 * first render after a blackout, and nothing is fitted until then.
 */
function Toasts(props: {
  low: number | null;
  edges: ToastEdges;
  pane: number | null;
  paneStands: boolean;
  layer: HTMLElement | null;
  foot: number | null;
  optionsTop: number | null;
  /** The foot of the room a resting strip leaves the toasts (barDock.ts restFloor), or null. */
  restFloor: number | null;
  /** Where the toasts' room starts, under the top bars and the lasting notices. */
  top: number | null;
  safeTop: number;
}) {
  const toasts = useRoomView((s) => s.toasts);
  const heldSince = useRoomView((s) => s.buildHeldSince);
  const ui = useRoomUi();
  const slot = useModalSlot("toasts");
  const zoom = useUiScale();
  const { width, height } = useLayoutSize();
  // A toast whose time ran out while play was paused goes with its timer, and is never drawn for a frame first (review FU22B-OP-6).
  const left = new Map(toastsLeft(toasts, Date.now(), heldSince).map((t) => [t.id, t.ms]));
  const showing = toasts.filter((t) => (left.get(t.id) ?? 0) > 0);
  const ids = showing.map((t) => t.id);
  /*
   * Over a band too short for a toast beside a resting strip, the newest
   * shows as one row over the top bar's row, and the older ones wait, not
   * drawn (docs/design-v1-bar-compact.md 3.5, barDock.ts toastsOverBars).
   * A tap on its words shows it whole with its time held, and Close or
   * Escape shrinks it back. One that arrives meanwhile waits, and takes
   * the row then.
   */
  const overBars = props.restFloor !== null && props.top !== null && slot === null && !props.paneStands && props.layer !== null && toastsOverBars({ restFloor: props.restFloor, top: props.top });
  const [whole, setWhole] = useState<number | null>(null);
  const wholeToast = overBars && whole !== null ? showing.find((t) => t.id === whole) : undefined;
  const rowToast = overBars ? (wholeToast ?? showing[showing.length - 1]) : undefined;
  const shrink = useCallback(() => {
    setWhole((id) => {
      if (id !== null) ui.holdToast(id, false);
      return null;
    });
  }, [ui]);
  useEffect(() => {
    if (whole !== null && wholeToast === undefined) shrink();
  }, [whole, wholeToast, shrink]);
  // A toast held whole is let go as the toasts unmount, so none is left stopped. Only a player's blackout unmounts them today, and PauseScreen drops every toast then (review BARBUILD-ASTRA-04).
  const wholeNow = useRef(whole);
  wholeNow.current = whole;
  useEffect(
    () => () => {
      if (wholeNow.current !== null) ui.holdToast(wholeNow.current, false);
    },
    [ui],
  );
  // The box of the toast over the bars, as the row or whole, so the alerts' summary row stands clear of it, or in the strip's header (D-261024-23).
  const dockStore = useScoped(barDockSlot);
  const rowBox = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const r = rowToast !== undefined ? rowBox.current?.getBoundingClientRect() : undefined;
    const next = r ? { top: r.top, bottom: r.bottom } : null;
    const was = dockStore.getState().toastRow;
    if (next === null ? was !== null : was === null || Math.abs(was.top - next.top) > 0.5 || Math.abs(was.bottom - next.bottom) > 0.5) dockStore.setState({ toastRow: next });
  });
  useLayoutEffect(() => () => dockStore.setState({ toastRow: null }), [dockStore]);
  useEffect(() => {
    if (wholeToast === undefined) return;
    // Escape shrinks the whole toast first, and its preventDefault leaves the room's own Escape alone (RoomChrome.tsx useEscape).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      shrink();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [wholeToast, shrink]);
  const upright = width <= height;
  const turn = useRef({ upright, at: -Infinity });
  if (turn.current.upright !== upright) turn.current = { upright, at: Date.now() };
  // The column measures its cards a render or two after the turn, so the turn counts for a moment, not one render.
  const turned = Date.now() - turn.current.at < TURN_MS;
  // The places from the render before, the same again when a render repeats, so this stays pure.
  const placed = useRef<ToastPlaces>(NO_TOAST_PLACES);
  // The foot of the toasts at the notices' top as last drawn, in the chrome's px, so a toast never starts under the column's card over them (review LP18-TO-4).
  const mapFoot = useRef<number | null>(null);
  // A card that comes with its toast is measured a render after it, so the toast counts as new for a moment (review LP18-TO-5).
  const cardMs = cardWaitMs();
  // A toast not drawn yet is new, however long it waited (store.ts toastsLeft).
  const recent = new Set(showing.filter((t) => t.shownAt === undefined || Date.now() - t.shownAt < cardMs).map((t) => t.id));
  // A turn's start counts for as long, since the column measures the turn's card a render or two after it (review LP20-CC-2).
  const activeEntry = useRoomView((s) => s.view?.encounter?.activeEntryId ?? null);
  const turnAt = useRef({ entry: activeEntry, at: -Infinity });
  if (turnAt.current.entry !== activeEntry) turnAt.current = { entry: activeEntry, at: Date.now() };
  const turnStarted = activeEntry !== null && Date.now() - turnAt.current.at < cardMs;
  // The toasts to place under a spanning token bar's header, read from the boxes as last drawn, the place under it, and the bar's opening then, which owns the stack once it is placed (barDock.ts toastsUnderHead and barStack).
  const spanToast = useScoped(spanToastSlot);
  const [overBar, setOverBar] = useState<OverBar>(NOT_OVER_BAR);
  // The bar asks for a look again as it opens, or as its header goes down into the stack under it, which draws nothing else here.
  const [, setRecheck] = useState(0);
  useLayoutEffect(() => {
    spanToast.recheck = () => setRecheck((n) => n + 1);
    return () => {
      spanToast.recheck = null;
    };
  }, [spanToast]);
  /*
   * As resting begins, and each time the strip's top rises, a stack in the
   * layer whose foot as last drawn is lower than the room's new foot takes
   * its place anew (barDock.ts nextToastPlaces `anew`, 3.5).
   */
  const floorWas = useRef<number | null>(null);
  const layerFoot = useRef<number | null>(null);
  const rose = props.restFloor !== null && (floorWas.current === null || props.restFloor < floorWas.current - 0.5);
  const anew = rose && layerFoot.current !== null && layerFoot.current > props.restFloor! ? new Set(ids) : undefined;
  floorWas.current = props.restFloor;
  placed.current = nextToastPlaces(placed.current, { ids, pane: props.pane, paneStands: props.paneStands, low: props.low, layer: props.layer !== null, slot: slot !== null, turned, mapFoot: mapFoot.current, recent, overBar, anew, turnStarted });
  const { places } = placed.current;
  useEffect(() => {
    if (slot) return;
    for (const [id, place] of placed.current.places) if (place === "sheet") ui.dismissToast(id);
  }, [slot, ui]);
  // Each toast's time counts from when it was first drawn (store.ts toastsLeft), so one that comes or goes, or a blackout that takes them all off screen, never restarts it. One not drawn yet, or shown whole, has no timer.
  useEffect(() => {
    const timers = toastsLeft(toasts, Date.now(), heldSince).flatMap(({ id, ms, runs }) => (runs ? [setTimeout(() => ui.dismissToast(id), ms)] : []));
    return () => timers.forEach(clearTimeout);
  }, [toasts, heldSince, ui]);
  const hosts = useRef(new Map<number, HTMLElement>());
  const hostOf = (id: number): HTMLElement => {
    let host = hosts.current.get(id);
    if (!host) {
      host = document.createElement("div");
      host.style.display = "contents";
      hosts.current.set(id, host);
    }
    return host;
  };
  const stacks = { notices: useToastStack(), layer: useToastStack() };
  const overMap = overBars ? [] : showing.filter((t) => places.get(t.id) === "map");
  const inSheet = slot ? showing.filter((t) => places.get(t.id) === "sheet") : [];
  const low = overBars ? [] : showing.filter((t) => inToastLayer(places.get(t.id)));
  const lowAt = toastLayerPlace(placed.current, ids, props.edges);
  const drawn = [...overMap, ...low];
  // The toasts drawn now, in the very short sheet and the one row too, start their time as they first draw (review BC-OPUS-35).
  const drawnKey = [...drawn, ...inSheet, ...(rowToast ? [rowToast] : [])].map((t) => t.id).join(",");
  useLayoutEffect(() => {
    if (drawnKey !== "") ui.toastsDrawn(drawnKey.split(",").map(Number));
  }, [drawnKey, ui]);
  useLayoutEffect(() => {
    // The hosts of toasts that went come out first, so the ones after them are already in order and stay put: moving a host that holds focus would blur it (review FU22B-ASTRA-01).
    const kept = new Set(drawn.map((t) => t.id));
    for (const [id, host] of hosts.current) {
      if (kept.has(id)) continue;
      host.remove();
      hosts.current.delete(id);
    }
    const put = (stack: HTMLElement | null, list: readonly Toast[]) => {
      if (!stack) return;
      let at: ChildNode | null = stack.firstChild;
      for (const t of list) {
        const host = hosts.current.get(t.id);
        if (!host) continue;
        if (host !== at) stack.insertBefore(host, at);
        at = host.nextSibling;
      }
    };
    put(stacks.notices.stack.current, overMap);
    put(stacks.layer.stack.current, low);
    const height = (t: Toast) => hosts.current.get(t.id)?.firstElementChild?.getBoundingClientRect().height ?? 0;
    for (const [stack, list] of [
      [stacks.notices, overMap],
      [stacks.layer, low],
    ] as const) {
      const drop = stack.fit(list, height, props.foot, zoom);
      for (const id of drop) ui.dismissToast(id);
    }
    const notices = stacks.notices.box.current;
    mapFoot.current = overMap.length > 0 && notices ? notices.getBoundingClientRect().bottom / zoom : null;
    // The foot of the toasts over the map, at the top of the notices or in the layer, which the clearing move leaves its token below (barDock.ts clearShift, review LP19-BS-3).
    const layerBox = lowAt !== null ? stacks.layer.box.current : null;
    layerFoot.current = layerBox && low.length > 0 ? layerBox.getBoundingClientRect().bottom / zoom : null;
    const feet = [mapFoot.current, layerFoot.current].filter((f): f is number => f !== null);
    spanToast.foot = feet.length > 0 ? Math.max(...feet) : null;
    // A toast that just showed over the bar's header takes its place again under it, on a render before the browser paints. While the bar opens, so does every toast already showing there (review LP19-Q1).
    const opening = barOpening(spanToast.shownAt, Date.now());
    const boxes = drawn.flatMap((t) => {
      const r = opening || recent.has(t.id) ? hosts.current.get(t.id)?.firstElementChild?.getBoundingClientRect() : undefined;
      return r && r.height > 0 ? [{ id: t.id, top: r.top / zoom, bottom: r.bottom / zoom }] : [];
    });
    // A stack this opening's header placed goes again once the header goes down into it (reviews LP19-OPUS-3 and FU24-OPUS-1).
    const opened = spanToast.opening;
    const stack = barStack(placed.current, ids, opened);
    spanToast.stack = stack !== null && opened !== null ? { top: stack.top, opening: opened } : null;
    const over = toastsUnderHead(boxes, spanToast.head, stack);
    const at = over.size > 0 && props.optionsTop !== null ? barToastTop({ head: spanToast.head, optionsTop: props.optionsTop }) : null;
    // The opening is read here, as the toasts are placed, so a bar that closes before the next render never hands its stack to the next one.
    const next = at === null || opened === null ? NOT_OVER_BAR : { ids: over, at, opening: opened };
    if (next.at !== overBar.at || next.opening !== overBar.opening || next.ids.size !== overBar.ids.size || [...next.ids].some((id) => !overBar.ids.has(id))) setOverBar(next);
  });
  useEffect(
    () => () => {
      spanToast.foot = null;
      spanToast.stack = null;
    },
    [spanToast],
  );
  return (
    <>
      <ToastVoice toasts={toasts} heldSince={heldSince} />
      {overMap.length > 0 ? <ToastStack stack={stacks.notices} style={{ width: "100%" }} /> : null}
      {props.layer && lowAt !== null
        ? createPortal(
            // Under the column's first card, the card's edges, so the toast lines up with it. Under a pane's header, across the map as the notices are.
            <ToastStack stack={stacks.layer} style={{ position: "absolute", top: lowAt.top, ...(lowAt.edges ? { left: lowAt.edges.left, right: lowAt.edges.right } : { left: 0, right: 0, padding: `0 ${theme.space(3)}px` }) }} />,
            props.layer,
          )
        : null}
      {drawn.map((t) => createPortal(<ToastNote toast={t} onDismiss={() => ui.dismissToast(t.id)} />, hostOf(t.id), `toast-${t.id}`))}
      {props.layer && rowToast
        ? createPortal(
            // Over the top bar's row, 4 px from the safe top, as wide as the layer less its sides. Whole, it stands from the safe top down.
            <div ref={rowBox} data-toast-over-bars="" style={{ position: "absolute", top: props.safeTop + (wholeToast ? 0 : theme.space(1)), left: 0, right: 0, padding: `0 ${theme.space(3)}px`, display: "flex", justifyContent: "center" }}>
              <ToastNote
                key={rowToast.id}
                toast={rowToast}
                form={wholeToast ? "whole" : "row"}
                onDismiss={() => ui.dismissToast(rowToast.id)}
                onWhole={() => {
                  setWhole(rowToast.id);
                  ui.holdToast(rowToast.id, true);
                }}
                onShrink={shrink}
              />
            </div>,
            props.layer,
          )
        : null}
      {slot && inSheet.length > 0
        ? createPortal(
            inSheet.map((t) => <ToastNote key={t.id} toast={t} onDismiss={() => ui.dismissToast(t.id)} />),
            slot,
          )
        : null}
    </>
  );
}

type OverBar = { ids: ReadonlySet<number>; at: number | null; opening: number | null };

const NOT_OVER_BAR: OverBar = { ids: new Set(), at: null, opening: null };

/** How long after the screen turns a toast at the top of the notices may still be placed again under the column's card. */
const TURN_MS = 600;

/** How long after a toast shows at the top of the notices, with no card to start under, a card the column measures may still take it under that card, as long as a turn's. */
const CARD_MS = 600;

/**
 * CARD_MS, or the page's `rvttToastCardMs` where a run sets it: a test
 * hook, so e2e/dmphone.e2e.ts can leave a trap's toast at the notices'
 * top, as a card measured late leaves it, to see what comes after it
 * there (review LP18-TO-4). Nothing in the app sets it.
 */
function cardWaitMs(): number {
  const hook = (globalThis as { rvttToastCardMs?: unknown }).rvttToastCardMs;
  return typeof hook === "number" && hook >= 0 ? hook : CARD_MS;
}

/** The widest a toast stands, and a stack that scrolls with it, so the map either side still takes a tap. */
const TOAST_MAX_PX = theme.layout.notice;

/**
 * What a tool's key said (docs/design-v1-tool-cycle.md 4.3), "Area:
 * Sphere", in a polite status beside the toolbar, mounted with it, so a
 * phone's sheet over the options never takes it away. It alone reads its
 * slot, so a press re-renders it and not the page.
 */
function ToolVoice() {
  const said = useStore(useScoped(toolVoiceSlot));
  return (
    <div role="status" data-rvtt-tool-status="" style={VISUALLY_HIDDEN}>
      <span key={said.key}>{said.text}</span>
    </div>
  );
}

/** Which toasts this Room has said, by the newest id said: ids only grow, and the record outlives Toasts through a blackout. */
const toastVoiceSlot = scopeSlot(() => ({ through: 0 }));

/** What a toast says: its words, a die's verdict, and its button's name, as its own box read out before it stopped being a live region. */
function toastWords(t: Toast): string {
  return [t.text, t.die?.verdict ? `${t.die.verdict}.` : null, t.action ? `${t.action.label}.` : null].filter((w): w is string => w !== null).join(" ");
}

/**
 * The toasts' one status region (review FU22B-OP-3), always on the page
 * and visually hidden, as FoldStatus is for the folded alerts: each toast
 * is said once, as it is pushed, whatever moves its box. Inside a very
 * short sheet while one shows, where the modal leaves the room's region
 * out of reach, it speaks from the sheet's status slot instead. Its
 * record of what it has said stays in the Room's scope, and its region
 * starts empty in a new place, so a move or a blackout says nothing again.
 */
function ToastVoice(props: { toasts: readonly Toast[]; heldSince: number | undefined }) {
  const voice = useScoped(toastVoiceSlot);
  const slot = useModalSlot("status");
  const [said, setSaid] = useState({ key: 0, text: "" });
  const [speaksIn, setSpeaksIn] = useState(slot);
  if (speaksIn !== slot) {
    setSpeaksIn(slot);
    setSaid((was) => ({ key: was.key + 1, text: "" }));
  }
  useEffect(() => {
    const now = Date.now();
    const left = new Map(toastsLeft(props.toasts, now, props.heldSince).map((t) => [t.id, t.ms]));
    const fresh = props.toasts.filter((t) => t.id > voice.through);
    if (fresh.length === 0) return;
    voice.through = Math.max(...fresh.map((t) => t.id));
    // A toast whose time ran out unseen, while play was paused, is not news any more.
    const words = fresh.filter((t) => (left.get(t.id) ?? 0) > 0).map(toastWords);
    // A new node each time, so words that repeat, as a second "Undid moving Thorn.", are said again.
    if (words.length > 0) setSaid((was) => ({ key: was.key + 1, text: words.join(" ") }));
  }, [props.toasts, props.heldSince, voice]);
  return inModal(
    <div role="status" data-rvtt-toast-status="" style={VISUALLY_HIDDEN}>
      <span key={said.key}>{said.text}</span>
    </div>,
    slot,
  );
}

/** How a stack of toasts over the map fits its room: the height it scrolls in, in the chrome's px, or none while it fits, and whether toasts hide above and below. */
type StackFit = { max: number | null; above: boolean; below: boolean };

const FITS: StackFit = { max: null, above: false, below: false };

/** One stack's scroller and the stack inside it, which Toasts fills with the toasts' hosts, and how it fits its room. */
function useToastStack() {
  const box = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<StackFit>(FITS);
  const newest = useRef<number | null>(null);
  /*
   * Whether the box stands at its foot, the newest in view. A resize, the
   * pane's header moving or the tool's options changing shrinks the room
   * with no scroll of its own, so a stack that followed its newest is put
   * back at its foot then (review FU22B-ASTRA-02). A scroll toward older
   * toasts is the reader's, and is left alone until a newer toast comes.
   */
  const following = useRef(true);
  const zoomAt = useRef(1);
  const update = (next: StackFit) => setShown((was) => (was.max === next.max && was.above === next.above && was.below === next.below ? was : next));
  /*
   * "Scroll for more" on the edge that hides toasts. The top's lies only
   * over toasts above the newest, never over the newest kept in view,
   * whose button it would hide: a newest taller than the room shows its
   * foot, cut at the top. The foot's stands where the box holds it over a
   * whole touch target, as on a short screen the newest's button would
   * sit under it.
   */
  const edges = () => {
    const el = box.current;
    if (!el) return;
    following.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    const fade = SCROLL_FOR_MORE_PX * zoomAt.current;
    const last = stack.current?.lastElementChild?.firstElementChild?.getBoundingClientRect();
    const above = el.scrollTop > 1 && (last === undefined || last.top - el.getBoundingClientRect().top >= fade);
    const below = !following.current;
    setShown((was) => {
      if (was.max === null) return was;
      const foot = below && was.max >= SCROLL_FOR_MORE_PX + TOAST_MIN;
      return was.above === above && was.below === foot ? was : { ...was, above, below: foot };
    });
  };
  const fits = () => {
    newest.current = null;
    following.current = true;
    if (shown.max !== null) update(FITS);
  };
  /** After the hosts are placed: what to drop from `list` (barDock.ts fitToasts), and otherwise the room it scrolls in and its fades, the newest kept in view. */
  const fit = (list: readonly Toast[], height: (t: Toast) => number, foot: number | null, zoom: number): number[] => {
    const el = box.current;
    if (!el || list.length === 0 || foot === null) {
      fits();
      return [];
    }
    zoomAt.current = zoom;
    const room = foot * zoom - el.getBoundingClientRect().top;
    const { drop, scrolls } = fitToasts(
      list.map((t) => ({ id: t.id, height: height(t), action: t.action !== undefined, logged: t.logged === true })),
      theme.space(2) * zoom,
      room,
    );
    if (drop.length > 0) return drop;
    if (!scrolls) {
      fits();
      return [];
    }
    // At least a toast's least height, so a stack on too short a room still shows one whole touch target.
    const max = Math.round((Math.max(room, TOAST_MIN * zoom) / zoom) * 2) / 2;
    if (shown.max !== max) {
      update({ ...shown, max });
      return [];
    }
    const last = list[list.length - 1]!.id;
    if (newest.current !== last) {
      newest.current = last;
      following.current = true;
    }
    if (following.current) el.scrollTop = el.scrollHeight;
    edges();
    return [];
  };
  return { box, stack, shown, fit, edges };
}

/** A stack of toasts over the map: a box that scrolls while it runs past its room, its fades, and the stack the toasts' hosts go into. */
function ToastStack(props: { stack: ReturnType<typeof useToastStack>; style: CSSProperties }) {
  const { box, stack, shown, edges } = props.stack;
  const scrolls = shown.max !== null;
  // Scrolling, the box takes taps and scroll gestures, so it is no wider than its toasts, centered as they are, and the map either side still takes a tap (review FU22B-OP-5).
  const pad = props.style.padding !== undefined ? 2 * theme.space(3) : 0;
  return (
    <div ref={box} onScroll={edges} style={{ ...props.style, ...(scrolls ? { maxHeight: shown.max!, maxWidth: TOAST_MAX_PX + pad, marginLeft: "auto", marginRight: "auto", overflowY: "auto", overscrollBehavior: "contain", pointerEvents: "auto" } : null) }}>
      {scrolls && shown.above ? <ScrollForMore edge="top" /> : null}
      <div ref={stack} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: theme.space(2) }} />
      {scrolls && shown.below ? <ScrollForMore /> : null}
    </div>
  );
}

/**
 * One toast. In the stack, as it always was. As the one row over the top
 * bar's row (docs/design-v1-bar-compact.md 3.5): 44 px with its outline
 * drawn inside, its words on one line cut with an ellipsis and whole as
 * the text button's name, which shows it whole, and its action at the
 * right end, its words whole and the row's full height. Whole: the stack's
 * form with a 44 px Close at its top right, which shrinks it back.
 */
function ToastNote(props: { toast: Toast; onDismiss(): void; form?: "stack" | "row" | "whole"; onWhole?(): void; onShrink?(): void; closeRoom?: boolean }) {
  const t = props.toast;
  const form = props.form ?? "stack";
  const tone = NOTICE_TONES[t.tone === "error" ? "danger" : "info"];
  const look: CSSProperties = {
    pointerEvents: "auto",
    width: "100%",
    maxWidth: TOAST_MAX_PX,
    minHeight: theme.touch,
    borderRadius: theme.radius.md,
    background: tone.fill,
    border: `${theme.line.border}px solid ${tone.outline}`,
    color: tone.text,
    fontFamily: theme.font.body,
    fontSize: theme.font.body14,
    lineHeight: theme.leading.body,
    textAlign: "left",
    boxShadow: theme.shadow.float,
  };
  const action = t.action;
  if (form === "row") {
    return (
      <div
        data-toast=""
        data-toast-form="row"
        style={{ ...look, maxWidth: "none", height: theme.touch, minHeight: 0, boxSizing: "border-box", border: "none", outline: `${theme.line.border}px solid ${tone.outline}`, outlineOffset: -theme.line.border, display: "flex", alignItems: "stretch", overflow: "hidden" }}
      >
        <button
          type="button"
          aria-label={t.text}
          onClick={props.onWhole}
          style={{ flex: "1 1 auto", minWidth: theme.touch, padding: `0 ${theme.space(2)}px 0 ${theme.space(3)}px`, background: "transparent", border: "none", color: "inherit", font: "inherit", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer" }}
        >
          {t.text}
        </button>
        {action ? (
          <Button
            size="sm"
            onClick={() => {
              if (action.ready?.() === false) return;
              props.onDismiss();
              action.run();
            }}
            style={{ flex: "none", height: theme.touch, minHeight: theme.touch }}
          >
            {action.label}
          </Button>
        ) : null}
      </div>
    );
  }
  if (form === "whole") {
    return (
      <div data-toast-form="whole" style={{ position: "relative", width: "100%", maxWidth: TOAST_MAX_PX, pointerEvents: "auto" }}>
        <ToastNote toast={t} onDismiss={props.onDismiss} closeRoom />
        <IconButton icon="close" label="Close" onClick={props.onShrink} style={{ position: "absolute", top: 0, right: 0 }} />
      </div>
    );
  }
  if (action) {
    // A button cannot hold another, so the words dismiss as a button of their own beside the action's.
    return (
      <div data-toast="" style={{ ...look, display: "flex", alignItems: "center", flexWrap: "wrap", gap: theme.space(2), padding: `${theme.space(1)}px ${props.closeRoom ? theme.touch : theme.space(2)}px ${theme.space(1)}px ${theme.space(3)}px` }}>
        <button type="button" onClick={props.onDismiss} style={{ flex: "1 1 200px", minWidth: 0, minHeight: theme.touch, padding: 0, background: "transparent", border: "none", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer" }}>
          {t.text}
        </button>
        <Button
          size="sm"
          onClick={() => {
            // A button not ready, such as Forget and undo while a builder gesture waits, does nothing and keeps the toast.
            if (action.ready?.() === false) return;
            props.onDismiss();
            action.run();
          }}
          style={{ flex: "none" }}
        >
          {action.label}
        </Button>
      </div>
    );
  }
  return (
    <button type="button" data-toast="" onClick={props.onDismiss} style={{ ...look, padding: `${theme.space(2)}px ${props.closeRoom ? theme.touch : theme.space(3)}px ${theme.space(2)}px ${theme.space(3)}px`, cursor: "pointer" }}>
      {t.die ? <ToastD20 die={t.die} text={t.text} /> : t.text}
    </button>
  );
}

/** The toast die's size, and its ring's gap and width, in CSS px. */
const TOAST_DIE_PX = 28;
const TOAST_RING_GAP_PX = 3;
const TOAST_RING_PX = 2;

/**
 * Someone else's D20 Test leads with a flat d20 showing its kept face
 * (docs/design-v1-roll-animation.md 4), in the app's neutral colors, never
 * the roller's set. A natural 20 or a critical hit rings once in the accent,
 * and a natural 1 is outlined in danger. The icon is hidden from a screen
 * reader, so the verdict follows the text as hidden words.
 */
function ToastD20(props: { die: ToastDie; text: string }) {
  const { die } = props;
  const outer = TOAST_DIE_PX / 2 + TOAST_RING_GAP_PX + TOAST_RING_PX;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
      <span data-toast-die={die.face} style={{ position: "relative", flex: "none", width: TOAST_DIE_PX, height: TOAST_DIE_PX }}>
        <D20Icon size={TOAST_DIE_PX} text={String(die.face)} body={theme.color.surface} edge={theme.color.textMuted} ink={theme.color.text} {...(die.fumble ? { outline: theme.color.danger } : {})} />
        {die.ring ? (
          <span
            aria-hidden="true"
            data-toast-ring=""
            style={{
              position: "absolute",
              left: TOAST_DIE_PX / 2 - outer,
              top: TOAST_DIE_PX / 2 - outer,
              width: 2 * outer,
              height: 2 * outer,
              boxSizing: "border-box",
              borderRadius: theme.radius.round,
              border: `${TOAST_RING_PX}px solid ${theme.color.accent}`,
              opacity: 0.95,
              animation: "rvtt-tray-ring 520ms ease-out both",
            }}
          />
        ) : null}
      </span>
      <span>
        {props.text}
        {die.verdict ? <span style={VISUALLY_HIDDEN}> {die.verdict}.</span> : null}
      </span>
    </span>
  );
}

/** A terminal close (design 7.1: 4001, 4003, 4009). The socket will not retry, so say why and offer the way back. */
function EndedScreen(props: { ended: Ended; roomId: string; role: "dm" | "player" }) {
  const text = endedText(props.ended.kind, props.role);
  return (
    <Page>
      <Card title={text.title}>
        <p style={{ margin: 0 }}>{text.body}</p>
        {text.rejoin ? (
          <Button variant={text.dmLink ? "secondary" : "primary"} onClick={() => location.assign(roomPath(props.roomId))}>
            {text.rejoin}
          </Button>
        ) : null}
        <Button onClick={() => location.assign("/")}>Home</Button>
      </Card>
      {text.dmLink ? <DmLinkEntry /> : null}
    </Page>
  );
}

/** A tool's icon in the toolbar, a little larger than a button's 20 px, as the tools' own shapes are drawn. */
const TOOL_ICON_PX = 22;

function ToolIcon(props: { tool: ToolDef }) {
  const { icon } = props.tool;
  if ("glyph" in icon) return <span aria-hidden style={{ fontSize: theme.font.heading, fontWeight: theme.weight.bold, lineHeight: 1 }}>{icon.glyph}</span>;
  if ("icon" in icon) return <Icon name={icon.icon} size={TOOL_ICON_PX} />;
  return (
    <svg aria-hidden viewBox={`0 0 ${icon.box ?? 24} ${icon.box ?? 24}`} width={TOOL_ICON_PX} height={TOOL_ICON_PX} style={{ display: "block" }}>
      <path d={icon.path} fill="currentColor" />
    </svg>
  );
}

/** What the options' popovers read as they open and when the layout moves, kept current by RoomPage (7.3). */
type PopoverInputs = { mapWidth: number; height: number; safe: { top: number; right: number; bottom: number; left: number }; sideShown: boolean; top: number; lasting: number | null };

/**
 * The active tool's options (docs/design-v1-tool-options.md 4, 6 and
 * 10.1): one row of controls and the line above it, in one element,
 * `role="toolbar"` named "<tool> options", before the toolbar in the
 * page's order, so Tab meets the options before the tools, and never
 * remounted by a rotation or a change of arrangement, so a draft, a
 * half-typed field and focus survive turning the phone.
 *
 * Stacked, on a phone, it spans the map on the toolbar: 44 px controls,
 * 4 px padding and a 1 px top edge, 53 px in all. Floating, from 900 px
 * up, it stands 8 px right of the left safe area and 6 px above the
 * toolbar, as wide as its controls up to 640 px. It gives the strip inside
 * (features/measure/controls.tsx OptionsStrip) the room its row may use,
 * where its line floats, and where its popovers stand, and it rises to
 * `theme.z.popover` while one is open, and where it would stand above the
 * last lasting notice's foot, over that notice (7.6, 8).
 */
function ToolOptions(props: {
  ref?: Ref<HTMLDivElement>;
  id: string;
  tool: ToolDef;
  role: "dm" | "player";
  zoom: number;
  place: OptionsPlace;
  /** Where the element stands in the toolbar's row, in from the map's safe edges (pages/optionsLayout.ts mergedEdges). */
  edges: { left: number; right: number };
  wide: boolean;
  mapWidth: number;
  safe: { top: number; right: number; bottom: number; left: number };
  overNotice: boolean;
  /** The options are tucked (5.4): the row hides, and the line too unless a task is under way. */
  tucked: boolean;
  /** Setup or Tools stands where the line floats, or the top bars do, where the map is shorter than the line. */
  covered: boolean;
  onShow(): void;
  popover: RefObject<PopoverInputs>;
  toolbar: RefObject<HTMLElement | null>;
  /** How much of the layout's foot the on-screen keyboard hides, in the options' own px, or null with none: each arrangement stands on it as it stands on the toolbar or the screen's foot. */
  keyboard: number | null;
}) {
  const Options = props.tool.Options;
  const own = useRef<HTMLDivElement | null>(null);
  const { ref: outer } = props;
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      own.current = el;
      if (typeof outer === "function") return outer(el);
      if (outer) outer.current = el;
      return undefined;
    },
    [outer],
  );
  const [raised, setRaised] = useState(false);
  // A roll card at a narrow screen's foot stands over these popovers (7.6), so it folds while one is open (features/rolls/PlayerRolls.tsx).
  const dockStore = useScoped(barDockSlot);
  useLayoutEffect(() => {
    if (dockStore.getState().toolPopover !== raised) dockStore.setState({ toolPopover: raised });
  }, [dockStore, raised]);
  useLayoutEffect(() => () => dockStore.setState({ toolPopover: false }), [dockStore]);
  const [description, setDescription] = useState<string | null>(null);
  // A state with no row (6.6) draws only its line, 6 px above the toolbar, in every arrangement. Stacked, the map keeps its 53 px inset, so nothing moves, but no empty band is drawn there (LP7-CHROME-4, docs/design-v1-dice-ui.md 3.1).
  const [rowless, setRowless] = useState(false);
  const descriptionId = useId();
  const { arrangement, room } = props.place;
  const inRow = inToolbarRow(arrangement);
  const boxless = props.tucked || rowless;
  // On a computer the toolbar has no fill, so a row in its row takes the floating row's box (4.2), 3 px in from the toolbar's edges.
  const boxed = inRow && props.wide;
  const lineMax = props.mapWidth - props.safe.left - props.safe.right - 2 * theme.space(2);
  const lift = boxed ? (TOOLBAR - theme.layout.options.row - theme.line.border) / 2 : 0;
  const line =
    arrangement === "floating" && !boxless
      ? { left: -theme.line.border, maxWidth: lineMax, lift: 0 }
      : inRow && !boxless
        ? // 6 px above the toolbar, from the left safe area plus 8 px (4.2).
          { left: theme.space(2) - props.edges.left - theme.line.border, maxWidth: lineMax, lift }
        : { left: props.safe.left + theme.space(2), maxWidth: lineMax, lift: 0 };
  const popoverInputs = props.popover;
  const { toolbar, onShow, tucked, covered } = props;
  const lifted = props.keyboard !== null;
  const frame = useMemo<OptionsFrame>(() => {
    const popover = () => {
      const p = popoverInputs.current;
      return toolPopoverFrame({ mapWidth: p.mapWidth, height: p.height, safe: { ...p.safe, right: p.sideShown ? 0 : p.safe.right }, top: p.top, lasting: p.lasting });
    };
    return {
      room,
      arrangement,
      popover: {
        bound: () => popover().bound,
        rise: () => popover().rise,
        // 6 px above the row's top, or the toolbar's in its row, whatever the control's place inside them (7.3).
        gap: (anchor: Rect) => {
          // Lifted onto the keyboard, the row in the toolbar's row has left the toolbar under it.
          const edge = inRow && !lifted ? toolbar.current : own.current;
          if (!edge) return theme.layout.popover.gap;
          return anchor.top - edge.getBoundingClientRect().top / uiScaleNow() + theme.layout.popover.gap;
        },
      },
      line,
      tucked,
      covered,
      show: onShow,
      raise: setRaised,
      task: () => {},
      rowless: setRowless,
      describe: setDescription,
      toolButton: () => toolbar.current?.querySelector<HTMLElement>('button[data-active="true"]') ?? null,
    };
    // `line` is rebuilt each render from these numbers.
  }, [room, arrangement, inRow, lifted, line.left, line.maxWidth, line.lift, popoverInputs, toolbar, tucked, covered, onShow]);
  if (!Options) return null;
  // With the keyboard up, each arrangement's foot stands on it as far up as it stands on the toolbar or the screen's foot now.
  const onKeys = (normal: string, above: number) => (props.keyboard === null ? normal : `max(${normal}, ${props.keyboard + above}px)`);
  const place: CSSProperties = boxless
    ? // Tucked, or with no row, the options take no height: only the line, or the "options hidden" pill, stands above the toolbar (5.4, 6.6).
      { left: 0, right: 0, bottom: onKeys(`calc(${theme.safe.bottom} + ${TOOLBAR}px)`, 0), height: 0, background: "transparent" }
    : arrangement === "floating"
      ? {
          left: `calc(${theme.safe.left} + ${theme.space(2)}px)`,
          right: "auto",
          bottom: onKeys(`calc(${theme.safe.bottom} + ${TOOLBAR + theme.layout.popover.gap}px)`, theme.layout.popover.gap),
          maxWidth: FLOAT_MAX,
          padding: `${theme.space(1)}px ${theme.space(2)}px`,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          borderRadius: theme.radius.md,
        }
      : boxed
        ? {
            left: `calc(${theme.safe.left} + ${props.edges.left}px)`,
            // Its own padding and border at the right take the 8 px before Panels, so its controls keep the room.
            right: `calc(${theme.safe.mapRight} + ${props.edges.right - theme.space(2) - theme.line.border}px)`,
            bottom: onKeys(`calc(${theme.safe.bottom} + ${lift}px)`, lift),
            padding: `${theme.space(1)}px ${theme.space(2)}px`,
            border: `${theme.line.border}px solid ${theme.color.border}`,
            borderRadius: theme.radius.md,
          }
        : inRow
          ? {
              // In the toolbar's row, over its backdrop, from 6 px after the last tool, its 1 px divider and 8 px padding before its first control.
              left: `calc(${theme.safe.left} + ${props.edges.left}px)`,
              right: `calc(${theme.safe.mapRight} + ${props.edges.right}px)`,
              bottom: onKeys(theme.safe.bottom, 0),
              height: TOOLBAR,
              paddingLeft: theme.space(2),
              borderLeft: `${theme.line.border}px solid ${theme.color.border}`,
              // Over the keyboard the toolbar's fill stays under it, so the row takes that fill itself.
              background: lifted ? theme.color.overlay : "transparent",
            }
          : {
              left: 0,
              right: 0,
              bottom: onKeys(`calc(${theme.safe.bottom} + ${TOOLBAR}px)`, 0),
              minHeight: theme.layout.options.row,
              padding: `${theme.space(1)}px calc(${theme.safe.mapRight} + ${theme.space(2)}px) ${theme.space(1)}px calc(${theme.safe.left} + ${theme.space(2)}px)`,
              borderTop: `${theme.line.border}px solid ${theme.color.border}`,
            };
  return (
    <div
      ref={ref}
      id={props.id}
      role="toolbar"
      aria-label={`${props.tool.label} options`}
      aria-describedby={description ? descriptionId : undefined}
      data-rvtt-arrangement={arrangement}
      data-rvtt-tucked={tucked ? "" : undefined}
      {...smallUi(props.zoom)}
      style={{
        ...chromeZoom(props.zoom),
        position: "absolute",
        zIndex: raised || props.overNotice ? theme.z.popover : theme.z.options,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        background: theme.color.overlay,
        ...place,
      }}
    >
      <OptionsFrameContext.Provider value={frame}>
        <LoadBoundary key={props.tool.id} fallback={(f) => <RoomLoadNotice {...f} subject="These options" verb="load" compact reopen={{ tool: props.tool.id }} />}>
          <Options role={props.role} />
        </LoadBoundary>
      </OptionsFrameContext.Provider>
      {description ? (
        <span id={descriptionId} hidden>
          {description}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The phone toolbar's fill and top edge, drawn under the tool's options
 * rather than by the toolbar itself (docs/design-v1-tool-options.md 10.1),
 * so a row standing in the toolbar's own row is never painted under it.
 * It takes the taps between the toolbar's buttons, as the toolbar did, so
 * none reaches the map.
 */
function ToolbarBackdrop(props: { zoom: number }) {
  return (
    <div
      aria-hidden
      data-rvtt-backdrop=""
      style={{
        ...chromeZoom(props.zoom),
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: theme.z.options - 1,
        height: `calc(${theme.safe.bottom} + ${TOOLBAR}px)`,
        boxSizing: "border-box",
        background: theme.color.overlay,
        borderTop: `${theme.line.border}px solid ${theme.color.border}`,
      }}
    />
  );
}

/** The descriptions a toolbar button carries for tuck and its menus (docs/design-v1-tool-options.md 11). */
const TOOLBAR_LINES = {
  shown: "Press again to hide its options.",
  hidden: "Its options are hidden. Press again to show them.",
  menuTucked: "Its options are hidden. Pick it again in the menu to show them.",
  again: "In use. Tap again for all tools.",
  pairIdle: "Tap it, then again for all tools.",
  tileShown: "Pick again to hide its options.",
  tileHidden: "Its options are hidden. Pick again to show them.",
} as const;

/**
 * The toolbar (docs/design-v1-tool-options.md 5): the role's tools, and
 * Panels at its right end on a phone.
 *
 * - On a phone, the DM's setup tools stand behind Setup, a menu of tiles,
 *   so seven buttons and Panels fit a 390 px phone without scrolling. The
 *   buttons share the row, each from 44 px up to 68 px, and scroll where
 *   even 44 px each do not fit (components/ScrollStrip.tsx).
 * - From 900 px up every tool shows, with a divider before the setup tools.
 * - Where the options share the toolbar's row (the merged and pair
 *   arrangements), every button is 56 px with its name, or 44 px icons
 *   alone for a mouse, and the tools end at the last one. In the pair
 *   only Select and the last tool show, and the last tool's second tap
 *   opens Tools, every tool as tiles.
 * - A tap on the active tool's own button tucks its options, and the next
 *   brings them back, marked by an up chevron. Through Setup or Tools,
 *   picking the active tool's tile does the same.
 *
 * Keys pick every tool directly whatever the toolbar shows
 * (state/shortcuts.ts reads the role's tools, not these buttons). Its fill
 * is the backdrop's, under the options (ToolbarBackdrop), so only its
 * buttons take taps.
 */
function Toolbar(props: {
  ref?: Ref<HTMLElement>;
  zoom: number;
  wide: boolean;
  tools: ToolDef[];
  tool: string;
  arrangement: Arrangement;
  /** The pair's second button (state/toolbar.ts). */
  last: string;
  /** The active tool's options are tucked. */
  tucked: boolean;
  /** The options element, which the active tool's button controls, while it is drawn. */
  optionsId: string | undefined;
  /** A press on a tool's own button: picks it, or on the active tool tucks or shows its options. */
  onPress(id: string): void;
  /** A pick of a tile in Setup or Tools. */
  onPick(id: string): void;
  /** Setup or Tools opened or closed: the toolbar rises over the notices and the line hides under it (7.6, 8). */
  onMenu(open: boolean): void;
  popover: RefObject<PopoverInputs>;
  toolbar: RefObject<HTMLElement | null>;
  panelsOpen: boolean;
  onPanels(): void;
  /** Unread messages in the Log and unread journal pages, and a PDF upload waiting, which sit behind the Panels button on phones. */
  unread: number;
  /** What the count says to a screen reader, such as "2 unread, 1 upload waiting". */
  unreadLabel: string;
  panelsRef: Ref<HTMLButtonElement>;
  /** A phone's hidden sheet, which Panels shows again: its button says so. */
  hiddenSheet: string | null;
  /** The side panel is hidden from 900 px up: Panels shows at the toolbar's right end, which brings it back (docs/design-v1-layout-hierarchy.md 4.1). */
  sideHidden: boolean;
  sidePanelId: string;
  onShowSide(): void;
  /**
   * Each tool's short name under its icon: on a phone, and on any touch
   * screen from 900 px up (docs/design-v1-layout-hierarchy.md M10), which
   * has no hover to show a tool's name. A mouse keeps the icons alone, named
   * on hover and to screen readers.
   */
  named: boolean;
}) {
  const { wide, tools, arrangement, tucked } = props;
  const ids = useId();
  const setup = usePopover({ kind: "menu" });
  const all = usePopover({ kind: "menu" });
  const menuOpen = setup.open || all.open;
  const { onMenu } = props;
  useLayoutEffect(() => {
    onMenu(menuOpen);
  }, [onMenu, menuOpen]);
  // Any change of tool closes them, whatever made it: a key, a tile, a panel.
  const closeSetup = setup.close;
  const closeAll = all.close;
  useLayoutEffect(() => {
    closeSetup("state");
    closeAll("state");
  }, [props.tool, closeSetup, closeAll]);

  const inRow = inToolbarRow(arrangement);
  const setupTools = tools.filter((t) => SETUP_TOOLS.has(t.id));
  const layout = toolbarButtons(tools, wide);
  const grouped = layout.ids.includes(SETUP_BUTTON);
  const lastTool = tools.find((t) => t.id === props.last) ?? tools.find((t) => t.id !== "select");
  const shown = arrangement === "pair" ? tools.filter((t) => t.id === "select" || t.id === lastTool?.id) : tools.filter((t) => layout.ids.includes(t.id));
  const divider = arrangement === "pair" ? null : layout.divider;
  const activeSetup = setupTools.find((t) => t.id === props.tool) ?? null;
  // The width of a button: fixed where the options share the row, shared and capped on a phone's own row, as before from 900 px up.
  const size: ButtonSize = inRow ? { fixed: props.named ? TOOL_BUTTON_NAMED : TOOL_BUTTON_ICON } : wide ? "floating" : "shared";
  const line = (key: keyof typeof TOOLBAR_LINES) => `${ids}-${key}`;
  const frame = useMemo(() => toolbarPopoverFrame(props.popover, props.toolbar), [props.popover, props.toolbar]);
  // Each tool's key in its tooltip, as this device has it (the shortcut sheet may have changed it). None where the tool has no key: none in the table, or its default taken by another tool's change (keyBindings.ts UNBOUND).
  const hints = useKeyHints();
  const hint = (t: ToolDef) => hints(`tool:${t.id}`);
  const panelsKey = useKeyHint("sidePanel");

  const tileKeys = (t: ToolDef) => {
    const keys = hint(t);
    return keys ? { keys: { title: withKey(t.label, keys), aria: keys.aria } } : null;
  };
  const tile = (t: ToolDef): MenuItem => ({
    id: t.id,
    title: t.label,
    checked: t.id === props.tool,
    glyph: <ToolIcon tool={t} />,
    ...tileKeys(t),
    ...(t.id === props.tool && t.id !== "select" ? { description: tucked ? TOOLBAR_LINES.tileHidden : TOOLBAR_LINES.tileShown } : {}),
  });
  const content = (t: ToolDef) => (props.named ? <Stacked icon={<ToolIcon tool={t} />} text={t.shortLabel ?? t.label} /> : <ToolIcon tool={t} />);

  const buttons = shown.map((t, i) => {
    const active = props.tool === t.id;
    const second = arrangement === "pair" && t.id !== "select";
    const opensMenu = second && active;
    const own = active && t.id !== "select" && !opensMenu;
    return (
      // The pair's second button keeps its element as its tool changes, so focus stays on it after a pick in Tools.
      <Fragment key={second ? "pair-second" : t.id}>
        {/* The play tools, then the setup tools past a divider (docs/design-v1-layout-hierarchy.md M1): a line in a phone's strip, a 12 px gap between the floating buttons. */}
        {i === divider ? <ToolbarDivider wide={wide && !inRow} /> : null}
        <ToolButton
          label={t.label}
          keys={hint(t)}
          active={active}
          onClick={() => props.onPress(t.id)}
          popup={opensMenu ? all : undefined}
          floating={wide}
          iconOnly
          alone={!props.named}
          size={size}
          // The pair's second button carries its caret whether or not its tool is active, so the other tools behind it always show (5.1). While active, its menu takes the place of a pressed state, so its description says it is in use.
          mark={second ? (active && tucked ? "tucked" : "caret") : own && tucked ? "tucked" : null}
          controls={active ? props.optionsId : undefined}
          describedBy={own ? line(tucked ? "hidden" : "shown") : opensMenu ? [line("again"), tucked ? line("menuTucked") : ""].filter(Boolean).join(" ") : second ? line("pairIdle") : undefined}
        >
          {content(t)}
        </ToolButton>
      </Fragment>
    );
  });
  if (grouped && arrangement !== "pair") {
    const shownTool = activeSetup;
    buttons.push(
      <ToolbarDivider key="divider" wide={wide && !inRow} />,
      <ToolButton
        key="setup"
        label={shownTool ? `Setup tools: ${shownTool.label}` : "Setup tools"}
        active={shownTool !== null}
        onClick={() => {}}
        popup={setup}
        floating={wide}
        iconOnly
        size={size}
        mark={shownTool && tucked ? "tucked" : "caret"}
        controls={shownTool ? props.optionsId : undefined}
        describedBy={shownTool && tucked ? line("menuTucked") : undefined}
      >
        {shownTool ? content(shownTool) : <Stacked icon={<Icon name="sliders" size="lg" />} text="Setup" />}
      </ToolButton>,
    );
  }

  const panelsIcon = <Icon name="panels" size={TOOL_ICON_PX} />;
  const menuPopover = (handle: PopoverHandle, label: string, sections: readonly MenuSection[]) => (
    // The nav takes no taps of its own, so its menus take theirs back. No box of its own, so it takes no gap in the row.
    <div style={{ display: "contents", pointerEvents: "auto" }}>
      <Popover handle={handle} side="above" bound={frame.bound} rise={frame.rise} gap={frame.gap} minHeight={POPOVER_MIN} title={label}>
        <Menu label={label} tiles sections={sections} onPick={props.onPick} />
      </Popover>
    </div>
  );
  return (
    <nav
      ref={props.ref}
      aria-label="Tools"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: menuOpen ? theme.z.popover : theme.z.bars,
        display: "flex",
        alignItems: "center",
        gap: theme.space(1),
        height: `calc(${theme.safe.bottom} + ${TOOLBAR}px)`,
        padding: `0 calc(${theme.safe.mapRight} + ${theme.space(1)}px) ${theme.safe.bottom} calc(${theme.safe.left} + ${theme.space(1)}px)`,
        // Its fill and top edge are the backdrop's, under the tool's options (ToolbarBackdrop). Only its buttons take taps.
        background: "transparent",
        borderTop: wide ? "none" : `${theme.line.border}px solid transparent`,
        pointerEvents: "none",
        ...chromeZoom(props.zoom),
      }}
    >
      {inRow ? (
        // Fixed widths, so the row beside them is known before paint (pages/optionsLayout.ts mergedEdges).
        <div data-rvtt-tools="" style={{ flex: "none", display: "flex", alignItems: "center", gap: TOOL_GAP, height: "100%" }}>
          {buttons}
        </div>
      ) : (
        <ScrollStrip active={props.tool} gap={wide ? theme.space(1) : theme.space(0.5)} style={{ flex: "1 1 auto", height: "100%", pointerEvents: wide ? "none" : "auto" }}>
          {buttons}
        </ScrollStrip>
      )}
      {grouped && arrangement !== "pair" ? menuPopover(setup, "Setup tools", [{ key: "setup", items: setupTools.map(tile) }]) : null}
      {arrangement === "pair"
        ? menuPopover(all, "Tools", [
            { key: "play", items: tools.filter((t) => !SETUP_TOOLS.has(t.id)).map(tile) },
            ...(setupTools.length > 0 ? [{ key: "setup", separator: true, items: setupTools.map(tile) }] : []),
          ])
        : null}
      {inRow ? <div style={{ flex: "1 1 auto" }} /> : null}
      {wide ? (
        props.sideHidden ? (
          <div style={{ flex: "none", display: "flex", alignItems: "center", height: "100%" }}>
            <ToolButton ref={props.panelsRef} label="Panels" keys={panelsKey} active={false} expanded={false} controls={props.sidePanelId} onClick={props.onShowSide} floating iconOnly alone={!props.named} size={inRow ? size : "floating"}>
              {props.named ? <Stacked icon={panelsIcon} text="Panels" /> : panelsIcon}
              <Badge count={props.unread} corner label={props.unreadLabel} />
            </ToolButton>
          </div>
        ) : null
      ) : (
        <div style={{ flex: "none", display: "flex", alignItems: "center", height: "100%", paddingLeft: theme.space(1), borderLeft: `${theme.line.border}px solid ${theme.color.border}`, pointerEvents: "auto" }}>
          <ToolButton ref={props.panelsRef} label="Panels" active={props.panelsOpen} onClick={props.onPanels} describedBy={props.hiddenSheet ? `${ids}-sheet` : undefined} size={inRow ? size : "panels"}>
            <Stacked icon={panelsIcon} text="Panels" />
            <Badge count={props.unread} corner label={props.unreadLabel} />
          </ToolButton>
        </div>
      )}
      {/* What the buttons' descriptions say, hidden. */}
      <span hidden>
        <span id={line("shown")}>{TOOLBAR_LINES.shown}</span>
        <span id={line("hidden")}>{TOOLBAR_LINES.hidden}</span>
        <span id={line("menuTucked")}>{TOOLBAR_LINES.menuTucked}</span>
        <span id={line("again")}>{TOOLBAR_LINES.again}</span>
        <span id={line("pairIdle")}>{TOOLBAR_LINES.pairIdle}</span>
        {props.hiddenSheet ? <span id={`${ids}-sheet`}>{`Shows ${props.hiddenSheet} again.`}</span> : null}
      </span>
    </nav>
  );
}

/** Where Setup and Tools stand (7.3): above the toolbar by 6 px, over a stacked row, within the map less the safe areas and under the top bars. */
function toolbarPopoverFrame(inputs: RefObject<PopoverInputs>, toolbar: RefObject<HTMLElement | null>) {
  const frame = () => {
    const p = inputs.current;
    return toolPopoverFrame({ mapWidth: p.mapWidth, height: p.height, safe: { ...p.safe, right: p.sideShown ? 0 : p.safe.right }, top: p.top, lasting: p.lasting });
  };
  return {
    bound: () => frame().bound,
    rise: () => frame().rise,
    gap: (anchor: Rect) => {
      const nav = toolbar.current;
      return nav ? anchor.top - nav.getBoundingClientRect().top / uiScaleNow() + theme.layout.popover.gap : theme.layout.popover.gap;
    },
  };
}

function ToolbarDivider(props: { wide: boolean }) {
  return <span aria-hidden data-rvtt-divider="" style={props.wide ? { flex: "none", width: theme.space(1) } : { flex: "none", width: theme.line.border, height: 32, background: theme.color.border }} />;
}

/** A tile's `data-opener` in the list of panels, which "All panels" finds again. */
function panelTile(panelId: string): string {
  return `panel-${panelId}`;
}

/**
 * Every panel the role has, as large buttons, for the phone's Panels sheet:
 * card rows (components/Row.tsx), the open panel in the pressed look.
 * `grouped` labels a DM's groups, "In play" and "Prepare", with Menu after
 * a plain divider, so a DM finds a panel for preparing without reading the
 * ones for play. The labels are items that span the grid, so it stays one
 * list named "Panels" and its tiles keep their names.
 */
function PanelPicker(props: { panels: PanelDef[]; current: string; badges: Record<string, number>; badgeLabels: Record<string, string>; grouped: boolean; onPick(id: string): void }) {
  return (
    <ul
      aria-label="Panels"
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
        gap: theme.space(2),
      }}
    >
      {panelSections(props.panels, props.grouped).map((section, i) => (
        <Fragment key={section.key}>
          {section.label ? (
            <li style={{ gridColumn: "1 / -1", paddingTop: i === 0 ? 0 : theme.space(2) }}>
              <SectionLabel>{section.label}</SectionLabel>
            </li>
          ) : section.line ? (
            <li aria-hidden style={{ gridColumn: "1 / -1", height: theme.line.border, margin: `${theme.space(1)}px 0`, background: theme.color.border }} />
          ) : null}
          {section.panels.map((p) => {
            const current = p.id === props.current;
            const count = props.badges[p.id] ?? 0;
            return (
              <li key={p.id}>
                <Row
                  opener={panelTile(p.id)}
                  leading={<Icon name={p.icon} size="md" style={{ color: current ? theme.color.accent : theme.color.textMuted }} />}
                  title={p.title}
                  trailing={count > 0 ? <Badge count={count} label={props.badgeLabels[p.id]} /> : undefined}
                  chosen={current}
                  onClick={() => props.onPick(p.id)}
                  style={{ minHeight: 52, ...(current ? { color: theme.color.accent } : null) }}
                />
              </li>
            );
          })}
        </Fragment>
      ))}
    </ul>
  );
}

/**
 * How wide a toolbar button is. On a phone's own row the buttons share it,
 * from 44 px up to 68 px with 4 px of padding inside, so seven buttons and
 * Panels fit a 390 px phone (5.1), with Panels at 44 px there. Where the
 * options share the toolbar's row they take a fixed width (5.3). A
 * computer's floating buttons stay as before.
 */
type ButtonSize = "shared" | "panels" | "floating" | { fixed: number };

/** The most a shared toolbar button grows to on a phone. */
const SHARED_MAX = 68;

function sizeStyle(size: ButtonSize | undefined): CSSProperties {
  if (size === "shared") return { flex: "1 1 0", minWidth: theme.touch, maxWidth: SHARED_MAX, padding: `0 ${theme.space(1)}px` };
  // Panels' word fills its 44 px with no padding of its own, so seven tools and Panels fit a 390 px phone to the pixel.
  if (size === "panels") return { flex: "none", minWidth: theme.touch, padding: 0 };
  if (typeof size === "object") return { flex: "none", width: size.fixed, minWidth: size.fixed, padding: 0 };
  return { flex: "none", minWidth: theme.touch, padding: `0 ${theme.space(2)}px` };
}

function ToolButton(props: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  /** Its key (state/shortcuts.ts useKeyHint), which the tooltip adds to its name, "Fog (F)", and `aria-keyshortcuts` holds. */
  keys?: KeyHint | null;
  /**
   * Its icon stands alone, with no name under it (a mouse's toolbar), so
   * its name shows as the shared tooltip on hover, keyboard focus and a
   * long press, as every icon-only control's does (docs/design-v1-icons.md
   * 3.2). A tool named under its icon keeps the native title.
   */
  alone?: boolean;
  active: boolean;
  onClick(): void;
  floating?: boolean;
  iconOnly?: boolean;
  /** A button that shows or hides something it names (`controls`), which says so in place of a pressed state. */
  expanded?: boolean;
  controls?: string;
  describedBy?: string;
  /** A menu it opens (Setup, Tools), whose base gives it `aria-haspopup`, `aria-expanded` and its keys, in place of a pressed state. */
  popup?: PopoverHandle;
  size?: ButtonSize;
  /** In its top right corner: a caret for a menu it opens, an up chevron while the options are tucked (5.1, 5.4). */
  mark?: "caret" | "tucked" | null;
  children: ReactNode;
}) {
  const popup = props.popup;
  const { ref: outer } = props;
  const anchorRef = popup?.anchorProps.ref;
  const ref = useCallback(
    (el: HTMLButtonElement | null) => {
      anchorRef?.(el);
      if (typeof outer === "function") return outer(el);
      if (outer) outer.current = el;
      return undefined;
    },
    [outer, anchorRef],
  );
  const expanded = popup ? undefined : props.expanded;
  const name = withKey(props.label, props.keys ?? null);
  const tooltip = useTooltip(name, { describes: addsWords(name, props.label) });
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-active={props.active}
        aria-pressed={expanded === undefined && !popup ? props.active : undefined}
        aria-expanded={expanded}
        aria-haspopup={popup?.anchorProps["aria-haspopup"]}
        {...(popup ? { "aria-expanded": popup.anchorProps["aria-expanded"] } : null)}
        aria-controls={popup?.open ? popup.anchorProps["aria-controls"] : props.controls}
        aria-label={props.iconOnly ? props.label : undefined}
        aria-keyshortcuts={props.keys?.aria}
        title={props.alone ? undefined : name}
        {...(props.alone ? tooltip.anchor({ "aria-describedby": props.describedBy }) : { "aria-describedby": props.describedBy })}
        onClick={popup ? popup.anchorProps.onClick : props.onClick}
        onKeyDown={popup?.anchorProps.onKeyDown}
        style={{
          position: "relative",
          display: "grid",
          placeItems: "center",
          boxSizing: "border-box",
          minHeight: theme.touch,
          borderRadius: theme.radius.md,
          border: `${theme.line.border}px solid ${props.active || popup?.open ? theme.color.accent : props.floating ? theme.color.border : "transparent"}`,
          background: props.active || popup?.open ? theme.color.accentTint : props.floating ? theme.color.overlay : "transparent",
          color: props.active || popup?.open ? theme.color.accent : theme.color.text,
          fontSize: theme.font.small,
          fontWeight: theme.weight.strong,
          cursor: "pointer",
          pointerEvents: "auto",
          ...sizeStyle(props.size),
        }}
      >
        {props.children}
        {props.mark ? (
          <span aria-hidden style={{ position: "absolute", top: theme.space(0.5), right: theme.space(0.5), display: "grid" }}>
            <Icon name={props.mark === "tucked" ? "chevronUp" : "caret"} size={theme.icon.sm - 4} />
          </span>
        ) : null}
      </button>
      {props.alone ? tooltip.tip : null}
    </>
  );
}

/**
 * The side panel from 900 px up: the party bar, the tabs, and the open
 * panel, or two of them one above the other with a bar between
 * (docs/design-v1-split-panel.md). While a panel shows a subpage
 * (features/panels.ts usePanelHeader), a header at the top of its pane
 * names the subpage with "Back to" its panel, and focus follows it in and
 * out (useSubpageFocus). With no subpage there is no header, since the
 * chosen tab or the bar already names the panel, unless More cuts the top
 * panel's name (pages/SideTabs.tsx).
 *
 * "Hide panels" at the end of the tab row hides it (`hidden`), its content
 * kept mounted, so a half-typed message, an open journal page and each
 * panel's scroll survive (docs/design-v1-layout-hierarchy.md 4.1). The
 * tabs stand in one row at every height, the rest behind More
 * (docs/design-v1-panel-tabs.md), so the open panel keeps a body to show:
 * at 932 x 430 a DM's wrapped tabs left it 45 px.
 *
 * Under the tab row, the room holds the top pane, and with a split the
 * bar and the bottom pane. Its height alone decides whether two show and
 * how tall each pane is (pages/splitPanes.ts), measured before paint and
 * on every resize, never from what the panes hold. Too short for two, the
 * top pane fills it and the bottom one stays mounted and hidden.
 */
function SidePanel(props: {
  ref?: Ref<HTMLElement>;
  id: string;
  hidden: boolean;
  short: boolean;
  onHide(): void;
  zoom: number;
  tabs: PanelDef[];
  tab: string;
  /** The panel below the top one while a split is kept, one of `tabs` and never `tab`, else null. */
  below: string | null;
  /** Whether the room holds two, as the room's state has it (state/types.ts splitFits). */
  fits: boolean | null;
  /** The bar's stored place, in thousandths, or null for the default (pages/splitPanes.ts). */
  share: number | null;
  badges: Record<string, number>;
  /** What a tab's count says to a screen reader where it is not "N unread". */
  badgeLabels: Record<string, string>;
  grouped: boolean;
  onTab(id: string): void;
  /** A pick in the bar's "Panel below". */
  onBelow(id: string): void;
  /** "Two panels" in More's menu. */
  onSplit(on: boolean): void;
  onSwap(): void;
  onCloseBelow(): void;
  onFits(fits: boolean | null): void;
  onShare(share: number): void;
  subpages: Readonly<Record<string, PanelHeader | null>>;
  /** A panel's body, mounted in its pane. */
  panel(id: string, shown: boolean): ReactNode;
  /** What a panel is about, so it opens at its top when that changed (features/panels.ts panelSubject). */
  scrollSubject(id: string): string | null;
  /**
   * The chosen tab, which takes focus from script when Details opens the
   * token's panel: "Token, tab, selected". The tab panel itself takes no
   * focus, so a click on its blank space leaves Space free to pan the map.
   * More, while the open panel is in it.
   */
  tabRef: RefObject<HTMLButtonElement | null>;
  /** The bottom panel's name in the bar, which takes focus for it as the chosen tab does for the top one. */
  nameRef: RefObject<HTMLButtonElement | null>;
  /** The tabs have just been drawn for a new fit, in a commit of the side panel's own. */
  onTabsDrawn(): void;
}) {
  const { tabRef, nameRef } = props;
  const scope = useRoomScope();
  const store = useRoomStore();
  const latest = useRef(props);
  latest.current = props;
  // The panel is named by its chosen tab, so a screen reader entering it hears "Initiative" rather than a bare "tab panel".
  const ids = useId();
  const tabId = (id: string) => `${ids}-tab-${id}`;
  const panelId = `${ids}-panel`;
  const topPaneId = `${ids}-top`;
  const nameId = `${ids}-below`;
  const asideRef = useRef<HTMLElement | null>(null);
  const asideRefs = useCallback(
    (el: HTMLElement | null) => {
      asideRef.current = el;
      const outer = latest.current.ref;
      if (typeof outer === "function") outer(el);
      else if (outer) outer.current = el;
    },
    [],
  );
  const roomRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  const [dragTop, setDragTop] = useState<number | null>(null);
  const [cutTitle, setCutTitle] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const top = props.tabs.find((p) => p.id === props.tab);
  const below = props.below !== null ? props.tabs.find((p) => p.id === props.below) : undefined;
  const two = !props.hidden && below !== undefined && props.fits === true;

  /*
   * The room's measure (3.2): before the first paint, as the side panel
   * shows and at a new interface size, then on every resize, committed at
   * once as the tabs' fit is, so no frame paints one pane and the next
   * two. A hidden side panel measures nothing, so its room is unknown.
   */
  const measure = useCallback(() => {
    const el = roomRef.current;
    if (!el) return;
    const p = latest.current;
    if (p.hidden) {
      p.onFits(null);
      return;
    }
    const height = el.getBoundingClientRect().height / p.zoom;
    setRoom((was) => (was !== null && Math.abs(was - height) < 0.5 ? was : height));
    p.onFits(roomForTwo(height));
  }, []);
  useLayoutEffect(measure, [measure, props.hidden, props.zoom]);
  useEffect(() => {
    const el = roomRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  const sizes = splitPanes({ room: room ?? 0, share: props.share, initiative: props.tab === "tracker" ? "top" : props.below === "tracker" ? "below" : null });
  const topPx = dragTop ?? sizes.top;
  const drawn = { ...sizes, top: topPx, below: sizes.top + sizes.below - topPx };

  /*
   * A swap moves the panes and the bar with `insertBefore` (react-dom has
   * no `moveBefore` here), which drops every scroll offset in what moved
   * and, by the browser's focus fixup, the focus inside it (4.3). So the
   * room keeps every offset as it happens, weakly, so no pane it no
   * longer holds stays in memory (pages/splitPanes.ts ScrollKeep), and
   * focus is read as the swap is asked for: zustand calls a subscriber
   * inside the state change, before React commits the move, whichever
   * path asked.
   */
  const [offsets] = useState(() => new ScrollKeep());
  useEffect(() => {
    const el = roomRef.current;
    if (!el) return;
    const keep = (e: Event) => {
      if (e.target instanceof Element) offsets.record(e.target);
    };
    el.addEventListener("scroll", keep, true);
    return () => el.removeEventListener("scroll", keep, true);
  }, [offsets]);
  const swapAsked = useRef<{ before: Element | null } | null>(null);
  useEffect(
    () =>
      store.subscribe((s, prev) => {
        const a = s.local;
        const b = prev.local;
        if (b.below !== null && a.tab === b.below && a.below === b.tab) swapAsked.current = { before: document.activeElement };
      }),
    [store],
  );
  // The last element focused in the room, for a pane that hides after the browser already let its focus go. Held weakly, as the offsets are, since its pane may leave.
  const lastIn = useRef<WeakRef<Element> | null>(null);
  useEffect(() => {
    const onIn = (e: FocusEvent) => {
      lastIn.current = e.target instanceof Element && roomRef.current?.contains(e.target) ? new WeakRef(e.target) : null;
    };
    document.addEventListener("focusin", onIn);
    return () => document.removeEventListener("focusin", onIn);
  }, []);

  /*
   * After each commit, before paint: the offsets and the focus a swap
   * took, and a pane that hid with focus inside it, whose focus goes to
   * the chosen tab (9.2). A request that focuses something itself, as
   * Stat block does at its block, runs after this and wins.
   */
  const wasTwo = useRef(two);
  useLayoutEffect(() => {
    const roomEl = roomRef.current;
    const hadTwo = wasTwo.current;
    wasTwo.current = two;
    if (!roomEl) return;
    const hiddenHere = (el: Element | null) => {
      const hidden = el?.closest("[hidden]");
      return hidden != null && hidden !== roomEl && roomEl.contains(hidden);
    };
    let lost = false;
    const ask = swapAsked.current;
    if (ask) {
      swapAsked.current = null;
      offsets.restore(roomEl.querySelectorAll("*"));
      const back = swapFocus(ask.before, document.activeElement, roomEl, document.body);
      if (back instanceof HTMLElement) {
        if (hiddenHere(back)) lost = true;
        else back.focus({ preventScroll: true });
      }
    }
    if (props.hidden) return;
    const active = document.activeElement;
    if (hiddenHere(active)) lost = true;
    if (hadTwo && !two && (active === null || active === document.body) && hiddenHere(lastIn.current?.deref() ?? null)) lost = true;
    if (lost) tabRef.current?.focus({ preventScroll: true });
  });

  // The status says what moved while focus stays put (9.3): the split opening, and any swap. A close and a new bottom panel say nothing, since focus moves to what names them.
  const pairWas = useRef({ tab: props.tab, below: props.below });
  useLayoutEffect(() => {
    const was = pairWas.current;
    if (was.tab === props.tab && was.below === props.below) return;
    pairWas.current = { tab: props.tab, below: props.below };
    const title = (id: string | null) => props.tabs.find((p) => p.id === id)?.title ?? "";
    if (props.below !== null && was.below === null) setStatus(`Two panels, ${title(props.below)} below`);
    else if (props.below !== null && was.tab === props.below && was.below === props.tab) setStatus(`${title(props.tab)} on top, ${title(props.below)} below`);
    else setStatus("");
  });

  // O goes between the two (9.4): from the side panel above the bar to the bottom panel's name, and from anywhere else to the chosen tab.
  const splitKeys = scope.get(splitKeysSlot);
  useEffect(() => {
    if (!two) return;
    splitKeys.other = () => {
      const active = document.activeElement;
      const bar = barRef.current;
      const above = active !== null && bar !== null && !bar.contains(active) && asideRef.current?.contains(active) === true && (bar.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
      (above ? nameRef.current : tabRef.current)?.focus({ preventScroll: true });
    };
    return () => {
      splitKeys.other = null;
    };
  }, [two, splitKeys, nameRef, tabRef]);

  const topPane = top ? (
    <SidePane
      key={top.id}
      panelId={top.id}
      subject={props.scrollSubject(top.id)}
      rootId={topPaneId}
      style={two ? { flex: "none", height: drawn.top } : { flex: "1 1 0" }}
      subpage={props.subpages[top.id] ?? null}
      cutTitle={cutTitle}
      fallback={tabRef}
      body={{ id: panelId, role: "tabpanel", "aria-labelledby": tabId(top.id) }}
    >
      {props.panel(top.id, !props.hidden)}
    </SidePane>
  ) : null;
  const panes = below
    ? [
        topPane,
        <SplitBar
          key={"\u0000bar"}
          hidden={!two}
          zoom={props.zoom}
          panels={props.tabs}
          grouped={props.grouped}
          top={top ?? below}
          below={below}
          badges={props.badges}
          badgeLabels={props.badgeLabels}
          sizes={drawn}
          topPaneId={topPaneId}
          nameId={nameId}
          nameRef={nameRef}
          barRef={barRef}
          onPick={props.onBelow}
          onSwap={props.onSwap}
          onClose={props.onCloseBelow}
          onDrag={setDragTop}
          onPlace={(px) => {
            if (room !== null) props.onShare(shareOf(px, room));
          }}
        />,
        <SidePane
          key={below.id}
          panelId={below.id}
          subject={props.scrollSubject(below.id)}
          hidden={!two}
          style={{ flex: "1 1 0" }}
          subpage={props.subpages[below.id] ?? null}
          cutTitle={null}
          fallback={nameRef}
          root={{ role: "group", "aria-labelledby": nameId }}
          body={{}}
        >
          {props.panel(below.id, two)}
        </SidePane>,
      ]
    : [topPane];

  return (
    <aside
      ref={asideRefs}
      id={props.id}
      hidden={props.hidden}
      {...smallUi(props.zoom)}
      style={{
        ...chromeZoom(props.zoom),
        width: theme.layout.sidePanelWidth,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        background: theme.color.surface,
        borderLeft: `${theme.line.border}px solid ${theme.color.border}`,
        paddingTop: theme.safe.top,
        paddingRight: theme.safe.right,
        paddingBottom: theme.safe.bottom,
      }}
    >
      <PartyDock short={props.short} />
      <SideTabs
        hidden={props.hidden}
        zoom={props.zoom}
        tabs={props.tabs}
        tab={props.tab}
        badges={props.badges}
        badgeLabels={props.badgeLabels}
        grouped={props.grouped}
        onTab={props.onTab}
        onHide={props.onHide}
        split={{ on: below !== undefined, fits: props.fits, below: two ? (below?.id ?? null) : null, onToggle: () => props.onSplit(below === undefined) }}
        onCutTitle={setCutTitle}
        tabRef={tabRef}
        onTabsDrawn={props.onTabsDrawn}
        tabId={tabId}
        panelId={panelId}
      />
      {/* The room: its height alone sets the panes', so nothing a panel shows ever moves the bar. */}
      <div ref={roomRef} data-split-room="" style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {panes}
      </div>
      <div role="status" style={VISUALLY_HIDDEN}>
        {status}
      </div>
    </aside>
  );
}

/**
 * One pane of the side panel: a header slot, for a subpage's header or
 * the name More cut, above its own scrolling body, so a sticky header or
 * footer inside a panel meets its own pane's edges (`data-pane-body`).
 * Each runs its own subpage focus, its fallback the name of the pane: the
 * chosen tab for the top one, the bar's name for the bottom one.
 */
function SidePane(props: {
  /** The panel it shows, whose scroll it keeps as the panel leaves and puts back as it shows again. */
  panelId: string;
  /** What the panel is about: a place about another subject is not put back. */
  subject: string | null;
  rootId?: string;
  hidden?: boolean;
  style: CSSProperties;
  subpage: PanelHeader | null;
  cutTitle: string | null;
  fallback: RefObject<HTMLElement | null>;
  root?: { role?: string; "aria-labelledby"?: string };
  body: { id?: string; role?: string; "aria-labelledby"?: string };
  children: ReactNode;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Where Back lands when the row that opened the subpage is gone (a page deleted from inside it): the header goes with the subpage, and the pane's name stays.
  useSubpageFocus(props.subpage, { title: titleRef, body: bodyRef, root: rootRef, fallback: props.fallback });
  usePanelScroll(props.panelId, props.subpage, bodyRef, props.subject);
  const header = props.subpage ? (
    <SheetHeader compact title={props.subpage.title} back={subpageBack(props.subpage)} titleRef={titleRef} />
  ) : props.cutTitle ? (
    // On a touch pointer, a name the tab row does not show, an icon-only tab's or one More cuts, is named in full above the panel (docs/design-v1-panel-tabs.md 3.8, docs/design-v1-icons-2.md 3.1). A subpage's header names it in its Back instead.
    <SheetHeader compact title={props.cutTitle} />
  ) : null;
  return (
    <div ref={rootRef} id={props.rootId} hidden={props.hidden} {...props.root} style={{ display: "flex", flexDirection: "column", minHeight: 0, ...props.style }}>
      {header ? <div style={{ flex: "none", borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>{header}</div> : null}
      <div
        ref={bodyRef}
        {...props.body}
        data-pane=""
        data-pane-body=""
        style={{ ...paneBodyPadding(theme.space(4), theme.space(4), theme.space(4)), flex: "1 1 0", minHeight: 0, overflowY: "auto", padding: theme.space(4) }}
      >
        {props.children}
      </div>
    </div>
  );
}
