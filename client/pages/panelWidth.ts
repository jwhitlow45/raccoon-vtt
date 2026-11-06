import { TAP_SLOP_PX } from "../lib/gestures.ts";
import { theme } from "../lib/theme.ts";

/**
 * The side panel's width (docs/design/design-v1-panel-size.md 3 and 4): one
 * source for its bounds, the clamp, the rounding and what a change stores.
 * Every width here is in layout px, the chrome's own before the interface
 * size's zoom, and whole, rounded down, so the map's least width holds
 * exactly: 1440 at 130% is a layout of 1107.7, whose cap is 507.
 *
 * The stored width is this device's (features/device/settings.ts), never
 * the room's. `null` is the default, so a later change of the default
 * reaches every device that never chose a width.
 */

/** The least the panel draws: the width every panel is designed and measured at. */
export const PANEL_MIN = theme.layout.sidePanelWidth;

/** The most it ever draws, which keeps help lines near 80 characters. */
export const PANEL_MAX = 640;

/** The map keeps at least this much beside the panel, so the DM's mouse toolbar stays whole with room for the tool options. */
export const MAP_MIN = 600;

/** One key step, and a step with Shift, as the split bar's grip takes. */
export const EDGE_STEP = 8;
export const EDGE_STEP_BIG = 64;

/** The widest the panel draws in a layout this wide: whole px, never under the least. */
export function panelCap(layoutWidth: number): number {
  return Math.max(PANEL_MIN, Math.floor(Math.min(PANEL_MAX, layoutWidth - MAP_MIN)));
}

/** The width the panel draws: the stored one clamped to the bounds and rounded down, or the default. */
export function drawnWidth(stored: number | null, layoutWidth: number): number {
  if (stored === null || !Number.isFinite(stored)) return PANEL_MIN;
  return Math.min(panelCap(layoutWidth), Math.max(PANEL_MIN, Math.floor(stored)));
}

/** What a drawn width stores: `null` at the default, so the default is never written as a number. */
export function storedFor(width: number): number | null {
  return width <= PANEL_MIN ? null : Math.floor(width);
}

/** A width a key or a drag reaches from `start`, clamped and rounded down as it draws. */
export function widthAt(start: number, delta: number, layoutWidth: number): number {
  return drawnWidth(start + delta, layoutWidth);
}

/**
 * The width a drag that began at `start`, with the pointer at `fromX`,
 * reaches with the pointer at `toX`, both in screen px: the edge is on the
 * panel's left, so a move to the left widens it. Null while a drag that
 * has not moved stays inside the slop a tap on the map has, so a
 * double-click never drags.
 */
export function dragWidth(input: { start: number; fromX: number; toX: number; zoom: number; layoutWidth: number; moved: boolean }): number | null {
  const dx = (input.fromX - input.toX) / input.zoom;
  if (!input.moved && Math.abs(dx) <= TAP_SLOP_PX) return null;
  return widthAt(input.start, dx, input.layoutWidth);
}

/** The edge's keys: Left widens, Right narrows, Home goes to the default and End to the cap. Null for any other key. */
export type EdgeKey = { kind: "step"; delta: number } | { kind: "home" } | { kind: "end" };

export function edgeKey(key: string, shift: boolean): EdgeKey | null {
  const size = shift ? EDGE_STEP_BIG : EDGE_STEP;
  if (key === "ArrowLeft") return { kind: "step", delta: size };
  if (key === "ArrowRight") return { kind: "step", delta: -size };
  if (key === "Home") return { kind: "home" };
  if (key === "End") return { kind: "end" };
  return null;
}

/** What a change does to the setting: store a value, go back to the device's own (ending page-only mode), or nothing. */
export type WidthWrite = { kind: "set"; value: number | null } | { kind: "restore" } | { kind: "none" };

/**
 * A key step's write: a change from the width drawn before the key stores
 * what it draws, and no change stores nothing, so Left at the cap in a
 * narrow window leaves a wider stored width alone.
 */
export function keyWrite(before: number, after: number): WidthWrite {
  return after === before ? { kind: "none" } : { kind: "set", value: storedFor(after) };
}

/**
 * A drag's release: a change from the width drawn as the drag began
 * commits, and no change restores, so a released drag always leaves the
 * page-only mode its moves showed through.
 */
export function releaseWrite(start: number, end: number): WidthWrite {
  return end === start ? { kind: "restore" } : { kind: "set", value: storedFor(end) };
}

/**
 * Double-click, Home and Reset width: the default stored whenever the
 * stored value is not already the default, even where the panel draws 360
 * already (a stored 640 in a 960 window), so a wider window later draws 360.
 */
export function resetWrite(stored: number | null): WidthWrite {
  return stored === null ? { kind: "none" } : { kind: "set", value: null };
}

/** What a screen reader hears as the separator's value. */
export function widthText(width: number): string {
  return width === PANEL_MIN ? `${width} pixels, the default` : `${width} pixels`;
}
