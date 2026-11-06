/**
 * Design tokens. Components style themselves inline from these (the house
 * convention), and globals.css carries only what an inline style cannot.
 *
 * Dark by default, because the app is mostly a map on a phone at a dim table,
 * with the crest's yellow as the accent. The crest's orange stays in the
 * logo only: the yellow was chosen for the interface (2026-10-14).
 *
 * Each device may pick a light theme instead (This device, Theme, kept by
 * lib/scheme.ts), so the colors that differ live in two palettes below. The
 * board keeps the dark look in both (docs/design/design-v1-light-theme.md
 * 6.4), and what draws on a canvas reads `boardTheme`, never `theme.color`.
 */

/** The two looks a device can show. */
export type Scheme = "dark" | "light";
export const SCHEMES: readonly Scheme[] = ["dark", "light"];

/**
 * The colors that differ by scheme. Each key missing from one palette fails
 * typecheck. The light values hold the same contrasts as the dark ones on
 * their own grounds (docs/design/design-v1-light-theme.md 6.1).
 */
export type Palette = {
  bg: string;
  surface: string;
  surfaceRaised: string;
  /** Card and section separators. Decoration only: it identifies no control. */
  border: string;
  /**
   * The outline that identifies a control with no text of its own: a text,
   * number or select field, a Switch's off track. At least 3:1 against
   * bg, surface and a raised surface, as WCAG 1.4.11 asks (dark: 3.9, 3.6
   * and 3.1).
   */
  controlBorder: string;
  text: string;
  textMuted: string;
  /**
   * The label of a control that cannot act yet. Dim, but still legible:
   * 3.4:1 on a raised surface. A disabled control never fades by opacity,
   * which turned a member's accent into a muddy copy of itself.
   */
  textDisabled: string;
  /**
   * Highlights: the creature whose turn it is (its ring, its row, its
   * name), whispers and similar marks. Never a member's color, so it never
   * follows one into a clash. In dark a pale cream rather than a second
   * yellow, so it reads apart from the crest yellow and every member color
   * beside it, and still bright enough to stand out on a dark or a brown
   * map. In light an amber that reads as text. A fill under ink takes
   * `highlightFill`, which stays cream in both.
   */
  accentSoft: string;
  /** Behind the turn in progress: the tracker's active row, and the strip on a player's own turn. */
  turnTint: string;
  /** Outlines, stripes and fills. Never text, which takes `dangerText`. */
  danger: string;
  /**
   * The text of a destructive button (components/Button.tsx) and any red
   * words. `danger` reads at only about 3.6:1 on a dark raised surface,
   * short of the 4.5:1 that 16 px text needs, so words take this red.
   */
  dangerText: string;
  /** Behind an armed destructive button. */
  dangerTint: string;
  /** The fill of a danger notice, such as "You are offline". */
  dangerFill: string;
  success: string;
  warning: string;
  /** The fill of a warning notice, such as "Reconnecting...". */
  warningFill: string;
  ally: string;
  neutral: string;
  hostile: string;
  /** Bars floating over the map, translucent so the map stays in view. */
  overlay: string;
  /** Behind every dialog. */
  scrim: string;
  /**
   * The 1 px ring every mark in a member's raw color wears (a member's dot,
   * a swatch), so a white or yellow dot still shows its edge on a light
   * page. Dark keeps the card separator it had.
   */
  markRing: string;
};

export const PALETTES: Readonly<Record<Scheme, Readonly<Palette>>> = {
  dark: {
    bg: "#16161a",
    surface: "#1f1f25",
    surfaceRaised: "#2a2a32",
    border: "#3a3a44",
    controlBorder: "#76747f",
    text: "#f1efe9",
    textMuted: "#a7a5ad",
    textDisabled: "#7c7a84",
    accentSoft: "#ffe8a3",
    turnTint: "rgba(247, 223, 0, 0.08)",
    danger: "#e5484d",
    dangerText: "#f87171",
    dangerTint: "rgba(229, 72, 77, 0.12)",
    dangerFill: "#3b1214",
    success: "#30a46c",
    warning: "#f5a524",
    warningFill: "#3a2a07",
    ally: "#3e8ef7",
    neutral: "#c9c9c9",
    hostile: "#e5484d",
    overlay: "rgba(22, 22, 26, 0.88)",
    scrim: "rgba(0, 0, 0, 0.6)",
    markRing: "#3a3a44",
  },
  light: {
    bg: "#f3f1ec",
    surface: "#fcfbf8",
    surfaceRaised: "#e9e7e1",
    border: "#d3d0c8",
    controlBorder: "#7a7781",
    text: "#1b1a1f",
    textMuted: "#55535c",
    textDisabled: "#7b7882",
    accentSoft: "#8a4f00",
    turnTint: "rgba(247, 223, 0, 0.2)",
    danger: "#d1343a",
    dangerText: "#b4232a",
    dangerTint: "rgba(209, 52, 58, 0.1)",
    dangerFill: "#fbe4e3",
    success: "#157246",
    warning: "#945400",
    warningFill: "#fbecd2",
    ally: "#1d61c0",
    neutral: "#6d6c73",
    hostile: "#c8333a",
    overlay: "rgba(252, 251, 248, 0.92)",
    scrim: "rgba(20, 18, 24, 0.45)",
    markRing: "#7a7781",
  },
};

/** The shadows that differ by scheme: the same shapes, a warm black and lighter on a light page. */
export type Shadows = {
  /** Notices floating over the map. */
  float: string;
  /** Panes on the map: the token action bar, the label, pin and light panes, the door card. */
  pane: string;
  /** Sheets rising from the bottom. */
  sheet: string;
  /** Dialogs, the handout and the X-card. */
  dialog: string;
  /** A page a swipe back slides off the one under it, its soft edge on the left (lib/backSwipe.ts). */
  slide: string;
};

export const SHADOWS: Readonly<Record<Scheme, Readonly<Shadows>>> = {
  dark: {
    float: "0 4px 16px rgba(0, 0, 0, 0.4)",
    pane: "0 8px 24px rgba(0, 0, 0, 0.45)",
    sheet: "0 -8px 32px rgba(0, 0, 0, 0.45)",
    dialog: "0 16px 48px rgba(0, 0, 0, 0.5)",
    slide: "-8px 0 24px rgba(0, 0, 0, 0.45)",
  },
  light: {
    float: "0 4px 16px rgba(30, 24, 16, 0.16)",
    pane: "0 8px 24px rgba(30, 24, 16, 0.18)",
    sheet: "0 -8px 32px rgba(30, 24, 16, 0.16)",
    dialog: "0 16px 48px rgba(30, 24, 16, 0.24)",
    slide: "-8px 0 24px rgba(30, 24, 16, 0.16)",
  },
};

/** Colors that look the same in either scheme. */
const FIXED = {
  /** Dark text on a light fill that is not the accent: the cream "viewing as" notice, the turn notice. */
  ink: "#1a1206",
  /**
   * The crest yellow, fixed: the accent's default, and the yellow of
   * marks that mean something whoever looks, such as the ruler's Dash band.
   */
  crest: "#f7df00",
  /**
   * The cream band under ink: the highlight notice and the turn strip's
   * fills (15.3:1 with ink). It was `accentSoft`'s job in dark, where the two
   * are one color, and stays cream on a light page, where `accentSoft` is
   * an amber for text.
   */
  highlightFill: "#ffe8a3",
  /** Fog of war. Players see it fully opaque, the DM at half opacity. */
  fog: "#0d0d12",
  /** Outline behind text drawn on the map, so it reads on any art. */
  textHalo: "#000000",
  /** Behind a picker that must keep the map in view, such as the stamp sheet. */
  scrimLight: "rgba(0, 0, 0, 0.2)",
  /** Pure black: the table display, the blackout and the player preview's frame. */
  stage: "#000000",
  /** Marks on a colored fill: token initials, effect badges, the QR code's light squares. */
  white: "#ffffff",
} as const;

/** The CSS custom property that carries a palette color in the DOM, such as `--rvtt-surface-raised`. */
export function colorVar(key: keyof Palette): string {
  return `--rvtt-${kebab(key)}`;
}

/** The CSS custom property that carries a shadow in the DOM, such as `--rvtt-shadow-pane`. */
export function shadowVar(key: keyof Shadows): string {
  return `--rvtt-shadow-${kebab(key)}`;
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * A scheme's custom properties: every palette color and shadow, for the
 * page's root (lib/scheme.ts) or a subtree that keeps one look.
 */
export function paletteVars(scheme: Scheme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of Object.keys(PALETTES[scheme]) as (keyof Palette)[]) vars[colorVar(key)] = PALETTES[scheme][key];
  for (const key of Object.keys(SHADOWS[scheme]) as (keyof Shadows)[]) vars[shadowVar(key)] = SHADOWS[scheme][key];
  return vars;
}

/**
 * What a canvas draws with: the dark palette and the fixed colors as plain
 * hex. A canvas cannot read a CSS variable, and the board keeps its dark
 * look in both schemes. client/canvas/boardColors.test.ts holds every file
 * that draws on Konva to it. The accent comes from `useAccent()`
 * (state/accent.ts), resolved for dark.
 */
export const boardTheme = { color: { ...PALETTES.dark, ...FIXED } } as const;

/**
 * The accent resolved for dark, as a room sets it (lib/accent.ts
 * `boardAccentVars`), with the crest's own as the fallback outside a room.
 */
const BOARD_ACCENT = "var(--rvtt-board-accent, #f7df00)";

/**
 * Spread on a DOM element's style, it makes the element and everything
 * under it read the dark palette and the dark accent, whatever the device's
 * scheme: what lies on the board's own ground (the height pill, the dice
 * tray) and the screens on the black `stage` (the pause screen and its
 * X-card, the scene gate, the preview's waiting and error screens). The
 * accent family and the focus ring take the member's accent resolved for
 * dark, since the light one reads 2.1:1 on a dark raised surface. Native
 * controls and scrollbars inside draw dark too. A Notice inside still sets
 * its own `--rvtt-focus` on itself.
 */
export const BOARD_SCOPE: Readonly<Record<string, string>> = {
  ...paletteVars("dark"),
  "--rvtt-accent": BOARD_ACCENT,
  "--rvtt-on-accent": "var(--rvtt-board-on-accent, #1a1206)",
  "--rvtt-accent-tint": "var(--rvtt-board-accent-tint, rgba(247, 223, 0, 0.14))",
  "--rvtt-selection": "var(--rvtt-board-selection, rgba(247, 223, 0, 0.4))",
  "--rvtt-focus": BOARD_ACCENT,
  colorScheme: "dark",
};

/**
 * Chrome that floats on the board, where a zoomed or panned map can put any
 * art under its focus ring: the map's focus target and the toolbar's tool
 * buttons on a computer. The attribute takes globals.css's two-tone ring, a
 * dark halo (`theme.ringHalo`) under the accent outline, and the style
 * gives that outline the member's accent resolved for dark, which reads on
 * the halo in either scheme. Spread `ON_BOARD` on the element and
 * `ON_BOARD_STYLE` in its style.
 */
export const ON_BOARD = { "data-rvtt-on-board": "" } as const;
export const ON_BOARD_STYLE: Readonly<Record<string, string>> = { "--rvtt-focus": BOARD_ACCENT };

/**
 * The iPhone home-screen app's black strip under its white status bar text
 * on a light page, drawn inside a top-layer surface whose ground reaches
 * the screen's top (every dialog backdrop, the full-screen phone card). An
 * inset shadow, so it takes no room and never needs the element's padding.
 * `scale` is the element's own zoom (the interface size where it zooms, 1
 * where it does not), so the strip is the status bar's height in its px.
 * lib/scheme.ts sets `--rvtt-status-band` to black only where it shows.
 */
export function statusBand(scale: number): string {
  return `inset 0 calc(${theme.safe.top} / ${scale}) 0 0 var(--rvtt-status-band, transparent)`;
}

/**
 * Each palette color as the DOM reads it: its custom property, with the
 * dark value as the fallback, so a unit test's render, the boot page and
 * any page before lib/scheme.ts runs still draw dark.
 */
function paletteRefs(): { [K in keyof Palette]: string } {
  const refs = {} as { [K in keyof Palette]: string };
  for (const key of Object.keys(PALETTES.dark) as (keyof Palette)[]) refs[key] = `var(${colorVar(key)}, ${PALETTES.dark[key]})`;
  return refs;
}

function shadowRef(key: keyof Shadows): string {
  return `var(${shadowVar(key)}, ${SHADOWS.dark[key]})`;
}

export const theme = {
  /**
   * DOM styles only. The colors that differ by scheme are CSS variables
   * (`paletteVars`), so a switch restyles the page with no re-render. What
   * draws on a canvas reads `boardTheme.color`, which a test holds every
   * Konva file to (client/canvas/boardColors.test.ts).
   */
  color: {
    ...paletteRefs(),
    ...FIXED,
    /**
     * Filled buttons, the chosen option, the focus ring and the selected
     * tool: the viewing member's own color in a room, the scheme's crest
     * accent elsewhere (lib/accent.ts gives the values, pages/RoomChrome.tsx
     * and lib/scheme.ts set them). These are CSS variables, so they work in
     * DOM styles only. What draws on the board takes the resolved colors
     * from `useAccent()` (state/accent.ts).
     */
    accent: "var(--rvtt-accent, var(--rvtt-base-accent, #f7df00))",
    /** Text and icons on an accent fill, dark or light by the accent. */
    onAccent: "var(--rvtt-on-accent, var(--rvtt-base-on-accent, #1a1206))",
    /** The faint fill behind a pressed or chosen control that wears the accent border. */
    accentTint: "var(--rvtt-accent-tint, var(--rvtt-base-accent-tint, rgba(247, 223, 0, 0.14)))",
  },
  /**
   * The dark halo of a focus ring that falls on the board (`ON_BOARD`):
   * 6 px out under the 2 px accent outline, at least 13:1 on white art.
   * Fixed, since the accent on it is always the one resolved for dark.
   */
  ringHalo: "rgba(13, 13, 18, 0.9)",
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
    float: shadowRef("float"),
    /** Panes on the map: the token action bar, the label, pin and light panes, the door card. */
    pane: shadowRef("pane"),
    /** Sheets rising from the bottom. */
    sheet: shadowRef("sheet"),
    /** Dialogs, the handout and the X-card. */
    dialog: shadowRef("dialog"),
    /** A proficiency mark's 1 px line in its words' own color, just outside a roll in text (components/ProficiencyMark.tsx). */
    mark: "0 0 0 1px currentColor",
    /** The same line inside a box: a proficient roll button's second line, the frame of a label that cuts its words, or the outline of an ability box whose save is proficient. */
    markInside: "inset 0 0 0 1px currentColor",
    /** Expertise on a roll button: a 2 px band of the button's own `fill` inside its border, then a second line. */
    markDouble: (fill: string) => `inset 0 0 0 2px ${fill}, inset 0 0 0 3px currentColor`,
    /** A sticky foot's `fill` carried over the pane's side padding beside it (components/Sheet.tsx `--pane-pad-x`), taking no room. */
    paneSides: (fill: string) => `calc(-1 * var(--pane-pad-x, 0px)) 0 0 ${fill}, var(--pane-pad-x, 0px) 0 0 ${fill}`,
    /** A page a swipe back slides off the one under it, its soft edge on the left (lib/backSwipe.ts). */
    slide: shadowRef("slide"),
  },
  /**
   * Stacking over the map, lowest first. Dialogs open with showModal and
   * sit in the browser's top layer, so they need none. Stacking inside one
   * component (1 or 2) and the table display's own order stay local.
   */
  z: {
    /**
     * The side panel's edge (pages/PanelEdge.tsx): over the map's canvas and
     * under every map layer with a z, so where the top bar, the toolbar or a
     * docked token window meets the map's right edge, that control wins the
     * press and only the edge's part inside the panel takes it.
     */
    panelEdge: 1,
    /** The tracker's round header while it sticks (docs/design/design-v1-combat-flow.md 3.1): above a row being dragged (2), so a row dragged upward passes under it. */
    stickyHeader: 3,
    pane: 5,
    sheet: 10,
    options: 14,
    bars: 15,
    /** The token action bar on a screen too short to dock it (docs/design/design-v1-bar-dock.md 1.4): over the toolbar and the options it covers, under the notices. */
    barOverlay: 16,
    /** A map pane's bottom sheet on a screen too short for it under the top bars (features/builder/labelEdit.ts panePlacement): over the bars, so its header and Close show, and under the notices, so a toast still shows over it. */
    paneOverBars: 17,
    notices: 20,
    /**
     * An open popover or menu and the element that holds it, in a browser with no popovers
     * (docs/design/design-v1-tool-options.md 7.6): over notices and toasts, under the fight's alerts opened
     * over the screen, a player's roll card and dialogs. With popovers its box stands in the top layer
     * over all of these, and only a modal dialog opened after it stands above it (FL-17).
     */
    popover: 21,
    /** The top bar while it holds the fight's alerts opened over the screen: over the notices, which would hide the alerts' buttons. */
    alertsOverlay: 22,
    overBars: 25,
    /**
     * The iPhone home-screen app's black strip under the status bar on a
     * light page (App.tsx, `statusBand`): over everything outside the top
     * layer, so no bar, sheet or popover fallback covers it.
     */
    statusBand: 30,
  },
  /** Minimum touch target, per Apple's and Google's guidance. */
  touch: 44,
  layout: {
    /** From this width up, panels dock beside the map instead of opening as sheets (design section 14.4). */
    wideMinWidth: 900,
    /**
     * From this width up, a stacked toolbar's buttons stop growing at
     * SHARED_MAX (pages/Room.tsx) rather than filling their section, so a
     * tablet's bar stays as it was. Under it, on a phone, they fill it.
     */
    tabletMinWidth: 600,
    /**
     * Below this width, but wide, the top bar holds the turn chip and End
     * Turn beside the room name, so the player's chip shrinks to its color
     * dot and the room name keeps its room.
     */
    chipNameMinWidth: 1100,
    /** The side panel's default width, the one every panel is designed at. A drag widens it (pages/panelWidth.ts). */
    sidePanelWidth: 360,
    /** The most a list in a popover takes, a side panel's default width, so it never follows a drag of the side panel's edge. */
    listCap: 360,
    landscapeSheetWidth: 340,
    /**
     * The Room page's top bar and bottom toolbar, each before the safe area
     * insets. The canvas runs under both, so anything placed over the map
     * (sheets, banners, the token action bar) keeps clear of them by these.
     */
    topBar: 52,
    toolbar: 60,
    /**
     * Dialog widths on a computer. A phone shows a dialog full screen or as
     * a bottom sheet. `xl` is the playlist maker's, its two columns side by side
     * (docs/design/design-v1-sound-layout.md 4.5).
     */
    dialog: { sm: 440, md: 560, lg: 720, xl: 1040 },
    /**
     * The widest a floating notice stands over the map: the connection
     * banner, the quiet load, the starting view's bar, a toast and the
     * preview's banner, so the map either side still takes a tap
     * (docs/design/design-v1-design-pass.md 4.4).
     */
    notice: 520,
    /**
     * The shared popover base (components/Popover.tsx, docs/design/design-v1-tool-options.md 7.1 and 7.2): its
     * gap from its anchor, its margin inside its bound, and the size of a tile in a menu of tiles.
     */
    popover: { gap: 6, margin: 8, tile: 60 },
    /**
     * A tool's options in one row (docs/design/design-v1-tool-options.md 4.2, 6 and 8): the stacked row's height (44 px
     * controls, 4 px padding above and below and a 1 px top edge), the line's gap above the row, the least width of a
     * flexible field and of flexible text, a color chip's disk, and the most a creature's name takes in a control
     * before it ends in an ellipsis, about ten characters (docs/design/design-v1-area-from-character.md 3.2).
     */
    options: { row: 53, lineGap: 6, field: 96, text: 48, disk: 24, name: 68 },
  },
  /**
   * The notch, the rounded corners and the home bar. index.html sets
   * viewport-fit=cover, so the map runs under them and the UI keeps clear.
   */
  safe: {
    /**
     * Nothing in the app sets `--rvtt-safe-top`. It lets an e2e test stand
     * in a notch, which Chromium cannot emulate, to check the iPhone
     * home-screen app's status strip (`statusBand`).
     */
    top: "var(--rvtt-safe-top, env(safe-area-inset-top, 0px))",
    right: "env(safe-area-inset-right, 0px)",
    bottom: "env(safe-area-inset-bottom, 0px)",
    left: "env(safe-area-inset-left, 0px)",
    /**
     * The right safe area as the map's own chrome sees it (the top bar, the
     * toolbar, the tool's options and the alerts column): the inset where
     * the map reaches the right edge, and none beside the side panel, which
     * holds it (docs/design/design-v1-layout-hierarchy.md 4.3). Room sets the
     * property on the map's area.
     */
    mapRight: "var(--rvtt-map-safe-right, env(safe-area-inset-right, 0px))",
  },
  /** The isometric view's raised ground, walls and standees (docs/design/design-v1-isometric-view.md 5.4 and 5.5). */
  relief: {
    /** A standee's ring on the ground, under its disposition's outline. */
    ring: "rgba(0, 0, 0, 0.25)",
    /** A side with nothing else to wear: a map image's cell not wholly revealed, or a texture not yet loaded. */
    side: "#5c5852",
    /** The light from the left on a side facing left, and the shade on one facing right. */
    lit: "rgba(255, 255, 255, 0.12)",
    shaded: "rgba(0, 0, 0, 0.3)",
    /** The thin line around every side and wall, so a height reads on flat art. */
    edge: "rgba(0, 0, 0, 0.45)",
    /** A wall's stone, pulled toward the builder's wall color, and a pillar's toward its swatch. */
    wallTint: "rgba(21, 18, 15, 0.35)",
    pillarTint: "rgba(143, 137, 126, 0.3)",
    /** A window's pane, half opaque. */
    pane: "rgba(160, 210, 245, 0.5)",
    /** A door leaf's stain over its wood, so a door reads against a wood floor. */
    doorStain: "rgba(52, 28, 12, 0.45)",
    /** The faint line round each square inside a raised top, so squares stay countable with the grid off. */
    squareLine: "rgba(0, 0, 0, 0.16)",
    /** A pit's floor, darkened by its depth. */
    pitShade: "rgba(0, 0, 0, 0.4)",
    /** A standee's stem and shadow. */
    stem: "rgba(0, 0, 0, 0.6)",
    shadow: "rgba(0, 0, 0, 0.35)",
    /** A covered standee's outline (5.6), a ghost's and a drag's standee, and one the players cannot see on the DM's device. */
    silhouetteOpacity: 0.35,
    ghostOpacity: 0.6,
    hiddenOpacity: 0.5,
  },
  /**
   * An area standing as its real shape in Isometric
   * (docs/design/design-v1-iso-area-shapes.md 5): the area's own color at these
   * strengths, each fill once on its far faces and once on its near ones,
   * so what lies behind it takes about twice the tint of what lies inside.
   * Widths and dashes are screen pixels.
   */
  area: {
    volumeFill: 0.16,
    volumeLine: 0.95,
    volumeHidden: 0.55,
    volumeGuide: 0.8,
    /** Another member's preview, fainter, as Top-down draws it. */
    previewFill: 0.1,
    /** A DM-only area on the DM's device, as Top-down dims it. */
    dmOpacity: 0.6,
    lineWidthPx: 2,
    selectedWidthPx: 2.5,
    thinWidthPx: 1,
    hiddenDash: [4, 4],
    dmDash: [6, 4],
    previewDash: [8, 5],
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
