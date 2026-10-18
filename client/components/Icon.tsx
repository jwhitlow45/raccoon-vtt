import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "#shared/credits.ts";
import { theme } from "../lib/theme.ts";

/**
 * The interface's icons, drawn as inline SVG in `currentColor` with 2 px
 * strokes. They replace the glyphs `×`, `‹`, `›`, `⋯`, `▸`, `▾` and `−`
 * used as icons, which drew at a different size and weight in every font
 * and on every phone. Glyphs inside text ("30 × 20", "↑10 ft") stay text.
 *
 * Each name is a meaning, not a picture, so one icon means one thing
 * everywhere (docs/design-v1-icons.md 2). Most are drawn for the app. Those
 * marked Lucide copy that set's path data (lucide.dev, ISC license, credited
 * in shared/credits.ts and CREDITS.md), on the same 24 unit grid and 2 px
 * round stroke, so the two sets read as one.
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
  | "fullScreen"
  | "leaveFullScreen"
  | "collapsePanel"
  | "splitPanel"
  | "swapPanels"
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
  | "fogRoom"
  | "noCaster"
  | "again"
  | "hidden"
  | "shown"
  | "speed"
  | "group"
  | "delete"
  | "edit"
  | "retry"
  | "locked"
  | "duplicate"
  | "ping"
  | "panels"
  | "crop"
  | "arrowUp"
  | "arrowDown"
  | "removeFromFight"
  | "eraser"
  | "arrowLeft"
  | "arrowRight"
  | "zoomIn"
  | "zoomOut"
  | "focus"
  | "download"
  | "share"
  | "settings"
  | "device"
  | "about"
  | "leave"
  | "guide"
  | "external"
  | "pass"
  | "fail";

/**
 * The meanings drawn with Lucide's path data, by the Lucide icon each
 * copies. The credit (shared/credits.ts LUCIDE_ICONS, CREDITS.md) lists
 * the same icons, which a test holds it to.
 */
export const LUCIDE: Partial<Record<IconName, LucideIcon>> = {
  undo: "undo-2",
  redo: "redo-2",
  again: "repeat",
  hidden: "eye-off",
  shown: "eye",
  speed: "footprints",
  group: "users",
  delete: "trash-2",
  edit: "pencil",
  retry: "refresh-cw",
  locked: "lock",
  duplicate: "copy-plus",
  ping: "radar",
  panels: "menu",
  crop: "crop",
  arrowUp: "arrow-up",
  arrowDown: "arrow-down",
  removeFromFight: "user-minus",
  eraser: "eraser",
  arrowLeft: "arrow-left",
  arrowRight: "arrow-right",
  zoomIn: "zoom-in",
  zoomOut: "zoom-out",
  focus: "focus",
  download: "download",
  share: "share",
  settings: "settings",
  device: "smartphone",
  about: "info",
  leave: "log-out",
  guide: "book-open",
  external: "external-link",
  fullScreen: "maximize-2",
  leaveFullScreen: "minimize-2",
};

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const CHECK = <path {...STROKE} d="M5 12.5l4.5 4.5L19 7.5" />;
const CROSS = <path {...STROKE} d="M6 6l12 12M18 6L6 18" />;

/** Each icon on a 24 unit square, so every one sits on the same grid at any size. */
const SHAPES: Record<IconName, ReactNode> = {
  close: CROSS,
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
  check: CHECK,
  copy: (
    <g {...STROKE}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </g>
  ),
  filter: <path {...STROKE} d="M4 5h16l-6 7.5V19l-4 2v-8.5z" />,
  expand: <path {...STROKE} d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  // Lucide maximize-2 and minimize-2: the whole page in the browser's full screen, and back (lib/fullscreen.ts). Arrows rather than `expand`'s corners, which the top bar's Fit beside them already draws.
  fullScreen: (
    <g {...STROKE}>
      <path d="M15 3h6v6" />
      <path d="m21 3-7 7" />
      <path d="m3 21 7-7" />
      <path d="M9 21H3v-6" />
    </g>
  ),
  leaveFullScreen: (
    <g {...STROKE}>
      <path d="m14 10 7-7" />
      <path d="M20 10h-6V4" />
      <path d="m3 21 7-7" />
      <path d="M4 14h6v6" />
    </g>
  ),
  // A framed panel with its right edge and an arrow toward it, for Hide: a bare chevron read as a scrolling row's arrow, or as forward beside Back.
  collapsePanel: (
    <g {...STROKE}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16M8 9l3 3-3 3" />
    </g>
  ),
  // A framed panel split across its middle, for More's "Two panels" (docs/design-v1-split-panel.md 4.1): one panel above another.
  splitPanel: (
    <g {...STROKE}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 12h16" />
    </g>
  ),
  // An up arrow beside a down arrow, for the split's Swap: the two panels change places.
  swapPanels: <path {...STROKE} d="M8 19V5M4 9l4-4 4 4M16 5v14M12 15l4 4 4-4" />,
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
  // Undo and Redo, in the top bar and a tool's own row. Lucide's undo-2 and redo-2: the filled arrows they replace were the only filled shapes in a stroked set.
  undo: <path {...STROKE} d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11" />,
  redo: <path {...STROKE} d="m15 14 5-5-5-5M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13" />,
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
  // A plain circle crossed by a slash, where the area tool's From control names no creature: No caster, or "From you" (docs/design-v1-area-from-character.md 3.2).
  noCaster: <path {...STROKE} d="M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16zM6.3 17.7L17.7 6.3" />,
  // Lucide repeat: a roll sent again as it went. Never Redo, which takes back an undo.
  again: <path {...STROKE} d="m17 2 4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3" />,
  // Lucide eye-off: hidden from players (a secret roll, a hidden token, a DM-only note). Never the side panel's Hide.
  hidden: (
    <path
      {...STROKE}
      d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49M14.084 14.158a3 3 0 0 1-4.242-4.242M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143M2 2l20 20"
    />
  ),
  // Lucide eye: players see it.
  shown: (
    <g {...STROKE}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </g>
  ),
  // Lucide footprints: a creature's speed.
  speed: (
    <path
      {...STROKE}
      d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0ZM20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0ZM16 17h4M4 13h4"
    />
  ),
  // Lucide users: several creatures at once, such as a group save.
  group: (
    <g {...STROKE}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.128a4 4 0 0 1 0 7.744M22 21v-2a4 4 0 0 0-3-3.87" />
      <circle cx="9" cy="7" r="4" />
    </g>
  ),
  // Lucide trash-2: delete or remove a thing for good.
  delete: <path {...STROKE} d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6" />,
  // Lucide pencil: edit.
  edit: <path {...STROKE} d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4" />,
  // Lucide refresh-cw: try a failed load again.
  retry: <path {...STROKE} d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5" />,
  // Lucide lock: a token that cannot be moved.
  locked: (
    <g {...STROKE}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </g>
  ),
  // Lucide copy-plus: a second one of this thing. Never Copy, which puts text on the clipboard.
  duplicate: (
    <g {...STROKE}>
      <path d="M15 12v6M12 15h6M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      <rect x="8" y="8" width="14" height="14" rx="2" />
    </g>
  ),
  // Lucide radar: the Ping tool, a call to look here. Never a pin, which the Pin tool draws.
  ping: (
    <g {...STROKE}>
      <path d="M19.07 4.93A10 10 0 0 0 6.99 3.34M4 6h.01M2.29 9.62A10 10 0 1 0 21.31 8.35M16.24 7.76A6 6 0 1 0 8.23 16.67M12 18h.01M17.99 11.66A6 6 0 0 1 15.77 16.67M13.41 10.59l5.66-5.66" />
      <circle cx="12" cy="12" r="2" />
    </g>
  ),
  // Lucide menu: the toolbar's Panels, which lists the side panels.
  panels: <path {...STROKE} d="M4 12h16M4 18h16M4 6h16" />,
  // Lucide crop: crop a picture.
  crop: <path {...STROKE} d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2" />,
  // Lucide arrow-up: move a thing up a list, or nudge it up. Never a fold, which takes the chevrons.
  arrowUp: <path {...STROKE} d="M5 12l7-7 7 7M12 19V5" />,
  // Lucide arrow-down: move a thing down a list, or nudge it down.
  arrowDown: <path {...STROKE} d="M12 5v14M19 12l-7 7-7-7" />,
  // Lucide user-minus: take a creature out of the fight. Never Delete: the token stays on the map.
  removeFromFight: (
    <g {...STROKE}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 11L16 11" />
      <circle cx="9" cy="7" r="4" />
    </g>
  ),
  // Lucide eraser: clear a ruler, drawings or range rings off the map. Never Close.
  eraser: <path {...STROKE} d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21M5.082 11.09l8.828 8.828" />,
  // Lucide arrow-left: nudge a thing left.
  arrowLeft: <path {...STROKE} d="M12 19l-7-7 7-7M19 12H5" />,
  // Lucide arrow-right: nudge a thing right.
  arrowRight: <path {...STROKE} d="M5 12h14M12 5l7 7-7 7" />,
  // Lucide zoom-in: make a grid's squares larger. Never Add, which takes the plus.
  zoomIn: (
    <g {...STROKE}>
      <path d="M21 21L16.65 16.65M11 8L11 14M8 11L14 11" />
      <circle cx="11" cy="11" r="8" />
    </g>
  ),
  // Lucide zoom-out: make a grid's squares smaller.
  zoomOut: (
    <g {...STROKE}>
      <path d="M21 21L16.65 16.65M8 11L14 11" />
      <circle cx="11" cy="11" r="8" />
    </g>
  ),
  // Lucide focus: look at a thing on the map, such as an area's Show. Never Shown, which says players see it.
  focus: (
    <g {...STROKE}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <circle cx="12" cy="12" r="3" />
    </g>
  ),
  // Lucide download: save a file to the device, a handout or the log.
  download: <path {...STROKE} d="M12 15V3M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5" />,
  // Lucide share: hand a file to the device's share sheet.
  share: <path {...STROKE} d="M12 2v13M16 6l-4-4-4 4M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />,
  // Lucide settings: a room's settings. Settings only.
  settings: (
    <g {...STROKE}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </g>
  ),
  // Lucide smartphone: this device's own settings.
  device: (
    <g {...STROKE}>
      <path d="M12 18h.01" />
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
    </g>
  ),
  // Lucide info: about the app, its credits and licenses.
  about: (
    <g {...STROKE}>
      <path d="M12 16v-4M12 8h.01" />
      <circle cx="12" cy="12" r="10" />
    </g>
  ),
  // Lucide log-out: leave a room, or sign out.
  leave: <path {...STROKE} d="M16 17l5-5-5-5M21 12H9M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />,
  // Lucide book-open: the DM guide.
  guide: <path {...STROKE} d="M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />,
  // Lucide external-link: a link that opens another site in a new tab.
  external: <path {...STROKE} d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
  // The DM desk's Pass and Fail, beside their words: a check and a cross, the one place they mean a save's outcome.
  pass: CHECK,
  fail: CROSS,
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
