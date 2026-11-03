/**
 * When the weather moves, holds still or does not draw, and when it ticks
 * (the weather design note, 5.2 and 6.3), as one state machine with no
 * clock of its own: every call carries its time, as requestAnimationFrame
 * and performance.now give it. The controller asks it each frame whether to
 * tick, steps the field and draws when it says so, and tells it what each
 * draw cost.
 */

/** This device's choice, `rvtt.weather`. */
export type WeatherSetting = "moving" | "still" | "off";

/** What the weather does on this device now. */
export type Effective = "moving" | "still" | "off";

/** Why the weather holds still though the setting says Moving, for This device's help line. */
export type StillReason = "reducedMotion" | "lowPower" | "slow" | null;

export type ModeInput = {
  setting: WeatherSetting;
  reducedMotion: boolean;
  lowPower: boolean;
  /** The scene shown has weather. */
  weather: boolean;
  /** Its look has particles, so a step-down halves them before it holds still. Fog has none. */
  particles: boolean;
  pageVisible: boolean;
  /** The room's map tree is not frozen. */
  mapShown: boolean;
  /** A weather layer is registered and its tree shows. */
  layer: boolean;
  /** A panel fills the whole screen. */
  covered: boolean;
  /** View as a player stands over the room. */
  preview: boolean;
  /** The scene is still loading. */
  loading: boolean;
  roomOpen: boolean;
  /** The Builder, Fog, Line up grid or Traps tool is in use. */
  setupTool: boolean;
};

/** Ticks come no closer than this: 30 a second on a 60 Hz and a 120 Hz screen alike. */
export const TICK_MS = 30;
/** A step never covers more than this (sim.ts STEP_CLAMP_MS). */
export const TICK_CLAMP_MS = 50;
/** No window counts this soon after a start, a resume, a scene load or a remount. */
export const WARMUP_MS = 2000;
/** The step-down judges ticks in windows this long. */
export const WINDOW_MS = 3000;
/** A window whose median gap between ticks is over this steps down (under 20 a second). */
export const SLOW_GAP_MS = 50;
/** A window whose 95th percentile draw is over this steps down. */
export const SLOW_DRAW_MS = 4;

export type StepLevel = "full" | "half" | "still";

export class WeatherMode {
  #input: ModeInput;
  #level: StepLevel = "full";
  /** Bumped whenever mounted, effective, looping, half or stillReason changes. */
  version = 0;
  /** Ticks, and draws no tick started (a camera change, a mount), counted apart. */
  ticks = 0;
  cameraDraws = 0;

  constructor(input: ModeInput, now: number) {
    this.#input = { ...input };
    void now;
  }

  get input(): Readonly<ModeInput> {
    return this.#input;
  }

  /** Any change of what decides the mode. A change that makes the weather show again restarts the warm-up. */
  update(patch: Partial<ModeInput>, now: number): void {
    this.#input = { ...this.#input, ...patch };
    void now;
  }

  /** The scene finished loading: the warm-up restarts and the window so far is dropped. */
  sceneLoaded(now: number): void {
    void now;
  }

  /** The stage remounted (Low power, interface size): the same as a scene load. */
  remounted(now: number): void {
    void now;
  }

  /**
   * A frame at `now`. Returns the ms to step the field by when this frame
   * ticks, else null. A tick's draw must follow in the same frame, and its
   * `drew` is counted as the tick's.
   */
  frame(now: number): number | null {
    void now;
    return null;
  }

  /** A sceneFunc run took `ms`. Says whether a tick started it or something else did. */
  drew(ms: number): "tick" | "camera" {
    void ms;
    this.cameraDraws++;
    return "camera";
  }

  /** The step-down so far: it only goes down, until the page reloads. */
  get level(): StepLevel {
    return this.#level;
  }

  /** A weather layer exists: the scene has weather, the device draws it, no setup tool, the page shows. */
  get mounted(): boolean {
    return false;
  }

  get effective(): Effective {
    return "off";
  }

  /** The frame loop should run: Moving and seen. */
  get looping(): boolean {
    return false;
  }

  /** Draw half the particles (sim.ts setHalf). */
  get half(): boolean {
    return this.#level === "half";
  }

  get stillReason(): StillReason {
    return null;
  }
}
