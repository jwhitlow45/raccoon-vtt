import "./testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const { refitOn } = await import("./WholeParts.tsx");

/** A row whose width the test sets, a ResizeObserver it can fire, and a font set that loads when told. */
function fakes() {
  const row = { clientWidth: 300 };
  let observed: (() => void) | null = null;
  class Observer {
    constructor(callback: () => void) {
      observed = callback;
    }
    observe() {}
    disconnect() {
      observed = null;
    }
  }
  let ready!: () => void;
  const fonts = Object.assign(new EventTarget(), { ready: new Promise<void>((done) => (ready = done)) });
  return { row, resize: () => observed?.(), ready: () => ready(), fonts, Observer: Observer as unknown as typeof ResizeObserver };
}

test("fl7: a folded line fits again when its row's width changes, and not when only its height does (FL7-R2-OPUS-01)", () => {
  const f = fakes();
  let fits = 0;
  const stop = refitOn(f.row, () => fits++, { Observer: f.Observer, fonts: f.fonts });
  f.resize();
  assert.equal(fits, 0, "the same width fits nothing again");
  f.row.clientWidth = 280;
  f.resize();
  assert.equal(fits, 1);
  stop();
  f.row.clientWidth = 260;
  f.resize();
  assert.equal(fits, 1, "nothing after it stops");
});

test("fl7: a folded line fits again once the web fonts are ready and after each later font load, since a swapped font changes what fits (FL7-R2-OPUS-01)", async () => {
  const f = fakes();
  let fits = 0;
  const stop = refitOn(f.row, () => fits++, { Observer: f.Observer, fonts: f.fonts });
  f.ready();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fits, 1, "fonts.ready");
  f.fonts.dispatchEvent(new Event("loadingdone"));
  assert.equal(fits, 2, "loadingdone");
  stop();
  f.fonts.dispatchEvent(new Event("loadingdone"));
  assert.equal(fits, 2, "nothing after it stops");
});

test("fl7: fonts that load after the line has gone fit nothing (FL7-R2-OPUS-01)", async () => {
  const f = fakes();
  let fits = 0;
  refitOn(f.row, () => fits++, { Observer: f.Observer, fonts: f.fonts })();
  f.ready();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fits, 0);
});
