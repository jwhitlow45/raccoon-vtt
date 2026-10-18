import { preloadInBackground } from "../../../lib/retryableLazy.ts";
import { scopeSlot } from "../../../state/scope.ts";
import { lowPower, subscribeLowPower } from "../../device/settings.ts";
import { canDrawDice, stageLoader } from "./probe.ts";
import type { StageModule, ThrowOrigin } from "./store.ts";

/**
 * What code every member loads needs of the roll animation, and no more
 * (docs/design-v1-roll-animation.md 6). The panel's rolls go through
 * useDicePanel, which the fight's cards load with the room, so the throw's
 * store would ride along with them. Instead the store stays with the Dice
 * panel's chunk, and binds itself here when the panel first renders, which
 * is before any tap in it.
 */

/** Whether the settings let the dice chunk load at all. */
function loadAllowed(): boolean {
  return !lowPower();
}

/**
 * The dice chunk, loaded in the background once the room is ready, like
 * the panels, so a dropped connection or a redeploy later never turns the
 * dice off. The store reaches the stage only through this `import()`.
 */
export const diceLoader = stageLoader<StageModule>({
  allowed: loadAllowed,
  subscribe: (listener) => subscribeLowPower(listener),
  probe: canDrawDice,
  load: () => import("./stage.ts"),
});

preloadInBackground(() => diceLoader.start(), ["dm", "player"]);

/** The Room's throw store, as a Dice panel control reaches it. */
export type ThrowHooks = {
  /** A panel roll's tag, with where its tap was. */
  register(tag: string, origin: ThrowOrigin): void;
  /** The origin of the panel tap being handled now. */
  origin(): ThrowOrigin;
};

/** Set while the Room's store is bound (throw/useThrows.ts). */
export const throwHooksSlot = scopeSlot<{ current: ThrowHooks | null }>(() => ({ current: null }));
