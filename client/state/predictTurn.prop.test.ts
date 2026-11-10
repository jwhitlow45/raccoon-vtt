import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { holds } from "#shared/propertyTestutil.ts";
import type { ClientOp, Op, ServerMessage } from "#shared/protocol.ts";
import { TURN_OPS } from "#shared/reads.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, actor, character, env, room, token } from "#shared/testutil.ts";
import { LocalServer } from "../dev/localServer.ts";
import { openRecord } from "../features/combat/logic.ts";
import { turnOp } from "../features/encounter/logic.ts";
import { createRoomStore, turnPending, type RoomStore } from "./store.ts";
import { applyTestHistory, FakeClock, FakeOutbox } from "./testing.ts";
import type { OpAnswer, OpRefusal } from "./types.ts";

/*
 * Random runs of a DM's device in a fight: its own Next, Previous and
 * deletes, answers that come, are refused or are lost to a reconnect, and
 * another DM's turn changes and unrelated ops between them. Named
 * invariants, checked after every event:
 *
 * - SHOWN: the device's view never differs from its confirmed copy in
 *   which turn runs, so no key or record it holds is one it minted.
 * - IDLE: with no op of TURN_OPS pending, nothing waits.
 * - RECORD: a record action is sent only while nothing waits, and never
 *   with a record the server has already ended.
 * - SETTLED: once every answer is in, the device's turn is the server's.
 */

const CO_DM: Viewer = { memberId: "dm2", role: "dm" };

type Event =
  | { k: "next" | "prev" | "deleteGoblin" | "deleteMissing" | "deliver" | "lose" | "reconnect" | "coNext" | "coPrev" | "coChat" | "coHp" | "record" };

const event: fc.Arbitrary<Event> = fc.constantFrom<Event["k"]>("next", "next", "prev", "deleteGoblin", "deleteMissing", "deliver", "deliver", "deliver", "lose", "reconnect", "coNext", "coPrev", "coChat", "coHp", "record", "record").map((k) => ({ k }));

/** Dragon, Thorn (dying, on a token row or his character alone), Troll and Goblin, the dragon acting. */
function fight(rows: "token" | "character"): RoomState {
  let state = room({
    tokens: {
      dragon: token("dragon", { name: "Dragon" }),
      troll: token("troll", { name: "Troll", x: 4, y: 2, actor: { inline: actor({ hp: { cur: 80, max: 94, temp: 0 } }) } }),
      goblin: token("goblin", { name: "Goblin", x: 6, y: 2 }),
      ...(rows === "token" ? { thorn: token("thorn", { kind: "pc", name: "Thorn", x: 8, y: 2, actor: { ref: "thorn" } }) } : {}),
    },
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ hp: { cur: 0, max: 30, temp: 0 }, life: "dying", deathSaves: { ok: 0, fail: 0 } }) }) },
  });
  state.meta.settings = { ...state.meta.settings, monstersDieAtZero: false };
  const thorn = rows === "token" ? { tokenId: "thorn" } : { characterId: "thorn" };
  let seq = 0;
  for (const op of [
    { t: "encounter.start", entries: [{ id: "ed", tokenId: "dragon", value: 20 }, { id: "et", ...thorn, value: 15 }, { id: "er", tokenId: "troll", value: 12 }, { id: "eg", tokenId: "goblin", value: 5 }] },
    { t: "encounter.next" },
  ] as Op[]) {
    const result = applyOp(state, op, DM, env(++seq));
    assert.ok(result.ok, op.t);
    state = result.state;
  }
  return state;
}

function receive(room: RoomStore, msg: ServerMessage): void {
  if (msg.t === "ev") room.applyEv(msg);
  else if (msg.t === "snapshot") room.applySnapshot(msg);
  else if (msg.t === "retry" && msg.n !== undefined) room.retryOps(msg.n);
}

function turnIdentity(state: Pick<RoomState, "encounter" | "tokens" | "characters"> | null | undefined): string {
  const encounter = state?.encounter ?? null;
  const records: [string, number][] = [];
  for (const [id, t] of Object.entries(state?.tokens ?? {})) if ("inline" in t.actor && t.actor.inline.turnRecord) records.push([`token:${id}`, t.actor.inline.turnRecord.id]);
  for (const [id, c] of Object.entries(state?.characters ?? {})) if (c.actor.turnRecord) records.push([`character:${id}`, c.actor.turnRecord.id]);
  records.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify([encounter?.activeEntryId ?? null, encounter?.turnStart?.entryId ?? null, encounter?.turnStart?.seq ?? null, records]);
}

function run(rows: "token" | "character", events: readonly Event[]): void {
  const server = new LocalServer(fight(rows), DM, "s1");
  const outbox = new FakeOutbox();
  const room = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock(), random: () => 0.5, clientId: "c1" });
  room.setOutbox(outbox);
  const state = () => room.store.getState();
  const connect = () => {
    room.suspend();
    const hello = room.prepareHello();
    room.setConnection("open");
    room.applySnapshot(server.hello({ resumeFrom: hello.resumeFrom, sceneId: "s1" }));
    applyTestHistory(room, hello.resumeFrom - 1);
  };
  const sent = () => {
    const ops = outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
    outbox.sent = [];
    return ops;
  };
  const deliver = () => {
    for (const msg of server.batch(sent())) receive(room, msg);
  };
  const coDm = (op: Op) => {
    const ev = server.external(op, CO_DM);
    if (ev) receive(room, ev);
  };
  const recordAnswers: { answer: OpAnswer; refusal: OpRefusal | undefined }[] = [];
  /** Whether the socket is up: a lost answer drops it until the next reconnect. */
  let up = true;
  connect();
  for (const e of events) {
    switch (e.k) {
      case "next":
      case "prev":
        room.dispatch(turnOp(e.k === "next" ? "encounter.next" : "encounter.prev", state()));
        break;
      case "deleteGoblin":
        room.dispatch({ t: "token.delete", tokenId: "goblin" });
        break;
      case "deleteMissing":
        room.dispatch({ t: "token.delete", tokenId: "missing" }, { quiet: true });
        break;
      case "deliver":
        if (up) deliver();
        break;
      case "lose":
        // The server takes the batch, and the socket drops before its answer.
        server.batch(sent());
        room.suspend();
        up = false;
        break;
      case "reconnect":
        connect();
        up = true;
        break;
      case "coNext":
        coDm({ t: "encounter.next" });
        break;
      case "coPrev":
        coDm({ t: "encounter.prev" });
        break;
      case "coChat":
        coDm({ t: "log.chat", text: "meanwhile" });
        break;
      case "coHp":
        coDm({ t: "actor.hp", target: { tokenId: "troll" }, change: { kind: "damage", amount: 1 } });
        break;
      case "record": {
        if (!up) break;
        const view = state().view as unknown as RoomState | null;
        const record = view ? openRecord(view.encounter, view.characters.thorn?.actor, "deathSave", turnPending(state())) : undefined;
        if (record === "pending") {
          assert.equal(turnPending(state()), true, "RECORD: pending while nothing waits");
          break;
        }
        if (record === undefined) break;
        const op: ClientOp = { t: "actor.prompt", target: { characterId: "thorn" }, record, what: "deathSave", state: "skipped" };
        room.dispatch(op, { quiet: true, onAnswer: (answer, refusal) => recordAnswers.push({ answer, refusal }) });
        // Sent at once with whatever waits ahead of it, none of which changes the turn.
        deliver();
        break;
      }
    }
    const s = state();
    assert.equal(turnIdentity(s.view as unknown as RoomState), turnIdentity(s.confirmed as unknown as RoomState), `SHOWN after ${e.k}`);
    if (!s.pending.some((p) => TURN_OPS.has(p.op.t))) assert.equal(turnPending(s), false, `IDLE after ${e.k}`);
  }
  for (const a of recordAnswers) assert.notEqual(a.answer, "refused", `RECORD: refused, ${a.refusal?.message}`);
  connect();
  deliver();
  deliver();
  assert.equal(state().pending.length, 0);
  assert.equal(turnPending(state()), false, "SETTLED: nothing waits");
  assert.equal(turnIdentity(state().view as unknown as RoomState), turnIdentity(projectState(server.state, DM, { sceneId: "s1" }) as unknown as RoomState), "SETTLED: the server's turn");
}

test("random runs of turn changes, answers, reconnects and another DM keep every view to the confirmed turn", () => {
  holds(
    fc.property(fc.constantFrom("token" as const, "character" as const), fc.array(event, { minLength: 1, maxLength: 40 }), (rows, events) => run(rows, events)),
    300,
  );
});
