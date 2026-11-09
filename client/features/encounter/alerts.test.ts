import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * The turn sound is a per-device setting cached for the page, like the
 * ping sound (features/pings/feedback.test.ts). Each case loads the module
 * afresh, as a new tab does. The tabs share one window and one storage.
 */

const stored = new Map<string, string>();
const win = new EventTarget();
Object.assign(globalThis, {
  window: win,
  localStorage: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, String(v)),
  },
});

let tab = 0;
async function loadTab(): Promise<typeof import("./alerts.ts")> {
  return (await import(`./alerts.ts?tab=${++tab}`)) as typeof import("./alerts.ts");
}

/** What the browser sends every other tab when one writes or clears local storage. */
function storageEvent(key: string | null, newValue: string | null): void {
  win.dispatchEvent(Object.assign(new Event("storage"), { key, newValue }));
}

test("turning the sound on in another tab reaches this one and its switches, and a cleared storage puts the default back", async () => {
  stored.clear();
  const here = await loadTab();
  const there = await loadTab();
  assert.equal(here.isSoundOn(), false, "off until turned on");
  const seen: boolean[] = [];
  const stop = here.subscribeSoundOn(() => seen.push(here.isSoundOn()));
  there.setSoundOn(true);
  storageEvent("rvtt.sound", "on");
  assert.equal(here.isSoundOn(), true, "a turn in this tab chimes");
  storageEvent("rvtt.pingSound", "off");
  assert.equal(here.isSoundOn(), true, "another key changes nothing");
  storageEvent(null, null);
  assert.equal(here.isSoundOn(), false);
  stop();
  assert.deepEqual(seen, [true, false]);
});

test("the choice is kept for the next tab", async () => {
  stored.clear();
  (await loadTab()).setSoundOn(true);
  assert.equal((await loadTab()).isSoundOn(), true);
});

test("a trap's sound follows Turn sound and plays on a muted device (docs/design/design-v1-volume.md 4, D-261108-381)", async () => {
  stored.clear();
  let started = 0;
  // Any node the shapes make: it connects, schedules and starts, and a source's start is the sound.
  const node = (): unknown =>
    new Proxy(() => {}, {
      get: (_t, key) => (key === "start" ? () => void started++ : key === "connect" ? () => node() : key === "value" || key === "currentTime" ? 0 : node()),
      apply: () => node(),
    });
  class FakeContext {
    state = "running";
    currentTime = 0;
    sampleRate = 48_000;
    destination = node();
    resume = async () => {};
    createGain = () => node();
    createBiquadFilter = () => node();
    createBufferSource = () => node();
    createOscillator = () => node();
    createBuffer = () => ({ getChannelData: () => new Float32Array(16) });
  }
  Object.assign(win, { AudioContext: FakeContext });
  try {
    const { setRoomSoundChoice } = await import("../device/settings.ts");
    setRoomSoundChoice("off");
    const alerts = await loadTab();
    alerts.playTrapSound("rumble");
    assert.equal(started, 0, "Turn sound off");
    alerts.setSoundOn(true);
    started = 0;
    alerts.playTrapSound("rumble");
    assert.ok(started > 0, "muted, with Turn sound on, the trap sounds");
  } finally {
    delete (win as unknown as { AudioContext?: unknown }).AudioContext;
  }
});
