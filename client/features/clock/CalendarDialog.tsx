import { useRef, useState, type RefObject } from "react";
import { clockNow } from "#shared/calendar.ts";
import { LIMITS } from "#shared/limits.ts";
import type { Calendar, RoomClock } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog, DiscardQuestion } from "../../components/Dialog.tsx";
import { ErrorText, Field, Input } from "../../components/Field.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { RadioCards } from "../../components/RadioCards.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { calendarOf, calendarUpdate, draftOf, draftYearDays, followMonth, type CalendarDraft, type MonthRow } from "./calendarDraft.ts";
import { DateFieldsEditor } from "./DateFieldsEditor.tsx";
import { DISCARD, useDiscard } from "./useDiscard.ts";
import { composeDraft, draftDate, firstDay, keptSeconds, reconcileDate, type DateDraft } from "./words.ts";

export const KIND_OPTIONS = [
  { value: "days", label: "Day count", help: "Day 1, Day 2 and on." },
  { value: "months", label: "Months", help: "Named months, a week and years. You name them next." },
] as const;

/**
 * Calendar (docs/design/design-v1-calendar.md 4.3), the DM's. With a clock
 * running, Save sends one `clock.update`: the calendar, and the date as
 * Today reads it only when the DM edited Today or changed the kind
 * (calendarUpdate). Before the clock starts there is
 * no clock to update, so Save hands the calendar back to the start form
 * (`onSave`) and nothing is sent until Start the clock.
 */
export function CalendarDialog(props: {
  initial: Calendar;
  clock: RoomClock | null;
  /** Before the clock starts: the calendar saved, and how a date the start form holds follows its months as they moved or went. */
  onSave?(calendar: Calendar, follow: (date: DateDraft) => DateDraft): void;
  opener?: RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const { clock } = props;
  const actions = useRoomActions();
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const keys = useRef(0);
  const nextKey = () => ++keys.current;
  const [start] = useState(() => draftOf(props.initial, nextKey));
  const [draft, setDraft] = useState<CalendarDraft>(start);
  // Null until the DM edits a Today field, so it keeps reading the clock's moment through the calendar as it is edited.
  const [dateEdit, setDateEdit] = useState<DateDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [triedDate, setTriedDate] = useState(false);
  const now = clock ? clockNow(clock, encounter) : 0;

  const result = calendarOf(draft);
  const kindChanged = clock !== null && draft.kind !== clock.calendar.kind;
  // The Today fields: the moment as the new calendar reads it, or, after the kind changed, the first day with the time of day kept.
  const timeOfDay = clock ? ((now % 86_400) + 86_400) % 86_400 : 0;
  const derived: DateDraft | null =
    clock === null || !result.ok ? null : kindChanged ? firstDay(timeOfDay) : draftDate(now, result.calendar);
  const dateValue = dateEdit && result.ok ? reconcileDate(dateEdit, result.calendar) : (dateEdit ?? derived);
  const composed = result.ok && dateValue ? composeDraft(dateValue, result.calendar, keptSeconds(dateValue, now)) : null;

  const dirty = !sameDraft(draft, start) || dateEdit !== null;
  const { armed, leave } = useDiscard(dirty, props.onClose, draft, dateEdit);
  // Today follows the calendar as it is edited (ASTRA-04): a new kind starts it again from the first day, and a date the DM typed keeps its month by its row.
  const edit = (next: CalendarDraft) => {
    setDraft(next);
    setError(null);
    if (next.kind !== draft.kind) setDateEdit(null);
    else if (dateEdit && next.rows !== draft.rows) setDateEdit(followMonth(dateEdit, draft.rows, next.rows));
  };

  const save = () => {
    setTriedDate(true);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    if (!clock) {
      const rows = draft.rows;
      props.onSave?.(result.calendar, (date) => followMonth(date, start.rows, rows));
      props.onClose();
      return;
    }
    // Today is checked only when Save sends it: an untouched Today reads the clock as it is, which may be a Day count day under 1.
    if ((dateEdit !== null || kindChanged) && composed && !composed.ok) {
      setError(composed.reason);
      return;
    }
    const update = calendarUpdate({ before: clock.calendar, calendar: result.calendar, today: composed, todayTouched: dateEdit !== null, now });
    if (update) actions.dispatch({ t: "clock.update", ...update });
    props.onClose();
  };

  const setRow = (key: number, patch: Partial<MonthRow>) => edit({ ...draft, rows: draft.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const move = (i: number, by: -1 | 1) => {
    const rows = draft.rows.slice();
    const [row] = rows.splice(i, 1);
    rows.splice(i + by, 0, row!);
    edit({ ...draft, rows });
  };
  const days = draftYearDays(draft.rows);

  return (
    <Dialog
      title="Calendar"
      onClose={leave}
      opener={props.opener}
      width="md"
      phone="fill"
      backClose
      status={armed ? <DiscardQuestion /> : error ? <ErrorText>{error}</ErrorText> : undefined}
      footer={
        <>
          <Button variant={armed ? "danger" : "secondary"} armed={armed} onClick={leave} style={{ flex: "1 1 auto" }}>
            {armed ? DISCARD : "Cancel"}
          </Button>
          <Button variant="primary" onClick={save} style={{ flex: "1 1 auto" }}>
            Save
          </Button>
        </>
      }
    >
      <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
        <RadioCards legend="Calendar" value={draft.kind} options={KIND_OPTIONS} onChange={(kind) => edit({ ...draft, kind })} />
        {draft.kind === "months" ? (
          <>
            <Section label="Months" divider={false}>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(2) }}>
                {draft.rows.map((row, i) => (
                  <li key={row.key} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
                    {/* Name and days stay together and the three buttons wrap under them as one, so a narrow dialog never strands a part. */}
                    <span style={{ flex: "1 1 220px", minWidth: 0, display: "flex", gap: theme.space(2) }}>
                      <Input aria-label={`Month ${i + 1} name`} value={row.name} maxLength={LIMITS.calendarNameChars} onChange={(e) => setRow(row.key, { name: e.target.value })} style={{ flex: "1 1 0", minWidth: 0 }} />
                      <Input aria-label={`Days in ${row.name.trim() || `month ${i + 1}`}`} inputMode="numeric" value={row.days} onChange={(e) => setRow(row.key, { days: e.target.value })} style={{ width: 80, flex: "none" }} />
                    </span>
                    <span style={{ display: "flex", flex: "none" }}>
                      <IconButton icon="arrowUp" label={`Move up ${row.name.trim() || `month ${i + 1}`}`} disabled={i === 0} onClick={() => move(i, -1)} />
                      <IconButton icon="arrowDown" label={`Move down ${row.name.trim() || `month ${i + 1}`}`} disabled={i === draft.rows.length - 1} onClick={() => move(i, 1)} />
                      <IconButton icon="delete" label={`Remove ${row.name.trim() || `month ${i + 1}`}`} disabled={draft.rows.length <= 1} onClick={() => edit({ ...draft, rows: draft.rows.filter((r) => r.key !== row.key) })} />
                    </span>
                  </li>
                ))}
              </ul>
              <div style={{ display: "flex" }}>
                <Button size="sm" icon="plus" disabled={draft.rows.length >= LIMITS.calendarMonths} onClick={() => edit({ ...draft, rows: [...draft.rows, { key: nextKey(), name: `Month ${draft.rows.length + 1}`, days: "30" }] })}>
                  Add a month
                </Button>
              </div>
              <Help>A month of 1 day shows by its name alone, as a festival day does.</Help>
            </Section>
            <Field label="Day names" value={draft.week} hint="In order, split by commas. Leave it empty for no week." onChange={(e) => edit({ ...draft, week: e.target.value })} />
            <Field label="After the year" value={draft.era} maxLength={LIMITS.calendarEraChars} hint="Words after the year, such as an era's initials. Leave it empty for none." onChange={(e) => edit({ ...draft, era: e.target.value })} />
            <p aria-live="polite" style={{ margin: 0, fontSize: theme.font.body14, color: theme.color.textMuted }}>
              A year is {days.toLocaleString("en-US")} {days === 1 ? "day" : "days"}.
            </p>
          </>
        ) : null}
        {clock && result.ok && dateValue && composed ? (
          <Section label="Today in this calendar">
            <DateFieldsEditor calendar={result.calendar} value={dateValue} onChange={setDateEdit} composed={composed} showErrors={triedDate} />
          </Section>
        ) : null}
      </div>
    </Dialog>
  );
}

function sameDraft(a: CalendarDraft, b: CalendarDraft): boolean {
  return a.kind === b.kind && a.week === b.week && a.era === b.era && a.rows.length === b.rows.length && a.rows.every((r, i) => r.name === b.rows[i]!.name && r.days === b.rows[i]!.days && r.key === b.rows[i]!.key);
}

/** A new Months calendar's starting point: 12 months of 30 days, no week, no words after the year. */
export const STARTING_MONTHS: Calendar = { kind: "months", months: Array.from({ length: 12 }, (_, i) => ({ name: `Month ${i + 1}`, days: 30 })) };
