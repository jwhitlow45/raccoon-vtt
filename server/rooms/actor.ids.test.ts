import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { sealedId, uuidv7 } from "#shared/ids.ts";
import type { Op } from "#shared/protocol.ts";
import { actor, character, room } from "#shared/testutil.ts";
import { ID_TAKEN } from "./createIds.ts";
import { scopeActor, type ScopeClient } from "./undoScopeTesting.ts";

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
