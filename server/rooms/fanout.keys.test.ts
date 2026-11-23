import assert from "node:assert/strict";
import { test } from "node:test";
import { ID_TIME_REFUSED, sealedId, sealedTime } from "#shared/ids.ts";
import { room } from "#shared/testutil.ts";
import { DEVELOPMENT_ROOM_SECRET_KEY } from "../config.ts";
import { clientKey, Connection } from "./connection.ts";
import { publishBatch, rejectsFor, takeKeptRejects } from "./fanout.ts";
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

test("a refusal's ids reach a keyed socket, live and kept for its next snapshot, and never a socket that did not ask", () => {
  const state = room();
  const sent = new Map<string, unknown[]>();
  const socket = (name: string) => {
    const frames: unknown[] = [];
    sent.set(name, frames);
    const raw = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => frames.push(JSON.parse(text)), close() {}, terminate() {} };
    return new Connection(raw as never, { sessionId: name, roomId: "UNDOSCOPE", memberId: "dm1", role: "dm" }, "203.0.113.9");
  };
  const keyed = socket("keyed");
  keyed.sealIds = true;
  const older = socket("older");
  for (const conn of [keyed, older]) {
    conn.clientId = conn.sessionId;
    conn.held = null;
  }
  const refusal = { n: 3, code: "invalid" as const, message: ID_TIME_REFUSED, ids: ["0190f0a8-6c1e-7a4b-9c3d-000000000001"] };
  const batch = { pub: 1, before: state, after: state, touched: [], global: false, acks: new Map(), restored: new Map(), rejects: new Map([[clientKey("keyed", "keyed"), [refusal]], [clientKey("older", "older"), [refusal]]]) };
  const current = (key: string) => (key === clientKey("keyed", "keyed") ? keyed : key === clientKey("older", "older") ? older : undefined);
  // Neither socket holds a snapshot: each keeps the refusal for the one it waits on.
  publishBatch(batch, [keyed, older], current);
  assert.deepEqual(takeKeptRejects(keyed), [refusal]);
  assert.deepEqual(takeKeptRejects(older), [{ n: 3, code: "invalid", message: ID_TIME_REFUSED }]);
  assert.deepEqual(rejectsFor({ sealIds: false }, [refusal]), [{ n: 3, code: "invalid", message: ID_TIME_REFUSED }]);
  assert.deepEqual(rejectsFor({ sealIds: true }, [refusal]), [refusal]);
});
