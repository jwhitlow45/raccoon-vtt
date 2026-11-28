import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "../model.ts";
import { opSchema, type Op } from "../protocol.ts";
import { opportunityNoticesOn } from "../rules/opportunity.ts";
import { DM, apply, room } from "../testutil.ts";
import { undoScope } from "../undoScope.ts";

/** The room's Opportunity Attack notices switch (docs/design/design-v1-opportunity-attacks.md 4), as the sound switches are tested. */

describe("Opportunity Attack notices (docs/design/design-v1-opportunity-attacks.md 4)", () => {
  const notices = (on: boolean): Op => ({ t: "room.update", settings: { opportunityNotices: on } });
  const run = (state: RoomState, op: Op) => apply(state, op, DM);

  test("room.update stores off as false and clears it on, a patch without it leaves it, and it is a Setup step", () => {
    const fresh = room();
    assert.equal("opportunityNotices" in fresh.meta.settings, false);
    assert.equal(opportunityNoticesOn(fresh.meta.settings), true, "absent reads on");
    const off = run(fresh, notices(false));
    assert.equal(off.meta.settings.opportunityNotices, false);
    assert.equal(opportunityNoticesOn(off.meta.settings), false);
    assert.equal(undoScope(notices(false), fresh), "setup");
    const other = run(off, { t: "room.update", settings: { skipDefeated: false } });
    assert.equal(other.meta.settings.opportunityNotices, false, "another setting's patch keeps it");
    const on = run(other, notices(true));
    assert.equal("opportunityNotices" in on.meta.settings, false);
    assert.deepEqual(run(fresh, notices(true)).meta.settings, fresh.meta.settings, "on in a room without it adds nothing");
  });

  test("the op parses with the switch, and a value that is not a boolean is refused", () => {
    assert.ok(opSchema.safeParse(notices(false)).success);
    assert.ok(opSchema.safeParse(notices(true)).success);
    assert.equal(opSchema.safeParse({ t: "room.update", settings: { opportunityNotices: "off" } }).success, false);
  });
});
