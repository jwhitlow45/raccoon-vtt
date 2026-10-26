import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { effectiveZoom } from "../features/device/layout.ts";
import { isCoarsePointer } from "./device.ts";

/*
 * The on-screen keyboard's place, for what stands at the screen's foot
 * (components/Sheet.tsx, docs/design.md 14.4). iOS Safari never
 * resizes the layout viewport for the keyboard: the page keeps its height
 * and only `window.visualViewport` shrinks, so a sheet fixed to the foot
 * stays under the keyboard with the field that opened it. Safari may also
 * pan the visible area down the page to show a field, which hides the top
 * instead. Android Chrome resizes the layout viewport itself, where
 * index.html asks it to (`interactive-widget=resizes-content`), and then
 * nothing is hidden and this reads no keyboard.
 *
 * It counts only while a field that opens a keyboard has focus: a pinch
 * zoom shrinks the visual viewport too, and so can a browser's own bars
 * for a moment, and neither is a keyboard.
 */

/** The parts of `window.visualViewport` this reads, so the rules can be tested without a browser. */
export type ViewportSource = { height: number; offsetTop: number; scale: number };

/**
 * The visible area while the keyboard is open, in the page's CSS px from
 * the layout viewport's top: `top` where it starts (above it the page is
 * panned out of view), `height` how tall it is, and `inset` how much of the
 * layout viewport's bottom it leaves hidden, under the keyboard.
 */
export type KeyboardView = { top: number; height: number; inset: number };

/** Less than this is a rounding of the viewport's size, not a keyboard. */
const NOISE = 1;

/** The keyboard's view for a layout `layoutHeight` tall, or null where no keyboard hides any of it. */
export function keyboardView(input: { layoutHeight: number; viewport: ViewportSource | null; field: boolean }): KeyboardView | null {
  const v = input.viewport;
  if (!v || !input.field || Math.abs(v.scale - 1) > 0.01) return null;
  const top = Math.max(0, v.offsetTop);
  const inset = Math.max(0, input.layoutHeight - top - v.height);
  if (inset < NOISE && top < NOISE) return null;
  return { top, height: v.height, inset };
}

/** The parts of an element that say whether focus on it opens the on-screen keyboard. */
export type FocusTarget = { tagName: string; type?: string; readOnly?: boolean; disabled?: boolean; isContentEditable?: boolean; inputMode?: string };

/** The input types that type text. Buttons, boxes, sliders and pickers open no keyboard. */
const TYPED = new Set(["", "text", "search", "number", "email", "tel", "url", "password"]);

/** Whether focus on `el` opens the on-screen keyboard: a text field, a text area, or editable text. */
export function opensKeyboard(el: FocusTarget | null): boolean {
  if (!el || el.inputMode === "none") return false;
  if (el.isContentEditable === true) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return el.readOnly !== true && el.disabled !== true;
  if (tag !== "input") return false;
  return TYPED.has((el.type ?? "").toLowerCase()) && el.readOnly !== true && el.disabled !== true;
}

const sameView = (a: KeyboardView | null, b: KeyboardView | null) => a === b || (a !== null && b !== null && a.top === b.top && a.height === b.height && a.inset === b.inset);

let current: KeyboardView | null = null;
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

/** The keyboard's view read afresh from the page, for a surface that places itself on an event of its own, before the store may have heard it. */
export function readKeyboardView(): KeyboardView | null {
  if (typeof window === "undefined") return null;
  return keyboardView({ layoutHeight: window.innerHeight, viewport: window.visualViewport ?? null, field: opensKeyboard(document.activeElement as FocusTarget | null) });
}

function refresh(): void {
  const next = readKeyboardView();
  if (sameView(next, current)) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

function attach(): () => void {
  // Read when the first listener comes, so a fake viewport a test installs before the page loads is the one heard.
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", refresh);
  viewport?.addEventListener("scroll", refresh);
  window.addEventListener("resize", refresh);
  document.addEventListener("focusin", refresh, true);
  document.addEventListener("focusout", refresh, true);
  return () => {
    viewport?.removeEventListener("resize", refresh);
    viewport?.removeEventListener("scroll", refresh);
    window.removeEventListener("resize", refresh);
    document.removeEventListener("focusin", refresh, true);
    document.removeEventListener("focusout", refresh, true);
  };
}

/** Calls `listener` whenever the keyboard's view changes, until the returned function is called. */
export function subscribeKeyboard(listener: () => void): () => void {
  listeners.add(listener);
  if (!detach) {
    detach = attach();
    current = readKeyboardView();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || !detach) return;
    detach();
    detach = null;
  };
}

/** The keyboard's view now, as subscribeKeyboard last heard it, or read afresh with no one subscribed. */
export function keyboardViewNow(): KeyboardView | null {
  return detach ? current : readKeyboardView();
}

/** The keyboard's view, rendering again as it changes. Null where no keyboard hides any of the page. */
export function useKeyboardView(): KeyboardView | null {
  return useSyncExternalStore(subscribeKeyboard, keyboardViewNow, () => null);
}

/** A box's top and bottom on the screen, in CSS px. */
export type Span = { top: number; bottom: number };

/** What of the page shows above the keyboard, from the layout viewport's top, in px at the interface size `scale`. Null with no keyboard. */
export function visibleSpan(view: KeyboardView | null, scale: number): Span | null {
  return view ? { top: view.top / scale, bottom: (view.top + view.height) / scale } : null;
}

/**
 * How far to scroll a pane's body so a focused field shows with what goes
 * with it (its form, such as Spend and Cancel beside an amount), `margin`
 * clear of the visible edges. `visible` is what of the body can be seen:
 * its box less what the keyboard hides. A group taller than that counts as
 * the field alone, so a field in a long form is not moved while it shows.
 * The field's own top wins over the group's bottom. Returns the change to
 * the body's scrollTop, 0 when all of it shows.
 */
export function fieldScroll(input: { field: Span; group: Span; visible: Span; margin: number }): number {
  const { field, visible, margin } = input;
  const top = visible.top + margin;
  const bottom = visible.bottom - margin;
  const group = input.group.bottom - input.group.top > bottom - top ? field : input.group;
  let delta = Math.max(0, group.bottom - bottom);
  if (field.top - delta < top) delta = field.top - top;
  return Math.abs(delta) < 1 ? 0 : delta;
}

/**
 * Keeps the field focused inside `scroller` in view (fieldScroll): as it
 * takes focus, and again each time the keyboard's view changes (`view`),
 * after the surface has laid out for it, and after a resize of the page,
 * which is how Android Chrome makes room for its keyboard (index.html), so
 * there the view stays null. A touch drag or a wheel on the scroller is a
 * scroll on purpose, and stops it for that field until a field takes
 * focus again. `margin` is in the scroller's own px, as its interface size
 * draws them.
 */
export function useFieldInView(scroller: RefObject<HTMLElement | null>, view: KeyboardView | null, margin: number): void {
  const following = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = scroller.current;
    // A computer opens no on-screen keyboard, and its browser shows a focused field itself.
    if (!el || !isCoarsePointer()) return;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target instanceof HTMLElement && opensKeyboard(e.target) ? e.target : null;
      following.current = target;
      if (target) keepInView(el, target, margin);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.target === following.current) following.current = null;
    };
    const onUserScroll = () => {
      following.current = null;
    };
    // The room lays out for the new size in a render after the resize event, so the field is placed two frames on, once that has drawn.
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const field = following.current;
          if (field?.isConnected && el.contains(field)) keepInView(el, field, margin);
        });
      });
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    el.addEventListener("touchmove", onUserScroll, { passive: true });
    el.addEventListener("wheel", onUserScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      el.removeEventListener("touchmove", onUserScroll);
      el.removeEventListener("wheel", onUserScroll);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(frame);
    };
  }, [scroller, margin]);
  useLayoutEffect(() => {
    const el = scroller.current;
    const field = following.current;
    if (el && field?.isConnected && el.contains(field)) keepInView(el, field, margin);
  }, [scroller, view, margin]);
}

/**
 * useFieldInView for every surface at once, mounted once by the room: the
 * field with focus, wherever it is, kept in view in the nearest box that
 * scrolls it, two frames after each change of the keyboard's view or the
 * page's size, once the surfaces have laid out for it. It serves the
 * surfaces that keep no scroller of their own here, such as the token bar
 * and its drawers, a map pane, a roll card at the foot or an alert card.
 * Where a sheet or a dialog also keeps the field, the second pass finds it
 * in view and moves nothing. Unlike useFieldInView it does nothing as a
 * field takes focus: with no keyboard up nothing covers the field, and the
 * token bar's strip, scrolled by the viewer while a refusal shows under
 * its HP entry, moved back under them (e2e/barrest.e2e.ts br-f-16). A
 * touch drag or a wheel anywhere stops it until a field takes focus again.
 */
export function useFocusedFieldInView(margin: number): void {
  useEffect(() => {
    // A computer opens no on-screen keyboard, and its browser shows a focused field itself.
    if (!isCoarsePointer()) return;
    let following: HTMLElement | null = null;
    let frame = 0;
    const keep = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const field = following;
          if (!field?.isConnected || document.activeElement !== field) return;
          const scroller = scrollerOf(field);
          if (scroller) keepInView(scroller, field, margin);
        });
      });
    };
    const onFocusIn = (e: FocusEvent) => {
      following = e.target instanceof HTMLElement && opensKeyboard(e.target) ? e.target : null;
    };
    const onUserScroll = () => {
      following = null;
    };
    const stop = subscribeKeyboard(keep);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("touchmove", onUserScroll, { capture: true, passive: true });
    document.addEventListener("wheel", onUserScroll, { capture: true, passive: true });
    window.addEventListener("resize", keep);
    return () => {
      stop();
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("touchmove", onUserScroll, true);
      document.removeEventListener("wheel", onUserScroll, true);
      window.removeEventListener("resize", keep);
    };
  }, [margin]);
}

/** The nearest box around `el` that scrolls up and down, and has more than it shows. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

/** keepInView for the field that has focus now, where it opens a keyboard and is inside `scroller`: for a surface that lays itself out on an event of its own, such as a popover placed again. */
export function keepFocusInView(scroller: HTMLElement, margin: number): void {
  const field = document.activeElement;
  if (field instanceof HTMLElement && field !== scroller && scroller.contains(field) && opensKeyboard(field)) keepInView(scroller, field, margin);
}

function keepInView(scroller: HTMLElement, field: HTMLElement, margin: number): void {
  const box = scroller.getBoundingClientRect();
  // The boxes are in the page's px, and scrollTop in the scroller's own, which the interface size zooms.
  const zoom = effectiveZoom(scroller, box.width);
  const viewport = window.visualViewport;
  // getBoundingClientRect is from the layout viewport's top, as the visual viewport's offsetTop is.
  const seen = viewport ? { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height } : { top: 0, bottom: window.innerHeight };
  const visible = { top: Math.max(box.top, seen.top), bottom: Math.min(box.bottom, seen.bottom) };
  if (visible.bottom <= visible.top) return;
  const form = field.closest("form");
  const group = form && scroller.contains(form) ? form.getBoundingClientRect() : field.getBoundingClientRect();
  const delta = fieldScroll({ field: field.getBoundingClientRect(), group, visible, margin: margin * zoom });
  if (delta !== 0) scroller.scrollTop += delta / zoom;
}
