import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { Character } from "#shared/model.ts";
import { CLASS_IDS, CLASS_NAMES, type ClassId, type CountAbility, type LevelUp, type ResourceInput } from "#shared/rules/classResources.ts";
import { ABILITY_NAMES } from "#shared/rules/skills.ts";
import { LIMITS } from "#shared/limits.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { FieldRow, Input, NUMBER_FIELD_WIDTH, Select } from "../../components/Field.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { UnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomUi } from "../../state/view.ts";
import { SheetDialog } from "../tokens/SheetDialog.tsx";
import { ConfirmButton } from "../tokens/ui.tsx";
import {
  addOutcome,
  blockModifiers,
  editDraft,
  editOutcome,
  EMPTY_OWN,
  firstLevel,
  ownOutcome,
  pickClass,
  pickHelp,
  pickLevel,
  pickRows,
  removeOutcome,
  RESET_OPTIONS,
  startPick,
  startUpdate,
  tick,
  updateOutcome,
  updateTitle,
  type Outcome,
  type OwnDraft,
  type PickDraft,
  type Reset,
} from "./logic.ts";

/** What the sheet does: add one or more, update a class after a level rose, or edit one. */
export type SheetMode = { kind: "add" } | { kind: "update"; up: LevelUp } | { kind: "edit"; id: string };

type Tab = "class" | "own";

const LEVELS = Array.from({ length: 20 }, (_, i) => i + 1);

const TABS: { value: Tab; label: string }[] = [
  { value: "class", label: "From a class" },
  { value: "own", label: "Your own" },
];

/** A modifier as typed: a whole number, a plus sign allowed, within what a score of 1 to 30 gives. */
function modifierOf(text: string | undefined): number | null {
  const t = (text ?? "").trim().replace(/^\+/, "").replace(/[\u2212\u2013]/g, "-");
  if (!/^-?\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= -5 && n <= 10 ? n : null;
}

/**
 * The sheet that adds, updates and edits a character's class resources
 * (docs/design-v1-combat-controls.md 7.1). Add picks one of the twelve
 * SRD classes and its level, and ticks that class's resources there, their
 * counts from Appendix A, or makes one of the player's own. Update reads a
 * class's resources again at a new class level. Edit changes one, or
 * removes it with a second tap.
 *
 * Every change is one character.update holding the whole list, so the
 * sheet waits for the server's answer: its main button is busy, a refusal
 * stays in its status line beside what was set, and taken closes it.
 */
export function ResourceSheet(props: { character: Character; mode: SheetMode; opener: RefObject<HTMLElement | null>; onClose(): void }) {
  const { character, mode } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const resources = character.resources;
  const editing = mode.kind === "edit" ? resources?.find((r) => r.id === mode.id) : undefined;
  const [tab, setTab] = useState<Tab>("class");
  const [pick, setPick] = useState<PickDraft>(() => (mode.kind === "update" ? startUpdate(resources, mode.up) : startPick(resources, character.level)));
  const [modText, setModText] = useState<Partial<Record<CountAbility, string>>>({});
  const [own, setOwn] = useState<OwnDraft>(() => (editing ? editDraft(editing) : EMPTY_OWN));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened] = useState(() => JSON.stringify({ pick, own }));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const formId = useId();
  const block = blockModifiers(character.stats);
  const draft: PickDraft = { ...pick, modifiers: { wis: modifierOf(modText.wis), cha: modifierOf(modText.cha) } };
  const unsaved = !sending && (JSON.stringify({ pick, own }) !== opened || Object.values(modText).some((t) => t?.trim()));
  const pickMode = mode.kind === "update" ? "update" : "add";
  const rows = pickRows(draft, resources, block);

  const send = (list: ResourceInput[]) => {
    if (sending) return;
    const n = actions.dispatch(
      { t: "character.update", characterId: character.id, patch: { resources: list } },
      {
        quiet: true,
        onAnswer: (answer, refusal) => {
          if (!mounted.current) {
            if (answer === "refused") ui.notify(refusal?.text ?? "Not saved.", "error");
            return;
          }
          if (answer === "refused") {
            setSending(false);
            setError(refusal?.text ?? "Not saved.");
          } else props.onClose();
        },
      },
    );
    if (n === null) setError("That could not be sent. Check it and try again.");
    else {
      setSending(true);
      setError(null);
    }
  };

  const sendOutcome = (outcome: Outcome) => {
    if (outcome.ok) send(outcome.resources);
    else setError(outcome.error);
  };

  const submit = () => {
    const ctx = { resources, block, characterLevel: character.level, newId: () => actions.newId() };
    const outcome =
      mode.kind === "edit"
        ? editOutcome(own, { resources, id: mode.id })
        : mode.kind === "update"
          ? updateOutcome(draft, { ...ctx, characterLevel: character.level ?? mode.up.guess })
          : tab === "own"
            ? ownOutcome(own, ctx)
            : addOutcome(draft, ctx);
    sendOutcome(outcome);
  };

  const fresh = rows.filter((r) => r.ticked && !r.have).length;
  const mainLabel =
    mode.kind === "edit" ? "Save" : mode.kind === "update" ? "Update" : tab === "own" || fresh === 0 ? "Add" : fresh === 1 ? "Add 1 resource" : `Add ${fresh} resources`;
  const title = mode.kind === "edit" ? `Edit ${editing?.name ?? "a class resource"}` : mode.kind === "update" ? updateTitle(mode.up.classId) : "Add a class resource";
  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setError(null);
  };

  return (
    <SheetDialog
      title={title}
      onClose={props.onClose}
      opener={props.opener}
      width={theme.layout.dialog.md}
      statusGrow
      status={
        error ? (
          <span role="alert" style={{ color: theme.color.dangerText }}>
            {error}
          </span>
        ) : null
      }
      footer={
        <>
          <Button onClick={props.onClose} style={{ flex: "1 1 auto" }}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} busy={sending} style={{ flex: "1 1 auto" }}>
            {sending ? "Saving…" : mainLabel}
          </Button>
        </>
      }
    >
      <UnsavedInput unsaved={unsaved} />
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          // Enter saves from a text field alone: on a checkbox or a radio a browser would send the form too.
          const target = e.target as HTMLElement;
          if (e.key === "Enter" && target instanceof HTMLInputElement && (target.type === "radio" || target.type === "checkbox")) e.preventDefault();
        }}
      >
        <fieldset disabled={sending} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
          <div style={{ display: "grid", gap: theme.space(4) }}>
            {mode.kind === "add" ? <Segmented<Tab> label="Add from" value={tab} options={TABS} onChange={change(setTab)} grow /> : null}
            {mode.kind === "edit" ? (
              editing ? (
                <OwnFields draft={own} onChange={change(setOwn)} />
              ) : (
                <Help>It was removed meanwhile.</Help>
              )
            ) : mode.kind === "add" && tab === "own" ? (
              <>
                <OwnFields draft={own} onChange={change(setOwn)} />
                <Help>For Superiority Dice, a species trait, a feat or anything else counted.</Help>
              </>
            ) : (
              <ClassFields
                draft={draft}
                mode={pickMode}
                rows={rows}
                characterLevel={character.level}
                modText={modText}
                onModText={change(setModText)}
                onClass={(classId) => change(setPick)(pickClass(pick, classId, resources, character.level))}
                onLevel={(level) => change(setPick)(pickLevel(pick, level, resources))}
                onTick={(id, on) => change(setPick)(tick(pick, id, on))}
                upFrom={mode.kind === "update" ? mode.up.classLevel : undefined}
              />
            )}
            {mode.kind === "edit" && editing ? (
              <Section label="Remove" divider={false}>
                <div>
                  <ConfirmButton confirm="Tap again to remove" wrap onConfirm={() => sendOutcome(removeOutcome(resources, editing.id))}>
                    {`Remove ${editing.name}`}
                  </ConfirmButton>
                </div>
              </Section>
            ) : null}
          </div>
        </fieldset>
      </form>
    </SheetDialog>
  );
}

/**
 * A class, its level and its resources there (7.1). The level starts at
 * the character's, or at 1 with a word on where to set it, and a class
 * with nothing at that level says where its first comes. A count from a
 * modifier asks for it while ticked, unless the stat block gives it.
 */
function ClassFields(props: {
  draft: PickDraft;
  mode: "add" | "update";
  rows: ReturnType<typeof pickRows>;
  characterLevel: number | undefined;
  modText: Partial<Record<CountAbility, string>>;
  onModText(next: Partial<Record<CountAbility, string>>): void;
  onClass(classId: ClassId): void;
  onLevel(level: number): void;
  onTick(id: string, on: boolean): void;
  upFrom?: number;
}) {
  const { draft, rows } = props;
  const classId = draft.classId;
  const asked = new Set(rows.flatMap((r) => (r.ticked && !r.have && r.asks ? [r.asks] : [])));
  const levelHint =
    props.upFrom !== undefined
      ? `It was ${props.upFrom}. Leveled another class? Keep it at ${props.upFrom}.`
      : props.characterLevel === undefined
        ? "Set the character's level in Stats to fill this in."
        : undefined;
  return (
    <>
      {props.mode === "add" ? (
        <FieldRow label="Class" fill>
          <Select aria-label="Class" value={classId ?? ""} onChange={(e) => e.target.value && props.onClass(e.target.value as ClassId)} style={{ flex: 1, minWidth: 0, maxWidth: "100%" }}>
            {classId === null ? <option value="">Choose a class</option> : null}
            {CLASS_IDS.map((c) => (
              <option key={c} value={c}>
                {CLASS_NAMES[c]}
              </option>
            ))}
          </Select>
        </FieldRow>
      ) : null}
      {classId ? (
        <>
          <FieldRow label={`${CLASS_NAMES[classId]} level`} hint={levelHint}>
            {/* A native picker of the twenty levels: a phone's own wheel, and nothing typed that a press must first commit. */}
            <Select aria-label={`${CLASS_NAMES[classId]} level`} value={String(draft.classLevel)} onChange={(e) => props.onLevel(Number(e.target.value))} style={{ minWidth: NUMBER_FIELD_WIDTH }}>
              {LEVELS.map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
            </Select>
          </FieldRow>
          <Section label={`At ${CLASS_NAMES[classId]} ${draft.classLevel}`} divider={false}>
            {rows.length === 0 ? (
              <Help>{`No ${CLASS_NAMES[classId]} resources yet. The first comes at level ${firstLevel(classId)}.`}</Help>
            ) : (
              <div style={{ display: "grid" }}>
                {rows.map((row) => (
                  <Checkbox
                    key={row.preset.id}
                    label={row.preset.name}
                    help={pickHelp(row, props.mode)}
                    checked={row.have !== undefined || row.ticked}
                    aria-disabled={row.have !== undefined}
                    onChange={(on) => props.onTick(row.preset.id, on)}
                  />
                ))}
              </div>
            )}
            {[...asked].map((ability) => (
              <ModifierField key={ability} ability={ability} text={props.modText[ability] ?? ""} onText={(text) => props.onModText({ ...props.modText, [ability]: text })} />
            ))}
          </Section>
        </>
      ) : (
        <Help>Choose a class to see its resources at its level.</Help>
      )}
    </>
  );
}

function ModifierField(props: { ability: CountAbility; text: string; onText(text: string): void }) {
  const name = `${ABILITY_NAMES[props.ability]} modifier`;
  return (
    <FieldRow label={name} hint="No stat block to read it from. Below +1 counts once.">
      <Input aria-label={name} inputMode="numeric" enterKeyHint="done" autoComplete="off" placeholder="+3" value={props.text} onChange={(e) => props.onText(e.target.value)} style={{ width: NUMBER_FIELD_WIDTH, textAlign: "right", fontVariantNumeric: "tabular-nums" }} />
    </FieldRow>
  );
}

/** A resource's own fields: its name, whether it spends an amount, its count and the rest that brings it back (7.1). */
export function OwnFields(props: { draft: OwnDraft; onChange(next: OwnDraft): void }) {
  const { draft } = props;
  const set = (patch: Partial<OwnDraft>) => props.onChange({ ...draft, ...patch });
  const most = draft.pool ? LIMITS.resourcePoolMax : LIMITS.resourceMax;
  return (
    <>
      <FieldRow label="Name" fill>
        <Input aria-label="Name" value={draft.name} maxLength={LIMITS.resourceNameChars} placeholder="Superiority Dice" autoComplete="off" enterKeyHint="done" onChange={(e) => set({ name: e.target.value })} style={{ flex: 1, minWidth: 0, width: 0 }} />
      </FieldRow>
      <Checkbox checked={draft.pool} onChange={(pool) => set({ pool })} label="Spend an amount" help="For a pool of points, such as Lay on Hands, where a use spends any amount." />
      <FieldRow label={draft.pool ? "Amount" : "Count"} hint={`1 to ${most}`}>
        <Input
          aria-label={draft.pool ? "Amount" : "Count"}
          inputMode="numeric"
          enterKeyHint="done"
          autoComplete="off"
          value={draft.count}
          onChange={(e) => set({ count: e.target.value })}
          style={{ width: NUMBER_FIELD_WIDTH, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
        />
      </FieldRow>
      <FieldRow label="Comes back on" fill>
        <Select aria-label="Comes back on" value={draft.reset} onChange={(e) => set({ reset: e.target.value as Reset })} style={{ flex: 1, minWidth: 0, maxWidth: "100%" }}>
          {RESET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </FieldRow>
    </>
  );
}
