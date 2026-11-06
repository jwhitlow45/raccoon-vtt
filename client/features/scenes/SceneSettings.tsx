import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { AutoWalls, Scene } from "#shared/model.ts";
import { MAX_SCENE_CELLS, type OpOf } from "#shared/protocol.ts";
import { autoWallsOf } from "#shared/rules/autoWalls.ts";
import { gridOfShape, isHex, sceneGrid } from "#shared/rules/grid.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { useExpansionFocus } from "../../components/expansionFocus.ts";
import { ErrorText, FieldRow, Input } from "../../components/Field.tsx";
import { Loading, Spinner } from "../../components/Loading.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Group, GROUP_FOLD, Help, Note, Section } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { Switch } from "../../components/Switch.tsx";
import { Tag } from "../../components/Tag.tsx";
import { scrollBox, startInScrollBox } from "../../lib/reveal.ts";
import { useUnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import type { ViewKind } from "../../lib/view.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { useAssets, useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { calibrationFromCounts, fitBounds, imageSquares, sameCalibration } from "../grid/calibrate.ts";
import { copyUrls, importSearch, IMPORT_WAIT_MS, nameGivesSize, replacementFound, searchOnImport, type ImportWait } from "../grid/findGrid.ts";
import { showOutcome } from "../grid/outcome.ts";
import { shapeChanged, useGridStore } from "../grid/store.ts";
import { useFindGrid, useLandLater, useSwitchRefusal } from "../grid/useFindGrid.ts";
import { shapeRefusal, ShapeRow } from "../grid/ShapeRow.tsx";
import { HEX_LIMITS, SHAPE_HELP, sceneCellWord, shapeChoice, sizeWords, storedShape, type ShapeChoice } from "../grid/words.ts";
import { isVideoFile } from "../animmap/firstFrame.ts";
import { MapVideoHelp, ProbeHost, StillPick, UseStillOnly, useVideoUpload } from "../animmap/MapVideoRow.tsx";
import { useServerAnimatedMaps } from "../animmap/status.ts";
import { animatedUploadText, mapAccept, stepText, VIDEO_PICK_HELP } from "../animmap/upload.ts";
import { PasteButton, PasteStatus, usePasteTarget } from "../images/PasteImage.tsx";
import { MapExport } from "../mapexport/MapExport.tsx";
import { BlockMovementSetting } from "../movement/SceneSetting.tsx";
import { PhasesSection } from "../phases/PhasesSection.tsx";
import { thisDevice } from "../uvtt/limits.ts";
import { isoOffered, suggestedKind, SUGGESTED_VIEW, SUGGESTED_VIEW_HELP, VIEW_NAMES } from "../view/choice.ts";
import { LightSettings, useWallless, VisionSettings } from "../vision/VisionSettings.tsx";
import { SceneWeather } from "../weather/WeatherSettings.tsx";
import { useServerRoomSoundState } from "../sound/engine/store.ts";
import { ColorInput, ConfirmButton, NumberInput, Select, Slider } from "./controls.tsx";
import { fogsWithFirstMap, nameCellPx, refitsToNamedMap, replacement, viewFromCamera, type MapAsset } from "./create.ts";
import { useStartFraming } from "./FrameView.tsx";
import { sceneRequestSlot, useSceneRequestSeq } from "./request.ts";
import { sceneGroupSummary, sceneSoundSummary } from "./sceneSummary.ts";
import { SceneSoundSettings, useSceneSoundNames } from "./SceneSoundSettings.tsx";
import { SCENE_GROUP_ICONS, SCENE_GROUP_LABELS, useSceneFolds, type SceneGroup } from "./settingsFolds.ts";
import { currentStageCamera } from "./stageCamera.ts";
import { uploadErrorText, uploadMap } from "./upload.ts";
import { layoutWidth } from "../device/layout.ts";
import { takeOverPanelScroll, type PanelClose } from "../panels.ts";

/**
 * Settings of the scene the DM is looking at, grouped by what the DM is
 * doing (docs/design/design-v1-scenes-reorg.md 3): the scene's name under
 * "This scene", apart from New scene above it (docs/design/design-v1-design-pass.md
 * 4.1), then Light and weather, the group changed in play, open on every
 * width, then the setup groups: Scene sound (the preset Move players
 * starts), Fog and vision (everything that decides what reaches players,
 * features/vision/VisionSettings.tsx), Map and grid, Walls and movement,
 * and Size and view, then Export. Deleting the scene is in its row's ⋯ menu
 * alone (SceneMenu.tsx). Each group folds as the panel kit's `Group`, with
 * its icon and, folded, what it holds (sceneSummary.ts), setup groups
 * starting folded on a phone (lib/folds.ts SCENES_FOLDS), and stays mounted
 * while folded, so an upload in it is never cut short. Every change is one
 * op, so it shows at once and undo covers it, and a setting that is on or
 * off is a Switch row named by the setting (docs/design/design-v1-visual.md
 * 3.7), never a button named by its state.
 *
 * Ambiance's Weather and Scene sound rows open these settings at their
 * group (features/scenes/request.ts): the settings take the request once,
 * as they mount or on a new press, scroll its group into view and move
 * focus there (useSceneRequest).
 */
export function SceneSettings(props: { scene: Scene; others: Scene[]; close: PanelClose }) {
  const { scene } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const startFraming = useStartFraming();
  const fold = useSceneFolds();
  // As the token panel's and the character page's groups (docs/design/design-v1-design-pass.md 4.1), kept mounted while folded so an upload in one is never cut short.
  const group = (key: SceneGroup, summary: string) => ({ label: SCENE_GROUP_LABELS[key], icon: SCENE_GROUP_ICONS[key], ...fold(key), keep: true, summary });
  const update = (patch: OpOf<"scene.update">["patch"]) => actions.dispatch({ t: "scene.update", sceneId: scene.id, patch });
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const size = sizeWords(sceneGrid(scene), scene.bounds, feetPerCell);
  // Scene sound shows only while the server offers sound files, as the Sound panel's line did: with the switch off nothing plays to save (SoundPanel.tsx).
  const sound = useServerRoomSoundState() === "on";
  const soundNames = useSceneSoundNames(scene);
  const wallless = useWallless(scene);
  const players = group("players", sceneGroupSummary(scene, "players"));
  const noWallsId = useId();
  // Folded, the warning would otherwise be out of sight: a tag on the row that never shrinks says it (D-261102-932). Open, the warning itself shows.
  const noWalls = wallless && !players.open;
  const light = useRef<HTMLDivElement>(null);
  const soundGroup = useRef<HTMLDivElement>(null);
  useSceneRequest({ light, sound: sound ? soundGroup : null });

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
      <Section label="This scene">
        <NameField key={scene.id} name={scene.name} onSave={(name) => update({ name })} />
      </Section>

      <div ref={light} style={GROUP_SLOT}>
        <Group {...group("light", sceneGroupSummary(scene, "light"))}>
          <LightSettings scene={scene} />
          <SceneWeather key={scene.id} scene={scene} />
        </Group>
      </div>

      {sound ? (
        <div ref={soundGroup} style={GROUP_SLOT}>
          <Group {...group("sound", sceneSoundSummary(soundNames))}>
            <SceneSoundSettings scene={scene} />
          </Group>
        </div>
      ) : null}

      <Group
        {...players}
        action={
          noWalls ? (
            <Tag id={noWallsId} tone="warning">
              No walls
            </Tag>
          ) : undefined
        }
        describedBy={noWalls ? noWallsId : undefined}
      >
        <VisionSettings scene={scene} wallless={wallless} />
      </Group>

      <Group {...group("map", sceneGroupSummary(scene, "map"))}>
        <MapImageRow scene={scene} close={props.close} />
        <PhasesSection scene={scene} />
        <GridStyle scene={scene} onChange={(grid) => update({ grid })} close={props.close} />
      </Group>

      <Group {...group("walls", sceneGroupSummary(scene, "walls"))}>
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
      </Group>

      <Group {...group("scene", sceneGroupSummary(scene, "scene"))}>
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
      </Group>

      <MapExport scene={scene} />
    </>
  );
}

/** A box around a group that a request scrolls to, one column as the panel's own. */
const GROUP_SLOT: CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0, 1fr)" };

/** The room a scroll to a group's top leaves above it. */
const GROUP_MARGIN = theme.space(2);

/**
 * Takes Ambiance's request for this scene's weather or sound
 * (features/scenes/request.ts, docs/design/design-v1-scenes-reorg.md 7), once,
 * in a layout effect as the settings mount or on a new press. Weather
 * brings Light and weather's header to the top of the panel's scroller
 * where the Weather row still shows whole under it, else the Weather row,
 * and focuses the Weather select. Sound brings Scene sound's header to the
 * top and focuses its fold. A sound request while Scene sound is not drawn
 * (the server offers no sound files) is taken and dropped.
 *
 * The scroll moves the panel's own scroller alone (lib/reveal.ts
 * startInScrollBox), as Ambiance's does: scrollIntoView also scrolls the
 * sheet's frame where the scroller cannot go far enough, as on a tall sheet
 * with little under the group, and takes the sheet's header out of sight.
 * The choice compares rects with rects alone: at 130% the page is zoomed,
 * and a scrollTop set from rect distances landed the row half out of the
 * sheet. It waits for the commit's own layout effects to end, the panel's
 * scroll restore among them (features/panels.ts usePanelScroll), which runs
 * after this child's, and then counts as the viewer taking the scroller
 * over, so a restore still pending never pulls the panel back over it.
 */
function useSceneRequest(groups: { light: RefObject<HTMLDivElement | null>; sound: RefObject<HTMLDivElement | null> | null }): void {
  const request = useScoped(sceneRequestSlot);
  const seq = useSceneRequestSeq();
  const latest = useRef(groups);
  latest.current = groups;
  useLayoutEffect(() => {
    const target = request.take();
    if (target === null) return;
    const slot = target === "weather" ? latest.current.light.current : latest.current.sound?.current;
    if (!slot) return;
    queueMicrotask(() => {
      if (!slot.isConnected) return;
      if (target === "sound") {
        startInScrollBox(slot, GROUP_MARGIN);
        takeOverPanelScroll(slot);
        slot.querySelector<HTMLElement>(GROUP_FOLD)?.focus({ preventScroll: true });
        return;
      }
      const select = slot.querySelector<HTMLElement>('select[aria-label="Weather"]');
      const row = select?.closest<HTMLElement>("[data-setting-row]") ?? null;
      const scroller = scrollBox(slot as unknown as Parameters<typeof scrollBox>[0]) as unknown as Element | null;
      const room = scroller ? scroller.getBoundingClientRect().height : Infinity;
      const whole = row === null || row.getBoundingClientRect().bottom - slot.getBoundingClientRect().top + GROUP_MARGIN <= room;
      startInScrollBox(whole || !row ? slot : row, GROUP_MARGIN);
      takeOverPanelScroll(slot);
      select?.focus({ preventScroll: true });
    });
  }, [request, seq]);
}

const VIEWS: readonly { value: ViewKind; label: string }[] = [
  { value: "topDown", label: VIEW_NAMES.topDown },
  { value: "isometric", label: VIEW_NAMES.isometric },
];

/**
 * The view devices that follow the scene show on it
 * (docs/design/design-v1-isometric-view.md 7): Top-down, which stores nothing, or
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
 * (docs/design/design-v1-maps-vision.md section 2.1). Each note names the edges its
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

/** The grid lines' look, and for a map image, how its squares line up with the scene's: the rest of Map and grid. */
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
 * The scene's grid shape (docs/design/design-v1-hex-grids.md section 8), beside
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
        shapeChanged(gridStore, scene.id, scene.map ? { map: scene.map, from: sceneGrid(scene), to: gridOfShape(storedShape(gridShape)) } : undefined);
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
  // Only Apply sends counts typed over the grid's own, so a sheet's swipe springs back until then (docs/design/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(countsEdited && (across !== squares.across || down !== squares.down));
  const counts = calibrationFromCounts(map, across, down);

  const applyCounts = () => {
    const cal = { cellPx: counts.cellPx, originPx: counts.originPx };
    if (!sameCalibration(cal, map)) actions.dispatch({ t: "scene.setGrid", sceneId: scene.id, ...cal });
    const bounds = fitBounds({ ...map, ...cal }, sceneGrid(scene));
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
            title="Look for a grid drawn on the map and line up with it"
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
      {hex ? <Help>{HEX_LIMITS.counting}</Help> : null}
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
 * The map image's row, first in Map and grid: adding one to a scene
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
  // The picked image reads the fog choice, so a sheet's swipe springs back while the picker is out with it changed (docs/design/design-v1-sheet-swipe.md 4.5).
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
  const [upload, setUpload] = useState<{ busy: boolean; waiting: boolean; finding?: boolean; error: string | null; step?: string; video?: boolean }>({ busy: false, waiting: false, error: null });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  // An animated map (docs/design/design-v1-animated-maps.md 4.1): the pickers take a video while the server's switch is on.
  const videos = useServerAnimatedMaps();
  const video = useVideoUpload(roomId);
  const gridStore = useGridStore();
  const room = useRoomStore();
  const assets = useAssets();
  const landLater = useLandLater();
  const refusal = useSwitchRefusal();
  const phaseCount = scene.phases?.length ?? 0;
  /*
   * A key paste lands here only with focus in the row, and on the players'
   * scene only once the DM has confirmed (docs/design/design-v1-paste.md 1.2):
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

  /** `still` is the DM's own image for a video whose first frame this device could not read. */
  const choose = async (file: File, pasted = false, still?: File) => {
    const animated = !pasted && videos && isVideoFile(file);
    const abort = new AbortController();
    abortRef.current = abort;
    setUpload({ busy: true, waiting: false, error: null, video: animated });
    // A new image is searched for a drawn grid while it uploads, as a new
    // map scene's is (NewScene.tsx). Only the upload tells whether it is
    // the same file, which keeps the grid unsearched, or has the old
    // image's shape, which keeps the grid scaled and only offers a find
    // (create.ts `replacement`).
    const device = thisDevice();
    // Squares and hexes are both looked for. A name's size wins on every grid, read as that grid's cells (D-261101-190).
    // A video's grid is searched on its still, which exists only once the first frame is read.
    let search = !animated && searchOnImport({ source: "image", named: nameGivesSize(file.name) }) ? importSearch(file, device) : null;
    abort.signal.addEventListener("abort", () => search?.cancel());
    const onWaiting = (waiting: boolean) => setUpload((u) => ({ ...u, waiting }));
    try {
      let asset: MapAsset;
      let searchFile: File = file;
      if (animated) {
        const done = await video.run(file, { signal: abort.signal, onWaiting, still, onStep: (step) => setUpload((u) => ({ ...u, step: stepText(step) })) });
        if (!done) {
          // The form asks for a still image now (StillPick).
          setUpload({ busy: false, waiting: false, error: null });
          return;
        }
        asset = done.asset;
        searchFile = done.stillFile;
      } else asset = await uploadMap(roomId, file, { pasted, signal: abort.signal, onWaiting });
      let wait: ImportWait = { answer: null, later: null };
      // The scene as the room holds it as the upload ends: another device may have replaced the map or changed the grid meanwhile, and the new art scales from what is there now.
      const uploaded = room.getState().view?.scenes[scene.id] ?? scene;
      const { map: next, search: searched, kept } = replacement(uploaded.map, asset, uploaded.gridShape);
      const named = nameCellPx(asset, uploaded.gridShape);
      if (searched) {
        search ??= importSearch(searchFile, device);
        setUpload({ busy: true, waiting: false, finding: true, error: null, video: animated });
        wait = await search.afterUpload(copyUrls(device, (variant) => assets.url(asset.id, variant)), IMPORT_WAIT_MS);
      } else search?.cancel();
      if (abort.signal.aborted) {
        wait.later?.cancel();
        video.cancel();
        return;
      }
      setUpload({ busy: false, waiting: false, error: null });
      setArmed(false);
      // The scene as the room holds it now, read before the replacement lands: the grid found and the refit below ask about it, not about the scene as the upload began.
      const held = room.getState().view?.scenes[scene.id] ?? scene;
      const oldMap = held.map;
      const { found, ownGrid } = replacementFound(wait.answer, named !== undefined, next, held, kept);
      // Fog first, so players on this scene never see the map before it.
      if (firstFog && (!playersHere || fogIt)) actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { fogEnabled: true } });
      // Bounds as the room holds them now: another DM may have resized the scene during the upload, and that edit must not be refit away.
      const bounds0 = held.bounds;
      const refitTo = !found && !wait.later && refitsToNamedMap(oldMap, next, named, bounds0, held.gridShape) ? fitBounds(next, sceneGrid(held)) : null;
      const refit = refitTo && (refitTo.w !== bounds0.w || refitTo.h !== bounds0.h) ? refitTo : null;
      // The refit travels in the replacement's undo step, so one Undo setup takes the new art and its bounds back together.
      const group = refit ? actions.newId() : undefined;
      actions.dispatch({ t: "scene.setMap", sceneId: scene.id, map: next }, group ? { group, groupScope: "setup" } : undefined);
      // A scene with map phases takes new art only in its map's shape, and this device's own
      // prediction has already refused any other with the reducer's words (NOT_SAME_SHAPE). A grid
      // found on art the scene refused belongs to no image it shows, so Line up grid is left alone.
      if (room.getState().view?.scenes[scene.id]?.map?.assetId !== next.assetId) {
        wait.later?.cancel();
        // A video the scene refused with its still is this upload's to clean up.
        video.cancel();
        return;
      }
      video.taken();
      // A replacement keeps the scene as it is, unless a grid was found on
      // new art, which a scene with its own grid is only offered, as art of
      // the old image's shape is one that differs from the grid it keeps
      // (findGrid.ts `replacementFound`), or a phone's search of the copy
      // goes on past the wait, which Line up grid shows. A first image
      // either knows its scale from its name, so the scene fits it now, or
      // the grid tool comes up to find the scale (and fits the scene when
      // applied). Over an old map, a name's scale that restarts the grid
      // refits bounds that were fitted to the old one (refitsToNamedMap).
      const fallback = { cellPx: next.cellPx, originPx: next.originPx };
      if (refitTo) {
        if (refit && group) actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { bounds: refit } }, { group, groupScope: "setup" });
      } else if (!oldMap || found || wait.later) {
        // The shape the room holds now, not as the upload began: Grid shape may have changed meanwhile, here or on another device.
        const gridShape = room.getState().view?.scenes[scene.id]?.gridShape;
        const landing = { id: scene.id, bounds: bounds0, gridShape, map: next };
        if (found) {
          const at = { x: next.widthPx / 2, y: next.heightPx / 2 };
          showOutcome({ actions, store: gridStore, scene: landing, found, fit: true, at, fallback, ownGrid, refusal: (to) => refusal(landing, to) });
        } else if (wait.later) landLater({ sceneId: scene.id, start: landing, search: wait.later, fallback, ownGrid, kept });
        ui.setTool("grid");
        props.close({ placing: true });
      }
    } catch (err) {
      if (abort.signal.aborted) video.cancel();
      else setUpload({ busy: false, waiting: false, error: animated ? animatedUploadText(err) : uploadErrorText(err) });
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  };

  /** Stops a video's upload at any step, and keeps the row as it was. */
  const cancelVideo = () => {
    abortRef.current?.abort();
    video.cancel();
    setUpload({ busy: false, waiting: false, error: null });
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
      {upload.busy ? <Spinner size={theme.icon.sm} /> : null}
      {upload.finding ? "Looking for a grid…" : upload.busy ? (upload.step ?? "Uploading…") : label}
      <input
        ref={fileRef}
        type="file"
        accept={mapAccept(videos)}
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
      {upload.busy && upload.video ? (
        <Row>
          <Button size="sm" onClick={cancelVideo}>
            Cancel
          </Button>
        </Row>
      ) : null}
      {video.pending ? (
        <StillPick
          pending={video.pending}
          busy={upload.busy}
          onStill={(still) => void choose(video.pending!.file, false, still)}
          onRetry={() => void choose(video.pending!.file)}
        />
      ) : null}
      {video.pending && !upload.busy ? (
        <Row>
          <Button size="sm" onClick={cancelVideo}>
            Cancel
          </Button>
        </Row>
      ) : null}
      <PasteStatus paste={paste} />
      <Loading text="Waiting for the server…" active={upload.waiting} />
      <ErrorText>{upload.error}</ErrorText>
    </>
  );

  /* Removing the image removes every map phase with it (docs/design/design-v1-maps-vision.md section 3.4), so the second tap says so. */
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
   * see the moment it uploads. Asked, the sentence leads and the first
   * map's fog choice follows it, so the question reads before its answers,
   * as the forget question and Leave Explore's do. Cancel takes a line of
   * its own under the ways to bring an image: on a narrow phone at a large
   * size those two already take two lines, and Cancel beside them would
   * wrap alone. Remove map image comes last, on its own line, since it
   * answers nothing: it acts on the image the scene has now.
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
        {playersHere ? <Note id={warningId}>The players are on this scene. They see the new image as soon as it uploads.</Note> : null}
        {firstFog && playersHere ? <Checkbox label="Start it under fog, so they see only what you reveal" checked={fogIt} onChange={setFogIt} /> : null}
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
        {firstFog && !playersHere ? <Help>Fog turns on with the first map, as for a scene made from a map.</Help> : null}
      </>
    );

  // The warning, the fog choice, its buttons and the status stack under the name, as the section they came from did.
  return (
    <SettingRow name="Map image" help={map?.video ? <MapVideoHelp video={map.video} /> : map ? `A ${map.widthPx} × ${map.heightPx} px image.` : "No map image yet."} wide>
      <div ref={rowRef} style={{ position: "relative", flex: 1, minWidth: 0, display: "grid", gap: theme.space(2) }}>
        <ProbeHost host={video.host} />
        {picker(map ? "Replace map image" : "Add a map image")}
        {/* Below the row's buttons (docs/design/design-v1-animated-maps.md 4.2). */}
        {map?.video ? (
          <Row>
            <UseStillOnly scene={scene} disabled={upload.busy} />
          </Row>
        ) : null}
        {/* What a video makes, under the ways to bring an image once they show (docs/design/design-v1-animated-maps.md 4.1). */}
        {videos && !(playersHere && !armed && !upload.busy) ? <Help>{VIDEO_PICK_HELP}</Help> : null}
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
