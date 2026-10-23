/**
 * Design tokens. Components style themselves inline from these (the house
 * convention), and globals.css carries only what an inline style cannot.
 *
 * Dark by default, because the app is mostly a map on a phone at a dim table,
 * with the crest's yellow as the accent. The crest's orange stays in the
 * logo only: the yellow was chosen for the interface (2026-10-14).
 */
export const theme = {
  color: {
    bg: "#16161a",
    surface: "#1f1f25",
    surfaceRaised: "#2a2a32",
    /** Card and section separators. Decoration only: it identifies no control. */
    border: "#3a3a44",
    /**
     * The outline that identifies a control with no text of its own: a text,
     * number or select field, a Switch's off track. At least 3:1 against
     * bg (3.9), surface (3.6) and a raised surface (3.1), as WCAG 1.4.11 asks.
     */
    controlBorder: "#76747f",
    text: "#f1efe9",
    textMuted: "#a7a5ad",
    /**
     * The label of a control that cannot act yet. Dim, but still legible:
     * 3.4:1 on a raised surface. A disabled control never fades by opacity,
     * which turned a member's accent into a muddy copy of itself.
     */
    textDisabled: "#7c7a84",
    /** Dark text on a light fill that is not the accent: the cream "viewing as" notice, the turn notice. */
    ink: "#1a1206",
    /**
     * Filled buttons, the chosen option, the focus ring and the selected
     * tool: the viewing member's own color in a room, the crest yellow
     * elsewhere (lib/accent.ts sets the variables). These four are CSS
     * variables, so they work in DOM styles only. What draws on the board
     * takes the resolved colors from `useAccent()` (state/accent.ts).
     */
    accent: "var(--rvtt-accent, #f7df00)",
    /** Text and icons on an accent fill, dark or light by the accent. */
    onAccent: "var(--rvtt-on-accent, #1a1206)",
    /** The faint fill behind a pressed or chosen control that wears the accent border. */
    accentTint: "var(--rvtt-accent-tint, rgba(247, 223, 0, 0.14))",
    /**
     * The crest yellow, fixed: the accent's default, and the yellow of
     * marks that mean something whoever looks, such as the ruler's Dash band.
     */
    crest: "#f7df00",
    /**
     * Highlights: the creature whose turn it is (its ring, its row, its
     * name), whispers and similar marks. Fixed, so it never follows a
     * member's color into a clash. A pale cream rather than a second
     * yellow, so it reads apart from the crest yellow and every member
     * color beside it, and still bright enough to stand out on a dark or a
     * brown map.
     */
    accentSoft: "#ffe8a3",
    /** Behind the turn in progress: the tracker's active row, and the strip on a player's own turn. Fixed, like `accentSoft`. */
    turnTint: "rgba(247, 223, 0, 0.08)",
    danger: "#e5484d",
    /**
     * The text of a destructive button (components/Button.tsx). `danger`
     * reads at only about 3.6:1 on a raised surface, short of the 4.5:1
     * that 16 px text needs, so the label takes this lighter red.
     */
    dangerText: "#f87171",
    /** Behind an armed destructive button. */
    dangerTint: "rgba(229, 72, 77, 0.12)",
    /** The fill of a danger notice, such as "You are offline". */
    dangerFill: "#3b1214",
    success: "#30a46c",
    warning: "#f5a524",
    /** The fill of a warning notice, such as "Reconnecting...". */
    warningFill: "#3a2a07",
    ally: "#3e8ef7",
    neutral: "#c9c9c9",
    hostile: "#e5484d",
    /** Fog of war. Players see it fully opaque, the DM at half opacity. */
    fog: "#0d0d12",
    /** Bars floating over the map, translucent so the map stays in view. */
    overlay: "rgba(22, 22, 26, 0.88)",
    /** Outline behind text drawn on the map, so it reads on any art. */
    textHalo: "#000000",
    /** Behind every dialog. */
    scrim: "rgba(0, 0, 0, 0.6)",
    /** Behind a picker that must keep the map in view, such as the stamp sheet. */
    scrimLight: "rgba(0, 0, 0, 0.2)",
    /** Pure black: the table display, the blackout and the player preview's frame. */
    stage: "#000000",
    /** Marks on a colored fill: token initials, effect badges, the QR code's light squares. */
    white: "#ffffff",
  },
  radius: { xs: 3, sm: 6, md: 10, lg: 16, pill: 999, round: "50%" },
  /** Border widths. Every outline is `border` wide, unless it marks the chosen one or a stripe. */
  line: { border: 1, strong: 2, stripe: 3 },
  space: (n: number) => n * 4,
  font: {
    /** Inter, bundled (lib/interFont.ts). The system fonts after it draw until it loads, and any character it lacks. */
    body: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, "SF Mono", Menlo, monospace',
    /** Tags in dense rows, counters and badges only. Never a sentence. */
    tiny: 11,
    /** Help, details under a title, section labels, tags. */
    small: 13,
    /** Body text, field labels, small buttons. */
    body14: 14,
    /**
     * Inputs, buttons, and the name of a thing: row titles, setting names,
     * pane titles. 16 px minimum on inputs, or iOS zooms the page when one
     * is focused.
     */
    input: 16,
    /** Sheet, dialog and card titles. */
    heading: 18,
    title: 20,
    /** A page's own name: Home, Join, Admin. */
    display: 24,
  },
  weight: { regular: 400, strong: 600, bold: 700 },
  leading: { tight: 1.2, body: 1.4 },
  /** The letter spacing of a capitals section label. */
  caps: "0.04em",
  /** Icons drawn by components/Icon.tsx, inside a 44 px target. */
  icon: { sm: 16, md: 20, lg: 24 },
  shadow: {
    /** The connection dot's dark rim. */
    rim: "0 0 0 2px rgba(0, 0, 0, 0.35)",
    /** Notices floating over the map. */
    float: "0 4px 16px rgba(0, 0, 0, 0.4)",
    /** Panes on the map: the token action bar, the label, pin and light panes, the door card. */
    pane: "0 8px 24px rgba(0, 0, 0, 0.45)",
    /** Sheets rising from the bottom. */
    sheet: "0 -8px 32px rgba(0, 0, 0, 0.45)",
    /** Dialogs, the handout and the X-card. */
    dialog: "0 16px 48px rgba(0, 0, 0, 0.5)",
  },
  /**
   * Stacking over the map, lowest first. Dialogs open with showModal and
   * sit in the browser's top layer, so they need none. Stacking inside one
   * component (1 or 2) and the table display's own order stay local.
   */
  z: {
    /** The tracker's round header while it sticks (docs/design-v1-combat-flow.md 3.1): above a row being dragged (2), so a row dragged upward passes under it. */
    stickyHeader: 3,
    pane: 5,
    sheet: 10,
    options: 14,
    bars: 15,
    /** The token action bar on a screen too short to dock it (docs/design-v1-bar-dock.md 1.4): over the toolbar and the options it covers, under the notices. */
    barOverlay: 16,
    /** A map pane's bottom sheet on a screen too short for it under the top bars (features/builder/labelEdit.ts panePlacement): over the bars, so its header and Close show, and under the notices, so a toast still shows over it. */
    paneOverBars: 17,
    notices: 20,
    /**
     * An open popover or menu and the element that holds it (docs/design-v1-tool-options.md 7.6): over
     * notices and toasts, under the fight's alerts opened over the screen, a player's roll card and dialogs.
     */
    popover: 21,
    /** The top bar while it holds the fight's alerts opened over the screen: over the notices, which would hide the alerts' buttons. */
    alertsOverlay: 22,
    overBars: 25,
  },
  /** Minimum touch target, per Apple's and Google's guidance. */
  touch: 44,
  layout: {
    /** From this width up, panels dock beside the map instead of opening as sheets (design section 14.4). */
    wideMinWidth: 900,
    /**
     * Below this width, but wide, the top bar holds the turn chip and End
     * Turn beside the room name, so the player's chip shrinks to its color
     * dot and the room name keeps its room.
     */
    chipNameMinWidth: 1100,
    sidePanelWidth: 360,
    landscapeSheetWidth: 340,
    /**
     * The Room page's top bar and bottom toolbar, each before the safe area
     * insets. The canvas runs under both, so anything placed over the map
     * (sheets, banners, the token action bar) keeps clear of them by these.
     */
    topBar: 52,
    toolbar: 60,
    /** Dialog widths on a computer. A phone shows a dialog full screen or as a bottom sheet. */
    dialog: { sm: 440, md: 560, lg: 720 },
    /**
     * The shared popover base (components/Popover.tsx, docs/design-v1-tool-options.md 7.1 and 7.2): its
     * gap from its anchor, its margin inside its bound, and the size of a tile in a menu of tiles.
     */
    popover: { gap: 6, margin: 8, tile: 60 },
    /**
     * A tool's options in one row (docs/design-v1-tool-options.md 4.2, 6 and 8): the stacked row's height (44 px
     * controls, 4 px padding above and below and a 1 px top edge), the line's gap above the row, the least width of a
     * flexible field and of flexible text, a color chip's disk, and the most a creature's name takes in a control
     * before it ends in an ellipsis, about ten characters (docs/design-v1-area-from-character.md 3.2).
     */
    options: { row: 53, lineGap: 6, field: 96, text: 48, disk: 24, name: 68 },
  },
  /**
   * The notch, the rounded corners and the home bar. index.html sets
   * viewport-fit=cover, so the map runs under them and the UI keeps clear.
   */
  safe: {
    top: "env(safe-area-inset-top, 0px)",
    right: "env(safe-area-inset-right, 0px)",
    bottom: "env(safe-area-inset-bottom, 0px)",
    left: "env(safe-area-inset-left, 0px)",
    /**
     * The right safe area as the map's own chrome sees it (the top bar, the
     * toolbar, the tool's options and the alerts column): the inset where
     * the map reaches the right edge, and none beside the side panel, which
     * holds it (docs/design-v1-layout-hierarchy.md 4.3). Room sets the
     * property on the map's area.
     */
    mapRight: "var(--rvtt-map-safe-right, env(safe-area-inset-right, 0px))",
  },
} as const;

/**
 * Colors offered to a new player: distinct on a dark map and from the
 * disposition rings. The first is the DM's when a room is made
 * (server/auth/http.ts DM_COLOR), the crest yellow. The crest orange stays
 * on offer, last, for whoever picks it and for members who already have it.
 */
export const MEMBER_COLORS = [
  "#f7df00",
  "#30a46c",
  "#3e8ef7",
  "#8e4ec6",
  "#e93d82",
  "#12a594",
  "#ad7f58",
  "#e5e5e5",
  "#ff6b4a",
  "#f38400",
] as const;

/**
 * The member colors' names, for swatch labels everywhere (draw, pins,
 * areas, icon disks, members). A screen reader says "Green", not a hex code.
 */
export const MEMBER_COLOR_NAMES: Record<(typeof MEMBER_COLORS)[number], string> = {
  "#f7df00": "Yellow",
  "#30a46c": "Green",
  "#3e8ef7": "Blue",
  "#8e4ec6": "Purple",
  "#e93d82": "Pink",
  "#12a594": "Teal",
  "#ad7f58": "Brown",
  "#e5e5e5": "White",
  "#ff6b4a": "Coral",
  "#f38400": "Orange",
};
