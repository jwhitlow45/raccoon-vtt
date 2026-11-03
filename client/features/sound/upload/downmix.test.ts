import assert from "node:assert/strict";
import { test } from "node:test";
import { toStereo } from "./downmix.ts";

const f = (...values: number[]) => Float32Array.from(values);

test("mono and stereo pass as they are", () => {
  const mono = [f(0.5)];
  assert.equal(toStereo(mono)[0], mono[0]);
  const stereo = [f(0.1), f(0.2)];
  assert.deepEqual(toStereo(stereo), stereo);
});

test("quad mixes by the speakers rule: each side halves its front and its surround", () => {
  const [l, r] = toStereo([f(1), f(0), f(0.5), f(0.25)]);
  assert.ok(Math.abs(l![0]! - 0.75) < 1e-6);
  assert.ok(Math.abs(r![0]! - 0.125) < 1e-6);
});

test("5.1 mixes by the speakers rule: center and surround at -3 dB, the LFE dropped", () => {
  // L, R, C, LFE, SL, SR
  const [l, r] = toStereo([f(0.1), f(0.2), f(0.4), f(1), f(0.3), f(0)]);
  assert.ok(Math.abs(l![0]! - (0.1 + Math.SQRT1_2 * (0.4 + 0.3))) < 1e-6);
  assert.ok(Math.abs(r![0]! - (0.2 + Math.SQRT1_2 * 0.4)) < 1e-6);
});

test("other counts have no rule", () => {
  assert.throws(() => toStereo([f(0), f(0), f(0)]));
});
