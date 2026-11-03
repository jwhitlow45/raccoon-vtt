import assert from "node:assert/strict";
import { clockText } from "../logText.ts";
import type { Calendar, ClockLogEvent, Encounter, LogEntry, RoomClock, RoomState, Viewer } from "../model.ts";
import type { Op, OpOf, RestoreEntry } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { DM, character, entry, env, room, token } from "../testutil.ts";
import type { RestoreHistoryFields } from "../undoContract.ts";

/** Fixtures for the clock's reducer tests (docs/design/design-v1-calendar.md 11). */
export const H = 3_600;
export const DAYS: Calendar = { kind: "days" };
export const MONTHS: Extract<Calendar, { kind: "months" }> = { kind: "months", months: Array.from({ length: 12 }, (_, i) => ({ name: `Month ${i + 1}`, days: 30 })), week: ["One", "Two", "Three"], era: "AF" };

export function run(state: RoomState, op: Op, seq = 2, who: Viewer = DM, opVersion?: number): Applied {
  const r = applyOp(state, op, who, { ...env(seq), ...(opVersion === undefined ? {} : { opVersion }) });
  assert.ok(r.ok, r.ok ? "" : `${op.t}: ${r.message}`);
  return r;
}

export function refusal(state: RoomState, op: Op, who: Viewer = DM): string {
  const r = applyOp(state, op, who, env(9));
  assert.ok(!r.ok, `${op.t} should be refused`);
  return r.message;
}

export function clockLines(lines: readonly LogEntry[]): LogEntry[] {
  return lines.filter((line) => line.data?.type === "clock");
}

export function texts(lines: readonly LogEntry[]): string[] {
  return clockLines(lines).map((line) => clockText(line.data as ClockLogEvent));
}

/** A fight in `round`, its first row acting unless `active` is null. */
export function fight(round: number, active: string | null = "e1"): Encounter {
  return { rev: 1, round, activeEntryId: active, entries: [entry("e1", { tokenId: "gob", value: 15 }), entry("e2", { tokenId: "bree-t", value: 5, tieOrder: 1 })] };
}

export function base(overrides: Partial<RoomState> = {}): RoomState {
  return room({
    characters: { bree: character("bree", { name: "Bree", actor: { ...character("x").actor, hp: { cur: 5, max: 20, temp: 0 } } }) },
    tokens: { gob: token("gob"), "bree-t": token("bree-t", { kind: "pc", name: "Bree", actor: { ref: "bree" }, ownerIds: ["p1"] }) },
    ...overrides,
  });
}

export function withClock(t: number, overrides: Partial<RoomClock> = {}, state: Partial<RoomState> = {}): RoomState {
  return base({ clock: { id: "c1", rev: 1, t, shown: true, calendar: DAYS, ...overrides }, ...state });
}

export function restore(state: RoomState, entries: RestoreEntry[], from: "undo" | "redo", seq: number, opts: { scope?: "play" | "setup"; who?: Viewer; opVersion?: number; gate?: boolean } = {}): Applied {
  const op: OpOf<"sys.restore"> & RestoreHistoryFields = {
    t: "sys.restore",
    entries,
    from,
    deps: true,
    ...(opts.gate === false ? {} : { scope: opts.scope ?? "play", correction: { label: "moving the clock on 8 hours" } }),
  };
  return run(state, op, seq, opts.who ?? DM, opts.opVersion);
}
