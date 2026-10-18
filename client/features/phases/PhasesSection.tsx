import { useEffect, useRef, useState } from "react";
import type { MapPhase, Scene } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Help, Note, Section } from "../../components/Panel.tsx";
import { Tag } from "../../components/Tag.tsx";
import { accessibleName } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { useAssets, useRoomActions, useRoomStore, useRoomView } from "../../state/view.ts";
import { ConfirmButton } from "../scenes/controls.tsx";
import { nameFromFile } from "../scenes/create.ts";
import { uploadErrorText, uploadMap } from "../scenes/upload.ts";
import { UvttAddPhase } from "../uvtt/UvttImport.tsx";
import { activePhaseId, addPhase, canAddPhase, movePhase, phasesOf, removeConfirmText, removePhase, renamePhase } from "./rules.ts";

/**
 * A map's phases in the scene's settings (docs/design-v1-maps-vision.md
 * section 3.4): the same place as another image, such as night or on fire.
 * A row of chips switches the map with one tap and no confirmation, since
 * the DM prepared it and the switch is the point. The list below adds,
 * renames, reorders and removes phases.
 *
 * Players get only the phase showing. Adding, renaming or reordering the
 * others changes nothing they receive, so none of it asks first.
 */
export function PhasesSection(props: { scene: Scene }) {
  const { scene } = props;
  const actions = useRoomActions();
  const store = useRoomStore();
  const roomId = useRoomView((s) => s.roomId);
  const [editing, setEditing] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ busy: boolean; waiting: boolean; error: string | null }>({ busy: false, waiting: false, error: null });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    setEditing(null);
    setUpload((u) => (u.busy ? u : { busy: false, waiting: false, error: null }));
  }, [scene.id]);

  if (!scene.map) return null;
  const phases = phasesOf(scene);
  const active = activePhaseId(scene, phases);
  const send = (list: MapPhase[] | null) => {
    if (list) actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { phases: list } });
  };

  const add = async (file: File) => {
    const sceneId = scene.id;
    const abort = new AbortController();
    abortRef.current = abort;
    setUpload({ busy: true, waiting: false, error: null });
    try {
      const asset = await uploadMap(roomId, file, { signal: abort.signal, onWaiting: (waiting) => setUpload((u) => ({ ...u, waiting })) });
      // The scene as it is now: the DM may have changed its grid or phases during the upload.
      const latest = store.getState().view?.scenes[sceneId];
      if (!latest) {
        setUpload({ busy: false, waiting: false, error: null });
        return;
      }
      const edit = addPhase(latest, { assetId: asset.id, widthPx: asset.width, heightPx: asset.height, name: nameFromFile(file.name) }, actions.newId);
      if ("problem" in edit) {
        setUpload({ busy: false, waiting: false, error: edit.problem });
        return;
      }
      setUpload({ busy: false, waiting: false, error: null });
      actions.dispatch({ t: "scene.update", sceneId, patch: { phases: edit.phases } });
    } catch (err) {
      if (!abort.signal.aborted) setUpload({ busy: false, waiting: false, error: uploadErrorText(err) });
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  };

  // One column that never grows past the panel: a phase name from a file can be 80 characters on one line.
  return (
    <Section label="Map phases" style={{ gridTemplateColumns: "minmax(0, 1fr)", minWidth: 0 }}>
      {phases.length > 1 ? (
        <div role="group" aria-label="Show a phase" style={{ display: "flex", alignItems: "center", gap: theme.space(1), flexWrap: "wrap" }}>
          {phases.map((phase) => {
            const title = phase.id === active ? `${phase.name} is showing` : `Show ${phase.name}`;
            return (
              <Button
                key={phase.id}
                size="sm"
                title={title}
                aria-label={accessibleName(phase.name, title)}
                pressed={phase.id === active}
                onClick={() => {
                  if (phase.id !== active) actions.dispatch({ t: "scene.setPhase", sceneId: scene.id, phaseId: phase.id });
                }}
                style={{ flex: "0 1 auto", minWidth: 0, maxWidth: "100%" }}
              >
                <span style={ellipsis}>{phase.name}</span>
              </Button>
            );
          })}
        </div>
      ) : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
        {phases.map((phase, i) => (
          <PhaseRow
            key={phase.id || "first"}
            phase={phase}
            showing={phase.id === active}
            editing={editing === phase.id}
            onEdit={() => setEditing(editing === phase.id ? null : phase.id)}
            first={i === 0}
            last={i === phases.length - 1}
            canRemove={phases.length > 1}
            removeConfirm={removeConfirmText(phases, phase.id, phase.id === active)}
            onRename={(name) => send(renamePhase(scene, phase.id, name, actions.newId))}
            onMove={(delta) => send(movePhase(scene, phase.id, delta))}
            onRemove={() => {
              setEditing(null);
              send(removePhase(scene, phase.id));
            }}
          />
        ))}
      </ul>
      <Help>
        {canAddPhase(phases)
          ? "Another image of this same map, such as night or on fire. Players see only the phase showing. Tokens, fog and the build stay where they are."
          : `A map can have at most ${LIMITS.phasesPerScene} phases.`}
      </Help>
      {canAddPhase(phases) ? (
        <div style={{ display: "grid", gap: theme.space(2), justifyItems: "start" }}>
          <AddPicker busy={upload.busy} onFile={(f) => void add(f)} />
          <UvttAddPhase scene={scene} />
        </div>
      ) : null}
      {upload.waiting ? <Help>Waiting for the server…</Help> : null}
      {upload.error ? (
        <div role="alert">
          <Note>{upload.error}</Note>
        </div>
      ) : null}
    </Section>
  );
}

const ellipsis = { display: "block", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

function PhaseRow(props: {
  phase: MapPhase;
  showing: boolean;
  editing: boolean;
  first: boolean;
  last: boolean;
  canRemove: boolean;
  removeConfirm: string;
  onEdit(): void;
  onRename(name: string): void;
  onMove(delta: -1 | 1): void;
  onRemove(): void;
}) {
  const { phase } = props;
  return (
    <li style={{ borderTop: `${theme.line.border}px solid ${theme.color.border}`, padding: `${theme.space(2)}px 0` }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(3) }}>
        <Thumb assetId={phase.assetId} />
        <div style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5), justifyItems: "start" }}>
          <div style={{ ...ellipsis, maxWidth: "100%", fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight }}>{phase.name}</div>
          {props.showing ? (
            <Tag tone="turn">Showing now</Tag>
          ) : (
            <div style={{ fontSize: theme.font.small, lineHeight: theme.leading.tight, color: theme.color.textMuted }}>
              {phase.widthPx} × {phase.heightPx} px
            </div>
          )}
        </div>
        <Button size="sm" aria-label={props.editing ? undefined : `Edit ${phase.name}`} title={props.editing ? undefined : `Edit ${phase.name}`} pressed={props.editing} onClick={props.onEdit}>
          {props.editing ? "Done" : "Edit"}
        </Button>
      </div>
      {props.editing ? (
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap", padding: `${theme.space(2)}px 0 0` }}>
          <PhaseName name={phase.name} onSave={props.onRename} />
          <Button size="sm" icon="arrowUp" iconOnly="always" aria-label={`Move ${phase.name} up`} disabled={props.first} onClick={() => props.onMove(-1)} />
          <Button size="sm" icon="arrowDown" iconOnly="always" aria-label={`Move ${phase.name} down`} disabled={props.last} onClick={() => props.onMove(1)} />
          {props.canRemove ? (
            <ConfirmButton
              label="Remove"
              confirm={props.removeConfirm}
              title={props.showing ? `Remove ${phase.name}. The map shows the first phase left.` : `Remove ${phase.name}`}
              shrink
              onConfirm={props.onRemove}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The phase's own small image, or a plain swatch while it loads or if it will not. */
function Thumb(props: { assetId: string }) {
  const assets = useAssets();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [props.assetId]);
  const box = { flex: "none", width: 64, height: 44, borderRadius: theme.radius.sm, background: theme.color.surfaceRaised, objectFit: "cover" } as const;
  if (broken) return <span aria-hidden style={{ ...box, display: "block" }} />;
  return <img src={assets.url(props.assetId, "thumb")} alt="" loading="lazy" onError={() => setBroken(true)} style={box} />;
}

function PhaseName(props: { name: string; onSave(name: string): void }) {
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
    <div style={{ flex: "1 1 180px", minWidth: 0, display: "flex" }}>
      <Input
        aria-label="Phase name"
        value={text}
        maxLength={80}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
        style={{ flex: 1, width: "100%" }}
      />
    </div>
  );
}

function AddPicker(props: { busy: boolean; onFile(file: File): void }) {
  return (
    <label
      style={{
        position: "relative",
        display: "inline-grid",
        placeItems: "center",
        minHeight: theme.touch,
        padding: `0 ${theme.space(3)}px`,
        borderRadius: theme.radius.md,
        fontSize: theme.font.body14,
        fontWeight: theme.weight.strong,
        cursor: props.busy ? "default" : "pointer",
        ...buttonLook("secondary", { disabled: props.busy }),
      }}
    >
      {props.busy ? "Uploading…" : "Add a phase"}
      <input
        type="file"
        accept="image/*"
        aria-label="Add a phase from an image"
        disabled={props.busy}
        style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", cursor: "pointer" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) props.onFile(f);
        }}
      />
    </label>
  );
}
