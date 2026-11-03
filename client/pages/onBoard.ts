import type { CSSProperties } from "react";
import { MARK_RING } from "../lib/memberColor.ts";
import { BOARD_SCOPE, boardTheme, ON_BOARD, ON_BOARD_STYLE, theme } from "../lib/theme.ts";

/*
 * The Room page where it meets the board, which keeps its dark look in
 * both schemes (docs/design/design-v1-light-theme.md 6.4, D-261102-362):
 * the ground around the map, the toolbar's floating buttons and the map's
 * focus target, the marks in a member's color, and the scene gate on the
 * black stage. Apart from Room.tsx, which a unit test cannot import, so
 * each rule is tested on its own.
 */

/** The ground around the map: the board's, so a light page never frames the map in white. */
export const MAP_GROUND = boardTheme.color.bg;

/**
 * A toolbar button's ground. From 900 px up the toolbar has no band, so a
 * floating button stands on the board. Its chosen tint lies over the same
 * overlay its neighbors wear, so on a light page the accent reads on a
 * light square rather than on whatever map art shows through the tint.
 */
export function toolGround(chosen: boolean, floating: boolean): string {
  if (!chosen) return floating ? theme.color.overlay : "transparent";
  return floating ? `linear-gradient(${theme.color.accentTint}, ${theme.color.accentTint}), ${theme.color.overlay}` : theme.color.accentTint;
}

/**
 * What a floating toolbar button adds: the two-tone ring of chrome on the
 * board (`ON_BOARD`), since a zoomed or panned map can put white art under
 * its ring. A button on a phone's or tablet's band rings on the band.
 */
export function toolOnBoard(floating: boolean): { attrs: Record<string, string>; style: Record<string, string> } {
  return floating ? { attrs: ON_BOARD, style: ON_BOARD_STYLE } : { attrs: {}, style: {} };
}

/**
 * The map's focus target (pages/mapFocus.ts): over the whole map, drawing
 * nothing but its ring, inside the map's edge. Under keys it keeps its
 * ring where other places focus lands draw none (data-rvtt-ring,
 * globals.css), and after a pointer it draws neither ring nor halo
 * (D-261102-538). The ring is the two-tone one in its inset form, since
 * the map's own art lies under it.
 */
export const MAP_FOCUS_ATTRS = { ...ON_BOARD, "data-rvtt-ring": "" } as const;
export const MAP_FOCUS_STYLE = { position: "absolute", inset: 0, pointerEvents: "none", outlineOffset: -2, ...ON_BOARD_STYLE } as CSSProperties;

/**
 * A dot in a member's raw color, with the 1 px ring every such mark wears
 * (D-261102-365), so a white or yellow dot still shows its edge on a light
 * bar. Inset, so the dot keeps its size.
 */
export function memberDotStyle(color: string, size: number): CSSProperties {
  return { flex: "none", width: size, height: size, borderRadius: theme.radius.round, background: color, boxShadow: MARK_RING };
}

/**
 * The scene gate (D-261102-364): black, not the page's ground, so a
 * blackout and a load look alike, and the whole dark palette and the dark
 * accent inside it, since light muted text reads 2.8:1 on black. Its text
 * color is set here, under the scope, as the inherited one is the page's.
 */
export const SCENE_GATE_STYLE = {
  ...BOARD_SCOPE,
  position: "absolute",
  inset: 0,
  background: theme.color.stage,
  display: "grid",
  placeItems: "center",
  color: theme.color.textMuted,
  fontSize: theme.font.body14,
  padding: theme.space(6),
  textAlign: "center",
} as CSSProperties;
