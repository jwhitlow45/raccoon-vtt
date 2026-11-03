import type { ByteSource } from "./bytes.ts";

/**
 * WAV files (docs/design/design-v1-sound.md 4.2 step 2): the header's facts,
 * and its PCM turned into float samples piece by piece, so a WAV of a
 * plain sample format at 44.1 or 48 kHz is never held decoded whole. Any
 * other WAV decodes whole in the browser, under the device's budget.
 */

export type WavSample = "int" | "float";

/** A WAV's `fmt ` chunk and where its `data` chunk lies. */
export type WavFormat = {
  sample: WavSample;
  /** Bits a sample takes in the file: 8 is unsigned, the rest signed little-endian. */
  bits: number;
  channels: number;
  rateHz: number;
  /** Bytes of one frame, every channel's sample. */
  blockAlign: number;
  dataOffset: number;
  /** Whole frames only, and only bytes the file holds. */
  dataBytes: number;
  frames: number;
};

const PCM = 0x0001;
const IEEE_FLOAT = 0x0003;
const EXTENSIBLE = 0xfffe;

/** The bytes of the GUID every `WAVE_FORMAT_EXTENSIBLE` subformat shares after its first two. */
const GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/** Chunks read before the `data` chunk, at most, so a file of empty chunks cannot keep the reader going. */
const MAX_CHUNKS = 64;
/** A `fmt ` chunk past this is no plain WAV's. */
const MAX_FMT_BYTES = 1024;

function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
}

/** Whether the file starts as a RIFF WAVE file. */
export function isWav(head: Uint8Array): boolean {
  return head.length >= 12 && fourcc(head, 0) === "RIFF" && fourcc(head, 8) === "WAVE";
}

/**
 * The WAV's format and data, reading only chunk headers and the `fmt `
 * chunk. Null when it is no WAV this reader can place: no `fmt ` before
 * `data`, a format other than integer PCM or IEEE float (or those inside
 * `WAVE_FORMAT_EXTENSIBLE`), or a frame size that does not match. A `data`
 * chunk whose size runs past the file, as a recorder that never finished
 * writes, counts the whole frames the file holds.
 */
export async function readWavFormat(source: ByteSource): Promise<WavFormat | null> {
  const head = await source.read(0, 12);
  if (!isWav(head)) return null;
  let at = 12;
  let fmt: Omit<WavFormat, "dataOffset" | "dataBytes" | "frames"> | null = null;
  for (let i = 0; i < MAX_CHUNKS && at + 8 <= source.size; i++) {
    const header = await source.read(at, at + 8);
    const id = fourcc(header, 0);
    const size = new DataView(header.buffer, header.byteOffset, 8).getUint32(4, true);
    const body = at + 8;
    if (id === "fmt ") {
      if (size < 16 || size > MAX_FMT_BYTES) return null;
      fmt = parseFmt(await source.read(body, body + size));
      if (!fmt) return null;
    } else if (id === "data") {
      if (!fmt) return null;
      const held = Math.max(0, Math.min(size, source.size - body));
      const frames = Math.floor(held / fmt.blockAlign);
      return { ...fmt, dataOffset: body, dataBytes: frames * fmt.blockAlign, frames };
    }
    // Chunks are padded to an even length.
    at = body + size + (size % 2);
  }
  return null;
}

function parseFmt(b: Uint8Array): Omit<WavFormat, "dataOffset" | "dataBytes" | "frames"> | null {
  if (b.length < 16) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let tag = v.getUint16(0, true);
  const channels = v.getUint16(2, true);
  const rateHz = v.getUint32(4, true);
  const blockAlign = v.getUint16(12, true);
  const bits = v.getUint16(14, true);
  if (tag === EXTENSIBLE) {
    if (b.length < 40) return null;
    for (let i = 0; i < GUID_TAIL.length; i++) if (b[26 + i] !== GUID_TAIL[i]) return null;
    tag = v.getUint16(24, true);
  }
  let sample: WavSample;
  if (tag === PCM && (bits === 8 || bits === 16 || bits === 24 || bits === 32)) sample = "int";
  else if (tag === IEEE_FLOAT && (bits === 32 || bits === 64)) sample = "float";
  else return null;
  if (channels < 1 || rateHz < 1 || blockAlign !== channels * (bits / 8)) return null;
  return { sample, bits, channels, rateHz, blockAlign };
}

/** Whether this WAV is read in pieces, straight from its PCM: a plain sample format at a stored rate. */
export function readsInPieces(format: WavFormat): boolean {
  return format.rateHz === 44_100 || format.rateHz === 48_000;
}

/**
 * Whole frames of PCM as one float array a channel, -1 to 1 for integers
 * (8-bit samples are unsigned around 128). `bytes` holds whole frames from
 * a frame's first byte.
 */
export function wavToFloat(bytes: Uint8Array, format: Pick<WavFormat, "sample" | "bits" | "channels" | "blockAlign">): Float32Array[] {
  const frames = Math.floor(bytes.length / format.blockAlign);
  const out = Array.from({ length: format.channels }, () => new Float32Array(frames));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const step = format.bits / 8;
  for (let f = 0; f < frames; f++) {
    const base = f * format.blockAlign;
    for (let c = 0; c < format.channels; c++) {
      const at = base + c * step;
      out[c]![f] = sampleAt(v, at, format.sample, format.bits);
    }
  }
  return out;
}

function sampleAt(v: DataView, at: number, sample: WavSample, bits: number): number {
  if (sample === "float") return bits === 32 ? v.getFloat32(at, true) : v.getFloat64(at, true);
  switch (bits) {
    case 8:
      return (v.getUint8(at) - 128) / 128;
    case 16:
      return v.getInt16(at, true) / 32_768;
    case 24: {
      const raw = v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getInt8(at + 2) << 16);
      return raw / 8_388_608;
    }
    default:
      return v.getInt32(at, true) / 2_147_483_648;
  }
}
