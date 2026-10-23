import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { theme } from "../../lib/theme.ts";

const { dragColor, walkShown } = await import("./RulerLayer.tsx");

type Walk = Parameters<typeof walkShown>[0];

describe("a drag's color", () => {
  test("is its speed band's, green, yellow or red", () => {
    assert.equal(dragColor({ kind: "walk", speed: 30, leftFt: 10, band: "walk" }), theme.color.success);
    assert.equal(dragColor({ kind: "walk", speed: 30, leftFt: 10, band: "dash" }), theme.color.crest);
    assert.equal(dragColor({ kind: "walk", speed: 30, leftFt: -5, band: "over" }), theme.color.danger);
  });

  test("with no band to show, the text color, never the crest yellow a Dash wears", () => {
    assert.equal(dragColor(undefined), theme.color.text);
    assert.equal(dragColor(null), theme.color.text);
    assert.notEqual(dragColor(undefined), theme.color.crest);
  });
});

describe("a walking ruler while its walk is searched", () => {
  const leg = (searching: boolean) => ({ from: { x: 0, y: 0 }, to: { x: 4, y: 0 }, corners: [], ft: searching ? 0 : 20, none: false, ...(searching ? { searching: true as const } : {}) });
  const done: Walk = { legs: [leg(false)], totalFt: 20, extra: null, size: { w: 1, h: 1 }, searching: false };
  const searching: Walk = { legs: [leg(false), leg(true)], totalFt: 20, extra: null, size: { w: 1, h: 1 }, searching: true };

  test("a finished walk reads itself", () => {
    assert.deepEqual(walkShown(done, null, false), { reading: done, finding: false });
  });

  test("a search that has just started keeps the last walk's reading, and nothing waits grey yet", () => {
    assert.deepEqual(walkShown(searching, done, false), { reading: done, finding: false });
  });

  test("only past the shared loading delay does it say it is finding the way", () => {
    assert.deepEqual(walkShown(searching, done, true), { reading: null, finding: true });
  });

  test("a first search, with no walk to keep, reads nothing until then", () => {
    assert.deepEqual(walkShown(searching, null, false), { reading: null, finding: false });
  });

  test("a random run of frames never leaves the ruler without a reading once it has had one, until the delay passes", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let held: Walk | null = null;
    let since = 0;
    for (let frame = 0; frame < 2000; frame++) {
      const m = random() < 0.6 ? searching : { ...done, totalFt: 5 * Math.floor(random() * 20) };
      since = m.searching ? since + 16 : 0;
      const slow = since >= 200;
      const shown = walkShown(m, held, slow);
      if (!m.searching) held = m;
      // Invariants: a reading or the wait shows whenever a walk was ever finished, and the wait shows only past the delay.
      if (held) assert.ok(shown.reading !== null || shown.finding, `frame ${frame} shows nothing`);
      assert.equal(shown.finding, m.searching && slow, `frame ${frame} waits at the wrong time`);
      if (shown.reading) assert.equal(shown.reading.searching, false, "a reading is always a finished walk");
    }
  });
});
