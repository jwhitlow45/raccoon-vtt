import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LIMITS } from "#shared/limits.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { ErrorText, Field } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, Note } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import type { OpAnswer } from "../../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { newScenePick, newScenePreset, withPlayersSee } from "../scenes/create.ts";
import { uploadErrorText, uploadMap } from "../scenes/upload.ts";
import { startingLight } from "../vision/uvttLight.ts";
import { importScene, placeMap, severalFilesOps, type FileFloor } from "./batch.ts";
import { UvttWorker, type Progress } from "./client.ts";
import type { ImportOptions } from "./convert.ts";
import { addingText, dialogTitle, fileError, filesRefusal, moveRow, readingText, rowName, rowsOf, sceneNameOf, scenesFull, severalOutcomeText, tooManyFiles, uploadFailed, uploadingText, type FloorRow } from "./floorsImport.ts";
import { GRID_PROBLEM, type Device } from "./limits.ts";
import { addAnswer, CHECK_MS, importOutcome, mustCount, NO_ANSWERS, sceneShown, storedContents, type Answers, type Contents } from "./rules.ts";
import { shapeNote, sizeText, summaryLight } from "./summary.ts";

/**
 * A new scene from several Universal VTT files (docs/design/design-v1-floors.md
 * phase 4, 9.5, D-261119-057), opened when New scene's file picker gets two
 * or more: a row for each file, lowest floor first, with its Floor name and
 * Move up and Move down, then the Scene name. Make the scene reads each
 * file in the one worker and uploads its image, one file after another, so
 * a phone holds one map at a time. Only once every image is up does it send
 * one Setup group: the first file's scene and contents, then each next
 * file's floor above the one before and its contents. A file that cannot
 * be read or uploaded ends the run there, and nothing is sent.
 *
 * Each floor starts as its file would alone on the room's defaults: a map
 * that brings its own lights dark under party vision, another on what the
 * room's new scenes start on, at the light its file proposes.
 *
 * Once the walls are being sent, closing the dialog only hides it, as one
 * file's import does: the ops go on and a toast says how it ended.
 */

type Step =
  | { k: "rows" }
  | { k: "reading"; at: number; progress: Progress | null }
  | { k: "upload"; at: number; bytes: number; waiting: boolean }
  | { k: "walls"; answered: number; total: number; floor: string }
  /** Answers were lost with the connection, so the new scene is opened and its contents counted. */
  | { k: "checking" }
  /** Ops were sent and the server refused some, or answers were lost: the scene may stand, so it is never made again from here. */
  | { k: "ended"; error: string };

const OPTIONS_OF = (feetPerCell: number): ImportOptions => ({ objects: true, portals: "window", feetPerCell });

/** The footer's line: what Make the scene does with the rows. */
const STATUS = "Each file becomes a floor, the first the lowest.";

const GROW = { flex: "1 1 auto" } as const;

export function FloorsImportDialog(props: { files: readonly File[]; device: Device; onClose(): void }) {
  const actions = useRoomActions();
  const store = useRoomStore();
  const ui = useRoomUi();
  const roomId = useRoomView((s) => s.roomId);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const sceneCount = useRoomView((s) => (s.view ? Object.keys(s.view.scenes).length : 0));
  const setting = useRoomView((s) => s.view?.meta.settings.newScenePlayers);
  const shape = useRoomView((s) => shapeNote(s.view?.meta.settings.newScenes));
  const [rows, setRows] = useState<FloorRow[]>(() => rowsOf(props.files));
  const [sceneName, setSceneName] = useState(() => sceneNameOf(rowsOf(props.files)));
  const [step, setStep] = useState<Step>({ k: "rows" });
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<UvttWorker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  /** The move button to focus once its row has moved, since moving a row's element takes focus off it. */
  const [refocus, setRefocus] = useState<{ key: string; up: boolean } | null>(null);
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      workerRef.current?.terminate();
      abortRef.current?.abort();
    };
  }, []);

  useLayoutEffect(() => {
    if (!refocus) return;
    setRefocus(null);
    const at = rows.findIndex((r) => r.key === refocus.key);
    // At the end of the list the pressed button is off, so its partner takes focus.
    const up = refocus.up ? at > 0 : at === rows.length - 1;
    moveButtons.current.get(`${refocus.key}:${up ? "up" : "down"}`)?.focus();
  }, [refocus, rows]);

  const busy = step.k !== "rows" && step.k !== "ended";
  const refusal = tooManyFiles(rows.length) ?? scenesFull(sceneCount, rows.length);

  /** Stops a file's read or upload. The worker is ended too, since a read in it cannot be stopped otherwise. */
  const cancel = () => {
    abortRef.current?.abort();
    workerRef.current?.terminate();
  };

  const move = (key: string, up: boolean) => {
    const next = moveRow(rows, key, up);
    if (!next) return;
    setRows(next);
    setRefocus({ key, up });
  };

  /**
   * How the import ended, said whether the dialog is open or hidden, as one
   * file's import says it (ImportDialog.tsx finish): with answers lost, the
   * new scene is opened and every floor's contents counted against what
   * was sent, since a DM's view holds every floor of the scene it shows.
   */
  const finish = async (files: readonly FileFloor[], answers: Answers) => {
    const id = files[0]!.scene.id;
    const ids = files.map((f) => f.scene.id);
    const name = files[0]!.scene.name;
    const exists = () => store.getState().view?.scenes[id] !== undefined;
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      actions.switchScene(id);
    };
    let contents: Contents | null = null;
    if (mustCount(answers, exists()) && mounted.current) {
      setStep({ k: "checking" });
      open();
      const view = (await sceneShown(store, id, CHECK_MS)) ? store.getState().view : null;
      contents = view ? sum(ids.map((floor) => storedContents(view, floor))) : null;
    }
    const outcome = importOutcome(answers, { exists: exists(), contents }, sum(files.map((f) => ({ edges: f.plan.edges.length, walls: f.plan.walls.length, lights: f.plan.lights.length }))));
    // A hidden dialog's DM may be anywhere by now, so the new scene does not pull them away.
    if (outcome.k === "complete" && mounted.current) open();
    const { text, tone } = severalOutcomeText(outcome, name, files.length, opened);
    if (mounted.current && outcome.k !== "complete") {
      setStep({ k: "ended", error: text });
      return;
    }
    // Done, or hidden: the toast says how it ended, beside the new scene as the dialog closes on it.
    ui.notify(text, tone);
    if (mounted.current) props.onClose();
  };

  const make = async () => {
    if (busy || refusal) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    const order = rows.slice();
    const name = sceneName;
    const roomDefault = newScenePreset(store.getState().view?.meta.settings.newScenePlayers ?? setting, "uvtt");
    try {
      // Asked again on the latest view, so a scene a co-DM made meanwhile that fills the room sends nothing.
      const early = filesRefusal(store.getState().view, order.length);
      if (early) throw new Error(early);
      workerRef.current?.terminate();
      const worker = new UvttWorker((progress) => setStep((s) => (s.k === "reading" ? { ...s, progress } : s)));
      workerRef.current = worker;
      const files: FileFloor[] = [];
      for (const [i, row] of order.entries()) {
        const at = i + 1;
        setStep({ k: "reading", at, progress: null });
        let read: Awaited<ReturnType<UvttWorker["read"]>>;
        let image: Awaited<ReturnType<UvttWorker["image"]>>;
        try {
          read = await worker.read(row.file, props.device, "scene", OPTIONS_OF(feetPerCell));
          if (!read.plan) throw new Error(read.problem ?? "Its walls could not be worked out.");
          image = await worker.image();
        } catch (err) {
          throw abort.signal.aborted || isAbort(err) ? err : new Error(fileError(row.file.name, messageOf(err)));
        }
        const plan = read.plan;
        setStep({ k: "upload", at, bytes: image.blob.size, waiting: false });
        const ext = image.blob.type === "image/png" ? "png" : image.blob.type === "image/jpeg" ? "jpg" : "webp";
        let asset: Awaited<ReturnType<typeof uploadMap>>;
        try {
          asset = await uploadMap(roomId, new File([image.blob], `${rowName(row)}.${ext}`, { type: image.blob.type }), {
            signal: abort.signal,
            onWaiting: (waiting) => setStep((s) => (s.k === "upload" ? { ...s, waiting } : s)),
          });
        } catch (err) {
          if (abort.signal.aborted || isAbort(err)) throw err;
          throw new Error(`${uploadFailed(rowName(row))} ${uploadErrorText(err)}`);
        }
        const map = placeMap(plan, { assetId: asset.id, width: asset.width, height: asset.height, fileImageWidth: read.info.image.width });
        if (!map) throw new Error(fileError(row.file.name, GRID_PROBLEM));
        const start = startingLight(summaryLight(read), roomDefault);
        const scene = withPlayersSee(importScene(plan, map, { id: actions.newId(), name, light: start.light }), newScenePick(start.seen, undefined, setting, "uvtt"), start.light);
        files.push({ scene, plan, floor: row.floor });
      }
      const late = filesRefusal(store.getState().view, order.length);
      if (late) throw new Error(late);
      const { ops, floorAt } = severalFilesOps(files, actions.newId);
      const floorName = (op: number) => rowName(order[floorAt[Math.max(0, op)] ?? 0]!);
      // One undo group, so one Undo setup takes the whole scene back, every floor with it.
      const group = actions.newId();
      let answers = NO_ANSWERS;
      let answered = 0;
      setStep({ k: "walls", answered: 0, total: ops.length, floor: floorName(0) });
      await new Promise<void>((resolve) => {
        const settle = (answer: OpAnswer) => {
          answers = addAnswer(answers, answer);
          answered++;
          if (mounted.current) setStep({ k: "walls", answered, total: ops.length, floor: floorName(Math.min(answered, ops.length - 1)) });
          if (answered === ops.length) resolve();
        };
        for (const op of ops) {
          if (actions.dispatch(op, { group, groupScope: "setup", onAnswer: settle }) === null) settle("refused");
        }
      });
      await finish(files, answers);
    } catch (err) {
      if (!mounted.current) return;
      setStep({ k: "rows" });
      if (!(abort.signal.aborted || isAbort(err))) setError(messageOf(err));
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
    }
  };

  const at = step.k === "reading" || step.k === "upload" ? step.at : null;
  return (
    <Dialog
      title={dialogTitle(rows.length)}
      onClose={props.onClose}
      width="lg"
      phone="fill"
      status={STATUS}
      statusGrow
      footer={
        <>
          {/* Each grows, so one that wraps under the status fills its line. */}
          {step.k === "reading" || step.k === "upload" ? (
            <Button onClick={cancel} style={GROW}>
              Cancel
            </Button>
          ) : (
            <Button onClick={props.onClose} style={GROW}>
              {step.k === "walls" ? "Hide (keep this page open)" : step.k === "checking" ? "Hide" : "Close"}
            </Button>
          )}
          {step.k === "ended" ? null : (
            <Button variant="primary" busy={busy} disabled={!busy && refusal !== null} onClick={() => void make()} style={GROW}>
              {busy ? "Making…" : "Make the scene"}
            </Button>
          )}
        </>
      }
    >
      <div style={{ display: "grid", gap: theme.space(3), fontSize: theme.font.body14 }}>
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(3) }}>
          {rows.map((row, i) => (
            <li key={row.key} role="group" aria-label={row.file.name} style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>
                <span style={{ flex: "1 1 auto", minWidth: 0, color: theme.color.textMuted, overflowWrap: "anywhere" }}>{row.file.name}</span>
                <Button
                  ref={(el) => void (el ? moveButtons.current.set(`${row.key}:up`, el) : moveButtons.current.delete(`${row.key}:up`))}
                  icon="arrowUp"
                  iconOnly="always"
                  disabled={busy || i === 0}
                  onClick={() => move(row.key, true)}
                >
                  {`Move ${rowName(row)} up`}
                </Button>
                <Button
                  ref={(el) => void (el ? moveButtons.current.set(`${row.key}:down`, el) : moveButtons.current.delete(`${row.key}:down`))}
                  icon="arrowDown"
                  iconOnly="always"
                  disabled={busy || i === rows.length - 1}
                  onClick={() => move(row.key, false)}
                >
                  {`Move ${rowName(row)} down`}
                </Button>
              </div>
              <Field
                label="Floor name"
                value={row.floor}
                maxLength={LIMITS.floorNameChars}
                disabled={busy}
                onChange={(e) => {
                  const floor = e.target.value;
                  setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, floor } : r)));
                }}
              />
            </li>
          ))}
        </ol>
        <Field label="Scene name" value={sceneName} maxLength={80} disabled={busy} onChange={(e) => setSceneName(e.target.value)} />
        {shape ? <Help>{shape}</Help> : null}
        {refusal ? (
          <div role="alert">
            <Note>{refusal}</Note>
          </div>
        ) : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
        {step.k === "ended" ? <ErrorText>{step.error}</ErrorText> : null}
        <Steps step={step} name={at === null ? "" : rowName(rows[at - 1] ?? rows[0]!)} of={rows.length} />
      </div>
    </Dialog>
  );
}

/** What the dialog is doing, each step in its own words. */
function Steps(props: { step: Step; name: string; of: number }) {
  const { step } = props;
  if (step.k === "reading") {
    const fraction = step.progress?.stage === "reading" && step.progress.done !== undefined && step.progress.total ? step.progress.done / step.progress.total : null;
    return <Loading delay={0} text={readingText(props.name, step.at, props.of)} detail={fraction === null ? null : `${Math.floor(fraction * 100)}%`} />;
  }
  if (step.k === "upload") {
    return (
      <div style={{ display: "grid", gap: theme.space(1) }}>
        <Loading delay={0} text={uploadingText(props.name, step.at, props.of)} detail={sizeText(step.bytes)} />
        {step.waiting ? <Help>Waiting for the server…</Help> : null}
      </div>
    );
  }
  if (step.k === "walls") {
    return (
      <div style={{ display: "grid", gap: theme.space(2) }}>
        <Loading delay={0} text={addingText(step.answered, step.total, step.floor)} />
        <Note>Keep this page open until the walls are added.</Note>
      </div>
    );
  }
  if (step.k === "checking") return <Loading delay={0} text="Checking the new scene…" detail="The connection dropped while the walls were sent." />;
  return null;
}

function sum(all: readonly Contents[]): Contents {
  return all.reduce((a, c) => ({ edges: a.edges + c.edges, walls: a.walls + c.walls, lights: a.lights + c.lights }), { edges: 0, walls: 0, lights: 0 });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
