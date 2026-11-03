import { useId } from "react";
import type { ComposedDate } from "#shared/calendar.ts";
import type { Calendar } from "#shared/model.ts";
import { Field, Select } from "../../components/Field.tsx";
import { theme } from "../../lib/theme.ts";
import { weekdayLine, type DateDraft } from "./words.ts";

/**
 * The fields that name a moment (docs/design/design-v1-calendar.md 4.3), shared
 * by Set the date and time, the start form and the Calendar dialog's Today:
 * a Day field for Day count, a Month, a Day and a Year for Months, and a
 * time. A refused field names its reason under it (`error`, once the DM has
 * tried), the month's too, and the weekday reads out in a polite line under
 * the date.
 */
export function DateFieldsEditor(props: {
  calendar: Calendar;
  value: DateDraft;
  onChange(value: DateDraft): void;
  /** What composing the value said, shown under the field it names while `showErrors`. */
  composed: ComposedDate;
  showErrors: boolean;
  /** Focus starts on the first field, as in a dialog. */
  autoFocus?: boolean;
}) {
  const { calendar, value, composed } = props;
  const selectId = useId();
  const bad = (field: "day" | "month" | "year" | "time") => (props.showErrors && !composed.ok && composed.field === field ? composed.reason : null);
  const set = (patch: Partial<DateDraft>) => props.onChange({ ...value, ...patch });
  const weekday = composed.ok ? weekdayLine(composed.t, calendar) : "";
  const monthMissing = calendar.kind === "months" && (value.month === "" || calendar.months[Number(value.month)] === undefined);
  const monthError = bad("month");
  return (
    <div style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
      {calendar.kind === "months" ? (
        <div style={{ display: "grid", gap: theme.space(1) }}>
          <label htmlFor={selectId} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
            Month
          </label>
          <Select id={selectId} autoFocus={props.autoFocus} value={value.month} error={monthError !== null} aria-describedby={monthError ? `${selectId}-error` : undefined} onChange={(e) => set({ month: e.target.value })}>
            {/* A month the calendar no longer has reads as none (reconcileDate). Without this the select would show the first month while the draft holds none, and picking it would change nothing. */}
            {monthMissing ? (
              <option value="" disabled>
                Pick a month
              </option>
            ) : null}
            {calendar.months.map((m, i) => (
              <option key={i} value={String(i)}>
                {m.name}
              </option>
            ))}
          </Select>
          {monthError ? (
            <div id={`${selectId}-error`} role="alert" style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
              {monthError}
            </div>
          ) : null}
        </div>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: calendar.kind === "months" ? "repeat(auto-fit, minmax(min(100%, 120px), 1fr))" : "minmax(0, 1fr)", gap: theme.space(3) }}>
        <Field
          label="Day"
          inputMode="numeric"
          value={value.day}
          error={bad("day")}
          autoFocus={props.autoFocus && calendar.kind === "days"}
          onChange={(e) => set({ day: e.target.value })}
        />
        {calendar.kind === "months" ? <Field label="Year" inputMode="numeric" value={value.year} error={bad("year")} onChange={(e) => set({ year: e.target.value })} /> : null}
      </div>
      {/* Mounted while empty, with the gap above it taken back, so a screen reader hears the weekday as the date changes. */}
      <p aria-live="polite" style={{ margin: 0, marginTop: weekday ? 0 : -theme.space(3), fontSize: theme.font.body14, color: theme.color.textMuted }}>
        {weekday}
      </p>
      <Field label="Time" type="time" value={value.time} error={bad("time")} onChange={(e) => set({ time: e.target.value })} />
    </div>
  );
}
