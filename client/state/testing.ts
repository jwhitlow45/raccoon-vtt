import type { ClientMessage } from "#shared/protocol.ts";
import type { Outbox } from "./store.ts";
import type { Clock } from "./timing.ts";

/**
 * Test doubles for the store and socket tests. Nothing here runs in the app.
 */

/** A clock whose timers fire only when the test advances it, in due order. */
export class FakeClock implements Clock {
  t = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Runs every timer due within `ms`, including ones those timers set. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (timer.at < nextAt || (timer.at === nextAt && id < nextId))) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId < 0) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = Math.max(this.t, timer.at);
      timer.fn();
    }
    this.t = end;
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

/** Records what the store sends. Closed, it refuses like a socket that is not open. */
export class FakeOutbox implements Outbox {
  sent: ClientMessage[] = [];
  open = true;

  send(msg: ClientMessage): boolean {
    if (!this.open) return false;
    this.sent.push(msg);
    return true;
  }

  /** The `n`s of ops sent so far, in order, and clears the record. */
  takeOps(): number[] {
    const ns = this.sent.flatMap((m) => (m.t === "op" ? [m.n] : []));
    this.sent = [];
    return ns;
  }
}

/** A fixed, explicit head for transport tests that do not simulate server stacks. */
export const TEST_HISTORY_HEAD = "00000000-0000-4000-8000-000000000001";

export function applyTestHistory(room: import("./store.ts").RoomStore, watermark: number): void {
  const s = room.store.getState();
  const stack = { head: { id: TEST_HISTORY_HEAD, label: "moving a token" }, depth: 1 };
  room.applyHistory({ t: "history", epoch: "00000000-0000-4000-8000-000000000002", seq: s.seq, serial: (s.history?.summary?.serial ?? 0) + 1, watermark,
    play: { undo: stack, redo: stack }, ...(s.you?.role === "dm" ? { setup: { undo: stack, redo: stack } } : {}) });
}
