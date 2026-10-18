import { useEffect, useRef, useState, type ReactNode } from "react";
import { MAX_SCENE_CELLS } from "#shared/protocol.ts";
import type { FoundWork } from "#shared/starter.ts";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { Help } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { api, type AssetRow } from "../../lib/api.ts";
import { useUnsavedSince } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useAssets, useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { copyUrls, importFound, importSearch, IMPORT_WAIT_MS, nameGivesSize, searchOnImport, type ImportSearch, type ImportWait } from "../grid/findGrid.ts";
import { showOutcome } from "../grid/outcome.ts";
import { endFinding, useGridStore } from "../grid/store.ts";
import { useLandLater } from "../grid/useFindGrid.ts";
import { loadedStarterWork } from "../starter/catalog.ts";
import { starterMapScene } from "../starter/mapScene.ts";
import { StarterDialog } from "../starter/StarterDialog.tsx";
import { thisDevice } from "../uvtt/limits.ts";
import { ColorInput, NumberInput } from "./controls.tsx";
import { builderScene, MAT_BACKGROUND, mapScene, matScene, nameFromFile, type MapAsset } from "./create.ts";
import { uploadErrorText, uploadMap } from "./upload.ts";

type Kind = "mat" | "map" | "builder";

/** The room limit on scenes (design 10.5). */
const MAX_SCENES = 50;

/**
 * Creating a scene: a blank battle mat, a scene from a map image, or a
 * scene for the map builder (design section 3 of the feature list). The DM
 * lands on the new scene, with the next tool ready: grid alignment for a map
 * whose scale is only a guess, the builder for a builder scene.
 *
 * A map whose name gives no size is searched for a drawn grid while it
 * uploads (docs/design-v1-grid-detect.md section 6), in a Worker started
 * when the file is picked, or on a phone or an iPad, for a large file, on
 * the server's phone-sized copy once the upload answers (findGrid.ts
 * `importSearchFrom`). A grid found with high confidence goes on the
 * scene as one undo step after it is made, and Line up grid opens on it.
 * A search of the copy still running when the wait ends goes on in Line
 * up grid, as Find the grid's does.
 *
 * A map from the starter packs (docs/design-v1-starter-art.md 7) is copied
 * into the room and starts on the grid the catalog measured, so it is
 * never searched and skips grid alignment. One the catalog has no grid,
 * or only a square's size, for opens on Line up grid, as an upload with
 * no size does.
 *
 * The kind is a choice of native radios, and a tap on the chosen radio does
 * nothing, so the form folds with its own Cancel. During an upload that
 * Cancel stops the upload and keeps the form, so the DM can try again.
 */
export function NewScene(props: { sceneCount: number; close(): void }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const roomId = useRoomView((s) => s.roomId);
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState("");
  const [w, setW] = useState(30);
  const [h, setH] = useState(20);
  const [background, setBackground] = useState(MAT_BACKGROUND);
  const [file, setFile] = useState<File | null>(null);
  const [starter, setStarter] = useState(false);
  const starterButton = useRef<HTMLButtonElement>(null);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const [status, setStatus] = useState<{ busy: boolean; waiting: boolean; finding?: boolean; error: string | null }>({ busy: false, waiting: false, error: null });
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
  // Only Create sends it, so a sheet's swipe springs back once a name or a size is typed or a map picked (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedSince({ name, w, h, background, file: file?.name ?? null });

  const full = props.sceneCount >= MAX_SCENES;

  const pick = (k: Kind) => {
    // Another kind of scene ends an upload in flight, or it would still
    // make its map scene after the DM moved on.
    abortRef.current?.abort();
    stopSearch();
    setKind(k);
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
    stopSearch();
    setStatus({ busy: false, waiting: false, error: null });
    if (!status.busy) {
      setKind(null);
      setFile(null);
    }
  };

  const open = (id: string, tool: string | null) => {
    actions.switchScene(id);
    setKind(null);
    setName("");
    setFile(null);
    if (tool) {
      ui.setTool(tool);
      props.close();
    }
  };

  const createMat = () => {
    const id = actions.newId();
    actions.dispatch({ t: "scene.create", scene: matScene({ id, name, w, h, background }) });
    open(id, null);
  };

  const createBuilder = () => {
    const id = actions.newId();
    actions.dispatch({ t: "scene.create", scene: builderScene({ id, name, w, h }) });
    open(id, "build");
  };

  const createFromAsset = (asset: MapAsset, fileName: string, wait: ImportWait = { answer: null, later: null }) => {
    const id = actions.newId();
    const { scene, hinted } = mapScene({ id, name: name.trim() || nameFromFile(fileName), asset });
    actions.dispatch({ t: "scene.create", scene });
    // The scene is made with the guess first, so undo takes a found grid
    // back to it in one step, and Use default puts it back.
    const map = scene.map!;
    const fallback = { cellPx: map.cellPx, originPx: map.originPx };
    const found = importFound(wait.answer, hinted, map);
    if (found) {
      const at = { x: map.widthPx / 2, y: map.heightPx / 2 };
      showOutcome({ actions, store: gridStore, scene: { id, bounds: scene.bounds, map }, found, fit: true, at, fallback });
    } else if (wait.later && !hinted) {
      // A phone's search of the copy that outlived the wait goes on, and Line up grid shows it.
      landLater({ sceneId: id, start: { id, bounds: scene.bounds, map }, search: wait.later, fallback });
    } else wait.later?.cancel();
    // A scale from the file name is usually right. A guess never is.
    open(id, hinted ? null : "grid");
  };

  const createFromStarter = (row: AssetRow, found: FoundWork) => {
    // A starter map is never searched: its grid is the catalog's. A file picked before it is dropped, and so is its
    // search, whether it still runs here or was handed on to Line up grid after an upload (useLandLater).
    stopSearch();
    const running = gridStore.getState().finding;
    if (running) endFinding(gridStore, running.sceneId);
    const id = actions.newId();
    const { scene, aligned } = starterMapScene({ id, name, asset: { id: row.id, width: row.width, height: row.height }, work: found.work });
    actions.dispatch({ t: "scene.create", scene });
    setStarter(false);
    open(id, aligned ? null : "grid");
  };

  // A starter map already in the room starts on its catalog grid again, when the catalog is here to say what it is.
  const reuseMap = (row: AssetRow) => {
    const found = row.starter ? loadedStarterWork(row.starter) : null;
    if (found) createFromStarter(row, found);
    else createFromAsset({ id: row.id, width: row.width, height: row.height }, "Map");
  };

  const pickFile = (next: File | null) => {
    setFile(next);
    setStatus({ busy: false, waiting: false, error: null });
    stopSearch();
    if (next && searchOnImport({ source: "image", named: nameGivesSize(next.name) })) searchRef.current = { file: next, search: importSearch(next, thisDevice()) };
  };

  const upload = async () => {
    if (!file || status.busy) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setStatus({ busy: true, waiting: false, error: null });
    try {
      const asset = await uploadMap(roomId, file, {
        signal: abort.signal,
        onWaiting: (waiting) => setStatus((s) => ({ ...s, waiting })),
      });
      // The name's size wins. Otherwise the search started at the pick
      // gets a short wait, or one starts now: for a name whose counts the
      // server refused, or an upload tried again after a cancel.
      let wait: ImportWait | undefined;
      if (asset.cellPx !== undefined) stopSearch();
      else {
        if (searchRef.current?.file !== file) searchRef.current = { file, search: importSearch(file, thisDevice()) };
        setStatus({ busy: true, waiting: false, finding: true, error: null });
        wait = await searchRef.current.search.afterUpload(copyUrls(thisDevice(), (variant) => assets.url(asset.id, variant)), IMPORT_WAIT_MS);
        if (abort.signal.aborted) {
          wait.later?.cancel();
          return;
        }
        searchRef.current = null;
      }
      setStatus({ busy: false, waiting: false, error: null });
      createFromAsset(asset, file.name, wait);
    } catch (err) {
      if (abort.signal.aborted) return;
      setStatus({ busy: false, waiting: false, error: uploadErrorText(err) });
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  };

  if (full) return <Help>A room holds at most {MAX_SCENES} scenes. Delete one to add another.</Help>;

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
        onChange={pick}
        options={[
          { value: "mat", label: "Battle mat" },
          { value: "map", label: "Map image" },
          { value: "builder", label: "Builder" },
        ]}
      />
      {kind ? (
        <div
          style={{
            display: "grid",
            gap: theme.space(2),
            padding: theme.space(3),
            borderRadius: theme.radius.md,
            border: `${theme.line.border}px solid ${theme.color.border}`,
            background: theme.color.surfaceRaised,
          }}
        >
          <Input aria-label="Scene name" placeholder={kind === "mat" ? "Battle mat" : kind === "builder" ? "Dungeon" : "Name from the file"} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
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
                  border: `${theme.line.border}px dashed ${status.busy ? theme.color.border : theme.color.controlBorder}`,
                  color: status.busy ? theme.color.textDisabled : theme.color.text,
                  cursor: status.busy ? "default" : "pointer",
                  fontSize: theme.font.body14,
                  fontWeight: theme.weight.strong,
                  textAlign: "center",
                  overflowWrap: "anywhere",
                }}
              >
                {file ? file.name : "Choose a map image"}
                <input
                  type="file"
                  accept="image/*"
                  disabled={status.busy}
                  style={{ position: "absolute", inset: 0, width: "100%", opacity: 0, cursor: status.busy ? "default" : "pointer" }}
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <Help>
                A name like <code>crypt_30x20.jpg</code> sets the scale for 30 by 20 squares. Otherwise a grid drawn on the map is looked for, and you check it or line up the grid next.
              </Help>
              {actionsRow(
                <Button size="sm" variant="primary" busy={status.busy} disabled={!file} onClick={() => void upload()}>
                  {status.finding ? "Looking for a grid…" : status.busy ? "Uploading…" : "Upload and create"}
                </Button>,
              )}
              {status.waiting ? <Help>Waiting for the server…</Help> : null}
              {status.error ? (
                <p role="alert" style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
                  {status.error}
                </p>
              ) : null}
              <div style={{ display: "grid", gap: theme.space(1), justifyItems: "start" }}>
                <Help>Or start from a map in the starter packs</Help>
                <Button ref={starterButton} size="sm" disabled={status.busy} onClick={() => setStarter(true)}>
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
                  onPicked={createFromStarter}
                  onClose={() => setStarter(false)}
                  opener={starterButton}
                />
              ) : null}
              <UploadedMaps roomId={roomId} disabled={status.busy} onPick={reuseMap} />
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
                <span style={{ fontSize: theme.font.body14 }}>Squares</span>
                <NumberInput label="Squares across" value={w} min={1} max={MAX_SCENE_CELLS} onChange={setW} />
                <span aria-hidden>×</span>
                <NumberInput label="Squares down" value={h} min={1} max={MAX_SCENE_CELLS} onChange={setH} />
                {kind === "mat" ? <ColorInput label="Background color" value={background} onChange={setBackground} /> : null}
              </div>
              {actionsRow(
                <Button size="sm" variant="primary" onClick={kind === "mat" ? createMat : createBuilder}>
                  Create
                </Button>,
              )}
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
 * is fetched when the form opens, never polled.
 */
function UploadedMaps(props: { roomId: string; disabled: boolean; onPick(row: AssetRow): void }) {
  const assets = useAssets();
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
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <Help>Or use a map already uploaded</Help>
      <div style={{ display: "flex", gap: theme.space(2), overflowX: "auto", paddingBottom: theme.space(1) }}>
        {maps.map((m) => (
          <button
            key={m.id}
            type="button"
            title="Use this map"
            disabled={props.disabled}
            onClick={() => props.onPick(m)}
            style={{
              flex: "none",
              padding: 0,
              border: `${theme.line.border}px solid ${theme.color.border}`,
              borderRadius: theme.radius.sm,
              background: theme.color.bg,
              cursor: props.disabled ? "default" : "pointer",
            }}
          >
            <img
              src={assets.url(m.id, m.variants.includes("thumb") ? "thumb" : "full")}
              alt={`Map, ${m.width} × ${m.height}`}
              loading="lazy"
              style={{ display: "block", width: 96, height: 64, objectFit: "cover", borderRadius: theme.radius.sm }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
