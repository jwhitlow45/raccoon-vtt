import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject, type SyntheticEvent } from "react";
import { idle } from "../../../lib/idle.ts";
import { scopeSlot, useScoped } from "../../../state/scope.ts";
import { realClock } from "../../../state/timing.ts";
import { usePreview } from "../../dm/previewContext.ts";
import { usePanelShown } from "../../panels.ts";
import { diceSetId, lowPower, subscribeDiceSet, subscribeLowPower } from "../../device/settings.ts";
import { useModule } from "../../modules/Gate.tsx";
import { useReceipts, type ReceiptTracker } from "../useReceipt.ts";
import { diceAnimationHere, diceLoader, throwHooksSlot, type ThrowHooks } from "./hooks.ts";
import type { DieKind } from "./layout.ts";
import { ThrowStore, type PaneSize, type ThrowHost, type ThrowSurface, type ThrowView } from "./store.ts";

/**
 * The throw's store bound to the page (docs/design/design-v1-roll-animation.md 6):
 * the dice chunk's loader (throw/hooks.ts), the page's visibility, reduced
 * motion, the device's settings, and one store per Room, so a "view as a
 * player" preview keeps its own and never throws. Only the chunks of the
 * rolling surfaces (the Dice panel, a token's panel and the Characters
 * panel, through their trays) and This device load this module, and
 * binding the store hands the room's rolling code its hooks.
 */

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

/** Binds a Room's store to the page, once, and again after React's development double mount disposed it. `on` is this role's Dice animation as it binds. */
function bind(bound: Bound, tracker: ReceiptTracker, preview: boolean, hooks: { current: ThrowHooks | null }, on: boolean): void {
  const { store } = bound;
  if (store.bound) return;
  hooks.current = { register: (tag, origin) => store.register(tag, origin), origin: () => store.origin() };
  bound.stop.push(() => {
    hooks.current = null;
  });
  store.bind({ clock: realClock, idle, tracker, loader: diceLoader, hidden: pageHidden });
  store.setInputs({ on, lowPower: lowPower(), reducedMotion: reducedMotion(), preview, set: diceSetId() });
  bound.stop.push(subscribeLowPower(() => store.setInputs({ lowPower: lowPower() })));
  bound.stop.push(subscribeDiceSet(() => store.setInputs({ set: diceSetId() })));
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

/**
 * A change of this role's Dice animation, here or from another window
 * (docs/design/design-v1-features.md 8, D-261127-310): hidden, a throw in
 * the air ends and the renderer goes (throw/store.ts setInputs), and shown
 * again the next roll throws, with no reload. The loader learns it too, so
 * a chunk not yet loaded waits. A "view as a player" preview shows every
 * part and never throws, so it tells the loader nothing.
 */
export function followDiceAnimation(store: Pick<ThrowStore, "setInputs">, on: boolean, preview: boolean): void {
  store.setInputs({ on });
  if (!preview) diceAnimationHere(on);
}

/** This Room's throw store. */
export function useThrows(): ThrowStore {
  const bound = useScoped(throwsSlot);
  const hooks = useScoped(throwHooksSlot);
  const tracker = useReceipts();
  const preview = usePreview() !== null;
  const on = useModule("diceAnimation");
  bind(bound, tracker, preview, hooks, on);
  useEffect(() => followDiceAnimation(bound.store, on, preview), [bound, on, preview]);
  return bound.store;
}

/** The throw as React draws it: what waits, "Rolling…", and the dice on screen. */
export function useThrowView(): ThrowView {
  const store = useThrows();
  return useSyncExternalStore(store.subscribe, store.view, store.view);
}

/** The rolling surface a tray is drawn in, which it attaches to and draws only that surface's throws for. */
export const ThrowHostContext = createContext<ThrowHost | null>(null);

/** The tray's host: the one given, else the surface around it. */
export function useTrayHost(given?: ThrowHost | null): ThrowHost | null {
  const around = useContext(ThrowHostContext);
  return given ?? around;
}

/** A pane's border box on screen, as a host's resize baseline reads it. */
export function paneSize(pane: Element): PaneSize {
  const r = pane.getBoundingClientRect();
  return { width: r.width, height: r.height };
}

/** The control a pointer or key went to, which a roll from it throws its dice from. */
function controlOf(e: SyntheticEvent): Element | null {
  const target = e.target instanceof Element ? e.target : null;
  return target?.closest("button, input, [role='button']") ?? target;
}

/** The capture-phase listeners a rolling surface's root takes. */
export type ThrowSurfaceProps = {
  ref: RefObject<HTMLDivElement | null>;
  onPointerDownCapture(e: SyntheticEvent): void;
  onPointerUpCapture(): void;
  onPointerCancelCapture(): void;
  onClickCapture(): void;
  onKeyDownCapture(e: SyntheticEvent): void;
};

/**
 * A rolling surface's part in a throw (docs/design/design-v1-roll-animation.md
 * 3.5 and docs/design/design-v1-token-roll-header.md 4.3): its host, mounted
 * for the component's life and told when its pane hides. Any tap or key in
 * the root, or a change of its pane's size off the baseline, ends the
 * throw. The listeners are on the capture phase and never stop or prevent
 * the event, so the tap or key still does its own job.
 *
 * The host is made as the component first renders and mounted in a layout
 * effect, so a tray in it can attach in its own layout effect, which runs
 * first. Give the root `props`, and the trays inside the host through
 * ThrowHostContext. `rebase()` records the pane's size now as the baseline,
 * for a change the surface made itself.
 */
export function useThrowSurface(surface: ThrowSurface, kinds: () => DieKind[]): { host: ThrowHost; props: ThrowSurfaceProps; rebase(): void } {
  const store = useThrows();
  const kindsRef = useRef(kinds);
  kindsRef.current = kinds;
  const [host] = useState(() => store.host({ surface, kinds: () => kindsRef.current() }));
  const root = useRef<HTMLDivElement | null>(null);
  const visible = usePanelShown();
  useLayoutEffect(() => {
    host.mount();
    return () => host.unmount();
  }, [host]);
  useLayoutEffect(() => host.shown(visible), [host, visible]);
  useEffect(() => {
    const node = root.current;
    const fromMenu = (e: Event) => host.keyDown(e.target instanceof Element ? e.target : null);
    node?.addEventListener("rvtt-roll-mode-origin", fromMenu);
    return () => node?.removeEventListener("rvtt-roll-mode-origin", fromMenu);
  }, [host]);
  useEffect(() => {
    const pane = root.current?.closest("[data-pane-body]");
    if (!pane || typeof ResizeObserver === "undefined") return;
    // An observer reports once as it starts, which is the baseline.
    const observer = new ResizeObserver(() => host.observed(paneSize(pane)));
    observer.observe(pane);
    return () => observer.disconnect();
  }, [host]);
  const [props] = useState<ThrowSurfaceProps>(() => ({
    ref: root,
    onPointerDownCapture: (e) => host.pointerDown(controlOf(e)),
    onPointerUpCapture: () => host.pointerUp(),
    onPointerCancelCapture: () => host.pointerCancel(),
    onClickCapture: () => host.click(),
    onKeyDownCapture: (e) => host.keyDown(controlOf(e)),
  }));
  const [rebase] = useState(() => () => {
    const pane = root.current?.closest("[data-pane-body]");
    if (pane) host.baseline(paneSize(pane));
  });
  return { host, props, rebase };
}
