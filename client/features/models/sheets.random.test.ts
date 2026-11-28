import assert from "node:assert/strict";
import { test } from "node:test";
import { rng } from "#shared/testutil.ts";
import { SHEET_BUDGET, SHEET_WEIGHT, type SheetCopy, type SheetImage } from "./sheets.ts";
import { harness } from "./sheets.testutil.ts";

/*
 * The sheet cache under many random orders of boards asking, rendering and
 * committing, hiding, and loads answering, failing and arriving late
 * (docs/design/design-v1-token-models.md 6). Named invariants:
 *
 * - BUDGET: the sheets loading, held and gone but not yet closed never weigh
 *   more than the budget, and neither do the images decoded and not freed.
 * - ADMISSION: every sheet held or loading that a board asks for is
 *   admitted, then the first of every board's other asks taken rank by
 *   rank that fit in the room left, a failed one in its place weighing
 *   nothing, all in the asks' order, and every load running is one of them.
 * - NEVER-CLOSED: no board's last commit draws a freed sheet, and no
 *   snapshot holds one.
 * - ONCE: no sheet is freed twice.
 * - LATE: a sheet whose load stopped never shows.
 * - HELD: a sheet that arrived while others load is told with the last of
 *   them or once its wait ends, so SETTLES holds once every wait has ended.
 * - SETTLES: once every load has answered and every board has committed
 *   until nothing more starts, every admitted sheet is held or failed, and
 *   nothing gone waits to close.
 */

type Board = { key: object; copy: SheetCopy; asks: string[]; drawn: Set<SheetImage>; live: boolean };

test("random sequences of asks, commits, hides and answers keep the cache's invariants", async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const random = rng(seed);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    const h = harness();
    const boards: Board[] = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ key: {}, copy: random() < 0.5 ? "full" : "mobile", asks: [], drawn: new Set(), live: false }));
    // The boards in the order the cache heard of them: a hidden board comes back last.
    const order: Board[] = [];
    const pool = (copy: SheetCopy) => Array.from({ length: 40 }, (_, i) => `${copy}:${i}`);
    const commit = (b: Board) => {
      const snap = h.cache.snapshot();
      b.drawn = new Set(b.asks.flatMap((u) => snap.get(u) ?? []));
      if (!b.live) order.push(b);
      b.live = true;
      h.cache.layout(b.key, b.copy, b.asks, snap.version);
    };
    const weighs = (url: string) => SHEET_WEIGHT[url.startsWith("full") ? "full" : "mobile"];
    const check = (step: string) => {
      let weight = 0;
      for (const [url, state] of h.cache.states()) if (state !== "failed") weight += weighs(url);
      const { held, closing } = h.cache.weight();
      assert.equal(held, weight, `BUDGET, seed ${seed}, ${step}: the cache's own count`);
      assert.ok(held + closing <= SHEET_BUDGET, `BUDGET, seed ${seed}, ${step}: ${held} held and ${closing} closing`);
      const decoded = h.live().reduce((w, image) => w + weighs((image as unknown as { url: string }).url), 0);
      assert.ok(decoded <= SHEET_BUDGET, `BUDGET, seed ${seed}, ${step}: ${decoded} decoded and not freed`);
      // ADMISSION, against the rule written out again.
      const live = order;
      const merged: string[] = [];
      for (let rank = 0; rank < 40; rank++) for (const b of live) if (b.asks[rank] !== undefined && !merged.includes(b.asks[rank]!)) merged.push(b.asks[rank]!);
      const states = h.cache.states();
      const isHeld = (url: string) => states.get(url) === "loading" || states.get(url) === "ready";
      const taken = new Set(merged.filter(isHeld));
      let w = [...taken].reduce((sum, url) => sum + weighs(url), 0);
      for (const url of merged.filter((u) => !isHeld(u))) {
        w += states.get(url) === "failed" ? 0 : weighs(url);
        if (w > SHEET_BUDGET) break;
        taken.add(url);
      }
      const expected = merged.filter((url) => taken.has(url));
      assert.deepEqual(h.cache.admitted(), expected, `ADMISSION, seed ${seed}, ${step}`);
      for (const [url, state] of h.cache.states()) if (state === "loading") assert.ok(expected.includes(url), `ADMISSION, a load runs only for an admitted sheet, seed ${seed}, ${step}`);
      const snap = h.cache.snapshot();
      for (const b of live) for (const image of b.drawn) assert.ok(!h.released.includes(image), `NEVER-CLOSED, seed ${seed}, ${step}`);
      for (const url of [...pool("full"), ...pool("mobile")]) {
        const image = snap.get(url);
        if (image) assert.ok(!h.released.includes(image), `NEVER-CLOSED in the snapshot, seed ${seed}, ${step}`);
      }
      assert.equal(new Set(h.released).size, h.released.length, `ONCE, seed ${seed}, ${step}`);
    };
    for (let step = 0; step < 60; step++) {
      const roll = random();
      const b = pick(boards);
      let what: string;
      if (roll < 0.3) {
        // A cull step or a turn: a new list of creatures nearest the middle, often much the same.
        const all = pool(b.copy);
        const n = Math.floor(random() * 32);
        const keep = b.asks.filter(() => random() < 0.7);
        b.asks = [...new Set([...keep, ...Array.from({ length: n }, () => pick(all))])].slice(0, n);
        commit(b);
        what = `ask ${b.asks.length}`;
      } else if (roll < 0.45) {
        commit(b);
        what = "render";
      } else if (roll < 0.52) {
        if (b.live) order.splice(order.indexOf(b), 1);
        b.live = false;
        b.asks = [];
        b.drawn = new Set();
        h.cache.forget(b.key);
        what = "hide";
      } else if (roll < 0.58) {
        b.copy = b.copy === "full" ? "mobile" : "full";
        b.asks = [];
        commit(b);
        what = "copy";
      } else if (h.pending.length > 0 && roll < 0.95) {
        const i = Math.floor(random() * h.pending.length);
        const [load] = h.pending.splice(i, 1);
        const fails = random() < 0.15;
        const image = fails ? null : h.decoded(load!.url);
        if (image) load!.resolve(image);
        else load!.reject(new Error("404"));
        await new Promise((r) => setImmediate(r));
        // LATE: a sheet whose load had stopped is freed at once and never held.
        if (image && load!.signal.aborted) assert.ok(h.released.includes(image) && h.cache.snapshot().get(load!.url) !== image, `LATE, seed ${seed}`);
        what = "answer";
      } else if (roll < 0.98 || h.waits.size === 0) {
        h.tell();
        what = "news";
      } else {
        // Arrivals that waited for a slow sheet are told.
        h.wait();
        what = "wait";
      }
      check(`step ${step} (${what})`);
    }
    // SETTLES: every load answers and every board commits, until nothing more starts.
    for (let round = 0; round < 10 && (round < 2 || h.pending.length > 0); round++) {
      while (h.pending.length > 0) await h.finish();
      h.wait();
      h.tell();
      for (const b of boards) if (b.live) commit(b);
    }
    h.wait();
    h.tell();
    for (const b of boards) if (b.live) commit(b);
    check("settled");
    assert.equal(h.pending.length, 0, `SETTLES, seed ${seed}: loads still waiting`);
    const states = h.cache.states();
    for (const url of h.cache.admitted()) assert.ok(states.get(url) === "ready" || states.get(url) === "failed", `SETTLES, seed ${seed}: ${url} is ${states.get(url)}`);
    assert.equal(h.cache.weight().closing, 0, `SETTLES, seed ${seed}: sheets wait to close`);
    h.cache.dispose();
    assert.equal(new Set(h.released).size, h.released.length, `ONCE after dispose, seed ${seed}`);
  }
});
