import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planImage } from "./image.ts";
import { deviceFrom, fileSizeProblem, isIos, MAX_PHONE_FILE_BYTES } from "./limits.ts";

const MiB = 1024 * 1024;

const IPAD_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_CHROME = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1";

describe("what the import takes this device for", () => {
  test("iOS and iPadOS are told apart from a Mac by the touch screen", () => {
    assert.equal(isIos({ userAgent: IPHONE_SAFARI, platform: "iPhone", maxTouchPoints: 5 }), true);
    assert.equal(isIos({ userAgent: IPAD_CHROME, platform: "iPad", maxTouchPoints: 5 }), true);
    // iPadOS Safari asks for desktop pages and calls itself a Mac.
    assert.equal(isIos({ userAgent: IPAD_SAFARI, platform: "MacIntel", maxTouchPoints: 5 }), true);
    assert.equal(isIos({ userAgent: IPAD_SAFARI, platform: "MacIntel", maxTouchPoints: 0 }), false);
    assert.equal(isIos({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)", platform: "Linux armv8l", maxTouchPoints: 5 }), false);
  });

  test("a 12.9 inch iPad is no phone by its screen, and still resizes only what iOS can draw", () => {
    const device = deviceFrom({ coarsePointer: true, shortSidePx: 1024, ios: true });
    assert.equal(device, "iPad");
    assert.equal(planImage({ width: 12_800, height: 6_400, bytes: 20 * MiB }, device).kind, "refuse");
    // A trackpad makes its pointer fine. It is the same iPad.
    assert.equal(deviceFrom({ coarsePointer: false, shortSidePx: 1024, ios: true }), "iPad");
  });

  test("the file size limit still follows the screen", () => {
    assert.equal(deviceFrom({ coarsePointer: true, shortSidePx: 390, ios: true }), "phone");
    assert.equal(deviceFrom({ coarsePointer: true, shortSidePx: 412, ios: false }), "phone");
    assert.equal(deviceFrom({ coarsePointer: false, shortSidePx: 1080, ios: false }), "computer");
    assert.equal(deviceFrom({ coarsePointer: true, shortSidePx: 1200, ios: false }), "computer");
    assert.equal(fileSizeProblem(90 * MiB, "iPad"), null);
    assert.notEqual(fileSizeProblem(MAX_PHONE_FILE_BYTES + 1, "phone"), null);
  });
});
