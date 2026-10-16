import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { barDockSlot, DEFAULT_CHROME, EDGE, freeArea, noticePlace, noticeSpan, type Chrome } from "../canvas/barDock.ts";
import { BarWidthProbe } from "../canvas/BarWidthProbe.tsx";
import { ScrollForMore } from "../canvas/TokenActionBar.tsx";
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
import { QuietLoadNotice } from "./QuietLoadNotice.tsx";
import { Loading } from "../components/Loading.tsx";
import { ScrollStrip } from "../components/ScrollStrip.tsx";
import { Sheet, paneBodyPadding, type SheetMode } from "../components/Sheet.tsx";
import { headerStacks, SHEET_HEADER, SHEET_HEADER_STACKED, sheetMode, sideSheetWidth } from "../components/sheetCap.ts";
import { SHORT_LANDSCAPE_MAX, useRecordOverflow, useTopBars, useTurnPlacement, type TurnPlacement } from "../features/encounter/band.ts";
import { FightWatch, InitiativeStrip, useYourTurnNotice } from "../features/encounter/InitiativeStrip.tsx";
import { panelById, panelSections, panelsFor, subpageBack, useSubpageFocus, type PanelDef, type PanelHeader } from "../features/panels.ts";
import { PartyDock } from "../features/party/PartyDock.tsx";
import type { OpenSheet } from "../features/find/findToken.ts";
import { HandoutPopup } from "../features/handouts/HandoutPopup.tsx";
import { useJobWaiting, usePdfJobRoom } from "../features/handouts/pdf/live.ts";
import { useJournalUnread } from "../features/journal/store.ts";
import { useLogUnread } from "../features/log/useLogUnread.ts";
import { PhaseMenu } from "../features/phases/PhaseMenu.tsx";
import { FrameViewBar } from "../features/scenes/FrameView.tsx";
import { barInset, chromeZoom, layoutWidth, screenHeight, smallUi, useLayoutSize } from "../features/device/layout.ts";
import { useUiScale } from "../features/device/settings.ts";
import { activeTool, toolsFor, type ToolDef } from "../features/tools.ts";
import { setupDivider } from "../features/toolbarOrder.ts";
import { useDropHpDraftsOnSelect } from "../features/tokens/hpDraft.ts";
import { useClearStatBlockOnSelect } from "../features/tokens/statBlockOpen.ts";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { useBackClose } from "../lib/backClose.ts";
import { useWakeLock } from "../lib/wakeLock.ts";
import type { Insets } from "../lib/camera.ts";
import { isCoarsePointer } from "../lib/device.ts";
import { sheetStepping } from "../lib/modalDialog.ts";
import { roomPath } from "../lib/roomId.ts";
import { sceneGate, selectionScene } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
import { PanelBody, RoomLoadNotice } from "../panels/Panels.tsx";
import { RoomScope, RoomScopeProvider, useRoomScope, useScoped } from "../state/scope.ts";
import { TOAST_MS } from "../state/store.ts";
import { sidePanelKeysSlot, useShortcuts } from "../state/shortcuts.ts";
import { usePreview } from "../features/dm/previewContext.ts";
import { ShortcutSheetHost } from "../features/device/ShortcutSheet.tsx";
import type { Ended, Toast } from "../state/types.ts";
import { barDismiss, dismissal } from "../state/selection.ts";
import { useRoomStore, useRoomUi, useRoomView } from "../state/view.ts";
import { DmLinkEntry } from "./DmLinkEntry.tsx";
import { endedText } from "./endedText.ts";
import { drawn, dockFits, dockSlot, DOCK_GAP, DOCK_PX, focusAlert, foldsUnderSheet, useSideSheetRoom, type AlertsSummary } from "./fold.ts";
import { mapFocusSlot } from "./mapFocus.ts";
import { firstSidePanel, readSidePanel, writeSidePanel } from "./sidePanel.ts";
import { SideTabs } from "./SideTabs.tsx";
import { inModal, ModalSlots, useModalSlot } from "./modalSlot.tsx";
import { optionsPlace, railAllowed, RAIL_WIDTH, wrapRecord, wrapsLines } from "./optionsPlace.ts";
import { Badge, FindButton, FitButton, PauseScreen, Stacked, UndoButtons, useAccentVars, useEscape, useNoPageZoom, usePreloadAndReopen, useRoomTitle } from "./RoomChrome.tsx";
import { DockHeaderActions, DockRow, FoldStatus, SAFE_PROBE_STYLE, useDockSummary, useLayoutHeight, useSafeAreas, type DockActions } from "./RoomDock.tsx";

/** What the DM panel's count says while a PDF upload waits on the DM. */
const UPLOAD_WAITING = "1 upload waiting";

const { topBar: TOP_BAR, toolbar: TOOLBAR } = theme.layout;
/** One row of a tool's options at the foot: a 44 px control and the bar's padding. */
const OPTIONS_ROW = theme.touch + theme.space(2);
/** "Viewing as Pat" at its widest, in window pixels (features/dm/PlayerPreview.tsx). */
const PREVIEW_NOTICE_MAX = 520;
/** Over the whole map, drawing nothing but its focus ring, inside the map's edge. */
const MAP_FOCUS_STYLE: CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none", outlineOffset: -2 };

/**
 * An element's height as drawn, kept up to date. The bars over the map
 * report theirs so a fitted map keeps clear of them, whatever the safe
 * areas, the interface size and however many rows a tool's options wrap
 * onto. A zoomed bar's own size does not change with the interface size, so
 * a new size measures again (features/device/layout.ts barInset).
 */
function useHeight(scale: number): [(el: HTMLElement | null) => (() => void) | undefined, number] {
  const [height, setHeight] = useState(0);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return undefined;
      const measure = () => setHeight(barInset(el.getBoundingClientRect()));
      const observer = new ResizeObserver(measure);
      // The border box, since the safe areas pad the bars: a home bar or notch that comes or goes leaves their content the same size.
      observer.observe(el, { box: "border-box" });
      measure();
      return () => {
        observer.disconnect();
        setHeight(0);
      };
    },
    // The scale is read through the element's rectangle, but a change must measure again.
    [scale],
  );
  return [ref, height];
}

/** An element's width as drawn, kept up to date, as useHeight keeps a height: the tool's rail reports its own, which Fit and the bar dock keep clear of. */
function useWidth(scale: number): [(el: HTMLElement | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return undefined;
      const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
      const observer = new ResizeObserver(measure);
      observer.observe(el, { box: "border-box" });
      measure();
      return () => {
        observer.disconnect();
        setWidth(0);
      };
    },
    // The scale is read through the element's rectangle, but a change must measure again.
    [scale],
  );
  return [ref, width];
}

/**
 * The active tool's options bar's height, as useHeight measures it, and how
 * far up from its foot its highest button or field reaches. A hint wraps
 * above the Ruler's buttons, and what the alerts column lays over the
 * bar's top may cover a hint but never a control (barDock.ts Chrome), nor
 * a reading or a warning (measure/controls.tsx InfoLine), which count as
 * controls here: the summary row stood over the Ruler's line at 480 x 320
 * at 130%.
 */
function useOptionsHeights(scale: number): [(el: HTMLElement | null) => (() => void) | undefined, number, number] {
  const [heights, setHeights] = useState({ height: 0, controls: 0 });
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return undefined;
      const measure = () => {
        const box = el.getBoundingClientRect();
        const tops = Array.from(el.querySelectorAll("button, input, select, [data-options-reading]"), (c) => c.getBoundingClientRect().top);
        const height = barInset(box);
        // The bar scrolls once capped, so a control scrolled out above it reaches no higher than its top, and one below no lower than its foot.
        const controls = tops.length > 0 ? Math.round(Math.max(0, Math.min(box.height, box.bottom - Math.min(...tops)))) : 0;
        setHeights((h) => (h.height === height && h.controls === controls ? h : { height, controls }));
      };
      /*
       * Its controls move without the bar changing size: past half the
       * screen it is capped and scrolls, and rows such as the kept rulers
       * grow or go inside it. So it measures again as it scrolls, as its
       * rows change size, and as they come and go.
       */
      const observer = new ResizeObserver(measure);
      const watch = () => {
        observer.observe(el, { box: "border-box" });
        for (const row of el.children) observer.observe(row);
      };
      const changes = new MutationObserver(() => {
        watch();
        measure();
      });
      watch();
      changes.observe(el, { childList: true, subtree: true });
      el.addEventListener("scroll", measure, { passive: true });
      measure();
      return () => {
        observer.disconnect();
        changes.disconnect();
        el.removeEventListener("scroll", measure);
        setHeights({ height: 0, controls: 0 });
      };
    },
    // The scale is read through the element's rectangle, but a change must measure again.
    [scale],
  );
  return [ref, heights.height, heights.controls];
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
  const [topBarRef, topBarHeight] = useHeight(zoom);
  const [toolbarRef, toolbarHeight] = useHeight(zoom);
  const [optionsRef, optionsHeight, optionsControls] = useOptionsHeights(zoom);
  const [railRef, railWidth] = useWidth(zoom);
  const insets = useMemo<Insets>(
    () => ({ top: topBarHeight, right: 0, bottom: toolbarHeight + optionsHeight, left: railWidth }),
    [topBarHeight, toolbarHeight, optionsHeight, railWidth],
  );
  const role = useRoomView((s) => s.you?.role ?? "player");
  usePreloadAndReopen(role);
  const ended = useRoomView((s) => s.ended);
  const roomId = useRoomView((s) => s.roomId);
  const gate = useRoomView(useShallow((s) => sceneGate({ view: s.view, sceneId: s.sceneId, role })));
  const { selectedId, panel, tab, tool: toolId, actionBar, sidePanelHidden, sheetHidden } = useRoomView(useShallow((s) => s.local));
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
  const focusNext = useRef<{ kind: "panel" } | { kind: "tile"; panelId: string } | { kind: "panels" } | null>(null);

  // The action bar steps aside once the token's panel is open, and focus, which went with the bar's Details, goes to the panel.
  const openDetails = useCallback(
    (id: string) => {
      ui.select(id);
      ui.showActions(false);
      ui.openPanel("token");
      focusNext.current = { kind: "panel" };
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
  // The keyboard (state/shortcuts.ts). A "view as a player" preview answers no key.
  const previewing = usePreview();
  const preview = previewing !== null;
  useShortcuts({ role, tools, scope, preview });

  /*
   * The side panel from 900 px up, which can be hidden
   * (docs/design-v1-layout-hierarchy.md 4.1). Its first state on this page
   * is worked out once, the first time the layout is wide, from this
   * device's choice or the short screen's default (pages/sidePanel.ts), in
   * a layout effect so a panel that starts hidden never paints a frame.
   */
  const sideShown = wide && !sidePanelHidden;
  const sideFirst = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    if (sideFirst.current !== null || !wide) return;
    const first = firstSidePanel(null, { wide, height, stored: readSidePanel() });
    sideFirst.current = first;
    if (first !== null) ui.hideSidePanel(first);
  }, [wide, height, ui]);
  // Crossing 900 px, a phone's hidden sheet and the side panel hand over to each other (state/types.ts crossWide).
  const wasWide = useRef(wide);
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
  // New chat and whispers mark the Log's button while it is not on screen.
  const unread = useLogUnread(wide ? sideShown && tabId === "log" : sheet?.id === "log");
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
  const tokenPanelShown = wide ? sideShown && tabId === "token" : sheet?.id === "token";
  const away = useRoomView((s) => dismissal(s.local, tokenPanelShown));
  /*
   * While the token's panel shows the token, the bar's Close, Escape and
   * Back put the bar away and keep the token, so the panel the DM is
   * reading stays filled (state/selection.ts barDismiss), and focus, which
   * was on the bar or nowhere, goes to the panel.
   */
  const hideBar = useCallback(() => {
    ui.showActions(false);
    focusNext.current = { kind: "panel" };
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
  // The subpage the open panel names (features/panels.ts usePanelHeader), for the sheet's or side panel's header.
  const [subpage, setSubpage] = useState<PanelHeader | null>(null);

  // ------------------------------------------------ the dock (pages/fold.ts)
  const dockStore = scope.get(dockSlot);
  const hasBar = useStore(dockStore, (s) => s.bar !== null);
  const summary = useDockSummary();
  const safe = useSafeAreas();
  /*
   * Where a sheet stands: at the foot of an upright phone, on the right of
   * one held sideways, or, where that would leave its body under 88 px, in
   * the very short mode over the whole screen (components/sheetCap.ts).
   * Worked out from the layout, the safe areas and the bars, never measured.
   */
  const sideWidth = sideSheetWidth(width);
  const sideHeader = headerStacks({ width: sideWidth - safe.right - 2 * theme.line.border, buttons: mounted ? 3 : 1, actions: false }) ? SHEET_HEADER_STACKED : SHEET_HEADER;
  const sheetModeNow: SheetMode = !landscape ? "bottom" : sheetMode({ height, safeTop: safe.top, safeBottom: safe.bottom, topBars: topInset, header: sideHeader });
  const full = sheetModeNow === "full" && sheetOpen;
  // Less a 1 px border on each side, which the very short mode does not draw (Sheet.tsx).
  const headerWidth = (sheetModeNow === "side" ? sideWidth - safe.right : width - safe.left - safe.right) - (sheetModeNow === "full" ? 0 : 2 * theme.line.border);
  const fullMode = sheetModeNow === "full";
  useLayoutEffect(() => {
    const now = dockStore.getState();
    if (now.sheetFull !== full || now.sheetFullMode !== fullMode) dockStore.setState({ sheetFull: full, sheetFullMode: fullMode });
  }, [dockStore, full, fullMode]);
  useLayoutEffect(() => () => dockStore.setState({ sheetFull: false, sheetFullMode: false }), [dockStore]);
  /*
   * The tool's options in a rail on the left of the map, on a short screen
   * held sideways (docs/design-v1-layout-hierarchy.md 3, pages/optionsPlace.ts).
   * A one-row tool's foot bar records the width where its row wrapped, and
   * from then on uses the rail at that width or narrower: the record comes
   * from a layout effect, so the bar is never painted at the foot first.
   */
  const mapWidth = sideShown ? width - theme.layout.sidePanelWidth : width;
  const [wrappedAt, setWrappedAt] = useState<Readonly<Record<string, number>>>({});
  const optionsDrawn = tool.Options !== undefined && optionsShown && !sheet && !pickerOpen;
  const optionsAt = optionsPlace({ allowed: railAllowed({ width, height, mapWidth, safeLeft: safe.left }), toolId: tool.id, optionsAt: tool.optionsAt, footWidth: mapWidth, wrappedAt: wrappedAt[tool.id] ?? null });
  const recordWrap = useCallback(
    (toolId: string, footWidth: number) =>
      setWrappedAt((prev) => {
        const next = wrapRecord(prev[toolId] ?? null, footWidth);
        return prev[toolId] === next ? prev : { ...prev, [toolId]: next };
      }),
    [],
  );
  const sideRoom = useSideSheetRoom();
  const folded = foldsUnderSheet({ width, height, sheetOpen, full, sideRoom });
  const docked = folded && (hasBar || summary !== null);
  // Over the whole screen there is no edge to dock on, nor beside a sideways sheet that leaves a window too little room, so the dock's buttons join the header, as where the dock has no room.
  const dockInHeader = docked && (full || landscape || !dockFits({ height, safeTop: safe.top, safeBottom: safe.bottom, insetTop: topInset, insetBottom: TOOLBAR }));
  const sheetHeight = useLayoutHeight(sheetEl, zoom);
  const backRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef<HTMLButtonElement>(null);
  useDockSummaryButton(summaryRef);
  /** What the tap that closed the sheets asked to show, for where focus goes once they are gone. */
  const showing = useRef<{ kind: "bar" } | { kind: "alerts"; first: AlertsSummary["first"] } | null>(null);
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
      if (rolls?.waiting) {
        // A roll waits for this viewer's answer: its card shows and takes focus (features/rolls, 3.3.1).
        showing.current = null;
        closeSheets();
        rolls.open();
        return;
      }
      showing.current = { kind: "alerts", first: s.first };
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
      topBarHeight > 0 && toolbarHeight > 0
        ? {
            top: topBarHeight / zoom,
            bottom: (toolbarHeight + optionsHeight) / zoom,
            controls: (toolbarHeight + optionsControls) / zoom,
            toolbar: toolbarHeight / zoom,
            // Beside the side panel the map never touches the right edge, so its free area keeps no right inset.
            safe: { top: safe.top, right: sideShown ? 0 : safe.right, bottom: safe.bottom, left: safe.left },
            sheet: sheetRight,
            rail: railWidth / zoom,
          }
        : null,
    [topBarHeight, toolbarHeight, optionsHeight, optionsControls, zoom, safe.top, safe.right, safe.bottom, safe.left, sheetRight, sideShown, railWidth],
  );
  useLayoutEffect(() => {
    barDock.setState({ chrome });
  }, [barDock, chrome]);

  /*
   * The notices over the map (design 1.3): with 320 px or more left of the
   * lane the token bar and the alerts column share, the whole stack, toasts
   * included, centers there, so nothing moves when an alert arrives.
   * Otherwise it spans as before, and the column starts below the notices
   * that last (the offline banner, a layer that did not load, the DM's
   * frame bar and "Viewing as Pat"), while toasts keep their place, so a
   * card never jumps under a finger for a toast. "Viewing as Pat" stays in
   * the preview, outside this page, so a blackout and the ended screen keep
   * its Exit: the preview tells this page how tall it is, and this page
   * says where it goes. Spanning, this page's own notices start below it.
   */
  const free = freeArea({ width: mapWidth, height }, chrome ?? DEFAULT_CHROME);
  const beside = chrome ? noticePlace(free) : null;
  const besideLane = beside !== null;
  // With a rail the notices that span keep to the free area, right of it (barDock.ts noticeSpan).
  const span = chrome && !beside ? noticeSpan(free, chrome.rail) : null;
  const noticeBox = beside ?? span;
  const previewNotice = previewing?.notice ?? null;
  const previewPush = !beside && previewNotice ? previewNotice.height / zoom + EDGE : 0;
  const reportsPreview = previewNotice !== null && !ended && gate.kind !== "blackout";
  useLayoutEffect(() => {
    if (!previewNotice || !reportsPreview) return;
    // Beside the lane, or spanning the free area right of a rail, so "Viewing as Pat" never covers the tool's options.
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
  const columnSummary = useStore(barDock, (s) => s.bar?.lane === "summary" || s.footYields || s.columnCramped) && summary !== null;
  // The tool's options grow up from the toolbar, but never under the top bars or a lasting notice, which stand over them: past that they scroll.
  const lastingBottom = useStore(barDock, (s) => s.lasting);
  const optionsRoom = chrome ? height - chrome.toolbar - Math.max(chrome.top, lastingBottom ?? 0) - EDGE : null;
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
  const placeFocus = () => {
    const ask = focusNext.current;
    if (!ask) return;
    // The side panel draws no tabs until it has fitted them to its row (pages/SideTabs.tsx), at most one commit later and before paint, and then asks again (onTabsDrawn).
    if (ask.kind === "panel" && wide && sideShown && !sideTabRef.current) return;
    focusNext.current = null;
    if (ask.kind === "panel") (wide ? sideTabRef.current : sheetTitleRef.current)?.focus({ preventScroll: true });
    else if (ask.kind === "panels") panelsRef.current?.focus({ preventScroll: true });
    else sheetRef.current?.querySelector<HTMLElement>(`[data-opener="${panelTile(ask.panelId)}"]`)?.focus();
  };
  useLayoutEffect(placeFocus);

  if (ended) return <EndedScreen ended={ended} roomId={roomId} role={role} />;
  // A blackout is for a break or a reveal (features section 13), so players
  // see nothing of the table: no map, panels, initiative strip, handouts or
  // toasts. sceneGate gives only players this kind, so a DM's room is unchanged.
  if (gate.kind === "blackout") return <PauseScreen />;

  const reserveTop = docked && !dockInHeader ? DOCK_PX + DOCK_GAP : undefined;
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
        <MapArea gate={gate} role={role} actionBar={actionBar} insets={insets} onSelect={select} onOpenDetails={openDetails} tokenPanelShown={tokenPanelShown} onHideBar={hideBar} />
        {/* The map's focus target (mapFocus.ts): after the map, so its ring draws over it, and before the bars, so Tab from it goes on to them. Taps pass through it. */}
        <div ref={mapFocusRef} tabIndex={-1} role="img" aria-label="Map" style={MAP_FOCUS_STYLE} />
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
          <Toasts />
        </div>
        {mounted ? (
          <Sheet
            ref={sheetElRef}
            title={mounted.title}
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
            subpage={subpage}
            reserveTop={reserveTop}
            actions={headerActions}
            actionCount={headerActionCount}
            headerWidth={headerWidth}
            notices={notices}
            backRef={backRef}
            closeRef={closeRef}
            titleRef={sheetTitleRef}
          >
            <PanelBody id={mounted.id} shown={sheet !== undefined} selectedTokenId={selectedId} close={() => ui.closePanel()} onHeader={setSubpage} />
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
            backRef={backRef}
            closeRef={closeRef}
          >
            <PanelPicker
              panels={panels}
              current={tabId}
              badges={badges}
              badgeLabels={badgeLabels}
              grouped={role === "dm"}
              onPick={(id) => {
                focusNext.current = { kind: "panel" };
                ui.openPanel(id);
              }}
            />
          </Sheet>
        ) : null}
        {/* After the sheet, so a test's or a screen reader's first "Close" in the page is still the sheet's (docs/design-v1-visual.md 5.4). */}
        {docked && !dockInHeader ? <DockRow zoom={zoom} sheetHeight={sheetHeight} summary={summary} actions={dockActions} showRef={showRef} summaryRef={summaryRef} /> : null}
        {/* One element at the foot or in the rail, so a rotation never remounts the tool's options. */}
        {optionsDrawn ? (
          <OptionsBar
            ref={optionsAt === "rail" ? railRef : optionsRef}
            railTop={optionsAt === "rail" ? topInset : null}
            tool={tool}
            role={role}
            wide={wide}
            zoom={zoom}
            room={optionsRoom}
            onWrap={optionsAt === "foot" && tool.optionsAt === "foot" && tool.id !== "select" ? () => recordWrap(tool.id, mapWidth) : undefined}
          />
        ) : null}
        <Toolbar
          ref={toolbarRef}
          zoom={zoom}
          wide={wide}
          tools={tools}
          tool={tool.id}
          onTool={(id) => ui.setTool(id)}
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
          badges={badges}
          badgeLabels={badgeLabels}
          grouped={role === "dm"}
          onTab={(id) => ui.openPanel(id)}
          onHide={hideSidePanel}
          subpage={subpage}
          tabRef={sideTabRef}
          onTabsDrawn={placeFocus}
        >
          {tabId ? <PanelBody id={tabId} shown={sideShown} selectedTokenId={selectedId} close={() => ui.closePanel()} onHeader={setSubpage} /> : null}
        </SidePanel>
      ) : null}
      <FoldStatus folded={folded || columnSummary} />
      <HandoutPopup />
      <ShortcutSheetHost role={role} />
    </div>
  );
}

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
 *   where it fell, as before.
 *
 * Both run after the render that folded or unfolded, when the folded
 * parts have their `hidden` set or cleared.
 */
function useDockFocus(input: {
  folded: boolean;
  sheetOpen: boolean;
  store: ReturnType<typeof dockSlot.create>;
  registry: ReturnType<typeof sheetFocusSlot.create>;
  showing: { current: { kind: "bar" } | { kind: "alerts"; first: AlertsSummary["first"] } | null };
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
    if (asked?.kind === "bar") {
      const frame = store.getState().bar?.frame.current;
      if (frame && drawn(frame)) {
        frame.focus({ preventScroll: true });
        return;
      }
    }
    if (asked?.kind === "alerts" && focusAlert(store.getState().column, asked.first)) return;
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
 * Undo and Redo, Find my token and Fit map. The initiative strip sits in
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
 * 130% the whole chip pushed Fit off the screen. A DM's row from 900 px up
 * checks too, since Undo and Redo sit in it on every layout
 * (docs/design-v1-layout-hierarchy.md M2): there the strip stays, the chip
 * gives way to its dot first, then the Phase menu leaves the bar, each
 * until the layout is wider, and a scene's "Show a phase" chips still
 * switch phases. The row's own box keeps its size when its content grows,
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
  const rowRef = useRef<HTMLDivElement>(null);
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const recordOverflow = useRecordOverflow();
  const { width } = useLayoutSize();
  // The layout width at which the DM's whole chip last overflowed the row: up to it, the chip is its dot.
  const [dmDotUpTo, setDmDotUpTo] = useState(0);
  const dmDot = role === "dm" && width <= dmDotUpTo;
  // From 900 px up, the width at which the row still overflowed with the chip's dot: up to it, the Phase menu leaves the bar.
  const [phaseOffUpTo, setPhaseOffUpTo] = useState(0);
  const phaseMenu = !props.compact && width > phaseOffUpTo;
  const phases = useRoomView((s) => (s.sceneId ? (s.view?.scenes[s.sceneId]?.phases?.length ?? 0) : 0));
  // From 900 px up the strip sits in the bar whatever it holds, so only a phone's bar records it.
  const measured = props.placement === "bar" && props.compact;
  // A phone's row, and a DM's row from 900 px up, which holds Undo, Redo and the Phase menu.
  const checks = props.compact || role === "dm";
  const check = useCallback(() => {
    const row = rowRef.current;
    if (!checks || !row) return;
    // The last button tucks into the bar's padding by a negative margin (RoomChrome.tsx FitButton), which is room the row has, not overflow.
    const last = row.lastElementChild;
    const tuck = last ? Math.max(0, -parseFloat(getComputedStyle(last).marginRight) || 0) : 0;
    const overflow = row.scrollWidth - row.clientWidth - tuck;
    if (overflow <= 0) return;
    // The strip leaves first. Once it is in the band, this runs again with the row it left. Then the chip's name, then the Phase menu.
    if (measured) recordOverflow(layoutWidth(), overflow);
    else if (role === "dm" && !dmDot) setDmDotUpTo(layoutWidth());
    else if (phaseMenu) setPhaseOffUpTo(layoutWidth());
  }, [checks, measured, recordOverflow, role, dmDot, phaseMenu]);
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
      {...smallUi(props.zoom)}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: alertsOverlay ? theme.z.alertsOverlay : theme.z.bars,
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
          // A DM's phone fits the name, Undo, Redo and Fit only with tighter gaps.
          gap: props.compact ? theme.space(1.5) : theme.space(3),
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
        {props.undo ? <UndoButtons /> : null}
        {phaseMenu ? <PhaseMenu /> : null}
        {props.placement === "bar" ? <InitiativeStrip placement="bar" notice={notice} stripRef={setStrip} /> : null}
        {props.canFit && role === "player" ? <FindButton openSheet={props.openSheet} /> : null}
        {props.canFit ? <FitButton /> : null}
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
    <div style={{ pointerEvents: "auto", width: "100%", maxWidth: 520, minWidth: 0 }}>
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
 * modal leaves the map's notices out of reach. Each toast stays where it
 * first showed until it ends, so it is never moved and never announced
 * again: one shown in the sheet goes with the sheet.
 */
function Toasts() {
  const toasts = useRoomView((s) => s.toasts);
  const ui = useRoomUi();
  const slot = useModalSlot("toasts");
  // Where each toast first showed, by id: over the map, or in the very short sheet. Set once, so a toast never moves.
  const places = useRef(new Map<number, "map" | "sheet">());
  for (const t of toasts) if (!places.current.has(t.id)) places.current.set(t.id, slot ? "sheet" : "map");
  useEffect(() => {
    for (const id of places.current.keys()) if (!toasts.some((t) => t.id === id)) places.current.delete(id);
  }, [toasts]);
  useEffect(() => {
    if (slot) return;
    for (const [id, place] of places.current) if (place === "sheet") ui.dismissToast(id);
  }, [slot, ui]);
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) => setTimeout(() => ui.dismissToast(t.id), TOAST_MS));
    return () => timers.forEach(clearTimeout);
  }, [toasts, ui]);
  if (toasts.length === 0) return null;
  const overMap = toasts.filter((t) => places.current.get(t.id) !== "sheet");
  const inSheet = slot ? toasts.filter((t) => places.current.get(t.id) === "sheet") : [];
  return (
    <>
      {overMap.map((t) => (
        <ToastNote key={t.id} toast={t} onDismiss={() => ui.dismissToast(t.id)} />
      ))}
      {slot && inSheet.length > 0
        ? createPortal(
            inSheet.map((t) => <ToastNote key={t.id} toast={t} onDismiss={() => ui.dismissToast(t.id)} />),
            slot,
          )
        : null}
    </>
  );
}

function ToastNote(props: { toast: Toast; onDismiss(): void }) {
  const t = props.toast;
  const tone = NOTICE_TONES[t.tone === "error" ? "danger" : "info"];
  return (
    <button
      type="button"
      role="status"
      onClick={props.onDismiss}
      style={{
        pointerEvents: "auto",
        width: "100%",
        maxWidth: 520,
        minHeight: theme.touch,
        padding: `${theme.space(2)}px ${theme.space(3)}px`,
        borderRadius: theme.radius.md,
        background: tone.fill,
        border: `${theme.line.border}px solid ${tone.outline}`,
        color: tone.text,
        fontFamily: theme.font.body,
        fontSize: theme.font.body14,
        lineHeight: theme.leading.body,
        textAlign: "left",
        boxShadow: theme.shadow.float,
        cursor: "pointer",
      }}
    >
      {t.text}
    </button>
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

function ToolIcon(props: { tool: ToolDef }) {
  const { icon } = props.tool;
  if ("glyph" in icon) return <span aria-hidden style={{ fontSize: theme.font.heading, fontWeight: theme.weight.bold, lineHeight: 1 }}>{icon.glyph}</span>;
  return (
    <svg aria-hidden viewBox="0 0 24 24" width={22} height={22} style={{ display: "block" }}>
      <path d={icon.path} fill="currentColor" />
    </svg>
  );
}

/**
 * The active tool's options, docked above the toolbar on phones and floating
 * above it on wide screens. They wrap onto more rows rather than scroll, so
 * no option hides past the edge of a phone.
 *
 * On a short screen held sideways (`railTop`, the top bars' height under
 * which it starts), they stand in a rail on the left of the map instead,
 * from under the top bars down to the toolbar, 248 px and the left safe
 * area wide, scrolling up and down, never sideways, with "Scroll for more"
 * while they run past its foot (docs/design-v1-layout-hierarchy.md 3.2).
 * The map keeps its whole height. Its place in the page's order stays just
 * before the toolbar, so Tab reaches it where it did.
 *
 * `onWrap` is a one-row tool's at the foot: told, in a layout effect and so
 * before paint, when its controls stand on more than one line, so Room can
 * move them to the rail in the same frame (pages/optionsPlace.ts).
 */
function OptionsBar(props: {
  ref?: Ref<HTMLDivElement>;
  railTop: number | null;
  tool: ToolDef;
  role: "dm" | "player";
  wide: boolean;
  zoom: number;
  room: number | null;
  onWrap?(): void;
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
  const rail = props.railTop !== null;
  // Capped, the bar shows its buttons rather than the hint above them, which scrolls back into view: the Ruler's Keep and Clear stay in reach on a short screen. The rail is tall, and starts at its hint.
  useLayoutEffect(() => {
    const el = own.current;
    if (!el || rail) return;
    const reveal = () => {
      const first = el.querySelector<HTMLElement>("button, input, select");
      if (!first || el.scrollHeight <= el.clientHeight + 1) return;
      const top = first.offsetTop - theme.space(1);
      if (el.scrollTop < top) el.scrollTop = top;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(el);
    for (const row of el.children) observer.observe(row);
    return () => observer.disconnect();
  }, [props.tool.id, rail]);
  // A one-row tool whose row wraps at the foot: read in a layout effect, and in its observers' callbacks with a synchronous render, so it never paints a frame there.
  const latestWrap = useRef(props.onWrap);
  latestWrap.current = props.onWrap;
  const watchWrap = props.onWrap !== undefined;
  useLayoutEffect(() => {
    const el = own.current;
    if (!el || !watchWrap) return;
    const wrapped = () => wrapsLines(Array.from(el.querySelectorAll("button, input, select"), (c) => c.getBoundingClientRect()).filter((r) => r.height > 0));
    if (wrapped()) {
      latestWrap.current?.();
      return;
    }
    const observer = new ResizeObserver(() => {
      if (wrapped()) flushSync(() => latestWrap.current?.());
    });
    observer.observe(el);
    for (const row of el.children) observer.observe(row);
    return () => observer.disconnect();
  }, [watchWrap, props.tool.id]);
  // "Scroll for more" while the rail's content runs past its foot.
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = own.current;
    if (!el || !rail) {
      setClipped(false);
      return;
    }
    const clip = () => setClipped(el.scrollHeight - el.clientHeight - el.scrollTop > 4);
    clip();
    const observer = new ResizeObserver(clip);
    observer.observe(el);
    for (const row of el.children) observer.observe(row);
    el.addEventListener("scroll", clip, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", clip);
    };
  }, [rail, props.tool.id]);
  if (!Options) return null;
  const place: CSSProperties = rail
    ? {
        left: 0,
        right: "auto",
        top: `calc(${theme.safe.top} + ${props.railTop}px)`,
        bottom: `calc(${theme.safe.bottom} + ${TOOLBAR}px)`,
        width: `calc(${RAIL_WIDTH}px + ${theme.safe.left})`,
        maxWidth: "none",
        minHeight: 0,
        maxHeight: "none",
        alignContent: "flex-start",
        padding: `${theme.space(1)}px ${theme.space(2)}px ${theme.space(1)}px calc(${theme.safe.left} + ${theme.space(2)}px)`,
        borderTop: "none",
        borderRight: `${theme.line.border}px solid ${theme.color.border}`,
        borderBottom: "none",
        borderLeft: "none",
        borderRadius: 0,
        overflowX: "hidden",
        overflowY: "auto",
        overscrollBehavior: "contain",
      }
    : {
        // From 900 px up the bar floats clear of every side, 8 px right of the left safe area, so its content pads 8 px with no safe area.
        left: props.wide ? `calc(${theme.safe.left} + ${theme.space(2)}px)` : 0,
        right: props.wide ? "auto" : 0,
        top: "auto",
        bottom: `calc(${theme.safe.bottom} + ${TOOLBAR}px)`,
        width: "auto",
        minHeight: OPTIONS_ROW,
        maxWidth: props.wide ? 640 : "none",
        alignContent: "normal",
        padding: props.wide ? `${theme.space(1)}px ${theme.space(2)}px` : `${theme.space(1)}px calc(${theme.safe.right} + ${theme.space(2)}px) ${theme.space(1)}px calc(${theme.safe.left} + ${theme.space(2)}px)`,
        // Longhands only: React warns when a rerender changes a shorthand mixed with its longhands, as crossing the wide breakpoint did.
        borderTop: `${theme.line.border}px solid ${theme.color.border}`,
        borderRight: props.wide ? `${theme.line.border}px solid ${theme.color.border}` : "none",
        borderBottom: props.wide ? `${theme.line.border}px solid ${theme.color.border}` : "none",
        borderLeft: props.wide ? `${theme.line.border}px solid ${theme.color.border}` : "none",
        borderRadius: props.wide ? theme.radius.md : 0,
        // Rows wrap (measure/controls.tsx), so the bar grows upward. Past
        // half the screen it scrolls, so the map always keeps the other half,
        // and past the room under the top bars and any lasting notice too,
        // which would stand over its buttons, keeping one row at least.
        maxHeight: props.room === null ? screenHeight(50) : `min(${screenHeight(50)}, ${Math.max(OPTIONS_ROW, props.room)}px)`,
        /*
         * Where even one row does not fit under a lasting notice, as at 480
         * x 320 at 130% in a fight with Reconnecting up, the row stands over
         * the notice, so the tool's buttons stay in reach. The notice keeps
         * to one line there, and the connection dot or the tool's own
         * change of mode still says what it said.
         */
        zIndex: props.room !== null && props.room < OPTIONS_ROW ? theme.z.notices + 1 : theme.z.options,
        overflowX: "auto",
        overflowY: "auto",
        overscrollBehavior: "auto",
      };
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={`${props.tool.label} options`}
      data-rvtt-options={rail ? "rail" : "foot"}
      {...smallUi(props.zoom)}
      style={{
        ...chromeZoom(props.zoom),
        position: "absolute",
        zIndex: theme.z.options,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: theme.space(2),
        background: theme.color.overlay,
        ...place,
      }}
    >
      <LoadBoundary key={props.tool.id} fallback={(f) => <RoomLoadNotice {...f} subject="These options" verb="load" compact reopen={{ tool: props.tool.id }} />}>
        <Options role={props.role} />
      </LoadBoundary>
      {clipped ? <ScrollForMore fill={theme.color.overlay} /> : null}
    </div>
  );
}

function Toolbar(props: {
  ref?: Ref<HTMLElement>;
  zoom: number;
  wide: boolean;
  tools: ToolDef[];
  tool: string;
  onTool(id: string): void;
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
  const { wide, tools } = props;
  const divider = setupDivider(tools);
  const hiddenId = useId();
  const panelsIcon = (
    <svg aria-hidden viewBox="0 0 24 24" width={22} height={22} style={{ display: "block" }}>
      <path d="M4 5h16v2H4zm0 6h16v2H4zm0 6h16v2H4z" fill="currentColor" />
    </svg>
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
        zIndex: theme.z.bars,
        display: "flex",
        alignItems: "center",
        gap: theme.space(1),
        height: `calc(${theme.safe.bottom} + ${TOOLBAR}px)`,
        padding: `0 calc(${theme.safe.mapRight} + ${theme.space(1)}px) ${theme.safe.bottom} calc(${theme.safe.left} + ${theme.space(1)}px)`,
        background: wide ? "transparent" : theme.color.overlay,
        borderTop: wide ? "none" : `${theme.line.border}px solid ${theme.color.border}`,
        pointerEvents: wide ? "none" : "auto",
        ...chromeZoom(props.zoom),
      }}
    >
      <ScrollStrip active={props.tool} style={{ flex: "1 1 auto", height: "100%" }}>
        {tools.map((t, i) => (
          <Fragment key={t.id}>
            {/* The play tools, then the setup tools past a divider (docs/design-v1-layout-hierarchy.md M1): a line in a phone's strip, a 12 px gap between the floating buttons. */}
            {i === divider ? <span aria-hidden data-rvtt-divider="" style={wide ? { flex: "none", width: theme.space(1) } : { flex: "none", width: theme.line.border, height: 32, background: theme.color.border }} /> : null}
            <ToolButton label={t.label} active={props.tool === t.id} onClick={() => props.onTool(t.id)} floating={wide} iconOnly>
              {props.named ? <Stacked icon={<ToolIcon tool={t} />} text={t.shortLabel ?? t.label} /> : <ToolIcon tool={t} />}
            </ToolButton>
          </Fragment>
        ))}
      </ScrollStrip>
      {wide ? (
        props.sideHidden ? (
          <div style={{ flex: "none", display: "flex", alignItems: "center", height: "100%" }}>
            <ToolButton ref={props.panelsRef} label="Panels" active={false} expanded={false} controls={props.sidePanelId} onClick={props.onShowSide} floating iconOnly>
              {props.named ? <Stacked icon={panelsIcon} text="Panels" /> : panelsIcon}
              <Badge count={props.unread} corner label={props.unreadLabel} />
            </ToolButton>
          </div>
        ) : null
      ) : (
        <div style={{ flex: "none", display: "flex", alignItems: "center", height: "100%", paddingLeft: theme.space(1), borderLeft: `${theme.line.border}px solid ${theme.color.border}` }}>
          <ToolButton ref={props.panelsRef} label="Panels" active={props.panelsOpen} onClick={props.onPanels} describedBy={props.hiddenSheet ? hiddenId : undefined}>
            <Stacked icon={panelsIcon} text="Panels" />
            <Badge count={props.unread} corner label={props.unreadLabel} />
          </ToolButton>
          {props.hiddenSheet ? (
            <span id={hiddenId} hidden>
              {`Shows ${props.hiddenSheet} again.`}
            </span>
          ) : null}
        </div>
      )}
    </nav>
  );
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

function ToolButton(props: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  active: boolean;
  onClick(): void;
  floating?: boolean;
  iconOnly?: boolean;
  /** A button that shows or hides something it names (`controls`), which says so in place of a pressed state. */
  expanded?: boolean;
  controls?: string;
  describedBy?: string;
  children: ReactNode;
}) {
  return (
    <button
      ref={props.ref}
      type="button"
      data-active={props.active}
      aria-pressed={props.expanded === undefined ? props.active : undefined}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      aria-describedby={props.describedBy}
      aria-label={props.iconOnly ? props.label : undefined}
      title={props.label}
      onClick={props.onClick}
      style={{
        flex: "none",
        position: "relative",
        display: "grid",
        placeItems: "center",
        minWidth: theme.touch,
        minHeight: theme.touch,
        padding: `0 ${theme.space(2)}px`,
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${props.active ? theme.color.accent : props.floating ? theme.color.border : "transparent"}`,
        background: props.active ? theme.color.accentTint : props.floating ? theme.color.overlay : "transparent",
        color: props.active ? theme.color.accent : theme.color.text,
        fontSize: theme.font.small,
        fontWeight: theme.weight.strong,
        cursor: "pointer",
        pointerEvents: "auto",
      }}
    >
      {props.children}
    </button>
  );
}

/**
 * The side panel from 900 px up: the party bar, the tabs, and the open
 * panel. While the panel shows a subpage (features/panels.ts
 * usePanelHeader), a header above it names the subpage with "Back to" its
 * panel, and focus follows it in and out (useSubpageFocus). With no
 * subpage there is no header, since the chosen tab already names the
 * panel, unless More cuts its name (pages/SideTabs.tsx).
 *
 * "Hide panels" at the end of the tab row hides it (`hidden`), its content
 * kept mounted, so a half-typed message, an open journal page and each
 * panel's scroll survive (docs/design-v1-layout-hierarchy.md 4.1). The
 * tabs stand in one row at every height, the rest behind More
 * (docs/design-v1-panel-tabs.md), so the open panel keeps a body to show:
 * at 932 x 430 a DM's wrapped tabs left it 45 px.
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
  badges: Record<string, number>;
  /** What a tab's count says to a screen reader where it is not "N unread". */
  badgeLabels: Record<string, string>;
  grouped: boolean;
  onTab(id: string): void;
  subpage: PanelHeader | null;
  /**
   * The chosen tab, which takes focus from script when Details opens the
   * token's panel: "Token, tab, selected". The tab panel itself takes no
   * focus, so a click on its blank space leaves Space free to pan the map.
   * More, while the open panel is in it.
   */
  tabRef: RefObject<HTMLButtonElement | null>;
  /** The tabs have just been drawn for a new fit, in a commit of the side panel's own. */
  onTabsDrawn(): void;
  children: ReactNode;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Where Back lands when the row that opened the subpage is gone (a page deleted from inside it): the header goes with the subpage, and the panel's tab stays.
  const chosenTabRef = props.tabRef;
  useSubpageFocus(props.subpage, { title: titleRef, body: bodyRef, fallback: chosenTabRef });
  // The panel is named by its chosen tab, so a screen reader entering it hears "Initiative" rather than a bare "tab panel".
  const ids = useId();
  const tabId = (id: string) => `${ids}-tab-${id}`;
  const panelId = `${ids}-panel`;
  return (
    <aside
      ref={props.ref}
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
        subpage={props.subpage !== null}
        tabRef={chosenTabRef}
        onTabsDrawn={props.onTabsDrawn}
        tabId={tabId}
        panelId={panelId}
      />
      {props.subpage ? (
        <div style={{ flex: "none", borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
          <SheetHeader title={props.subpage.title} back={subpageBack(props.subpage)} titleRef={titleRef} />
        </div>
      ) : null}
      <div
        ref={bodyRef}
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(props.tab)}
        data-pane-body=""
        style={{ ...paneBodyPadding(theme.space(4), theme.space(4)), flex: 1, overflowY: "auto", padding: theme.space(4) }}
      >
        {props.children}
      </div>
    </aside>
  );
}
