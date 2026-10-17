import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { compareLogIds } from "#shared/keys.ts";
import { rollToastText, type LogNames } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";
import { useRollToastsOn } from "../device/settings.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { rollsOf, type DiceLine } from "./logic.ts";
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

/** This device's own roll nobody saw land: its total, its refusal, or that it may have happened. */
export function ownResultText(state: Exclude<ReceiptState, { state: "sending" | "checking" }>): string {
  if (state.state === "refused") return state.text || state.message;
  if (state.state === "unknown") return "A roll may have happened. Check the log.";
  const rolls = rollsOf(state.lines);
  const first = rolls[0];
  if (!first) return "Rolled. Its result is no longer in the log.";
  if (rolls.length > 1) return `Rolled ${rolls.length} times.`;
  return `Rolled ${first.total.toLocaleString("en-US")}${first.label ? `: ${first.label}` : ""}.`;
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
    if (!on || diceShown) return;
    for (const lines of othersRolls(fresh, me)) ui.notify(rollToastText(lines, names));
  }, [loaded, log, on, diceShown, me, names, ui]);

  const tracker = useReceipts();
  const version = useSyncExternalStore(tracker.subscribe, tracker.version);
  useEffect(() => {
    for (const { state } of tracker.unannounced()) ui.notify(ownResultText(state), state.state === "refused" ? "error" : "info");
  }, [tracker, version, ui]);
}
