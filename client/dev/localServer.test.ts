import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyChanges, projectState, type ProjectedState } from "#shared/project.ts";
import { DM, P1, room } from "#shared/testutil.ts";
import { LocalServer } from "./localServer.ts";

describe("the dev room's fan-out (client/dev/localServer.ts)", () => {
  test("keeps a player's live log as the room projects it when their whispers move where it starts", () => {
    const server = new LocalServer(room(), P1, "s1");
    let view = server.hello({ resumeFrom: 1, sceneId: "s1" }).state as ProjectedState;
    for (let i = 0; i < 70; i++) {
      // The DM chats, then whispers P1, so P1's whispers fill their ring and their live log starts later.
      for (const op of [{ t: "log.chat" as const, text: `c${i}` }, { t: "log.whisper" as const, to: ["p1"], text: `w${i}` }]) {
        const ev = server.external(op, DM);
        if (!ev) continue;
        const changed = ev.changes.map((c) => c.key);
        assert.deepEqual(changed, [...changed].sort(), "changes in key order, as the actor's fan-out sends them");
        view = applyChanges(view, ev.changes);
      }
    }
    const expected = projectState(server.state, P1, { sceneId: "s1" }).log;
    assert.ok(expected[0]!.kind === "whisper" && expected.length < 140, "the live log starts at P1's oldest kept whisper");
    assert.deepEqual(view.log, expected);
  });
});
