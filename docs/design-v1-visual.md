# raccoon-vtt v1 visual design pass

Status: built. Draft 6, after design review round 5, is what the build followed: parts 1 to 9 merged at `oolrvnxv` (923bdddc), part 10's sweep on top of it from `mlwntwxq` to `ouvyspxz` (a6e564fa), then the build review's round 1 fixes after that. Where the build changed a rule, this document says so in place.

The project owner asked for it on 2026-10-14: "in general we should also do a design review pass of the entire app once done with all waves and try to make the app look consistent and unified/sleek while not sacrificing functionality". The app grew wave by wave and its screens drifted apart. This pass makes it one product.

## Scope

- In: how every screen looks. Tokens in `client/lib/theme.ts`, shared components in `client/components/`, per-screen changes, a member color picker, and the height pills' text size.
- Out: new features, rules, ops and stored data. No protocol, schema or migration changes. The one server change adds the DMs' current colors to the join step's answer (section 4.4). A light theme stays a Later item (`docs/features.md:606`).
- Fixed by the project owner: the interface accent is the crest yellow `#f7df00`, and in a room it is the viewer's own member color, kept readable by `lib/accent.ts`. The crest orange stays in the logo and never returns as an interface color. Nothing may cost a function, a shortcut, a touch target or an accessibility property.

The screenshots named below were taken on the integration commit after the wave 5 live play fixes. They are not in the repository. A name starting `d-` is a DM at 1280 x 800, `p-` a 390 x 844 touch phone (DM or player as the name says), and `l-` a phone in landscape.

The numbers come from a scan of the 447 client source files (`client/**/*.ts(x)` minus tests, `client/dev` and `theme.ts`), with comments stripped. Part 1 of the build adds `scripts/style-drift.ts`, which reproduces them.

### Principles

1. One meaning per look. The accent means "act here" or "this one is chosen". Fixed colors mean a status. Nothing else wears the accent.
2. One component per pattern. A pattern used in two places is a shared component styled from `theme.ts`.
3. Nothing is lost. Every control keeps its function, 44 px target and keyboard path. Section 5.4 lists every role and accessible name that changes, and why.
4. Disabled looks unavailable, not faded.

## 1. Audit

Severity: **High** misleads or hides a state. **Medium** is a visible inconsistency on a main screen. **Low** is polish or upkeep.

| # | Area | Finding | Screenshots | Files | Severity |
|---|---|---|---|---|---|
| F1 | Disabled controls | Disabled is `opacity: 0.5` on the fill, so a disabled primary turns olive for a yellow member and murky green for a green one. It reads as a broken color, not as "not yet". Four opacities are in use (0.45, 0.5, 0.55, 0.6) in 22 places. | d-home, p-join-password, d-dm-link-save, d-tab-log, p-player-token-bar, d-tool-grid, d-admin-login, d-dlg-image-picker | components/Button.tsx:66, dm/controls.tsx:47, measure/controls.tsx:84, scenes/controls.tsx:62, tokens/ui.tsx:246,343, MenuPanel.tsx:168 and 15 more | High |
| F2 | On and off settings | Five idioms for a setting that is on or off: the Switch, the SwitchRow, a pressed button named by its state ("Fog is off", "Shown", "Players see everything you reveal", "Walls and ledges block players' moves", "Sound on"), a checkbox row, and bare checkboxes at 20, 22 and 24 px. A button named by its state reads as an action. | d-dm-scenes-panel-full, d-menu-settings, d-tool-ping, d-tab-log | dm/controls.tsx:24,63, encounter/parts.tsx:230, scenes/SceneSettings.tsx, vision/VisionSettings.tsx, movement/SceneSetting.tsx, pings/PingTool.tsx, tokens/ui.tsx:235 | High |
| F3 | Actions dressed as choices | "Upload and create" and the grid's "Apply" wear the accent outline and tint, the look of a chosen option, so the main action looks already done. | d-dm-new-scene-map-chosen, d-tool-grid | scenes/NewScene.tsx, grid/Options.tsx | High |
| F4 | Accent on headings | Stat block and journal headings and the monster editor's group titles take the accent, so they change color with each member (pink headings for a pink player) and look tappable. | d-dm-statblock-full, d-dlg-new-monster | components/Markdown.tsx:38,48, monsters/MonsterEditor.tsx:236 | Medium |
| F5 | Too many primaries | The DM tab has four filled buttons, the DM link page three, the DM's Members page two. A panel's "New ..." button is full width in Characters and Encounters and small in Journal. | d-tab-dm, d-dm-link-save, d-menu-members, d-tab-characters, d-tab-journal | dm/*, dm/Access.tsx:137,389, pages/Home.tsx, journal/JournalPanel.tsx | Medium |
| F6 | Type sizes | 111 raw font sizes (23%) in 16 distinct values. Panel buttons are 14 px from two `SmallButton` copies with different radii, page buttons 16 px. Headings come in 9 sizes from 13 to 28. Weights 500 and 800 are strays. | d-tab-token, d-tab-dm, d-menu-about | encounter/parts.tsx:288, tokens/ui.tsx:306, OutlinerPanel.tsx:165,227, RoomChrome.tsx:337 | Medium |
| F7 | Section headings | Seven heading styles: capitals at 11, 13 or 14 px with tracking 0.3, 0.4 or 0.04em, sentence case at 15 px in the DM tab and Room settings (the same size as the setting names under them), and the accent headings of F4. | d-tab-token, d-tab-dm, d-menu-settings, d-dm-scenes-panel | TrackerPanel.tsx:99, tokens/ui.tsx:31, scenes/controls (heading), LibraryPanel.tsx:43, MonsterList.tsx:23, RequestSheet.tsx:275, dm/controls.tsx:13 | Medium |
| F8 | Dialog and sheet shells | Nine hand-built `<dialog>` shells plus the Sheet and four pane frames. Titles are 15, 17, 18 or 28 px. Backdrops are 0.2, 0.45, 0.5, 0.6 or 0.85 black. Widths are 480 to 600. The close glyph is 20, 22 or 24 px, and the handout uses a text "Close" button. | d-dlg-ask-party, d-dlg-image-picker, d-dlg-journal-editor, d-dlg-shortcuts, p-dm-dlg-new-page | images/Modal.tsx, tokens/SheetDialog.tsx, scenes/SceneSheet.tsx, tokens/MonsterFilters.tsx, builder/stamps/StampPicker.tsx, StampSheet.tsx, handouts/HandoutPopup.tsx, xcard/XCardHost.tsx, components/Sheet.tsx | Medium |
| F9 | Phone token bar | On a phone the token action bar stays open behind every sheet, so two cards stack, each with its own close button. Alone it is a 300 px card that leaves a gap at the right. | p-player-sheet-initiative, p-player-sheet-log, p-player-sheet-journal, p-dm-token-bar | canvas/TokenActionBar.tsx, pages/Room.tsx | Medium |
| F10 | Subpages | On a phone, Members and the other Menu pages show a second "‹ Menu" back link under the sheet's own back button, and the sheet title stays "Menu". Journal pages, area damage, the encounter editor and the monster stat block have the same in-body back link. | p-player-members, d-menu-members, d-dm-statblock | panels/MenuPanel.tsx:45-61, journal/JournalPanel.tsx:215-231, areas/AreaDamage.tsx:90-92, encounters/EncountersPanel.tsx:214-227, tokens/MonstersPanel.tsx:173 | Medium |
| F11 | Height pills | Height mode pills keep a fixed 13 px while the board text beside them follows the map (11 to 16 px). They also draw over token labels, which do not make way for them. | d-builder-height-pills-fitted (the Goblin Boss label is cut), d-builder-height-pills-zoomed | builder/heights/boardText.ts:12-15, heights/HeightLayer.tsx:63,70-73 | Medium |
| F12 | Token initials | The board and the tracker show "AR" and "GW". The Characters and Monsters panels show "Ad" and "Go" for the same tokens. | d-dm-tokens-placed, d-dm-statblock | tokens/CharactersPanel.tsx:132,139, tokens/CharacterCard.tsx:67, monsters/MonsterEditor.tsx:166, monsters/MonsterImage.tsx:123 | Medium |
| F13 | Join swatches | A color already in use draws at 35% opacity: the yellow turns olive and looks disabled, though it can be picked. Each swatch's label reads its hex code. The legend sits 2 px right of the field labels. | p-join-name | pages/Join.tsx:279-307 | Medium |
| F14 | Native controls and fields | No `color-scheme` is set, so unchecked checkboxes are white squares and select menus and scrollbars draw light on a dark app. An empty field shows its edge only by a `border` outline at 1.5:1 and a fill at 1.1:1 against a surface, under the 3:1 a control's edge needs. | d-dm-link-save, d-dm-new-character, d-tab-log | client/globals.css | Medium |
| F15 | Side panel tabs | The chosen tab is raised grey, while every other chosen option wears the accent. | d-dm-room-empty | pages/Room.tsx:758-783 | Low |
| F16 | Room loading | Opening a room goes from the boot text on the page color to "Opening the room..." on pure black and back to the page color, a visible flash. | p-player-slow-load-500ms, -1500ms, -7000ms | pages/RoomRoute.tsx:105, pages/LiveRoom.tsx:66 | Low |
| F17 | Error pages | "Page not found" and "No such room" have no logo or title, unlike Home and Admin. The display code page's Home button sits outside its card. | d-not-found, d-room-missing, d-display-code | client/App.tsx, pages/RoomRoute.tsx, display/DisplayPages.tsx | Low |
| F18 | Empty states | Eight text styles (13, 14 or inherited size, `p`, `span` or `div`, muted or not). | d-tab-initiative, d-tab-areas, d-tab-journal, d-tab-library, p-player-sheet-areas | 17 direct sites and 3 helpers (scan) | Low |
| F19 | Status tags | "Healthy" is an outlined pill, "Under fog" a grey pill, "This device" accent text, "Online" green text with a dot, "LA 3/3" a filled chip and "Players here" cream text. | d-tab-token, d-tab-outliner, d-menu-members, d-dm-fight-running, d-dm-map-scene | tokens/HpSection.tsx:223, OutlinerPanel.tsx:278, MembersPanel.tsx, encounter/parts.tsx:179,197, scenes/SceneList.tsx | Low |
| F20 | Tool option bars | The hint comes first (ruler, area, draw, ping, pin), last (add, fog, builder) or under the controls (grid). | d-tool-add, d-tool-ruler, d-tool-fog, d-tool-grid | the tools' Options files | Low |
| F21 | Scene rows | The name and detail wrap to four lines beside "Move players" and the menu button. | d-dm-map-scene, p-dm-sheet-scenes | scenes/SceneList.tsx | Low |
| F22 | Landscape turn strip | On a landscape phone the turn strip takes its own row of about 48 px on a 390 px tall screen while the top bar row stands mostly empty. | l-player-landscape-sheet | pages/Room.tsx, encounter/InitiativeStrip.tsx | Low |
| F23 | Colors and errors | 102 hex literals with no token (63 distinct), 82 rgb literals (13 alphas of black), 17 distinct shadows, z-index values from 1 to 30 with no names. Error text uses `danger` in 11 places, which reads 4.2:1 on a surface, below 4.5:1. | d-admin-rooms, p-player-reconnecting | ConnectionStatus.tsx:53, Field.tsx:75, LogPanel.tsx, ImagePicker.tsx:185 and the scan | Low (look), High (upkeep) |
| F24 | Text that acts | "Copy player link" and the DM link page's disclosures are accent text, the look of a link, though they act in place. | d-tab-menu, d-dm-link-save | panels/MenuPanel.tsx, pages/Home.tsx | Low |
| F25 | Doubled titles | The Scenes sheet says "Scenes" in its header and "SCENES" again as its first label. | p-dm-sheet-scenes | scenes/SceneList.tsx:156 | Low |
| F26 | Accent on status | Unread badges are accent filled, so a count looks like an action and changes with the member. | d-dm-room-empty | pages/RoomChrome.tsx:325-340 | Low |
| F27 | Player's roll card over a sheet | On a phone the roll card stays over the bottom half of an open sheet until answered or folded (post-wave-5 review). | post-w5-review/022-fail-player-phone-chips-under-sheet.png | features/rolls/PlayerRolls.tsx:195-215 | Medium |
| F28 | DM's open requests on a phone | Every open request stacks as a folded card with no cap. Six cover most of the map (post-wave-5 review). | post-w5-review/015-dm-phone-room-open-requests.png | features/rolls/DmDesk.tsx:55-80 | Medium |

### Drift in numbers

| Measure | Today |
|---|---|
| Font sizes from tokens | 357 of 487 (73%). 111 raw numbers in 16 values: 11 x16, 18 x13, 15 x12, 17 x11, 20 x11, 24 x11, 12 x8, 16 x7, 13 x6, 22 x4, 10 x3, 28 x3, 19 x2, 36 x2, 21, 9 |
| Radii from tokens | 179 of 228. Raw: "50%" x18, 4 x4, 6 x3, 12 x2, 2, 3, 7, 8 |
| Spacing from tokens | 80% of non-zero padding, margin and gap. Raw `gap: 2` x40 and `gap: 4` x37 lead |
| Shadows | 40 uses, 17 distinct values |
| z-index | 21 uses: 1, 2, 5, 10, 12, 14, 15, 20, 25, 30, none named |
| Raw `<button>` vs `<Button>` | 110 vs 99. 103 of the raw ones carry their own inline style |
| Local copies of one pattern | SmallButton x2, ToolButton x2, Segmented x3, Toggle x2, IconButton x2, Chip x2, Pill x3, Note x5, Help, Hint x2, Muted, Group x5, Section x4 |
| Header close buttons | 12, in 3 glyph sizes and 3 margin schemes, plus 2 text "Close" buttons |

## 2. The visual system

### 2.1 Tokens

The surfaces, text, status and disposition colors keep their values: they read well and every board color was tuned against them. The pass adds names for what is today a literal, a type scale, and named shadows and layers. This is `client/lib/theme.ts` as it lands (existing comments kept, only new ones shown):

```ts
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
    accent: "var(--rvtt-accent, #f7df00)",
    onAccent: "var(--rvtt-on-accent, #1a1206)",
    accentTint: "var(--rvtt-accent-tint, rgba(247, 223, 0, 0.14))",
    crest: "#f7df00",
    accentSoft: "#ffe8a3",
    turnTint: "rgba(247, 223, 0, 0.08)",
    danger: "#e5484d",
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
    fog: "#0d0d12",
    overlay: "rgba(22, 22, 26, 0.88)",
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
    body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, "SF Mono", Menlo, monospace',
    /** Tags in dense rows, counters and badges only. Never a sentence. */
    tiny: 11,
    /** Help, details under a title, section labels, tags. */
    small: 13,
    /** Body text, field labels, small buttons. */
    body14: 14,
    /** Inputs, buttons, and the name of a thing: row titles, setting names, pane titles. */
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
  z: { pane: 5, sheet: 10, options: 14, bars: 15, notices: 20, overBars: 25 },
  touch: 44,
  layout: {
    /* existing entries unchanged */
    /** Dialog widths on a computer. A phone shows a dialog full screen or as a bottom sheet. */
    dialog: { sm: 440, md: 560, lg: 720 },
  },
  safe: { /* unchanged */ },
} as const;

/** MEMBER_COLORS unchanged. Their names, for swatch labels everywhere (draw, pins, areas, icon disks, members). */
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
```

How the raw values map:

- Font sizes: 9 and 10 go to `tiny` (they are chip text). 12 goes to `small`, except pill counters, which go to `tiny`. 15 goes to `input` for the name of a thing and to `body14` for anything else. 17, 18 and 19 go to `heading`. 21 and 22 go to `title`. 24 goes to `display`. A close or back glyph's 20 to 24 px becomes an `Icon` at `icon.md`. The table display keeps its 28 and 36 px as named constants in `features/display/`, since a TV across the room is its own scale. Text drawn on the board keeps its sizes from `lib/boardScale.ts`, outside this scale.
- Weights: 500 becomes 400 or 600 by role, 800 becomes 700.
- The scale has no 15. The names of things (row titles, setting names, pane titles) take 16 px at weight 600, as Room settings' switch rows already do (`features/dm/controls.tsx` Toggle). In the Token panel a 15 px setting name, a 14 px field label and a 16 px input sit together and do not read as three steps. With 15 gone, each size has one job: 13 explains, 14 is body and small controls, 16 names and takes input, 18 and up title.
- Radii: 2, 3 and 4 become `xs` (bars). 7 and 8 become `sm`. 12 becomes `md`. `"50%"` becomes `round`.
- Spacing: `gap: 2` becomes `space(0.5)` and `gap: 4` becomes `space(1)`. Other raw values snap to the 4 px grid, and the close-button nudges (`margin: "-4px -10px -4px 0"` x4) go away with the shared pane header.
- The stripe on a card's left edge is 3 px everywhere (AreasPanel.tsx:73 uses 4).
- Black alphas collapse into `scrim`, `scrimLight`, the shadows and `overlay`. The board's art colors and stored palettes stay literal, by name (section 5.5).

`globals.css` adds three rules, lets a container change the focus ring's color, and keeps the rest:

```css
/* Native checkboxes, radios, selects, date fields and scrollbars draw for
   a dark page. Without it an unchecked box is a white square. */
:root {
  color-scheme: dark;
}

/* Folded parts keep their inline display (grid, flex), which would
   otherwise beat the hidden attribute. The image picker's file input,
   hidden today, stays hidden. */
[hidden] {
  display: none !important;
}

/* The ring is the accent, unless a container on a light fill sets
   --rvtt-focus (the highlight Notice sets it to ink, 15.3:1 on cream,
   where the yellow accent would read 1.1:1). */
:focus-visible {
  outline: 2px solid var(--rvtt-focus, var(--rvtt-accent, #f7df00));
  outline-offset: 2px;
}

/* A choice's native radio lies unseen over its option (components/
   Segmented.tsx, Swatches.tsx), so the ring goes on the option. */
.rvtt-choice:has(> input:focus-visible) {
  outline: 2px solid var(--rvtt-focus, var(--rvtt-accent, #f7df00));
  outline-offset: 2px;
}
```

### 2.2 The member accent, by component

The accent is the viewer's member color as `lib/accent.ts` resolves it, or the crest yellow outside a room. `accentFor` already guarantees 4.5:1 for the accent against every surface and its tint, and for `onAccent` against the accent, for any color a member can pick. Nothing below needs a new contrast rule for the accent.

| Where | Rest | Chosen, on or pressed | Follows the member |
|---|---|---|---|
| Primary button | Accent fill, `onAccent` label | Not applicable | Yes |
| Secondary and quiet buttons | Raised or transparent, text label | Accent tint, accent border, accent label (when pressed) | Only when pressed |
| Danger button | `dangerText` label | Armed: `danger` border, `dangerTint` | Never |
| Segmented options, filter chips, tabs, tool buttons, radio cards | Raised or transparent | Accent tint, accent border, accent label | Yes |
| Switch | Raised track with a `controlBorder` outline, muted knob | Accent track, `onAccent` knob | Yes |
| Checkbox, radio, range | `accentColor` | Same | Yes |
| Focus ring | Accent, 2 px, offset 2 (globals.css). `ink` inside a highlight fill | Same | Yes, except on a highlight fill |
| Links that navigate | Accent text, underlined | Same | Yes |
| Selection on the board (token ring, builder handles) | `useAccent()` | Same | Yes |
| Headings, labels, body text | Text or muted | Never accent | No |
| Unread badges on tabs and the Panels button | `text` fill, `bg` digits | Same | No: a count is a status |
| The "viewing as a player" notice | `accentSoft` fill, `ink` text, as today | Same | No |
| Status tags, notices, HP modes, dispositions, the turn highlight (`accentSoft`, `turnTint`) | Fixed tone colors | Fixed | No |
| The table display | Crest yellow | Same | No (it is not a member) |

### 2.3 Components

Each lives in `client/components/` unless it says otherwise. Everything keeps a 44 px target.

**Icon** (`Icon.tsx`, new). Inline SVG icons drawn with `currentColor` at `icon.md`, 2 px strokes: close, back, more, chevron right, chevron down, plus, minus, check, copy, filter. They replace the glyphs `×`, `‹`, `›`, `⋯`, `▸`, `▾`, `−` used as icons (49 sites), so every one draws the same whatever the font. Glyphs in text, such as "30 × 20" and the arrows in "↑10 ft", stay text.

**Button** (`Button.tsx`, extended).

- Variants: `primary`, `secondary`, `quiet` (the unused `ghost` renamed) and `danger`.
- Sizes: `md` is 16 px, weight 600, padding 0 `space(4)`. `sm` is 14 px, padding 0 `space(3)`. Both are at least 44 px tall and use radius `md`. `sm` replaces both `SmallButton`s and both `ToolButton`s.
- `pressed`: sets `aria-pressed` and the chosen look. It replaces `OptButton` and the toggle buttons.
- `busy`: a spinner before the caller's busy label ("Saving…", "Sending…", "Joining…", which `e2e/notes.e2e.ts:132,155` waits for), `aria-busy`, and further taps ignored, at full color.
- `block`: full width.
- One primary per view: the main action of a form, dialog, card or page (Create, Save, Send, Place, Join, Next turn, Continue). Buttons that open something or act on the side are secondary.

**Disabled and busy, for every control.** Nothing fades by opacity. Disabled keeps each control's shape and swaps its colors:

| Control | Disabled |
|---|---|
| Primary, secondary and danger buttons | Raised fill, `border` outline, `textDisabled` label |
| Quiet button, IconButton | Transparent as at rest, `textDisabled` label or icon. No shape change |
| Switch row | Name and help in `textDisabled`. Track raised with a `border` outline, knob in `textDisabled`, still at its on or off end |
| Segmented option, Chip, tab | Unchosen: `textDisabled` label. Chosen: keeps its place with a `textDisabled` outline and no tint |
| Radio card | `border` outline, no tint, title and help in `textDisabled` |
| Swatch | The disk keeps its color (the color is the content), the ring and badge turn `textDisabled`, and the legend says why. Today no swatch row is ever disabled |
| Field | `bg` fill, `border` outline, value in `textDisabled` |
| Checkbox | Native disabled look, dark through `color-scheme` |

Busy: the button that started the work shows `busy`. A form that waits on it (JournalEditor.tsx:149, PinPane.tsx:197, RequestSheet.tsx:100 dim their whole fieldset today) sets `disabled` on its `fieldset`, so its fields take the disabled look above, and keeps the busy button outside that fieldset.

**IconButton** (`IconButton.tsx`, new). 44 x 44, transparent, an `Icon` in `textMuted`, with the label in `aria-label` and `title`. `pressed` gives the chosen look. It replaces SceneSheet's and RoomChrome's IconButtons and every header close.

**Sheet header and panel subpages** (`SheetHeader.tsx`, new). One row, 56 px tall: an optional back IconButton, the title at `heading` weight 700, optional trailing actions, and the close IconButton. Its side padding is `space(2)`. `Sheet`, `Dialog` and panel subpages use it.

- Changed by docs/design-v1-side-headers.md: in the side panel, a subpage's header is a 44 px row with a 16 px title (`compact`), and the side panel's chosen tab draws the pressed look on a 32 px pill. Sheets and dialogs keep 56 px.

- `features/panels.ts` gains `usePanelHeader({ title, parent, onBack, armed })`. A panel calls it while it shows a subpage. While `armed` holds a label, the back button shows it beside the icon in the armed danger look, and the label is its name. Encounters uses it for "Discard changes?" (3.3).
- The back button's accessible name is "Back to" and the parent's name: "Back to Menu", "Back to Journal", "Back to Areas", "Back to Encounters", "Back to Monsters". Its visible content is the back icon only.
- A phone sheet shows the subpage's title and wires its back button to `onBack`. With no subpage named, its back button returns to the Panels grid as today ("All panels").
- The desktop side panel draws the header only while a subpage is named, so no panel repeats its tab's name.
- The hook does nothing where no host listens, so a panel can adopt it before the room wires it.

**Pane header** (same file, `PaneHeader`). The token action bar, label, pin and light panes, the door card and the stop note use one 48 px row: the title at 16 px weight 700 and a close IconButton. This removes the four negative-margin nudges.

**Dialog** (`Dialog.tsx`, new, from `features/images/Modal.tsx`). One `<dialog>` shell, opened with showModal:

- Backdrop `scrim`, radius `lg`, shadow `dialog`, width `layout.dialog.sm`, `md` or `lg`.
- Structure, which `e2e/size.e2e.ts:130,152,156` relies on: the card is the dialog's first `section`. One direct child of that section scrolls, up and down only, with padding `space(4)`. The header is SheetHeader, whose close button's name starts with "Close". Footer buttons sit in a `footer` element: a top border, a status line at the left (13 px muted, optional), then Cancel (secondary) and the main button (primary) at the right.
- Phone, `fill` mode: full screen, for editors with many fields (journal page, monster editor, image picker, crop, map import).
- Phone, `sheet` mode: a bottom sheet under the top bar, for short pickers (request a roll, filters, several tokens, scene sheet, stamps, the log's export). On a computer a `sheet` card fits its content, while a `fill` card keeps one height, so an editor does not jump as its tabs or steps change.
- `Modal.tsx` and `SheetDialog.tsx` become thin wrappers over it, so their callers keep working unchanged.
- The handout popup and the X-card use the same shell, with their own content. The handout keeps its deeper backdrop through a `scrim` prop, since a dim map helps read the handout.

**Sheet** (`Sheet.tsx`). Keeps its placement rules. Its header becomes SheetHeader, its title moves from 17 to 18 px, and its shadow is `shadow.sheet`. It gains `reserveTop`: its height cap (`Sheet.tsx:52`) keeps `max(24, reserveTop)` px free between the top bars and its top edge, for what docks there (3.2.1). It never goes below 120 layout px: the 56 px header, one 44 px row and the start of the next, so the body still reads as a list that scrolls.

**Sheet return focus and the alerts summary slot** (`sheetFocus.ts`, new). `useSheetReturnFocus(ref, rank)`: a control that should take focus when a sheet closes registers with a rank, and Room asks for the lowest rank present once a sheet has closed (3.2.1). `useAlertsSummary(entry)`, in the same pattern: part 5 publishes the rolls' part of the dock's summary into it (text, name, whether a request waits for this viewer, and `open()`), and part 3's dock reads it. Neither part imports the other, so each builds alone. Both do nothing until someone reads them.

**Panel layout** (`Panel.tsx`, new: `Section`, `SectionLabel`, `Help`, `Note`).

- A panel body has padding `space(4)`.
- Sections are separated by a 1 px `border` line with `space(4)` above and below.
- A section opens with a SectionLabel: 13 px, weight 700, capitals, `caps` tracking, `textMuted`, with an optional action at the right.
- A section about something that cannot be undone (the DM link, deleting the room, today's red 15 px headings at `features/dm/controls.tsx:13`) uses the SectionLabel's danger tone: `dangerText`, 5.9:1 on a surface.
- Help: 13 px muted, leading 1.4. Note: Help in the warning tone.
- These replace the five Groups, four Sections, five Notes, Help, two Hints and Muted, and `panels/parts.tsx`.
- A panel never repeats its own title as its first label (F25).

**Setting row** (`SettingRow.tsx`, new). The name at 16 px weight 600, help under it as its description, and a control at the right (Switch, Segmented, a small field) or below when it is wide. The DM tab, Room settings, This device, Scenes and Initiative all lay settings out this way.

**Switch** (`Switch.tsx`, new, from the Toggle in dm/controls.tsx). A `button` with `role="switch"` and `aria-checked`. Its accessible name is the setting's name and never changes with its state. The help is its `aria-describedby` description. The track is a 46 x 28 pill with a 20 px knob. The whole row is the target. Rule: a setting that takes effect at once and is on or off is a Switch. Section 3.7 lists every caller.

**Checkbox.** A native box at 22 px with `accentColor` set to the accent, dark through `color-scheme`. For picking several items in a list, and for options of a form that a button then submits (placing monsters, a journal page's secret block, a pin's DM only, a roll request's "Players see" options).

**Choices: Segmented and Swatches** (`Segmented.tsx` and `Swatches.tsx`, new).

- Each option is a native `<input type="radio">` inside its `<label>`. The input covers the whole option at opacity 0, so a tap anywhere on the option hits it and the 44 px target holds. Inputs in a group share one `name` from `useId`.
- The group is a `div` with `role="radiogroup"` and the group's name, so `getByRole("radiogroup", { name: "Ability" })` keeps working.
- Why native radios rather than buttons with a roving tabindex: the browser gives one Tab stop per group, arrow keys that move and choose, and the right announcements, with no key handling to write or test in four places. The three local Segmented copies and the measure Swatches render a button per option today, every one a Tab stop, with no arrow keys.
- The focus ring goes on the option through the `.rvtt-choice` rule in `globals.css` (2.1), the one thing inline styles cannot do here.
- A tap on the chosen radio does nothing, as with any native radio, so Segmented has no reselect handler. The one caller that closed its form that way, the new scene kind (`NewScene.tsx:42`), gets a Cancel (3.3).
- Segmented: options gap `space(1)`, wrapping, small-button size, the chosen one in the pressed look. For two to six choices: the new scene kind, light, who can read a page, the interface size, the tool modes. The HP entry modes (Damage, Heal, Set, Temp) keep their own mode colors, since red for damage and green for healing carry meaning. `even` with six options, such as Request a roll's six abilities, goes three by three where six cannot keep 44 px each (docs/design-v1-roll-request.md 4.2).
- Swatches: 44 px options, 28 px disks, the chosen one in a 2 px `text` ring with a 2 px `bg` gap. Each option's name is the color's name from `MEMBER_COLOR_NAMES` (other colors keep their names from their own lists, such as the icon neutrals). One row serves draw, pins, areas, the icon disk and members.
- Not choices: tabs. The image picker's sources and the side panel keep `tablist`, `tab` and `tabpanel`, which e2e queries. Their chosen tab takes the pressed look. The side panel's tabs take the ARIA tab keys: one Tab stop on the chosen tab (roving tabindex), Left and Right to move and choose, Home and End for the ends. The map's arrow and Page shortcuts stand aside on any tab list.

**Radio cards.** The settings' option cards stay as they are, the best-looking pattern in the app: radius `md`, accent border and tint when chosen.

**Field** (`Field.tsx`).

- On pages and in dialogs the label sits above at 14 px weight 600, the input is 16 px and 44 px tall with radius `md`, a `bg` fill and a `controlBorder` outline.
- In panels, `FieldRow` puts the label at the left (14 px, text color) and the input at the right. Numbers are 88 px wide and right aligned. Text takes the remaining width.
- Errors draw a `danger` border and a message in `dangerText`. Today 11 sites write error text in `danger`, which reads 4.2:1 on a surface.
- The 36 raw text inputs and the native selects move onto Field, FieldRow or a plain `Input` export with the same style.

**Rows** (`Row.tsx`, new).

- At least 44 px, or 56 px with two lines. Padding `space(2)` `space(3)`.
- A leading slot (a 32 px disk or a 20 px dot), a title at 16 px weight 600 with ellipsis, a detail line at 13 px muted, and a trailing slot (a value, a tag, a small button or the more IconButton).
- In a list, rows are separated by 1 px lines.
- A row that is itself a button (Menu items, the Claim page's "This is me", character cards) is a card: raised, radius `md`, `border` outline.
- The chosen row (the scene you are on) takes the accent tint and border. The active turn keeps `accentSoft` and `turnTint`.

**Chips** (`Chip.tsx`, new). Filters and quick picks: pill radius, 44 px tall, 14 px weight 600, an optional count in muted, the content centered. Chosen uses the pressed look. This covers the outliner filters, monster filters, DC chips and range ring presets. Range ring presets are 44 px circles, so a row of them reads as one set whatever their digits.

**Tags** (`Tag.tsx`, new). Read-only status: pill radius, a solid `bg` fill, a 1 px outline in the tone color, 13 px weight 600 (`tiny` 11 px in dense rows such as the tracker's legendary counters), padding 1 px `space(2)`. The solid fill keeps the text's contrast the same on any row, the tinted turn row included. Tones, with the text color and its ratio on `bg`:

| Tone | Outline | Text | Text on bg | Used for |
|---|---|---|---|---|
| success | `success` | `success` | 5.7:1 | Healthy, Online |
| warning | `warning` | `warning` | 8.8:1 | Bloodied |
| danger | `danger` | `dangerText` | 6.5:1 | Dying, Dead |
| muted | `border` | `textMuted` | 7.4:1 | Under fog, This device, Hidden |
| turn | `accentSoft` | `accentSoft` | 14.9:1 | "Players here", legendary counters |

It replaces the 11 to 14 px pills of F19. Part 1 tests every tone's text against its fill.

**Notice** (`Notice.tsx`, new). One look for toasts and banners:

- Tones: info (raised fill, `border` outline), warning (`warningFill`, `warning` outline), danger (`dangerFill`, `danger` outline), highlight (`accentSoft` fill, `ink` text, for "You are viewing as Pat"). The highlight tone sets `--rvtt-focus` to `ink`, so a control in it, such as the preview's Exit (`features/dm/PlayerPreview.tsx:98-119`), shows a ring that reads.
- 14 px text, radius `md`, padding `space(2)` `space(3)`, an optional action button at the right.
- Floating notices add `shadow.float` and stack in the existing notice layer under the top bar. Inline ones have no shadow.
- It replaces ConnectionStatus's banner, the scene loading toast, QuietLoadNotice, FrameView, DmDesk's wrappers, the roll toasts, PlayerPreview's banner and the inline banners on Home, StorageCard, JournalEditor and MonsterEditor.

**Empty** (`Empty.tsx`, new). One sentence at 14 px muted, leading 1.4, saying what will be here and how to add it, plus at most one button under it. Every panel's empty state uses it.

**Loading.** `Loading` and `Spinner` are unchanged. Full-screen waits (the boot text, opening the room, scene loading) all sit on `bg`.

## 3. Per-screen changes

Each row says what changes. "Before" and "After" name the look, and the files are the ones that change. Shared components come from section 2.3.

### 3.1 Pages outside a room

| Screen | Before | After | Files |
|---|---|---|---|
| Home (d-home, p-home, d-home-known-room) | Disabled Join is olive. "Set up a table display" is a small button where every other card action is full width. The tip floats under the cards. | Disabled buttons per F1. Every card's action is `block`. The tip becomes a Help line at the foot of the Table display card. "Forget" is a small danger button. | pages/Home.tsx |
| DM link saved (d-dm-link-save, p-dm-link-save) | Three filled buttons, accent disclosures, a white checkbox. | "Continue to the room" is the one primary. Both "Copy link" buttons are secondary with the copy icon. Disclosures are text color with a chevron icon. The checkbox is dark by `color-scheme`. | pages/Home.tsx |
| Join (p-join-password, p-join-name) | Olive "Next", faded swatches, hex labels. | Disabled per F1. Swatches per section 4. The legend lines up with the field labels. | pages/Join.tsx (part 9) |
| Claim (p-dm-claim) | "This is me" in accent inside a raised row. | A card Row with the member's dot, name and a trailing "This is me" in text color with a chevron. Disabled "Join as a new DM" per F1. | pages/Claim.tsx |
| DM link entry | The same Card and Field as Home. | Disabled per F1 only. | pages/DmLinkEntry.tsx |
| Not found, no such room (d-not-found, d-room-missing) | A bare card. | The Home header (logo and name) above the card. Home is a block primary inside it. | client/App.tsx, pages/RoomRoute.tsx |
| Opening the room (p-player-slow-load-1500ms) | Pure black behind "Opening the room...". | `bg`, the same as the boot text and the room. | pages/RoomRoute.tsx, pages/LiveRoom.tsx |
| Table display code (d-display-code, p-display-code) | The Home button sits outside the card, and a disabled Connect is olive. | Home is a quiet button inside the card's foot. Disabled per F1. | features/display/DisplayPages.tsx |
| Admin (d-admin-login, d-admin-rooms) | A 22 px title. "Last active" and "Size" as pills. Room rows built by hand. | The Home header at `display`. Sort order as Segmented. Rooms as Rows with Pin and Delete as small buttons. The backup warning as a Notice. | pages/Admin.tsx, features/admin/* |
| About (d-menu-about) | Headings at 20, 17 and 15. | `title`, `heading` and 16 px. Links stay accent. | panels/AboutPanel.tsx, features/about/* |

### 3.2 Room chrome

The side panel that hides from 900 px up, a phone's sideways sheet that hides, and the very short sheet over the whole screen are docs/design-v1-layout-hierarchy.md section 4.

| Screen | Before | After | Files |
|---|---|---|---|
| Top bar (d-dm-room-empty, p-player-room-empty) | The DM badge is an accent-outlined "DM". The player chip has a dot and a border in the member color. Different heights and weights. | One chip shape for both: a pill 28 px tall at 13 px weight 700, a dot in the member color and a 1 px outline in the accent. The DM's says "DM", the player's their name. The connection dot uses `shadow.rim`. | pages/Room.tsx (PlayerChip), pages/RoomChrome.tsx (Badge) |
| Side panel tabs (d-dm-room-empty) | The chosen tab is raised grey. Unread badges are accent filled. | The chosen tab takes the pressed look (accent tint and accent label). Unread badges take a `text` fill with `bg` digits, weight 700, since a count is a status. | pages/Room.tsx:758-783, pages/RoomChrome.tsx:325-340 |
| Panels grid (p-dm-panels-menu, p-player-panels-menu) | Text tiles, the last opened in an accent outline. | Unchanged in layout. The tiles use the card Row style, and the open panel takes the pressed look. | pages/Room.tsx |
| Phone sheets (p-player-sheet-*, p-dm-sheet-*) | A 17 px title, glyph back and close of different sizes. | SheetHeader. Subpages name themselves through `usePanelHeader` (section 2.3), so the Members page's sheet says "Members" and its back button is "Back to Menu" (F10). | components/Sheet.tsx (part 1), pages/Room.tsx |
| Token action bar (d-dm-token-selected, p-dm-token-bar, p-player-token-bar) | A 304 px card on a phone, glyph close, olive Apply, 14 px buttons of two kinds. It stays open under a phone's sheet (F9). | PaneHeader. Small buttons. Apply is primary with the new disabled look. On a phone in portrait it spans the screen with `space(2)` side margins. From 600 layout px up, and on a phone on its side, it docks in the map's free area, moves by its header and shares the right lane with the alerts column, and a screen too short for either opens it compact (docs/design-v1-bar-dock.md). It folds under a sheet as section 3.2.1 says. Since docs/design-v1-token-window.md, docked it is the token window: the measured default width, a grip and a Reset in its header, and on a computer a resize handle. | canvas/TokenActionBar.tsx, canvas/barDock.ts, canvas/Stage.tsx, pages/Room.tsx |
| Turn strip (p-player-fight-running, d-dm-fight-auto-init, l-player-landscape-sheet) | A 48 px band under the top bar whenever the layout is under 900 px wide (`features/encounter/band.ts:20-23`), landscape included. In TopBar one `compact` flag sets both the tight gaps and where the strip goes (`pages/Room.tsx:213-221,349-410`). | One rule in band.ts, `turnPlacement`, returns "bar" from 900 px wide, or when the layout is wider than tall, under 500 px tall, and the bar's row has measured room for the strip. Otherwise "band". InitiativeStrip draws from it, and `useTopBars()` reserves the 48 px only for "band", so sheets, notices, the token bar and the DM's roll desk follow it. All of it reads the chrome's own pixels (`layoutSize`), so the interface size changes it alike (F22). Measure and fall back: in "bar" the player's chip shows only its dot (the rule `chipDot` applies from 900 to 1100 px today, `Room.tsx:219`), then the bar checks whether its row overflows (`scrollWidth > clientWidth`). The row's own box keeps its size when its content grows, so the check runs on three triggers: a ResizeObserver on the row (the window changes), a ResizeObserver on the strip element, whose `flex: none` box grows with its content (InitiativeStrip.tsx:101-103), and a layout effect keyed on the bar's content state (whose turn, the player's own turn with "Your turn" and End turn, the timer, the room name, the blackout pill). If it does, band.ts records the width that overflowed plus the overflow, and placement stays "band" until the layout is wider than that. No fixed threshold, so long room names, the player's own turn and every interface size are covered, and the record stops it flipping back and forth. TopBar takes the placement as its own prop beside `compact`, which keeps only the gaps, the name's shrink and the phase menu. Browser checks at 844 x 390 and 667 x 375, at 100% and 130%, for a DM and for a player on their turn: every bar button lies inside the window. One check loads the page first, then starts the fight and passes the turn to the player at a fixed window size. | features/encounter/band.ts, features/encounter/InitiativeStrip.tsx, pages/Room.tsx |
| Reconnecting and offline (p-player-reconnecting, d-dm-reconnecting) | Literal fills `#3a2a07` and `#3b1214`. | Notice in the warning and danger tones. Same words. | components/ConnectionStatus.tsx (part 1) |
| Scene loading toast | Its own box, over a 0.3 black dim. | Notice, info tone, over `scrimLight`. | canvas/SceneLoading.tsx |
| X-card (p-player-xcard-confirm, p-player-xcard-after, d-dm-xcard-shown) | Its own card and backdrop. | The Dialog shell without a title row, the same words and buttons. | features/xcard/* |
| Stop note, ground notice, door card | Their own frames and close nudges. | PaneHeader and `shadow.pane`. | features/movement/StopNote.tsx, GroundNotice.tsx, features/doors/DoorPill.tsx, DoorButton.tsx |
| Party bar and dock (d-dm-character-placed) | "PARTY ▾" glyph, its own sizes. | Chevron icon, SectionLabel style for "Party", HP bar radius `xs`. | features/party/* |

#### 3.2.1 What floats over the map under a sheet

Today the token bar (`role="dialog"`, named "Thorn actions", `TokenActionBar.tsx:137,489-493`) keeps its place when a sheet opens, and the sheet paints over it (z 10 over 5). Its header is a `<strong>` name beside a button named "Close", which deselects the token (`Stage.tsx:1055`). The fight alerts column hangs from the top bar at z 15 above sheets (`InitiativeStrip.tsx:363-368`): concentration prompts with no count limit (`:550`), up to three notices, the time-up notice and the roll alerts. The DM's roll desk and the player's chips already fold under a portrait sheet (`deskLayout`, `features/rolls/logic.ts:426-432`). This section gives the token bar and the whole column the same rule.

- **When.** A phone in portrait (layout under 900 px wide and no wider than tall, the desk's rule) with a panel sheet or the Panels grid open (`sheetOpen(local)`). In landscape nothing docks: the right-hand sheet leaves the map beside it, the bar's right edge stops at the sheet's left edge instead of passing under it, and the column already steps aside (`InitiativeStrip.tsx:351-354`). The player's full-width roll card is the one thing that still folds there, into the column (3.3.1).
- **The dock.** Everything that floats folds into one row, 48 px tall, spanning the screen with `space(2)` margins, on the sheet's top edge. Part 3 renders it in Room. It holds two siblings: a group named "Thorn actions" when a token is selected, with "Show Thorn actions" (its visible text is the token's name, with a chevron icon, at 16 px weight 700) and the bar's "Close" side by side, then the alerts summary when the column has anything. Short of room, the token's name shrinks first, then the summary's text, each with an ellipsis, so what shows stays part of each button's name. The summary's count ("+2") sits outside the text that shrinks, so it always shows, and Close never moves.
- **The alerts summary.** One button that names the most pressing alert in its visible text, in this order: "Roll asked" (a roll waits for this viewer), or for the DM the rolls' count while a player's ask to change a roll waits (docs/design-v1-roll-request.md 6), "Concentration check", "Time is up", "Rolls d/a", then the newest notice. It adds "+2" when two more wait. An order by urgency rather than by time, since the column mixes log entries, roll requests and a timer that carry no common clock. Its name starts with that text and lists the rest: "Concentration check +2: Thorn checks concentration, rolls 1 of 3 answered, time is up. Close the sheet to see them." It is the "sheet" kind, with no `aria-expanded`: its tap closes the sheets and the full column shows. Every prompt is one tap away. The column's time-up and notice buttons are `role="status"` today (`InitiativeStrip.tsx:383,394`), and a hidden column says nothing. So Room keeps one visually hidden `role="status"` region, outside the column and outside the summary button (a hidden subtree leaves the accessibility tree, and a live region inside a button reads poorly). It exists at all times, whether or not the dock shows, and while the column is folded it takes each new alert's text, so nothing that was announced goes quiet when the dock appears or goes. The alert shows only as text because a card does not fit: at 320 x 480 at 130% the layout is 369 px tall, the bars and the turn band take 100, the toolbar 60, and 209 px are left for the dock and the sheet. The roll part comes from the alerts summary slot that part 1 adds (2.3): part 5 publishes the rolls' text and name, whether a request waits for this viewer's answer, and an `open()` action (3.3.1), and hides its own summary button while the dock shows. Part 3's dock reads the slot, which is empty until part 5 fills it, so each part builds alone.
- **Room for it.** The Sheet's cap today leaves as little as 24 px under the top bars (`Sheet.tsx:52`). While the dock shows, Room passes the Sheet a `reserveTop` (2.3) of the dock's measured height plus the `space(2)` gap above it, and the sheet keeps its minimum of 120 layout px (2.3). At 320 x 480 at 130% in a fight, with no safe areas, that leaves the sheet 153 px. Part 1 adds the prop and the minimum, part 3 measures the dock and supplies the reserve.
- **When the dock and the sheet's minimum do not both fit.** Safe areas can take that room (`Sheet.tsx:52` subtracts them): at 320 x 480 at 130% with 44 px at the top and 34 at the bottom, 131 px are left between the bars and the toolbar, less than the 176 the dock, its gap and the minimum need. Then the dock is not drawn, and its buttons move into the sheet header's trailing actions (SheetHeader, 2.3): the token's group and the alerts summary, between the title and the sheet's close. There the token's group is one outlined chip with the token's name, and a tap on it shows the token's actions, as "Show Thorn actions" does. It has no close icon of its own in header mode: the token's Close is in the bar the chip shows, so the header holds one close, the sheet's, and two closes never sit side by side. That leaves at most four 44 px targets (Back, the token chip, the alerts summary, Close) and a 40 px title. With the four 4 px gaps between them they need 240 layout px once the header's side padding halves to 4 px, which it does while it holds the dock's buttons, inside the 244 px the forced case's sheet has (its 246 px layout less the sheet's border). With the full 8 px padding they needed 248. The title shrinks first but keeps a few letters (`minWidth: 40`, as the top bar's room name does at `Room.tsx:383-388`), then the token's name and the summary's text shrink, each with an ellipsis, while the summary's count and every icon stay. While Back asks its question (the encounter editor's "Discard changes?"), the question takes the title's place and the dock's buttons step aside until it is answered or put away: the question alone is about 160 px, and beside the title and the dock's buttons it ran past the sheet's edge. The sheet keeps its 120 px.
- **The folded bar.** While docked, the bar's frame in Stage draws nothing. It takes the `hidden` attribute and keeps its body mounted inside, and the global `[hidden]` rule (2.1) wins over the body's inline `display: grid` (`TokenActionBar.tsx:513-520`). Its controls leave the focus order and the accessibility tree, and the body stays mounted, so a half-typed HP entry, the chosen HP mode, an open Conditions drawer, the light chip and an armed Delete survive. The group bar ("3 selected tokens", `TokenActionBar.tsx:263-372`) folds the same way: the dock's group is named "3 selected tokens" and holds "Show actions for 3 selected tokens" and its close, still named "Let go of all of them".
- **Show buttons.** Each closes the sheets (`ui.closeSheets()`, as the desk's button does) and focuses what it shows. "Show Thorn actions" focuses the bar's frame (`tabIndex={-1}`), which announces "Thorn actions, dialog" and opens no keyboard. The alerts summary calls the rolls' `open()` when a request waits for this viewer's answer, which shows that request's card even if the player put it off with Later, and focuses it (3.3.1). Otherwise it focuses the column's first alert. From the dock an action takes two taps: Show, then the action.
- **Close.** Does what it does today: deselects the token, and the bar goes. The sheet stays open. Focus moves to the sheet's back button, or its close button when it has none.
- **Folding.** If focus is inside the bar's body or the column when they fold, it moves to the matching dock button. Otherwise it stays where the tap that opened the sheet left it.
- **When the sheet closes by its close button, Escape or Back.** Everything unfolds. If focus was in the sheet or was lost with it, one decision places it: a mounted roll card that the sheet was hiding, else the token bar's frame, else where it goes today. A request the player put off with Later stays put off: it has no card, so it is not a target. Part 1 adds a small registry, `useSheetReturnFocus(ref, rank)`, part 5 registers the card (rank 1), part 3 registers the bar (rank 2), and Room, which part 3 owns, asks it once when a sheet closes.
- **Escape and Back.** Unchanged. Escape closes the sheet first, then the bar (`lib/escape.ts:9-12`). Back closes what opened last (`lib/backClose.ts:10-14,74-79`): a sheet opened over a bar closes first, and a bar opened folded under an open sheet closes first. A folded roll card takes no part (3.3.1).
- **Tests.** Part 3's `e2e/fold.e2e.ts` asserts `document.activeElement` after each of: folding with focus in the body, each Show button, Close, and the sheet closing by Escape and by Back. It checks that folded controls are not visible and cannot take focus with Tab, and that a typed HP value survives a fold and an unfold. It checks that the dock clears the top bars and the sheet keeps 120 px at 320 x 480 and 375 x 667 in a fight, at every interface size, and at 320 x 480 at 130% with three concentration prompts, the Rolls summary and a selected token. It runs on real device profiles, 375 x 667 with no insets and 375 x 812 with 47 px top and 34 px bottom insets, at 100% and 130%, and on one forced case, 320 x 480 with 44 and 34 px insets, where the dock's buttons must sit in the sheet's header, the sheet keeps 120 px, and nothing overlaps the bars or the toolbar. It checks that a time-up under a sheet updates Room's status region. The combined cases (a selected token, a roll waiting and an open sheet, through Escape, Back and each Show button, and the same with the roll put off by Later, where the summary opens it and a generic close does not) pass once part 5 fills the registries, and the owner runs them after merging both. A unit test covers the fold rule (portrait, landscape, wide, no sheet).

### 3.3 Panels

| Panel | Before | After | Files |
|---|---|---|---|
| Initiative (d-tab-initiative, d-dm-fight-running, p-dm-sheet-initiative) | Caps labels at `small`, SwitchRows, "By creature" as pressed buttons. | Sections with SectionLabels, Switch SettingRows (3.7), Segmented for the auto initiative order and the turn timer. "No fight is running." is Empty. "Next" stays the one primary. Disabled per F1. | panels/TrackerPanel.tsx, features/encounter/* |
| Token (d-tab-token, p-player-sheet-token-v2) | Caps labels from `tokens/ui.tsx`, FieldRows by hand, "Healthy" pill, checkbox rows that apply at once. | Sections, FieldRow, Tag for the health state, small buttons, Chips for the range ring presets, Switch rows (3.7). The owners list stays checkboxes. "Tap a token to see it here." is Empty. Order and folds: docs/design-v1-token-panel.md. | panels/TokenPanel.tsx, features/tokens/*, features/vision/TokenSight.tsx (part 6) |
| Characters (d-tab-characters, p-player-sheet-characters) | "Ad" style initials, card rows. | `initials()` from lib (F12). Character cards as card Rows. "New character" stays a block primary. | features/tokens/CharactersPanel.tsx, CharacterCard.tsx |
| Monsters and stat blocks (d-dm-monsters-panel, d-dm-statblock-full) | Accent headings, "Go" initials, an in-body "‹ Back". | Headings in text color with a 1 px rule under each (F4). `initials()`. The stat block is a subpage named by the monster, with "Back to Monsters" in the header. Placement options stay checkboxes, since "Place on the map" applies them. | features/tokens/MonstersPanel.tsx, features/monsters/*, components/Markdown.tsx (part 1) |
| Encounters (d-tab-encounters, d-dlg-encounter-builder) | Olive "Save encounter" and "Place where I tap". An in-body "‹ Back" that arms as "Discard changes?" (`EncountersPanel.tsx:214-227`). | Disabled per F1. Empty for no encounters. The editor is a subpage with "Back to Encounters" in the header. With unsaved changes the first tap on back stays and sets `armed` to "Discard changes?", so the back button shows that text beside the icon in the armed danger look, with that name. A second tap leaves, and any edit disarms it, as today. | features/encounters/* |
| Scenes (d-dm-scenes-panel-full, d-dm-map-scene, p-dm-sheet-scenes) | Rows wrap to four lines. Fog, grid lines, party vision and movement are buttons named by their state. "Upload and create" looks chosen. The list's label repeats the sheet's title. | Scene rows: thumbnail, the name on one line, the detail on one line, the more button. "Move players" (small secondary) or the "Players here" Tag go on a second line under the text. Switch rows "Fog", "Grid lines", "Party vision" and "Walls and ledges block players' moves" (3.7). "Upload and create" is primary. The new scene form gets a Cancel that folds it, since a tap on the chosen kind no longer does (2.3). Its Cancel during an upload keeps aborting the upload (`NewScene.tsx:158`). The list's label becomes "All scenes", and "Reorder" stays at its right. | features/scenes/*, features/vision/VisionSettings.tsx, PartySightToggle.tsx, features/movement/SceneSetting.tsx |
| Outliner (d-tab-outliner, p-dm-sheet-outliner) | Chips fine, weight 500 rows, "Under fog" pills. | Chip, Row and muted Tags. | features/outliner/* |
| Library (d-tab-library) | A hint line at 14 px. | Empty. | panels/LibraryPanel.tsx, features/images/LibraryGrid.tsx |
| Areas (d-tab-areas, p-player-sheet-areas), part 7 | Plain text. A 4 px stripe on area cards. An in-body "‹ Areas" on the damage page. | Empty. Stripe 3 px. The damage page is a subpage with "Back to Areas" in the header. | features/areas/AreasPanel.tsx, AreaDamage.tsx |
| Log (d-tab-log, p-player-sheet-log) | A white checkbox for "Chat only". Olive Send. | "Chat only" stays a checkbox, as a filter, now dark. Show older and Export as small buttons. Disabled per F1. Whisper marks keep `accentSoft`. | panels/LogPanel.tsx, features/log/* |
| Journal (d-tab-journal, p-player-sheet-journal) | "New page" is a small primary. A page has an in-body "‹ Journal" in accent. | A block primary, as in Characters. Empty for no pages. A page is a subpage named by its title, with "Back to Journal" in the header. | features/journal/* |
| DM (d-tab-dm, p-dm-sheet-dm) | Four primaries, 15 px sentence-case headings. | Sections with SectionLabels ("Players' view", "Undo", "Handouts", "Player link", "Table display"). View, Show a handout, Show the player link and Add a TV become secondary. Switch rows. The "viewing as" banner is a Notice in the highlight tone. | panels/DmPanel.tsx, features/dm/*, features/handouts/* |
| Menu (d-tab-menu, p-player-sheet-menu) | "Copy player link" in accent text. In-body back links. | "Copy player link" as a quiet small button with the copy icon. Menu items as card Rows. Subpages name themselves through `usePanelHeader`, with "Back to Menu" (F10). | panels/MenuPanel.tsx |
| Members (d-menu-members, p-player-members) | Hand-built rows, "This device" in accent. Two primaries for the DM: "Show the player link" and "Add a DM device" (`features/dm/Access.tsx:137,389`). | Rows, Tags for Online and This device. Kick and Remove as small danger buttons. "Show the player link" stays the page's one primary, and "Add a DM device" becomes secondary. The "DM link" and "Delete this room" sections use the danger SectionLabel. The color picker (section 4). | panels/MembersPanel.tsx (part 9), features/dm/Access.tsx (part 4) |
| Room settings (d-menu-settings) | Group titles ("Players", "Combat") at 15 px, the same size as the setting names under them. | SectionLabels for the groups, SettingRows for the settings. The radio cards and switches are already right. The pick-several lists of players stay checkboxes. | panels/SettingsPanel.tsx, features/settings/* |
| This device (d-menu-device) | 100% shown as a pressed button. | Segmented for the interface size. SettingRows. | features/device/* |

#### 3.3.1 Roll requests on phones (part 5)

Since wave 7 the card's measured answer row is its answer block, from "Fail (Stunned)" or the roll row down to the total and Send (docs/design-v1-roll-request.md 5.7). Every step below that reads the row reads the block, and every fallback is unchanged.

Two findings from the post-wave-5 review. The project owner confirmed their recommendations on 2026-10-15 (6.3, question 4). They build on that review's live play fixes: the player's chips cap at two on a phone, with a "Rolls d/a" button for the rest (a disclosure with `aria-expanded`, `PlayerRolls.tsx:95-108`), and fold into that button while a sheet covers the map in portrait (`PHONE_CHIPS` and `chipStack`, `features/rolls/logic.ts:460-475`).

**The player's card over a sheet** (screenshot `022-fail-player-phone-chips-under-sheet.png` from the post-wave-5 review). Below 600 layout px the card (`role="dialog"`, "The DM asks for a roll") is portaled full width and fixed above the toolbar at z 25 (`PlayerRolls.tsx:111,136,195-215`). It stays over a phone's sheet until answered or folded with Later, and in 022 it hides the lower half of the Panels list (Areas, Log, Journal, Menu). From 600 px it sits in the fight alerts column. The code's comment says "The card is the prompt and stays" (`PlayerRolls.tsx:88`), and part 5 rewrites it to the rule below.

- **When it folds.** Whenever it would cover an open sheet: a sheet or the Panels grid is open, and either the card is the full-width one (under 600 layout px, portrait or landscape) or the layout is portrait (the desk's rule, where the column's card would cover the sheet's header). It folds rather than moving to the column because at 667 x 375 at 115% the layout is 580 px wide, the right-hand sheet takes 340, and the 240 px left is narrower than the column's 300 px card. Folding is also the rule the chips, the desk and the token bar follow.
- **Folded.** The card stays mounted with the `hidden` attribute, which the global `[hidden]` rule (2.1) keeps hidden over its inline `display: grid` (`PlayerRolls.tsx:186,208`). Its controls leave the focus order and the accessibility tree, and its typed total and chosen roll survive. While it is folded, `underSheet` holds for `chipStack` in landscape too, so every chip folds with it into one summary of the "sheet" kind: no `aria-expanded`, and a tap closes the sheet. The summary shows even when no other chip does, and reads "Roll asked" while any request waits for this player's answer and "Rolls d/a" otherwise, with a name that starts with that text: "Roll asked: the DM asks for a Wisdom check. Close the sheet to answer." In portrait that summary is the dock's alerts summary (3.2.1). In landscape it stays in the column, which steps left of the sheet. A card at a narrow screen's foot folds the same way, into the column's own summary, while a popover of the tool's options is open, since that popover rises from the row the card stands on and the card stands over popovers (docs/design-v1-tool-options.md 7.6). That summary's name ends "Open it to answer.", since there is no sheet to close: a press on it closes the popover as any press outside one does, and a click alone, as a screen reader's, closes it too and focuses the card. A new request that arrives under a sheet arrives folded and still chimes (`cameUp`, `logic.ts:390`). The first keystroke or roll choice in a card sets `opened` to its request, so a newer request becomes a chip and never replaces a card being typed in, with or without a sheet over it (today `shownRequest()` would switch to the newer request and drop the typed total).
- **Back.** The card registers with `useBackClose` only while it shows (today `PlayerRolls.tsx:155` registers whenever the card is the portaled kind). So a request that arrives under an open sheet never takes Back: Back closes the visible sheet first.
- **The summary opens a request.** Activating the summary is a request to answer. Its `open()` first prefers a mounted card the sheet is hiding: the one `shownRequest()` already shows (`logic.ts:375`), a request the player tapped open included. Only when no card is mounted does it take the newest request still waiting for this player's answer and undo Later for it, the way a chip's tap does (`setOpened`), so its card mounts. So it never unmounts a card with an unsent total, and never overrides a Later the player chose in order to answer another request. Either way the sheets close and focus moves to the card's dialog (`tabIndex={-1}`), which reads its request and opens no keyboard. If the build finds a state where a card cannot open, the fallback is that request's chip: the stack expands first (`setExpanded(true)`), so the chip is not hidden past the two-chip cap, and focus goes to the chip.
- **Focus otherwise.** If focus is in the card when it folds, it moves to the summary. When the sheet closes any other way, Later stays as it was. Only a mounted card registers, as rank 1 in `useSheetReturnFocus`, so the one decision of 3.2.1 gives it focus before the token bar, and a request put off with Later is never a target.
- **Tests.** Part 5 adds `e2e/rolls.e2e.ts`: a request arriving under an open sheet on a phone (folded, "Roll asked", chime), the folded card not visible and not reachable by Tab, Back closing the sheet and not the card, keyboard reopening with focus on the card, a typed total kept through a fold and an unfold, and the same at 667 x 375 at 115% with the right-hand sheet and the summary of the "sheet" kind. One case asks three requests, puts the oldest off with Later, opens a sheet and activates the summary: the newest waiting request's card shows and takes focus. One asks two, opens the older one's chip, types a total, opens a sheet and activates the summary: that card comes back with its total. Another puts a request off with Later, opens a sheet over a selected token, and closes it with Escape: Later holds and focus goes to the token bar. One types a total into a card that came up on its own, opens a sheet, and a newer request arrives: once the sheet closes, the same card shows with its total and the newer request is a chip.

**The DM's open requests on a phone** (`015-dm-phone-room-open-requests.png` in the same folder). Every open request stacks as a folded card of about 62 px (`DmDesk.tsx:55-80`), and six cover most of the map's top half. Recommendation: the player's rule and look, through the same `chipStack`. On a phone the newest two cards show, then one "Rolls d/a" button with `aria-expanded` that shows the rest and folds them again, the same disclosure and wording as the player's. "Close all answered" stays first. While a sheet is open in portrait, the whole stack folds into the dock's alerts summary (3.2.1).

### 3.4 Map tools

A tool's options are one row, with what does not fit behind ⋯, and on a short screen held sideways they stand in the toolbar's own row: docs/design-v1-tool-options.md, which replaced the rail of docs/design-v1-layout-hierarchy.md section 3.

| Tool | Before | After | Files |
|---|---|---|---|
| Every options bar (d-tool-*) | The hint at the top, the end or below. Hand-built buttons. | One layout: the hint line first (13 px muted, wraps), then a wrapping row of controls with gap `space(1)` inside a group and `space(2)` between groups. Modes are Segmented, actions small buttons, clears small danger buttons. | features/measure/controls.tsx, areas/AreaOptions.tsx, drawings/DrawTool.tsx, pings/PingTool.tsx, pins/PinTool.tsx, fog/Options.tsx, grid/Options.tsx, builder/Options.tsx, builder/heights/HeightOptions.tsx, select/SelectOptions.tsx, tokens/placeTool.tsx |
| Ping (d-tool-ping) | "Sound on" and "Sound off", a pressed button whose name changes. | A pressed button with the fixed name "Ping sound", the same setting and name as in This device (3.7). | features/pings/PingTool.tsx |
| Grid (d-tool-grid) | "Apply" with the chosen look. "App grid shown" and "App grid hidden". | Apply is primary. The grid toggle is a pressed button named "Grid lines", the same setting as the Scenes switch (3.7). | features/grid/Options.tsx |
| Draw and pin (d-tool-draw, d-tool-pin) | Two swatch rows built separately. | Swatches with color names. | features/drawings/DrawTool.tsx, features/pins/PinTool.tsx |
| Areas and rulers | "Share" and "Shared", "Hide" and "Hidden": pressed buttons whose names change. | Pressed buttons with the fixed names "Shared" and "Hidden", which say what pressed means, as the token bar's "Hidden" and "Locked" do (3.7). | features/areas/AreaOptions.tsx, features/measure/RulerTool.tsx |
| Label, pin and light panes | Their own frame and close nudge. | PaneHeader, `shadow.pane`, radius `lg`. | features/builder/LabelPane.tsx, labelPaneFrame.ts, features/pins/PinPane.tsx, features/lights/LightPane.tsx |
| Stamp picker and sheet | Their own `<dialog>`s at 0.45 and 0.2 backdrops. | Dialog in `sheet` mode. The sheet keeps `scrimLight`, so the map stays in view. | features/builder/stamps/* |

**Height mode pills** (F11). The pills follow the board text rule of `docs/design.md:1502` and stop covering token labels:

- The font becomes `boardSizes(scale).pillPx`, the size of every other board pill (12 design px scaled with the map between 11 and 16 px, times the interface size). Padding and height scale from it, as `pillGeometry` does in `measure/Pill.tsx`. The stair `?` marks take `boardSizes(scale).chipTextPx` instead of their own clamp of 11 to 18 px.
- The pills draw under the token labels, chips and plates instead of over them. Stage's overlay layer draws, in order, the sight overlay, the fog, the tokens above it, the token decor, then every overlay entry (`canvas/Stage.tsx:1013-1023`). It gains one slot just before the decor, and the height layer moves there. Labels then always read on top.
- They are not published as board pills. Publishing would put up to 300 more obstacles into the label pass, and that pass reruns on every zoom step (`canvas/useBoardText.ts:147` depends on `scale`), so every frame of a pinch would pay for it. A published pill also has one fixed spot, while each region picks its spot per zoom today (`heights/HeightLayer.tsx:66-73`).
- Pills stay readable, not only drawn under. Stage already places every token label and plate per zoom. Part 1 hands those placed boxes to the overlay slot (`labelBoxes`, in screen pixels for the current camera), and the height layer checks each candidate spot's pill box against them, as it checks pills against each other today (`HeightLayer.tsx:66-73`). It only reads them: nothing goes back into `placeLabels`. The boxes include each token's condition chips, elevation badge and HP bar too, which draw over the slot like the labels: an elevation badge ("↑25") half over a pill ("↑25 ft") left neither readable (build review round 1).
- When no candidate spot of a region fits, its pill is left out at this zoom, the same fallback the pill-against-pill check uses today, and it comes back when a zoom gives it room. A pill drawn half under a label would not read either.
- Unchanged: at most 300 pills, largest region first, never overlapping each other, and the `?` only from 8 px a cell.
- Files: `features/builder/heights/boardText.ts` and `HeightLayer.tsx` (part 8). The slot in `canvas/Stage.tsx` and `features/layers.ts`, with the label boxes it passes, comes from part 1, which runs before anything else.
- Tests (part 8): pill sizes against `boardSizes`, and a crowded region at fitted zoom where every drawn pill clears every label and plate box. The timing script `scripts/bench-height-pills.ts` (part 8's, run alone) times the spot pass in node for 300 regions and 40 labels at three scales, and drives a 20-step pinch over the same scene in Chrome at 4x CPU throttling, where the height layer, label check included, may add at most 4 ms to a frame.

### 3.5 Dialogs

| Dialog | Phone mode | Width | Change |
|---|---|---|---|
| Request a roll (d-dlg-ask-party, p-dm-dlg-ask-party) | sheet | md | Dialog shell. "What to roll" and "Ability" as Segmented, DC chips as Chips, the footer as today. |
| Several tokens (GroupMoreSheet) | sheet | md | Dialog shell. |
| New page and edit page (d-dlg-journal-editor, p-dm-dlg-new-page) | fill | md | Dialog shell. "Who can read it" as Segmented. |
| Choose an image (d-dlg-image-picker, p-dm-dlg-image-picker) | fill | lg | Dialog shell. The source tabs keep `tablist` and `tab` (size.e2e.ts:305-311 and tools.e2e.ts:501-502 query them) and take the pressed look. Swatches for the disk color. |
| Crop the image | fill | md | Dialog shell. |
| New monster and edit monster (d-dlg-new-monster) | fill | lg | Dialog shell. Group titles as SectionLabels, not accent (F4). |
| Paste or attach a stat block | fill | md | Dialog shell. |
| Import a Universal VTT map | fill | lg | Dialog shell. |
| Export the log | sheet | sm | Dialog shell. A short list of sessions, so it fits its content on a computer, where `fill` left the card mostly empty. |
| Scene sheet, monster filters | sheet | md | Dialog shell. |
| Shortcuts (d-dlg-shortcuts) | fill | sm | Dialog shell. Keys keep their mono `kbd` look at radius `sm`. |
| Handout popup | fill | lg | Dialog shell, close icon in the header, deeper scrim kept. |

Every dialog keeps its accessible name and the structure section 2.3 gives the Dialog, which `e2e/size.e2e.ts` relies on.

### 3.6 The table display

It keeps its black stage, its large type and its lack of chrome. Only its banners move to Notice colors and its sizes to named constants. It is not a member, so it shows the crest yellow (d-display-room).

### 3.7 On and off controls

One rule per place, so a control's look says how it behaves:

- In a panel, a setting that takes effect at once is a **Switch row**: `role="switch"`, a fixed name (the setting's name), the state in `aria-checked`, the help as its description.
- In a tool's options bar or a pane, an option that takes effect at once is a **pressed button** with a fixed name that says what pressed means, and `aria-pressed`, as "DM only", "Snap" and the token bar's "Hidden" are already. A switch row does not fit a bar.
- An option that a button then submits, a filter, a pick-several list and a mixed state are **checkboxes**.
- An action pair whose label names what a tap does (Edit and Done, Reorder and Done, Hide and Show, Add and Done) is a plain button and stays as it is.

| Today | Where | After |
|---|---|---|
| `Toggle` (dm/controls.tsx), a switch whose name is its label plus its help | Room settings (8 settings), Party sight, Show my view on the table display, Follow me, Black out players' screens, Low power, Turn sound, Ping sound | Switch, named by the label only. The e2e selectors use a prefix (`/^Black out players' screens/`, `/^Show my view on the table display/`), so they still match |
| `Toggle` (dm/controls.tsx) in the movers and drawers lists | SettingsPanel.tsx:114 | Checkbox: a pick-several list |
| `SwitchRow` (encounter/parts.tsx) that applies at once | TrackerPanel.tsx:337,467,552,554, encounter/Row.tsx:382-384,446, ReadyControls.tsx:41 | Switch |
| `SwitchRow` read by a button | AutoInitiative.tsx:73 "Re-roll monsters that have a value", RequestSheet.tsx:159-160 "Players see the DC" and "Players see pass or fail" | Checkbox |
| `Toggle` (tokens/ui.tsx), a checkbox row that applies at once | TokenPanel.tsx:229 "Hide the name from players", :285 "Hidden from players", :291 "Locked", :292 "Always visible, even under fog", TokenSight.tsx:64 "Shares sight with the party", StatsSection.tsx:77 "Hovers" | Switch |
| `Toggle` (tokens/ui.tsx), pick-several or filter | TokenPanel.tsx:330 owners, CharacterCard.tsx:119 played by, MonsterFilters.tsx:274-275 | Checkbox |
| `Toggle` (tokens/ui.tsx) submitted by a button | JournalEditor.tsx:297, PinPane.tsx:222, RequestSheet.tsx:180, EncountersPanel.tsx:353-354,412, EffectsSection.tsx:432,440, CharactersPanel.tsx:367, MonstersPanel.tsx:182,193-194, MonsterImage.tsx:133 | Checkbox |
| Native checkboxes | LogPanel.tsx:150 "Chat only" (a filter), SceneSettings.tsx:337, SceneSheet.tsx:141, HandoutsSection.tsx:200, ImportDialog.tsx:496, HpSection.tsx:125, GroupMoreSheet.tsx:158 (mixed), Home.tsx:381 | Checkbox, dark through `color-scheme` |
| "Fog is on" and "Fog is off" | SceneSettings.tsx:41-45 | Switch "Fog" |
| "Shown" and "Hidden" under "Grid lines" | SceneSettings.tsx:186 | Switch "Grid lines" |
| "Players see only what their characters see" and "Players see everything you reveal" | VisionSettings.tsx:47-51 | Switch "Party vision", whose help says which way it is |
| "Walls and ledges block players' moves", pressed | movement/SceneSetting.tsx:20-24 | Switch, same name |
| "App grid shown" and "App grid hidden" | grid/Options.tsx:98-104 | Pressed button "Grid lines" |
| "Sound on" and "Sound off" | pings/PingTool.tsx:78-87 | Pressed button "Ping sound" |
| "Share" and "Shared", "Hide" and "Hidden" | areas/AreaOptions.tsx:302,398, measure/RulerTool.tsx:180-197 | Pressed buttons "Shared" and "Hidden" |
| "Grid on" and "Grid off" in the map export | mapexport/MapExport.tsx:177 | Checkbox "Grid", read by "Make image" |

## 4. The member color picker

Today a member picks a color only when joining. The op to change it already exists: `member.update { memberId, name?, color? }` (`shared/protocol.ts:847`). The server lets each member change only their own (`shared/permissions.ts:228,384`), the reducer writes it (`shared/reducer/room.ts:34-38`), and every viewer receives it. No client sends it yet (`lib/accent.ts:41-42` says so).

### 4.1 Where it lives

- Menu, then Members, on your own row (d-menu-members, p-player-members). The row gains a trailing small button "Color" with the member's dot in it, named "Change your color" for screen readers.
- Tapping it opens the picker inline under the row, pushing the list down, and scrolls it into view (`scrollIntoView({ block: "nearest" })`): a phone sheet is at most 60% of the screen and the picker is about 250 px tall, so under a lower row it would open out of sight. Tapping "Color" again, or "Done", folds it.
- The DM gets the same row and picker. A DM in a room made before the accent followed members (stored as the old orange `#f38400`) can now pick a color for real.
- While the DM views as a player, the "Color" button is not shown, as Leave room is disabled there (`panels/MenuPanel.tsx:96-101`) and the preview refuses every op (`features/dm/preview.ts:134-137`).
- Not in this pass: renaming yourself, which the same op allows.

### 4.2 What it shows

```
Pat (you)                          [● Color]
Player · Online
┌───────────────────────────────────────────┐
│ Your color                                │
│ ( ● ) ( ● ) ( ● ) ( ● ) ( ● )             │
│ ( ● ) ( ● ) ( ● ) ( ● ) ( ● )             │
│ Buttons  [ Primary ]   Pings and drawings ●│
│ Drawings you made keep their color.  Done │
└───────────────────────────────────────────┘
```

- The palette is `MEMBER_COLORS`, the same ten as the join page, in the same order. The crest orange stays on offer, last, as the owner decided after the post-wave-3 review, with its buttons staying yellow (question 1).
- A current color outside the palette (one an older join form accepted, or one a hand-made op stored) shows first as an extra, chosen swatch named "Current color". It goes once the member picks a palette color.
- Swatches use the shared Swatches component (native radios, section 2.3): 44 px targets, the chosen one ringed.
- A color another member uses keeps its full color and carries a 16 px badge at its lower right, in the ink that reads on the swatch: that member's initial, or "DM" on the join page (4.4). It stays pickable, as on the join page today.
- Each swatch's accessible name is the color's name from `MEMBER_COLOR_NAMES`, plus who uses it: "Green, used by Pat", "Yellow, used by Dana and Lee".
- The preview line stays. It shows a primary button in `accentFor(color)` and a dot in the raw color for pings, the laser and drawings, so a member can tell the adjusted button color from the color the map shows. When `accentFor` moves the color, the line adds "Buttons use a lighter shade so they stay readable" (a dark color) or "Buttons stay yellow" (the orange, question 1).
- One Help line says what follows the change: "Your pings, laser, rulers and buttons change now. Drawings, pins and areas you already made keep their color."

### 4.3 The op and its effects

- A tap sends `member.update { memberId: you, color }` at once, like a Switch, with no Save. The swatch shows chosen at once from the local prediction. A refusal puts the old color back and shows the client's usual refusal message.
- Every tap in one opening of the picker goes under one undo group (`actions.dispatch(op, { group })`, with the group made by `actions.newId()` when the picker opens). The server merges grouped steps (`server/rooms/undo.ts:121-136`), so a DM who tries four colors undoes them as one "changing your name or color" (`server/rooms/undoLabels.ts:34`). A player's undo does not record the op, which is fine for a color they can pick again.
- The accent follows the member's color live through `useAccent()`, so the interface recolors at once.
- What follows the color live, from the code: the accent, pings, laser, live and kept rulers, remote drags and remote area previews, the members list, the top bar chip, owner dots and chat names. What keeps its color, because it was stored when made: drawings, pins and area templates.
- No protocol, schema or migration change. The picker sends only `MEMBER_COLORS` values, six hex digits in lowercase. Replay checks every stored op against today's `opSchema` (`server/rooms/persistence.ts:115`), so a tighter schema could leave a room read-only, and normalizing stored values would break later restore guards. A hand-made op can still store any color the shared schema allows (`#rrggbb` or `#rrggbbaa`, any case), as today. `accentFor` falls back to the crest yellow for anything it cannot use, and the picker shows such a color as "Current color".

### 4.4 Who uses a color

The picker and the join page both mark the colors in use, from real data. Today both assume the DM is yellow (`lib/memberColor.ts:4-7,14-16,37-38`), which is wrong once a DM can change color.

- **Members.** The picker reads the whole roster from the room's view: every member, DMs included, with their current colors.
- **Join.** Step one of joining (`POST /api/rooms/:id/join`, `server/http/join.ts:83`) answers `{ ticket, players }` with the players a device may continue as, and leaves DMs out (`join.ts:169-174`). It gains `dmColors`: the current colors of the members whose kind is DM (`dmRoster`, `server/rooms/actorGateway.ts:85-88`), with no names or ids. `client/lib/api.ts` (the step-one answer type, `:297`) reads it. A member left out of `players` for having been a DM but who is a player now is in neither list, so their color is not marked. That case is rare and costs nothing but a duplicate color.
- `freeColor(taken, dmColors)` counts both lists and no longer adds `DM_DEFAULT_COLOR`. On a tie, a color a DM uses goes last, as the yellow does today.
- `colorUsers(color, players, dmColors)` names the players and adds "a DM" (or "2 DMs").
- The join page (p-join-name) uses the same Swatches, badges and names instead of the 35% fade and the hex labels. A DM's color carries a "DM" badge.
- Tests: a DM who changed color (the yellow is free, the new color is taken), two DMs, two members sharing a color, a room with no players. `server/http/join.itest.ts` checks that step one carries the DM colors and no DM name or id.

## 5. Build plan

### 5.1 Parts and ownership

Part 1 runs first and alone. Parts 2 to 9 then run in parallel, each in its own jj workspace. Part 10 runs last and alone. A part may read anything and edits only its files.

| Part | Content | Owns |
|---|---|---|
| 1. Tokens and kit | Sections 2.1 and 2.3, with `MEMBER_COLOR_NAMES`. The wrappers that keep `Modal` and `SheetDialog` callers working. `usePanelHeader`. The overlay slot under the token decor, with the height layer moved into it and the placed label and plate boxes passed to it (3.4). The Sheet's `reserveTop` and 120 px minimum, `useSheetReturnFocus`, the alerts summary slot, and the global `[hidden]` rule (2.1, 2.3, 3.2.1). `scripts/style-drift.ts`. A dev-only `/dev/kit` page that shows every component in every state, with a switch between three accents (yellow, blue, white). | client/lib/theme.ts, client/globals.css, client/components/** (new and existing), client/features/panels.ts, client/features/layers.ts, client/features/images/Modal.tsx, client/features/tokens/SheetDialog.tsx, client/dev/Kit.tsx, client/lib/router.ts and client/App.tsx (the dev route only), canvas/Stage.tsx (the slot only), scripts/style-drift.ts, e2e/kit.e2e.ts (new) |
| 2. Pages | Section 3.1 except Join, plus 3.6. | client/App.tsx (after part 1), pages/Home.tsx, Claim.tsx, claimRefusal.ts, DmLinkEntry.tsx, Admin.tsx, RoomRoute.tsx, LiveRoom.tsx, QuietLoadNotice.tsx, features/admin/*, features/display/*, features/about/*, panels/AboutPanel.tsx |
| 3. Room chrome | Section 3.2 and 3.2.1, with the dock and the alerts column's fold. | pages/Room.tsx, pages/RoomChrome.tsx, panels/Panels.tsx, canvas/Stage.tsx (after part 1), canvas/TokenActionBar.tsx, canvas/SceneLoading.tsx, features/encounter/InitiativeStrip.tsx, features/encounter/band.ts, features/party/*, features/xcard/*, features/movement/StopNote.tsx, GroundNotice.tsx, features/doors/DoorPill.tsx, DoorButton.tsx, e2e/fold.e2e.ts (new), its FEATURES.md lines |
| 4. Menu and DM panels | Section 3.3: DM, Menu, Room settings, This device, Log, Journal, handouts, Kick and Remove, the DM's Members tools. | panels/MenuPanel.tsx, DmPanel.tsx, SettingsPanel.tsx, LogPanel.tsx, features/dm/*, features/settings/*, features/device/*, features/handouts/*, features/log/*, features/journal/*, e2e/smoke.e2e.ts |
| 5. Tokens and combat | Section 3.3: Token, Characters, Monsters, Encounters, Initiative, the Add token options bar, and roll requests on phones (3.3.1), with the rolls' entry in the alerts summary slot and the card's return-focus rank. | panels/TokenPanel.tsx, TrackerPanel.tsx, features/tokens/* (not SheetDialog.tsx), features/encounter/* (not InitiativeStrip.tsx or band.ts), features/encounters/*, features/monsters/*, features/rolls/*, e2e/rolls.e2e.ts (new) |
| 6. Scenes, library, outliner | Section 3.3: Scenes, Library, Outliner, and the image, map import, export and phase dialogs. | panels/ScenesPanel.tsx, LibraryPanel.tsx, features/scenes/*, features/images/* (not Modal.tsx), features/uvtt/*, features/mapexport/*, features/phases/*, features/vision/* (DOM files only: VisionSettings, PartySightToggle, TokenSight, LightChip, UvttLightChoice), features/movement/SceneSetting.tsx, features/outliner/* |
| 7. Map tools and areas | Section 3.4 except the height pills, and the Areas row of 3.3. | features/measure/*, features/areas/*, features/drawings/*, features/pings/*, features/pins/*, features/fog/*, features/grid/*, features/lights/*, features/select/*, features/builder/* except heights/boardText.ts and heights/HeightLayer.tsx |
| 8. Board text | The height pills of section 3.4. | features/builder/heights/boardText.ts, heights/HeightLayer.tsx, a new heights/boardText.test.ts, scripts/bench-height-pills.ts (new), its FEATURES.md lines |
| 9. Member color | Section 4. | pages/Join.tsx, panels/MembersPanel.tsx, lib/memberColor.ts, lib/accent.ts (its stale comment at :39-46 always, its rule only if question 1 changes), server/http/join.ts, server/http/join.itest.ts, client/lib/api.ts (the join step's answer type), the unit tests beside them, e2e/regress.e2e.ts (one new step), its FEATURES.md lines |
| 10. Sweep and docs | The drift test, the size e2e coverage, the stale doc lines, deleting the local copies the other parts stopped using (`panels/parts.tsx`, the Toggle and Switch in dm/controls.tsx, the Toggle and Segmented in tokens/ui.tsx, SwitchRow, the measure and scenes Segmented, Swatches and ToolButton), so no part deletes a file another part still imports, pointing the icon tab's names at `MEMBER_COLOR_NAMES`, the final screenshots, and any leftover the drift test finds (it runs alone, each fix its own commit, listed in its report). | client/lib/styleDrift.test.ts (new), e2e/size.e2e.ts, panels/parts.tsx and the unused copies above, features/images/IconsTab.tsx (that one import), docs/design.md, docs/design-v1-dm-tools.md, docs/features.md, FEATURES.md (lines parts 3, 8 and 9 did not change) |

`FEATURES.md`: part 3 adds the token bar folding under a sheet and the landscape turn strip, part 8 the height pills that follow the map, part 9 the color picker, part 10 the rest. Each edits only its own section's lines, so the hunks do not meet. Restyles that change no behavior add nothing.

e2e files: part 4 owns `smoke.e2e.ts`, part 9 `regress.e2e.ts`, part 10 `size.e2e.ts`, and parts 1, 3 and 5 their new files. A part whose change breaks a selector in a file it does not own (`display.e2e.ts`, `maps.e2e.ts`, `notes.e2e.ts`, `table.e2e.ts`, `tools.e2e.ts`, `vision.e2e.ts`, or one owned by another part) does not edit it. It lists the file, the line and the new selector in its report, and the owner applies the edit when merging, before the e2e run. Section 5.4 lists the edits known now.

### 5.2 Order

1. Part 1, reviewed on the kit page at both sizes and three accents, then merged. It lands every shared contract the parallel parts meet at: the components, `usePanelHeader`, the overlay slot, `useSheetReturnFocus` and the alerts summary slot. So part 3's dock and part 5's rolls never import each other, and each builds alone.
2. Parts 2 to 9 in parallel.
3. Part 10, after all are merged.
4. A live play round with the whole app, as after each wave.

Section 3.3.1 builds on the post-wave-5 live play fixes (the player's two-chip cap and the "Rolls" button), which are on main.

### 5.3 How each part is checked

- Every part runs `pnpm -s typecheck`, `pnpm -s test` and `pnpm -s build` together, then its e2e files one after another on its own e2e port, which the owner assigns.
- Each part takes after shots of its screens at 1280 x 800 and 390 x 844, in a folder per part, named like the before shots in section 3, so the pairs line up.
- The e2e files on main are `display`, `maps`, `notes`, `regress`, `size`, `smoke`, `table`, `tools` and `vision`, and the build adds `kit` (part 1), `fold` (part 3) and `rolls` (part 5). `display` covers the TV, handouts, the X-card and the password change, and `notes` the pin pane and the journal.

| Part | Unit tests | e2e files that cover its screens |
|---|---|---|
| 1 | New: Button and every control's disabled style (no opacity), pressed sets `aria-pressed`, `busy` keeps the caller's label. The Sheet's cap with and without `reserveTop`, and its 120 px floor. `textDisabled` at least 3:1 and below `textMuted`, and `controlBorder` at least 3:1, on every surface. Every Tag tone's text against its `bg` fill at 4.5:1. The Switch knob's `onAccent` against the accent for the palette and the fuzz set in `accent.test.ts`. Segmented and Swatches markup through `renderToStaticMarkup`: native radios sharing one name inside a named radiogroup, one checked. New `e2e/kit.e2e.ts` serves the kit page with Vite's dev server and checks with real keys: one Tab stop per Segmented and Swatches group, arrows move and choose, Space toggles a Switch, the focus ring shows, in `ink` on a highlight Notice's action, and a body with `hidden` over an inline `display` can be neither seen nor reached by Tab. | size (its nine dialogs, unchanged), smoke |
| 2 | Existing `features/admin` and `display` tests. | smoke (home, join), display (pairing a TV) |
| 3 | New: the fold rule, the alerts summary's order, and `turnPlacement` with the recorded overflow width (portrait, landscape under and over 500 px tall, wide, interface sizes). New `e2e/fold.e2e.ts` for focus, the dock and the sheet reserve (3.2.1) and the top bar checks, the content change at a fixed size included (3.2). Existing `backClose` and `escape` tests. | smoke, table, regress, display (the X-card), fold |
| 4 | Existing `device`, `settings`, `log`, `journal` tests. | display (Add a TV, handouts, the password change), notes (journal), tools (DM tab), smoke (log, members) |
| 5 | New: one `initials()` everywhere (F12), the card's fold rule, which request `open()` picks (a mounted card A with a deferred B gives A, only deferred gives the newest, none gives nothing), that the first keystroke or choice sets `opened`, and the desk's two-card cap. Existing tokens, monsters, encounter, rolls tests. | smoke (characters, monsters, tracker), tools (request a roll), table, rolls (3.3.1) |
| 6 | Existing scenes, images, uvtt tests. | maps, vision, size |
| 7 | Existing measure, areas, fog, grid, builder tests. | notes (pin pane), tools, maps, vision |
| 8 | New: pill font equals `boardSizes(scale).pillPx` at three map scales and two interface sizes, and no drawn pill overlaps a label or plate box in a crowded region at fitted zoom. `scripts/bench-height-pills.ts`, run alone (3.4). | maps (builder) |
| 9 | New: `freeColor` and `colorUsers` with a DM who changed color, two DMs, two members sharing a color, no players. `join.itest.ts`: step one carries the DM colors and no DM name or id. `accent.test.ts` per question 1. | regress gets one step: a player changes color, the DM's Members list shows it, and the player's next ping draws in it. smoke (join) |
| 10 | New `client/lib/styleDrift.test.ts`, which must pass on the merged tree (5.5). | size, extended to every migrated shell (scene sheet, monster filters, stamp picker and sheet, keyboard shortcuts, handout, X-card), with a check that every button in each is at least 44 px, plus the structure of 2.3's Dialog. The X-card's shell has no title row, and the helper names it as the one exception to the header check. Then the whole suite, one file after another. |

Part 10 also fixes the stale lines: `docs/design.md:1716` and `docs/design-v1-dm-tools.md:680` still say token names, chips and badges "keep a fixed size on screen". `docs/design.md:1502` (board text scales with the map) is the current rule and gains the height pills. `docs/features.md:35` gains the color picker.

### 5.4 Role and name changes

Everything not listed keeps its role and accessible name.

| Control | Before | After | e2e edit |
|---|---|---|---|
| Menu subpage back | button "‹ Menu" | button "Back to Menu" in the sheet or panel header | smoke.e2e.ts:510 (part 4) |
| Monsters stat block back | button "‹ Back" | button "Back to Monsters" | smoke.e2e.ts:561 (part 5 reports, part 4's file) |
| Journal page back | button "‹ Journal" | button "Back to Journal" | none |
| Area damage back | button "‹ Areas" | button "Back to Areas" | none |
| Encounter editor back | button "‹ Back" | button "Back to Encounters", which may ask "Discard changes?" | none |
| Panel settings named by their state (Fog, Grid lines, Party vision, Walls and ledges) | button with `aria-pressed`, name changes with state | switch with a fixed name (3.7) | none |
| Tool bar toggles named by their state (Ping sound, Grid lines, Shared, Hidden) | button with `aria-pressed`, name changes with state | the same role with a fixed name (3.7) | none |
| Today's switches (`Toggle`, `SwitchRow`) | switch named by label and help | switch named by label only, help as description | none: the two e2e selectors match a prefix |
| Checkbox rows that apply at once (six in the Token panel and Stats) | checkbox | switch (3.7) | none |
| Settings and options that a button reads ("Players see the DC", "Players see pass or fail", "Re-roll monsters that have a value", the movers and drawers lists, the export's grid) | switch or pressed button | checkbox (3.7) | none |
| Segmented and Swatches options | button with a radio role, every option a Tab stop | native radio, one Tab stop per group, same names and groups | none: `getByRole("radio")` and `getByRole("radiogroup")` still match (smoke.e2e.ts:206, table.e2e.ts:147, tools.e2e.ts:360-374), since the input lies on top of its option and takes the click or tap |
| Swatch names | the hex code | the color's name | none |
| Request a roll's "What to roll" | buttons with `aria-pressed` ("Saving throw", "Ability check", `RequestSheet.tsx:130-138,287-293`) | native radios in a radiogroup "What to roll" | tools.e2e.ts:359 `getByRole("button", { name: "Saving throw" })` becomes `getByRole("radio", { name: "Saving throw" })` (part 5 reports, the owner applies) |
| The player's roll summary while a request awaits an answer | button "Rolls d/a: …" | button "Roll asked: …". While the card is folded under a sheet it is the "sheet" kind, with no `aria-expanded`, in landscape too, and in portrait it is the dock's alerts summary | none: tools.e2e.ts:371-378 meets the card with no sheet open, so it does not fold there |
| The DM's phone stack past two requests | every card shown | the newest two, then a "Rolls d/a" button with `aria-expanded` | none |
| The fight alerts column under a portrait sheet | every alert shown over the sheet | one alerts summary in the dock, named from its visible text (3.2.1) | none: no e2e reads the column while a sheet is open |
| Busy buttons | the caller's busy label, some dimmed | the same label with a spinner before it | none: notes.e2e.ts:132,155 still find "Saving…" |
| Token bar, folded | dialog "Thorn actions" | the dialog takes `hidden` with its body mounted, and the dock in Room shows a group "Thorn actions" holding "Show Thorn actions" and "Close", then the alerts summary as a sibling | none: no test opens a sheet over a bar. Part 3 checks the `/^Close/` helpers that take `.first()` (tools.e2e.ts:120-123, table.e2e.ts:177,212) still reach the sheet's close |

### 5.5 The drift test

`client/lib/styleDrift.test.ts` scans `client/**` (not tests or `client/dev`) and fails on:

- a hex or `rgb()` literal outside the allowlist,
- a raw `fontSize` number, a raw `borderRadius` number, or a `boxShadow` that is not a `theme.shadow` value,
- a `zIndex` above 2 outside `theme.z` and `features/display/`, since stacking inside one component (1 or 2) stays local,
- an `opacity` whose value depends on `disabled`, `busy`, `saving` or `sending` (Principle 4).

The allowlist is by file and named constant, so the exceptions stay visible and small:

| Kind | Where |
|---|---|
| Tokens and the accent math | lib/theme.ts, lib/accent.ts |
| Stored data defaults, whose values are part of saved rooms | features/scenes/create.ts (`DEFAULT_GRID`, `MAT_BACKGROUND`, `BUILDER_BACKGROUND`, and `MAP_BACKGROUND`, which scenes made from a map image and imported Universal VTT scenes store), features/tokens/EffectsSection.tsx and lib/tokenView.ts (the effect and status palettes) |
| Art drawn on the board or into an export | client/canvas/** except TokenActionBar.tsx and SceneLoading.tsx (which are chrome), every `features/**/*Layer.tsx`, features/builder/draw.ts, textures.ts, stamps/rules.ts, stamps/draw.ts, stamps/StampHandles.tsx, heights/relief.ts, heights/boardText.ts, features/vision/SightOverlay.tsx (it formats stored light colors as `rgba()` at run time), features/mapexport/render.ts |
| Icon palettes | features/images/icons.ts, features/images/IconsTab.tsx (the neutrals) |
| The table display's TV sizes and stacking | features/display/* |

The UI literals the scan found outside these become tokens: `#1a1206` in PlayerPreview.tsx and InitiativeStrip.tsx becomes `ink`, claimRefusal.ts's fallback `#888888` becomes `textMuted`, and the 0.3 dim behind the scene loading toast (`canvas/SceneLoading.tsx:48`, part 3) becomes `scrimLight`, since it too only needs the map to stay in view.

## 6. What stays, and the risks

### 6.1 What stays as it is

- The dark theme and every color value of surfaces, text, status, dispositions, fog and the member palette. They read well, and the board was tuned against them.
- `lib/accent.ts`: how the member color becomes the accent, `accentSoft` for the turn, `turnTint`. They already meet 4.5:1 for any color.
- The layout model: bottom sheets on phones in portrait, a right sheet in landscape, the side panel from 900 px, a labeled toolbar on phones and an icon toolbar with titles and shortcuts on computers, Undo and Redo in the top bar only where there is no keyboard.
- 44 px targets, 16 px inputs, the interface size's CSS zoom, reduced motion.
- The destructive look: red text at rest, the red outline only once armed.
- The board: token rings by disposition, board text that follows the map, the ruler's screen-size readings (they must read at any zoom), the builder's art colors.
- The table display's black stage and TV type sizes.
- Native selects, color inputs and file pickers. They are the best on a phone, and `color-scheme` makes them dark.
- The radio cards of Room settings and the plain-sentence tone of every message. Both are consistent already.
- The member palette's ten colors, and duplicates allowed on join.

### 6.2 Risks

- **Contrast.** `textDisabled` is 3.4:1 on a raised surface. That is deliberate (disabled controls are exempt from 1.4.3), and the label stays legible. Error text moves from `danger` (4.2:1 on a surface) to `dangerText` (5.9:1), and so do danger tags and danger section labels. Fields and the Switch's off track take `controlBorder` (3.1:1 to 3.9:1), while cards keep the quieter `border`, which identifies no control.
- **Touch targets.** Chips, Segmented options and swatches keep 44 px, and a radio input covers its whole option. Tags are read-only and need none. Part 10's size e2e checks the 44 px in every dialog.
- **Canvas performance.** The height pills add no work to the label pass, since they are not published (3.4). A pinch redraws up to 300 pills, as today, now with a read-only check against the placed labels, and part 8 times that frame on a phone-class budget.
- **The table display.** It is excluded from the accent and keeps its sizes, so nothing on the TV changes except banner colors.
- **Short phones.** New inputs keep 16 px and the `data-rvtt-small-ui` rule. Under a portrait sheet the token bar and the fight alerts column fold into one 48 px dock on the sheet's top edge, and the sheet keeps at least 120 px. Where safe areas leave no room for both, the dock's buttons move into the sheet's header (3.2.1). In a landscape fight the turn strip leaves the top bar whenever it would push a button off the screen (3.2).
- **e2e churn.** Section 5.4 lists every role and name that changes and the two e2e lines that follow. Part 1 lands the wrappers before any caller moves, and part 10 deletes the old local copies only after every part has merged, so a half-merged state still builds.
- **Stored colors.** Nothing about member colors changes on the server or in stored ops (4.3). An odd color a hand-made op stored still replays, the accent falls back to yellow for it, and the picker shows it as "Current color".
- **Old rooms.** The `#f38400` legacy rule in `lib/accent.ts` stays, as the project owner confirmed for question 1 on 2026-10-15.

### 6.3 Questions for the project owner

The project owner confirmed all four defaults on 2026-10-15: "Confirmed on defaults".

1. A member who picks the crest orange `#f38400`: do their buttons turn orange (their choice), or stay yellow (orange never in the interface)? Today's code makes them yellow for anyone with that exact color. Recommended default, which the project owner confirmed: yellow, with the picker's preview saying "Buttons stay yellow". Their pings and drawings stay orange either way, and the orange stays on offer.
2. On a phone in portrait, should the token action bar fold into a row on the sheet's edge while a sheet is open, with the fight alerts beside it as one summary (F9, section 3.2.1)? Recommended default, which the project owner confirmed: yes. Every action stays reachable in two taps (Show, then the action), and the Escape and Back order is unchanged.
3. Should the color picker also offer any color through the browser's color input, as the effects picker does? Recommended default, which the project owner confirmed: no. The ten swatches keep members distinct on the map, as on the join page.
4. From the post-wave-5 review (3.3.1): should the player's roll card fold into the "Rolls" button whenever it would cover an open sheet, and should the DM's phone show only the newest two open requests, with the same "Rolls d/a" button as the player's for the rest? Recommended default, which the project owner confirmed: yes to both.
