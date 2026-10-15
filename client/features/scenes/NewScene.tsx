import { useEffect, useRef, useState, type ReactNode } from "react";
import { MAX_SCENE_CELLS } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { Help } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { api, type AssetRow } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { useAssets, useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
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
  const [status, setStatus] = useState<{ busy: boolean; waiting: boolean; error: string | null }>({ busy: false, waiting: false, error: null });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const full = props.sceneCount >= MAX_SCENES;

  const pick = (k: Kind) => {
    // Another kind of scene ends an upload in flight, or it would still
    // make its map scene after the DM moved on.
    abortRef.current?.abort();
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

  const createFromAsset = (asset: MapAsset, fileName: string) => {
    const id = actions.newId();
    const { scene, hinted } = mapScene({ id, name: name.trim() || nameFromFile(fileName), asset });
    actions.dispatch({ t: "scene.create", scene });
    // A scale from the file name is usually right. A guess never is.
    open(id, hinted ? null : "grid");
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
      setStatus({ busy: false, waiting: false, error: null });
      createFromAsset(asset, file.name);
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
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setStatus({ busy: false, waiting: false, error: null });
                  }}
                />
              </label>
              <Help>
                A name like <code>crypt_30x20.jpg</code> sets the scale for 30 by 20 squares. Otherwise you line up the grid next.
              </Help>
              {actionsRow(
                <Button size="sm" variant="primary" busy={status.busy} disabled={!file} onClick={() => void upload()}>
                  {status.busy ? "Uploading…" : "Upload and create"}
                </Button>,
              )}
              {status.waiting ? <Help>Waiting for the server…</Help> : null}
              {status.error ? (
                <p role="alert" style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
                  {status.error}
                </p>
              ) : null}
              <UploadedMaps roomId={roomId} disabled={status.busy} onPick={(asset) => createFromAsset(asset, "Map")} />
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

/**
 * Maps already in the room, so one image can back several scenes. The list
 * is fetched when the form opens, never polled.
 */
function UploadedMaps(props: { roomId: string; disabled: boolean; onPick(asset: MapAsset): void }) {
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
            onClick={() => props.onPick({ id: m.id, width: m.width, height: m.height })}
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
