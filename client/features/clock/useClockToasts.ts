import { useEffect, useRef } from "react";
import { clockText } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";
import { arrivals } from "../areas/reminders.ts";
import { useConfirmedSeq } from "../encounter/hooks.ts";
import { useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";

/** How long an op this device sent can still claim the clock line it wrote. */
export const OWN_MS = 15_000;

type Own = { kind: "step" | "history"; at: number };

/** What a pending op writes a clock line as: a step or Set, or an Undo or Redo (whose line carries `from`). Null for any other op. */
export function ownKindOf(op: { t: string }): Own["kind"] | null {
  if (op.t.startsWith("clock.")) return "step";
  if (op.t === "undo" || op.t === "redo") return "history";
  return null;
}

/**
 * A clock line that arrived, minus those this device caused. A line has no
 * author, so a device remembers the ops it sent, and the first line of the
 * same kind within `OWN_MS` is its own (4.7: "The DM device that made the
 * change does not" toast). An op the server refused leaves a claim that
 * lapses on its own.
 */
export function unclaimed(fresh: readonly LogEntry[], own: Own[], now: number): LogEntry[] {
  for (let i = own.length - 1; i >= 0; i--) if (now - own[i]!.at > OWN_MS) own.splice(i, 1);
  return fresh.filter((entry) => {
    const kind = entry.data?.type === "clock" && entry.data.from !== undefined ? "history" : "step";
    const i = own.findIndex((o) => o.kind === kind);
    if (i < 0) return true;
    own.splice(i, 1);
    return false;
  });
}

/**
 * A toast for each clock line that arrives while the Log and the Time panel
 * are both closed (docs/design/design-v1-calendar.md 4.7), for players and
 * co-DMs. The Log keeps every line, toast or not. A line this device's own
 * op wrote makes none.
 */
export function useClockToasts(hidden: boolean): void {
  const log = useRoomView((s) => s.view?.log);
  const confirmedSeq = useConfirmedSeq();
  const ui = useRoomUi();
  const store = useRoomStore();
  const seen = useRef<Set<string> | null>(null);
  const own = useRef<Own[]>([]);
  const lastN = useRef(0);
  // Ops are noted as they are sent, since a toast waits for the server's confirmation of its line, long after the op left `pending`.
  useEffect(() => {
    const note = (pending: readonly { n: number; op: { t: string } }[]) => {
      for (const p of pending) {
        if (p.n <= lastN.current) continue;
        lastN.current = p.n;
        const kind = ownKindOf(p.op);
        if (kind !== null) own.current.push({ kind, at: Date.now() });
      }
    };
    note(store.getState().pending);
    return store.subscribe((s, prev) => {
      if (s.pending !== prev.pending) note(s.pending);
    });
  }, [store]);
  useEffect(() => {
    if (!log) return;
    const { seen: next, fresh } = arrivals(seen.current, log, confirmedSeq);
    seen.current = next;
    const lines = fresh.filter((e) => e.kind === "event" && e.data?.type === "clock");
    const shown = unclaimed(lines, own.current, Date.now());
    if (hidden) return;
    for (const entry of shown) if (entry.data?.type === "clock") ui.notify(clockText(entry.data), "info", undefined, undefined, true);
  }, [log, confirmedSeq, hidden, ui]);
}
