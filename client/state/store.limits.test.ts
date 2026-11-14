import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HIDDEN_EFFECTS_FULL, HIDDEN_ROW_REFUSED, IDS_TOO_FAST, overNotice, SEAT_FULL } from "#shared/limits.ts";
import type { Viewer } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { DM, P1, room } from "#shared/testutil.ts";
import { LocalServer } from "../dev/localServer.ts";
import { createRoomStore, refusalText } from "./store.ts";
import { FakeClock, FakeOutbox } from "./testing.ts";

type Snapshot = Extract<ServerMessage, { t: "snapshot" }>;
const MiB = 1024 * 1024;

function setup(viewer: Viewer) {
  const server = new LocalServer(room(), viewer, "s1");
  const store = createRoomStore({ roomId: "R1", you: viewer, clock: new FakeClock(), random: () => 0.5, clientId: "c1" });
  store.setOutbox(new FakeOutbox());
  /** A snapshot, with the DM's `over` field when `bytes` is given. */
  const snapshot = (bytes?: number) => {
    const hello = store.prepareHello();
    store.setConnection("open");
    const snap: Snapshot = server.hello({ resumeFrom: hello.resumeFrom, sceneId: "s1" });
    store.applySnapshot(bytes === undefined ? snap : { ...snap, over: { bytes } });
  };
  /** The toasts showing, which it then dismisses, so each step reads only what it brought. */
  const shown = () => {
    const toasts = store.store.getState().toasts;
    for (const t of toasts) store.ui.dismissToast(t.id);
    return toasts.map((t) => t.text);
  };
  return { snapshot, shown };
}

describe("the DM's notice of a room over its size limit (docs/design/design-v1-player-limits.md 15)", () => {
  test("shows once as it appears, again as the MiB over changes either way, and again after the room was under", () => {
    const s = setup(DM);
    s.snapshot(1.5 * MiB);
    assert.deepEqual(s.shown(), [overNotice(2)]);
    s.snapshot(1.9 * MiB);
    assert.deepEqual(s.shown(), [], "the same MiB says nothing new");
    s.snapshot(3.1 * MiB);
    assert.deepEqual(s.shown(), [overNotice(4)]);
    s.snapshot(2 * MiB);
    assert.deepEqual(s.shown(), [overNotice(2)]);
    s.snapshot();
    assert.deepEqual(s.shown(), []);
    s.snapshot(2 * MiB);
    assert.deepEqual(s.shown(), [overNotice(2)]);
  });

  test("a player's page never shows it", () => {
    const s = setup(P1);
    s.snapshot(5 * MiB);
    assert.deepEqual(s.shown(), []);
  });
});

describe("the words of player limits in the toast (docs/design/design-v1-player-limits.md 15)", () => {
  test("each seat's, the ids', and the DM's hidden conditions' words follow Not saved.", () => {
    for (const words of Object.values(SEAT_FULL)) assert.equal(refusalText("quota", words), `Not saved. ${words}`);
    assert.equal(refusalText("quota", IDS_TOO_FAST), `Not saved. ${IDS_TOO_FAST}`);
    assert.equal(refusalText("quota", HIDDEN_EFFECTS_FULL), "Not saved. At most 32 hidden effects per creature.");
  });

  test("a player's row for their own hidden creature reads as the refusal it is", () => {
    assert.equal(refusalText("forbidden", HIDDEN_ROW_REFUSED), HIDDEN_ROW_REFUSED);
  });
});
