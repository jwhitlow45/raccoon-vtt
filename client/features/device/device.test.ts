import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cameraForView, worldToScreen } from "../../lib/camera.ts";
import { EPH_PER_SECOND } from "../../state/socket.ts";
import { barInset, cameraInZoomed, chromeZoom, effectiveZoom, insetsInZoomed, inZoomed, layoutSize, sizeInZoomed, smallUi, type ZoomedElement } from "./layout.ts";
import { ephRate, mapVariantFor, parseLowPower, parseUiScale, pixelRatioFor, stageMountKey, UI_SCALES, uiScaleLabel } from "./settings.ts";

describe("this device's settings", () => {
  test("the interface size reads only its four sizes, anything else as 100%", () => {
    assert.deepEqual(UI_SCALES.map(uiScaleLabel), ["85%", "100%", "115%", "130%"]);
    for (const s of UI_SCALES) assert.equal(parseUiScale(String(s)), s);
    for (const raw of [null, "", "2", "0.5", "abc", "1.0000001"]) assert.equal(parseUiScale(raw), 1, String(raw));
  });

  test("low power is off unless stored on", () => {
    assert.equal(parseLowPower("on"), true);
    for (const raw of [null, "off", "true", "1"]) assert.equal(parseLowPower(raw), false);
  });

  test("low power loads the phone size map on every device", () => {
    const desktop = { coarsePointer: false, shortSidePx: 1080 };
    assert.equal(mapVariantFor({ ...desktop, lowPower: false, setting: "auto" }), "full");
    assert.equal(mapVariantFor({ ...desktop, lowPower: true, setting: "auto" }), "mobile");
    assert.equal(mapVariantFor({ ...desktop, lowPower: true, setting: "full" }), "mobile", "low power wins over the map detail");
    assert.equal(mapVariantFor({ coarsePointer: true, shortSidePx: 390, lowPower: false, setting: "full" }), "full", "the map detail picks otherwise");
  });

  test("low power draws one device pixel per CSS pixel, else up to 2", () => {
    assert.equal(pixelRatioFor(false, 3), 2);
    assert.equal(pixelRatioFor(false, 1.5), 1.5);
    assert.equal(pixelRatioFor(false, 0), 1);
    assert.equal(pixelRatioFor(true, 3), 1);
    assert.equal(pixelRatioFor(true, 1), 1);
  });

  test("the stage remounts when low power or the interface size changes, and only then", () => {
    const keys = new Set<string>();
    for (const low of [false, true]) for (const s of UI_SCALES) keys.add(stageMountKey(low, s));
    assert.equal(keys.size, 8);
    assert.equal(stageMountKey(true, 1), stageMountKey(true, 1));
  });

  test("low power halves the frames a device sends", () => {
    assert.equal(ephRate(false), EPH_PER_SECOND);
    assert.equal(ephRate(true), 15);
  });
});

describe("interface size", () => {
  test("the layout reads the window divided by the scale", () => {
    assert.deepEqual(layoutSize({ innerWidth: 1000, innerHeight: 700 }, 1), { width: 1000, height: 700 });
    // A 1,000 px window at 130% lays out as a phone, under the 900 px side panel breakpoint.
    assert.ok(layoutSize({ innerWidth: 1000, innerHeight: 700 }, 1.3).width < 900);
    assert.equal(Math.round(layoutSize({ innerWidth: 1000, innerHeight: 700 }, 1.3).width), 769);
    assert.ok(layoutSize({ innerWidth: 800, innerHeight: 700 }, 0.85).width > 900, "85% can reach the side panel");
  });

  test("100% zooms nothing, and only a smaller size asks fields to grow", () => {
    assert.deepEqual(chromeZoom(1), {});
    assert.equal((chromeZoom(1.3) as { zoom?: number }).zoom, 1.3);
    assert.deepEqual(smallUi(1), {});
    assert.deepEqual(smallUi(1.15), {});
    assert.deepEqual(smallUi(0.85), { "data-rvtt-small-ui": "" });
  });

  test("an element's zoom is the browser's own figure where it gives one, else its drawn width over its laid-out width", () => {
    /** A 100 px element drawn `drawn` px wide, whose box may only be read when `boxRead` allows. */
    const el = (drawn: number, extra: Partial<ZoomedElement> = {}, boxRead = true): ZoomedElement => ({
      offsetWidth: 100,
      getBoundingClientRect: () => {
        if (!boxRead) throw new Error("the box was read again");
        return { width: drawn };
      },
      ...extra,
    });
    for (const scale of UI_SCALES) {
      assert.equal(effectiveZoom(el(999, { currentCSSZoom: scale })), scale, `currentCSSZoom wins at ${uiScaleLabel(scale)}`);
      assert.equal(effectiveZoom(el(100 * scale)), scale, `measured at ${uiScaleLabel(scale)}`);
      assert.equal(effectiveZoom(el(0, {}, false), 100 * scale), scale, `a width the caller measured is not read again at ${uiScaleLabel(scale)}`);
    }
    // Two zoomed layers, one inside the other, multiply.
    assert.equal(effectiveZoom(el(0, { currentCSSZoom: 1.3 * 0.85 })), 1.3 * 0.85);
    assert.equal(effectiveZoom(el(130, { currentCSSZoom: 0 })), 1.3, "a zero from the browser is no figure");
    assert.equal(effectiveZoom(el(130, { offsetWidth: 0 })), 1, "an element laid out at no width");
    assert.equal(effectiveZoom(el(0)), 1, "an element drawn at no width");
  });

  test("a bar's inset is its drawn height, which grows with the scale", () => {
    for (const scale of UI_SCALES) {
      const drawn = { height: 52 * scale };
      assert.equal(barInset(drawn), Math.round(52 * scale), `at ${uiScaleLabel(scale)}`);
    }
    assert.equal(barInset(null), 0);
  });

  test("at 100% the map's camera and sizes pass through as they are", () => {
    const cam = { x: 1, y: 2, scale: 30 };
    const size = { width: 390, height: 844 };
    const bars = { top: 52, right: 0, bottom: 60, left: 0 };
    assert.equal(cameraInZoomed(cam, 1), cam);
    assert.equal(sizeInZoomed(size, 1), size);
    assert.equal(insetsInZoomed(bars, 1), bars);
  });

  test("the action bar lands under its token at every scale", () => {
    const viewport = { width: 390, height: 844 };
    const cam = cameraForView(viewport, { x: 10, y: 12, zoom: 48 });
    const token = { x: 10.5, y: 13 };
    const onScreen = worldToScreen(cam, token);
    for (const scale of UI_SCALES) {
      // Inside a layer zoomed by `scale`, a point at p draws at p * scale.
      const inLayer = worldToScreen(cameraInZoomed(cam, scale), token);
      assert.ok(Math.abs(inLayer.x * scale - onScreen.x) < 1e-9 && Math.abs(inLayer.y * scale - onScreen.y) < 1e-9, uiScaleLabel(scale));
      const anchor = inZoomed(onScreen, scale);
      assert.ok(Math.abs(anchor.x * scale - onScreen.x) < 1e-9);
      const room = sizeInZoomed(viewport, scale);
      assert.ok(Math.abs(room.width * scale - viewport.width) < 1e-9);
      const bars = insetsInZoomed({ top: 68, right: 0, bottom: 78, left: 0 }, scale);
      assert.ok(Math.abs(bars.bottom * scale - 78) < 1e-9);
    }
  });
});
