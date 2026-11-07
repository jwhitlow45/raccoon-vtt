import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Scene } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { Playlist, Sound } from "#shared/sound.ts";
import { DM, room as roomOf, scene as sceneOf } from "#shared/testutil.ts";
import { LocalServer } from "../../dev/localServer.ts";
import { moveWords, SCENE_GONE } from "../../pages/chipMenus.ts";
import { createRoomStore } from "../../state/store.ts";
import { FakeClock, FakeOutbox } from "../../state/testing.ts";
import type { OnAnswer, OpRefusal } from "../../state/types.ts";
import { moveQuestion, movePlayers, movingPlayersTo, type ConfirmedRoom, type MoveAnswer, type MoveRoom } from "./movePlayers.ts";

/** The one move helper behind the Scenes list's Move players and the DM menu's moves (docs/design/design-v1-qol.md 4, C2's move and 6). */

const sounds: Record<string, Sound> = { m1: { id: "m1", rev: 0, name: "Harbor", assetId: "file-m1", ms: 60_000, use: "music" } };
const playlists: Record<string, Playlist> = { night: { id: "night", rev: 0, name: "Night", sounds: ["m1"], repeat: "all", fade: 5 } };
const fogged: Scene = sceneOf("crypt", { fogEnabled: true });
const open: Scene = sceneOf("hall");
const withSound: Scene = { ...fogged, sound: { music: { playlistId: "night", repeat: "all", fade: 5 }, loops: [] } };
const room: MoveRoom = { viewingId: "start", sight: undefined, serverSound: "on", playlists, sounds, confirmed: () => null };

type Sent = { op: ClientOp; group?: string; quiet?: boolean; onAnswer?: OnAnswer };

/** Room actions that keep what was sent, numbered from 1, with a hook to answer each, and `refuseAt` the numbers the store would not queue. */
function fakeActions(refuseAt: readonly number[] = []) {
  const sent: Sent[] = [];
  let ids = 0;
  let n = 0;
  return {
    sent,
    newId: () => `id${++ids}`,
    dispatch(op: ClientOp, opts?: { group?: string; quiet?: boolean; onAnswer?: OnAnswer }): number | null {
      n++;
      if (refuseAt.includes(n)) return null;
      sent.push({ op, ...opts });
      return n;
    },
  };
}

const refusal: OpRefusal = { code: "invalid", message: "the players are on another scene now", text: "Not saved. The players are on another scene now." };

async function settled(answer: Promise<MoveAnswer>): Promise<MoveAnswer | "waiting"> {
  return Promise.race([answer, new Promise<"waiting">((r) => setTimeout(() => r("waiting"), 5))]);
}

describe("a move of the players", () => {
  test("asks first where the scene warns, sending nothing, and goes once confirmed", () => {
    const actions = fakeActions();
    const question = moveQuestion(open, room);
    assert.ok(question?.startsWith("Fog is off here"));
    assert.deepEqual(movePlayers(actions, open, room), { t: "ask", warning: question });
    assert.equal(actions.sent.length, 0);
    assert.equal(movePlayers(actions, open, room, { confirmed: true }).t, "sent");
    assert.deepEqual(actions.sent.map((s) => s.op), [{ t: "room.setPlayerScene", sceneId: "hall" }]);
  });

  test("reads the scene on screen from its sight, and another scene by what to check", () => {
    assert.equal(moveQuestion(fogged, room), null, "fog on and no party vision: nothing to say");
    const lookedAt = moveQuestion({ ...fogged, vision: { on: true, light: "dark" } }, { ...room, viewingId: "crypt" });
    assert.match(lookedAt ?? "", /No party creature on this scene can see/);
    const elsewhere = moveQuestion({ ...fogged, vision: { on: true, light: "dark" } }, room);
    assert.match(elsewhere ?? "", /only what their characters on this scene see/);
  });

  test("sends the move alone, then the scene's own sound, with no undo group, and is taken when the move is", async () => {
    const actions = fakeActions();
    const step = movePlayers(actions, withSound, room);
    assert.equal(step.t, "sent");
    assert.deepEqual(actions.sent.map((s) => s.op.t), ["room.setPlayerScene", "sound.scene"]);
    assert.deepEqual(actions.sent[1]!.op, { t: "sound.scene", sceneId: "crypt", run: "id1", order: ["m1"], onMove: true });
    assert.ok(actions.sent.every((s) => s.group === undefined && s.quiet === undefined));
    if (step.t !== "sent") return;
    assert.equal(await settled(step.answer), "waiting");
    actions.sent[0]!.onAnswer!("taken");
    assert.deepEqual(await step.answer, { t: "taken" });
  });

  test("says which op the server refused, or that the answer was lost", async () => {
    for (const [answer, expected] of [
      ["refused", { t: "refused", step: "move", refusal }],
      ["unknown", { t: "unknown" }],
    ] as const) {
      const actions = fakeActions();
      const step = movePlayers(actions, fogged, room);
      assert.equal(step.t, "sent");
      if (step.t !== "sent") return;
      actions.sent[0]!.onAnswer!(answer, answer === "refused" ? refusal : undefined);
      assert.deepEqual(await step.answer, expected);
    }
  });

  test("a move the store would not queue is refused at once, and the sound goes as it always did", async () => {
    const actions = fakeActions([1]);
    const step = movePlayers(actions, withSound, room);
    assert.equal(step.t, "sent");
    if (step.t !== "sent") return;
    assert.deepEqual(await step.answer, { t: "refused", step: "move", refusal: undefined });
    assert.deepEqual(actions.sent.map((s) => s.op.t), ["sound.scene"]);
  });
});

describe("a reveal (Show players <scene>)", () => {
  test("sends the move, then the lift guarded by the scene, under one group, then the sound outside it", () => {
    const actions = fakeActions();
    movePlayers(actions, withSound, room, { reveal: true });
    assert.deepEqual(actions.sent.map((s) => s.op), [
      { t: "room.setPlayerScene", sceneId: "crypt" },
      { t: "view.blackout", blackout: false, whilePlayersOn: "crypt" },
      { t: "sound.scene", sceneId: "crypt", run: "id2", order: ["m1"], onMove: true },
    ]);
    assert.equal(actions.sent[0]!.group, "id1");
    assert.equal(actions.sent[1]!.group, "id1", "one Undo takes the move and the lift back");
    assert.equal(actions.sent[2]!.group, undefined);
  });

  test("asks first as a move does, and is quiet when the caller says the refusal in place", () => {
    const actions = fakeActions();
    assert.equal(movePlayers(actions, open, room, { reveal: true }).t, "ask");
    assert.equal(actions.sent.length, 0);
    movePlayers(actions, open, room, { reveal: true, confirmed: true, quiet: true });
    assert.deepEqual(actions.sent.map((s) => [s.op.t, s.quiet]), [["room.setPlayerScene", true], ["view.blackout", true]]);
  });

  test("is taken only once the lift is, and a refused lift is named as the lift's", async () => {
    const actions = fakeActions();
    const step = movePlayers(actions, fogged, room, { reveal: true });
    if (step.t !== "sent") return assert.fail("sent");
    actions.sent[0]!.onAnswer!("taken");
    assert.equal(await settled(step.answer), "waiting", "the move alone does not settle a reveal");
    actions.sent[1]!.onAnswer!("refused", refusal);
    assert.deepEqual(await step.answer, { t: "refused", step: "lift", refusal });

    const both = fakeActions();
    const ok = movePlayers(both, fogged, room, { reveal: true });
    if (ok.t !== "sent") return assert.fail("sent");
    both.sent[0]!.onAnswer!("taken");
    both.sent[1]!.onAnswer!("taken");
    assert.deepEqual(await ok.answer, { t: "taken" });
  });

  test("a refused move is the answer, whatever the lift's refusal after it says", async () => {
    const actions = fakeActions();
    const step = movePlayers(actions, fogged, room, { reveal: true });
    if (step.t !== "sent") return assert.fail("sent");
    const gone: OpRefusal = { code: "gone", message: "scene is not here", text: "Not saved. Scene is not here." };
    actions.sent[0]!.onAnswer!("refused", gone);
    actions.sent[1]!.onAnswer!("refused", refusal);
    assert.deepEqual(await step.answer, { t: "refused", step: "move", refusal: gone });
  });

  test("a lift the store would not queue leaves the answer to the lift", async () => {
    const actions = fakeActions([2]);
    const step = movePlayers(actions, fogged, room, { reveal: true });
    if (step.t !== "sent") return assert.fail("sent");
    assert.deepEqual(await step.answer, { t: "refused", step: "lift", refusal: undefined });
  });
});

/** A snapshot's room with the players on `on`, holding the scenes named. */
function held(on: string | null, scenes: Record<string, string>): ConfirmedRoom {
  return { meta: { playerSceneId: on }, scenes: Object.fromEntries(Object.entries(scenes).map(([id, name]) => [id, { name }])) };
}

describe("a move whose answer a snapshot lost (a reconnect, or the resync a co-DM's delete of the DM's scene sends)", () => {
  test("reads where the snapshot has the players: not moved, the scene deleted or not and where they are, or taken where they are on it", async () => {
    for (const [snapshot, expected] of [
      [held("start", { start: "Battle mat" }), { t: "notMoved", sceneGone: true, playersOn: "Battle mat" }],
      [held("start", { start: "Battle mat", crypt: "Crypt" }), { t: "notMoved", sceneGone: false, playersOn: "Battle mat" }],
      [held(null, { crypt: "Crypt" }), { t: "notMoved", sceneGone: false, playersOn: null }],
      [held("crypt", { crypt: "Crypt" }), { t: "taken" }],
    ] as const) {
      const actions = fakeActions();
      const step = movePlayers(actions, fogged, { ...room, confirmed: () => snapshot });
      if (step.t !== "sent") return assert.fail("sent");
      actions.sent[0]!.onAnswer!("unknown", undefined, "snapshot");
      assert.deepEqual(await step.answer, expected);
    }
  });

  test("reads the snapshot only once the answer is lost, and a move too old to send, or one with no snapshot to read, stays unknown", async () => {
    let reads = 0;
    const gone = () => (reads++, held("start", { start: "Battle mat" }));
    const actions = fakeActions();
    const step = movePlayers(actions, fogged, { ...room, confirmed: gone });
    if (step.t !== "sent") return assert.fail("sent");
    assert.equal(reads, 0, "nothing read at the press");
    // Dropped while the store prepared its hello, before any new snapshot: the view may still lack a move that did commit.
    actions.sent[0]!.onAnswer!("unknown", undefined, "expired");
    assert.deepEqual(await step.answer, { t: "unknown" });
    assert.equal(reads, 0);

    const none = fakeActions();
    const unread = movePlayers(none, fogged, { ...room, confirmed: () => null });
    if (unread.t !== "sent") return assert.fail("sent");
    none.sent[0]!.onAnswer!("unknown", undefined, "snapshot");
    assert.deepEqual(await unread.answer, { t: "unknown" });
  });

  test("a reveal whose move a snapshot settled with the players on the scene waits on its lift, and one with them elsewhere ends there", async () => {
    const actions = fakeActions();
    const step = movePlayers(actions, fogged, { ...room, confirmed: () => held("crypt", { crypt: "Crypt" }) }, { reveal: true });
    if (step.t !== "sent") return assert.fail("sent");
    actions.sent[0]!.onAnswer!("unknown", undefined, "snapshot");
    assert.equal(await settled(step.answer), "waiting", "the lift, still pending, is resent and answered");
    actions.sent[1]!.onAnswer!("refused", refusal);
    assert.deepEqual(await step.answer, { t: "refused", step: "lift", refusal });

    const elsewhere = fakeActions();
    const lost = movePlayers(elsewhere, fogged, { ...room, confirmed: () => held("start", { start: "Battle mat" }) }, { reveal: true });
    if (lost.t !== "sent") return assert.fail("sent");
    elsewhere.sent[0]!.onAnswer!("unknown", undefined, "snapshot");
    elsewhere.sent[1]!.onAnswer!("unknown", undefined, "snapshot");
    assert.deepEqual(await lost.answer, { t: "notMoved", sceneGone: true, playersOn: "Battle mat" });

    // The move was taken, so a snapshot that has the players elsewhere by the lift's lost answer says only that someone moved them since.
    const moved = fakeActions();
    const lift = movePlayers(moved, fogged, { ...room, confirmed: () => held("start", { start: "Battle mat", crypt: "Crypt" }) }, { reveal: true });
    if (lift.t !== "sent") return assert.fail("sent");
    moved.sent[0]!.onAnswer!("taken");
    moved.sent[1]!.onAnswer!("unknown", undefined, "snapshot");
    assert.deepEqual(await lift.answer, { t: "unknown" });
  });
});

/**
 * se-6 in the store, frame by frame (CI's search.e2e.ts se-6): the DM looks
 * at Doomed hall and presses Show players or Move players here as a co-DM
 * deletes it. The server refuses the move, but its delete resynced the
 * DM's socket first, and a socket without a snapshot is sent no refusal.
 * Whether the DM's hello reaches the server before the refusal commits
 * (the refusal comes after the snapshot) or after it (the snapshot settles
 * the move with no answer) is the network's timing, so every order runs.
 */
describe("a move the server refuses while it resyncs the DM's socket", () => {
  const doomed = sceneOf("doomed", { name: "Doomed hall", fogEnabled: true });

  function play(order: { deleted: boolean; reveal: boolean; helloFirst: boolean; deleteSeen: boolean }) {
    const state = roomOf({ scenes: { s1: sceneOf("s1", { name: "Battle mat", fogEnabled: true }), doomed } });
    state.meta.view.blackout = true;
    const server = new LocalServer(state, DM, "doomed");
    const outbox = new FakeOutbox();
    const store = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock(), random: () => 0.5, clientId: "c1" });
    store.setOutbox(outbox);
    store.applySnapshot(server.hello({ resumeFrom: store.prepareHello().resumeFrom, sceneId: "doomed" }));
    const take = () => {
      const ops = outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
      outbox.sent = [];
      return ops;
    };
    const dmRoom: MoveRoom = { viewingId: "doomed", sight: undefined, serverSound: "off", playlists: {}, sounds: {}, confirmed: () => store.store.getState().confirmed };
    const actions = { dispatch: store.dispatch, newId: () => "g1" };
    // The co-DM's delete: its frames to the DM's page wait behind the press.
    const deleteEv = order.deleted ? server.external({ t: "scene.delete", sceneId: "doomed" }, DM) : null;
    const step = movePlayers(actions, doomed, dmRoom, { reveal: order.reveal, quiet: true, confirmed: true });
    if (step.t !== "sent") throw new Error("not sent");
    let answer: MoveAnswer | null = null;
    void step.answer.then((a) => (answer = a));
    const sent = take();
    const hello = () => {
      if (order.deleteSeen && deleteEv) store.applyEv(deleteEv);
      store.suspend();
      // As the room actor does, a DM whose scene was deleted lands on the players' scene.
      if (!server.state.scenes[server.dmSceneId ?? ""]) server.dmSceneId = server.state.meta.playerSceneId;
      store.applySnapshot(server.hello({ resumeFrom: store.prepareHello().resumeFrom, sceneId: "doomed" }));
    };
    if (order.helloFirst) {
      hello();
      // The server takes the press as first sent, and the resend after the snapshot as the duplicate it is.
      for (const msg of server.batch(sent)) if (msg.t === "ev") store.applyEv(msg);
      for (const msg of server.batch(take())) if (msg.t === "ev") store.applyEv(msg);
    } else {
      // Committed before the hello: its answers go to a socket with no snapshot, which is sent none.
      server.batch(sent);
      hello();
      take();
    }
    return { answer: () => answer, store };
  }

  test("the DM hears the players were not moved, or that they were, in every order", async () => {
    for (const deleted of [true, false])
      for (const reveal of [true, false])
        for (const helloFirst of [true, false])
          for (const deleteSeen of [true, false]) {
            const order = { deleted, reveal, helloFirst, deleteSeen };
            const t = play(order);
            await new Promise((r) => setTimeout(r, 0));
            const answer = t.answer();
            assert.ok(answer, `settled: ${JSON.stringify(order)}`);
            const meta = t.store.store.getState().confirmed?.meta;
            if (deleted) {
              assert.deepEqual(moveWords(answer), { t: "refused", words: `Players not moved. ${SCENE_GONE}` }, `said not moved: ${JSON.stringify(order)}`);
              assert.equal(meta?.playerSceneId, "s1", "nobody moved");
              assert.equal(meta?.view.blackout, true, "the blackout stays on");
            } else {
              assert.deepEqual(moveWords(answer), { t: "taken" }, `taken: ${JSON.stringify(order)}`);
              assert.equal(meta?.playerSceneId, "doomed");
            }
          }
  });
});

describe("the move waiting on the server", () => {
  test("is the first move of the players among the pending ops", () => {
    assert.equal(movingPlayersTo([]), null);
    assert.equal(movingPlayersTo([{ op: { t: "view.follow", follow: true } }]), null);
    assert.equal(movingPlayersTo([{ op: { t: "view.follow", follow: true } }, { op: { t: "room.setPlayerScene", sceneId: "crypt" } }]), "crypt");
  });
});
