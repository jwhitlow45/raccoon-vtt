/**
 * Doing something that needs a user activation, from an event the browser
 * accepts as one.
 *
 * The HTML spec counts only some events as a user activation. For a mouse
 * that is pointerdown. For touch and pen it is pointerup and touchend, never
 * pointerdown, so work that waits for pointerdown never runs on an iPhone.
 * Keyboards count on keydown, except Escape, which browsers leave out. This
 * file holds those rules once, so the turn chime, the ping sound and
 * anything after them cannot drift apart again.
 */

/** The members of a gesture event the rules read. */
export interface GestureEvent {
  readonly type: string;
  readonly pointerType?: string;
  readonly key?: string;
}

/** Event names listened for: every event that can count as an activation, whatever the device. A touch tap fires several, and `countsAsActivation` picks the ones that do. */
export const UNLOCK_EVENTS = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;

/** Whether this event is one the browser counts as a user activation. */
export function countsAsActivation(e: GestureEvent): boolean {
  switch (e.type) {
    case "pointerdown":
      return e.pointerType === "mouse";
    case "pointerup":
      return e.pointerType !== "mouse";
    case "touchend":
    case "click":
      return true;
    case "keydown":
      return e.key !== "Escape";
    default:
      return false;
  }
}

export interface Activation {
  /** Listens again, as after the thing the attempt did came undone. A no-op while already listening. */
  rearm(): void;
  /** Removes every listener. */
  stop(): void;
}

/**
 * Runs `attempt` synchronously inside each event that counts as an
 * activation, so the browser ties what it starts to that gesture. The
 * attempt answers true once it worked, or a promise of that, and listening
 * stops. Any other answer, a rejection too, leaves it listening for the next
 * gesture. A page restored from the back-forward cache (`pageshow`) listens
 * again, since whatever was unlocked may not have survived.
 */
export function onActivation(attempt: () => boolean | Promise<boolean>, target: EventTarget = window): Activation {
  let armed = false;
  const arm = () => {
    if (armed) return;
    armed = true;
    for (const type of UNLOCK_EVENTS) target.addEventListener(type, onGesture, true);
  };
  const disarm = () => {
    if (!armed) return;
    armed = false;
    for (const type of UNLOCK_EVENTS) target.removeEventListener(type, onGesture, true);
  };
  function onGesture(e: Event) {
    if (!countsAsActivation(e as unknown as GestureEvent)) return;
    const result = attempt();
    if (result === true) return disarm();
    if (result === false) return;
    // A rejected attempt (a resume() the browser refused) keeps listening on purpose, so the next gesture tries again.
    result.then(
      (ok) => ok && disarm(),
      () => {},
    );
  }
  arm();
  target.addEventListener("pageshow", arm);
  return {
    rearm: arm,
    stop() {
      disarm();
      target.removeEventListener("pageshow", arm);
    },
  };
}

/** The few members of an AudioContext the helper uses. `interrupted` is Safari's state after a call or a lock. */
export interface UnlockableContext {
  readonly state: string;
  resume(): Promise<void>;
  addEventListener?(type: "statechange", listener: () => void): void;
  removeEventListener?(type: "statechange", listener: () => void): void;
}

export interface AudioUnlock {
  /**
   * The context, created on first use. It runs inside the gesture's handler,
   * because a context made or resumed later is not covered by the activation.
   */
  context: () => UnlockableContext | null;
  /** False leaves the gesture alone and keeps listening. Defaults to always. */
  wanted?: () => boolean;
  /** Where gestures arrive. Defaults to the window. */
  target?: EventTarget;
}

/**
 * Brings the context to `running` on an accepted gesture. A context that
 * later leaves `running` (Safari's `interrupted`, or `suspended` after the
 * tab was hidden) starts the listening again. Returns the cleanup for an
 * effect.
 */
export function armAudioUnlock(options: AudioUnlock): () => void {
  const wanted = options.wanted ?? (() => true);
  let watched: UnlockableContext | null = null;
  const onStateChange = () => {
    if (watched && watched.state !== "running") activation.rearm();
  };
  const activation = onActivation(() => {
    if (!wanted()) return false;
    const ctx = options.context();
    if (!ctx) return false;
    if (watched !== ctx) {
      watched?.removeEventListener?.("statechange", onStateChange);
      watched = ctx;
      ctx.addEventListener?.("statechange", onStateChange);
    }
    if (ctx.state === "running") return true;
    return ctx.resume().then(() => ctx.state === "running");
  }, options.target);
  return () => {
    activation.stop();
    watched?.removeEventListener?.("statechange", onStateChange);
    watched = null;
  };
}
