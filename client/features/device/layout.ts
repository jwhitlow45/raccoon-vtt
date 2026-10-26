import { useEffect, useState, type CSSProperties } from "react";
import type { Camera, Insets, Point, Size } from "../../lib/camera.ts";
import { isCoarsePointer } from "../../lib/device.ts";
import { typingNow } from "../../lib/keyboardField.ts";
import { subscribeUiScale, uiScale } from "./settings.ts";

/**
 * The interface size (docs/design-v1-dm-tools.md 3.16) without rewriting
 * every inline pixel: each piece of chrome (the bars, the toolbar, panels,
 * sheets, dialogs, toasts, the token action bar and the label pane) takes
 * the CSS `zoom` property, and the map canvas never does, so its pointer
 * math (a client position minus the canvas's rectangle) stays in plain
 * screen pixels. What follows from that lives here:
 *
 * - Layout decisions read the window divided by the scale, so a 1,000 px
 *   window at 130% lays out as 769 px wide, the phone layout.
 * - The bars' insets over the map are measured with getBoundingClientRect,
 *   which reports the size as drawn (Room.tsx).
 * - What sits at a point of the map inside a zoomed layer (the action bar,
 *   the label pane) gets that point divided by the scale, since the layer
 *   multiplies its lengths again.
 * - Fields keep a drawn size of at least 16 px below 100%, or iOS zooms the
 *   page into one when it takes focus (the rule in globals.css that
 *   `smallUi` turns on).
 * - `zoom` multiplies viewport units as it does pixels, so a share of the
 *   screen inside zoomed chrome is written with screenHeight or
 *   screenWidth, and a dialog's card is sized by percentages of the dialog,
 *   which covers the screen.
 */

/** The size the layout reads: the window's, in the zoomed chrome's own pixels. */
export function layoutSize(window: { innerWidth: number; innerHeight: number }, scale: number): Size {
  return { width: window.innerWidth / scale, height: window.innerHeight / scale };
}

/** The layout width now, for code outside render, such as a sheet choosing its placement as it opens. */
export function layoutWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth / uiScale();
}

/** The size the layout reads, and whether it is a taller one kept while the page is short for a keyboard (steadySize). */
export type SteadySize = { size: Size; held: boolean };

/**
 * The size the layout keeps as the page measures `next`: `next`, except
 * when the page has only grown shorter at the same width while a field
 * that opens the on-screen keyboard has focus. A browser that shrinks the
 * page for its keyboard, rather than only the visual viewport as iOS
 * Safari and Android Chrome do, then leaves the room as it was: a phone
 * whose page grew shorter than it is wide does not turn the room
 * sideways, and no height rule (a sheet's mode, the dock, the bar's
 * compact rule, a roll card's fit) flips while someone types (docs/
 * design.md 14.4). What stands at the foot follows the keyboard by
 * placement instead (lib/keyboardInset.ts).
 *
 * Once held, the size stays while the page stays short, whatever has
 * focus, as the keyboard's view does: a tap on Spend takes focus from the
 * field before the keyboard closes, and the room must not turn under the
 * finger. It goes as the page grows back or changes width.
 */
export function steadySize(kept: SteadySize, next: Size, typing: boolean): SteadySize {
  const shorter = next.width === kept.size.width && next.height < kept.size.height;
  if (shorter && (typing || kept.held)) return kept.held ? kept : { size: kept.size, held: true };
  const same = next.width === kept.size.width && next.height === kept.size.height;
  return same && !kept.held ? kept : { size: same ? kept.size : next, held: false };
}

/** The page's steady size, one for every reader, so the room and the keyboard's view (lib/keyboardInset.ts) agree on whether it is held. */
let steadyNow: SteadySize | null = null;

/**
 * The steady size for the page as it measures now, brought up to date:
 * whoever reads first after a resize updates it, and the next reader gets
 * the same answer, so the order of their listeners never matters.
 */
export function readSteady(): SteadySize {
  const next = layoutSize(window, uiScale());
  // A computer opens no on-screen keyboard: its window made shorter is the size to read, field in focus or not.
  const typing = isCoarsePointer() && typingNow();
  steadyNow = steadySize(steadyNow ?? { size: next, held: false }, next, typing);
  return steadyNow;
}

/** Whether the page is shorter than the size the room keeps, as a browser that shrinks the page for its keyboard leaves it while someone types. */
export function pageHeldShort(): boolean {
  return typeof window !== "undefined" && readSteady().held;
}

/** The layout size, kept up to date through resizes and changes of the interface size, and steady while someone types on a touch device (steadySize). */
export function useLayoutSize(): Size {
  const [size, setSize] = useState<Size>(() => readSteady().size);
  useEffect(() => {
    // The steady size keeps its identity while nothing changes, so an unchanged read renders nothing.
    const read = () => setSize(readSteady().size);
    read();
    window.addEventListener("resize", read);
    const unsubscribe = subscribeUiScale(read);
    return () => {
      window.removeEventListener("resize", read);
      unsubscribe();
    };
  }, []);
  return size;
}

/**
 * A share of the screen's height, for a box inside zoomed chrome: `60dvh`
 * there would draw as 78% of the screen at 130%. Divided by the zoom the
 * chrome carries (`--rvtt-ui`, which chromeZoom and zoomed dialogs set), it
 * draws as the share asked for, and outside zoomed chrome it is plain dvh.
 */
export function screenHeight(percent: number): string {
  return `calc(${percent}dvh / var(--rvtt-ui, 1))`;
}

/** A share of the screen's width inside zoomed chrome, as screenHeight. */
export function screenWidth(percent: number): string {
  return `calc(${percent}vw / var(--rvtt-ui, 1))`;
}

/** The style that zooms one piece of chrome. Nothing at 100%, so the page is exactly as it was. */
export function chromeZoom(scale: number): CSSProperties {
  if (scale === 1) return {};
  return { zoom: scale, ["--rvtt-ui" as string]: String(scale) } as CSSProperties;
}

/** Marks a zoomed piece whose fields would draw under 16 px, for the rule in globals.css. */
export function smallUi(scale: number): { "data-rvtt-small-ui"?: "" } {
  return scale < 1 ? { "data-rvtt-small-ui": "" } : {};
}

/** The parts of an element `effectiveZoom` reads, so its rule runs under node --test. */
export type ZoomedElement = { readonly currentCSSZoom?: number; readonly offsetWidth: number; getBoundingClientRect(): { readonly width: number } };

/**
 * How many of the page's px each of an element's own px draws as: every
 * `zoom` around it multiplied together, the interface size's (chromeZoom)
 * among them. currentCSSZoom says so exactly. A browser without it gets
 * the drawn width over offsetWidth instead, which offsetWidth's rounding to
 * whole pixels leaves off by half a pixel in the element's width at most.
 * A caller that has just measured the drawn width passes it as `drawn`, so
 * the box is not read twice. With nothing to go by, the zoom is 1.
 */
export function effectiveZoom(el: ZoomedElement, drawn?: number): number {
  const exact = el.currentCSSZoom;
  if (typeof exact === "number" && exact > 0) return exact;
  const width = drawn ?? el.getBoundingClientRect().width;
  return el.offsetWidth > 0 && width > 0 ? width / el.offsetWidth : 1;
}

/*
 * These hand back what they were given at 100%, so a layer that is not
 * zoomed sees the very objects it saw before, and memos keyed on them hold.
 */

/** A screen point inside a layer zoomed by `scale`. */
export function inZoomed(p: Point, scale: number): Point {
  return scale === 1 ? p : { x: p.x / scale, y: p.y / scale };
}

export function sizeInZoomed(s: Size, scale: number): Size {
  return scale === 1 ? s : { width: s.width / scale, height: s.height / scale };
}

export function insetsInZoomed(i: Insets, scale: number): Insets {
  return scale === 1 ? i : { top: i.top / scale, right: i.right / scale, bottom: i.bottom / scale, left: i.left / scale };
}

/**
 * The map camera as a zoomed layer sees it: what it puts at screen point p
 * lands at p / scale there, which the layer draws back at p.
 */
export function cameraInZoomed(cam: Camera, scale: number): Camera {
  return scale === 1 ? cam : { x: cam.x / scale, y: cam.y / scale, scale: cam.scale / scale };
}

/**
 * A bar's inset over the map, from its rectangle as drawn
 * (getBoundingClientRect). A ResizeObserver reports a zoomed bar's own,
 * unzoomed size, which would leave part of the map under it.
 */
export function barInset(rect: { height: number } | null | undefined): number {
  return rect ? Math.round(rect.height) : 0;
}
