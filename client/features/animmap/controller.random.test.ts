import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fc from "fast-check";
import type { MapVideo } from "#shared/model.ts";
import { chance, int, pick, rng } from "#shared/testutil.ts";
import { AnimMapBoard, CALLBACK_WAIT_MS, connectBoard, IDLE_INPUT, pageSteppedDown, resetPageStepDownForTests, stepDownListenersForTests, type BoardEnv, type BoardInput, type FrameMetadata, type LayerLike, type VideoLike } from "./board.ts";
import { MIN_GAP_MS } from "./pacing.ts";
import { sizeProblem, type Decodable } from "./playback.ts";
import { boardVideoStatus, decoderLeases, leaseDecoder, resetDecoderForTests, type DecoderLease } from "./status.ts";
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
/** A 4:3 file: coded 1920 x 1080, drawn 2560 x 1080 (docs/design/design-v1-video-turns.md 6.3). */
const VIDEO_WIDE: MapVideo = { ...VIDEO_A, assetId: "vw", container: "mp4", video: "avc1.640028", widthPx: 1920, heightPx: 1080, displayWidthPx: 2560 };
/** An Android portrait video: coded 1920 x 1080, turned 90. */
const VIDEO_TURNED: MapVideo = { ...VIDEO_WIDE, assetId: "vt", displayWidthPx: undefined, turn: 90 };
const VIDEOS = [VIDEO_A, VIDEO_B, VIDEO_UHD, VIDEO_WIDE, VIDEO_TURNED] as const;

type Size = { w: number; h: number };

/**
 * What an element reports for a video's source and what its frames really
 * are: the board's fixtures report what they decode, and the 4:3 file
 * reports its coded size, its stretched size or Gecko's rounding of it,
 * and now and then really decodes at the stretch, as a WebM that declares
 * one may (D-261102-897).
 */
function sizesFor(video: MapVideo | undefined, r: () => number): { reported: Size; frame: Size } {
  if (!video || (video.displayWidthPx === undefined && video.turn === undefined)) return { reported: { w: 1280, h: 720 }, frame: { w: 1280, h: 720 } };
  const coded = { w: video.widthPx, h: video.heightPx };
  if (video.displayWidthPx === undefined) return { reported: coded, frame: coded };
  const stretched = { w: video.displayWidthPx, h: video.heightPx };
  const reported = pick(r, [coded, stretched, { w: video.displayWidthPx - 1, h: video.heightPx }]);
  return { reported, frame: chance(r, 0.3) ? stretched : coded };
}

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
  /** A real size change mid-stream, as VP9 may have: both what the element reports and its frames. */
  realSize: { w: number; h: number } | null = null;
  /** What each source's element reports and decodes, by its address. */
  sizes: (url: string | undefined) => { reported: Size; frame: Size } = () => ({ reported: { w: 1280, h: 720 }, frame: { w: 1280, h: 720 } });
  /** Commits React holds until the frame's draws are done: a commit late enough for Konva to draw before it. */
  lateCommits: (() => void)[] = [];
  /** The share of commits that land after the next frame's draws. */
  lateShare = 0;
  r: () => number = () => 1;

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
  callbacks = new Map<number, (now: number, m: FrameMetadata) => void>();
  #nextCallback = 1;
  readonly withCallbacks: boolean;
  /** The frame callback's metadata gives the frame's size, as the spec says, or leaves it out, as an older engine may. */
  frameSizes = true;
  /** The method is there but never calls back, as on a browser that runs none for this element. */
  silent = false;
  /** What this source's frames decode at. */
  frameSize: Size = { w: 1280, h: 720 };
  /** The size the last frame callback gave the board, or null before one did. */
  lastFrameGiven: Size | null = null;
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

  /** Sources this element took, for a test that counts them. */
  sources = 0;

  load(): void {
    log(this.#world.now.toFixed(1), "load() src", this.attrs.get("src"));
    if (this.hasSrc()) this.sources++;
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
    this.lastFrameGiven = null;
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
        const sizes = this.#world.sizes(this.attrs.get("src"));
        this.frameSize = this.#world.realSize ?? sizes.frame;
        this.videoWidth = this.#world.realSize?.w ?? sizes.reported.w;
        this.videoHeight = this.#world.realSize?.h ?? sizes.reported.h;
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

  requestVideoFrameCallback(callback: (now: number, m: FrameMetadata) => void): number {
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
    if (this.silent) return true;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    this.lastMediaMs = cb.mediaMs;
    const size = this.frameSizes ? { width: this.frameSize.w, height: this.frameSize.h } : {};
    if (callbacks.length > 0 && this.frameSizes) this.lastFrameGiven = this.frameSize;
    for (const run of callbacks) run(now, { mediaTime: cb.mediaMs / 1000, presentedFrames: cb.presentedFrames, ...size });
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
  /** What the board is told now, for the size invariant. */
  told: () => { video: MapVideo | null; variant: "full" | "mobile" } = () => ({ video: null, variant: "full" });

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
    if (this.cameraPending) this.world.fail(`${this.label}: a video draw in a frame the camera's draw already shows`);
    if (el.paused || !el.hasSrc()) return this.world.fail(`${this.label}: a video draw while not playing`);
    // A frame whose own size breaks the rule is never drawn (D-261102-897), whatever the element reported.
    const told = this.told();
    const frame = el.lastFrameGiven;
    if (frame && told.video && sizeProblem({ widthPx: frame.w, heightPx: frame.h }, told.video.fps, told.variant)) this.world.fail(`${this.label}: a video draw of a ${frame.w} x ${frame.h} frame on ${told.variant}`);
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
    const commit = () => {
      this.#commitQueued = false;
      const next = this.board.shown.element;
      if (next !== this.konvaHeld) {
        this.konvaHeld = next;
        this.board.konvaHolds(next);
      }
    };
    // Mostly at once, and now and then only after the next frame's draws, so a source cleared before the commit would meet a Konva draw.
    if (this.world.r() < this.world.lateShare) this.world.lateCommits.push(commit);
    else queueMicrotask(commit);
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
  world.r = r;
  world.lateShare = 0.3;
  const content = pick(r, CONTENTS);
  const display = pick(r, DISPLAYS);
  const withCallbacks = !chance(r, 0.2);
  const frameSizes = !chance(r, 0.1);
  const decodable = pick(r, ["smooth", "smooth", "smooth", "notSmooth"] as const);
  world.sizes = (url) => sizesFor(VIDEOS.find((v) => url === `/${v.assetId}`), r);
  const make = () => {
    const v = new FakeVideo(world, content, display, r, withCallbacks);
    v.frameSizes = frameSizes;
    return v;
  };
  const dm = new Rig(world, "dm", make, decodable);
  log("content", JSON.stringify(content), "display", JSON.stringify(display), "callbacks", withCallbacks, decodable);
  dm.board.onState = (state) => {
    reached.states.add(state);
    log(world.now.toFixed(1), "dm state", state);
  };
  let preview: Rig | null = null;
  const viewer = new Viewer();
  let input: BoardInput = { ...IDLE_INPUT, server: true, video: VIDEO_A, url: "/va" };
  dm.told = () => ({ video: input.video, variant: input.variant });
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
      for (const commit of world.lateCommits.splice(0)) commit();
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
        p.told = () => ({ video: input.video, variant: input.variant });
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
        const sizes = world.sizes(rig.video.attrs.get("src"));
        rig.video.frameSize = world.realSize ?? sizes.frame;
        rig.video.videoWidth = world.realSize?.w ?? sizes.reported.w;
        rig.video.videoHeight = world.realSize?.h ?? sizes.reported.h;
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
  for (const state of ["playing", "paused", "loading", "waiting", "covered", "still setting", "still low-power", "still still-view", "still not-started", "still load-failed", "still not-smooth", "still phone-size", "preview playing"])
    assert.ok(reached.states.has(state), `no sequence reached ${state}: ${[...reached.states].join(", ")}`);
});

/** One board on a display, with its element, run by hand. `sizes` is what the element reports and decodes; `variant` the map detail it starts on. */
function single(content: Content, display: Display, video: MapVideo, options: { callbacks?: boolean; silent?: boolean; sizes?: { reported: Size; frame: Size }; variant?: "full" | "mobile" } = {}) {
  resetDecoderForTests();
  resetPageStepDownForTests();
  const world = new World();
  if (options.sizes) world.sizes = () => options.sizes!;
  const r = rng(9);
  const dm = new Rig(
    world,
    "dm",
    () => {
      const v = new FakeVideo(world, content, display, r, options.callbacks ?? true);
      v.silent = options.silent === true;
      return v;
    },
    "smooth",
  );
  const variant = options.variant ?? "full";
  dm.told = () => ({ video, variant });
  dm.board.input({ ...IDLE_INPUT, server: true, video, url: `/${video.assetId}`, variant });
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
      for (const commit of world.lateCommits.splice(0)) commit();
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
  // React's useSyncExternalStore takes the board's subscribe unbound.
  const { subscribe } = dm.board;
  subscribe(() => {})();
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

test("a failed load is tried once more after 5 s, and a second failure shows the still with its reason", async () => {
  const { world, dm, run } = single([{ fps: 30, ms: 2000 }], { hz: 60 }, VIDEO_A);
  world.failLoads = true;
  await settle(world);
  await run(1000);
  assert.equal(dm.board.state, "loading", "waiting for the retry");
  assert.equal(dm.video!.hasSrc(), false, "the failed source is let go meanwhile");
  world.failLoads = false;
  await run(5000);
  assert.equal(dm.board.state, "playing", "the retry plays");
  world.failLoads = true;
  dm.board.input({ video: VIDEO_B, url: "/vb" });
  await settle(world);
  await run(7000);
  assert.equal(dm.board.state, "still load-failed");
  assert.equal(dm.video!.hasSrc(), false);
  assert.deepEqual(world.failures, []);
});

test("a play() the browser refuses shows the still, and a tap on the board plays it", async () => {
  const { world, dm, run } = single([{ fps: 30, ms: 2000 }], { hz: 60 }, VIDEO_A);
  world.rejectPlay = true;
  await settle(world);
  await run(1000);
  assert.equal(dm.board.state, "still not-started");
  assert.equal(dm.konvaHeld, null, "Konva draws the still");
  dm.board.tapped();
  await settle(world);
  await run(500);
  assert.equal(dm.board.state, "still not-started", "a tap the browser still refuses keeps the still");
  world.rejectPlay = false;
  dm.board.tapped();
  await settle(world);
  await run(500);
  assert.equal(dm.board.state, "playing");
  assert.deepEqual(world.failures, []);
});

test("a board that yielded to another board asks again only once what decides it changes", async () => {
  const { world, dm, run } = single([{ fps: 30, ms: 2000 }], { hz: 60 }, VIDEO_A);
  await settle(world);
  await run(1000);
  assert.equal(dm.board.state, "playing");
  // The preview's board leases before the DM's board hears that it is covered.
  const preview = new Rig(world, "preview", () => new FakeVideo(world, [{ fps: 30, ms: 2000 }], { hz: 60 }, rng(3), true), "smooth");
  preview.board.input({ ...IDLE_INPUT, server: true, video: VIDEO_A, url: "/va" });
  await settle(world);
  await run(500);
  assert.deepEqual(decoderLeases(), [{ user: "board", granted: true }], "only the preview's lease, the DM's board standing down");
  assert.equal(dm.video!.hasSrc(), false);
  assert.equal(preview.video!.hasSrc(), true);
  assert.equal(dm.video!.sources, 1, "the DM's board never took its source back");
  assert.equal(preview.video!.sources, 1);
  // Covered, the DM's board asks for nothing, though what decides it changed.
  dm.board.input({ preview: true });
  await settle(world);
  await run(500);
  assert.equal(dm.video!.sources, 1);
  assert.equal(preview.video!.hasSrc(), true, "the preview keeps its source");
  preview.board.dispose();
  dm.board.input({ preview: false });
  await settle(world);
  await run(1000);
  assert.equal(dm.board.state, "playing", "the DM's board plays again once the preview goes");
  assert.deepEqual(world.failures, []);
});

test("a blackout unmounts the controller while the room stays: the video stops, its source and lease go, the status clears, and it plays again after (AMBUILD-ASTRA-04)", async () => {
  const { world, dm, run } = single([{ fps: 30, ms: 2000 }], { hz: 60 }, VIDEO_A);
  const status = boardVideoStatus();
  const disconnect = connectBoard(dm.board, status);
  await settle(world);
  await run(1000);
  assert.equal(dm.board.state, "playing");
  assert.equal(status.get()?.playback.reason, "moving");
  // The blackout takes MapStage away: its host, its map layer and the controller let go, in React's order, and the Room's scope keeps the board.
  dm.board.attachHost(null);
  dm.board.konvaHolds(null);
  dm.board.attachLayer(null);
  disconnect();
  await settle(world);
  await run(1000);
  assert.equal(dm.video!.paused, true, "nothing plays");
  assert.equal(dm.video!.hasSrc(), false, "the source is gone");
  assert.deepEqual(decoderLeases(), [], "the decoder is free");
  assert.equal(status.get(), null, "the Map image row hears nothing plays");
  assert.equal(dm.board.state, "none");
  // The blackout ends: the stage mounts again on the same board.
  const again = connectBoard(dm.board, status);
  dm.remount();
  dm.board.input({ ...IDLE_INPUT, server: true, video: VIDEO_A, url: "/va" });
  await settle(world);
  await run(1000);
  assert.equal(dm.board.state, "playing");
  assert.equal(status.get()?.playback.reason, "moving");
  again();
  assert.deepEqual(world.failures, []);
});

/*
 * The size the board judges (docs/design/design-v1-video-turns.md 6.3 and
 * 13, D-261102-897): each frame's own size from its frame callback, a
 * reported coded or stretched size held until the first frame, and the
 * reported size judged as reported without callbacks.
 */
const SECOND = [{ fps: 30, ms: 2000 }] as const;
const HZ60 = { hz: 60 };

test("on Phone size, a 1920 × 1080 video turned 90 plays: the cap reads the coded size", async () => {
  const { world, dm, run } = single(SECOND, HZ60, VIDEO_TURNED, { variant: "mobile", sizes: { reported: { w: 1920, h: 1080 }, frame: { w: 1920, h: 1080 } } });
  await settle(world);
  await run(1500);
  assert.equal(dm.board.state, "playing");
  assert.deepEqual(world.failures, []);
});

test("on Phone size, a 4:3 file that Gecko reports at 2560 × 1080, or 2559, plays: its frames are 1920 × 1080", async () => {
  for (const w of [2560, 2559, 2561, 1920]) {
    const { world, dm, run } = single(SECOND, HZ60, VIDEO_WIDE, { variant: "mobile", sizes: { reported: { w, h: 1080 }, frame: { w: 1920, h: 1080 } } });
    await settle(world);
    await run(1500);
    assert.equal(dm.board.state, "playing", `reported ${w}`);
    assert.ok(dm.board.videoDraws > 20, `${w}: it draws`);
    assert.deepEqual(world.failures, []);
  }
  // Two pixels off is no rounding: judged as reported, the still.
  const { world, dm, run } = single(SECOND, HZ60, VIDEO_WIDE, { variant: "mobile", sizes: { reported: { w: 2562, h: 1080 }, frame: { w: 1920, h: 1080 } } });
  await settle(world);
  await run(1500);
  assert.equal(dm.board.state, "still phone-size");
  assert.equal(dm.board.videoDraws, 0);
});

test("on Phone size, a WebM that declares 2560 × 720 for 1280 × 720 and really decodes at 2560 × 720 shows the still after its first frame", async () => {
  const liar: MapVideo = { ...VIDEO_A, assetId: "vl", widthPx: 1280, heightPx: 720, displayWidthPx: 2560 };
  const { world, dm, run } = single(SECOND, HZ60, liar, { variant: "mobile", sizes: { reported: { w: 2560, h: 720 }, frame: { w: 2560, h: 720 } } });
  await settle(world);
  await run(1500);
  assert.equal(dm.board.state, "still phone-size", "the frame's own size is judged");
  assert.equal(dm.board.videoDraws, 0, "and that frame is never drawn");
  assert.equal(dm.konvaHeld, null, "Konva draws the still");
  // On Full size the same frames are inside the caps.
  dm.board.input({ variant: "full" });
  dm.told = () => ({ video: liar, variant: "full" });
  await settle(world);
  await run(1500);
  assert.equal(dm.board.state, "playing");
  assert.deepEqual(world.failures, []);
});

test("the 4:3 file reported at 2560 × 1080 without frame callbacks, or with none in CALLBACK_WAIT_MS, is judged as reported: the still on Phone size", async () => {
  {
    const { world, dm, run } = single(SECOND, HZ60, VIDEO_WIDE, { variant: "mobile", callbacks: false, sizes: { reported: { w: 2560, h: 1080 }, frame: { w: 1920, h: 1080 } } });
    await settle(world);
    await run(1500);
    assert.equal(dm.board.state, "still phone-size", "no method: as reported at once");
  }
  {
    const { world, dm, run } = single(SECOND, HZ60, VIDEO_WIDE, { variant: "mobile", silent: true, sizes: { reported: { w: 2560, h: 1080 }, frame: { w: 1920, h: 1080 } } });
    await settle(world);
    await run(CALLBACK_WAIT_MS / 2);
    assert.notEqual(dm.board.state, "still phone-size", "held while a callback may still come");
    await run(CALLBACK_WAIT_MS + 1000);
    assert.equal(dm.board.state, "still phone-size", "none came: as reported");
  }
});

test("plain facts with an SPS stretch reported at 2560 × 1080 for 1920 × 1080 show the still on Phone size, and a frame of 1920 × 1080 then a resize to 2560 × 1080 keeps playing", async () => {
  const plain: MapVideo = { ...VIDEO_WIDE, assetId: "vp", displayWidthPx: undefined };
  {
    const { world, dm, run } = single(SECOND, HZ60, plain, { variant: "mobile", sizes: { reported: { w: 2560, h: 1080 }, frame: { w: 1920, h: 1080 } } });
    await settle(world);
    await run(1500);
    assert.equal(dm.board.state, "still phone-size", "no stretch in the facts, so nothing holds it: the documented exception");
  }
  {
    const { world, dm, run } = single(SECOND, HZ60, plain, { variant: "mobile", sizes: { reported: { w: 1920, h: 1080 }, frame: { w: 1920, h: 1080 } } });
    await settle(world);
    await run(1000);
    assert.equal(dm.board.state, "playing");
    const el = dm.video!;
    el.videoWidth = 2560;
    el.fire("resize");
    await settle(world);
    await run(1000);
    assert.equal(dm.board.state, "playing", "the resize waits for the next frame, which is 1920 × 1080");
    // A frame that really grows is judged on that frame.
    el.frameSize = { w: 2560, h: 1080 };
    await run(500);
    assert.equal(dm.board.state, "still phone-size");
    assert.deepEqual(world.failures, []);
  }
});

test("a disposed board no longer hears the page's step-down, so an ended Room scope is not kept alive (AM-R1-04)", () => {
  resetPageStepDownForTests();
  const before = stepDownListenersForTests();
  const world = new World();
  const rig = new Rig(world, "gone", () => new FakeVideo(world, [{ fps: 30, ms: 2000 }], { hz: 60 }, rng(4), true), "smooth");
  assert.equal(stepDownListenersForTests(), before + 1);
  rig.board.dispose();
  assert.equal(stepDownListenersForTests(), before);
  rig.board.input({ ...IDLE_INPUT, server: true, video: VIDEO_A, url: "/va" });
  assert.equal(stepDownListenersForTests(), before + 1, "used again, it hears it again");
  rig.board.dispose();
});
