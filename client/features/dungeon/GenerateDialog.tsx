import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { GROUND_FLOOR } from "#shared/reducer/floors.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog, PINNED_FOOT } from "../../components/Dialog.tsx";
import { ErrorText } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, Note } from "../../components/Panel.tsx";
import { fitSlot, grownWithin } from "../../canvas/fitSlot.ts";
import { uiScale } from "../device/settings.ts";
import { ON_BOARD, ON_BOARD_STYLE, theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { builderScene, cleanName, pickNow, type NewSceneIntent, type SceneInput } from "../scenes/create.ts";
import { floorAddRefusal, floorCreateOf, type FloorTarget } from "../scenes/floorSource.ts";
import { CHECK_MS } from "../uvtt/rules.ts";
import { NumberInput } from "../scenes/controls.tsx";
import { Choice, Choices as ChoiceRows } from "./Choices.tsx";
import { closePreviews, preview, warmPreviews, type Preview } from "./client.ts";
import { counted, drawable, flowStep, readiness, startFlow, type Flow, type FlowEvent } from "./flow.ts";
import { journalFull } from "./keyHold.ts";
import { keyOps, type KeyInput } from "./keyPage.ts";
import { LookCloser } from "./LookCloser.tsx";
import { SCENE_PLACEHOLDER, withIds } from "./ops.ts";
import { DungeonPreview, type Drawn } from "./Preview.tsx";
import { keptSize, loadChoices, saveChoices, settingsOf, sidesOf, startChoices, withSize, type Choices } from "./remembered.ts";
import { formatSeed, newSeed, parseSeed } from "./seed.ts";
import { CHOICE_NAMES, MAX_SIDE, MIN_SIDE, type DungeonSettings, type SizeChoice } from "./settings.ts";
import { sendDungeon, warmOpChecks } from "./send.ts";
import {
  entranceSide,
  FIT_NONE,
  fitLine,
  floorKeyName,
  floorOutcomeText,
  floorTitle,
  lightLine,
  MAKE_FLOOR,
  MAKE_SCENE,
  makingLine,
  MAKING_FLOOR,
  fogLine,
  NOT_MADE,
  outcomeText,
  PICTURE_FAILED,
  previewName,
  sizeLine,
  startScene,
  statusLine,
  WAITING,
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
 *
 * Aimed at a floor (docs/design/design-v1-floors.md phase 3, 3.7), it makes
 * a floor just above or below the floor beside, named for the theme: it
 * opens on Custom at that floor's size, leaves the remembered size alone,
 * starts the light as an untouched New scene form starts a generated scene,
 * and sends the key page once the floor's create is taken. Until then no
 * close goes through, the browser's own included, so no op of this device
 * splits the floor's Undo setup step from its key (D-261110-183).
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
  /** Make a floor here in place of a scene. `form` is then the floor beside's size, and `name` its scene's. */
  floor?: FloorTarget;
}) {
  const actions = useRoomActions();
  const store = useRoomStore();
  const ui = useRoomUi();
  const frames = useScoped(fitSlot);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const offline = useRoomView((s) => s.connection !== "open");
  const journal = useRoomView((s) => s.view?.journal);
  const myColor = useRoomView((s) => s.view?.members[s.you?.memberId ?? ""]?.color ?? null);
  /** The DM's tap of Keep it lit. Held until the dialog closes, and a Lit rooms change keeps it (the import's rule). */
  const [keptLit, setKeptLit] = useState(false);
  const [looking, setLooking] = useState(false);
  const [lookFailed, setLookFailed] = useState<string | null>(null);
  // A floor opens at its own size and leaves the remembered size as it was when the dialog opened (D-261110-185).
  const [start] = useState(() => {
    const saved = loadChoices(props.roomId);
    const choices = startChoices(saved, props.form, props.floor ? props.form : undefined);
    return { choices, kept: props.floor ? keptSize(saved, choices.rooms) : undefined };
  });
  const [choices, setChoices] = useState<Choices>(start.choices);
  const [seedText, setSeedText] = useState(() => formatSeed(newSeed()));
  const [flow, step] = useReducer((f: Flow<Shown>, e: FlowEvent<Shown>) => flowStep(f, e), undefined, startFlow<Shown>);
  const [sending, setSending] = useState<Sending | null>(null);
  /** How a Make that did not complete ended, said in the dialog. `retry` when no scene was made, so Make may send again. */
  const [failed, setFailed] = useState<{ text: string; retry: boolean } | null>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  /** A Make was sent and did not end with no scene, so a scene may exist: the form starts over when the dialog goes. */
  const sceneMayExist = useRef(false);
  /** A floor's create sent and not yet answered: every close waits, up to CHECK_MS (D-261110-183). */
  const [holding, setHolding] = useState(false);
  const hideRef = useRef<HTMLButtonElement>(null);
  // A scene's one floor takes this name with its first add.
  const besideName = useRoomView((s) => (props.floor ? (s.view?.scenes[props.floor.beside]?.floor?.name ?? GROUND_FLOOR) : GROUND_FLOOR));
  const root = useRef<HTMLDivElement>(null);
  const layout = useBodyLayout(root);

  const parsed = parseSeed(seedText);
  const settings = settingsOf(choices);
  const { w, h } = sidesOf(choices);
  const sceneName = cleanName(props.name, "Dungeon");
  /** A floor is named for its theme, numbered by the reducer while taken (D-261110-076). */
  const floorName = CHOICE_NAMES.theme[choices.theme];
  // The preview's scene: the form's name at the chosen size. Players see goes on at Make, read then.
  const scene: SceneInput = useMemo(() => builderScene({ id: SCENE_PLACEHOLDER, name: props.name, w, h }), [props.name, w, h]);
  // Held when the journal has room for nothing more: the preview then lands no key, and the switch reads off.
  const [keyHeld, setKeyHeld] = useState(false);
  // A floor's page is titled again from the stored name once its create is taken (send.ts). The preview's guesses it.
  const keyName = props.floor ? floorKeyName(sceneName, floorName) : sceneName;
  const keyInput: KeyInput | null = choices.key && !keyHeld && myColor ? { name: keyName, color: myColor, feetPerCell } : null;
  const key = parsed.ok ? JSON.stringify([settings, parsed.seed, keyInput]) : null;

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
    root.current?.querySelector<HTMLInputElement>('[data-choice="theme"] input:checked')?.focus({ preventScroll: true });
  }, []);

  useEffect(() => saveChoices(props.roomId, choices, undefined, start.kept), [props.roomId, choices, start.kept]);

  // The hold lasts until the create is answered, or CHECK_MS at most, so a create whose answer never comes never traps the DM.
  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => setHolding(false), CHECK_MS);
    return () => clearTimeout(timer);
  }, [holding]);

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
      preview(settings, seed, scene, { feetPerCell }, keyInput).then(
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
  }, [key, scene, feetPerCell]);

  const busy = sending !== null;
  /** The choices and Make wait while Make sends, and stay so after a partial or unconfirmed one: a scene exists then, and another Make would be a second dungeon. */
  const locked = busy || (failed !== null && !failed.retry);
  const ready = readiness(flow);
  const current = ready.current?.result ?? null;
  const secretRooms = (counted(flow)?.result.summary.secretRooms ?? 0) > 0;
  /** Lit rooms start the scene dark with party vision on, unless the DM tapped Keep it lit (4.1 row 7). */
  const startsDark = choices.lit > 0 && !keptLit;
  const fogWarning = useRoomView((s) => fogLine(startsDark ? { preset: "explore" } : pickNow(props.intent, s.view, "builder").pick, secretRooms));
  const { problem } = flow;
  const plan = current?.plan ?? null;

  // The key is held only when the live room's journal fits without it and not with it, so another cap the room is
  // already over never blames the journal (D-261107-270). The page is built from the plan, not the preview's ops,
  // because a held key leaves the preview without one.
  useEffect(() => {
    const room = store.getState().view;
    if (!choices.key || !plan || !room || !myColor) {
      setKeyHeld(false);
      return;
    }
    let held = false;
    try {
      held = journalFull(room, keyOps(plan, settings, { name: keyName, color: myColor, feetPerCell }, SCENE_PLACEHOLDER), store.getState().you?.memberId ?? "");
    } catch {
      // The key page is not built or the room cannot be read: nothing to hold.
    }
    setKeyHeld(held);
    // The plan and the journal are what the check reads. `settings` and `sceneName` only reshape the page and come with a new plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices.key, plan, journal, myColor, feetPerCell]);
  // The preview's ops parsed once as it lands, in a task of their own, so the press's parse finds zod's checks built (send.ts warmOpChecks).
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => warmOpChecks(current.ops), 0);
    return () => clearTimeout(timer);
  }, [current]);
  const canMake = !locked && parsed.ok && current !== null && current.summary.rooms >= 2;

  // While a floor's create waits, Hide, Escape, the backdrop and Back do nothing, so no op of this device lands between the floor and its key.
  const close = () => {
    if (holding) return;
    props.onClose(sceneMayExist.current);
  };
  const set = (patch: Partial<Choices>) => setChoices((c) => ({ ...c, ...patch }));
  const setSize = (patch: Partial<Pick<Choices, "size" | "across" | "down">>) => setChoices((c) => withSize(c, patch));

  const make = async () => {
    if (!canMake || !current) return;
    const floor = props.floor;
    // A floor's add asks its refusals on the latest view first, so a change made since the dialog opened stops it with its reason.
    const view = store.getState().view;
    const refused = floor && view ? floorAddRefusal(view, floor) : null;
    if (refused) {
      setFailed({ text: refused, retry: true });
      return;
    }
    const made = withIds(current.ops, actions.newId);
    // Players see as the form says now: Like reads its scene at Make, as the form's own Create does.
    const { pick, gone } = pickNow(props.intent, store.getState().view, "builder");
    if (gone) ui.notify(gone);
    // A floor's light is sent whole, so a floor beside on Time of day never relights it, and its automatic walls are stated (floorSource.ts).
    const ops = made.ops.map((op) => (op.t !== "scene.create" ? op : floor ? floorCreateOf(startScene(op.scene, pick, startsDark), floor, floorName, "own") : { ...op, scene: startScene(op.scene, pick, startsDark) }));
    const { plan } = current;
    // Only this device's camera frames the entrance, through its own room scope, and nothing is stored (4.5).
    frames.frameOnOpen = { sceneId: made.sceneId, rect: grownWithin({ x: plan.entrance.x, y: plan.entrance.y, width: plan.entrance.w, height: plan.entrance.h }, FRAME_MARGIN, { w: plan.w, h: plan.h }) };
    setFailed(null);
    setSending({ answered: 0, total: ops.length });
    sceneMayExist.current = true;
    if (floor) setHolding(true);
    // The send opens the scene once complete, or to compare it when answers were lost, unless a hidden dialog's DM went elsewhere.
    const outcome = await sendDungeon(
      { ops, sceneId: made.sceneId, room: current.room, ids: made.ids },
      actions,
      (answered, total) => {
        if (mounted.current) setSending({ answered, total });
      },
      { store, shown: () => mounted.current },
      floor
        ? {
            keyName: (stored) => floorKeyName(sceneName, stored),
            sentName: floorName,
            onCreated: () => {
              if (mounted.current) setHolding(false);
            },
          }
        : undefined,
    );
    // The floor's words read the name the server stored once it shows, else the one sent.
    const named = store.getState().view?.scenes[made.sceneId]?.floor?.name ?? floorName;
    const words = (opened: boolean) => (floor ? floorOutcomeText(outcome, named, sceneName, opened) : outcomeText(outcome, sceneName, opened));
    if (outcome.k === "complete" && mounted.current) {
      if (outcome.checked) ui.notify(words(true).text, "info");
      props.onMade(made.sceneId);
      return;
    }
    const opened = (store.getState().sceneLoad?.requested ?? store.getState().sceneId) === made.sceneId;
    const said = words(opened);
    if (!mounted.current) {
      ui.notify(said.text, said.tone);
      return;
    }
    if (outcome.k === "none") sceneMayExist.current = false;
    setSending(null);
    setFailed({ text: said.text, retry: outcome.k === "none" });
  };

  // The foot counts the dungeon on screen, busy while the next one draws, and its words change with the picture.
  // Gone meanwhile, they let Cancel and Make share a row, and the shorter foot grew a phone's preview, sized from
  // the body's height, by about 24 px until the picture landed: Reroll jumped under the finger on every seed.
  const counts = counted(flow)?.result.summary;
  const status = failed && !failed.retry ? null : busy ? (
    <Loading delay={0} text={offline ? WAITING : makingLine(sending.answered, sending.total)} />
  ) : counts ? (
    <span aria-live="polite" aria-busy={ready.drawing}>
      {statusLine(counts)}
    </span>
  ) : null;

  // Off until the picture on screen is the dungeon Make would send.
  const looksReady = !ready.drawing && !ready.pictureFailed && current !== null;

  // Reroll stands in the preview's corner, so the preview and the choices each keep one left edge. Its ring can fall on the picture's stone, so it is the board's two-tone ring (Preview.tsx CORNER_SLOT).
  const previewBox = (
    <DungeonPreview
      drawn={drawable(flow)}
      width={layout.width}
      height={layout.height}
      drawing={ready.drawing || looking}
      drawingNow={looking}
      onPictured={(drawn) => step({ k: "pictured", drawn })}
      onPictureFailed={(drawn) => step({ k: "pictureFailed", drawn })}
      leftCorner={<LookCloser drawn={looksReady ? drawable(flow) : null} name={sceneName} disabled={locked} onDrawing={setLooking} onFailed={setLookFailed} />}
    >
      <Button size="sm" {...ON_BOARD} style={ON_BOARD_STYLE} disabled={locked} onClick={() => setSeedText(formatSeed(newSeed()))}>
        Reroll
      </Button>
    </DungeonPreview>
  );

  const fit = current ? fitLine(current.summary) : null;
  // Pinned above the foot with the fog warning, so a DM scrolled down sees why Make is off.
  const errorLine = failed ? <ErrorText>{failed.text}</ErrorText> : null;
  const previewError =
    problem === "fit" ? <ErrorText>{FIT_NONE}</ErrorText> : problem === "bug" ? <ErrorText>{NOT_MADE}</ErrorText> : ready.pictureFailed ? <ErrorText>{PICTURE_FAILED}</ErrorText> : lookFailed ? <ErrorText>{lookFailed}</ErrorText> : null;
  const choicesBox = (
    <div style={{ display: "grid", gap: theme.space(4), minWidth: 0, alignContent: "start" }}>
      {problem === null && !ready.pictureFailed && fit ? <Note>{fit}</Note> : null}
      <ChoiceRows
        value={settings}
        onChange={(next) => set(changed(settings, next))}
        held={locked}
        grid="squares"
        wing={false}
        keyHeld={keyHeld}
        size={
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
        }
        light={<LightLine kept={keptLit} onToggle={() => setKeptLit((k) => !k)} />}
        seed={{ text: seedText, onChange: setSeedText }}
      />
    </div>
  );

  return (
    <Dialog
      title={props.floor ? floorTitle(props.floor.side, besideName) : "Generate a dungeon"}
      onClose={close}
      width="xl"
      phone="fill"
      backClose
      opener={props.opener}
      {...(holding ? { keepOpen: hideRef } : null)}
      status={status}
      statusGrow
      footer={
        <>
          {/* Each grows, so one that wraps under the status fills its line. */}
          <Button ref={hideRef} busy={holding} onClick={close} style={{ flex: "1 1 auto" }}>
            {holding ? MAKING_FLOOR : busy ? "Hide" : failed && !failed.retry ? "Close" : "Cancel"}
          </Button>
          {failed && !failed.retry ? null : (
            <Button variant="primary" busy={busy} disabled={!canMake && !busy} onClick={() => void make()} style={{ flex: "1 1 auto" }}>
              {props.floor ? MAKE_FLOOR : MAKE_SCENE}
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
        <div style={layout.wide ? { position: "absolute", top: 0, left: 0, bottom: 0, width: layout.width } : { position: "sticky", top: 0, zIndex: 1, background: theme.color.surface, paddingBottom: theme.space(2), marginBottom: -theme.space(2) }}>
          {/* One place in the tree at either width, or crossing the breakpoint remounts the preview empty. */}
          <div style={layout.wide ? { position: "sticky", top: 0 } : undefined}>{previewBox}</div>
        </div>
        {choicesBox}
        {/* Above the foot whatever the scroll, so it is read before Make. */}
        {errorLine || previewError || fogWarning ? (
          <div style={{ ...PINNED_FOOT, display: "grid", gap: theme.space(2) }}>
            {errorLine}
            {previewError}
            {fogWarning ? <Note>{fogWarning}</Note> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * The preview's box and whether the card is wide enough for two columns
 * (4.7), from the dialog's body as it lays out. On a wide card the preview
 * is a square (previewSide), never taller than the body. On a narrow
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
    const side = previewSide(box.width, box.height);
    return { wide, width: side, height: side };
  }
  const share = uiScale() > 1 || box.width + box.pad < 360 ? 0.4 : 0.45;
  return { wide, width: Math.max(0, Math.floor(box.width)), height: Math.max(0, Math.floor(Math.min(box.width, box.height * share))) };
}

/**
 * The wide card's preview side. Half the room is its floor, so the two columns
 * split evenly on a narrow card. The choices keep a side panel's width, the
 * width their Segmented rows are designed at, once the room allows it, so a
 * wide card gives the preview the rest. The body's height caps it.
 */
export function previewSide(width: number, height: number): number {
  const room = width - theme.space(4);
  return Math.max(0, Math.floor(Math.min(Math.max(room / 2, room - theme.layout.sidePanelWidth), height)));
}

/**
 * The choices a row change touched, so a field the rows show clamped (Rooms
 * past the size's cap) keeps the DM's own value until they change it, and a
 * later size change still reads it (remembered.ts `withSize`).
 */
export function changed(before: DungeonSettings, after: DungeonSettings): Partial<Choices> {
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(after) as (keyof DungeonSettings)[]) if (k !== "w" && k !== "h" && after[k] !== before[k]) patch[k] = after[k];
  return patch as Partial<Choices>;
}

/** The light line: what the scene starts as with lights in it, and the one tap that flips it. Focus stays on the button as the words swap. */
function LightLine(props: { kept: boolean; onToggle(): void }) {
  const line = lightLine(props.kept);
  return (
    <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <Help>{line.text}</Help>
      <div>
        <Button size="sm" onClick={props.onToggle}>
          {line.action}
        </Button>
      </div>
    </div>
  );
}
