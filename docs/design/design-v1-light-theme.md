# raccoon-vtt: the light theme

Status: built (2026-11-02). Decisions D-261102-360 to D-261102-369 (section 12). The "As built" section at the end says where the build went its own way. The counts in section 2 are the design's, taken before the build.

Asked for in docs/design/mvp.md section 17 ("Look, feel and accessibility"): "Dark theme by default. In a room, buttons and other accented controls take your own member color, made lighter or darker when needed so they stay readable and never look like the turn highlight or a disabled button. ... Optional light theme." The project owner's order for the Later list (D-261102-007) puts it after weather and before the dungeon generator, with a preview first.

## 1. Summary

- **Each device picks.** Menu, This device, Theme: Dark (the default, as before), Light, or Auto, which follows the device's own light or dark setting and changes with it. Kept in local storage beside the interface size, and every open page of the app on the device follows a change. Nothing reaches the server or the room.
- **Every page and panel follows it:** Home, Join, the DM guide and Docs, the top bar, the toolbar and tool options, side panels and sheets, the token window and the map's panes, toasts and notices, dialogs, stat blocks, the Dice panel, the tracker and the strip.
- **The board stays dark on purpose:** the map, the fog, the canvas and everything drawn on it, the ground around the map, the height pill, the dice tray, the table display, and every screen on the black `stage` ground (the pause screen, the scene gate, the preview's waiting and error screens).
- **Light chrome that floats on the dark board stays readable there, over any map art:** a chosen control's tint lies over the same light ground as its neighbors, and a focus ring that falls on the board is two-tone, the member's accent resolved for dark inside a dark halo. The halo mends dark's own weak ring over bright art too.
- **One mechanism.** 22 color tokens, a new `markRing` and 5 shadows become CSS custom properties with the dark value as fallback. The DOM's uses of them keep working with no edit. The canvas uses move to a fixed dark palette, since a canvas cannot read a variable.
- **Member colors keep the existing rule.** The accent is made lighter or darker until it reads, now against the scheme's own surfaces: on light ground the crest yellow becomes a dark olive gold. Names shown in a member's color take the same rule, and member dots gain a thin ring.
- **Contrast:** text at 4.5:1 and control outlines and focus rings at 3:1 on their own composited ground, checked by unit tests over both palettes and by an e2e sweep that must reach the top bar, toolbar, tool options, token window and toast.
- **Versions:** none. No op, no stored state, no snapshot change.

## 2. Before

- `client/lib/theme.ts` held every color as a hex string in `theme.color` (32 tokens), plus shadows. Only the accent family (`accent`, `onAccent`, `accentTint`, selection) was already a CSS variable, set by `useAccentVars` (pages/RoomChrome.tsx) from `lib/accent.ts`.
- Counted when designed, tests left out: `theme.color.*` was read 1,318 times in 228 files. 129 reads drew on a canvas, in the 20 Konva files that draw with it and three canvas helpers (features/builder/draw.ts, features/builder/heights/boardText.ts, features/traps/Crossing.tsx). The other 1,189 reads in 205 files were DOM styles. `theme.shadow.*` was read 38 times in 27 files.
- **A token flowed to the canvas as data:** a trap's area draft took `theme.color.danger` (features/traps/TrapPane.tsx), which features/areas/AreaPreviewLayer.tsx draws on Konva.
- Literal colors outside theme.ts: almost all board art or data that look the same in either theme. The ones a light theme must reach: client/globals.css, the `theme-color` meta in client/index.html, and the manifest's two colors.
- **Chrome on the board.** On a computer the toolbar has no band. Its buttons float with an `overlay` ground, but the chosen tool's ground was only the 14% `accentTint`, so it sat on the board itself. The map's focus target draws its accent ring inside the map's edge, on the board.
- **Scheme text on the black `stage`:** the pause screen, the scene gate and the preview's loading and error content put muted text on black.
- **Full-screen phone dialogs** (components/Dialog.tsx) pad `theme.safe.top` on their `surface` ground in the top layer.
- **One text use of `danger`:** the party bar's "dying" word.
- `features/device/settings.ts` kept its `setting()` store private and had no `storage` listener, so a change reached only its own window.
- **A bug found on the way:** the Height tool's area outline was stroked with `theme.color.accent`, a `var(...)` string that a canvas ignores, so it drew in the last color set.

## 3. How other apps do it (ideas only)

- **Owlbear Rodeo** has light and dark interfaces over a map that never changes. **Foundry VTT** core is dark with a client setting for the interface. **D&D Beyond** offers light and dark per device.
- Taken: a per-device choice, Auto as an option, and the map left alone. Left out: following the system by default (D-261102-360) and per-room themes. No SRD 5.2.1 text applies.

## 4. What the DM and players see and do

### 4.1 The choice

Menu, This device, a **Theme** section after Interface size:

- Help: "Auto follows this device's own light or dark setting. The map, the fog, the dice tray and the table display stay dark in both."
- A Segmented row, label "Theme", options **Dark**, **Light**, **Auto**, Dark chosen at first. A tap changes the page at once, with no reload and no animation, and every other open tab or window of the app follows through the `storage` event (the guide opens in a new tab).
- The Menu's This device row detail becomes "Interface size, theme, full screen, low power, map detail, sounds, shortcuts and sheet handle." (without "full screen" where it is missing).
- The same layout on a phone upright, sideways, a tablet and a computer. The three options fit one row at 320 x 568 at 130%.
- No key and no gesture. The shortcut sheet is unchanged.
- Outside a room there is no This device page. Home, Join, the guide and Docs read the stored choice. Rejected: a switch on Home (one more control on the first page, for a choice made once).

### 4.2 Surface by surface

| Surface | Light theme | Stays dark |
|---|---|---|
| Home, Join, Claim, Admin | Light page, cards, fields. Primary buttons in the light crest accent (dark olive gold) | The logo, which already has a rim for white pages |
| DM guide, Docs | Light page. Its screenshots stay pictures of the dark app | |
| Top bar, toolbar, tool options row, alerts column, banners | Light `overlay` grounds. On a computer the chosen tool's tint lies over the same ground as the other tools | Focus rings that fall on the board (6.4) |
| Side panels, sheets, the Menu, This device, Room settings | Light | |
| Token window, label, pin, light and door panes, stop note | Light, with a lighter shadow | |
| Toasts, notices | Light raised fill. Danger and warning notices take pale red and pale amber under dark text | |
| Dialogs | Light dialog over a softer scrim | A full-screen phone dialog's status bar strip in an iPhone home-screen app (6.4) |
| Tracker, Initiative strip, party bar | Light rows. The turn's row and strip take a pale yellow tint, an amber name and ring | |
| Stat blocks, character and monster pages | Light | |
| Dice panel, recent rolls, roll requests | Light. Roller names in their member color, made readable | The whole tray while dice fall, its rings and "+N" disc included |
| The map area | | The canvas and everything on it, the ground around the map, the height pill |
| Black `stage` screens | | The pause screen and its X-card, the scene gate, the preview's waiting and error screens, the table display |

### 4.3 Words

Theme, Dark, Light, Auto, and the help in 4.1. FEATURES.md gains a Theme bullet under This device, and its Look and accessibility section says "A dark theme by default, and a light one in This device." The DM guide's This device paragraph names Theme.

## 5. The model: none

Nothing joins `shared/model.ts` or `shared/protocol.ts`. No op, no permission, no stored field. Export and import of rooms are untouched. The only new stored value is `rvtt.theme` in local storage (`"dark"`, `"light"` or `"auto"`, anything else reads as dark), read and written in try and catch as every `rvtt.*` key is. **Privacy:** nothing is sent, and a player's device learns nothing new.

## 6. Colors

### 6.1 Which tokens change

22 of the color tokens, the new `markRing` and 5 shadows differ by scheme. Fixed in both: `ink`, `crest`, `fog`, `textHalo`, `scrimLight`, `stage`, `white`, and a new `highlightFill`.

| Token | Light | on surface | on raised | worst light ground | Dark | worst dark ground |
|---|---|---|---|---|---|---|
| bg, surface, surfaceRaised | #f3f1ec, #fcfbf8, #e9e7e1 | | | | #16161a, #1f1f25, #2a2a32 | |
| border (decoration only) | #d3d0c8 | | | | #3a3a44 | |
| text | #1b1a1f | 16.7 | 14.0 | 13.5 | #f1efe9 | 12.4 |
| textMuted | #55535c | 7.3 | 6.1 | 5.9 | #a7a5ad | 5.8 |
| textDisabled | #7b7882 | 4.2 | 3.5 | 3.4 | #7c7a84 | 3.4 |
| controlBorder | #7a7781 | 4.2 | 3.6 | 3.4 | #76747f | 3.1 |
| accentSoft (turn text and ring) | #8a4f00 | 6.3 | 5.3 | 5.1 | #ffe8a3 | 11.7 |
| danger (outlines, stripes, fills, never text) | #d1343a | 4.8 | 4.0 | 3.9 | #e5484d | 3.6 |
| dangerText | #b4232a | 6.3 | 5.3 | 5.1 | #f87171 | 5.1 |
| success | #157246 | 5.8 | 4.8 | 4.7 | #30a46c | 4.5 |
| warning | #945400 | 5.8 | 4.8 | 4.7 | #f5a524 | 7.0 |
| ally | #1d61c0 | 5.8 | 4.8 | 4.7 | #3e8ef7 | 4.3 |
| neutral, hostile (rings only) | #6d6c73, #c8333a | 5.0, 5.1 | 4.2, 4.3 | 4.1, 4.1 | #c9c9c9, #e5484d | 8.6, 3.6 |
| turnTint | rgba(247, 223, 0, 0.2) | | | | rgba(247, 223, 0, 0.08) | |
| dangerTint | rgba(209, 52, 58, 0.1) | | | | rgba(229, 72, 77, 0.12) | |
| dangerFill, warningFill | #fbe4e3, #fbecd2 (text 14.3, 14.9) | | | | #3b1214, #3a2a07 | |
| overlay | rgba(252, 251, 248, 0.92) | | | | rgba(22, 22, 26, 0.88) | |
| scrim | rgba(20, 18, 24, 0.45) | | | | rgba(0, 0, 0, 0.6) | |
| markRing (new) | #7a7781 | | | | #3a3a44 | |

"Worst light ground" includes the turn tint over a surface (#fbf5c6) and over a raised surface (#ece5b4). Ratios are WCAG 2.x. Shadows keep their shapes with a warm black at 0.16 to 0.24.

- **`danger` is never text.** The party bar's "dying" word moves to `dangerText` (5.3:1 light, 5.1:1 dark), which also mends dark's 3.6:1.
- **`accentSoft`** keeps its job as the turn's text, ring and outline. Its fills under ink (the highlight Notice and the "Your turn" fills of the Initiative strip) move to the fixed **`highlightFill`** (#ffe8a3, ink 15.3:1). Rejected: one token (ink on amber 2.8:1, cream on white 1.2:1).
- **`markRing`**: the 1 px ring every member-color mark wears (6.3). Dark keeps the old `border`, light takes `controlBorder`'s value, so a white or yellow dot (1.2:1 and 1.3:1 on white) still shows its edge.

### 6.2 The mechanism (`client/lib/theme.ts`, `client/lib/scheme.ts`)

- theme.ts has `type Scheme = "dark" | "light"`, `PALETTES` and `SHADOWS` typed per scheme, so a key missing from one fails typecheck, and `boardTheme.color`, the dark palette and the fixed tokens as plain hex, for canvases.
- `theme.color.bg` and the others are `"var(--rvtt-bg, #16161a)"`: the dark value as fallback, so a unit test's render, the boot page and any page before the module runs still draw dark. The five shadows the same. The accent family nests a base: `var(--rvtt-accent, var(--rvtt-base-accent, #f7df00))`, so a room's member accent wins and leaving the room falls back to the scheme's crest accent.
- `paletteVars(scheme)` returns a scheme's custom properties. `BOARD_SCOPE` spread on a DOM element makes it and everything under it read the dark palette and the dark accent, so a button inside a dark scope, such as the paused X-card's Send and Cancel or the preview error's Try again, fills and rings in the dark accent, not the light one. A Notice inside a scope still sets its own `--rvtt-focus` on itself.
- `theme.safe.top` is `var(--rvtt-safe-top, env(safe-area-inset-top, 0px))`. Nothing in the app sets the variable. It lets e2e stand in a notch, which Chromium cannot emulate (13).
- settings.ts exports its `setting()` store. scheme.ts keeps `rvtt.theme` in one, resolves Auto through `matchMedia("(prefers-color-scheme: light)")` and its change event, and on every change writes the scheme's properties and base accent on `document.documentElement.style`, sets `color-scheme` there (native controls and scrollbars follow), sets `data-rvtt-scheme`, and sets the `theme-color` meta to the scheme's `bg`. `startScheme()` runs in client/main.tsx before the first render.
- **Every open page follows.** scheme.ts listens to the window's `storage` event for `rvtt.theme` and takes the new value as the device's own. `holdScheme("dark")` takes dark for one page and gives back the device's latest choice on release, a change that arrived while held included.
- `useScheme()` and `scheme()` for the few places that compute a color (6.3).
- globals.css: the page ground and text, the boot text, the off placeholder and the focus rules read the variables. `:root { color-scheme: dark }` stays as the boot default.
- SVG presentation attributes that read a variable move into `style` (components/AcBadge.tsx, features/builder/heights/ReadoutHost.tsx).

Rejected: a theme context with re-rendered objects (every one of 228 files would need a hook), two built stylesheets, a palette only in CSS (the tests and the accent rule need the values in TypeScript).

### 6.3 Member colors on light ground

- **The accent** (`accentFor(color, scheme)`) keeps its rule word for word: the member's color unless it fails, then the nearest OKLCH lightness at its own hue with as much chroma as fits. The checks read the scheme's palette: 4.5:1 against a pressed control's tint over `surfaceRaised`, and 20 apart (CIE76) from that scheme's `accentSoft` and `textMuted`. On light ground the search tries darker first. `scheme` defaults to "dark", and every canvas caller passes "dark" by name. If no lightness fits, light falls back to its `text` color, never the dark crest yellow, and dark keeps its fallback to the crest, so dark is unchanged.

| Member color | Dark accent | Light accent (on surface) |
|---|---|---|
| Yellow #f7df00 (and the crest outside a room) | #f7df00 | #675c00 (6.5) |
| Green #30a46c | #49b97f | #00683f (6.7) |
| Blue #3e8ef7 | #64a6ff | #0057b4 (6.7) |
| Purple #8e4ec6 | #c68bff | #7b39b0 (6.6) |
| Pink #e93d82 | #ff79a5 | #ad0058 (7.0) |
| Teal #12a594 | #35b8a6 | #00665b (6.7) |
| Brown #ad7f58 | #cc9c74 | #7d522c (6.5) |
| White #e5e5e5 | #e5e5e5 | #292929 (14.1) |
| Coral #ff6b4a | #ff7e61 | #aa2500 (6.8) |
| Orange #f38400 | the crest's #f7df00 | the crest's #675c00 |

Every light accent takes white text on its fill.
- **Two accents.** `useAccentVars` sets the scheme's accent variables, and also `--rvtt-board-accent` and its family, the member's accent resolved for dark, for dark scopes and rings on the board (6.4).
- **Names in a member's color** (the Log, Recent rolls) read `memberInk(color, scheme)`: the same search with the 4.5:1 check and 20 apart from the scheme's `accentSoft`, the turn's text and the whisper label beside the names, and no orange-to-yellow swap. It applies in dark too, where a navy name read 1.2:1.
- **Marks** in a member's color (the top bar's chip dot, Members rows, a group's dot labels, Swatches' disk and badge) keep the raw color and draw a 1 px inset `markRing`, a box-shadow, so no box grows.
- **The color picker** follows the scheme as it changes: the Members picker's "Buttons" sample reads `accentFor(color, useScheme())`, so an orange member reads "Buttons stay yellow." on dark and "Buttons use the crest's darker shade so they stay readable." on light.

### 6.4 What stays dark, and how

- **Canvases** read `boardTheme.color`, named in client/canvas/boardColors.test.ts. A trap's area drafts take `boardTheme.color.danger`. The Height tool's area outline takes the resolved accent.
- **The ground around the map** takes `boardTheme.color.bg`.
- **Chrome that floats on the board** (D-261102-362). Two rules, by what is drawn:
  - *A fill gets a scheme ground.* The chosen tool lays its `accentTint` over the same `overlay` its unchosen neighbors wear. On light the accent then reads 4.6:1 on that ground over the bare board, and more over brighter map art. Rejected for fills: the board accent (a dark-looking chosen tool among light ones).
  - *A ring that falls on the board is two-tone.* A ring has no ground of its own, and a zoomed or panned map can put any art under it: the dark crest accent reads 13.3:1 on #16161a but 1.35:1 on white art. The map's focus target and every floating tool button spread `ON_BOARD`: `data-rvtt-on-board` and `--rvtt-focus` set to the board accent. One globals.css rule gives such an element a dark halo while it shows focus, a box-shadow of `theme.ringHalo` (rgba(13, 13, 18, 0.9), fixed) 6 px out, under the 2 px accent outline at 2 px out, so the accent sits on the halo and the halo stands on the art (at least 13:1 on white). The map's focus target, whose ring lies inside the map's edge, takes the inset form. This is the same ring in dark, which had the same weakness over bright art, so both schemes gain it. Rejected: the accent ring alone (fails over bright art in both schemes), a backing under each ring.
- **The height pill** and **the dice tray**: `BOARD_SCOPE` on the tray's root, so the scrim, the rings and the "+N" disc are all dark, and on the pill's root.
- **Black `stage` screens:** `BOARD_SCOPE` on the pause screen's root, so its X-card button is dark too, on the scene gate and on the preview's wait. The loaded preview's room follows the scheme. The preview's 4 px frame stays `accentSoft`.
- **The table display:** a dark hold for its page, released on unmount. As built it stands outside the pages' lazy chunk, and from boot on a fresh load (As built).
- **The iPhone home-screen app.** index.html asks for `black-translucent`, so iOS draws white status text over the page, read only at launch. Where `navigator.standalone` is true and the scheme is light, root sets `--rvtt-status-band` to black (else transparent), and:
  - App.tsx draws a fixed strip `theme.safe.top` tall at `theme.z.statusBand` (30), above every bar, sheet and popover fallback outside the top layer.
  - Every top-layer surface whose ground reaches the screen's top draws the strip itself, as an inset box-shadow `statusBand(scale)` whose height is the safe area in the element's own zoomed px: every dialog backdrop and the full-screen phone card. A native popover keeps its margin inside a bound below the bars.
  - Android and Safari tabs follow the live `theme-color` meta. The manifest's colors stay dark (the splash screen).

## 7. Files

No server or shared file changes. Client: client/lib/theme.ts, accent.ts, scheme.ts (new), features/device/settings.ts, every canvas color source, lib/tokenView.ts, ThisDevice.tsx, MenuPanel.tsx, main.tsx, App.tsx, globals.css, state/accent.ts, pages/RoomChrome.tsx, components/tones.ts, Dialog.tsx, InitiativeStrip.tsx, dev/Kit.tsx, pages/Room.tsx, ReadoutHost.tsx, Tray.tsx, DisplayPages.tsx, PreviewWait.tsx, LogPanel.tsx, RecentRolls.tsx, Swatches.tsx, MembersPanel.tsx, lib/memberColor.ts, AcBadge.tsx, PartyBar.tsx, with unit tests beside them. e2e: e2e/lighttheme.e2e.ts (new), e2e/helpers/contrast.ts (new), e2e/alignmentRoom.ts (grab-e) and e2e/kit.e2e.ts.

## 8. Performance

- A switch writes about 30 custom properties on the root: one style recalculation and one paint of the DOM. The board is not touched, so no Konva layer redraws and no map texture reloads. Measured on a 1440 x 900 room with This device open, under Chrome's 4x CPU slowdown, click to the next frame over 10 switches: median 33 ms, max 46 ms.
- Nothing runs per frame. One `matchMedia` listener while Auto is chosen and one `storage` listener. One local storage key.

## 9. Accessibility

- **Contrast:** section 6.1. Text at 4.5:1 on every light ground, control outlines, the off label and focus rings at 3:1 against their own composited ground (WCAG 1.4.3, 1.4.11, 2.4.7), the board included where chrome floats on it (6.4).
- **Native controls** follow through `color-scheme`. **Reduced motion:** a switch has no transition. **Forced colors** replace the palette.
- **Screen readers:** the Segmented row is a radio group named "Theme", one Tab stop, arrows move and choose. The help is its description.
- **Large interface sizes:** the alignment sweep measures the row at 320 x 568 at 130%. The status band takes each surface's own zoom, so it covers the status bar at every interface size.

## 10. The preview

A throwaway prototype carried the palette, the variables, the board palette, Auto, the This device row, a dark scrim in the tray, the display hold and readable names, and was shown to the project owner before the build, dark beside light, on a computer and a phone. Two things differ in the build from those pictures: the chosen tool on a computer shows a light tinted square instead of an olive one on the board, and member dots gain a thin ring.

## 11. Order of the build

The contract came first and alone: the palettes, the variables with their dark fallbacks, the scheme store and every canvas color source moved to `boardTheme`, with the dark look unchanged but for the Height tool's outline (a fix). The Theme row and the page, the chrome on the board and the dark screens, and the member colors followed side by side on it, then the sweeps and these docs.

## 12. Decisions

- **D-261102-360 (who picks, the default, every page):** each device, in This device, Dark by default, with Light and Auto, and every open page of the app follows a change through the `storage` event. mvp.md says "Dark theme by default", and theme.ts gives the reason: a map on a phone at a dim table. Rejected: Auto by default (a phone set to light would flip its player on the deploy), a per-member or per-room setting, a switch on Home or in the top bar, a change that waits for a reload in other tabs.
- **D-261102-361 (mechanism and order):** CSS custom properties with dark fallbacks, set on the root from typed palettes in theme.ts. The contract also moves every canvas color source to `boardTheme`, so no step draws a broken dark board. Rejected: a theme context, two stylesheets, palettes only in CSS, the canvas switch in a later step.
- **D-261102-362 (the board and chrome on it):** the canvas and everything drawn at a map point keep the dark look. Panes, bars, menus and toasts follow the theme. A fill that floats on the board gets a scheme ground under its tint, and a ring that falls on the board is two-tone: the member's accent resolved for dark inside a fixed dark halo, in both schemes. Rejected: a light board chrome, a dark toolbar in the light theme, the board accent for the chosen tool's fill, the accent ring alone (1.35:1 over white art), a backing under every ring.
- **D-261102-363 (the dice tray):** the whole tray is dark in both, so every dice set keeps its edges and the dice look is unchanged. Rejected: a light band (Ivory on near-white).
- **D-261102-364 (dark screens):** every screen on the black `stage` ground takes the whole dark palette and the dark accent, focus rings included (the pause screen and its X-card, the scene gate, the preview's waiting and error screens), and the table display holds dark for its page while still recording the device's latest choice. Rejected: scheme text on black (light `textMuted` reads 2.8:1), the TV following its own setting.
- **D-261102-365 (member colors):** the existing lighter-or-darker rule, checked against the scheme's surfaces, darker first on light, light falling back to its text color and dark keeping its crest fallback. The crest yellow becomes #675c00 there. Names use `memberInk`, marks keep the raw color with a ring. Rejected: yellow fills in light (1.3:1 fails 1.4.11), a hue shift toward gold, one fixed accent for everyone.
- **D-261102-366 (the turn highlight):** `accentSoft` becomes amber text on light, the fixed `highlightFill` keeps the cream band under ink, and `turnTint` grows to 0.2. Rejected: one token, a blue or green turn color.
- **D-261102-367 (palette):** warm off-white with the values in 6.1, statuses and DOM dispositions darkened for light, the board's untouched, and `danger` never used as text. Rejected: pure white grounds, the dark statuses on light (warning 2.0:1 on white).
- **D-261102-368 (iPhone home-screen app):** a black status band in light, drawn by App.tsx at z 30 over pages and by each top-layer surface that reaches the top as an inset shadow `theme.safe.top` tall in the element's own zoomed px. Rejected: switching the status bar meta (read only at launch), the default status bar style (a white band over the dark theme), one band element (it cannot rise over the top layer).
- **D-261102-369 (verification):** unit tests over both palettes, a guard that no Konva importer reads `theme.color` but named DOM sites, a check of the trap drafts' colors, a runtime net on the canvas color setters, a contrast sweep with named exclusions and required coverage, rings and floating chrome measured over the board and over white map art, and one light pass of the This device alignment step and the kit. Rejected: the whole alignment sweep again in light (colors move no box), screenshot diffs against stored images.

## 13. Tests

- **Unit (lib/theme.test.ts, accent.test.ts, components/controls.test.ts, lib/scheme.test.ts):** every check that read a hex reads `PALETTES[scheme]` for both schemes: textDisabled dimmer than textMuted and 3:1, controlBorder 3:1 on every ground in 6.1, every Tag and Notice tone at 4.5:1, highlightFill under ink, the accent for every member color and 2,000 random colors per scheme (fast-check: 4.5:1 on the tint, 20 apart from accentSoft and textMuted, the same hue within rounding, and light never #f7df00). `memberInk` keeps orange orange. `paletteVars` covers every key. The setting reads unknown values as dark, Auto follows a stubbed `matchMedia` and its change, a `storage` event applies the new value, a `storage` event while held is what release gives back.
- **Unit, the board (client/canvas/boardColors.test.ts):** no file that imports react-konva or konva reads `theme.color` or the scheme's disposition rings, except named DOM sites in mixed files. The three canvas helpers that import no Konva read no `theme.color`. A trap's two area drafts, from a preset and from a template, hold plain hex.
- **e2e, e2e/lighttheme.e2e.ts** (a room of its own, light unless a step says):
  - lt-0, the runtime net: an init script wraps the `fillStyle`, `strokeStyle` and `shadowColor` setters of the canvas context and records any value holding `var(`. Every step ends with that list empty. The steps reach Top-down and Isometric, a ruler, an area, a trap's Aim, the Height brush's area, a ping, the fog brush, the builder and the dice tray.
  - lt-1: the Theme row, Dark at first. Light switches the open room at once, survives a reload, and Auto follows `emulateMedia` both ways. A second page in the same browser, the guide, follows a change made in the room.
  - lt-2, the board check: with every piece of chrome hidden, the canvas pixels in dark and light are identical (the check first proves it hid something), and the map ground is #16161a in both.
  - lt-3, the contrast sweep (e2e/helpers/contrast.ts), at 1440 x 900 and 390 x 844, on Home, Join, the guide, Docs, and in the room the top bar, toolbar, the chosen tool, tool options, token window, a toast, tracker, token panel, stat block, Log, Dice, Members, This device, Room settings, a dialog, a danger notice, and a party bar with a dying member. Text at 4.5:1 (3:1 at 24 px or 18.66 px bold), control outlines at 3:1, each against the ground the browser paints under it. Where that ground reaches the map, the element is measured twice, over #16161a and over white. Each focusable element on the map's column is focused by keys and its ring measured at 3:1 against the ground behind its line: the halo where it has one. A step loads a white map and reads the pixels: the halo's dark is there around a focused tool and inside the map's ring. Named exclusions only. The sweep fails unless it measured something in each of the top bar, toolbar, tool options, token window and toast, the chosen tool and the map's focus ring. In dark it reports its findings as a follow-up list.
  - lt-4, the dark screens: the pause screen with its X-card, the scene gate, the preview's waiting and failed screens, and the tray mid-throw draw no color of the light palette in a light browser, and their words read. Keyboard focus on the X-card's Send and Cancel and on the preview error's Try again draws a ring in the dark accent at 3:1 or more.
  - lt-5, the display: same-window navigation from the display back to a room gives the device's light back, and a change made in another tab while the display held dark is the one the room shows.
  - lt-6, the status band: `navigator.standalone` stubbed true, `--rvtt-safe-top: 47px` on the root, light, at 390 x 844 at 100% and 130%: the top 47 px are black, and the row under them is not, on Home, in the room, under a full-screen dialog, under the handout viewer while only its backdrop covers the top, under a bottom-sheet dialog, a sheet at its usual height and swiped to the whole screen, a popover and View as a player, and absent in dark.
  - lt-7: the Height tool's area outline draws in the accent.
- **Alignment:** the This device step of the alignment sweep also measures the Theme section at its six sizes, keeps its row detail check, checks the three options share one row, and runs once more in light. The kit's e2e runs its focus ring and Notice checks in light through the kit's own Theme switch, with `accentFor(hex, "light")` for each expected ring.

| Case | Expected | Test |
|---|---|---|
| A new device | Dark, as before | lt-1, scheme.test |
| Light chosen in a room | Every panel, bar and dialog light at once, the board unchanged | lt-1, lt-2 |
| Light chosen with the guide open in another tab | The guide turns light | lt-1, scheme.test |
| Auto and the system turns light | The app turns light without a reload | lt-1 |
| Storage blocked | The choice lasts until the page closes | scheme.test |
| Yellow DM on light, chosen tool on a computer | A light tinted square, its icon at 4.6:1 | lt-3 |
| Keyboard focus on the map, light or dark, white map art at the edge | The accent ring on its dark halo | lt-3 |
| Keyboard focus on the paused X-card's Send, light | A ring in the dark accent | lt-4 |
| A pause during a light game | Dark pause screen and X-card | lt-4 |
| A natural 1 in a light Dice panel | The dark danger ring on a dark tray | lt-4 |
| A dying party member, light | The word at 5.3:1 | lt-3 |
| White member's dot on light | A visible ring | lt-3, Swatches test |
| Orange member's name in the Log on light | Readable orange | accent.test |
| Trap Aim on a light device | The area draft in the dark danger red | lt-0 |
| Display, then a room in the same window | The device's latest choice | lt-5 |
| iPhone home-screen app, full-screen dialog at 130% | Black strip under the status bar | lt-6 |
| Handout viewer, card lower than the top, light | Black strip from its backdrop | lt-6 |
| A canvas reading a variable | Fails | boardColors.test, lt-0 |

## 14. UI checklist

- **Loading states:** none. The switch is instant. The boot text before the script stays dark. Rejected: a blocking head script (a request before first paint on every cold load, for a screen most loads never show).
- **Keys and focus:** no new key. One Tab stop with arrows. Focus stays on the chosen option across a switch.
- **Screen readers:** "Theme, radio group", options "Dark", "Light", "Auto", the help as its description.
- **Large interface sizes:** the Theme row at 130% on 320 x 568. The status band at 130% (lt-6).
- **Words:** Theme. Dark. Light. Auto. "Auto follows this device's own light or dark setting. The map, the fog, the dice tray and the table display stay dark in both." The This device row detail in 4.1.

## As built

- **More of the code read colors than the design counted.** By the time of the build there were 38 Konva importers (the weather layer added one with no color reads), and the same 20 read colors. canvas/relief/IsoBoard.tsx holds a second DOM site, its "Building area shapes…" note, named in the board guard and left scheme-aware. The dungeon generator's preview keeps the board's dark look (D-261102-545), and its member color comes from `boardTheme`.
- **The switch broke tests the design did not count, some silently.** 95 unit tests in 23 files read a token as a value. A contrast worked out on a `var(` string read it as near-black, and a regex built from one could pass by matching nothing. Every token regex now goes through `tokenPattern`, and a contrast through `tokenValue` (client/components/testing/tokenPattern.ts).
- **Two files outside the design's list broke in dark:** the HP mode's fill appended an alpha to a token (now `color-mix` at 20%), and the toast's d20 icon took tokens as SVG attributes (now `style`).
- **`ON_BOARD` is two spreads**, the attribute and `ON_BOARD_STYLE`. `BOARD_SCOPE` also sets `color-scheme: dark`. The board accent variables fall back to the crest's dark accent, so scheme.ts writes none of them outside a room.
- **The map's focus target shows its ring and its halo under keys only** (D-261102-538, which reverses LT-A's D-261102-550), as its ring did before the light theme. After a pointer it draws neither: script moves focus to it after taps, such as the last roll card's close, and iOS Safari may count that focus as visible, which would frame the whole map in dark after an ordinary tap. lt-3 checks both modes.
- **The off field's placeholder is two rules:** dark's hex, then a rule under `[data-rvtt-scheme]` that reads the variable (D-261102-551).
- **The status strip is components/StatusBand.tsx**, which App draws over every page. The This device row's detail is worked out in ThisDevice.tsx.
- **More top-layer surfaces draw the status strip than the design named:** a sheet that fills the screen, at its whole-screen shape and swiped up from the foot, and View as a player's dialog, whose room covers the dialog's own ground and so takes a StatusBand of its own. lt-6 found both.
- **The kit page has a Theme switch** that holds the scheme for that page alone, and `?theme=light` or `?theme=dark`.
- **The Room page's rules where it meets the board live in pages/onBoard.ts**, since Room.tsx cannot load under the unit tests. The chip's member dot reads the one `MARK_RING` of lib/memberColor.ts.
- **The display's hold covers the `/display` code page too** (D-261102-555). The preview's wait sets its own text color under its dark scope.
- **Dark, a floating chosen tool over pure white art** reads about 4.1:1 for mid-light member colors (2.2:1 before), enough for the icon and short of 4.5:1 for a named tool's 13 px label: dark's overlay alpha. A follow-up (D-261102-556).
- **The dot ring lives in components/Row.tsx's `RowDot`**, which covers the Members rows, the picker sample, the dot labels and the Claim, Join and join request dots. A second `danger` text use in the party bar, the folded pill's word, takes `dangerText` too. On light, a yellow member's note reads the general "darker shade" words, and the crest's words stay for orange (D-261102-562).
- **The contrast sweep reads the ground the browser paints**, from the stack of elements under each word's line with every element made hit-testable while it reads, not from DOM parents: a phone toolbar's band is a sibling drawn behind its buttons. A sign of one or two characters hidden from screen readers, such as the HP mode's "−", is an icon its control's name carries, held to 3:1 as a graphic (WCAG 1.4.11). lt-4 reads a part's colors where they draw: an inherited text color on a box with no words is not read.
- **lt-4's scene gate is the gate's wait**, with the room's socket held so no snapshot comes. **lt-6's popover** is the Area tool's Shape choice, and **its bottom-sheet dialog** the X-card as the DM gets it.
- **The sweep found one more ring on the board:** the turn strip's tracker target ("Initiative, round 1. Thorn's turn. Open the tracker."), which covers the phone's band and the top bar's pill. Its ring's lower side falls past the band onto the map, where it read 2.67:1 in light (the light accent over the board) and 1.35:1 in dark over white art. It now spreads `ON_BOARD` in the band and the pill, so it is the two-tone ring in both schemes.
- **Review round 1 fixes (lane ltfix):**
  - The dungeon generator's Reroll, in the preview's corner, stands on the board's dark ground or the dark picture, where the light accent's ring read 2.5:1 to 2.7:1. The corner slot spreads `BOARD_SCOPE`, so Reroll keeps the dark look and rings in the dark accent (D-261102-710). No other control stands over a board-colored ground outside the map. lt-3 now opens the generate dialog at both sizes in both schemes and measures Reroll's ring.
  - The table display's hold stands in App's display route, outside the lazy pages (features/display/DisplayHold.tsx), and client/main.tsx holds dark from boot on a display path, so a light device never paints a light frame on the TV while the pages' code loads (D-261102-712). lt-5 records every frame of both.
  - `memberInk` keeps 20 apart from `accentSoft` in both schemes: orange on light had come within 4.2 of it (D-261102-711).
  - lt-3 requires the rings Tab reaches on the map's column, and runs the ring pass once more with Thorn's window and Select's options row open, counting their rings apart (D-261102-713).
- **Not checked in Safari or WebKit.** Chrome resolves `var()` in SVG presentation attributes. The ones the app had moved into `style` anyway.
- **The DM guide's Theme picture shows the light page**, with Light chosen, so it shows what the choice does. The guide's other pictures stay pictures of the dark app.
