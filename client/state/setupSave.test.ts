import assert from "node:assert/strict";
import { test } from "node:test";
import type { Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { serverMessageSchema, type ClientOp, type ServerMessage } from "#shared/protocol.ts";
import type { UndoScope } from "#shared/undoContract.ts";
import { DM, P1, room as roomState } from "#shared/testutil.ts";
import { createRoomStore } from "./store.ts";
import { FakeClock, FakeOutbox } from "./testing.ts";

const SAVED = "Saved. Undo in Setup history.";
const TOO_LARGE = "This change is too large to undo.";
const rename: ClientOp = { t: "scene.update", sceneId: "s1", patch: { name: "The crypt" } };
type StateEvent = Extract<ServerMessage, { t: "ev" }>;
type Ev = StateEvent;

function setup(viewer: Viewer = DM) {
  const room = createRoomStore({ roomId: "R1", you: viewer, clock: new FakeClock() });
  room.setOutbox(new FakeOutbox());
  room.setConnection("open");
  const snapshot = (watermark = 0) => room.applySnapshot({ t: "snapshot", seq: room.store.getState().seq, watermark, state: projectState(roomState(), viewer, { sceneId: "s1" }), you: { ...viewer, sceneId: "s1" } });
  snapshot();
  const event = (n: number, scope: UndoScope = "setup", changed = true, extra: Partial<Ev> = {}): Ev => ({
    t: "ev", seq: room.store.getState().seq + 1, changes: [], acks: [n], ackDetails: [{ n, scope, changed, recorded: true }], ...extra,
  });
  const notices = () => room.store.getState().toasts.filter((toast) => toast.text === SAVED);
  const oversized = () => room.store.getState().toasts.filter((toast) => toast.text === TOO_LARGE);
  const clear = () => [...notices(), ...oversized()].forEach((toast) => room.ui.dismissToast(toast.id));
  return { room, snapshot, event, notices, oversized, clear };
}

test("only a server-confirmed effective Setup save announces, including quiet editors", () => {
  for (const quiet of [false, true]) {
    const s = setup();
    const n = s.room.dispatch(rename, { quiet })!;
    assert.equal(s.notices().length, 0, "optimistic state is not a confirmation");
    s.room.applyEv(s.event(n));
    assert.equal(s.notices().length, 1, "the server's per-op effect is authoritative even without visible changes");
    s.room.dispose();
  }
});

test("server scope overrides the client's apparent operation scope and group declaration", () => {
  for (const scope of ["play", "none", "setup"] as const) {
    const s = setup();
    const n = s.room.dispatch(rename, { group: "setup", groupScope: "setup" })!;
    s.room.applyEv(s.event(n, scope, true, { changes: [{ key: "scene:s1", value: { ...s.room.store.getState().view!.scenes.s1, name: "The crypt" } }] }));
    assert.equal(s.notices().length, scope === "setup" ? 1 : 0);
    s.room.dispose();
  }
  const promoted = setup();
  const n = promoted.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { suggestedView: "isometric" } })!;
  promoted.room.applyEv(promoted.event(n));
  assert.equal(promoted.notices().length, 1, "a later gesture part can inherit Setup without a local declaration");
  promoted.room.dispose();
});

test("recorded and oversized acknowledgment fields survive the socket's parse of the wire frame", () => {
  for (const tooLarge of [false, true]) {
    const s = setup();
    const n = s.room.dispatch(rename)!;
    const ev = s.event(n, "setup", true, { ackDetails: [{ n, scope: "setup", changed: true, recorded: !tooLarge, ...(tooLarge ? { tooLarge: true as const } : {}) }] });
    const parsed = serverMessageSchema.parse(JSON.parse(JSON.stringify(ev)));
    assert.equal(parsed.t, "ev");
    s.room.applyEv(parsed as Ev);
    assert.equal(s.notices().length, tooLarge ? 0 : 1, "only a recorded step promises Setup history");
    assert.equal(s.oversized().length, tooLarge ? 1 : 0, "only the sender hears that the change is too large");
    s.room.dispose();
  }
});

test("changed false and missing metadata never infer success from projected values", () => {
  for (const details of ["unchanged", "missing"] as const) {
    const s = setup();
    const n = s.room.dispatch(rename)!;
    const ev = s.event(n, "setup", false, { changes: [{ key: "scene:s1", value: { ...s.room.store.getState().view!.scenes.s1, name: "The crypt" } }] });
    if (details === "missing") delete ev.ackDetails;
    s.room.applyEv(ev);
    assert.equal(s.notices().length, 0, details);
    s.room.dispose();
  }
});

test("mixed-device batches and incomplete projections still confirm this sender's save", () => {
  const s = setup();
  const n = s.room.dispatch({ t: "character.update", characterId: "outside-view", patch: { ownerIds: [] } })!;
  s.room.applyEv(s.event(n, "setup", true, { seq: 18 }));
  assert.equal(s.notices().length, 1);
  s.room.dispose();
});

test("players and displays never advertise Setup history", () => {
  for (const role of ["player", "display"] as const) {
    const s = setup(P1);
    s.room.applySnapshot({ t: "snapshot", seq: 0, watermark: 0, state: projectState(roomState(), P1, { sceneId: "s1" }), you: { ...P1, role, sceneId: "s1" } });
    const n = s.room.dispatch(rename)!;
    s.room.applyEv(s.event(n));
    assert.equal(s.notices().length, 0, role);
    s.room.dispose();
  }
});

test("details must match both an acknowledgment and a pending command by number", () => {
  for (const kind of ["no-ack", "foreign-number", "pending-other"] as const) {
    const s = setup();
    const n = s.room.dispatch(rename)!;
    const other = s.room.dispatch(rename)!;
    const ev = s.event(n);
    if (kind === "no-ack") ev.acks = [];
    if (kind === "foreign-number") ev.ackDetails = [{ n: 999, scope: "setup", changed: true, recorded: true }];
    if (kind === "pending-other") ev.ackDetails = [{ n: other, scope: "setup", changed: true, recorded: true }];
    s.room.applyEv(ev);
    assert.equal(s.notices().length, 0, kind);
    s.room.dispose();
  }
});

test("a refusal wins over contradictory acknowledgment metadata", () => {
  const s = setup();
  const n = s.room.dispatch(rename)!;
  s.room.applyEv(s.event(n, "setup", true, { rejects: [{ n, code: "invalid", message: "Changed elsewhere" }] }));
  assert.equal(s.notices().length, 0);
  s.room.dispose();
});

test("per-op effects survive a batch that returns to its starting values", () => {
  const s = setup();
  const first = s.room.dispatch(rename)!;
  const second = s.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { name: "s1" } })!;
  s.room.applyEv(s.event(first, "setup", true, { seq: 2, acks: [first, second], ackDetails: [{ n: second, scope: "setup", changed: true, recorded: true }, { n: first, scope: "setup", changed: true, recorded: true }] }));
  assert.equal(s.notices().length, 1, "one confirmation for this batch of saves, despite no net projected change");
  s.room.dispose();
});

test("a later save renews the notice, but duplicate acknowledgments never do", () => {
  const s = setup();
  const n = s.room.dispatch(rename)!;
  const ev = s.event(n);
  s.room.applyEv(ev);
  const first = s.notices()[0]!.id;
  s.room.applyEv(ev);
  assert.equal(s.notices()[0]!.id, first);
  const next = s.room.dispatch(rename)!;
  s.room.applyEv(s.event(next));
  assert.equal(s.notices().length, 1);
  assert.notEqual(s.notices()[0]!.id, first);
  s.clear();
  s.room.applyEv(s.event(next));
  assert.equal(s.notices().length, 0, "dismissed confirmations do not return on duplicate delivery");
  s.room.dispose();
});

test("a reconnect snapshot settles a lost answer without confirming a save", () => {
  const s = setup();
  const n = s.room.dispatch(rename)!;
  s.room.suspend();
  s.snapshot(n);
  assert.equal(s.notices().length, 0);
  s.room.applyEv(s.event(n));
  assert.equal(s.notices().length, 0, "a delayed receipt cannot revive a settled command");
  s.room.dispose();
});

test("randomized scopes, effects, refusals, missing receipts and lost answers keep confirmation invariants", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const s = setup();
    let random = seed;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 30; step++) {
      s.clear();
      const n = s.room.dispatch(rename, { quiet: next() % 2 === 0 })!;
      assert.equal(s.notices().length, 0, `seed ${seed}, step ${step}: no optimistic confirmation`);
      const scope = (["play", "setup", "none"] as const)[next() % 3]!;
      const changed = next() % 3 !== 0;
      const kind = next() % 5;
      const ev = s.event(n, scope, changed, { seq: s.room.store.getState().seq + 1 + next() % 5 });
      const recorded = next() % 3 !== 0;
      const tooLarge = !recorded && next() % 2 === 0;
      ev.ackDetails = [{ n, scope, changed, recorded, ...(tooLarge ? { tooLarge: true as const } : {}) }];
      if (kind === 0) delete ev.ackDetails;
      if (kind === 1) ev.rejects = [{ n, code: "invalid", message: "No longer available" }];
      if (kind === 2) s.snapshot(n);
      else s.room.applyEv(ev);
      assert.equal(s.notices().length, kind > 2 && scope === "setup" && changed && recorded ? 1 : 0, `seed ${seed}, step ${step}: only an accepted effective Setup receipt confirms`);
      assert.equal(s.oversized().length, kind > 2 && changed && tooLarge ? 1 : 0, `seed ${seed}, step ${step}: only the oversized flag warns`);
      const warning = s.oversized()[0]?.id;
      const id = s.notices()[0]?.id;
      s.room.applyEv(ev);
      assert.equal(s.oversized()[0]?.id, warning, "warnings never repeat on replay");
      assert.equal(s.notices()[0]?.id, id, `seed ${seed}, step ${step}: repeated delivery never repeats confirmation`);
    }
    s.room.dispose();
  }
});


test("only a recorded Setup step promises Undo, including legacy metadata", () => {
  for (const recorded of [false, undefined]) {
    const s = setup();
    const n = s.room.dispatch(rename)!;
    s.room.applyEv(s.event(n, "setup", true, { ackDetails: [{ n, scope: "setup", changed: true, ...(recorded === undefined ? {} : { recorded }) }] }));
    assert.equal(s.notices().length, 0);
    assert.equal(s.oversized().length, 0, "unrecorded alone does not mean oversized");
    s.room.dispose();
  }
});

for (const viewer of [DM, P1]) for (const scope of ["play", "setup"] as const) test(`${viewer.role} gets one oversized ${scope} warning, including quiet commands`, () => {
  for (const quiet of [false, true]) {
    const s = setup(viewer);
    const n = s.room.dispatch(rename, { quiet })!;
    const ev = s.event(n, scope, true, { ackDetails: [{ n, scope, changed: true, recorded: false, tooLarge: true }] });
    s.room.applyEv(ev);
    assert.equal(s.notices().length, 0);
    assert.equal(s.oversized().length, 1);
    const id = s.oversized()[0]!.id;
    s.room.applyEv(ev);
    assert.equal(s.oversized()[0]!.id, id);
    const again = s.room.dispatch(rename, { quiet })!;
    s.room.applyEv(s.event(again, scope, true, { ackDetails: [{ n: again, scope, changed: true, recorded: false, tooLarge: true }] }));
    assert.equal(s.oversized().length, 1);
    assert.notEqual(s.oversized()[0]!.id, id, "a later oversized save has a fresh result");
    s.room.dispose();
  }
});

test("an oversized save clears an earlier promise and dominates a mixed batch", () => {
  const s = setup();
  const old = s.room.dispatch(rename)!;
  s.room.applyEv(s.event(old));
  assert.equal(s.notices().length, 1);
  const large = s.room.dispatch(rename)!;
  const small = s.room.dispatch(rename)!;
  s.room.applyEv(s.event(large, "setup", true, { acks: [large, small], ackDetails: [
    { n: large, scope: "setup", changed: true, recorded: false, tooLarge: true },
    { n: small, scope: "setup", changed: true, recorded: true },
  ] }));
  assert.equal(s.notices().length, 0);
  assert.equal(s.oversized().length, 1);
  s.room.dispose();
});

test("oversized details need an effective, pending, accepted command on this device", () => {
  for (const kind of ["unchanged", "foreign", "no-ack", "refused", "snapshot"] as const) {
    const s = setup();
    const n = s.room.dispatch(rename)!;
    const ev = s.event(n, "setup", true, { ackDetails: [{ n: kind === "foreign" ? n + 1 : n, scope: "setup", changed: kind !== "unchanged", recorded: false, tooLarge: true }] });
    if (kind === "no-ack") ev.acks = [];
    if (kind === "refused") ev.rejects = [{ n, code: "invalid", message: "Refused" }];
    if (kind === "snapshot") s.snapshot(n);
    s.room.applyEv(ev);
    assert.equal(s.oversized().length, 0, kind);
    assert.equal(s.notices().length, 0, kind);
    s.room.dispose();
  }
});
