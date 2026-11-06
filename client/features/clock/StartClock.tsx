import { useRef, useState } from "react";
import type { Calendar } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { RadioCards } from "../../components/RadioCards.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { Switch } from "../../components/Switch.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions } from "../../state/view.ts";
import { CalendarDialog, KIND_OPTIONS, STARTING_MONTHS } from "./CalendarDialog.tsx";
import { DateFieldsEditor } from "./DateFieldsEditor.tsx";
import { pickStartKind, savedToStart, START_FORM, type StartForm } from "./calendarDraft.ts";
import { composeDraft, calendarSummary } from "./words.ts";

export const START_INTRO = "Track the in-game date and time. You move the clock on as time passes. Party Long Rests and fights move it too.";
export const SHARE_HELP = "Off, players don't see the date or time, and their Log stops showing its changes.";

/**
 * The Time panel with no clock (docs/design/design-v1-calendar.md 4.1). The
 * form holds the calendar, the date and the sharing switch, and nothing is
 * sent until Start the clock: one `clock.start`, so a hidden Months clock
 * never reaches a player, its start line included. A Months calendar is
 * kept here as a draft by the Calendar dialog's Save. A clock started here
 * or on another device takes the form's place, so the next start, after a
 * stop, begins afresh.
 */
export function StartClock() {
  const actions = useRoomActions();
  const [form, setForm] = useState<StartForm>(START_FORM);
  const [shown, setShown] = useState(true);
  const { calendar, date, tried } = form;
  const [dialog, setDialog] = useState<Calendar | null>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const composed = composeDraft(date, calendar);

  const pickKind = (kind: "days" | "months") => {
    const next = pickStartKind(form, kind);
    if (next === "ask") setDialog(STARTING_MONTHS);
    else setForm(next);
  };

  const start = () => {
    setForm({ ...form, tried: true });
    if (!composed.ok) return;
    actions.dispatch({ t: "clock.start", id: actions.newId(), at: composed.t, shown, calendar });
  };

  return (
    <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <Help>{START_INTRO}</Help>
      <div style={{ display: "grid", gap: theme.space(2) }}>
        <RadioCards legend="Calendar" value={calendar.kind} options={KIND_OPTIONS} onChange={pickKind} />
        {calendar.kind === "months" ? (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), justifyContent: "space-between" }}>
            <span style={{ fontSize: theme.font.body14 }}>{calendarSummary(calendar)}</span>
            <Button ref={changeButton} size="sm" onClick={() => setDialog(calendar)}>
              Change
            </Button>
          </div>
        ) : null}
      </div>
      <Section label="It is now" divider={false}>
        <DateFieldsEditor calendar={calendar} value={date} onChange={(next) => setForm({ ...form, date: next })} composed={composed} showErrors={tried} />
      </Section>
      <Switch label="Players see the date and time" help={SHARE_HELP} checked={shown} onChange={setShown} />
      <Button variant="primary" block onClick={start}>
        Start the clock
      </Button>
      {dialog ? (
        <CalendarDialog
          initial={dialog}
          clock={null}
          opener={calendar.kind === "months" ? changeButton : undefined}
          onSave={(saved, follow) => setForm(savedToStart(form, saved, follow))}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
