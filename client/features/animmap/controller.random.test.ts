import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fc from "fast-check";
import type { MapVideo } from "#shared/model.ts";
import { chance, int, pick, rng } from "#shared/testutil.ts";
import { AnimMapBoard, IDLE_INPUT, pageSteppedDown, resetPageStepDownForTests, type BoardEnv, type BoardInput, type LayerLike, type VideoLike } from "./board.ts";
import { MIN_GAP_MS } from "./pacing.ts";
import type { Decodable } from "./playback.ts";
import { leaseDecoder, resetDecoderForTests, type DecoderLease } from "./status.ts";
import { Compositor, HEALTHY, mostInWindow, renderTimes, type Content, type Display, type Struggle } from "./videoSim.testutil.ts";

/*
 * The board as one state machine (docs/design/design-v1-animated-maps.md
 * 5.2 to 5.4 and 12): random sequences of frames at mixed frame and refresh
 * rates, camera draws, Animated maps, Low power and reduced motion flips,
 * page hides, Isometric and setup tools, panels, View as a player's cover
 * and its own board, the Library viewer, scene and phase switches, `play()`
 * refusals and taps, resizes, media errors, remounts and struggling
 * decoders. A fake element, layer and clock stand in for the browser, and
 * a fake map layer commits what the board hands it a microtask later, as
 * React's commit does.
 *
 * Invariants, checked as each thing happens:
 * - No video draw while the element is paused, holds no source or is not
 *   what Konva draws. No two video draws closer than MIN_GAP_MS: in media
 *   time with frame callbacks, in wall time in the fallback, outside a wrap
 *   or a new source. At most 32 video draws in any second, camera draws
 *   counted apart.
 * - Of the DM's board, the preview's board and the Library viewer, at most
 *   one holds a source at a time, and Konva never draws an element whose
 *   source was cleared.
 * - The step-down only goes down.
 * - Liveness: while the board plays and shows, a new frame gets a draw
 *   within 100 ms, its own or the camera's.
 */

const VIDEO_A: MapVideo = { assetId: "va", widthPx: 1280, heightPx: 720, container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 2000, kbps: 3000 };
const VIDEO_B: MapVideo = { ...VIDEO_A, assetId: "vb", container: "mp4", video: "avc1.640028", fps: 60 };
const VIDEO_UHD: MapVideo = { ...VIDEO_A, assetId: "vu", widthPx: 3840, heightPx: 2160 };
const VIDEOS = [VIDEO_A, VIDEO_B, VIDEO_UHD] as const;

const CONTENTS: readonly Content[] = [[{ fps: 24, ms: 2000 }], [{ fps: 30, ms: 2000 }], [{ fps: 31, ms: 3000 }], [{ fps: 59.94, ms: 2000 }], [{ fps: 60, ms: 2000 }]];
const DISPLAYS: readonly Display[] = [{ hz: 60 }, { hz: 59.95 }, { hz: 60.05 }, { hz: 90 }, { hz: 120 }, { hz: 144 }, { hz: 60, capped: true }];

type Timer = { at: number; run: () => void; id: number };

/** The page's clock, timers, animation frames and the queue of element events, run by hand. */
class World {
  now = 0;
  #next = 1;
  timers: Timer[] = [];
  frames = new Map<number, (now: number) => void>();
  events: (() => void)[] = [];
  failures: string[] = [];
  rejectPlay = false;
  failLoads = false;
  realSize: { w: number; h: number } | null = null;

  later(run: () => void, ms: number): number {
    const id = this.#next++;
    this.timers.push({ at: this.now + ms, run, id });
    return id;
  }
  cancelLater(id: number): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }
  frame(run: (now: number) => void): number {
    const id = this.#next++;
    this.frames.set(id, run);
    return id;
  }
  cancelFrame(id: number): void {
    this.frames.delete(id);
  }
  fail(why: string): void {
    this.failures.push(`${why} at ${this.now.toFixed(1)} ms`);
  }
}

/** Lets every promise reaction and queued element event run. */
async function settle(world: World): Promise<void> {
  for (let i = 0; i < 50; i++) {
    // Promise reactions take a few microtask turns: an async answer, then its `then`.
    for (let turn = 0; turn < 8; turn++) await null;
    if (world.events.length === 0) return;
    while (world.events.length > 0) world.events.shift()!();
  }
}

class FakeVideo implements VideoLike {
  muted = false;
  defaultMuted = false;
  playsInline = false;
  loop = false;
  preload = "";
  paused = true;
  videoWidth = 0;
  videoHeight = 0;
  error: { code: number } | null = null;
  readonly attrs = new Map<string, string>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #world: World;
  readonly #content: Content;
  readonly #display: Display;
  readonly #r: () => number;
  #struggle: Struggle = HEALTHY;
  /** No struggle since this source started: a struggling device misses callbacks, so liveness holds only here. */
  healthy = true;
  get struggle(): Struggle {
    return this.#struggle;
  }
  set struggle(next: Struggle) {
    this.#struggle = next;
    if (next !== HEALTHY) this.healthy = false;
    if (this.compositor) this.compositor.struggle = next;
  }
  #loaded = false;
  #generation = 0;
  compositor: Compositor | null = null;
  #pausedMedia = 0;
  callbacks = new Map<number, (now: number, m: { mediaTime: number; presentedFrames: number }) => void>();
  #nextCallback = 1;
  readonly withCallbacks: boolean;
  /** The media time of the frame last given to a callback, and whether a wrap or a new source came since the frame before. */
  lastMediaMs: number | null = null;
  jumped = true;

  constructor(world: World, content: Content, display: Display, r: () => number, withCallbacks: boolean) {
    this.#world = world;
    this.#content = content;
    this.#display = display;
    this.#r = r;
    this.withCallbacks = withCallbacks;
    if (!withCallbacks) {
      (this as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback = undefined;
      (this as { cancelVideoFrameCallback?: unknown }).cancelVideoFrameCallback = undefined;
    }
  }

  get currentTime(): number {
    if (!this.compositor) return (this.#pausedMedia % 2000) / 1000;
    return this.compositor.mediaAt(this.#world.now) / 1000;
  }

  hasSrc(): boolean {
    return this.attrs.has("src");
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  addEventListener(type: string, listener: () => void): void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const l of [...(this.#listeners.get(type) ?? [])]) l();
  }
  #queue(type: string): void {
    const generation = this.#generation;
    this.#world.events.push(() => {
      if (generation === this.#generation) this.fire(type);
    });
  }

  load(): void {
    log(this.#world.now.toFixed(1), "load() src", this.attrs.get("src"));
    this.#generation++;
    this.#loaded = false;
    this.paused = true;
    this.compositor = null;
    this.#pausedMedia = 0;
    this.error = null;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.callbacks.clear();
    this.jumped = true;
    if (!this.hasSrc()) return;
    const generation = this.#generation;
    this.#world.later(
      () => {
        if (generation !== this.#generation) return;
        if (this.#world.failLoads) {
          this.error = { code: 2 };
          this.fire("error");
          return;
        }
        this.#loaded = true;
        this.videoWidth = this.#world.realSize?.w ?? 1280;
        this.videoHeight = this.#world.realSize?.h ?? 720;
        this.fire("loadedmetadata");
        this.fire("loadeddata");
        if (!this.paused) this.#start();
      },
      int(this.#r, 20, 400),
    );
  }

  #start(): void {
    if (!this.compositor) {
      this.compositor = new Compositor(this.#content, this.#display, this.#r, this.#struggle, this.#world.now);
      this.healthy = this.#struggle === HEALTHY;
    }
    this.compositor.resumeAt(this.#world.now, this.#pausedMedia);
    this.#queue("playing");
  }

  play(): Promise<void> {
    log(this.#world.now.toFixed(1), "play() paused", this.paused, "loaded", this.#loaded);
    if (this.#world.rejectPlay) {
      const err = new Error("play() needs a tap");
      err.name = "NotAllowedError";
      return Promise.reject(err);
    }
    if (!this.hasSrc()) return Promise.reject(Object.assign(new Error("no source"), { name: "NotSupportedError" }));
    if (!this.paused) return Promise.resolve();
    this.paused = false;
    if (this.#loaded) this.#start();
    return Promise.resolve();
  }

  pause(): void {
    log(this.#world.now.toFixed(1), "pause() paused", this.paused);
    if (this.paused) return;
    this.paused = true;
    if (this.compositor) this.#pausedMedia = this.compositor.playedAt(this.#world.now);
    this.#queue("pause");
  }

  requestVideoFrameCallback(callback: (now: number, m: { mediaTime: number; presentedFrames: number }) => void): number {
    const id = this.#nextCallback++;
    this.callbacks.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(id: number): void {
    this.callbacks.delete(id);
  }
  getVideoPlaybackQuality(): { totalVideoFrames: number; droppedVideoFrames: number } {
    return { totalVideoFrames: this.compositor?.totalFrames ?? 0, droppedVideoFrames: this.compositor?.droppedFrames ?? 0 };
  }

  /** A rendering frame: the frame shown, to its callbacks. Returns whether a new frame showed. */
  render(now: number): boolean {
    if (this.paused || !this.#loaded || !this.compositor) return false;
    const cb = this.compositor.render(now);
    if (!cb) {
      log(now.toFixed(1), "no new frame, media", this.compositor.mediaAt(now).toFixed(1));
      return false;
    }
    if (cb.wrapped) this.jumped = true;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    this.lastMediaMs = cb.mediaMs;
    for (const run of callbacks) run(now, { mediaTime: cb.mediaMs / 1000, presentedFrames: cb.presentedFrames });
    return true;
  }
}

/** A board with its element, layer and fake map layer, as one Room's Stage gives it. */
class Rig {
  readonly board: AnimMapBoard;
  readonly world: World;
  readonly label: string;
  video: FakeVideo | null = null;
  /** What the fake map layer's last commit drew: the element, or null for the still. */
  konvaHeld: VideoLike | null = null;
  cameraPending = false;
  #cameraDrawing = false;
  #layerListeners = new Set<() => void>();
  layer: LayerLike;
  /** Video draws: wall time, media time where known, and whether a wrap or new source came before it. */
  draws: { now: number; media: number | null; jumped: boolean }[] = [];
  lastDrawAt = -Infinity;
  /** The earliest shown frame no draw has shown yet. */
  waitingSince: number | null = null;
  #commitQueued = false;

  constructor(world: World, label: string, makeVideo: () => FakeVideo, decodable: Decodable) {
    this.world = world;
    this.label = label;
    const env: BoardEnv = {
      now: () => world.now,
      frame: (run) => world.frame(run),
      cancelFrame: (id) => world.cancelFrame(id),
      later: (run, ms) => world.later(run, ms),
      cancelLater: (id) => world.cancelLater(id),
      createVideo: () => {
        if (this.video) world.fail(`${label} made a second element`);
        this.video = makeVideo();
        return this.video;
      },
      decodable: async () => decodable,
      lease: leaseDecoder,
    };
    this.board = new AnimMapBoard(env);
    this.layer = this.#makeLayer();
    this.board.attachLayer(this.layer);
    this.board.subscribe(() => this.#queueCommit());
  }

  #makeLayer(): LayerLike {
    const listeners = new Set<() => void>();
    this.#layerListeners = listeners;
    return {
      draw: () => {
        const held = this.konvaHeld as FakeVideo | null;
        if (held && !held.hasSrc()) this.world.fail(`${this.label}: Konva drew an element with no source`);
        if (!this.#cameraDrawing) this.#videoDraw(held);
        this.lastDrawAt = this.world.now;
        this.waitingSince = null;
        for (const l of [...listeners]) l();
      },
      waitingForDraw: () => this.cameraPending,
      onDraw(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  #videoDraw(held: FakeVideo | null): void {
    const el = this.video;
    if (!el || held !== el) return this.world.fail(`${this.label}: a video draw while Konva draws the still`);
    if (el.paused || !el.hasSrc()) return this.world.fail(`${this.label}: a video draw while not playing`);
    const media = el.withCallbacks && el.callbacks !== undefined && !this.#inFallback() ? el.lastMediaMs : null;
    this.draws.push({ now: this.world.now, media, jumped: el.jumped });
    log(this.world.now.toFixed(1), this.label, "draw media", media?.toFixed(1), "jumped", el.jumped);
    el.jumped = false;
  }

  #inFallback(): boolean {
    // In the fallback the board draws from an animation frame, with no callback in hand.
    return this.#ticking;
  }
  #ticking = false;

  /** React's commit, a microtask after the board's store changed: the map layer draws what the board hands it. */
  #queueCommit(): void {
    if (this.#commitQueued) return;
    this.#commitQueued = true;
    queueMicrotask(() => {
      this.#commitQueued = false;
      const next = this.board.shown.element;
      if (next !== this.konvaHeld) {
        this.konvaHeld = next;
        this.board.konvaHolds(next);
      }
    });
  }

  remount(): void {
    this.board.attachLayer(null);
    this.layer = this.#makeLayer();
    this.board.attachLayer(this.layer);
  }

  /** A rendering frame: the element's callbacks, then the animation frames, the camera's draw among them. */
  render(now: number): void {
    const shown = this.video?.render(now) ?? false;
    if (shown && this.waitingSince === null && this.lastDrawAt < now) this.waitingSince = now;
    if (shown) log(now.toFixed(1), this.label, "shown", this.video?.lastMediaMs?.toFixed(1));
    // Liveness: while the board plays and shows, a shown frame is drawn within 100 ms.
    const live = this.board.state === "playing" && this.video !== null && this.video.healthy && !this.video.paused && this.konvaHeld === this.video;
    if (!live) this.waitingSince = null;
    else if (this.waitingSince !== null && now - this.waitingSince > 100 + 1e-6) this.world.fail(`${this.label}: a shown frame waited ${(now - this.waitingSince).toFixed(1)} ms for a draw`);
  }

  cameraDraw(): void {
    if (!this.cameraPending) return;
    this.cameraPending = false;
    this.#cameraDrawing = true;
    try {
      this.layer.draw();
    } finally {
      this.#cameraDrawing = false;
    }
  }

  set ticking(on: boolean) {
    this.#ticking = on;
  }
}

/** Runs an animation frame's callback, whichever board asked for it, with each rig knowing a draw then is the fallback's. */
function ticking(rigs: readonly Rig[], run: () => void): void {
  for (const rig of rigs) rig.ticking = true;
  try {
    run();
  } finally {
    for (const rig of rigs) rig.ticking = false;
  }
}

/** The Library viewer: a second user of the decoder, holding a source while granted. */
class Viewer {
  lease: DecoderLease | null = null;
  holdsSrc = false;
  open(): void {
    if (this.lease) return;
    this.lease = leaseDecoder("viewer", {
      onGrant: () => (this.holdsSrc = true),
      onYield: (lease) => {
        this.holdsSrc = false;
        lease.release();
        this.lease = null;
      },
    });
  }
  close(): void {
    this.holdsSrc = false;
    this.lease?.release();
    this.lease = null;
  }
}

afterEach(() => {
  resetDecoderForTests();
  resetPageStepDownForTests();
});

/** What the sequences reached, so the run shows it tested the board playing and every way it stops. */
const reached = { sequences: 0, drew: 0, fallbackDrew: 0, cameraDraws: 0, states: new Set<string>() };

async function sequence(seed: number): Promise<string[]> {
  resetDecoderForTests();
  resetPageStepDownForTests();
  const r = rng(seed);
  const world = new World();
  const content = pick(r, CONTENTS);
  const display = pick(r, DISPLAYS);
  const withCallbacks = !chance(r, 0.2);
  const decodable = pick(r, ["smooth", "smooth", "smooth", "notSmooth"] as const);
  const make = () => new FakeVideo(world, content, display, r, withCallbacks);
  const dm = new Rig(world, "dm", make, decodable);
  log("content", JSON.stringify(content), "display", JSON.stringify(display), "callbacks", withCallbacks, decodable);
  dm.board.onState = (state) => {
    reached.states.add(state);
    log(world.now.toFixed(1), "dm state", state);
  };
  let preview: Rig | null = null;
  const viewer = new Viewer();
  let input: BoardInput = { ...IDLE_INPUT, server: true, video: VIDEO_A, url: "/a" };
  dm.board.input(input);
  let stepped: string | null = null;
  const rigs = () => [dm, ...(preview ? [preview] : [])];

  const check = () => {
    const holders = [dm.video?.hasSrc() ? "dm" : null, preview?.video?.hasSrc() ? "preview" : null, viewer.holdsSrc ? "viewer" : null].filter(Boolean);
    if (holders.length > 1) world.fail(`two sources at once: ${holders.join(" and ")}`);
    const now = pageSteppedDown();
    if (stepped && now !== stepped) world.fail("the step-down went back");
    stepped = now;
  };

  const advance = async (ms: number) => {
    const until = world.now + ms;
    for (const at of renderTimes(display, world.now + 1e-6, until)) {
      // Timers due before this frame, in time order.
      for (;;) {
        world.timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const due = world.timers[0];
        if (!due || due.at > at) break;
        world.timers.shift();
        world.now = Math.max(world.now, due.at);
        due.run();
        await settle(world);
        check();
      }
      world.now = at;
      for (const rig of rigs()) rig.render(at);
      const frames = [...world.frames.entries()];
      world.frames.clear();
      for (const [, run] of frames) ticking(rigs(), () => run(at));
      for (const rig of rigs()) rig.cameraDraw();
      await settle(world);
      check();
    }
    world.now = until;
  };

  const steps = int(r, 15, 40);
  for (let i = 0; i < steps; i++) {
    const roll = r();
    const before = input;
    // Mostly short, and now and then past the step-down's warm-up and window, or a failed load's retry.
    if (roll < 0.3) await advance(chance(r, 0.05) ? int(r, 3000, 8000) : int(r, 16, 700));
    else if (roll < 0.36) for (const rig of rigs()) rig.cameraPending = true;
    else if (roll < 0.4) input = { ...input, setting: input.setting === "moving" ? "still" : "moving" };
    else if (roll < 0.43) input = { ...input, lowPower: !input.lowPower };
    else if (roll < 0.46) input = { ...input, reducedMotion: !input.reducedMotion };
    else if (roll < 0.49) input = { ...input, variant: input.variant === "full" ? "mobile" : "full" };
    else if (roll < 0.53) input = { ...input, pageVisible: !input.pageVisible };
    else if (roll < 0.57) input = { ...input, iso: !input.iso };
    else if (roll < 0.6) input = { ...input, setupTool: !input.setupTool };
    else if (roll < 0.63) input = { ...input, panelCovered: !input.panelCovered };
    else if (roll < 0.66) input = { ...input, loading: !input.loading };
    else if (roll < 0.72) {
      const next = pick(r, [...VIDEOS, null]);
      input = { ...input, video: next, url: next ? `/${next.assetId}` : null };
    } else if (roll < 0.77) {
      // View as a player: the preview's board mounts over the room, or goes.
      if (!preview) {
        const p = new Rig(world, "preview", make, decodable);
        p.board.onState = (state) => {
          reached.states.add(`preview ${state}`);
          log(world.now.toFixed(1), "preview state", state);
        };
        preview = p;
        const cover = () => (input = { ...input, preview: true });
        if (chance(r, 0.5)) {
          cover();
          dm.board.input(input);
          p.board.input({ ...input, preview: false });
        } else {
          p.board.input({ ...input, preview: false });
          cover();
        }
      } else {
        preview.board.dispose();
        preview = null;
        input = { ...input, preview: false };
      }
    } else if (roll < 0.82) {
      if (viewer.lease) viewer.close();
      else viewer.open();
    } else if (roll < 0.85) world.rejectPlay = !world.rejectPlay;
    else if (roll < 0.88) for (const rig of rigs()) rig.board.tapped();
    else if (roll < 0.9) {
      world.realSize = chance(r, 0.5) ? { w: 2560, h: 1440 } : null;
      for (const rig of rigs()) {
        if (!rig.video?.hasSrc()) continue;
        rig.video.videoWidth = world.realSize?.w ?? 1280;
        rig.video.videoHeight = world.realSize?.h ?? 720;
        rig.video.fire("resize");
      }
    } else if (roll < 0.93) {
      world.failLoads = !world.failLoads;
      for (const rig of rigs()) {
        if (!rig.video?.hasSrc() || !world.failLoads) continue;
        rig.video.error = { code: 2 };
        rig.video.fire("error");
      }
    } else if (roll < 0.96) {
      for (const rig of rigs()) if (rig.video) rig.video.struggle = chance(r, 0.5) ? { dropShare: 0.5, blockChance: 0.2 } : HEALTHY;
    } else if (roll < 0.98) for (const rig of rigs()) rig.remount();
    else input = { ...input, server: !input.server };
    log(world.now.toFixed(1), "step", roll.toFixed(3), "dm", dm.board.state, "preview", preview?.board.state ?? "-", "viewer", viewer.holdsSrc);
    if (input !== before) {
      dm.board.input(input);
      preview?.board.input({ ...input, preview: false });
    }
    await settle(world);
    check();
  }
  // Whatever stood, a long run settles: the invariants over the draws, and nothing left holding two sources.
  await advance(1500);
  for (const rig of rigs()) {
    let lastMedia: number | null = null;
    let lastWall: number | null = null;
    for (const d of rig.draws) {
      if (d.media !== null && lastMedia !== null && !d.jumped && d.media - lastMedia < MIN_GAP_MS - 1e-6) world.fail(`${rig.label}: two drawn frames ${(d.media - lastMedia).toFixed(2)} ms apart in media time`);
      if (d.media === null && lastWall !== null && lastMedia === null && !d.jumped && d.now - lastWall < MIN_GAP_MS - 1e-6) world.fail(`${rig.label}: two fallback draws ${(d.now - lastWall).toFixed(2)} ms apart`);
      lastMedia = d.media;
      lastWall = d.now;
    }
    const most = mostInWindow(rig.draws.map((d) => d.now));
    if (most > 32) world.fail(`${rig.label}: ${most} video draws in a second`);
  }
  reached.sequences++;
  if (dm.draws.length > 0) reached.drew++;
  if (dm.draws.some((d) => d.media === null)) reached.fallbackDrew++;
  reached.cameraDraws += dm.board.cameraDraws;
  return world.failures;
}

// ANIMMAP_SEED=<n> runs one sequence and prints what it did, to look into a failure.
const ONE = process.env.ANIMMAP_SEED;
const log = (...args: unknown[]) => {
  if (ONE) console.log(...args);
};

test("one sequence, when asked for", { skip: !ONE }, async () => {
  assert.deepEqual(await sequence(Number(ONE)), []);
});

test("2,000 random sequences keep the board's invariants", { skip: Boolean(ONE) }, async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
      const failures = await sequence(seed);
      assert.deepEqual(failures, [], `seed ${seed}`);
    }),
    { numRuns: 2000 },
  );
  // The sequences reached the board playing, its fallback, and each way it stops.
  assert.ok(reached.drew > reached.sequences * 0.2, `${reached.drew} of ${reached.sequences} drew`);
  assert.ok(reached.fallbackDrew > 0 && reached.cameraDraws > 0);
  for (const state of ["playing", "paused", "loading", "waiting", "covered", "still setting", "still low-power", "still still-view", "still not-started", "still load-failed", "still not-smooth", "preview playing"])
    assert.ok(reached.states.has(state), `no sequence reached ${state}: ${[...reached.states].join(", ")}`);
});

/** One board on a display, with its element, run by hand. */
function single(content: Content, display: Display, video: MapVideo) {
  resetDecoderForTests();
  resetPageStepDownForTests();
  const world = new World();
  const r = rng(9);
  const dm = new Rig(world, "dm", () => new FakeVideo(world, content, display, r, true), "smooth");
  dm.board.input({ ...IDLE_INPUT, server: true, video, url: `/${video.assetId}` });
  const run = async (ms: number) => {
    const until = world.now + ms;
    for (const at of renderTimes(display, world.now + 1e-6, until)) {
      for (;;) {
        world.timers.sort((a, b) => a.at - b.at);
        const due = world.timers[0];
        if (!due || due.at > at) break;
        world.timers.shift();
        world.now = due.at;
        due.run();
        await settle(world);
      }
      world.now = at;
      dm.render(at);
      const frames = [...world.frames.values()];
      world.frames.clear();
      for (const f of frames) ticking([dm], () => f(at));
      dm.cameraDraw();
      await settle(world);
    }
  };
  return { world, dm, run };
}

test("a board that falls behind steps down to the still for the page, frees its source, and a new board starts still", async () => {
  const { world, dm, run } = single([{ fps: 30, ms: 2000 }], { hz: 60 }, VIDEO_A);
  await settle(world);
  await run(1000);
  assert.equal(dm.board.state, "playing");
  dm.video!.struggle = { dropShare: 0.5, blockChance: 0.3 };
  await run(25_000);
  assert.equal(dm.board.state, "still slowing");
  assert.equal(dm.video!.hasSrc(), false, "the step-down frees the decoder");
  assert.equal(pageSteppedDown(), "slowing");
  dm.video!.struggle = HEALTHY;
  dm.board.input({ video: VIDEO_B, url: "/vb" });
  await settle(world);
  await run(2000);
  assert.equal(dm.board.state, "still slowing", "another video stays still too, until the page reloads");
  assert.deepEqual(world.failures, []);
});

test("a healthy board on Moving plays, draws about 30 a second, and pauses when hidden", async () => {
  const { world, dm, run } = single([{ fps: 60, ms: 2000 }], { hz: 60 }, VIDEO_B);
  await settle(world);
  await run(1000);
  assert.equal(dm.board.state, "playing");
  const before = dm.board.videoDraws;
  await run(2000);
  const rate = (dm.board.videoDraws - before) / 2;
  assert.ok(rate >= 29 && rate <= 31, `${rate} draws a second`);
  dm.board.input({ pageVisible: false });
  await settle(world);
  const hidden = dm.board.videoDraws;
  await run(1000);
  assert.equal(dm.board.videoDraws, hidden, "no draws while hidden");
  assert.equal(dm.video!.paused, true);
  assert.equal(dm.video!.hasSrc(), true, "a pause keeps the source");
  dm.board.input({ pageVisible: true });
  await settle(world);
  await run(100);
  assert.ok(dm.board.videoDraws > hidden, "it plays again at once");
  assert.deepEqual(world.failures, []);
});
