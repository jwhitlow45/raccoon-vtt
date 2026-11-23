import assert from "node:assert/strict";
import { test } from "node:test";
import { sealedId, sealedTime } from "#shared/ids.ts";
import { room } from "#shared/testutil.ts";
import { DEVELOPMENT_ROOM_SECRET_KEY } from "../config.ts";
import { RoomIdKeys } from "./idKeys.ts";
import { scopeActor, scopeObserver, type ScopeClient } from "./undoScopeTesting.ts";

/** The `you` of each snapshot a socket was sent. */
function yous(sent: readonly unknown[]): { memberId: string; idKey?: string }[] {
  return sent.flatMap((m) => ((m as { t?: string }).t === "snapshot" ? [(m as { you: { memberId: string; idKey?: string } }).you] : []));
}

test("a member's socket that asks gets its own member's id key with every snapshot, and a display, a preview and a socket that did not ask get none", async (t) => {
  const state = room();
  const { actor, connect } = await scopeActor(t, state);
  const keys = new RoomIdKeys(DEVELOPMENT_ROOM_SECRET_KEY, "UNDOSCOPE");
  const p1 = await connect(state.members.p1!, "player", undefined, undefined, true);
  const dm = await connect(state.members.dm1!, "dm", undefined, undefined, true);
  const old: ScopeClient = await connect(state.members.p2!, "player");
  const display = await scopeObserver(actor, { memberId: "display:abcdefghijkl", role: "player", display: true }, undefined, true);
  const preview = await scopeObserver(actor, { memberId: state.members.dm1!.id, role: "dm", previewOf: state.members.p1!.id }, undefined, true);

  assert.deepEqual(yous(p1.sent).map((y) => y.idKey), [keys.member("p1").text]);
  assert.deepEqual(yous(dm.sent).map((y) => y.idKey), [keys.member("dm1").text]);
  for (const [what, sent] of [["a socket that did not ask", old.sent], ["a display", display.sent], ["a preview", preview.sent]] as const) {
    assert.deepEqual(yous(sent).map((y) => y.idKey), [undefined], what);
    assert.ok(!JSON.stringify(sent).includes(keys.member("p1").text), `${what}: no frame holds P1's key`);
    assert.ok(!JSON.stringify(sent).includes(keys.server.text), `${what}: no frame holds the server's key`);
  }
  assert.ok(!JSON.stringify(p1.sent).includes(keys.member("p2").text) && !JSON.stringify(p1.sent).includes(keys.server.text), "P1 holds no other key");

  // A key read from the snapshot seals ids the room reads under P1's key alone.
  const id = sealedId(p1.idKey!, 1_700_000_000_000);
  assert.equal(sealedTime(keys.member("p1").key, id), 1_700_000_000_000);
  assert.equal(sealedTime(keys.member("p2").key, id), null);
});
