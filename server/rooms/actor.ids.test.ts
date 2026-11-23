import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { sealedId, uuidv7 } from "#shared/ids.ts";
import type { Op } from "#shared/protocol.ts";
import { actor, character, room } from "#shared/testutil.ts";
import { ID_TAKEN } from "./createIds.ts";
import { Connection } from "./connection.ts";
import { scopeActor, until, type ScopeClient } from "./undoScopeTesting.ts";

/**
 * A group save's conditions are recorded without the gate's clock
 * (createIds.ts recordedRow): each one's row is held past every time it
 * reads to under any current member's key, so the member whose key made it
 * meets `gone` for as long as the clock would pass it again, whoever
 * applied the save.
 */

const T0 = Date.parse("2026-11-23T20:00:00.000Z");
const HOUR = 3_600_000;

async function open(t: TestContext) {
  const state = room();
  state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor() });
  const clock = { now: T0 };
  const { connect } = await scopeActor(t, state, { now: () => clock.now });
  const at = () => clock.now;
  const dm = await connect(state.members.dm1!, "dm", at, undefined, true);
  const p1 = await connect(state.members.p1!, "player", at, undefined, true);
  return { clock, dm, p1 };
}

const outcome = (id: string): Op => ({ t: "actor.outcome", plan: uuidv7(T0), label: "Hold Person", targets: [{ target: { characterId: "c1" }, effects: [{ id, key: "paralyzed" }] }] }) as Op;
const remove = (id: string): Op => ({ t: "actor.effect.remove", target: { characterId: "c1" }, effectId: id }) as Op;
const add = (id: string): Op => ({ t: "actor.effect.add", target: { characterId: "c1" }, effect: { id, key: "blessed" } }) as Op;

async function code(client: ScopeClient, op: Op): Promise<string> {
  const event = await client.send(op);
  return event.rejects?.find((r) => r.n === client.n)?.code ?? "taken";
}

describe("a recorded condition's row", () => {
  test("the DM's own condition sealed two hours ahead: once removed, a create of its id two hours on is gone", async (t) => {
    const r = await open(t);
    const id = sealedId(r.dm.idKey!, T0 + 2 * HOUR);
    assert.equal(await code(r.dm, outcome(id)), "taken");
    assert.equal(await code(r.dm, remove(id)), "taken");
    r.clock.now = T0 + 2 * HOUR;
    const event = await r.dm.send(add(id));
    assert.deepEqual(event.rejects?.map((x) => [x.code, x.message]), [["gone", ID_TAKEN]]);
  });

  test("a player's id two hours ahead, recorded by the DM: once removed, the player's create of it in its window is gone", async (t) => {
    const r = await open(t);
    const id = sealedId(r.p1.idKey!, T0 + 2 * HOUR);
    assert.equal(await code(r.dm, outcome(id)), "taken");
    assert.equal(await code(r.dm, remove(id)), "taken");
    for (const at of [T0 + 2 * HOUR - 5_000, T0 + 2 * HOUR + 29 * 60_000]) {
      r.clock.now = at;
      assert.equal(await code(r.p1, add(id)), "gone", `at ${(at - T0) / 60_000} minutes`);
    }
  });
});

type IdsAnswer = { t: "ids"; k: number; held: string[]; notHeld: string[]; pending: string[] };

/** The device's `ids` ask numbered `k`, and its answer once it comes. */
async function askIds(client: ScopeClient, k: number, ids: readonly string[], conn: Connection = client.conn, sent: readonly unknown[] = client.sent): Promise<IdsAnswer> {
  client.actor.ids(conn, { k, ids });
  return until(() => sent.find((m): m is IdsAnswer => (m as { t?: string }).t === "ids" && (m as IdsAnswer).k === k), `ids answer ${k}`);
}

describe("a device's ids ask", () => {
  test("an ask behind each of the device's ops joins that op's batch and is answered once it is stored, never pending while the device plays on", async (t) => {
    const r = await open(t);
    const id = uuidv7();
    for (let k = 1; k <= 5; k++) {
      void r.p1.actor.op(r.p1.conn, ++r.p1.n, { t: "log.chat", text: `chat ${k}` });
      const answer = await askIds(r.p1, k, [id]);
      assert.deepEqual([answer.held, answer.notHeld, answer.pending], [[], [id], []], `ask ${k}`);
      const acked = r.p1.sent.findIndex((m) => m.t === "ev" && m.acks?.includes(r.p1.n));
      assert.ok(acked >= 0 && acked < r.p1.sent.indexOf(answer as never), `ask ${k} answered after the op before it`);
    }
  });

  test("the device's old socket still open, or an ask past its socket's op rate, answers pending", async (t) => {
    const r = await open(t);
    const id = uuidv7();
    // A second socket of P1's device, under the same client: its ask waits while the first is open.
    const sent: unknown[] = [];
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text)), close() {}, terminate() {} };
    const again = new Connection(socket as never, { sessionId: r.p1.conn.sessionId, roomId: "UNDOSCOPE", memberId: r.p1.conn.memberId, role: "player" }, "203.0.113.9", { now: () => r.clock.now });
    r.p1.actor.attach(again);
    await r.p1.actor.hello(again, { clientId: r.p1.clientId, resumeFrom: r.p1.n + 1 });
    await until(() => sent.find((m) => (m as { t?: string }).t === "snapshot"), "the second socket's snapshot");
    assert.deepEqual((await askIds(r.p1, 1, [id], again, sent)).pending, [id], "the old socket is open");
    r.p1.actor.detach(r.p1.conn);
    r.p1.conn.close(1000);
    assert.deepEqual((await askIds(r.p1, 2, [id], again, sent)).notHeld, [id], "read once the old socket is gone");
    while (again.opRate.allow(1, r.clock.now)) {
      // the socket's whole burst
    }
    assert.deepEqual((await askIds(r.p1, 3, [id], again, sent)).pending, [id], "past the socket's op rate");
  });
});
