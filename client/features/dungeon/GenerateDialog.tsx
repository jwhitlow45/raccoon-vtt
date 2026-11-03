import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import { LEVEL_BANDS, type LevelBand } from "#shared/srd/traps.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog, PINNED_FOOT } from "../../components/Dialog.tsx";
import { ErrorText, Input } from "../../components/Field.tsx";
import { Held } from "../../components/Held.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, Note } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { Switch } from "../../components/Switch.tsx";
import { fitSlot, grownWithin } from "../../canvas/fitSlot.ts";
import { uiScale } from "../device/settings.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { BAND_NAMES } from "../traps/rules.ts";
import { builderScene, cleanName, pickNow, withPlayersSee, type NewSceneIntent, type SceneInput } from "../scenes/create.ts";
import { NumberInput } from "../scenes/controls.tsx";
import { closePreviews, preview, warmPreviews, type Preview } from "./client.ts";
import { flowStep, readiness, startFlow, type Flow, type FlowEvent } from "./flow.ts";
import { SCENE_PLACEHOLDER, withIds } from "./ops.ts";
import { DungeonPreview, type Drawn } from "./Preview.tsx";
import { loadChoices, saveChoices, settingsOf, sidesOf, startChoices, withSize, type Choices } from "./remembered.ts";
import { formatSeed, newSeed, parseSeed, type Seed } from "./seed.ts";
import { clampRooms, MAX_SIDE, MIN_ROOMS, MIN_SIDE, roomCap, type SizeChoice } from "./settings.ts";
import { sendDungeon } from "./send.ts";
import {
  DENSITY_HELP,
  entranceSide,
  FIT_NONE,
  fitLine,
  HEIGHTS_HELP,
  LOOPS_HELP,
  makingLine,
  fogLine,
  NOT_MADE,
  outcomeText,
  PICTURE_FAILED,
  previewName,
  roomsHint,
  SEED_BAD,
  SEED_OTHER_VERSION,
  sizeLine,
  statusLine,
  THEME_HELP,
  TRAPS_HELP,
  WAITING,
  WIDE_HELP,
} from "./words.ts";

/** A change of choice or seed draws a new preview after this much quiet (4.3). */
const QUIET_MS = 150;
/** The entrance room is framed with this many squares round it (D-261102-387). */
const FRAME_MARGIN = 4;
/** From this card width the preview takes the left half (4.7). */
const TWO_COLUMNS_PX = 640;

type Shown = { result: Extract<Preview, { ok: true }>; drawn: Drawn };
type Sending = { answered: number; total: number };

/**
 * Generate a dungeon (docs/design/design-v1-dungeon-generator.md 4.2 to 4.5),
 * opened from New scene's Builder form with the form's name, size and
 * Players see. The worker plans the dungeon and runs its ops through a
 * scratch room (client.ts `preview`), and the picture is that room, so
 * what shows is what Make sends. Nothing is sent before Make.
 *
 * The seed lives only in this dialog: it is never stored or sent, and the
 * device keeps only the choices (remembered.ts). Make gives every op a
 * fresh id, so a second Make of one preview is a second dungeon.
 *
 * Once Make has sent, closing only hides the dialog. The answers still
 * end in the new scene or a toast, and a DM who went to another scene
 * meanwhile is not pulled back (the import's `movedOn`).
 */
export function GenerateDialog(props: {
  roomId: string;
  name: string;
  /** The form's size, where Custom starts. */
  form: { w: number; h: number };
  intent: NewSceneIntent;
  opener: RefObject<HTMLButtonElement | null>;
  /** `made` when a Make was sent and did not end with no scene: hidden mid-send or after a partial one, the form must not make another. */
  onClose(made: boolean): void;
  /** Make ended complete with the dialog open: the form opens the scene. */
  onMade(sceneId: string): void;
}) {
  const actions = useRoomActions();
  const store = useRoomStore();
  const ui = useRoomUi();
  const frames = useScoped(fitSlot);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const offline = useRoomView((s) => s.connection !== "open");
  const fogWarning = useRoomView((s) => fogLine(pickNow(props.intent, s.view, "builder").pick));
  const [choices, setChoices] = useState<Choices>(() => startChoices(loadChoices(props.roomId), props.form));
  const [seedText, setSeedText] = useState(() => formatSeed(newSeed()));
  const [flow, step] = useReducer((f: Flow<Shown>, e: FlowEvent<Shown>) => flowStep(f, e), undefined, startFlow<Shown>);
  const [sending, setSending] = useState<Sending | null>(null);
  /** How a Make that did not complete ended, said in the dialog. `retry` when no scene was made, so Make may send again. */
  const [failed, setFailed] = useState<{ text: string; retry: boolean } | null>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  /** A Make was sent and did not end with no scene, so a scene may exist: the form starts over when the dialog goes. */
  const sceneMayExist = useRef(false);
  const themeRef = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const layout = useBodyLayout(root);

  const parsed = parseSeed(seedText);
  const settings = settingsOf(choices);
  const { w, h } = sidesOf(choices);
  const sceneName = cleanName(props.name, "Dungeon");
  // The preview's scene: the form's name at the chosen size. Players see goes on at Make, read then.
  const scene: SceneInput = useMemo(() => builderScene({ id: SCENE_PLACEHOLDER, name: props.name, w, h }), [props.name, w, h]);
  const key = parsed.ok ? JSON.stringify([settings, parsed.seed]) : null;

  // The worker loads as the dialog opens, and closing ends it, dropping any late answer (client.ts).
  useEffect(() => {
    mounted.current = true;
    warmPreviews();
    return () => {
      mounted.current = false;
      closePreviews();
    };
  }, []);

  // Focus starts on Theme (section 11), after the dialog's own first focus.
  useLayoutEffect(() => {
    themeRef.current?.querySelector<HTMLInputElement>("input:checked")?.focus({ preventScroll: true });
  }, []);

  useEffect(() => saveChoices(props.roomId, choices), [props.roomId, choices]);

  // Only the newest answer shows: each request takes a number, and the flow drops an answer to any older one (flow.ts).
  // A seed that stops reading takes a number too, so a request still drawing never replaces the preview kept.
  useEffect(() => {
    const asked = ++request.current;
    if (key === null || !parsed.ok) {
      step({ k: "invalid", id: asked });
      return;
    }
    step({ k: "ask", id: asked });
    const seed = parsed.seed;
    const timer = setTimeout(() => {
      preview(settings, seed, scene).then(
        (result) => {
          if (!mounted.current) return;
          if (!result.ok) return step({ k: "answer", id: asked, answer: { ok: false, error: result.error } });
          const drawn = { plan: result.plan, room: result.room, name: previewName(result.summary, entranceSide(result.plan)) };
          step({ k: "answer", id: asked, answer: { ok: true, value: { result, drawn } } });
        },
        () => {
          if (mounted.current) step({ k: "answer", id: asked, answer: { ok: false, error: "bug" } });
        },
      );
    }, QUIET_MS);
    return () => clearTimeout(timer);
    // `key` holds the settings and the seed, so the effect runs once per change of either.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scene]);

  const busy = sending !== null;
  /** The choices and Make wait while Make sends, and stay so after a partial or unconfirmed one: a scene exists then, and another Make would be a second dungeon. */
  const locked = busy || (failed !== null && !failed.retry);
  const ready = readiness(flow);
  const current = ready.current?.result ?? null;
  const { problem } = flow;
  const canMake = !locked && parsed.ok && current !== null && current.summary.rooms >= 2;

  const close = () => props.onClose(sceneMayExist.current);
  const set = (patch: Partial<Choices>) => setChoices((c) => ({ ...c, ...patch }));
  const setSize = (patch: Partial<Pick<Choices, "size" | "across" | "down">>) => setChoices((c) => withSize(c, patch));

  const make = async () => {
    if (!canMake || !current) return;
    const made = withIds(current.ops, actions.newId);
    // Players see as the form says now: Like reads its scene at Make, as the form's own Create does.
    const { pick, gone } = pickNow(props.intent, store.getState().view, "builder");
    if (gone) ui.notify(gone);
    const ops = made.ops.map((op) => (op.t === "scene.create" ? { ...op, scene: withPlayersSee(op.scene, pick) } : op));
    const { plan } = current;
    // Only this device's camera frames the entrance, through its own room scope, and nothing is stored (4.5).
    frames.frameOnOpen = { sceneId: made.sceneId, rect: grownWithin({ x: plan.entrance.x, y: plan.entrance.y, width: plan.entrance.w, height: plan.entrance.h }, FRAME_MARGIN, { w: plan.w, h: plan.h }) };
    setFailed(null);
    setSending({ answered: 0, total: ops.length });
    sceneMayExist.current = true;
    // The send opens the scene once complete, or to compare it when answers were lost, unless a hidden dialog's DM went elsewhere.
    const outcome = await sendDungeon(
      { ops, sceneId: made.sceneId, room: current.room },
      actions,
      (answered, total) => {
        if (mounted.current) setSending({ answered, total });
      },
      { store, shown: () => mounted.current },
    );
    if (outcome.k === "complete" && mounted.current) {
      if (outcome.checked) ui.notify(outcomeText(outcome, sceneName, true).text, "info");
      props.onMade(made.sceneId);
      return;
    }
    const opened = (store.getState().sceneLoad?.requested ?? store.getState().sceneId) === made.sceneId;
    const said = outcomeText(outcome, sceneName, opened);
    if (!mounted.current) {
      ui.notify(said.text, said.tone);
      return;
    }
    if (outcome.k === "none") sceneMayExist.current = false;
    setSending(null);
    setFailed({ text: said.text, retry: outcome.k === "none" });
  };

  const status = failed && !failed.retry ? null : busy ? (
    <Loading delay={0} text={offline ? WAITING : makingLine(sending.answered, sending.total)} />
  ) : current ? (
    <span aria-live="polite">{statusLine(current.summary)}</span>
  ) : null;

  // Reroll stands in the preview's corner, so the preview and the choices each keep one left edge.
  const previewBox = (
    <DungeonPreview
      drawn={flow.shown?.drawn ?? null}
      width={layout.width}
      height={layout.height}
      drawing={ready.drawing}
      onPictured={(drawn) => step({ k: "pictured", drawn })}
      onPictureFailed={(drawn) => step({ k: "pictureFailed", drawn })}
    >
      <Button size="sm" disabled={locked} onClick={() => setSeedText(formatSeed(newSeed()))}>
        Reroll
      </Button>
    </DungeonPreview>
  );

  const roomsLimit = roomCap(w, h);
  const fit = current ? fitLine(current.summary) : null;
  const choicesBox = (
    <div style={{ display: "grid", gap: theme.space(4), minWidth: 0, alignContent: "start" }}>
      {failed ? <ErrorText>{failed.text}</ErrorText> : null}
      {problem === "fit" ? (
        <ErrorText>{FIT_NONE}</ErrorText>
      ) : problem === "bug" ? (
        <ErrorText>{NOT_MADE}</ErrorText>
      ) : ready.pictureFailed ? (
        <ErrorText>{PICTURE_FAILED}</ErrorText>
      ) : fit ? (
        <Note>{fit}</Note>
      ) : null}
      {/* Held while Make sends and once a scene exists, so no choice draws a preview Make can no longer send. */}
      <Held held={locked} style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
        <div ref={themeRef}>
          <Choice<Choices["theme"]>
            name="Theme"
            value={choices.theme}
            onChange={(theme) => set({ theme })}
            options={[
              { value: "dungeon", label: "Dungeon" },
              { value: "crypt", label: "Crypt" },
            ]}
            help={THEME_HELP[choices.theme]}
          />
        </div>
        <Choice<SizeChoice>
          name="Size"
          value={choices.size}
          onChange={(size) => setSize({ size })}
          options={[
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
            { value: "custom", label: "Custom" },
          ]}
          help={sizeLine(w, h, feetPerCell)}
        >
          {choices.size === "custom" ? (
            <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
              <NumberInput label="Across" value={choices.across} min={MIN_SIDE} max={MAX_SIDE} onChange={(across) => setSize({ across })} />
              <span aria-hidden>×</span>
              <NumberInput label="Down" value={choices.down} min={MIN_SIDE} max={MAX_SIDE} onChange={(down) => setSize({ down })} />
            </div>
          ) : null}
        </Choice>
        <Named name="Rooms" help={roomsHint(roomsLimit)}>
          {(nameId, helpId) => (
            <div role="group" aria-labelledby={nameId} aria-describedby={helpId}>
              <NumberInput label="Rooms" value={clampRooms(choices.rooms, w, h)} min={MIN_ROOMS} max={roomsLimit} onChange={(rooms) => set({ rooms })} />
            </div>
          )}
        </Named>
        <Choice<Choices["density"]>
          name="Density"
          value={choices.density}
          onChange={(density) => set({ density })}
          options={[
            { value: "sparse", label: "Sparse" },
            { value: "normal", label: "Normal" },
            { value: "dense", label: "Dense" },
          ]}
          help={DENSITY_HELP}
        />
        <Choice<Choices["corridors"]>
          name="Corridors"
          value={choices.corridors}
          onChange={(corridors) => set({ corridors })}
          options={[
            { value: "straight", label: "Straight" },
            { value: "bending", label: "Bending" },
            { value: "winding", label: "Winding" },
          ]}
        />
        <Choice<"narrow" | "wide">
          name="Corridor width"
          value={choices.wide ? "wide" : "narrow"}
          onChange={(v) => set({ wide: v === "wide" })}
          options={[
            { value: "narrow", label: "Narrow" },
            { value: "wide", label: "Wide" },
          ]}
          help={WIDE_HELP}
        />
        <Switch label="Extra ways round" help={LOOPS_HELP} checked={choices.loops} onChange={(loops) => set({ loops })} />
        <Choice<Choices["heights"]>
          name="Heights"
          value={choices.heights}
          onChange={(heights) => set({ heights })}
          options={[
            { value: "flat", label: "Flat" },
            { value: "some", label: "Some" },
          ]}
          help={HEIGHTS_HELP}
        />
        <Choice<Choices["traps"]>
          name="Traps"
          value={choices.traps}
          onChange={(traps) => set({ traps })}
          options={[
            { value: "none", label: "None" },
            { value: "few", label: "Few" },
            { value: "some", label: "Some" },
          ]}
          help={choices.traps === "none" ? undefined : TRAPS_HELP}
        />
        {choices.traps === "none" ? null : (
          <Choice<LevelBand>
            name="Party level"
            value={choices.band}
            onChange={(band) => set({ band })}
            options={LEVEL_BANDS.map((b) => ({ value: b, label: BAND_NAMES[b].replace("Levels ", ""), title: BAND_NAMES[b] }))}
          />
        )}
      </Held>
      <SeedField text={seedText} seed={parsed.ok ? parsed.seed : null} disabled={locked} error={parsed.ok ? null : SEED_BAD} note={parsed.ok && parsed.otherVersion ? SEED_OTHER_VERSION : null} onChange={setSeedText} />
    </div>
  );

  return (
    <Dialog
      title="Generate a dungeon"
      onClose={close}
      width="lg"
      phone="fill"
      backClose
      opener={props.opener}
      status={status}
      statusGrow
      footer={
        <>
          {/* Each grows, so one that wraps under the status fills its line. */}
          <Button onClick={close} style={{ flex: "1 1 auto" }}>{busy ? "Hide" : failed && !failed.retry ? "Close" : "Cancel"}</Button>
          {failed && !failed.retry ? null : (
            <Button variant="primary" busy={busy} disabled={!canMake && !busy} onClick={() => void make()} style={{ flex: "1 1 auto" }}>
              Make the scene
            </Button>
          )}
        </>
      }
    >
      <div ref={root} style={{ position: "relative", display: "grid", gap: theme.space(4), ...(layout.wide ? { paddingLeft: layout.width + theme.space(4), minHeight: layout.height } : null) }}>
        {/*
         * The preview stays in view while the choices scroll: beside them on a
         * wide card, in a column of its own placed at the left, and over them
         * on a narrow one.
         */}
        {layout.wide ? (
          <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: layout.width }}>
            <div style={{ position: "sticky", top: 0 }}>{previewBox}</div>
          </div>
        ) : (
          <div style={{ position: "sticky", top: 0, zIndex: 1, background: theme.color.surface, paddingBottom: theme.space(2), marginBottom: -theme.space(2) }}>{previewBox}</div>
        )}
        {choicesBox}
        {/* Above the foot whatever the scroll, so it is read before Make. */}
        {fogWarning ? (
          <div style={PINNED_FOOT}>
            <Note>{fogWarning}</Note>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * The preview's box and whether the card is wide enough for two columns
 * (4.7), from the dialog's body as it lays out. On a wide card the preview
 * is a square of half the width, never taller than the body. On a narrow
 * one it spans the body and is as tall as it is wide, up to 45% of the
 * body's height, or 40% at a large interface size or on the smallest
 * phones.
 */
function useBodyLayout(root: RefObject<HTMLDivElement | null>): { wide: boolean; width: number; height: number } {
  const [box, setBox] = useState({ width: 0, height: 0, pad: 0 });
  useLayoutEffect(() => {
    const el = root.current;
    const body = el?.parentElement;
    if (!el || !body) return;
    const measure = () => {
      const style = getComputedStyle(body);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      setBox({ width: body.clientWidth - padX, height: body.clientHeight - padY, pad: padX });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [root]);
  const wide = box.width + box.pad >= TWO_COLUMNS_PX;
  if (wide) {
    const side = Math.max(0, Math.floor(Math.min((box.width - theme.space(4)) / 2, box.height)));
    return { wide, width: side, height: side };
  }
  const share = uiScale() > 1 || box.width + box.pad < 360 ? 0.4 : 0.45;
  return { wide, width: Math.max(0, Math.floor(box.width)), height: Math.max(0, Math.floor(Math.min(box.width, box.height * share))) };
}

const NAME_STYLE = { fontSize: theme.font.body14, fontWeight: theme.weight.strong } as const;

function Named(props: { name: string; help?: ReactNode; children: (nameId: string, helpId: string | undefined) => ReactNode }) {
  const nameId = useId();
  const helpId = useId();
  return (
    <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      <span id={nameId} style={NAME_STYLE}>
        {props.name}
      </span>
      {props.children(nameId, props.help ? helpId : undefined)}
      {props.help ? <Help id={helpId}>{props.help}</Help> : null}
    </div>
  );
}

/** A named choice with its help under it, the group named by the visible name. */
function Choice<T extends string>(props: {
  name: string;
  value: T;
  options: readonly { value: T; label: string; title?: string }[];
  onChange(value: NoInfer<T>): void;
  help?: ReactNode;
  children?: ReactNode;
}) {
  const nameId = useId();
  return (
    <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      <span id={nameId} style={NAME_STYLE}>
        {props.name}
      </span>
      <Segmented<T> labelledBy={nameId} value={props.value} options={props.options} onChange={props.onChange} description={props.help} />
      {props.children}
    </div>
  );
}

/** The seed's field. Copy seed copies the seed as read, in its usual form, whatever spacing or case was typed. */
function SeedField(props: { text: string; seed: Seed | null; disabled: boolean; error: string | null; note: string | null; onChange(text: string): void }) {
  const id = useId();
  const hintId = useId();
  const { seed } = props;
  const copy = () => {
    if (seed !== null) void navigator.clipboard?.writeText(formatSeed(seed)).catch(() => {});
  };
  return (
    <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      <label htmlFor={id} style={NAME_STYLE}>
        Seed
      </label>
      <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
        <Input
          id={id}
          value={props.text}
          error={!!props.error}
          disabled={props.disabled}
          maxLength={40}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error || props.note ? hintId : undefined}
          onChange={(e) => props.onChange(e.target.value)}
          style={{ flex: "1 1 12em", minWidth: 0, fontFamily: theme.font.mono }}
        />
        <Button onClick={copy} disabled={seed === null}>
          Copy seed
        </Button>
      </div>
      {props.error ? (
        <div id={hintId} role="alert" style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
          {props.error}
        </div>
      ) : props.note ? (
        <Help id={hintId}>{props.note}</Help>
      ) : null}
    </div>
  );
}
