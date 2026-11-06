import { useId } from "react";
import { Button } from "../../components/Button.tsx";
import { ErrorText, Input, Select } from "../../components/Field.tsx";
import { SectionLabel } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions } from "../../state/view.ts";
import { AMOUNT_UNITS, amountBy, stepName, STEPS, toDawn, type AmountUnit } from "./words.ts";

/** Other amount's row: whether it shows, what is typed, its unit and the last refusal. */
export type OtherAmount = { readonly open: boolean; readonly count: string; readonly unit: AmountUnit; readonly error: string | null };

export const NO_OTHER_AMOUNT: OtherAmount = { open: false, count: "", unit: "hours", error: null };

/**
 * Move the clock on (docs/design/design-v1-calendar.md 4.2): 10 minutes, 1 hour,
 * 8 hours and To dawn, each one `clock.advance`, then Other amount in a row
 * that opens in place. Every step applies at once, and the top bar's Undo is
 * the way back from a stray tap: there is no negative step, and no guard
 * against a second quick tap (D-261102-120). The four sit 2 by 2 and become
 * one column where the sheet's content is under 360 px wide (never more than two columns, however wide it is).
 *
 * Other amount's row, open or not, with its number and unit, comes from the
 * Ambiance panel's top (`amount`), above the Sound subpages that replace the
 * whole first page, so Back finds it as it was left
 * (docs/design/design-v1-panel-groups.md 4.1, D-261102-763).
 */
export function StepButtons(props: { now: number; amount: OtherAmount; onAmount(next: OtherAmount): void }) {
  const actions = useRoomActions();
  const nameId = useId();
  const { open: other, count, unit, error } = props.amount;
  const set = (patch: Partial<OtherAmount>) => props.onAmount({ ...props.amount, ...patch });
  const dawn = toDawn(props.now);
  const step = (by: number) => actions.dispatch({ t: "clock.advance", by });

  const moveOn = () => {
    const amount = amountBy(count, unit);
    if (!amount.ok) {
      set({ error: amount.reason });
      return;
    }
    step(amount.by);
    set({ count: "", error: null });
  };

  return (
    <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      {/* An h4, as the sections around it in Ambiance's Time group are, under the group's h3. */}
      <SectionLabel id={nameId} level={4}>
        Move the clock on
      </SectionLabel>
      <div role="group" aria-labelledby={nameId} style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(max(176px, calc(50% - ${theme.space(1)}px)), 1fr))`, gap: theme.space(2) }}>
        {STEPS.map((s) => (
          <Button key={s.id} aria-label={stepName(s.label)} onClick={() => step(s.by)}>
            {s.label}
          </Button>
        ))}
        <Button aria-label={dawn.name} onClick={() => step(dawn.by)}>
          To dawn
        </Button>
      </div>
      <div style={{ display: "flex" }}>
        <Button size="sm" expanded={other} onClick={() => set({ open: !other })}>
          Other amount…
        </Button>
      </div>
      {other ? (
        <form
          style={{ display: "grid", gap: theme.space(2) }}
          onSubmit={(e) => {
            e.preventDefault();
            moveOn();
          }}
        >
          {/* The amount and its unit share a line that never wraps, and Move on takes the line under, so a narrow sheet never strands one part. */}
          <div style={{ display: "flex", gap: theme.space(2), alignItems: "center" }}>
            <Input
              type="text"
              inputMode="numeric"
              aria-label="Amount"
              value={count}
              error={error !== null}
              autoFocus
              onChange={(e) => set({ count: e.target.value, error: null })}
              style={{ flex: "1 1 0", minWidth: 0, textAlign: "right" }}
            />
            <Select aria-label="Unit" value={unit} onChange={(e) => set({ unit: e.target.value as AmountUnit })} style={{ flex: "none" }}>
              {AMOUNT_UNITS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="primary" size="sm" block>
            Move on
          </Button>
          <ErrorText>{error}</ErrorText>
        </form>
      ) : null}
    </div>
  );
}
