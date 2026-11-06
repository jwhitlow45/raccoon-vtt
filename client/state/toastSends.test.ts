import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ACTION_TOAST_MS, createRoomStore, SEND_FAILED, settledToasts, toastsLeft, withToast } from "./store.ts";
import type { Toast, ToastSend } from "./types.ts";

/*
 * A toast's buttons that wait on the server (types.ts ToastSend), as a
 * damage roll's Apply to chips on the DM's device use them (QOL audit Q2):
 * busy until the answer, the toast kept with its time stopped meanwhile,
 * closed once taken, and a refusal's words shown in it.
 */

const chip = (label: string, send: () => PromiseLike<string | null>): ToastSend => ({ label, name: `Apply 9 damage to ${label}`, send });
const rollToast = (id: number, shownAt: number, extra: Partial<Toast> = {}): Toast => ({ id, text: `Bree rolled 9 for Longsword damage. ${id}`, tone: "info", logged: true, actions: [chip("Goblin 1", async () => null)], actionsLabel: "Apply to", shownAt, ...extra });

/** A send whose answer the test gives when it likes. */
function deferred() {
  let answer: (words: string | null) => void = () => {};
  let fail: () => void = () => {};
  let sent = 0;
  const send = () => {
    sent++;
    return new Promise<string | null>((resolve, reject) => {
      answer = resolve;
      fail = () => reject(new Error("socket gone"));
    });
  };
  return { send, answer: (w: string | null) => answer(w), fail: () => fail(), sent: () => sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a toast's buttons that wait on the server", () => {
  test("its time is a button toast's, and while busy it neither runs nor runs out", () => {
    assert.deepEqual(toastsLeft([rollToast(1, 0)], 4_000), [{ id: 1, ms: ACTION_TOAST_MS - 4_000, runs: true }]);
    // Pressed with a second left, then the answer is slow: it stays drawn, and no timer takes it.
    assert.deepEqual(toastsLeft([rollToast(1, 0, { busy: 0 })], 60_000), [{ id: 1, ms: ACTION_TOAST_MS, runs: false }]);
  });

  test("a full stack never pushes it off, as it never does a toast with a button", () => {
    const logged = (id: number): Toast => ({ id, text: `Pat whispers ${id}`, tone: "info", logged: true, shownAt: id });
    let list = withToast([], rollToast(1, 1));
    for (const id of [2, 3, 4, 5]) list = withToast(list, logged(id));
    assert.deepEqual(list.map((t) => t.id), [1, 4, 5]);
  });

  test("the answer: taken closes it, a refusal shows its words with its time started again, and a toast gone stays gone", () => {
    const list = [rollToast(1, 0, { busy: 0 }), rollToast(2, 0)];
    assert.deepEqual(settledToasts(list, 1, null, 9_000).map((t) => t.id), [2]);
    const refused = settledToasts(list, 1, "Goblin 1 is gone.", 9_000)[0]!;
    assert.equal(refused.busy, undefined);
    assert.equal(refused.said, "Goblin 1 is gone.");
    assert.deepEqual(toastsLeft([refused], 9_000), [{ id: 1, ms: ACTION_TOAST_MS, runs: true }]);
    // Shown whole as the refusal came: it stays held, with its whole time to read once let go.
    const held = settledToasts([rollToast(1, 0, { busy: 0, pausedAt: 3_000 })], 1, "No.", 9_000)[0]!;
    assert.deepEqual(toastsLeft([held], 20_000), [{ id: 1, ms: ACTION_TOAST_MS, runs: false }]);
    assert.equal(settledToasts(list, 7, null, 9_000), list, "a toast dismissed meanwhile");
  });

  test("through the store: busy refuses a second press, taken closes the toast, a refusal says why and the button works again", async () => {
    const room = createRoomStore({ roomId: "room", you: { memberId: "dm", role: "dm" }, clientId: "device" });
    try {
      const a = deferred();
      const b = deferred();
      room.ui.notify("Bree rolled 9 for Longsword damage.", "info", undefined, { label: "Apply to", buttons: [chip("Goblin 1", a.send), chip("Goblin 2", b.send)] }, true);
      const toast = () => room.store.getState().toasts[0];
      const id = toast()!.id;
      assert.equal(toast()!.actionsLabel, "Apply to");
      room.ui.toastsDrawn([id]);
      room.ui.pressToast!(id, 0);
      assert.equal(toast()!.busy, 0);
      room.ui.pressToast!(id, 0);
      room.ui.pressToast!(id, 1);
      assert.deepEqual([a.sent(), b.sent()], [1, 0], "one send at a time, the toast's other buttons refused too");
      a.answer("Goblin 1 is already dead.");
      await settle();
      assert.equal(toast()!.busy, undefined);
      assert.equal(toast()!.said, "Goblin 1 is already dead.");
      room.ui.pressToast!(id, 1);
      assert.equal(b.sent(), 1);
      b.answer(null);
      await settle();
      assert.equal(toast(), undefined, "taken: the toast closes");
    } finally {
      room.dispose();
    }
  });

  test("a send that throws says it could not be sent, and a toast with no buttons left gets none", async () => {
    const room = createRoomStore({ roomId: "room", you: { memberId: "dm", role: "dm" }, clientId: "device" });
    try {
      const a = deferred();
      room.ui.notify("Bree rolled 9.", "info", undefined, { label: "Apply to", buttons: [chip("Goblin 1", a.send)] });
      const id = room.store.getState().toasts[0]!.id;
      room.ui.pressToast!(id, 0);
      a.fail();
      await settle();
      assert.equal(room.store.getState().toasts[0]!.said, SEND_FAILED);
      room.ui.notify("Ana rolled 4.", "info", undefined, { label: "Apply to", buttons: [] });
      const plain = room.store.getState().toasts[1]!;
      assert.deepEqual([plain.actions, plain.actionsLabel], [undefined, undefined]);
    } finally {
      room.dispose();
    }
  });

  test("many orders of presses, answers, refusals, dismissals and time: one send in flight a toast, nothing busy once all are answered, and a closed toast never comes back (randomized)", async () => {
    for (let seed = 1; seed <= 60; seed++) {
      let random = seed;
      const draw = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
      let now = 0;
      const realNow = Date.now;
      Date.now = () => now;
      const room = createRoomStore({ roomId: "room", you: { memberId: "dm", role: "dm" }, clientId: "device" });
      try {
        const out = new Map<number, { answer(w: string | null): void }>();
        let inFlight = 0;
        const gone = new Set<number>();
        const ids: number[] = [];
        for (let step = 0; step < 80; step++) {
          now += draw() % 3_000;
          const kind = draw() % 6;
          const toasts = room.store.getState().toasts;
          if (kind === 0 || ids.length === 0) {
            const n = step;
            const make = (label: string): ToastSend =>
              chip(label, () => {
                inFlight++;
                return new Promise((resolve) => {
                  const id = room.store.getState().toasts.find((t) => t.text === `Roll ${n}`)?.id ?? -1;
                  assert.ok(!out.has(id), `seed ${seed}: a second send while ${id} waits`);
                  out.set(id, {
                    answer: (w) => {
                      inFlight--;
                      out.delete(id);
                      resolve(w);
                    },
                  });
                });
              });
            room.ui.notify(`Roll ${n}`, "info", undefined, { label: "Apply to", buttons: [make("Goblin 1"), make("Goblin 2")] }, true);
            const id = room.store.getState().toasts.at(-1)!.id;
            ids.push(id);
            room.ui.toastsDrawn([id]);
          } else if (kind === 1 || kind === 2) {
            const id = ids[draw() % ids.length]!;
            room.ui.pressToast!(id, draw() % 2);
          } else if (kind === 3 && out.size > 0) {
            const [, waiting] = [...out.entries()][draw() % out.size]!;
            waiting.answer(draw() % 2 === 0 ? null : "Refused.");
            await settle();
          } else if (kind === 4 && toasts.length > 0) {
            const t = toasts[draw() % toasts.length]!;
            room.ui.dismissToast(t.id);
          }
          for (const t of room.store.getState().toasts) {
            assert.ok(!gone.has(t.id), `seed ${seed}: toast ${t.id} came back`);
            if (t.busy !== undefined) assert.ok(out.has(t.id), `seed ${seed}: busy with nothing out`);
          }
          for (const id of ids) if (!room.store.getState().toasts.some((t) => t.id === id)) gone.add(id);
        }
        for (const waiting of [...out.values()]) waiting.answer(null);
        await settle();
        assert.equal(inFlight, 0);
        assert.ok(room.store.getState().toasts.every((t) => t.busy === undefined), `seed ${seed}: busy after every answer`);
      } finally {
        room.dispose();
        Date.now = realNow;
      }
    }
  });
});
