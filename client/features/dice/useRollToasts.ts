import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { hitOf, keptD20 } from "#shared/dice/roll.ts";
import { compareLogIds } from "#shared/keys.ts";
import { critSums, labelText, rollToastText, type LogNames } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";
import { useRollToastsOn } from "../device/settings.ts";
import type { ToastDie } from "../../state/types.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { rollsOf, rollVerdict, type DiceLine } from "./logic.ts";
import { useReceipts, type ReceiptState } from "./useReceipt.ts";

/**
 * Rolls as toasts (docs/design-v1-dice.md 8.5 and 8.7): someone else's
 * roll that arrives with its numbers after the page's first snapshot, one
 * toast per batch, while the Dice panel is not on screen and this device
 * shows others' rolls. A bare secret line shows none, nor does a request's
 * answer, which the DM's live card shows. And this device's own roll whose
 * surface closed before its answer, which nobody would see otherwise.
 */
const EMPTY_LOG: LogEntry[] = [];

/** Someone else's new dice lines with their numbers, grouped one batch to a toast, oldest first. */
export function othersRolls(fresh: readonly LogEntry[], me: string): DiceLine[][] {
  const groups = new Map<string, DiceLine[]>();
  for (const entry of fresh) {
    const data = entry.data;
    if (entry.kind !== "event" || data?.type !== "dice" || data.by === me || data.rolls.length === 0) continue;
    const key = data.batch === undefined ? entry.id : `${data.by}|${data.batch}`;
    const group = groups.get(key);
    if (group) group.push(data);
    else groups.set(key, [data]);
  }
  return [...groups.values()];
}

/**
 * The die a toast of one D20 Test leads with (docs/design-v1-roll-animation.md 4):
 * an attack, a save, a check or initiative, read by its deciding d20. It
 * rings for a natural 20, or a critical hit against an AC, and is outlined
 * for a natural 1. Null for any other toast: damage, several rolls, or a
 * roll with no deciding d20.
 */
export function toastDie(lines: readonly DiceLine[]): ToastDie | null {
  const line = lines.length === 1 ? lines[0] : undefined;
  const roll = line?.rolls.length === 1 ? line.rolls[0] : undefined;
  const d20 = roll ? keptD20(roll) : null;
  if (!line || !roll || !d20) return null;
  const critical = line.ac !== undefined && hitOf(roll, line.ac) === "critical";
  return { face: d20.face, ring: d20.face === 20 || critical, fumble: d20.face === 1, verdict: rollVerdict(roll, line) };
}

/** How long a batch that toasted is remembered, so its later parts make no second toast. */
export const BATCH_REMEMBERED_MS = 10_000;

/**
 * The groups still to toast: one toast a batch, across frames too. A
 * group's batches usually land in one frame, but a resend or a busy server
 * can split them, and each later part would toast again. A batch is
 * remembered from its first part, and each later part keeps it remembered,
 * however its parts came. `seen` is the hook's own memory, `now` the clock.
 */
export function unseenGroups(groups: DiceLine[][], seen: Map<string, number>, now: number): DiceLine[][] {
  for (const [key, at] of seen) if (now - at > BATCH_REMEMBERED_MS) seen.delete(key);
  return groups.filter((lines) => {
    const first = lines[0];
    if (first?.batch === undefined) return true;
    const key = `${first.by}|${first.batch}`;
    const known = seen.has(key);
    seen.set(key, now);
    return !known;
  });
}

/** This device's own roll nobody saw land: its total, its refusal, or that it may have happened. */
export function ownResultText(state: Exclude<ReceiptState, { state: "sending" | "checking" }>): string {
  if (state.state === "refused") return state.text || state.message;
  if (state.state === "unknown") return "A roll may have happened. Check the log.";
  const rolls = rollsOf(state.lines);
  const first = rolls[0];
  if (!first) return "Rolled. Its result is no longer in the log.";
  if (rolls.length > 1) return `Rolled ${rolls.length} times.`;
  return `Rolled ${first.total.toLocaleString("en-US")}${critSums([first])}${first.label ? `: ${labelText(first.label)}` : ""}.`;
}

export function useRollToasts(diceShown: boolean): void {
  const on = useRollToastsOn();
  const log = useRoomView((s) => s.view?.log ?? EMPTY_LOG);
  const loaded = useRoomView((s) => s.view !== null);
  const me = useRoomView((s) => s.you?.memberId ?? "");
  const members = useRoomView((s) => s.view?.members);
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const handouts = useRoomView((s) => s.view?.handouts);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const names = useMemo<LogNames>(() => ({ members: members ?? {}, tokens: tokens ?? {}, characters: characters ?? {}, handouts: handouts ?? {}, encounter }), [members, tokens, characters, handouts, encounter]);
  const ui = useRoomUi();
  /** The newest entry already read. Undefined until the first snapshot, whose lines are history, not news. */
  const read = useRef<string | null | undefined>(undefined);
  /** Batches already toasted, or shown while the panel was on screen, by when they were last heard of. */
  const batches = useRef(new Map<string, number>());

  useEffect(() => {
    if (!loaded) return;
    const latest = log.at(-1)?.id ?? null;
    if (read.current === undefined) {
      read.current = latest;
      return;
    }
    const since = read.current;
    const fresh = since === null ? log : log.filter((e) => compareLogIds(e.id, since) > 0);
    read.current = latest;
    // Remembered even when not toasted, so a later part of a group seen in the panel stays quiet once it closes.
    const groups = unseenGroups(othersRolls(fresh, me), batches.current, Date.now());
    if (!on || diceShown) return;
    for (const lines of groups) ui.notify(rollToastText(lines, names), "info", toastDie(lines) ?? undefined, undefined, true);
  }, [loaded, log, on, diceShown, me, names, ui]);

  const tracker = useReceipts();
  const version = useSyncExternalStore(tracker.subscribe, tracker.version);
  useEffect(() => {
    // Only a roll the server took is in the log: a refusal or an unknown answer is not.
    for (const { state } of tracker.unannounced()) ui.notify(ownResultText(state), state.state === "refused" ? "error" : "info", undefined, undefined, state.state === "committed");
  }, [tracker, version, ui]);
}
