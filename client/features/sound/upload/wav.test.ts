import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bytesSource } from "./bytes.ts";
import { concat, toneSamples, wavData, wavFile, wavHeader, type WavSpec } from "./sounds.testutil.ts";
import { readsInPieces, readWavFormat, wavToFloat } from "./wav.ts";

const FORMATS: WavSpec[] = [
  { channels: 1, rateHz: 44_100, bits: 8, sample: "int" },
  { channels: 2, rateHz: 44_100, bits: 16, sample: "int" },
  { channels: 2, rateHz: 48_000, bits: 24, sample: "int" },
  { channels: 4, rateHz: 48_000, bits: 32, sample: "int" },
  { channels: 2, rateHz: 44_100, bits: 32, sample: "float" },
  { channels: 6, rateHz: 48_000, bits: 64, sample: "float" },
  { channels: 2, rateHz: 44_100, bits: 24, sample: "int", extensible: true },
  { channels: 2, rateHz: 48_000, bits: 32, sample: "float", extensible: true },
];

describe("WAV files read in pieces", () => {
  for (const spec of FORMATS) {
    test(`${spec.bits}-bit ${spec.sample}${spec.extensible ? " (extensible)" : ""}, ${spec.channels} channels at ${spec.rateHz} Hz, read back within its precision in any piece`, async () => {
      const tone = toneSamples({ seconds: 0.25, rateHz: spec.rateHz, channels: spec.channels, tone: { hz: 997, dbfs: -6 } });
      const file = wavFile(spec, tone);
      const format = await readWavFormat(bytesSource(file));
      assert.ok(format);
      assert.equal(format.frames, tone[0]!.length);
      assert.equal(readsInPieces(format), true);
      // A piece from the middle, on a frame boundary, as read.ts cuts them.
      const from = 1000;
      const piece = wavToFloat(file.subarray(format.dataOffset + from * format.blockAlign, format.dataOffset + (from + 500) * format.blockAlign), format);
      const tolerance = spec.bits === 8 ? 1 / 100 : 1 / 30_000;
      for (let c = 0; c < spec.channels; c++) for (let i = 0; i < 500; i++) assert.ok(Math.abs(piece[c]![i]! - tone[c]![from + i]!) < tolerance, `channel ${c} sample ${i}`);
    });
  }

  test("other rates are decoded whole", async () => {
    const format = await readWavFormat(bytesSource(wavHeader({ channels: 2, rateHz: 22_050, bits: 16, sample: "int" }, 0)));
    assert.equal(format && readsInPieces(format), false);
  });

  test("a data chunk whose size runs past the file counts the whole frames the file holds", async () => {
    const spec: WavSpec = { channels: 2, rateHz: 44_100, bits: 16, sample: "int" };
    const data = wavData(spec, toneSamples({ seconds: 0.01, rateHz: 44_100, channels: 2, tone: null }));
    const file = concat([wavHeader(spec, 0, 0xffffffff), data, new Uint8Array([1])]);
    const format = await readWavFormat(bytesSource(file));
    assert.equal(format?.frames, data.length / 4);
  });

  test("not a WAV, a format it cannot place, or data before fmt reads as none", async () => {
    assert.equal(await readWavFormat(bytesSource(new Uint8Array(64))), null);
    const mulaw = wavHeader({ channels: 1, rateHz: 8000, bits: 8, sample: "int" }, 0);
    mulaw[20] = 7;
    assert.equal(await readWavFormat(bytesSource(mulaw)), null);
    const wrongAlign = wavHeader({ channels: 2, rateHz: 44_100, bits: 16, sample: "int" }, 0);
    wrongAlign[32] = 3;
    assert.equal(await readWavFormat(bytesSource(wrongAlign)), null);
    const badGuid = wavHeader({ channels: 2, rateHz: 44_100, bits: 16, sample: "int", extensible: true }, 0);
    badGuid[50] = 0x99;
    assert.equal(await readWavFormat(bytesSource(badGuid)), null);
  });
});
