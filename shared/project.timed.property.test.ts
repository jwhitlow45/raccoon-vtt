import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { LIMITS } from "./limits.ts";
import type { Effect, RoomState, Viewer } from "./model.ts";
import { projectState, stableStringify } from "./project.ts";
import { P1, P2, actor, character, room, token } from "./testutil.ts";

/**
 * Twin rooms that differ only in a hidden clock's time, with every span's
 * end shifted alike, project alike to every player and a table display
 * (docs/design/design-v1-calendar-c2c3.md 4.4, 11): nothing a player gets
 * from a time span reads out a hidden clock. A blackout and a fight in
 * either twin change nothing of that.
 */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const BOUND = LIMITS.clockSecondsMax / 4;

const spans = fc.array(fc.record({ span: fc.integer({ min: 1, max: LIMITS.effectSpanMax / 60 }).map((m) => m * 60), left: fc.integer({ min: -LIMITS.effectSpanMax, max: LIMITS.effectSpanMax }), hidden: fc.boolean() }), { maxLength: 6 });

function twin(t: number, list: { span: number; left: number; hidden: boolean }[], blackout: boolean, round: number | null): RoomState {
  const effects: Effect[] = list.map((e, i) => ({ id: `e${i}`, key: "blessed", ends: { span: e.span, at: t + e.left, clock: "c1" }, ...(e.hidden ? { hiddenFromPlayers: true } : {}) }));
  return room({
    meta: { ...room().meta, view: { follow: false, blackout } },
    characters: { bree: character("bree", { ownerIds: ["p1"], actor: actor({ effects }) }) },
    tokens: { "bree-t": token("bree-t", { kind: "pc", actor: { ref: "bree" }, ownerIds: ["p1"] }), gob: token("gob", { actor: { inline: actor({ effects }) } }) },
    encounter: round === null ? null : { rev: 1, round, activeEntryId: null, started: true, entries: [] },
    clock: { id: "c1", rev: 4, t, shown: false, calendar: { kind: "days" } },
  });
}

test("a hidden clock's time never reaches a player or a display through a time span", () => {
  fc.assert(
    fc.property(fc.integer({ min: -BOUND, max: BOUND }), fc.integer({ min: -BOUND, max: BOUND }), spans, fc.boolean(), fc.option(fc.integer({ min: 1, max: 500 })), (t, shift, list, blackout, round) => {
      const a = twin(t, list, blackout, round);
      const b = twin(t + shift, list, blackout, round);
      for (const who of [P1, P2, DISPLAY]) {
        assert.equal(stableStringify(projectState(a, who, { sceneId: "s1" })), stableStringify(projectState(b, who, { sceneId: "s1" })), who.memberId);
      }
    }),
    { numRuns: 300 },
  );
});
