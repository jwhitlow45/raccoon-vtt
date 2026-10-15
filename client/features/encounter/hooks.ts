import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientOp } from "#shared/protocol.ts";
import { dispatchGesture } from "../../state/actions.ts";
import type { OpAnswer, RoomView } from "../../state/types.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { entryActor, isDefeated, ownsEntry, sortedEntries } from "./logic.ts";
import { timerState, turnStartedAt, type TimerState } from "./timer.ts";

/**
 * The live store keeps its op queue and the last confirmed `seq` beside the
 * view (state/store.ts), and the view type leaves them out because most
 * components never care. The tracker needs both, read-only.
 */
type StoreExtras = { pending?: readonly { n: number }[]; seq?: number };

/**
 * Whether op `n` is still waiting for the server. A player's encounter ops
 * scan the whole encounter, so they are never predicted (design 7.4) and
 * the view shows nothing until the server's event: this is how the button
 * that sent one knows to spin until then.
 */
function isPending(s: RoomView, n: number): boolean {
  return (s as RoomView & StoreExtras).pending?.some((p) => p.n === n) ?? false;
}

/**
 * The newest `seq` the server confirmed. A log entry's id starts with the
 * seq of the op that wrote it, and a predicted op's entries borrow seqs
 * above this one, which can change when other events land first. Prompts
 * and notices wait for confirmed entries, so a prediction and its
 * confirmation never show twice. Without the field every entry counts as
 * confirmed.
 */
export function useConfirmedSeq(): number {
  return useRoomView((s) => (s as RoomView & StoreExtras).seq ?? Number.POSITIVE_INFINITY);
}

/** Whether any of these ops is still waiting for the server. */
export function useAnyPending(ns: readonly number[]): boolean {
  return useRoomView((s) => ns.some((n) => isPending(s, n)));
}

/** Sends ops and reports whether the last one sent here is still unanswered. */
export function useSend(): { send(op: ClientOp): void; waiting: boolean } {
  const actions = useRoomActions();
  const [n, setN] = useState<number | null>(null);
  const waiting = useRoomView((s) => n !== null && isPending(s, n));
  useEffect(() => {
    if (n !== null && !waiting) setN(null);
  }, [n, waiting]);
  const send = useCallback(
    (op: ClientOp) => {
      const sent = actions.dispatch(op);
      if (sent !== null) setN(sent);
    },
    [actions],
  );
  return { send, waiting };
}

/**
 * Sends an op and keeps what the server made of it (OpAnswer), waiting
 * until then, and null before anything is sent. For a form that reports
 * success only once the server took the op, and stays open otherwise. The
 * answer comes to this op's own sender, so no number of later ops can make
 * an unknown answer read as taken.
 */
export function useSendAnswered(): { send(op: ClientOp): void; answer: OpAnswer | "waiting" | null } {
  const actions = useRoomActions();
  const [answer, setAnswer] = useState<OpAnswer | "waiting" | null>(null);
  const send = useCallback(
    (op: ClientOp) => {
      if (actions.dispatch(op, { onAnswer: setAnswer }) !== null) setAnswer("waiting");
    },
    [actions],
  );
  return { send, answer };
}

/**
 * Sends several ops as one gesture, so one undo takes them all back (design
 * 7.7), and reports whether any of them is still unanswered. `send` returns
 * the ops' numbers.
 */
export function useSendAll(): { send(ops: readonly ClientOp[]): readonly number[]; waiting: boolean } {
  const actions = useRoomActions();
  const [ns, setNs] = useState<readonly number[]>([]);
  const waiting = useAnyPending(ns);
  useEffect(() => {
    if (ns.length > 0 && !waiting) setNs([]);
  }, [ns, waiting]);
  const send = useCallback(
    (ops: readonly ClientOp[]) => {
      const sent = dispatchGesture(actions, ops);
      setNs(sent);
      return sent;
    },
    [actions],
  );
  return { send, waiting };
}

const NO_ENTRIES: never[] = [];

/** The encounter's rows in turn order. Sorting a sorted list is cheap, and it guards a replayed view. */
export function useSortedEntries() {
  const entries = useRoomView((s) => s.view?.encounter?.entries ?? NO_ENTRIES);
  return useMemo(() => sortedEntries(entries), [entries]);
}

/** Who is looking, for the tracker's role and ownership checks. */
export function useYou(): { memberId: string; role: "dm" | "player" } {
  const memberId = useRoomView((s) => s.you?.memberId ?? "");
  const role = useRoomView((s) => s.you?.role ?? "player");
  return useMemo(() => ({ memberId, role }), [memberId, role]);
}

/**
 * Predicates over rows that need the view's tokens and characters. They
 * change whenever a token does, which is fine for the few components that
 * use them.
 */
export function useRowFacts() {
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const skipDefeated = useRoomView((s) => s.view?.meta.settings.skipDefeated ?? true);
  const you = useYou();
  return useMemo(() => {
    const view = { tokens: tokens ?? {}, characters: characters ?? {} };
    return {
      view,
      mine: (e: { tokenId?: string; characterId?: string }) => you.role === "player" && ownsEntry(view, you.memberId, e),
      skip: (e: { tokenId?: string; characterId?: string }) => skipDefeated && isDefeated(entryActor(view, e)),
    };
  }, [tokens, characters, skipDefeated, you]);
}

/**
 * The acting turn's timer (timer.ts), or null while the room has none or no
 * turn this viewer can see is running. It ticks once a second, and only
 * while a timer runs, so a room at rest renders nothing.
 */
export function useTurnTimer(): TimerState | null {
  const limit = useRoomView((s) => s.view?.meta.settings.turnTimerSec ?? 0);
  const activeEntryId = useRoomView((s) => s.view?.encounter?.activeEntryId ?? null);
  const round = useRoomView((s) => s.view?.encounter?.round ?? 0);
  const log = useRoomView((s) => s.view?.log);
  // The seq naming the acting turn, when this viewer holds its start (design 7.3).
  const turnSeq = useRoomView((s) => {
    const start = s.view?.encounter?.turnStart;
    return start && start.entryId === s.view?.encounter?.activeEntryId ? start.seq : undefined;
  });
  const fromLog = useMemo(() => (log ? turnStartedAt(log, activeEntryId, round, turnSeq) : null), [log, activeEntryId, round, turnSeq]);
  const key = `${round}:${activeEntryId ?? ""}`;
  const seenAt = turnSeenAt(key);
  const running = limit > 0 && activeEntryId !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, key]);
  if (!running) return null;
  return timerState(limit, fromLog ?? seenAt, now);
}

/**
 * When this page first saw a turn start, for a turn whose start has no log
 * line. Kept once for the page, so the strip and the tracker, mounted at
 * different times, show the same clock.
 */
let lastTurnSeen: { key: string; at: number } | null = null;

function turnSeenAt(key: string): number {
  if (lastTurnSeen?.key !== key) lastTurnSeen = { key, at: Date.now() };
  return lastTurnSeen.at;
}
