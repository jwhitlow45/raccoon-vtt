import type { AssetRow, ProgressUploadOptions } from "../../../lib/api.ts";
import { ApiError } from "../../../lib/api.ts";
import type { CreateAnswer, QueueDeps, SoundCreate } from "./job.ts";
import type { ReadOutcome, ReadStep } from "./read.ts";

/**
 * A queue's world in tests: every read, upload and `sound.create` waits
 * until the test settles it, so a test or a random sequence can cancel,
 * refuse and finish in any order, and the invariants the queue promises
 * are checked as it goes.
 */

type Pending<T> = { resolve(value: T): void; reject(err: unknown): void };

export type ReadCall = { file: File; signal: AbortSignal; onStep(step: ReadStep): void; settled: boolean } & Pending<ReadOutcome>;
export type UploadCall = { blob: Blob; options: ProgressUploadOptions & { signal: AbortSignal }; settled: boolean } & Pending<AssetRow>;
export type CreateCall = { op: SoundCreate; settled: boolean } & Pending<CreateAnswer>;

export class FakeWorld {
  readonly reads: ReadCall[] = [];
  readonly uploads: UploadCall[] = [];
  readonly creates: CreateCall[] = [];
  readonly held = new Set<string>();
  readonly timers: { run(): void; ms: number; cleared: boolean }[] = [];
  readonly added: string[] = [];
  storageChanges = 0;
  #ids = 0;
  /** The most reads ever in flight at once, a settled cancelled one included until it settles. */
  maxReads = 0;

  readsInFlight(): number {
    return this.reads.filter((r) => !r.settled).length;
  }

  deps(): QueueDeps {
    return {
      prepare: (input) =>
        new Promise<ReadOutcome>((resolve, reject) => {
          const call: ReadCall = { ...input, settled: false, resolve: (v) => ((call.settled = true), resolve(v)), reject: (e) => ((call.settled = true), reject(e)) };
          this.reads.push(call);
          this.maxReads = Math.max(this.maxReads, this.readsInFlight());
        }),
      upload: (blob, options) =>
        new Promise<AssetRow>((resolve, reject) => {
          const call: UploadCall = { blob, options, settled: false, resolve: (v) => ((call.settled = true), resolve(v)), reject: (e) => ((call.settled = true), reject(e)) };
          this.uploads.push(call);
          options.signal.addEventListener("abort", () => call.reject(options.signal.reason), { once: true });
        }),
      create: (op) =>
        new Promise<CreateAnswer>((resolve, reject) => {
          const call: CreateCall = { op, settled: false, resolve: (v) => ((call.settled = true), resolve(v)), reject: (e) => ((call.settled = true), reject(e)) };
          this.creates.push(call);
        }),
      holds: (id) => this.held.has(id),
      newId: () => `id${++this.#ids}`,
      setTimer: (run, ms) => {
        const timer = { run, ms, cleared: false };
        this.timers.push(timer);
        return () => {
          timer.cleared = true;
        };
      },
      onAdded: (id) => this.added.push(id),
      onStorageChanged: () => {
        this.storageChanges++;
      },
    };
  }
}

export function fakeFile(name: string): File {
  return new File([new Uint8Array(4)], name);
}

export function prepared(level = 25): ReadOutcome {
  return { ok: true, prepared: { blob: new Blob([new Uint8Array(8)], { type: "audio/mpeg" }), level, ms: 31_000, copied: false } };
}

export function assetRow(id: string): AssetRow {
  return { id, kind: "sound", width: 0, height: 0, variants: ["full"], audio: { ms: 31_020, channels: 2, kbps: 128 } } as unknown as AssetRow;
}

export const OUT_OF_SPACE = new ApiError(507, "full", "quota_exceeded", null);

/** Lets every settled promise's handlers run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
