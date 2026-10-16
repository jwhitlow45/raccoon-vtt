import type { CSSProperties, ReactNode } from "react";
import { theme } from "../lib/theme.ts";

/**
 * The interface's icons, drawn as inline SVG in `currentColor` with 2 px
 * strokes. They replace the glyphs `×`, `‹`, `›`, `⋯`, `▸`, `▾` and `−`
 * used as icons, which drew at a different size and weight in every font
 * and on every phone. Glyphs inside text ("30 × 20", "↑10 ft") stay text.
 *
 * An icon is decoration: the control around it carries the name
 * (`aria-label`, or its visible text), so the SVG is hidden from screen
 * readers.
 */

export type IconName = "close" | "back" | "more" | "chevronRight" | "chevronDown" | "plus" | "minus" | "check" | "copy" | "filter" | "expand";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Each icon on a 24 unit square, so every one sits on the same grid at any size. */
const SHAPES: Record<IconName, ReactNode> = {
  close: <path {...STROKE} d="M6 6l12 12M18 6L6 18" />,
  back: <path {...STROKE} d="M15 5l-7 7 7 7" />,
  more: (
    <g fill="currentColor">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </g>
  ),
  chevronRight: <path {...STROKE} d="M9 5l7 7-7 7" />,
  chevronDown: <path {...STROKE} d="M5 9l7 7 7-7" />,
  plus: <path {...STROKE} d="M12 5v14M5 12h14" />,
  minus: <path {...STROKE} d="M5 12h14" />,
  check: <path {...STROKE} d="M5 12.5l4.5 4.5L19 7.5" />,
  copy: (
    <g {...STROKE}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </g>
  ),
  filter: <path {...STROKE} d="M4 5h16l-6 7.5V19l-4 2v-8.5z" />,
  expand: <path {...STROKE} d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
};

export const ICON_NAMES = Object.keys(SHAPES) as IconName[];

export function Icon(props: { name: IconName; size?: keyof typeof theme.icon | number; style?: CSSProperties }) {
  const size = typeof props.size === "number" ? props.size : theme.icon[props.size ?? "md"];
  return (
    <svg aria-hidden focusable="false" viewBox="0 0 24 24" width={size} height={size} style={{ display: "block", flex: "none", ...props.style }}>
      {SHAPES[props.name]}
    </svg>
  );
}
