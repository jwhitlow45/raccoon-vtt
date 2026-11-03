import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Writes public/sounds/silence.mp3, the tenth of a second of silence the
 * room sound's element pool plays inside a tap so the browser lets each
 * element play later by itself (docs/design/design-v1-music.md 5.5). Run by
 * hand when it changes:
 *
 *   node scripts/silence.ts
 *
 * It makes no audio: each frame is an MPEG-1 Layer III header and a side
 * information block of zeros, which tells a decoder that every granule
 * holds no data, so it decodes to digital silence. Four frames of 1152
 * samples at 44.1 kHz are 104 ms. silence.test.ts checks the committed file
 * is exactly what this writes.
 */

const RATE_INDEX_44100 = 0b00;
/** 64 kbps in MPEG-1 Layer III's bitrate table. */
const BITRATE_INDEX_64 = 0b0101;
const BITRATE = 64_000;
const RATE = 44_100;
const FRAMES = 4;

/** One frame: a padded frame is one byte longer, and every frame here is padded, which the header says. */
function frame(): Uint8Array {
  const size = Math.floor((144 * BITRATE) / RATE) + 1;
  const bytes = new Uint8Array(size);
  // Sync, MPEG-1, Layer III, no CRC.
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  // Bitrate, sample rate, padding on, private bit off.
  bytes[2] = (BITRATE_INDEX_64 << 4) | (RATE_INDEX_44100 << 2) | 0b10;
  // Mono, no mode extension, not copyrighted, a copy, no emphasis.
  bytes[3] = 0b11 << 6;
  // Mono's 17 bytes of side information and the main data after it stay zero: no granule holds data.
  return bytes;
}

/** The whole file. */
export function silenceMp3(): Uint8Array {
  const one = frame();
  const out = new Uint8Array(one.length * FRAMES);
  for (let i = 0; i < FRAMES; i++) out.set(one, i * one.length);
  return out;
}

export const SILENCE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "sounds", "silence.mp3");

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(SILENCE_PATH, silenceMp3());
  console.log(`wrote ${path.relative(process.cwd(), SILENCE_PATH)}`);
}
