import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { VideoFacts } from "#shared/model.ts";
import { chance, int, pick, rng } from "#shared/testutil.ts";
import { ApiError, type AssetRow, type ProgressUploadOptions } from "../../lib/api.ts";
import { readFirstFrame, readStoredFrame, type FrameDeps, type ProbeCanvas, type ProbeVideo } from "./firstFrame.ts";
import { VideoHold, type UploadDeps } from "./upload.ts";

/*
 * An animated map's upload as one state machine (docs/design/design-v1-video-turns.md
 * 8 and 14): the probe on the picked file, the video's upload, the read of
 * the stored copy, the still, and the form's hold, run with the real probe
 * and steps over a fake browser and server whose every answer comes in a
 * random order, late, or never until a timeout. The DM cancels, picks a
 * still, taps Try again, picks another file or leaves at random.
 *
 * Invariants:
 * - A still never goes up before the video's answer, or twice in one run.
 * - Every run that ends but in success or a hold has deleted a video it made.
 *   A hold is deleted on cancel, on another file and on leaving.
 * - Every probe clears its `src` and lets go of its listeners and timer.
 * - Nothing starts after a cancel: no upload, no probe.
 * - Every run settles once the answers run out.
 */

type Pending = { label: string; run: () => void };

class World {
  queue: Pending[] = [];
  failures: string[] = [];
  r: () => number;
  constructor(r: () => number) {
    this.r = r;
  }
  later(label: string, run: () => void): void {
    this.queue.push({ label, run });
  }
  fail(why: string): void {
    this.failures.push(why);
  }
}

/** Lets promise reactions run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await null;
}

const FACTS: VideoFacts = { widthPx: 1920, heightPx: 1080, container: "mp4", video: "avc1.640028", fps: 30, durationMs: 4000, kbps: 3000 };
const GEOMETRIES = [{}, {}, { turn: 90 as const }, { turn: 180 as const, mirror: true as const }, { displayWidthPx: 2560 }];

class FakeProbe implements ProbeVideo {
  muted = false;
  playsInline = false;
  preload = "";
  currentTime = 3;
  videoWidth = 0;
  videoHeight = 0;
  duration = Number.NaN;
  removed = false;
  readonly style: Record<string, string> = {};
  readonly #world: World;
  readonly #listeners = new Map<string, Set<() => void>>();
  #src = "";
  #frame: (() => void) | null = null;
  constructor(world: World) {
    this.#world = world;
  }
  get src(): string {
    return this.#src;
  }
  set src(v: string) {
    this.#src = v;
  }
  listening(): number {
    let n = this.#frame ? 1 : 0;
    for (const set of this.#listeners.values()) n += set.size;
    return n;
  }
  #fire(type: string): void {
    for (const l of [...(this.#listeners.get(type) ?? [])]) l();
  }
  play(): Promise<void> {
    const r = this.#world.r;
    return new Promise((resolve, reject) => {
      const how = pick(r, ["plays", "plays", "plays", "plays", "lowPower", "unsupported", "never"] as const);
      if (how === "never") return;
      this.#world.later(`play ${how}`, () => {
        if (how === "plays") resolve();
        else reject(new DOMException("no", how === "lowPower" ? "NotAllowedError" : "NotSupportedError"));
      });
      // What the file shows once it loads, in any order with the play's answer.
      const big = chance(r, 0.15);
      const width = big ? 5120 : 1920;
      const height = big ? 2880 : 1080;
      const seconds = chance(r, 0.1) ? 700 : 4;
      if (chance(r, 0.9)) this.#world.later("metadata", () => this.#meta(width, height, seconds));
      if (chance(r, 0.15)) this.#world.later("error", () => this.#fire("error"));
      for (const type of ["seeked", "loadeddata", "frame"] as const) {
        if (!chance(r, 0.6)) continue;
        this.#world.later(type, () => {
          if (!this.#src) return;
          if (this.videoWidth === 0) this.#meta(width, height, seconds, false);
          if (type === "frame") {
            const cb = this.#frame;
            this.#frame = null;
            cb?.();
          } else this.#fire(type);
        });
      }
    });
  }
  #meta(width: number, height: number, seconds: number, fire = true): void {
    if (!this.#src) return;
    this.videoWidth = width;
    this.videoHeight = height;
    this.duration = seconds;
    if (fire) this.#fire("loadedmetadata");
  }
  pause(): void {}
  load(): void {}
  setAttribute(): void {}
  removeAttribute(name: string): void {
    if (name === "src") this.#src = "";
  }
  addEventListener(type: string, listener: () => void): void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }
  requestVideoFrameCallback = (cb: () => void): number => {
    this.#frame = cb;
    return 1;
  };
  cancelVideoFrameCallback = (): void => {
    this.#frame = null;
  };
  remove(): void {
    this.removed = true;
  }
}

class FakeCanvas implements ProbeCanvas {
  width = 0;
  height = 0;
  readonly #world: World;
  constructor(world: World) {
    this.#world = world;
  }
  getContext() {
    return { drawImage: () => {}, setTransform: () => {} };
  }
  toBlob(callback: (blob: Blob | null) => void, type?: string): void {
    this.#world.later("toBlob", () => callback(chance(this.#world.r, 0.05) ? null : new Blob([new Uint8Array(2)], { type: type ?? "image/png" })));
  }
}

/** What the sequences reached, so the run shows it tested every way an upload ends. */
const reached = { done: 0, askLowPower: 0, askStill: 0, askShape: 0, failed: 0, cancelled: 0, stored: 0, skipped: 0 };

type Run = { id: number; aborted: boolean; videoPut: "none" | "sent" | "answered"; stillPuts: number; made: string[]; settled: boolean };

async function sequence(seed: number): Promise<string[]> {
  const r = rng(seed);
  const world = new World(r);
  const probes: FakeProbe[] = [];
  const timers = new Set<{ cleared: boolean }>();
  /** Every video this form's uploads made, and what became of it. */
  const created = new Map<string, "live" | "removed" | "taken">();
  let nextId = 1;
  let current: Run | null = null;

  const runs = new Map<AbortSignal | undefined, Run>();
  /** A probe asked for by a run already cancelled. */
  const probeFor = (signal: AbortSignal | undefined, what: string) => {
    const run = runs.get(signal);
    if (!run) world.fail(`a ${what} for no run`);
    else if (run.aborted) world.fail(`run ${run.id}: a ${what} after the cancel`);
  };
  const frameDeps: FrameDeps = {
    makeVideo: () => {
      const v = new FakeProbe(world);
      probes.push(v);
      return v;
    },
    attach: () => {},
    makeCanvas: () => new FakeCanvas(world),
    url: () => "blob:x",
    revoke: () => {},
    setTimeout: (run) => {
      const t = { cleared: false };
      timers.add(t);
      world.later("timeout", () => {
        if (!t.cleared) run();
      });
      return t;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };

  const deps: UploadDeps = {
    readFrame: (file, o) => {
      probeFor(o.signal, "probe");
      return readFirstFrame(file, { ...o, deps: frameDeps }).then((frame) => {
        if (frame === null) reached.skipped++;
        return frame;
      });
    },
    readStored: (video, o) => {
      probeFor(o.signal, "read of the stored copy");
      reached.stored++;
      return readStoredFrame(`/api/assets/${video.assetId}/full`, video, { ...o, deps: frameDeps });
    },
    upload: (_room: string, kind: "video" | "map", _file: Blob, options: ProgressUploadOptions) => {
      const run = runs.get(options.signal)!;
      if (run.aborted) world.fail(`run ${run.id}: a ${kind} upload after the cancel`);
      if (kind === "map") {
        run.stillPuts++;
        if (run.stillPuts > 1) world.fail(`run ${run.id}: a second still`);
        if (run.videoPut === "sent") world.fail(`run ${run.id}: the still before the video's answer`);
      } else run.videoPut = "sent";
      return new Promise<AssetRow>((resolve, reject) => {
        const signal = options.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        world.later(`${kind} answer`, () => {
          if (signal?.aborted) return;
          if (chance(r, 0.15)) return reject(new ApiError(503, "busy", undefined, null));
          if (kind === "video") {
            run.videoPut = "answered";
            const id = `v${nextId++}`;
            const made = chance(r, 0.8);
            if (made) {
              created.set(id, "live");
              run.made.push(id);
            }
            return resolve({ id, kind: "video", width: 1920, height: 1080, variants: ["full"], created: made, video: { ...FACTS, ...pick(r, GEOMETRIES) } });
          }
          // A still the shape or not, as the server's facts judge it.
          const fits = chance(r, 0.8);
          resolve({ id: `s${nextId++}`, kind: "map", width: fits ? 1920 : 500, height: fits ? 1080 : 500, variants: ["full"], cellPx: 64 });
        });
      });
    },
    remove: async (_room, ids) => {
      for (const id of ids) {
        if (created.get(id) === "taken") world.fail(`${id} deleted after the map took it`);
        created.set(id, "removed");
      }
    },
  };

  const hold = new VideoHold(() => "r1", deps);
  /** What the form shows: nothing, a run in flight, or a still to ask for. */
  type FormState = { t: "idle" } | { t: "busy"; abort: AbortController; done: Promise<void> } | { t: "ask"; file: File; lowPower: boolean };
  let form = { t: "idle" } as FormState;
  let file = new File([new Uint8Array(4)], "map.mp4", { type: "video/mp4" });

  const start = (f: File, still?: File) => {
    const abort = new AbortController();
    const run: Run = { id: nextId++, aborted: false, videoPut: "none", stillPuts: 0, made: [], settled: false };
    current = run;
    runs.set(abort.signal, run);
    const done = hold.run({ roomId: "r1", file: f, host: null, signal: abort.signal, onStep: () => {}, deps, ...(still ? { still } : {}) }).then(
      (outcome) => {
        run.settled = true;
        if (run.aborted) {
          // A run that finished as the DM cancelled: the form lets go of it, as its catch does.
          if (outcome.t === "ask") world.fail(`run ${run.id}: a still asked for after the cancel`);
          hold.release();
          return;
        }
        if (outcome.t === "done") reached.done++;
        else if (outcome.lowPower) reached.askLowPower++;
        else if (outcome.problem) reached.askShape++;
        else reached.askStill++;
        if (outcome.t === "done") {
          // The form sends the op, and the map takes the video.
          const id = outcome.upload.asset.video.assetId;
          if (created.get(id) === "removed") world.fail(`run ${run.id}: the map took ${id}, already deleted`);
          if (created.has(id)) created.set(id, "taken");
          hold.taken();
          form = { t: "idle" };
        } else form = { t: "ask", file: f, lowPower: outcome.lowPower };
      },
      () => {
        run.settled = true;
        if (run.aborted) reached.cancelled++;
        else reached.failed++;
        // A failed run let go of what it made, and the form lets go of its hold.
        for (const id of run.made) if (created.get(id) === "live" && hold.held?.video.assetId !== id) world.fail(`run ${run.id}: ${id} left behind by a failed run`);
        if (!run.aborted) form = { t: "idle" };
      },
    );
    form = { t: "busy", abort, done };
  };

  const cancel = () => {
    if (form.t === "busy") {
      current!.aborted = true;
      form.abort.abort();
    }
    hold.release();
    form = { t: "idle" };
  };

  /** The form as the run's callbacks left it, which the type checker cannot follow into them. */
  const now = (): FormState => form;
  const steps = int(r, 10, 60);
  start(file);
  for (let i = 0; i < steps; i++) {
    const roll = r();
    if (roll < 0.75 && world.queue.length > 0) {
      const at = int(r, 0, world.queue.length - 1);
      const [event] = world.queue.splice(at, 1);
      event!.run();
      // Now and then the DM cancels in the same turn, before the answer's reactions run, so a cancel races what the answer settles.
      if (chance(r, 0.05)) cancel();
    } else if (roll < 0.82) cancel();
    else if (now().t === "ask") {
      const asked = now() as Extract<FormState, { t: "ask" }>;
      const how = r();
      if (how < 0.4) start(asked.file, new File([new Uint8Array(3)], "still.png", { type: "image/png" }));
      else if (how < 0.7) start(asked.file);
      else {
        file = new File([new Uint8Array(4)], `map${nextId}.webm`, { type: "video/webm" });
        start(file);
      }
    } else if (now().t === "idle") {
      file = new File([new Uint8Array(4)], `IMG_${nextId}.MOV`, { type: "video/quicktime" });
      start(file);
    }
    await flush();
  }
  // The DM leaves: the form cancels and lets go, and every answer still owed comes.
  cancel();
  for (let guard = 0; guard < 10_000; guard++) {
    await flush();
    if (world.queue.length === 0) {
      // Late reactions may queue more answers.
      for (let i = 0; i < 5; i++) await flush();
      if (world.queue.length === 0) break;
    }
    const [event] = world.queue.splice(int(r, 0, world.queue.length - 1), 1);
    event!.run();
  }
  await flush();
  const last = current as Run | null;
  if (last && !last.settled) world.fail(`run ${last.id} never settled`);
  for (const [id, state] of created) if (state === "live") world.fail(`${id} left behind after the form went`);
  for (const [i, p] of probes.entries()) {
    if (p.src !== "") world.fail(`probe ${i} kept its src`);
    if (!p.removed) world.fail(`probe ${i} stayed in the form`);
    if (p.listening() > 0) world.fail(`probe ${i} kept ${p.listening()} listeners`);
  }
  for (const t of timers) if (!t.cleared) world.fail("a probe's timer was left running");
  return world.failures;
}

test("2,000 random uploads keep the upload's invariants (docs/design/design-v1-video-turns.md 14)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
      assert.deepEqual(await sequence(seed), [], `seed ${seed}`);
    }),
    { numRuns: 2000 },
  );
  for (const [what, n] of Object.entries(reached)) assert.ok(n > 20, `${what} reached only ${n} times: ${JSON.stringify(reached)}`);
});
