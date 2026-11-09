import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * Look closer paints "Drawing the dungeon…" before its long render
 * (D-261107-269): a frame's callback runs before that frame paints, so the
 * render waits for a task after it.
 */
const { afterPaint } = await import("./LookCloser.tsx");

test("afterPaint waits for the frame's callback and then a task, never the callback alone", async () => {
  const g = globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => number };
  const saved = g.requestAnimationFrame;
  let frame: (() => void) | null = null;
  g.requestAnimationFrame = (cb) => {
    frame = cb;
    return 1;
  };
  try {
    const order: string[] = [];
    const note = (what: string) => void order.push(what);
    const done = afterPaint().then(() => note("render"));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(order.length, 0, "no frame yet");
    (frame as (() => void) | null)?.();
    note("callback ran");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(order, ["callback ran"], "the callback alone does not release it");
    await done;
    assert.deepEqual(order, ["callback ran", "render"]);
  } finally {
    g.requestAnimationFrame = saved;
  }
});

test("a picture that finishes after the dialog closed is revoked, never kept (DG2-SOL-02)", async () => {
  const { settlePicture } = await import("./LookCloser.tsx");
  const picture = { src: "blob:x", width: 1, height: 1 };
  const revoked: string[] = [];
  const kept: unknown[] = [];
  const saved = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => void revoked.push(u);
  try {
    settlePicture(picture, false, (p) => kept.push(p));
    assert.deepEqual(revoked, ["blob:x"]);
    assert.equal(kept.length, 0);
    settlePicture(picture, true, (p) => kept.push(p));
    assert.deepEqual(revoked, ["blob:x"], "a mounted dialog keeps it and revokes it with the viewer");
    assert.equal(kept.length, 1);
  } finally {
    URL.revokeObjectURL = saved;
  }
});
