import { useRef, useState } from "react";
import { clockNow, dateText, fightStarted } from "#shared/calendar.ts";
import type { RoomClock } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { Switch } from "../../components/Switch.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { CalendarDialog } from "./CalendarDialog.tsx";
import { SetTimeDialog } from "./SetTimeDialog.tsx";
import { SHARE_HELP, StartClock, type StartDraft } from "./StartClock.tsx";
import { StepButtons, type OtherAmount } from "./StepButtons.tsx";
import { calendarSummary, timeLine } from "./words.ts";

export const NOT_SHARING = "The DM isn't sharing the date and time now.";
export const FIGHT_NOTE = "When the fight ends, the clock moves on 6 seconds for each round.";
export const HIDDEN_NOTE = "Players don't see the date and time.";
export const STOP_HELP = "Removes the date and time for everyone. Undo setup in Setup history brings them back.";

/** What the DM's Time keeps above Ambiance's Sound subpages (docs/design/design-v1-panel-groups.md 4.1, D-261102-763): Other amount, and the start form with no clock. */
export type TimeKept = { amount: OtherAmount; onAmount(next: OtherAmount): void; draft: StartDraft; onDraft(next: StartDraft): void };

/**
 * Time (docs/design/design-v1-calendar.md 4), Ambiance's Time section
 * (docs/design/design-v1-panel-groups.md 4.1): the room's in-game date and
 * time. Everyone with a clock reads the date and the time with its part of
 * the day, in a polite live region so the DM hears a step land. The DM also
 * starts the clock, moves it on, sets it, picks its calendar, chooses
 * whether players see it, and stops it. A player whose Ambiance keeps Time
 * after sharing stops is told so until they close it
 * (features/ambiance/kept.ts). `kept` is the DM's alone.
 */
export function TimeSection(props: { kept?: TimeKept }) {
  const role = useRoomView((s) => s.you?.role);
  const clock = useRoomView((s) => s.view?.clock ?? null);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const { kept } = props;

  if (role === undefined) return null;
  if (!clock) return role === "dm" && kept ? <StartClock draft={kept.draft} onDraft={kept.onDraft} /> : <Empty>{NOT_SHARING}</Empty>;

  const now = clockNow(clock, encounter);
  return (
    <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <div role="status" aria-live="polite" aria-atomic="true" style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
        <span data-clock-date="" style={{ fontSize: theme.font.display, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>
          {dateText(now, clock.calendar, "full")}
        </span>
        <span data-clock-time="" style={{ fontSize: theme.font.heading, color: theme.color.textMuted }}>
          {timeLine(now)}
        </span>
      </div>
      {/* Keyed by the clock, so an armed Stop or an open dialog goes with the clock it was for, however it went: a stop here or on another device, or an Undo (ASTRA-07). */}
      {role === "dm" && kept ? <RunningClock key={clock.id} clock={clock} now={now} fight={fightStarted(encounter)} amount={kept.amount} onAmount={kept.onAmount} /> : null}
    </div>
  );
}

/** The DM's controls of a running clock (4.2). */
function RunningClock(props: { clock: RoomClock; now: number; fight: boolean; amount: OtherAmount; onAmount(next: OtherAmount): void }) {
  const { clock } = props;
  const actions = useRoomActions();
  const [dialog, setDialog] = useState<"set" | "calendar" | null>(null);
  const [stopArmed, setStopArmed] = useState(false);
  const setButton = useRef<HTMLButtonElement>(null);
  const calendarButton = useRef<HTMLButtonElement>(null);
  return (
    <>
      {props.fight ? <Help>{FIGHT_NOTE}</Help> : null}
      {clock.shown ? null : <Help>{HIDDEN_NOTE}</Help>}
      <StepButtons now={props.now} amount={props.amount} onAmount={props.onAmount} />
      <div style={{ display: "flex" }}>
        <Button ref={setButton} onClick={() => setDialog("set")}>
          Set the date and time…
        </Button>
      </div>
      <Section label="Sharing" divider={false}>
        <Switch label="Players see the date and time" help={SHARE_HELP} checked={clock.shown} onChange={(shown) => actions.dispatch({ t: "clock.update", shown })} />
      </Section>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), justifyContent: "space-between" }}>
        <Button ref={calendarButton} onClick={() => setDialog("calendar")}>
          Calendar…
        </Button>
        <span data-clock-calendar="" style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>
          {calendarSummary(clock.calendar)}
        </span>
      </div>
      <Section label="Stop" tone="danger">
        <Help>{STOP_HELP}</Help>
        <div style={{ display: "flex" }}>
          <Button
            variant="danger"
            armed={stopArmed}
            onBlur={() => setStopArmed(false)}
            onClick={() => {
              if (!stopArmed) {
                setStopArmed(true);
                return;
              }
              // Disarmed here too, so a stop the server refuses leaves it as it was.
              setStopArmed(false);
              actions.dispatch({ t: "clock.stop" });
            }}
          >
            {stopArmed ? "Tap again to stop the clock" : "Stop the clock"}
          </Button>
        </div>
      </Section>
      {dialog === "set" ? <SetTimeDialog clock={clock} opener={setButton} onClose={() => setDialog(null)} /> : null}
      {dialog === "calendar" ? <CalendarDialog initial={clock.calendar} clock={clock} opener={calendarButton} onClose={() => setDialog(null)} /> : null}
    </>
  );
}
