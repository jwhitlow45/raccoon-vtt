import { useEffect, useRef } from "react";
import { clockText } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";
import { arrivals } from "../areas/reminders.ts";
import { useConfirmedSeq } from "../encounter/hooks.ts";
import type { RoomView } from "../../state/types.ts";
import { useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";

/** An op this device sent that writes a clock line, by its `n` and the claim id the line will carry, until the server settles it. */
export type Claim = { n: number; id: string };

type SentOp = { t: string; claim?: string; head?: string; of?: number };

/**
 * The claim id a sent op's clock line will carry, or null for an op that
 * writes none (docs/design/design-v1-calendar-c2c3.md 4.6). A clock op that
 * can write a line carries a fresh id (claim.ts `withClaim`), and the reducer
 * copies it onto the line. A DM's Undo or Redo names the head of its stack,
 * which the server copies onto the line its restore writes. One that names a
 * step by `of` is not claimed, since the device holds only heads. A head
 * that moved no clock writes no line, and the claim is given up when its
 * answer arrives with none.
 */
export function ownClaimOf(op: SentOp): string | null {
  switch (op.t) {
    case "clock.start":
    case "clock.set":
    case "clock.advance":
    case "clock.update":
      return op.claim ?? null;
    case "undo":
    case "redo":
      return op.of === undefined && op.head !== undefined ? op.head : null;
    default:
      return null;
  }
}

/**
 * The clock lines this device's own ops wrote (ASTRA-05). A claim id is on
 * the op and on the line it wrote, so a device knows its own lines exactly,
 * whatever else arrives in the same update. A claim is looked for only among
 * the clock lines that arrived in the same update as its answer: a batch's
 * lines and its acks travel in one `ev`, and a snapshot that ends an op
 * unanswered carries its line if it wrote one. A refused op, and one whose
 * update held no line with its id, gives its claim up there.
 */
export function settleClaims(claims: readonly Claim[], pending: ReadonlySet<number>, refused: ReadonlySet<number>, arrived: readonly LogEntry[]): { mine: string[]; left: Claim[] } {
  const mine: string[] = [];
  const left: Claim[] = [];
  for (const claim of claims) {
    if (pending.has(claim.n)) {
      left.push(claim);
      continue;
    }
    if (refused.has(claim.n)) continue;
    const line = arrived.find((entry) => entry.data?.type === "clock" && entry.data.claim === claim.id);
    if (line) mine.push(line.id);
  }
  return { mine, left };
}

type Watched = Pick<RoomView, "pending" | "refused" | "confirmed" | "history">;

function clockLinesAdded(was: readonly LogEntry[] | undefined, now: readonly LogEntry[] | undefined): LogEntry[] {
  if (!now || now === was) return [];
  const before = new Set((was ?? []).map((e) => e.id));
  return now.filter((e) => e.data?.type === "clock" && !before.has(e.id));
}

/**
 * Follows the store for the clock lines this device's ops wrote: claims an
 * op as it is sent, and settles it in the update that answers it.
 */
export function ownLineWatcher(): { update(s: Watched, prev: Watched): void; take(id: string): boolean } {
  let claims: Claim[] = [];
  let lastN = 0;
  const mine = new Set<string>();
  return {
    update(s, prev) {
      if (s.pending !== prev.pending) {
        for (const p of s.pending) {
          if (p.n <= lastN) continue;
          lastN = p.n;
          const id = ownClaimOf(p.op as SentOp);
          if (id !== null) claims.push({ n: p.n, id });
        }
      }
      if (claims.length === 0) return;
      const pending = new Set(s.pending.map((p) => p.n));
      if (claims.every((c) => pending.has(c.n))) return;
      const settled = settleClaims(claims, pending, new Set(s.refused ?? []), clockLinesAdded(prev.confirmed?.log, s.confirmed?.log));
      claims = settled.left;
      for (const id of settled.mine) mine.add(id);
    },
    take(id) {
      return mine.delete(id);
    },
  };
}

/**
 * A toast for each clock line that arrives while neither the Log nor an open
 * Time is on screen (docs/design/design-v1-calendar.md 4.7), for players and
 * co-DMs. The Log keeps every line, toast or not. A line this device's own
 * op wrote makes none.
 */
export function useClockToasts(hidden: boolean): void {
  const log = useRoomView((s) => s.view?.log);
  const confirmedSeq = useConfirmedSeq();
  const ui = useRoomUi();
  const store = useRoomStore();
  const seen = useRef<Set<string> | null>(null);
  const own = useRef<ReturnType<typeof ownLineWatcher> | null>(null);
  // Followed as the store changes, since an op's answer and its line arrive in one update, long before the toast's effect runs.
  useEffect(() => {
    const watcher = ownLineWatcher();
    own.current = watcher;
    const first = store.getState();
    watcher.update(first, { ...first, pending: [] });
    return store.subscribe((s, prev) => watcher.update(s, prev));
  }, [store]);
  useEffect(() => {
    if (!log) return;
    const { seen: next, fresh } = arrivals(seen.current, log, confirmedSeq);
    seen.current = next;
    const shown = fresh.filter((e) => e.kind === "event" && e.data?.type === "clock" && !own.current?.take(e.id));
    if (hidden) return;
    for (const entry of shown) if (entry.data?.type === "clock") ui.notify(clockText(entry.data), "info", undefined, undefined, true);
  }, [log, confirmedSeq, hidden, ui]);
}
