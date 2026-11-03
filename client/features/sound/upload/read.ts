import { walkMp3 } from "#shared/audio/mp3.ts";
import { SOUND_LIMITS, soundUseFits } from "#shared/limits.ts";
import type { SoundUse } from "#shared/sound.ts";
import { blobSource } from "./bytes.ts";
import { copiedFile, copyable, type CopyCheck } from "./copy.ts";
import type { FromWorker, ToWorker } from "./encode.ts";
import { lengthRefusal, planRead, probeFile, thisDeviceBudget, wholeDecodeFits, type Probe } from "./guard.ts";
import { levelOf } from "./loudness.ts";
import { mp3Pieces, OUTPUT_RATE } from "./pieces.ts";
import type { WavFormat } from "./wav.ts";
import type { Refusal } from "./words.ts";

/**
 * One file made into the room's copy in the DM's browser
 * (docs/design/design-v1-sound.md 4.2 steps 1 to 5): the checks before any
 * decoding, then the read that suits it, its loudness, and the MP3 to
 * upload, copied or encoded. Only one file is read at a time (job.ts), and
 * nothing here outlives its file: the worker ends, the decoded audio and
 * the file's bytes are let go.
 */

/** Where the read is, for the file's row. */
export type ReadStep = { t: "reading" } | { t: "converting"; percent: number };

/** The room's copy, ready to upload. `ms` is its own length, frames times 1152 over the rate. */
export type Prepared = { blob: Blob; level: number; ms: number; copied: boolean };

export type ReadOutcome = { ok: true; prepared: Prepared } | { ok: false; why: Refusal };

/** A file refused partway, carried out of the steps to the one place that answers. */
class Refused extends Error {
  readonly why: Refusal;
  constructor(why: Refusal) {
    super(why.t);
    this.why = why;
  }
}

/** Seconds of audio sent to the worker at once: 10 s of 6 channels at 48 kHz is under 12 MB. */
const PIECE_SECONDS = 10;
/** Pieces in the worker's queue at once, so a fast reader never piles a file's whole PCM there. */
const IN_FLIGHT = 2;
/** How long the media element may take to give a length. */
const METADATA_TIMEOUT_MS = 15_000;

export async function prepareSound(input: { file: File; use: SoundUse; signal: AbortSignal; onStep(step: ReadStep): void; budget?: number }): Promise<ReadOutcome> {
  try {
    return { ok: true, prepared: await prepare(input) };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, why: err.why };
    if (input.signal.aborted) throw input.signal.reason;
    throw err;
  }
}

async function prepare(input: { file: File; use: SoundUse; signal: AbortSignal; onStep(step: ReadStep): void; budget?: number }): Promise<Prepared> {
  const { file, use, signal } = input;
  const budget = input.budget ?? thisDeviceBudget();
  input.onStep({ t: "reading" });
  if (file.size > SOUND_LIMITS.readFileBytes) throw new Refused({ t: "fileTooLarge" });
  const probe = await probeFile(blobSource(file));
  signal.throwIfAborted();
  // The media element only once the channels passed, so a refused file is never handed to a decoder of any kind.
  const ms = probe.ms ?? (probe.channels !== null && SOUND_LIMITS.channels.includes(probe.channels) ? await mediaLength(file, signal) : null);
  const plan = planRead({ probe, ms, fileBytes: file.size, use, budget });
  if (!plan.ok) throw new Refused(plan.why);

  if (plan.path === "mp3Pieces") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    const copy = copyable(bytes);
    if (copy.ok) {
      if (!soundUseFits(use, copy.facts.ms)) throw new Refused(lengthRefusal(use, copy.facts.ms, true) ?? { t: "tooLong" });
      const measured = await measureMp3(copy, signal);
      if (measured) {
        const blob = copiedFile(copy.bytes);
        return { blob, level: levelOf(measured), ms: copy.facts.ms, copied: true };
      }
    }
    // Not the one form the room keeps, or a piece that would not decode: the whole file, under the budget.
    return await encodeWhole({ ...input, probe, ms: plan.ms, budget, bytes });
  }
  if (plan.path === "wavPieces") return await encodeWav({ ...input, wav: probe.wav! });
  return await encodeWhole({ ...input, probe, ms: plan.ms, budget, bytes: null });
}

// ---------------------------------------------------------------- the three reads

/** The copy's own frames in pieces: its offsets count from the first of them, past every tag, so they are taken together. */
async function measureMp3(copy: Extract<CopyCheck, { ok: true }>, signal: AbortSignal): Promise<{ lufs: number; peak: number } | null> {
  const { bytes, facts } = copy;
  const context = new OfflineAudioContext(1, 1, OUTPUT_RATE);
  const worker = new EncodeWorker(signal);
  try {
    let started = false;
    let seq = 0;
    for (const piece of mp3Pieces(facts, bytes.length)) {
      let audio: AudioBuffer;
      try {
        // decodeAudioData takes its buffer away, so each piece gets a copy of its own bytes.
        audio = await context.decodeAudioData(bytes.slice(piece.start, piece.end).buffer);
      } catch {
        return null;
      }
      signal.throwIfAborted();
      if (!started) {
        if (audio.numberOfChannels !== facts.channels) return null;
        worker.start({ t: "start", rateHz: OUTPUT_RATE, channels: facts.channels, encode: false, wav: null });
        started = true;
      }
      const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c).slice(piece.drop, piece.drop + piece.keep));
      await worker.send({ t: "pcm", seq: seq++, channels }, channels.map((c) => c.buffer));
    }
    if (!started) return null;
    const done = await worker.end();
    return { lufs: done.lufs, peak: done.peak };
  } finally {
    worker.close();
  }
}

async function encodeWav(input: { file: File; use: SoundUse; signal: AbortSignal; onStep(step: ReadStep): void; wav: WavFormat }): Promise<Prepared> {
  const { file, signal, wav } = input;
  const perPiece = PIECE_SECONDS * wav.rateHz * wav.blockAlign;
  const pieces = Math.max(1, Math.ceil(wav.dataBytes / perPiece));
  const worker = new EncodeWorker(signal);
  try {
    input.onStep({ t: "converting", percent: 0 });
    worker.start({ t: "start", rateHz: wav.rateHz, channels: wav.channels, encode: true, wav });
    for (let i = 0; i < pieces; i++) {
      const start = wav.dataOffset + i * perPiece;
      const bytes = await file.slice(start, Math.min(wav.dataOffset + wav.dataBytes, start + perPiece)).arrayBuffer();
      signal.throwIfAborted();
      await worker.send({ t: "wav", seq: i, bytes }, [bytes]);
      input.onStep({ t: "converting", percent: Math.floor(((i + 1) / pieces) * 99) });
    }
    return await finish(worker, input.use);
  } finally {
    worker.close();
  }
}

async function encodeWhole(input: { file: File; use: SoundUse; signal: AbortSignal; onStep(step: ReadStep): void; probe: Probe; ms: number; budget: number; bytes: Uint8Array | null }): Promise<Prepared> {
  const { probe, signal } = input;
  if (!wholeDecodeFits({ fileBytes: input.file.size, ms: input.ms, channels: probe.channels!, rateHz: probe.rateHz, budget: input.budget })) throw new Refused({ t: "tooBigToRead" });
  input.onStep({ t: "reading" });
  let buffer: ArrayBuffer | null = input.bytes ? (input.bytes.buffer as ArrayBuffer) : await input.file.arrayBuffer();
  signal.throwIfAborted();
  let audio: AudioBuffer | null;
  try {
    audio = await new OfflineAudioContext(1, 1, OUTPUT_RATE).decodeAudioData(buffer);
  } catch (err) {
    throw new Refused(isOutOfMemory(err) ? { t: "outOfMemory" } : { t: "unreadable" });
  } finally {
    buffer = null;
  }
  signal.throwIfAborted();
  const channels = audio.numberOfChannels;
  if (!SOUND_LIMITS.channels.includes(channels)) throw new Refused({ t: "channels", channels });
  // The decoded length is the source's own, checked exactly, but a framed source's carries its encoder's padding.
  const length = lengthRefusal(input.use, (audio.length / OUTPUT_RATE) * 1000, probe.framed);
  if (length) throw new Refused(length);
  const perPiece = PIECE_SECONDS * OUTPUT_RATE;
  const pieces = Math.max(1, Math.ceil(audio.length / perPiece));
  const worker = new EncodeWorker(signal);
  try {
    input.onStep({ t: "converting", percent: 0 });
    worker.start({ t: "start", rateHz: OUTPUT_RATE, channels, encode: true, wav: null });
    for (let i = 0; i < pieces; i++) {
      const from = i * perPiece;
      const to = Math.min(audio.length, from + perPiece);
      const piece = Array.from({ length: channels }, (_, c) => audio!.getChannelData(c).slice(from, to));
      await worker.send({ t: "pcm", seq: i, channels: piece }, piece.map((p) => p.buffer));
      input.onStep({ t: "converting", percent: Math.floor(((i + 1) / pieces) * 99) });
    }
    // Every piece is in the worker: the decoded file can go before the encoder's last frames.
    audio = null;
    return await finish(worker, input.use);
  } finally {
    audio = null;
    worker.close();
  }
}

/** The encoder's MP3, walked as the server will walk it, and its length checked against the use with the allowance. */
async function finish(worker: EncodeWorker, use: SoundUse): Promise<Prepared> {
  const done = await worker.end();
  if (!done.mp3) throw new Error("the encoder made no file");
  const walk = walkMp3(new Uint8Array(await done.mp3.arrayBuffer()));
  if (!walk.ok) throw new Error(`the encoder's file failed the walk: ${walk.why}`);
  if (!soundUseFits(use, walk.facts.ms)) throw new Refused(lengthRefusal(use, walk.facts.ms, true) ?? { t: "tooLong" });
  return { blob: done.mp3, level: levelOf(done), ms: walk.facts.ms, copied: false };
}

/** A decoder that ran out of memory says so in a RangeError, or by name in its message. */
function isOutOfMemory(err: unknown): boolean {
  return err instanceof RangeError || (err instanceof Error && /memory/i.test(err.message));
}

/**
 * A length the header does not give, from a muted media element's
 * metadata on a `blob:` URL. The element reads the container, not the
 * audio, so this decodes nothing. Null when the browser cannot tell, or
 * says the length is infinite, as an unfinished recording does.
 */
function mediaLength(file: File, signal: AbortSignal): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    audio.muted = true;
    audio.preload = "metadata";
    const url = URL.createObjectURL(file);
    const timer = setTimeout(() => settle(null), METADATA_TIMEOUT_MS);
    const onAbort = () => {
      settle(null);
      reject(signal.reason);
    };
    function settle(ms: number | null) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      resolve(ms);
    }
    audio.addEventListener("loadedmetadata", () => settle(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : null), { once: true });
    audio.addEventListener("error", () => settle(null), { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    audio.src = url;
  });
}

// ---------------------------------------------------------------- the worker

/**
 * The encode worker for one file, with at most IN_FLIGHT pieces queued in
 * it. A cancel ends it at once, whatever it was doing, and a worker that
 * dies (a crash or its memory) fails the file with a plain error.
 */
class EncodeWorker {
  readonly #worker: Worker;
  readonly #signal: AbortSignal;
  #inFlight = 0;
  #waiters: (() => void)[] = [];
  #done: ((result: Extract<FromWorker, { t: "done" }>) => void) | null = null;
  #failure: Error | null = null;
  #fail: ((err: Error) => void)[] = [];

  constructor(signal: AbortSignal) {
    this.#signal = signal;
    this.#worker = new Worker(new URL("./encode.worker.ts", import.meta.url), { type: "module", name: "sound-encoder" });
    this.#worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const message = e.data;
      if (message.t === "took") {
        this.#inFlight--;
        this.#waiters.shift()?.();
      } else if (message.t === "done") this.#done?.(message);
      else this.#failed(new Error(message.message));
    };
    this.#worker.onerror = (e) => {
      e.preventDefault();
      this.#failed(new Error(e.message || "the encode worker stopped"));
    };
    signal.addEventListener("abort", this.close, { once: true });
  }

  #failed(err: Error): void {
    this.#failure ??= err;
    for (const fail of this.#fail.splice(0)) fail(this.#failure);
  }

  /** Waits until something happens: a slot frees, the worker finishes, fails, or the file is cancelled. */
  #until<T>(arm: (resolve: (value: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.#signal.aborted) return reject(this.#signal.reason);
      if (this.#failure) return reject(this.#failure);
      const onAbort = () => reject(this.#signal.reason);
      this.#signal.addEventListener("abort", onAbort, { once: true });
      this.#fail.push(reject);
      arm((value) => {
        this.#signal.removeEventListener("abort", onAbort);
        resolve(value);
      });
    });
  }

  start(message: Extract<ToWorker, { t: "start" }>): void {
    this.#worker.postMessage(message);
  }

  async send(message: Extract<ToWorker, { t: "pcm" | "wav" }>, transfer: ArrayBufferLike[]): Promise<void> {
    if (this.#inFlight >= IN_FLIGHT) await this.#until<void>((resolve) => this.#waiters.push(resolve));
    if (this.#failure) throw this.#failure;
    this.#inFlight++;
    this.#worker.postMessage(message, transfer as Transferable[]);
  }

  end(): Promise<Extract<FromWorker, { t: "done" }>> {
    const done = this.#until<Extract<FromWorker, { t: "done" }>>((resolve) => {
      this.#done = resolve;
    });
    this.#worker.postMessage({ t: "end" } satisfies ToWorker);
    return done;
  }

  readonly close = (): void => {
    this.#signal.removeEventListener("abort", this.close);
    this.#worker.terminate();
  };
}
