import { Mp3Encoder } from "@breezystack/lamejs";
import { concat as join } from "#shared/audio/mp3Testutil.ts";
import { Mp3Writer, type Mp3EncoderClass } from "./encode.ts";

/**
 * Sound files written from scratch for the upload's tests and the e2e
 * fixtures' script (e2e/fixtures/sounds.ts): WAVs of every sample format,
 * MP3s from the same encoder the app uses, tags around them, and the
 * headers of the other formats the guard reads. Every one is a tone or
 * silence made here, never a recording.
 */

/** An ID3v1 tag: 128 bytes at a file's end, the frame walk's tests' own. */
export { id3v1 } from "#shared/audio/mp3Testutil.ts";

export type Tone = { hz: number; dbfs: number };

/** Samples of a tone on every channel, or silence for a tone of null. */
export function toneSamples(input: { seconds: number; rateHz: number; channels: number; tone: Tone | null; offset?: number }): Float32Array[] {
  const length = Math.round(input.seconds * input.rateHz);
  const amplitude = input.tone ? 10 ** (input.tone.dbfs / 20) : 0;
  const out: Float32Array[] = [];
  for (let c = 0; c < input.channels; c++) {
    const data = new Float32Array(length);
    if (input.tone) for (let i = 0; i < length; i++) data[i] = amplitude * Math.sin((2 * Math.PI * input.tone.hz * (i + (input.offset ?? 0))) / input.rateHz);
    out.push(data);
  }
  return out;
}

function ascii(text: string): number[] {
  return Array.from(text, (ch) => ch.charCodeAt(0));
}

function le(value: number, bytes: number): number[] {
  return Array.from({ length: bytes }, (_, i) => Math.floor(value / 256 ** i) % 256);
}

function be(value: number, bytes: number): number[] {
  return Array.from({ length: bytes }, (_, i) => Math.floor(value / 256 ** (bytes - 1 - i)) % 256);
}

export type WavSpec = { channels: number; rateHz: number; bits: 8 | 16 | 24 | 32 | 64; sample: "int" | "float"; extensible?: boolean; extraChunk?: boolean };

/** The header of a WAV of `frames` frames, the `data` chunk's header last. */
export function wavHeader(spec: WavSpec, frames: number, dataSize?: number): Uint8Array {
  const blockAlign = (spec.channels * spec.bits) / 8;
  const data = dataSize ?? frames * blockAlign;
  const tag = spec.sample === "float" ? 3 : 1;
  const fmt = spec.extensible
    ? [...le(0xfffe, 2), ...le(spec.channels, 2), ...le(spec.rateHz, 4), ...le(spec.rateHz * blockAlign, 4), ...le(blockAlign, 2), ...le(spec.bits, 2), ...le(22, 2), ...le(spec.bits, 2), ...le(0, 4), ...le(tag, 2), 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]
    : [...le(tag, 2), ...le(spec.channels, 2), ...le(spec.rateHz, 4), ...le(spec.rateHz * blockAlign, 4), ...le(blockAlign, 2), ...le(spec.bits, 2)];
  // An odd-sized chunk before the data, padded, as recorders write a LIST or bext chunk.
  const extra = spec.extraChunk ? [...ascii("LIST"), ...le(5, 4), ...ascii("INFOx"), 0] : [];
  const body = [...ascii("WAVE"), ...ascii("fmt "), ...le(fmt.length, 4), ...fmt, ...extra, ...ascii("data"), ...le(data, 4)];
  return new Uint8Array([...ascii("RIFF"), ...le(Math.min(0xffffffff, body.length + data), 4), ...body]);
}

/** PCM bytes of float samples in a WAV's format, interleaved. */
export function wavData(spec: WavSpec, channels: readonly Float32Array[]): Uint8Array {
  const frames = channels[0]?.length ?? 0;
  const step = spec.bits / 8;
  const out = new Uint8Array(frames * spec.channels * step);
  const v = new DataView(out.buffer);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < spec.channels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]![f]!));
      const at = (f * spec.channels + c) * step;
      if (spec.sample === "float") {
        if (spec.bits === 32) v.setFloat32(at, s, true);
        else v.setFloat64(at, s, true);
      } else if (spec.bits === 8) v.setUint8(at, Math.round(s * 127) + 128);
      else if (spec.bits === 16) v.setInt16(at, Math.round(s * 32_767), true);
      else if (spec.bits === 24) {
        const x = Math.round(s * 8_388_607);
        v.setUint8(at, x & 0xff);
        v.setUint8(at + 1, (x >> 8) & 0xff);
        v.setInt8(at + 2, x >> 16);
      } else v.setInt32(at, Math.round(s * 2_147_483_647), true);
    }
  }
  return out;
}

export function wavFile(spec: WavSpec, channels: readonly Float32Array[]): Uint8Array {
  return concat([wavHeader(spec, channels[0]?.length ?? 0), wavData(spec, channels)]);
}

/** The parts end to end, joined by the frame walk's own builder, which takes them one by one. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  return join(...parts);
}

/** A constant bitrate MP3 from the app's own encoder: 128 kbps stereo or 64 kbps mono. */
export function mp3Of(channels: readonly Float32Array[], rateHz: number): Uint8Array {
  const writer = new Mp3Writer(Mp3Encoder as unknown as Mp3EncoderClass, channels.length === 1 ? 1 : 2, rateHz);
  writer.push(channels);
  return concat(writer.end());
}

/** An MP3 at any bitrate lamejs makes, such as 320 kbps, which the room never keeps as it is. */
export function mp3AtKbps(channels: readonly Float32Array[], rateHz: number, kbps: number): Uint8Array {
  const encoder = new (Mp3Encoder as unknown as Mp3EncoderClass)(channels.length, rateHz, kbps);
  const toInt = (f: Float32Array) => Int16Array.from(f, (s) => Math.max(-32_768, Math.min(32_767, Math.round(s * 32_767))));
  const parts = [encoder.encodeBuffer(toInt(channels[0]!), channels[1] ? toInt(channels[1]) : undefined).slice(), encoder.flush().slice()];
  return concat(parts);
}

/** An ID3v2.3 tag with a title frame, padded to `size` bytes in all. */
export function id3v2(title: string, size = 64): Uint8Array {
  const text = [0, ...ascii(title)];
  const frame = [...ascii("TIT2"), ...be(text.length, 4), 0, 0, ...text];
  const body = new Uint8Array(Math.max(size - 10, frame.length));
  body.set(frame);
  const n = body.length;
  return new Uint8Array([...ascii("ID3"), 3, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f, ...body]);
}

export function aiffHeader(input: { channels: number; frames: number; rateHz: number }): Uint8Array {
  // The rate as an 80-bit extended float: exponent then a 64-bit mantissa with its leading 1.
  const e = Math.floor(Math.log2(input.rateHz));
  const mantissa = input.rateHz / 2 ** e;
  const hi = Math.floor(mantissa * 2 ** 31);
  const rate = [...be(16383 + e, 2), ...be(hi, 4), ...be(0, 4)];
  const comm = [...be(input.channels, 2), ...be(input.frames, 4), ...be(16, 2), ...rate];
  const body = [...ascii("AIFF"), ...ascii("COMM"), ...be(comm.length, 4), ...comm];
  return new Uint8Array([...ascii("FORM"), ...be(body.length, 4), ...body]);
}

export function flacHeader(input: { channels: number; rateHz: number; totalSamples: number }): Uint8Array {
  const info = new Uint8Array(34);
  info[10] = (input.rateHz >> 12) & 0xff;
  info[11] = (input.rateHz >> 4) & 0xff;
  info[12] = ((input.rateHz & 0xf) << 4) | (((input.channels - 1) & 7) << 1) | 0;
  info[13] = (15 << 4) | (Math.floor(input.totalSamples / 2 ** 32) & 0xf);
  new DataView(info.buffer).setUint32(14, input.totalSamples % 2 ** 32);
  return new Uint8Array([...ascii("fLaC"), 0x80, 0, 0, 34, ...info]);
}

function oggPage(packet: number[], granule: number, serial: number): number[] {
  return [...ascii("OggS"), 0, 2, ...le(granule, 8), ...le(serial, 4), ...le(0, 4), ...le(0, 4), 1, packet.length, ...packet];
}

/** The first and last pages of an Ogg stream, enough for the guard: its identification header and its last granule. */
export function oggFile(input: { codec: "vorbis" | "opus"; channels: number; rateHz: number; samples: number; preSkip?: number }): Uint8Array {
  const serial = 0x1234;
  const id =
    input.codec === "vorbis"
      ? [1, ...ascii("vorbis"), ...le(0, 4), input.channels, ...le(input.rateHz, 4), ...le(0, 12), 0xb8, 1]
      : [...ascii("OpusHead"), 1, input.channels, ...le(input.preSkip ?? 312, 2), ...le(input.rateHz, 4), 0, 0, 0];
  return new Uint8Array([...oggPage(id, 0, serial), ...new Array(200).fill(0), ...oggPage([0], input.samples + (input.codec === "opus" ? (input.preSkip ?? 312) : 0), serial)]);
}

function box(type: string, body: readonly number[]): number[] {
  return [...be(body.length + 8, 4), ...ascii(type), ...body];
}

/** An AudioSpecificConfig in an `esds` box. */
export function esdsBox(input: { objectType: number; rateIndex: number; channelConfig: number; extensionRateIndex?: number }): number[] {
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  put(input.objectType, 5);
  put(input.rateIndex, 4);
  put(input.channelConfig, 4);
  if (input.extensionRateIndex !== undefined) {
    put(input.extensionRateIndex, 4);
    put(2, 5);
  }
  while (bits.length % 8 !== 0) bits.push(0);
  const asc = Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((a, b) => a * 2 + b, 0));
  const specific = [5, asc.length, ...asc];
  const config = [4, 13 + specific.length, 0x40, 0x15, 0, 0, 0, ...be(0, 4), ...be(0, 4), ...specific];
  const es = [3, 3 + config.length, 0, 1, 0, ...config];
  return box("esds", [0, 0, 0, 0, ...es]);
}

/** An MP4 file of one sound track: `ftyp`, an `mdat` placeholder, then `moov` at the end, where many encoders write it. */
export function m4aFile(input: { channels: number; rateHz: number; version?: 0 | 1 | 2; esds?: number[]; timescale?: number; duration?: number; type?: string }): Uint8Array {
  const version = input.version ?? 0;
  let entryBody: number[];
  if (version === 2) {
    const rate = new Uint8Array(8);
    new DataView(rate.buffer).setFloat64(0, input.rateHz);
    entryBody = [...new Array(6).fill(0), 0, 1, ...be(2, 2), ...be(0, 2), ...be(0, 4), ...be(3, 2), ...be(16, 2), ...be(0xfffe, 2), ...be(0, 2), ...be(65536, 4), ...be(72, 4), ...rate, ...be(input.channels, 4), ...be(0x7f000000, 4), ...be(16, 4), ...be(0, 4), ...be(0, 4), ...be(1, 4)];
  } else {
    entryBody = [...new Array(6).fill(0), 0, 1, ...be(version, 2), ...be(0, 2), ...be(0, 4), ...be(input.channels, 2), ...be(16, 2), ...be(0, 2), ...be(0, 2), ...be(Math.round(input.rateHz * 65536) % 2 ** 32, 4)];
    if (version === 1) entryBody.push(...new Array(16).fill(0));
  }
  const entry = box(input.type ?? "mp4a", [...entryBody, ...(input.esds ?? [])]);
  const stsd = box("stsd", [0, 0, 0, 0, ...be(1, 4), ...entry]);
  const stbl = box("stbl", stsd);
  const minf = box("minf", stbl);
  const timescale = input.timescale ?? input.rateHz;
  const mdhd = box("mdhd", [0, 0, 0, 0, ...be(0, 4), ...be(0, 4), ...be(timescale, 4), ...be(input.duration ?? 0, 4), 0, 0, 0, 0]);
  const hdlr = box("hdlr", [0, 0, 0, 0, ...be(0, 4), ...ascii("soun"), ...new Array(12).fill(0), 0]);
  const mdia = box("mdia", [...mdhd, ...hdlr, ...minf]);
  const trak = box("trak", [...box("tkhd", new Array(84).fill(0)), ...mdia]);
  const moov = box("moov", [...box("mvhd", new Array(100).fill(0)), ...trak]);
  return new Uint8Array([...box("ftyp", [...ascii("M4A "), 0, 0, 0, 0, ...ascii("M4A ")]), ...box("mdat", new Array(64).fill(0)), ...moov]);
}

/** ADTS frames of silence-sized payloads: `frames` frames of 1024 samples. */
export function adtsFile(input: { rateIndex: number; channelConfig: number; frames: number }): Uint8Array {
  const out: number[] = [];
  const length = 7 + 16;
  for (let i = 0; i < input.frames; i++) {
    out.push(0xff, 0xf1, (1 << 6) | (input.rateIndex << 2) | ((input.channelConfig >> 2) & 1), ((input.channelConfig & 3) << 6) | ((length >> 11) & 3), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc, ...new Array(16).fill(0));
  }
  return new Uint8Array(out);
}

function ebml(id: number, body: readonly number[]): number[] {
  const idBytes: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v % 256);
  // Sizes as 8-byte vints, which every reader takes.
  return [...idBytes, 0x01, ...be(body.length, 7), ...body];
}

/** A WebM's header through its Tracks, enough for the guard. `segmentUnknown` writes the Segment's size as unknown, as a recorder does. */
export function webmFile(input: { channels?: number; rateHz: number; codec?: string; durationMs?: number; segmentUnknown?: boolean }): Uint8Array {
  const float64 = (n: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n);
    return [...b];
  };
  const header = ebml(0x1a45dfa3, ebml(0x4282, ascii("webm")));
  const info = ebml(0x1549a966, [...ebml(0x2ad7b1, be(1_000_000, 3)), ...(input.durationMs !== undefined ? ebml(0x4489, float64(input.durationMs)) : [])]);
  const audio = ebml(0xe1, [...ebml(0xb5, float64(input.rateHz)), ...(input.channels !== undefined ? ebml(0x9f, [input.channels]) : [])]);
  const track = ebml(0xae, [...ebml(0xd7, [1]), ...ebml(0x83, [2]), ...ebml(0x86, ascii(input.codec ?? "A_VORBIS")), ...audio]);
  const tracks = ebml(0x1654ae6b, track);
  const cluster = ebml(0x1f43b675, new Array(32).fill(0));
  const segmentBody = [...info, ...tracks, ...cluster];
  const segment = input.segmentUnknown ? [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...segmentBody] : ebml(0x18538067, segmentBody);
  return new Uint8Array([...header, ...segment]);
}
