import { useCallback, useEffect, useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { usePreview } from "../dm/previewContext.ts";
import { MODULES, type ModuleId } from "./registry.ts";

/*
 * What follows a Show (docs/design/design-v1-features.md 6, After a Show):
 * focus goes to the part that came back in the same surface, else to the
 * next Show button of the line, else to the home's heading, and a polite
 * live region says "Sound shows again.". The toolbar's, More's and the
 * chip menus' Show items place focus themselves, as each menu does after
 * its picks, and say it through `useShowSaid`. The Hidden on this device
 * line (Gate.tsx) only shows the part, so a press on one of its buttons is
 * read here, on its way down the page, before the line loses the button.
 */

/** A part's way back as one line says it: the part's name, or the first named where its needs come with it. */
export function shownWords(name: string): string {
  return `${name} shows again.`;
}

/** The part a Show button's words name first: "Show Dungeon generator and Map builder" is the Dungeon generator's. */
export function partOfShow(label: string): ModuleId | null {
  if (!label.startsWith("Show ")) return null;
  const rest = label.slice("Show ".length);
  // No part's name begins another's, so the first part named is the only one.
  return MODULES.find((m) => rest === m.name || rest.startsWith(`${m.name} and `) || rest.startsWith(`${m.name}, `))?.id ?? null;
}

/** What a Room page's live region says, numbered so the same words said twice are said again. */
type Said = { text: string; n: number };

const showSaidSlot = scopeSlot(() => createStore<Said>(() => ({ text: "", n: 0 })));

/** Says that a part shows again, in the Room page's polite live region. */
export function useShowSaid(): (name: string) => void {
  const store = useScoped(showSaidSlot);
  return useCallback((name: string) => store.setState((s) => ({ text: shownWords(name), n: s.n + 1 })), [store]);
}

/** What takes focus by itself inside a surface: a control, never one kept out of the tab order. */
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Where a surface ends for "the same surface": a dialog, a sheet, a tab panel, the side panel or a menu. */
const SURFACE_EDGE = 'dialog, [role="dialog"], [role="tabpanel"], aside, [role="menu"], nav';

/** The first control of a part's element, the element itself where it is one. */
function controlIn(el: Element): HTMLElement | null {
  if (el instanceof HTMLElement && el.matches(FOCUSABLE)) return el;
  return el.querySelector<HTMLElement>(FOCUSABLE);
}

/** The part that came back, looked for from the line's place outward, no further than its surface's edge. */
function cameBack(from: Element, id: ModuleId): HTMLElement | null {
  for (let at: Element | null = from; at; at = at.parentElement) {
    for (const el of at.querySelectorAll(`[data-part="${id}"]`)) {
      const control = controlIn(el);
      if (control) return control;
    }
    if (at.matches(SURFACE_EDGE)) return null;
  }
  return null;
}

/** The home's heading: the nearest heading above the line's place, by its own control where it is a fold, else itself. */
function headingOf(from: Element): HTMLElement | null {
  for (let at: Element | null = from; at; at = at.parentElement) {
    const heading = at.querySelector<HTMLElement>("h1, h2, h3, h4, [role='heading']");
    if (heading) {
      const control = heading.querySelector<HTMLElement>(FOCUSABLE);
      if (control) return control;
      if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      return heading;
    }
    if (at.matches(SURFACE_EDGE)) return null;
  }
  return null;
}

/** Where focus goes once the line drew again after a press of its button at `index`. */
export function showFocusTarget(place: Element, line: Element, index: number, id: ModuleId): HTMLElement | null {
  const back = cameBack(place, id);
  if (back) return back;
  if (line.isConnected) {
    const buttons = [...line.querySelectorAll<HTMLElement>("button")];
    const next = buttons[Math.min(index, buttons.length - 1)];
    if (next) return next;
  }
  return headingOf(place);
}

/**
 * The Room page's part: the polite live region, and the read of a Hidden on
 * this device line's press. A preview's page shows every part, so it has
 * no line to read.
 */
export function ShowFocus() {
  const store = useScoped(showSaidSlot);
  const said = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const say = useShowSaid();
  const preview = usePreview() !== null;
  useEffect(() => {
    if (preview) return;
    const onPress = (e: MouseEvent) => {
      const button = e.target instanceof Element ? e.target.closest("button") : null;
      const line = button?.closest("[data-hidden-here]");
      const place = line?.parentElement;
      const id = button ? partOfShow(button.textContent ?? "") : null;
      if (!button || !line || !place || id === null) return;
      const index = [...line.querySelectorAll("button")].indexOf(button);
      // After the press's render, which the line's own handler starts once this has read the line.
      setTimeout(() => {
        // Focus moves only where the press left it with nothing: a tap that never focused the button leaves focus where it was.
        const active = document.activeElement;
        if (!active || active === document.body || !active.isConnected || active === button) showFocusTarget(place, line, index, id)?.focus();
        say(MODULES.find((m) => m.id === id)?.name ?? "");
      }, 0);
    };
    document.addEventListener("click", onPress, true);
    return () => document.removeEventListener("click", onPress, true);
  }, [preview, say]);
  return (
    <div role="status" style={VISUALLY_HIDDEN}>
      <span key={said.n}>{said.text}</span>
    </div>
  );
}
