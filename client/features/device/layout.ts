import { useEffect, useState, type CSSProperties } from "react";
import type { Camera, Insets, Point, Size } from "../../lib/camera.ts";
import { subscribeUiScale, uiScale, useUiScale } from "./settings.ts";

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

/** The layout size, kept up to date through resizes and changes of the interface size. */
export function useLayoutSize(): Size {
  const scale = useUiScale();
  const [size, setSize] = useState(() => layoutSize(window, scale));
  useEffect(() => {
    const read = () => setSize(layoutSize(window, uiScale()));
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
