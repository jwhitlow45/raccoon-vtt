import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AutoWalls, Scene } from "#shared/model.ts";
import { MAX_SCENE_CELLS, type OpOf } from "#shared/protocol.ts";
import { autoWallsOf } from "#shared/rules/autoWalls.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { useExpansionFocus } from "../../components/expansionFocus.ts";
import { ErrorText, FieldRow, Input } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Help, Note, Section } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { Switch } from "../../components/Switch.tsx";
import { useUnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import type { ViewKind } from "../../lib/view.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useAssets, useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { calibrationFromCounts, fitBounds, imageSquares, sameCalibration } from "../grid/calibrate.ts";
import { copyUrls, importSearch, IMPORT_WAIT_MS, nameGivesSize, replacementFound, searchOnImport, type ImportWait } from "../grid/findGrid.ts";
import { showOutcome } from "../grid/outcome.ts";
import { shapeChanged, useGridStore } from "../grid/store.ts";
import { useFindGrid, useLandLater } from "../grid/useFindGrid.ts";
import { shapeRefusal, ShapeRow } from "../grid/ShapeRow.tsx";
import { HEX_LIMITS, SHAPE_HELP, sceneCellWord, shapeChoice, sizeWords, type ShapeChoice } from "../grid/words.ts";
import { PasteButton, PasteStatus, usePasteTarget } from "../images/PasteImage.tsx";
import { MapExport } from "../mapexport/MapExport.tsx";
import { BlockMovementSetting } from "../movement/SceneSetting.tsx";
import { PhasesSection } from "../phases/PhasesSection.tsx";
import { thisDevice } from "../uvtt/limits.ts";
import { isoOffered, suggestedKind, SUGGESTED_VIEW, SUGGESTED_VIEW_HELP, VIEW_NAMES } from "../view/choice.ts";
import { VisionSettings } from "../vision/VisionSettings.tsx";
import { deleteBlocked, sceneAfterDelete } from "./afterDelete.ts";
import { ColorInput, ConfirmButton, NumberInput, Select, Slider } from "./controls.tsx";
import { fogsWithFirstMap, replaceMap, sameArt, viewFromCamera } from "./create.ts";
import { useStartFraming } from "./FrameView.tsx";
import { SCENE_GROUP_LABELS, useSceneFolds, type SceneGroup } from "./settingsFolds.ts";
import { currentStageCamera } from "./stageCamera.ts";
import { uploadErrorText, uploadMap } from "./upload.ts";
import { layoutWidth } from "../device/layout.ts";
import type { PanelClose } from "../panels.ts";

/**
 * Settings of the scene the DM is looking at, grouped by what each is for
 * (docs/design-v1-map-discovery.md 8.4): the scene's name with no header,
 * then What players see, everything that decides what reaches players
 * (features/vision/VisionSettings.tsx), then Map image and grid, Walls and
 * movement, and the scene's own size, background and views, then export
 * and deleting it. Each group folds, setup groups starting folded on a
 * phone (settingsFolds.ts), and stays mounted while folded, so an upload
 * in it is never cut short. Every change is one op, so it shows at once
 * and undo covers it, and a setting that is on or off is a Switch row
 * named by the setting (docs/design-v1-visual.md 3.7), never a button
 * named by its state.
 */
export function SceneSettings(props: { scene: Scene; others: Scene[]; close: PanelClose }) {
  const { scene, others } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const startFraming = useStartFraming();
  const fold = useSceneFolds();
  const group = (key: SceneGroup) => ({ ...fold(key), keep: true });
  const update = (patch: OpOf<"scene.update">["patch"]) => actions.dispatch({ t: "scene.update", sceneId: scene.id, patch });
  const playerSceneId = useRoomView((s) => s.view?.meta.playerSceneId ?? null);
  const deleteWhy = deleteBlocked(others, scene.id, playerSceneId);
  const deleteHelp = useId();
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const size = sizeWords(sceneGrid(scene), scene.bounds, feetPerCell);

  const saveView = () => {
    // A phone's sheet hides most of the map, so the DM frames the view with the sheet closed (FrameView.tsx).
    if (layoutWidth() < theme.layout.wideMinWidth) {
      startFraming(scene.id);
      props.close();
      return;
    }
    const live = currentStageCamera(scope);
    if (live) update({ defaultView: viewFromCamera(live) });
  };

  return (
    <>
      <Section>
        <NameField key={scene.id} name={scene.name} onSave={(name) => update({ name })} />
      </Section>

      <VisionSettings scene={scene} fold={group("players")} />

      <Section label={SCENE_GROUP_LABELS.map} fold={group("map")}>
        <MapImageRow scene={scene} close={props.close} />
        <PhasesSection scene={scene} />
        <GridStyle scene={scene} onChange={(grid) => update({ grid })} close={props.close} />
      </Section>

      <Section label={SCENE_GROUP_LABELS.walls} fold={group("walls")}>
        <BlockMovementSetting scene={scene} />
        <SettingRow name="Automatic walls" help={AUTO_WALLS_NOTE[autoWallsOf(scene)]} wide>
          <Select<AutoWalls> label="Automatic walls" value={autoWallsOf(scene)} options={AUTO_WALLS} onChange={(autoWalls) => update({ autoWalls })} />
        </SettingRow>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
          <Button
            size="sm"
            onClick={() => {
              ui.setTool("build");
              props.close({ placing: true });
            }}
          >
            Open the builder
          </Button>
          <ConfirmButton label="Clear the build" confirm="Tap again to clear" title="Remove every floor, wall, door, height, stair, label, light and stamp" onConfirm={() => actions.dispatch({ t: "build.clear", sceneId: scene.id })} />
        </div>
      </Section>

      <Section label={SCENE_GROUP_LABELS.scene} fold={group("scene")}>
        <SettingRow name={size.name} help={size.holds ?? undefined} wide>
          <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
            <NumberInput label={size.across} value={scene.bounds.w} min={1} max={MAX_SCENE_CELLS} onChange={(w) => update({ bounds: { ...scene.bounds, w } })} />
            <span aria-hidden>×</span>
            <NumberInput label={size.down} value={scene.bounds.h} min={1} max={MAX_SCENE_CELLS} onChange={(h) => update({ bounds: { ...scene.bounds, h } })} />
          </div>
        </SettingRow>
        <SettingRow name="Background">
          <ColorInput label="Background color" value={scene.background} onChange={(background) => update({ background })} />
        </SettingRow>
        <SettingRow name="Starting view" help={scene.defaultView ? "The scene opens where you saved it." : "The scene opens fitted to the screen."} wide>
          <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
            <Button size="sm" onClick={saveView}>
              Save current view
            </Button>
            {scene.defaultView ? (
              <Button size="sm" onClick={() => update({ defaultView: null })}>
                Clear
              </Button>
            ) : null}
          </div>
        </SettingRow>
        {isoOffered ? <SuggestedView scene={scene} onChange={(suggestedView) => update({ suggestedView })} /> : null}
      </Section>

      <MapExport scene={scene} />

      <Section label="Delete">
        <div>
          <ConfirmButton
            label="Delete scene"
            confirm="Tap again to delete"
            title="Delete this scene and everything on it"
            disabled={others.length === 0}
            unavailable={deleteWhy !== null}
            describedBy={deleteHelp}
            onConfirm={() => {
              const next = sceneAfterDelete(others, scene.id);
              if (!next || deleteWhy !== null) return;
              actions.dispatch({ t: "scene.delete", sceneId: scene.id });
              actions.switchScene(next.id);
            }}
          />
        </div>
        <Help id={deleteHelp}>{deleteWhy ?? "Removes its tokens, drawings, build and fog too."}</Help>
      </Section>
    </>
  );
}

const VIEWS: readonly { value: ViewKind; label: string }[] = [
  { value: "topDown", label: VIEW_NAMES.topDown },
  { value: "isometric", label: VIEW_NAMES.isometric },
];

/**
 * The view devices that follow the scene show on it
 * (docs/design-v1-isometric-view.md 7): Top-down, which stores nothing, or
 * Isometric. Each device may pick its own view instead, from the View
 * button, and a pick holds until it follows the scene again.
 */
function SuggestedView(props: { scene: Scene; onChange(view: ViewKind): void }) {
  return (
    <SettingRow name={SUGGESTED_VIEW} help={SUGGESTED_VIEW_HELP} wide>
      {(ids) => <Segmented<ViewKind> labelledBy={ids.nameId} value={suggestedKind(props.scene.suggestedView)} options={VIEWS} onChange={props.onChange} />}
    </SettingRow>
  );
}

/**
 * The walls the builder adds where painted ground meets unpainted ground
 * (docs/design-v1-maps-vision.md section 2.1). Each note names the edges its
 * rule walls, so switching says which edges open or close.
 */
const AUTO_WALLS: readonly { value: AutoWalls; label: string }[] = [
  { value: "all", label: "Around every painted cell" },
  { value: "floor", label: "Around floor only" },
  { value: "off", label: "Off" },
];

const AUTO_WALLS_NOTE: Record<AutoWalls, string> = {
  all: "A wall wherever a painted cell meets unpainted ground, water, stairs and pillars included.",
  floor: "A wall wherever stone, wood, grass, dirt or cave meets unpainted ground. Water, difficult ground, rubble, pits, pillars and stairs are not walled in.",
  off: "No automatic walls. Only the walls and doors you draw.",
};

function NameField(props: { name: string; onSave(name: string): void }) {
  const id = useId();
  const [text, setText] = useState(props.name);
  // Enter saves, and the blur that follows must not save the same name again.
  const saved = useRef(props.name);
  useEffect(() => {
    setText(props.name);
    saved.current = props.name;
  }, [props.name]);
  const save = () => {
    const trimmed = text.trim();
    if (trimmed && trimmed !== saved.current) {
      saved.current = trimmed;
      props.onSave(trimmed);
    } else if (!trimmed) {
      setText(props.name);
    }
  };
  return (
    <FieldRow label="Scene name" fill htmlFor={id}>
      <Input
        id={id}
        value={text}
        maxLength={80}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
        style={{ flex: 1, width: "100%" }}
      />
    </FieldRow>
  );
}

/** The grid lines' look, and for a map image, how its squares line up with the scene's: the rest of Map image and grid. */
function GridStyle(props: { scene: Scene; onChange(grid: Scene["grid"]): void; close: PanelClose }) {
  const { grid } = props.scene;
  const set = (patch: Partial<Scene["grid"]>) => props.onChange({ ...grid, ...patch });
  return (
    <>
      <Switch
        label="Grid lines"
        help={props.scene.map ? `Hide them when the map has its own grid. Tokens and rulers still follow the ${sceneCellWord(props.scene, true)}.` : undefined}
        checked={grid.show}
        onChange={(show) => set({ show })}
      />
      <SettingRow name="Grid color">
        <ColorInput label="Grid color" value={grid.color} onChange={(color) => set({ color })} />
      </SettingRow>
      {grid.show ? (
        <>
          <Slider label="Opacity" value={grid.opacity} min={0.05} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(opacity) => set({ opacity })} />
          <Slider label="Line width" value={grid.lineWidth} min={0.5} max={4} step={0.5} format={(v) => `${v} px`} onChange={(lineWidth) => set({ lineWidth })} />
        </>
      ) : null}
      <GridShape scene={props.scene} close={props.close} />
      {props.scene.map ? <MapGrid key={props.scene.id} scene={props.scene} map={props.scene.map} close={props.close} /> : null}
    </>
  );
}

/**
 * The scene's grid shape (docs/design-v1-hex-grids.md section 8), beside
 * Line up the grid. A shape the scene's content cannot stand on is off,
 * with the reducer's own words for why (shared/rules/grid.ts
 * `switchRefusal`), and so is every hex shape for a scene that came with
 * its own square grid. A map scene keeps its scale and origin and opens
 * Line up grid, since its art's cells are another shape now (HX-D14).
 */
function GridShape(props: { scene: Scene; close: PanelClose }) {
  const { scene } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const gridStore = useGridStore();
  const refusal = (c: ShapeChoice) => (s: { view: Parameters<typeof shapeRefusal>[0] | null }) => (s.view ? shapeRefusal(s.view, scene, c) : null);
  const squares = useRoomView(refusal("squares"));
  const rows = useRoomView(refusal("hexRows"));
  const columns = useRoomView(refusal("hexColumns"));
  const refused: Partial<Record<ShapeChoice, string>> = {};
  for (const [c, why] of [["squares", squares], ["hexRows", rows], ["hexColumns", columns]] as const) if (why !== null) refused[c] = why;
  return (
    <ShapeRow
      name="Grid shape"
      help={SHAPE_HELP}
      value={shapeChoice(scene.gridShape)}
      refused={refused}
      onChange={(gridShape) => {
        if (refused[gridShape] !== undefined) return;
        // A square grid searched for or found stands for nothing on hexes, nor a hex box on squares.
        shapeChanged(gridStore, scene.id);
        actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { gridShape } });
        if (scene.map) {
          ui.setTool("grid");
          props.close({ placing: true });
        }
      }}
    />
  );
}

/**
 * A map image's scale: aligning its grid with a box on the map, or by
 * counting the squares across and down the art.
 */
function MapGrid(props: { scene: Scene; map: NonNullable<Scene["map"]>; close: PanelClose }) {
  const { scene, map } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const findGrid = useFindGrid();
  const hex = isHex(sceneGrid(scene));
  const findOffId = useId();
  const squares = imageSquares(map);
  const [across, setAcross] = useState(squares.across);
  const [down, setDown] = useState(squares.down);
  /** The DM typed a count. Only then can the counts be wrong: the ones filled in are the grid's own. */
  const [countsEdited, setCountsEdited] = useState(false);
  useEffect(() => {
    setAcross(squares.across);
    setDown(squares.down);
    setCountsEdited(false);
  }, [scene.id, squares.across, squares.down]);
  // Only Apply sends counts typed over the grid's own, so a sheet's swipe springs back until then (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(countsEdited && (across !== squares.across || down !== squares.down));
  const counts = calibrationFromCounts(map, across, down);

  const applyCounts = () => {
    const cal = { cellPx: counts.cellPx, originPx: counts.originPx };
    if (!sameCalibration(cal, map)) actions.dispatch({ t: "scene.setGrid", sceneId: scene.id, ...cal });
    const bounds = fitBounds({ ...map, ...cal });
    if (bounds.w !== scene.bounds.w || bounds.h !== scene.bounds.h) actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { bounds } });
  };

  return (
    <>
      <SettingRow
        name="Map grid"
        help={`${formatPx(map.cellPx)} px per ${sceneCellWord(scene)}, first line at ${formatPx(map.originPx.x)}, ${formatPx(map.originPx.y)} of a ${map.widthPx} × ${map.heightPx} image.`}
        wide
      >
        <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
          <Button
            size="sm"
            onClick={() => {
              ui.setTool("grid");
              props.close({ placing: true });
            }}
          >
            Line up the grid
          </Button>
          {/* The search's progress and its answer show in Line up grid, which opens over the map it looks at. */}
          <Button
            size="sm"
            title={hex ? HEX_LIMITS.findGrid : "Look for a grid drawn on the map and line up with it"}
            disabled={hex}
            aria-describedby={hex ? findOffId : undefined}
            onClick={() => {
              findGrid(scene.id);
              ui.setTool("grid");
              props.close({ placing: true });
            }}
          >
            Find the grid
          </Button>
        </div>
      </SettingRow>
      {hex ? (
        <>
          <Help id={findOffId}>{HEX_LIMITS.findGrid}</Help>
          <Help>{HEX_LIMITS.counting}</Help>
        </>
      ) : null}
      {/* Counting assumes squares that start at the image's corner. A grid whose first line sits before the image
          only comes from a Universal VTT file, and counting would slide the image half a square under its walls. */}
      {hex || map.originPx.x < 0 || map.originPx.y < 0 ? null : (
        <SettingRow name="Or count the squares" wide>
          <div style={{ display: "grid", gap: theme.space(1) }}>
            {/* The counts keep their line together, so Apply wraps under them whole on a narrow phone, never beside one of them. */}
            <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
                <NumberInput
                  label="Squares across the image"
                  value={across}
                  min={1}
                  max={MAX_SCENE_CELLS}
                  onChange={(n) => {
                    setAcross(n);
                    setCountsEdited(true);
                  }}
                />
                <span aria-hidden>×</span>
                <NumberInput
                  label="Squares down the image"
                  value={down}
                  min={1}
                  max={MAX_SCENE_CELLS}
                  onChange={(n) => {
                    setDown(n);
                    setCountsEdited(true);
                  }}
                />
              </div>
              <Button size="sm" onClick={applyCounts}>
                Apply
              </Button>
            </div>
            {countsEdited && counts.mismatch > 0.02 ? (
              <Note>
                Those counts make squares that are not square ({formatPx(map.widthPx / across)} by {formatPx(map.heightPx / down)} px). Check them.
              </Note>
            ) : (
              <Help>For art whose squares run edge to edge. Also resizes the scene to match.</Help>
            )}
          </div>
        </SettingRow>
      )}
    </>
  );
}

/**
 * The map image's row, first in Map image and grid: adding one to a scene
 * without, replacing it, or removing it.
 *
 * On the scene the players are on, a new image shows on their screens the
 * moment it uploads, so the picker asks first (features 3: the DM prepares
 * privately). A scene's first image also brings the fog a map scene starts
 * with (create.ts `fogsWithFirstMap`), which the DM can decline there.
 */
function MapImageRow(props: { scene: Scene; close: PanelClose }) {
  const { scene } = props;
  const map = scene.map;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const roomId = useRoomView((s) => s.roomId);
  const playersHere = useRoomView((s) => s.view?.meta.playerSceneId === scene.id);
  const hasBuild = useRoomView((s) =>
    Object.values(s.view?.buildChunks ?? {}).some((c) => c?.sceneId === scene.id && (Object.keys(c.cells).length > 0 || Object.keys(c.edges).length > 0)),
  );
  const firstFog = fogsWithFirstMap(scene, hasBuild);
  /** On the players' scene: the DM has read the warning, and the picker is out. */
  const [armed, setArmed] = useState(false);
  const [fogIt, setFogIt] = useState(true);
  // The picked image reads the fog choice, so a sheet's swipe springs back while the picker is out with it changed (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(armed && !fogIt);
  useEffect(() => setArmed(false), [scene.id]);
  /*
   * The button that arms the picker gives way to it, and Cancel gives way
   * back. Focus follows: to the picker, which names the warning beside it
   * as its description, and back to the button.
   */
  const askRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const warningId = useId();
  useExpansionFocus(playersHere && armed, { inside: fileRef, opener: askRef });
  const [upload, setUpload] = useState<{ busy: boolean; waiting: boolean; finding?: boolean; error: string | null }>({ busy: false, waiting: false, error: null });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const gridStore = useGridStore();
  const room = useRoomStore();
  const assets = useAssets();
  const landLater = useLandLater();
  const phaseCount = scene.phases?.length ?? 0;
  /*
   * A key paste lands here only with focus in the row, and on the players'
   * scene only once the DM has confirmed (docs/design-v1-paste.md 1.2):
   * the row is on screen whenever the Scenes panel is, and a paste uploads
   * at once, so a Ctrl+V meant for the room must never replace the map.
   * Confirming moves focus into the row, so the rule costs nothing.
   */
  const rowRef = useRef<HTMLDivElement>(null);
  /** On the players' scene before the DM confirms, the row takes no paste by any path: not a key, not the box, not a late answer. */
  const unconfirmed = playersHere && !armed;
  const paste = usePasteTarget(rowRef, {
    accepts: "image",
    takes: unconfirmed ? "none" : "focus",
    disabled: upload.busy || unconfirmed,
    closed: unconfirmed,
    onFile: (f) => {
      if (!unconfirmed) void choose(f, true);
    },
  });

  const choose = async (file: File, pasted = false) => {
    const abort = new AbortController();
    abortRef.current = abort;
    setUpload({ busy: true, waiting: false, error: null });
    // A new image is searched for a drawn grid while it uploads, as a new
    // map scene's is (NewScene.tsx). Only the upload tells whether it is
    // the old art at another size, which keeps the scene's grid, scaled.
    const device = thisDevice();
    const hex = isHex(sceneGrid(scene));
    let search = searchOnImport({ source: "image", named: nameGivesSize(file.name), hex }) ? importSearch(file, device) : null;
    abort.signal.addEventListener("abort", () => search?.cancel());
    try {
      const asset = await uploadMap(roomId, file, { pasted, signal: abort.signal, onWaiting: (waiting) => setUpload((u) => ({ ...u, waiting })) });
      let wait: ImportWait = { answer: null, later: null };
      if ((!map || !sameArt(map, asset)) && asset.cellPx === undefined && !hex) {
        search ??= importSearch(file, device);
        setUpload({ busy: true, waiting: false, finding: true, error: null });
        wait = await search.afterUpload(copyUrls(device, (variant) => assets.url(asset.id, variant)), IMPORT_WAIT_MS);
      } else search?.cancel();
      if (abort.signal.aborted) {
        wait.later?.cancel();
        return;
      }
      setUpload({ busy: false, waiting: false, error: null });
      setArmed(false);
      const next = replaceMap(map, asset);
      const { found, ownGrid } = replacementFound(wait.answer, asset.cellPx !== undefined, next, scene);
      // Fog first, so players on this scene never see the map before it.
      if (firstFog && (!playersHere || fogIt)) actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { fogEnabled: true } });
      actions.dispatch({ t: "scene.setMap", sceneId: scene.id, map: next });
      // A replacement keeps the scene as it is, unless a grid was found on
      // new art, which a scene with its own grid is only offered, or a
      // phone's search of the copy goes on past the wait, which Line up grid
      // shows. A first image either knows its scale from its name, so the
      // scene fits it now, or the grid tool comes up to find the scale
      // (and fits the scene when applied).
      const fallback = { cellPx: next.cellPx, originPx: next.originPx };
      if (!map && asset.cellPx !== undefined && next.cellPx === asset.cellPx) {
        const bounds = fitBounds(next);
        if (bounds.w !== scene.bounds.w || bounds.h !== scene.bounds.h) actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { bounds } });
      } else if (!map || found || wait.later) {
        // The shape the room holds now, not as the upload began: Grid shape may have changed meanwhile, here or on another device.
        const gridShape = room.getState().view?.scenes[scene.id]?.gridShape;
        const landing = { id: scene.id, bounds: scene.bounds, gridShape, map: next };
        if (found) {
          const at = { x: next.widthPx / 2, y: next.heightPx / 2 };
          showOutcome({ actions, store: gridStore, scene: landing, found, fit: true, at, fallback, ownGrid });
        } else if (wait.later) landLater({ sceneId: scene.id, start: landing, search: wait.later, fallback, ownGrid });
        ui.setTool("grid");
        props.close({ placing: true });
      }
    } catch (err) {
      if (!abort.signal.aborted) setUpload({ busy: false, waiting: false, error: uploadErrorText(err) });
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  };

  // A label over a file input, so it takes the tap that opens the picker. It wears the small secondary button's look.
  const filePicker = (label: string) => (
    <label
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: theme.space(2),
        minHeight: theme.touch,
        padding: `0 ${theme.space(3)}px`,
        borderRadius: theme.radius.md,
        fontSize: theme.font.body14,
        fontWeight: theme.weight.strong,
        cursor: upload.busy ? "default" : "pointer",
        ...buttonLook("secondary", { disabled: upload.busy }),
      }}
    >
      {upload.finding ? "Looking for a grid…" : upload.busy ? "Uploading…" : label}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        disabled={upload.busy}
        aria-describedby={playersHere ? warningId : undefined}
        style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", cursor: "pointer" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void choose(f);
        }}
      />
    </label>
  );

  const status = (
    <>
      <PasteStatus paste={paste} />
      <Loading text="Waiting for the server…" active={upload.waiting} />
      <ErrorText>{upload.error}</ErrorText>
    </>
  );

  /* Removing the image removes every map phase with it (docs/design-v1-maps-vision.md section 3.4), so the second tap says so. */
  const removeButton = (
    <ConfirmButton
      label="Remove map image"
      confirm={phaseCount > 1 ? `Tap again to remove all ${phaseCount} phases` : "Tap again to remove"}
      title={phaseCount > 1 ? "Removes the map image and every map phase of this scene" : undefined}
      onConfirm={() => actions.dispatch({ t: "scene.setMap", sceneId: scene.id, map: null })}
    />
  );

  /*
   * The players' scene asks before the picker opens: the image is theirs to
   * see the moment it uploads. Cancel and Remove each stand on a line of
   * their own under the ways to bring an image, apart from them, so neither
   * wraps alone under them.
   */
  const picker = (label: string) =>
    playersHere && !armed && !upload.busy ? (
      <>
        <Row>
          <Button ref={askRef} size="sm" onClick={() => setArmed(true)}>
            {label}
          </Button>
        </Row>
        {map ? <Row>{removeButton}</Row> : null}
      </>
    ) : (
      <>
        <Row>
          {filePicker(playersHere ? "Choose the image" : label)}
          <PasteButton paste={paste} />
        </Row>
        {playersHere && !upload.busy ? (
          <Row>
            <Button size="sm" onClick={() => setArmed(false)}>
              Cancel
            </Button>
          </Row>
        ) : null}
        {map ? <Row>{removeButton}</Row> : null}
        {playersHere ? <Note id={warningId}>The players are on this scene. They see the new image as soon as it uploads.</Note> : null}
        {firstFog && playersHere ? <Checkbox label="Start it under fog, so they see only what you reveal" checked={fogIt} onChange={setFogIt} /> : null}
        {firstFog && !playersHere ? <Help>Fog turns on with the first map, as for a scene made from a map.</Help> : null}
      </>
    );

  // Its buttons, the warning, the fog choice and the status stack under the name, as the section they came from did.
  return (
    <SettingRow name="Map image" help={map ? `A ${map.widthPx} × ${map.heightPx} px image.` : "No map image yet."} wide>
      <div ref={rowRef} style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(2) }}>
        {picker(map ? "Replace map image" : "Add a map image")}
        {status}
      </div>
    </SettingRow>
  );
}

function Row(props: { children: ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>{props.children}</div>;
}

function formatPx(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
