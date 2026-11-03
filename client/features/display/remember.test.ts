import assert from "node:assert/strict";
import { test } from "node:test";

const stored = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, String(v)),
    removeItem: (k: string) => void stored.delete(k),
  },
});
const { forgetDisplayRoom, rememberDisplayRoom, rememberedDisplayRoom } = await import("./remember.ts");

test("a display forgets only its own room, so Home keeps a room another tab paired it with since", () => {
  rememberDisplayRoom("ROOMAAAA");
  // Another tab of this browser pairs the device with another room, which signs it out of the first.
  rememberDisplayRoom("ROOMBBBB");
  forgetDisplayRoom("ROOMAAAA");
  assert.equal(rememberedDisplayRoom(), "ROOMBBBB");
  forgetDisplayRoom("ROOMBBBB");
  assert.equal(rememberedDisplayRoom(), null);
});

test("a display's weather is its own, apart from a member's in the same browser, and goes back when it closes", async () => {
  const { restoreWeatherMode, setWeatherMode, weatherMode } = await import("../device/settings.ts");
  const { chooseDisplayWeather, readDisplayWeather } = await import("./remember.ts");
  setWeatherMode("still");
  assert.equal(readDisplayWeather(), "moving", "a display with no choice of its own moves");
  chooseDisplayWeather("off");
  assert.equal(stored.get("rvtt.displayWeather"), "off");
  assert.equal(stored.get("rvtt.weather"), "still", "the member's setting is unchanged");
  assert.equal(weatherMode(), "off", "the display's page shows its own");
  assert.equal(readDisplayWeather(), "off");
  stored.set("rvtt.displayWeather", "sideways");
  assert.equal(readDisplayWeather(), "moving", "an unknown choice reads as moving");
  restoreWeatherMode();
  assert.equal(weatherMode(), "still", "closing the display gives the member's back");
});

test("a display's animated maps are its own, apart from a member's in the same browser, and go back when it closes", async () => {
  const { animatedMaps, restoreAnimatedMaps, setAnimatedMaps } = await import("../device/settings.ts");
  const { chooseDisplayAnimatedMaps, readDisplayAnimatedMaps } = await import("./remember.ts");
  setAnimatedMaps("still");
  assert.equal(readDisplayAnimatedMaps(), "moving", "a display with no choice of its own moves");
  chooseDisplayAnimatedMaps("still");
  chooseDisplayAnimatedMaps("moving");
  assert.equal(stored.get("rvtt.displayAnimatedMaps"), "moving");
  assert.equal(stored.get("rvtt.animatedMaps"), "still", "the member's setting is unchanged");
  assert.equal(animatedMaps(), "moving", "the display's page shows its own");
  stored.set("rvtt.displayAnimatedMaps", "sideways");
  assert.equal(readDisplayAnimatedMaps(), "moving", "an unknown choice reads as moving");
  restoreAnimatedMaps();
  assert.equal(animatedMaps(), "still", "closing the display gives the member's back");
});

test("a display's sound is its own, on at first, apart from a member's Room sound in the same browser", async () => {
  const { roomSoundChoice, setRoomSoundChoice } = await import("../device/settings.ts");
  const { chooseDisplaySound, displaySound, parseDisplaySound } = await import("./remember.ts");
  setRoomSoundChoice("off");
  assert.equal(displaySound(), true, "a display with no choice of its own plays");
  chooseDisplaySound(false);
  assert.equal(stored.get("rvtt.displaySound"), "off");
  assert.equal(roomSoundChoice(), "off", "the member's setting is its own");
  chooseDisplaySound(true);
  assert.equal(stored.get("rvtt.roomSound"), "off");
  assert.equal(displaySound(), true);
  for (const raw of [null, "", "on", "sideways"]) assert.equal(parseDisplaySound(raw), true, String(raw));
  assert.equal(parseDisplaySound("off"), false);
});
