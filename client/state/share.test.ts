import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createInitialState } from "#shared/initial.ts";
import type { LogEntry, RoomState } from "#shared/model.ts";
import { AT, member, randomState, rng } from "#shared/testutil.ts";
import { shareState } from "./share.ts";

const line = (id: string): LogEntry => ({ id, at: AT, kind: "event", data: { type: "trapSeen", by: [], message: "Click." } });

/**
 * A room with every field a new room starts with and a line in each of its
 * lists, so a list added to the room later is read here without naming it.
 */
function fullRoom(): RoomState {
  const state: RoomState = { ...createInitialState({ roomName: "Full", dm: member("dm1", "dm"), now: AT }), ...randomState(rng(7)) };
  for (const [key, value] of Object.entries(state)) if (Array.isArray(value)) (state as Record<string, unknown>)[key] = [...value, line(`${key}:1`)];
  return state;
}

const lists = (state: RoomState) => Object.entries(state).filter(([, value]) => Array.isArray(value)).map(([key]) => key);

describe("shareState", () => {
  test("every list of a full room stays a list, its equal lines keeping their identity, when a snapshot brings them again", () => {
    const prev = fullRoom();
    assert.ok(lists(prev).length >= 4, "the room holds its lists");
    // Off the wire, as a second snapshot brings it: every line a new object equal to the one the view keeps.
    const next = JSON.parse(JSON.stringify(prev)) as RoomState;
    for (const key of lists(next)) ((next as Record<string, unknown>)[key] as LogEntry[]).push(line(`${key}:2`));
    const out = shareState(prev, next) as Record<string, unknown>;
    for (const key of lists(prev)) {
      const was = (prev as Record<string, unknown>)[key] as unknown[];
      const now = out[key];
      assert.ok(Array.isArray(now), `${key} is still a list`);
      assert.equal(now.length, was.length + 1, `${key} has its new line`);
      assert.equal(now[was.length - 1], was[was.length - 1], `${key}'s equal line keeps its identity`);
    }
  });

  test("a list the room did not have when this was written stays a list", () => {
    const prev = { ...fullRoom(), later: [line("1:0")] } as RoomState;
    const next = { ...(JSON.parse(JSON.stringify(prev)) as RoomState), later: [line("1:0"), line("2:0")] } as RoomState;
    const out = shareState(prev, next) as RoomState & { later: unknown };
    assert.ok(Array.isArray(out.later));
    assert.equal(out.later[0], (prev as RoomState & { later: LogEntry[] }).later[0]);
  });
});
