import type { LogEntry } from "#shared/model.ts";

/**
 * The optional turn timer (features section 10): a DM setting, off by
 * default, that counts each turn down and nudges whoever acts when it runs
 * out. It never ends a turn. Turns at a table stop for rules questions and
 * jokes, and a turn that ended by itself would need taking back.
 *
 * Every device counts from the moment the turn began, which the turn's log
 * line records in the server's time. A turn whose line this viewer does
 * not hold, such as one that began out of their sight, counts from when
 * this device saw it start. Phones keep their clocks within a second or so of
 * the server's, which is close enough for a nudge.
 */

/** The choices the DM picks from, in seconds, up to MAX_TURN_TIMER_SEC. 0 is off. */
export const TIMER_CHOICES: readonly { value: number; label: string }[] = [
  { value: 0, label: "Off" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 120, label: "2 minutes" },
  { value: 180, label: "3 minutes" },
  { value: 300, label: "5 minutes" },
  { value: 600, label: "10 minutes" },
];

/** "4 min 10 s", "45 s" or "4 min", for a timer that is none of the choices. */
export function timerLabel(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/**
 * The choices, with the room's own timer among them when it is none of
 * them: an imported room or a raw op can set any number of seconds up to
 * the limit, and the control must not read as unset then.
 */
export function timerChoices(current: number): { value: number; label: string }[] {
  if (TIMER_CHOICES.some((c) => c.value === current)) return [...TIMER_CHOICES];
  return [...TIMER_CHOICES, { value: current, label: timerLabel(current) }].sort((a, b) => a.value - b.value);
}

/** The seq of the op that wrote a log line, from its id (`"<seq>:<index>"`). */
function seqOf(entry: LogEntry): number {
  return Number(entry.id.split(":")[0]);
}

/** When the clock turns to a warning, in seconds left. */
export const TIMER_WARNING_SEC = 10;

/**
 * When the acting row's turn began, from the newest turn line in this
 * viewer's log, or null when that line is not this turn's, and the page
 * counts from when it saw the turn instead.
 *
 * A viewer's log leaves out the turns they could not see, so the newest
 * line they hold may be about an earlier turn: this same row's of an
 * earlier round, or a line taken back long ago. So a turn's own line counts
 * only for its row and round. A line taken back (the DM's Previous) marks
 * when the turn it names in `to` resumed, and counts only for that row,
 * and only when it came after the acting turn began (`turnSeq`, the seq of
 * the op that started it, which TurnStart carries): a later turn of the
 * same row began after it. A take-back whose resumed row this viewer could
 * not see carries no `to`, and one without the turn's seq cannot be
 * placed, so neither counts.
 */
export function turnStartedAt(log: readonly LogEntry[], activeEntryId: string | null, round: number, turnSeq?: number): number | null {
  if (activeEntryId === null) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]!;
    const data = entry.data;
    if (data?.type !== "turn") continue;
    if (!data.back && (data.entryId !== activeEntryId || data.round !== round)) return null;
    if (data.back && (data.to !== activeEntryId || turnSeq === undefined || seqOf(entry) <= turnSeq)) return null;
    const at = Date.parse(entry.at);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

export type TimerState = { left: number; over: boolean; warning: boolean };

/** Whole seconds left of the turn, negative once it has run out. */
export function timerState(limitSec: number, startedAt: number, now: number): TimerState {
  const left = limitSec - Math.floor(Math.max(0, now - startedAt) / 1000);
  return { left, over: left <= 0, warning: left > 0 && left <= TIMER_WARNING_SEC };
}

/** "1:05" while time is left, "+0:12" for the time past it. */
export function clockText(state: TimerState): string {
  const seconds = Math.abs(state.left);
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return state.over && state.left < 0 ? `+${text}` : text;
}
