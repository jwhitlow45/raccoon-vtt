import { applyPixelRatio } from "./konvaSetup.ts";
import type Konva from "konva";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Layer, Stage } from "react-konva";
import type { RoomState, Scene, Token } from "#shared/model.ts";
import { labelBox } from "#shared/rules/labels.ts";
import { activeTool, type ToolContext, type ToolDef, type ToolPointer } from "../features/tools.ts";
import { LabelPaneHost } from "../features/builder/LabelPaneHost.tsx";
import { ReadoutHost } from "../features/builder/heights/ReadoutHost.tsx";
import { measureLabel as measureMapLabel } from "../features/builder/draw.ts";
import { turnFocus, useFollowTurn } from "../features/encounter/followTurn.ts";
import { panAnchor, requestPan, watchPans } from "../features/encounter/pan.ts";
import { stageCameraSlot } from "../features/scenes/stageCamera.ts";
import { layersOf, type LayerProps } from "../features/layers.ts";
import { LightPaneHost } from "../features/lights/LightPaneHost.tsx";
import { PinPaneHost } from "../features/pins/PinPaneHost.tsx";
import { DoorPillHost } from "../features/doors/DoorPill.tsx";
import { onHoldPing } from "../features/pings/hold.ts";
import { StopNoteHost } from "../features/movement/StopNote.tsx";
import { SightOverlay } from "../features/vision/SightOverlay.tsx";
import { useDrawnFogTiles, useSightMode } from "../features/vision/stageHooks.ts";
import {
  cameraForView,
  fitRect,
  keepInView,
  NO_INSETS,
  rectClear,
  sameCamera,
  sceneMinScale,
  screenToWorld,
  wheelZoomFactor,
  worldToScreen,
  zoomAt,
  type Camera,
  type Insets,
  type Point,
  type Rect,
  type Size,
} from "../lib/camera.ts";
import { fitTarget } from "../lib/fitTarget.ts";
import { revealedMask } from "../lib/fogTiles.ts";
import { CameraGesture, distance, LongPress, TAP_SLOP_PX } from "../lib/gestures.ts";
import { groupFollowers, tokensInBox } from "../lib/group.ts";
import { displayName, drawsAboveFog, footprint, snapPosition, type ViewToken } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
import { BoardViewContext, useBoardPills } from "./boardView.ts";
import { useBoardText, type TokenText } from "./useBoardText.ts";
import { ownsToken as memberOwns } from "../features/tokens/access.ts";
import { followOps, lastMoveSlot } from "../features/tokens/undoMove.ts";
import { useDragStops } from "../features/movement/stageHooks.ts";
import { cameraInZoomed, chromeZoom, insetsInZoomed, inZoomed, layoutSize, sizeInZoomed, smallUi } from "../features/device/layout.ts";
import { stageMountKey, uiScale, useLowPower, useMapVariant, useUiScale } from "../features/device/settings.ts";
import { mapFocusSlot, spaceMovesMap } from "../pages/mapFocus.ts";
import { localDragSlot } from "../state/localDrags.ts";
import { useRoomScope } from "../state/scope.ts";
import { stageKeysSlot } from "../state/shortcuts.ts";
import { sheetOpen as sheetIsOpen } from "../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../state/view.ts";
import { droppedIntoFog, intoFogText, refusedDragText, watchDrop } from "./dragNotes.ts";
import { emptyTap } from "./emptyTap.ts";
import { canDragToken, movesOthers } from "./dragRights.ts";
import { fitSlot } from "./fitSlot.ts";
import { FogShape } from "./FogShape.tsx";
import { MapLayer } from "./layers/MapLayer.tsx";
import { RemoteDrags } from "./RemoteDrags.tsx";
import { placedTextBoxes } from "./textBoxes.ts";
import { GroupActionBar, TokenActionBar } from "./TokenActionBar.tsx";
import { TokenDecor, TokenInteractionContext, TokenNode, type TokenInteraction } from "./TokenNode.tsx";

const EMPTY_TOKENS: Record<string, Token> = {};
const EMPTY_TILES: RoomState["fogTiles"] = {};
const EMPTY_MAP_LABELS: RoomState["labels"] = {};
const NOT_CARRIED: ReadonlySet<string> = new Set();
const BOARD_LAYERS = layersOf("board");
/** The "Select several" bar's height above the toolbar (features/select/SelectOptions.tsx). */
const SELECT_OPTIONS_PX = 60;
const OVERLAY_LAYERS = layersOf("overlay");
const UNDER_DECOR_LAYERS = layersOf("underDecor");

function sceneRect(scene: Scene) {
  return { x: 0, y: 0, width: scene.bounds.w, height: scene.bounds.h };
}

/**
 * A fitted camera, the canvas and scene sizes it was fitted to, and what it
 * fits: a part of the scene (a player's "Fit map" under fog), or the whole
 * scene when `target` is null, which follows the scene's size.
 */
type Fit = { cam: Camera; key: string; target: Rect | null };

function fitScene(size: Size, scene: Scene, insets: Insets, target: Rect | null = null): Fit {
  return {
    cam: fitRect(size, target ?? sceneRect(scene), 24, insets),
    key: `${size.width}x${size.height}:${scene.bounds.w}x${scene.bounds.h}`,
    target,
  };
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
  /** A tap on a token or on empty map. `add` adds the token to the selection or takes it out. */
  onSelect(tokenId: string | null, add?: boolean): void;
  onOpenDetails(tokenId: string): void;
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
  const actions = useRoomActions();
  const ui = useRoomUi();
  const store = useRoomStore();
  const scope = useRoomScope();
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
      return c && s ? { camera: { x: c.x, y: c.y, scale: c.scale }, viewport: { width: s.width, height: s.height } } : null;
    };
    slot.read = read;
    return () => {
      if (slot.read === read) slot.read = null;
    };
  }, [scope]);

  // A new scene starts at its saved view, or fitted to the screen.
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  useLayoutEffect(() => {
    if (!size || cameraSceneRef.current === scene.id) return;
    cameraSceneRef.current = scene.id;
    pendingCamRef.current = null;
    if (scene.defaultView) {
      fittedRef.current = null;
      setCam(cameraForView(size, scene.defaultView));
    } else {
      fittedRef.current = fitScene(size, scene, insetsRef.current);
      setCam(fittedRef.current.cam);
    }
  }, [size, scene]);

  const { top, right, bottom, left } = insets;
  useLayoutEffect(() => {
    const fitted = fittedRef.current;
    const c = pendingCamRef.current ?? camRef.current;
    if (!size || !fitted || !c || !sameCamera(c, fitted.cam) || cameraSceneRef.current !== scene.id) return;
    const next = fitScene(size, scene, { top, right, bottom, left }, fitted.target);
    if (next.key === fitted.key && rectClear(c, fitted.target ?? sceneRect(scene), size, { top, right, bottom, left })) return;
    fittedRef.current = next;
    if (!sameCamera(next.cam, c)) setCam(next.cam);
  }, [size, scene, top, right, bottom, left]);

  // How far out this scene zooms (camera.ts sceneMinScale), for the pinch and the wheel.
  useEffect(() => {
    if (size) gestureRef.current.minScale = sceneMinScale(size, scene.bounds);
  }, [size, scene.bounds]);

  // The top bar's "Fit map" button (fitSlot.ts, lib/fitTarget.ts). Its fit
  // keeps clear of the bars and follows them like a scene's first fit.
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
      fittedRef.current = fitScene(s, current, insetsRef.current, whole ? null : target);
      pendingCamRef.current = null;
      setCam(fittedRef.current.cam);
    };
    // "Find my token" (features/find/findToken.ts). A plain camera rather
    // than a fit, so the bars changing never move it back.
    const show = (camera: (viewport: Size, bars: Insets) => Camera) => {
      const s = sizeRef.current;
      if (!s) return;
      fittedRef.current = null;
      pendingCamRef.current = null;
      setCam(camera(s, insetsRef.current));
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
    setCam(cameraForView(size, focus));
  }, [focus, size, ignoreFocus]);

  // A table display's camera mode, after the scene's own first camera so it wins.
  const controlled = props.controlledCamera ?? null;
  useLayoutEffect(() => {
    if (!controlled || !size) return;
    fittedRef.current = null;
    pendingCamRef.current = null;
    setCam(controlled(size));
  }, [controlled, size, scene.id]);

  // A tap on an initiative row brings its token into view, keeping the zoom.
  useEffect(
    () =>
      watchPans(scope, scene.id, (p) => {
        const s = sizeRef.current;
        const c = pendingCamRef.current ?? camRef.current;
        if (!s || !c) return;
        pendingCamRef.current = null;
        setCam({ ...c, x: s.width * p.anchor.x - p.x * c.scale, y: s.height * p.anchor.y - p.y * c.scale });
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
    return list.sort((a, b) => (a.layer === b.layer ? (a.id < b.id ? -1 : 1) : a.layer === "object" ? -1 : 1));
  }, [allTokens, scene.id]);
  const tokensById = useMemo(() => new Map(tokens.map((t) => [t.id, t])), [tokens]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // A selected token that was deleted, or left this scene, drops out of the selection.
  useEffect(() => ui.keepSelected((id) => tokensById.has(id)), [tokensById, ui]);

  const scale = cam?.scale ?? 1;

  const activeTokenId = useMemo(() => {
    const entry = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
    return entry?.tokenId ?? null;
  }, [encounter]);

  // The server's movement rule read from this member's projection (dragRights.ts), so a drag offered here is one it takes.
  const ownsToken = useCallback((t: ViewToken) => memberOwns(characters && { characters }, youId, t), [youId, characters]);

  // Every token's marks and label for the zoom, laid out together (useBoardText.ts).
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const barOpen = actionBar && selecting && draggingId === null && selectedId !== null;
  // The action bar's header shows the selected token's whole name, so that token's plate shows only while no bar does, hovered or not.
  const plateIds = useMemo(
    () => new Set([hoveredId, selectedId].filter((id): id is string => id !== null && !(barOpen && id === selectedId))),
    [hoveredId, selectedId, barOpen],
  );
  const pills = useBoardPills();
  // The DM's labels on the map, as this viewer's projection holds them: token labels keep off them, measured as the builder draws them.
  const allMapLabels = useRoomView((s) => s.view?.labels ?? EMPTY_MAP_LABELS);
  // The board's text and marks follow the interface size (lib/boardScale.ts), so a new size lays the labels out again.
  const zoom = useUiScale();
  const mapLabels = useMemo(
    () => Object.values(allMapLabels).flatMap((l) => (l && l.sceneId === scene.id ? [labelBox(l, measureMapLabel)] : [])),
    [allMapLabels, scene.id, zoom],
  );
  const boardText = useBoardText({ tokens, scale, characters, role, ownsToken, activeTokenId, selectedId, plateIds, pills, mapLabels });
  const movesAny = useCallback((t: ViewToken) => movesOthers(t, settings, youId), [settings, youId]);
  const canDrag = useCallback(
    (t: ViewToken) => canDragToken({ token: t, role, memberId: youId, characters, settings }),
    [role, youId, characters, settings],
  );
  /** Why a press on a token cannot drag it (dragNotes.ts), or null when it can. */
  const dragRefusal = useCallback(
    (t: ViewToken) => refusedDragText({ name: displayName(t), role, owns: ownsToken(t), locked: t.locked, moveAny: movesAny(t) }),
    [role, ownsToken, movesAny],
  );
  // The lock shows where it is the only thing in the way of a drag.
  const lockShown = (t: ViewToken) => t.locked && (role === "dm" || ownsToken(t) || movesAny(t));

  // The pointer handlers and the drag callbacks outlive renders, so they read these.
  const tokensByIdRef = useRef(tokensById);
  tokensByIdRef.current = tokensById;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const multiRef = useRef(multi);
  multiRef.current = multi;
  const canDragRef = useRef(canDrag);
  canDragRef.current = canDrag;
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
    /** The rest of the selection, moving with this token (lib/group.ts). */
    followers: { token: ViewToken; node: Konva.Node }[];
  } | null>(null);
  /** A box being dragged over the map to select the tokens under it, in screen pixels. */
  const boxRef = useRef<{ pointerId: number; start: Point } | null>(null);
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
    // A pan or a zoom never leaves the screen without some of the map on it.
    const s = sizeRef.current;
    const next = s ? keepInView(wanted, s, sceneRef.current.bounds, insetsRef.current) : wanted;
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
      const node = { x: () => lead.x + dx, y: () => lead.y + dy, position: () => {} };
      dragStopsRef.current.send(dragStopsRef.current.plan(node, lead, movable));
    };
    slot.zoom = zoomBy;
    slot.nudge = nudge;
    return () => {
      if (slot.zoom === zoomBy) slot.zoom = null;
      if (slot.nudge === nudge) slot.nudge = null;
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
   * sizes as it draws (lib/boardScale.ts). The camera is this component's
   * state and stays.
   */
  const stageKey = stageMountKey(lowPower, zoom);
  applyPixelRatio(lowPower);
  useEffect(() => {
    const stage = stageRef.current;
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
      world: screenToWorld(c, p),
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

    const onDown = (e: PointerEvent) => {
      const mousePan = e.pointerType === "mouse" && (e.button === 1 || e.button === 2 || (e.button === 0 && spaceRef.current));
      if (e.pointerType === "mouse" && e.button !== 0 && !mousePan) return;
      const c = currentCam();
      if (!c) return;
      const p = local(e);
      panMovedRef.current = false;
      if (mousePan) {
        if (gesture.pointers.size > 0) return;
        mousePanRef.current = { pointerId: e.pointerId, start: p, moved: false };
        gesture.down(e.pointerId, p, c, true);
        return;
      }
      const handlers = toolRef.current.pointer;
      const tokenId = tokenAt(p);
      if (gesture.pointers.size === 0) suppressSelectRef.current = false;
      // While selecting several, or with Shift on a desktop, a drag on empty
      // map draws a box that selects the tokens under it. Two fingers still
      // move the map.
      const boxing =
        !handlers && tokenId === null && gesture.pointers.size === 0 && (multiRef.current || (e.pointerType === "mouse" && e.shiftKey));
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
        boxRef.current = { pointerId: e.pointerId, start: p };
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
      const box = boxRef.current;
      if (box && box.pointerId === e.pointerId) {
        const p = local(e);
        endBox();
        if (e.type !== "pointercancel" && distance(box.start, p) > TAP_SLOP_PX) {
          const picked = tokensInBox(tokensByIdRef.current.values(), screenToWorld(c, box.start), screenToWorld(c, p));
          if (picked.length > 0) uiRef.current.selectMany(picked.map((t) => t.id));
        }
      }
      const { tapOnEmpty, held } = gesture.up(e.pointerId, c);
      if (tapOnEmpty) emptyTap(toolContextRef.current, toolRef.current.id, screenToWorld(c, local(e)), held, () => onSelectRef.current(null));
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
    };
    // The listeners read the camera and the tool through refs, so they
    // attach once, when the stage first exists, and again to a remounted one.
  }, [hasStage, stageKey, scheduleCam, stopTokenDrag]);

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

  const interaction = useMemo<TokenInteraction>(
    () => ({
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
        // Dragging a selected token moves the rest of the selection with it, those this member may move.
        const stage = stageRef.current;
        const followers = groupFollowers(selectedIdsRef.current, token.id, tokensByIdRef.current, canDragRef.current).flatMap((t) => {
          const n = stage?.findOne(`#${t.id}`);
          return n ? [{ token: t, node: n }] : [];
        });
        dragRef.current = { node, tokenId: token.id, cancelled: false, followers };
        // Space and the left button drag the map, not the token under it.
        if (gestureRef.current.pointers.size >= 2 || mousePanRef.current) {
          stopTokenDrag();
          return;
        }
        setDraggingId(token.id);
        setCarried(new Set([token.id, ...followers.map((f) => f.token.id)]));
        dragStopsRef.current.start(token.id);
        actions.sendEph({ k: "dragStart", tokenId: token.id, x: token.x, y: token.y });
        for (const f of followers) actions.sendEph({ k: "dragStart", tokenId: f.token.id, x: f.token.x, y: f.token.y });
      },
      dragMove(node, token) {
        const drag = dragRef.current;
        if (!drag || drag.cancelled) return;
        // A lone token's preview stays at a wall or a ledge that stops its walk, so its frames do too.
        if (drag.followers.length === 0) dragStopsRef.current.frame(node, token);
        actions.sendEph({ k: "dragMove", tokenId: token.id, x: node.x(), y: node.y() });
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
          actions.sendEph({ k: "dragMove", tokenId: f.token.id, x, y });
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
          node.position({ x: token.x, y: token.y });
          actions.sendEph({ k: "dragCancel", tokenId: token.id });
          for (const f of followers) {
            f.node.position({ x: f.token.x, y: f.token.y });
            f.node.getLayer()?.batchDraw();
            actions.sendEph({ k: "dragCancel", tokenId: f.token.id });
          }
          clearSpots();
          return;
        }
        const group = [token, ...followers.map((f) => f.token)];
        const plan = dragStopsRef.current.plan(node, token, group);
        const moves = plan.moves;
        const landed = new Map(moves.map((m) => [m.tokenId, m]));
        for (const [n, t] of [[node, token] as const, ...followers.map((f) => [f.node, f.token] as const)]) {
          const m = landed.get(t.id);
          n.position(m ? { x: m.x, y: m.y } : { x: t.x, y: t.y });
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
        watch?.sent(sent.length);
        const note = intoFogText(swallowed.map((t) => displayName(t)));
        if (note) uiRef.current.notify(note);
        for (const t of group) {
          const m = landed.get(t.id);
          actions.sendEph(m ? { k: "dragEnd", tokenId: t.id, x: m.x, y: m.y, ...(m.squeeze ? { squeeze: true as const } : {}) } : { k: "dragCancel", tokenId: t.id });
        }
        clearSpots();
      },
    }),
    [actions, stopTokenDrag, setSpot, clearSpots],
  );

  const memberMap = members ?? {};
  const below: ViewToken[] = [];
  const above: ViewToken[] = [];
  // The party stays above the sight overlay as it does above the fog, fog or no fog (docs/design-v1-maps-vision.md 4.3.7).
  for (const t of tokens) ((fog || sightMode !== null) && drawsAboveFog(t, role, memberMap, characters) ? above : below).push(t);

  const renderToken = (t: ViewToken) => (
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
  // "Select several" puts its own bar above the toolbar, so the token bars keep clear of it.
  const reserveBottom = multi ? SELECT_OPTIONS_PX : 0;

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
  // The part of the scene on screen, in cells, so pills near an edge slide back into view (Pill.tsx).
  const boardView = useMemo(
    () => (cam && size ? { x0: -cam.x / cam.scale, y0: -cam.y / cam.scale, x1: (size.width - cam.x) / cam.scale, y1: (size.height - cam.y) / cam.scale } : null),
    [cam, size],
  );
  const overlay = fog || OVERLAY_LAYERS.length > 0 || UNDER_DECOR_LAYERS.length > 0;

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {size && cam ? (
        <TokenInteractionContext.Provider value={interaction}>
          <BoardViewContext.Provider value={boardView}>
            <Stage
              key={stageKey}
              ref={stageRef}
              width={size.width}
              height={size.height}
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
                {below.map(renderToken)}
                <RemoteDrags tokens={tokens} scale={cam.scale} youId={youId} draggingId={draggingId} />
                {overlay ? null : decor}
              </Layer>
              {overlay ? (
                <Layer>
                  {sightMode ? <SightOverlay scene={scene} mode={sightMode} /> : null}
                  {fog ? <FogShape sceneId={scene.id} bounds={scene.bounds} tiles={drawnFogTiles} translucent={role === "dm"} /> : null}
                  {above.map(renderToken)}
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
          </BoardViewContext.Provider>
        </TokenInteractionContext.Provider>
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
              anchor={inZoomed(worldAnchor(cam, selected), zoom)}
              tokenSize={sizeInZoomed(screenSize(cam, selected), zoom)}
              viewport={sizeInZoomed(size, zoom)}
              reserveBottom={reserveBottom}
              onClose={() => ui.select(null)}
            />
          ) : barShown && selected ? (
            <TokenActionBar
              // Keyed by token, so an armed Delete or a half-typed HP entry never carries over to the next token tapped.
              key={selected.id}
              token={selected}
              anchor={inZoomed(belowLabel(worldAnchor(cam, selected), boardText.get(selected.id)), zoom)}
              tokenSize={sizeInZoomed(screenSize(cam, selected), zoom)}
              viewport={sizeInZoomed(size, zoom)}
              reserveBottom={reserveBottom}
              fullAccess={role === "dm" || ownsToken(selected)}
              onDetails={() => onOpenDetails(selected.id)}
              onClose={() => ui.select(null)}
            />
          ) : null}
          {role === "dm" ? <LabelPaneHost scene={scene} tool={tool.id} camera={cameraInZoomed(cam, zoom)} viewport={sizeInZoomed(size, zoom)} insets={insetsInZoomed(insets, zoom)} /> : null}
          {role === "dm" ? <LightPaneHost scene={scene} camera={cameraInZoomed(cam, zoom)} viewport={sizeInZoomed(size, zoom)} insets={insetsInZoomed(insets, zoom)} /> : null}
          {role === "dm" ? <PinPaneHost scene={scene} tool={tool.id} camera={cameraInZoomed(cam, zoom)} viewport={sizeInZoomed(size, zoom)} insets={insetsInZoomed(insets, zoom)} /> : null}
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
 * The action bar hangs OFFSET_Y (34 px) under the token (TokenActionBar.tsx),
 * room for a label of two lines. A taller label under the token, or a
 * hover plate, pushes it further down, so the bar never hides it.
 */
function belowLabel(anchor: Point, text: TokenText | undefined): Point {
  const block = text?.plate ?? text?.label;
  if (!text || !block || block.y < text.heightPx) return anchor;
  return { x: anchor.x, y: anchor.y + Math.max(0, block.y + block.height - text.heightPx + 4 - 34) };
}

function screenSize(cam: Camera, token: ViewToken): Size {
  const fp = footprint(token);
  return { width: fp.w * cam.scale, height: fp.h * cam.scale };
}

/** The screen point under a token's bottom center, where its action bar hangs. */
function worldAnchor(cam: Camera, token: ViewToken): Point {
  const fp = footprint(token);
  return worldToScreen(cam, { x: token.x + fp.w / 2, y: token.y + fp.h });
}
