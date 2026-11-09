import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * The engine's mix (docs/design/design-v1-volume.md 5 and 7): Volume
 * squared over every channel, a display's own level in place of a
 * member's mix, and the display's level heard at once, as a member's mix
 * is.
 */

const stored = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, String(v)),
    removeItem: (k: string) => void stored.delete(k),
  },
});
const { SHORT_FADE_MS } = await import("#shared/sound.ts");
const { channelGains, deviceMix, moveGain, subscribeDeviceMix } = await import("./engine.ts");
const { setSoundMix } = await import("../../device/settings.ts");
const { chooseDisplayVolume } = await import("../../display/remember.ts");

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} is not ${b}`);

test("Volume 50 takes each channel's gain to a quarter, over the device's sliders and the room's volumes", () => {
  const full = channelGains({ volume: 100, music: 80, loops: 60, effects: 100 }, { music: 50, effects: 70 });
  const half = channelGains({ volume: 50, music: 80, loops: 60, effects: 100 }, { music: 50, effects: 70 });
  close(full.music, 0.64 * 0.25, "music at 100");
  close(full.loop, 0.36, "background takes no room volume");
  close(full.effects, 0.49, "effects");
  for (const k of ["music", "loop", "effects"] as const) close(half[k], full[k] * 0.25, k);
});

test("a display plays its own Volume over full channels, and a member its own mix", () => {
  setSoundMix({ volume: 40, music: 80, loops: 80, effects: 80 });
  chooseDisplayVolume(75);
  assert.deepEqual(deviceMix("display"), { volume: 75, music: 100, loops: 100, effects: 100 });
  assert.deepEqual(deviceMix("member"), { volume: 40, music: 80, loops: 80, effects: 80 });
  close(channelGains(deviceMix("display"), { music: 100, effects: 100 }).music, 0.5625, "75% on a display");
});

test("the engine hears a display's level as it changes, and a member's mix, each its own", () => {
  let display = 0;
  let member = 0;
  const offDisplay = subscribeDeviceMix("display", () => display++);
  const offMember = subscribeDeviceMix("member", () => member++);
  chooseDisplayVolume(50);
  assert.deepEqual([display, member], [1, 0]);
  setSoundMix({ volume: 60, music: 80, loops: 80, effects: 80 });
  assert.deepEqual([display, member], [1, 1]);
  offDisplay();
  offMember();
  chooseDisplayVolume(100);
  assert.deepEqual([display, member], [1, 1]);
});

function fakeParam(value: number) {
  const calls: string[] = [];
  return {
    calls,
    value,
    cancelScheduledValues: () => void calls.push("cancel"),
    setValueAtTime: (v: number, t: number) => void calls.push(`set ${v} @${t}`),
    linearRampToValueAtTime: (v: number, t: number) => void calls.push(`ramp ${v} @${t}`),
  };
}

test("a gain ramps over the short fade while the engine plays, and is set at once while it does not", () => {
  const playing = fakeParam(0.49);
  moveGain(playing, 0.0025, 10, true);
  assert.deepEqual(playing.calls, ["cancel", "set 0.49 @10", `ramp 0.0025 @${10 + SHORT_FADE_MS / 1000}`]);
  const held = fakeParam(0.49);
  moveGain(held, 0.0025, 10, false);
  assert.deepEqual(held.calls, ["cancel", "set 0.0025 @10"], "no ramp is left running when the engine goes active");
});
