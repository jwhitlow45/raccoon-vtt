import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectState } from "../project.ts";
import { applyOp } from "../reducer.ts";
import { character, drawing, env, room, template, token } from "../testutil.ts";
import type { Handout, Viewer } from "../model.ts";

const SERVER: Viewer = { memberId: "server", role: "dm" };

describe("sys.memberRemove", () => {
  test("takes the member off the roster and lets go of everything it owned", () => {
    const state = room();
    state.tokens.shared = token("shared", { ownerIds: ["p1", "p2"] });
    state.tokens.own = token("own", { ownerIds: ["p2"] });
    state.characters.c1 = character("c1", { ownerIds: ["p2"] });
    state.templates.t1 = template("t1", { ownerId: "p2" });
    state.templates.t2 = template("t2", { ownerId: "p1" });
    state.drawings.d1 = drawing("d1", { ownerId: "p2" });
    state.drawings.d2 = drawing("d2", { ownerId: "dm1" });
    const result = applyOp(state, { t: "sys.memberRemove", memberId: "p2" }, SERVER, env(1));
    assert.ok(result.ok);
    const next = result.state;
    assert.equal(next.members.p2, undefined);
    assert.deepEqual(next.tokens.shared?.ownerIds, ["p1"]);
    assert.deepEqual(next.tokens.own?.ownerIds, []);
    assert.deepEqual(next.characters.c1?.ownerIds, []);
    assert.deepEqual(Object.keys(next.templates), ["t2"]);
    assert.deepEqual(Object.keys(next.drawings), ["d2"]);
    // Members and ownership changed, so every projection is redone.
    assert.equal(result.global, true);
    assert.equal(result.touched.includes("member:p2"), true);
  });

  test("takes the member off the players chosen to move any token", () => {
    const state = room();
    state.meta.settings.playersMoveAny = ["p1", "p2"];
    const result = applyOp(state, { t: "sys.memberRemove", memberId: "p2" }, SERVER, env(1));
    assert.ok(result.ok);
    assert.deepEqual(result.state.meta.settings.playersMoveAny, ["p1"]);
    state.meta.settings.playersMoveAny = "all";
    const all = applyOp(state, { t: "sys.memberRemove", memberId: "p2" }, SERVER, env(1));
    assert.ok(all.ok && all.state.meta.settings.playersMoveAny === "all");
  });

  test("drops the member from handout recipients, closes a handout left with none, and says it was removed", () => {
    const state = room();
    const handout = (id: string, to: Handout["to"]): Handout => ({ id, rev: 0, assetId: "a1", title: id, to, shownAt: "2026-10-12T00:00:00.000Z" });
    state.handouts = { only: handout("only", ["p2"]), both: handout("both", ["p1", "p2"]), all: handout("all", "all") };
    const joined = applyOp(state, { t: "sys.memberJoin", member: { id: "p3", name: "Quin", color: "#336699", kind: "player", createdAt: "2026-10-12T00:00:00.000Z" } }, SERVER, env(1));
    assert.ok(joined.ok);
    const result = applyOp(joined.state, { t: "sys.memberRemove", memberId: "p3" }, SERVER, env(2));
    assert.ok(result.ok);
    const removed = applyOp(result.state, { t: "sys.memberRemove", memberId: "p2" }, SERVER, env(3));
    assert.ok(removed.ok);
    const next = removed.state;
    assert.deepEqual(Object.keys(next.handouts).sort(), ["all", "both"]);
    assert.deepEqual(next.handouts.both?.to, ["p1"]);
    assert.equal(next.handouts.all?.to, "all");
    assert.deepEqual(removed.log.map((e) => e.data), [{ type: "member", memberId: "p2", action: "remove" }]);

    // Players keep the lines about members no longer on the roster: the join and the removal.
    const log = projectState(next, { memberId: "p1", role: "player" }, { sceneId: null }).log.map((e) => e.data);
    assert.deepEqual(log, [
      { type: "member", memberId: "p3", action: "join" },
      { type: "member", memberId: "p3", action: "remove" },
      { type: "member", memberId: "p2", action: "remove" },
    ]);
  });

  test("a member that is not there is gone", () => {
    const result = applyOp(room(), { t: "sys.memberRemove", memberId: "nobody" }, SERVER, env(1));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "gone");
  });
});
