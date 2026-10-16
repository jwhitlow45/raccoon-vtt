# raccoon-vtt v1: layout and hierarchy

Status: draft 5, with the project owner's answers of 2026-10-15 (section 12) and the fixes from the design review's rounds 1 to 4. Code is cited from the `bar-dock` branch tip (`d1acdaf0`), where docs/design-v1-bar-dock.md is built. This design builds on that one. It changes none of its rules: section 3.5 lists the two new inputs its rules read (a rail on the left, and a side panel that can be hidden), and what each rule then does.

The project owner's feedback after the group's first real session (2026-10-15) asked for five things this document answers:

1. "There is little to no screen space when the orientation is landscape on mobile, especially when opening a tool like area or drawing. If possible, please come up with a UI that makes these take up less space vertically. Maybe we could have the options appear to the right and be scrollable? Open to design review here." Section 3.
2. "In general, the sidebar should be collapsible, but especially on mobile for phones which have padding at the side of the display." Section 4.
3. "Unable to make handout big when viewing as DM in library. Also the entire pane showing the handout should be taken up when someone zooms, not just the pane put within the modal. It can start the size it is now but it should be able to be zoomed to be larger while showing more of it." Section 5.
4. "Also please do an entire pass of just grouping things more logically and thinking about what things are used by a DM and players more often and less often and ranking hierarchies appropriately." Section 6.
5. "Also adding an image to current scene should be moved up to be in the \"this scene\" section". Section 6.2 (Scenes) and move M5.

Two other designs answer the rest of the same feedback in parallel: docs/design-v1-token-panel.md (the token panel, stat blocks, HP, AC on tokens) and docs/design-v1-combat-flow.md (the initiative tracker, death and revive, companions and summons). Where this design meets theirs it says so in a line or two and designs nothing of theirs.

Every size is in layout pixels, the chrome's own (`features/device/layout.ts`), and a safe area counts at its full size, as in docs/design-v1-bar-dock.md. "Sideways" means a layout wider than tall. "Short" means a layout under 500 px tall, the line `SHORT_LANDSCAPE_MAX` already draws for the turn strip (`features/encounter/band.ts:18`). "Wide" means 900 px or wider (`Room.tsx:190`), where panels are tabs of a side panel.

## 1. Summary

- **Tool options on a short sideways screen move into a rail on the left of the map**, 248 px wide, from under the top bars down to the toolbar, scrolling up and down. The map keeps its whole height. The rail is used only while it takes at most half of the map's width, so it never trades one cramped dimension for another. Only tools whose options run past one row use it. The one-row bars (Select several, Ping, Pin, Add token) stay at the foot, where they cost less map, unless their row wraps at that width. Everything else stays as it is: portrait phones, tablets and computers keep the bar at the foot.
- **The side panel can be hidden** from 900 px up, by "Hide panels" on the panel or the S key, and comes back by "Panels" in the toolbar, the same button a phone has. This device remembers the choice. A short screen, such as a large phone held sideways, starts with it hidden. **A phone's sideways sheet can be hidden** too, keeping its place and state, and Panels brings it back in one tap. While the side panel shows, the map's own chrome stops padding for the right safe area it no longer touches.
- **The handout viewer**: zooming uses the whole dialog body instead of the image's fitted box. Where the viewer is a card (a layout at least 600 px wide and 500 px tall), the first zoom step opens it to the whole window, and Zoom out or Reset zoom takes it back. "Expand" does the same without zooming. A short or narrow screen shows it whole-screen from the start. Zoom in, Zoom out and the + and − keys give the zoom a keyboard path it lacks today. The Library's image detail gains "View", which opens any image the viewer may see in the same viewer, so the DM can look at a handout large.
- **Ten moves** from the hierarchy pass (6.3), each with its reason. Among them: Fog moves up the DM's toolbar, Undo and Redo sit in every DM's top bar, the panels are ordered by use with the in-play ones first, the DM panel leads with Handouts, the map image moves into "This scene" as the project owner asked, and the Members roster tucks Kick and Remove behind one button per row.
- No ops, no schema, no protocol change. One new localStorage key.

## 2. Today

### 2.1 Tool options on a sideways phone

The active tool's options are a bar above the toolbar (`Room.tsx:1044-1086`), drawn only while no sheet is open (`Room.tsx:572`). On a phone it spans the screen (`:1056-1057`), its rows wrap rather than scroll sideways (`:1060`, and `features/measure/controls.tsx:18-45`), and past half the screen's height it scrolls (`maxHeight: screenHeight(50)`, `:1076`). Each tool lays out the same way: a hint or reading line first, then wrapping rows of 44 px controls (`measure/controls.tsx:23-71`). The canvas runs under every bar, and the bars' measured heights become the insets that Fit, Find and the bar dock keep clear of (`Room.tsx:205-208,360-373`).

On a sideways phone the bars take most of the height. The top bar is 52 px (`theme.ts:169`), the toolbar 60 px plus the bottom safe area (`Room.tsx:1114`), and in a fight a 48 px turn band unless the strip fits in the top bar (`band.ts:41-46`). What is left of the map's height, measured in Chrome on the dev fixture room:

The map's height left between the top bar and the options, in layout px, for the DM (a player's are the same where the tool exists). Headless Chrome, `hasTouch`, safe areas set through `Emulation.setSafeAreaInsetsOverride`: 47 px at each side and 21 at the bottom for 844 x 390, 59 and 21 for 932 x 430, none for 667 x 375. The turn strip stayed in the top bar at every one of these sizes (`band.ts:41-46`), so no band is counted.

| Tool and state | 844 x 390, 100% | 844 x 390, 130% | 667 x 375, 100% | 667 x 375, 130% | 932 x 430, 100% (wide) | 932 x 430, 130% |
|---|---|---|---|---|---|---|
| No options (Select) | 256 | 166 | 262 | 176 | 296 | 197 |
| Select several | 203 | 114 | 209 | 123 | 242 | 144 |
| Ping, Add token | 181 | 91 | 187 | 101 | 220 | 122 |
| Ruler | 181 | 73 | 187 | 83 | 202 | 104 |
| Ruler with one kept ruler | 133 | 25 | 139 | 35 | 154 | 56 |
| Pin | 181 | 43 | 187 | 53 | 126 | 122 |
| Fog, Polygon | 133 | 43 | 139 | 53 | 124 | 74 |
| Line up grid with Nudge | 133 | 43 | 139 | 53 | 172 | 74 |
| Area, a cone being placed | 131 | 42 | 137 | 51 | 170 | 73 |
| Area being placed, with More | 61 | 16 | 75 | 32 | 81 | 32 |
| Area, spell search | 85 | 16 | 91 | 32 | 81 | 32 |
| Draw, any drawing tool | 133 | 16 | 91 | 32 | 81 | 32 |
| Map builder, Label | 181 | 25 | 121 | 35 | 154 | 56 |
| Map builder, Heights with Stairs | 115 | 16 | 121 | 32 | 106 | 32 |
| **Any tool, with the rail (section 3)** | **256** | **166** | **262** | **176** | **296** (side panel hidden) | **197** |

- The bar stops at half the window's height (`screenHeight(50)`), and the top bar and toolbar are not counted against that half. Sideways they already take 134 of 390 px at 100% and 174 of 300 layout px at 130% (`Room.tsx:1076`). So a bar at its cap takes exactly half the screen and leaves the map 4% to 19% of it: 16 layout px at 844 x 390 at 130%.
- Draw reaches the cap at 130% before anything is drawn: its first state is five rows.
- At 130% Area with More, the spell search, Draw, Heights with Stairs and Fog with a draft and More all scroll.
- An upright phone (390 x 844) has room: Area with More, the worst, is eleven rows and leaves 180 px of 602.

The measuring script and every state's rows are kept outside the repository. The screenshots `measure-*-area-*-draft-more-dm.png` and `measure-*-draw-polygon-one-corner-placed-dm.png` in the project owner's screenshot folder show the worst cases.

### 2.2 The side panel and the sideways sheet

- From 900 px up the side panel always shows (`Room.tsx:585-589`): 360 px (`:1278`, `theme.ts:162`), the party bar for a DM (`:1289`), a wrapping tab list (`:1290-1327`) and the open panel (`:1333`). Nothing hides it. Its box includes the right, top and bottom safe areas (`:1284-1286`, every box is `border-box`, `globals.css:28-32`).
- A large phone held sideways lays out at 900 px or more at 100% (932 x 430 for the largest iPhones, 915 x 412 for many Android phones), so it gets the side panel. Measured at 932 x 430 with 59 px safe areas: the panel is 300 px inside its border and the inset, 268 px inside its body's padding (`Room.tsx:1333`), and the map 572 px. For a DM the party bar takes 165 px and the 13 tabs wrap onto four rows, 199 px, which leaves the open panel a body 45 px tall: Initiative shows "Round 2" and cuts off Previous and Next. The room name is cut to "Th...". A player's tabs take 153 px and leave 256.
- The map's own chrome pads for both side safe areas whatever stands beside it: the top bar (`Room.tsx:806`), the toolbar (`:1115`), the options bar (`:1066`), and the bar dock's free area and lane (`barDock.ts:83`, `InitiativeStrip.tsx:668-669`). With the side panel open, the map does not reach the right edge, so its chrome pads for an inset it never touches.
- On a phone held sideways a panel opens as a sheet on the right, 340 px or 60% of the width (`Sheet.tsx:86-94`), between the top bars and the toolbar, holding the right safe area inside it (`:93`). Its header has "All panels" and "Close <panel>" (`Room.tsx:524-545`). Close unmounts the panel. Panels then opens the list of panels (`Room.tsx:276-279`), so getting the same panel back takes two taps and it starts again at its top: a scrolled Log, an open journal page, a half-typed message are gone.

### 2.3 Handouts and the Library

- A handout pops up for the players it is shown to, never for the DM (`HandoutPopup.tsx:26-27,50`). It is the shared Dialog, large (`:150-158`): the whole screen below 600 px, else a card up to 720 x 760 px (`Dialog.tsx:84-108`).
- The image sits in a box as wide and tall as its fitted size (`HandoutPopup.tsx:285-302`: `width: fit-content`, the image's `maxHeight` from `imageMaxHeight`, `:200-203`). Zoom scales the image inside that box (`:304-324`), clamped to it (`zoom.ts:22-26`). So a zoom never grows the visible area: a wide map handout on an upright phone zooms inside a strip about 200 px tall while the rest of the screen stays empty, and on a computer inside the 720 px card while the window around it stays dim.
- Zoom is pinch, one-finger pan once zoomed, double tap or double click, and the wheel (`:205-280`). There is no button or key to zoom. "Reset zoom" floats over the image while zoomed (`:326-330`).
- The Library is a grid of thumbnails (`LibraryGrid.tsx:249-258`). A tap shows a detail card under the grid with a 96 px thumbnail, the size and the credit (`:208-238`), and for the DM a two-tap Delete on an unused image (`:160-166`). Nothing opens an image larger, for either role. The DM's library lists Token images, then Maps, then Handouts (`:111-115`). A player's library starts with "Handouts from the DM" and an Open for each, which pops the handout up again (`LibraryPanel.tsx:37-79`).

So the DM has no way to see a handout larger than 96 px, and nobody can make the viewing area larger than the fitted image.

## 3. Tool options in a rail on short sideways screens

### 3.1 When

`optionsPlace` in a new `client/pages/optionsPlace.ts` gives "rail" or "foot" for the active tool, in two steps.

First, whether this screen allows the rail at all:

- **Allowed** when the layout is sideways and short (under 500 px tall) and the rail with the left safe area takes at most half of the map's width: `248 + safe.left ≤ mapWidth / 2`. `mapWidth` is the layout's width, less the side panel's 360 px while it shows (section 4.1).
- **Not allowed** otherwise: every tool keeps today's bar at the foot.

Half, because the bar at the foot never takes more than half the screen's height (`Room.tsx:1076`), and the rail must not swap a map with no height for one with no width.

Then, where the rail is allowed, which tools use it (the project owner's choice, section 12):

- **Multi-row tools** use the rail: Ruler, Area, Draw, Fog, Map builder and Line up grid. Their options run to two or more rows at the foot on every sideways phone measured (2.1), and grow with use (a kept ruler, More, a drawing tool's settings, a builder mode).
- **One-row tools** stay at the foot: Select several, Ping, Pin and Add token, whose controls are one row that never changes with use. There the foot costs less map. At 844 x 390 at 100% Ping's bar leaves the map 181 x 844 px, while the rail would leave it 256 x 549. `ToolDef` gains `optionsAt: "foot"` for these four (`tools.ts:137-145`, `pings/PingTool.tsx:93-104`, `pins/PinTool.tsx:157-180`, `tokens/placeTool.tsx:46-74`).
- **A one-row tool whose row wraps.** Ping, Pin and Add token are one row only where the foot is wide enough: Pin's ten swatches and DM only wrap at 844 x 390 at 130%, measured at 160 px tall, leaving the map 43 px. When a one-row tool's controls stand on more than one line at the foot (their tops differ, as `useOptionsHeights` already reads them, `Room.tsx:97-140`), Room records the layout width, as the turn strip records an overflow (`band.ts:53-57` `overflowRecord`). That tool then uses the rail while the rail is allowed and the layout is no wider than the record. The check runs in a layout effect of the foot bar, which reads the controls' tops after layout and before paint, and its record re-renders the bar in the rail in the same frame (React flushes a state change made in a layout effect before the browser paints). So the first time a one-row tool opens at a width where it wraps, it is never painted at the foot: no jump. A resize or a new interface size re-renders Room, and the same layout effect decides again before that frame paints. Its controls never change with use, so it never moves while it is in use. Select several never moves (3.4).

The worked sizes:

| Window | Interface size | Layout | Side insets | Rail with inset | Half the map | Rail allowed |
|---|---|---|---|---|---|---|
| 844 x 390 | 100% | 844 x 390 | 47 | 295 | 422 | Yes |
| 844 x 390 | 130% | 649 x 300 | 47 | 295 | 325 | Yes. Pin wraps here, so it uses the rail too |
| 667 x 375 | 100% | 667 x 375 | 0 | 248 | 334 | Yes |
| 667 x 375 | 130% | 513 x 288 | 0 | 248 | 257 | Yes. Pin wraps here too |
| 932 x 430, side panel hidden | 100% | 932 x 430 | 59 | 307 | 466 | Yes |
| 932 x 430, side panel shown | 100% | 932 x 430 | 59 | 307 | 286 | No |
| 932 x 430 | 130% | 717 x 331 | 59 | 307 | 359 | Yes |
| 568 x 320 | 100% | 568 x 320 | 0 | 248 | 284 | Yes |
| 480 x 320 | 100% | 480 x 320 | 47 | 295 | 240 | No |
| 480 x 320 | 130% | 369 x 246 | 47 | 295 | 185 | No |

Upright phones, tablets (an iPad sideways lays out 768 px tall at 130%: 591) and computers are never short and sideways at once, so they keep the foot. Pin's wrap at 130% comes from the measurements in 2.1 (three rows at 844 x 390 and at 667 x 375 at 130%). Where the table says a one-row tool wraps, the record above finds it, and no width is written into the code.

### 3.2 Where, and how big

- **Left of the map.** The project owner first suggested the right. The right side of a sideways phone is taken: the bar dock's lane holds the fight alerts and the docked token bar there (docs/design-v1-bar-dock.md 1.3), the sheet opens there, and Panels sits at the toolbar's right end. A rail on the right would push the lane into the middle of the map. On the left the rail stands right above the toolbar's tools, which start at its left end, so the options sit over the button that opened them. The project owner chose the left on 2026-10-15 (section 12).
- **Size.** 248 px wide plus the left safe area: 231 px of content, 8 px padding at each side and a 1 px right edge. 231 px is the width the options bar already lays out on the narrowest screen it serves, a 320 px phone at 130% (246 px wide, 230 inside its padding, `Room.tsx:1066`), so every tool's controls already fit it. The rail's box reaches the screen's left edge and pads its content by the safe area, as the toolbar does (`Room.tsx:1115`).
- **Height.** From under the top bars (the top bar, the turn band when the strip is not in the bar, the top safe area: the same top as a sheet, `Room.tsx:529`) down to the toolbar's top (`calc(safe.bottom + 60px)` from the bottom).
- **Look.** The bars' `overlay` fill, a `border` line on its right edge, no rounding, at `z.options` (14) as today. It scrolls up and down (`overflowY: auto`, `overscrollBehavior: contain`) and never sideways. While its content runs past its foot, it shows the token bar's sticky `aria-hidden` "Scroll for more" (`ScrollForMore`, exported at `TokenActionBar.tsx:750` and already used by the alerts column). It gains a `fill` prop for its fade, `surface` by default as today and the rail's `overlay` here, so the fade matches what it covers.

### 3.3 What it holds

The same element as today: `role="toolbar"`, named "<tool> options" (`Room.tsx:1050-1051`), with the tool's Options inside the same LoadBoundary (`:1081-1083`). No tool's Options changes. Their hint or reading comes first and their rows wrap to the rail's width, so a tool that took three rows across a phone takes more, shorter ones down the rail, and they scroll. It keeps its place in the page's order, just before the toolbar, so Tab reaches it where it does today.

### 3.4 One-row tools stay at the foot

The Select several bar is the mode's status line ("3 selected", Actions, Done), one row by the bar dock design (docs/design-v1-bar-dock.md section 3), and the compact bar's rules lean on it standing at the foot (1.4). In a rail it would also take a third of the width while the token bar takes the lane, leaving almost no map to tap tokens on. So it stays at the foot always, even where it would wrap, as the bar dock design's own short hint keeps it one row. Ping, Pin and Add token stay at the foot by the rule in 3.1, and move to the rail only at a width where their row wraps.

### 3.5 With the bar dock

The bar dock's rules stay. They read two new inputs:

- **The rail.** `Chrome` gains `rail`, the rail's drawn width with the left safe area, in layout px, or 0 (`barDock.ts:55-67`). The free area's left edge becomes `(rail > 0 ? rail : safe.left) + 8` (`barDock.ts:82`), as its right edge already takes a sheet in place of the right safe area (`:83`). With the rail, the tool adds nothing at the foot, so `Chrome.bottom` and `Chrome.controls` hold the toolbar alone, and the free area grows taller. `barMode`, `shareLane`, the summary row, the compact overlay, the stored spot, Move bar and `barCover` all take the narrower, taller free area as it is. The lane stays at the right.
- **The side panel's state** (section 4.1): the free area's `mapWidth` (`Room.tsx:390`) subtracts the side panel only while it shows, and the right safe area counts only while the map reaches the right edge (4.3).
- **The alerts column's cards.** The column hangs from the top bar and sizes its cards from the map's width, not the free area (`InitiativeStrip.tsx:668-681`), so a narrower free area alone would not narrow them. At 667 x 375 at 130% a 300 px card would run from x 205 to 505, 43 px over the rail. With a rail the card width becomes `min(300px, 100% − sheet − 16px − rail − (the right safe area, or 0 beside a sheet))`, where `rail` replaces the left safe area. The left shadow allowance becomes `min(SHADOW_ROOM, 100% − rail − card − right padding)`, so the padding that holds the cards' shadows never reaches over the rail. The summary rows (bar dock 1.3) take the same width. The rule in 3.1 leaves at least 232 px there (the worst case: a rail and its inset taking exactly half, and an equal right inset), wider than the 230 px card a 320 px phone at 130% already draws. Cards measured: 249 px at 667 x 375 at 130%, 291 px at 844 x 390 at 130%, 300 px elsewhere.
- **Narrower cards are taller.** The column publishes its content height and its first card's height from the drawn cards after each layout (bar dock 1.3, Measuring), so `shareLane` reads the taller heights on the next measure. Nothing estimates them.

What that gives at the sizes the bar dock design worked through (1.4), with a rail tool such as Area active:

- 844 x 390 at 130%: free area 291 x 150, so the bar docks (today the Area bar's rows leave it compact). With the turn band, 291 x 102: compact, the overlay 291 px wide and, since down to the toolbar leaves 102 px, over the toolbar too, as today. The free width less the lane is under 230, so an alert shows as the summary row.
- 667 x 375 at 130%: free area 249 x 160 (112 with the band). Dock, or compact with the band. The column's cards are 249 px wide, right of the rail.
- 480 x 320 at 130%: no rail. Everything as the bar dock design says.

Its short screen summary row stops at the tool's options (1.3). With a rail there are none at the foot, so it stops at the toolbar.

### 3.6 Everything else over the map

- **Fit, Find, pans and panes.** Room's `insets.left` becomes the rail's drawn width (`Room.tsx:205-208`, 0 today). Fit, Find, the pans that bring a token into view and `keepInView` read it (`Stage.tsx:101-102,357,369,407,609`), and so do the panes anchored to map points, which already clamp to `insets.left` (`features/movement/anchor.ts:22`). A fitted map refits when a rail tool is picked, as it refits today when a bar at the foot appears (`Stage.tsx:325-326`). A camera the viewer moved does not move: the rail lies over the canvas and leaves its size alone.
- **Notices.** The stack centers in the free area left of the lane when 320 px are left there, as today (`barDock.ts:488-491`). Otherwise it spans the free area's width, starting right of the rail, instead of the whole map (`Room.tsx:506`), so an offline banner never covers the tool's controls.
- **"Viewing as Pat"** lives in PlayerPreview, which centers it across the window whenever Room reports no box (`Room.tsx:397-406` calls `place(null)`, `PlayerPreview.tsx:128`). While a rail shows, Room always reports a box: the free area's left and width, the notice centered in it at most 520 px wide. So it never covers the rail. Without a rail, the rule stays as the bar dock design set it.
- **A player's roll card at a narrow screen's foot** (under 600 px, `PlayerRolls.tsx:505-508`) stands on the toolbar and starts right of the rail, so it never covers the tool's controls, as it stands on the foot bar today. At 667 x 375 at 130% that leaves it 265 px, wider than the 246 px card of a 320 px phone at 130%.
- **Scene loading** centers in the area the insets leave (`Room.tsx:697`), right of the rail.
- **A sheet** hides the rail as it hides the bar (`Room.tsx:572`). A hidden sheet brings it back (4.2).
- **Turning the phone** upright puts the options at the foot, and back sideways in the rail. The tool, its draft and its choices are the tool's own state in the room's scope, so nothing is lost.

### 3.7 What stays

Every tool, option, name, role, shortcut and Tab stop. The foot bar on every screen that is not short and sideways. The Select several bar. The toolbar.

### 3.8 Mockups

A DM with Area, a Fireball being placed, 844 x 390 at 100%. Today (measured: section 2.1):

```
+--------------------------------------------------------------------+
| o Crypt  (DM)                          undo redo [Goblin 2 R3] Fit |
|                       map, about 60 px tall                        |
+--------------------------------------------------------------------+
| Tap or drag on the map to place it.                                |
| [Spell: Fireball v] [Shape: Sphere v] [- 20 ft +] [Place] [Shared] |
| [Cancel] [More]                                                    |
+--------------------------------------------------------------------+
| Select Add Ruler Area Draw Ping Pin Fog ...              | Panels  |
+--------------------------------------------------------------------+
```

With the rail:

```
+--------------------------------------------------------------------+
| o Crypt  (DM)                          undo redo [Goblin 2 R3] Fit |
+-------------------+------------------------------------------------+
| Tap or drag on    |                                  +-----------+ |
| the map to place  |                                  | Goblin 2  | |
| it.               |                                  | checks    | |
| [Spell:Fireball v]|              map                 | conc.     | |
| [Shape: Sphere v] |        (256 px tall)             +-----------+ |
| [- 20 ft +]       |                                                |
| [Place] [Shared]  |                                                |
| [Cancel] [More]   |                                                |
| ..Scroll for more.|                                                |
+-------------------+------------------------------------------------+
| Select Ruler Area Fog Draw Ping | Add Pin ...            | Panels  |
+--------------------------------------------------------------------+
```

The same at 667 x 375 at 130% (layout 513 x 288), where the rail takes just under half:

```
+-------------------------------------------------+
| o Crypt (DM)              undo redo  [R3]  Fit  |
+-------------------+-----------------------------+
| Tap or drag on    |                             |
| the map to place  |            map              |
| it.               |       265 x 176 px          |
| [Spell:Fireball v]|                             |
| [Shape: Sphere v] |                             |
| ..Scroll for more.|                             |
+-------------------+-----------------------------+
| Select Ruler Area Fog Draw ...         | Panels |
+-------------------------------------------------+
```

An upright phone (390 x 844), a tablet and a computer look as today.

## 4. Hiding the side panel and the sideways sheet

### 4.1 The side panel, from 900 px up

- **Hide.** An icon button "Hide panels" (`collapsePanel`: a framed panel with an arrow toward its right edge, where the panel goes) at the end of the side panel's tab row, outside the tab list (`Room.tsx:1290-1327`). The row becomes a flex row: the tab list, which wraps as before, then the button, aligned with the first row of tabs. Not a bare chevron: on a short side panel the tab row's own scroll chevron sits a few pixels away, and in a sheet's header a right chevron read as forward beside Back's left one. Both Hide buttons are one component (`HideButton`, `SheetHeader.tsx`).
- **Hidden.** The side panel takes the `hidden` attribute and no width. Its content stays mounted, as the folded token bar keeps its body (docs/design-v1-visual.md 3.2.1), so a half-typed Log message, an open journal page and each panel's scroll survive. The map widens. Stage keeps the world point at the center for a camera the viewer moved and refits a fitted one (`Stage.tsx:197-219,325-326`).
- **Show.** While it is hidden, the toolbar shows "Panels" at its right end: the phone's button (`Room.tsx:1129-1143`) in the wide toolbar's floating look, with the same unread badge for the Log and the Journal. Its name is "Panels", with `aria-expanded="false"` and `aria-controls` naming the side panel. A press shows the side panel on its chosen tab, and focus goes to that tab, as when Details opens the token's panel (`Room.tsx:458`).
- **Keyboard.** Both buttons take Tab, the path every keyboard layout has. A new shortcut, S ("Hide or show the side panel"), for the DM and players, from 900 px up only (`state/shortcuts.ts`, listed by the shortcut sheet). A letter, because `letterOf` falls back to the key's physical code (`shortcuts.ts:89-93`), so it works on every layout. `\` was rejected: it needs AltGr or Option on many layouts, and `shortcutFor` drops any press with Alt (`shortcuts.ts:391`).
- **Focus.** Hide panels moves focus to Panels, since the button it was on is gone. Panels moves it to the chosen tab, since Panels goes. S moves focus only where its element disappears: hiding with focus inside the side panel puts it on Panels, and showing with focus on Panels puts it on the chosen tab. Anywhere else, focus stays where it is. Escape does not hide the side panel: it is not a sheet.
- **Anything that opens a panel shows it.** `ui.openPanel` clears the hidden state (`store.ts:436-439`): the token bar's Details (`Room.tsx:242`), a tracker row (`encounter/Row.tsx:411`), a tap on the turn strip (`InitiativeStrip.tsx:322`), the `/` shortcut (`shortcuts.ts:367`), a pin's journal page (`PinPane.tsx:189`, `PinLayer.tsx:139`), Add token's Monsters and Characters (`placeTool.tsx:112,115`). A hidden side panel never swallows a request to see a panel. This leaves the stored choice alone, so a reload brings back what the viewer chose.
- **Remembered per device.** localStorage `rvtt.sidePanel`, "hidden" or "shown", written by Hide panels, Panels and S, read and written in try and catch as every `rvtt.*` key is. One value for every room and both roles. With no value, the side panel shows, except on a short layout (under 500 px tall), where it starts hidden: there it is a large phone held sideways, and the map needs the width. That default is worked out once per Room page, the first time the layout is wide, and kept in the room's local state. A resize or a rotation never hides or shows the panel by itself, so a window dragged shorter does not lose its panel. A DM's "view as a player" reads the key and never writes it, as it treats the token bar's spot.
- **What follows its state.** Panels learn whether they are on screen (4.2, "Read only when seen"). The Log and the Journal count as on screen only while the side panel shows (`Room.tsx:263`). `tokenPanelShown` (`Room.tsx:291`) holds only while the side panel shows, so Escape and Back still end a held group's Select several while it is hidden (docs/design-v1-bar-dock.md section 3). The bar dock's `mapWidth` (`Room.tsx:390`) and the Select several hint's room (`SelectOptions.tsx:58`) subtract the side panel only while it shows. The rail's rule (3.1) reads the same width.
- **A short side panel.** On a short layout (under 500 px tall) the side panel, when shown, keeps its body: the tab list becomes one row that scrolls sideways, in the toolbar's ScrollStrip with its fade and chevron (`components/ScrollStrip.tsx`, which takes a `role` and a name), in place of four wrapped rows. The chosen tab carries `data-active`, so it scrolls into view. The tab keys (Left, Right, Home, End) work as before and scroll the row with focus. The party bar starts folded there when this device has stored no fold (`rvtt.partyFolded`, `PartyBar.tsx:24-40`). At 932 x 430 that leaves a DM's panel body about 250 px instead of 45. A tall side panel keeps its wrapping tabs, so a mouse reaches all of them (`Room.tsx:168-169`).
- **The party bar** sits at the top of the side panel (`Room.tsx:1289`), and the Party panel is a phone's only (`panels.ts:84`), so it hides with the side panel. Panels brings both back.

### 4.2 The sheet on a phone held sideways

- **Hide.** A sheet placed on the right gains an icon button "Hide <panel>", such as "Hide Initiative" (`collapsePanel`, the side panel's Hide icon), named by the panel even on a subpage, as Close is (`Sheet.tsx:102`). It sits in the header between the trailing actions and Close (`SheetHeader.tsx:78-100`, through a new `onHide` on `Sheet`). A bottom sheet has none: the owner asked about the sidebar, and a bottom sheet is not one. The list of panels has none: hiding a list equals closing it.
- **A narrow header.** One row needs its buttons at 44 px each, a title of at least 40 px (`SheetHeader.tsx:19-26`), a 4 px gap between each two and the header's side padding: 200 px for Back, Hide and Close, or 192 with the 4 px padding of a header that holds actions. Below that the header stacks. Its first row holds Back at the left and the other buttons at the right, each 44 px. Its second row holds the title alone, at the heading's size, one line with an ellipsis: 78 px in all (6 px, the 44 px row, a 22 px title line, 6 px) against a one-row header's 56. Sheet decides it from its width and its buttons (the width less its side padding and borders, which Room knows from the layout and `useSafeAreas`), never from a measurement that could flicker. Every sideways sheet in 8.1 keeps one row: the narrowest, at 480 x 320 at 130%, would have had 172 px, but that size always takes the very short mode below, whose header is 275 px wide, as that mode draws no border. There the header stacks only while it also holds the dock's two buttons (five buttons need 244 px of row and a 40 px title).
- **A very short sheet.** A sheet on the right runs from under the top bars to the toolbar, so on a short screen with the turn band in a band its body can vanish: at 480 x 320 at 130% with the band and the 21 px home-bar inset the sheet is 65 px tall, less than its header. So when the sheet's body would be under 88 px below its header, inside its 1 px borders (two 44 px rows: one whole control and room to see there is more), the panel opens in a very short mode instead, as the bar dock's compact overlay covers the bars when it must (docs/design-v1-bar-dock.md 1.4). The sheet's height is the layout's height less the top safe area, the top bars (52 px, and 48 more while the strip is in a band), the bottom safe area and the 60 px toolbar, which Room knows without measuring.
  - **Its shape.** The whole screen, from the top safe area to the screen's foot, above the top bars, the band, the toolbar and every pane over the map. It pads its content by the safe areas on all four sides, and draws no border, which at the screen's edges would frame nothing and take 2 px from a short body. A dialog's whole-screen card (`Dialog.tsx` `dialogCard`, such as the handout viewer's) draws none either. It is the sheet's own `<dialog>` opened with `showModal()` (next bullet), so focus stays inside it and the room behind is inert, and it takes the interface size as a sheet does.
  - **Its header** is the same: Back ("All panels" or the subpage's "Back to"), the title, Hide and Close, with the narrow rule above.
  - **What floats over the map** folds while it shows, as under an upright sheet (docs/design-v1-visual.md 3.2.1): the token bar and the alerts column take `hidden` with their state kept, and the dock's buttons ("Show Thorn actions" and the alerts summary) join the header's trailing actions as the dock's header mode already places them (`DockHeaderActions`, `Room.tsx:469`). `foldsUnderSheet` (`pages/fold.ts:31`) gains this mode beside the upright one.
  - **Announcements, toasts and notices.** A modal dialog makes everything outside it inert, so the alerts' status region (`FoldStatus`, `RoomDock.tsx:241-275`, mounted at `Room.tsx:590`) and the toasts (`Room.tsx:522,965-1008`) would speak and show where no one can reach them. Both components stay mounted where they are, and while the modal sheet shows, each renders its output through a portal into a slot inside the dialog: the status region visually hidden, the toasts between the header and the body, 520 px wide at most, in flow. They push the body down for the few seconds they show and never lie over it, since over it they hid under Initiative's sticky round header or covered the panel's controls. Their tracking stays in the components, outside what moves, so nothing is said twice. `FoldStatus` keeps its record of what it has said, and its region starts empty in its new place, speaking only what arrives after the move. Each toast stays where it first showed until it ends (Room keeps the place by toast id), so a toast is never moved and never announced again. A refusal from the server while the modal shows therefore appears inside it, on top, and is read out.
    The room's other notices go to the same place while the modal shows, above the toasts and in flow too: "Your turn" (the strip's assertive status, `InitiativeStrip.tsx:378-380`), the connection banner (`components/ConnectionStatus.tsx:53`, drawn by Room's `Banner`, `Room.tsx:518`), a map layer that did not load (`QuietLoadNotice`, `:520`) and the DM's frame bar (`FrameViewBar`, `:519`). Each stays mounted where it is and renders its output through the same portal, keeping its own state. One already showing when the modal opens moves with its text and is not spoken again, since a live region speaks what changes in it, not what it holds as it appears. One that appears or changes while the modal shows is spoken there. So a player reading the Log in the very short mode hears and sees "Your turn" inside the sheet.
    In a DM's "view as a player", the preview's "Viewing as Pat" and its Exit (`PlayerPreview.tsx:94,120-132`) sit outside the previewed room, under any modal sheet it opens. While that room shows the very short mode it hands PlayerPreview its slot through `PreviewContext` (`features/dm/previewContext.ts`, beside `place`), and the notice renders first in it, so it stays above the sheet's content and Exit takes a tap. When the sheet hides or closes, the notice goes back to its place.
  - **Escape, Back and Close** close it, as they close a sheet. **Hide** hides it and moves focus to Panels, as for any sideways sheet. Panels shows it again in the same mode while the screen is still that short.
  - **Shortcuts.** While the modal shows, the room's shortcuts are off, N and Ctrl+Z included, as under any modal dialog (`shortcuts.ts:390-391,413`). Its Escape is the dialog's own, which closes it.
  - **Its body** is the screen's height less the safe areas and the header: 223 px at 844 x 390 at 130% with the band, 232 px at 667 x 375 at 130% with the band, 243 px at 480 x 320 at 100% with the band, and at 480 x 320 at 130% (band or not) 169 px, or 147 px while the header stacks to hold the dock's buttons. These include the body's 4 px top and 16 px bottom padding (`Sheet.tsx:108`).
  - The decision is one pure function, `sheetMode({ height, safeTop, safeBottom, topBars, header })` in `components/sheetCap.ts`, giving "side" or "full".
- **One `<dialog>` for every mode.** A sheet is one `<dialog>` element, kept mounted from the moment its panel opens until it is closed, whatever its mode: at the bottom of an upright phone, on the right of a sideways one, or in the very short mode. So no change of mode, no hiding and no rotation ever remounts the panel, and its draft, scroll and subpage stay. Its inner `<section>` keeps today's `aria-label` and region role (`Sheet.tsx:63-65`), so every query and landmark that finds a sheet still does.
  - **Bottom and side modes:** `show()`, with no `aria-modal`. The map and the bars stay live, as today. Chrome's `show()` runs the dialog focusing steps and moves focus to the sheet's first control, which no sheet did before. So the hook notes the focused element before `show()` and puts focus back on it after, unless a focus request is pending: Room's request for the sheet's title (`focusNext`, `Room.tsx:454-460`), or Show's. A turn-strip tap that opens Initiative therefore leaves focus on the strip, as today.
  - **Very short mode:** `showModal()`, with `aria-modal="true"`.
  - **Hide:** `close()`, and `aria-modal` is removed, before focus moves to Panels, which is then no longer inert. The content stays mounted, the panel stays the open one with `sheetHidden` set, and Hide is not Close.
  - **Show:** the same element opens again in the mode the screen calls for now, with `show()` or `showModal()`, and focus goes to its title.
  - **A change of mode while it shows** (the turn band appearing when a fight starts or when a player's End turn overflows the bar, or going when it ends, or a resize): `close()`, then `show()` or `showModal()` on the same element. Both run the browser's dialog focusing steps, so the hook notes the focused element inside the sheet before `close()` and focuses it again after, and focus stays on its element. The page hears none of the focus moves on the way: while the steps run, the hook stops every focus and blur event at the window, before any listener. A field that saves on blur (a number, a name, the initiative box) therefore neither saves nor drops a half-typed value because the mode changed. It does so only whenever focus will come back to an element that can still take it, so a real blur, such as a field in a token bar folded away under a sheet, is heard as before. While the sheet is hidden, a change of mode only changes the mode it will open in.
  - **Close:** as today the panel closes and the sheet unmounts. The dialog is closed first, so the after-close focus decision (`Room.tsx:654-673`) finds nothing inert. Chrome's `close()` sends focus back to the element focused before the sheet opened, and that decision returns early whenever focus is somewhere (`:669-671`), so today's order (a roll card the sheet hid, then the token bar's frame) would be skipped. So the hook holds focus on close: when focus was inside the sheet as it closed, it takes back the browser's move, leaving focus lost exactly as when a sheet unmounted before, and Room decides as today. When focus was elsewhere (Panels, the map), it stays there. Hide then moves focus to Panels itself.
  - **A close the hook did not ask for.** Chrome can close a modal dialog with no `cancel` event when Escape repeats with no tap or click between (`lib/modalDialog.ts:64-68` handles it for every Dialog). The hook listens for the native `close` event too, and marks each `close()` of its own (Hide, a change of mode, Close) just before it calls it. A `close` it did not mark is the viewer closing the sheet: it removes `aria-modal` and calls `onCancel`, so the panel closes and the modal marker goes in the same step.
  - **The hook.** `useModalDialog` stays as it is for every Dialog: it opens on mount and closes on cleanup (`lib/modalDialog.ts:53-102`), which suits a dialog that lives only while open. A small hook beside it in the same file, `useSheetDialog(ref, { shown, modal, onCancel })`, opens, closes and switches the element on `shown` and `modal` in a layout effect, before paint. It reuses that file's Tab wrapping and its `cancel` handling only while modal, carries over its native `close` fallback as above, keeps focus where it was after `show()` unless a request is pending, and holds focus on close so Hide and Room's after-close step place it, as this section says.
  - **What counts as a modal.** `aria-modal="true"` is on the sheet only between `showModal()` and `close()`, so the readers that ask whether a modal is open (`state/shortcuts.ts:413`, `RoomChrome.tsx:119`, `LabelPane.tsx:48`, `PinPane.tsx:54`, `LightPane.tsx:51`) see one only while it shows, and need no change. After Hide, the map's shortcuts and the room's Escape work again at once.
- **Hidden.** The sheet's dialog is closed (`close()`, as above) and stays mounted, with its panel's state and scroll. It stops counting as open everywhere. `sheetOpen(local)` (`state/types.ts:165-167`) is false while it is hidden, which the alerts column, the token bar, the roll cards and the dock read (`InitiativeStrip.tsx:445`, `TokenActionBar.tsx:517`, `PlayerRolls.tsx:102`, `DmDesk.tsx:62`, `pages/fold.ts:37`). Room derives its own values from `local.panel`, and each of these reads the shown sheet instead, through one pure `panelView(local, wide)` in `state/types.ts` that gives the panel that is mounted and whether it shows:
  - `sheet` (`Room.tsx:260`): mounted while hidden, its dialog closed.
  - `sheetOpen` (`:281`): the shown sheet or the list, so Back (`:282`), Escape (`:299`, `RoomChrome.tsx:121`) and the dock's fold (`:318`) pass over a hidden sheet.
  - `tokenPanelShown` (`:291`): false while the Token sheet is hidden, so Escape and Back end a held group's Select several again (docs/design-v1-bar-dock.md section 3).
  - `sheetRight` (`:358`): 0 while hidden, so `Chrome.sheet` is 0 and the bar's free area and the alerts column agree that the right edge is free.
  - The options' gate (`:572`) and Panels' pressed state (`:580`): the shown sheet only.
  - Unread (`:263`): a hidden Log is not on screen.
  - `openSheet` (`:307-310`), which Find my token reads: null while hidden, since a hidden box measures 0.
- **Focus.** Hide closes the sheet's dialog and drops any `aria-modal`, then moves focus to the toolbar's Panels button, since the button it was on disappears. A draft in the panel is kept, because the panel stays mounted, and so is its scroll. The after-close focus decision (`Room.tsx:654-673`) finds focus on Panels and leaves it there, so it never sends focus to the token bar or a roll card for a sheet that was only hidden.
- **Show.** Panels shows the hidden sheet in one tap, with focus on its title, in place of opening the list (`Room.tsx:276-279`). While a sheet is hidden the button is not pressed, and its description says what it will do: "Shows Initiative again." (`aria-describedby`). Close still closes for good, and Panels then opens the list as today. The sheet's "All panels" still leads to the list.
- **Opening another panel** from anywhere drops the hidden one, as opening a panel always takes the open one's place. Opening the list (`showPanelList(true)`) drops it too.
- **Turning upright** keeps a hidden sheet hidden. Panels then shows it as a bottom sheet.
- **Crossing 900 px.** A phone sheet's hidden state means nothing on a wide layout: crossing to 900 px or more clears it, and the side panel shows that panel's tab, shown or hidden by its own state (4.1). Crossing back below 900 px opens the side panel's tab as a sheet, as today (`local.panel` holds it), except that a hidden side panel comes back as a hidden sheet, so a panel the viewer hid never pops up on a rotation.
- **Remembered.** Nothing past this page. A phone opens a sheet for a need and closes it after, and a stored "hidden" would open the next one hidden.
- **Read only when seen.** A hidden panel stays mounted, so an effect that marks content read must know whether it is on screen. `PanelProps` (`features/panels.ts:40-45`) gains `shown`, which Room passes through `PanelBody` (`panels/Panels.tsx:18-31`): true while the sheet or the side panel shows and that panel is the open one. The Journal's open page marks itself read only while shown, and marks the revision on screen read when it shows again (`JournalPanel.tsx:201-204` today marks every change at once). The Log's unread count already takes Room's flag (`Room.tsx:263`). No other panel marks anything read: `markRead` and `useLogUnread` are the only two (searched across `client/`).

State: `LocalUi` (`state/types.ts:137-145`) gains `sidePanelHidden` (wide, from the key or the default) and `sheetHidden` (a phone's sheet, this page only). `openPanel` clears both. `closePanel`, `closeSheets` and `showPanelList` clear `sheetHidden`, and `showPanelList(true)` also drops a hidden panel. A DM's "view as a player" keeps its own copy of these actions (`features/dm/preview.ts:102-105`), which follow the same rules.

### 4.3 The side safe areas

| Chrome | Today | New |
|---|---|---|
| Top bar | Pads left and right by the safe areas (`Room.tsx:806`) | Pads right only while the map reaches the right edge: a phone, or the side panel hidden |
| Toolbar | The same (`Room.tsx:1115`) | The same rule |
| Options at the foot, phone | Pads left and right (`Room.tsx:1066`) | Unchanged |
| Options at the foot, wide | Box 8 px from the left, under a notch, content padded by both safe areas (`Room.tsx:1056,1066`) | Box 8 px right of the left safe area, content padded 8 px, since the box never touches a side. The Select several hint's room drops the safe sides it adds today (`SelectOptions.tsx:57-58`) |
| Rail | New | Reaches the left edge, content padded by the left safe area: 231 px of content at every size |
| Bar dock free area, lane, column | Hold the right safe area (`barDock.ts:83`, `InitiativeStrip.tsx:668-669`) | Hold it only while the map reaches the right edge |
| Side panel | Holds the right, top and bottom safe areas inside its 360 px (`Room.tsx:1284-1286`) | Unchanged. Hidden, the right safe area goes back to the map's chrome |
| Sideways sheet | Holds the right safe area inside its 340 px (`Sheet.tsx:93`) | Unchanged. Inside its 1 px borders, the 47 px inset and the body's 16 px side padding (`Sheet.tsx:108`), a panel gets 259 px, wider than the 212 px of a bottom sheet on a 320 px phone at 130%. At 480 x 320 at 130% a side sheet would be 221 px (60%) with a 140 px panel, but there the very short mode always applies (4.2): the whole width inside both insets, 275 px with no border, and a 243 px panel |

Room sets one custom property on the map's area, `--rvtt-map-safe-right`, to `env(safe-area-inset-right, 0px)` or `0px`, and the map's chrome reads it in place of `theme.safe.right`. `useSafeAreas` reports `right: 0` into `Chrome` while the side panel shows. At 932 x 430 with the panel showing that gives the map's chrome back 59 px.

### 4.4 Mockups

A computer, 1280 x 800, the side panel shown and hidden:

```
+------------------------------------------------+-----------------------+
| o Crypt  (DM)        undo redo [Goblin 2 R3] Fit| PARTY  v              |
|                                                | [Token][Init][Log] (>)|
|                                                | [Journal][Areas][DM]  |
|                    map                         | ...                   |
|                                                | Initiative            |
|                                                |  Round 3              |
| [sel][rul][area][fog][draw][ping]|[add][pin]   |  ...                  |
+------------------------------------------------+-----------------------+

+------------------------------------------------------------------------+
| o Crypt  (DM)                              undo redo [Goblin 2 R3] Fit |
|                                                                        |
|                              map                                       |
|                                                                        |
| [sel][rul][area][fog][draw][ping]|[add][pin]...            [= Panels 2]|
+------------------------------------------------------------------------+
```

`(>)` is "Hide panels". "2" is the unread badge.

A large phone held sideways, 932 x 430 at 100%, first visit (hidden, so a rail tool uses the rail):

```
+------------------------------------------------------------------------+
|     o Crypt (DM)                        undo redo [Goblin 2 R3] Fit    |
+------------------+-----------------------------------------------------+
|     Ruler: 30 ft |                                                     |
|     [Keep] [Clear|                       map                           |
|     ...          |                                                     |
+------------------+-----------------------------------------------------+
|     Select Ruler Area Fog Draw Ping | Add Pin ...          [= Panels]  |
+------------------------------------------------------------------------+
```

A phone held sideways, 844 x 390, Initiative open, then hidden:

```
+---------------------------------------------+----------------------+
| o Crypt (DM)              [Goblin 2 R3] Fit |(<) Initiative  (>) X |
|                                             | Round 3   [Next]     |
|              map                            | Goblin 2   7/7  ...  |
|                                             | Thorn     22/30 ...  |
+---------------------------------------------+----------------------+
| Select Ruler Area Fog Draw Ping ...                     [Panels]   |
+--------------------------------------------------------------------+

+--------------------------------------------------------------------+
| o Crypt (DM)                            undo redo [Goblin 2 R3] Fit|
|                                                                    |
|                         map, whole width                           |
|                                                                    |
+--------------------------------------------------------------------+
| Select Ruler Area Fog Draw Ping ...                     [Panels]   |
+--------------------------------------------------------------------+
```

`(<)` is "All panels", `(>)` "Hide Initiative", `X` "Close Initiative". Panels in the second picture brings Initiative back where it was.

## 5. The handout viewer

### 5.1 The viewer

One component, `HandoutViewer` (`features/handouts/HandoutViewer.tsx`), replaces `ZoomableImage` (`HandoutPopup.tsx:211-333`). The popup uses it for players, and the Library uses it for both roles (5.3).

- **The stage is the whole body.** The image's viewport is the dialog's body under its header (and under "The DM shows you" in the popup), not a box the size of the fitted image. At rest the image fits the stage, centered. Zoomed, it fills the stage and pans inside it. A wide map on an upright phone zooms into the screen's whole height instead of a 200 px strip.
- **Card or whole screen.** The Dialog is a card where the layout is at least `DIALOG_PHONE_MAX` (600 px) wide (`Dialog.tsx:10,77`). A sideways phone is that wide but short: at 844 x 390 the card would be 720 x 358 px, a card with a sliver of dim room around it. So the viewer is a card only where the layout is at least 600 px wide and 500 px tall, the line 3.1 draws for "short". Everywhere else it fills the screen from the start, through a new `full` prop on Dialog that gives any width the phone's whole-screen card (`Dialog.tsx:94-102`). Below, "a card layout" means the first kind.
- **Three states, on a card layout.** The viewer is in one of:
  1. **Card fit.** Today's card, up to 720 x 760 px (`Dialog.tsx:103-108`), the image fitted to its stage. Zoom out is disabled and Reset zoom hidden.
  2. **Window fit.** The card fills the window, inside the safe areas, and the image fits that larger stage, so it shows larger and whole. The first zoom step in from card fit goes here, by Zoom in, +, the wheel, or a double tap or click. Zoom out and Reset zoom both show and both go back to card fit. This is the owner's "It can start the size it is now but it should be able to be zoomed to be larger while showing more of it."
  3. **Magnified.** The card fills the window and the image is zoomed past the window's fit. Zoom out steps back toward window fit, then card fit. Reset zoom goes straight to card fit.
  
  On a whole-screen layout there is no card fit: the viewer starts at window fit, where Zoom out is disabled and Reset zoom hidden, and only magnifies.
- **A pinch never resizes the card mid-gesture.** On a card layout a pinch zooms inside the card's stage, since growing the card under two fingers would move the pinch's baseline (`zoom.ts:41-47`). When the last finger lifts with the image zoomed past card fit, the card grows to the window. The image's scale is worked out again against the window's fit, so that its box stays where it is on the screen, but never below window fit: the window fit is the floor of every expanded state (`clampView` keeps a scale of at least 1, `zoom.ts:22-26`). So a pinch that ended smaller than the window's fit, a 1.05 times pinch on a wide image whose window fit is 1.2 times its card fit, settles at window fit, centered: a documented snap. A pinch past the window's fit keeps the image's box, shifted only as far as clamping needs to leave no gap at an edge. A pinch that ends at card fit leaves the card as it is. So a touch tablet (820 x 1180) grows the card at the gesture's end, and a mouse at the first step.
- **Expand.** A header icon button, "Expand", with `aria-pressed`, on a card layout only. Pressed, it takes the card to window fit and keeps it at the window size at any zoom: Zoom out stops at window fit, and Reset zoom goes to window fit. Pressed again, it goes back to card fit. It is the one-press way to "make handout big".
- **Clamping.** Where the zoomed image is narrower or shorter than the stage, it stays centered that way. Where it is larger, it pans with no gap at its edges. `clampView` (`zoom.ts:22-26`) clamps to the stage instead of the fitted box. The zoom runs from the fit to 6 times it, as today (`zoom.ts:17`).

### 5.2 Controls and keys

- **Header**: the title, Download (the popup only, unchanged, `HandoutPopup.tsx:158-163`), Expand (a computer only), Close.
- **Over the stage, at its bottom right**: "Zoom out" and "Zoom in" icon buttons (`minus`, `plus`), 44 px, on the `overlay` fill, and "Reset zoom" beside them in the window fit and magnified states (today's button, `:326-330`). Each step past window fit is 1.5 times, about the stage's center. Zoom out is disabled only at the state's floor (card fit, or window fit on a whole-screen layout or with Expand pressed). Zoom in is disabled at 6 times the window's fit.
- **Keys**, while focus is in the viewer: + or = does what Zoom in does, − what Zoom out does, 0 what Reset zoom does, and the arrow keys pan by a tenth of the stage while magnified. The room's shortcuts never run under a modal dialog (`shortcuts.ts:390-391`), so nothing clashes. So focus never falls to the page under the viewer: a button that a step disables or hides hands focus to the other zoom button, and a control that leaves while the viewer stays (Expand when the window gets too small for a card, the zoom buttons while the next handout's image loads) hands it to a zoom button that stays, else Close.
- **Gestures**, unchanged: pinch, one finger pans once zoomed, double tap or double click, the wheel.
- **Loading**, unchanged: "Loading the image…" until the image arrives (`HandoutPopup.tsx:284`).
- **Interface size**: the dialog stays at 100% (`zoom={false}`, `:157`), so its pointer math stays in screen pixels.

### 5.3 Opening any Library image

- The Library's detail card (`LibraryGrid.tsx:208-238`) gains a small "View" button, first in its row, for every image that role's Library lists: for the DM token images, maps and handouts, for a player the token images they see. Its 96 px thumbnail opens the same viewer on a tap, as a pointer shortcut (`aria-hidden`, `tabIndex={-1}`), so "View" is the one named control and keyboard stop.
- The viewer's title is the title of a handout showing that image, or else the tile's own name: "Handout", "Map" or "Token image" (`LibraryGrid.tsx:203-206`). It has no Download: the popup's stays the players' way to save a handout, and the DM holds the images already.
- It loads the `full` variant when the row lists it, else the largest one listed (`AssetRow.variants`, `lib/api.ts:39`). The server serves an image only to a member who may see it (design 11.2), so a player sees nothing new.
- A player's "Handouts from the DM" and its Open stay as they are (`LibraryPanel.tsx:37-79`), opening the popup, which now holds the viewer.

### 5.4 Later: a document of pages

A PDF-like viewer is queued, not part of this wave: one scrolling document of pages with zoom. The viewer is built for it now. It takes `pages: { src, alt, width, height }[]` and lays them in one column with a 16 px gap. One page fits whole. Several fit the widest page's width, the wheel then scrolls (and with Ctrl, like a pinch, zooms), and the stage, the three states, Expand, the buttons and the keys work as above. The states and their steps are one pure function in `zoom.ts` (`viewerStep(state, action)`), so the later viewer reuses them too. This wave passes one page. The layout function's tests cover two pages, so the later viewer reuses it unchanged.

### 5.5 Mockups

A computer (a card layout), a handout at card fit, then after one zoom step, at window fit:

```
+--------------------------------------------------------------+
|                 (dimmed room)                                |
|      +--------------------------------------------+          |
|      | The old map           [Download] [Exp] [X] |          |
|      | The DM shows you                           |          |
|      |   +------------------------------------+   |          |
|      |   |                                    |   |          |
|      |   |            the image               |   |          |
|      |   |                         [-][+]     |   |          |
|      |   +------------------------------------+   |          |
|      +--------------------------------------------+          |
+--------------------------------------------------------------+

+--------------------------------------------------------------+
| The old map                          [Download] [Exp] [X]    |
| The DM shows you                                             |
|                                                              |
|                 the image, fitted to the window              |
|                                                              |
|                                   [-][+] [Reset zoom]        |
+--------------------------------------------------------------+
```

Here Zoom out and Reset zoom both take it back to the card.

An upright phone, a wide image zoomed in, today and new:

```
+----------------------+   +----------------------+
| The old map  [Dl] [X]|   | The old map  [Dl] [X]|
| The DM shows you     |   | The DM shows you     |
| +------------------+ |   |                      |
| | zoomed, clipped  | |   |  zoomed image, the   |
| +------------------+ |   |  whole screen high   |
|                      |   |                      |
|     (empty)          |   |                      |
|                      |   |                      |
|   [Reset zoom]       |   | [-][+] [Reset zoom]  |
+----------------------+   +----------------------+
```

The DM's Library with an image open:

```
| HANDOUTS                                   |
| [img] [img] [img]                          |
| +----------------------------------------+ |
| | [96px]  1600 x 1200 px, 410 KB. In use.| |
| |         [View]                         | |
| +----------------------------------------+ |
```

## 6. Grouping and ranking

### 6.1 How controls were ranked

Each control is ranked by how often a DM and a player reach for it in a session: **every turn**, **every scene** (a few times an hour), **a few times** a session, **once** a session, or **rarely** (setup, or something gone wrong). Then:

- **Primary**: every turn and every scene. One tap, first in its surface.
- **Secondary**: a few times. In its surface, after the primary.
- **Tucked away**: once, rarely, and anything that cannot be undone. Lower in the surface, or behind one more tap.

A move must have a clear gain: a tap or a scroll saved on something used often, or a rare or dangerous control taken out of the way of a common one. Moves that only tidy are left out. The Token and Initiative panels' insides, the token action bar and the stat block are the other two designs' (docs/design-v1-token-panel.md, docs/design-v1-combat-flow.md). The order of the token action bar's button row in particular belongs to docs/design-v1-token-panel.md, and this pass leaves it alone.

### 6.2 Surface by surface

| Surface | Today | DM use | Player use | Proposal |
|---|---|---|---|---|
| Toolbar | Select, Add token, Ruler, Area, Draw, Ping, Pin, Fog, Builder, Grid (`tools.ts:137-159` and each tool's `order`). A 390 px phone shows about six before a swipe | Select every turn. Ruler, Area every turn in a fight. Fog every scene while exploring. Ping every scene. Draw a few times. Add token, Pin, Builder and Grid in setup | Select, Ruler, Area every turn. Ping, Draw a few times | M1: the DM's play tools first, Fog fourth, then a divider and the setup tools. A player's order does not change. M10: on a touch screen from 900 px up, names under the icons |
| Top bar | Room name, chip, Undo and Redo only on a phone or touch tablet (`Room.tsx:494,850`), Phase menu (wide), turn strip, Find (player), Fit | Undo every scene. Fit every scene. Phase a few times | Find, Fit every scene | M2: Undo and Redo on every DM layout, and a wide row that gives way when it overflows |
| Panels list and side panel tabs | Token, Party, Characters, Monsters, Encounters, Initiative, Scenes, Outliner, Library, Areas, Log, Journal, DM, Menu (`panels.ts:72-88`). A sideways sheet shows three or four rows of the list (measured: 257 px tall at 844 x 390, one column), so Initiative and Log need a scroll | Initiative, Token every turn. Party, Log every scene. Journal, Areas, DM, Scenes a few times. Monsters, Encounters, Characters, Outliner, Library in setup. Menu rarely | Initiative, Token every turn. Log every scene. Journal, Areas, Characters a few times. Library, Menu rarely | M3: in-play panels first, grouped |
| DM panel | Players' view (View as a player, Party sight, Follow me, Bring everyone here, Black out), Undo, Handouts, Player link, Table display (`DmPanel.tsx:18-23`, `ViewControls.tsx:35-83`) | Handouts a few times. Follow me, Bring everyone here a few times. Black out rarely (a break). View as a player, Party sight rarely. Player link, Table display once | None | M4: Handouts first, the players' screens next, the checks after, setup last. Undo leaves (M2) |
| Scenes | All scenes, New scene, This scene (name, Fog, Starting view, Size, Background), Grid, Map image, Map phases, Vision, Movement, Map builder, Export as image, Delete (`ScenesPanel.tsx:29-34`, `SceneSettings.tsx:56-136`) | Switching and Move players every scene. Phases and Light a few times. Map image, Grid, Size, Builder, Export, Delete in setup | None | M5: the map image into "This scene", as the owner asked. Phases and Vision above Grid |
| Library | DM: Delete N not in use, Token images, Maps, Handouts (`LibraryGrid.tsx:111-174`). Player: Handouts from the DM, token images | Handouts a few times, the rest rarely. Deleting rarely | Reopening a handout a few times | M6: Handouts first, clean-up at the foot, View (5.3) |
| Journal | DM: New page, pages and folders. A page: Edit, Pin to the map, Delete, blocks (`JournalPanel.tsx:106-246`) | Reading every scene, New page a few times | Reading a few times | No change: the list leads, and the page's actions are few |
| Log | Show older, Export, Chat only, entries, composer (`LogPanel.tsx:150-170,285-326`) | Reading every scene, chat a few times, Export rarely | The same | No change. Export is one small button in a row the entries scroll under |
| Menu | X-card, Room ID and copy link, Members, Room settings (DM), This device, About, Leave room (`MenuPanel.tsx:54-89`) | Copy link once, the rest rarely | X-card any time, the rest rarely | No change. The X-card leads on purpose, for safety |
| Members | Roster, each other member's row with Kick, Remove and for a DM Remove DM in view (`MembersPanel.tsx:95-99`, `Access.tsx:68-95`), then for the DM Player link, Player password, DM devices, DM link, Delete room | The roster a few times. Kick and Remove rarely | The roster a few times | M7: Kick, Remove and Remove DM behind one Manage button per row |
| Room settings | Room name, Players, Combat, Grid and distance, Areas of effect, Backup (`SettingsPanel.tsx:43-56`) | Setup only | None | No change |
| This device, About | `ThisDevice.tsx:17-68`, `AboutPanel.tsx` | Rarely | Rarely | No change |
| Characters | New character, Long rest for the party (DM), the list, The party (`CharactersPanel.tsx:71-98`) | The list a few times, Long rest once | Their own card a few times | M8: Long rest below the list |
| Party bar and panel | Portrait, name, HP, AC and passive Perception named only in a tooltip (`PartyBar.tsx:234-243`), conditions | Every turn in a fight | Not shown | M9: the AC badge and "PP 13" |
| Monsters, Encounters, Areas, Outliner | Search or the main action first, then the lists | As the rows say | Areas a few times | No change |

### 6.3 The moves

| # | Surface | Move | Why |
|---|---|---|---|
| M1 | Toolbar, DM | New order: Select, Ruler, Area, Fog, Draw, Ping, then a 1 px divider, then Add token, Pin, Map builder, Line up grid. `order` values: Select 0, Ruler 20, Area 30, Fog 35, Draw 40, Ping 50, Add token 55, Pin 60, Map builder 80, Line up grid 90. The divider is `aria-hidden`, before the first setup tool: a line in a phone's strip, a 12 px gap between the wide toolbar's floating buttons | Fog is the DM's busiest tool after Select while exploring, and today it is eighth, past the swipe on a phone. Add token, Pin, Builder and Grid serve setup. A player's tools keep their order, and every shortcut keeps its key |
| M2 | Top bar | Undo and Redo show in a DM's top bar on every layout (`Room.tsx:494` drops `(!wide \|\| touchFirst)`). The DM panel's Undo section goes (`ViewControls.tsx:73-83`). Measured at 900 px (the widest map the side panel leaves is 540 px, the row 516 px), with Undo and Redo as a touch tablet shows them today: the dot 10, the room name 54 (down from 146), the DM chip 57, Undo and Redo 88, the turn strip 206 and Fit 44, with 12 px gaps, and no overflow. A scene with two or more phases adds the Phase menu (`PhaseMenu.tsx:20-36`, its select up to 200 px), which overflows that row, today's touch row included, since a wide row never checks (`Room.tsx:774-777`). So the overflow check that a phone's row runs (`Room.tsx:775-795`) runs on a wide DM row too: on overflow the DM chip gives way to its dot, as on a phone, then the Phase menu leaves the bar, each recorded by the width as the chip's dot is today (`dmDotUpTo`, `:771`). The scene's "Show a phase" chips in Scenes still switch phases (`PhasesSection.tsx:79-98`). From 1,000 px the measured row keeps the whole room name | A DM with a mouse undoes today through the DM tab or Ctrl+Z only. Undo is used every scene, the Phase menu a few times. The same two buttons, with the same names, keep Undo one click away, and the panel loses a third copy |
| M3 | Panels list, side panel tabs | DM: Token, Initiative, Party (phone), Log, Journal, Areas, DM, Scenes, then Monsters, Encounters, Characters, Outliner, Library, then Menu. Player: Token, Initiative, Log, Journal, Areas, Characters, Library, Menu. A phone's list shows the DM's groups under "In play" and "Prepare", with Menu after a plain divider. The wide tab row puts an 8 px gap before each group's first tab. `order` values in 6.4 | On a sideways phone the list shows three or four rows: Initiative was sixth and the Log eleventh. In play the DM looks for Initiative, the token, the party and the Log, and these come first for both roles. The group labels let a DM find setup panels without reading play ones |
| M4 | DM panel | Handouts, then "Players' screens" (the different-scene notice, Follow me, Bring everyone here, Black out players' screens), then "Check their view" (View as a player, Party sight), then Player link, then Table display | Handouts is the panel's most used tool. Black out is rare and drastic, and no longer sits under the first control. View as a player and Party sight are checks, not table actions |
| M5 | Scenes | "This scene" holds, in order: Scene name, Map image, Fog, Starting view, Size in squares, Background. The Map image section goes. Its row is a SettingRow named "Map image", whose help says "No map image yet." or the image's size, with "Add a map image" (name kept), "Replace map image" and "Remove map image" (renamed from "Replace image" and "Remove image", which no longer sit under a "Map image" label), and its warning, fog choice and status under it as today (`SceneSettings.tsx:430-453`). Then Map phases and Vision come up, above Grid: This scene, Map phases, Vision, Grid, Movement, Map builder, Export as image, Delete | The owner asked for the map image in "This scene". It decides the scene, so it follows the name. Phases and the light change during play, the grid once |
| M6 | Library, DM | Sections in the order Handouts, Maps, Token images. "Delete N not in use" and its help move to the foot, under a "Clean up" label. Every detail card gains View (5.3) | The DM comes to the Library for a handout, and a bulk delete led the panel |
| M7 | Members, DM | Each other member's row shows one small "Manage" button, named "Manage Pat", with `aria-expanded`. It opens the row's Kick, Remove and, for a DM, Remove DM, each with its confirm as today (`Access.tsx:41-100`) | The roster is for seeing who is here. Two or three danger buttons under every row made it a list of threats and pushed the player link down. One more tap guards actions that cannot be undone |
| M8 | Characters, DM | "Long rest for the party" moves below the DM's list of characters (`CharactersPanel.tsx:77`) | Used once a long rest. The list is used every time the panel opens |
| M9 | Party bar | This design owns how the party bar shows AC and passive Perception. AC becomes the shield badge docs/design-v1-token-panel.md settles, `AcBadge` at `sm` from `client/components/AcBadge.tsx`, `role="img"` named "Armor Class 15", sized to its number from 0 to 100 as that design says. Passive Perception becomes visible text, "PP 13", whose accessible text is "Passive Perception 13". Both replace the `Stat` that names its value only in a tooltip (`PartyBar.tsx:234-243`) | A tooltip must never be the only way to learn a thing, and the party bar, the tokens and the tracker then show AC one way |
| M10 | Toolbar, touch screens from 900 px up | A device whose main pointer is touch (`isCoarsePointer`, already read at `Room.tsx:193`) draws the phone's tool buttons, the short name under each icon (`Room.tsx:1125`), in the wide toolbar too, and the wide Panels button (4.1) the same way. A mouse keeps the icons alone, named on hover and to screen readers as today | From 900 px up a tool's name shows only on hover (`Room.tsx:1124,1196-1197`), and a tablet or a large phone held sideways has no hover. Fog, Builder, Grid and Pin are not icons anyone reads at a glance |

### 6.4 Order values

Token 10, Initiative 12, Party 14 (phone, DM), Log 16, Journal 18, Areas 20, DM 22, Scenes 24, Monsters 40, Encounters 42, Characters 44, Outliner 46, Library 48, Menu 90. `PanelDef` gains `group: "play" | "prepare" | "room"` (play: 10 to 24, prepare: 40 to 48, room: Menu). Only a DM's phone list draws the labels, as list items that span the grid, so the list stays one list named "Panels" and its tiles keep their names. The default side panel tab stays Initiative (`state/types.ts:157`).

### 6.5 What stays

Every control, name and role. The moves change only where things are, M7 adds one tap before an action that cannot be undone, and M2 removes a duplicate whose buttons stay in the top bar with the same names. Every shortcut keeps its key.

Interfaces:

- docs/design-v1-token-panel.md: the Token panel stays first in every order. Its contents, the token action bar (its button row's order included) and the stat block are theirs. A hidden sideways sheet (4.2) keeps the Token panel's state. The party bar shows AC with their `AcBadge` at `sm` (M9), and this design owns the party bar's look.
- docs/design-v1-combat-flow.md: Initiative is second in every order and stays the side panel's default tab. Its sticky round header lives inside the panel's own scrolling body, which a hidden sheet or side panel keeps mounted with its scroll. The turn strip's placement does not change. A sheet's body is never under 88 px: where a sideways sheet would leave less, the panel opens in the very short mode (4.2), whose body is 223 px at 844 x 390 at 130% with the band, 232 px at 667 x 375 at 130% with the band, 243 px at 480 x 320 at 100% with the band, and 169 px (147 px with the dock's buttons in a stacked header) at 480 x 320 at 130%. That doc's sticky header table reads these.

## 7. Data model and protocol

None. No op, no schema, no projection, nothing in a stored room or a replay changes. One new localStorage key, `rvtt.sidePanel` ("hidden" or "shown"), read and written in try and catch. Anything else in it reads as no value.

## 8. Edge cases and states

### 8.1 By size

Numbers are layout px. "Rail" means the rail is allowed there, for the multi-row tools, while Select several, Ping, Pin and Add token stay at the foot unless the row says one wraps (3.1). The free area is the bar dock's, with a rail tool active. "Cards" is the alerts column's card width (3.5). "Panel" is the width a panel's body gets inside a sheet's padding (4.3).

| Size and interface size | Insets (left, right, bottom) | Options | Map left with a rail tool | Turn strip | Token bar and alerts with a rail tool | Notices | Panels |
|---|---|---|---|---|---|---|---|
| 390 x 844, 100% | 0, 0, 34 (47 top) | Foot | As today | Band | As today: spans | As today | Bottom sheet. No Hide |
| 390 x 844, 130% (300 x 649) | the same | Foot | As today | Band | Spans | As today | Bottom sheet |
| 844 x 390, 100% | 47, 47, 21 | Rail, 295 | 549 x 256 (band: 208) | In the bar (measured), else band | Free 486 x 240: dock. Lane stacked, or the summary row (486 − 312 is under 230). Cards 300 | Span the free area, right of the rail, "Viewing as Pat" too | Sideways sheet with Hide, one-row header, panel 259. Body 201 px (153 with the band) |
| 844 x 390, 130% (649 x 300) | 47, 47, 21 | Rail, 295. Pin wraps at the foot, so it uses the rail | 354 x 166 (band: 118) | In the bar (measured), else band | Free 291 x 150: dock. With the band 291 x 102: compact over the toolbar. Cards 291 | Span the free area, right of the rail | Sideways sheet with Hide, one-row header, panel 259, body 111 px. With the band the body would be 63, so the very short mode: the whole screen, body 223 |
| 667 x 375, 100% | 0 | Rail, 248 | 419 x 262 (band: 214) | In the bar (measured) | Free 403 x 246: dock. Cards 300 | Span the free area, right of the rail | Sideways sheet with Hide, one-row header, panel 306. Body 207 px (159 with the band) |
| 667 x 375, 130% (513 x 288) | 0 | Rail, 248. Pin wraps at the foot, so it uses the rail | 265 x 176 (band: 128) | In the bar (measured) | Free 249 x 160: dock. With the band 249 x 112: compact. Cards 249, summarized or not | Span the free area, right of the rail | Sideways sheet (308, its 60% cap) with Hide, one-row header, panel 274, body 120 px. With the band the body would be 72, so the very short mode: body 232 |
| 932 x 430, 100%, side panel hidden (the default here) | 59, 59, 21 | Rail, 307 | 625 x 296 | In the bar (wide) | Free 550 x 280: dock. 550 − 312 = 238, so beside the column when it must. Cards 300 | Span the free area, right of the rail | "Panels" in the toolbar |
| 932 x 430, 100%, side panel shown | 59, 0 for the map, 21 | Foot, floating | As today, 572 wide | In the bar | Free from the map less the left inset: about 497 wide | As today | Side panel with Hide panels, one row of tabs, party bar folded unless stored open: a body of about 250 px |
| 932 x 430, 130% (717 x 331) | 59, 59, 21 | Rail, 307 | 410 x 197 (band: 149) | In the bar (measured) | Free 335 x 181: dock. Cards 300 | Span the free area, right of the rail | Sideways sheet with Hide, one-row header, panel 247. Body 142 px (94 with the band, still a sheet) |
| 480 x 320, 100% | 47, 47, 21 | Foot | As today | As today | As the bar dock design | As today | Sideways sheet (288) with Hide, one-row header (239 px inside), panel 207, body 131 px. With the band the body would be 83, so the very short mode: body 243 |
| 480 x 320, 130% (369 x 246) | 47, 47, 21 | Foot | As today | As today | As the bar dock design (compact) | As today | Always the very short mode: a side sheet's body would be 35 px (no band) or less. The whole screen, panel 243, one-row header and a body of 169 px, or with a token selected or an alert the dock's buttons join the header, which stacks, and the body is 147 |
| 320 x 480, 100% | 0, 0, 34 (44 top) | Foot | As today | Band | As the bar dock design | As today | Bottom sheet |
| 320 x 480, 130% (246 x 369) | 0, 0, 34 (44 top) | Foot | As today | Band | As the bar dock design | As today | Bottom sheet |
| Tablet upright, 820 x 1180, 100% and 130% | 0 | Foot | As today | Band | Dock | As today | Bottom sheet (under 900) |
| Tablet sideways, 1180 x 820, 100% (908 x 631 at 130%) | 0 | Foot, floating | As today | In the bar | Dock | As today | Side panel with Hide. Not short, so it starts shown |
| Computer, 1280 x 800, 100% and 130% | 0 | Foot, floating | As today | In the bar | Dock | As today | Side panel with Hide, starts shown |
| Computer window 1280 x 480 | 0 | Rail | 1032 x 367, as the side panel starts hidden here (short). Shown, 672 x 367 | In the bar | Dock | Beside the lane | Side panel with Hide, starts hidden |

### 8.2 By state

- **Each tool.** Ruler, Area, Draw, Fog, Map builder (every mode) and Line up grid: in the rail wherever it is allowed (3.1), their content unchanged and scrolling inside it. Ping, Pin and Add token: at the foot, one row, unless their row wraps at that width, which a record keeps (3.1). Select with Select several on: always at the foot (3.4). Select without it: no options, as today. A tool whose options are loading or failed shows its LoadBoundary notice in the rail as in the bar. A player whom the DM has not let draw has no Draw, as today.
- **A fight with the turn band.** The band sits under the top bar across the whole width. The rail starts under it. The rail's height loses 48 px, and its content scrolls sooner.
- **A lasting notice** (offline banner, a layer that did not load, the frame bar, "Viewing as Pat"). It lies over the map under the top bars, above the rail in the stacking (z 20 over 14), placed in the free area so it never covers the rail. "Viewing as Pat", drawn by PlayerPreview, gets the free area's box from Room while a rail shows (3.6). The column starts below the lasting notices as the bar dock design says.
- **The docked token bar.** Lives in the free area right of the rail. Its stored spot's corners are the free area's, so a bar stored at the bottom left sits right of the rail, and goes back to the screen's corner when the rail goes.
- **The compact token bar.** Its overlay takes the free area's right, never the rail. Where it covers the toolbar (bar dock 1.4), the rail still shows above the toolbar's line, and the tool button under the overlay comes back on Close.
- **Alerts in the lane.** The lane is the free area's right, as before. The cards, the summary rows and the shadow padding stop at the rail's edge (3.5), at least 232 px wide, whether the token bar is open or not, and whether the column is summarized or opened from its summary row. The summary row's lowest place is the toolbar's top with a rail.
- **An open sheet.** Hides the rail and the foot bar alike. A hidden sheet shows them again. A sideways sheet whose body would be under 88 px opens in the very short mode instead (4.2): over the whole screen, the bars and the rail included, with the token bar and the alerts folded into its header, and the alerts' status region and the toasts moved inside it.
- **A hidden sheet or side panel.** Counts as closed for everything over the map (4.2), and focus goes to Panels as it hides. A hidden sheet's dialog is closed and never modal, so the map's shortcuts, Escape and Back act on the room at once, and Panels opens it again in the mode the screen calls for then, with its draft.
- **The band flipping while a sheet shows.** At 844 x 390 and 667 x 375 at 130% and at 480 x 320 at 100% a fight starting or ending, or a player's End turn overflowing the bar, switches an open sideways sheet between the side and the very short mode. The same `<dialog>` closes and opens again in the other mode: the panel is not remounted, its draft and scroll stay, and focus stays on its element.
- **Shortcuts and Escape.** In the bottom and side modes, as today: the room's shortcuts work and Escape closes the sheet first. In the very short mode the room's shortcuts are off, as under any modal, and Escape is the dialog's own, which closes the sheet. A toast, an alert, "Your turn" or a room notice that arrives meanwhile shows and is announced inside the sheet, and a preview's "Viewing as Pat" stays above it with its Exit. A Journal page open in it is not marked read while hidden, so a page the DM edits meanwhile counts as unread on Panels (4.2, "Read only when seen").
- **The side panel hidden or shown.** Section 4.1, and the 932 x 430 rows above. Hiding it while a rail tool is active can move the options from the foot to the rail, and showing it moves them back. The tool's state lives in the scope, so its draft survives.
- **Roles.** The DM has every tool and panel. A player has Select, Ruler, Area, Draw when allowed, and Ping, all of which use the rail the same way, and the player's panels. The DM's "view as a player" preview reads the side panel's key and writes nothing (4.1), and answers no shortcut, S included (`shortcuts.ts:391`).
- **The handout viewer** at every size: on a layout under 600 px wide or under 500 px tall it fills the screen from the start, with no Expand and no card fit. On a card layout (a tablet, a computer) it starts as a card, grows on the first zoom step or at a pinch's end (a small pinch settling at the window's fit), and Zoom out or Reset zoom takes it back (5.1). No state shows the image under the window's fit once the card has grown. During an X-card a popup waits as today (`handouts.ts:44-46`). In a blackout a player has no room and no popup (`Room.tsx:466`).
- **Interface sizes** 85% and 115% fall between the rows above. The rail's rule reads layout px, so a larger size can switch the rail off where the map would get too narrow.
- **Rotating** with a rail tool active: the options move between the rail and the foot. A hidden sheet stays hidden. The side panel's choice holds whenever the layout is wide again.

### 8.3 Self-review against this matrix

Checked before commit, and again after the design review's round 1. Each state above has a rule. Two places in the bar dock design read "the options" as the foot bar: its compact overlay "covers only the Select several bar", which stays true because Select several never moves to the rail, and its short screen summary row "stops at the active tool's options", which 3.5 restates for the rail. The free area's corners move with the rail, so a stored bar spot follows its corner (8.2). Round 1 found three things over the map that sized themselves from the map rather than the free area: the alerts column's cards, its summary rows and shadow padding, and "Viewing as Pat". Each now stops at the rail (3.5, 3.6). Every other thing drawn over the map was checked for the same: the roll card at a narrow screen's foot (3.6), notices (3.6), the token bar (the free area), the panes anchored to the map (`insets.left`), the scene loading notice (the insets) and the dock row (portrait only, no rail). The roll card's left edge is the one change in the rolls code, and it is a position only. Every width in this document is now taken inside borders, safe areas and padding (4.3, 8.1). Round 4 found what the browser itself does to a dialog (its own focus moves on `show()` and `close()`, and a close with no `cancel`), and the notices still outside the modal. The hook now answers each, and every room notice and the preview's notice reach the modal's slot (4.2). Round 3 found that a sheet hidden or switched between modes kept a modal's marks, and that the modal hid the room's announcements and toasts. The sheet is now one `<dialog>` that opens, closes and switches without remounting, modal only while it shows in the very short mode, and the status region and new toasts render inside it while it does (4.2). Round 2 found the same for heights: a stacked header could eat a short sheet's body. Every sheet height in 8.1 is now worked out with the top bar, the band when it is one, the toolbar and the home-bar inset, and each one either leaves a body of 88 px or more or takes the very short mode, which leaves at least 147. The one-row tool's first wrap is decided before paint (3.1), and a pinch's end can no longer ask for a scale under the window's fit (5.1).

## 9. FEATURES.md

In "Phones, tablets and connection":

- "On a phone, panels open as sheets from the bottom, and the toolbar names each tool under its icon. On a screen 900 px or wider, panels are tabs in a side panel." becomes: "On a phone, panels open as sheets from the bottom, and the toolbar names each tool under its icon, as it does on any touch screen. On a screen 900 px or wider, panels are tabs in a side panel. Hide panels at the end of its tabs, or the S key, hides it, and Panels in the toolbar brings it back. This device remembers the choice. A short screen, such as a large phone held sideways, starts with it hidden, and shows its tabs in one row that scrolls. On a phone held sideways, Hide in a panel's header tucks the panel away with its place kept, and Panels brings it back. Where the screen is too short for a panel beside the map, it opens over the whole screen, with the token's actions and the fight's alerts as buttons in its header."
- New, after it: "On a short screen held sideways, such as a phone, a tool whose options take more than one row opens them in a column on the left of the map that scrolls, so the map keeps its height. Select several, Ping, Pin and Add token keep their one-row bar at the bottom, unless the screen is too narrow for it to stay one row."
- New, after that: "Panels are listed with the ones used in play first. A DM's phone list groups them under In play and Prepare."

Elsewhere:

- DM tools: "Undo and Redo for the DM's changes, each saying what it took back. On a phone or a tablet they sit in the top bar." becomes "Undo and Redo for the DM's changes, each saying what it took back. They sit in the top bar."
- Log, chat and handouts: the Handouts line's "Players can zoom in" becomes "Players can zoom in with a pinch, a double tap, the wheel, the zoom buttons or the + and − keys. Zooming uses the whole popup. On a tablet or a computer the popup starts as a card, and zooming in opens it to the whole window, at once with a button, a key or the wheel, or when a pinch ends. A small pinch then settles with the whole picture fitted to the window. Zoom out or Reset zoom brings the card back, and Expand opens it to the window without zooming. On a phone it fills the screen from the start."
- Images and art, after the library line: "View in an image's details opens it large in the same viewer, so the DM can look at any handout, map or token image, and a player at any token image they can see. The DM's library lists handouts first."
- Scenes and maps: before "Changing the map image of the scene the players are on asks first", add "A scene's map image is added, replaced or removed in its This scene section."
- Rooms and joining: the kick line gains "On Members, Manage on a member's row holds Kick and Remove."
- Keyboard shortcuts: a new row, S, "Hide or show the side panel", everyone.
- DM tools, the Party bar line: its AC shows on the same shield as the tokens' and its passive Perception as "PP 13".

## 10. Tests

Unit tests, `node:test`:

- New `client/pages/optionsPlace.test.ts`: every row of the table in 3.1, the boundary at exactly half and one pixel over, a height of 499 and 500, a square layout. Each multi-row tool in the rail where it is allowed. Ping, Pin and Add token at the foot, and in the rail once a wrap is recorded at a width, until the layout is wider than the record. The record is made from tops read in a layout effect. Select several at the foot always, a record or not.
- `client/canvas/barDock.test.ts`: `freeArea` with a rail, with a rail and a sheet, with the right safe area off while the side panel shows. The column's card width and shadow allowance with a rail at 667 x 375 and 844 x 390 at 130% (249 and 291), at the 3.1 worst case (232), and with no rail (300, as today). `barMode` and `shareLane` at 844 x 390 and 667 x 375 at 130% with a rail, band or not, against the numbers in 3.5 and 8.1. `noticePlace` and the spanning notice's left with a rail. A stored bottom-left spot sits right of the rail.
- `client/state/store.test.ts`: `openPanel` clears both hidden states. `closeSheets` and `showPanelList` clear `sheetHidden`, and `showPanelList(true)` drops a hidden panel. `sheetOpen` is false for a hidden sheet. `panelView(local, wide)` for each case: no panel, a shown sheet, a hidden sheet, the list, and wide with the side panel shown and hidden, giving the mounted panel, whether it shows, and the Token panel shown or not. Crossing 900 px both ways with a hidden sheet and with a hidden side panel.
- A new `client/pages/sidePanel.test.ts`: reading `rvtt.sidePanel` with "hidden", "shown", nothing, a bad value and a throwing storage, and the short-screen default worked out once: a later resize across 500 px tall leaves it as it was. The preview never writes.
- `client/features/handouts/zoom.test.ts`: clamping to the stage, centered when smaller across or down, no gap when larger. The pages layout with one and two pages. The step about the center. `viewerStep` through every state of 5.1: from card fit, Zoom in goes to window fit, and then Zoom out and Reset each go back to card fit. From magnified, Zoom out steps to window fit, then card fit. With Expand pressed, Zoom out stops at window fit and Reset goes there. On a whole-screen layout there is no card fit. A pinch's end past card fit goes to the window: past the window's fit with the image's screen box unchanged (save for edge clamping), and below it, as a 1.05 times pinch on a wide image whose window fit is 1.2 times its card fit, at window fit and centered. No state has a scale under the window's fit once expanded. A pinch that ends at fit stays a card.
- `client/state/shortcuts.test.ts`: S toggles from 900 px up, by its key and by its physical code on another layout, and does nothing below, in a text field, under a dialog or in a preview.
- `client/components/sheetCap.test.ts`: the stacked header below 200 px of header width (192 with actions), one row at 200, and five buttons stacking at 275 px, from the sheet's width, the insets and the borders where the mode draws them. A new `client/lib/modalDialog.test.ts` case, or the hook's own test, for `useSheetDialog`'s plan from `shown` and `modal`: open as `show()`, open as `showModal()` with `aria-modal`, close with `aria-modal` removed, and a switch of mode as `close()` then the other open, keeping the focused element. A native `close` the hook did not ask for calls `onCancel` and removes `aria-modal`, while its own marked closes (Hide, a switch, Close) do not call it. Focus after `show()` returns to the element noted before, unless a request is pending. `sheetMode` for every sideways row of 8.1, band or not: "full" exactly where the body would be under 88 px (844 x 390 and 667 x 375 at 130% with the band, 480 x 320 at 100% with the band, 480 x 320 at 130% always), "side" at 88 and above (932 x 430 at 130% with the band, 94).
- `client/components/Dialog.test.ts`: the `full` card at a width over 600 px.
- `client/features/panels.test.ts` (new if absent): the DM's and the player's orders and groups, phone and wide.
- `client/features/tools.test.ts` (new if absent): the DM's tool order and where the divider falls, and a player's order unchanged.

e2e, one file after another as docs/design-v1-visual.md 5.3 says:

- New `e2e/layout.e2e.ts`, on E2E_PORT plus 11 (plus 8 is the bar dock's `reach.e2e.ts`), run after the other files like them:
  1. 844 x 390 at 100% and 130% with 47, 47 and 21 px insets, and 667 x 375 at 100% and 130%, for the DM and a player: each multi-row tool puts its options in the rail, a `role="toolbar"` named "<tool> options" whose box lies left of the map's middle, starts under the top bars, ends at the toolbar's top, and never scrolls sideways (`scrollWidth <= clientWidth`). Every control in it scrolls into view and takes a tap. Select several, Ping and Add token keep their one-row bar at the foot, every control at one top. Pin is at the foot at 100% and in the rail at 130%. At 844 x 390 at 130% with no record stored, Pin is picked for the first time while a `requestAnimationFrame` loop in the page logs where its options toolbar stands in every frame: no frame shows it at the foot. The map's height between the bars equals the measured one in section 2.1 without the options.
  2. 480 x 320 at 100% and 130%, 390 x 844 and 1280 x 800: the options stay at the foot.
  3. With a rail tool and a fight with concentration prompts and a roll waiting, at 844 x 390 and 667 x 375 at 130%: the column's cards, its summary row and the rail never intersect, with the token bar closed, with it open, with the column summarized, and with it opened from its summary row. Every card's buttons take a tap at their centers. A spanning notice starts right of the rail. In a DM's "view as a player" at 667 x 375 at 130% with a rail tool, "Viewing as Pat" never intersects the rail. A player at 667 x 375 at 130% sees the roll card right of the rail.
  4. Fit with a rail tool leaves no part of the scene under the rail.
  5. 1280 x 800: Hide panels hides the side panel and focus is on Panels, the map widens, Panels shows the unread badge after a chat message arrives, and a press brings the side panel back on its tab with focus on that tab. S does the same both ways: from a focused tab it hides and focus goes to Panels, and from a focused Panels it shows and focus goes to the tab, with no token bar or roll card in the room. A reload keeps the choice in `rvtt.sidePanel`. Details in the token bar shows a hidden side panel on the Token tab. A half-typed Log message survives a hide and a show. A player with a journal page open hides the side panel, the DM edits that page, and the player's Panels badge counts it until the side panel shows again.
  6. 932 x 430 at 100% with 59, 59 and 21 px insets, no stored choice: the side panel starts hidden and a rail tool uses the rail. Shown, the top bar's and the toolbar's right padding drop the 59 px inset, the options go to the foot, the tabs are one row that scrolls with the chosen tab in view, the party bar is folded, and the DM's Initiative body is at least 200 px tall with Next in view. Left, Right, Home and End move along the scrolled tabs.
  7. 844 x 390: a tap on the turn strip opens Initiative's sheet, and focus stays on the strip. Its Close, with a token selected, leaves focus on the token bar's frame, as today. Initiative's sheet, scrolled down, then Hide Initiative by keyboard: the sheet is gone, focus is on Panels, the options and the lane come back, the docked token bar's right edge and the column's agree, Escape does not reopen or close anything of it, Panels brings it back scrolled where it was with focus on its title. With a group held under Select several and the Token sheet hidden, Escape ends the mode. Close then Panels opens the list. Turning upright keeps it hidden, and Panels shows it as a bottom sheet. A player hides a sheet holding an open journal page, the DM edits that page, and the badge counts it. Then the very short mode: at 480 x 320 at 130% with 47, 47 and 21 px insets, and at 844 x 390 at 130% with a room name long enough to put the strip in a band, Initiative opens over the whole screen, above the band and the toolbar, as a `dialog` with `aria-modal="true"`. Back, Hide and Close are each at least 44 x 44, inside the sheet, apart from each other and from the title, and each takes a tap at its center. A control in the body (Next) is in view and takes a tap with the band present. Tab stays inside the sheet. With a token selected and a concentration check waiting, "Show Thorn actions" and the alerts summary sit in the header (stacked at 480 x 320 at 130%), each takes a tap, and a new alert updates the status region. A new concentration check while it is open puts its text in a status region inside the dialog, which is in the accessibility tree, and a refusal shows its toast inside the dialog, reachable and read out, and is not announced again after the sheet closes: from the Log open in the sheet, a whisper sent to a member another DM device has just removed, which the server refuses. Escape closes it. Opened again, Escape pressed twice with no tap between closes it as well: the panel is closed in the room's state and no element keeps `aria-modal`, with the native dialog closed. With the Log open in it, a player whose turn the DM starts gets "Your turn" in an assertive status inside the dialog, and with the page taken offline (`context.setOffline(true)`) the connection banner shows inside the dialog. A map layer whose image request the test aborts shows its notice inside the dialog. In a DM's "view as a player" at 480 x 320 at 130% with a panel open in the very short mode, "Viewing as Pat" is visible above the sheet's content and its Exit takes a tap and leaves the preview. Opened again with a half-typed Log message, Hide hides it: focus is on Panels, no element has `aria-modal`, an arrow key nudges a selected token and R picks the Ruler, and Escape lets go of the token. Panels then shows it modal again with the draft. At 844 x 390 at 130%, with Initiative open as a side sheet, focus on a field and a half-typed value, the fight's turn band appears (a long room name and the player's End turn): the sheet becomes modal on the same element, the field keeps focus and its value, and when the band goes it becomes a side sheet again the same way.
  8. The handout viewer: at 1280 x 800 a player's popup, one wheel step in, and the card takes the window. Then Zoom out at once goes back to the card, and again with Reset zoom. Zoom in, Zoom out and Reset zoom by keyboard, and + − 0 and the arrows. Expand without zoom, and Zoom out stopping at the window while it is pressed. At 844 x 390 with insets the popup fills the screen from the start, has no Expand, and Zoom in magnifies. At 820 x 1180 a two-finger pinch keeps the card's size until the fingers lift. A 2.5 times pinch then fills the window and the image's box moves less than 2 px. A 1.05 times pinch on a wide image fills the window and the image settles fitted to it, centered, with Zoom out and Reset zoom showing. At 390 x 844 a wide image, zoomed in, fills more than 80% of the stage's height. The DM's Library: a handout's View opens the viewer with its title, a map's with "Map". A player's token image opens too. No Download in the Library viewer.
  9. The moves: the DM's toolbar order with Fog fourth. Undo and Redo in a DM's top bar at 1280 x 800 with a mouse, and no Undo section in the DM panel. At 900 x 800 with a two-phase scene the DM's top bar row does not overflow: the chip shows its dot and the Phase menu leaves, and Fit and the turn strip stay inside the row. The Panels list's order for both roles and the DM's group labels. The DM panel's section order. Scenes: "Add a map image" inside "This scene", right after the name. Library: Handouts first. Members: Manage opens Kick and Remove. Characters: Long rest below the list. Party bar: an `img` named "Armor Class 15" and the text "PP 13". At 932 x 430 with touch, the toolbar shows each tool's name under its icon.
- Existing files: `e2e/desk.e2e.ts:344,358` finds "Add a map image" in the "Map image" section, and moves to "This scene". The tab order checks (`desk.e2e.ts:170,243`) follow the new order. Tests that press Kick or Remove press Manage first. `playerphone.e2e.ts:405,527` and `display.e2e.ts:319` find tiles by name in the "Panels" list, which stays one list. `bardock`, `dmphone`, `playerphone` and `fold` run unchanged at their sizes for the Select tool, and the bar dock cases that open a rail tool are covered by case 3 above. `size.e2e.ts` checks the Dialog contract, which the viewer keeps.
- Browsers: the e2e runs in Chrome only. That a `hidden` sheet or side panel keeps its scroll and a half-typed draft is checked there and not in iOS Safari, which the build checks by hand on a phone before it merges.

## 11. Build plan

Four parts, each its own commits, in this order: part 2 reads the side panel's state from part 1, and parts 3 and 4 edit `Room.tsx` and `LibraryGrid.tsx` after the parts before them.

1. **The side panel and the sheet** (section 4).
   - `client/state/types.ts`, `client/state/store.ts`, and the preview's copy in `client/features/dm/preview.ts:102-105`: `sidePanelHidden`, `sheetHidden`, `sheetOpen` with the hidden sheet, `panelView`, `openPanel` and the closes clearing them, and the 900 px crossing. `client/pages/sidePanel.ts` (new) for the key and its default, with its test.
   - `client/pages/Room.tsx`: Hide panels, the hidden side panel, the short side panel's one-row tabs, the wide toolbar's Panels, `togglePanels` with a hidden sheet, focus on Hide and on Show, and every reader of `local.panel` through `panelView` (`:260`, `:263`, `:281`, `:291`, `:307-310`, `:318`, `:358`, `:572`, `:580`), `mapWidth`, the `--rvtt-map-safe-right` property and its readers (top bar, toolbar, options).
   - `client/components/Sheet.tsx`, `client/components/SheetHeader.tsx`, `client/components/sheetCap.ts`: the sheet as one `<dialog>` with its inner section kept, `onHide` for a sheet on the right, the stacked header, `sheetMode`, and the three modes.
   - `client/lib/modalDialog.ts` and its test: `useSheetDialog`, beside `useModalDialog`, which is unchanged: open, close and switch on `shown` and `modal`, the native `close` fallback with its own closes marked, focus kept after `show()` and held on close.
   - `client/pages/fold.ts` and `client/pages/Room.tsx`: the very short mode folds the token bar and the column and puts the dock's buttons in the header, as an upright sheet does.
   - `client/pages/RoomDock.tsx` (`FoldStatus`) and `client/pages/Room.tsx` (`Toasts`, `Banner`, `FrameViewBar`, `QuietLoadNotice`): their output through a portal into the modal sheet's slot while it shows, `FoldStatus`'s region empty after a move, and each toast kept where it first showed. `client/features/encounter/InitiativeStrip.tsx`: "Your turn" into the same slot. `client/features/dm/previewContext.ts` and `PlayerPreview.tsx`: the slot handed to the preview's notice.
   - `client/features/panels.ts` (`PanelProps.shown`), `client/panels/Panels.tsx` (`PanelBody` passes it), `client/features/journal/JournalPanel.tsx` (the page marks itself read only while shown).
   - `client/pages/RoomDock.tsx` (`useSafeAreas` right side), `client/features/select/SelectOptions.tsx` (`mapWidth`, and the safe sides out of the wide bar's padding), `client/features/party/PartyBar.tsx` (folded at first on a short layout), `client/features/encounter/InitiativeStrip.tsx` (the column's right padding through the property).
   - `client/state/shortcuts.ts`: S.
   - Commits: `feat(ui): hide and show the side panel, remembered on this device`, `feat(ui): hide a sideways sheet and bring it back with panels`, `fix(ui): the map's chrome pads for the right safe area only where it reaches the edge`.
2. **The rail** (section 3).
   - `client/pages/optionsPlace.ts` (new) and its test.
   - `client/pages/Room.tsx`: `OptionsBar` as a rail or at the foot, the one-row tools' wrap record read in a layout effect before paint, its measured width into `Chrome.rail` and `insets.left`, the spanning notices' left, and a box for "Viewing as Pat" while a rail shows (`:397-406`).
   - `client/features/encounter/InitiativeStrip.tsx`: the column's card width, summary rows and shadow allowance stop at the rail (`:668-681`).
   - `client/canvas/barDock.ts` and its test: `Chrome.rail`, the free area's left.
   - `client/features/tools.ts`: `optionsAt: "foot"` on `selectTool`, and in `pings/PingTool.tsx`, `pins/PinTool.tsx` and `tokens/placeTool.tsx`.
   - `client/features/rolls/PlayerRolls.tsx`: the foot card's left.
   - `client/canvas/TokenActionBar.tsx`: `ScrollForMore` (`:750`) gains a `fill` prop, `surface` by default. The rail imports it. No new file.
   - Commit: `feat(ui): tool options in a rail on short sideways screens`.
3. **The handout viewer** (section 5).
   - `client/features/handouts/HandoutViewer.tsx` (new), `zoom.ts` and its test, `HandoutPopup.tsx` using it.
   - `client/components/Dialog.tsx`: a `full` prop that gives any layout the phone's whole-screen card, for a short layout and for the viewer's window states.
   - `client/features/images/LibraryGrid.tsx`: View, the thumbnail's tap, and (M6) the section order and the clean-up at the foot.
   - Commits: `feat(handouts): a viewer that zooms over the whole popup and grows to the window`, `feat(library): view any library image large`.
4. **The moves** (section 6).
   - M1 `client/features/tools.ts` and the tools' `order` (`placeTool.tsx:52`, `fog/tool.tsx:92`), the divider in `Room.tsx` Toolbar. M2 `Room.tsx:494` and the wide row's overflow check (`:771-795`), `features/dm/ViewControls.tsx`. M3 `client/features/panels.ts`, `Room.tsx` PanelPicker and SidePanel. M4 `client/panels/DmPanel.tsx`, `features/dm/ViewControls.tsx`. M5 `client/features/scenes/SceneSettings.tsx` (MapSection into "This scene", the new names, and the sections' order). M6 is in part 3. M7 `client/panels/MembersPanel.tsx`. M8 `client/features/tokens/CharactersPanel.tsx`. M9 `client/features/party/PartyBar.tsx`. M10 `Room.tsx` Toolbar (`touchFirst` into `ToolButton`'s content).
   - One commit per move, such as `feat(ui): fog and the play tools first in the dm's toolbar`, `feat(scenes): the map image in this scene`.
- Then the e2e files of section 10, FEATURES.md as in section 9, and a line in docs/design-v1-visual.md 3.4 and 3.2 that points here for the rail and the side panel.
- Files the other two builds also edit. Whichever build lands second keeps the other's change:
  - `client/canvas/TokenActionBar.tsx`: this design adds a `fill` prop to `ScrollForMore`. docs/design-v1-token-panel.md rewrites the bar's summary and rows, and docs/design-v1-combat-flow.md adds Revive and Dismiss.
  - `client/features/party/PartyBar.tsx`: this design's M9 and the short-screen fold default. docs/design-v1-token-panel.md moves the shield path into `AcBadge.tsx`, which M9 then uses.
  - `client/features/tokens/CharactersPanel.tsx`: this design's M8 moves Long rest. docs/design-v1-combat-flow.md adds companions to the character card.
  - `client/pages/Room.tsx` and `client/components/Sheet.tsx`: docs/design-v1-combat-flow.md publishes the scrolling bodies' padding as CSS variables (its build step 3). This design adds Hide, the hidden state, the stacked header and the side panel's changes.
- Ports: `e2e/layout.e2e.ts` runs on E2E_PORT plus 11, since `e2e/reach.e2e.ts` took plus 8. The combat flow and token panel builds take plus 9 and plus 10 for their own e2e files, so the three never share a port.

## 12. Decided

The project owner answered on 2026-10-15.

1. **The rail's side.** Left, decided by the project owner. The fight alerts, the docked token bar, the panels' sheet and the Panels button stay on the right, and the rail sits over the tool buttons (3.2).
2. **The side panel on a short screen.** It starts hidden on a short layout, such as a large phone held sideways, until this device stores a choice (4.1). Settled by default.
3. **One-row tools** (D6). Only tools whose options run past one row use the rail. One-row tools (Select several, Ping, Pin and Add token) stay at the foot, where they cost less map, and move to the rail only at a width where their row wraps (3.1, 3.4). Settled by default.
4. **The Library viewer.** View works on every image in the Library, for both roles: handouts, maps and token images for the DM, the token images a player can see (5.3). Settled by default.
5. **The panels' new order** (M3) is taken now, while the group's habits are new. Settled by default.
