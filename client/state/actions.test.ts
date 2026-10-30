import { FakeClock } from "./testing.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClientMessage, ClientOp, EphEvent } from "#shared/protocol.ts";
import { projectState } from "#shared/project.ts";
import { DM, room as testRoom } from "#shared/testutil.ts";
import { createRoomActions, dispatchGesture, validEph } from "./actions.ts";
import { createRoomStore } from "./store.ts";

function setup() {
  const room = createRoomStore({ roomId: "R1", you: DM, clientId: "c1", clock: new FakeClock() });
  const sent: EphEvent[] = [];
  const actions = createRoomActions(room, { sendEph: (e) => void sent.push(e), switchScene: () => {} });
  return { room, sent, actions };
}

function quietly<T>(fn: () => T): { result: T; errors: number } {
  const original = console.error;
  let errors = 0;
  console.error = () => {
    errors++;
  };
  try {
    return { result: fn(), errors };
  } finally {
    console.error = original;
  }
}

describe("ephemeral events are checked before they go out", () => {
  test("a valid event is shown here and sent", () => {
    const s = setup();
    s.actions.sendEph({ k: "ping", x: 3, y: 4 });
    assert.deepEqual(s.sent, [{ k: "ping", x: 3, y: 4 }]);
    assert.equal(s.room.store.getState().ephemeral.pings.length, 1);
  });

  test("a malformed event is neither sent nor shown, and is reported once per kind", () => {
    const s = setup();
    const tooClose = { k: "focus", x: 1, y: 1, zoom: 160 } as EphEvent;
    const empty = { k: "ruler", id: "r1", points: [] } as EphEvent;
    const { errors } = quietly(() => {
      s.actions.sendEph(tooClose);
      s.actions.sendEph(tooClose);
      s.actions.sendEph(empty);
    });
    assert.deepEqual(s.sent, []);
    assert.deepEqual(s.room.store.getState().ephemeral.rulers, {});
    assert.equal(errors, 2);
  });

  test("the payload size cap counts as it does on the server", () => {
    const point = (i: number) => ({ x: i + 0.123456, y: i + 0.654321, tokenId: "t".repeat(64) });
    assert.ok(validEph({ k: "ruler", id: "r1", points: [point(0), point(1)] }));
    assert.equal(validEph({ k: "ruler", id: "r1", points: Array.from({ length: 50 }, (_, i) => point(i)) }), false);
  });
});

function emptyProjected(): unknown {
  return projectState(testRoom(), DM, { sceneId: "s1" });
}

describe("one gesture is one undo step", () => {
  const paint = (cell: string): ClientOp => ({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: [cell] });

  test("a gesture sent as several ops shares one undo group, and a lone op needs none", () => {
    const sent: Array<{ op: ClientOp; group: string | undefined }> = [];
    let ids = 0;
    const actions = { dispatch: (op: ClientOp, opts?: { group?: string }) => (sent.push({ op, group: opts?.group }), sent.length), newId: () => `g${++ids}` };
    assert.deepEqual(dispatchGesture(actions, [paint("1,1"), paint("2,2"), paint("3,3")]), [1, 2, 3]);
    assert.deepEqual(dispatchGesture(actions, [paint("4,4"), paint("5,5")]), [4, 5]);
    assert.deepEqual(dispatchGesture(actions, [paint("6,6")]), [6]);
    assert.deepEqual(
      sent.map((s) => s.group),
      ["g1", "g1", "g1", "g2", "g2", undefined],
    );
    // A folder rename of one scene still goes as a gesture, so its undo step is named for the rename.
    assert.deepEqual(dispatchGesture(actions, [paint("7,7")], { alwaysGroup: true }), [7]);
    assert.equal(sent.at(-1)?.group, "g3");
  });

  test("the group goes out with each op, and again when the op is resent", () => {
    const room = createRoomStore({ roomId: "R1", you: DM, clientId: "c1", clock: new FakeClock() });
    const out: ClientMessage[] = [];
    room.setOutbox({ send: (msg) => (out.push(msg), true) });
    room.applySnapshot({ t: "snapshot", seq: 0, state: emptyProjected(), you: { memberId: DM.memberId, role: "dm", sceneId: "s1" }, watermark: 0 });
    room.dispatch(paint("1,1"), { group: "stroke" });
    room.dispatch(paint("2,2"));
    room.suspend();
    room.applySnapshot({ t: "snapshot", seq: 0, state: emptyProjected(), you: { memberId: DM.memberId, role: "dm", sceneId: "s1" }, watermark: 0 });
    room.dispose();
    const ops = out.flatMap((m) => (m.t === "op" ? [{ n: m.n, g: m.g }] : []));
    assert.deepEqual(ops, [
      { n: 1, g: "stroke" },
      { n: 2, g: undefined },
      { n: 1, g: "stroke" },
      { n: 2, g: undefined },
    ]);
  });
});

test("mixed setup gestures declare their scope on the first part and every retry", () => {
  const room = createRoomStore({ roomId: "R1", you: DM, clientId: "c1", clock: new FakeClock() });
  const out: ClientMessage[] = [];
  room.setOutbox({ send: (message) => (out.push(message), true) });
  room.applySnapshot({ t: "snapshot", seq: 0, state: emptyProjected(), you: { ...DM, sceneId: "s1" }, watermark: 0 });
  const actions = createRoomActions(room, { sendEph() {}, switchScene() {} });
  dispatchGesture(actions, [{ t: "scene.update", sceneId: "s1", patch: { gridShape: "hexRows" } }, { t: "scene.setGrid", sceneId: "s1", cellPx: 50, originPx: { x: 0, y: 0 } }], { groupScope: "setup" });
  const sent = out.filter((message) => message.t === "op") as (Extract<ClientMessage, { t: "op" }> & { groupScope?: string })[];
  assert.equal(sent.length, 2);
  assert.ok(sent[0]!.g);
  assert.ok(sent.every((message) => message.g === sent[0]!.g && message.groupScope === "setup"));
  room.suspend();
  room.applySnapshot({ t: "snapshot", seq: 0, state: emptyProjected(), you: { ...DM, sceneId: "s1" }, watermark: 0 });
  assert.deepEqual(out.slice(2), sent);
  room.dispose();
});

test("setup group declarations require a group and a DM", () => {
  for (const role of ["dm", "player"] as const) {
    const room = createRoomStore({ roomId: "R1", you: { ...DM, role }, clock: new FakeClock() });
    const op = { t: "scene.update" as const, sceneId: "s1", patch: { name: "New name" } };
    assert.equal(room.dispatch(op, { groupScope: "setup", ...(role === "player" ? { group: "gesture" } : {}) }), null);
    assert.equal(room.store.getState().pending.length, 0);
    room.dispose();
  }
});
