import { useSyncExternalStore } from "react";
import { idle } from "../../../lib/idle.ts";
import { scopeSlot, useScoped } from "../../../state/scope.ts";
import { realClock } from "../../../state/timing.ts";
import { usePreview } from "../../dm/previewContext.ts";
import { lowPower, subscribeLowPower } from "../../device/settings.ts";
import { useReceipts, type ReceiptTracker } from "../useReceipt.ts";
import { diceLoader, throwHooksSlot, type ThrowHooks } from "./hooks.ts";
import { ThrowStore, type ThrowView } from "./store.ts";

/**
 * The throw's store bound to the page (docs/design-v1-roll-animation.md 6):
 * the dice chunk's loader (throw/hooks.ts), the page's visibility, reduced
 * motion and Low power, and one store per Room, so a "view as a player"
 * preview keeps its own and never throws. Only the Dice panel's chunk
 * loads this module, and binding the store hands the room's rolling code
 * its hooks.
 */

export { diceLoader };

const REDUCED = "(prefers-reduced-motion: reduce)";

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia(REDUCED).matches;
}

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

type Bound = { store: ThrowStore; stop: (() => void)[] };

export const throwsSlot = scopeSlot<Bound>(
  () => ({ store: new ThrowStore(), stop: [] }),
  (bound) => {
    for (const stop of bound.stop) stop();
    bound.stop = [];
    bound.store.dispose();
  },
);

/** Binds a Room's store to the page, once, and again after React's development double mount disposed it. */
function bind(bound: Bound, tracker: ReceiptTracker, preview: boolean, hooks: { current: ThrowHooks | null }): void {
  const { store } = bound;
  if (store.bound) return;
  hooks.current = { register: (tag, origin) => store.register(tag, origin), origin: () => store.origin() };
  bound.stop.push(() => {
    hooks.current = null;
  });
  store.bind({ clock: realClock, idle, tracker, loader: diceLoader, hidden: pageHidden });
  store.setInputs({ lowPower: lowPower(), reducedMotion: reducedMotion(), preview });
  bound.stop.push(subscribeLowPower(() => store.setInputs({ lowPower: lowPower() })));
  if (typeof document !== "undefined") {
    const onVisibility = () => store.visibility(pageHidden());
    document.addEventListener("visibilitychange", onVisibility);
    bound.stop.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  if (typeof matchMedia === "function") {
    const media = matchMedia(REDUCED);
    const onChange = () => store.setInputs({ reducedMotion: media.matches });
    media.addEventListener("change", onChange);
    bound.stop.push(() => media.removeEventListener("change", onChange));
  }
}

/** This Room's throw store. */
export function useThrows(): ThrowStore {
  const bound = useScoped(throwsSlot);
  const hooks = useScoped(throwHooksSlot);
  const tracker = useReceipts();
  const preview = usePreview() !== null;
  bind(bound, tracker, preview, hooks);
  return bound.store;
}

/** The throw as React draws it: what waits, "Rolling…", and the dice on screen. */
export function useThrowView(): ThrowView {
  const store = useThrows();
  return useSyncExternalStore(store.subscribe, store.view, store.view);
}
