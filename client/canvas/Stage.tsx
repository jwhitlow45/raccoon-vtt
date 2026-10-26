import { applyPixelRatio } from "./konvaSetup.ts";
import { popoverSlot } from "../components/popoverRules.ts";
import type Konva from "konva";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Layer, Stage } from "react-konva";
import { DEFAULT_SETTINGS, type RoomState, type Scene, type Token } from "#shared/model.ts";
import { holderOf as linkedHolder, linkHolds } from "#shared/rules/attach.ts";
import { labelBox } from "#shared/rules/labels.ts";
import { activeTool, type ToolContext, type ToolDef, type ToolPointer } from "../features/tools.ts";
import { LabelPaneHost } from "../features/builder/LabelPaneHost.tsx";
import { ReadoutHost } from "../features/builder/heights/ReadoutHost.tsx";
import { measureLabel as measureMapLabel } from "../features/builder/draw.ts";
import { turnFocus, useFollowTurn } from "../features/encounter/followTurn.ts";
import { panAnchor, requestPan, watchPans } from "../features/encounter/pan.ts";
import { stageCameraSlot } from "../features/scenes/stageCamera.ts";
import { CONTROLLERS, layersOf, type LayerProps } from "../features/layers.ts";
import { displayViewKey, viewKey } from "../features/view/store.ts";
import { LightPaneHost } from "../features/lights/LightPaneHost.tsx";
import { PinPaneHost } from "../features/pins/PinPaneHost.tsx";
import { TrapPaneHost } from "../features/traps/TrapPaneHost.tsx";
import { DoorPillHost } from "../features/doors/DoorPill.tsx";
import { onHoldPing } from "../features/pings/hold.ts";
import { StopNoteHost } from "../features/movement/StopNote.tsx";
import { SightOverlay } from "../features/vision/SightOverlay.tsx";
import { useDrawnFogTiles, useSightMode } from "../features/vision/stageHooks.ts";
import {
  barShift,
  cameraAt,
  cameraForView,
  holdStill,
  fitRect,
  keepInView,
  NO_INSETS,
  panBy,
  rectClear,
  sameCamera,
  sceneMinScale,
  screenToView,
  viewToScreen,
  wheelZoomFactor,
  zoomAt,
  type Camera,
  type Insets,
  type Point,
  type Rect,
  type Size,
} from "../lib/camera.ts";
import { groundAtMiddle, TOP_DOWN, toView, toWorld, viewBox, type Live, type View, type ViewPoint } from "../lib/view.ts";
import { ellipseBox } from "./relief/standee.ts";
import { isAppleDevice } from "../lib/device.ts";
import { fitTarget } from "../lib/fitTarget.ts";
import { revealedMask } from "../lib/fogTiles.ts";
import { CameraGesture, distance, LongPress, mousePans, TAP_SLOP_PX } from "../lib/gestures.ts";
import { groupFollowers, tokensInBox } from "../lib/group.ts";
import { displayName, drawsAboveFog, footprint, snapPosition, type ViewToken } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
import { BoardViewContext, boardViewsOf, useBoardPills } from "./boardView.ts";
import { useBoardFontEpoch } from "./boardFont.ts";
import { useBoardText, type TokenText } from "./useBoardText.ts";
import { ownsToken as memberOwns } from "../features/tokens/access.ts";
import { followOps, lastMoveSlot } from "../features/tokens/undoMove.ts";
import type { DropPlan } from "../features/movement/drop.ts";
import { useDragStops } from "../features/movement/stageHooks.ts";
import { carriesText, dragLead, dragNamed, drawOrder, drawsInset, groupMembers, holderMiddles, pressLead, reseatText, type CellBox } from "../features/attach/groups.ts";
import { dragsToken, movesToken, reseats, type AttachViewer, type RightsView } from "../features/attach/rights.ts";
import { cameraInZoomed, chromeZoom, insetsInZoomed, inZoomed, layoutSize, sizeInZoomed, smallUi } from "../features/device/layout.ts";
import { stageMountKey, uiScale, useLowPower, useMapVariant, useUiScale } from "../features/device/settings.ts";
import { mapFocusSlot, spaceMovesMap } from "../pages/mapFocus.ts";
import { localDragSlot } from "../state/localDrags.ts";
import { useRoomScope } from "../state/scope.ts";
import { addsToSelection, barDismiss } from "../state/selection.ts";
import { stageKeysSlot } from "../state/shortcuts.ts";
import { sheetOpen as sheetIsOpen, type Opening } from "../state/types.ts";
import { dockSlot, foldsUnderSheet, sideSheetRoom } from "../pages/fold.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../state/view.ts";
import { droppedIntoFog, intoFogText, refusedDragText, watchDrop } from "./dragNotes.ts";
import { barChrome, barCover, barDockSlot, clearAnchor, DOCK_MIN_WIDTH, keepsOpening, largerEach, pastBars, restingBar, stripSqueezed, type BarSubject } from "./barDock.ts";
import { emptyTap, putAway } from "./emptyTap.ts";
import { canDragToken, movesOthers } from "./dragRights.ts";
import { fitSlot } from "./fitSlot.ts";
import { FogShape } from "./FogShape.tsx";
import { MapLayer } from "./layers/MapLayer.tsx";
import { createEasedDrags, RemoteDragClock, RemoteDrags } from "./RemoteDrags.tsx";
import { IsoBoard } from "./relief/IsoBoard.tsx";
import { useTestView } from "./relief/isoTest.ts";
import { placedTextBoxes } from "./textBoxes.ts";
import { GroupActionBar, TokenActionBar } from "./TokenActionBar.tsx";
import { TokenDecor, TokenInteractionContext, TokenNode, type IsoToken, type TokenInteraction } from "./TokenNode.tsx";

const EMPTY_TOKENS: Record<string, Token> = {};
/** How long after a new size the fitted map follows the measures of the new layout as they arrive. */
const SETTLE_MS = 1_000;
const EMPTY_TILES: RoomState["fogTiles"] = {};
const EMPTY_MAP_LABELS: RoomState["labels"] = {};
const NOT_CARRIED: ReadonlySet<string> = new Set();
const APPLE = isAppleDevice();
const BOARD_LAYERS = layersOf("board");
const OVERLAY_LAYERS = layersOf("overlay");
const UNDER_DECOR_LAYERS = layersOf("underDecor");

/**
 * Holds a drawing tree still while it is hidden, so a camera move renders
 * only the tree on screen (docs/design-v1-isometric-view.md ISO-D15). Its
 * last render, the one that hid it, sized its stage 0x0.
 */
const Frozen = memo(
  function Frozen(props: { frozen: boolean; children: ReactNode }) {
    return <>{props.children}</>;
  },
  (prev, next) => prev.frozen && next.frozen,
);

/** What a drag that starts on a token moves (docs/design-v1-attach.md 4.2). */
type DragParts = {
  /** The token whose move goes out and whose walk is searched: the pressed one, or the mount a rider's press moves. */
  lead: ViewToken;
  /** The tokens the drop names, the lead first. Empty when it moves nothing. */
  named: ViewToken[];
  /** The named token each moving token goes with, for where it lands. */
  rootOf: Map<string, string>;
  /** Why the drag moves nothing, said as it starts. */
  refusal: string | null;
  /** A player may move the lead only to a new seat on its holder, or within reach of it. */
  reseatOnly: boolean;
};

/** The lead's place as a node, while the finger drags another token of its group: the same offset either way. */
function offsetNode(node: Konva.Node, pressed: ViewToken, lead: ViewToken): { x(): number; y(): number; position(p: Point): void } {
  return {
    x: () => node.x() - pressed.x + lead.x,
    y: () => node.y() - pressed.y + lead.y,
    position: (p) => node.position({ x: p.x - lead.x + pressed.x, y: p.y - lead.y + pressed.y }),
  };
}

function sceneRect(scene: Scene) {
  return { x: 0, y: 0, width: scene.bounds.w, height: scene.bounds.h };
}

/**
 * A fitted camera, the canvas and scene sizes it was fitted to, and what it
 * fits: a part of the scene (a player's "Fit map" under fog), or the whole
 * scene when `target` is null, which follows the scene's size. `cover` is
 * the docked token bar's cover the fit kept clear of (canvas/barDock.ts
 * barCover), kept with it, so the bar opening or closing later never moves
 * the fitted map, while the bars over the map growing still refit it. A new
 * canvas size or interface size (`zoom`) places the bar anew for the refit.
 */
type Fit = { cam: Camera; key: string; target: Rect | null; cover: Insets; zoom: number };

function fitKey(size: Size, scene: Scene): string {
  return `${size.width}x${size.height}:${scene.bounds.w}x${scene.bounds.h}`;
}

function fitScene(size: Size, scene: Scene, insets: Insets, view: View, target: Rect | null = null, cover: Insets = NO_INSETS): Fit {
  return { cam: fitRect(size, viewBox(view, target ?? sceneRect(scene)), 24, largerEach(insets, cover)), key: fitKey(size, scene), target, cover, zoom: uiScale() };
}

/**
 * The map canvas (design section 14.2): at most four Konva layers.
 *
 * 1. map: background, map image, grid. Never listens.
 * 2. board: the `board` renderers from client/features/layers.ts (builder,
 *    drawings, areas). Mounted only when a feature registers one.
 * 3. tokens: every token that sits below the fog, then other members' drag
 *    previews, so a creature dragged into the dark stays under the fog.
 * 4. overlay: the fog image, the tokens drawn above it (the party and
 *    exempt tokens, section 13.3), the `underDecor` renderers (the height
 *    pills), every token's chips, labels and plates, then the `overlay`
 *    renderers (rulers, pings, laser, AoE previews).
 *
 * Input: two fingers always move the camera, and so does a mouse drag with
 * the middle or right button, or the left with Space held. One finger goes
 * to the active tool from client/features/tools.ts, and a tool without
 * pointer handlers gets the select behavior below (tap selects, drag a
 * token, drag the map to pan).
 *
 * Nothing animates at rest. React re-renders the layers whose inputs changed
 * and Konva redraws only those. The camera changes at most once per
 * animation frame during a gesture.
 */
export function MapStage(props: {
  scene: Scene;
  fog: boolean;
  role: "dm" | "player";
  /** Whether the selected token's action bar shows. */
  actionBar: boolean;
  /** Screen pixels the Room page's bars cover along each side, which a fitted scene keeps clear of. */
  insets?: Insets;
  /** The same for the panes over the map, which stand on the on-screen keyboard while it is open (pages/Room.tsx `paneInsets`). The map's fit never takes it. */
  paneInsets?: Insets;
  /** A tap on a token or on empty map. `add` adds the token to the selection or takes it out. */
  onSelect(tokenId: string | null, add?: boolean): void;
  onOpenDetails(tokenId: string): void;
  /** Whether the token's panel shows the selection, where the bar's Close hides the bar and keeps the token (state/selection.ts barDismiss). */
  tokenPanelShown?: boolean;
  /** Hides the bar and keeps the token, sending focus to its panel (pages/Room.tsx). */
  onHideBar?(): void;
  /**
   * A table display's camera (features/display): when set, the canvas shows
   * what it gives for the canvas size, again whenever it or the size
   * changes. A display takes no input, so nothing else moves it but the
   * DM's "look here" when `ignoreFocus` is off.
   */
  controlledCamera?: ((viewport: Size) => Camera) | null;
  /** Leaves the DM's focus events unfollowed, for a display fitting the map. */
  ignoreFocus?: boolean;
}) {
  const { scene, fog, role, actionBar, onSelect, onOpenDetails } = props;
  const insets = props.insets ?? NO_INSETS;
  const paneInsets = props.paneInsets ?? insets;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const store = useRoomStore();
  const scope = useRoomScope();
  const popovers = scope.get(popoverSlot);
  const youId = useRoomView((s) => s.you?.memberId ?? null);
  const allTokens = useRoomView((s) => s.view?.tokens ?? EMPTY_TOKENS);
  const characters = useRoomView((s) => s.view?.characters);
  const members = useRoomView((s) => s.view?.members);
  const fogTiles = useRoomView((s) => s.view?.fogTiles ?? EMPTY_TILES);
  const drawnFogTiles = useDrawnFogTiles(fogTiles, role);
  const sightMode = useSightMode(scene, role);
  const settings = useRoomView((s) => s.view?.meta.settings);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const selectedId = useRoomView((s) => s.local.selectedId);
  const selectedIds = useRoomView((s) => s.local.selectedIds);
  const multi = useRoomView((s) => s.local.multi);
  const toolId = useRoomView((s) => s.local.tool);
  const focus = useRoomView((s) => s.ephemeral.focus);
  const tool = activeTool(toolId, role);
  const selecting = !tool.pointer;
  /*
   * The view the board shows: Top-down, until the isometric view's choice
   * ships (features/view/store.ts isoReady). Only a test or the bench
   * reaches Isometric before then (relief/isoTest.ts). Its tree mounts the
   * first time it shows and stays (ISO-D15).
   */
  const roomId = useRoomView((s) => s.roomId);
  const testView = useTestView(props.controlledCamera ? displayViewKey(roomId) : viewKey(roomId), scene.id, scene.suggestedView);
  const shown: View = testView ?? TOP_DOWN;
  const isoShown = shown.kind === "isometric";
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const isoEverRef = useRef(false);
  if (isoShown) isoEverRef.current = true;
  const [isoStage, setIsoStage] = useState<Konva.Stage | null>(null);
  /** Other members' drags, eased by one clock for both drawing trees. */
  const [eased] = useState(createEasedDrags);

  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [cam, setCam] = useState<Camera | null>(null);
  const camRef = useRef<Camera | null>(null);
  camRef.current = cam;
  const cameraSceneRef = useRef<string | null>(null);
  /**
   * The last fit, while its camera is still the one on screen. The fitted
   * scene then follows the canvas size, and moves clear of a bar that grew
   * over it (a tool's options appearing or wrapping). A bar that shrank
   * leaves it be, so changing a tool's options never moves the map for
   * nothing. Any other camera move ends all this.
   */
  const fittedRef = useRef<Fit | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** The tokens this device's drag carries, which draw their own decorations so they travel with them. */
  const [carried, setCarried] = useState<ReadonlySet<string>>(NOT_CARRIED);
  /** The camera a gesture asked for, shown on the next animation frame. */
  const pendingCamRef = useRef<Camera | null>(null);
  const frameRef = useRef(0);
  // Low power loads the phone size map on every device (features/device/settings.ts).
  const variant = useMapVariant();
  const lowPower = useLowPower();

  // The canvas fills its box. A rotation or a docked panel resizes it, and the
  // world point at the center stays at the center.
  const sizeRef = useRef<Size | null>(null);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) };
      const prev = sizeRef.current;
      if (prev && prev.width === next.width && prev.height === next.height) return;
      sizeRef.current = next;
      const c = pendingCamRef.current ?? camRef.current;
      const fitted = c !== null && fittedRef.current !== null && sameCamera(c, fittedRef.current.cam);
      if (prev && c && !fitted) {
        pendingCamRef.current = null;
        setCam({ ...c, x: c.x + (next.width - prev.width) / 2, y: c.y + (next.height - prev.height) / 2 });
      }
      setSize(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The Scenes panel and the grid tool read the camera through this Room's scope.
  useEffect(() => {
    const slot = scope.get(stageCameraSlot);
    const read = () => {
      const c = pendingCamRef.current ?? camRef.current;
      const s = sizeRef.current;
      return c && s ? { camera: { x: c.x, y: c.y, scale: c.scale }, viewport: { width: s.width, height: s.height }, view: shownRef.current } : null;
    };
    slot.read = read;
    return () => {
      if (slot.read === read) slot.read = null;
    };
  }, [scope]);

  /*
   * A new scene starts at its saved view, or fitted to the screen. The
   * camera is seen at once, as the refit's is: the active tool activates
   * again for the new scene in this same commit, before the render that
   * would hand camRef the new camera, and Line up grid centers its box on
   * the view. Read later, the last scene's view put the box off this
   * scene's image.
   */
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  useLayoutEffect(() => {
    if (!size || cameraSceneRef.current === scene.id) return;
    cameraSceneRef.current = scene.id;
    pendingCamRef.current = null;
    let next: Camera;
    if (scene.defaultView) {
      fittedRef.current = null;
      next = cameraForView(size, toView(shownRef.current, scene.defaultView), scene.defaultView.zoom);
    } else {
      fittedRef.current = fitScene(size, scene, insetsRef.current, shownRef.current);
      next = fittedRef.current.cam;
    }
    camRef.current = next;
    setCam(next);
  }, [size, scene]);

  /*
   * A turn or a view switch keeps the world point at the canvas's middle
   * still on screen, and the zoom (docs/design-v1-isometric-view.md 4.2),
   * on this device only.
   */
  const viewSeenRef = useRef(shown);
  useLayoutEffect(() => {
    const before = viewSeenRef.current;
    viewSeenRef.current = shown;
    if (before === shown) return;
    const c = pendingCamRef.current ?? camRef.current;
    const s = sizeRef.current;
    if (!c || !s) return;
    const middle = groundAtMiddle({ camera: c, viewport: s, view: before });
    const next = holdStill(c, toView(before, middle), toView(shown, middle));
    pendingCamRef.current = null;
    fittedRef.current = null;
    camRef.current = next;
    setCam(next);
  }, [shown]);

  /*
   * What the token action bar covers of the map, in screen pixels
   * (canvas/barDock.ts barCover), for Fit, Find and the pans that bring a
   * token into view. A bar counts by the box it published: an upright
   * phone's strip, or its expanded bar, covers the map's foot from its top
   * (docs/design-v1-bar-compact.md 4). `opening` also counts a bar the change that asked for the move
   * is about to show, as a tracker row's tap does: its box does not exist
   * yet, so it rests at its spot with the height it last had. `fresh`
   * places it anew for the canvas as it is now, as a refit after a
   * rotation needs, since the box it published was for the old size, and
   * `shows` then says whether the bar showed when the size changed.
   */
  const barShowsRef = useRef<() => boolean>(() => false);
  barShowsRef.current = () => {
    // Whether the bar shows follows the room's state at once, ahead of the render that draws or removes it.
    const local = store.getState().local;
    const full = scope.get(dockSlot).getState().sheetFull;
    const layout = layoutSize(window, uiScale());
    const sideRoom = sideSheetRoom(layout, scope.get(barDockSlot).getState().chrome);
    return local.actionBar && local.selectedId !== null && !activeTool(local.tool, role).pointer && !foldsUnderSheet({ ...layout, sheetOpen: sheetIsOpen(local), full, sideRoom });
  };
  const barCoverRef = useRef<(viewport: Size, source: "drawn" | "opening" | "fresh", shows?: boolean) => Insets>(() => NO_INSETS);
  barCoverRef.current = (viewport, source, shows = barShowsRef.current()) => {
    const dock = scope.get(barDockSlot).getState();
    const z = uiScale();
    const layout = layoutSize(window, z);
    if (!shows) return NO_INSETS;
    const resting = () => {
      const chrome = barChrome(dock);
      const zoomed = sizeInZoomed(viewport, z);
      // A roll card that folds for a held strip leaves the strip on the toolbar (barDock.ts stripSqueezed).
      const restFoot = stripSqueezed({ viewport: zoomed, chrome, foot: dock.foot, held: dock.heldMode === "span" }) ? 0 : dock.foot;
      return restingBar({ layout, viewport: zoomed, chrome, spot: dock.spot, height: dock.lastHeight, foot: dock.foot, column: dock.column, width: dock.defaultWidth, size: dock.size, resizable: dock.finePointer, heldMode: dock.heldMode, cardAt: dock.cardAt, restFoot, state: dock.expanded ? "expanded" : "rest", expandedHeight: dock.expandedHeight });
    };
    const bar = source === "fresh" ? resting() : dock.bar ? dock.bar : source === "opening" ? resting() : null;
    if (!bar) return NO_INSETS;
    const box = { left: bar.box.left * z, top: bar.box.top * z, width: bar.box.width * z, height: bar.box.height * z };
    return barCover(viewport, insetsRef.current, { box, laneLeft: bar.laneLeft * z, freeRight: bar.freeRight * z, mode: bar.mode });
  };

  /*
   * The fitted map follows the canvas and the bars over it. A new size or
   * interface size, a rotation say, also places the token bar anew: the
   * cover the fit kept was for the old layout, and could now cover the
   * whole screen, or belong to a bar that spans now and covers nothing for
   * the map. The new layout's measures arrive over the next frames, after
   * this canvas's own: Room's bars, the turn band that may move between the
   * top bar and its own row, the alerts column's cards. So for a moment
   * after such a change (`settle`) every one of them fits the map again
   * against the bar placed afresh, whether or not the bar has opened or
   * closed since, which never moves a fitted map. Once the moment is over,
   * or the viewer moved the camera, the fit keeps the cover it had.
   */
  const settleRef = useRef<{ until: number; shows: boolean } | null>(null);
  const refitRef = useRef(() => {});
  refitRef.current = () => {
    const s = sizeRef.current;
    const current = sceneRef.current;
    const bars = insetsRef.current;
    const fitted = fittedRef.current;
    const c = pendingCamRef.current ?? camRef.current;
    if (!s || !fitted || !c || !sameCamera(c, fitted.cam) || cameraSceneRef.current !== current.id) return;
    const now = performance.now();
    const z = uiScale();
    if (fitKey(s, current) !== fitted.key || z !== fitted.zoom) settleRef.current = { until: now + SETTLE_MS, shows: barShowsRef.current() };
    const settle = settleRef.current && now <= settleRef.current.until ? settleRef.current : null;
    const next = fitScene(s, current, bars, shownRef.current, fitted.target, settle ? barCoverRef.current(s, "fresh", settle.shows) : fitted.cover);
    if (!settle && rectClear(c, viewBox(shownRef.current, fitted.target ?? sceneRect(current)), s, largerEach(bars, fitted.cover))) return;
    fittedRef.current = next;
    if (sameCamera(next.cam, c)) return;
    // Seen at once, so a second measure in the same frame still finds the camera it fitted.
    camRef.current = next.cam;
    setCam(next.cam);
  };
  const { top, right, bottom, left } = insets;
  useLayoutEffect(() => refitRef.current(), [size, scene, top, right, bottom, left]);
  useEffect(
    () =>
      scope.get(barDockSlot).subscribe((now, before) => {
        if (now.chrome === before.chrome && now.column === before.column && now.bar === before.bar && now.foot === before.foot) return;
        if (settleRef.current && performance.now() <= settleRef.current.until) refitRef.current();
      }),
    [scope],
  );

  // How far out this scene zooms (camera.ts sceneMinScale), for the pinch and the wheel.
  useEffect(() => {
    if (size) gestureRef.current.minScale = sceneMinScale(size, scene.bounds);
  }, [size, scene.bounds]);

  // The top bar's "Fit map" button (fitSlot.ts, lib/fitTarget.ts). Its fit
  // keeps clear of the bars and the token bar, and follows the bars like a
  // scene's first fit.
  useEffect(() => {
    const slot = scope.get(fitSlot);
    const fit = () => {
      const s = sizeRef.current;
      if (!s) return;
      const current = sceneRef.current;
      const player = role === "player";
      const revealed = player && fogRef.current.on ? revealedMask(current.bounds, current.id, fogRef.current.tiles) : null;
      const own = player
        ? [...tokensByIdRef.current.values()].filter((t) => ownsTokenRef.current(t)).map((t) => ({ x: t.x, y: t.y, width: footprint(t).w, height: footprint(t).h }))
        : [];
      const target = fitTarget({ bounds: current.bounds, revealed, own });
      const whole = target.width === current.bounds.w && target.height === current.bounds.h;
      fittedRef.current = fitScene(s, current, insetsRef.current, shownRef.current, whole ? null : target, barCoverRef.current(s, "drawn"));
      pendingCamRef.current = null;
      setCam(fittedRef.current.cam);
    };
    // "Find my token" (features/find/findToken.ts). A plain camera rather
    // than a fit, so the bars changing never move it back. The token bar's
    // cover goes with it, past the bars, counting a bar about to open.
    const show = (camera: (viewport: Size, bars: Insets, bar: Insets) => Camera) => {
      const s = sizeRef.current;
      if (!s) return;
      fittedRef.current = null;
      pendingCamRef.current = null;
      setCam(camera(s, insetsRef.current, pastBars(barCoverRef.current(s, "opening"), insetsRef.current)));
    };
    slot.fit = fit;
    slot.show = show;
    return () => {
      if (slot.fit === fit) slot.fit = null;
      if (slot.show === show) slot.show = null;
    };
  }, [scope, role]);

  // A DM's "look here" (design 7.6). The store records one only for players.
  const focusRef = useRef<number | null>(focus?.id ?? null);
  const ignoreFocus = props.ignoreFocus === true;
  useEffect(() => {
    if (!focus || !size || focusRef.current === focus.id) return;
    focusRef.current = focus.id;
    if (ignoreFocus) return;
    pendingCamRef.current = null;
    setCam(cameraForView(size, toView(shownRef.current, focus), focus.zoom));
  }, [focus, size, ignoreFocus]);

  // A table display's camera mode, after the scene's own first camera so it wins.
  const controlled = props.controlledCamera ?? null;
  useLayoutEffect(() => {
    if (!controlled || !size) return;
    fittedRef.current = null;
    pendingCamRef.current = null;
    setCam(controlled(size));
  }, [controlled, size, scene.id]);

  /*
   * An upright phone's strip or expanded bar moves the map once to clear
   * its token (barDock.ts clearShift), `dy` in the chrome's pixels. It goes
   * through the camera's bounds with the bar's cover, as a pan from the
   * camera as it stands (lib/camera.ts barShift, review BAR-ASTRA-07). A
   * pan whose frame is still pending is the viewer's, and the move gives
   * way to it (docs/design-v1-bar-compact.md 3.6).
   */
  const shiftForBar = useCallback((dy: number) => {
    const s = sizeRef.current;
    const c = camRef.current;
    if (!s || !c || pendingCamRef.current) return;
    const next = barShift(c, dy * uiScale(), s, sceneRef.current.bounds, largerEach(insetsRef.current, barCoverRef.current(s, "drawn")));
    camRef.current = next;
    setCam(next);
  }, []);

  // A tap on an initiative row brings its token into view, keeping the zoom, and clear of the token bar it opens.
  useEffect(
    () =>
      watchPans(scope, scene.id, (p) => {
        const s = sizeRef.current;
        const c = pendingCamRef.current ?? camRef.current;
        if (!s || !c) return;
        pendingCamRef.current = null;
        const at = clearAnchor({ x: s.width * p.anchor.x, y: s.height * p.anchor.y }, s, insetsRef.current, barCoverRef.current(s, "opening"));
        setCam(cameraAt(at, toView(shownRef.current, p), c.scale));
      }),
    [scope, scene.id],
  );

  // The DM's camera follows the turn when this device asks for it (followTurn.ts).
  // It moves when the turn changes or the setting is turned on, never on a
  // mere re-render, so the DM can still pan away during a turn.
  const followTurn = useFollowTurn() && role === "dm";
  const activeEntryId = encounter?.activeEntryId ?? null;
  const followedRef = useRef<{ entryId: string | null; on: boolean }>({ entryId: activeEntryId, on: followTurn });
  useEffect(() => {
    const prev = followedRef.current;
    followedRef.current = { entryId: activeEntryId, on: followTurn };
    if (!followTurn || (prev.on && prev.entryId === activeEntryId)) return;
    const at = turnFocus(store.getState().view?.encounter, store.getState().view?.tokens ?? {}, scene.id);
    if (!at) return;
    const sheetOpen = sheetIsOpen(store.getState().local);
    requestPan(scope, { sceneId: scene.id, ...at, anchor: panAnchor(layoutSize(window, uiScale()), theme.layout.wideMinWidth, sheetOpen) });
  }, [activeEntryId, followTurn, scene.id, scope, store]);

  const tokens = useMemo(() => {
    const list = Object.values(allTokens).filter((t): t is ViewToken => !!t && t.sceneId === scene.id);
    // Objects (doors, chests, markers) under creatures. Creation order otherwise.
    list.sort((a, b) => (a.layer === b.layer ? (a.id < b.id ? -1 : 1) : a.layer === "object" ? -1 : 1));
    // A carried token draws right after its holder, whatever its layer, so a torch shows on the hand holding it (docs/design-v1-attach.md 4.4).
    return drawOrder(list, allTokens);
  }, [allTokens, scene.id]);
  const tokensById = useMemo(() => new Map(tokens.map((t) => [t.id, t])), [tokens]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // Where each carried token leaves a press to a holder under it (groups.ts holderMiddles), the same boxes kept while they are the same, so the token's node renders only when they change.
  const holesRef = useRef(new Map<string, readonly CellBox[]>());
  const holes = useMemo(() => {
    const next = new Map<string, readonly CellBox[]>();
    const same = (a: CellBox, b: CellBox) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
    for (const t of tokens) {
      const boxes = holderMiddles(allTokens, t);
      if (boxes.length === 0) continue;
      const kept = holesRef.current.get(t.id);
      next.set(t.id, kept && kept.length === boxes.length && kept.every((b, i) => same(b, boxes[i]!)) ? kept : boxes);
    }
    holesRef.current = next;
    return next;
  }, [tokens, allTokens]);

  // A selected token that was deleted, or left this scene, drops out of the selection.
  useEffect(() => ui.keepSelected((id) => tokensById.has(id)), [tokensById, ui]);

  /*
   * An opening's intent (state/types.ts LocalUi `opening`) is judged once,
   * at the commit after it, so the calls of one handler count together:
   * where the bar now shows a new token (barDock.ts keepsOpening), the
   * strip clears it once (docs/design-v1-bar-compact.md 3.6, review
   * BAR-ASTRA-09). Any other is dropped, never to replay. One found as
   * Stage mounts, as after a blackout, counts as judged.
   */
  const opening = useRoomView((s) => s.local.opening);
  const shownGroup = selectedIds.filter((id) => tokensById.has(id)).length;
  const barSubject: BarSubject = actionBar && selecting && draggingId === null && selectedId !== null && tokensById.has(selectedId) ? (shownGroup >= 2 ? "group" : selectedId) : null;
  const judged = useRef<{ opening: Opening | null; subject: BarSubject }>({ opening, subject: null });
  useLayoutEffect(() => {
    const was = judged.current;
    if (opening !== was.opening && opening !== null && barSubject !== null && selectedId !== null && keepsOpening(was.subject, barSubject, opening.gather)) {
      scope.get(barDockSlot).setState({ clearRequest: { tokenId: selectedId } });
    }
    judged.current = { opening, subject: barSubject };
  });
  /*
   * A close ends the bar's expanded state and any request (5.3): a let-go,
   * a hide and a switch away from Select, though not a drag, which keeps
   * the bar open while it hides. The held strip goes as the selection is
   * let go, the screen turns between upright and on its side, or the
   * interface size changes (2, review BC-OPUS-33).
   */
  const barOpen = actionBar && selecting && selectedId !== null;
  useLayoutEffect(() => {
    const dock = scope.get(barDockSlot);
    const d = dock.getState();
    if (d.barOpen !== barOpen) dock.setState({ barOpen });
    if (barOpen) return;
    if (d.expanded || d.expandedHeight !== null || d.expandedFor !== null || d.clearRequest !== null) dock.setState({ expanded: false, expandedHeight: null, expandedFor: null, clearRequest: null });
  }, [barOpen, scope]);
  useLayoutEffect(() => () => scope.get(barDockSlot).setState({ barOpen: false }), [scope]);
  const shapeRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const layout = layoutSize(window, zoom);
    const shape = `${layout.width < DOCK_MIN_WIDTH && layout.width <= layout.height}:${zoom}`;
    const turned = shapeRef.current !== null && shapeRef.current !== shape;
    shapeRef.current = shape;
    const dock = scope.get(barDockSlot);
    if ((turned || selectedIds.length === 0) && dock.getState().heldMode !== null) dock.setState({ heldMode: null });
  });

  const scale = cam?.scale ?? 1;

  const activeTokenId = useMemo(() => {
    const entry = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
    return entry?.tokenId ?? null;
  }, [encounter]);

  // The server's movement rule read from this member's projection (dragRights.ts), so a drag offered here is one it takes.
  const ownsToken = useCallback((t: ViewToken) => memberOwns(characters && { characters }, youId, t), [youId, characters]);

  // Every token's marks and label for the zoom, laid out together (useBoardText.ts).
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // The selected token's plate shows its whole name on the map, since the action bar's header keeps two lines of it (docs/design-v1-bar-dock.md section 6).
  const plateIds = useMemo(() => new Set([hoveredId, selectedId].filter((id): id is string => id !== null)), [hoveredId, selectedId]);
  const pills = useBoardPills();
  // The DM's labels on the map, as this viewer's projection holds them: token labels keep off them, measured as the builder draws them.
  const allMapLabels = useRoomView((s) => s.view?.labels ?? EMPTY_MAP_LABELS);
  // The board's text and marks follow the interface size (lib/boardScale.ts), so a new size lays the labels out again.
  const zoom = useUiScale();
  // So does the interface font arriving, since widths measured before it are the fallback's (boardFont.ts).
  const fontEpoch = useBoardFontEpoch();
  const mapLabels = useMemo(
    () => Object.values(allMapLabels).flatMap((l) => (l && l.sceneId === scene.id ? [labelBox(l, measureMapLabel)] : [])),
    [allMapLabels, scene.id, zoom, fontEpoch],
  );
  const movesAny = useCallback((t: ViewToken) => movesOthers(t, settings, youId), [settings, youId]);
  // The lock shows where it is the only thing in the way of a drag.
  const lockShown = useCallback((t: ViewToken) => t.locked && (role === "dm" || ownsToken(t) || movesAny(t)), [role, ownsToken, movesAny]);
  const boardText = useBoardText({ tokens, scale, characters, role, ownsToken, activeTokenId, selectedId, plateIds, pills, mapLabels, lockShown, fontEpoch });
  /*
   * The attach rules' parts of a drag (docs/design-v1-attach.md 4.2 and 6),
   * from this copy: a press on a rider of a controlled mount, or on one
   * that covers its holder, moves the mount, and starts whenever the viewer
   * could move either, so a rider's player hears why the mount stays. A
   * player also directs a mount their creature rides controlled, and gives
   * a token carried by one they may move a new seat.
   */
  const rightsView = useMemo(() => ({ tokens: allTokens, characters: characters ?? {}, meta: { settings: settings ?? {} }, encounter }) as unknown as RightsView, [allTokens, characters, settings, encounter]);
  const attachViewer = useMemo<AttachViewer>(() => ({ role, memberId: youId }), [role, youId]);
  const plainDrag = useCallback((t: ViewToken) => canDragToken({ token: t, role, memberId: youId, characters, settings }), [role, youId, characters, settings]);
  /** Whether a drag may move this token as the lead, the drag's own token or the mount a rider's drag moves. */
  const movesLead = useCallback(
    (t: ViewToken) => (role === "dm" ? !t.locked : plainDrag(t) || dragsToken(rightsView, attachViewer, t)),
    [role, plainDrag, rightsView, attachViewer],
  );
  const canDrag = useCallback(
    (t: ViewToken) => {
      if (plainDrag(t)) return true;
      const lead = dragLead(allTokens, t);
      if (lead.id !== t.id) return role === "dm" || movesToken(rightsView, attachViewer, t) || movesLead(lead as ViewToken);
      return role === "player" && (dragsToken(rightsView, attachViewer, t) || reseats(rightsView, attachViewer, t));
    },
    [plainDrag, allTokens, role, rightsView, attachViewer, movesLead],
  );
  /** Why a press on a token cannot drag it (dragNotes.ts), or null when it can. */
  const dragRefusal = useCallback(
    (t: ViewToken) => refusedDragText({ name: displayName(t), role, owns: ownsToken(t), locked: t.locked, moveAny: movesAny(t) }),
    [role, ownsToken, movesAny],
  );
  // The pointer handlers and the drag callbacks outlive renders, so they read these.
  const tokensByIdRef = useRef(tokensById);
  tokensByIdRef.current = tokensById;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const multiRef = useRef(multi);
  multiRef.current = multi;
  const canDragRef = useRef(canDrag);
  canDragRef.current = canDrag;
  const movesLeadRef = useRef(movesLead);
  movesLeadRef.current = movesLead;
  /** The links of this copy and the rules they are judged by, for the drag callbacks. */
  const linksRef = useRef({ allTokens, settings, role });
  linksRef.current = { allTokens, settings, role };
  const dragRefusalRef = useRef(dragRefusal);
  dragRefusalRef.current = dragRefusal;
  /** What a drop reads to tell a player their token went into the fog or out of the party's sight. */
  const dropFactsRef = useRef({ role, store, ownsToken });
  dropFactsRef.current = { role, store, ownsToken };
  const ownsTokenRef = useRef(ownsToken);
  ownsTokenRef.current = ownsToken;
  const fogRef = useRef({ on: fog, tiles: fogTiles });
  fogRef.current = { on: fog, tiles: fogTiles };
  /** Walls, doors and ledges stopping a player's drag (features/movement/stageHooks.ts). */
  const dragStops = useDragStops(role);
  const dragStopsRef = useRef(dragStops);
  dragStopsRef.current = dragStops;
  /**
   * What a drag or an arrow key that starts on `pressed` moves
   * (docs/design-v1-attach.md 4.2): the mount a rider's press moves, or a
   * selected holder above it, or why it moves nothing, then the rest of the
   * selection, less what rides on another of them, and whether a player may
   * only give it a new seat.
   */
  const dragPartsRef = useRef<(pressed: ViewToken, selectedIds: readonly string[]) => DragParts>(null!);
  dragPartsRef.current = (pressed, selectedIds) => {
    const links = linksRef.current;
    const byId = tokensByIdRef.current;
    const mount = dragLead(links.allTokens, pressed).id;
    const lead = pressLead(links.allTokens, pressed, byId, new Set(selectedIds), canDragRef.current, movesLeadRef.current);
    const rootOf = new Map<string, string>([[pressed.id, lead.id]]);
    if (lead.id !== pressed.id && lead.id === mount && !movesLeadRef.current(lead)) {
      const refusal = (links.role === "dm" ? dragRefusalRef.current(lead) : null) ?? carriesText(lead, pressed);
      return { lead, named: [], rootOf, refusal, reseatOnly: false };
    }
    const holderIn = (t: ViewToken) => {
      const holder = linkedHolder(links.allTokens, t);
      return holder ? byId.get(holder.id) : undefined;
    };
    const followers = groupFollowers(selectedIds, pressed.id, byId, canDragRef.current, holderIn, lead.id === pressed.id ? [] : [lead.id]);
    const named = dragNamed(links.allTokens, lead, followers, byId, movesLeadRef.current);
    // The pressed token, or a selected holder that leads it, which a player may move only within its own holder.
    const reseatOnly = links.role === "player" && (lead.id === pressed.id || lead.id !== mount) && lead.attached !== undefined && !movesLeadRef.current(lead);
    return { lead, named, rootOf, refusal: null, reseatOnly };
  };

  // ------------------------------------------------------------ tools

  const toolRef = useRef<ToolDef>(tool);
  toolRef.current = tool;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const currentCam = () => pendingCamRef.current ?? camRef.current;

  const toolContext = useMemo<ToolContext>(
    () => ({
      actions,
      ui,
      getState: () => store.getState(),
      get scene() {
        return sceneRef.current;
      },
      role,
      camera: () => currentCam() ?? { x: 0, y: 0, scale: 1 },
      scope,
    }),
    [actions, ui, store, role, scope],
  );
  const toolContextRef = useRef(toolContext);
  toolContextRef.current = toolContext;
  /** The pointer that the active tool's one-finger gesture follows. */
  const toolPointerRef = useRef<number | null>(null);

  // Activation, and deactivation when the tool, the scene or the role changes.
  useEffect(() => {
    const ctx = toolContextRef.current;
    tool.activate?.(ctx);
    return () => {
      if (toolPointerRef.current !== null) {
        toolPointerRef.current = null;
        tool.pointer?.cancel?.(ctx);
      }
      tool.deactivate?.(ctx);
    };
  }, [tool, scene.id, role]);

  // ------------------------------------------------------------ gestures

  const gestureRef = useRef(new CameraGesture());
  // A press the select tool's hold-to-ping fired for is a hold, which a tap on empty map must not act on (emptyTap.ts).
  useEffect(() => onHoldPing(scope, (pointerId) => gestureRef.current.hold(pointerId)), [scope]);
  const longPressRef = useRef(new LongPress());
  const dragRef = useRef<{
    node: Konva.Node;
    tokenId: string;
    cancelled: boolean;
    /** Everything else that moves with this token, by the same offset: the rest of the selection (lib/group.ts) and what each carries. */
    followers: { token: ViewToken; node: Konva.Node }[];
  } & DragParts | null>(null);
  /**
   * A box being dragged over the map to select the tokens under it, in
   * screen pixels. With Multi-select on and no key that adds (`add`), a
   * box that never moves past the tap slop is a tap off instead
   * (docs/design-v1-bar-dock.md section 3).
   */
  const boxRef = useRef<{ pointerId: number; start: Point; add: boolean; moved: boolean } | null>(null);
  const boxElRef = useRef<HTMLDivElement>(null);
  /** Set when a gesture became multi-touch, so lifting fingers off a token does not select it. */
  const suppressSelectRef = useRef(false);
  /**
   * A mouse drag that moves the map whatever the tool: the middle or right
   * button, or the left with Space held. Every tool but select puts the left
   * button to its own use, so without this a desktop could only zoom.
   */
  const mousePanRef = useRef<{ pointerId: number; start: Point; moved: boolean } | null>(null);
  /** Whether the last mouse pan moved, so the right-click menu some systems open on release stays shut. */
  const panMovedRef = useRef(false);
  const spaceRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  // Space works as a pan modifier only while nothing has focus, or the map
  // does (pages/mapFocus.ts spaceMovesMap), so it never takes a key press
  // from a field or a button.
  useEffect(() => {
    const free = () => spaceMovesMap(document.activeElement, document.body, scope.get(mapFocusSlot).el);
    const hold = (held: boolean) => {
      spaceRef.current = held;
      setSpaceHeld(held);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !free()) return;
      e.preventDefault();
      if (!spaceRef.current) hold(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && spaceRef.current) hold(false);
    };
    const onBlur = () => {
      if (spaceRef.current) hold(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [scope]);
  /** A press on a token this member may not drag, so moving it says why instead of doing nothing. */
  const refusedPressRef = useRef<{ pointerId: number; start: Point; text: string } | null>(null);

  const scheduleCam = useCallback((wanted: Camera) => {
    // A pan or a zoom never leaves the screen without some of the map on it, nor puts the map's edge under an upright phone's strip, unless it already stood there (docs/design-v1-bar-compact.md 4).
    const s = sizeRef.current;
    const strip = s && scope.get(barDockSlot).getState().bar?.mode === "span" ? barCoverRef.current(s, "drawn") : NO_INSETS;
    const from = pendingCamRef.current ?? camRef.current ?? undefined;
    const next = s ? keepInView(wanted, s, sceneRef.current.bounds, largerEach(insetsRef.current, strip), 64, from) : wanted;
    pendingCamRef.current = next;
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const c = pendingCamRef.current;
      pendingCamRef.current = null;
      if (c) setCam(c);
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  // The keyboard's part of the map (state/shortcuts.ts): + and - zoom about
  // the middle, and an arrow moves the selection a square. An arrow press is
  // a drop, the drag's own: on a creature's turn it adds a leg to its path,
  // and walls and ledges stop it as they stop a drag (features/movement).
  useEffect(() => {
    const slot = scope.get(stageKeysSlot);
    const zoomBy = (factor: number) => {
      const s = sizeRef.current;
      const c = pendingCamRef.current ?? camRef.current;
      if (!s || !c) return;
      scheduleCam(zoomAt(c, { x: s.width / 2, y: s.height / 2 }, factor, gestureRef.current.minScale));
    };
    const nudge = (dx: number, dy: number) => {
      if (dragRef.current) return;
      const local = store.getState().local;
      const picked = local.selectedIds.flatMap((id) => tokensByIdRef.current.get(id) ?? []);
      const movable = picked.filter((t) => canDragRef.current(t));
      const lead = movable.find((t) => t.id === local.selectedId) ?? movable[0];
      if (!lead) {
        const last = picked[picked.length - 1];
        const why = last ? dragRefusalRef.current(last) : null;
        if (why) uiRef.current.notify(why);
        return;
      }
      const parts = dragPartsRef.current(lead, local.selectedIds);
      if (parts.refusal) {
        uiRef.current.notify(parts.refusal);
        return;
      }
      const moved = parts.lead;
      const node = { x: () => moved.x + dx, y: () => moved.y + dy, position: () => {} };
      dragStopsRef.current.press(node, moved, parts.named);
    };
    // A tool's key moves nothing of the tool's while it follows a pointer (docs/design-v1-tool-cycle.md 2.7).
    const busy = () => toolPointerRef.current !== null;
    slot.zoom = zoomBy;
    slot.nudge = nudge;
    slot.busy = busy;
    return () => {
      if (slot.zoom === zoomBy) slot.zoom = null;
      if (slot.nudge === nudge) slot.nudge = null;
      if (slot.busy === busy) slot.busy = null;
    };
  }, [scope, store, scheduleCam]);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const uiRef = useRef(ui);
  uiRef.current = ui;

  const stopTokenDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.cancelled = true;
    drag.node.stopDrag();
  }, []);

  const hasStage = size !== null && cam !== null;
  /**
   * Konva makes each layer's canvas at the pixel ratio set when it mounts,
   * so a change of low power remounts the stage at the new one. A change of
   * the interface size does too, since every board renderer reads its marks'
   * sizes as it draws (lib/boardScale.ts). So does the interface font
   * arriving after the board first drew (boardFont.ts): Konva measures a
   * text only when it is made or changed, and layers place their pills from
   * widths measured as they mount. The camera is this component's state and
   * stays.
   */
  const stageKey = `${stageMountKey(lowPower, zoom)}:${fontEpoch}`;
  applyPixelRatio(lowPower);
  useEffect(() => {
    // The stage on screen takes the gestures: Top-down's, or the isometric board's main stage.
    const stage = isoShown ? isoStage : stageRef.current;
    if (!stage) return;
    const el = stage.container();
    const gesture = gestureRef.current;
    const longPress = longPressRef.current;

    const local = (e: PointerEvent | WheelEvent): Point => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const tokenAt = (p: Point): string | null => {
      const hit = stage.getIntersection(p);
      return hit?.findAncestor(".token", true)?.id() ?? null;
    };
    const toolPointer = (e: PointerEvent, p: Point, c: Camera, tokenId: string | null): ToolPointer => ({
      world: toWorld(TOP_DOWN, screenToView(c, p)),
      screen: p,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      button: e.button,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      tokenId,
    });
    const drawBox = (a: Point, b: Point) => {
      const div = boxElRef.current;
      if (!div) return;
      div.style.display = "block";
      div.style.left = `${Math.min(a.x, b.x)}px`;
      div.style.top = `${Math.min(a.y, b.y)}px`;
      div.style.width = `${Math.abs(a.x - b.x)}px`;
      div.style.height = `${Math.abs(a.y - b.y)}px`;
    };
    const endBox = () => {
      boxRef.current = null;
      if (boxElRef.current) boxElRef.current.style.display = "none";
    };
    const cancelToolGesture = () => {
      if (toolPointerRef.current === null) return;
      toolPointerRef.current = null;
      toolRef.current.pointer?.cancel?.(toolContextRef.current);
    };

    /*
     * A press on the map while a popover or menu is open does nothing but
     * close it (docs/design-v1-tool-options.md 7.1 and 7.4): from its first
     * event to its last finger's lift, the tool does nothing with it, no
     * stroke, ping, ruler point, fog edit, area, selection, one-finger pan
     * or hold to ping. The room's popover rule follows the press
     * (components/popoverRules.ts) and closes the popover as it ends as
     * one pointer. A second finger still pinches or pans the map, which
     * leaves the popover open. A press that pans the map whatever the tool
     * is the map's to judge, with its own Space rule, and never closes one.
     */
    const pans = (e: { pointerType: string; button: number }) => mousePans(e, spaceRef.current);
    popovers.mapPans = pans;

    const onDown = (e: PointerEvent) => {
      const mousePan = pans(e);
      if (e.pointerType === "mouse" && e.button !== 0 && !mousePan) return;
      const c = currentCam();
      if (!c) return;
      // A finger down on the map before the bar has cleared its token is the viewer's own move, and the clearing move gives way to it (3.6).
      const dock = scope.get(barDockSlot);
      if (dock.getState().clearRequest !== null) dock.setState({ clearRequest: null });
      const p = local(e);
      panMovedRef.current = false;
      if (mousePan) {
        if (gesture.pointers.size > 0) return;
        mousePanRef.current = { pointerId: e.pointerId, start: p, moved: false };
        gesture.down(e.pointerId, p, c, true);
        return;
      }
      if (popovers.suppressesTool()) {
        // Followed for a pinch, never for a one-finger pan, and no token is selected on its lift.
        suppressSelectRef.current = true;
        refusedPressRef.current = null;
        const mode = gesture.down(e.pointerId, p, c, false);
        if (mode === "pinch" || mode === "ignored") {
          longPress.cancel();
          stopTokenDrag();
          cancelToolGesture();
          endBox();
        }
        return;
      }
      const handlers = toolRef.current.pointer;
      const tokenId = tokenAt(p);
      if (gesture.pointers.size === 0) suppressSelectRef.current = false;
      // While selecting several, or on a desktop with a key that adds a
      // clicked token (Shift, or Ctrl or Cmd: state/selection.ts
      // addsToSelection), a drag on empty map draws a box that adds the
      // tokens under it. Two fingers still move the map.
      const add = addsToSelection(e, APPLE);
      const boxing = !handlers && tokenId === null && gesture.pointers.size === 0 && (multiRef.current || (e.pointerType === "mouse" && add));
      // A tool with handlers owns the one-finger gesture wherever it lands, so it never pans.
      const mode = gesture.down(e.pointerId, p, c, !handlers && tokenId === null && !boxing);
      refusedPressRef.current = null;
      const pressed = mode === "tool" && !handlers && tokenId ? tokensByIdRef.current.get(tokenId) : undefined;
      const refusal = pressed ? dragRefusalRef.current(pressed) : null;
      if (refusal) refusedPressRef.current = { pointerId: e.pointerId, start: p, text: refusal };
      if (mode === "pinch" || mode === "ignored") {
        // A second finger means the camera, never a token or a tool: stop
        // any drag and the long-press, and ignore the click Konva may
        // report on lift.
        suppressSelectRef.current = true;
        longPress.cancel();
        stopTokenDrag();
        cancelToolGesture();
        endBox();
        return;
      }
      if (boxing) {
        boxRef.current = { pointerId: e.pointerId, start: p, add, moved: false };
      } else if (handlers) {
        toolPointerRef.current = e.pointerId;
        handlers.down?.(toolPointer(e, p, c, tokenId), toolContextRef.current);
      } else if (tokenId && mode === "tool" && !multiRef.current) {
        // While selecting several, a press only adds or removes on its tap.
        longPress.start(p, () => onSelectRef.current(tokenId));
      }
    };
    const onMove = (e: PointerEvent) => {
      const handlers = toolRef.current.pointer;
      if (!gesture.pointers.has(e.pointerId)) {
        if (handlers?.hover && e.pointerType === "mouse" && gesture.pointers.size === 0 && e.target instanceof Node && el.contains(e.target)) {
          const c = currentCam();
          if (c) {
            const p = local(e);
            handlers.hover(toolPointer(e, p, c, tokenAt(p)), toolContextRef.current);
          }
        }
        return;
      }
      const p = local(e);
      longPress.move(p);
      const pan = mousePanRef.current;
      if (pan && pan.pointerId === e.pointerId) {
        if (distance(pan.start, p) > TAP_SLOP_PX) pan.moved = true;
        const next = gesture.move(e.pointerId, p);
        if (next) scheduleCam(next);
        return;
      }
      const refused = refusedPressRef.current;
      if (refused && refused.pointerId === e.pointerId && distance(refused.start, p) > TAP_SLOP_PX) {
        refusedPressRef.current = null;
        uiRef.current.notify(refused.text);
      }
      const box = boxRef.current;
      if (box && box.pointerId === e.pointerId) {
        if (distance(box.start, p) > TAP_SLOP_PX) box.moved = true;
        drawBox(box.start, p);
        return;
      }
      const next = gesture.move(e.pointerId, p);
      if (next) {
        scheduleCam(next);
        return;
      }
      if (toolPointerRef.current === e.pointerId && handlers?.move) {
        const c = currentCam();
        if (c) handlers.move(toolPointer(e, p, c, tokenAt(p)), toolContextRef.current);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!gesture.pointers.has(e.pointerId)) return;
      if (popovers.suppressesTool() && mousePanRef.current?.pointerId !== e.pointerId) {
        const c = currentCam();
        if (c) gesture.up(e.pointerId, c);
        else gesture.pointers.delete(e.pointerId);
        // Its last finger lifted, and the popover's own listeners have heard it: the next press is the tool's again.
        if (gesture.pointers.size === 0) popovers.settle();
        return;
      }
      longPress.cancel();
      if (refusedPressRef.current?.pointerId === e.pointerId) refusedPressRef.current = null;
      const c = currentCam();
      if (!c) return;
      if (mousePanRef.current?.pointerId === e.pointerId) {
        // A pan never selects. A right-click that stayed put still opens a token's menu.
        panMovedRef.current = mousePanRef.current.moved;
        mousePanRef.current = null;
        gesture.up(e.pointerId, c);
        return;
      }
      if (toolPointerRef.current === e.pointerId) {
        toolPointerRef.current = null;
        const p = local(e);
        if (e.type === "pointercancel") toolRef.current.pointer?.cancel?.(toolContextRef.current);
        else toolRef.current.pointer?.up?.(toolPointer(e, p, c, tokenAt(p)), toolContextRef.current);
      }
      // Read before the box, which needs to know whether its press was held until it pinged.
      const { tapOnEmpty, held } = gesture.up(e.pointerId, c);
      const box = boxRef.current;
      if (box && box.pointerId === e.pointerId) {
        const p = local(e);
        endBox();
        // A cancelled press neither selects nor counts as a tap.
        const lifted = e.type !== "pointercancel";
        if (lifted && (box.moved || distance(box.start, p) > TAP_SLOP_PX)) {
          const picked = tokensInBox(tokensByIdRef.current.values(), toWorld(TOP_DOWN, screenToView(c, box.start)), toWorld(TOP_DOWN, screenToView(c, p)));
          if (picked.length > 0) uiRef.current.selectMany(picked.map((t) => t.id));
        } else if (lifted && !held && !box.add) {
          // Multi-select's tap off hides the group's bar and keeps the group (state/selection.ts tapToken), and opens nothing, as before.
          onSelectRef.current(null);
          putAway(toolContextRef.current, toWorld(TOP_DOWN, screenToView(c, p)));
        }
      }
      if (tapOnEmpty) emptyTap(toolContextRef.current, toolRef.current.id, toWorld(TOP_DOWN, screenToView(c, local(e))), held, () => onSelectRef.current(null));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = currentCam();
      if (!c) return;
      scheduleCam(zoomAt(c, local(e), wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey), gesture.minScale));
    };
    const onContextMenu = (e: Event) => e.preventDefault();
    // A middle-button press would start the browser's own autoscroll on some systems.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };

    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", onContextMenu);
    el.addEventListener("mousedown", onMouseDown);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("mousedown", onMouseDown);
      longPress.cancel();
      if (popovers.mapPans === pans) popovers.mapPans = null;
    };
    // The listeners read the camera and the tool through refs, so they
    // attach once, when the stage first exists, and again to a remounted one.
  }, [hasStage, stageKey, scheduleCam, stopTokenDrag, popovers, isoShown, isoStage]);

  // Safari's own pinch-zoom of the page would fight the canvas pinch. The
  // Room page prevents it for the whole room (Room.tsx useNoPageZoom).

  // Where this device's drags would land, for what follows a token (client/state/localDrags.ts).
  const localDrags = scope.get(localDragSlot);
  const setSpot = useCallback(
    (token: ViewToken, x: number, y: number) => {
      const at = snapPosition(x, y, footprint(token));
      const prev = localDrags.getState().spots[token.id];
      if (prev && prev.x === at.x && prev.y === at.y) return;
      localDrags.setState({ spots: { ...localDrags.getState().spots, [token.id]: at } });
    },
    [localDrags],
  );
  const clearSpots = useCallback(() => {
    if (Object.keys(localDrags.getState().spots).length > 0) localDrags.setState({ spots: {} });
  }, [localDrags]);

  // The bar's "Undo move" follows what this device sends and what the server refuses (undoMove.ts).
  const lastMove = scope.get(lastMoveSlot);
  useEffect(() => followOps(store, lastMove), [store, lastMove]);

  // A drag in progress when the scene or the stage goes away ends as a cancel for everyone watching.
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag) {
        actions.sendEph({ k: "dragCancel", tokenId: drag.tokenId });
        for (const f of drag.followers) actions.sendEph({ k: "dragCancel", tokenId: f.token.id });
      }
      clearSpots();
    },
    [actions, scene.id, clearSpots],
  );

  const interaction = useMemo<TokenInteraction>(() => {
    /** Puts every token of a drop back where it stood, and tells the room the drag ended without a move. */
    const putBack = (node: Konva.Node, token: ViewToken, followers: readonly { token: ViewToken; node: Konva.Node }[]) => {
      node.position({ x: token.x, y: token.y });
      actions.sendEph({ k: "dragCancel", tokenId: token.id });
      for (const f of followers) {
        f.node.position({ x: f.token.x, y: f.token.y });
        f.node.getLayer()?.batchDraw();
        actions.sendEph({ k: "dragCancel", tokenId: f.token.id });
      }
      clearSpots();
    };
    /** Puts the dropped tokens where the plan lands them, each carried one by its named holder's offset, and sends the moves and the drag's end. */
    const landDrop = (node: Konva.Node, token: ViewToken, followers: readonly { token: ViewToken; node: Konva.Node }[], parts: DragParts, plan: DropPlan) => {
      const group = parts.named;
      const moves = plan.moves;
      const landed = new Map(moves.map((m) => [m.tokenId, m]));
      // A player who may move a carried token only to a new seat keeps it with its holder (docs/design-v1-attach.md 6).
      const links = linksRef.current;
      const reseat = parts.reseatOnly ? linkedHolder(links.allTokens, parts.lead) : undefined;
      const lands = landed.get(parts.lead.id);
      if (reseat && parts.lead.attached && lands) {
        const at = { ...parts.lead, x: lands.x, y: lands.y, elevation: lands.elevation ?? parts.lead.elevation };
        const holder = reseat as Token;
        if (!linkHolds(links.settings ?? DEFAULT_SETTINGS, parts.lead.attached.kind, at, holder)) {
          putBack(node, token, followers);
          uiRef.current.notify(reseatText(parts.lead, holder));
          return;
        }
      }
      const tokenOf = (id: string) => (id === token.id ? token : (followers.find((f) => f.token.id === id)?.token ?? tokensByIdRef.current.get(id)));
      /** Where a moving token lands: its own move, or its named holder's offset, or nowhere when that did not move. */
      const landing = (t: ViewToken): { x: number; y: number } | null => {
        const rootId = parts.rootOf.get(t.id) ?? t.id;
        const m = landed.get(rootId);
        const root = tokenOf(rootId);
        if (!m || !root) return null;
        return rootId === t.id ? { x: m.x, y: m.y } : { x: t.x + m.x - root.x, y: t.y + m.y - root.y };
      };
      for (const [n, t] of [[node, token] as const, ...followers.map((f) => [f.node, f.token] as const)]) {
        n.position(landing(t) ?? { x: t.x, y: t.y });
        if (n !== node) n.getLayer()?.batchDraw();
      }
      // A player who drops a creature into the fog or out of the party's sight loses it, which reads as a bug unless the map says so.
      const facts = dropFactsRef.current;
      const dropped = moves.flatMap((m) => {
        const t = group.find((g) => g.id === m.tokenId);
        return t ? [{ token: t, owns: facts.ownsToken(t), x: m.x, y: m.y, squeeze: m.squeeze === true }] : [];
      });
      // The fog a drop lands in is known now, on a scene without party vision.
      const view = facts.store.getState().view;
      const swallowed = view ? droppedIntoFog({ role: facts.role, view, moves: dropped }) : [];
      // What the party sees after it is the server's to say, on a vision scene: that note waits for the moves' answers.
      const watch = watchDrop({ role: facts.role, store: facts.store, moves: dropped, notify: (text) => uiRef.current.notify(text) });
      // The moves land in the view before the spots go, so an aura on a token never jumps back.
      const sent = dragStopsRef.current.send(plan, watch?.answer);
      // The bar comes back after a drop and clears its token once, as it does when it opens (docs/design-v1-bar-compact.md 3.6).
      const after = facts.store.getState().local;
      if (after.actionBar && after.selectedId !== null && group.some((t) => t.id === after.selectedId || after.selectedIds.includes(t.id))) scope.get(barDockSlot).setState({ clearRequest: { tokenId: after.selectedId } });
      watch?.sent(sent.length);
      const note = intoFogText(swallowed.map((t) => displayName(t)));
      if (note) uiRef.current.notify(note);
      for (const t of [token, ...followers.map((f) => f.token)]) {
        const m = landed.get(t.id);
        const at = landing(t);
        actions.sendEph(at ? { k: "dragEnd", tokenId: t.id, x: at.x, y: at.y, ...(m?.squeeze ? { squeeze: true as const } : {}) } : { k: "dragCancel", tokenId: t.id });
      }
      clearSpots();
    };
    return {
      hover(id) {
        if (typeof matchMedia === "function" && matchMedia("(hover: hover)").matches) setHoveredId(id);
      },
      select(id, add) {
        if (!suppressSelectRef.current && !toolRef.current.pointer) onSelectRef.current(id, add);
      },
      menu(id) {
        // While selecting several, a click adds or removes, and the menu would undo it.
        if (!multiRef.current && !panMovedRef.current) onSelectRef.current(id);
      },
      dragStart(node, token) {
        longPressRef.current.cancel();
        // A hover plate would travel with the drag and cover the squares it crosses.
        setHoveredId(null);
        // Dragging a selected token moves the rest of the selection with it, those this member may move, and everything each of them carries.
        const stage = node.getStage() ?? stageRef.current;
        const parts = dragPartsRef.current(token, selectedIdsRef.current);
        const named = new Set(parts.named.map((t) => t.id));
        const followers: { token: ViewToken; node: Konva.Node }[] = [];
        for (const t of parts.named) {
          for (const id of [t.id, ...groupMembers(linksRef.current.allTokens, t.id, named)]) {
            if (id !== t.id) parts.rootOf.set(id, t.id);
            const member = id === token.id ? undefined : tokensByIdRef.current.get(id);
            const n = member ? stage?.findOne(`#${id}`) : undefined;
            if (member && n) followers.push({ token: member, node: n });
          }
        }
        dragRef.current = { node, tokenId: token.id, cancelled: false, followers, ...parts };
        if (parts.refusal) {
          uiRef.current.notify(parts.refusal);
          stopTokenDrag();
          return;
        }
        // Space and the left button drag the map, not the token under it. A press that closes a popover moves nothing.
        if (gestureRef.current.pointers.size >= 2 || mousePanRef.current || popovers.suppressesTool()) {
          stopTokenDrag();
          return;
        }
        setDraggingId(token.id);
        setCarried(new Set([token.id, ...followers.map((f) => f.token.id)]));
        dragStopsRef.current.start(parts.lead.id);
        actions.sendEph({ k: "dragStart", tokenId: token.id, x: token.x, y: token.y });
        for (const f of followers) actions.sendEph({ k: "dragStart", tokenId: f.token.id, x: f.token.x, y: f.token.y });
      },
      dragMove(node, token) {
        const drag = dragRef.current;
        if (!drag || drag.cancelled) return;
        const lone = drag.named.length === 1;
        // A lone lead's preview stays at a wall or a ledge that stops its walk, or the walk of a creature it drags, so its frames do too.
        const leadNode = drag.lead.id === token.id ? node : offsetNode(node, token, drag.lead);
        if (lone) dragStopsRef.current.frame(leadNode, drag.lead);
        // A lone lead's frames carry its route's corners and its cost (docs/design-v1-movement.md 6.5), and a group's named tokens
        // their own leg's cost, as the group's label reads it (review AT-ASTRA-15).
        const leadFields = lone ? dragStopsRef.current.frameFields(drag.lead.id) : {};
        const named = lone ? null : new Set(drag.named.map((t) => t.id));
        const fieldsOf = (t: ViewToken, x: number, y: number) => (lone ? (t.id === drag.lead.id ? leadFields : {}) : named!.has(t.id) ? dragStopsRef.current.groupFields(t, { x, y }) : {});
        actions.sendEph({ k: "dragMove", tokenId: token.id, x: node.x(), y: node.y(), ...fieldsOf(token, node.x(), node.y()) });
        setSpot(token, node.x(), node.y());
        if (drag.followers.length === 0) return;
        const dx = node.x() - token.x;
        const dy = node.y() - token.y;
        const layers = new Set<Konva.Layer>();
        for (const f of drag.followers) {
          const x = f.token.x + dx;
          const y = f.token.y + dy;
          f.node.position({ x, y });
          const layer = f.node.getLayer();
          if (layer) layers.add(layer);
          actions.sendEph({ k: "dragMove", tokenId: f.token.id, x, y, ...fieldsOf(f.token, x, y) });
          setSpot(f.token, x, y);
        }
        for (const layer of layers) layer.batchDraw();
      },
      dragEnd(node, token) {
        const drag = dragRef.current;
        dragRef.current = null;
        setDraggingId(null);
        setCarried(NOT_CARRIED);
        const followers = drag?.followers ?? [];
        if (!drag || drag.cancelled) {
          dragStopsRef.current.end();
          putBack(node, token, followers);
          return;
        }
        const leadNode = drag.lead.id === token.id ? node : offsetNode(node, token, drag.lead);
        // A drop made while its route is searched waits at the ghost and lands once it is found (docs/design-v1-movement.md 3.1).
        dragStopsRef.current.drop(leadNode, drag.lead, drag.named, (plan) => landDrop(node, token, followers, drag, plan));
      },
    };
  }, [actions, stopTokenDrag, setSpot, clearSpots, popovers]);

  const memberMap = members ?? {};
  const below: ViewToken[] = [];
  const above: ViewToken[] = [];
  // The party stays above the sight overlay as it does above the fog, fog or no fog (docs/design-v1-maps-vision.md 4.3.7).
  for (const t of tokens) ((fog || sightMode !== null) && drawsAboveFog(t, role, memberMap, characters) ? above : below).push(t);

  const renderToken = (t: ViewToken, iso: IsoToken | null = null) => (
    <TokenNode
      key={t.id}
      token={t}
      scale={cam?.scale ?? 1}
      text={boardText.get(t.id)}
      lockMark={lockShown(t)}
      decor={carried.has(t.id)}
      selected={selectedSet.has(t.id)}
      active={t.id === activeTokenId}
      draggable={selecting && canDrag(t)}
      inset={drawsInset(allTokens, t)}
      holes={holes.get(t.id) ?? null}
      iso={iso}
    />
  );
  // Every chip and badge, then every label, then the plates, over all the tokens and the fog (TokenNode.tsx TokenDecor).
  const decor = (["marks", "label", "plate"] as const).flatMap((part) =>
    tokens
      .filter((t) => !carried.has(t.id) && (part !== "plate" || boardText.get(t.id)?.plate))
      .map((t) => <TokenDecor key={`${part}:${t.id}`} part={part} token={t} scale={cam?.scale ?? 1} text={boardText.get(t.id)} lockMark={lockShown(t)} />),
  );

  const selected = selectedId ? tokensById.get(selectedId) : undefined;
  const group = selectedIds.flatMap((id) => tokensById.get(id) ?? []);
  const barShown = actionBar && selecting && cam && size && draggingId === null;

  const stageStyle: CSSProperties = {
    touchAction: "none",
    overscrollBehavior: "none",
    WebkitTouchCallout: "none",
    WebkitUserSelect: "none",
    userSelect: "none",
    cursor: spaceHeld ? "grab" : tool.cursor,
  };

  // The placed labels and plates, for the layers under them to keep clear of (features/layers.ts LayerProps).
  const labelBoxes = useMemo(() => placedTextBoxes(tokens, boardText, scale), [tokens, boardText, scale]);
  const layerProps: LayerProps = { scene, role, scale: cam?.scale ?? 1, fog, labelBoxes };
  // The scene on screen and the part of it the bars leave clear, in cells (boardView.ts): readouts slide into the clear part, and drawing culls by the whole.
  const boardView = useMemo(() => (cam && size ? boardViewsOf(cam, size, { top, right, bottom, left }) : null), [cam, size, top, right, bottom, left]);
  const overlay = fog || OVERLAY_LAYERS.length > 0 || UNDER_DECOR_LAYERS.length > 0;

  // What the isometric board reads beside what Top-down's tree does (relief/IsoBoard.tsx).
  const aboveFogOf = useCallback((t: ViewToken) => drawsAboveFog(t, role, members ?? {}, characters), [role, members, characters]);
  const decorTokens = useMemo(() => tokens.filter((t) => !carried.has(t.id)), [tokens, carried]);
  const keepIds = useMemo(() => new Set([...selectedIds, ...(draggingId ? [draggingId] : [])]), [selectedIds, draggingId]);
  const live: Live | null = cam && size ? { camera: cam, viewport: size, view: shown } : null;

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {size && cam && live ? (
        <>
          {/* Everything with effects mounts once, outside both drawing trees, whichever view shows (ISO-D15). */}
          {CONTROLLERS.map(({ id, Component }) => (
            <Component key={id} {...layerProps} live={live} />
          ))}
          <RemoteDragClock eased={eased} />
          <TokenInteractionContext.Provider value={interaction}>
            <BoardViewContext.Provider value={boardView}>
              <Frozen frozen={isoShown}>
                <Stage
                  key={stageKey}
                  ref={stageRef}
                  width={isoShown ? 0 : size.width}
                  height={isoShown ? 0 : size.height}
                  x={cam.x}
                  y={cam.y}
                  scaleX={cam.scale}
                  scaleY={cam.scale}
                  style={stageStyle}
                >
                  <MapLayer scene={scene} variant={variant} />
                  {BOARD_LAYERS.length > 0 ? (
                    <Layer>
                      {BOARD_LAYERS.map(({ id, Component }) => (
                        <Component key={id} {...layerProps} />
                      ))}
                    </Layer>
                  ) : null}
                  <Layer>
                    {below.map((t) => renderToken(t))}
                    <RemoteDrags tokens={tokens} scale={cam.scale} youId={youId} draggingId={draggingId} eased={eased} />
                    {overlay ? null : decor}
                  </Layer>
                  {overlay ? (
                    <Layer>
                      {sightMode ? <SightOverlay scene={scene} mode={sightMode} /> : null}
                      {fog ? <FogShape sceneId={scene.id} bounds={scene.bounds} tiles={drawnFogTiles} translucent={role === "dm"} /> : null}
                      {above.map((t) => renderToken(t))}
                      {UNDER_DECOR_LAYERS.map(({ id, Component }) => (
                        <Component key={id} {...layerProps} />
                      ))}
                      {decor}
                      {OVERLAY_LAYERS.map(({ id, Component }) => (
                        <Component key={id} {...layerProps} />
                      ))}
                    </Layer>
                  ) : null}
                </Stage>
              </Frozen>
              {isoEverRef.current ? (
                <IsoBoard
                  hidden={!isoShown}
                  stageKey={stageKey}
                  turn={shown.kind === "isometric" ? shown.turn : 0}
                  cam={cam}
                  size={size}
                  scene={scene}
                  role={role}
                  fog={fog}
                  sightMode={sightMode}
                  drawnFogTiles={drawnFogTiles}
                  viewerFog={role === "player" && fog ? fogTiles : null}
                  playersFog={role === "dm" && fog ? fogTiles : null}
                  tokens={tokens}
                  aboveFog={aboveFogOf}
                  renderToken={renderToken}
                  renderDecor={(t, part, at) => <TokenDecor key={`${part}:${t.id}`} part={part} token={t} scale={cam.scale} text={boardText.get(t.id)} lockMark={lockShown(t)} atX={at.x} atY={at.y} />}
                  decorTokens={decorTokens}
                  hasPlate={(t) => !!boardText.get(t.id)?.plate}
                  layerProps={layerProps}
                  variant={variant}
                  lowPower={lowPower}
                  keepIds={keepIds}
                  eased={eased}
                  youId={youId}
                  draggingId={draggingId}
                  onStage={setIsoStage}
                />
              ) : null}
            </BoardViewContext.Provider>
          </TokenInteractionContext.Provider>
        </>
      ) : null}
      {cam && size ? (
        // The action bar and the panes over the map are chrome, and take the
        // interface size (features/device/layout.ts). The layer passes taps
        // through to the map (its children take them, globals.css), and what
        // sits at a point of the map gets that point in the layer's pixels.
        <div data-rvtt-pass="" {...smallUi(zoom)} style={{ position: "absolute", inset: 0, pointerEvents: "none", ...chromeZoom(zoom) }}>
          {barShown && selected && group.length >= 2 ? (
            <GroupActionBar
              tokens={group}
              movable={group.filter(canDrag).length}
              anchor={inZoomed(worldAnchor(cam, selected, shown), zoom)}
              viewport={sizeInZoomed(size, zoom)}
              tokenHeight={tokenRise(cam, selected, worldAnchor(cam, selected, shown), zoom, shown)}
              onClose={() => ui.select(null)}
              onShift={shiftForBar}
            />
          ) : barShown && selected ? (
            <TokenActionBar
              // Keyed by token, so an armed Delete or a half-typed HP entry never carries over to the next token tapped.
              key={selected.id}
              token={selected}
              anchor={inZoomed(belowLabel(worldAnchor(cam, selected, shown), boardText.get(selected.id)), zoom)}
              viewport={sizeInZoomed(size, zoom)}
              tokenHeight={tokenRise(cam, selected, belowLabel(worldAnchor(cam, selected, shown), boardText.get(selected.id)), zoom, shown)}
              fullAccess={role === "dm" || ownsToken(selected)}
              onDetails={() => onOpenDetails(selected.id)}
              onShift={shiftForBar}
              onClose={() => {
                if (barDismiss(store.getState().local, props.tokenPanelShown === true) === "hide") (props.onHideBar ?? (() => ui.showActions(false)))();
                else ui.select(null);
              }}
            />
          ) : null}
          {role === "dm" ? <LabelPaneHost scene={scene} tool={tool.id} camera={cameraInZoomed(cam, zoom)} viewport={sizeInZoomed(size, zoom)} insets={insetsInZoomed(paneInsets, zoom)} /> : null}
          {role === "dm" ? <LightPaneHost scene={scene} camera={cameraInZoomed(cam, zoom)} viewport={sizeInZoomed(size, zoom)} insets={insetsInZoomed(paneInsets, zoom)} /> : null}
          {role === "dm" ? <PinPaneHost scene={scene} tool={tool.id} camera={cameraInZoomed(cam, zoom)} viewport={sizeInZoomed(size, zoom)} insets={insetsInZoomed(paneInsets, zoom)} /> : null}
          {role === "dm" ? <TrapPaneHost scene={scene} tool={tool.id} camera={cameraInZoomed(cam, zoom)} viewport={sizeInZoomed(size, zoom)} insets={insetsInZoomed(paneInsets, zoom)} /> : null}
          <DoorPillHost scene={scene} tool={tool.id} camera={cameraInZoomed(cam, zoom)} viewport={sizeInZoomed(size, zoom)} insets={insetsInZoomed(insets, zoom)} />
          <ReadoutHost scene={scene} tool={tool.id} camera={cameraInZoomed(cam, zoom)} viewport={sizeInZoomed(size, zoom)} insets={insetsInZoomed(insets, zoom)} />
          {draggingId === null ? <StopNoteHost scene={scene} camera={cameraInZoomed(cam, zoom)} viewport={sizeInZoomed(size, zoom)} insets={insetsInZoomed(insets, zoom)} /> : null}
        </div>
      ) : null}
      <div
        ref={boxElRef}
        aria-hidden
        style={{
          display: "none",
          position: "absolute",
          pointerEvents: "none",
          border: `2px dashed ${theme.color.accent}`,
          background: theme.color.accentTint,
          borderRadius: theme.radius.xs,
        }}
      />
    </div>
  );
}

/**
 * The point under a token's label that the bar's clearing move keeps
 * clear: OFFSET_Y (34 px) under the token (barDock.ts clearShift), room
 * for a label of two lines. A taller label under the token, or its plate,
 * pushes it further down, so the bar never hides it.
 */
function belowLabel(anchor: Point, text: TokenText | undefined): Point {
  const block = text?.plate ?? text?.label;
  if (!text || !block || block.y < text.heightPx) return anchor;
  return { x: anchor.x, y: anchor.y + Math.max(0, block.y + block.height - text.heightPx + 4 - 34) };
}

/**
 * The screen point under a token's bottom center, where its action bar
 * hangs: in Isometric, under its ring on the ground (design 5.4). Drawn
 * heights lift it in ISO-4.
 */
function worldAnchor(cam: Camera, token: ViewToken, view: View): Point {
  const fp = footprint(token);
  if (view.kind === "topDown") return viewToScreen(cam, toView(TOP_DOWN, { x: token.x + fp.w / 2, y: token.y + fp.h }));
  const center = toView(view, { x: token.x + fp.w / 2, y: token.y + fp.h / 2 });
  return viewToScreen(cam, { x: center.x, y: ellipseBox(view.turn, fp.w, fp.h, center).y1 } as ViewPoint);
}

/** How far a token's top stands above the point under its label, in the chrome's pixels (barDock.ts clearShift's `tokenHeight`): in Isometric, its standee's art box's top. */
function tokenRise(cam: Camera, token: ViewToken, anchor: Point, zoom: number, view: View): number {
  if (view.kind === "topDown") return (anchor.y - viewToScreen(cam, toView(TOP_DOWN, { x: token.x, y: token.y })).y) / zoom;
  const fp = footprint(token);
  const center = toView(view, { x: token.x + fp.w / 2, y: token.y + fp.h / 2 });
  return (anchor.y - viewToScreen(cam, { x: center.x, y: center.y - fp.h } as ViewPoint).y) / zoom;
}
