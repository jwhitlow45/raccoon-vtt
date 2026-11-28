import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { MODEL_LIMITS } from "#shared/limits.ts";
import type { ImageRef } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { DiscardQuestion } from "../../components/Dialog.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, SectionLabel } from "../../components/Panel.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { useAssets, useRoomView } from "../../state/view.ts";
import { useDiscard } from "../clock/useDiscard.ts";
import { Module, useModule } from "../modules/Gate.tsx";
import { SheetDialog } from "../tokens/SheetDialog.tsx";
import { ConfirmButton, FieldRow, Select, Stepper } from "../tokens/ui.tsx";
import type { DrawOptions } from "./client.ts";
import { ModelPreview } from "./ModelPreview.tsx";
import { ModelSession, pictureColorOffer, roomModels, sharedModel, sizeCap, type ColorChoice, type RoomModel, type SessionDeps } from "./session.ts";
import { modelUploadWords, pictureColor, uploadModelAsset } from "./upload.ts";

/**
 * The 3D model sheet (docs/design/design-v1-token-models.md 3.1, 3.4, 7 and
 * 8): a bottom sheet on a phone held upright and the dialog elsewhere, as
 * Attach's list is. It reads a file, shows its 8 views with the options
 * that draw them again, and saves the sheet onto the picture, or reuses a
 * model already in the room. With a model there it shows the stored views,
 * Choose another file and Remove model.
 *
 * `wearers` are the images it edits: one for a field, each selected
 * token's in the group edit sheet. `onCommit` gets the change worked out
 * from each one's own image (session.ts).
 */

export const DISCARD_MODEL = "Discard this model?";

/** The model worker's side loads only when someone adds a model, and only once (D-261127-377). */
let client: Promise<typeof import("./client.ts")> | null = null;
function loadClient(): Promise<typeof import("./client.ts")> {
  client ??= import("./client.ts").catch((err: unknown) => {
    client = null;
    throw err;
  });
  return client;
}

const COLOR_OPTIONS: { value: ColorChoice; label: string }[] = [
  { value: "stone", label: "Stone" },
  { value: "bronze", label: "Bronze" },
  { value: "bone", label: "Bone" },
  { value: "iron", label: "Iron" },
];
const PICTURE_COLOR = { value: "picture" as const, label: "Picture's color" };

const STAGE_WORDS = { reading: "Reading the file…", drawing: "Drawing its 8 views…" } as const;
const STAGE_SAID = { reading: "Reading the file.", drawing: "Drawing its views." } as const;

type SheetProps = {
  wearers: readonly (ImageRef | undefined)[];
  onCommit(change: (current: ImageRef | undefined) => ImageRef | null): void;
  onClose(): void;
  opener: RefObject<HTMLElement | null>;
  ring?: string;
};

/**
 * Isometric view's, wherever it opens (D-261127-692): the sheet draws only
 * while the part shows on this device, and closes for good once it hides,
 * here or in another window, as an open ResourceSheet does. Its session
 * closes with it, so a file read or a save under way sends nothing.
 */
export function ModelSheet(props: SheetProps) {
  const shown = useModule("isometric");
  const { onClose } = props;
  useEffect(() => {
    if (!shown) onClose();
  }, [shown, onClose]);
  return (
    <Module id="isometric">
      <OpenSheet {...props} />
    </Module>
  );
}

function OpenSheet(props: SheetProps) {
  const roomId = useRoomView((s) => s.roomId);
  const view = useRoomView((s) => s.view);
  const assets = useAssets();
  const commit = useRef(props.onCommit);
  commit.current = props.onCommit;
  const [session] = useState(() => {
    const deps: SessionDeps = {
      draw: (file, options: DrawOptions) =>
        loadClient().then(
          (m) => m.drawModel(file, options),
          () => {
            throw new Error("The 3D model reader did not load. Check the connection and try again.");
          },
        ),
      endWorker: () => void client?.then((m) => m.endModelWorker()),
      upload: (kind, blob, signal) => uploadModelAsset(roomId, kind, blob, signal),
      colorOf: (image) => pictureColor(image, (id) => assets.url(id, "thumb")),
      commit: (change) => commit.current(change),
      uploadWords: modelUploadWords,
    };
    return new ModelSession(deps, props.wearers);
  });
  const state = useSyncExternalStore(session.subscribe, () => session.state);
  useEffect(() => session.setWearers(props.wearers), [session, props.wearers]);
  // Closing however it closes ends the worker and drops whatever runs. A mount opens it, so strict mode's second mount works.
  useEffect(() => {
    session.open();
    return () => session.close();
  }, [session]);

  const stored = sharedModel(props.wearers);
  const anyModel = props.wearers.some((w) => w?.model);
  const offer = pictureColorOffer(props.wearers);
  const others = useMemo(() => (view ? roomModels(view).filter((m) => m.model.assetId !== stored?.assetId) : []), [view, stored?.assetId]);
  const pending = state.file !== null || state.reuse !== null;
  const close = () => session.close();
  // Once a file was read or a room model picked, the first Cancel asks before it throws that away.
  const { armed, leave } = useDiscard((state.drawn !== null || state.reuse !== null) && !state.saving, close, state.file, state.reuse, state.options);
  // A save closes the sheet as a Cancel does, so the sheet closes in one place.
  const { onClose } = props;
  useEffect(() => {
    if (state.closed) onClose();
  }, [state.closed, onClose]);

  // What the polite live region says: each stage, the model ready, and each error.
  const [said, setSaid] = useState("");
  const was = useRef(state);
  useEffect(() => {
    const before = was.current;
    was.current = state;
    if (state.error && state.error !== before.error) setSaid(state.error);
    else if (state.stage && state.stage !== before.stage) setSaid(STAGE_SAID[state.stage]);
    else if (state.drawn && state.drawn !== before.drawn) setSaid("Model ready.");
  }, [state]);

  const input = useRef<HTMLInputElement>(null);
  const chooser = useRef<HTMLButtonElement>(null);
  const focusChooser = useRef(false);
  useEffect(() => {
    if (!focusChooser.current) return;
    focusChooser.current = false;
    chooser.current?.focus();
  });
  const choose = () => input.current?.click();
  const fileInput = (
    <input
      ref={input}
      type="file"
      hidden
      aria-hidden
      tabIndex={-1}
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) session.pick(file);
      }}
    />
  );

  const busy = state.stage !== null;
  const drawing = busy ? (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: theme.space(2), minHeight: theme.touch }}>
      <Loading text={STAGE_WORDS[state.stage!]} live={false} />
      <Button size="sm" onClick={() => session.cancelDraw()}>
        Cancel
      </Button>
    </div>
  ) : null;
  const error = state.error ? <p style={{ margin: 0, color: theme.color.dangerText, fontSize: theme.font.body14 }}>{state.error}</p> : null;

  let body;
  if (state.drawn && state.file) {
    const cap = sizeCap(state.drawn);
    const colors = offer.shown && offer.usable ? [...COLOR_OPTIONS, PICTURE_COLOR] : COLOR_OPTIONS;
    body = (
      <>
        <ModelPreview sheet={{ blob: state.drawn.sheet }} model={state.drawn.meta} ring={props.ring} />
        {drawing}
        {error}
        {state.drawn.notes.map((note) => (
          <Help key={note}>{note}</Help>
        ))}
        <div data-model-options="" style={{ display: "grid", gap: theme.space(2) }}>
          {state.drawn.colorable ? (
            <>
              <FieldRow label="Color" fill>
                <Select<ColorChoice> label="Color" value={state.options.color} options={colors} disabled={state.saving} onChange={(color) => session.setOptions({ color })} />
              </FieldRow>
              {offer.shown && !offer.usable ? <Help>Picture's color works for up to 6 different pictures at once.</Help> : null}
            </>
          ) : null}
          <OptionButton label="Stand it up" help="Lying down or upside down? Tap until it stands." disabled={state.saving} onClick={() => session.setOptions({ up: (state.options.up + 1) % 6 })} />
          <OptionButton label="Turn its front" help="Which way it faces at Facing 0°: away up the map." disabled={state.saving} onClick={() => session.setOptions({ front: (state.options.front + 1) % 4 })} />
          <FieldRow label="Size" hint="100% fills its square. Its base, if it has one, fills it exactly." stack>
            <Stepper label="Size" value={state.options.size} step={MODEL_LIMITS.sizeStepPercent} min={MODEL_LIMITS.minSizePercent} max={cap} unit="%" disabled={state.saving} onChange={(size) => session.setOptions({ size })} />
          </FieldRow>
          {cap < 200 ? <Help>{`This model stops at ${cap}% to stay sharp.`}</Help> : null}
        </div>
      </>
    );
  } else if (state.reuse) {
    body = (
      <>
        <ModelPreview sheet={{ assetId: state.reuse.model.assetId }} model={state.reuse.model} ring={props.ring} />
        <Help>Saved onto this picture as it is. To change its color, size or which way is up, choose its file.</Help>
        <Button size="sm" ref={chooser} onClick={choose}>
          Choose a file
        </Button>
      </>
    );
  } else if (busy) {
    body = drawing;
  } else if (stored) {
    body = (
      <>
        <ModelPreview sheet={{ assetId: stored.assetId }} model={stored} ring={props.ring} autoFocus />
        {error}
        <Help>To change its color, size or which way is up, choose the file again.</Help>
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
          <Button size="sm" ref={chooser} onClick={choose}>
            Choose another file
          </Button>
          <RemoveModel
            onConfirm={() => {
              focusChooser.current = true;
              session.remove();
            }}
          />
        </div>
      </>
    );
  } else {
    body = (
      <>
        <Help>Stands in Isometric in place of the picture. STL, OBJ or GLB.</Help>
        {error}
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
          <Button size="sm" variant="primary" ref={chooser} autoFocus onClick={choose}>
            Choose a file
          </Button>
          {/* A group whose tokens wear different models has no stored views, and still takes them all off. */}
          {anyModel ? (
            <RemoveModel
              onConfirm={() => {
                focusChooser.current = true;
                session.remove();
              }}
            />
          ) : null}
        </div>
        {others.length > 0 ? <RoomModels models={others} onPick={(m) => session.useRoomModel(m)} /> : null}
      </>
    );
  }

  return (
    <SheetDialog
      title="3D model"
      onClose={state.saving ? close : leave}
      opener={props.opener}
      width={theme.layout.dialog.sm}
      statusGrow
      status={armed ? <DiscardQuestion /> : null}
      footer={
        pending ? (
          <>
            <Button variant={armed ? "danger" : "secondary"} armed={armed} onClick={state.saving ? close : leave} style={{ flex: "1 1 auto" }}>
              {armed ? DISCARD_MODEL : "Cancel"}
            </Button>
            <Button variant="primary" busy={state.saving} disabled={!session.canSave && !state.saving} onClick={() => session.save()} style={{ flex: "1 1 auto" }}>
              {state.saving ? "Saving…" : "Save"}
            </Button>
          </>
        ) : undefined
      }
    >
      <div data-model-sheet="" style={{ display: "grid", gap: theme.space(3) }}>
        {fileInput}
        {body}
        <span role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
          {said}
        </span>
      </div>
    </SheetDialog>
  );
}

/** Remove model: two taps for everyone, since a player has no Undo for it (D-261127-370, 416). */
function RemoveModel(props: { onConfirm(): void }) {
  return (
    <>
      <ConfirmButton icon="delete" confirm="Tap again to remove" describedBy="model-remove-what" onConfirm={props.onConfirm}>
        Remove model
      </ConfirmButton>
      <span id="model-remove-what" style={VISUALLY_HIDDEN}>
        Removes the 3D model. The picture stays.
      </span>
    </>
  );
}

/** A button that draws the views again with the next way up or front, its help under it. */
function OptionButton(props: { label: string; help: string; disabled?: boolean; onClick(): void }) {
  return (
    <div style={{ display: "grid", gap: theme.space(1), justifyItems: "start" }}>
      <Button size="sm" disabled={props.disabled} onClick={props.onClick}>
        {props.label}
      </Button>
      <Help>{props.help}</Help>
    </div>
  );
}

/** "Or use one from this room": the front view of each model the viewer can see, 64 px, each a 44 px target or more. */
function RoomModels(props: { models: readonly RoomModel[]; onPick(model: RoomModel): void }) {
  return (
    // A section label's 8 px over what it heads, as the sheet's other sections stand.
    <div role="group" aria-labelledby="model-room-label" style={{ display: "grid", gap: theme.space(2) }}>
      <SectionLabel id="model-room-label">Or use one from this room</SectionLabel>
      <ul style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), margin: 0, padding: 0, listStyle: "none" }}>
        {props.models.map((m, i) => (
          // A flex item, so the button leaves no line's descender under it.
          <li key={m.model.assetId} style={{ display: "flex" }}>
            <FrontView model={m} index={i} onPick={() => props.onPick(m)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const FRONT_PX = 64;

function FrontView(props: { model: RoomModel; index: number; onPick(): void }) {
  const assets = useAssets();
  return (
    <button
      type="button"
      onClick={props.onPick}
      aria-label={`Use model ${props.index + 1}`}
      title={`Use model ${props.index + 1}`}
      style={{
        width: FRONT_PX,
        height: FRONT_PX,
        padding: 0,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.md,
        backgroundColor: theme.color.stage,
        backgroundImage: `url("${assets.url(props.model.model.assetId, "thumb")}")`,
        // The thumbnail holds the 8 views 4 across and 2 down, frame 0, the front, at its top left.
        backgroundSize: `${MODEL_LIMITS.sheetColumns * 100}% ${MODEL_LIMITS.sheetRows * 100}%`,
        backgroundPosition: "0 0",
        backgroundRepeat: "no-repeat",
        cursor: "pointer",
      }}
    />
  );
}
