import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoomState, Viewer } from "#shared/model.ts";
import type { ClientOp, ServerMessage } from "#shared/protocol.ts";
import { character, DM, P1, room as roomState, scene } from "#shared/testutil.ts";
import { LocalServer } from "../dev/localServer.ts";
import { createRoomStore } from "./store.ts";
import { FakeClock, FakeOutbox } from "./testing.ts";

const SAVED = "Saved. Undo in Setup history.";
const rename: ClientOp = { t: "scene.update", sceneId: "s1", patch: { name: "The crypt" } };

function setup(state: RoomState = roomState(), viewer: Viewer = DM) {
  const room = createRoomStore({ roomId: "R1", you: viewer, clock: new FakeClock() });
  const server = new LocalServer(state, viewer, "s1");
  const outbox = new FakeOutbox();
  room.setOutbox(outbox);
  room.setConnection("open");
  room.applySnapshot(server.hello({ resumeFrom: 1, sceneId: "s1" }));
  const receive = (message: ServerMessage) => {
    if (message.t === "ev") room.applyEv(message);
  };
  const deliver = () => {
    const ops = outbox.sent.flatMap((message) => message.t === "op" ? [{ n: message.n, op: message.op }] : []);
    outbox.sent = [];
    const messages = server.batch(ops);
    messages.forEach(receive);
    return messages;
  };
  const notices = () => room.store.getState().toasts.filter((toast) => toast.text === SAVED);
  return { room, server, outbox, receive, deliver, notices };
}

test("Setup saves announce only after an acknowledgment, including editors with quiet errors", () => {
  for (const quiet of [false, true]) {
    const s = setup();
    s.room.dispatch(rename, { quiet });
    assert.equal(s.notices().length, 0, "optimistic state is not a confirmed save");
    s.deliver();
    assert.equal(s.notices().length, 1);
    s.room.dispose();
  }
});

test("a refusal, a no-effect save, and a player save never advertise Setup history", () => {
  const refused = setup();
  const n = refused.room.dispatch(rename)!;
  refused.room.applyEv({ t: "ev", seq: 1, changes: [{ key: "scene:s1", value: { ...refused.server.state.scenes.s1, name: "Another DM's edit" } }], rejects: [{ n, code: "invalid", message: "Changed elsewhere" }] });
  assert.equal(refused.notices().length, 0);
  refused.room.dispose();
  const same = setup();
  same.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { name: "s1" } });
  same.deliver();
  assert.equal(same.notices().length, 0, "a revision bump alone is not a saved change");
  same.room.dispose();
  const state = roomState({ characters: { c1: character("c1", { ownerIds: ["p1"] }) } });
  const player = setup(state, P1);
  player.room.dispatch({ t: "character.update", characterId: "c1", patch: { name: "Bree" } });
  player.deliver();
  assert.equal(player.server.state.characters.c1!.name, "Bree");
  assert.equal(player.notices().length, 0);
  player.room.dispose();
});

test("Play and None changes never advertise Setup history", () => {
  const s = setup();
  s.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { suggestedView: "isometric" } });
  s.deliver();
  assert.equal(s.notices().length, 0);
  s.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { thumb: null } });
  s.deliver();
  assert.equal(s.notices().length, 0);
  s.room.dispose();
});

test("classification uses the accepted before-state rather than the resulting state", () => {
  const state = roomState({ characters: { c1: character("c1") } });
  state.characters.c1!.actor.legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 };
  const s = setup(state);
  const max: ClientOp = { t: "character.update", characterId: "c1", patch: { actor: { legendary: { actionsMax: 4, actionsUsed: 0, resistMax: 3, resistUsed: 0 } } } };
  s.room.dispatch(max);
  s.deliver();
  assert.equal(s.notices().length, 1, "classifying the resulting state would incorrectly call this Play");
  s.room.ui.dismissToast(s.notices()[0]!.id);
  s.room.dispatch({ t: "character.update", characterId: "c1", patch: { actor: { legendary: { actionsMax: 4, actionsUsed: 1, resistMax: 3, resistUsed: 0 } } } });
  s.deliver();
  assert.equal(s.notices().length, 0, "spending a use stays Play");
  s.room.dispose();
});

test("an earlier accepted Play op supplies the next op's before-state", () => {
  const s = setup();
  s.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { suggestedView: "isometric" } });
  s.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { suggestedView: "isometric", name: "s1" } });
  s.deliver();
  assert.equal(s.notices().length, 0, "the Setup-classified patch has no effect after the preceding Play op");
  assert.equal(s.server.state.scenes.s1!.suggestedView, "isometric");
  s.room.dispose();
});

test("a Setup batch that leaves the confirmed values unchanged reports no saved change", () => {
  const s = setup();
  s.room.dispatch(rename);
  s.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { name: "s1" } });
  s.deliver();
  assert.equal(s.notices().length, 0);
  s.room.dispose();
});

test("declared Setup promotion includes Play parts but never promotes None", () => {
  const s = setup();
  s.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { suggestedView: "isometric" } }, { group: "setup", groupScope: "setup" });
  s.deliver();
  assert.equal(s.notices().length, 1);
  s.room.ui.dismissToast(s.notices()[0]!.id);
  s.room.dispatch({ t: "member.update", memberId: "dm1", name: "DM" }, { group: "setup", groupScope: "setup" });
  s.deliver();
  assert.equal(s.notices().length, 0);
  assert.equal(s.server.state.members.dm1!.name, "DM");
  s.room.dispose();
});

test("a batch with unknown ops or incomplete reads cannot establish a Setup save", () => {
  const s = setup();
  s.room.dispatch(rename);
  s.server.external({ t: "scene.update", sceneId: "s1", patch: { suggestedView: "isometric" } }, DM);
  s.deliver();
  assert.equal(s.notices().length, 0, "a batch sequence gap may hide a different accepted before-state");
  s.room.dispose();
  const state = roomState({ scenes: { s1: scene("s1"), s2: scene("s2") }, characters: { c1: character("c1") } });
  const incomplete = setup(state);
  incomplete.room.dispatch({ t: "character.update", characterId: "c1", patch: { ownerIds: [] } });
  incomplete.deliver();
  assert.equal(incomplete.notices().length, 0, "a character owner edit reads tokens outside this scene");
  incomplete.room.dispose();
});

test("unacknowledged Setup changes stay silent while a confirmed Play edit changes the same entity", () => {
  const s = setup();
  s.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { suggestedView: "isometric" } });
  const first = s.outbox.sent.find((message) => message.t === "op")!;
  s.room.dispatch(rename);
  if (first.t !== "op") throw new Error("missing first op");
  s.server.batch([{ n: first.n, op: first.op }]).forEach(s.receive);
  assert.equal(s.notices().length, 0);
  assert.equal(s.room.store.getState().pending.length, 1);
  s.room.dispose();
});

test("another device's Setup save cannot confirm this device's pending save", () => {
  const s = setup();
  s.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { suggestedView: "isometric" } });
  const first = s.outbox.sent.find((message) => message.t === "op")!;
  s.room.dispatch(rename);
  s.server.external(rename, DM);
  if (first.t !== "op") throw new Error("missing first op");
  s.server.batch([{ n: first.n, op: first.op }]).forEach(s.receive);
  assert.equal(s.notices().length, 0);
  assert.equal(s.room.store.getState().pending.length, 1);
  s.room.dispose();
});

test("a refusal wins over a contradictory acknowledgment", () => {
  const s = setup();
  const n = s.room.dispatch(rename)!;
  s.room.applyEv({ t: "ev", seq: 1, acks: [n], rejects: [{ n, code: "invalid", message: "Changed elsewhere" }], changes: [{ key: "scene:s1", value: { ...s.server.state.scenes.s1, name: "The crypt" } }] });
  assert.equal(s.notices().length, 0);
  s.room.dispose();
});

test("an acknowledged save that cannot replay against the known view never claims a Setup change", () => {
  const state = roomState();
  const s = setup(state);
  const n = s.room.dispatch({ t: "scene.setGrid", sceneId: "s1", cellPx: 50, originPx: { x: 0, y: 0 } })!;
  const next = s.room.dispatch(rename)!;
  // The transport can acknowledge a save whose accepted before-state this projection cannot reproduce.
  s.room.applyEv({ t: "ev", seq: 2, acks: [n, next], changes: [{ key: "scene:s1", value: { ...state.scenes.s1, name: "The crypt" } }] });
  assert.equal(s.notices().length, 0);
  s.room.dispose();
});

test("grouped Setup saves announce once and a later confirmed save announces again", () => {
  const s = setup();
  s.room.dispatch(rename, { group: "setup", groupScope: "setup" });
  s.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { background: "#123456" } }, { group: "setup", groupScope: "setup" });
  const messages = s.deliver();
  assert.equal(s.notices().length, 1);
  const first = s.notices()[0]!.id;
  messages.forEach(s.receive);
  assert.equal(s.notices()[0]!.id, first, "a repeated ack never announces twice");
  s.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { name: "The vault" } });
  s.deliver();
  assert.equal(s.notices().length, 1);
  assert.notEqual(s.notices()[0]!.id, first, "a new save is a new announcement");
  s.room.dispose();
});

test("a reconnect snapshot never claims that a lost answer was a confirmed save", () => {
  const s = setup();
  s.room.dispatch(rename);
  s.server.batch(s.outbox.sent.flatMap((message) => message.t === "op" ? [{ n: message.n, op: message.op }] : []));
  s.room.suspend();
  s.room.applySnapshot(s.server.hello({ resumeFrom: 1, sceneId: "s1" }));
  assert.equal(s.notices().length, 0);
  s.room.dispose();
});

test("randomized saves, no-effect edits, lost answers and duplicate deliveries keep confirmation invariants", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const s = setup();
    let random = seed;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 30; step++) {
      for (const notice of s.notices()) s.room.ui.dismissToast(notice.id);
      const kind = next() % 3;
      const current = s.server.state.scenes.s1!;
      const op: ClientOp = kind === 0 ? { t: "scene.update", sceneId: "s1", patch: { name: `Save ${seed}:${step}` } }
        : kind === 1 ? { t: "scene.update", sceneId: "s1", patch: { name: current.name } }
          : { t: "scene.update", sceneId: "s1", patch: { suggestedView: current.suggestedView === "isometric" ? "topDown" : "isometric" } };
      s.room.dispatch(op, { quiet: next() % 2 === 0 });
      assert.equal(s.notices().length, 0, `seed ${seed}, step ${step}: no optimistic confirmation`);
      const messages = s.server.batch(s.outbox.sent.flatMap((message) => message.t === "op" ? [{ n: message.n, op: message.op }] : []));
      s.outbox.sent = [];
      const lost = next() % 4 === 0;
      if (lost) s.room.applySnapshot(s.server.hello({ resumeFrom: 1, sceneId: "s1" }));
      else messages.forEach(s.receive);
      assert.equal(s.notices().length, kind === 0 && !lost ? 1 : 0, `seed ${seed}, step ${step}: only a confirmed Setup change`);
      const id = s.notices()[0]?.id;
      messages.forEach(s.receive);
      assert.equal(s.notices()[0]?.id, id, `seed ${seed}, step ${step}: no duplicate confirmation`);
    }
    s.room.dispose();
  }
});
