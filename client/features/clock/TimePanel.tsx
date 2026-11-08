import { useLayoutEffect, useRef, useState } from "react";
import { clockNow, dateText, fightStarted } from "#shared/calendar.ts";
import type { RoomClock } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { Switch } from "../../components/Switch.tsx";
import { startInScrollBox } from "../../lib/reveal.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { takeOverPanelScroll, type PanelProps } from "../panels.ts";
import { CalendarDialog } from "./CalendarDialog.tsx";
import { DaylightRow } from "./DaylightRow.tsx";
import { SetTimeDialog } from "./SetTimeDialog.tsx";
import { SHARE_HELP, StartClock } from "./StartClock.tsx";
import { StepButtons } from "./StepButtons.tsx";
import { calendarSummary, timeLine } from "./words.ts";

export const NOT_SHARING = "The DM isn't sharing the date and time now.";
export const FIGHT_NOTE = "When the fight ends, the clock moves on 6 seconds for each round.";
export const HIDDEN_NOTE = "Players don't see the date and time.";
export const STOP_HELP = "Removes the date and time for everyone. Undo setup in Setup history brings them back.";

/**
 * The Time panel (docs/design/design-v1-calendar.md 4, its own panel again
 * in docs/design/design-v1-sound-layout.md 3): the room's in-game date and
 * time. Everyone with a clock reads the date and the time with its part of
 * the day, in a polite live region so the DM hears a step land. The DM also
 * starts the clock, moves it on, sets it, picks its calendar, chooses
 * whether players see it, and stops it. A player's Time left open when the
 * DM stops sharing says so until they close it (pages/timeSound.ts keeps it
 * listed).
 */
export default function TimePanel(_props: PanelProps) {
  const role = useRoomView((s) => s.you?.role);
  const clock = useRoomView((s) => s.view?.clock ?? null);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  // The clock this device's own Start the clock asked for, until it shows.
  const startedHere = useRef<string | null>(null);
  const dateBlock = useRef<HTMLDivElement>(null);
  const clockId = clock?.id ?? null;
  useLayoutEffect(() => {
    if (clockId !== null) landOnOwnStart(startedHere, clockId, dateBlock.current);
  }, [clockId]);

  if (role === undefined) return null;
  if (!clock) return role === "dm" ? <StartClock onStart={(id) => void (startedHere.current = id)} /> : <Empty>{NOT_SHARING}</Empty>;

  const now = clockNow(clock, encounter);
  return (
    <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      {/* A place for focus to land after this device's own start (landOnOwnStart), not a control, so it draws no ring (globals.css). */}
      <div ref={dateBlock} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true" style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
        <span data-clock-date="" style={{ fontSize: theme.font.display, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>
          {dateText(now, clock.calendar, "full")}
        </span>
        <span data-clock-time="" style={{ fontSize: theme.font.heading, color: theme.color.textMuted }}>
          {timeLine(now, clock)}
        </span>
      </div>
      {/* Keyed by the clock, so an armed Stop, an open dialog or Other amount's row goes with the clock it was for, however it went: a stop here or on another device, or an Undo (ASTRA-07). */}
      {role === "dm" ? <RunningClock key={clock.id} clock={clock} now={now} fight={fightStarted(encounter)} /> : null}
    </div>
  );
}

/** What landOnOwnStart moves. */
type LandTarget = { readonly isConnected: boolean; focus(options?: FocusOptions): void };

/** How landOnOwnStart reaches the page: the browser's by default, a test's fakes. */
export type LandEnv = { later(run: () => void): void; bring(el: LandTarget): void; takeOver(el: LandTarget): void };

const PAGE: LandEnv = {
  later: (run) => queueMicrotask(run),
  bring: (el) => startInScrollBox(el as unknown as HTMLElement, theme.space(4)),
  takeOver: (el) => takeOverPanelScroll(el as unknown as Element),
};

/**
 * After this device's own Start the clock (LP31-A-TIME-1): the form and its
 * pressed button go as the clock arrives, which left focus on the page, and
 * on a phone the browser's scroll anchoring kept the rows under the form in
 * place, so the new date sat above the sheet's top. Once the clock this
 * device asked for shows, its date block comes to the top of the panel's
 * scroller and takes focus. A clock started on another device moves
 * nothing, and the start is acted on once. It waits for the commit's own
 * layout effects, the panel's scroll restore among them, which runs after
 * this child's, then counts as the viewer taking the scroller, so a restore
 * still pending never pulls it back.
 */
export function landOnOwnStart(startedHere: { current: string | null }, clockId: string, el: LandTarget | null, env: LandEnv = PAGE): void {
  if (startedHere.current !== clockId) return;
  startedHere.current = null;
  if (!el) return;
  env.later(() => {
    if (!el.isConnected) return;
    env.bring(el);
    env.takeOver(el);
    el.focus({ preventScroll: true });
  });
}

/** The DM's controls of a running clock (4.2). */
function RunningClock(props: { clock: RoomClock; now: number; fight: boolean }) {
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
      <StepButtons now={props.now} clock={clock} />
      <div style={{ display: "flex" }}>
        <Button ref={setButton} search="time.set" onClick={() => setDialog("set")}>
          Set the date and time…
        </Button>
      </div>
      <Section label="Sharing" divider={false}>
        <Switch label="Players see the date and time" search="time.shown" help={SHARE_HELP} checked={clock.shown} onChange={(shown) => actions.dispatch({ t: "clock.update", shown })} />
      </Section>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), justifyContent: "space-between" }}>
        <Button ref={calendarButton} search="time.calendar" onClick={() => setDialog("calendar")}>
          Calendar…
        </Button>
        <span data-clock-calendar="" style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>
          {calendarSummary(clock.calendar)}
        </span>
      </div>
      <DaylightRow clock={clock} />
      <Section label="Stop" tone="danger">
        <Help>{STOP_HELP}</Help>
        <div style={{ display: "flex" }}>
          <Button
            variant="danger"
            search="time.stop"
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
