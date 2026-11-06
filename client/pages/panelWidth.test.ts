import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import { dragWidth, drawnWidth, edgeKey, keyWrite, MAP_MIN, PANEL_MAX, PANEL_MIN, panelCap, releaseWrite, resetWrite, storedFor, widthText, type WidthWrite } from "./panelWidth.ts";

/** The side panel's width (docs/design/design-v1-panel-size.md 3, 4.2 and 8). */

// A stored value as storage can hold it: the default, whole and fractional widths in and out of bounds, and nonsense.
const storedValue = fc.oneof(fc.constant(null), fc.integer({ min: -100, max: 2000 }), fc.double({ min: -100, max: 2000, noNaN: true }), fc.constantFrom(Number.POSITIVE_INFINITY, Number.NaN));
// Layout widths from 900 up, fractional ones included, as an interface size makes them (1440 at 130% is 1107.69...).
const layoutWidth = fc.oneof(fc.integer({ min: 900, max: 4000 }), fc.double({ min: 900, max: 4000, noNaN: true }));

describe("the bounds", () => {
  test("the drawn width is a whole number in [360, cap], the stored one clamped and floored, and the map keeps 600 from 960 up", () => {
    holds(
      fc.property(storedValue, layoutWidth, (stored, layout) => {
        const cap = panelCap(layout);
        const drawn = drawnWidth(stored, layout);
        assert.ok(Number.isInteger(drawn), `whole: ${drawn}`);
        assert.ok(drawn >= PANEL_MIN && drawn <= cap, `${drawn} in [360, ${cap}]`);
        assert.ok(Number.isInteger(cap) && cap <= PANEL_MAX);
        const expected = stored === null || !Number.isFinite(stored) ? PANEL_MIN : Math.min(cap, Math.max(PANEL_MIN, Math.floor(stored)));
        assert.equal(drawn, expected);
        if (layout >= PANEL_MIN + MAP_MIN) assert.ok(layout - drawn >= MAP_MIN, `map ${layout - drawn} at ${layout}`);
      }),
      2000,
    );
  });

  test("the cap at the design's sizes: 640 at 1440 and 1920, 500 at 1100, 360 from 960 down, 507 at 1440 at 130%, 640 at 1920 at 130%", () => {
    assert.equal(panelCap(1440), 640);
    assert.equal(panelCap(1920), 640);
    assert.equal(panelCap(1100), 500);
    assert.equal(panelCap(960), 360);
    assert.equal(panelCap(900), 360);
    assert.equal(panelCap(1440 / 1.3), 507);
    assert.equal(panelCap(1920 / 1.3), 640);
  });

  test("a stored 640 draws 500 at 1100, 360 at 960, and 640 again at 1440: the stored width waits", () => {
    assert.deepEqual([1100, 960, 1440].map((w) => drawnWidth(640, w)), [500, 360, 640]);
    assert.equal(drawnWidth(null, 1440), 360, "the default");
  });
});

describe("what a change stores", () => {
  test("the default is stored as null, never as a number", () => {
    holds(
      fc.property(fc.double({ min: -100, max: 2000, noNaN: true }), (w) => {
        const s = storedFor(w);
        if (w <= PANEL_MIN) assert.equal(s, null);
        else assert.ok(s !== null && Number.isInteger(s) && s >= PANEL_MIN, `${w} stores ${s}`);
      }),
      1000,
    );
  });

  test("a key step stores what it draws when the width changes, and nothing when it does not", () => {
    const keys = fc.constantFrom("ArrowLeft", "ArrowRight", "End");
    holds(
      fc.property(storedValue, layoutWidth, keys, fc.boolean(), (stored, layout, key, shift) => {
        const before = drawnWidth(stored, layout);
        const k = edgeKey(key, shift)!;
        const after = k.kind === "end" ? panelCap(layout) : k.kind === "step" ? drawnWidth(before + k.delta, layout) : before;
        const w = keyWrite(before, after);
        if (after === before) assert.deepEqual(w, { kind: "none" });
        else {
          assert.equal(w.kind, "set");
          assert.equal(drawnWidth(w.kind === "set" ? w.value : null, layout), after, "a reload draws what the key drew");
        }
      }),
      2000,
    );
  });

  test("Left at the cap in a narrow window stores nothing, so the wider stored width stays", () => {
    const before = drawnWidth(640, 1100);
    assert.equal(before, 500);
    assert.deepEqual(keyWrite(before, drawnWidth(before + 8, 1100)), { kind: "none" });
  });

  test("Left, Shift+Left, Home and End from 360 at 1440: 368, 432, null, 640", () => {
    let stored: number | null = null;
    const press = (key: string, shift = false) => {
      const before = drawnWidth(stored, 1440);
      const k = edgeKey(key, shift)!;
      const w: WidthWrite = k.kind === "home" ? resetWrite(stored) : keyWrite(before, k.kind === "end" ? panelCap(1440) : drawnWidth(before + k.delta, 1440));
      if (w.kind === "set") stored = w.value;
      return stored;
    };
    assert.equal(press("ArrowLeft"), 368);
    assert.equal(press("ArrowLeft", true), 432);
    assert.equal(press("Home"), null);
    assert.equal(press("End"), 640);
    assert.equal(press("ArrowRight", true), 576, "Right narrows");
    assert.equal(edgeKey("ArrowUp", false), null, "Up and Down are not the edge's");
  });

  test("a drag released where it began restores, so the page leaves the drag's page-only width, and elsewhere commits", () => {
    holds(
      fc.property(fc.integer({ min: 360, max: 640 }), fc.integer({ min: 360, max: 640 }), (start, end) => {
        const w = releaseWrite(start, end);
        assert.deepEqual(w, end === start ? { kind: "restore" } : { kind: "set", value: storedFor(end) });
      }),
      500,
    );
  });

  test("double-click, Home and Reset width store null whenever the stored width is not null, a stored 640 in a 960 window included", () => {
    assert.equal(drawnWidth(640, 960), 360);
    assert.deepEqual(resetWrite(640), { kind: "set", value: null });
    assert.deepEqual(resetWrite(null), { kind: "none" });
  });

  test("a drag moves nothing inside the tap slop, then follows the pointer in layout px, a move to the left widening", () => {
    const at = (toX: number, zoom = 1, moved = false) => dragWidth({ start: 400, fromX: 1000, toX, zoom, layoutWidth: 1440, moved });
    assert.equal(at(994), null, "6 px is inside the slop");
    assert.equal(at(992), null, "8 px still is");
    assert.equal(at(991), 409);
    assert.equal(at(1000, 1, true), 400, "once moved, back to the start draws the start");
    assert.equal(at(870, 1.3), 500, "130 screen px at 130% is 100 layout px");
    assert.equal(at(0), 640, "past the cap stops at it");
    assert.equal(at(2000), 360, "under the least stops at 360");
  });

  test("the separator's words", () => {
    assert.equal(widthText(360), "360 pixels, the default");
    assert.equal(widthText(500), "500 pixels");
  });
});

/*
 * Random sessions of what the edge meets, against the device setting
 * itself (features/device/settings.ts) with storage stubbed: key steps,
 * drags that move and end by a release, Escape, a cancel or S, double-
 * clicks, Reset width, windows of new widths and another window's change.
 * A driver stands in for pages/PanelEdge.tsx, using the rules it uses.
 * Invariants: storage never holds the default as a number, outside a drag
 * the page draws what storage holds (so a drag always leaves page-only
 * mode), a step that changes nothing writes nothing, and a reset leaves
 * null stored.
 */
describe("the write rules over random sessions", () => {
  test("hold their invariants", async () => {
    const stored = new Map<string, string>();
    let writes = 0;
    Object.assign(globalThis, {
      localStorage: {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => {
          writes += 1;
          // The default is never written as a number, so a later change of the default reaches this device.
          assert.ok(v === "" || Number(v) > PANEL_MIN, `wrote ${v}`);
          stored.set(k, String(v));
        },
        removeItem: (k: string) => stored.delete(k),
      },
    });
    // A fresh copy of the settings, which read storage once as they load, over the stub above.
    const fresh = "panelWidth";
    const s = (await import(`../features/device/settings.ts?${fresh}`)) as typeof import("../features/device/settings.ts");
    const key = s.PANEL_WIDTH_KEY;
    type Op =
      | { k: "key"; key: "ArrowLeft" | "ArrowRight" | "Home" | "End"; shift: boolean }
      | { k: "drag"; moves: number[]; end: "release" | "escape" | "cancel" | "hide" }
      | { k: "double" }
      | { k: "window"; width: number }
      | { k: "other"; raw: string | null };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ k: fc.constant("key" as const), key: fc.constantFrom("ArrowLeft" as const, "ArrowRight" as const, "Home" as const, "End" as const), shift: fc.boolean() }),
      fc.record({ k: fc.constant("drag" as const), moves: fc.array(fc.integer({ min: -400, max: 400 }), { maxLength: 6 }), end: fc.constantFrom("release" as const, "escape" as const, "cancel" as const, "hide" as const) }),
      fc.constant({ k: "double" as const }),
      fc.record({ k: fc.constant("window" as const), width: fc.oneof(fc.integer({ min: 900, max: 2400 }), fc.constant(1440 / 1.3)) }),
      fc.record({ k: fc.constant("other" as const), raw: fc.constantFrom(null, "", "500", "360", "300", "640.9", "abc") }),
    );
    holds(
      fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
        stored.clear();
        s.setPanelWidth(null);
        let layout = 1440;
        const write = (w: WidthWrite) => {
          if (w.kind === "set") s.setPanelWidth(w.value);
          else if (w.kind === "restore") s.restorePanelWidth();
        };
        for (const o of ops) {
          const before = drawnWidth(s.panelWidth(), layout);
          const writesBefore = writes;
          if (o.k === "key") {
            const k = edgeKey(o.key, o.shift)!;
            if (k.kind === "home") write(resetWrite(s.panelWidth()));
            else {
              const after = k.kind === "end" ? panelCap(layout) : drawnWidth(before + k.delta, layout);
              write(keyWrite(before, after));
              if (after === before) assert.equal(writes, writesBefore, "a step that changes nothing writes nothing");
              assert.equal(drawnWidth(s.panelWidth(), layout), after);
            }
          } else if (o.k === "drag") {
            let width: number | null = null;
            let x = 1000;
            for (const dx of o.moves) {
              x += dx;
              const next = dragWidth({ start: before, fromX: 1000, toX: x, zoom: 1, layoutWidth: layout, moved: width !== null });
              if (next === null || next === width) continue;
              width = next;
              s.applyPanelWidth(next);
              assert.equal(drawnWidth(s.panelWidth(), layout), next, "the drag shows what it draws");
            }
            if (width !== null) {
              if (o.end === "release") write(releaseWrite(before, width));
              else s.restorePanelWidth();
            }
            if (o.end !== "release" || width === before || width === null) assert.equal(drawnWidth(s.panelWidth(), layout), before, `${o.end} puts it back`);
          } else if (o.k === "double") {
            write(resetWrite(s.panelWidth()));
            assert.equal(s.panelWidth(), null);
          } else if (o.k === "window") layout = o.width;
          else {
            if (o.raw === null) stored.delete(key);
            else stored.set(key, o.raw);
            s.adoptPanelWidth(o.raw);
          }
          const raw = stored.get(key) ?? null;
          assert.equal(s.panelWidth(), s.parsePanelWidth(raw), "outside a drag the page shows what storage holds");
        }
      }),
      500,
    );
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
