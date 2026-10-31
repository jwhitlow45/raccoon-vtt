import type Konva from "konva";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Ellipse, Group, Layer, Rect, Shape, Stage } from "react-konva";
import { CHUNK_CELLS, DEFAULT_SETTINGS, type BuildChunk, type Label, type RoomState, type Scene, type TerrainId, type Token } from "#shared/model.ts";
import { SAMPLES } from "#shared/rules/aoe.ts";
import { onHolder } from "#shared/rules/attach.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import type { TexturedTerrain } from "../../features/builder/geometry.ts";
import { drawLabel, measureLabel } from "../../features/builder/draw.ts";
import { labelShape, labelSplitter } from "../../features/builder/labelShape.ts";
import { useTextures } from "../../features/builder/textures.ts";
import { aimedArea, type AimedArea } from "../../features/areas/AreaPreviewLayer.tsx";
import { caughtTokens, contextFrom, type AreaInputs, type DeviceAreaContext } from "../../features/areas/coverage.ts";
import { zoomOctave } from "../../features/areas/volume.ts";
import { useLiveGround } from "../../features/areas/liveGround.ts";
import { samplesNow, useAreaScope } from "../../features/areas/store.ts";
import { IsoAreasContext, type IsoAreas } from "../../features/areas/TemplateLayer.tsx";
import { useLiveTokens } from "../../features/areas/useLiveTokens.ts";
import { Loading } from "../../components/Loading.tsx";
import type { Insets } from "../../lib/camera.ts";
import { isoLayersOf, type LayerProps } from "../../features/layers.ts";
import { SightOverlay } from "../../features/vision/SightOverlay.tsx";
import type { SightMode } from "../../features/vision/sightMode.ts";
import type { AssetVariant } from "../../lib/api.ts";
import { cameraOfStage, NO_INSETS, screenToView, type Camera, type Size } from "../../lib/camera.ts";
import { DISPOSITION_RING } from "../../lib/tokenView.ts";
import { footprint, type ViewToken } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { footprintCells } from "../../lib/groundCells.ts";
import { drawnBase, drawnFootprintGround, drawnHeights, groundGroups, heightsStand, isometric, K, toView, type DrawnSource, type Turn } from "../../lib/view.ts";
import { useStore } from "zustand";
import { seenSeat, dropView } from "../../features/movement/drop.ts";
import { localDragSlot } from "../../state/localDrags.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomStore } from "../../state/view.ts";
import { DRAG_GROUND } from "../dragLayer.ts";
import { useBoardFontEpoch } from "../boardFont.ts";
import { FogShape } from "../FogShape.tsx";
import { MapContent, useReadableMap, type DrawnMap } from "../layers/MapLayer.tsx";
import { RemoteDrags, type EasedDrags, type IsoGhost } from "../RemoteDrags.tsx";
import { DragMarks } from "../DragMarks.tsx";
import { useBoardText, type BoardTextInput, type TokenText } from "../useBoardText.ts";
import { decorPlace, IsoNamesContext, isoTokenBoxes, mapLabelInk, tokenLayoutPills, viewPill } from "./isoText.ts";
import { BoardViewContext, boardPillsSlot, boardViewsOf, type BoardViews } from "../boardView.ts";
import { useDraggedIds } from "../draggedIds.ts";
import type { IsoToken } from "../TokenNode.tsx";
import { groupWalls, meets, ReliefIndex, type DrawPiece, type Item, type StandeeIn } from "./buckets.ts";
import { IsoGroundContext, TreeShownContext, useShownView, useTreeShown, useTreeShownStore, useTreeShownView, type IsoGround } from "./context.ts";
import { drawRun, runPaintedBox, standeePaintedBox, type DrawContext, type GroundCopy } from "./drawRelief.ts";
import { FogView } from "./fogView.ts";
import { cellLook, CellTints, hexLook, imageReader } from "./looks.ts";
import type { VBox } from "./pieces.ts";
import { pillarPieces, wallPieces, type WallPiece } from "./runs.ts";
import { FrameScheduler, type KeptLayer } from "./scheduler.ts";
import { keptHost, onDeviceGrid, screenBox } from "./kept.ts";
import { liveCameraSlot, needsApply, useCameraWhileShown, type LastApplied } from "../../state/liveCamera.ts";
import { cullFit, cullOf } from "./cull.ts";
import { previewLanding, seenChunks } from "./seenChunks.ts";
import { dimmedForDm, ghostStands, ghostTagStands, ringsAtBase, splitTokens, tokenBox } from "./stand.ts";
import { BoardVolumes, type VolumeEntry, type VolumeWorld } from "./volumes.ts";
import { useCommitCount, useKeptReport, useLayoutReport } from "./isoTest.ts";
import { ON_GROUND, standeeShape, type Seat } from "./standee.ts";
import { hexBoxGround } from "../isoPlace.ts";
import { COVER_INSET, drawsInset } from "../../features/attach/groups.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { flatPressTokens, keepRingPairs, sameIso } from "./renderCache.ts";

/**
 * The isometric board (docs/design-v1-isometric-view.md 5.1): two stages,
 * one over the other. The ground stage never listens. It is taller than the
 * canvas by the lift margin, and draws the map, the grid, the board layers,
 * the creatures the stand rule lays flat, sight, fog and the still ground
 * marks in one layer, turned and squashed into the ground plane. The main
 * stage holds the relief (columns, pits, walls and standees in depth order,
 * whose tops copy the ground stage's pixels), the drag layer (other
 * members' drags and the moving marks, and at a local drag what it moves),
 * and the overlay in view space (silhouettes, decor and upright labels).
 *
 * Both trees stay mounted once Isometric has shown (ISO-D15). While
 * Top-down shows, this tree is memoized out of camera renders and its
 * stages are sized 0x0, which frees their canvases and keeps their nodes.
 */

export type IsoBoardProps = {
  hidden: boolean;
  /** Remounts the stages with the Top-down one (Stage.tsx stageKey): low power and the interface size change the pixel ratio. */
  stageKey: string;
  turn: Turn;
  cam: Camera;
  size: Size;
  scene: Scene;
  role: "dm" | "player";
  /** Whether the scene draws fog. */
  fog: boolean;
  sightMode: SightMode | null;
  /** The fog the board draws, as Top-down's FogShape gets it. */
  drawnFogTiles: RoomState["fogTiles"];
  /** The fog the stand rule and the drawn heights read: a player's own on a scene with fog, else null for a viewer who sees all the ground. */
  viewerFog: RoomState["fogTiles"] | null;
  /**
   * On the DM's device, the fog the DM's map draws (`drawnFogTiles`: the
   * DM's own and, on a per-player scene, the party's explored ground), for
   * dimming the standees on ground it shows fogged (5.4, D-261026-18), or null.
   */
  dmFog: RoomState["fogTiles"] | null;
  /** The scene's tokens in Top-down's draw order. */
  tokens: readonly ViewToken[];
  aboveFog: (t: ViewToken) => boolean;
  /** Today's TokenNode for a token, placed on the relief (`iso`) or on the ground stage (null). */
  renderToken: (t: ViewToken, iso: IsoToken | null, text?: TokenText) => ReactNode;
  /** Today's decor pass for a token, its box's top left at a view point. */
  renderDecor: (t: ViewToken, part: "marks" | "label" | "plate", at: { x: number; y: number }, text: TokenText | undefined) => ReactNode;
  /** The tokens that draw decor in the passes over the board, as Top-down's: all but the ones a drag carries. */
  decorTokens: readonly ViewToken[];
  /** What the token labels' layout reads besides where things stand (useBoardText.ts), which the board lays out again in view space (5.4). */
  text: Omit<BoardTextInput, "tokens" | "scale" | "mapLabels" | "place">;
  /** The labels as laid out here, for the chrome that hangs below a token's label (Stage.tsx's action bar). */
  onText: (text: ReadonlyMap<string, TokenText>) => void;
  layerProps: LayerProps;
  variant: AssetVariant;
  lowPower: boolean;
  /** Tokens whose nodes must stay whatever the culling: the one dragged here and the selection. */
  keepIds: ReadonlySet<string>;
  eased: EasedDrags;
  youId: string | null;
  draggingId: string | null;
  /** The main stage, for the board's gestures, once it exists. */
  onStage: (stage: Konva.Stage | null) => void;
  /** Top-down's stage style, which the main stage takes too: no browser touch gestures, no text selection, the tool's cursor. */
  stageStyle: CSSProperties;
  /** Where the bars cover the canvas, so the board's loading words show clear of them. */
  insets?: Insets;
};

const EMPTY_CHUNKS: Record<string, BuildChunk> = {};
const EMPTY_TEMPLATES: RoomState["templates"] = {};
const EMPTY_TOKENS: RoomState["tokens"] = {};
const NO_RINGS: readonly string[] = [];
const NO_RING_PAIRS: ReadonlySet<string> = new Set();
/** While areas still build, how often the ones done since come in. */
const VOLUME_LAYOUT_MS = 250;
const NO_SPOTS: Readonly<Record<string, { x: number; y: number }>> = {};
const NO_TOKENS: readonly ViewToken[] = [];
const ALL_TEXTURES: readonly TexturedTerrain[] = ["stone", "wood", "grass", "dirt", "cave", "water", "difficult", "rubble"];
const GROUND_LAYERS = isoLayersOf("ground", "board");
const GROUND_MARKS = [...isoLayersOf("ground", "underDecor"), ...isoLayersOf("ground", "overlay")];
const MOVING_LAYERS = isoLayersOf("moving");
/** Pins, and the parts of other layers that stand: pills, badges and text, by the stand rule where Top-down draws them under the fog. */
const UPRIGHT_LAYERS = isoLayersOf("upright");
/** The lift margin grows in steps, so a pan that changes the highest lift in view seldom reallocates the ground stage's canvas (section 11). */
const MARGIN_STEP_PX = 128;

export const IsoBoard = memo(
  // The board's own reads of the room's other stores hold while it is hidden, as its parts' do (context.ts TreeShownContext).
  (props: IsoBoardProps) => (
    <TreeShownContext.Provider value={!props.hidden}>
      <IsoBoardImpl {...props} />
    </TreeShownContext.Provider>
  ),
  (prev, next) => prev.hidden && next.hidden,
);

function IsoBoardImpl(props: IsoBoardProps) {
  const { scene, cam, size, turn, hidden } = props;
  const view = isometric(turn);
  // The room's live camera (state/liveCamera.ts) and this board's frame scheduler, which the stages' applier and the area build both use.
  const live = useScoped(liveCameraSlot);
  const schedulerRef = useRef<FrameScheduler | null>(null);
  // While hidden it keeps what it last read, so a brush stroke in Top-down walks no walls, heights or buckets here, and it reads afresh when shown.
  const chunks = useShownView(!hidden, (s) => s.view?.buildChunks ?? EMPTY_CHUNKS);
  const feet = useShownView(!hidden, (s) => s.view?.meta.settings.feetPerCell ?? DEFAULT_SETTINGS.feetPerCell);
  const allLabels = useShownView(!hidden, (s) => s.view?.labels);
  const { w, h } = scene.bounds;
  // Footprints read the scene's grid as Top-down's do, so both views stand and lay flat the same hexes (hex grids 4.2).
  const grid = useMemo(() => sceneGrid(scene), [scene.gridShape]);
  const stand = heightsStand(cam.scale, props.lowPower);
  const fog = useMemo(() => new FogView(props.viewerFog, scene.id, { w, h }), [props.viewerFog, scene.id, w, h]);
  const dmFog = useMemo(() => (props.dmFog ? new FogView(props.dmFog, scene.id, { w, h }) : null), [props.dmFog, scene.id, w, h]);
  const src: DrawnSource = useMemo(() => ({ chunks, sceneId: scene.id, bounds: { w, h }, grid, fog: props.viewerFog, stand }), [chunks, scene.id, w, h, grid, props.viewerFog, stand]);
  const heights = useMemo(() => drawnHeights(src, feet), [src, feet]);

  // The standing walls and pillars, by bucket, each bucket's list kept while its pieces stay the same.
  const walls = useMemo(() => sceneWalls(scene, chunks), [scene, chunks]);
  const wallGroups = useRef<Map<string, readonly WallPiece[]> | null>(null);
  const grouped = useMemo(() => {
    // Pillars are painted ground, which stays square.
    const pieces = stand ? [...wallPieces(walls, fog, grid), ...(isHex(grid) ? [] : pillarPieces(chunks, scene.id, { w, h }, fog))] : [];
    return (wallGroups.current = groupWalls(pieces, wallGroups.current, { w, h }, grid));
  }, [stand, walls, fog, chunks, scene.id, w, h, grid]);

  // The map image Top-down draws, for the side tints of cells with no builder terrain (looks.ts).
  const [drawnMap, setDrawnMap] = useState<DrawnMap | null>(null);
  const onDrawn = useCallback((d: DrawnMap | null) => setDrawnMap((prev) => (prev?.image === d?.image && sameRect(prev?.rect, d?.rect) ? prev : d)), []);
  // Read only while the shared loader still holds that image: it frees it once another settles, and a hidden tree learns of that late.
  const readable = useReadableMap(drawnMap);
  const tints = useMemo(() => {
    if (!readable) return null;
    const read = imageReader(readable.image);
    const iw = "naturalWidth" in readable.image ? readable.image.naturalWidth : readable.image.width;
    const ih = "naturalHeight" in readable.image ? readable.image.naturalHeight : readable.image.height;
    return read && iw > 0 && ih > 0 ? new CellTints(read, readable.rect, { width: iw, height: ih }) : null;
  }, [readable]);
  // The builder's textures load with the first Isometric view (section 8).
  const textures = useTextures(ALL_TEXTURES);

  // The depth list. Tints ride each bucket's build, so a fog reveal pays only for its cells (ISO-FR-R5-1).
  const index = useRef<ReliefIndex>(null);
  index.current ??= new ReliefIndex();
  const relief = index.current;
  const global = useMemo(() => ({ stand, feet, tints }), [stand, feet, tints]);
  // Hidden, the board draws nothing. A map changed meanwhile takes its tints away and brings new ones, and each would rebuild every bucket here, so the buckets wait to be built once when the board shows (ISO2-OPUS-12).
  const synced = useMemo(() => {
    if (hidden) return null;
    relief.sync({
      sceneId: scene.id,
      bounds: { w, h },
      chunks,
      tiles: props.viewerFog,
      walls: grouped,
      global,
      grid,
      src: {
        ground: (x, y) => heights.at(x, y),
        terrain: (x, y) => terrainAt(chunks, scene.id, x, y),
        look: (x, y, t) => (isHex(grid) ? hexLook(fog, tints, grid, { col: x, row: y }, t) : cellLook(fog, tints, x, y, t)),
        bounds: { w, h },
        grid,
      },
    });
    return {};
  }, [hidden, relief, scene.id, w, h, chunks, props.viewerFog, grouped, global, heights, fog, tints, grid]);

  // Who stands and who lies flat, by the stand rule.
  const { standing, flat } = useMemo(() => splitTokens(fog, grid, props.tokens, props.aboveFog), [fog, grid, props.tokens, props.aboveFog]);
  const byId = useMemo(() => new Map(props.tokens.map((t) => [t.id, t])), [props.tokens]);
  const standees = useMemo(() => {
    const standingIds = new Set(standing.map((t) => t.id));
    const all = Object.fromEntries(props.tokens.map((t) => [t.id, t]));
    return standing.map((t): Standing => {
      const fp = footprint(t);
      const cells = footprintCells(grid, t);
      const base = drawnBase(src, cells, t.elevation) / feet;
      const ground = drawnFootprintGround(src, cells) / feet;
      const link = t.attached;
      const holder = link && onHolder(link.kind) && standingIds.has(link.to) ? link.to : null;
      const holderToken = holder ? byId.get(holder) : undefined;
      // One seat, read by the drawing (TokenNode.tsx Standee) and by every box below, so they agree.
      const seat: Seat = holderToken ? { rise: footprint(holderToken).h / 2, inset: drawsInset(grid, all, t) ? COVER_INSET : 1 } : ON_GROUND;
      const shape = standeeShape(turn, { x: t.x, y: t.y, w: fp.w, h: fp.h }, base, ground, cam.scale, size.height, seat);
      return {
        id: t.id,
        x: t.x + fp.w / 2,
        y: t.y + fp.h / 2,
        cells,
        base,
        holder,
        bounds: shape.bounds,
        art: shape.art,
        frame: shape.frame,
        keep: props.keepIds.has(t.id),
        ground,
        capped: shape.capped,
        drawn: shape.drawnBase,
        rise: seat.rise,
        inset: seat.inset,
        ring: shape.ring,
      };
    });
  }, [standing, src, grid, feet, turn, cam.scale, size.height, props.keepIds, byId, props.tokens]);

  // The canvas's view box, grown and snapped in steps, so a pan lays out again only when it crosses a step.
  const { box: cull, key: cullKey } = cullOf(cam, size);

  /*
   * Areas standing as their real shapes (docs/design-v1-iso-area-shapes.md):
   * the still areas the ground stage draws, read where their tokens stand
   * and without those being dragged, as TemplateLayer reads them, and the
   * area the Area tool aims once the finger rests. Each stands where heights
   * stand, by the stand rule on this viewer's live ground (D-261027-06),
   * built in slices nearest the middle first, and lies flat until then.
   */
  const templates = useTreeShownView((s) => s.view?.templates ?? EMPTY_TEMPLATES);
  const stored = useTreeShownView((s) => s.view?.tokens ?? EMPTY_TOKENS);
  const settings = useTreeShownView((s) => s.view?.meta.settings);
  const casts = useTreeShownView((s) => s.view?.casts);
  const youId = props.youId ?? "";
  const dragged = useDraggedIds();
  const areaTool = useTreeShownView((s) => s.local.tool);
  const areaStore = useAreaScope().store;
  const draft = useTreeShownStore(areaStore, (s) => s.draft);
  const selectedArea = useTreeShownStore(areaStore, (s) => s.selectedId);
  const areaLive = useTreeShownStore(areaStore, (s) => s.live);
  const aimMoving = useTreeShownStore(areaStore, (s) => s.moving);
  const liveGround = useLiveGround(props.fog ? scene : undefined, props.role);
  const stillTokens = useMemo(() => (dragged.all.size > 0 ? withoutTokens(stored, dragged.all) : stored), [stored, dragged]);
  const stillCtx = useMemo(() => (settings ? contextFrom({ tokens: stillTokens, buildChunks: chunks, settings, live: liveGround }, scene, SAMPLES, fog) : null), [settings, stillTokens, chunks, liveGround, scene, fog]);
  // The area the Area tool aims, from a probe mounted only while there can be one: it alone reads the live tokens, so a drag elsewhere renders no board.
  const [aim, setAim] = useState<Aim | null>(null);
  const aiming = areaTool === "area" && (!!draft || !!selectedArea);
  const aimed = aiming ? (aim?.area ?? null) : null;
  const aimedCtx = aiming ? (aim?.ctx ?? null) : null;
  const entries = useMemo((): VolumeEntry[] => {
    if (!stand || !stillCtx) return [];
    const editing = areaLive ? selectedArea : null;
    const out: VolumeEntry[] = [];
    for (const t of Object.values(templates)) {
      if (!t || t.sceneId !== scene.id || t.id === editing || (t.attachedTo !== undefined && dragged.all.has(t.attachedTo))) continue;
      if (aimed && aimed.id === t.id) continue;
      out.push({ id: t.id, template: t, ctx: stillCtx, look: { color: t.color, dm: t.visibility === "dm" && props.role === "dm", selected: areaTool === "area" && selectedArea === t.id, preview: false } });
    }
    if (aimed && aimedCtx) out.push({ id: aimed.id, template: aimed.t, ctx: aimedCtx, look: { color: aimed.color, dm: false, selected: true, preview: false } });
    return out;
  }, [stand, stillCtx, aimedCtx, areaLive, selectedArea, templates, scene.id, dragged, aimed, props.role, areaTool]);
  // Meshes are built for the zoom's octave (volume.ts zoomOctave), so a zoom within one changes nothing here.
  const octave = zoomOctave(cam.scale);
  const world = useMemo((): VolumeWorld => ({ heights, tiles: props.viewerFog, px: octave, fog, live: liveGround }), [heights, props.viewerFog, octave, fog, liveGround]);
  const volumesRef = useRef<BoardVolumes>(null);
  volumesRef.current ??= new BoardVolumes();
  const volumes = volumesRef.current;
  const volumesSynced = useMemo(() => {
    if (hidden) return null;
    volumes.sync(entries, world);
    return {};
  }, [hidden, volumes, entries, world]);
  // Each frame's slice of building, and a render when something new can stand.
  const [volumeTick, setVolumeTick] = useState(0);
  // Areas build nearest the middle of what the viewer sees, past the panels over the board, at the camera on screen: a pan inside a cull step renders nothing.
  const clear = props.insets ?? NO_INSETS;
  const sliceView = useRef({ turn, cull, world, clear, size, cam });
  sliceView.current = { turn, cull, world, clear, size, cam };
  /*
   * The build runs as the frame scheduler's background work
   * (scheduler.ts background): after the frame's draw, with what the frame
   * leaves of its budget, and never in a frame that repaints the relief
   * whole or began with a repaint waiting, so a standing area's publish
   * and its repaint never share a frame with a slice (docs/design-v1-relief-pan.md 8).
   */
  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (!volumesSynced || entries.length === 0 || !scheduler) return;
    let changed = false;
    let laidOut = performance.now();
    return scheduler.background((until) => {
      const { turn: at, cull: box, world: w, clear: bars, size: s, cam: rendered } = sliceView.current;
      const c = live.camera ?? rendered;
      const mid = screenToView(c, { x: (bars.left + s.width - bars.right) / 2, y: (bars.top + s.height - bars.bottom) / 2 });
      const start = performance.now();
      const step = volumes.step(at, box, w, until, mid);
      changed ||= step.changed;
      // A layout redraws the whole relief, so while areas keep standing one by one they come in together a few times a second, and at once when the last does.
      if (changed && (!step.more || start - laidOut >= VOLUME_LAYOUT_MS)) {
        changed = false;
        laidOut = start;
        setVolumeTick((n) => n + 1);
      }
      return step.more;
    });
  }, [volumesSynced, entries.length, volumes, turn, cullKey, world, props.stageKey, live]);
  const volumesNow = useMemo(() => (volumesSynced ? volumes.now(turn, cull, world) : null), [volumesSynced, volumes, turn, cullKey, world, volumeTick]);

  // Rings at the bases of the creatures that stand by the stand rule itself, in each area whose volume stands (D-261026-31).
  const rings = useMemo(() => {
    if (!volumesNow || volumesNow.standing.size === 0) return null;
    const list = entries.filter((e) => volumesNow.standing.has(e.id)).map((e) => ({ id: e.id, color: e.look.color, caught: caughtTokens(e.template, e.ctx, scene.id) }));
    return ringsAtBase(list, byId, fog, grid);
  }, [volumesNow, entries, scene.id, byId, fog, grid]);
  const ringPairs = useRef(NO_RING_PAIRS);
  const ringsUp = useMemo(() => (ringPairs.current = keepRingPairs(ringPairs.current, rings?.pairs ?? NO_RING_PAIRS)), [rings]);
  const isoAreas = useMemo((): IsoAreas => ({ ctx: stillCtx, ringsUp, world: stand ? world : null }), [stillCtx, ringsUp, stand, world]);

  // The box is made anew each render, so its numbers say when it changed.
  const items = useMemo(() => relief.layout(turn, cull, standees, volumesNow?.pieces ?? []), [relief, synced, turn, cullKey, standees, volumesNow]);
  useLayoutReport()(items, volumesNow, rings?.byToken ?? null);

  // Looked up by id for each standee, silhouette and decor: a search of the list each time is quadratic at 500 tokens.
  const byStandee = useMemo(() => new Map(standees.map((s) => [s.id, s])), [standees]);

  /*
   * Where this device's drag would land each token it moves (state/localDrags.ts),
   * for the standee's base mid-drag (4.3, ISO-OP-34): the drop's landing on
   * the ground this viewer has seen, a kept seat at its holder's height
   * first, else the holder's footing, so a fogged platform never lifts it.
   * A token whose holder moves with it rides at the holder's landing. It
   * changes only when a token crosses into another cell.
   */
  const store = useRoomStore();
  const spots = useStore(useScoped(localDragSlot), (st) => (hidden ? NO_SPOTS : st.spots));
  const movedIso = useCallback(
    (t: ViewToken, spot: { x: number; y: number }, seat: Seat): Pick<IsoToken, "base" | "ground" | "drawn" | "capped" | "rise" | "inset"> => {
      const room = store.getState().view;
      const seen = seenChunks({ chunks, sceneId: scene.id, bounds: { w, h }, fog: props.viewerFog });
      const landingOf = (tok: ViewToken, at: { x: number; y: number }) => (room ? previewLanding(room, props.role, seen, tok, at) : tok.elevation);
      const holderId = t.attached && onHolder(t.attached.kind) ? t.attached.to : null;
      const holder = holderId ? byId.get(holderId) : undefined;
      const holderSpot = holderId ? spots[holderId] : undefined;
      const riding = holder !== undefined && holderSpot !== undefined;
      const landing = riding ? landingOf(holder, holderSpot) : landingOf(t, spot);
      // Off its holder's footprint a rider stands on its own, unless the holder moves with it.
      const seated = holder !== undefined && (riding || (room !== null && seenSeat(dropView(room, props.role), t)?.keptAt(spot) === true));
      const kept = seated ? seat : ON_GROUND;
      const fp = footprint(t);
      const cells = footprintCells(grid, { ...t, x: spot.x, y: spot.y, squeeze: undefined });
      const base = drawnBase(src, cells, landing) / feet;
      const ground = drawnFootprintGround(src, cells) / feet;
      const shape = standeeShape(turn, { x: spot.x, y: spot.y, w: fp.w, h: fp.h }, base, ground, cam.scale, size.height, kept);
      return { base, ground, drawn: shape.drawnBase, capped: shape.capped, rise: kept.rise, inset: kept.inset };
    },
    [store, chunks, scene.id, w, h, props.viewerFog, props.role, byId, spots, src, grid, feet, turn, cam.scale, size.height],
  );

  // Each standee's placing, kept while it is the same, so its node does not render again for a pan.
  const isoCache = useRef(new Map<string, IsoToken>());
  const flatCache = useRef(new Map<string, IsoToken>());
  const isoOf = useMemo(() => {
    const next = new Map<string, IsoToken>();
    for (const item of items) {
      if (item.kind !== "standee") continue;
      const s = byStandee.get(item.id)!;
      const t = byId.get(item.id)!;
      const dim = props.role === "dm" && dimmedForDm(dmFog, grid, t);
      const spot = spots[item.id];
      const placed = spot ? movedIso(t, spot, { rise: s.rise, inset: s.inset }) : s;
      const fresh: IsoToken = { turn, base: placed.base, ground: placed.ground, drawn: placed.drawn, capped: placed.capped, rise: placed.rise, inset: placed.inset, pits: item.pits.map((p) => p.poly), dim, pressOnly: false, press: [], rings: rings?.byToken.get(item.id) ?? NO_RINGS };
      const old = isoCache.current.get(item.id);
      next.set(item.id, old && sameIso(old, fresh) ? old : fresh);
    }
    isoCache.current = next;
    return next;
  }, [items, byStandee, byId, turn, props.role, dmFog, grid, spots, movedIso, rings]);
  const silhouettes = useMemo(() => items.filter((i): i is Extract<Item, { kind: "standee" }> => i.kind === "standee" && i.silhouette), [items]);

  // The lift margin: the highest drawn lift in view, in steps, at most one canvas height.
  const margin = stand ? Math.min(size.height, Math.ceil((K * heights.high * cam.scale) / MARGIN_STEP_PX) * MARGIN_STEP_PX) : 0;

  const groundStageRef = useRef<Konva.Stage>(null);
  const groundLayerRef = useRef<Konva.Layer>(null);
  const reliefLayerRef = useRef<Konva.Layer>(null);
  const reliefRootRef = useRef<Konva.Group>(null);
  const mainRef = useRef<Konva.Stage>(null);
  const dc = useRef<DrawContext | null>(null);
  // Counts the ground's draws (Konva's layer `draw` event, on every path that draws it), so the tops copy one pattern of each and the kept picture knows a ground draw it did not ask for.
  const groundCopy = useRef<GroundCopy>({ version: 0, made: -1, canvas: null, pattern: null });
  // The camera-derived fields are set again from the main stage at each draw (scheduler.ts KeptHost.prepare), so a draw between renders culls by the view on screen.
  dc.current = {
    turn,
    camera: cam,
    pixelRatio: reliefLayerRef.current?.getCanvas().getPixelRatio() ?? 1,
    ground: groundLayerRef.current ? (groundLayerRef.current.getCanvas()._canvas as HTMLCanvasElement) : null,
    textures,
    view: screenBox(cam, size),
    openings: (region, box, asker) => relief.openingsMeeting(region, turn, box, asker),
    groundCopy: groundCopy.current,
  };

  /*
   * The camera reaches the stages without React (docs/design-v1-relief-pan.md
   * 6.2): the room's live camera holds the camera on screen, and the applier
   * positions both stages at it, its translation on the relief canvas's
   * device grid, inside the scheduler's camera move, so the relief scrolls.
   * It answers how the camera stands to the layout this board last rendered.
   */
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const renderedCull = useRef({ key: cullKey, box: cull });
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const byStandeeRef = useRef(byStandee);
  byStandeeRef.current = byStandee;
  const spotsRef = useRef(spots);
  spotsRef.current = spots;
  /** The camera last put on the stages, the stage it went on and at what pixel ratio. */
  const lastApplied = useRef<LastApplied>({ camera: null, stage: null, ratio: 0 });
  const applyCamera = useCallback(
    (c: Camera) => {
      const main = mainRef.current;
      const groundStage = groundStageRef.current;
      const layer = reliefLayerRef.current;
      const scheduler = schedulerRef.current;
      if (!main || !groundStage || !layer || !scheduler) return;
      const ratio = layer.getCanvas().getPixelRatio();
      lastApplied.current = { camera: c, stage: main, ratio };
      const applied = onDeviceGrid(c, ratio);
      scheduler.moveCamera(() => {
        for (const st of [main, groundStage]) {
          st.x(applied.x);
          st.y(applied.y);
          st.scaleX(applied.scale);
          st.scaleY(applied.scale);
        }
      });
      live.setApplied(c, applied);
    },
    [live],
  );

  const onStage = props.onStage;
  const stageKey = props.stageKey;
  useLayoutEffect(() => {
    const ground = groundLayerRef.current;
    const reliefLayer = reliefLayerRef.current;
    const main = mainRef.current;
    if (!ground || !reliefLayer || !main) return;
    const scheduler = new FrameScheduler(ground, reliefLayer);
    schedulerRef.current = scheduler;
    const copy = groundCopy.current;
    ground.on("draw.groundCopy", () => void copy.version++);
    const stageCamera = (): Camera => cameraOfStage(main);
    scheduler.keep(
      keptHost<Konva.Node>({
        layer: reliefLayer as unknown as KeptLayer,
        camera: stageCamera,
        size: () => sizeRef.current,
        turn: () => dc.current?.turn ?? 0,
        key: () => stageKey,
        groundVersion: () => copy.version,
        dc: () => dc.current,
        items: () => itemsRef.current,
        children: () => reliefRootRef.current?.getChildren() ?? [],
        boxOf: (child, d) => paintedBoxOf(child, d, byStandeeRef.current, spotsRef.current),
        drawChild: (child, canvas) => child.drawScene(canvas as never),
      }),
    );
    // The chrome hung on map points hears of the camera once the canvas has drawn it (liveCamera.ts drawn).
    scheduler.afterDraw(() => {
      if (!hiddenRef.current) live.setDrawn(stageCamera());
    });
    onStage(main);
    return () => {
      ground.off("draw.groundCopy");
      scheduler.detach();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
      onStage(null);
    };
  }, [stageKey, onStage, live]);

  // After a render the stages take the live camera when it, the stage or the pixel ratio is new since the last one applied, as react-konva sets
  // a prop only when it changes: a render never writes an older camera back, and one that changes nothing moves nothing. The applier goes to
  // the room only while this board shows.
  useLayoutEffect(() => {
    renderedCull.current = { key: cullKey, box: cull };
    const want = live.camera ?? cam;
    if (needsApply(lastApplied.current, want, mainRef.current, reliefLayerRef.current?.getCanvas().getPixelRatio() ?? 0)) applyCamera(want);
    if (hidden) {
      if (live.applier) live.applier = null;
      live.setDrawn(null);
      return;
    }
    live.applier = (c) => {
      applyCamera(c);
      return cullFit(renderedCull.current, c, sizeRef.current);
    };
  });
  useLayoutEffect(
    () => () => {
      live.applier = null;
      live.setDrawn(null);
    },
    [live],
  );
  // What the bench and the e2e read of this board's frames (isoTest.ts), with the test flag only.
  useKeptReport(() => ({
    counts: () => {
      const s = schedulerRef.current;
      if (!s?.kept) return null;
      return { ...s.kept.stats, why: { ...s.kept.stats.why }, probe: s.kept.probe, frames: s.frames, draws: s.draws, cameraGroundDraws: s.cameraGroundDraws, slices: s.slices, slicesInWhole: s.slicesInWhole };
    },
    repaint: () => reliefLayerRef.current?.batchDraw(),
    measure: (on) => {
      const kept = schedulerRef.current?.kept;
      if (kept) kept.measure = on;
    },
    pixels: () => (reliefLayerRef.current?.getCanvas()._canvas as HTMLCanvasElement | undefined)?.toDataURL("image/png") ?? null,
    drawn: () => live.drawn,
  }));
  useCommitCount("board");
  // A texture's image arriving changes what the tops and sides draw, but no node's props: the relief repaints whole for it.
  useLayoutEffect(() => {
    reliefLayerRef.current?.batchDraw();
  }, [textures]);

  // Map labels split once by the stand rule: those that stand draw in the overlay, and the build on the ground stage leaves them out by id.
  // Split again when Inter loads, since the widths measured in the fallback font no longer hold.
  const labels = useMemo(() => Object.values(allLabels ?? {}).filter((l): l is NonNullable<typeof l> => !!l && l.sceneId === scene.id), [allLabels, scene.id]);
  const fontEpoch = useBoardFontEpoch();
  const [splitLabels] = useState(() => labelSplitter<(typeof labels)[number]>(measureLabel));
  const uprightLabels = splitLabels(fog, labels, fontEpoch).upright;
  const uprightIds = useMemo(() => new Set(uprightLabels.map((l) => l.id)), [uprightLabels]);

  /*
   * Token labels laid out in view space (5.4): each token's box is where its
   * decor stands, a standee's ring below it, and they keep off the pills and
   * the map labels where this board draws them, a map label by its ink as it
   * stands or lies by the stand rule. Hidden, it lays out nothing.
   */
  const groundAt = useCallback((x: number, y: number) => heights.atPoint({ x, y }), [heights]);
  // The frames alone, kept while none moves, so a drag's start, which marks its standee kept, lays nothing out again.
  const framesRef = useRef<ReadonlyMap<string, { frame: VBox; ring: VBox }> | null>(null);
  const frames = useMemo(() => {
    const next = new Map(standees.map((s) => [s.id, { frame: s.frame, ring: s.ring }]));
    const prev = framesRef.current;
    const same = prev !== null && prev.size === next.size && [...next].every(([id, f]) => {
      const p = prev.get(id);
      return p !== undefined && sameBox(p.frame, f.frame) && sameBox(p.ring, f.ring);
    });
    return same ? prev : (framesRef.current = next);
  }, [standees]);
  // A creature lying flat lays out on the drawn ground under it, where the ground stage copies its picture up a seen column.
  const flatGround = useCallback((t: ViewToken) => drawnFootprintGround(src, footprintCells(grid, t)) / feet, [src, grid, feet]);
  const flatIsoOf = useMemo(() => (flatCache.current = flatPressTokens(flatCache.current, flat, turn, flatGround, groundAt, grid)), [flat, turn, flatGround, groundAt, grid]);
  const placeOf = useCallback((t: ViewToken) => decorPlace(isometric(turn), t, frames.get(t.id), flatGround(t)), [turn, frames, flatGround]);
  const publishedPills = useTreeShownStore(useScoped(boardPillsSlot), (s) => s.pills);
  // Area and trap names read this layout. They cannot also be its inputs.
  const fixedPillsKey = JSON.stringify(tokenLayoutPills(publishedPills));
  const fixedPills = useMemo(() => tokenLayoutPills(publishedPills), [fixedPillsKey]);
  const viewPills = useMemo(() => fixedPills.map((p) => viewPill(p, isometric(turn), groundAt)), [fixedPills, turn, groundAt]);
  const labelInk = useMemo(
    () => labels.map((l) => mapLabelInk(l, isometric(turn), uprightIds.has(l.id), groundAt, measureLabel)),
    [labels, uprightIds, turn, groundAt, fontEpoch],
  );
  const isoText = useBoardText({ ...props.text, tokens: hidden ? NO_TOKENS : props.tokens, scale: cam.scale, pills: viewPills, mapLabels: labelInk, place: placeOf });
  const names = useMemo(() => ({ view, ground: groundAt, boxes: isoTokenBoxes(hidden ? NO_TOKENS : props.tokens, isoText, cam.scale, placeOf) }), [view, groundAt, hidden, props.tokens, isoText, cam.scale, placeOf]);
  const onText = props.onText;
  useLayoutEffect(() => {
    if (!hidden) onText(isoText);
  }, [hidden, isoText, onText]);
  // One context per place, so a renderer drawn in several knows which part it draws there (features/layers.ts IsoPlace).
  const groundCtx: IsoGround = useMemo(
    () => ({
      turn,
      fog,
      heights: stand,
      uprightLabels: uprightIds,
      place: "ground",
      ground: (x: number, y: number) => heights.atPoint({ x, y }),
      top: isHex(grid) ? (box: { x0: number; y0: number; x1: number; y1: number }) => hexBoxGround(heights, box) : undefined,
      surface: isHex(grid) ? { grid, atCell: heights.atCell } : undefined,
    }),
    [turn, fog, stand, uprightIds, heights, grid],
  );
  const movingCtx: IsoGround = useMemo(() => ({ ...groundCtx, place: "moving" }), [groundCtx]);
  const uprightCtx: IsoGround = useMemo(() => ({ ...groundCtx, place: "upright" }), [groundCtx]);
  const groups = groundGroups(turn);
  const width = hidden ? 0 : size.width;
  const height = hidden ? 0 : size.height;

  // Each ghost of another member's drag, standing or flat and clipped, at each eased spot (5.2).
  const ghostOf = useCallback(
    (t: ViewToken, at: { x: number; y: number }, name: string): IsoGhost => {
      const fp = footprint(t);
      const cells = footprintCells(grid, { ...t, x: at.x, y: at.y, squeeze: undefined });
      // It previews where the drop would land it there, on the ground this viewer has seen, as this device's own drag does (4.3).
      const room = store.getState().view;
      const seen = seenChunks({ chunks, sceneId: scene.id, bounds: { w, h }, fog: props.viewerFog });
      const landing = room ? previewLanding(room, props.role, seen, t, at) : t.elevation;
      const base = drawnBase(src, cells, landing) / feet;
      const ground = drawnFootprintGround(src, cells) / feet;
      if (ghostStands(fog, grid, t, at)) {
        const shape = standeeShape(turn, { x: at.x, y: at.y, w: fp.w, h: fp.h }, base, ground, cam.scale, size.height);
        const standee: IsoToken = { turn, base, ground, drawn: shape.drawnBase, capped: shape.capped, rise: 0, inset: 1, pits: [], dim: false, pressOnly: false, press: [] };
        // The tag stands over the art when the pill Top-down draws for it is clear too, and is left out otherwise.
        return { standee, clip: null, tag: ghostTagStands(fog, t, at, name, cam.scale) ? { x: (shape.art.x0 + shape.art.x1) / 2, y: shape.art.y0 } : null };
      }
      return { standee: null, clip: fog.revealedRects(tokenBox(grid, t, at)), tag: null };
    },
    [src, grid, feet, fog, turn, cam.scale, size.height, store, chunks, scene.id, w, h, props.viewerFog, props.role],
  );

  // The ground stage's layers cull by the layout's box, a step past the view, so a pan between steps finds them drawn. Its pills keep their points (5.8).
  const groundView = useMemo((): BoardViews => ({ clear: cull, canvas: cull }), [cullKey]);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: hidden ? "none" : undefined }} aria-hidden={hidden || undefined}>
      <TreeShownContext.Provider value={!hidden}>
      <IsoAreasContext.Provider value={isoAreas}>
      <IsoNamesContext.Provider value={names}>
        <Stage
          key={`ground:${props.stageKey}`}
          ref={groundStageRef}
          width={width}
          height={hidden ? 0 : height + margin}
          listening={false}
          // Hidden, both stages skip the draws their layers' own store subscriptions still ask for, past the memo.
          visible={!hidden}
          style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
        >
          <BoardViewContext.Provider value={groundView}>
          <Layer ref={groundLayerRef} listening={false}>
            <Group scaleY={groups.outer.scaleY}>
              <Group rotation={groups.inner.rotation}>
                <IsoGroundContext.Provider value={groundCtx}>
                  <MapContent scene={scene} variant={props.variant} report={!hidden} onDrawn={onDrawn} />
                  {GROUND_LAYERS.map(({ id, Component }) => (
                    <Component key={id} {...props.layerProps} />
                  ))}
                  {flat.map((t) => props.renderToken(t, null))}
                  {props.sightMode ? <SightOverlay scene={scene} mode={props.sightMode} /> : null}
                  {props.fog ? <FogShape sceneId={scene.id} bounds={scene.bounds} tiles={props.drawnFogTiles} translucent={props.role === "dm"} /> : null}
                  {GROUND_MARKS.map(({ id, Component }) => (
                    <Component key={id} {...props.layerProps} />
                  ))}
                </IsoGroundContext.Provider>
              </Group>
            </Group>
          </Layer>
          </BoardViewContext.Provider>
        </Stage>
        <Stage key={`main:${props.stageKey}`} ref={mainRef} width={width} height={height} visible={!hidden} style={{ ...props.stageStyle, position: "absolute", left: 0, top: 0 }}>
          <Layer ref={reliefLayerRef}>
            <Group scaleY={groups.outer.scaleY}>
              <Group ref={reliefRootRef} rotation={groups.inner.rotation}>
                {items.map((item, i) =>
                  item.kind === "run" ? <ReliefRun key={`run${i}`} pieces={item.pieces} dc={dc} /> : props.renderToken(byId.get(item.id)!, isoOf.get(item.id)!, isoText.get(item.id)),
                )}
                {flat.map((t) => props.renderToken(t, flatIsoOf.get(t.id)!))}
              </Group>
            </Group>
          </Layer>
          {/*
            The drag layer: what moves frame by frame. Other members' drags with
            their tags, and the moving marks, draw here rather than in the
            overlay, so a ghost's frame redraws none of the overlay's text. What a
            local drag moves comes into the empty group at its start
            (canvas/dragLayer.ts), over its own rings, auras and tethers, so each
            frame of this device's drag redraws this layer alone.
          */}
          <LiveBoardView size={size} insets={clear}>
          <Layer>
            <Group scaleY={groups.outer.scaleY} listening={false}>
              <Group rotation={groups.inner.rotation}>
                <RemoteDrags tokens={props.tokens} scale={cam.scale} youId={props.youId} draggingId={props.draggingId} eased={props.eased} iso={ghostOf} part="ghost" />
              </Group>
            </Group>
            <DragMarks tokenIds={dragged.local} iso={uprightCtx} layer={props.layerProps} side="behind" />
            <Group scaleY={groups.outer.scaleY}>
              <Group rotation={groups.inner.rotation} name={DRAG_GROUND} />
            </Group>
            <DragMarks tokenIds={dragged.local} iso={uprightCtx} layer={props.layerProps} side="front" />
            <Group scaleY={groups.outer.scaleY} listening={false}>
              <Group rotation={groups.inner.rotation}>
                <IsoGroundContext.Provider value={movingCtx}>
                  {MOVING_LAYERS.map(({ id, Component }) => (
                    <Component key={id} {...props.layerProps} />
                  ))}
                </IsoGroundContext.Provider>
              </Group>
            </Group>
            <Group listening={false}>
              <RemoteDrags tokens={props.tokens} scale={cam.scale} youId={props.youId} draggingId={props.draggingId} eased={props.eased} iso={ghostOf} part="tag" />
            </Group>
          </Layer>
          <Layer listening={false}>
            {silhouettes.map((s) => (
              <Silhouette key={s.id} token={byId.get(s.id)!} turn={turn} standee={byStandee.get(s.id)!} scale={cam.scale} />
            ))}
            <UprightLabels labels={uprightLabels} turn={turn} ground={(x, y) => heights.atPoint({ x, y })} />
            <IsoGroundContext.Provider value={uprightCtx}>
              {UPRIGHT_LAYERS.map(({ id, Component }) => (
                <Component key={id} {...props.layerProps} />
              ))}
            </IsoGroundContext.Provider>
            {/* The rings, auras and tethers of the tokens another member drags (5.1). This device's own move with its standees in the drag layer. */}
            <DragMarks tokenIds={dragged.remote} iso={uprightCtx} layer={props.layerProps} />
            {(["marks", "label", "plate"] as const).flatMap((part) =>
              props.decorTokens
                .filter((t) => part !== "plate" || !!isoText.get(t.id)?.plate)
                .flatMap((t) => {
                  const at = decorAt(t, byStandee, view, cull, props.keepIds, flatGround);
                  return at ? [props.renderDecor(t, part, at, isoText.get(t.id))] : [];
                }),
            )}
          </Layer>
          </LiveBoardView>
        </Stage>
        {aiming && settings && !hidden ? (
          <AimProbe settings={settings} chunks={chunks} liveGround={liveGround} scene={scene} fog={fog} aimMoving={aimMoving} tool={areaTool} draft={draft} selectedId={selectedArea} live={areaLive} templates={templates} role={props.role} youId={youId} casts={casts} onAim={setAim} />
        ) : null}
        {!hidden ? <Loading text="Building area shapes…" active={volumesNow?.waiting === true} style={buildingStyle(props.insets)} /> : null}
      </IsoNamesContext.Provider>
      </IsoAreasContext.Provider>
      </TreeShownContext.Provider>
    </div>
  );
}

/**
 * The board view the drag and overlay layers read (canvas/boardView.ts), at
 * the live camera: the upright pills slide into the clear part of the screen
 * through a pan that renders no board, and only they render for it (5.8).
 * While the tree is hidden it holds its last view and hears no camera, so a
 * Top-down pan renders none of them (review HXPERF2B-ASTRA-01).
 */
function LiveBoardView(props: { size: Size; insets: Insets; children: ReactNode }) {
  const live = useScoped(liveCameraSlot);
  const camera = useCameraWhileShown(live, useTreeShown());
  useCommitCount("pills");
  const { size, insets } = props;
  const value = useMemo(() => (camera ? boardViewsOf(camera, size, insets) : null), [camera, size.width, size.height, insets.top, insets.right, insets.bottom, insets.left]);
  return <BoardViewContext.Provider value={value}>{props.children}</BoardViewContext.Provider>;
}

/** The area the Area tool aims once the finger rests, and the context it reads. */
type Aim = { area: AimedArea; ctx: DeviceAreaContext };

type AimInput = Parameters<typeof aimedArea>[0];

/**
 * Reports the area the Area tool aims once the finger rests, with the live
 * tokens it reads (useLiveTokens), or null. While the finger moves it
 * stands coarse in the drag layer instead (AreaPreviewLayer.tsx).
 */
function AimProbe(props: {
  settings: AreaInputs["settings"];
  chunks: AreaInputs["buildChunks"];
  liveGround: AreaInputs["live"];
  scene: Parameters<typeof contextFrom>[1];
  fog: FogView;
  aimMoving: boolean;
  tool: string;
  draft: AimInput["draft"];
  selectedId: string | null;
  live: AimInput["live"];
  templates: AimInput["templates"];
  role: AimInput["role"];
  youId: string;
  casts: AimInput["casts"] | undefined;
  onAim: (aim: Aim | null) => void;
}) {
  const { settings, chunks, liveGround, scene, fog, aimMoving, tool, draft, selectedId, live, templates, role, youId, casts, onAim } = props;
  const { tokens, moving } = useLiveTokens();
  const ctx = useMemo(() => contextFrom({ tokens, buildChunks: chunks, settings, live: liveGround }, scene, SAMPLES, fog), [tokens, chunks, settings, liveGround, scene, fog]);
  const aim = useMemo((): Aim | null => {
    if (samplesNow(aimMoving || moving) !== SAMPLES) return null;
    const area = aimedArea({ tool, draft, selectedId, live, templates, sceneId: scene.id, tokens, grid: ctx.grid, feetPerCell: settings.feetPerCell, role, youId, casts: casts ?? {} });
    return area ? { area, ctx } : null;
  }, [aimMoving, moving, tokens, tool, draft, selectedId, live, templates, scene.id, ctx, settings.feetPerCell, role, youId, casts]);
  useEffect(() => onAim(aim), [aim, onAim]);
  useEffect(() => () => onAim(null), [onAim]);
  return null;
}

/** Where "Building area shapes…" shows: at the top of the canvas, clear of the bar over it, taking no presses (docs/design-v1-iso-area-shapes.md 7). */
function buildingStyle(insets: Insets | undefined): CSSProperties {
  return {
    position: "absolute",
    top: (insets?.top ?? 0) + theme.space(2),
    // In the middle of the part no panel covers.
    left: `calc(50% + ${((insets?.left ?? 0) - (insets?.right ?? 0)) / 2}px)`,
    transform: "translateX(-50%)",
    padding: `${theme.space(1)}px ${theme.space(3)}px`,
    borderRadius: theme.radius.pill,
    background: theme.color.overlay,
    color: theme.color.text,
    pointerEvents: "none",
    whiteSpace: "nowrap",
    zIndex: 1,
  };
}

function withoutTokens(tokens: Readonly<Record<string, Token | undefined>>, hide: ReadonlySet<string>): Record<string, Token> {
  const out: Record<string, Token> = {};
  for (const [id, t] of Object.entries(tokens)) if (t && !hide.has(id)) out[id] = t;
  return out;
}

/** A standing token as the board lays it out: its depth entry, its drawn base and seat, and the box its decor lays out on. */
type Standing = StandeeIn & { ground: number; capped: boolean; drawn: number; rise: number; inset: number; frame: VBox; ring: VBox };

/** The pieces each run's shape draws, so a scroll's walk over the relief's children can bound it (paintedBoxOf). */
const RUN_PIECES = new WeakMap<Konva.Node, readonly DrawPiece[]>();

/**
 * A child of the relief root's painted bounds in device pixels: a run's
 * pieces together, a standee's StandeeShape bounds, which hold its ring,
 * shadow, outlines, caught rings and facing tick with its decor's reach.
 * Null for a child it cannot bound, which a scroll always draws: a creature
 * lying flat, or a standee this device's drag places somewhere else.
 */
function paintedBoxOf(node: Konva.Node, dc: DrawContext, standees: ReadonlyMap<string, Standing>, spots: Readonly<Record<string, unknown>>): VBox | null {
  const pieces = RUN_PIECES.get(node);
  if (pieces) return runPaintedBox(pieces, dc);
  const s = standees.get(node.id());
  if (!s || spots[s.id] !== undefined) return null;
  return standeePaintedBox(s, dc);
}

/** One run of relief pieces, drawn by one shape that does not listen. */
const ReliefRun = memo(function ReliefRun(props: { pieces: DrawPiece[]; dc: { readonly current: DrawContext | null } }) {
  const { pieces, dc } = props;
  const register = useCallback(
    (node: Konva.Shape | null) => {
      if (node) RUN_PIECES.set(node, pieces);
    },
    [pieces],
  );
  return (
    <Shape
      ref={register}
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        const c = dc.current;
        if (c) drawRun(ctx._context, pieces, c);
      }}
    />
  );
});

/**
 * Where a token's decor box sits in view units: on a standee's art box, or
 * for a creature lying flat on its footprint's diamond, centered on it.
 * Null when its bounds lie off the canvas and nothing keeps it.
 */
function decorAt(
  t: ViewToken,
  standees: ReadonlyMap<string, Standing>,
  view: ReturnType<typeof isometric>,
  cull: VBox,
  keep: ReadonlySet<string>,
  flatGround: (t: ViewToken) => number,
): { x: number; y: number } | null {
  const s = standees.get(t.id);
  const at = decorPlace(view, t, s, s ? 0 : flatGround(t));
  if (s) return s.keep || meets(s.bounds, cull) ? at : null;
  // A creature lying flat draws its decor above the fog, as Top-down's decor already is (5.2): every token a player holds is partly in sight.
  const fp = footprint(t);
  const box = { x0: at.x - fp.w / 2, y0: at.y - fp.h / 2, x1: at.x + fp.w * 1.5, y1: at.y + fp.h * 1.5 };
  return keep.has(t.id) || meets(box, cull) ? at : null;
}

/** A covered standee's outline over whatever covers it (5.6). */
function Silhouette(props: { token: ViewToken; turn: Turn; standee: StandeeIn; scale: number }) {
  const { token, standee } = props;
  const a = standee.art;
  const ring = DISPOSITION_RING[token.disposition] ?? theme.color.neutral;
  const common = { stroke: ring, strokeWidth: 2, strokeScaleEnabled: false, opacity: theme.relief.silhouetteOpacity, listening: false } as const;
  return token.kind === "object" ? (
    <Rect x={a.x0} y={a.y0} width={a.x1 - a.x0} height={a.y1 - a.y0} {...common} />
  ) : (
    <Ellipse x={(a.x0 + a.x1) / 2} y={(a.y0 + a.y1) / 2} radiusX={(a.x1 - a.x0) / 2} radiusY={(a.y1 - a.y0) / 2} {...common} />
  );
}

/**
 * Map labels the stand rule stands up: each text block in the box
 * labelShape gives it (builder/labelShape.ts), on its anchor at the drawn
 * ground under it, in view space, the same box a tap on it reads. The rest
 * lie flat in the build on the ground stage, under the fog.
 */
const UprightLabels = memo(function UprightLabels(props: { labels: readonly Pick<Label, "x" | "y" | "text" | "size">[]; turn: Turn; ground: (x: number, y: number) => number }) {
  const { labels, turn, ground } = props;
  if (labels.length === 0) return null;
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        const view = isometric(turn);
        for (const l of labels) {
          const { box } = labelShape(l, view, { measure: measureLabel, upright: true, ground: ground(l.x, l.y) });
          // drawLabel centers the text on its point: the middle of the box.
          drawLabel(ctx._context, { x: box.x + box.width / 2, y: box.y + box.height / 2, text: l.text, size: l.size });
        }
      }}
    />
  );
});

function terrainAt(chunks: Readonly<Record<string, BuildChunk | undefined>>, sceneId: string, x: number, y: number): TerrainId | null {
  const chunk = chunks[`${sceneId}:${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`];
  return chunk?.cells[`${x},${y}`] ?? null;
}

function sameBox(a: VBox, b: VBox): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

function sameRect(a: { x: number; y: number; width: number; height: number } | undefined, b: { x: number; y: number; width: number; height: number } | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
