import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canApply } from "./permissions.ts";
import { clientMessageSchema, clientOpSchema, opSchema, serverMessageSchema, type Op } from "./protocol.ts";
import { DM, P1, room } from "./testutil.ts";
import { historyCommandSchema, type HistoryMessage, type StackHistoryCommand } from "./undoContract.ts";

const HEAD = "018f1234-5678-7000-8000-000000000001";
const EMPTY = { head: null, depth: 0 };

describe("scoped history protocol wiring", () => {
  test("acknowledgment details are optional and hello accepts only an explicit true capability", () => {
    const hello = { t: "hello", clientId: "ack-capability", resumeFrom: 1 };
    assert.equal(clientMessageSchema.safeParse(hello).success, true);
    assert.equal(clientMessageSchema.safeParse({ ...hello, ackDetails: true }).success, true);
    for (const ackDetails of [false, 1, "true", null]) assert.equal(clientMessageSchema.safeParse({ ...hello, ackDetails }).success, false);
    const event = { t: "ev", seq: 1, changes: [], acks: [1] };
    assert.equal(serverMessageSchema.safeParse(event).success, true);
    const detail = { n: 1, scope: "setup", changed: false };
    assert.equal(serverMessageSchema.safeParse({ ...event, ackDetails: [detail] }).success, true);
    assert.equal(serverMessageSchema.safeParse({ ...event, ackDetails: [{ ...detail, label: "secret" }] }).success, false);
  });

  for (const command of [
    { t: "undo", head: HEAD },
    { t: "undo", scope: "setup", head: HEAD },
    { t: "redo", scope: "setup", head: HEAD, forget: 12 },
    { t: "undo", head: HEAD, of: 3 },
    { t: "redo", scope: "play", head: HEAD },
    { t: "undo", log: "1:0" },
    { t: "redo", scope: "setup", head: HEAD, discard: true },
  ] as const) {
    test(`the live client parser accepts ${JSON.stringify(command)}`, () => {
      assert.equal(historyCommandSchema.safeParse(command).success, true);
      const parsed = clientOpSchema.safeParse(command);
      assert.equal(parsed.success, true, JSON.stringify(parsed.error));
      if (parsed.success) assert.deepEqual(parsed.data, command);
    });
  }

  for (const command of [{ t: "undo" }, { t: "redo" }, { t: "undo", of: 4 }]) {
    test(`bare ${JSON.stringify(command)} refuses with the reload message`, () => {
      const parsed = clientOpSchema.safeParse(command);
      assert.equal(parsed.success, false, "legacy stack command must never consume a fresh head");
      if (!parsed.success) assert.ok(parsed.error.issues.some((issue) => issue.message === "Reload to use Undo"));
    });
  }

  test("groupScope is accepted with a group and refused without one", () => {
    const message = { t: "op", n: 1, g: "mixed-grid", groupScope: "setup", op: { t: "view.follow", follow: true } };
    assert.equal(clientMessageSchema.safeParse(message).success, true);
    const { g: _group, ...withoutGroup } = message;
    assert.equal(clientMessageSchema.safeParse(withoutGroup).success, false);
  });

  test("server messages admit committed private histories without extending existing envelopes", () => {
    const history: HistoryMessage = { t: "history", epoch: HEAD, seq: 3, serial: 1, watermark: 7, play: { undo: EMPTY, redo: EMPTY }, setup: { undo: EMPTY, redo: EMPTY } };
    assert.equal(serverMessageSchema.safeParse(history).success, true);
    assert.equal(clientMessageSchema.safeParse({ t: "hello", clientId: "old-page", resumeFrom: 1 }).success, true);
    assert.equal(serverMessageSchema.safeParse({ t: "ev", seq: 3, changes: [], rejects: [{ n: 7, code: "invalid", message: "Reload to use Undo" }] }).success, true);
  });

  test("stored scoped restores need no live head, and empty restores remain forbidden in batch A", () => {
    const restore = { t: "sys.restore", entries: [{ key: "token:t1", value: null, expectRev: null }], from: "undo", scope: "setup", correction: { label: "changing a sheet" }, deps: true };
    assert.equal(opSchema.safeParse(restore).success, true);
    assert.equal(opSchema.safeParse({ ...restore, entries: [] }).success, false);
  });

  test("players cannot select Setup or Discard, while ordinary Play remains permitted", () => {
    const state = room();
    const allowed = (op: unknown, who = P1) => canApply(op as Op, who, state, { canUseAsset: () => true });
    const play: StackHistoryCommand = { t: "undo", head: HEAD };
    assert.equal(allowed(play).ok, true);
    assert.equal(allowed({ ...play, scope: "setup" }).ok, false);
    assert.equal(allowed({ ...play, discard: true }).ok, false);
    assert.equal(allowed({ ...play, scope: "setup" }, DM).ok, true);
  });
});
