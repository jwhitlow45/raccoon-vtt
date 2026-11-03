import type { AssetId, MapVideo } from "#shared/model.ts";
import { scopeSlot } from "../../state/scope.ts";
import { decodable as askDecodable } from "./capabilities.ts";
import { DrawGate } from "./pacing.ts";
import { playback, type Decodable, type PlaybackInput } from "./playback.ts";
import { decoderLeases, leaseDecoder, type BoardVideo, type DecoderHandlers, type DecoderLease, type DecoderUser, type Playback, type StillReason } from "./status.ts";
import { StepDown, type StepResult } from "./stepDown.ts";
import type { AnimatedMapsChoice } from "./words.ts";

/**
 * The board's one video (docs/design/design-v1-animated-maps.md 5.2 to 5.4),
 * one per Room page: the element, its source and its turn at the window's
 * decoder, when it plays and pauses, when Konva may draw it, the draws
 * themselves, the step-down and the status the Map image row reads.
 * AnimMapController.tsx feeds it what the room shows, the board's host
 * gives it a place in the page, and the Top-down map layer takes the
 * element from it and hands it back.
 *
 * Nothing here touches React or Konva, so a test drives it with a fake
 * element, a fake layer and a clock of its own (controller.random.test.ts).
 *
 * The order of a free (a cover, the Library viewer, a scene or phase
 * switch, Still, the video removed): one commit stops handing the element
 * to Konva, and only once the map layer says it holds it no more does the
 * source go, with `removeAttribute("src")` and `load()`, which drops the
 * decoder's frames. So Konva never draws an element without a source.
 */

// ---------------------------------------------------------------- what the room needs from the page

/** The parts of an HTMLVideoElement the board uses. */
export type VideoLike = {
  muted: boolean;
  defaultMuted: boolean;
  playsInline: boolean;
  loop: boolean;
  preload: string;
  readonly paused: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly currentTime: number;
  readonly error: { code: number } | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  load(): void;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  requestVideoFrameCallback?(callback: (now: number, metadata: { mediaTime: number; presentedFrames: number }) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
  getVideoPlaybackQuality?(): { totalVideoFrames: number; droppedVideoFrames: number };
};

/** The Top-down map layer, as the board draws it. */
export type LayerLike = {
  /** Draws the layer at once, in this frame. */
  draw(): void;
  /** A camera draw is already asked for this frame (Konva's batchDraw), and it will show the frame. */
  waitingForDraw(): boolean;
  /** Hears every draw of the layer, the board's own included. */
  onDraw(listener: () => void): () => void;
};

/** Where the element sits: the board's host, under the cover and the canvas. */
export type HostLike = { place(video: VideoLike): void; remove(video: VideoLike): void };

export type BoardEnv = {
  now(): number;
  frame(run: (now: number) => void): number;
  cancelFrame(id: number): void;
  later(run: () => void, ms: number): number;
  cancelLater(id: number): void;
  createVideo(): VideoLike;
  decodable(video: MapVideo, powerEfficient: boolean): Promise<Decodable>;
  lease(user: DecoderUser, handlers: DecoderHandlers): DecoderLease;
};

/** What decides the board's video, from the room and the device. */
export type BoardInput = {
  /** The shown scene's map video, with the address its bytes load from, or null. */
  video: MapVideo | null;
  url: string | null;
  server: boolean;
  setting: AnimatedMapsChoice;
  lowPower: boolean;
  reducedMotion: boolean;
  variant: "full" | "mobile";
  /** Isometric shows: the Top-down tree is hidden, so the video pauses. */
  iso: boolean;
  /** The Builder, Fog, Line up grid or Traps tool shows Top-down with the still. */
  setupTool: boolean;
  pageVisible: boolean;
  /** A panel fills the whole screen. */
  panelCovered: boolean;
  /** View as a player stands over this room: its board frees the decoder for the preview's. */
  preview: boolean;
  /** The scene is still loading. */
  loading: boolean;
};

export const IDLE_INPUT: BoardInput = {
  video: null,
  url: null,
  server: false,
  setting: "moving",
  lowPower: false,
  reducedMotion: false,
  variant: "full",
  iso: false,
  setupTool: false,
  pageVisible: true,
  panelCovered: false,
  preview: false,
  loading: false,
};

/** A failed load waits this long before its one retry (5.2). */
export const RETRY_MS = 5000;
/** Without a frame callback this long after `playing`, the board draws on animation frames (5.2). */
export const CALLBACK_WAIT_MS = 1000;
/** The video draws whose times the bench reads: half a minute of them. */
const DRAW_TIMES = 900;
/** A loop's wrap shows as the time going back by more than this, in seconds, against the last frame. */
const WRAP_BACK_S = 0.25;

/** What the map layer and the host read: the element Konva may draw, and whether it holds a source, so the cover shows. */
export type BoardShown = { element: VideoLike | null; assetId: AssetId | null; holdsSrc: boolean };

// ---------------------------------------------------------------- the step-down, for the page

/**
 * The step-down lasts until the page reloads and speaks for the device
 * (words.ts deviceStillHelp), so it is one value for the page: a board
 * that falls behind stills every board and the judge's answers too.
 */
let pageStepDown: StepResult | null = null;
const stepDownListeners = new Set<() => void>();

export function pageSteppedDown(): StepResult | null {
  return pageStepDown;
}

export function subscribePageStepDown(listener: () => void): () => void {
  stepDownListeners.add(listener);
  return () => stepDownListeners.delete(listener);
}

function stepPageDown(result: StepResult): void {
  if (pageStepDown) return;
  pageStepDown = result;
  for (const listener of [...stepDownListeners]) listener();
}

export function resetPageStepDownForTests(): void {
  pageStepDown = null;
}

/** How many boards hear the page's step-down, so a test sees a board let go of it. */
export function stepDownListenersForTests(): number {
  return stepDownListeners.size;
}

// ---------------------------------------------------------------- the board

export class AnimMapBoard {
  readonly #env: BoardEnv;
  #input: BoardInput = IDLE_INPUT;
  #element: VideoLike | null = null;
  #host: HostLike | null = null;
  #layer: LayerLike | null = null;
  #layerOff: (() => void) | null = null;
  /** The element the map layer said it draws, or null. */
  #konvaHolds: VideoLike | null = null;
  #lease: DecoderLease | null = null;
  /** Asked to yield: the source goes and the lease ends. */
  #yielding = false;
  /** After yielding to another board, ask again only once what decides the board changes. */
  #standDown = false;
  /** The asset whose bytes the element holds now, or null. */
  #srcAsset: AssetId | null = null;
  #srcUrl: string | null = null;
  #firstFrame = false;
  #playing = false;
  #playPending = false;
  #handed = false;
  /** Per asset: what went wrong with it, kept until another asset shows. */
  #forAsset: AssetId | null = null;
  #realSize: { widthPx: number; heightPx: number } | undefined = undefined;
  #notStarted = false;
  #loadFailed = false;
  #retried = false;
  #retryTimer: number | null = null;
  #cooling = false;
  /** The browser's answer for the shown video, by its question. */
  #decodable: { key: string; value: Decodable } | null = null;
  #asking: string | null = null;
  // The draw loop.
  readonly #gate = new DrawGate();
  #stepDown: StepDown;
  #callback: number | null = null;
  #rafId: number | null = null;
  #fallback = false;
  #callbackSeen = false;
  #callbackTimer: number | null = null;
  #lastMediaS: number | null = null;
  #drawing = false;
  #wasLoading = false;
  #settling = false;
  #again = false;
  #shown: BoardShown = { element: null, assetId: null, holdsSrc: false };
  #status: BoardVideo = null;
  #state = "none";
  readonly #listeners = new Set<() => void>();
  /** Stops this board hearing the page's step-down, or null while it does not. */
  #stepDownOff: (() => void) | null = null;
  /** Video draws and camera draws of the map layer, counted apart (the e2e hooks). */
  videoDraws = 0;
  cameraDraws = 0;
  /** The main thread's time of the last DRAW_TIMES video draws, in ms, for the bench (scripts/bench-animmap.ts). */
  readonly drawMs: number[] = [];
  /** Called with the status for the Map image row, and with the test hook's words, on a change. */
  onStatus: ((status: BoardVideo) => void) | null = null;
  onState: ((state: string) => void) | null = null;

  constructor(env: BoardEnv) {
    this.#env = env;
    this.#stepDown = new StepDown(env.now());
    this.#hearStepDown();
  }

  /**
   * A step-down speaks for the page, so every board stills when one falls
   * behind. The page's list holds the board only until dispose, so a Room
   * scope that ends, such as View as a player's, is not kept alive by it
   * (AM-R1-04).
   */
  #hearStepDown(): void {
    this.#stepDownOff ??= subscribePageStepDown(() => this.#settle());
  }

  // ---------------------------------------------------------------- what the page tells it

  input(patch: Partial<BoardInput>): void {
    this.#hearStepDown();
    const was = this.#input;
    const next = { ...was, ...patch };
    if (sameInput(was, next)) return;
    this.#input = next;
    // A change of what decides the board lets a board that stood down for another ask again.
    this.#standDown = false;
    if (was.loading && !next.loading) this.#restartWindows();
    this.#settle();
  }

  attachHost(host: HostLike | null): void {
    if (this.#host && this.#element) this.#host.remove(this.#element);
    this.#host = host;
    if (host && this.#element && this.#srcAsset !== null) host.place(this.#element);
    this.#settle();
  }

  /** The Top-down map layer that draws the video, or null when it unmounts. A new layer is a remount for the step-down. */
  attachLayer(layer: LayerLike | null): void {
    if (layer === this.#layer) return;
    this.#layerOff?.();
    this.#layerOff = null;
    this.#layer = layer;
    if (layer) {
      this.#layerOff = layer.onDraw(() => {
        if (!this.#drawing) this.cameraDraws++;
      });
      this.#restartWindows();
    }
    this.#settle();
  }

  /** What the map layer draws now: the element, or null once a commit stopped drawing it. */
  konvaHolds(element: VideoLike | null): void {
    if (element === this.#konvaHolds) return;
    this.#konvaHolds = element;
    this.#settle();
  }

  /**
   * A `pointerup` or `click` on the board. Those grant user activation, so a
   * `play()` the browser refused is tried again here, inside the event
   * (5.3 Autoplay, D-261102-455).
   */
  tapped(): void {
    if (!this.#notStarted || !this.#element || this.#srcAsset === null) return;
    this.#notStarted = false;
    this.#play();
    this.#settle();
  }

  /** The map size this device loads now, for the judge's question. */
  get variant(): "full" | "mobile" {
    return this.#input.variant;
  }

  get shown(): BoardShown {
    return this.#shown;
  }

  get status(): BoardVideo {
    return this.#status;
  }

  get state(): string {
    return this.#state;
  }

  /** An arrow, so React's useSyncExternalStore can take it unbound. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The playback rule for any video, as this board would apply it now, for the judge the Map image row and the Library viewer ask. */
  judge(video: MapVideo, answer: Decodable): Playback {
    return playback(video, this.#ruleInput(answer, false));
  }

  /**
   * Lets everything go: the source, the lease, the loops, the status and the
   * page's step-down. The controller is going, with the Room's tree or with
   * the board alone while the Room stays, as a blackout takes the board
   * away (AMBUILD-ASTRA-04), so its map layer holds nothing. Not for good:
   * the board's next input, after a blackout or React's development double
   * mount, brings the video back.
   */
  dispose(): void {
    this.#input = IDLE_INPUT;
    this.#konvaHolds = null;
    this.#settle();
    this.#stepDownOff?.();
    this.#stepDownOff = null;
  }

  // ---------------------------------------------------------------- the rule

  #ruleInput(answer: Decodable, forBoard: boolean): PlaybackInput {
    const i = this.#input;
    return {
      server: i.server,
      setting: i.setting,
      lowPower: i.lowPower,
      reducedMotion: i.reducedMotion,
      variant: i.variant,
      decodable: answer,
      steppedDown: pageStepDown,
      ...(forBoard
        ? {
            ...(this.#realSize ? { realSize: this.#realSize } : {}),
            loadFailed: this.#loadFailed,
            stillView: i.iso || i.setupTool,
            notStarted: this.#notStarted,
          }
        : {}),
    };
  }

  #question(video: MapVideo): string {
    return `${video.assetId}|${this.#input.variant}`;
  }

  /** The browser's answer for the shown video, asked once per video and Map detail. Null until it comes. */
  #answer(video: MapVideo): Decodable | null {
    const key = this.#question(video);
    if (this.#decodable?.key === key) return this.#decodable.value;
    if (this.#asking !== key) {
      this.#asking = key;
      void this.#env.decodable(video, this.#input.variant === "mobile").then(
        (value) => {
          if (this.#asking !== key) return;
          this.#asking = null;
          this.#decodable = { key, value };
          this.#settle();
        },
        () => {
          if (this.#asking !== key) return;
          this.#asking = null;
          this.#decodable = { key, value: "codec" };
          this.#settle();
        },
      );
    }
    return null;
  }

  // ---------------------------------------------------------------- settling

  /** Brings the element, the lease, the handing and the loops in line with what decides them. Reentrant calls run once more after. */
  #settle(): void {
    if (this.#settling) {
      this.#again = true;
      return;
    }
    this.#settling = true;
    try {
      do {
        this.#again = false;
        this.#step();
      } while (this.#again);
    } finally {
      this.#settling = false;
    }
  }

  #step(): void {
    const i = this.#input;
    const video = i.video && i.url ? i.video : null;
    if ((video?.assetId ?? null) !== this.#forAsset) {
      // Another video: what went wrong with the last one stays with it.
      this.#forAsset = video?.assetId ?? null;
      this.#realSize = undefined;
      this.#notStarted = false;
      this.#loadFailed = false;
      this.#retried = false;
      this.#cooling = false;
      if (this.#retryTimer !== null) this.#env.cancelLater(this.#retryTimer);
      this.#retryTimer = null;
    }
    const answer = video ? this.#answer(video) : null;
    // What the device allows for this video, before what the board shows decides whether it moves now.
    const allowed = video && answer ? playback(video, { ...this.#ruleInput(answer, true), stillView: false, notStarted: false }) : null;
    const wantSrc = Boolean(video && allowed?.play && !i.preview);

    // The lease: asked for while the board wants a source, given up once the source is gone.
    if (wantSrc && !this.#lease && !this.#standDown) {
      this.#lease = this.#env.lease("board", {
        onGrant: () => this.#settle(),
        onYield: (lease) => this.#yield(lease),
      });
    }
    const granted = Boolean(this.#lease?.granted()) && !this.#yielding;
    const desired = wantSrc && granted && !this.#cooling ? video!.assetId : null;

    // A source that must go, or change: stop handing it to Konva first.
    if (this.#srcAsset !== null && (this.#srcAsset !== desired || this.#srcUrl !== i.url)) {
      this.#setHanded(false);
      if (this.#konvaHolds === null) this.#clearSrc();
    }
    if ((!wantSrc || this.#yielding) && this.#srcAsset === null && this.#lease) {
      const lease = this.#lease;
      this.#lease = null;
      this.#yielding = false;
      lease.release();
      if (wantSrc) return void (this.#again = true);
    }
    if (this.#srcAsset === null && desired !== null && i.url) this.#setSrc(desired, i.url);

    // Play while the map shows, pause otherwise. A pause keeps the source, so a return plays within a frame.
    const el = this.#element;
    const runs = this.#srcAsset !== null && !i.iso && !i.setupTool && i.pageVisible && !i.panelCovered && !i.loading && !this.#notStarted;
    if (el && this.#srcAsset !== null) {
      if (runs && el.paused && !this.#playPending) this.#play();
      if (!runs && !el.paused) el.pause();
    }

    // Konva draws the element while the device allows it, it has a frame, and no setup tool shows the still.
    const full = video && answer ? playback(video, this.#ruleInput(answer, true)) : null;
    const hand = Boolean(this.#srcAsset !== null && this.#srcAsset === desired && this.#firstFrame && full && (full.play || full.reason === "stillView") && !i.setupTool);
    this.#setHanded(hand);
    // Draws start once the map layer's commit holds the element, so no video draw redraws the still.
    this.#loop(hand && runs && this.#playing && this.#layer !== null && this.#konvaHolds === this.#element);

    // Before the browser answers, the device's own choices already say Still, and otherwise it reads as moving, the way it is about to go.
    this.#publish(video, full ?? (video ? playback(video, this.#ruleInput("smooth", true)) : null));
  }

  #yield(lease: DecoderLease): void {
    if (lease !== this.#lease) return lease.release();
    this.#yielding = true;
    // A viewer asked: wait for it in a new lease at once, since the board never takes the decoder from a viewer. A board asked: wait for a change.
    if (!viewerWaiting()) this.#standDown = true;
    this.#settle();
  }

  #setSrc(assetId: AssetId, url: string): void {
    let el = this.#element;
    if (!el) {
      el = this.#env.createVideo();
      // Muted as property and attribute before any source (5.2), so no browser treats it as a video with sound.
      el.muted = true;
      el.defaultMuted = true;
      el.setAttribute("muted", "");
      el.playsInline = true;
      el.setAttribute("playsinline", "");
      el.loop = true;
      el.preload = "auto";
      el.setAttribute("aria-hidden", "true");
      el.setAttribute("disablepictureinpicture", "");
      el.setAttribute("disableremoteplayback", "");
      for (const [type, listener] of this.#events) el.addEventListener(type, listener);
      this.#element = el;
    }
    this.#host?.place(el);
    this.#srcAsset = assetId;
    this.#srcUrl = url;
    this.#firstFrame = false;
    this.#playing = false;
    this.#lastMediaS = null;
    this.#callbackSeen = false;
    this.#fallback = false;
    this.#gate.reset();
    this.#restartWindows();
    el.setAttribute("src", url);
    el.load();
  }

  #clearSrc(): void {
    const el = this.#element;
    this.#stopLoops();
    this.#srcAsset = null;
    this.#srcUrl = null;
    this.#firstFrame = false;
    this.#playing = false;
    if (!el) return;
    el.pause();
    el.removeAttribute("src");
    el.load();
    this.#host?.remove(el);
  }

  #play(): void {
    const el = this.#element;
    if (!el) return;
    this.#playPending = true;
    const asset = this.#srcAsset;
    let started: Promise<void>;
    try {
      started = el.play();
    } catch (err) {
      started = Promise.reject(err);
    }
    void Promise.resolve(started).then(
      () => {
        this.#playPending = false;
        this.#settle();
      },
      (err: unknown) => {
        this.#playPending = false;
        // NotAllowedError: iOS Low Power Mode, or a browser that wants a tap. An AbortError is a pause or a new source cutting it short, which says nothing.
        if (asset === this.#srcAsset && err instanceof Error && err.name === "NotAllowedError") this.#notStarted = true;
        this.#settle();
      },
    );
  }

  #setHanded(hand: boolean): void {
    if (hand === this.#handed) return;
    this.#handed = hand;
    this.#publishShown();
  }

  #publishShown(): void {
    const element = this.#handed ? this.#element : null;
    const assetId = this.#handed ? this.#srcAsset : null;
    const holdsSrc = this.#srcAsset !== null;
    const was = this.#shown;
    if (was.element === element && was.assetId === assetId && was.holdsSrc === holdsSrc) return;
    this.#shown = { element, assetId, holdsSrc };
    for (const listener of [...this.#listeners]) listener();
  }

  #publish(video: MapVideo | null, play: Playback | null): void {
    this.#publishShown();
    const status: BoardVideo = video && play ? { assetId: video.assetId, playback: play } : null;
    const was = this.#status;
    if (status === null ? was !== null : was === null || was.assetId !== status.assetId || was.playback.reason !== status.playback.reason) {
      this.#status = status;
      this.onStatus?.(status);
    }
    const state = stateWords(video, play, {
      preview: this.#input.preview,
      waiting: Boolean(this.#lease && !this.#lease.granted()) || this.#standDown || this.#yielding,
      holdsSrc: this.#srcAsset !== null,
      firstFrame: this.#firstFrame,
      drawing: this.#callback !== null || this.#rafId !== null,
    });
    if (state !== this.#state) {
      this.#state = state;
      this.onState?.(state);
    }
  }

  // ---------------------------------------------------------------- the element's events

  readonly #events: ReadonlyArray<[string, () => void]> = [
    ["loadedmetadata", () => this.#sized()],
    ["resize", () => this.#sized()],
    [
      "loadeddata",
      () => {
        this.#firstFrame = true;
        this.#settle();
      },
    ],
    [
      "playing",
      () => {
        this.#playing = true;
        this.#notStarted = false;
        this.#restartWindows();
        this.#settle();
      },
    ],
    [
      "pause",
      () => {
        this.#playing = false;
        this.#settle();
      },
    ],
    ["error", () => this.#failed()],
  ];

  #sized(): void {
    const el = this.#element;
    if (!el || this.#srcAsset === null || !(el.videoWidth > 0 && el.videoHeight > 0)) return;
    const real = { widthPx: el.videoWidth, heightPx: el.videoHeight };
    if (this.#realSize && this.#realSize.widthPx === real.widthPx && this.#realSize.heightPx === real.heightPx) return;
    this.#realSize = real;
    this.#settle();
  }

  /** A media error: one retry after RETRY_MS, then the still with "the video didn't load." */
  #failed(): void {
    const el = this.#element;
    if (!el || this.#srcAsset === null || !el.error) return;
    if (this.#retried) {
      this.#loadFailed = true;
      this.#settle();
      return;
    }
    this.#retried = true;
    this.#cooling = true;
    this.#retryTimer = this.#env.later(() => {
      this.#retryTimer = null;
      this.#cooling = false;
      this.#settle();
    }, RETRY_MS);
    this.#settle();
  }

  // ---------------------------------------------------------------- the draws

  #restartWindows(): void {
    this.#stepDown.restart(this.#env.now());
  }

  #loop(on: boolean): void {
    if (!on) return this.#stopLoops();
    const el = this.#element!;
    if (this.#callback !== null || this.#rafId !== null) return;
    if (!this.#fallback && el.requestVideoFrameCallback) {
      this.#callback = el.requestVideoFrameCallback(this.#onFrame);
      if (!this.#callbackSeen && this.#callbackTimer === null) {
        // A frame callback that never comes, as on a browser that has the method but runs none for this element: draw on animation frames instead.
        this.#callbackTimer = this.#env.later(() => {
          this.#callbackTimer = null;
          if (this.#callbackSeen) return;
          if (this.#callback !== null) el.cancelVideoFrameCallback?.(this.#callback);
          this.#callback = null;
          this.#fallback = true;
          this.#settle();
        }, CALLBACK_WAIT_MS);
      }
      return;
    }
    this.#fallback = true;
    this.#rafId = this.#env.frame(this.#onTick);
  }

  #stopLoops(): void {
    const el = this.#element;
    if (this.#callback !== null) el?.cancelVideoFrameCallback?.(this.#callback);
    this.#callback = null;
    if (this.#rafId !== null) this.#env.cancelFrame(this.#rafId);
    this.#rafId = null;
    if (this.#callbackTimer !== null) this.#env.cancelLater(this.#callbackTimer);
    this.#callbackTimer = null;
  }

  readonly #onFrame = (now: number, metadata: { mediaTime: number; presentedFrames: number }): void => {
    this.#callback = null;
    this.#callbackSeen = true;
    if (this.#element && this.#handed && this.#srcAsset !== null) {
      this.#sample(now, metadata.presentedFrames, metadata.mediaTime);
      const mediaMs = metadata.mediaTime * 1000;
      if (this.#gate.frame(mediaMs, now)) this.#draw(now, mediaMs);
    }
    // Asks for the next frame while the board still draws.
    this.#settle();
  };

  readonly #onTick = (now: number): void => {
    this.#rafId = null;
    const el = this.#element;
    if (el && this.#handed && this.#srcAsset !== null) {
      this.#sample(now, null, el.currentTime);
      if (this.#gate.tick(now)) this.#draw(now, null);
    }
    this.#settle();
  };

  /** Feeds the step-down: the frame's counters, and a wrap where the time went back. */
  #sample(now: number, presentedFrames: number | null, mediaS: number): void {
    const el = this.#element!;
    if (this.#lastMediaS !== null && mediaS < this.#lastMediaS - WRAP_BACK_S) this.#stepDown.wrap(now);
    this.#lastMediaS = mediaS;
    const quality = el.getVideoPlaybackQuality?.();
    if (!quality) return;
    this.#stepDown.sample({ now, presentedFrames, totalFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames });
    const result = this.#stepDown.result;
    if (result && !pageStepDown) {
      stepPageDown(result);
      this.#settle();
    }
  }

  /** A video draw: skipped when the camera's own draw is already asked for this frame, since it shows the same frame. */
  #draw(now: number, mediaMs: number | null): void {
    const layer = this.#layer;
    if (!layer || layer.waitingForDraw()) return;
    this.#drawing = true;
    const start = this.#env.now();
    try {
      layer.draw();
    } finally {
      this.#drawing = false;
    }
    this.drawMs.push(this.#env.now() - start);
    if (this.drawMs.length > DRAW_TIMES) this.drawMs.shift();
    this.videoDraws++;
    this.#gate.drew(now, mediaMs);
  }
}

// ---------------------------------------------------------------- the controller's mount

/**
 * What AnimMapController's mount ties together: the board's status reaches
 * the Map image row while the controller is mounted. Its unmount stops and
 * resets the board and clears the status, since the board, scoped to the
 * Room, outlives a controller a blackout unmounts with the map's stage
 * (AMBUILD-ASTRA-04): otherwise the old input would keep the video's
 * source and the decoder.
 */
export function connectBoard(board: AnimMapBoard, status: { get(): BoardVideo; set(next: BoardVideo): void }): () => void {
  board.onStatus = (next) => status.set(next);
  status.set(board.status);
  return () => {
    board.onStatus = null;
    board.dispose();
    status.set(null);
  };
}

// ---------------------------------------------------------------- helpers

function sameInput(a: BoardInput, b: BoardInput): boolean {
  for (const key of Object.keys(b) as (keyof BoardInput)[]) if (a[key] !== b[key]) return false;
  return true;
}

/** Whether a viewer's lease waits for the decoder: the one that just asked the board to yield, if so. */
function viewerWaiting(): boolean {
  return decoderLeases().some((l) => l.user === "viewer" && !l.granted);
}

/** The board's test hook words (`data-animmap`): "none", "playing", "paused", "loading", "waiting", "covered" or "still <reason>". */
export function stateWords(
  video: MapVideo | null,
  play: Playback | null,
  at: { preview: boolean; waiting: boolean; holdsSrc: boolean; firstFrame: boolean; drawing: boolean },
): string {
  if (!video || !play) return "none";
  if (!play.play) return `still ${kebab(play.reason)}`;
  if (at.preview) return "covered";
  if (!at.holdsSrc) return at.waiting ? "waiting" : "loading";
  if (!at.firstFrame) return "loading";
  return at.drawing ? "playing" : "paused";
}

function kebab(reason: StillReason): string {
  return reason.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** The board in the page, with the browser's clocks, element and decoder. */
export function browserBoardEnv(): BoardEnv {
  return {
    now: () => performance.now(),
    frame: (run) => requestAnimationFrame(run),
    cancelFrame: (id) => cancelAnimationFrame(id),
    later: (run, ms) => window.setTimeout(run, ms),
    cancelLater: (id) => window.clearTimeout(id),
    createVideo: () => {
      const el = document.createElement("video");
      el.style.position = "absolute";
      el.style.inset = "0";
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.objectFit = "fill";
      el.style.pointerEvents = "none";
      el.dataset.animmapVideo = "";
      return el as unknown as VideoLike;
    },
    decodable: (video, powerEfficient) => askDecodable(video, powerEfficient),
    lease: leaseDecoder,
  };
}

/** One per Room page, so View as a player's board keeps an element and a lease of its own. */
export const animMapSlot = scopeSlot(
  () => new AnimMapBoard(typeof window === "undefined" ? nodeEnv() : browserBoardEnv()),
  (board) => board.dispose(),
);

/** Outside a browser, a board that never loads anything, for a component's unit test. */
function nodeEnv(): BoardEnv {
  return {
    now: () => 0,
    frame: () => 0,
    cancelFrame: () => {},
    later: () => 0,
    cancelLater: () => {},
    createVideo: () => {
      throw new Error("no video outside a browser");
    },
    decodable: async () => "codec",
    lease: leaseDecoder,
  };
}
