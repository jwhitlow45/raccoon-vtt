import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogEntry } from "#shared/model.ts";
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
