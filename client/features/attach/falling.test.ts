import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Effect, RoomState, Token } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { actor, character, DM, effect, room, token } from "#shared/testutil.ts";
import { LocalServer } from "../../dev/localServer.ts";
import { createRoomStore } from "../../state/store.ts";
import { FakeClock, FakeOutbox } from "../../state/testing.ts";
import { fallAsk, fallReminders, fallRisks, fallText } from "./falling.ts";

/** Bree, p1's, riding the DM's warhorse, with her owl perched on her and a goblin the DM's ogre carries. */
function stable(): RoomState {
  const state = room();
  state.characters.bree = character("bree", { name: "Bree", ownerIds: ["p1"] });
  const list: Token[] = [
    token("bree", { name: "Bree", kind: "pc", actor: { ref: "bree" }, x: 5, y: 5, attached: { to: "horse", kind: "ride", steer: true } }),
    token("horse", { name: "Warhorse", size: "large", x: 5, y: 5 }),
    token("owl", { name: "Owl", size: "tiny", ownerIds: ["p1"], x: 5, y: 5, attached: { to: "bree", kind: "perch" } }),
    token("ogre", { name: "Ogre", size: "large", x: 9, y: 5 }),
    token("goblin", { name: "Goblin", size: "small", x: 9, y: 5, attached: { to: "ogre", kind: "ride" } }),
  ];
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));
  return state;
}

/** The room with an effect added: on a character's actor for a PC, else on the token's own. */
function withEffect(state: RoomState, tokenId: string, e: Effect): RoomState {
  const next = structuredClone(state);
  const t = next.tokens[tokenId]!;
  if ("ref" in t.actor) {
    const c = next.characters[t.actor.ref]!;
    c.actor = { ...c.actor, effects: [...c.actor.effects, e] };
  } else {
    t.actor = { inline: { ...t.actor.inline, effects: [...t.actor.inline.effects, e] } };
  }
  return next;
}

describe("the falling off reminder", () => {
  test("Prone or Unconscious landing on a rider, or on the mount it rides, reminds once for that ride", () => {
    const before = stable();
    assert.deepEqual(fallRisks(before, withEffect(before, "bree", effect("p", { key: "prone" }))), [{ riderId: "bree", mountId: "horse" }]);
    assert.deepEqual(fallRisks(before, withEffect(before, "horse", effect("u", { key: "unconscious" }))), [{ riderId: "bree", mountId: "horse" }]);
    assert.deepEqual(fallRisks(before, withEffect(before, "ogre", effect("p", { key: "prone" }))), [{ riderId: "goblin", mountId: "ogre" }], "any ride, controlled or not");
  });

  test("a familiar's holder going Prone, another condition, a condition already there, or one taken off reminds of nothing", () => {
    const before = stable();
    const perch = withEffect(before, "owl", effect("p", { key: "prone" }));
    assert.deepEqual(fallRisks(before, perch), [], "the owl perches, it does not ride");
    assert.deepEqual(fallRisks(before, withEffect(before, "bree", effect("b", { key: "blessed" }))), []);
    const down = withEffect(before, "bree", effect("p", { key: "prone" }));
    assert.deepEqual(fallRisks(down, withEffect(down, "bree", effect("u", { key: "unconscious" }))), [{ riderId: "bree", mountId: "horse" }], "Unconscious is a new landing");
    assert.deepEqual(fallRisks(down, structuredClone(down)), [], "nothing new landed");
    assert.deepEqual(fallRisks(down, before), [], "Prone taken off");
  });

  test("a ride that is new in the change, or a token that is, has nothing to fall from yet", () => {
    const before = stable();
    const { attached: _was, ...walking } = before.tokens.bree!;
    const unmounted = structuredClone(before);
    unmounted.tokens.bree = walking;
    assert.deepEqual(fallRisks(unmounted, withEffect(before, "bree", effect("p", { key: "prone" }))), []);
    const added = structuredClone(before);
    added.tokens.mule = token("mule", { name: "Mule", size: "large", x: 1, y: 1, actor: { inline: actor({ effects: [effect("p", { key: "prone" })] }) } });
    added.tokens.rider = token("rider", { name: "Rider", x: 1, y: 1, attached: { to: "mule", kind: "ride" } });
    assert.deepEqual(fallRisks(before, added), []);
  });

  test("the toast's words, and Ask for the save only when a player plays the rider", () => {
    const state = stable();
    assert.equal(fallText(state.tokens.bree!, state.tokens.horse!), "Bree may fall off Warhorse: DC 10 Dexterity save.");
    assert.deepEqual(fallAsk(state, state.tokens.bree!), { kind: "selection", tokenIds: ["bree"], fill: { test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 10 } });
    assert.equal(fallAsk(state, state.tokens.goblin!), null, "the DM rolls a goblin's save");
  });

  test("the DM's device reminds once, of what the server took, and never for a snapshot or on a player's", () => {
    const before = stable();
    const after = withEffect(before, "horse", effect("p", { key: "prone" }));
    const dm = { role: "dm" as const };
    assert.deepEqual(
      fallReminders({ you: dm, snapshots: 1, confirmed: after }, { you: dm, snapshots: 1, confirmed: before }).map((r) => r.text),
      ["Bree may fall off Warhorse: DC 10 Dexterity save."],
    );
    assert.deepEqual(fallReminders({ you: dm, snapshots: 2, confirmed: after }, { you: dm, snapshots: 1, confirmed: before }), [], "a snapshot is history");
    assert.deepEqual(fallReminders({ you: dm, snapshots: 1, confirmed: after }, { you: dm, snapshots: 1, confirmed: after }), [], "a change of the view alone, such as a prediction");
    assert.deepEqual(fallReminders({ you: { role: "player" }, snapshots: 1, confirmed: after }, { you: { role: "player" }, snapshots: 1, confirmed: before }), []);
    assert.deepEqual(fallReminders({ you: dm, snapshots: 1, confirmed: after }, { you: dm, snapshots: 1, confirmed: null }), [], "the first state there is");
  });

  test("through the DM's store and the real reducer: one toast when the server takes Prone, none at load, after a reconnect or for the prediction", () => {
    const server = new LocalServer(structuredClone(stable()), DM, "s1");
    const store = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock(), random: () => 0.5, clientId: "c1" });
    const outbox = new FakeOutbox();
    store.setOutbox(outbox);
    const heard: string[] = [];
    store.store.subscribe((now, prev) => heard.push(...fallReminders(now, prev).map((r) => r.text)));
    const connect = () => store.applySnapshot(server.hello({ resumeFrom: store.prepareHello().resumeFrom, sceneId: "s1" }));
    const deliver = () => {
      const ops = outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
      outbox.sent = [];
      for (const msg of server.batch(ops)) if (msg.t === "ev") store.applyEv(msg);
    };
    const prone: ClientOp = { t: "actor.effect.add", target: { tokenId: "horse" }, effect: { id: "fx-prone", key: "prone" } };
    connect();
    assert.deepEqual(heard, [], "the room as it loads is history");
    store.dispatch(prone);
    assert.deepEqual(heard, [], "the prediction shows Prone, and the reminder waits for the server");
    deliver();
    assert.deepEqual(heard, ["Bree may fall off Warhorse: DC 10 Dexterity save."]);
    connect();
    assert.equal(heard.length, 1, "a reconnect's snapshot reminds of nothing again");
  });
});
