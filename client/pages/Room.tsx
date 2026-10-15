import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { barDockSlot, DEFAULT_CHROME, EDGE, freeArea, noticePlace, type Chrome } from "../canvas/barDock.ts";
import { SceneLoadingOverlay } from "../canvas/SceneLoading.tsx";
import { MapStage } from "../canvas/Stage.tsx";
import { Button } from "../components/Button.tsx";
import { ConnectionDot, ReconnectBanner } from "../components/ConnectionStatus.tsx";
import { Card, Page } from "../components/Field.tsx";
import { LoadBoundary } from "../components/LoadBoundary.tsx";
import { PRESSED } from "../components/looks.ts";
import { Row } from "../components/Row.tsx";
import { returnFocusAfterSheet, sheetFocusSlot, useAlertsSummaryEntry, useDockSummaryButton } from "../components/sheetFocus.ts";
import { SheetHeader } from "../components/SheetHeader.tsx";
import { NOTICE_TONES } from "../components/tones.ts";
import { QuietLoadNotice } from "./QuietLoadNotice.tsx";
import { Loading } from "../components/Loading.tsx";
import { ScrollStrip } from "../components/ScrollStrip.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { useRecordOverflow, useTopBars, useTurnPlacement, type TurnPlacement } from "../features/encounter/band.ts";
import { FightWatch, InitiativeStrip, useYourTurnNotice } from "../features/encounter/InitiativeStrip.tsx";
import { panelById, panelsFor, subpageBack, useSubpageFocus, type PanelDef, type PanelHeader } from "../features/panels.ts";
import { PartyDock } from "../features/party/PartyDock.tsx";
import type { OpenSheet } from "../features/find/findToken.ts";
import { HandoutPopup } from "../features/handouts/HandoutPopup.tsx";
import { useJournalUnread } from "../features/journal/store.ts";
import { useLogUnread } from "../features/log/useLogUnread.ts";
import { PhaseMenu } from "../features/phases/PhaseMenu.tsx";
import { FrameViewBar } from "../features/scenes/FrameView.tsx";
import { barInset, chromeZoom, layoutWidth, screenHeight, smallUi, useLayoutSize } from "../features/device/layout.ts";
import { useUiScale } from "../features/device/settings.ts";
import { activeTool, toolsFor, type ToolDef } from "../features/tools.ts";
import { useDropHpDraftsOnSelect } from "../features/tokens/hpDraft.ts";
import { tabKeyIndex, VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { useBackClose } from "../lib/backClose.ts";
import { useWakeLock } from "../lib/wakeLock.ts";
import type { Insets } from "../lib/camera.ts";
import { isCoarsePointer } from "../lib/device.ts";
import { roomPath } from "../lib/roomId.ts";
import { sceneGate, selectionScene } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
import { PanelBody, RoomLoadNotice } from "../panels/Panels.tsx";
import { RoomScope, RoomScopeProvider, useRoomScope } from "../state/scope.ts";
import { TOAST_MS } from "../state/store.ts";
import { useShortcuts } from "../state/shortcuts.ts";
import { usePreview } from "../features/dm/previewContext.ts";
import { ShortcutSheetHost } from "../features/device/ShortcutSheet.tsx";
import type { Ended } from "../state/types.ts";
import { dismissal } from "../state/selection.ts";
import { useRoomStore, useRoomUi, useRoomView } from "../state/view.ts";
import { DmLinkEntry } from "./DmLinkEntry.tsx";
import { endedText } from "./endedText.ts";
import { drawn, dockFits, dockSlot, DOCK_GAP, DOCK_PX, focusAlert, foldsUnderSheet, type AlertsSummary } from "./fold.ts";
import { mapFocusSlot } from "./mapFocus.ts";
import { Badge, FindButton, FitButton, PauseScreen, Stacked, UndoButtons, useAccentVars, useEscape, useNoPageZoom, usePreloadAndReopen, useRoomTitle } from "./RoomChrome.tsx";
import { DockHeaderActions, DockRow, FoldStatus, SAFE_PROBE_STYLE, useDockSummary, useLayoutHeight, useSafeAreas, type DockActions } from "./RoomDock.tsx";

const { topBar: TOP_BAR, toolbar: TOOLBAR } = theme.layout;
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
      observer.observe(el);
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
 * From 900 px up the tools fit, and the side panel's tabs wrap onto a
 * second row instead of scrolling, so a mouse reaches all of them.
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
  const [optionsRef, optionsHeight] = useHeight(zoom);
  const insets = useMemo<Insets>(
    () => ({ top: topBarHeight, right: 0, bottom: toolbarHeight + optionsHeight, left: 0 }),
    [topBarHeight, toolbarHeight, optionsHeight],
  );
  const role = useRoomView((s) => s.you?.role ?? "player");
  usePreloadAndReopen(role);
  const ended = useRoomView((s) => s.ended);
  const roomId = useRoomView((s) => s.roomId);
  const gate = useRoomView(useShallow((s) => sceneGate({ view: s.view, sceneId: s.sceneId, role })));
  const { selectedId, panel, tab, tool: toolId, actionBar } = useRoomView(useShallow((s) => s.local));
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

  /*
   * Where focus goes once the render that follows a tap has drawn what the
   * tap asked for: the open panel (a phone's sheet at its heading, the side
   * panel's tab panel), or a tile in the list of panels. See the effect
   * after useDockFocus below.
   */
  const focusNext = useRef<{ kind: "panel" } | { kind: "tile"; panelId: string } | null>(null);

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
  const optionsShown = useRoomView((s) => (tool.optionsShown ? tool.optionsShown(s) : true));
  const sheet = !wide && panel ? panels.find((p) => p.id === panel) : undefined;
  const tabId = panelById(tab) && panels.some((p) => p.id === tab) ? tab : (panels[0]?.id ?? "");
  // New chat and whispers mark the Log's button while it is not on screen.
  const unread = useLogUnread(wide ? tabId === "log" : sheet?.id === "log");
  const journalUnread = useJournalUnread();
  const badges: Record<string, number> = { log: unread, journal: journalUnread };
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
  const togglePanels = () => {
    if (sheet || pickerOpen) closeSheets();
    else setPicker(true);
  };
  // Android's Back closes the sheet before it leaves the room (lib/backClose.ts).
  const sheetOpen = sheet !== undefined || pickerOpen;
  useBackClose(sheetOpen, closeSheets);
  /*
   * On a phone the token's action bar is the sheet a tap opened, so Back
   * closes it too, and with Select several on and the group's bar hidden it
   * ends the mode as Done does, so Back never leaves the room while a group
   * is held. Escape does the same everywhere. Neither ends the mode while
   * the token's panel shows the selection (state/selection.ts dismissal).
   */
  const tokenPanelShown = wide ? tabId === "token" : sheet?.id === "token";
  const away = useRoomView((s) => dismissal(s.local, tokenPanelShown));
  const putAway = useCallback(() => {
    const what = dismissal(store.getState().local, tokenPanelShown);
    if (what === "bar") ui.select(null);
    else if (what === "group") ui.doneSelecting();
  }, [store, ui, tokenPanelShown]);
  useBackClose(!wide && away !== null, putAway);
  useEscape(sheetOpen, closeSheets, tokenPanelShown);
  // Where the open sheet stands, read when Find my token is pressed, so the found token lands clear of it.
  const sheetRef = useRef<HTMLElement | null>(null);
  const [sheetEl, setSheetEl] = useState<HTMLElement | null>(null);
  const sheetElRef = useCallback((el: HTMLElement | null) => {
    sheetRef.current = el;
    setSheetEl(el);
  }, []);
  const openSheet = useCallback((): OpenSheet | null => {
    const rect = sheetRef.current?.getBoundingClientRect();
    return rect ? { placement: landscape ? "right" : "bottom", width: rect.width, height: rect.height } : null;
  }, [landscape]);
  // The subpage the open panel names (features/panels.ts usePanelHeader), for the sheet's or side panel's header.
  const [subpage, setSubpage] = useState<PanelHeader | null>(null);

  // ------------------------------------------------ the dock (pages/fold.ts)
  const dockStore = scope.get(dockSlot);
  const hasBar = useStore(dockStore, (s) => s.bar !== null);
  const summary = useDockSummary();
  const folded = foldsUnderSheet({ width, height, sheetOpen });
  const docked = folded && (hasBar || summary !== null);
  const safe = useSafeAreas();
  const dockInHeader = docked && !dockFits({ height, safeTop: safe.top, safeBottom: safe.bottom, insetTop: topInset, insetBottom: TOOLBAR });
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
  const sheetRight = landscape && sheetOpen ? Math.min(theme.layout.landscapeSheetWidth, width * 0.6) : 0;
  // Until both bars have a height, the bar keeps its defaults rather than reaching under them.
  const chrome = useMemo<Chrome | null>(
    () =>
      topBarHeight > 0 && toolbarHeight > 0
        ? {
            top: topBarHeight / zoom,
            bottom: (toolbarHeight + optionsHeight) / zoom,
            toolbar: toolbarHeight / zoom,
            safe: { top: safe.top, right: safe.right, bottom: safe.bottom, left: safe.left },
            sheet: sheetRight,
          }
        : null,
    [topBarHeight, toolbarHeight, optionsHeight, zoom, safe.top, safe.right, safe.bottom, safe.left, sheetRight],
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
  const mapWidth = wide ? width - theme.layout.sidePanelWidth : width;
  const free = freeArea({ width: mapWidth, height }, chrome ?? DEFAULT_CHROME);
  const beside = chrome ? noticePlace(free) : null;
  const besideLane = beside !== null;
  const previewNotice = previewing?.notice ?? null;
  const previewPush = !beside && previewNotice ? previewNotice.height / zoom + EDGE : 0;
  const reportsPreview = previewNotice !== null && !ended && gate.kind !== "blackout";
  useLayoutEffect(() => {
    if (!previewNotice || !reportsPreview) return;
    if (beside) {
      const room = beside.width * zoom;
      const noticeWidth = Math.min(PREVIEW_NOTICE_MAX, room);
      previewNotice.place({ left: beside.left * zoom + (room - noticeWidth) / 2, width: noticeWidth });
    } else {
      previewNotice.place(null);
    }
    return () => previewNotice.place(null);
  }, [previewNotice, reportsPreview, beside?.left, beside?.width, zoom]);
  const lastingRef = useRef<HTMLDivElement>(null);
  const laneTop = free.top;
  const previewBottom = previewPush > 0 ? laneTop + previewPush - EDGE : null;
  useLayoutEffect(() => {
    const lasting = lastingRef.current;
    if (!lasting || besideLane) {
      barDock.setState({ notices: null });
      return;
    }
    const measure = () => {
      const area = lasting.parentElement?.parentElement?.getBoundingClientRect();
      let bottom: number | null = previewBottom;
      for (const child of lasting.children) {
        const r = child.getBoundingClientRect();
        if (area && r.height > 0) bottom = Math.max(bottom ?? -Infinity, (r.bottom - area.top) / zoom);
      }
      if (barDock.getState().notices !== bottom) barDock.setState({ notices: bottom });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(lasting);
    for (const child of lasting.children) observer.observe(child);
    return () => observer.disconnect();
  }, [barDock, besideLane, previewBottom, zoom, role]);
  const columnSummary = useStore(barDock, (s) => s.bar?.lane === "summary") && summary !== null;
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
  useLayoutEffect(() => {
    const ask = focusNext.current;
    if (!ask) return;
    focusNext.current = null;
    if (ask.kind === "panel") (wide ? sideTabRef.current : sheetTitleRef.current)?.focus({ preventScroll: true });
    else sheetRef.current?.querySelector<HTMLElement>(`[data-opener="${panelTile(ask.panelId)}"]`)?.focus();
  });

  if (ended) return <EndedScreen ended={ended} roomId={roomId} role={role} />;
  // A blackout is for a break or a reveal (features section 13), so players
  // see nothing of the table: no map, panels, initiative strip, handouts or
  // toasts. sceneGate gives only players this kind, so a DM's room is unchanged.
  if (gate.kind === "blackout") return <PauseScreen />;

  const reserveTop = docked && !dockInHeader ? DOCK_PX + DOCK_GAP : undefined;
  const headerActions = dockInHeader ? <DockHeaderActions summary={summary} actions={dockActions} showRef={showRef} summaryRef={summaryRef} /> : undefined;
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
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <MapArea gate={gate} role={role} actionBar={actionBar} insets={insets} onSelect={select} onOpenDetails={openDetails} />
        {/* The map's focus target (mapFocus.ts): after the map, so its ring draws over it, and before the bars, so Tab from it goes on to them. Taps pass through it. */}
        <div ref={mapFocusRef} tabIndex={-1} role="img" aria-label="Map" style={MAP_FOCUS_STYLE} />
        <TopBar
          ref={topBarRef}
          zoom={zoom}
          canFit={gate.kind === "ready"}
          undo={role === "dm" && (!wide || touchFirst)}
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
            ...(beside ? { left: beside.left, width: beside.width, padding: 0 } : { left: 0, right: 0, padding: `0 ${theme.space(3)}px` }),
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
        {sheet ? (
          <Sheet
            ref={sheetElRef}
            title={sheet.title}
            placement={landscape ? "right" : "bottom"}
            inset={{ top: topInset, bottom: TOOLBAR }}
            onClose={() => ui.closePanel()}
            onBack={() => {
              focusNext.current = { kind: "tile", panelId: sheet.id };
              ui.closePanel();
              setPicker(true);
            }}
            backLabel="All panels"
            subpage={subpage}
            reserveTop={reserveTop}
            actions={headerActions}
            backRef={backRef}
            closeRef={closeRef}
            titleRef={sheetTitleRef}
          >
            <PanelBody id={sheet.id} selectedTokenId={selectedId} close={() => ui.closePanel()} onHeader={setSubpage} />
          </Sheet>
        ) : null}
        {pickerOpen ? (
          <Sheet
            ref={sheetElRef}
            title="Panels"
            placement={landscape ? "right" : "bottom"}
            inset={{ top: topInset, bottom: TOOLBAR }}
            onClose={() => setPicker(false)}
            reserveTop={reserveTop}
            actions={headerActions}
            backRef={backRef}
            closeRef={closeRef}
          >
            <PanelPicker
              panels={panels}
              current={tabId}
              badges={badges}
              onPick={(id) => {
                focusNext.current = { kind: "panel" };
                ui.openPanel(id);
              }}
            />
          </Sheet>
        ) : null}
        {/* After the sheet, so a test's or a screen reader's first "Close" in the page is still the sheet's (docs/design-v1-visual.md 5.4). */}
        {docked && !dockInHeader ? <DockRow zoom={zoom} sheetHeight={sheetHeight} summary={summary} actions={dockActions} showRef={showRef} summaryRef={summaryRef} /> : null}
        {tool.Options && optionsShown && !sheet && !pickerOpen ? <OptionsBar ref={optionsRef} tool={tool} role={role} wide={wide} zoom={zoom} /> : null}
        <Toolbar
          ref={toolbarRef}
          zoom={zoom}
          wide={wide}
          tools={tools}
          tool={tool.id}
          onTool={(id) => ui.setTool(id)}
          panelsOpen={sheet !== undefined || pickerOpen}
          onPanels={togglePanels}
          unread={unread + journalUnread}
        />
      </div>
      {wide ? (
        <SidePanel zoom={zoom} tabs={panels} tab={tabId} badges={badges} onTab={(id) => ui.openPanel(id)} subpage={subpage} tabRef={sideTabRef}>
          {tabId ? <PanelBody id={tabId} selectedTokenId={selectedId} close={() => ui.closePanel()} onHeader={setSubpage} /> : null}
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
    const onIn = (e: FocusEvent) => {
      lastFocus.current = e.target instanceof Element ? e.target : null;
    };
    // Focus that moved to the page because of a tap elsewhere, not because its element was folded away.
    const onOut = (e: FocusEvent) => {
      if (e.relatedTarget === null && e.target instanceof Element && drawn(e.target)) lastFocus.current = null;
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
 * Undo and Redo on a touch screen, Find my token and Fit map. The
 * initiative strip sits in its row or in a band of its own under it
 * (`placement`, features/encounter/band.ts). `compact` keeps only the
 * tight gaps, the name's way of giving way first, and the phase menu's
 * absence, which a phone's bar has no room for.
 *
 * A phone's bar checks whether its row overflows (scrollWidth past
 * clientWidth). Where the bar holds the strip, it records it, so the strip
 * goes back to the band until the layout is wider than that. Where the row
 * still overflows without the strip, the DM's chip keeps only its dot, as
 * a player's does, again until the layout is wider: on a 320 px phone at
 * 130% the whole chip pushed Fit off the screen. The row's own box keeps
 * its size when its content grows, so the check runs when the row's size
 * changes (the window), when the strip's size changes (whose turn, "Your
 * turn" and End turn, the timer), and when the bar's other content changes
 * (the room name, the blackout pill).
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
  const activeEntryId = useRoomView((s) => s.view?.encounter?.activeEntryId ?? null);
  const round = useRoomView((s) => s.view?.encounter?.round ?? null);
  const notice = useYourTurnNotice();
  const rowRef = useRef<HTMLDivElement>(null);
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const recordOverflow = useRecordOverflow();
  const { width } = useLayoutSize();
  // The layout width at which the DM's whole chip last overflowed the row: up to it, the chip is its dot.
  const [dmDotUpTo, setDmDotUpTo] = useState(0);
  const dmDot = props.compact && role === "dm" && width <= dmDotUpTo;
  // From 900 px up the strip sits in the bar whatever it holds, so only a phone's bar measures.
  const measured = props.placement === "bar" && props.compact;
  const check = useCallback(() => {
    const row = rowRef.current;
    if (!props.compact || !row) return;
    // The last button tucks into the bar's padding by a negative margin (RoomChrome.tsx FitButton), which is room the row has, not overflow.
    const last = row.lastElementChild;
    const tuck = last ? Math.max(0, -parseFloat(getComputedStyle(last).marginRight) || 0) : 0;
    const overflow = row.scrollWidth - row.clientWidth - tuck;
    if (overflow <= 0) return;
    // The strip leaves first. Once it is in the band, this runs again with the row it left.
    if (measured) recordOverflow(layoutWidth(), overflow);
    else if (role === "dm" && !dmDot) setDmDotUpTo(layoutWidth());
  }, [props.compact, measured, recordOverflow, role, dmDot]);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!props.compact || !row) return;
    const observer = new ResizeObserver(check);
    observer.observe(row);
    if (strip) observer.observe(strip);
    return () => observer.disconnect();
  }, [props.compact, strip, check]);
  useLayoutEffect(check, [check, name, blackout, role, activeEntryId, round, notice]);
  return (
    <header
      ref={props.ref}
      {...smallUi(props.zoom)}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: theme.z.bars,
        padding: `${theme.safe.top} calc(${theme.safe.right} + ${theme.space(3)}px) 0 calc(${theme.safe.left} + ${theme.space(3)}px)`,
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
        {props.compact ? null : <PhaseMenu />}
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

function Banner() {
  const connection = useRoomView((s) => s.connection);
  return (
    <div style={{ pointerEvents: "auto", width: "100%", maxWidth: 520, minWidth: 0 }}>
      <ReconnectBanner state={connection} />
    </div>
  );
}

/** Refusals and notices from the store (design 7.4), each gone after a few seconds or a tap, in the Notice look (components/Notice.tsx). */
function Toasts() {
  const toasts = useRoomView((s) => s.toasts);
  const ui = useRoomUi();
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) => setTimeout(() => ui.dismissToast(t.id), TOAST_MS));
    return () => timers.forEach(clearTimeout);
  }, [toasts, ui]);
  if (toasts.length === 0) return null;
  return (
    <>
      {toasts.map((t) => {
        const tone = NOTICE_TONES[t.tone === "error" ? "danger" : "info"];
        return (
          <button
            key={t.id}
            type="button"
            role="status"
            onClick={() => ui.dismissToast(t.id)}
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
      })}
    </>
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
 */
function OptionsBar(props: { ref?: Ref<HTMLDivElement>; tool: ToolDef; role: "dm" | "player"; wide: boolean; zoom: number }) {
  const Options = props.tool.Options;
  if (!Options) return null;
  return (
    <div
      ref={props.ref}
      role="toolbar"
      aria-label={`${props.tool.label} options`}
      {...smallUi(props.zoom)}
      style={{
        ...chromeZoom(props.zoom),
        position: "absolute",
        left: props.wide ? theme.space(2) : 0,
        right: props.wide ? undefined : 0,
        bottom: `calc(${theme.safe.bottom} + ${TOOLBAR}px)`,
        zIndex: theme.z.options,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: theme.space(2),
        minHeight: theme.touch + theme.space(2),
        maxWidth: props.wide ? 640 : undefined,
        padding: `${theme.space(1)}px calc(${theme.safe.right} + ${theme.space(2)}px) ${theme.space(1)}px calc(${theme.safe.left} + ${theme.space(2)}px)`,
        background: theme.color.overlay,
        // Longhands only: React warns when a rerender changes a shorthand mixed with its longhands, as crossing the wide breakpoint did.
        borderTop: `${theme.line.border}px solid ${theme.color.border}`,
        borderRight: props.wide ? `${theme.line.border}px solid ${theme.color.border}` : "none",
        borderBottom: props.wide ? `${theme.line.border}px solid ${theme.color.border}` : "none",
        borderLeft: props.wide ? `${theme.line.border}px solid ${theme.color.border}` : "none",
        borderRadius: props.wide ? theme.radius.md : 0,
        // Rows wrap (measure/controls.tsx), so the bar grows upward. Past
        // half the screen it scrolls, so the map always keeps the other half.
        maxHeight: screenHeight(50),
        overflowX: "auto",
        overflowY: "auto",
      }}
    >
      <LoadBoundary key={props.tool.id} fallback={(f) => <RoomLoadNotice {...f} subject="These options" verb="load" compact reopen={{ tool: props.tool.id }} />}>
        <Options role={props.role} />
      </LoadBoundary>
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
  /** Unread messages in the Log and unread journal pages, which sit behind the Panels button on phones. */
  unread: number;
}) {
  const { wide, tools } = props;
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
        padding: `0 calc(${theme.safe.right} + ${theme.space(1)}px) ${theme.safe.bottom} calc(${theme.safe.left} + ${theme.space(1)}px)`,
        background: wide ? "transparent" : theme.color.overlay,
        borderTop: wide ? "none" : `${theme.line.border}px solid ${theme.color.border}`,
        pointerEvents: wide ? "none" : "auto",
        ...chromeZoom(props.zoom),
      }}
    >
      <ScrollStrip active={props.tool} style={{ flex: "1 1 auto", height: "100%" }}>
        {tools.map((t) => (
          <ToolButton key={t.id} label={t.label} active={props.tool === t.id} onClick={() => props.onTool(t.id)} floating={wide} iconOnly>
            {wide ? <ToolIcon tool={t} /> : <Stacked icon={<ToolIcon tool={t} />} text={t.shortLabel ?? t.label} />}
          </ToolButton>
        ))}
      </ScrollStrip>
      {wide ? null : (
        <div style={{ flex: "none", display: "flex", alignItems: "center", height: "100%", paddingLeft: theme.space(1), borderLeft: `${theme.line.border}px solid ${theme.color.border}` }}>
          <ToolButton label="Panels" active={props.panelsOpen} onClick={props.onPanels}>
            <Stacked
              icon={
                <svg aria-hidden viewBox="0 0 24 24" width={22} height={22} style={{ display: "block" }}>
                  <path d="M4 5h16v2H4zm0 6h16v2H4zm0 6h16v2H4z" fill="currentColor" />
                </svg>
              }
              text="Panels"
            />
            <Badge count={props.unread} corner />
          </ToolButton>
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
 */
function PanelPicker(props: { panels: PanelDef[]; current: string; badges: Record<string, number>; onPick(id: string): void }) {
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
      {props.panels.map((p) => {
        const current = p.id === props.current;
        const count = props.badges[p.id] ?? 0;
        return (
          <li key={p.id}>
            <Row
              opener={panelTile(p.id)}
              title={p.title}
              trailing={count > 0 ? <Badge count={count} /> : undefined}
              chosen={current}
              onClick={() => props.onPick(p.id)}
              style={{ minHeight: 52, ...(current ? { color: theme.color.accent } : null) }}
            />
          </li>
        );
      })}
    </ul>
  );
}

function ToolButton(props: { label: string; active: boolean; onClick(): void; floating?: boolean; iconOnly?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      data-active={props.active}
      aria-pressed={props.active}
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

/** A side panel tab: the chosen one in the pressed look, as every other chosen option (docs/design-v1-visual.md 3.2). */
const TAB_REST: CSSProperties = { background: "transparent", border: `${theme.line.border}px solid transparent`, color: theme.color.textMuted };

/**
 * The side panel from 900 px up: the party bar, the tabs, and the open
 * panel. While the panel shows a subpage (features/panels.ts
 * usePanelHeader), a header above it names the subpage with "Back to" its
 * panel, and focus follows it in and out (useSubpageFocus). With no
 * subpage there is no header, since the chosen tab already names the panel.
 */
function SidePanel(props: {
  zoom: number;
  tabs: PanelDef[];
  tab: string;
  badges: Record<string, number>;
  onTab(id: string): void;
  subpage: PanelHeader | null;
  /**
   * The chosen tab, which takes focus from script when Details opens the
   * token's panel: "Token, tab, selected". The tab panel itself takes no
   * focus, so a click on its blank space leaves Space free to pan the map.
   */
  tabRef: RefObject<HTMLButtonElement | null>;
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
  /*
   * The ARIA tab pattern, which role="tab" promises a screen reader: the
   * row is one Tab stop, the chosen tab (roving tabindex), and Left, Right,
   * Home and End move along it and choose. The map's arrow shortcuts stand
   * aside on a tab list (state/shortcuts.ts ownsNavigationKeys).
   */
  const stop = props.tabs.some((t) => t.id === props.tab) ? props.tab : props.tabs[0]?.id;
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const at = props.tabs.findIndex((t) => tabId(t.id) === (e.target as HTMLElement).id);
    const index = at === -1 ? null : tabKeyIndex(e.key, at, props.tabs.length);
    const next = index === null ? undefined : props.tabs[index];
    if (!next) return;
    e.preventDefault();
    props.onTab(next.id);
    document.getElementById(tabId(next.id))?.focus();
  };
  return (
    <aside
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
      <PartyDock />
      <div
        role="tablist"
        aria-label="Panels"
        onKeyDown={onTabKey}
        style={{ display: "flex", flexWrap: "wrap", gap: theme.space(0.5), padding: theme.space(2), borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}
      >
        {props.tabs.map((t) => {
          const chosen = props.tab === t.id;
          return (
            <button
              key={t.id}
              ref={chosen ? chosenTabRef : undefined}
              id={tabId(t.id)}
              type="button"
              role="tab"
              aria-selected={chosen}
              aria-controls={chosen ? panelId : undefined}
              tabIndex={t.id === stop ? 0 : -1}
              onClick={() => props.onTab(t.id)}
              style={{
                flex: "none",
                minHeight: theme.touch,
                minWidth: theme.touch,
                padding: `0 ${theme.space(2)}px`,
                borderRadius: theme.radius.md,
                ...(chosen ? PRESSED : TAB_REST),
                fontFamily: theme.font.body,
                fontSize: theme.font.body14,
                fontWeight: theme.weight.strong,
                cursor: "pointer",
              }}
            >
              {t.title}
              <Badge count={props.badges[t.id] ?? 0} />
            </button>
          );
        })}
      </div>
      {props.subpage ? (
        <div style={{ flex: "none", borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
          <SheetHeader title={props.subpage.title} back={subpageBack(props.subpage)} titleRef={titleRef} />
        </div>
      ) : null}
      <div ref={bodyRef} id={panelId} role="tabpanel" aria-labelledby={tabId(props.tab)} style={{ flex: 1, overflowY: "auto", padding: theme.space(4) }}>
        {props.children}
      </div>
    </aside>
  );
}
