import { useSyncExternalStore } from "react";
import { sameCamera, type Camera } from "../../lib/camera.ts";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { RadioCardOption } from "../../components/RadioCards.tsx";
import { scopeSlot, useScopedIfAny } from "../../state/scope.ts";
import { useLowPower, WEATHER_MODE_WORDS, type WeatherMode as WeatherSettingValue } from "../device/settings.ts";
import { sameLook, type Look } from "./looks.ts";
import { WeatherMode, type ModeInput, type StepLevel } from "./mode.ts";
import { mapDraws } from "./mapFrames.ts";
import { setFieldLook, type Field } from "./sim.ts";
import type { TextureSource } from "./textures.ts";

/**
 * The weather's one clock and what decides it (docs/design/design-v1-weather.md
 * 5.2 and 6.3), one per Room page: the mode (mode.ts), the field both views
 * draw, and the frame loop. WeatherController.tsx feeds it what the room
 * shows. The weather layer that shows registers here, and only this loop's
 * ticks step the field and draw it.
 *
 * Nothing here imports the drawing code, so the room's own chunk carries
 * only the mode. The field and the textures are made by the lazy layer
 * (WeatherLayer.tsx) and kept here, so a switch between Top-down and
 * Isometric keeps the particles where they were.
 */

/** A frame source, as requestAnimationFrame gives frames, a parameter so a test can run the loop by hand. */
export type Frames = { request(run: (time: number) => void): number; cancel(id: number): void };

const BROWSER_FRAMES: Frames = {
  request: (run) => requestAnimationFrame(run),
  cancel: (id) => cancelAnimationFrame(id),
};

/**
 * A weather layer that shows: its tick steps the field and draws its Konva
 * layer at once, in the same frame. Its camera is the one its stage holds,
 * read as each frame starts, so the cost measure knows a frame the board
 * moved in (#judge). `onBoard` says whether an input event's target is on
 * its stage, since a move over a panel, a sheet or a dialog redraws no
 * board (WZB-7). With none, every move counts.
 */
export type WeatherTarget = { tick(ms: number): void; camera?(): Camera | null; onBoard?(target: EventTarget | null): boolean };

/**
 * The board's own work beside the weather, which the cost measure must
 * never read as the weather's (#judge): gestures, and the animated map's
 * frames. A parameter so a test can play both by hand.
 */
export type BoardWork = {
  /** Calls `moved` with its target on every pointer, touch or wheel move until the returned call stops it. */
  listen(moved: (target: EventTarget | null) => void): () => void;
  /** The animated map's draws so far (mapFrames.ts). */
  mapDraws(): number;
};

/** A gesture's moves. A mouse hovering over the board counts too: its hover redraws are the board's work. */
const GESTURE_EVENTS = ["pointermove", "touchmove", "wheel"] as const;

const BROWSER_BOARD: BoardWork = {
  listen(moved) {
    if (typeof window === "undefined") return () => {};
    const options = { capture: true, passive: true } as const;
    const on = (event: Event) => moved(event.target);
    for (const type of GESTURE_EVENTS) window.addEventListener(type, on, options);
    return () => {
      for (const type of GESTURE_EVENTS) window.removeEventListener(type, on, options);
    };
  },
  mapDraws,
};

/** The textures a layer made, with how to let them go. */
export type OwnedTextures = TextureSource & { release(): void };

/** What the mount points and This device read, published only when it changes. */
export type WeatherShown = {
  /** A weather layer is mounted: the scene has weather, the device draws it, no setup tool, the page shows. */
  mounted: boolean;
  effective: "moving" | "still" | "off";
  looping: boolean;
  level: StepLevel;
  /** The look's key, "rain heavy strong", or null for none. */
  key: string | null;
  /** Where its wind blows, degrees clockwise from the map's top, so a layer held still draws a turned wind again. Null for none. */
  toward: number | null;
};

const IDLE: ModeInput = {
  setting: "moving",
  reducedMotion: false,
  lowPower: false,
  weather: false,
  particles: false,
  pageVisible: true,
  layer: false,
  covered: false,
  preview: false,
  loading: false,
  setupTool: false,
};

export class WeatherRoom {
  readonly mode: WeatherMode;
  readonly state: StoreApi<WeatherShown>;
  /** The look the scene's weather draws, or null. */
  look: Look | null = null;
  /** The particles, made by the layer for the look and kept across a view switch. Null when the look changes. */
  field: Field | null = null;
  textures: OwnedTextures | null = null;
  /**
   * What a tick adds to its frame on the main thread, in ms, the median of
   * recent ticks (#measured), for the test hooks and the bench: the draw,
   * and where the 2D canvas has no GPU, its raster and paint, which no
   * timing inside the sceneFunc sees. The mode judges each window's own.
   */
  frameCost = 0;
  readonly #frames: Frames;
  readonly #now: () => number;
  readonly #afterFrame: AfterFrame;
  /** The loop's last frames, oldest first. */
  readonly #recent: FrameSeen[] = [];
  /** What recent ticks added to their frames. */
  readonly #added: number[] = [];
  /** Frames in a row that ticked, so a screen at 33 frames a second or fewer, where every frame ticks, holds one now and then. */
  #ticksInARow = 0;
  /** Ticks in a row that no like frame stood beside (#judge), so a screen where none comes, as with an animated map or long input in step with the ticks, holds one now and then. */
  #unmatched = 0;
  /**
   * Holds since a tick last had a like frame, and how many more ticks a due
   * hold lets through. In long input whose moves keep a beat that locks to
   * the holds' own, every hold makes no like frame (WXZOOM-SOL-01), so each
   * next one comes 0 to 3 ticks later, drawn from a seeded sequence, until
   * one makes a like frame. Elsewhere holds keep their beat: a map whose
   * measures come back late makes barren holds too, and putting those off
   * slowed a slow canvas's step-down.
   */
  #barren = 0;
  #putOff: number | null = null;
  #seed = 1;
  readonly #board: BoardWork;
  /** A gesture's move came since the last frame started. */
  #gestured = false;
  /** When the input going on began, and its last move, as frame times: a pause of INPUT_PAUSE_MS ends it. */
  #inputFrom = 0;
  #inputAt: number | null = null;
  #unlisten: (() => void) | null = null;
  /** The camera the last frame started with. */
  #camera: Camera | null = null;
  /** The animated map's draws at the last frame's measure, and whether a frame settled late since saw them change. */
  #mapDraws = 0;
  #mapUnsure = false;
  readonly #targets: WeatherTarget[] = [];
  #frame: number | null = null;
  #version = -1;
  #lookChanged = false;

  constructor(frames: Frames = BROWSER_FRAMES, now: () => number = () => performance.now(), afterFrame?: AfterFrame, board: BoardWork = BROWSER_BOARD) {
    this.#frames = frames;
    this.#now = now;
    this.#board = board;
    this.#mapDraws = board.mapDraws();
    this.#afterFrame = afterFrame ?? (typeof window === "undefined" ? (run) => run() : browserAfterFrame());
    this.mode = new WeatherMode(IDLE, now());
    this.state = createStore<WeatherShown>(() => this.#shown());
    this.#version = this.mode.version;
  }

  /** What decides the mode changed: the setting, the scene, the page, a tool, a panel. */
  input(patch: Partial<ModeInput>): void {
    this.mode.update(patch, this.#now());
    this.#settle();
  }

  /**
   * The scene's look, or none. A scene edit elsewhere sends the whole scene,
   * so an equal look comes often: it keeps the look and the field as they
   * are. The same weather blowing another way keeps the particles and turns
   * their motion. A new kind, strength or wind drops the field, so the layer
   * makes one for it.
   */
  setLook(look: Look | null): void {
    if (sameLook(look, this.look)) return;
    if (look && this.look && look.key === this.look.key) {
      this.look = look;
      if (this.field) setFieldLook(this.field, look);
      this.#lookChanged = true;
      this.#settle();
      return;
    }
    this.look = look;
    this.field = null;
    this.#lookChanged = true;
    this.#resetCost();
    if (!look) this.releaseTextures();
    this.mode.update({ weather: look !== null, particles: look?.particles != null }, this.#now());
    // A new look makes its textures on its first draws, a stall the step-down must not judge (mode.ts lookChanged).
    if (look) this.mode.lookChanged(this.#now());
    this.#settle();
  }

  sceneLoaded(): void {
    this.mode.sceneLoaded(this.#now());
    this.#settle();
  }

  /**
   * A layer whose tree shows. The newest one ticks: a view switch registers
   * the shown tree's before the hidden one lets go. A registration is a
   * remount for the step-down (6.3), so no window holds the stall.
   */
  register(target: WeatherTarget): () => void {
    this.#targets.push(target);
    this.#resetCost();
    this.mode.remounted(this.#now());
    this.mode.update({ layer: true }, this.#now());
    this.#settle();
    return () => {
      const i = this.#targets.indexOf(target);
      if (i >= 0) this.#targets.splice(i, 1);
      this.mode.update({ layer: this.#targets.length > 0 }, this.#now());
      this.#settle();
    };
  }

  /** The textures go when the scene clears or the device turns weather off (6.4). */
  releaseTextures(): void {
    this.textures?.release();
    this.textures = null;
  }

  /** Stops the loop and lets the textures go. Not for good: React's development double mount keeps using the room, and its next input starts the loop again. */
  dispose(): void {
    if (this.#frame !== null) this.#frames.cancel(this.#frame);
    this.#frame = null;
    this.#unlisten?.();
    this.#unlisten = null;
    this.releaseTextures();
    this.field = null;
  }

  #shown(): WeatherShown {
    const m = this.mode;
    const look = m.mounted ? this.look : null;
    return { mounted: m.mounted, effective: m.effective, looping: m.looping, level: m.level, key: look?.key ?? null, toward: look?.toward ?? null };
  }

  /** Publishes what changed and starts or stops the loop to match. Each frame calls it, so it builds nothing unless the mode moved. */
  #settle(): void {
    if (this.mode.version !== this.#version || this.#lookChanged) {
      this.#version = this.mode.version;
      this.#lookChanged = false;
      const next = this.#shown();
      const was = this.state.getState();
      if (next.mounted !== was.mounted || next.effective !== was.effective || next.looping !== was.looping || next.level !== was.level || next.key !== was.key || next.toward !== was.toward) this.state.setState(next, true);
      if (this.mode.input.setting === "off") this.releaseTextures();
    }
    const loop = this.mode.looping;
    if (loop && this.#frame === null) this.#frame = this.#frames.request(this.#run);
    if (!loop && this.#frame !== null) {
      this.#frames.cancel(this.#frame);
      this.#frame = null;
    }
    // Gestures matter only to the cost measure, so the listener lives as long as the loop.
    if (loop) this.#unlisten ??= this.#board.listen(this.#onGesture);
    else if (this.#unlisten) {
      this.#unlisten();
      this.#unlisten = null;
    }
  }

  readonly #onGesture = (target: EventTarget | null): void => {
    if (this.#targets.at(-1)?.onBoard?.(target) === false) return;
    this.#gestured = true;
  };

  /**
   * The board's gesture work since the last frame started: whether its
   * camera changed, from wherever, and whether a pointer, touch or wheel
   * moved over it. And whether input has gone on for LONG_INPUT_MS with no
   * pause.
   */
  #moves(time: number): Pick<FrameSeen, "camera" | "input" | "long"> {
    const now = this.#targets.at(-1)?.camera?.() ?? null;
    const camera = now !== null && (this.#camera === null || !sameCamera(now, this.#camera));
    this.#camera = now;
    const input = this.#gestured;
    this.#gestured = false;
    if (camera || input) {
      if (this.#inputAt === null || time - this.#inputAt > INPUT_PAUSE_MS) this.#inputFrom = time;
      this.#inputAt = time;
    }
    const long = this.#inputAt !== null && time - this.#inputAt <= INPUT_PAUSE_MS && time - this.#inputFrom >= LONG_INPUT_MS;
    return { camera, input, long };
  }

  /**
   * One loop frame. A 2D canvas with no GPU rasters at paint, after the
   * sceneFunc: a software canvas cost 60 to 230 ms a second at 4x slowdown
   * while its sceneFunc stayed under 0.1 ms (bench --software). So each
   * frame is timed from its start to a task after its paint, and a tick's
   * cost is its frame less the frames beside it (#measured).
   */
  readonly #run = (time: number): void => {
    this.#frame = null;
    const start = this.#now();
    // A measure still out when the next frame starts ran past it, so it holds that frame's work too and says nothing.
    const last = this.#recent.at(-1);
    if (last && !last.settled) this.#measured(last);
    const moves = this.#moves(time);
    const due = (this.#ticksInARow >= SAMPLE_AFTER || this.#unmatched >= SAMPLE_AFTER) && this.mode.wantsCosts;
    if (!due) this.#putOff = null;
    else this.#putOff ??= this.#barren > 0 && moves.long ? this.#draw() : 0;
    const holds = this.mode.holds;
    const ms = this.mode.frame(time, due && this.#putOff === 0);
    if (this.mode.holds !== holds) {
      // A hold makes the like frames the ticks around it wait for, so the count starts again, and the next frame ticks.
      this.#unmatched = 0;
      this.#barren++;
      this.#putOff = null;
    } else if (due && ms !== null) this.#putOff!--;
    const ticked = ms !== null && this.#targets.length > 0;
    if (ms !== null) this.#targets[this.#targets.length - 1]?.tick(ms);
    this.#ticksInARow = ticked ? this.#ticksInARow + 1 : 0;
    const seen: FrameSeen = { at: time, ticked, spent: null, settled: false, ...moves, inputBefore: this.#recent.at(-1)?.input ?? false, map: null, judged: !ticked };
    this.#recent.push(seen);
    if (this.#recent.length > RECENT_FRAMES) this.#recent.shift();
    this.#settle();
    this.#afterFrame(() => {
      if (seen.settled) return;
      seen.spent = this.#now() - start;
      this.#measured(seen);
    });
  };

  /**
   * A frame's measure is in, or never will be. The tick before it now has
   * both its neighbors, and a tick that waits for a like frame up to
   * LONG_INPUT_REACH frames off has that one (#judge).
   */
  #measured(seen: FrameSeen): void {
    seen.settled = true;
    // The map draws in a frame's rendering, before the paint this measure follows, so what the count gained since the last measure is this frame's.
    const draws = this.#board.mapDraws();
    const changed = draws !== this.#mapDraws;
    if (seen.spent === null) {
      // Settled as the next frame started, whose draw may already be counted: whose it was is unknown, so the count waits for the next measure.
      seen.map = changed ? null : false;
      this.#mapUnsure ||= changed;
    } else {
      seen.map = !changed ? false : this.#mapUnsure ? null : true;
      this.#mapUnsure = false;
      this.#mapDraws = draws;
    }
    const i = this.#recent.indexOf(seen);
    for (let d = 1; d <= LONG_INPUT_REACH; d++) this.#judge(i - d, d);
  }

  /**
   * What the tick at `t` added to its frame: its own frame less the mean of
   * the like frames beside it, `d` frames off. A like frame has no tick and
   * the same board work: a camera change or none, a pointer, touch or wheel
   * move or none, in it and in the frame before, and the animated map drawn
   * in both or in neither. So the dice or the isometric board's background
   * work, which every frame around the tick pays too, cancels out within a
   * frame, and a tick with no like frame beside it says nothing.
   *
   * A short gesture's frames say nothing at all (D-261106-306): its input
   * and its redraw land in the frames around a move, and a pinch or a drag
   * whose moves come every other frame, in step with the ticks, put the
   * whole redraw on the ticks and none on their neighbors, which stepped a
   * GPU canvas down. Input that goes on past LONG_INPUT_MS would hide a slow
   * canvas for as long as it lasts, so from there its frames are matched as
   * the map's are (D-261106-357). Where every frame moves, the redraw is
   * common to all of them and cancels out. Where moves skip frames, their
   * redraw lands in the move's frame or the next (a React render can run
   * after the paint), and a camera change shows in the frame it redraws in,
   * which the kind of frame tells apart.
   *
   * An animated map can play all session, so its frames are matched, not
   * dropped (WXZOOM-ASTRA-05). A 30 fps map on a 60 Hz screen draws every
   * other frame, so with the map playing a tick with no like frame next to
   * it waits for one two frames off, and with long input up to
   * LONG_INPUT_REACH. Where none comes, the loop holds a tick to make one
   * (SAMPLE_AFTER).
   */
  #judge(t: number, d: number): void {
    const tick = this.#recent[t];
    if (!tick || tick.judged) return;
    const nearMove = moved(tick) || moved(this.#recent[t - 1]) || moved(this.#recent[t + 1]);
    if (tick.spent === null || tick.map === null || (nearMove && !tick.long)) {
      tick.judged = true;
      return;
    }
    const gap = medianGap(this.#recent);
    // Within half a frame of `d` frames off, so no frame was dropped between them.
    const like = (f: FrameSeen | undefined): f is FrameSeen =>
      f !== undefined &&
      !f.ticked &&
      f.spent !== null &&
      f.camera === tick.camera &&
      f.input === tick.input &&
      f.inputBefore === tick.inputBefore &&
      f.map === tick.map &&
      Math.abs(f.at - tick.at) <= gap * (d + 0.5);
    const beside = [this.#recent[t - d], this.#recent[t + d]].filter(like);
    if (beside.length === 0) {
      if (d < (tick.long ? LONG_INPUT_REACH : this.#recent.some((f) => f.map === true) ? 2 : 1)) return;
      tick.judged = true;
      this.#unmatched++;
      return;
    }
    tick.judged = true;
    this.#unmatched = 0;
    this.#barren = 0;
    const cost = Math.max(0, tick.spent - beside.reduce((sum, f) => sum + f.spent!, 0) / beside.length);
    this.mode.added(cost, tick.at);
    this.#added.push(cost);
    if (this.#added.length > COST_TICKS) this.#added.shift();
    if (this.#added.length >= MIN_TICKS) this.frameCost = median(this.#added);
  }

  /** A draw of 0 to 3 from a fixed seed, so a run repeats. */
  #draw(): number {
    this.#seed = (Math.imul(this.#seed, 1664525) + 1013904223) >>> 0;
    return this.#seed >>> 30;
  }

  /** A new look, layer or stage starts its cost afresh, as the step-down's warm-up does. */
  #resetCost(): void {
    this.frameCost = 0;
    this.#recent.length = 0;
    this.#added.length = 0;
    this.#ticksInARow = 0;
    this.#unmatched = 0;
    this.#barren = 0;
    this.#putOff = null;
    this.#mapDraws = this.#board.mapDraws();
    this.#mapUnsure = false;
  }
}

/**
 * One loop frame as the cost measure sees it.
 * - `spent`: its main thread time from its start to after its paint, null until measured or when the next frame came first.
 * - `camera`, `input`: whether the board's camera changed, and whether a pointer, touch or wheel moved over it, since the frame before started.
 * - `inputBefore`: the frame before's `input`, since a move's redraw can land a frame late.
 * - `long`: input had gone on for LONG_INPUT_MS with no pause as the frame started.
 * - `map`: whether the animated map drew in it, null until measured or when that cannot be told.
 * - `judged`: its tick, if any, is judged.
 */
type FrameSeen = {
  at: number;
  ticked: boolean;
  spent: number | null;
  settled: boolean;
  camera: boolean;
  input: boolean;
  inputBefore: boolean;
  long: boolean;
  map: boolean | null;
  judged: boolean;
};

function moved(frame: FrameSeen | undefined): boolean {
  return frame !== undefined && (frame.camera || frame.input);
}

/** How a task after the frame's rendering is asked for: a message, which runs after paint and before the next frame. */
export type AfterFrame = (run: () => void) => void;

function browserAfterFrame(): AfterFrame {
  if (typeof MessageChannel === "undefined") return (run) => setTimeout(run, 0);
  const channel = new MessageChannel();
  const queue: (() => void)[] = [];
  channel.port1.onmessage = () => queue.shift()?.();
  return (run) => {
    queue.push(run);
    channel.port2.postMessage(null);
  };
}

/** The frames kept for a tick's neighbours and the length of one frame. */
const RECENT_FRAMES = 16;
/** The ticks `frameCost` is the median of, and how many it needs first. */
const COST_TICKS = 15;
const MIN_TICKS = 5;
/**
 * Input with no pause this long is one gesture going on, and one going on
 * this long is judged, not dropped (#judge, D-261106-357). A pinch, a pan
 * or a drag takes under a second (the bench's take 0.35 to 1 s), so each
 * stays whole in the exclusion, and a slow canvas under input that never
 * pauses still steps down within its first windows after it: the warm-up
 * is 2 s and a window 3 s. A pause of a quarter second is longer than the
 * gap between moves of any finger, mouse or wheel still moving, and shorter
 * than the pause between two gestures.
 */
const LONG_INPUT_MS = 2000;
const INPUT_PAUSE_MS = 250;
/**
 * How many frames off a like frame for a tick in long input may be. Moves
 * in two frames of three, or on every fourth frame in step with a 30 fps
 * map at 60 Hz, leave a tick's kind of frame three or four frames off, and
 * moves on every third frame beside a 30 fps map at 60 Hz six frames off.
 */
const LONG_INPUT_REACH = 6;
/**
 * Ticks in a row before the loop holds one (mode.ts `frame`'s hold), while
 * the window wants costs (mode.ts `wantsCosts`). At 33 frames a second or
 * fewer every frame ticks, so no frame shows the board without the weather.
 * Holding one in four there gives each hold two ticks to measure. One in
 * eight left a board whose frames vary by up to 8 ms stepping down healthy
 * phones within minutes, and with two slow windows in a row (mode.ts) one
 * in four keeps them moving (WXB-R2-1). A held frame shows the particles one
 * frame longer, so a window stops holding once its costs are in and well
 * under the limit, a few holds a window on a settled healthy device, and the
 * next tick steps the whole gap (mode.ts HELD_STEP_MS), so they keep their
 * speed (WXB-R3-1).
 *
 * At 60 or 120 Hz ticks skip frames, so the frames between them are their
 * like frames, until an animated map plays. In step with the ticks at
 * 60 Hz, every tick is a map frame and every frame between is empty, and
 * out of step every frame between is the map's. Neither has a like frame,
 * so the same count of ticks in a row with none (`#unmatched`) holds one
 * too: a hold on a map frame leaves a frame where only the map drew, the
 * next tick lands a frame later, out of step, and the frames on either
 * side of the hold are like frames for the ticks around it. Long input
 * whose moves skip frames in step with the ticks holds them the same way,
 * and where its holds make no like frame, their beat moves (`#barren`).
 */
export const SAMPLE_AFTER = 3;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The usual time between the loop's frames, which a dropped frame does not move. */
function medianGap(frames: readonly FrameSeen[]): number {
  const gaps: number[] = [];
  for (let k = 1; k < frames.length; k++) gaps.push(frames[k]!.at - frames[k - 1]!.at);
  return median(gaps);
}

/** One per Room page, so View as a player keeps a clock of its own. */
export const weatherSlot = scopeSlot(
  () => new WeatherRoom(),
  (room) => room.dispose(),
);

// ---------------------------------------------------------------- what decides it, outside the room

function mediaStore(query: string): { get(): boolean; subscribe(listener: () => void): () => void } {
  const list = typeof matchMedia === "function" ? matchMedia(query) : null;
  return {
    get: () => list?.matches ?? false,
    subscribe(listener) {
      list?.addEventListener("change", listener);
      return () => list?.removeEventListener("change", listener);
    },
  };
}

const reduced = mediaStore("(prefers-reduced-motion: reduce)");

/** The browser's reduced-motion setting, read live (8). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(reduced.subscribe, reduced.get, () => false);
}

function visibleNow(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function subscribeVisibility(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** Whether the page shows: a hidden tab or a locked phone stops the weather. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, visibleNow, () => true);
}

/**
 * View as a player over the DM's room (features/dm/PlayerPreview.tsx): the
 * DM's own board is covered, so its weather waits, and the preview's own
 * board draws its own. A count, since nothing stops two at once.
 */
const covers = createStore<{ count: number }>(() => ({ count: 0 }));

/** Called by the preview as it shows. Returns the call that ends it. */
export function coverRoomForPreview(): () => void {
  covers.setState((s) => ({ count: s.count + 1 }));
  return () => covers.setState((s) => ({ count: s.count - 1 }));
}

/** Whether a preview covers this room: never for the preview's own room. */
export function useCoveredByPreview(insidePreview: boolean): boolean {
  const count = useStore(covers, (s) => s.count);
  return !insidePreview && count > 0;
}

// ---------------------------------------------------------------- This device

/** This device's three cards (4.3). */
export const WEATHER_CARDS: readonly RadioCardOption<WeatherSettingValue>[] = [
  { value: "moving", label: WEATHER_MODE_WORDS.moving, help: "Rain falls, snow drifts and fog rolls. Uses more battery." },
  { value: "still", label: WEATHER_MODE_WORDS.still, help: "Shows the weather without moving it." },
  { value: "off", label: WEATHER_MODE_WORDS.off, help: "No weather on this device. Rolls still follow it." },
];

export const STILL_REDUCED = "Reduced motion keeps weather still.";
export const STILL_LOW_POWER = "Low power keeps weather still.";
export const STILL_SLOW = "Weather was slowing the map, so it stays still until you reload.";

/** What keeps the weather still though Moving is chosen, in This device's words, or null. */
export function weatherStillReason(input: { reducedMotion: boolean; lowPower: boolean; level: StepLevel }): string | null {
  if (input.reducedMotion) return STILL_REDUCED;
  if (input.lowPower) return STILL_LOW_POWER;
  if (input.level === "still") return STILL_SLOW;
  return null;
}

const NO_ROOM = createStore<WeatherShown>(() => ({ mounted: false, effective: "off", looping: false, level: "full", key: null, toward: null }));

/** This device's help line under its cards: it reads the room's step-down where a room is open. */
export function useWeatherStillReason(): string | null {
  const room = useScopedIfAny(weatherSlot);
  const level = useStore(room?.state ?? NO_ROOM, (s) => s.level);
  return weatherStillReason({ reducedMotion: useReducedMotion(), lowPower: useLowPower(), level });
}
