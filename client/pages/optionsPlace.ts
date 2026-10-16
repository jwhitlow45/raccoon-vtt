import { SHORT_LANDSCAPE_MAX } from "../features/encounter/band.ts";

/*
 * Where the active tool's options stand (docs/design-v1-layout-hierarchy.md
 * 3.1): the bar at the foot, above the toolbar, or a rail on the left of
 * the map on a short screen held sideways, where a bar at the foot took
 * most of the map's height. Plain functions, so every rule runs under
 * node --test.
 */

/** The rail's width before the left safe area: 231 px of content, 8 px padding at each side and a 1 px edge. */
export const RAIL_WIDTH = 248;

/**
 * Whether this screen allows the rail at all: sideways, short (under
 * 500 px tall, the line the turn strip draws), and with the rail and the
 * left safe area taking at most half of the map's width, since the bar at
 * the foot never takes more than half the screen's height, and the rail
 * must not swap a map with no height for one with no width. `mapWidth` is
 * the layout's width less a side panel that shows.
 */
export function railAllowed(input: { width: number; height: number; mapWidth: number; safeLeft: number }): boolean {
  return input.width > input.height && input.height < SHORT_LANDSCAPE_MAX && RAIL_WIDTH + input.safeLeft <= input.mapWidth / 2;
}

/**
 * Where the tool's options go. Tools whose options run past one row use
 * the rail wherever it is allowed. A one-row tool (`optionsAt: "foot"`)
 * stays at the foot, where it costs less map, unless its row wrapped at a
 * foot this wide or narrower (`wrappedAt`, the widest foot it wrapped at,
 * as wrapRecord keeps it). Multi-select never moves: it is the mode's
 * one-row status line, and a rail would leave almost no map to tap tokens
 * on beside the token bar.
 */
export function optionsPlace(input: { allowed: boolean; toolId: string; optionsAt?: "foot"; footWidth: number; wrappedAt: number | null }): "rail" | "foot" {
  if (!input.allowed) return "foot";
  if (input.optionsAt !== "foot") return "rail";
  if (input.toolId === "select") return "foot";
  return input.wrappedAt !== null && input.footWidth <= input.wrappedAt ? "rail" : "foot";
}

/** The record once a one-row tool's row wrapped at a foot this wide: never shrinks, so the widest wrap holds. */
export function wrapRecord(before: number | null, footWidth: number): number {
  return before === null ? footWidth : Math.max(before, footWidth);
}

/**
 * Whether controls, by their boxes as drawn, stand on more than one line:
 * one starts at or below where another ends. Controls of different heights
 * on one line overlap down the page, so their tops alone would not tell.
 */
export function wrapsLines(boxes: readonly { top: number; bottom: number }[]): boolean {
  return boxes.some((a) => boxes.some((b) => a.top >= b.bottom - 0.5));
}
