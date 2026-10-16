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

export type IconName =
  | "close"
  | "back"
  | "more"
  | "chevronRight"
  | "chevronDown"
  | "chevronUp"
  | "caret"
  | "plus"
  | "minus"
  | "check"
  | "copy"
  | "filter"
  | "expand"
  | "collapsePanel"
  | "resetZoom"
  | "grip"
  | "windowHome"
  | "resize"
  | "sliders"
  | "undo"
  | "redo"
  | "shapeLine"
  | "shapeArrow"
  | "shapeBox"
  | "shapeCircle"
  | "shapePolygon"
  | "areaCone"
  | "areaSphere"
  | "areaCylinder"
  | "areaCube"
  | "areaLine"
  | "areaEmanation"
  | "fogBrush"
  | "fogRoom";

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
  chevronUp: <path {...STROKE} d="M5 15l7-7 7 7" />,
  // The small mark in a value chip, or in the corner of a toolbar button, that says a tap opens a pop-up (docs/design-v1-tool-options.md 5.1, 6.2).
  caret: <path {...STROKE} d="M8 10l4 4 4-4" />,
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
  // A framed panel with its right edge and an arrow toward it, for Hide: a bare chevron read as a scrolling row's arrow, or as forward beside Back.
  collapsePanel: (
    <g {...STROKE}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16M8 9l3 3-3 3" />
    </g>
  ),
  // An arrow turning back around a center dot, for the handout viewer's Reset zoom: back to the fit, about the view's middle. The dot keeps it apart from an undo arrow.
  resetZoom: (
    <g {...STROKE}>
      <path d="M5 12a7 7 0 1 0 2.05-4.95M7 3v4h4" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </g>
  ),
  // Six dots, the usual sign that a control moves what it heads (the token window's Move window).
  grip: (
    <g fill="currentColor">
      {[6, 12, 18].flatMap((y) => [9, 15].map((x) => <circle key={`${x}:${y}`} cx={x} cy={y} r="1.75" />))}
    </g>
  ),
  // A frame with its bottom right corner filled and an arrow toward it, for the token window's Reset: back to its place, never Undo's curved arrow.
  windowHome: (
    <g>
      <g {...STROKE}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 8l5 5M12 9v4H8" />
      </g>
      <rect x="14" y="13" width="5" height="5" rx="1" fill="currentColor" />
    </g>
  ),
  // A double arrow on the top-left to bottom-right diagonal, for the token window's resize handle: turned a quarter for the other diagonal.
  resize: <path {...STROKE} d="M6 6l12 12M6 6v6M6 6h6M18 18v-6M18 18h-6" />,
  // Setup in the toolbar (docs/design-v1-tool-options.md 5.1): three sliders, for the tools that set a scene up.
  sliders: (
    <g {...STROKE}>
      <path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10" />
      <circle cx="10" cy="6" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="8" cy="18" r="2" />
    </g>
  ),
  // The top bar's undo and redo arrows (pages/RoomChrome.tsx), for a tool's own Undo and Redo.
  undo: <path fill="currentColor" d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62A7.95 7.95 0 0 1 12.5 10.5c3.54 0 6.55 2.31 7.6 5.5l2.37-.78A10.5 10.5 0 0 0 12.5 8" />,
  redo: <path fill="currentColor" d="M18.4 10.6A10.4 10.4 0 0 0 11.5 8 10.5 10.5 0 0 0 1.53 15.22l2.36.78A8 8 0 0 1 11.5 10.5c1.95 0 3.73.72 5.12 1.88L13 16h9V7z" />,
  // The plain glyphs of a tool's choices (docs/design-v1-tool-options.md 17.2): each draws the thing itself.
  shapeLine: <path {...STROKE} d="M5 19L19 5" />,
  shapeArrow: <path {...STROKE} d="M5 19L19 5M10 5h9v9" />,
  shapeBox: <rect {...STROKE} x="4" y="6" width="16" height="12" rx="1" />,
  shapeCircle: <circle {...STROKE} cx="12" cy="12" r="8" />,
  shapePolygon: <path {...STROKE} d="M12 3.5l8 6-3 10.5H7L4 9.5z" />,
  areaCone: <path {...STROKE} d="M4 12L20 5v14z" />,
  areaSphere: (
    <g {...STROKE}>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </g>
  ),
  areaCylinder: (
    <g {...STROKE}>
      <path d="M5 6.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5S15.9 4 12 4 5 5.1 5 6.5z" />
      <path d="M5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11" />
    </g>
  ),
  areaCube: <path {...STROKE} d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9" />,
  areaLine: <rect {...STROKE} x="3" y="9.5" width="18" height="5" rx="1" />,
  areaEmanation: (
    <g {...STROKE}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" />
    </g>
  ),
  fogBrush: <path {...STROKE} d="M4 16c2.5-5 4.5-6 6-3s3.5 2 5-1.5S19 8 20 9" />,
  fogRoom: <path {...STROKE} d="M4 4h16v16H4zM4 13h7M14 4v9h6" />,
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
