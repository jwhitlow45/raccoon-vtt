import assert from "node:assert/strict";
import { test } from "node:test";
import { mp3Pieces, outputSamples, PRE_ROLL_FRAMES } from "./pieces.ts";

function facts(rateHz: 44_100 | 48_000, frames: number, frameBytes = 418) {
  return { rateHz, frames, offsets: Uint32Array.from({ length: frames }, (_, i) => 10 + i * frameBytes) };
}

test("a 48 kHz MP3's pre-roll of 10 frames is 10,584 output samples, dropped from every piece but the first", () => {
  const f = facts(48_000, 2500 * 3 + 7);
  const pieces = mp3Pieces(f, 10 + f.frames * 418);
  assert.equal(pieces.length, 4);
  assert.equal(pieces[0]!.drop, 0);
  assert.equal(pieces[0]!.start, 10);
  for (const piece of pieces.slice(1)) assert.equal(piece.drop, 10_584);
  assert.equal(outputSamples(PRE_ROLL_FRAMES, 48_000), 10_584);
});

test("each piece starts 10 frames early on a frame boundary and ends where the next piece's own frames start", () => {
  const f = facts(44_100, 2297 * 2 + 1);
  const pieces = mp3Pieces(f, 10 + f.frames * 418);
  assert.equal(pieces[1]!.start, f.offsets[2297 - PRE_ROLL_FRAMES]);
  assert.equal(pieces[0]!.end, f.offsets[2297]);
  assert.equal(pieces[2]!.end, 10 + f.frames * 418);
  assert.equal(pieces[1]!.drop, 11_520);
});

test("the kept samples of all pieces add up to the file's, so nothing is measured twice or missed", () => {
  for (const rateHz of [44_100, 48_000] as const) {
    for (const frames of [1, 9, 2296, 2297, 2298, 34_455]) {
      const f = facts(rateHz, frames);
      const kept = mp3Pieces(f, 10 + frames * 418).reduce((n, p) => n + p.keep, 0);
      assert.equal(kept, outputSamples(frames, rateHz), `${frames} frames at ${rateHz}`);
    }
  }
});
