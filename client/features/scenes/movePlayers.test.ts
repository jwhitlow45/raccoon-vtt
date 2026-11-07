import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Scene } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { Playlist, Sound } from "#shared/sound.ts";
import { scene as sceneOf } from "#shared/testutil.ts";
import type { OnAnswer, OpRefusal } from "../../state/types.ts";
import { moveQuestion, movePlayers, movingPlayersTo, type MoveAnswer, type MoveRoom } from "./movePlayers.ts";

/** The one move helper behind the Scenes list's Move players and the DM menu's moves (docs/design/design-v1-qol.md 4, C2's move and 6). */

const sounds: Record<string, Sound> = { m1: { id: "m1", rev: 0, name: "Harbor", assetId: "file-m1", ms: 60_000, use: "music" } };
const playlists: Record<string, Playlist> = { night: { id: "night", rev: 0, name: "Night", sounds: ["m1"], repeat: "all", fade: 5 } };
const fogged: Scene = sceneOf("crypt", { fogEnabled: true });
const open: Scene = sceneOf("hall");
const withSound: Scene = { ...fogged, sound: { music: { playlistId: "night", repeat: "all", fade: 5 }, loops: [] } };
const room: MoveRoom = { viewingId: "start", sight: undefined, serverSound: "on", playlists, sounds };

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

describe("the move waiting on the server", () => {
  test("is the first move of the players among the pending ops", () => {
    assert.equal(movingPlayersTo([]), null);
    assert.equal(movingPlayersTo([{ op: { t: "view.follow", follow: true } }]), null);
    assert.equal(movingPlayersTo([{ op: { t: "view.follow", follow: true } }, { op: { t: "room.setPlayerScene", sceneId: "crypt" } }]), "crypt");
  });
});
