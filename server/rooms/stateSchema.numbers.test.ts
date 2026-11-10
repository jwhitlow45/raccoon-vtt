import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { room, scene, token } from "#shared/testutil.ts";
import { parseRoomState } from "./stateSchema.ts";

/** A room whose scene has given Goblin two numbers in group 2, as JSON carries it. */
function numberedRoom(overrides: Partial<RoomState> = {}): RoomState {
  const names: Record<string, [number, number]> = { Goblin: [2, 2], ["__proto__"]: [1, 1] };
  const state = room({
    scenes: { s1: scene("s1", { numbers: { names } }), s2: scene("s2", { order: 1 }) },
    tokens: { g1: token("g1", { met: 2, number: 1 }), g2: token("g2", { met: 2, number: 2 }) },
    numbering: { rev: 3, groups: 2 },
    ...overrides,
  });
  return JSON.parse(JSON.stringify(state)) as RoomState;
}

function refusal(state: unknown): string {
  const parsed = parseRoomState(state);
  assert.ok(!parsed.ok, "the backup should be refused");
  return parsed.message;
}

describe("creature numbers in the stored-state schema", () => {
  test("a room with numbers parses whole, a name like __proto__ kept as an own entry", () => {
    const state = numberedRoom();
    const parsed = parseRoomState(state);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.deepEqual(parsed.state.numbering, { rev: 3, groups: 2 });
    assert.deepEqual(parsed.state.tokens.g2!.met, 2);
    assert.ok(Object.hasOwn(parsed.state.scenes.s1!.numbers!.names, "__proto__"));
    assert.equal(Object.getPrototypeOf(parsed.state.scenes.s1!.numbers!.names), Object.prototype);
    assert.equal(JSON.stringify(parsed.state.scenes.s1!.numbers), JSON.stringify(state.scenes.s1!.numbers));
  });

  test("a count below a scene's group id or a creature's mark is refused", () => {
    assert.match(refusal(numberedRoom({ numbering: { rev: 1, groups: 1 } })), /^scenes\.s1\.numbers: /);
    assert.match(refusal(numberedRoom({ numbering: undefined, scenes: { s1: scene("s1") } })), /^tokens\.g1\.met: /);
    const state = numberedRoom();
    delete state.numbering;
    assert.match(refusal(state), /below a group id/);
  });

  test("a room from before numbers parses with none", () => {
    const parsed = parseRoomState(JSON.parse(JSON.stringify(room({ tokens: { g1: token("g1", { number: 3 }) } }))));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.equal(parsed.state.numbering, undefined);
  });

  test("an entry's count and group id stay in bounds, and a scene holds at most 100 names", () => {
    const names = (entries: Record<string, [number, number]>) => numberedRoom({ scenes: { s1: scene("s1", { numbers: { names: entries } }) }, tokens: {} });
    refusal(names({ Goblin: [1, 0] }));
    refusal(names({ Goblin: [1, 10_001] }));
    refusal(names({ Goblin: [0, 1] }));
    refusal(names(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`Name ${i}`, [1, 1] as [number, number]]))));
    assert.ok(parseRoomState(names(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`Name ${i}`, [1, 1] as [number, number]])))).ok);
  });
});
