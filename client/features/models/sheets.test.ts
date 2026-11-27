import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SHEET_BUDGET, SHEET_WEIGHT, sheetsNearest, type SheetWant } from "./sheets.ts";
import { harness } from "./sheets.testutil.ts";

/**
 * The decoded sheet cache (docs/design/design-v1-token-models.md 6,
 * D-261127-178, 387): 16 full or 24 phone copies, admitted nearest the
 * canvas's middle first, a sheet no board asks for going first, and a sheet
 * freed only once no board draws it.
 */

const urls = (n: number, prefix = "s") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("the sheet cache", () => {
  test("its budget holds 16 full copies or 24 phone copies", () => {
    assert.equal(SHEET_BUDGET / SHEET_WEIGHT.full, 16);
    assert.equal(SHEET_BUDGET / SHEET_WEIGHT.mobile, 24);
  });

  test("a board's asks, nearest the middle first, admit the first 16 full copies, and the rest stand as pictures", async () => {
    const h = harness();
    const board = {};
    const asked = urls(20);
    h.cache.layout(board, "full", asked, 0);
    assert.deepEqual(h.cache.admitted(), asked.slice(0, 16));
    assert.deepEqual(h.pending.map((p) => p.url), asked.slice(0, 16));
    await h.finish();
    const snap = h.cache.snapshot();
    assert.deepEqual(asked.map((u) => snap.get(u) !== null), asked.map((_, i) => i < 16));
    // Phone copies take 24.
    const phone = harness();
    phone.cache.layout({}, "mobile", urls(30), 0);
    assert.equal(phone.pending.length, 24);
  });

  test("one sheet asked for by several creatures, or by two boards, is held once", async () => {
    const h = harness();
    const a = {};
    const b = {};
    h.cache.layout(a, "full", ["x", "y"], 0);
    h.cache.layout(b, "full", ["y", "z"], 0);
    assert.deepEqual(h.pending.map((p) => p.url), ["x", "y", "z"]);
    await h.finish();
    assert.equal(h.cache.states().size, 3);
  });

  test("two boards share the budget rank by rank, so neither keeps the other's nearest out", () => {
    const h = harness();
    h.cache.layout({}, "full", urls(16, "a"), 0);
    h.cache.layout({}, "full", urls(16, "b"), 0);
    const admitted = h.cache.admitted();
    assert.equal(admitted.length, 16);
    assert.deepEqual(admitted.slice(0, 4), ["a0", "b0", "a1", "b1"]);
  });

  test("to make room, a sheet no board asks for goes first, then the one asked for last, never one admitted", async () => {
    const h = harness();
    const board = {};
    h.cache.layout(board, "full", urls(16), 0);
    await h.finish();
    // The board pans: s0 leaves the screen, and two new sheets come nearest the middle.
    h.cache.layout(board, "full", ["n0", "n1", ...urls(16).slice(1, 15)], h.cache.snapshot().version);
    const held = h.cache.states();
    assert.ok(!held.has("s0"), "the sheet no board asks for went");
    assert.ok(!held.has("s15"), "then the one asked for last");
    for (const u of urls(16).slice(1, 15)) assert.ok(held.has(u), u);
    // The new ones start once the board has committed a render without the two that went, and those are closed.
    assert.ok(!held.has("n0") && !held.has("n1"));
    h.cache.layout(board, "full", ["n0", "n1", ...urls(16).slice(1, 15)], h.cache.snapshot().version);
    assert.deepEqual(h.released, [h.imageOf("s0"), h.imageOf("s15")]);
    assert.deepEqual(h.pending.map((p) => p.url), ["n0", "n1"]);
  });

  /** The weight of what a cache's page holds decoded, a full copy 3 and a phone copy 2. */
  const liveWeight = (h: ReturnType<typeof harness>) => h.live().reduce((w, image) => w + SHEET_WEIGHT[(image as unknown as { url: string }).url.startsWith("m") ? "mobile" : "full"], 0);

  test("a change from 16 full copies to 24 phone copies never holds more than the budget decoded", async () => {
    const h = harness();
    const board = {};
    h.cache.layout(board, "full", urls(16, "f"), 0);
    await h.finish();
    assert.equal(liveWeight(h), SHEET_BUDGET);
    h.cache.layout(board, "mobile", urls(24, "m"), h.cache.snapshot().version);
    assert.equal(h.pending.length, 0, "no phone copy starts while the full ones are still drawn");
    assert.ok(liveWeight(h) <= SHEET_BUDGET);
    // The board commits a render without the full copies: they close, and the phone copies come.
    h.cache.layout(board, "mobile", urls(24, "m"), h.cache.snapshot().version);
    assert.equal(h.released.length, 16);
    assert.equal(h.pending.length, 24);
    await h.finish();
    assert.equal(liveWeight(h), SHEET_BUDGET);
    assert.deepEqual(h.cache.weight(), { held: SHEET_BUDGET, closing: 0 });
  });

  test("a board slow to commit holds back the sheets that replace the ones it may still draw, never past the budget", async () => {
    const h = harness();
    const a = {};
    const slow = {};
    h.cache.layout(a, "full", urls(16, "a"), 0);
    h.cache.layout(slow, "full", [], 0);
    await h.finish();
    for (const round of ["b", "c", "d"]) {
      h.cache.layout(a, "full", urls(16, round), h.cache.snapshot().version);
      await h.finish();
      h.cache.layout(a, "full", urls(16, round), h.cache.snapshot().version);
      await h.finish();
      assert.ok(liveWeight(h) <= SHEET_BUDGET, `round ${round}: ${liveWeight(h)}`);
      assert.ok(h.cache.weight().held + h.cache.weight().closing <= SHEET_BUDGET);
    }
    assert.equal(h.cache.states().size, 0, "nothing new decodes while the slow board may draw the old");
    // Once it commits, the old close and the new come.
    h.cache.layout(slow, "full", [], h.cache.snapshot().version);
    assert.equal(h.released.length, 16);
    assert.equal(h.pending.length, 16);
  });

  test("a failed sheet keeps its place but weighs nothing", async () => {
    const h = harness();
    const board = {};
    h.cache.layout(board, "full", ["bad", ...urls(16)], 0);
    assert.equal(h.cache.admitted().length, 16);
    await h.finish((url) => url === "bad");
    h.cache.layout(board, "full", ["bad", ...urls(16)], h.cache.snapshot().version);
    assert.deepEqual(h.cache.admitted(), ["bad", ...urls(16)]);
    assert.deepEqual(h.pending.map((p) => p.url), ["s15"]);
  });

  test("a sheet that goes is freed only once every board has committed a render without it", async () => {
    const h = harness();
    const a = {};
    const b = {};
    h.cache.layout(a, "full", urls(16), 0);
    h.cache.layout(b, "full", [], 0);
    await h.finish();
    const v1 = h.cache.snapshot().version;
    h.cache.layout(a, "full", urls(16), v1);
    h.cache.layout(b, "full", [], v1);
    const gone = h.imageOf("s15");
    // A asks for a new nearest sheet: s15, asked for last, goes from the snapshot at once.
    h.cache.layout(a, "full", ["new", ...urls(15)], v1);
    const v2 = h.cache.snapshot().version;
    assert.ok(v2 > v1 && h.cache.snapshot().get("s15") === null);
    assert.ok(!h.released.includes(gone), "board A's last commit still drew it");
    h.cache.layout(a, "full", ["new", ...urls(15)], v2);
    assert.ok(!h.released.includes(gone), "board B's last commit still drew it");
    h.cache.layout(b, "full", [], v2);
    assert.deepEqual(h.released, [gone]);
  });

  test("a board hidden or gone holds nothing back, and asks for nothing", async () => {
    const h = harness();
    const a = {};
    h.cache.layout(a, "full", urls(16), 0);
    await h.finish();
    h.cache.forget(a);
    assert.deepEqual(h.cache.admitted(), []);
    // Its sheets stay decoded until another board needs the room, then go once that board has committed a render without them.
    const b = {};
    h.cache.layout(b, "full", urls(3, "b"), h.cache.snapshot().version);
    assert.equal(h.released.length, 0);
    h.cache.layout(b, "full", urls(3, "b"), h.cache.snapshot().version);
    assert.equal(h.released.length, 3);
  });

  test("a load no board's admission holds stops, and its late answer is freed and never shown", async () => {
    const h = harness();
    const board = {};
    h.cache.layout(board, "full", ["x"], 0);
    const load = h.pending[0]!;
    h.cache.layout(board, "full", [], 0);
    assert.ok(load.signal.aborted);
    load.resolve(h.imageOf("x"));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.cache.snapshot().get("x"), null);
    assert.deepEqual(h.released, [h.imageOf("x")]);
  });

  test("a sheet that fails stays a picture while asked for, and a later ask tries again", async () => {
    const h = harness();
    const board = {};
    h.cache.layout(board, "full", ["x"], 0);
    await h.finish(() => true);
    h.cache.layout(board, "full", ["x"], 0);
    assert.equal(h.pending.length, 0, "no retry while it is still asked for");
    h.cache.layout(board, "full", [], 0);
    h.cache.layout(board, "full", ["x"], 0);
    assert.equal(h.pending.length, 1);
  });

  test("arrivals in a burst are told once", async () => {
    const h = harness();
    let told = 0;
    h.cache.subscribe(() => told++);
    h.cache.layout({}, "full", urls(5), 0);
    await h.finish();
    assert.equal(h.news.length, 1);
    h.news.splice(0).forEach((run) => run());
    assert.equal(told, 1);
  });

  test("a layout asks for the sheets of the creatures its cull box holds, nearest the canvas's middle first, each once", () => {
    const want = (sheet: string | null, x: number, y: number, keep = false): SheetWant => ({ sheet, at: { x, y }, wanted: { x0: x - 1, y0: y - 3, x1: x + 1, y1: y + 0.5 }, keep });
    const cull = { x0: 0, y0: 0, x1: 20, y1: 20 };
    const standing = [
      want("far", 18, 18),
      want("near", 10.5, 9),
      want(null, 10, 10),
      want("near", 3, 3),
      want("off", 40, 40),
      want("kept", 40, 40, true),
      want("mid", 6, 12),
      // Its ring lies past the box's bottom, but its model reaches into it.
      want("tall", 10, 22),
    ];
    assert.deepEqual(sheetsNearest(standing, cull, { x: 10, y: 10 }, (id) => `/${id}`), ["/near", "/mid", "/far", "/tall", "/kept"]);
  });
});
