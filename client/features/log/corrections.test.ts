import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogEntry } from "#shared/model.ts";
import { CorrectionAnnouncements, correctionText } from "./corrections.ts";
import { describeEvent } from "./format.ts";
import { room } from "#shared/testutil.ts";

const line = (id: string): LogEntry => ({ id, at: "", kind: "event", data: { type: "correction", from: "undo", scope: "setup", label: "secret AC 19", name: "Bree" } } as unknown as LogEntry);

test("player correction text never uses a private DM label", () => {
  for (const from of ["undo", "redo"] as const) for (const scope of ["play", "setup"] as const) {
    const event = { type: "correction" as const, from, scope, label: "secret AC 19", name: "Bree" };
    const verb = from === "undo" ? "undid" : "redid";
    assert.equal(correctionText(event), `The DM ${verb} a ${scope} change to Bree.`);
    assert.equal(describeEvent(event, room()), correctionText(event));
    assert.equal(describeEvent(event, room(), true), `The DM ${verb}${scope === "setup" ? " setup:" : ""} secret AC 19.`);
    assert.equal(correctionText({ ...event, name: undefined }), `The DM ${verb} a ${scope} change.`);
  }
});

test("corrections announce once after committed events, never on snapshot or replay", () => {
  const announcements = new CorrectionAnnouncements();
  assert.deepEqual(announcements.take([line("1:0")], false), []);
  announcements.snapshot([line("1:0")]);
  assert.deepEqual(announcements.take([line("1:0")], false), []);
  assert.deepEqual(announcements.take([line("1:0"), line("2:0")], false), [{ id: "2:0", text: "The DM undid a setup change to Bree." }]);
  assert.deepEqual(announcements.take([line("2:0")], false), []);
  announcements.snapshot([line("1:0"), line("4:0")]);
  assert.deepEqual(announcements.take([line("3:0"), line("4:0")], false), []);
  assert.equal(announcements.take([line("5:0")], false).length, 1);
});
