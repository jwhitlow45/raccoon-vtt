import { useId, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ErrorText, Input, Select } from "../../components/Field.tsx";
import { SectionLabel } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions } from "../../state/view.ts";
import { AMOUNT_UNITS, amountBy, stepName, STEPS, toDawn, type AmountUnit } from "./words.ts";

/**
 * Move the clock on (docs/design/design-v1-calendar.md 4.2): 10 minutes, 1 hour,
 * 8 hours and To dawn, each one `clock.advance`, then Other amount, which
 * opens its row in place. Every step applies at once, and the top bar's Undo
 * is the way back from a stray tap: there is no negative step, and no guard
 * against a second quick tap (D-261102-120).
 *
 * The five are one size (docs/design/design-v1-sound-layout.md 7,
 * D-261106-095): equal 44 px buttons in one grid, two by two where the
 * content is 360 px wide or more and one column below (never more than two,
 * however wide), with Other amount… across its own row. Move on keeps the
 * default size too.
 */
export function StepButtons(props: { now: number }) {
  const actions = useRoomActions();
  const nameId = useId();
  const [other, setOther] = useState(false);
  const [count, setCount] = useState("");
  const [unit, setUnit] = useState<AmountUnit>("hours");
  const [error, setError] = useState<string | null>(null);
  const dawn = toDawn(props.now);
  const step = (by: number) => actions.dispatch({ t: "clock.advance", by });

  const moveOn = () => {
    const amount = amountBy(count, unit);
    if (!amount.ok) {
      setError(amount.reason);
      return;
    }
    step(amount.by);
    setCount("");
    setError(null);
  };

  return (
    <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <SectionLabel id={nameId}>Move the clock on</SectionLabel>
      <div role="group" aria-labelledby={nameId} style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(max(176px, calc(50% - ${theme.space(1)}px)), 1fr))`, gap: theme.space(2) }}>
        {STEPS.map((s) => (
          <Button key={s.id} aria-label={stepName(s.label)} onClick={() => step(s.by)}>
            {s.label}
          </Button>
        ))}
        <Button aria-label={dawn.name} onClick={() => step(dawn.by)}>
          To dawn
        </Button>
        <Button expanded={other} onClick={() => setOther(!other)} style={{ gridColumn: "1 / -1" }}>
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
              onChange={(e) => {
                setCount(e.target.value);
                setError(null);
              }}
              style={{ flex: "1 1 0", minWidth: 0, textAlign: "right" }}
            />
            <Select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as AmountUnit)} style={{ flex: "none" }}>
              {AMOUNT_UNITS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="primary" block>
            Move on
          </Button>
          <ErrorText>{error}</ErrorText>
        </form>
      ) : null}
    </div>
  );
}
