import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MAX_SCENE_CELLS } from "#shared/protocol.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import type { FoundWork } from "#shared/starter.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorText, Input } from "../../components/Field.tsx";
import { useHeld } from "../../components/Held.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { api, type AssetRow } from "../../lib/api.ts";
import { useUnsavedSince } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useAssets, useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { copyUrls, importFound, importSearch, IMPORT_WAIT_MS, nameGivesSize, searchOnImport, type ImportSearch, type ImportWait } from "../grid/findGrid.ts";
import { showOutcome } from "../grid/outcome.ts";
import { endFinding, useGridStore } from "../grid/store.ts";
import { useLandLater } from "../grid/useFindGrid.ts";
import { ShapeRow } from "../grid/ShapeRow.tsx";
import { HEX_LIMITS, shapeChoice, sizeWords, storedShape, type ShapeChoice } from "../grid/words.ts";
import { isVideoFile } from "../animmap/firstFrame.ts";
import { ProbeHost, StillPick, useVideoUpload } from "../animmap/MapVideoRow.tsx";
import { useServerAnimatedMaps } from "../animmap/status.ts";
import { animatedUploadText, mapAccept, stepText, VIDEO_PICK_HELP } from "../animmap/upload.ts";
import { apartFromStarter } from "../images/library.ts";
import { PasteButton, PasteStatus, usePasteTarget } from "../images/PasteImage.tsx";
import { useEntryBusy, useHandoff } from "../images/roomPaste.ts";
import { loadedStarterWork } from "../starter/catalog.ts";
import { answeredGrid, retainedGrid, starterMapScene, type StarterGrid } from "../starter/mapScene.ts";
import { StarterDialog } from "../starter/StarterDialog.tsx";
import { GenerateDialog } from "../dungeon/GenerateDialog.tsx";
import { GENERATE_LEAD, HEX_NOTE } from "../dungeon/words.ts";
import { thisDevice } from "../uvtt/limits.ts";
import { NewScenePlayersSee, type PlayersSeeValue } from "../vision/PlayersSee.tsx";
import { ColorInput, NumberInput } from "./controls.tsx";
import { builderScene, MAT_BACKGROUND, mapScene, matScene, nameCellPx, nameFromFile, newSceneIntent, newScenePreset, newSceneShape, pickNow, withPlayersSee, type MapAsset, type NewSceneIntent, type SceneInput } from "./create.ts";
import { uploadErrorText, uploadMap } from "./upload.ts";
import type { PanelClose } from "../panels.ts";

type Kind = "mat" | "map" | "builder";

/** The room limit on scenes (design 10.5). */
const MAX_SCENES = 50;

/**
 * Turns the panel scroller's own scroll anchoring off from a create until
 * NewScene's next commit has laid out. A create starts the form over while
 * the DM is scrolled down to Create, so the content shrinks under the view
 * and the scroller's offset is clamped. Chrome keeps the anchor it chose
 * before the clamp, with its old place in the view, and moves the scroller
 * back to it once there is room again: as the new scene's settings drew,
 * Scenes jumped hundreds of px into Light and weather, where the first
 * scene made must scroll to nothing (D-261102-934). With anchoring off
 * through the clamp, Chrome drops that anchor and picks a fresh one where
 * the view is. Off for that one commit only, as a stat block's roll header
 * does (docs/design/design-v1-token-roll-header.md 1.2), so the panel keeps
 * its anchoring for everything else.
 */
function useAnchoringPause(): (from: Element | null) => void {
  const held = useRef<{ box: HTMLElement; prior: string } | null>(null);
  const restore = () => {
    const h = held.current;
    held.current = null;
    if (!h) return;
    // Reading the offset lays the commit out now, with anchoring still off, so its clamp keeps no anchor.
    void h.box.scrollTop;
    h.box.style.overflowAnchor = h.prior;
  };
  useLayoutEffect(restore);
  useLayoutEffect(() => restore, []);
  return useCallback((from) => {
    const box = from?.closest<HTMLElement>("[data-pane-body]") ?? null;
    if (!box || held.current) return;
    held.current = { box, prior: box.style.overflowAnchor };
    box.style.overflowAnchor = "none";
  }, []);
}

/**
 * Creating a scene: a blank battle mat, a scene from a map image, or a
 * scene for the map builder (design section 3 of the feature list). The DM
 * lands on the new scene, with the next tool ready: grid alignment for a map
 * whose scale is only a guess, the builder for a builder scene.
 *
 * A map whose name gives no size is searched for a drawn grid while it
 * uploads (docs/design/design-v1-grid-detect.md section 6), in a Worker started
 * when the file is picked, or on a phone or an iPad, for a large file, on
 * the server's phone-sized copy once the upload answers (findGrid.ts
 * `importSearchFrom`). A grid found with high confidence goes on the
 * scene as one undo step after it is made, and Line up grid opens on it.
 * A search of the copy still running when the wait ends goes on in Line
 * up grid, as Find the grid's does.
 *
 * A map from the starter packs (docs/design/design-v1-starter-art.md 7) is copied
 * into the room and starts on the grid the catalog measured, so it is
 * never searched and skips grid alignment. One the catalog has no grid,
 * or only a square's size, for opens on Line up grid, as an upload with
 * no size does.
 *
 * Players see (docs/design/design-v1-map-discovery.md 8.1 and 8.2) starts on the
 * room's default for the kind, or Like the scene on the DM's screen, and is
 * applied to whatever the kind makes. It holds still during an upload, so
 * the scene that upload makes is the one the DM chose. An upload or a
 * starter copy holds the choice, Like by its scene's id, and reads that
 * scene from the store once it is done, so what changed meanwhile comes
 * with it, and a scene deleted meanwhile leaves the kind's start, said in
 * a toast.
 *
 * The Grid row (docs/design/design-v1-hex-grids.md HX-D19) starts on the room's
 * New scenes shape for a Battle mat or a Map image and on Squares for a
 * Builder scene, and changes the shape for this one scene. A starter map
 * starts on squares, its art's own grid, unless the DM picks a hex shape
 * here, and then opens Line up grid. A map image is searched for squares
 * and hexes whatever the Grid row says, and a sure find of one shape alone
 * starts the scene on that shape (docs/design/design-v1-grid-detect.md 10.7).
 *
 * The kind is a choice of native radios, and a tap on the chosen radio does
 * nothing, so the form folds with its own Cancel. During an upload that
 * Cancel stops the upload and keeps the form, so the DM can try again.
 */
export function NewScene(props: { sceneCount: number; close: PanelClose }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const roomId = useRoomView((s) => s.roomId);
  const store = useRoomStore();
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState("");
  const [w, setW] = useState(30);
  const [h, setH] = useState(20);
  const [background, setBackground] = useState(MAT_BACKGROUND);
  const [file, setFile] = useState<File | null>(null);
  /** The file came from a paste, which may be re-encoded before it uploads (upload.ts). */
  const [pasted, setPasted] = useState(false);
  const [starter, setStarter] = useState(false);
  const starterButton = useRef<HTMLButtonElement>(null);
  /** The choice the starter dialog was opened with, which its copy makes the scene with. */
  const starterIntent = useRef<NewSceneIntent>({ value: "reveal" });
  /** The grid the starter dialog was opened with, as its intent is held. */
  const starterShapeRef = useRef<ShapeChoice | undefined>(undefined);
  /** The form's name, size and Players see as Generate a dungeon opened, held while its dialog is open as the starter dialog's are. */
  const [generate, setGenerate] = useState<{ name: string; w: number; h: number; intent: NewSceneIntent } | null>(null);
  const generateButton = useRef<HTMLButtonElement>(null);
  const hexNoteId = useId();
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const setting = useRoomView((s) => s.view?.meta.settings.newScenePlayers);
  const shapeSetting = useRoomView((s) => s.view?.meta.settings.newScenes);
  /** The DM's own pick of the grid, null for the kind's start. */
  const [shapePick, setShapePick] = useState<ShapeChoice | null>(null);
  const current = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId] : undefined));
  /** The DM's own pick of Players see, null for the kind's start. */
  const [seen, setSeen] = useState<PlayersSeeValue | null>(null);
  const [status, setStatus] = useState<{ busy: boolean; waiting: boolean; finding?: boolean; error: string | null; step?: string }>({ busy: false, waiting: false, error: null });
  // An animated map (docs/design/design-v1-animated-maps.md 4.1): the picker takes a video while the server's switch is on.
  const videos = useServerAnimatedMaps();
  const video = useVideoUpload(roomId);
  const animatedFile = (f: File | null, fromPaste: boolean) => f !== null && !fromPaste && videos && isVideoFile(f);
  const fileOff = useHeld(status.busy);
  const abortRef = useRef<AbortController | null>(null);
  /** The search for the picked file's grid, running while the DM fills in the form and the file uploads. */
  const searchRef = useRef<{ file: File; search: ImportSearch } | null>(null);
  const gridStore = useGridStore();
  const assets = useAssets();
  const landLater = useLandLater();
  const stopSearch = () => {
    searchRef.current?.search.cancel();
    searchRef.current = null;
  };
  useEffect(
    () => () => {
      abortRef.current?.abort();
      searchRef.current?.search.cancel();
    },
    [],
  );
  // Only Create sends it, so a sheet's swipe springs back once a name or a size is typed or a map picked (docs/design/design-v1-sheet-swipe.md 4.5).
  useUnsavedSince({ name, w, h, background, file: file?.name ?? null, seen, shapePick });

  const full = props.sceneCount >= MAX_SCENES;
  // A paste lands here while the Map image form is open, as a chosen file does: picked, and searched for its grid (docs/design/design-v1-paste.md 1.2).
  const formRef = useRef<HTMLDivElement>(null);
  const pauseAnchoring = useAnchoringPause();
  const paste = usePasteTarget(formRef, { accepts: "image", takes: kind === "map" ? "open" : "none", disabled: status.busy || kind !== "map", closed: kind !== "map", onFile: (f) => pickFile(f, true) });

  const pick = (k: Kind) => {
    // Another kind of scene ends an upload in flight, or it would still
    // make its map scene after the DM moved on.
    abortRef.current?.abort();
    video.cancel();
    stopSearch();
    setKind(k);
    setSeen(null);
    setShapePick(null);
    setStatus({ busy: false, waiting: false, error: null });
    if (k === "builder") {
      setW(40);
      setH(30);
    } else if (k === "mat") {
      setW(30);
      setH(20);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    video.cancel();
    stopSearch();
    setStatus({ busy: false, waiting: false, error: null });
    if (!status.busy) {
      setKind(null);
      setFile(null);
    }
  };

  /** The grid the form shows for a kind: the DM's pick, or the kind's start. */
  const shapeFor = (k: Kind): ShapeChoice => shapePick ?? shapeChoice(newSceneShape(shapeSetting, k));
  /** A starter map keeps its art's squares unless the DM picked a hex shape here. */
  const starterShape = () => (shapePick === null ? undefined : storedShape(shapePick));
  const hexFor = (k: Kind) => shapeFor(k) !== "squares";

  /** The choice the form shows now: the DM's pick, or the room's default for the kind. */
  const intentNow = (k: Kind): NewSceneIntent => newSceneIntent(seen ?? newScenePreset(setting, k), current);
  /** Players see over what the kind starts with, from the room as it is now. */
  const seeing = (scene: SceneInput, k: Kind, intent: NewSceneIntent): SceneInput => {
    const { pick, gone } = pickNow(intent, store.getState().view, k);
    if (gone) ui.notify(gone);
    return withPlayersSee(scene, pick);
  };

  /** The form as it opens, once a scene is made from it. */
  const startOver = () => {
    setKind(null);
    setName("");
    setFile(null);
  };

  const open = (id: string, tool: string | null) => {
    pauseAnchoring(formRef.current);
    actions.switchScene(id);
    startOver();
    if (tool) {
      ui.setTool(tool);
      props.close({ placing: true });
    }
  };

  const createMat = () => {
    const id = actions.newId();
    actions.dispatch({ t: "scene.create", scene: seeing(matScene({ id, name, w, h, background, gridShape: storedShape(shapeFor("mat")) }), "mat", intentNow("mat")) });
    open(id, null);
  };

  const createBuilder = () => {
    const id = actions.newId();
    actions.dispatch({ t: "scene.create", scene: seeing(builderScene({ id, name, w, h, gridShape: storedShape(shapeFor("builder")) }), "builder", intentNow("builder")) });
    open(id, "build");
  };

  const createFromAsset = (asset: MapAsset, fileName: string, intent: NewSceneIntent, gridShape: ShapeChoice, wait: ImportWait = { answer: null, later: null }) => {
    const id = actions.newId();
    const shape = storedShape(gridShape);
    const made = mapScene({ id, name: name.trim() || nameFromFile(fileName), asset, gridShape: shape });
    const { hinted } = made;
    const scene = seeing(made.scene, "map", intent);
    actions.dispatch({ t: "scene.create", scene });
    // The scene is made with the guess first, so undo takes a found grid
    // back to it in one step, and Use default puts it back.
    const map = scene.map!;
    const fallback = { cellPx: map.cellPx, originPx: map.originPx };
    // A name's size wins on every grid, read as that grid's cells (D-261101-190).
    const named = hinted;
    const found = importFound(wait.answer, named, map, shape);
    const later = wait.later && !named ? wait.later : null;
    if (found) {
      const at = { x: map.widthPx / 2, y: map.heightPx / 2 };
      showOutcome({ actions, store: gridStore, scene: { id, bounds: scene.bounds, gridShape: shape, map }, found, fit: true, at, fallback });
    } else if (later) {
      // A phone's search of the copy that outlived the wait goes on, and Line up grid shows it.
      landLater({ sceneId: id, start: { id, bounds: scene.bounds, gridShape: shape, map }, search: later, fallback });
    } else wait.later?.cancel();
    // A scale from the file name is usually right. A guess never is.
    open(id, named && !found && !later ? null : "grid");
  };

  const createFromStarter = (row: AssetRow, found: FoundWork, grid: StarterGrid | null, intent: NewSceneIntent, gridShape: ShapeChoice | undefined) => {
    // A starter map is never searched: its grid is the catalog's. A file picked before it is dropped, and so is its
    // search, whether it still runs here or was handed on to Line up grid after an upload (useLandLater).
    stopSearch();
    const running = gridStore.getState().finding;
    if (running) endFinding(gridStore, running.sceneId);
    const id = actions.newId();
    const made = starterMapScene({ id, name, asset: { id: row.id, width: row.width, height: row.height }, work: found.work, grid, ...(gridShape && gridShape !== "squares" ? { gridShape } : null) });
    const { aligned } = made;
    const scene = seeing(made.scene, "map", intent);
    actions.dispatch({ t: "scene.create", scene });
    setStarter(false);
    open(id, aligned ? null : "grid");
  };

  // A starter map already in the room starts on its catalog grid again, when the catalog is here and describes the room's file.
  const reuseMap = (row: AssetRow) => {
    const found = row.starter ? loadedStarterWork(row.starter) : null;
    if (found) createFromStarter(row, found, retainedGrid(row, found.work), intentNow("map"), starterShape());
    else createFromAsset({ id: row.id, width: row.width, height: row.height }, "Map", intentNow("map"), shapeFor("map"));
  };

  const pickFile = (next: File | null, fromPaste = false) => {
    setFile(next);
    setPasted(fromPaste);
    setStatus({ busy: false, waiting: false, error: null });
    stopSearch();
    // Another file lets go of a video an earlier pick left waiting for its still.
    video.cancel();
    // A video's grid is searched on its still, once its first frame is read.
    if (next && !animatedFile(next, fromPaste) && searchOnImport({ source: "image", named: nameGivesSize(next.name) })) searchRef.current = { file: next, search: importSearch(next, thisDevice()) };
  };

  // The room's "Use the pasted image" hands its picture here: Map image opens with it picked, and the grid search starts (docs/design/design-v1-paste.md 4).
  useHandoff("scene", !status.busy && !full, (handed) => {
    pick("map");
    pickFile(handed, true);
  });
  useEntryBusy("scene", status.busy);

  /** `still` is the DM's own image for a video whose first frame this device could not read. */
  const upload = async (still?: File) => {
    if (!file || status.busy) return;
    const animated = animatedFile(file, pasted);
    const intent = intentNow("map");
    const gridShape = shapeFor("map");
    const abort = new AbortController();
    abortRef.current = abort;
    setStatus({ busy: true, waiting: false, error: null });
    const onWaiting = (waiting: boolean) => setStatus((s) => ({ ...s, waiting }));
    try {
      let asset: MapAsset;
      let searchFile: File = file;
      if (animated) {
        const done = await video.run(file, { signal: abort.signal, onWaiting, still, onStep: (step) => setStatus((s) => ({ ...s, step: stepText(step) })) });
        if (!done) {
          // The form asks for a still image now (StillPick).
          setStatus({ busy: false, waiting: false, error: null });
          return;
        }
        asset = done.asset;
        searchFile = done.stillFile;
      } else asset = await uploadMap(roomId, file, { pasted, signal: abort.signal, onWaiting });
      // The name's size wins. Otherwise the search started at the pick
      // gets a short wait, or one starts now: for a name whose counts the
      // server refused, or an upload tried again after a cancel.
      let wait: ImportWait | undefined;
      if (nameCellPx(asset, storedShape(gridShape)) !== undefined) stopSearch();
      else {
        if (searchRef.current?.file !== searchFile) searchRef.current = { file: searchFile, search: importSearch(searchFile, thisDevice()) };
        setStatus({ busy: true, waiting: false, finding: true, error: null });
        wait = await searchRef.current.search.afterUpload(copyUrls(thisDevice(), (variant) => assets.url(asset.id, variant)), IMPORT_WAIT_MS);
        if (abort.signal.aborted) {
          wait.later?.cancel();
          video.cancel();
          return;
        }
        searchRef.current = null;
      }
      setStatus({ busy: false, waiting: false, error: null });
      createFromAsset(asset, file.name, intent, gridShape, wait);
      video.taken();
    } catch (err) {
      if (abort.signal.aborted) {
        video.cancel();
        return;
      }
      setStatus({ busy: false, waiting: false, error: animated ? animatedUploadText(err) : uploadErrorText(err) });
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  };

  if (full) return <Help>A room holds at most {MAX_SCENES} scenes. Delete one to add another.</Help>;
  const size = sizeWords(gridOfShape(kind ? storedShape(shapeFor(kind)) : undefined), { w, h }, feetPerCell);

  const actionsRow = (main: ReactNode) => (
    <div style={{ display: "flex", gap: theme.space(2), alignItems: "center", flexWrap: "wrap" }}>
      <Button size="sm" onClick={cancel}>
        Cancel
      </Button>
      {main}
    </div>
  );

  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <Segmented<Kind>
        label="Kind of scene"
        value={kind}
        even
        wrap
        onChange={pick}
        options={[
          { value: "mat", label: "Battle mat" },
          { value: "map", label: "Map image" },
          { value: "builder", label: "Builder" },
        ]}
      />
      {kind ? (
        <div
          ref={formRef}
          style={{
            position: "relative",
            display: "grid",
            gap: theme.space(2),
            padding: theme.space(3),
            borderRadius: theme.radius.md,
            border: `${theme.line.border}px solid ${theme.color.border}`,
            background: theme.color.surfaceRaised,
          }}
        >
          <Input aria-label="Scene name" placeholder={kind === "mat" ? "Battle mat" : kind === "builder" ? "Dungeon" : "Name from the file"} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          {/* A new map image has no walls yet, so Explore there is warned. */}
          <NewScenePlayersSee kind={kind} setting={setting} value={seen ?? newScenePreset(setting, kind)} like={current} wallless={kind === "map"} disabled={status.busy} onChange={setSeen} />
          <ShapeRow
            name="Grid"
            value={shapeFor(kind)}
            disabled={status.busy}
            note={kind === "builder" && hexFor(kind) ? HEX_LIMITS.builder : kind === "map" && shapePick === null && hexFor(kind) ? HEX_LIMITS.starter : undefined}
            onChange={(next) => {
              setShapePick(next);
              // A search started at the pick looks for squares, which a map for hexes never takes.
              if (kind === "map" && next !== "squares") stopSearch();
            }}
          />
          {kind === "map" ? (
            <>
              <label
                style={{
                  position: "relative",
                  display: "grid",
                  placeItems: "center",
                  minHeight: theme.touch,
                  padding: `0 ${theme.space(3)}px`,
                  borderRadius: theme.radius.md,
                  border: `${theme.line.border}px dashed ${fileOff ? theme.color.border : theme.color.controlBorder}`,
                  color: fileOff ? theme.color.textDisabled : theme.color.text,
                  cursor: fileOff ? "default" : "pointer",
                  fontSize: theme.font.body14,
                  fontWeight: theme.weight.strong,
                  textAlign: "center",
                  overflowWrap: "anywhere",
                }}
              >
                {file ? file.name : "Choose a map image"}
                <input
                  type="file"
                  accept={mapAccept(videos)}
                  disabled={fileOff}
                  style={{ position: "absolute", inset: 0, width: "100%", opacity: 0, cursor: fileOff ? "default" : "pointer" }}
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <div style={{ display: "flex" }}>
                <PasteButton paste={paste} />
              </div>
              <PasteStatus paste={paste} />
              {hexFor("map") ? (
                <Help>
                  A name like <code>crypt_30x20.jpg</code> sets the scale for 30 hexes across and 20 down. Otherwise a grid drawn on the map is looked for, and you check it or line up the hexes next.
                </Help>
              ) : (
                <Help>
                  A name like <code>crypt_30x20.jpg</code> sets the scale for 30 by 20 squares. Otherwise a grid drawn on the map is looked for, and you check it or line up the grid next.
                </Help>
              )}
              {videos ? <Help>{VIDEO_PICK_HELP}</Help> : null}
              {actionsRow(
                <Button size="sm" variant="primary" busy={status.busy} disabled={!file || video.pending !== null} onClick={() => void upload()}>
                  {status.finding ? "Looking for a grid…" : status.busy ? (status.step ?? "Uploading…") : "Upload and create"}
                </Button>,
              )}
              {video.pending ? <StillPick pending={video.pending} busy={status.busy} onStill={(still) => void upload(still)} onRetry={() => void upload()} /> : null}
              <ProbeHost host={video.host} />
              <Loading text="Waiting for the server…" active={status.waiting} />
              <ErrorText>{status.error}</ErrorText>
              <div style={{ display: "grid", gap: theme.space(1), justifyItems: "start" }}>
                <Help>Or start from a map in the starter packs</Help>
                <Button
                  ref={starterButton}
                  size="sm"
                  disabled={status.busy}
                  onClick={() => {
                    starterIntent.current = intentNow("map");
                    starterShapeRef.current = starterShape();
                    setStarter(true);
                  }}
                >
                  From starter packs
                </Button>
              </div>
              {starter ? (
                <StarterDialog
                  title="Starter maps"
                  uses={STARTER_MAP_USES}
                  kind="map"
                  hint="Openly licensed maps. Use copies the map into this room with its credit and makes the scene, on the map's own grid where it has one."
                  note={(found) => <FeetNote found={found} roomFeet={feetPerCell} />}
                  onPicked={(row, found) => createFromStarter(row, found, answeredGrid(row), starterIntent.current, starterShapeRef.current)}
                  onClose={() => setStarter(false)}
                  opener={starterButton}
                />
              ) : null}
              <UploadedMaps roomId={roomId} disabled={status.busy} onPick={reuseMap} />
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
                <span style={{ fontSize: theme.font.body14 }}>{size.holds === null ? "Squares" : size.name}</span>
                {/* The two sizes keep their line together, so a longer name above them on hexes never leaves Down alone. */}
                <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
                  <NumberInput label={size.across} value={w} min={1} max={MAX_SCENE_CELLS} onChange={setW} />
                  <span aria-hidden>×</span>
                  <NumberInput label={size.down} value={h} min={1} max={MAX_SCENE_CELLS} onChange={setH} />
                </div>
                {kind === "mat" ? <ColorInput label="Background color" value={background} onChange={setBackground} /> : null}
              </div>
              {size.holds !== null ? <Help>{size.holds}</Help> : null}
              {actionsRow(
                <Button size="sm" variant="primary" onClick={kind === "mat" ? createMat : createBuilder}>
                  Create
                </Button>,
              )}
              {kind === "builder" ? (
                <div style={{ display: "grid", gap: theme.space(1), justifyItems: "start" }}>
                  <Help>{GENERATE_LEAD}</Help>
                  <Button
                    ref={generateButton}
                    size="sm"
                    disabled={hexFor("builder")}
                    aria-describedby={hexFor("builder") ? hexNoteId : undefined}
                    onClick={() => setGenerate({ name, w, h, intent: intentNow("builder") })}
                  >
                    Generate a dungeon
                  </Button>
                  {hexFor("builder") ? <Help id={hexNoteId}>{HEX_NOTE}</Help> : null}
                </div>
              ) : null}
              {generate ? (
                <GenerateDialog
                  roomId={roomId}
                  name={generate.name}
                  form={generate}
                  intent={generate.intent}
                  opener={generateButton}
                  onClose={(made) => {
                    setGenerate(null);
                    // A dungeon is on its way, so the form starts over as a Create does, and a second Create makes no second scene.
                    if (made) startOver();
                  }}
                  onMade={(id) => {
                    setGenerate(null);
                    open(id, "build");
                  }}
                />
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

const STARTER_MAP_USES = ["map"] as const;

/**
 * A scene has no scale of its own: feet per square is the room's. So a
 * starter map drawn at another scale says so before it is used, rather
 * than measuring its distances wrong without a word.
 */
function FeetNote(props: { found: FoundWork; roomFeet: number }) {
  const feet = props.found.work.grid?.feetPerCell;
  if (!feet || feet === props.roomFeet) return null;
  return (
    <span style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted }}>
      Its squares are {feet} ft. This room counts {props.roomFeet} ft a square, set in the room's settings.
    </span>
  );
}

/**
 * Maps already in the room, so one image can back several scenes. The list
 * is fetched when the form opens, never polled. The DM's own uploads come
 * first and starter picks after, apart (docs/design/design-v1-starter-art.md 5),
 * as the Library panel lists them.
 */
function UploadedMaps(props: { roomId: string; disabled: boolean; onPick(row: AssetRow): void }) {
  const [maps, setMaps] = useState<AssetRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.listAssets(props.roomId).then(
      (res) => !cancelled && setMaps(res.assets.filter((a) => a.kind === "map")),
      () => !cancelled && setMaps([]),
    );
    return () => {
      cancelled = true;
    };
  }, [props.roomId]);
  if (!maps || maps.length === 0) return null;
  const { own, starter } = apartFromStarter(maps, (m) => m);
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <Help>Or use a map already in this room</Help>
      {own.length > 0 ? <MapStrip maps={own} disabled={props.disabled} onPick={props.onPick} /> : null}
      {starter.length > 0 ? (
        <>
          <Help>From starter packs</Help>
          <MapStrip maps={starter} disabled={props.disabled} onPick={props.onPick} />
        </>
      ) : null}
    </div>
  );
}

export function MapStrip(props: { maps: readonly AssetRow[]; disabled: boolean; onPick(row: AssetRow): void }) {
  const assets = useAssets();
  const disabled = useHeld(props.disabled);
  return (
    <div style={{ display: "flex", gap: theme.space(2), overflowX: "auto", paddingBottom: theme.space(1) }}>
      {props.maps.map((m) => (
          <button
            key={m.id}
            type="button"
            title="Use this map"
            disabled={disabled}
            onClick={() => props.onPick(m)}
            style={{
              flex: "none",
              padding: 0,
              border: `${theme.line.border}px solid ${theme.color.border}`,
              borderRadius: theme.radius.sm,
              background: theme.color.bg,
              cursor: disabled ? "default" : "pointer",
            }}
          >
            <img
              src={assets.url(m.id, m.variants.includes("thumb") ? "thumb" : "full")}
              alt={`Map, ${m.width} × ${m.height}`}
              loading="lazy"
              // A picture has no words to dim and must not fade, so a map that cannot be picked now goes gray (looks.ts).
              style={{ display: "block", width: 96, height: 64, objectFit: "cover", borderRadius: theme.radius.sm, filter: disabled ? "grayscale(1)" : undefined }}
            />
          </button>
        ))}
    </div>
  );
}
