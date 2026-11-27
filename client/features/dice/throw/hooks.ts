import { preloadInBackground } from "../../../lib/retryableLazy.ts";
import { scopeSlot } from "../../../state/scope.ts";
import { lowPower, subscribeLowPower } from "../../device/settings.ts";
import { moduleShown } from "../../modules/gate.ts";
import type { Role } from "../../modules/registry.ts";
import { canDrawDice, stageLoader } from "./probe.ts";
import type { StageModule, ThrowOrigin } from "./store.ts";

/**
 * What code every member loads needs of the roll animation, and no more
 * (docs/design/design-v1-roll-animation.md 6). The panel's rolls go through
 * useDicePanel, which the fight's cards load with the room, so the throw's
 * store would ride along with them. Instead the store stays with the
 * chunks of the rolling surfaces (the Dice panel, and a stat block's panel
 * through its tray), and binds itself here when the first of them renders,
 * which is before any tap in it.
 */

/**
 * Whether this page's role shows Dice animation (docs/design/design-v1-features.md 8):
 * unknown until the room says who you are, so the chunk waits for a role
 * (D-261127-316). The preload for a role records it, and the Room's throw
 * store (useThrows.ts) then tells each change, here or from another window.
 */
const animation: { role: Role | null; told: boolean | null } = { role: null, told: null };
const animationListeners = new Set<() => void>();

/** The Room's throw store says whether this role's Dice animation shows now. */
export function diceAnimationHere(shown: boolean): void {
  if (animation.told === shown) return;
  animation.told = shown;
  for (const listener of [...animationListeners]) listener();
}

function animationShown(): boolean {
  if (animation.told !== null) return animation.told;
  return animation.role !== null && moduleShown("diceAnimation", animation.role);
}

/** Whether the dice chunk may load at all: Dice animation shown for this page's role and Low power off. */
function loadAllowed(): boolean {
  return animationShown() && !lowPower();
}

/**
 * The dice chunk, loaded in the background once the room is ready, like
 * the panels, so a dropped connection or a redeploy later never turns the
 * dice off. The store reaches the stage only through this `import()`.
 */
export const diceLoader = stageLoader<StageModule>({
  allowed: loadAllowed,
  subscribe: (listener) => {
    animationListeners.add(listener);
    const stops = [subscribeLowPower(listener), () => void animationListeners.delete(listener)];
    return () => stops.forEach((stop) => stop());
  },
  probe: canDrawDice,
  load: () => import("./stage.ts"),
});

/** The preload for one role, which tells the loader whose Dice animation decides. */
function startFor(role: Role): Promise<void> {
  animation.role = role;
  return diceLoader.start();
}

preloadInBackground(() => startFor("dm"), ["dm"]);
preloadInBackground(() => startFor("player"), ["player"]);

/** The Room's throw store, as a rolling control reaches it. */
export type ThrowHooks = {
  /** A roll's tag, with its host and where its tap was. */
  register(tag: string, origin: ThrowOrigin): void;
  /** The origin of the Dice panel tap being handled now. */
  origin(): ThrowOrigin;
};

/** Set while the Room's store is bound (throw/useThrows.ts). */
export const throwHooksSlot = scopeSlot<{ current: ThrowHooks | null }>(() => ({ current: null }));
