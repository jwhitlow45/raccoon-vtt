import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogEntry } from "#shared/model.ts";
import type { StackHistoryCommand } from "#shared/undoContract.ts";
import { CorrectionAnnouncements } from "./corrections.ts";
import { describeEvent } from "./format.ts";
import { DM, P1, room } from "#shared/testutil.ts";
import { projectState } from "#shared/project.ts";
import { createRoomStore } from "../../state/store.ts";
import { FakeClock } from "../../state/testing.ts";

const line = (id: string): LogEntry => ({ id, at: "", kind: "event", data: { type: "correction", from: "undo", scope: "setup", label: "secret AC 19", name: "Bree" } });

test("player correction text never uses a private DM label", () => {
  for (const from of ["undo", "redo"] as const) for (const scope of ["play", "setup"] as const) {
    const event = { type: "correction" as const, from, scope, label: "secret AC 19", name: "Bree" };
    const verb = from === "undo" ? "undid" : "redid";
    assert.equal(describeEvent(event, room()), `The DM ${verb} a ${scope} change to Bree.`);
    assert.equal(describeEvent(event, room(), true), `The DM ${verb}${scope === "setup" ? " setup:" : ""} secret AC 19.`);
    assert.equal(describeEvent({ ...event, name: undefined }, room()), `The DM ${verb} a ${scope} change.`);
    for (const dm of [false, true]) {
      const announcements = new CorrectionAnnouncements();
      announcements.snapshot([]);
      assert.deepEqual(announcements.take([{ ...line("1:0"), data: event }], dm, room()), [{ id: "1:0", text: describeEvent(event, room(), dm) }]);
    }
  }
});

test("corrections announce once after committed events, never on snapshot or replay", () => {
  const announcements = new CorrectionAnnouncements();
  assert.deepEqual(announcements.take([line("1:0")], false, room()), []);
  announcements.snapshot([line("1:0")]);
  assert.deepEqual(announcements.take([line("1:0")], false, room()), []);
  assert.deepEqual(announcements.take([line("1:0"), line("2:0")], false, room()), [{ id: "2:0", text: "The DM undid a setup change to Bree." }]);
  assert.deepEqual(announcements.take([line("2:0")], false, room()), []);
  announcements.snapshot([line("1:0"), line("4:0")]);
  assert.deepEqual(announcements.take([line("3:0"), line("4:0")], false, room()), []);
  assert.equal(announcements.take([line("5:0")], false, room()).length, 1);
});

test("the store announces correction text for its own viewer once without changing panels", () => {
  for (const viewer of [DM, P1]) {
    const state = room();
    const store = createRoomStore({ roomId: "R1", you: viewer, clock: new FakeClock() });
    store.setConnection("open");
    const snapshot = { t: "snapshot" as const, seq: 0, state: projectState(state, viewer, { sceneId: "s1" }), you: { ...viewer, sceneId: "s1" }, watermark: 0 };
    store.applySnapshot(snapshot);
    const local = store.store.getState().local;
    const event = line("1:0");
    store.applyEv({ t: "ev", seq: 1, changes: [{ key: "log:1:0", value: event }] });
    const notices = store.store.getState().toasts;
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.text, describeEvent(event.data!, state, viewer.role === "dm"));
    assert.equal(notices[0]!.logged, true);
    assert.equal(store.store.getState().local, local);
    store.applySnapshot({ ...snapshot, seq: 1, state: { ...snapshot.state, log: [event] } });
    store.applyEv({ t: "ev", seq: 1, changes: [{ key: "log:1:0", value: event }] });
    assert.deepEqual(store.store.getState().toasts, notices);
    store.dispose();
  }
});

import { FakeOutbox } from "../../state/testing.ts";

const head = "00000000-0000-4000-8000-000000000001";

for (const direction of ["undo", "redo"] as const) for (const scope of ["play", "setup"] as const) for (const quiet of [false, true]) test(`own ${scope} ${direction} has one result and no correction announcement, quiet=${quiet}`, () => {
  const state = room();
  const store = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock() });
  store.setOutbox(new FakeOutbox());
  store.setConnection("open");
  store.applySnapshot({ t: "snapshot", seq: 0, state: projectState(state, DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" }, watermark: 0 });
  const command: StackHistoryCommand = direction === "redo" ? { t: "redo", scope, head }
    : scope === "setup" ? { t: "undo", scope: "setup", head } : { t: "undo", head };
  const n = store.dispatch(command, { quiet })!;
  const own: LogEntry = { ...line("1:0"), data: { type: "correction", from: direction, scope, label: "moving Goblin 2" } };
  const other: LogEntry = { ...line("2:0"), data: { type: "correction", from: direction, scope: "setup", label: "changing AC" } };
  const ev = { t: "ev" as const, seq: 2, acks: [n], restored: [{ n, what: "moving Goblin 2" }], changes: [{ key: "log:1:0", value: own }, { key: "log:2:0", value: other }] };
  store.applyEv(ev);
  const verb = direction === "undo" ? "Undid" : "Redid";
  assert.deepEqual(store.store.getState().toasts.map((t) => t.text), [...(quiet ? [] : [`${verb}${scope === "setup" ? " setup:" : ""} moving Goblin 2.`]), `The DM ${verb.toLowerCase()} setup: changing AC.`]);
  assert.equal(store.store.getState().confirmed!.log.length, 2, "both corrections stay in the Log");
  const ids = store.store.getState().toasts.map((t) => t.id);
  store.applyEv(ev);
  assert.deepEqual(store.store.getState().toasts.map((t) => t.id), ids, "quiet suppression advances the correction cursor too");
  store.dispose();
});

test("another device's correction still announces beside a refused local undo", () => {
  const store = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock() });
  store.setOutbox(new FakeOutbox());
  store.setConnection("open");
  store.applySnapshot({ t: "snapshot", seq: 0, state: projectState(room(), DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" }, watermark: 0 });
  const n = store.dispatch({ t: "undo", head })!;
  const correction = line("1:0");
  store.applyEv({ t: "ev", seq: 1, rejects: [{ n, code: "invalid", message: "The step changed" }], changes: [{ key: "log:1:0", value: correction }] });
  assert.equal(store.store.getState().toasts.filter((t) => t.logged).length, 1);
  store.dispose();
});


test("suppress only one matching correction per own command, preserving other scopes and directions", () => {
  const announcements = new CorrectionAnnouncements();
  announcements.snapshot([]);
  const events: LogEntry[] = [
    { ...line("1:0"), data: { type: "correction", from: "undo", scope: "setup", label: "moving Goblin 2" } },
    { ...line("2:0"), data: { type: "correction", from: "redo", scope: "play", label: "moving Goblin 2" } },
    { ...line("3:0"), data: { type: "correction", from: "undo", scope: "play", label: "another move" } },
    { ...line("4:0"), data: { type: "correction", from: "undo", scope: "play", label: "moving Goblin 2" } },
    { ...line("5:0"), data: { type: "correction", from: "undo", scope: "play", label: "moving Goblin 2" } },
  ];
  const own = [{ from: "undo" as const, scope: "play" as const, label: "moving Goblin 2" }];
  assert.deepEqual(announcements.take(events, true, room(), own).map((entry) => entry.id), ["1:0", "2:0", "3:0", "5:0"]);
  assert.deepEqual(announcements.take(events, true, room()), []);
});

test("ordinary edits, Log undo and discard never suppress another device's correction", () => {
  const ops = [
    { t: "scene.update", sceneId: "s1", patch: { name: "Crypt" } },
    { t: "undo", log: "1:0" },
    { t: "undo", head, discard: true },
  ] as const;
  for (const op of ops) {
    const store = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock() });
    store.setOutbox(new FakeOutbox());
    store.setConnection("open");
    store.applySnapshot({ t: "snapshot", seq: 0, state: projectState(room(), DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" }, watermark: 0 });
    const n = store.dispatch(op, { quiet: true })!;
    const correction: LogEntry = { ...line("1:0"), data: { type: "correction", from: "undo", scope: "play", label: "moving Goblin 2" } };
    store.applyEv({ t: "ev", seq: 1, acks: [n], restored: [{ n, what: "moving Goblin 2" }], changes: [{ key: "log:1:0", value: correction }] });
    assert.equal(store.store.getState().toasts.filter((t) => t.logged).length, 1, op.t);
    store.dispose();
  }
});

test("a restored label for a different command cannot silence a correction", () => {
  const store = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock() });
  store.setOutbox(new FakeOutbox());
  store.setConnection("open");
  store.applySnapshot({ t: "snapshot", seq: 0, state: projectState(room(), DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" }, watermark: 0 });
  const n = store.dispatch({ t: "undo", head }, { quiet: true })!;
  const correction: LogEntry = { ...line("1:0"), data: { type: "correction", from: "undo", scope: "play", label: "moving Goblin 2" } };
  store.applyEv({ t: "ev", seq: 1, acks: [n], restored: [{ n: n + 1, what: "moving Goblin 2" }], changes: [{ key: "log:1:0", value: correction }] });
  assert.equal(store.store.getState().toasts.filter((t) => t.logged).length, 1);
  store.dispose();
});
