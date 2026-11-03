import { useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { RadioCardOption } from "../../components/RadioCards.tsx";
import { scopeSlot, useScopedIfAny } from "../../state/scope.ts";
import { useLowPower, WEATHER_MODE_WORDS, type WeatherMode as WeatherSettingValue } from "../device/settings.ts";
import type { Look } from "./looks.ts";
import { WeatherMode, type ModeInput, type StepLevel } from "./mode.ts";
import type { Field } from "./sim.ts";
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
};

const IDLE: ModeInput = {
  setting: "moving",
  reducedMotion: false,
  lowPower: false,
  weather: false,
  particles: false,
  pageVisible: true,
  mapShown: true,
  layer: false,
  covered: false,
  preview: false,
  loading: false,
  roomOpen: true,
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
  readonly #frames: Frames;
  readonly #now: () => number;
  readonly #targets: WeatherTarget[] = [];
  #frame: number | null = null;
  #version = -1;
  #lookChanged = false;

  constructor(frames: Frames = BROWSER_FRAMES, now: () => number = () => performance.now()) {
    this.#frames = frames;
    this.#now = now;
    this.mode = new WeatherMode(IDLE, now());
    this.state = createStore<WeatherShown>(() => this.#shown());
    this.#version = this.mode.version;
  }

  /** What decides the mode changed: the setting, the scene, the page, a tool, a panel. */
  input(patch: Partial<ModeInput>): void {
    this.mode.update(patch, this.#now());
    this.#settle();
  }

  /** A new look, or none: a new look drops the field, so the layer makes one for it. */
  setLook(look: Look | null): void {
    if ((look?.key ?? null) === (this.look?.key ?? null)) {
      this.look = look;
      return;
    }
    this.look = look;
    this.field = null;
    this.#lookChanged = true;
    if (!look) this.releaseTextures();
    this.mode.update({ weather: look !== null, particles: look?.particles != null }, this.#now());
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
    return { mounted: m.mounted, effective: m.effective, looping: m.looping, level: m.level, key: m.mounted ? (this.look?.key ?? null) : null };
  }

  /** Publishes what changed and starts or stops the loop to match. Each frame calls it, so it builds nothing unless the mode moved. */
  #settle(): void {
    if (this.mode.version !== this.#version || this.#lookChanged) {
      this.#version = this.mode.version;
      this.#lookChanged = false;
      const next = this.#shown();
      const was = this.state.getState();
      if (next.mounted !== was.mounted || next.effective !== was.effective || next.looping !== was.looping || next.level !== was.level || next.key !== was.key) this.state.setState(next, true);
      if (this.mode.input.setting === "off") this.releaseTextures();
    }
    const loop = this.mode.looping;
    if (loop && this.#frame === null) this.#frame = this.#frames.request(this.#run);
    if (!loop && this.#frame !== null) {
      this.#frames.cancel(this.#frame);
      this.#frame = null;
    }
  }

  readonly #run = (time: number): void => {
    this.#frame = null;
    const ms = this.mode.frame(time);
    if (ms !== null) this.#targets[this.#targets.length - 1]?.tick(ms);
    this.#settle();
  };
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

const NO_ROOM = createStore<WeatherShown>(() => ({ mounted: false, effective: "off", looping: false, level: "full", key: null }));

/** This device's help line under its cards: it reads the room's step-down where a room is open. */
export function useWeatherStillReason(): string | null {
  const room = useScopedIfAny(weatherSlot);
  const level = useStore(room?.state ?? NO_ROOM, (s) => s.level);
  return weatherStillReason({ reducedMotion: useReducedMotion(), lowPower: useLowPower(), level });
}
