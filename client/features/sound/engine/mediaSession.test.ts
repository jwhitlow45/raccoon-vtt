import assert from "node:assert/strict";
import { test } from "node:test";
import { SoundMediaSession } from "./mediaSession.ts";

/*
 * The lock screen's and the headset's pause and play
 * (docs/design/design-v1-volume.md 5): pause mutes this device and play
 * unmutes it, the level kept in between, since a mute is the stored
 * choice alone and the level is the mix's.
 */

test("pause mutes and play unmutes, at the level the device kept", async () => {
  const handlers = new Map<string, (() => void) | null>();
  const session = { metadata: null as unknown, playbackState: "none", setActionHandler: (action: string, fn: (() => void) | null) => void handlers.set(action, fn) };
  const g = globalThis as Record<string, unknown>;
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaSession: session } });
  const { roomSoundChoice, setRoomSoundChoice, setSoundMix, soundMix } = await import("../../device/settings.ts");
  try {
    setSoundMix({ ...soundMix(), volume: 65 });
    setRoomSoundChoice("on");
    // As SoundHost.tsx gives a member's page.
    const media = new SoundMediaSession({ roomName: () => "Tower", setOn: (on) => setRoomSoundChoice(on ? "on" : "off") });
    media.set(true);
    assert.equal(session.playbackState, "playing");
    handlers.get("pause")?.();
    assert.equal(roomSoundChoice(), "off", "pause mutes");
    assert.equal(soundMix().volume, 65, "and keeps the level");
    handlers.get("play")?.();
    assert.equal(roomSoundChoice(), "on", "play unmutes");
    assert.equal(soundMix().volume, 65, "at the kept level");
    media.dispose();
    assert.equal(handlers.get("pause"), null);
  } finally {
    setRoomSoundChoice(null);
    if (nav) Object.defineProperty(globalThis, "navigator", nav);
    else delete g.navigator;
  }
});
