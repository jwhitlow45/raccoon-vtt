import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoomClock } from "#shared/model.ts";
import { dateHeading, partyRestOps } from "./ties.ts";

const clock: RoomClock = { id: "c1", rev: 0, t: 3 * 86_400 + 6 * 3_600, shown: true, calendar: { kind: "days" } };

describe("partyRestOps", () => {
  it("sends the advance first, then each rest", () => {
    const ops = partyRestOps(["a", "b"], true);
    assert.deepEqual(ops, [
      { t: "clock.advance", by: 8 * 3_600, why: "longRest" },
      { t: "actor.rest", target: { characterId: "a" }, kind: "long" },
      { t: "actor.rest", target: { characterId: "b" }, kind: "long" },
    ]);
  });
  it("sends only the rests when the box is unticked or there is no clock", () => {
    assert.deepEqual(
      partyRestOps(["a"], false).map((o) => o.t),
      ["actor.rest"],
    );
  });
});

describe("dateHeading", () => {
  it("reads the clock now as a heading", () => {
    assert.equal(dateHeading(clock, null), "### Day 4, 6:00 AM");
  });
  it("counts the running fight's rounds", () => {
    const fight = { round: 11, activeEntryId: null, started: true };
    assert.equal(dateHeading(clock, fight), "### Day 4, 6:01 AM");
  });
});
