import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { THIS_DEVICE_SECTIONS } from "../../lib/folds.ts";
import { STILL_REASONS } from "../animmap/status.ts";
import { deviceSummaries, type DeviceValues } from "./summaries.ts";

/* This device's folded summaries (docs/design/design-v1-panel-groups.md 6.2 and 10), each branch. */

const NEW_DEVICE: DeviceValues = {
  scale: 1,
  theme: "dark",
  fullscreen: false,
  lowPower: false,
  variant: "mobile",
  animatedMaps: null,
  weather: "moving",
  weatherHeld: false,
  animatedHeld: false,
  roomSound: false,
  rollAnimation: true,
  handle: "tail",
};

describe("This device's folded summaries", () => {
  test("a new device's, one for every section but Shortcuts", () => {
    const summaries = deviceSummaries(NEW_DEVICE);
    assert.deepEqual(Object.keys(summaries).sort(), [...THIS_DEVICE_SECTIONS].sort());
    assert.deepEqual(summaries, {
      size: "100%",
      theme: "Dark",
      screen: "Full screen off",
      battery: "Low power off",
      mapDetail: "Phone size",
      weather: "Moving",
      sounds: "Room sound off",
      rolls: "Roll animation on",
      shortcuts: undefined,
      handle: "Ringed tail",
    });
  });

  test("each setting's other values", () => {
    const s = deviceSummaries({ ...NEW_DEVICE, scale: 1.3, theme: "auto", fullscreen: true, lowPower: true, roomSound: true, rollAnimation: false, handle: "pill" });
    assert.equal(s.size, "130%");
    assert.equal(s.theme, "Auto");
    assert.equal(deviceSummaries({ ...NEW_DEVICE, theme: "light" }).theme, "Light");
    assert.equal(s.screen, "Full screen on");
    assert.equal(s.battery, "Low power on");
    assert.equal(s.sounds, "Room sound on");
    assert.equal(s.rolls, "Roll animation off");
    assert.equal(s.handle, "Plain pill");
  });

  test("Map detail says the images the cards show, Low power's phone size over a full size choice, then the animated maps choice where the server offers it", () => {
    assert.equal(deviceSummaries({ ...NEW_DEVICE, variant: "full" }).mapDetail, "Full size");
    assert.equal(deviceSummaries({ ...NEW_DEVICE, variant: "full", lowPower: true }).mapDetail, "Phone size");
    assert.equal(deviceSummaries({ ...NEW_DEVICE, variant: "full", animatedMaps: "moving" }).mapDetail, "Full size · Moving");
    assert.equal(deviceSummaries({ ...NEW_DEVICE, animatedMaps: "still" }).mapDetail, "Phone size · Still");
  });

  test("Map detail says Held still after Moving while any reason holds the maps, as Weather does", () => {
    // ThisDevice sets animatedHeld to useDeviceStillReason() !== null: Low power, reduced motion and the step-down all give a reason.
    for (const reason of STILL_REASONS) assert.equal(deviceSummaries({ ...NEW_DEVICE, animatedMaps: "moving", animatedHeld: reason !== null }).mapDetail, "Phone size · Moving · Held still", reason);
    assert.equal(deviceSummaries({ ...NEW_DEVICE, animatedMaps: "moving" }).mapDetail, "Phone size · Moving");
    assert.equal(deviceSummaries({ ...NEW_DEVICE, animatedMaps: "still", animatedHeld: true }).mapDetail, "Phone size · Still", "Still is still already");
    assert.equal(deviceSummaries({ ...NEW_DEVICE, animatedMaps: null, animatedHeld: true }).mapDetail, "Phone size");
  });

  test("Weather says the choice, then Held still while a reason keeps Moving still", () => {
    assert.equal(deviceSummaries({ ...NEW_DEVICE, weather: "still" }).weather, "Still");
    assert.equal(deviceSummaries({ ...NEW_DEVICE, weather: "off" }).weather, "Off");
    assert.equal(deviceSummaries({ ...NEW_DEVICE, weatherHeld: true }).weather, "Moving · Held still");
    assert.equal(deviceSummaries({ ...NEW_DEVICE, weather: "still", weatherHeld: true }).weather, "Still", "Still is still already");
    assert.equal(deviceSummaries({ ...NEW_DEVICE, weather: "off", weatherHeld: true }).weather, "Off");
  });
});
