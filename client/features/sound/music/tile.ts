import { createElement, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../../../components/Icon.tsx";
import { MEMBER_COLOR_NAMES, MEMBER_COLORS, theme } from "../../../lib/theme.ts";

/**
 * A track's or a playlist's tile (docs/design/design-v1-music-player.md 7,
 * D-261102-967): no art. A rounded square in one of eight fixed tints,
 * picked by a hash of the name, mixed into the raised surface, with the
 * app's music icon or the playlist icon in the text color. Nothing is drawn
 * or generated but the color. A name always gets the same tint, so two
 * copies of one track look alike, and a renamed one may change.
 */

/**
 * The eight tints, before the mix: the member colors' hues less the crest
 * yellow, which is the accent and marks what is chosen, and white. At full
 * strength they mark players, so a tile only ever mixes them in.
 */
const TINT_NAMES = ["Blue", "Green", "Purple", "Pink", "Teal", "Brown", "Coral", "Orange"] as const;
export const TINTS: readonly string[] = TINT_NAMES.map((name) => MEMBER_COLORS.find((c) => MEMBER_COLOR_NAMES[c] === name)!);

/** How much of the tint goes into the raised surface, so the icon keeps 3:1 on every tint in both themes (tile.test.ts). */
export const TINT_SHARE = 0.38;

/** The icon's share of the tile's side. */
export const ICON_SHARE = 0.42;

/** The tint a name gets: a small string hash, case folded, so the same name always has the same one. */
export function tintOf(name: string): string {
  let h = 0;
  for (const ch of name.toLocaleLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return TINTS[h % TINTS.length]!;
}

/** The tile's background, as CSS draws it: the tint mixed into the raised surface in OKLab. */
export function tileBackground(name: string): string {
  return `color-mix(in oklab, ${tintOf(name)} ${Math.round(TINT_SHARE * 100)}%, ${theme.color.surfaceRaised})`;
}

/** Tile sizes (7): 64 in the window's Now playing (48 under 300 px of width), 44 in the Sound group, 40 in Library's rows. */
export const TILE = { now: 64, nowNarrow: 48, group: 44, row: 40 } as const;

export function Tile(props: { name: string; size: number; icon?: "music" | "queue" }): ReactNode {
  const style: CSSProperties = {
    flex: "none",
    width: props.size,
    height: props.size,
    borderRadius: theme.radius.md,
    display: "grid",
    placeItems: "center",
    background: tileBackground(props.name),
    color: theme.color.text,
  };
  return createElement("span", { "aria-hidden": true, "data-music-tile": "", style }, createElement(Icon, { name: props.icon ?? "music", size: Math.round(props.size * ICON_SHARE) }));
}

// OKLab, as CSS color-mix() does it, so the test measures the color the browser draws.

function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function fromLinear(v: number): number {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

function oklab(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [toLinear((n >> 16) & 255), toLinear((n >> 8) & 255), toLinear(n & 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function hexOf(lab: [number, number, number]): string {
  const [L, A, B] = lab;
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map((v) => fromLinear(v).toString(16).padStart(2, "0")).join("")}`;
}

/** `share` of `a` mixed into `b` in OKLab, as `color-mix(in oklab, a share, b)`. */
export function mixOklab(a: string, b: string, share: number): string {
  const x = oklab(a);
  const y = oklab(b);
  return hexOf([x[0] * share + y[0] * (1 - share), x[1] * share + y[1] * (1 - share), x[2] * share + y[2] * (1 - share)]);
}
