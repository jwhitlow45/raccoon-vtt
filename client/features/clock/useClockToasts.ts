import { useEffect, useRef } from "react";
import { clockText } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";
import type { ScopeHistory } from "#shared/undoContract.ts";
import { arrivals } from "../areas/reminders.ts";
import { useConfirmedSeq } from "../encounter/hooks.ts";
import type { RoomView } from "../../state/types.ts";
import { useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";

type Kind = "step" | "history";

/** An op this device sent that writes a clock line, by its `n`, until the server settles it. */
export type Claim = { n: number; kind: Kind };

/**
 * The history labels of a step that moves the clock (server/rooms/undoLabels.ts
 * describeOp): a step, Set, a calendar save and the party's Long Rest. Only
 * their Undo or Redo can write the DM's "undid a clock change" line.
 */
const CLOCK_STEP = /^(moving the clock on |setting the date and time$|changing the calendar$|the party's Long Rest$)/;

type SentOp = { t: string; at?: number; head?: string; scope?: "play" | "setup"; of?: number };

/**
 * What a sent op writes a clock line as, or null for an op that writes none
 * (ASTRA-05). Stop, the sharing switch and a calendar save without a time
 * write none. An undo or redo writes one only when the step it names, the
 * head of its stack as this device last heard it, moved the clock. One that
 * names a step by `of` is not claimed, since the device holds only heads.
 */
export function ownKindOf(op: SentOp, history: { play: ScopeHistory; setup?: ScopeHistory } | null | undefined): Kind | null {
  switch (op.t) {
    case "clock.start":
    case "clock.set":
    case "clock.advance":
      return "step";
    case "clock.update":
      return op.at !== undefined ? "step" : null;
    case "undo":
    case "redo": {
      if (op.of !== undefined || op.head === undefined) return null;
      const head = history?.[op.scope ?? "play"]?.[op.t].head;
      return head?.id === op.head && CLOCK_STEP.test(head.label) ? "history" : null;
    }
    default:
      return null;
  }
}

function kindOf(entry: LogEntry): Kind {
  return entry.data?.type === "clock" && entry.data.from !== undefined ? "history" : "step";
}

/**
 * The clock lines this device's own ops wrote (ASTRA-05). A line names no
 * author and the server's answer names no line, so a claim is matched only
 * against the clock lines that arrived in the same update as its answer: a
 * batch's lines and its acks travel in one `ev`, and a snapshot that ends
 * an op unanswered carries its line if it wrote one. A refused op, and one
 * whose update held no line of its kind, gives its claim up there. Two
 * same-kind lines in one batch, one this device's and one another's, are
 * the one case left to chance.
 */
export function settleClaims(claims: readonly Claim[], pending: ReadonlySet<number>, refused: ReadonlySet<number>, arrived: readonly LogEntry[]): { mine: string[]; left: Claim[] } {
  const pool = arrived.slice();
  const mine: string[] = [];
  const left: Claim[] = [];
  for (const claim of claims) {
    if (pending.has(claim.n)) {
      left.push(claim);
      continue;
    }
    if (refused.has(claim.n)) continue;
    const i = pool.findIndex((entry) => kindOf(entry) === claim.kind);
    if (i < 0) continue;
    mine.push(pool[i]!.id);
    pool.splice(i, 1);
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
          const kind = ownKindOf(p.op as SentOp, s.history?.summary);
          if (kind !== null) claims.push({ n: p.n, kind });
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
