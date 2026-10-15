import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { actor, character, DM, room, token } from "#shared/testutil.ts";
import { LocalServer } from "../../dev/localServer.ts";
import { createRoomStore } from "../../state/store.ts";
import { FakeClock, FakeOutbox } from "../../state/testing.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { answerAsk, answerLabel, askOp, closedAskText, editAsk, emptyDraft, pendingAskCloseText, sendLabel, type AskSheet } from "./logic.ts";

/** The DM's store against a local server whose answers arrive only when the test delivers them: a slow acknowledgment. */
function setup(state: RoomState) {
  const outbox = new FakeOutbox();
  const server = new LocalServer(structuredClone(state), DM, "s1");
  const store = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock(), random: () => 0.5, clientId: "c1" });
  store.setOutbox(outbox);
  store.applySnapshot(server.hello({ resumeFrom: store.prepareHello().resumeFrom, sceneId: "s1" }));
  const deliver = () => {
    const ops = outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
    outbox.sent = [];
    for (const msg of server.batch(ops) as ServerMessage[]) {
      if (msg.t === "ev") store.applyEv(msg);
      else if (msg.t === "snapshot") store.applySnapshot(msg);
    }
  };
  return { store, server, deliver };
}

function party(): RoomState {
  return room({
    characters: { ayla: character("ayla", { name: "Ayla", ownerIds: ["p1"] }) },
    tokens: { a1: token("a1", { kind: "pc", sceneId: "s1", actor: { ref: "ayla" } }), goblin: token("goblin", { sceneId: "s1", actor: { inline: actor() } }) },
  });
}

/** Sends the sheet's request as the sheet does: locked until the answer, which closes it or unlocks it with the reason. */
function send(t: ReturnType<typeof setup>, sheet: AskSheet, id: string) {
  const check = askOp(sheet.draft, id, 0);
  assert.ok(check.ok);
  const heard: { answer?: OpAnswer; refusal?: OpRefusal } = {};
  assert.notEqual(t.store.dispatch(check.op, { quiet: true, onAnswer: (answer, refusal) => Object.assign(heard, { answer, refusal }) }), null);
  return { sheet: { ...sheet, sending: true, error: null }, heard };
}

describe("the request sheet while the server has not answered", () => {
  test("it is locked, an edit made meanwhile changes nothing, and the late acknowledgment closes it on what was sent", () => {
    const t = setup(party());
    const start: AskSheet = { draft: { ...emptyDraft([{ characterId: "ayla" }]), dc: "15" }, sending: false, error: null };
    const { sheet, heard } = send(t, start, "r1");
    assert.equal(sendLabel(sheet.sending, true), "Sending…");
    assert.equal(sendLabel(sheet.sending, false), "Waiting for the connection to send…", "offline, it says what it waits for");
    assert.equal(heard.answer, undefined, "no answer yet");
    const edited = editAsk(sheet, { dc: "20", note: "too late", ticked: [] });
    assert.equal(edited, sheet, "the DC, the note and the targets stay as sent");
    t.deliver();
    assert.equal(heard.answer, "taken");
    assert.deepEqual(answerAsk(edited, heard.answer!, heard.refusal), { close: true });
    const asked = t.store.store.getState().view?.rolls.r1;
    assert.equal(asked?.dc, 15);
    assert.equal(asked?.note, undefined);
    assert.deepEqual(asked?.targets.map((x) => x.characterId), ["ayla"]);
  });

  test("a refusal arriving late unlocks the sheet with the reason and keeps what the DM set up", () => {
    const t = setup(party());
    // A creature no player plays: the server refuses the whole request.
    const start: AskSheet = { draft: { ...emptyDraft([{ tokenId: "goblin" }]), note: "against the poison" }, sending: false, error: null };
    const { sheet, heard } = send(t, start, "r2");
    t.deliver();
    assert.equal(heard.answer, "refused");
    const after = answerAsk(sheet, heard.answer!, heard.refusal);
    assert.equal(after.close, false);
    assert.ok(!after.close && after.sheet.error, "the reason shows");
    assert.ok(!after.close && after.sheet.sending === false, "unlocked");
    assert.equal(!after.close && after.sheet.draft.note, "against the poison", "the setup is kept");
    assert.ok(!after.close && editAsk(after.sheet, { dc: "12" }).draft.dc === "12", "and the DM can fix it");
  });
});

describe("the request sheet closed while its request is sending (W5UI-15)", () => {
  test("closing says the request still goes out, online or not", () => {
    assert.equal(pendingAskCloseText(true), "The request is still sending.");
    assert.equal(pendingAskCloseText(false), "The request will send when the connection is back.");
  });

  test("a refusal arriving after the sheet closed still reaches the DM, with the reason", () => {
    const t = setup(party());
    const start: AskSheet = { draft: emptyDraft([{ tokenId: "goblin" }]), sending: false, error: null };
    // Sent, then the sheet closes before the server answers: only the toast is left to say what happened.
    const { heard } = send(t, start, "r3");
    t.deliver();
    assert.equal(heard.answer, "refused");
    assert.equal(closedAskText(heard.answer!, heard.refusal), "The request was not sent. Only creatures a player plays can be asked to roll.");
  });

  test("a request that went out says nothing, and one whose answer was lost says to check the cards", () => {
    const t = setup(party());
    const { heard } = send(t, { draft: emptyDraft([{ characterId: "ayla" }]), sending: false, error: null }, "r4");
    t.deliver();
    assert.equal(heard.answer, "taken");
    assert.equal(closedAskText(heard.answer!, heard.refusal), null);
    assert.match(closedAskText("unknown") ?? "", /may not have gone out/);
    assert.equal(closedAskText("refused"), "The request was not sent.");
  });
});

describe("a player's Send while the answer waits (LP5-ROLLS-11)", () => {
  test("offline it says it waits for the connection, as the DM's sheet does", () => {
    assert.equal(answerLabel(false, true, false), "Send");
    assert.equal(answerLabel(false, false, true), "Change");
    assert.equal(answerLabel(true, true, false), "Sending…");
    assert.equal(answerLabel(true, false, true), "Waiting for the connection to send…");
  });
});
