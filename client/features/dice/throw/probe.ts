/**
 * Whether this device can draw the dice, asked once per page without
 * three.js (docs/design-v1-roll-animation.md 6 and 7), and the background
 * load of the dice chunk that waits on it.
 *
 * The probe asks a fresh canvas for the very context the stage asks for:
 * WebGL2, refusing a major performance caveat, so a phone with only
 * software GL shows results at once rather than at a crawl. It releases
 * that context at once. three logs an error when it cannot make a context,
 * so it is never asked to: the stage is built only after the probe said
 * yes. WebGL1 alone counts as no WebGL.
 */

/** The stage's context. Antialiasing only below 2 device pixels per screen pixel, where it shows: a multisampled phone-sized buffer costs about 25 MB. */
export function contextAttributes(antialias: boolean): WebGLContextAttributes {
  return { alpha: true, antialias, powerPreference: "low-power", failIfMajorPerformanceCaveat: true };
}

/** The canvas a probe asks, a parameter so a test can stand in for the browser's. */
export type ProbeCanvas = { getContext(kind: "webgl2", attributes: WebGLContextAttributes): { getExtension(name: "WEBGL_lose_context"): { loseContext(): void } | null } | null };

export function makeProbe(canvas: () => ProbeCanvas): () => boolean {
  let answer: boolean | null = null;
  return () => {
    if (answer !== null) return answer;
    try {
      const gl = canvas().getContext("webgl2", contextAttributes(false));
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      answer = gl !== null;
    } catch {
      answer = false;
    }
    return answer;
  };
}

/** The page's probe, run at most once. */
export const canDrawDice = makeProbe(() => document.createElement("canvas") as unknown as ProbeCanvas);

export type LoaderDeps<T> = {
  /**
   * The switch is on and Low power is off. A preview is not asked: View as
   * a player is a dialog on the DM's own page, which loads the chunk for the
   * DM's panel, and the store keeps a preview from warming up or throwing.
   */
  allowed(): boolean;
  /** Told when any of those may have changed. */
  subscribe(listener: () => void): () => void;
  probe(): boolean;
  load(): Promise<T>;
};

/** Where the load stands: not asked yet, under way, here, failed, or not tried since the device cannot draw. */
export type LoadState = "waiting" | "loading" | "ready" | "failed" | "no-webgl";

export type StageLoader<T> = {
  /** What preloadInBackground calls once the room is ready. */
  start(): Promise<void>;
  /** The loaded module, or null. */
  loaded(): T | null;
  state(): LoadState;
  subscribe(listener: () => void): () => void;
};

/**
 * The dice chunk's loader. preloadInBackground calls its loader only once,
 * so this one waits on the settings itself: it probes and imports the
 * first time they allow, and never again, whatever they do after.
 */
export function stageLoader<T>(deps: LoaderDeps<T>): StageLoader<T> {
  let module: T | null = null;
  let state: LoadState = "waiting";
  const listeners = new Set<() => void>();
  const set = (next: LoadState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const tryLoad = async () => {
    if (state !== "waiting" || !deps.allowed()) return;
    if (!deps.probe()) return set("no-webgl");
    set("loading");
    try {
      module = await deps.load();
      set("ready");
    } catch {
      set("failed");
    }
  };
  return {
    start() {
      if (deps.allowed()) return tryLoad();
      const stop = deps.subscribe(() => {
        if (!deps.allowed()) return;
        stop();
        void tryLoad();
      });
      return Promise.resolve();
    },
    loaded: () => module,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
