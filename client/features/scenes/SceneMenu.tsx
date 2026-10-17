import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { Scene } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorText, Input } from "../../components/Field.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { Spinner } from "../../components/Loading.tsx";
import { Help } from "../../components/Panel.tsx";
import { LIMITS } from "#shared/limits.ts";
import { UnsavedInput, useUnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useAssets, useRoomActions, useRoomStore } from "../../state/view.ts";
import { DUPLICATE_DEFAULTS, duplicateOp, fogHint, type DuplicateInclude } from "./duplicate.ts";
import { cleanFolderName } from "./folders.ts";
import { makeThumbnail, thumbsSlot } from "./thumbs.ts";
import { CheckRow, SceneSheet, SheetRow } from "./SceneSheet.tsx";

type Step = "menu" | "duplicate" | "folder";

/**
 * A scene's menu in the Scenes panel, opened from the more button on its row. One
 * sheet stays open through its steps, so Back and Escape always close the
 * same thing.
 */
export function SceneMenuButton(props: { scene: Scene; viewing: boolean; sceneCount: number; folders: readonly string[] }) {
  const { scene } = props;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton ref={button} icon="more" label={`More for ${scene.name || "Untitled"}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
      {open ? <SceneMenu scene={scene} viewing={props.viewing} sceneCount={props.sceneCount} folders={props.folders} opener={button} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SceneMenu(props: { scene: Scene; viewing: boolean; sceneCount: number; folders: readonly string[]; opener: RefObject<HTMLButtonElement | null>; onClose(): void }) {
  const { scene, onClose } = props;
  const [step, setStep] = useState<Step>("menu");
  const duplicate = useDuplicate(scene, onClose);
  const full = props.sceneCount >= LIMITS.scenesPerRoom;
  const name = scene.name || "Untitled";

  if (step === "folder") {
    return (
      <SceneSheet title={`Move ${name} to a folder`} opener={props.opener} onClose={onClose} onBack={() => setStep("menu")}>
        <FolderPicker scene={scene} folders={props.folders} onDone={onClose} />
      </SceneSheet>
    );
  }

  if (step === "duplicate") {
    return (
      <SceneSheet
        title={`Duplicate ${name}`}
        opener={props.opener}
        onClose={onClose}
        onBack={duplicate.busy ? undefined : () => setStep("menu")}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={full} busy={duplicate.busy} onClick={duplicate.start}>
              {duplicate.busy ? "Duplicating…" : "Duplicate"}
            </Button>
          </>
        }
      >
        <div style={{ display: "grid", gap: theme.space(1) }}>
          {/* Only Duplicate sends the choices, so a swipe springs back once any changed, inside the sheet whose swipe it holds (docs/design-v1-sheet-swipe.md 4.5). */}
          <UnsavedInput unsaved={!duplicate.busy && duplicate.changed} />
          <Help style={{ marginBottom: theme.space(2) }}>
            The copy, {`"${name} (copy)"`}, always gets the map and its phases, the build, labels, stamps and lights. Also copy:
          </Help>
          <CheckRow label="Monsters, NPCs and objects" checked={duplicate.include.creatures} disabled={duplicate.busy} onChange={(creatures) => duplicate.set({ creatures })} />
          <CheckRow
            label="Player characters"
            hint="Their tokens point at the same characters. Moving players brings the party over instead."
            checked={duplicate.include.characters}
            disabled={duplicate.busy}
            onChange={(characters) => duplicate.set({ characters })}
          />
          <CheckRow
            label="Fog"
            hint={fogHint(scene, duplicate.include.fog)}
            checked={duplicate.include.fog}
            disabled={duplicate.busy}
            onChange={(fog) => duplicate.set({ fog })}
          />
          <CheckRow label="Drawings and placed areas" checked={duplicate.include.drawings} disabled={duplicate.busy} onChange={(drawings) => duplicate.set({ drawings })} />
          {full ? <Help>A room holds at most {LIMITS.scenesPerRoom} scenes. Delete one to add another.</Help> : null}
          <ErrorText>{duplicate.error}</ErrorText>
        </div>
      </SceneSheet>
    );
  }

  return (
    <SceneSheet title={name} opener={props.opener} onClose={onClose}>
      <div style={{ display: "grid", gap: theme.space(2) }}>
        <SheetRow label="Duplicate…" hint="A copy next to this scene, with what you choose." onClick={() => setStep("duplicate")} />
        <SheetRow label="Move to folder…" hint={scene.folder === undefined ? "In no folder now." : `In ${scene.folder} now.`} onClick={() => setStep("folder")} />
        <UpdateThumbnail scene={scene} viewing={props.viewing} />
      </div>
    </SceneSheet>
  );
}

/**
 * Sends the duplicate and waits for the server, which copies everything in
 * one step. The button ignores taps meanwhile, so a second tap never makes
 * a second copy. Once the copy is taken it opens, under the scene loading
 * notice like any switch (design 14.7), even if the DM closed the sheet.
 */
function useDuplicate(scene: Scene, close: () => void) {
  const actions = useRoomActions();
  const store = useRoomStore();
  const [include, setInclude] = useState<DuplicateInclude>(DUPLICATE_DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const finish = (newSceneId: string, opened: boolean, message: string | null) => {
    if (opened) {
      close();
      actions.switchScene(newSceneId);
      return;
    }
    if (!mounted.current) return;
    setBusy(false);
    setError(message);
  };

  const start = () => {
    if (busy) return;
    const newSceneId = actions.newId();
    setBusy(true);
    setError(null);
    const n = actions.dispatch(duplicateOp(scene.id, newSceneId, scene.name, include), {
      onAnswer: (answer) => {
        if (answer === "taken") finish(newSceneId, true, null);
        // The answer was lost with the connection. The snapshot that followed says whether the copy exists.
        else if (answer === "unknown") finish(newSceneId, store.getState().view?.scenes[newSceneId] !== undefined, "The connection dropped before the server answered, and the copy was not made. Try again.");
        else finish(newSceneId, false, "The scene was not duplicated.");
      },
    });
    if (n === null) finish(newSceneId, false, "The scene could not be duplicated.");
  };

  const changed = (Object.keys(DUPLICATE_DEFAULTS) as (keyof DuplicateInclude)[]).some((k) => include[k] !== DUPLICATE_DEFAULTS[k]);
  return { include, set: (patch: Partial<DuplicateInclude>) => setInclude((i) => ({ ...i, ...patch })), busy, error, start, changed };
}

/**
 * The folders that exist, plus a new one by name. A folder is only a name
 * on its scenes, so typing an existing name moves the scene into it.
 */
function FolderPicker(props: { scene: Scene; folders: readonly string[]; onDone(): void }) {
  const { scene } = props;
  const actions = useRoomActions();
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  // A new folder's name typed and not yet created keeps the menu from a swipe's close (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(draft.trim() !== "");
  const fieldId = useId();
  const move = (folder: string | null) => {
    if (folder !== (scene.folder ?? null)) actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { folder } });
    props.onDone();
  };
  const create = () => {
    const name = cleanFolderName(draft);
    if (name === null) setInvalid(true);
    else move(name);
  };
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      {props.folders.map((folder) => (
        <SheetRow key={folder} label={folder} hint={folder === scene.folder ? "This scene is here now." : undefined} disabled={folder === scene.folder} onClick={() => move(folder)} />
      ))}
      {scene.folder !== undefined ? <SheetRow label="No folder" hint="Back to the top of the list." onClick={() => move(null)} /> : null}
      <div style={{ display: "grid", gap: theme.space(1), marginTop: theme.space(2) }}>
        <label htmlFor={fieldId} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
          New folder…
        </label>
        <div style={{ display: "flex", gap: theme.space(2), alignItems: "center" }}>
          <Input
            id={fieldId}
            aria-label="New folder name"
            placeholder="Act one"
            value={draft}
            maxLength={LIMITS.folderNameChars}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
            style={{ flex: 1, width: 0 }}
          />
          <Button variant="primary" disabled={draft.trim() === ""} onClick={create}>
            Move
          </Button>
        </div>
        {invalid ? (
          <p role="alert" style={{ margin: 0, fontSize: theme.font.small, color: theme.color.warning }}>
            A folder name is 1 to {LIMITS.folderNameChars} characters on one line.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Update thumbnail": a wait the DM asked for, so it says "Updating…" until
 * done and says so if it fails (docs/design-v1-maps-vision.md section 3.3).
 * Only the scene on screen can be drawn, since the DM's view holds no other
 * scene's build.
 */
function UpdateThumbnail(props: { scene: Scene; viewing: boolean }) {
  const { scene, viewing } = props;
  const store = useRoomStore();
  const actions = useRoomActions();
  const assets = useAssets();
  const scope = useRoomScope();
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async () => {
    const room = store.getState().view;
    if (status === "busy" || !viewing || !room) return;
    setStatus("busy");
    let next: "done" | "failed" = "done";
    try {
      await makeThumbnail(scope.get(thumbsSlot), { store, actions, assets }, scene.id, room);
    } catch {
      next = "failed";
    }
    if (mounted.current) setStatus(next);
  };
  const busy = status === "busy";
  return (
    <>
      <SheetRow
        label={
          busy ? (
            <span style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
              <Spinner size={16} />
              Updating…
            </span>
          ) : (
            "Update thumbnail"
          )
        }
        hint={viewing ? (status === "done" ? "Updated." : "Draws this scene's map and build again.") : "Open this scene first. Only the scene on screen can be drawn."}
        disabled={!viewing}
        onClick={() => void run()}
      />
      <ErrorText>{status === "failed" ? "The thumbnail could not be updated. Check the connection and try again." : null}</ErrorText>
    </>
  );
}
