import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SILENCE_PATH, silenceMp3 } from "./silence.ts";

/* The committed silence.mp3 is exactly what scripts/silence.ts writes, so it cannot drift from the script that makes it. */
test("public/sounds/silence.mp3 is the script's output", () => {
  assert.deepEqual(new Uint8Array(readFileSync(SILENCE_PATH)), silenceMp3());
});

test("it is four frames of MPEG-1 Layer III at 44.1 kHz, mono, a tenth of a second", () => {
  const bytes = silenceMp3();
  const size = 209;
  assert.equal(bytes.length, 4 * size);
  for (let i = 0; i < 4; i++) {
    const at = i * size;
    assert.equal(bytes[at], 0xff);
    assert.equal(bytes[at + 1], 0xfb);
    assert.equal(bytes[at + 2], 0x52);
    assert.equal(bytes[at + 3]! >> 6, 0b11, "mono");
    assert.ok(bytes.subarray(at + 4, at + size).every((b) => b === 0), "no data in any granule");
  }
  assert.ok(Math.abs((4 * 1152) / 44_100 - 0.1) < 0.005);
});
