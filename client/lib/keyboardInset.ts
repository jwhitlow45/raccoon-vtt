import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { effectiveZoom, pageHeldShort } from "../features/device/layout.ts";
import { isCoarsePointer } from "./device.ts";
import { opensKeyboard, type FocusTarget } from "./keyboardField.ts";

/*
 * The on-screen keyboard's place, for what stands at the screen's foot
 * (components/Sheet.tsx, docs/design.md 14.4). iOS Safari never
 * resizes the layout viewport for the keyboard: the page keeps its height
 * and only `window.visualViewport` shrinks, so a sheet fixed to the foot
 * stays under the keyboard with the field that opened it. Safari may also
 * pan the visible area down the page to show a field, which hides the top
 * instead. Android Chrome does the same, as index.html leaves it its
 * default (`resizes-visual`). A browser that resizes the layout viewport
 * hides nothing, and features/device/layout.ts keeps the room's size
 * steady through it. The view then is the short page itself, top 0 and
 * inset 0, since the page already ends at the keyboard: the surfaces that
 * lay out by the room's steady size learn the real room from it, and
 * nothing is lifted twice.
 *
 * A view starts only with focus in a field that opens a keyboard: a pinch
 * zoom shrinks the visual viewport too, and so can a browser's own bars
 * for a moment, and neither is a keyboard. Once started it lasts while the
 * visual viewport stays shrunk at scale 1, whatever has focus, and ends as
 * the viewport grows back when the keyboard closes. A press on Spend takes
 * focus from the field while the keyboard is still up, and a view that
 * ended there dropped the sheet under the finger before the tap landed.
 * Its numbers are whole px, so a pan of the page draws again only as it
 * moves a whole pixel.
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

/**
 * The keyboard's view for a layout `layoutHeight` tall, or null where no
 * keyboard hides any of it. `field` is whether a view may start or go on:
 * a field that opens a keyboard has focus, or a view is already open.
 */
export function keyboardView(input: { layoutHeight: number; viewport: ViewportSource | null; field: boolean }): KeyboardView | null {
  const v = input.viewport;
  if (!v || !input.field || Math.abs(v.scale - 1) > 0.01) return null;
  const top = Math.max(0, v.offsetTop);
  const inset = Math.max(0, input.layoutHeight - top - v.height);
  if (inset < NOISE && top < NOISE) return null;
  // Round the edges, not each number, so top, height and inset still add up to the layout's height.
  const edge = Math.round(top);
  const foot = Math.round(top + v.height);
  return { top: edge, height: foot - edge, inset: Math.max(0, Math.round(input.layoutHeight) - foot) };
}

export { opensKeyboard, type FocusTarget } from "./keyboardField.ts";

const sameView = (a: KeyboardView | null, b: KeyboardView | null) => a === b || (a !== null && b !== null && a.top === b.top && a.height === b.height && a.inset === b.inset);

let current: KeyboardView | null = null;
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

/** The keyboard's view read afresh from the page, for a surface that places itself on an event of its own, before the store may have heard it. */
export function readKeyboardView(): KeyboardView | null {
  if (typeof window === "undefined") return null;
  const open = detach !== null && current !== null;
  const view = keyboardView({ layoutHeight: window.innerHeight, viewport: window.visualViewport ?? null, field: open || opensKeyboard(document.activeElement as FocusTarget | null) });
  return view ?? (pageHeldShort() ? { top: 0, height: Math.round(window.innerHeight), inset: 0 } : null);
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
 * takes focus, and again each time `layout` changes, what the surface
 * lays out by (the keyboard's view, or more), after it has laid out, and after a resize of the page,
 * which is how Android Chrome makes room for its keyboard (index.html), so
 * there the view stays null. A touch drag or a wheel on the scroller is a
 * scroll on purpose, and stops it for that field until a field takes
 * focus again. `margin` is in the scroller's own px, as its interface size
 * draws them.
 */
export function useFieldInView(scroller: RefObject<HTMLElement | null>, layout: unknown, margin: number): void {
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
  }, [scroller, layout, margin]);
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

/**
 * The follow state of useFieldInView for a surface that places itself on
 * events of its own, such as a popover placed again: it follows the field
 * that takes focus inside `scroller` until a touch drag or a wheel there
 * scrolls on purpose, and `keep` keeps that field in view while it still
 * has focus. `stop` takes its listeners off.
 */
export function followField(scroller: HTMLElement, margin: number): { keep(): void; stop(): void } {
  let following: HTMLElement | null = null;
  const onFocusIn = (e: FocusEvent) => {
    following = e.target instanceof HTMLElement && e.target !== scroller && opensKeyboard(e.target) ? e.target : null;
  };
  const onUserScroll = () => {
    following = null;
  };
  // A field with focus already, as a popover opens on its own field, is followed from the start.
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== scroller && scroller.contains(active) && opensKeyboard(active)) following = active;
  scroller.addEventListener("focusin", onFocusIn);
  scroller.addEventListener("touchmove", onUserScroll, { passive: true });
  scroller.addEventListener("wheel", onUserScroll, { passive: true });
  return {
    keep() {
      if (following?.isConnected && document.activeElement === following && scroller.contains(following)) keepInView(scroller, following, margin);
    },
    stop() {
      scroller.removeEventListener("focusin", onFocusIn);
      scroller.removeEventListener("touchmove", onUserScroll);
      scroller.removeEventListener("wheel", onUserScroll);
    },
  };
}

/**
 * Whether focus is in a field inside `ref` that opens the on-screen
 * keyboard: a surface holding it freezes the choices that would hide it,
 * fold it or turn it modal while someone types there (docs/design.md 14.4).
 */
export function useTypingWithin(ref: RefObject<HTMLElement | null>): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const read = () => {
      const el = ref.current;
      const active = document.activeElement;
      setTyping(el !== null && active instanceof HTMLElement && el.contains(active) && opensKeyboard(active));
    };
    read();
    document.addEventListener("focusin", read, true);
    document.addEventListener("focusout", read, true);
    return () => {
      document.removeEventListener("focusin", read, true);
      document.removeEventListener("focusout", read, true);
    };
  }, [ref]);
  return typing;
}

/**
 * Whether a body showing `visible` px holds a focused field and what goes
 * with it (fieldScroll's group), `margin` clear above and below. A group
 * more than three times the field's height is a long form, and the field
 * alone must fit.
 */
export function holdsField(input: { visible: number; field: number; group: number; margin: number }): boolean {
  const need = input.group <= 3 * input.field ? input.group : input.field;
  return input.visible >= need + 2 * input.margin - 0.5;
}

/** holdsField for a scrolling body and the field focused in it, measured, in the body's own px at the interface size. Null when no keyboard field inside it has focus. */
export function bodyHoldsField(body: HTMLElement, margin: number): boolean | null {
  const field = document.activeElement;
  if (!(field instanceof HTMLElement) || field === body || !body.contains(field) || !opensKeyboard(field)) return null;
  const box = body.getBoundingClientRect();
  const zoom = effectiveZoom(body, box.width);
  const seen = scrollerSeen(body, box, zoom);
  const form = field.closest("form");
  const group = form && body.contains(form) ? form.getBoundingClientRect().height : field.getBoundingClientRect().height;
  return holdsField({ visible: Math.max(0, seen.bottom - seen.top), field: field.getBoundingClientRect().height, group, margin: margin * zoom });
}

/**
 * What of a scroller's box shows, in the page's px: inside the visual
 * viewport, and inside its scroll padding, which a scroller with a sticky
 * header or a fade at its foot sets to their heights (the token bar's), so
 * a field kept in view is never kept under them. `zoom` is the scroller's
 * interface size.
 */
function scrollerSeen(scroller: HTMLElement, box: DOMRect, zoom: number): Span {
  const viewport = window.visualViewport;
  // getBoundingClientRect is from the layout viewport's top, as the visual viewport's offsetTop is.
  const seen = viewport ? { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height } : { top: 0, bottom: window.innerHeight };
  const style = getComputedStyle(scroller);
  // "auto" is no padding.
  const pad = (v: string) => (Number.parseFloat(v) || 0) * zoom;
  return { top: Math.max(box.top + pad(style.scrollPaddingTop), seen.top), bottom: Math.min(box.bottom - pad(style.scrollPaddingBottom), seen.bottom) };
}

function keepInView(scroller: HTMLElement, field: HTMLElement, margin: number): void {
  const box = scroller.getBoundingClientRect();
  // The boxes are in the page's px, and scrollTop in the scroller's own, which the interface size zooms.
  const zoom = effectiveZoom(scroller, box.width);
  const visible = scrollerSeen(scroller, box, zoom);
  if (visible.bottom <= visible.top) return;
  const form = field.closest("form");
  const group = form && scroller.contains(form) ? form.getBoundingClientRect() : field.getBoundingClientRect();
  const delta = fieldScroll({ field: field.getBoundingClientRect(), group, visible, margin: margin * zoom });
  if (delta !== 0) scroller.scrollTop += delta / zoom;
}
