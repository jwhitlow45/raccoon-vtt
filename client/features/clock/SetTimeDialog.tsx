import { useState, type RefObject } from "react";
import { clockNow } from "#shared/calendar.ts";
import type { RoomClock } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog, DiscardQuestion } from "../../components/Dialog.tsx";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { DateFieldsEditor } from "./DateFieldsEditor.tsx";
import { DISCARD, useDiscard } from "./useDiscard.ts";
import { withClaim } from "./claim.ts";
import { sameCalendar } from "./calendarDraft.ts";
import { composeDraft, draftDate, keptSeconds, reconcileDate, remapMonth, setAt } from "./words.ts";

/**
 * Set the date and time (docs/design/design-v1-calendar.md 4.3): the fields of
 * the clock's own calendar, filled from the current time (5.1), and one
 * `clock.set` on Set, sent only when the DM edited the fields (setAt), so
 * a Set left as it opened never moves the clock back by its seconds. A
 * date the calendar has no such day in, or past the
 * clock's limit, keeps the dialog open with the reason under its field.
 * Setting the clock back is this, never a negative step.
 */
export function SetTimeDialog(props: { clock: RoomClock; opener: RefObject<HTMLElement | null>; onClose(): void }) {
  const { clock } = props;
  const actions = useRoomActions();
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const now = clockNow(clock, encounter);
  // The calendar the fields were made against, so a change from another device is followed by month, not by place.
  const [opened, setOpened] = useState(() => ({ calendar: clock.calendar, start: draftDate(now, clock.calendar) }));
  const [kept, setDraft] = useState(opened.start);
  const [tried, setTried] = useState(false);
  let base = opened;
  let edited = kept;
  if (!sameCalendar(opened.calendar, clock.calendar)) {
    if (opened.calendar.kind !== clock.calendar.kind) {
      // Another DM changed the kind: the fields would name another calendar's parts, so they start again from the current time.
      const start = draftDate(now, clock.calendar);
      base = { calendar: clock.calendar, start };
      edited = start;
    } else {
      // Another DM changed the months: each draft keeps the month it named, or none where that is in doubt (ASTRA-04).
      base = { calendar: clock.calendar, start: remapMonth(opened.start, opened.calendar, clock.calendar) };
      edited = remapMonth(kept, opened.calendar, clock.calendar);
    }
    setOpened(base);
    setDraft(edited);
  }
  const start = reconcileDate(base.start, clock.calendar);
  const draft = reconcileDate(edited, clock.calendar);
  const dirty = JSON.stringify(draft) !== JSON.stringify(start);
  const composed = composeDraft(draft, clock.calendar, keptSeconds(draft, now));
  const { armed, leave } = useDiscard(dirty, props.onClose, kept);

  const set = () => {
    setTried(true);
    if (dirty && !composed.ok) return;
    const at = setAt(dirty, composed, now);
    if (at !== null) actions.dispatch(withClaim({ t: "clock.set", at }, () => actions.newId()));
    props.onClose();
  };

  return (
    <Dialog
      title="Set the date and time"
      onClose={leave}
      opener={props.opener}
      width="sm"
      phone="sheet"
      backClose
      status={armed ? <DiscardQuestion /> : undefined}
      footer={
        <>
          <Button variant={armed ? "danger" : "secondary"} armed={armed} onClick={leave} style={{ flex: "1 1 auto" }}>
            {armed ? DISCARD : "Cancel"}
          </Button>
          <Button variant="primary" onClick={set} style={{ flex: "1 1 auto" }}>
            Set
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          set();
        }}
      >
        <DateFieldsEditor calendar={clock.calendar} value={draft} onChange={setDraft} composed={composed} showErrors={tried} autoFocus />
      </form>
    </Dialog>
  );
}
