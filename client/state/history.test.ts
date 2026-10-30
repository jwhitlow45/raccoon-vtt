import assert from "node:assert/strict";
import { test } from "node:test";
import { projectState } from "#shared/project.ts";
import { DM, room as testRoom } from "#shared/testutil.ts";
import { createRoomActions } from "./actions.ts";
import { createRoomStore } from "./store.ts";
import { FakeClock, FakeOutbox } from "./testing.ts";
import { undoNotice } from "./historyNotice.ts";

// This process is a device that already saw the rollout notice, which would otherwise be one more toast in the first DM room's counts.
undoNotice.claim();

test("stack activation waits for authoritative history after a snapshot", () => {
  const room = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock() });
  const out = new FakeOutbox();
  room.setOutbox(out);
  room.setConnection("open");
  room.applySnapshot({ t: "snapshot", seq: 0, state: projectState(testRoom(), DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" }, watermark: 0 });
  const actions = createRoomActions(room, { sendEph() {}, switchScene() {} });
  actions.undo();
  assert.equal(out.sent.length, 0, "a snapshot alone cannot supply an undo head");
  room.dispose();
});

import type { HistoryMessage } from "#shared/undoContract.ts";
import { HistoryController, EMPTY_HISTORY, type HistoryCommand, type HistoryView } from "./history.ts";
import type { OnAnswer } from "./types.ts";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const empty = () => ({ head: null, depth: 0 });
const frame = (head = 1, seq = 0, serial = 0, watermark = 0, epoch = id(100)): HistoryMessage => ({
  t: "history", epoch, seq, serial, watermark,
  play: { undo: { head: { id: id(head), label: "moving Bree" }, depth: 1 }, redo: empty() },
  setup: { undo: { head: { id: id(head + 1000), label: "changing Bree's AC" }, depth: 1 }, redo: empty() },
});

test("a retained summary arriving before its state event offers Review step after coverage", () => {
  const room = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock() });
  room.setConnection("open");
  room.applySnapshot({ t: "snapshot", seq: 0, state: projectState(testRoom(), DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" }, watermark: 0 });
  const message = frame(1, 1);
  message.setup!.undo.head!.retained = { scope: "play", direction: "redo", label: "damage", buried: false };
  room.applyHistory(message);
  assert.equal(room.store.getState().toasts.length, 0);
  room.applyEv({ t: "ev", seq: 1, changes: [] });
  const review = room.store.getState().toasts.find((toast) => toast.action?.label === "Review step");
  assert.ok(review);
  review.action!.run();
  assert.deepEqual(room.store.getState().historyReview, { scope: "setup", direction: "undo" });
  room.applyHistory(message);
  assert.equal(room.store.getState().toasts.length, 1);
  room.applyEv({ t: "ev", seq: 2, changes: [] });
  room.applyHistory({ ...message, seq: 2 });
  assert.equal(room.store.getState().toasts.length, 1, "chat coverage does not repeat the retained-step notice");
  assert.equal(room.store.getState().toasts[0]!.id, review.id, "the existing notice is not announced again");
  room.ui.dismissToast(review.id);
  room.applyEv({ t: "ev", seq: 3, changes: [] });
  room.applyHistory({ ...message, seq: 3 });
  assert.equal(room.store.getState().toasts.length, 0, "a dismissed notice does not return for unchanged retention");
  room.dispose();
});

function harness() {
  const clock = new FakeClock();
  const context = { seq: 0, terminal: 0, issued: 0, enabled: true, dm: true };
  const sent: { command: HistoryCommand; answer: OnAnswer; n: number }[] = [];
  const notes: string[] = [];
  let view: HistoryView = EMPTY_HISTORY;
  const controller = new HistoryController({
    context: () => context,
    send(command, options) {
      const n = ++context.issued;
      sent.push({ command, answer: options.onAnswer, n });
      return n;
    },
    changed: (value) => { view = value; },
    notify: (text) => notes.push(text),
  }, clock);
  const snapshot = () => controller.snapshot();
  const ack = (n: number, seq = context.seq) => {
    context.terminal = n;
    context.seq = seq;
    sent.find((s) => s.n === n)!.answer("taken");
    controller.refresh();
  };
  snapshot();
  return { controller, context, sent, notes, clock, snapshot, ack, view: () => view };
}

test("an ack before its summary cannot reuse a cached head, including same-sequence refusals", () => {
  const h = harness();
  h.controller.receive(frame());
  h.controller.activate("undo");
  h.ack(1);
  h.controller.activate("undo");
  assert.equal(h.sent.length, 1);
  h.controller.receive(frame(2, 0, 1, 0));
  assert.equal(h.sent.length, 1, "new serial alone does not cover the ack");
  h.controller.receive(frame(2, 0, 1, 1));
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1]!.command.head, id(2));
});

test("equal serial accepts newer chat coverage and waits for its confirmed view", () => {
  const h = harness();
  h.controller.receive(frame());
  h.controller.receive(frame(1, 1));
  h.controller.activate("undo");
  assert.equal(h.sent.length, 0);
  assert.equal(h.view().summary, null);
  h.context.seq = 1;
  h.controller.refresh();
  assert.equal(h.sent[0]!.command.head, id(1));
});

test("a summary before its ack waits for that ack", () => {
  const h = harness();
  h.context.issued = 1;
  h.controller.receive(frame(2, 0, 1, 1));
  h.controller.activate("undo");
  assert.equal(h.sent.length, 0);
  h.context.terminal = 1;
  h.controller.refresh();
  assert.equal(h.sent[0]!.command.head, id(2));
});

test("regressing serial, sequence, and watermark frames cannot replace an accepted head", () => {
  for (const stale of [frame(9, 3, 1, 2), frame(9, 1, 3, 2), frame(9, 2, 3, 1)]) {
    const h = harness();
    h.context.seq = 2;
    h.context.terminal = h.context.issued = 2;
    h.controller.receive(frame(2, 2, 2, 2));
    h.controller.receive(stale);
    h.controller.activate("undo");
    assert.equal(h.sent[0]!.command.head, id(2));
  }
});

test("retired connections, pre-snapshot history, foreign and retired epochs are ignored", () => {
  const h = harness();
  h.controller.receive(frame());
  const retired = h.controller.generation;
  h.controller.suspend();
  h.controller.receive(frame(9));
  assert.equal(h.view().ready, false);
  h.snapshot();
  h.controller.receive(frame(9), retired);
  assert.equal(h.view().ready, false);
  h.controller.receive(frame(2, 0, 0, 0, id(200)));
  h.controller.receive(frame(9, 0, 1));
  h.controller.activate("undo");
  assert.equal(h.sent[0]!.command.head, id(2));
  h.ack(1);
  h.controller.suspend();
  h.snapshot();
  h.controller.receive(frame(9, 0, 2, 1));
  assert.equal(h.view().ready, false);
  h.controller.receive(frame(3, 0, 1, 1, id(200)));
  assert.equal(h.view().ready, true, "same room epoch is valid on a new connection");
});

test("a pointer double activation across its ack never consumes the replacement", () => {
  const h = harness();
  h.controller.receive(frame());
  h.controller.activate("undo", { control: "toolbar", detail: 1 });
  h.ack(1);
  h.controller.receive(frame(2, 0, 1, 1));
  assert.equal(h.controller.activate("undo", { control: "toolbar", detail: 2 }), false);
  assert.equal(h.sent.length, 1);
  h.controller.activate("undo", { control: "toolbar", detail: 1 });
  assert.equal(h.sent[1]!.command.head, id(2));
});

test("repeat keys do nothing, separate keys wait and then capture the next head", () => {
  const h = harness();
  h.controller.receive(frame());
  assert.equal(h.controller.activate("undo", { repeat: true }), false);
  h.controller.activate("undo");
  h.controller.activate("undo");
  assert.equal(h.sent.length, 1);
  h.ack(1);
  assert.equal(h.sent.length, 1);
  h.controller.receive(frame(2, 0, 1, 1));
  assert.equal(h.sent[1]!.command.head, id(2));
});

test("stale discard confirmation and admission-only heads send nothing", () => {
  const h = harness();
  const retained = frame();
  retained.setup!.undo.head!.retained = { scope: "play", direction: "redo", label: "damaging Bree", buried: true };
  h.controller.receive(retained);
  const expected = retained.setup!.undo.head!.id;
  h.controller.receive(frame(2, 0, 1));
  h.controller.activate("undo", { scope: "setup", expected, discard: true });
  h.controller.activate("undo", { scope: "setup", expected: id(1002), discard: true });
  assert.equal(h.sent.length, 0);
  assert.match(h.notes[0]!, /Setup history changed/);
  assert.match(h.notes[1]!, /not retained/);
});

test("retained discard, retry, and both forget directions preserve expected head and scope", () => {
  for (const direction of ["undo", "redo"] as const) {
    for (const discard of [true, false]) {
      const h = harness();
      const current = frame();
      current.setup![direction] = { depth: 1, head: { id: id(1001), label: "changing AC", retained: { scope: "play", direction: "undo", label: "damage", buried: false } } };
      h.controller.receive(current);
      h.controller.activate(direction, { scope: "setup", expected: id(1001), ...(discard ? { discard: true } : { forget: 7 }) });
      assert.deepEqual(h.sent[0]!.command, { t: direction, scope: "setup", head: id(1001), ...(discard ? { discard: true } : { forget: 7 }) });
    }
  }
});

test("offline, player setup, and empty play never dispatch or fall back to setup", () => {
  const h = harness();
  h.controller.receive({ ...frame(), play: { undo: empty(), redo: empty() } });
  h.controller.activate("undo");
  h.context.dm = false;
  assert.equal(h.controller.activate("undo", { scope: "setup" }), false);
  h.context.enabled = false;
  assert.equal(h.controller.activate("undo"), false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.view().pending, 0);
});

test("pending feedback waits 200 ms and clears after a terminal answer", () => {
  const h = harness();
  h.controller.activate("undo");
  h.clock.advance(199);
  assert.equal(h.view().slow, false);
  h.clock.advance(1);
  assert.equal(h.view().slow, true);
  h.controller.receive(frame());
  h.ack(1);
  assert.equal(h.view().slow, false);
  assert.equal(h.clock.pendingTimers, 0);
});

test("deterministic event permutations: no stale-head dispatch and no duplicate activation", () => {
  for (let seed = 1; seed <= 30; seed++) {
    let random = seed;
    const next = () => ((random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const h = harness();
    let expected = 1;
    h.controller.receive(frame(expected));
    for (let step = 0; step < 100; step++) {
      h.controller.activate("undo", { control: "toolbar", detail: 1 });
      const sent = h.sent.at(-1)!;
      assert.equal(sent.command.head, id(expected), `seed ${seed} step ${step}: no stale-head dispatch`);
      const n = sent.n;
      expected++;
      const summary = frame(expected, step + 1, step + 1, n);
      const deliveries = [() => h.ack(n, step + 1), () => h.controller.receive(summary), () => h.controller.activate("undo", { control: "toolbar", detail: 2 }), () => h.controller.activate("undo", { repeat: true }), () => h.controller.receive(frame(900, step, step, n - 1))];
      while (deliveries.length) deliveries.splice(Math.floor(next() * deliveries.length), 1)[0]!();
      assert.equal(h.sent.length, step + 1, `seed ${seed} step ${step}: no duplicate activation`);
      assert.equal(h.view().ready, true);
    }
    h.controller.dispose();
  }
});

test("a resync requires its following summary and never relaxes serial ordering", () => {
  const h = harness();
  h.controller.receive(frame(4, 0, 4));
  h.snapshot();
  h.controller.activate("undo");
  h.controller.receive(frame(3, 0, 3));
  assert.equal(h.sent.length, 0);
  h.controller.receive(frame(4, 0, 4));
  assert.equal(h.sent[0]!.command.head, id(4));
});

test("queued setup activation rechecks the role before dispatch", () => {
  const h = harness();
  h.controller.activate("undo", { scope: "setup" });
  h.context.dm = false;
  h.controller.receive(frame());
  assert.equal(h.sent.length, 0);
});

test("reconnect cancels waiting activations and terminates their callbacks", () => {
  const h = harness();
  const heard: string[] = [];
  h.controller.activate("undo", { onAnswer: (answer) => heard.push(answer) });
  h.controller.suspend();
  h.snapshot();
  h.controller.receive(frame());
  assert.deepEqual(heard, ["unknown"]);
  assert.equal(h.sent.length, 0);
  assert.equal(h.view().pending, 0);
});

test("terminal results name the captured setup action and preserve a reload refusal", () => {
  const h = harness();
  h.controller.receive(frame());
  h.controller.activate("undo", { scope: "setup" });
  h.ack(1);
  assert.equal(h.view().result, "Undid setup: changing Bree's AC.");
  h.controller.receive(frame(2, 0, 1, 1));
  h.controller.activate("undo");
  h.context.terminal = 2;
  h.sent[1]!.answer("refused", { code: "invalid", message: "Reload to use Undo", text: "Reload to use Undo" });
  assert.equal(h.view().result, "Reload to use Undo");
});

test("a lost history answer announces once, while quiet flows keep their own feedback", () => {
  for (const quiet of [false, true]) {
    const h = harness();
    h.controller.receive(frame());
    h.controller.activate("undo", { quiet });
    h.sent[0]!.answer("unknown", undefined, "snapshot");
    assert.deepEqual(h.notes, quiet ? [] : ["The answer was lost. Check the next change."]);
  }
});

test("disconnecting a quiet activation waiting for history does not add a second notice", () => {
  const h = harness();
  const answers: string[] = [];
  h.controller.activate("undo", { quiet: true, onAnswer: (answer) => answers.push(answer) });
  h.controller.suspend();
  assert.deepEqual(answers, ["unknown"]);
  assert.deepEqual(h.notes, []);
});

test("an unfamiliar epoch on the established connection cannot replace its heads", () => {
  const h = harness();
  h.controller.receive(frame());
  h.controller.receive(frame(9, 0, 1, 0, id(900)));
  h.controller.activate("undo");
  assert.equal(h.sent[0]!.command.head, id(1));
});

test("a cached summary behind the confirmed view never dispatches or describes the next head", () => {
  const h = harness();
  h.controller.receive(frame());
  h.context.seq = 1;
  h.controller.refresh();
  assert.equal(h.view().summary, null);
  h.controller.activate("undo");
  assert.equal(h.sent.length, 0);
  h.controller.receive(frame(2, 1, 1));
  assert.equal(h.sent[0]!.command.head, id(2));
});

for (const before of [false, true]) for (const quiet of [false, true]) test(`retained refusal has one notice with Review step, history first=${before}, quiet=${quiet}`, () => {
  const room = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock() });
  room.setOutbox(new FakeOutbox());
  room.setConnection("open");
  room.applySnapshot({ t: "snapshot", seq: 0, state: projectState(testRoom(), DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" }, watermark: 0 });
  const initial = frame();
  room.applyHistory(initial);
  const expected = initial.setup!.undo.head!.id;
  const n = room.dispatch({ t: "undo", scope: "setup", head: expected }, { quiet })!;
  const retained = { ...frame(1, 0, 1, n) };
  retained.setup!.undo.head!.retained = { scope: "play", direction: "redo", label: "damage", buried: false };
  if (before) {
    room.applyHistory(retained);
    assert.equal(room.store.getState().toasts.length, 0, "the matching pending command will supply its answer");
  }
  room.applyEv({ t: "ev", seq: 0, changes: [], rejects: [{ n, code: "invalid", message: "could not undo changing AC: redo the play step first: damage" }] });
  const id = room.store.getState().toasts[0]?.id;
  if (!before) room.applyHistory(retained);
  const notes = room.store.getState().toasts;
  assert.equal(notes.length, quiet ? 0 : 1);
  if (!quiet) {
    assert.equal(notes[0]!.id, id, "adding Review does not create another announcement");
    assert.equal(notes[0]!.action?.label, "Review step");
    notes[0]!.action!.run();
    assert.deepEqual(room.store.getState().historyReview, { scope: "setup", direction: "undo" });
    room.applyHistory({ ...retained, serial: 2 });
    assert.equal(room.store.getState().toasts, notes, "unchanged retention keeps the existing notice object");
    room.ui.dismissToast(id!);
    room.applyHistory({ ...retained, serial: 3 });
    assert.equal(room.store.getState().toasts.length, 0, "a dismissed result stays dismissed");
  }
  room.dispose();
});

test("randomized retained answers never duplicate a notice or replace its identity", () => {
  for (let seed = 1; seed <= 20; seed++) {
    let random = seed;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const room = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock() });
    room.setOutbox(new FakeOutbox());
    room.setConnection("open");
    room.applySnapshot({ t: "snapshot", seq: 0, state: projectState(testRoom(), DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" }, watermark: 0 });
    for (let step = 0; step < 20; step++) {
      const scope = next() % 2 ? "setup" : "play";
      const direction = next() % 3 ? "undo" : "redo";
      const quiet = next() % 3 === 0;
      const start = frame(step + 1, 0, step * 2, step);
      start[scope]![direction] = { depth: 1, head: { id: id(step + 10000), label: "changing AC" } };
      room.applyHistory(start);
      const head = start[scope]![direction].head!.id;
      const command: HistoryCommand = direction === "redo" ? { t: "redo", scope, head }
        : scope === "setup" ? { t: "undo", scope: "setup", head } : { t: "undo", scope: "play", head };
      const n = room.dispatch(command, { quiet })!;
      const retained = structuredClone(start);
      retained.serial++;
      retained.watermark = n;
      retained[scope]![direction].head!.retained = { scope: scope === "setup" ? "play" : "setup", direction: "redo", label: "damage", buried: false };
      const before = next() % 2 === 0;
      if (before) room.applyHistory(retained);
      room.applyEv({ t: "ev", seq: 0, changes: [], rejects: [{ n, code: "invalid", message: "could not undo changing AC: redo the other step first" }] });
      if (!before) room.applyHistory(retained);
      const notes = room.store.getState().toasts;
      assert.equal(notes.length, quiet ? 0 : 1, `seed ${seed}, step ${step}: one terminal announcement, none for quiet commands`);
      const identity = notes[0]?.id;
      room.applyEv({ t: "ev", seq: 0, changes: [], rejects: [{ n, code: "invalid", message: "could not undo changing AC: redo the other step first" }] });
      room.applyHistory(retained);
      assert.equal(room.store.getState().toasts[0]?.id, identity, `seed ${seed}, step ${step}: replay preserves identity`);
      if (identity !== undefined) {
        assert.equal(notes[0]!.action?.label, "Review step");
        notes[0]!.action!.run();
        assert.deepEqual(room.store.getState().historyReview, { scope, direction });
        room.ui.dismissToast(identity);
      }
    }
    room.dispose();
  }
});

test("a retained different head is independent of an old refusal and a pending command", () => {
  const room = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock() });
  room.setOutbox(new FakeOutbox());
  room.setConnection("open");
  room.applySnapshot({ t: "snapshot", seq: 0, state: projectState(testRoom(), DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" }, watermark: 0 });
  room.applyHistory(frame());
  const first = room.dispatch({ t: "undo", scope: "setup", head: id(1001) })!;
  room.applyEv({ t: "ev", seq: 0, changes: [], rejects: [{ n: first, code: "invalid", message: "The step changed" }] });
  room.ui.dismissToast(room.store.getState().toasts[0]!.id);
  room.dispatch({ t: "undo", scope: "setup", head: id(1001) });
  const different = frame(2, 0, 1, first);
  different.setup!.undo.head!.retained = { scope: "play", direction: "redo", label: "damage", buried: false };
  room.applyHistory(different);
  assert.equal(room.store.getState().toasts.length, 1);
  assert.equal(room.store.getState().toasts[0]!.action?.label, "Review step");
  room.dispose();
});


test("Review is attached only to the matching refusal toast", () => {
  const room = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock() });
  room.setOutbox(new FakeOutbox());
  room.setConnection("open");
  room.applySnapshot({ t: "snapshot", seq: 0, state: projectState(testRoom(), DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" }, watermark: 0 });
  room.applyHistory(frame());
  room.ui.notify("Another notice", "info");
  const n = room.dispatch({ t: "undo", scope: "setup", head: id(1001) })!;
  room.applyEv({ t: "ev", seq: 0, changes: [], rejects: [{ n, code: "invalid", message: "could not undo changing AC: redo damage first" }] });
  const retained = frame(1, 0, 1, n);
  retained.setup!.undo.head!.retained = { scope: "play", direction: "redo", label: "damage", buried: false };
  room.applyHistory(retained);
  const notes = room.store.getState().toasts;
  assert.equal(notes.length, 2);
  assert.equal(notes[0]!.text, "Another notice");
  assert.equal(notes[0]!.action, undefined);
  assert.equal(notes[1]!.action?.label, "Review step");
  room.applyHistory({ ...retained, serial: 2 });
  assert.equal(room.store.getState().toasts, notes);
  room.dispose();
});
