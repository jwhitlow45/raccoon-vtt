import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { parseFormula } from "#shared/dice/formula.ts";
import { LIMITS } from "#shared/limits.ts";
import { ABILITY_KEYS, CONDITION_KEYS, MIN_HEIGHT_FT, type AbilityKey, type BuildChunk, type ConditionKey, type SkillKey, type Trap, type TrapAction, type TrapCheck, type TrapRig, type TrapSound } from "#shared/model.ts";
import { MAX_NAME, TRAP_SOUNDS, type TrapPatch } from "#shared/protocol.ts";
import { DAMAGE_TYPES, damageTypeName, type DamageType } from "#shared/rules/damage.ts";
import { ABILITY_NAMES, choiceText, SKILLS } from "#shared/rules/skills.ts";
import { pitOpen, trapCreature } from "#shared/rules/traps.ts";
import { CONDITIONS } from "#shared/srd/conditions.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { ErrorText, FieldRow, Input, Select, TextArea } from "../../components/Field.tsx";
import { Chip, ChipRow } from "../../components/Chip.tsx";
import { Group, Help, Note } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { PaneHeader } from "../../components/SheetHeader.tsx";
import { Switch } from "../../components/Switch.tsx";
import { useBackClose } from "../../lib/backClose.ts";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { displayName } from "../../lib/scene.ts";
import { useSheetSwipe } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { paneDockFits, useAlertsLane, usePublishPaneLane } from "../../pages/fold.ts";
import { PaneDockRow, usePaneDock } from "../../pages/RoomDock.tsx";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { aimTrapArea } from "../areas/AreaTool.tsx";
import { draftFromTemplate, newDraft } from "../areas/placement.ts";
import { paneEscape, panePlacement, sheetPanAnchor, SHEET_BELOW_PX } from "../builder/labelEdit.ts";
import { labelPaneFrame, PANE_HEIGHT_UNMEASURED } from "../builder/labelPaneFrame.ts";
import { PaneFooter } from "../builder/PaneFooter.tsx";
import { findDoor } from "../doors/doors.ts";
import { playTrapSound } from "../encounter/alerts.ts";
import { requestPan } from "../encounter/pan.ts";
import { ChoiceRows, ConfirmButton, type RowOption } from "../measure/controls.tsx";
import { openAsk } from "../rolls/open.ts";
import { NumberInput } from "../scenes/controls.tsx";
import { trapScreenBox } from "./paneBox.ts";
import {
  afterSummary,
  alsoSummary,
  boxCenter,
  checkText,
  cleanLine,
  cleanNote,
  disarmFill,
  findSummary,
  hitsSummary,
  noteSummary,
  openedLine,
  pitFloor,
  presetLine,
  readSummary,
  saveSummary,
  searchFill,
  tokensOn,
  TRIGGER_ORDER,
  triggerSummary,
  zoneBox,
  zoneGround,
  zoneKind,
} from "./rules.ts";
import { trapSlot } from "./store.ts";

const NO_CHUNKS: Readonly<Record<string, BuildChunk>> = {};

/**
 * A trap's pane (docs/design-v1-traps.md 4.1), for the DM: where it started,
 * then its nine parts folded to one line each, and at its foot Armed and
 * Found, the asks for rolls, Set it off and Delete. It hangs over the map
 * beside the trap where the map is 600 px wide or more, and is a bottom
 * sheet below that, as on a phone held upright, as a pin's pane is.
 *
 * Each change sends `trap.update` with only the fields it changed, so two
 * DM devices editing different fields never undo each other, and an edit
 * never overwrites what the server wrote on the trap (its uses, its found
 * mark, its waiting springings). Text is sent when its field is left.
 */
export default function TrapPane(props: { trap: Trap; hidden: boolean; camera: Camera; viewport: Size; insets: Insets; onClose(): void }) {
  const { trap, camera, hidden } = props;
  const paneRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  // While the map picks something for the trap, Back and Escape belong to that pick, which its Done ends.
  useBackClose(!hidden, () => closeRef.current());
  const chunks = useRoomView((s) => s.view?.buildChunks ?? NO_CHUNKS);

  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const editing = target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const escape = paneEscape({
        key: e.key,
        handled: e.defaultPrevented,
        dialogOpen: document.querySelector('[aria-modal="true"]') !== null,
        editingElsewhere: editing && !paneRef.current?.contains(target),
      });
      if (!escape) return;
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);

  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.scrollHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const box = trapScreenBox(trap, chunks, camera);
  // As a bottom sheet it folds the alerts column, so its header and Close stay in reach, and their summary row docks on its top edge in room kept free under the top bars, and a toast that shows meanwhile starts under its header (pages/RoomDock.tsx usePaneDock).
  // As a card it keeps left of the column's cards, or under the summary row it has the column show where the lane leaves it no room (labelEdit.ts panePlacement).
  const sheet = props.viewport.width < SHEET_BELOW_PX;
  const dock = usePaneDock(sheet && !hidden, paneDockFits({ viewport: props.viewport, insets: props.insets }), paneRef);
  const insets = dock.reserve > 0 ? { ...props.insets, top: props.insets.top + dock.reserve } : props.insets;
  const lane = useAlertsLane(props.viewport);
  const place = panePlacement({ viewport: props.viewport, insets, box, height: height ?? PANE_HEIGHT_UNMEASURED, lane });
  // Hidden while the map picks for it, it stands over nothing.
  usePublishPaneLane(place.kind === "card" && !hidden ? (place.lane ?? null) : null, () => closeRef.current());

  // A bottom sheet brings its trap into view above it, once per trap.
  const scope = useRoomScope();
  const pannedFor = useRef<string | null>(null);
  useEffect(() => {
    if (place.kind !== "sheet" || height === null || hidden || pannedFor.current === trap.id) return;
    pannedFor.current = trap.id;
    const anchor = sheetPanAnchor({ viewport: props.viewport, insets, sheetHeight: height, box });
    const world = zoneBox(trap, chunks);
    if (anchor && world) requestPan(scope, { sceneId: trap.sceneId, ...boxCenter(world), anchor });
  });

  // As a bottom sheet it swipes down to close. Each choice is sent as it is made and text when its field is left, so the focus rule alone holds it.
  useSheetSwipe(paneRef, { enabled: sheet && !hidden, onClose: () => closeRef.current(), item: trap.id, clip: "foot", riders: dock.riders });

  return (
    <>
      <div
        ref={paneRef}
        role="dialog"
        aria-label="Edit trap"
        data-map-pane=""
        hidden={hidden}
        style={{ ...labelPaneFrame(place), overflowY: "auto", overscrollBehavior: "contain", color: theme.color.text, ...(hidden ? { display: "none" } : null) }}
      >
        {/* Keyed by trap, so a half-typed field or an armed Delete never carries over to the next trap tapped. */}
        <TrapEditor key={trap.id} trap={trap} sheet={sheet} onClose={props.onClose} />
      </div>
      {dock.summary && place.kind === "sheet" && !hidden ? <PaneDockRow ref={dock.row} pane={paneRef} bottom={place.bottom} summary={dock.summary} onClose={() => closeRef.current()} /> : null}
    </>
  );
}

type RigPatch = NonNullable<TrapPatch["rig"]>;
type Part = "name" | "when" | "after" | "hits" | "save" | "read" | "also" | "find" | "note";

function TrapEditor(props: { trap: Trap; sheet: boolean; onClose(): void }) {
  const { trap } = props;
  const rig = trap.rig;
  const actions = useRoomActions();
  const scope = useRoomScope();
  const room = useRoomStore();
  const chunks = useRoomView((s) => s.view?.buildChunks ?? NO_CHUNKS);
  const selected = useRoomView((s) => s.local.selectedIds);
  const [open, setOpen] = useState<ReadonlySet<Part>>(() => new Set());
  const [askUses, setAskUses] = useState(false);
  const setOffId = useId();
  if (!rig) return null;

  const update = (patch: TrapPatch) => actions.dispatch({ t: "trap.update", trapId: trap.id, patch });
  const setRig = (patch: RigPatch) => update({ rig: patch });
  const pick = (what: "squares" | "hits" | "action", fresh = false) => scope.get(trapSlot).store.setState({ picking: { trapId: trap.id, what, ...(fresh ? { fresh: true } : {}) } });
  const fold = (part: Part) => ({
    open: open.has(part),
    onToggle: () =>
      setOpen((was) => {
        const next = new Set(was);
        if (next.has(part)) next.delete(part);
        else next.add(part);
        return next;
      }),
  });

  const squares = "cells" in trap.zone;
  const ground = "cells" in trap.zone ? zoneGround(chunks, trap.sceneId, trap.zone.cells) : 0;
  // An open pit's squares stand at its floor, so the ground there says nothing of its depth (4.2): it reads Opened, and its depth stays.
  const opened = rig.pit !== undefined && "cells" in trap.zone && pitOpen(chunks, trap.sceneId, trap.zone.cells, rig.pit);
  const pitDepth = rig.pit && !opened ? ground - rig.pit.floor : null;
  const from = presetLine(rig);
  const doorGone = "door" in trap.zone && findDoor(chunks, trap.sceneId, trap.zone.door) === null;

  const arm = (on: boolean) => {
    if (!on) {
      update({ state: "disarmed" });
      return;
    }
    if (rig.usesLeft === 0) setAskUses(true);
    else update({ state: "armed" });
  };

  // Set it off (4.2): the selected creatures on its scene, else those on it now. Read at the tap, so the pane never redraws as tokens move.
  const setOff = () => {
    const view = room.getState().view;
    if (!view) return;
    const chosen = selected.filter((id) => {
      const t = view.tokens[id];
      return t?.sceneId === trap.sceneId && trapCreature(view, t);
    });
    const ids = chosen.length > 0 ? chosen : tokensOn(trap, view);
    actions.dispatch({ t: "trap.spring", trapId: trap.id, tokenIds: ids.slice(0, LIMITS.trapSpringTokens) });
  };

  const ask = (fill: ReturnType<typeof searchFill>) => {
    if (!fill) return;
    openAsk(scope, selected.length > 0 ? { kind: "selection", tokenIds: selected, fill } : { kind: "party", fill });
  };
  const search = searchFill(rig);
  const disarm = disarmFill(rig);

  return (
    // One column that never grows past the card, whatever a line inside asks for (LabelPane.tsx, PinPane.tsx).
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
      <PaneHeader title={trap.name} onClose={props.onClose} grab={props.sheet} />
      {from ? <Help>{from}</Help> : null}
      {doorGone ? <Note>Its door is gone, so it cannot go off. Delete it, or put a door back.</Note> : null}

      {/* The groups stack as the token panel's do, their lines doing the parting (docs/design-v1-look-pass-2.md 2.6). */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }}>
        {/* No summary: the pane's title already shows the name. */}
        <Group label="Name" holds="rows" {...fold("name")}>
          <TextField label="Name" value={trap.name} max={MAX_NAME} required="A trap needs a name." onSave={(name) => name && update({ name })} />
          <Help>Players see this name once the trap is found.</Help>
        </Group>

        <Group label="Goes off when" summary={triggerSummary({ zone: trap.zone, rig })} holds="rows" {...fold("when")}>
          {squares ? (
            <div role="group" aria-label="Goes off when" style={{ display: "grid", gap: theme.space(1) }}>
              {TRIGGER_ORDER.map((t) => {
                const on = rig.on.includes(t);
                const last = on && rig.on.length === 1;
                return (
                  <Checkbox
                    key={t}
                    label={TRIGGER_LABELS[t]}
                    checked={on}
                    // The last way it goes off keeps its tick and its place in the focus order, with the reason (docs/design-v1-look-pass-2.md 2.7).
                    aria-disabled={last}
                    help={last ? "A trap on squares goes off at least one way." : undefined}
                    onChange={(next) => setRig({ on: TRIGGER_ORDER.filter((o) => (o === t ? next : rig.on.includes(o))) })}
                  />
                );
              })}
            </div>
          ) : (
            <Help>{zoneKind(trap.zone) === "wire" ? "A creature crosses it." : "A creature opens it."}</Help>
          )}
          {squares ? (
            <div>
              <Button size="sm" icon="plus" onClick={() => pick("squares")}>
                Add squares
              </Button>
            </div>
          ) : null}
          <Segmented<TrapRig["who"]>
            label="Who"
            value={rig.who}
            even
            options={(["party", "others", "any"] as const).map((w) => ({ value: w, label: WHO_CHOICES[w] }))}
            description={WHO_HELP[rig.who]}
            onChange={(who) => setRig({ who })}
          />
          <Switch label="Small or larger only" checked={rig.minSize === "small"} onChange={(on) => setRig({ minSize: on ? "small" : null })} />
          <Switch label="Only creatures on the floor" help="Leaves out fliers, burrowers and riders." checked={rig.floor} onChange={(floor) => setRig({ floor })} />
        </Group>

        <Group label="Afterwards" summary={afterSummary(rig, pitDepth, opened)} holds="rows" {...fold("after")}>
          {/* Off is the plain case, a trap that goes off once (docs/design-v1-look-pass-2.md 2.7). */}
          <Switch label="Arms again at the start of the next turn" checked={rig.resets === "nextTurn"} onChange={(on) => setRig({ resets: on ? "nextTurn" : "never" })} />
          <UsesField value={rig.usesLeft ?? null} onChange={(usesLeft) => setRig({ usesLeft })} />
          <Switch label="Stops the creature where it goes off" help="A silent trap should not stop the creature: its player would notice." checked={rig.stops} onChange={(stops) => setRig({ stops })} />
          <Switch label="Marks itself found when players see it go off" checked={rig.foundOnSpring} onChange={(foundOnSpring) => setRig({ foundOnSpring })} />
          {squares ? (
            // An opened pit cannot be undone, so its switch stays disabled with the line that says where its floor is.
            <Switch label="Opens a pit" help={opened && rig.pit ? openedLine(rig.pit) : undefined} checked={rig.pit !== undefined} disabled={opened} onChange={(on) => setRig({ pit: on ? { floor: pitFloor(ground, 10) } : null })} />
          ) : null}
          {squares && pitDepth !== null ? (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
              <NumberInput label="Pit depth, feet" value={pitDepth} min={1} max={ground - MIN_HEIGHT_FT} onChange={(depth) => setRig({ pit: { floor: pitFloor(ground, depth) } })} />
              <span style={{ color: theme.color.textMuted }}>ft deep</span>
            </div>
          ) : null}
        </Group>

        <Group label="Hits" summary={hitsSummary(rig)} holds="rows" {...fold("hits")}>
          <HitsChoice trap={trap} rig={rig} chunks={chunks} setRig={setRig} pick={pick} />
        </Group>

        <Group label="Save and damage" summary={saveSummary(rig)} holds="rows" {...fold("save")}>
          <SaveFields rig={rig} setRig={setRig} />
        </Group>

        <Group label="Players read" summary={readSummary(rig)} holds="rows" {...fold("read")}>
          <TextField label="What players read" placeholder="The floor gives way!" value={rig.message ?? ""} max={LIMITS.trapMessageChars} onSave={(message) => setRig({ message })} />
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
            <Select aria-label="Sound" value={rig.sound ?? ""} onChange={(e) => setRig({ sound: e.target.value === "" ? null : (e.target.value as TrapSound) })}>
              <option value="">No sound</option>
              {TRAP_SOUNDS.map((s) => (
                <option key={s} value={s}>
                  {SOUND_NAMES[s]}
                </option>
              ))}
            </Select>
            {rig.sound ? (
              <Button size="sm" onClick={() => playTrapSound(rig.sound!, true)}>
                Play
              </Button>
            ) : null}
          </div>
          <Help>Players read the line, and hear the sound where their sound is on, when they see it go off.</Help>
        </Group>

        <Group label="It also" summary={alsoSummary(rig)} holds="rows" {...fold("also")}>
          <ActionList trap={trap} rig={rig} setRig={setRig} />
          {/* The tool's options say what to tap once the pick starts (TrapTool.tsx PICK_LINES). */}
          <div>
            <Button size="sm" icon="plus" disabled={rig.actions.length >= LIMITS.trapActions} onClick={() => pick("action")}>
              Add an effect
            </Button>
          </div>
        </Group>

        <Group label="Finding and disarming" summary={findSummary(rig)} holds="rows" {...fold("find")}>
          <FindFields rig={rig} setRig={setRig} />
        </Group>

        <Group label="DM note" summary={noteSummary(rig)} holds="rows" {...fold("note")}>
          <NoteField value={rig.note ?? ""} onSave={(note) => setRig({ note })} />
          <Help>Shown on the card when it goes off.</Help>
        </Group>
      </div>

      <div style={{ display: "grid", gap: theme.space(2), borderTop: `${theme.line.border}px solid ${theme.color.border}`, paddingTop: theme.space(2) }}>
        <Switch label="Armed" help={trap.state === "sprung" ? "Sprung. Arm it to set it again." : undefined} checked={trap.state === "armed"} onChange={arm} />
        {askUses ? (
          <UsesPrompt
            onArm={(usesLeft) => {
              setAskUses(false);
              update({ state: "armed", rig: { usesLeft } });
            }}
            onCancel={() => setAskUses(false)}
          />
        ) : null}
        <Switch label="Found" help="Players see a found trap's name and where it lies." checked={trap.found} onChange={(found) => update({ found })} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          {search ? (
            <Button size="sm" onClick={() => ask(search)}>
              Ask to search
            </Button>
          ) : null}
          {disarm ? (
            <Button size="sm" onClick={() => ask(disarm)}>
              Ask to disarm
            </Button>
          ) : null}
          <Button size="sm" aria-describedby={setOffId} onClick={setOff}>
            Set it off
          </Button>
        </div>
        <Help id={setOffId}>With Set it off, {selected.length > 0 ? "the selected creatures" : "the creatures on it now"} set it off.</Help>
      </div>
      <PaneFooter>
        <ConfirmButton
          icon="delete"
          iconOnly
          label="Delete"
          confirm="Tap again to delete"
          title="Delete this trap"
          onConfirm={() => {
            actions.dispatch({ t: "trap.delete", trapId: trap.id });
            props.onClose();
          }}
        />
        <Button size="sm" variant="primary" onClick={props.onClose}>
          Done
        </Button>
      </PaneFooter>
    </div>
  );
}

/** Who's options in a word each, so the three share a row at any width. The summaries keep rules.ts WHO_WORDS, as they are sentences. */
const WHO_CHOICES: Record<TrapRig["who"], string> = { party: "Party", others: "Others", any: "Any" };

/** What the chosen Who means, the choice's description. */
const WHO_HELP: Record<TrapRig["who"], string> = {
  party: "Only creatures a player owns set it off.",
  others: "Only creatures no player owns set it off.",
  any: "Any creature sets it off.",
};

const TRIGGER_LABELS: Record<TrapRig["on"][number], string> = {
  enter: "A creature steps onto it",
  turnStart: "A creature starts its turn on it",
  turnEnd: "A creature ends its turn on it",
  leave: "A creature steps off it",
};

const SOUND_NAMES: Record<TrapSound, string> = { click: "Click", rumble: "Rumble", crash: "Crash", whoosh: "Whoosh", hiss: "Hiss" };

/**
 * A line of text sent when its field is left or Enter is pressed, never
 * letter by letter. Empty sends null, unless the line is `required`: then
 * the field goes back to the saved text and says why, in those words, as
 * the label pane does, so an empty field never stands for a name the trap
 * still has.
 */
function TextField(props: { label: string; value: string; max: number; placeholder?: string; required?: string; onSave(value: string | null): void }) {
  const [text, setText] = useState(props.value);
  const [refused, setRefused] = useState(false);
  const noteId = useId();
  useEffect(() => setText(props.value), [props.value]);
  const save = () => {
    const clean = cleanLine(text, props.max);
    if (clean === null && props.required) {
      setText(props.value);
      setRefused(true);
      return;
    }
    setRefused(false);
    if ((clean ?? "") !== props.value) props.onSave(clean);
    else setText(props.value);
  };
  return (
    <>
      <Input
        type="text"
        aria-label={props.label}
        aria-describedby={refused ? noteId : undefined}
        placeholder={props.placeholder}
        maxLength={props.max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
        style={{ width: "100%" }}
      />
      {refused ? <Note id={noteId}>{props.required}</Note> : null}
    </>
  );
}

function NoteField(props: { value: string; onSave(value: string | null): void }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <TextArea
      aria-label="DM note"
      maxLength={LIMITS.trapNoteChars}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const clean = cleanNote(text);
        if ((clean ?? "") !== props.value) props.onSave(clean);
      }}
      style={{ width: "100%" }}
    />
  );
}

/** Its uses left, the word the summary and the prompt use: empty is no limit. Each springing spends one, so it reads what is left. */
function UsesField(props: { value: number | null; onChange(value: number | null): void }) {
  const id = useId();
  const shown = props.value === null ? "" : String(props.value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const raw = text.trim();
    if (raw === "") {
      if (props.value !== null) props.onChange(null);
      return;
    }
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return setText(shown);
    const clamped = Math.max(1, Math.min(99, n));
    setText(String(clamped));
    if (clamped !== props.value) props.onChange(clamped);
  };
  return (
    <FieldRow label="Uses left" htmlFor={id} hint="Each time it goes off spends one. Empty for no limit.">
      <Input
        id={id}
        inputMode="numeric"
        placeholder="No limit"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        style={{ width: theme.layout.options.field, textAlign: "center" }}
      />
    </FieldRow>
  );
}

/** Arming a trap with no uses left asks for its uses first (4.1), so it never arms only to stay spent. */
function UsesPrompt(props: { onArm(uses: number | null): void; onCancel(): void }) {
  const [uses, setUses] = useState(1);
  return (
    // A line and its buttons under Armed, with no box of its own: Done stays the pane's one primary (docs/design-v1-look-pass-2.md 2.2).
    <div role="group" aria-label="Give it uses" style={{ display: "grid", gap: theme.space(2) }}>
      <Help>It has no uses left. How many more times can it go off?</Help>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
        <NumberInput label="Uses" value={uses} min={1} max={99} onChange={setUses} />
        <Button size="sm" onClick={() => props.onArm(uses)}>
          Arm
        </Button>
        <Button size="sm" onClick={() => props.onArm(null)}>
          No limit
        </Button>
        <Button size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

type HitsKind = "trigger" | "zone" | "cells" | "area";

function hitsKind(hits: TrapRig["hits"]): HitsKind {
  return typeof hits === "string" ? hits : "cells" in hits ? "cells" : "area";
}

/**
 * Who it hits (4.1): the creature that set it off, everyone on the trap
 * (squares only), everyone in squares drawn on the map, or everyone in an
 * area aimed with the area tool. A choice of longer names, so rows with a
 * check (docs/design-v1-look-pass-2.md 2.7). An arrow key both moves and
 * chooses in a radio group, so choosing writes only what needs no map:
 * drawn squares start as the trap's own, and an area is written once
 * "Place the area" saves one, the choice held here until then. The map's
 * pick and the area tool start from the buttons that follow the choice.
 */
function HitsChoice(props: { trap: Trap; rig: TrapRig; chunks: Readonly<Record<string, BuildChunk>>; setRig(patch: RigPatch): void; pick(what: "hits", fresh?: boolean): void }) {
  const { trap, rig, chunks } = props;
  const scope = useRoomScope();
  const ui = useRoomUi();
  const view = useRoomView((s) => s.view);
  const kind = hitsKind(rig.hits);
  // A choice that wrote nothing yet: an area before it is placed, or squares for a trap with no place of its own.
  const [held, setHeld] = useState<HitsKind | null>(null);
  useEffect(() => setHeld(null), [kind]);
  const shown = held ?? kind;
  const squares = "cells" in trap.zone;
  const box = zoneBox(trap, chunks);
  const center = box ? boxCenter(box) : { x: 0, y: 0 };
  const choose = (next: HitsKind) => {
    if (next === kind) return setHeld(null);
    if (next === "trigger" || next === "zone") return props.setRig({ hits: next });
    if (next === "cells") {
      const own = "cells" in trap.zone ? trap.zone.cells : box ? [{ x: Math.floor(box.x0), y: Math.floor(box.y0), w: Math.max(1, Math.min(LIMITS.trapRectSide, Math.ceil(box.x1) - Math.floor(box.x0))), h: Math.max(1, Math.min(LIMITS.trapRectSide, Math.ceil(box.y1) - Math.floor(box.y0))) }] : [];
      if (own.length > 0) return props.setRig({ hits: { cells: own.map((r) => ({ ...r })) } });
    }
    setHeld(next);
  };
  // The area tool aims it, starting from the trap's area or a 15 ft cone at the trap's middle.
  const aim = () => {
    if (!view) return;
    const fpc = view.meta.settings.feetPerCell;
    const id = `trap-area-${trap.id}`;
    const area = typeof rig.hits === "object" && "area" in rig.hits ? rig.hits.area : null;
    const draft = area
      ? draftFromTemplate({ ...area, id, rev: 0, sceneId: trap.sceneId, color: theme.color.danger, visibility: "dm", ownerId: "" }, id, view.tokens, fpc)
      : { ...newDraft(id, "cone", theme.color.danger), point: { x: center.x, y: center.y, z: zoneGroundAt(chunks, trap.sceneId, center) } };
    aimTrapArea(scope, ui, trap.id, draft);
  };
  const options: RowOption<HitsKind>[] = [
    { value: "trigger", label: "The creature that set it off" },
    ...(squares ? [{ value: "zone" as const, label: "Everyone on the trap" }] : []),
    { value: "cells", label: "Everyone in these squares" },
    { value: "area", label: "Everyone in an area" },
  ];
  return (
    <>
      {/* Its names wrap, so a narrow pane never scrolls sideways for them (docs/design-v1-look-pass-2.md D2). */}
      <ChoiceRows<HitsKind> label="Hits" value={shown} options={options} onChange={choose} wrap />
      {shown === "cells" ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          <Button size="sm" onClick={() => props.pick("hits", true)}>
            Draw them again
          </Button>
          {/* Named apart from Goes off when's Add squares, which grows the trap itself. */}
          <Button size="sm" icon="plus" aria-label="Add squares it hits" onClick={() => props.pick("hits")}>
            Add squares
          </Button>
        </div>
      ) : null}
      {shown === "area" ? (
        <Button size="sm" onClick={aim}>
          Place the area
        </Button>
      ) : null}
    </>
  );
}

/** The ground at a point, for a new area's height. */
function zoneGroundAt(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, p: { x: number; y: number }): number {
  return zoneGround(chunks, sceneId, [{ x: Math.floor(p.x), y: Math.floor(p.y), w: 1, h: 1 }]);
}

const LASTS_OPTIONS = [
  { value: "", label: "Until removed" },
  { value: "turnStart", label: "Until the start of its next turn" },
  { value: "turnEnd", label: "Until the end of its next turn" },
  { value: "rounds", label: "For a number of rounds" },
] as const;

/** The group save's fields (4.4): a save or none, its DC, half or none on a pass, damage, conditions on a fail and how long they last. */
function SaveFields(props: { rig: TrapRig; setRig(patch: RigPatch): void }) {
  const { rig, setRig } = props;
  const damage = rig.damage ?? [];
  const conditions = rig.conditions ?? [];
  const setDamage = (next: { formula: string; type: DamageType }[]) => setRig({ damage: next.length > 0 ? next : null });
  /*
   * Each damage part keeps its own key as parts come and go, so a part's
   * typed dice and their error never pass to the part after a removed one.
   * Two parts may share their dice, so the dice cannot key them. A change
   * from elsewhere that adds or drops parts keys the end of the list anew.
   */
  const partKeys = useRef<number[]>([]);
  const nextPartKey = useRef(0);
  while (partKeys.current.length < damage.length) partKeys.current.push(nextPartKey.current++);
  if (partKeys.current.length > damage.length) partKeys.current = partKeys.current.slice(0, damage.length);
  const setConditions = (next: ConditionKey[]) => setRig(next.length > 0 ? { conditions: next } : { conditions: null, lasts: null });
  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
        <Select
          aria-label="Save"
          value={rig.save?.ability ?? ""}
          onChange={(e) => {
            const ability = e.target.value as AbilityKey | "";
            setRig({ save: ability === "" ? null : { ability, dc: rig.save?.dc ?? 13, onPass: rig.save?.onPass ?? "half" } });
          }}
        >
          <option value="">No save</option>
          {ABILITY_KEYS.map((a) => (
            <option key={a} value={a}>
              {ABILITY_NAMES[a]} save
            </option>
          ))}
        </Select>
      </div>
      {/* The group save's own rows, which these fields fill (features/dice/groupSave/GroupSave.tsx). */}
      {rig.save ? (
        <FieldRow label="DC">
          <NumberInput label="Save DC" value={rig.save.dc} min={LIMITS.rollDcMin} max={LIMITS.rollDcMax} onChange={(dc) => setRig({ save: { ...rig.save!, dc } })} />
        </FieldRow>
      ) : null}
      {rig.save && damage.length > 0 ? (
        <FieldRow label="On a pass">
          <Segmented<"half" | "none">
            label="On a pass"
            value={rig.save.onPass}
            options={[
              { value: "half", label: "Half" },
              { value: "none", label: "None" },
            ]}
            onChange={(onPass) => setRig({ save: { ...rig.save!, onPass } })}
          />
        </FieldRow>
      ) : null}
      {damage.map((part, i) => (
        <DamagePart
          key={partKeys.current[i]}
          part={part}
          onFormula={(formula) => setDamage(damage.map((p, j) => (j === i ? { ...p, formula } : p)))}
          onType={(type) => setDamage(damage.map((p, j) => (j === i ? { ...p, type } : p)))}
          onRemove={() => {
            partKeys.current.splice(i, 1);
            setDamage(damage.filter((_, j) => j !== i));
          }}
        />
      ))}
      {damage.length < LIMITS.trapDamageParts ? (
        <Button size="sm" icon="plus" onClick={() => setDamage([...damage, { formula: "1d6", type: "bludgeoning" }])}>
          Add damage
        </Button>
      ) : null}
      {conditions.length > 0 ? (
        // Removable choices, as the group save's conditions (docs/design-v1-look-pass-2.md 2.4).
        <ChipRow label="On a fail">
          {conditions.map((c) => (
            <Chip key={c} remove aria-label={`Remove ${CONDITIONS[c].name}`} onClick={() => setConditions(conditions.filter((o) => o !== c))}>
              {CONDITIONS[c].name}
            </Chip>
          ))}
        </ChipRow>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
        {conditions.length < LIMITS.trapConditions ? (
          <Select aria-label="Add a condition on a fail" value="" onChange={(e) => e.target.value && setConditions([...conditions, e.target.value as ConditionKey])}>
            <option value="">{conditions.length === 0 ? "A condition on a fail…" : "Another condition…"}</option>
            {CONDITION_KEYS.filter((c) => !conditions.includes(c)).map((c) => (
              <option key={c} value={c}>
                {CONDITIONS[c].name}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      {conditions.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
          <Select
            aria-label="How long the conditions last"
            value={rig.lasts?.mode ?? ""}
            onChange={(e) => {
              const mode = e.target.value as "" | "turnStart" | "turnEnd" | "rounds";
              setRig({ lasts: mode === "" ? null : mode === "rounds" ? { mode, rounds: rig.lasts?.rounds ?? 1 } : { mode } });
            }}
          >
            {LASTS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {rig.lasts?.mode === "rounds" ? (
            <>
              <NumberInput label="Rounds" value={rig.lasts.rounds ?? 1} min={1} max={1000} onChange={(rounds) => setRig({ lasts: { mode: "rounds", rounds } })} />
              <span style={{ color: theme.color.textMuted }}>rounds</span>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * One part of the damage: its dice, sent when they read as a formula, its
 * type and its remove. Dice that do not read keep the last good ones, and
 * say why in a line under the row, as every field's error does
 * (docs/design-v1-look-pass-2.md 2.9), not only in an outline and a title.
 */
function DamagePart(props: { part: { formula: string; type: DamageType }; onFormula(formula: string): void; onType(type: DamageType): void; onRemove(): void }) {
  const [text, setText] = useState(props.part.formula);
  const [bad, setBad] = useState(false);
  const errorId = useId();
  // Dice saved from here or elsewhere replace what was typed, and any error with it.
  useEffect(() => {
    setText(props.part.formula);
    setBad(false);
  }, [props.part.formula]);
  const save = () => {
    const clean = cleanLine(text, LIMITS.diceFormulaChars);
    if (!clean || !parseFormula(clean).ok) {
      setBad(true);
      return;
    }
    setBad(false);
    if (clean !== props.part.formula) props.onFormula(clean);
  };
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
        <Input
          type="text"
          aria-label="Damage dice"
          aria-invalid={bad || undefined}
          aria-describedby={bad ? errorId : undefined}
          error={bad}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          style={{ width: theme.layout.options.field }}
        />
        <Select aria-label="Damage type" value={props.part.type} onChange={(e) => props.onType(e.target.value as DamageType)}>
          {DAMAGE_TYPES.map((t) => (
            <option key={t} value={t}>
              {damageTypeName(t)}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="danger" icon="delete" iconOnly="always" aria-label="Remove this damage" onClick={props.onRemove} />
      </div>
      {bad ? (
        <div id={errorId}>
          <ErrorText>Not a dice formula, such as 2d10 or 1d6+2.</ErrorText>
        </div>
      ) : null}
    </div>
  );
}

/** "It also" (4.1): each thing it does when it goes off, in order, with its choice and a way to take it out. */
function ActionList(props: { trap: Trap; rig: TrapRig; setRig(patch: RigPatch): void }) {
  const { trap, rig, setRig } = props;
  const view = useRoomView((s) => s.view);
  if (rig.actions.length === 0) return <Help>Nothing else. Add a door to slam, a light to put out, or a hidden creature or stamp to show.</Help>;
  const put = (i: number, next: TrapAction | null) => setRig({ actions: next === null ? rig.actions.filter((_, j) => j !== i) : rig.actions.map((a, j) => (j === i ? next : a)) });
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      {rig.actions.map((a, i) => {
        let what: ReactNode;
        let choice: ReactNode = null;
        if ("door" in a) {
          const gone = view ? findDoor(view.buildChunks, trap.sceneId, a.door) === null : false;
          what = gone ? "A door that is gone" : "A door";
          choice = (
            <Segmented<"closed" | "open" | "locked">
              label="Set the door"
              value={a.state}
              options={[
                { value: "closed", label: "Close" },
                { value: "open", label: "Open" },
                { value: "locked", label: "Lock" },
              ]}
              onChange={(state) => put(i, { door: a.door, state })}
            />
          );
        } else if ("light" in a) {
          const light = view?.lights[a.light];
          what = light ? (light.label ?? "A light") : "A light that is gone";
          choice = (
            <Segmented<"off" | "on">
              label="Set the light"
              value={a.on ? "on" : "off"}
              options={[
                { value: "off", label: "Put out" },
                { value: "on", label: "Light" },
              ]}
              onChange={(v) => put(i, { light: a.light, on: v === "on" })}
            />
          );
        } else if ("tokenId" in a.show) {
          const token = view?.tokens[a.show.tokenId];
          what = token ? `Show ${displayName(token)}` : "Show a creature that is gone";
        } else {
          what = view?.stamps[a.show.stampId] ? "Show a hidden stamp" : "Show a stamp that is gone";
        }
        return (
          <div key={i} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
            <span style={{ flex: "1 1 120px" }}>{what}</span>
            {choice}
            <Button size="sm" variant="danger" icon="delete" iconOnly="always" aria-label="Remove this effect" onClick={() => put(i, null)} />
          </div>
        );
      })}
    </div>
  );
}

/** Every check a trap can ask for, ability alone then each of its skills: "wis" and "wis:perception". */
const CHECK_CHOICES: { value: string; label: string }[] = ABILITY_KEYS.flatMap((ability) => [
  { value: ability, label: ABILITY_NAMES[ability] },
  ...(Object.keys(SKILLS) as SkillKey[]).filter((k) => SKILLS[k].ability === ability).map((skill) => ({ value: `${ability}:${skill}`, label: choiceText({ ability, skill }) })),
]);

function checkValue(c: Pick<TrapCheck, "ability" | "skill">): string {
  return c.skill ? `${c.ability}:${c.skill}` : c.ability;
}

function checkOf(value: string, rest: Pick<TrapCheck, "dc" | "what">): TrapCheck {
  const [ability, skill] = value.split(":") as [AbilityKey, SkillKey | undefined];
  return { ability, ...(skill ? { skill } : {}), dc: rest.dc, ...(rest.what ? { what: rest.what } : {}) };
}

/** One check: which, its DC, and what it finds. */
function CheckRow(props: { check: TrapCheck; what: boolean; onChange(check: TrapCheck): void; onRemove(): void }) {
  const { check } = props;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
      <Select aria-label="Check" value={checkValue(check)} onChange={(e) => props.onChange(checkOf(e.target.value, check))}>
        {CHECK_CHOICES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </Select>
      <span style={{ color: theme.color.textMuted }}>DC</span>
      <NumberInput label="Check DC" value={check.dc} min={LIMITS.rollDcMin} max={LIMITS.rollDcMax} onChange={(dc) => props.onChange({ ...check, dc })} />
      {props.what ? (
        <div style={{ flex: "1 1 140px" }}>
          <TextField label="What it finds" placeholder="the pressure plate" value={check.what ?? ""} max={LIMITS.trapCheckChars} onSave={(what) => props.onChange(checkOf(checkValue(check), { dc: check.dc, ...(what ? { what } : {}) }))} />
        </div>
      ) : null}
      <Button size="sm" variant="danger" icon="delete" iconOnly="always" aria-label="Remove this check" onClick={props.onRemove} />
    </div>
  );
}

/** Finding and disarming (4.1): up to two checks to find it, the Passive Perception hint, and how it is disarmed. */
function FindFields(props: { rig: TrapRig; setRig(patch: RigPatch): void }) {
  const { rig, setRig } = props;
  const perception = rig.find.some((c) => c.skill === "perception");
  const setFind = (find: TrapCheck[]) => setRig(find.some((c) => c.skill === "perception") ? { find } : { find, notice: false });
  const disarm = rig.disarm;
  const setDisarm = (next: { text?: string; check?: TrapCheck } | null) => setRig({ disarm: next && (next.text || next.check) ? next : null });
  return (
    <>
      {rig.find.map((c, i) => (
        <CheckRow key={i} check={c} what onChange={(next) => setFind(rig.find.map((o, j) => (j === i ? next : o)))} onRemove={() => setFind(rig.find.filter((_, j) => j !== i))} />
      ))}
      {rig.find.length < LIMITS.trapFindChecks ? (
        <Button size="sm" icon="plus" onClick={() => setFind([...rig.find, { ability: "wis", skill: "perception", dc: 15 }])}>
          Add a check to find it
        </Button>
      ) : null}
      <Switch
        label="Hint when a creature's Passive Perception would notice it"
        help={perception ? undefined : "Needs a Wisdom (Perception) check."}
        checked={rig.notice && perception}
        disabled={!perception}
        onChange={(notice) => setRig({ notice })}
      />
      <TextField label="How it is disarmed" placeholder="Wedging an iron spike under the plate" value={disarm?.text ?? ""} max={LIMITS.trapDisarmChars} onSave={(text) => setDisarm({ ...(text ? { text } : {}), ...(disarm?.check ? { check: disarm.check } : {}) })} />
      <Switch
        label="With a check"
        checked={disarm?.check !== undefined}
        onChange={(on) => setDisarm({ ...(disarm?.text ? { text: disarm.text } : {}), ...(on ? { check: { ability: "dex", skill: "sleight-of-hand", dc: 15 } } : {}) })}
      />
      {disarm?.check ? <CheckRow check={disarm.check} what={false} onChange={(check) => setDisarm({ ...(disarm.text ? { text: disarm.text } : {}), check })} onRemove={() => setDisarm(disarm.text ? { text: disarm.text } : null)} /> : null}
      {rig.find.length > 0 || disarm?.check ? <Help>{[...rig.find.map(checkText), ...(disarm?.check ? [`Disarm: ${checkText(disarm.check)}`] : [])].join(". ")}.</Help> : null}
    </>
  );
}
