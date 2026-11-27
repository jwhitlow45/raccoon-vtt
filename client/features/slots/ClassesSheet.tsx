import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { Character, HitDieSize } from "#shared/model.ts";
import { CLASS_NAMES, type ClassId } from "#shared/rules/classResources.ts";
import { MAX_LEVEL, THIRD_CLASSES, THIRD_FROM } from "#shared/rules/spellSlots.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { DiscardQuestion } from "../../components/Dialog.tsx";
import { FieldRow, Select } from "../../components/Field.tsx";
import { Held } from "../../components/Held.tsx";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomUi } from "../../state/view.ts";
import { DISCARD, useDiscard } from "../clock/useDiscard.ts";
import { SheetDialog } from "../tokens/SheetDialog.tsx";
import { SmallButton, Stepper } from "../tokens/ui.tsx";
import { classChoices, lowering, newRow, preview, savePatch, startRows, type ClassRow } from "./logic.ts";

const DIES: HitDieSize[] = [6, 8, 10, 12];
const THIRD_HELP = "From level 3. Its slots follow the one-third caster table, which is not in SRD 5.2.1.";

/**
 * The Classes sheet (docs/design/design-v1-slots.md 3.1): one row per class
 * with its level, an Other class with its Hit Point Die, and a Fighter's or
 * Rogue's "Its subclass casts spells". Under the rows, what the classes
 * give and the level they add up to. Save sends the classes and their sum
 * as the level in one character.update, and a Save that lowers the level
 * asks for a second tap. Saving no classes removes them and keeps the
 * level. A bottom sheet on a phone held upright, the dialog elsewhere.
 */
export function ClassesSheet(props: { character: Character; opener: RefObject<HTMLElement | null>; onClose(): void }) {
  const { character } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const keyRef = useRef(0);
  const newKey = () => `row${(keyRef.current += 1)}`;
  const [rows, setRows] = useState<ClassRow[]>(() => startRows(character, newKey));
  const [opened] = useState(() => JSON.stringify(rows.map(({ key: _k, ...r }) => r)));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lowerArmed, setLowerArmed] = useState(false);
  const mounted = useRef(true);
  const addButton = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string | null>(null);
  const formId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty = !sending && JSON.stringify(rows.map(({ key: _k, ...r }) => r)) !== opened;
  const { armed, leave } = useDiscard(dirty, props.onClose, rows);
  // A removed row hands focus to the next row's Class, else Add a class.
  useEffect(() => {
    const key = focusNext.current;
    if (key === null) return;
    focusNext.current = null;
    const next = key === "" ? null : body.current?.querySelector<HTMLElement>(`[data-class-row="${key}"] select`);
    (next ?? addButton.current)?.focus();
  }, [rows]);
  // A change disarms the second tap, which then asks again.
  useEffect(() => setLowerArmed(false), [rows]);

  const shown = preview(rows, character.level);
  const lower = lowering(character.name, character.level, rows);
  const patch = savePatch(rows, character.level);

  const set = (key: string, change: Partial<ClassRow>) => {
    setError(null);
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...change } : r)));
  };
  const remove = (key: string) => {
    setError(null);
    const i = rows.findIndex((r) => r.key === key);
    focusNext.current = rows[i + 1]?.key ?? "";
    setRows(rows.filter((r) => r.key !== key));
  };
  const add = () => {
    const row = newRow(rows, newKey());
    if (!row) return;
    setError(null);
    setRows([...rows, row]);
  };

  const submit = () => {
    if (sending || !patch) return;
    if (lower && !lowerArmed) {
      setLowerArmed(true);
      return;
    }
    const n = actions.dispatch(
      { t: "character.update", characterId: character.id, patch },
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

  const mainLabel = sending ? "Saving…" : lower && lowerArmed ? lower.button : "Save";
  return (
    <SheetDialog
      title="Classes"
      onClose={leave}
      opener={props.opener}
      width={theme.layout.dialog.md}
      statusGrow
      status={
        armed ? (
          <DiscardQuestion />
        ) : error ? (
          <span role="alert" style={{ color: theme.color.dangerText }}>
            {error}
          </span>
        ) : null
      }
      footer={
        <>
          <Button variant={armed ? "danger" : "secondary"} armed={armed} onClick={leave} style={{ flex: "1 1 auto" }}>
            {armed ? DISCARD : "Cancel"}
          </Button>
          <Button variant="primary" type="submit" form={formId} busy={sending} disabled={patch === null} style={{ flex: "1 1 auto" }}>
            {mainLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          const target = e.target as HTMLElement;
          if (e.key === "Enter" && target instanceof HTMLInputElement && target.type === "checkbox") e.preventDefault();
        }}
      >
        <Held held={sending}>
          <div ref={body} style={{ display: "grid", gap: theme.space(4) }}>
            {rows.length === 0 ? <Help>No classes. Saving with none removes them and every spent slot and die, and keeps the level.</Help> : null}
            {rows.map((row) => (
              <ClassRowFields key={row.key} row={row} rows={rows} onChange={(change) => set(row.key, change)} onRemove={() => remove(row.key)} />
            ))}
            <div>
              <SmallButton ref={addButton} icon="plus" disabled={newRow(rows, "") === null} onClick={add}>
                Add a class
              </SmallButton>
            </div>
            <div role="status" style={{ display: "grid", gap: theme.space(1), fontSize: theme.font.body14, lineHeight: theme.leading.body }}>
              {shown.over ? <p style={{ margin: 0, color: theme.color.dangerText }}>{shown.over}</p> : null}
              {shown.gives ? <p style={{ margin: 0 }}>{shown.gives}</p> : null}
              {shown.total ? <p style={{ margin: 0 }}>{shown.sets ? `${shown.total} ${shown.sets}` : shown.total}</p> : null}
              {lower ? <p style={{ margin: 0, color: theme.color.dangerText }}>{lower.line}</p> : null}
            </div>
          </div>
        </Held>
      </form>
    </SheetDialog>
  );
}

/** One class row: its class, level and Remove, with an Other class's die or a Fighter's or Rogue's tick. */
function ClassRowFields(props: { row: ClassRow; rows: readonly ClassRow[]; onChange(change: Partial<ClassRow>): void; onRemove(): void }) {
  const { row } = props;
  const name = row.id === "other" ? "Other class" : CLASS_NAMES[row.id];
  const third = row.id !== "other" && THIRD_CLASSES.has(row.id);
  const below = row.level < THIRD_FROM;
  return (
    <div data-class-row={row.key} role="group" aria-label={name} style={{ display: "grid", gap: theme.space(2) }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
        <Select aria-label="Class" value={row.id} onChange={(e) => props.onChange({ id: e.target.value as ClassId | "other", third: false })} style={{ flex: "1 1 140px", minWidth: 0, maxWidth: "100%" }}>
          {classChoices(props.rows, row).map((id) => (
            <option key={id} value={id}>
              {id === "other" ? "Other class" : CLASS_NAMES[id]}
            </option>
          ))}
        </Select>
        <Stepper label={`${name} level`} value={row.level} step={1} min={1} max={MAX_LEVEL} onChange={(level) => props.onChange({ level })} />
        <SmallButton icon="delete" label={`Remove ${name}`} onClick={props.onRemove} />
      </div>
      {row.id === "other" ? (
        <FieldRow label="Hit Point Die">
          <Select aria-label="Hit Point Die" value={String(row.die)} onChange={(e) => props.onChange({ die: Number(e.target.value) as HitDieSize })}>
            {DIES.map((d) => (
              <option key={d} value={String(d)}>
                {`d${d}`}
              </option>
            ))}
          </Select>
        </FieldRow>
      ) : null}
      {third ? <Checkbox label="Its subclass casts spells" help={THIRD_HELP} checked={row.third && !below} aria-disabled={below} onChange={(on) => !below && props.onChange({ third: on })} /> : null}
    </div>
  );
}
