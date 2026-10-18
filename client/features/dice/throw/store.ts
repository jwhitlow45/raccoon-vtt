import type { DiceRoll } from "#shared/model.ts";
import type { Clock } from "../../../state/timing.ts";
import { rollsOf } from "../logic.ts";
import type { ReceiptState, ReceiptTracker } from "../useReceipt.ts";
import { planTray, seededRandom, tapDice, type DieKind, type TrayPlan } from "./layout.ts";
import type { LoadState } from "./probe.ts";

/**
 * The roll animation's state for one Room (docs/design-v1-roll-animation.md
 * 3 to 7): which taps may throw, the throw on screen, the 1 s timer that
 * shows its result, every interruption, the warm-up, a lost context and
 * the renderer's disposal. It never imports three: the stage arrives from
 * the lazy chunk through the loader, and everything it needs from the page
 * comes in as inputs, so the rules run under plain Node.
 *
 * It decides at the commit, before React renders. The room store applies
 * the `ev`, then tells the receipt tracker in the same task, and the
 * tracker calls this store's listener at once. So by the first render after
 * the commit the throw has started or the result shows: the header line and
 * Recent rolls read `held(tag)` during that render, and a total never
 * shows for one frame and then goes.
 *
 * The result shows by its own timer, never by the animation: 1 s after the
 * answer whatever frames the device drops, and at once on any interruption.
 */

/** What a Dice panel control hands its roll: where the tap was, and when. */
export type ThrowOrigin = { surface: "dice"; element: Element | null; tapAt: number };

/** The dice land this long after the answer reaches the device. */
export const LAND_MS = 1000;
/** The dice and the scrim have faded by then, and go. */
export const GONE_MS = 2100;
/** An answer this late after its tap shows at once: it has waited once already. */
export const LATE_MS = 3000;
/** "Rolling…" shows during a throw when the tap was this long before its answer, as the header line's own delayed indicator would have. */
export const ROLLING_MS = 200;
/** The renderer goes this long after the Dice panel closes. */
export const DISPOSE_MS = 30_000;
/** A pointer up with no click after it within this long was a scroll or a drag, and the result shows then. */
export const CLICK_WAIT_MS = 300;
/** A control pressed this recently is the one whose roll is being sent. */
export const PRESS_MS = 1000;
/** The warm-up runs in a quiet moment, and within this long after the panel opens. */
export const WARM_MAX_MS = 1500;
/** A pane shorter than this cannot hold the header line and the tray, and shows the result at once. */
export const MIN_PANE_PX = 160;

/** The tray's place on screen, all in screen px (getBoundingClientRect's, which include the panel's zoom). */
export type TrayGeometry = {
  /** The header line's width, which the tray takes. */
  width: number;
  /** The tray and the strip below it down to the control that rolled, within the pane's visible rect. */
  height: number;
  /** The panel's zoom, the interface size's: the canvas's CSS size is the screen size divided by it. */
  zoom: number;
  /** The middle of the control that rolled, from the tray's top left corner, or null to throw from the tray's lower right. */
  from: { x: number; y: number } | null;
};

/** One throw as the stage draws it. `parent` is the element its canvas hangs in. */
export type StagedThrow = { tag: string; plan: TrayPlan; geometry: TrayGeometry; reduced: boolean; set: string; parent: unknown };

/**
 * The stage, made by the lazy chunk. `play` draws from now: frames until
 * the dice have landed and dimmed, then none, by its own loop. `stop` takes
 * the dice away at once and ends any loop. `dispose` lets the renderer go,
 * on purpose, which never counts as a lost context.
 */
export type Stage = {
  warm(kinds: readonly DieKind[], set: string): Promise<void>;
  play(t: StagedThrow): void;
  stop(): void;
  dispose(): void;
};

/** What the stage tells the store. A loss the stage caused itself says so. */
export type StageEvents = { lost(deliberate: boolean): void; restored(): void };

export type StageModule = { createStage(events: StageEvents): Stage | null };

/** The Dice panel, while it is mounted: which dice to warm up. */
export type PanelHost = {
  /** The kinds of the dice in Recent rolls, so the first throw of each finds its texture drawn. */
  kinds(): DieKind[];
};

/**
 * The tray under the header line, while it is mounted. The header line
 * comes with the panel's first roll and goes while the group save page
 * shows, so it comes and goes apart from the panel.
 */
export type TrayHost = {
  /** The tray for a throw from `origin`, or null where the pane is too short to hold it. */
  measure(origin: ThrowOrigin): TrayGeometry | null;
  /** Where the canvas hangs. */
  parent: unknown;
};

/** What stops or allows a throw, from the device's settings and the page. */
export type ThrowInputs = {
  /** "Roll animation" in This device. */
  on: boolean;
  lowPower: boolean;
  /** prefers-reduced-motion: the dice at rest, with the result at once. */
  reducedMotion: boolean;
  /** View as a player: a preview never warms up or throws. */
  preview: boolean;
  /** The dice set, by id. */
  set: string;
};

export type ThrowEnv = {
  clock: Clock;
  idle(cb: () => void, maxMs: number): () => void;
  tracker: Pick<ReceiptTracker, "state" | "subscribe">;
  loader: { loaded(): StageModule | null; state(): LoadState; subscribe(listener: () => void): () => void };
  /** The page is hidden. */
  hidden(): boolean;
};

/** The throw on screen, for the tray's scrim, rings and disc. */
export type ShownThrow = { id: number; tag: string; plan: TrayPlan; geometry: TrayGeometry; reduced: boolean; set: string; startedAt: number };

export type ThrowView = {
  /** The tag whose result waits for the dice to land. */
  held: string | null;
  /** The header line says "Rolling…" while it waits. */
  rolling: boolean;
  shown: ShownThrow | null;
};

type Pending = { origin: ThrowOrigin; mount: number; checked: boolean; seq: number };

const QUIET: ThrowView = { held: null, rolling: false, shown: null };

/** One tap, one creature: rolls for several creatures show at once. */
function oneCreature(rolls: readonly DiceRoll[]): boolean {
  const who = new Set(rolls.map((r) => r.tokenId ?? (r.characterId !== undefined ? `c:${r.characterId}` : "")));
  return who.size <= 1;
}

export class ThrowStore {
  #env: ThrowEnv | null = null;
  #inputs: ThrowInputs = { on: true, lowPower: false, reducedMotion: false, preview: false, set: "ivory" };
  #view: ThrowView = QUIET;
  #listeners = new Set<() => void>();
  #pending = new Map<string, Pending>();
  #unsubscribe: (() => void)[] = [];

  #panel: PanelHost | null = null;
  #tray: TrayHost | null = null;
  /** Moves on every mount, so a tap made under one mount never throws under the next. */
  #mount = 0;
  #stage: Stage | null = null;
  #stageEvents: StageEvents | null = null;
  #warm: "cold" | "warming" | "warm" = "cold";
  /** Moves whenever a warm-up under way stops counting. */
  #warmRun = 0;
  #cancelIdle: (() => void) | null = null;
  #losses = 0;
  /** A real loss not yet restored: nothing warms up on a lost context. */
  #contextLost = false;
  /** The stage could not be made: no WebGL for the session. */
  #noStage = false;
  #seq = 0;

  #throwId = 0;
  #timers: unknown[] = [];
  #disposeTimer: unknown = null;
  #clickTimer: unknown = null;
  /** A pointer took the dice away, and the result waits for its click. */
  #pressed = false;
  /** The control the panel's last pointer or key went to, and when: a roll from it throws from there. */
  #pressedEl: Element | null = null;
  #pressedAt = Number.NEGATIVE_INFINITY;

  /** Binds the store to its Room, once. */
  bind(env: ThrowEnv): void {
    if (this.#env) return;
    this.#env = env;
    this.#unsubscribe.push(env.tracker.subscribe(() => this.#check()));
    this.#unsubscribe.push(env.loader.subscribe(() => this.#maybeWarm()));
  }

  get bound(): boolean {
    return this.#env !== null;
  }

  /** Real context losses so far: after two, no throws for the session. */
  get lostContexts(): number {
    return this.#losses;
  }

  // ------------------------------------------------------------ what React reads

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  view = (): ThrowView => this.#view;

  /** The store's clock, which a throw's `startedAt` is read on. */
  now(): number {
    return this.#env?.clock.now() ?? 0;
  }

  /** Whether this tag's result waits for the dice: the header line and Recent rolls leave it out until they land. */
  held(tag: string | null): boolean {
    return tag !== null && this.#view.held === tag;
  }

  /** The stage, once made: for the dice set picker's previews. */
  get stage(): Stage | null {
    return this.#stage;
  }

  #set(view: ThrowView): void {
    if (view.held === this.#view.held && view.rolling === this.#view.rolling && view.shown === this.#view.shown) return;
    this.#view = view;
    for (const listener of [...this.#listeners]) listener();
  }

  // ------------------------------------------------------------ inputs

  setInputs(patch: Partial<ThrowInputs>): void {
    const before = this.#inputs;
    this.#inputs = { ...before, ...patch };
    const now = this.#inputs;
    // Turning the dice off, Low power on, reduced motion on or a preview ends a throw at once.
    if ((!now.on && before.on) || (now.lowPower && !before.lowPower) || (now.reducedMotion && !before.reducedMotion) || (now.preview && !before.preview)) this.#end();
    this.#maybeWarm();
  }

  get inputs(): ThrowInputs {
    return this.#inputs;
  }

  #allowed(): boolean {
    const i = this.#inputs;
    return i.on && !i.lowPower && !i.preview && !this.#noStage && this.#losses < 2 && this.#env?.loader.state() === "ready";
  }

  // ------------------------------------------------------------ the panel

  /** The Dice panel mounted. The returned function is its unmount, which ends a throw and starts the renderer's 30 s. */
  mount(panel: PanelHost): () => void {
    const env = this.#env;
    this.#panel = panel;
    const mount = ++this.#mount;
    if (this.#disposeTimer !== null && env) env.clock.clearTimeout(this.#disposeTimer);
    this.#disposeTimer = null;
    this.#maybeWarm();
    return () => {
      if (this.#mount !== mount) return;
      this.#panel = null;
      this.#mount++;
      this.#end();
      this.#stopWarming();
      if (this.#stage && env) this.#disposeTimer = env.clock.setTimeout(() => this.#dispose(), DISPOSE_MS);
    };
  }

  /** The tray mounted under the header line. Its unmount, as the group save page opens, ends a throw. */
  attach(tray: TrayHost): () => void {
    this.#tray = tray;
    return () => {
      if (this.#tray !== tray) return;
      this.#tray = null;
      this.#end();
    };
  }

  /** A Dice panel control's roll. A newer roll ends the throw on screen. */
  register(tag: string, origin: ThrowOrigin): void {
    if (origin.surface !== "dice") return;
    this.#end();
    // A few taps in flight at most; an old one that never settled is forgotten.
    if (this.#pending.size > 20) this.#pending.delete(this.#pending.keys().next().value!);
    this.#pending.set(tag, { origin, mount: this.#panel ? this.#mount : -1, checked: false, seq: ++this.#seq });
    // An answer that came inside the send, as the dev room's local server gives, is this tap's commit.
    this.#check();
  }

  /**
   * The origin of the panel tap being handled now: the control its pointer
   * or key went to, if that was just now, so the dice leave from there.
   */
  origin(): ThrowOrigin {
    const now = this.#env?.clock.now() ?? 0;
    return { surface: "dice", element: now - this.#pressedAt < PRESS_MS ? this.#pressedEl : null, tapAt: now };
  }

  #press(target: Element | null): void {
    this.#pressedEl = target;
    this.#pressedAt = this.#env?.clock.now() ?? 0;
  }

  /** A pointer down anywhere in the panel takes the dice away. Its click shows the result, after the browser has chosen what it lands on. */
  pointerDown(target: Element | null = null): void {
    this.#press(target);
    if (this.#view.held !== null) this.#pressed = true;
    if (!this.#view.shown) return;
    this.#stage?.stop();
    this.#set({ ...this.#view, shown: null });
  }

  click(): void {
    this.#release();
  }

  /** A pointer up with no click soon after was a scroll or a drag. */
  pointerUp(): void {
    const env = this.#env;
    if (!this.#pressed || !env) return;
    if (this.#clickTimer !== null) env.clock.clearTimeout(this.#clickTimer);
    this.#clickTimer = env.clock.setTimeout(() => this.#release(), CLICK_WAIT_MS);
  }

  pointerCancel(): void {
    this.#release();
  }

  /** A key down in the panel ends the throw at once. */
  keyDown(target: Element | null = null): void {
    this.#press(target);
    this.#end();
  }

  /** The pane changed size: a rotation, a split moved, a sheet dragged, the keyboard. */
  resized(): void {
    this.#end();
  }

  visibility(hidden: boolean): void {
    if (hidden) {
      this.#end();
      this.#dispose();
    } else this.#maybeWarm();
  }

  /**
   * The Room went away. React's development double mount disposes a Room
   * and then keeps using it, so the store is left unbound, and the next
   * render binds it again.
   */
  dispose(): void {
    this.#end();
    this.#dispose();
    for (const stop of this.#unsubscribe) stop();
    this.#unsubscribe = [];
    this.#pending.clear();
    this.#panel = null;
    this.#tray = null;
    this.#env = null;
  }

  // ------------------------------------------------------------ deciding at the commit

  #check(): void {
    const env = this.#env;
    if (!env) return;
    for (const [tag, pending] of [...this.#pending]) {
      const state = env.tracker.state(tag);
      if (!state || state.state === "sending") continue;
      // A lookup settles it after a reconnect: that answer is late already.
      if (state.state === "checking") {
        pending.checked = true;
        continue;
      }
      this.#pending.delete(tag);
      if (state.state === "committed") this.#committed(tag, pending, state);
    }
  }

  #committed(tag: string, pending: Pending, state: Extract<ReceiptState, { state: "committed" }>): void {
    const env = this.#env!;
    const now = env.clock.now();
    const tray = this.#tray;
    if (!this.#allowed() || this.#warm !== "warm" || !this.#stage) return;
    if (!this.#panel || !tray || pending.mount !== this.#mount || pending.checked || env.hidden()) return;
    if (now - pending.origin.tapAt > LATE_MS) return;
    // A newer tap is on its way, and would end this throw as soon as it began.
    if ([...this.#pending.values()].some((p) => p.seq > pending.seq)) return;
    const rolls = rollsOf(state.lines);
    if (rolls.length === 0 || !oneCreature(rolls)) return;
    const dice = tapDice(rolls);
    if (!dice) return;
    const geometry = tray.measure(pending.origin);
    if (!geometry) return;
    const reduced = this.#inputs.reducedMotion;
    const plan = planTray(dice, geometry.width, seededRandom(tag));
    this.#clearTimers();
    this.#stage.stop();
    this.#pressed = false;
    const shown: ShownThrow = { id: ++this.#throwId, tag, plan, geometry, reduced, set: this.#inputs.set, startedAt: now };
    this.#stage.play({ tag, plan, geometry, reduced, set: this.#inputs.set, parent: tray.parent });
    // Under reduced motion the dice are drawn once, at rest, and the result shows at once.
    if (reduced) this.#set({ held: null, rolling: false, shown });
    else {
      this.#set({ held: tag, rolling: now - pending.origin.tapAt >= ROLLING_MS, shown });
      this.#timers.push(env.clock.setTimeout(() => this.#release(), LAND_MS));
    }
    this.#timers.push(env.clock.setTimeout(() => this.#gone(shown.id), GONE_MS));
  }

  // ------------------------------------------------------------ ending

  /** The result shows. The dice stay to fade, unless a pointer took them. */
  #release(): void {
    const env = this.#env;
    if (this.#clickTimer !== null && env) env.clock.clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    this.#pressed = false;
    if (this.#view.held !== null || this.#view.rolling) this.#set({ ...this.#view, held: null, rolling: false });
  }

  /** The dice have faded. */
  #gone(id: number): void {
    if (this.#view.shown?.id !== id) return;
    this.#stage?.stop();
    this.#set({ ...this.#view, shown: null });
  }

  /** Ends the throw at once: the result shows and the dice go without fading. */
  #end(): void {
    const env = this.#env;
    this.#clearTimers();
    if (this.#clickTimer !== null && env) env.clock.clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    this.#pressed = false;
    if (this.#view.shown) this.#stage?.stop();
    this.#set(QUIET);
  }

  #clearTimers(): void {
    const env = this.#env;
    if (env) for (const t of this.#timers) env.clock.clearTimeout(t);
    this.#timers = [];
  }

  // ------------------------------------------------------------ warm-up, loss and disposal

  #maybeWarm(): void {
    const env = this.#env;
    if (!env || this.#warm !== "cold" || this.#contextLost || !this.#panel || !this.#allowed() || env.hidden()) return;
    const module = env.loader.loaded();
    if (!module) return;
    const run = ++this.#warmRun;
    this.#warm = "warming";
    this.#cancelIdle = env.idle(() => {
      this.#cancelIdle = null;
      if (run !== this.#warmRun) return;
      if (!this.#stage) {
        const events: StageEvents = { lost: (deliberate) => this.#lost(events, deliberate), restored: () => this.#restored(events) };
        this.#stageEvents = events;
        this.#stage = module.createStage(events);
        if (!this.#stage) {
          this.#noStage = true;
          this.#warm = "cold";
          return;
        }
      }
      this.#stage.warm(this.#panel?.kinds() ?? ["d20", "d6"], this.#inputs.set).then(
        () => {
          if (run === this.#warmRun) this.#warm = "warm";
        },
        () => {
          if (run === this.#warmRun) this.#warm = "cold";
        },
      );
    }, WARM_MAX_MS);
  }

  #stopWarming(): void {
    this.#warmRun++;
    this.#cancelIdle?.();
    this.#cancelIdle = null;
    if (this.#warm === "warming") this.#warm = "cold";
  }

  #lost(from: StageEvents, deliberate: boolean): void {
    if (deliberate || from !== this.#stageEvents) return;
    this.#losses++;
    this.#contextLost = true;
    this.#end();
    this.#stopWarming();
    this.#warm = "cold";
  }

  #restored(from: StageEvents): void {
    if (from !== this.#stageEvents) return;
    this.#contextLost = false;
    this.#maybeWarm();
  }

  #dispose(): void {
    const env = this.#env;
    if (this.#disposeTimer !== null && env) env.clock.clearTimeout(this.#disposeTimer);
    this.#disposeTimer = null;
    this.#stopWarming();
    this.#warm = "cold";
    const stage = this.#stage;
    if (!stage) return;
    // Never while a throw runs: every caller has ended it first.
    if (this.#view.shown) this.#end();
    this.#stage = null;
    this.#stageEvents = null;
    this.#contextLost = false;
    stage.dispose();
  }
}
