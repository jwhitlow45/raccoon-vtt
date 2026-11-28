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
    h.tell();
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

  test("two boards share the room left rank by rank, so neither keeps the other's nearest out", async () => {
    const h = harness();
    const a = {};
    const b = {};
    h.cache.layout(a, "full", urls(8, "a"), 0);
    // A second board asks while the first's sheets load: those keep their place, and the second's take the room left.
    h.cache.layout(b, "full", urls(16, "b"), 0);
    assert.deepEqual(h.cache.admitted(), urls(8, "a").flatMap((u, i) => [u, `b${i}`]), "in the asks' order, rank by rank");
    await h.finish();
    h.tell();
    // The first board's creatures go, and both boards' new asks share what is left, rank by rank.
    h.cache.layout(a, "full", urls(16, "c"), h.cache.snapshot().version);
    h.cache.layout(b, "full", urls(16, "b"), h.cache.snapshot().version);
    const admitted = h.cache.admitted();
    assert.equal(admitted.length, 16);
    assert.deepEqual(admitted.slice(0, 12), ["c0", "b0", "c1", "b1", "c2", "b2", "c3", "b3", "c4", "b4", "c5", "b5"]);
    assert.deepEqual(admitted.slice(12), ["c6", "b6", "c7", "b7"]);
  });

  test("to make room, only a sheet no board asks for goes, never one asked for", async () => {
    const h = harness();
    const board = {};
    h.cache.layout(board, "full", urls(16), 0);
    await h.finish();
    h.tell();
    // The board pans: s0 and s15 leave its cull box, and two new sheets come nearest the middle.
    h.cache.layout(board, "full", ["n0", "n1", ...urls(16).slice(1, 15)], h.cache.snapshot().version);
    const held = h.cache.states();
    assert.ok(!held.has("s0") && !held.has("s15"), "the sheets no board asks for went");
    for (const u of urls(16).slice(1, 15)) assert.ok(held.has(u), u);
    // The new ones start once the board has committed a render without the two that went, and those are closed.
    assert.ok(!held.has("n0") && !held.has("n1"));
    h.tell();
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
    h.tell();
    assert.equal(liveWeight(h), SHEET_BUDGET);
    h.cache.layout(board, "mobile", urls(24, "m"), h.cache.snapshot().version);
    assert.equal(h.pending.length, 0, "no phone copy starts while the full ones are still drawn");
    assert.ok(liveWeight(h) <= SHEET_BUDGET);
    // The board commits a render without the full copies: they close, and the phone copies come.
    h.tell();
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
      h.tell();
      h.cache.layout(a, "full", urls(16, round), h.cache.snapshot().version);
      await h.finish();
      h.tell();
      assert.ok(liveWeight(h) <= SHEET_BUDGET, `round ${round}: ${liveWeight(h)}`);
      assert.ok(h.cache.weight().held + h.cache.weight().closing <= SHEET_BUDGET);
    }
    assert.equal(h.cache.states().size, 0, "nothing new decodes while the slow board may draw the old");
    // Once it commits, the old close and the new come.
    h.tell();
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
    h.tell();
    const v1 = h.cache.snapshot().version;
    h.cache.layout(a, "full", urls(16), v1);
    h.cache.layout(b, "full", [], v1);
    const gone = h.imageOf("s15");
    // A asks for a new nearest sheet in place of s15, which goes from the next snapshot.
    h.cache.layout(a, "full", ["new", ...urls(15)], v1);
    assert.equal(h.cache.snapshot().version, v1, "the snapshot changes only with the news");
    h.tell();
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
    h.tell();
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

  test("arrivals in a burst are told once, and the snapshot a board reads changes only with the news", async () => {
    const h = harness();
    let told = 0;
    h.cache.subscribe(() => told++);
    h.cache.layout({}, "full", urls(10), 0);
    const [first, second] = [h.pending.splice(0, 5), h.pending.splice(0)];
    h.pending.push(...first);
    await h.finish();
    // A render between two arrivals, before the frame's news, reads what it read before, so it never lays out twice for one frame.
    assert.equal(h.cache.snapshot().version, 0);
    assert.equal(h.cache.snapshot().get("s0"), null);
    h.pending.push(...second);
    await h.finish();
    assert.equal(h.news.length, 1);
    h.tell();
    assert.equal(told, 1);
    assert.equal(h.cache.snapshot().version, 1);
    assert.deepEqual(urls(10).map((u) => h.cache.snapshot().get(u) !== null), urls(10).map(() => true));
    assert.equal(h.cache.counts().news, 1);
  });

  test("a sheet that arrives while others load waits for them, and is told once its wait ends if one is slow", async () => {
    const h = harness();
    h.cache.layout({}, "full", urls(3), 0);
    const slow = h.pending.splice(2, 1)[0]!;
    await h.finish();
    assert.equal(h.news.length, 0, "the two that came wait for the third");
    assert.equal(h.waits.size, 1);
    h.wait();
    h.tell();
    assert.deepEqual(urls(3).map((u) => h.cache.snapshot().get(u) !== null), [true, true, false]);
    // The slow one comes alone, and is told at once.
    h.pending.push(slow);
    await h.finish();
    assert.equal(h.news.length, 1);
    h.tell();
    assert.notEqual(h.cache.snapshot().get("s2"), null);
  });

  test("arrivals waiting for a sheet that fails are told when it fails", async () => {
    const h = harness();
    h.cache.layout({}, "full", urls(3), 0);
    const bad = h.pending.splice(0, 1)[0]!;
    await h.finish();
    assert.equal(h.news.length, 0);
    bad.reject(new Error("404"));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.news.length, 1);
    assert.equal(h.waits.size, 0, "its wait ended");
    h.tell();
    assert.deepEqual(urls(3).map((u) => h.cache.snapshot().get(u) !== null), [false, true, true]);
  });

  test("a pan that reorders more asks than fit evicts and loads nothing: the sheets held keep their place, and the rest stand as pictures until one leaves", async () => {
    const h = harness();
    const board = {};
    const asked = urls(26, "m");
    h.cache.layout(board, "mobile", asked, 0);
    await h.finish();
    h.tell();
    assert.equal(h.cache.counts().loads, 24);
    // Each cull step of the pan brings the two waiting nearest the middle, then back, then past each other.
    for (const order of [["m25", "m24", ...asked.slice(0, 24)], asked, [...asked.slice(0, 12), "m24", "m25", ...asked.slice(12, 24)].reverse()]) {
      h.cache.layout(board, "mobile", order, h.cache.snapshot().version);
      assert.deepEqual(h.cache.counts(), { loads: 24, evictions: 0, arrivals: 24, news: 1 }, order.join());
      assert.deepEqual(new Set(h.cache.admitted()), new Set(asked.slice(0, 24)));
      assert.equal(h.news.length, 0, "nothing for the board to lay out again");
    }
    // A creature leaves the cull box: its sheet goes, and the nearest waiting one starts once the board has drawn without it.
    h.cache.layout(board, "mobile", ["m25", "m24", ...asked.slice(1, 24)], h.cache.snapshot().version);
    assert.equal(h.cache.counts().evictions, 1);
    h.tell();
    h.cache.layout(board, "mobile", ["m25", "m24", ...asked.slice(1, 24)], h.cache.snapshot().version);
    assert.deepEqual(h.pending.map((p) => p.url), ["m25"]);
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
