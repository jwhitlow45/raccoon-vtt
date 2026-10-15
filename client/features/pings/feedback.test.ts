import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * The ping sound is one setting shown in two places, the ping tool's
 * "Ping sound" and This device's switch (docs/design-v1-visual.md 3.7).
 * Each case loads the module afresh, as a new page does, since it reads
 * storage once as the page starts.
 */

const stored = new Map<string, string>();
const storage = { blocked: false };
Object.assign(globalThis, {
  localStorage: {
    getItem(k: string) {
      if (storage.blocked) throw new DOMException("blocked", "SecurityError");
      return stored.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (storage.blocked) throw new DOMException("blocked", "SecurityError");
      stored.set(k, String(v));
    },
  },
});

let page = 0;
async function loadPage(): Promise<typeof import("./feedback.ts")> {
  return (await import(`./feedback.ts?page=${++page}`)) as typeof import("./feedback.ts");
}

test("a change in one place reaches every subscriber at once, so both controls show it", async () => {
  stored.clear();
  storage.blocked = false;
  const sound = await loadPage();
  assert.equal(sound.soundEnabled(), true, "on until turned off");
  const seen: boolean[] = [];
  const stop = sound.subscribeSound(() => seen.push(sound.soundEnabled()));
  sound.setSoundEnabled(false);
  sound.setSoundEnabled(true);
  stop();
  sound.setSoundEnabled(false);
  assert.deepEqual(seen, [false, true]);
  assert.equal(sound.soundEnabled(), false);
});

test("the choice is kept for the next page", async () => {
  stored.clear();
  storage.blocked = false;
  (await loadPage()).setSoundEnabled(false);
  assert.equal((await loadPage()).soundEnabled(), false);
});

test("with storage blocked the choice still holds for this page", async () => {
  stored.clear();
  storage.blocked = true;
  const sound = await loadPage();
  sound.setSoundEnabled(false);
  assert.equal(sound.soundEnabled(), false);
});
