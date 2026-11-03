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
  /** A weather layer is registered and its tree shows, so a frozen map tree, or a room closed, has none. */
  layer: boolean;
  /** A panel fills the whole screen. */
  covered: boolean;
  /** View as a player stands over the room. */
  preview: boolean;
  /** The scene is still loading. */
  loading: boolean;
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

/** A gap this long between ticks is a stall, not slowness: it drops its window and warms up again. */
export const STALL_MS = 1000;

export type StepLevel = "full" | "half" | "still";

const LEVELS: readonly StepLevel[] = ["full", "half", "still"];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

export class WeatherMode {
  #input: ModeInput;
  #level: StepLevel = "full";
  #looping = false;
  #lastTick: number | null = null;
  /** No window opens before this. */
  #warmUntil = 0;
  /** When the window being judged opened, or null while none is open. */
  #windowAt: number | null = null;
  #gaps: number[] = [];
  #draws: number[] = [];
  /** The next draw is the tick's: set by a ticking frame, spent by `drew`, cleared by the next frame. */
  #tickDraw = false;
  #tickInWindow = false;
  #outputs = "";
  /** Bumped whenever mounted, effective, looping, half or stillReason changes. */
  version = 0;
  /** Ticks, and draws no tick started (a camera change, a mount), counted apart. */
  ticks = 0;
  cameraDraws = 0;

  constructor(input: ModeInput, now: number) {
    this.#input = { ...input };
    this.#settle(now);
  }

  get input(): Readonly<ModeInput> {
    return this.#input;
  }

  /** Any change of what decides the mode. A change that makes the weather show again restarts the warm-up. */
  update(patch: Partial<ModeInput>, now: number): void {
    this.#input = { ...this.#input, ...patch };
    this.#settle(now);
  }

  /** The scene finished loading: the warm-up restarts and the window so far is dropped. */
  sceneLoaded(now: number): void {
    this.#restart(now);
  }

  /** The stage remounted (Low power, interface size): the same as a scene load. */
  remounted(now: number): void {
    this.#restart(now);
  }

  /** The scene's weather changed while it shows: a new look makes its textures, so the warm-up restarts. */
  lookChanged(now: number): void {
    this.#restart(now);
  }

  /**
   * A frame at `now`. Returns the ms to step the field by when this frame
   * ticks, else null. A tick's draw must follow in the same frame, and its
   * `drew` is counted as the tick's.
   */
  frame(now: number): number | null {
    this.#tickDraw = false;
    if (!this.#looping) return null;
    const last = this.#lastTick;
    if (last !== null && now - last < TICK_MS) return null;
    if (last !== null && now - last >= STALL_MS) {
      // A stall is a pause the page never announced, a map decoding or a tab coming back: its window is dropped, as a pause's is.
      this.#restart(now);
    } else if (this.#windowAt !== null && now - this.#windowAt >= WINDOW_MS) {
      this.#judge(now);
      if (!this.#looping) return null;
    } else if (this.#windowAt !== null && last !== null) this.#gaps.push(now - last);
    if (this.#windowAt === null && now >= this.#warmUntil) this.#open(now);
    this.#lastTick = now;
    this.ticks++;
    this.#tickDraw = true;
    this.#tickInWindow = this.#windowAt !== null;
    // The first tick after a start draws at once and moves nothing: the field shows where it stood.
    return last === null ? 0 : Math.min(TICK_CLAMP_MS, now - last);
  }

  /** A sceneFunc run took `ms`. Says whether a tick started it or something else did. */
  drew(ms: number): "tick" | "camera" {
    if (this.#tickDraw) {
      this.#tickDraw = false;
      if (this.#tickInWindow && this.#windowAt !== null) this.#draws.push(ms);
      return "tick";
    }
    this.cameraDraws++;
    return "camera";
  }

  /** The step-down so far: it only goes down, until the page reloads. */
  get level(): StepLevel {
    return this.#level;
  }

  /** A weather layer exists: the scene has weather, the device draws it, no setup tool, the page shows. */
  get mounted(): boolean {
    const i = this.#input;
    return i.weather && i.setting !== "off" && !i.setupTool && i.pageVisible;
  }

  get effective(): Effective {
    const i = this.#input;
    if (!i.weather || i.setting === "off") return "off";
    if (i.setting === "still" || i.reducedMotion || i.lowPower || this.#level === "still") return "still";
    return "moving";
  }

  /** The frame loop should run: Moving and seen. */
  get looping(): boolean {
    return this.#looping;
  }

  /** Draw half the particles (sim.ts setHalf). */
  get half(): boolean {
    return this.#level === "half";
  }

  get stillReason(): StillReason {
    const i = this.#input;
    if (i.setting === "off") return null;
    if (i.reducedMotion) return "reducedMotion";
    if (i.lowPower) return "lowPower";
    if (this.#level === "still") return "slow";
    return null;
  }

  /** Seen: every reason it would stop is absent (5.2's "stops when unseen"). */
  #seen(): boolean {
    const i = this.#input;
    return this.mounted && i.layer && !i.covered && !i.preview && !i.loading;
  }

  #settle(now: number): void {
    const looping = this.effective === "moving" && this.#seen();
    if (looping !== this.#looping) {
      this.#looping = looping;
      // A start or a resume begins fresh, and a pause drops the window it fell in.
      this.#lastTick = null;
      this.#tickDraw = false;
      if (looping) this.#restart(now);
      else this.#close();
    }
    const outputs = `${this.mounted} ${this.effective} ${this.#looping} ${this.half} ${this.stillReason}`;
    if (outputs !== this.#outputs) {
      this.#outputs = outputs;
      this.version++;
    }
  }

  #restart(now: number): void {
    this.#warmUntil = now + WARMUP_MS;
    this.#close();
  }

  #open(now: number): void {
    this.#windowAt = now;
    this.#gaps = [];
    this.#draws = [];
  }

  #close(): void {
    this.#windowAt = null;
    this.#gaps = [];
    this.#draws = [];
    this.#tickInWindow = false;
  }

  /** A full window: too slow steps down once, and the next window opens here either way. */
  #judge(now: number): void {
    const slow = (this.#gaps.length > 0 && median(this.#gaps) > SLOW_GAP_MS) || (this.#draws.length > 0 && p95(this.#draws) > SLOW_DRAW_MS);
    if (slow) {
      const next = this.#input.particles && this.#level === "full" ? "half" : "still";
      this.#level = LEVELS[Math.max(LEVELS.indexOf(this.#level), LEVELS.indexOf(next))]!;
      this.#restart(now);
      this.#settle(now);
      return;
    }
    this.#open(now);
  }
}
