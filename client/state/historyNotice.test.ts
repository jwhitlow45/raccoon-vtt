import assert from "node:assert/strict";
import { test } from "node:test";
import { projectState } from "#shared/project.ts";
import { DM, P1, room as testRoom } from "#shared/testutil.ts";
import type { HistoryMessage } from "#shared/undoContract.ts";
import { createRoomStore } from "./store.ts";
import { FakeClock } from "./testing.ts";
import { UndoNotice, UNDO_NOTICE_KEY } from "./historyNotice.ts";

const empty = () => ({ undo: { head: null, depth: 0 }, redo: { head: null, depth: 0 } });
const message = (seq = 0): HistoryMessage => ({ t: "history", epoch: "00000000-0000-4000-8000-000000000001", seq, serial: 0, watermark: 0, play: empty(), setup: empty() });

function page(role: "dm" | "player" | "display" = "dm", claim = () => true) {
  const viewer = role === "dm" ? DM : P1;
  const room = createRoomStore({ roomId: "R1", you: viewer, clock: new FakeClock(), undoNotice: { claim } });
  room.setConnection("open");
  const snapshot = () => room.applySnapshot({ t: "snapshot", seq: 0, watermark: 0, state: projectState(testRoom(), viewer, { sceneId: "s1" }), you: { ...viewer, role, sceneId: "s1" } });
  const shown = () => room.store.getState().undoNotice === true;
  return { room, snapshot, shown };
}

test("the rollout notice waits for accepted scoped DM history after a snapshot", () => {
  let claims = 0;
  const p = page("dm", () => ++claims === 1);
  p.room.applyHistory(message());
  assert.equal(p.shown(), false, "pre-snapshot history cannot trigger the notice");
  p.snapshot();
  assert.equal(p.shown(), false, "a snapshot is not scoped history");
  const playOnly = message();
  delete playOnly.setup;
  p.room.applyHistory(playOnly);
  assert.equal(p.shown(), false, "Play-only history cannot trigger the rollout notice");
  p.room.applyHistory({ ...message(1), serial: 1 });
  assert.equal(p.shown(), false, "future history waits for its confirmed state");
  assert.equal(claims, 0);
  p.room.applyEv({ t: "ev", seq: 1, changes: [] });
  assert.equal(p.shown(), true);
  assert.equal(claims, 1);
  p.room.dispose();
});

test("players and displays never claim the rollout flag, even with unexpected Setup history", () => {
  for (const role of ["player", "display"] as const) {
    let claims = 0;
    const p = page(role, () => { claims++; return true; });
    p.snapshot();
    p.room.applyHistory(message());
    assert.equal(p.shown(), false, role);
    assert.equal(claims, 0, role);
    p.room.dispose();
  }
});

test("a device that already saw the rollout notice stays quiet", () => {
  const p = page("dm", () => false);
  p.snapshot();
  p.room.applyHistory(message());
  assert.equal(p.shown(), false);
  p.room.dispose();
});

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const writes: [string, string][] = [];
  return {
    getItem: (key: string) => { assert.equal(key, UNDO_NOTICE_KEY); return value; },
    setItem: (key: string, next: string) => { writes.push([key, next]); value = next; },
    writes,
  };
}

test("the notice persists once per device, including empty or unfamiliar storage values", () => {
  for (const initial of [null, "", "0", "unfamiliar"]) {
    const storage = memoryStorage(initial);
    const first = new UndoNotice(() => storage);
    assert.equal(first.claim(), true, String(initial));
    assert.equal(first.claim(), false, "one page never repeats it");
    assert.deepEqual(storage.writes, [[UNDO_NOTICE_KEY, "1"]]);
    assert.equal(new UndoNotice(() => storage).claim(), false, "a fresh page reads the device flag");
    assert.equal(storage.writes.length, 1, "reading an existing flag does not rewrite it");
  }
});

test("missing storage and throwing access, reads or writes still show once per page lifetime", () => {
  const denied = () => { throw new Error("storage denied"); };
  for (const storage of [() => null, denied, () => ({ getItem: denied, setItem: denied }), () => ({ getItem: () => null, setItem: denied })]) {
    const notice = new UndoNotice(storage);
    assert.equal(notice.claim(), true);
    assert.equal(notice.claim(), false);
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: denied });
  try {
    assert.equal(new UndoNotice().claim(), true, "accessing the browser property itself may throw");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("dismissal lasts through history updates, reconnects and fresh room pages", () => {
  const storage = memoryStorage();
  const once = new UndoNotice(() => storage);
  const p = page("dm", () => once.claim());
  p.snapshot();
  p.room.applyHistory(message());
  assert.equal(p.shown(), true);
  assert.equal(p.room.store.getState().toasts.length, 0, "the lasting notice does not create a timed duplicate");
  p.room.ui.dismissUndoNotice!();
  assert.equal(p.shown(), false);
  p.room.applyHistory({ ...message(), serial: 1 });
  assert.equal(p.shown(), false);
  p.room.suspend();
  p.snapshot();
  p.room.setConnection("open");
  p.room.applyHistory(message());
  assert.equal(p.shown(), false);
  p.room.dispose();
  const fresh = new UndoNotice(() => storage);
  const next = page("dm", () => fresh.claim());
  next.snapshot();
  next.room.applyHistory(message());
  assert.equal(next.shown(), false);
  next.room.dispose();
});

test("retired connections and foreign epochs never consume the device notice", () => {
  let claims = 0;
  const p = page("dm", () => ++claims === 1);
  p.snapshot();
  const old = p.room.historyConnection();
  p.room.suspend();
  p.snapshot();
  p.room.applyHistory(message(), old);
  assert.equal(claims, 0);
  const play = message();
  delete play.setup;
  p.room.applyHistory(play);
  p.room.applyHistory({ ...message(), epoch: "00000000-0000-4000-8000-000000000002" });
  assert.equal(claims, 0);
  p.room.applyHistory({ ...message(), serial: 1 });
  assert.equal(p.shown(), true);
  assert.equal(claims, 1);
  p.room.dispose();
});
