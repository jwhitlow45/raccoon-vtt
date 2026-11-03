import { useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { RadioCardOption } from "../../components/RadioCards.tsx";
import { scopeSlot, useScopedIfAny } from "../../state/scope.ts";
import { useLowPower, WEATHER_MODE_WORDS, type WeatherMode as WeatherSettingValue } from "../device/settings.ts";
import { sameLook, type Look } from "./looks.ts";
import { WeatherMode, type ModeInput, type StepLevel } from "./mode.ts";
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

/** A weather layer that shows: its tick steps the field and draws its Konva layer at once, in the same frame. */
export type WeatherTarget = { tick(ms: number): void };

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
  readonly #targets: WeatherTarget[] = [];
  #frame: number | null = null;
  #version = -1;
  #lookChanged = false;

  constructor(frames: Frames = BROWSER_FRAMES, now: () => number = () => performance.now(), afterFrame?: AfterFrame) {
    this.#frames = frames;
    this.#now = now;
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
    const ms = this.mode.frame(time, this.#ticksInARow >= SAMPLE_AFTER);
    const ticked = ms !== null && this.#targets.length > 0;
    if (ms !== null) this.#targets[this.#targets.length - 1]?.tick(ms);
    this.#ticksInARow = ticked ? this.#ticksInARow + 1 : 0;
    const seen: FrameSeen = { at: time, ticked, spent: null, settled: false };
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
   * both its neighbours: its cost is its own frame less the mean of the
   * frames on either side of it with no tick, each within about one frame
   * of it. So a pan, a drag, the dice or the isometric board's background
   * work, which every frame around the tick pays too, cancels out within a
   * frame, and a tick with no such neighbour says nothing.
   */
  #measured(seen: FrameSeen): void {
    seen.settled = true;
    const i = this.#recent.indexOf(seen);
    const tick = this.#recent[i - 1];
    if (!tick?.ticked || tick.spent === null) return;
    const frame = medianGap(this.#recent);
    const beside = [this.#recent[i - 2], seen].filter((f): f is FrameSeen => f !== undefined && !f.ticked && f.spent !== null && Math.abs(f.at - tick.at) <= frame * NEIGHBOUR_FRAMES);
    if (beside.length === 0) return;
    const cost = Math.max(0, tick.spent - beside.reduce((sum, f) => sum + f.spent!, 0) / beside.length);
    this.mode.added(cost, tick.at);
    this.#added.push(cost);
    if (this.#added.length > COST_TICKS) this.#added.shift();
    if (this.#added.length >= MIN_TICKS) this.frameCost = median(this.#added);
  }

  /** A new look, layer or stage starts its cost afresh, as the step-down's warm-up does. */
  #resetCost(): void {
    this.frameCost = 0;
    this.#recent.length = 0;
    this.#added.length = 0;
    this.#ticksInARow = 0;
  }
}

/** One loop frame as the cost measure sees it: its time, whether it ticked, and its main thread time from its start to after its paint, null until measured or when the next frame came first. */
type FrameSeen = { at: number; ticked: boolean; spent: number | null; settled: boolean };

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
/** A neighbour no further from its tick than this many frames, so no frame was dropped between them. */
const NEIGHBOUR_FRAMES = 1.5;
/**
 * Ticks in a row before the loop holds one (mode.ts `frame`'s hold). At 33
 * frames a second or fewer every frame ticks, so no frame shows the board
 * without the weather. Holding one in four there, about seven a second,
 * gives each hold two ticks to measure and a 3 s window about 45. One in
 * eight left a board whose frames vary by up to 8 ms stepping down healthy
 * phones within minutes, and with two slow windows in a row (mode.ts) one
 * in four keeps them moving (WXB-R2-1). A held frame shows the particles one
 * frame longer, which rain and snow hide, and its step is clamped (sim.ts
 * STEP_CLAMP_MS), so they move about an eighth slower there. It never
 * happens at 60 or 120 Hz, where ticks skip frames.
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

export const STILL_REDUCED = "Reduced motion is on for this device, so weather stays still.";
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
