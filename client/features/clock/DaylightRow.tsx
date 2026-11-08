import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { RoomClock } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Field } from "../../components/Field.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions } from "../../state/view.ts";
import { composeDaylight, DAYLIGHT_HELP, daylightDraft, daylightText, sameDaylight } from "./words.ts";

/**
 * The Time panel's Dawn and dusk row (docs/design/design-v1-calendar-c2c3.md
 * 5.2): the two times, and Change, which opens two time fields in place.
 * Save sends one `clock.update` with `daylight` and no claim, since it
 * writes no clock line. A save that changes nothing sends nothing. Change
 * puts focus in Dawn, and Save and Cancel give it back to Change.
 */
export function DaylightRow(props: { clock: RoomClock }) {
  const { clock } = props;
  const actions = useRoomActions();
  const [draft, setDraft] = useState<{ dawn: string; dusk: string } | null>(null);
  const [tried, setTried] = useState(false);
  const change = useRef<HTMLButtonElement>(null);
  // Focus returns once the row has closed and Change is drawn again.
  const returnFocus = useRef(false);
  useEffect(() => {
    if (draft === null && returnFocus.current) {
      returnFocus.current = false;
      change.current?.focus();
    }
  }, [draft]);

  const close = () => {
    returnFocus.current = true;
    setDraft(null);
    setTried(false);
  };
  const composed = draft ? composeDaylight(draft) : null;
  const save = () => {
    if (!composed) return;
    setTried(true);
    if (!composed.ok) return;
    if (!sameDaylight(clock, composed.daylight)) actions.dispatch({ t: "clock.update", daylight: composed.daylight });
    close();
  };
  const bad = (field: "dawn" | "dusk") => (tried && composed && !composed.ok && composed.field === field ? composed.reason : null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };

  return (
    <Section label="Dawn and dusk" divider={false} search="time.daylight">
      <Help>{DAYLIGHT_HELP}</Help>
      {draft === null ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), justifyContent: "space-between" }}>
          <span data-clock-daylight="" style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>
            {daylightText(clock)}
          </span>
          <Button ref={change} onClick={() => setDraft(daylightDraft(clock))}>
            Change
          </Button>
        </div>
      ) : (
        <form
          onKeyDown={onKeyDown}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}
        >
          {/* Side by side while the content is 360 px wide or more, stacked below. */}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${176}px), 1fr))`, gap: theme.space(2) }}>
            <Field label="Dawn" type="time" autoFocus value={draft.dawn} error={bad("dawn")} onChange={(e) => setDraft({ ...draft, dawn: e.target.value })} />
            <Field label="Dusk" type="time" value={draft.dusk} error={bad("dusk")} onChange={(e) => setDraft({ ...draft, dusk: e.target.value })} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
            <Button variant="secondary" onClick={close} style={{ flex: "1 1 auto" }}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" style={{ flex: "1 1 auto" }}>
              Save
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}
