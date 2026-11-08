import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { RoomState } from "#shared/model.ts";
import { holds } from "#shared/propertyTestutil.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { DM, room, token } from "#shared/testutil.ts";
import { LocalServer } from "../dev/localServer.ts";
import { createRoomStore, type DispatchOptions } from "./store.ts";
import { applyTestHistory, FakeClock, FakeOutbox } from "./testing.ts";

/*
 * `dispatchMany` (dungeon generator phase 2, section 6, D-261107-263): ops
 * queued as `dispatch` queues each, in order, with one view rebuild for all
 * of them, so a generated dungeon's 100 ops cost one rebuild in Make's task
 * rather than one each.
 */

function setup(state: RoomState) {
  const clock = new FakeClock();
  const outbox = new FakeOutbox();
  const server = new LocalServer(structuredClone(state), DM, "s1");
  const store = createRoomStore({ roomId: "R1", you: DM, clock, random: () => 0.5, clientId: "c1" });
  store.setOutbox(outbox);
  const hello = store.prepareHello();
  store.setConnection("open");
  store.applySnapshot(server.hello({ resumeFrom: hello.resumeFrom, sceneId: "s1" }));
  applyTestHistory(store, hello.resumeFrom - 1);
  let updates = 0;
  store.store.subscribe(() => updates++);
  return { store, outbox, updates: () => updates };
}

const START = room({ tokens: { a: token("a", { x: 1, y: 1 }), b: token("b", { x: 2, y: 2 }) } });
const move = (tokenId: string, x: number, y: number): ClientOp => ({ t: "token.move", tokenId, x, y });
const MALFORMED = { t: "token.move", tokenId: "a", x: "far" } as unknown as ClientOp;

test("DG2B: dispatchMany queues every op in order under the numbers dispatch would give, with one store update and every op sent", () => {
  const ops = [move("a", 3, 3), move("b", 4, 4), move("a", 5, 6)];
  const many = setup(START);
  const one = setup(START);
  const answers: string[] = [];
  const opts = (k: number): DispatchOptions => ({ group: "g1", groupScope: "setup", onAnswer: (a) => answers.push(`${k}:${a}`) });
  const before = many.updates();
  const ns = many.store.dispatchMany(ops.map((op, k) => ({ op, opts: opts(k) })));
  const manyUpdates = many.updates() - before;
  const was = one.updates();
  const first = one.store.dispatch(ops[0]!, opts(0));
  assert.equal(manyUpdates, one.updates() - was, "all three cost the store updates of one");
  const each = [first, ...ops.slice(1).map((op, k) => one.store.dispatch(op, opts(k + 1)))];
  assert.deepEqual(ns, each);
  assert.deepEqual(many.store.store.getState().view?.tokens, one.store.store.getState().view?.tokens, "the same predicted view");
  assert.deepEqual(many.outbox.sent, one.outbox.sent, "the same frames, in order, in the group");
  assert.deepEqual(many.store.store.getState().pending.map((p) => [p.n, p.group, p.groupScope]), ns.map((n) => [n, "g1", "setup"]));
});

test("DG2B: an op dispatch would refuse at input is null and says so once, and the rest still go", () => {
  const s = setup(START);
  const errors = console.error;
  console.error = () => {};
  try {
    const ns = s.store.dispatchMany([{ op: move("a", 3, 3) }, { op: MALFORMED }, { op: move("b", 4, 4) }, { op: MALFORMED }]);
    assert.equal(ns[1], null);
    assert.equal(ns[3], null);
    const [first, , third] = ns;
    assert.ok(typeof first === "number" && third === first + 1, "numbers stay consecutive past the refused one");
  } finally {
    console.error = errors;
  }
  assert.deepEqual(s.outbox.takeOps().length, 2);
  assert.equal(s.store.store.getState().toasts.filter((t) => t.text === "That change could not be sent.").length, 1);
  const setup2 = s.store.dispatchMany([{ op: move("a", 1, 1), opts: { groupScope: "setup" } }]);
  assert.deepEqual(setup2, [null], "a setup scope without a group is refused, as dispatch refuses it");
  assert.deepEqual(s.store.dispatchMany([]), []);
});

test("DG2B: while a builder gesture waits on its asks, dispatchMany holds back what dispatch would", () => {
  const s = setup(room());
  const release = s.store.holdBuild(() => {});
  const paint: ClientOp = { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["0,0"] };
  const many = s.store.dispatchMany([{ op: paint }, { op: { t: "log.chat", text: "hi" } }]);
  assert.equal(many[0], s.store.dispatch(paint));
  assert.equal(many[0], null);
  assert.notEqual(many[1], null);
  release();
});

test("DG2B: under any ops and refusals, dispatchMany leaves the store as dispatching each in turn does", () => {
  const op = fc.oneof(
    fc.record({ id: fc.constantFrom("a", "b", "gone"), x: fc.integer({ min: 0, max: 20 }), y: fc.integer({ min: 0, max: 20 }) }).map(({ id, x, y }) => move(id, x, y)),
    fc.constant(MALFORMED),
    fc.string({ maxLength: 8 }).map((text): ClientOp => ({ t: "log.chat", text: text || "x" })),
  );
  const errors = console.error;
  console.error = () => {};
  try {
    holds(
      fc.property(fc.array(op, { maxLength: 12 }), fc.boolean(), (ops, grouped) => {
        const many = setup(START);
        const one = setup(START);
        const opts = grouped ? { group: "g" } : undefined;
        const ns = many.store.dispatchMany(ops.map((o) => ({ op: o, ...(opts ? { opts } : {}) })));
        const each = ops.map((o) => one.store.dispatch(o, opts));
        assert.deepEqual(ns, each);
        assert.deepEqual(many.outbox.sent, one.outbox.sent);
        assert.deepEqual(many.store.store.getState().view, one.store.store.getState().view);
        assert.deepEqual(many.store.store.getState().pending.map((p) => p.n), one.store.store.getState().pending.map((p) => p.n));
      }),
      100,
    );
  } finally {
    console.error = errors;
  }
});
