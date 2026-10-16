import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { firstSidePanel, parseSidePanel, readSidePanel, SIDE_PANEL_KEY, writeSidePanel } from "./sidePanel.ts";

function storage(value: string | null) {
  const writes: [string, string][] = [];
  return {
    writes,
    getItem: (key: string) => (key === SIDE_PANEL_KEY ? value : null),
    setItem: (key: string, v: string) => {
      writes.push([key, v]);
    },
  };
}

const throwing = {
  getItem(): string | null {
    throw new Error("blocked");
  },
  setItem(): void {
    throw new Error("blocked");
  },
};

describe("the side panel's stored choice", () => {
  test("hidden and shown read back, anything else is no choice", () => {
    assert.equal(readSidePanel(storage("hidden")), "hidden");
    assert.equal(readSidePanel(storage("shown")), "shown");
    assert.equal(readSidePanel(storage(null)), null);
    assert.equal(readSidePanel(storage("open")), null);
    assert.equal(parseSidePanel("HIDDEN"), null);
    assert.equal(parseSidePanel(""), null);
  });

  test("a storage that throws reads as no choice, and a write to it is dropped", () => {
    assert.equal(readSidePanel(throwing), null);
    assert.doesNotThrow(() => writeSidePanel("hidden", { preview: false, storage: throwing }));
  });

  test("the viewer's choice is written, and a preview never writes", () => {
    const own = storage(null);
    writeSidePanel("hidden", { preview: false, storage: own });
    writeSidePanel("shown", { preview: false, storage: own });
    assert.deepEqual(own.writes, [
      [SIDE_PANEL_KEY, "hidden"],
      [SIDE_PANEL_KEY, "shown"],
    ]);
    const preview = storage(null);
    writeSidePanel("hidden", { preview: true, storage: preview });
    assert.deepEqual(preview.writes, []);
  });
});

describe("the side panel's first state on a page", () => {
  test("nothing is decided until the layout is wide", () => {
    assert.equal(firstSidePanel(null, { wide: false, height: 844, stored: null }), null);
    assert.equal(firstSidePanel(null, { wide: false, height: 390, stored: "hidden" }), null);
  });

  test("the stored choice wins at any height", () => {
    assert.equal(firstSidePanel(null, { wide: true, height: 430, stored: "shown" }), false);
    assert.equal(firstSidePanel(null, { wide: true, height: 800, stored: "hidden" }), true);
  });

  test("with no choice a short layout starts hidden and a tall one shown, the line at 500 px", () => {
    assert.equal(firstSidePanel(null, { wide: true, height: 430, stored: null }), true);
    assert.equal(firstSidePanel(null, { wide: true, height: 499, stored: null }), true);
    assert.equal(firstSidePanel(null, { wide: true, height: 500, stored: null }), false);
    assert.equal(firstSidePanel(null, { wide: true, height: 800, stored: null }), false);
  });

  test("worked out once: a later resize across 500 px tall leaves it as it was", () => {
    const short = firstSidePanel(null, { wide: true, height: 430, stored: null });
    assert.equal(short, true);
    assert.equal(firstSidePanel(short, { wide: true, height: 800, stored: null }), true);
    const tall = firstSidePanel(null, { wide: true, height: 800, stored: null });
    assert.equal(firstSidePanel(tall, { wide: true, height: 430, stored: null }), false);
    assert.equal(firstSidePanel(tall, { wide: false, height: 430, stored: null }), false, "going narrow and back keeps it too");
  });
});
