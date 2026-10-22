# raccoon-vtt v1: tool options in one row

Status: draft 1, for design review, with the project owner's answers of 2026-10-16 (section 17). Code is cited from public main at `e4ec8696`. This design builds on docs/design-v1-layout-hierarchy.md and docs/design-v1-bar-dock.md, and replaces the first one's section 3 (the rail). Their other rules stay, and section 10 says exactly what each rule that read the options' box does after.

The project owner's feedback after the first real session (2026-10-15): the tools' options took too much height, worst on a phone held sideways, and Draw and Area were the worst of them. Players on phones come first. The DM plays on a computer. The project owner then chose a direction from a visual design handoff: its Turn 2, frames 2a to 2d, "one row of options, everything else one tap away". This document keeps that direction's structure and behavior and makes it buildable here: every control the code has today gets a home, the fit and the popovers get exact rules, and every part of the page that reads the options' box is told what it reads now.

Two notes on names. The project owner renamed "Select several" to "Multi-select" on 2026-10-16, so this document calls the mode and its bar Multi-select. The rename itself (the token bar's button, the bar's words, the tests that find them) is its own change. A parallel design, docs/design-v1-token-window.md, changes the docked token bar: it removes Move bar and Reset bar position, adds a reset icon to the bar's header and lets the docked bar be resized on a computer. Nothing here depends on the bar's size or on those buttons. The bar reads the free area, and this design only changes how tall the options are.

Every size is in layout px, the chrome's own (`features/device/layout.ts`): the window divided by the interface size. A safe area counts at its full size, as in the two designs above. "Sideways" means wider than tall. "Short" means under 500 px tall (`SHORT_LANDSCAPE_MAX`, `features/encounter/band.ts:18`). "Wide" means 900 px or wider (`theme.layout.wideMinWidth`). "The phone layout" means under 900 px. "Room" means the width a row may use for its controls. Widths quoted from today's controls were measured on the dev fixture room at 100% (section 3.4). They illustrate the rules, and no rule depends on them: the build measures the real controls.

## 1. Summary

- **One row.** Every tool's options are one row of 44 px controls. On an upright phone it stands on the toolbar and is 53 px tall. On a phone held sideways it stands inside the toolbar's own row, beside the tools, and costs no height at all. On a computer it floats above the toolbar at the left. It never wraps and never scrolls.
- **Priorities and ⋯.** Each control has a priority. The row shows what fits its room, highest priority first, keeps the controls in their display order, and puts the rest behind ⋯ ("More options"). A wider screen shows more inline. Every control is drawn in exactly one place at a time: the row, ⋯, or the popover of the chip it belongs to.
- **Value chips and popovers.** A choice with many values (the drawing tool, a color, the stroke, an area's shape, a builder mode) is a chip that shows its value. A tap opens a small popover above the row. Popovers are non-modal: two fingers still pan and pinch the map under them.
- **The line.** The hint or reading floats above the row as a one-line pill. It takes no height from the map. When its words are cut, a tap shows them all.
- **The toolbar.** A DM's phone toolbar groups the four setup tools behind Setup, so it fits a 390 px phone without scrolling. On a short sideways screen where the tools and the options do not share one row, the toolbar shows Select and the last tool used, whose second tap opens every tool. Where even that leaves the options too little room, as on a 480 x 320 phone, the row stands above the toolbar as on an upright phone. Keys pick any tool directly, as today.
- **Tuck.** A second tap on the active tool's own button hides its options, and a third brings them back.
- **What goes.** The rail (`pages/optionsPlace.ts`, `Chrome.rail`, the map's left inset), the one-row tools' wrap record, the options' height cap and their scrolling, the Area, Fog and Line up grid More toggles, the compact stamp bar with its modal Tint and More sheets, and Multi-select's 600 px hint rule. Section 10.
- No op, no schema, no protocol change, no new localStorage key.

## 2. Where this differs from the handoff

The handoff is the direction. These are the places this design changes it, each for a reason the handoff could not see from its mock.

| Handoff | This design | Why |
|---|---|---|
| The merged row falls back to Select and the last tool by the active tool's priority-1 widths (`renderVals`) | The fallback is decided by the screen and the role alone: the room the options get with the role's whole toolbar, against the role's floor (4.1): the handoff's 240 px, raised to 268 so every player tool's priority-1 controls fit it, and 301 for the DM | Decided per tool, picking Draw at 667 x 375 would have collapsed a player's five tools to two while picking the Ruler kept them: the toolbar would change under the finger with every tool |
| Sideways screens either merge or fall back | A third outcome: where even Select and the last tool leave less than the floor (480 x 320 at 100% and 130%), the row stands above the full toolbar, as on an upright phone | 480 x 320 is in the project's reach sweep. Its pair would leave the options 174 px at 100% and 63 at 130% |
| Desktop floats the row (section C) | A short sideways layout merges whatever its width, so a large phone held sideways at 100% (932 x 430, a wide layout) and a short computer window (1280 x 480) merge too | The rail served exactly these screens. A floating row there would take 59 px back from a map that had its whole height |
| Controls that do not fit go to ⋯ | Before a priority-1 control goes to ⋯, controls with a compact form take it (a chip drops its words, a choice of two becomes a chip, a long label takes short words). Only then does a priority-1 control go to ⋯, and section 13.1 lists where | Real widths are wider than the mock's estimates. Without compact forms the stroke or Place would leave the row on narrow phones |
| Widths are estimates in the mock | Measured from the real controls. A control that a press changes keeps the width of its widest state (6.2) | So a pick in a chip's popover, or the first tap on a confirm button, never shifts the controls beside it |
| Chips show an icon and words | A chip with a glyph shows glyph and words where the row has room left, words where it has not, and the glyph alone where its priority-1 controls need the room (6.2, decided 17.3) | The project owner's answer. With measured widths a glyph always beside the words left no room for "Sphere 20 ft" in a 390 px phone's Area row and pushed Undo out of a sideways phone's Draw row (358 px), both of which the handoff shows, so the glyph is the first thing to give way |
| Draw's stroke preview is 2, 4 or 7 px tall | 2, 4 or 8 px | Code wins: Thick is 8 px (`DrawTool.tsx:388-397`) |
| Area's Size sits in the shape popover and in ⋯ | Size and the spell search have the shape chip's popover as their only home when they leave the row | One place per control: two Size steppers on screen confuse a screen reader and a finger alike |
| A tap on the map closes a popover | It closes it once the press ends as one finger, so a pinch keeps it open, and the tool does nothing with that press (7.1, 7.4) | A press meant only to close a popover must not ping every player, edit fog or place an area |
| The hint pill cuts with an ellipsis | A cut pill becomes a button that shows the whole line | Area's "In area" list and the builder's longer hints are what the person came for |
| The pill takes no layout height | It takes none from the map's layout, but Fit, Find, the panes on the map and the alerts keep clear of it (10.2) | Fit would otherwise leave part of the scene under the reading |
| Setup groups the setup tools on every layout | On the phone layout only. A computer keeps all ten tools (decided, 17.1) | A computer has room for ten buttons, and a DM preparing a scene there switches between setup tools often |
| The mock draws the merged row under the toolbar's fill (frames 2b to 2d show it faded) | The toolbar's fill becomes a backdrop under the row (10.1) | A stacking slip in the mock |
| Material Symbols stand-ins | The app's own tool icons, and plain glyphs in their style or words alone for the tiles (decided, 17.2) | The project ships only openly licensed art, and the toolbar's icons are plain glyphs drawn in code |
| Fog's draft Undo is an undo arrow | It keeps its word, "Undo" | An arrow there would read as the room's undo, which the DM's top bar already shows beside it |
| Not covered | Code-only controls and states: Fog's polygon, brush width and fog-off state, Area's idle and picked states and its whole More row, every builder mode, a selected stamp, Add token with something chosen, Pin's three states, Line up grid's More, Multi-select | Section 9 gives each a home |

## 3. Today

### 3.1 The options bar and the rail

- **One container.** `OptionsBar` (`pages/Room.tsx:1316-1491`) is a `role="toolbar"` named "<tool> options" (`:1469-1470`), with `data-rvtt-options` "rail" or "foot" (`:1471`), holding the tool's `Options` inside a `LoadBoundary` keyed by the tool (`:1485-1487`). It is drawn while the tool has options, `optionsShown` allows them, and no phone sheet or panel list is open (`:464`). It stands just before the toolbar in the page, so Tab reaches it there (`:760-772`).
- **At the foot** it spans a phone's width (`:1432-1448`), or from 900 px up floats 8 px right of the left safe area, as wide as its content up to 640 px. Its rows wrap (`:1477-1478`, `features/measure/controls.tsx:35-45`), so it grows upward, capped at half the screen and at the room under the top bars and any lasting notice (`:1449-1453`). Capped, it scrolls and opens scrolled to its first control (`:1356-1371`). Where not even one row fits under a lasting notice, it stands over the notice at z 21 (`:1454-1461`).
- **The rail.** On a short sideways screen where 248 px and the left safe area take at most half the map (`pages/optionsPlace.ts:22-24`), tools without `optionsAt: "foot"` put the same element in a 248 px column on the left (`Room.tsx:1411-1431`), with "Scroll for more" while it overflows (`:1391-1409`). Ping, Pin, Add token and Select keep the foot (`tools.ts:128,153`, `PingTool.tsx:105`, `PinTool.tsx:180`, `placeTool.tsx:74`) until a row wraps there, which a layout effect records per tool and width (`Room.tsx:462-473,1372-1390`, `optionsPlace.ts:35-54`).
- **The layout inside.** Every tool draws a hint, reading or warning line first (`InfoLine`, `controls.tsx:55-73`: polite live region, readings and warnings marked `data-options-reading`), then wrapping groups of controls (`OptionsRow`, `role="group"` with a name). The kit: `OptButton` (`:102-145`), `ConfirmButton` (`:224-253`), `Stepper` (`:256-269`), `OptInput` (`:308-333`), `OptSelect` (`:345-360`), `Segmented` and `Swatches` (native radios, one Tab stop each).
- **The toolbar** (`Room.tsx:1493-1583`) is a `nav` named "Tools": the role's tools in a `ScrollStrip` that scrolls sideways when they do not fit, a divider before the setup tools, and Panels at the right end on a phone. A tap on the active tool does nothing (`:779`, `state/store.ts` `setTool`).
- **Keys** (`client/state/shortcuts.ts:178-194,244-253`): V, R, A, D, P for everyone (D only for a player allowed to draw), T, M, F, B, G for the DM. A key works for any tool in the list `toolsFor` gives (`tools.ts:171-173`), which Room passes in (`Room.tsx:293-298`), not for what the toolbar happens to show.

### 3.2 What reads the options' box

Room measures the bar and publishes it (`Room.tsx:125-177,243-246,516-534`):

- `insets` for the camera: `bottom` is the toolbar plus the foot bar, `left` is the rail's width. Fit and Find (`canvas/Stage.tsx:102,241-251,363`), `keepInView` (`:614`), pans to a token (`:413`), the panes on map points through `insetsInZoomed` (`:1160-1164`, `features/movement/anchor.ts:22`, `features/builder/labelEdit.ts:168-170`) and the heights readout (`features/builder/heights/ground.ts:117`).
- `Chrome` (`canvas/barDock.ts:55-73`): `bottom` (toolbar and foot bar), `controls` (up to the bar's highest control or reading), `toolbar`, `safe`, `sheet`, `rail`. The free area (`:99-105`), the compact bar (`:137-148`), the notices that span right of a rail (`noticeSpan`, `:535-537`), the alerts column's cards and shadow room (`columnCards`, `:660-664`, `InitiativeStrip.tsx:798-801`), its height (`:812-826`), its cramped test (`:529`), its summary row's floors (`:596-613`), the player's roll card (`PlayerRolls.tsx:169-174,513-522`), "Viewing as Pat" (`Room.tsx:548-568`) and the options' own cap (`:605-607`).
- Multi-select's hint chooses its short form from `hintRoom` and `shortHint` (`barDock.ts:680-686`, `select/SelectOptions.tsx:43-60`).

### 3.3 What each tool shows today

Section 9 maps every control, so here only the shape of each bar. Ruler: a line, Shared (DM), Keep, Clear, then one danger button per kept ruler and Remove all. Area: three states (idle, placing, a placed area picked), the placing and picked bars with a More toggle that opens a second row of up to thirteen controls, and a spell search whose results take their own row. Draw: a long row of a drawing tool select, Undo, Redo, ten color swatches, Width, Opacity, Fill, DM only, Clear mine and Clear all, plus a text row or a polygon row above it while one is in progress, and an eraser-only form for a player not allowed to draw. Ping: Look here (DM) and Ping sound. Fog: a fog-off state, then Clear or add fog, Shape, the polygon's Close shape and Undo corner, the brush's width, Draft or Live, the draft's publish button, Undo and Discard, and More with Fog all and Reveal all. Add token: a kind select and Monster… and Character…, or Cancel once something is chosen. Pin: three states. Map builder: a mode select, Undo, Redo, each mode's controls and Clear build, with a compact form for a selected stamp on a phone that opens modal Tint and More sheets (`stamps/StampOptions.tsx:139-178`, `StampSheet.tsx:13-19`). Line up grid: Apply, the scale, Nudge and More, each opening a row. Multi-select: "3 selected.", Actions and Done.

The measured cost of the bars on a sideways phone is in docs/design-v1-layout-hierarchy.md 2.1: before the rail they left the map as little as 16 layout px at 844 x 390 at 130%.

### 3.4 Widths today

Measured on the dev fixture room at 1280 x 800 and 100%, for scale: Shared 74, Keep 60, Clear 62, Place 63, Cancel 72, the Size stepper 152, the Shape select 115, the Spell field 170, the drawing tool select 85, Undo 62, Redo 60, Fill 45, DM only 81, Clear mine 98, Look here 92, Ping sound 101, Clear or add fog 170, Draft or Live 118, Reveal to players (1) 162, Discard 78, the blank kind select 208, Monster… 93, Character… 105, the ten swatches 458, Apply 65, Nudge 71, the builder mode select 169, Brush size 140. A labelled tool button at 844 x 390 is 44 to 56 px, Panels 53. Text at 14 px and weight 600: "Eraser" 43, "Thick" 37, "Emanation" 71, "Emanation 1,000 ft" 127, "Heights and stairs" 122, "Blank player character" 151, "Reveal (4)" 69.

## 4. Where the options stand

### 4.1 Four arrangements

One pure function, `optionsArrangement` in a new `client/pages/optionsLayout.ts`, decides where the row stands from the layout alone, before paint, never from a measurement:

1. **On a short sideways layout** (wider than tall and under 500 px tall), it tries, in order:
   - **merged**: the row stands in the toolbar's row, right of the role's whole toolbar (5.1), left of Panels.
   - **pair**: the same, beside only Select and the last tool used (5.2).
   The first whose room is at least the role's floor wins: `MERGE_MIN`, 268 px, for a player, `MERGE_MIN_DM`, 301 px, for the DM.
2. **Otherwise**, or where neither leaves that much:
   - **floating** on a wide layout: the row floats above the toolbar.
   - **stacked** on the phone layout: the row spans the map's width on top of the toolbar.

The room in the merged and pair arrangements is worked out, not measured, from the map's width `M` (the layout less the side panel while it shows), the left safe area `L` and the map's right safe area `R` (0 beside the side panel), the toolbar's button width `B` (5.3) and its buttons `n`:

`room = M − L − R − (n × B + (n − 1) × 4 + divider) − 31 − panels`

where `divider` is 5 when a divider stands among the buttons (1 px and its 4 px gap), 31 is the toolbar's 4 px padding at each side, the row's 15 px lead (a 6 px gap, its 1 px divider, 8 px padding) and 8 px before Panels, and `panels` is `B + 9` while Panels shows (always on the phone layout, from 900 px up while the side panel is hidden: its 4 px gap, 4 px padding and 1 px separator).

In the stacked arrangement the room is `M − L − R − 16`. Floating, it is `min(640, M − L − R − 16) − 18`, the row's widest box less its padding and border.

Why a floor and not the tool's own need: the arrangement then depends only on the screen, the interface size, the role, whether Draw shows for a player, and the side panel. Picking a tool never changes the arrangement, so no button moves under the finger that picked it (in the pair, the second button shows the new tool in the same place). The handoff's floor was 240. `MERGE_MIN` is 268: the widest player tool's priority-1 controls in their compact forms with ⋯ beside them, which is Draw's, as the kit draws it (its tool chip 83.5 px at "Eraser" in Inter, keeping its words, 6.2, the color chip 64, the stroke's bar 64, two 4 px gaps, and ⋯ with its gap 48: 267.5). `optionsLayout.test.ts` derives it from the kit's chip and the theme. The floor was 256 until the build review measured the chips as drawn. A player's merged room between the two now takes the pair, as at 844 x 390 at 115% (merged 260, the pair 428). So every player tool's priority-1 controls fit, and the merged and pair arrangements always hold them inline (section 9 checks each, 14 tests it). No worked row of 4.3 moves between 240 and 268. A player meets a narrower room only in the stacked rows of 320 x 568 and 480 x 320 at 130% (230 and 259 px), where Draw's stroke chip waits in ⋯ (13.1). A DM's tools hold theirs in every pair room a phone gives (301 px and up), with one exception listed in 13.1. So the DM's floor is `MERGE_MIN_DM`, 301: some sideways Android phones would merge a DM's whole toolbar in less (283 px at 800 x 360, where the builder's walls and doors sent its edge chip behind ⋯), and the DM takes the pair there, or the stacked row where the pair has less still (568 x 320 at 115%). The DM's narrower stacked rooms send a priority-1 control to ⋯ where they must, by the fit's own rule (6.3).

### 4.2 Each arrangement's shape

| | Stacked | Floating | Merged and pair |
|---|---|---|---|
| Where | Spans the map from the left to the right edge, its bottom on the toolbar's top | 8 px right of the left safe area, 6 px above the toolbar, as wide as its controls up to 640 px | In the toolbar's row, from 15 px after the last tool to 8 px before Panels, its controls lined up with the tool buttons |
| Box | 44 px controls, 4 px padding top and bottom, a 1 px top edge: 53 px. Side padding 8 px plus the safe areas | The same controls, padding 4 and 8 px, a 1 px border all round, `theme.radius.md` | No box of its own: a 1 px divider at its start. Inside the toolbar's 60 px |
| Fill | `theme.color.overlay`, as the toolbar | The same | The toolbar's (on a wide layout, whose toolbar has no fill, the row takes the floating row's fill, border and radius) |
| Height it takes from the map | 53 px | Its box and the 6 px gap | None |
| The line | 6 px above the row, from the left safe area plus 8 px | 6 px above the row, from the row's left | 6 px above the toolbar, from the left safe area plus 8 px |

### 4.3 Worked rooms

Insets as the reach and layout sweeps use them: 47 px at each side and 21 at the bottom for 844 x 390 and 480 x 320, 59 and 21 for 932 x 430, 47 at the top and 34 at the bottom for 390 x 844, none elsewhere. Labelled buttons (`B` 56) on every touch screen and the phone layout, icons alone (`B` 44) for a mouse from 900 px up. A player's toolbar has five tools, four while Draw is hidden for them (60 px more room). A DM's phone toolbar has seven buttons and a divider (5.1), a computer's ten and a divider.

| Window | Size | Layout | Player | DM |
|---|---|---|---|---|
| 844 x 390 | 100% | 844 x 390 | merged, 358 | merged would leave 233: pair, 538 |
| 844 x 390 | 130% | 649 x 300 | merged 163: pair, 343 | pair, 343 |
| 667 x 375 | 100% | 667 x 375 | merged, 275 | merged 150: pair, 455 |
| 667 x 375 | 130% | 513 x 288 | merged 121: pair, 301 | pair, 301 |
| 568 x 320 | 100% | 568 x 320 | merged 176: pair, 356 | pair, 356 |
| 480 x 320 | 100% | 480 x 320 | pair 174: stacked, 370 | stacked, 370 |
| 480 x 320 | 130% | 369 x 246 | pair 63: stacked, 259 | stacked, 259 |
| 932 x 430, side panel hidden (its default here) | 100% | 932 x 430, wide | merged, 422 | merged 117: pair, 602 |
| 932 x 430, side panel shown | 100% | the map 572 | merged 186: pair, 366 | pair, 366 |
| 932 x 430 | 130% | 717 x 331 | merged 207: pair, 387 | pair, 387 |
| 1280 x 480, a mouse, side panel hidden | 100% | 1280 x 480, wide | merged, 960 | merged, 715 |
| 390 x 844, 320 x 568, 820 x 1180 | 100%, 130% | upright | stacked: 374, 304, 804 (284, 230, 615 at 130%) | the same |
| 1280 x 800, 1180 x 820 | 100% | wide, not short | floating, 622 | floating, 622 |

A DM's toolbar never merges whole at the sizes of this table: seven buttons leave under 301 px at each. That matches the handoff's frame 2d. It merges only where they leave 301 px, as at 740 x 360 at 85% (354 px).

## 5. The toolbar

### 5.1 The setup tools behind Setup

- **On the phone layout** the DM's toolbar is Select, Ruler, Area, Fog, Draw, Ping, a divider, then **Setup**. A player's toolbar has no setup tools and no Setup, as today.
- **Setup** opens the "Setup tools" menu: the shared popover base's menu kind (7.1), as the side panel's More is, drawn as tiles. It holds Add token, Pin, Map builder and Line up grid, each a `menuitemradio` tile with the tool's icon and full label, the active tool checked. Opened by a key (Enter, Space, Down or Up on Setup), focus goes to the checked tile, else the first (with Up, the last). Opened by a tap or a click, focus goes to Setup itself (7.1). Down and Right go to the next tile, Up and Left to the previous, wrapping (the menu's tile option, since tiles stand in a grid), Home and End to the first and the last, and a letter types ahead to the tool whose name starts with it. Enter, Space, a tap or a click picks: the tool becomes active, the menu closes, and focus goes to Setup. Picking the tile of the tool already active tucks its options, or shows them again if they are tucked, and closes the menu (5.4), so a setup tool can be tucked like any other and stay in use. That tile is described "Pick again to hide its options.", or "Its options are hidden. Pick again to show them." Escape and Shift+Tab close it with focus on Setup. Tab closes it and moves on as Tab from Setup would, to Panels. While the menu has focus, letters type ahead, so the room's tool keys pick nothing there, as in More's menu. Setup carries `aria-haspopup="menu"` and `aria-expanded`.
- **While a setup tool is active,** Setup shows that tool's icon and short label (Add, Pin, Builder, Grid) in the active look. A tap on it opens the popover again. Every toolbar button that opens a popover (Setup, the pair's second button) carries a small caret in its top right corner.
- **On a wide layout** the toolbar keeps all ten tools with the divider, as today (decided, 17.1).
- **Button widths.** Stacked, the buttons share the strip: each grows from 44 px to at most 68 px, with 2 px between them and 4 px side padding inside each (8 today), so a 44 px button holds "Select" and seven buttons and Panels fit a 390 px phone. Where even 44 px each do not fit (a 320 px phone, or 130%), the strip scrolls as today (`components/ScrollStrip.tsx`). Merged and pair, each button is `B` wide (5.3).

### 5.2 Select and the last tool (the pair)

- In the pair arrangement the toolbar shows two buttons: Select, and the **last tool**: the last tool other than Select that this page made active. It starts as the Ruler, the most used tool after Select for both roles. A tool that leaves the role's list (Draw taken from a player) gives way to the Ruler.
- A tap on the last tool while it is not active makes it active. A tap while it is active opens the **Tools** menu: every tool of the role as tiles, in toolbar order, the setup tools after a gap for a DM, built as Setup's menu is (5.1), with the same keys and focus rules: Tab closes it and moves on from the second button, to Panels. A pick makes that tool active, makes it the last tool unless it is Select, closes the menu and puts focus on the second button. Picking the tile of the tool already active tucks its options or shows them again, as in Setup (5.1, 5.4). While its tool is active, the button carries `aria-haspopup="menu"` and `aria-expanded`.
- Any way a tool becomes active updates the last tool: a key, a panel (Monsters, Characters, Encounters, Areas, a journal page's "Pin to the map", Scene settings, the outliner), a tile. So the second button always shows the tool the person last went to.
- The last tool is the page's own, in the room's scope, as the active tool is. A reload starts at the Ruler.
- Tuck works here through the menu: the second tap on the button opens Tools, and picking the active tool's tile there tucks or shows its options (5.4). Tuck holds when the arrangement changes, into the pair or out of it.

### 5.3 Buttons in the merged and pair arrangements

Every button in the toolbar's row, Panels included, is `B` wide: 56 px with its short name under its icon, 44 px icons alone. The labels already fit 56 px ("Builder" is the widest). A fixed width is what lets 4.1 know the room before paint. The strip in these arrangements does not grow: it ends at its last button, and the row starts after it.

### 5.4 Tuck

- A tap on the active tool's own button hides its options: the row, the line and any popover. A small up chevron in the button's top right corner says they are tucked. Another tap brings them back.
- **Tucked mid-task.** Today a tap on the active tool does nothing, so people tap it out of habit, and a tuck could hide Place, Cancel or the publish button with nothing on screen to bring them back. So while a task is under way, a tucked tool keeps one thing: its line, as a pill button reading "<tool> options hidden. Tap to show." ("Area options hidden. Tap to show."), whose press shows the options again. A task is under way while Area holds a draft not yet placed, Fog holds a draft waiting to be revealed or a polygon with corners, Draw holds text being typed or a polygon with corners, the builder holds a room with corners or a selected stamp, Pin or Add token holds something to place, or Line up grid has a change not yet applied. With no task, tucking hides the line too.
- Select has no options to tuck. Where the second tap on a button opens a menu (Setup on the phone layout, the pair's second button), picking the active tool's tile in that menu tucks or shows its options instead, with Enter or Space on that tile doing the same (5.1, 5.2). So every tool but Select can be tucked and kept in use, as the project owner asked (2026-10-16: "tapping on a tool while it is open should hide its options panel ... but allow the user to still have the tool selected and use the tool"). While its tool is tucked, Setup or the pair's button shows the tucked chevron in place of its menu caret and carries the tucked description (11).
- Picking another tool shows its options: tuck belongs to the tool that was tucked and ends with it. A sheet hides the options as today and leaves tuck alone. Tuck is the page's, in the room's scope, never stored.
- Tucked, the options take no height: stacked, the map gains 53 px and the line's room, less the pill's while a task is under way. Merged, the toolbar's row simply shows no options.
- Tucked options stay mounted and hidden, so a half-typed label or spell keeps its text.

### 5.5 Keys

Unchanged: every key picks its tool directly, a setup tool behind Setup and any tool hidden by the pair included, because `useShortcuts` keeps reading `toolsFor` (`Room.tsx:293-298`), never the buttons the toolbar draws. One addition: the key of the active tool brings back its tucked options. It never tucks, so a held or repeated key never hides them. A key that picks another tool closes any open popover, as any tool change does.

## 6. The row

### 6.1 Slots

Each tool's `Options` becomes a list of **slots**, drawn by one kit component (`OptionsStrip` in `features/measure/controls.tsx`), plus the tool's line (section 8). A slot is one control:

- an id, unique in the tool, and a display order (its place in the list).
- a priority, 1 (highest) to 9.
- its kind: button, primary, pressed toggle, danger, confirm, value chip, segmented choice, swatches, stepper, text field or plain text.
- its full form, and an optional compact form (6.2).
- its home when it does not fit the row: ⋯ by default, or a value chip's popover (Area's Size and Spell, 9.3).
- whether it is **always in ⋯** (the tool's fixed ⋯ content, such as Clear all or Fog all).
- whether it shows now (a condition on role and state, as each control has today).
- a group name for ⋯ ("More area options", "Reminders").

A text field is **flexible**: it fits at its minimum width (96 px, about nine characters at 16 px) and takes whatever room the row has left after the fit, up to its width today (170 px for the spell search, 200 for Draw's text, 160 for a label). Multi-select's words are flexible the same way (9.1).

The row draws its inline slots in display order with 4 px between them, then ⋯ when anything waits for it. The groups that today name parts of a bar ("Drawing", "Text", "Shape") do not survive in the row, since the fit splits them: the row is the toolbar named "<tool> options", and every control keeps its own name. Segmented choices, swatches and steppers keep their own groups.

### 6.2 Forms and stable widths

**Compact forms.** A slot may draw smaller:

- A value chip whose options all have glyphs (an area's shape, the fog's shape) has three forms, by the room the fit gives it (decided, 17.3): glyph and words where the row has room left after the fit (6.3 step 5), words as the fit's own form, and the glyph alone with its caret as its compact form. One whose options carry a swatch (a terrain) drops its words for the swatch. The stroke chip keeps only its preview bar. A color or tint chip is a disk already, so it has no smaller form, and nor do chips whose options have neither glyph nor swatch (the blank token kind, a builder mode, an edge, a light), or not all of them one: the drawing tool's Pen, Text and Eraser show words (17.2), so its chip keeps its words in every form, and a pick never changes its width.
- A segmented choice becomes a value chip showing the chosen option's words, whose popover holds the segmented choice ("Clear fog" with a caret).
- A button with long words shows short ones: Fog's publish button reads "Reveal (4)", "Fog (4)" or "Show (4)" for its three wordings (9.6). A confirm button's armed words get short too ("Delete?", as the compact stamp bar has today).
- A short word stands in for a long option name inside a chip, in every form: the builder's modes read "Brush", "Rect room", "Shape room", "Erase", "Erase area", "Walls", "Heights", "Label", "Lights" and "Stamp" in their chip, and the lights "Lantern" for Hooded Lantern. The tiles and the chip's name keep the whole name.

**Stable widths.** Some controls change their words when pressed, or when a pick in their own popover changes them. These draw at the width of their widest state, so the controls beside them never shift: a value chip at its widest value (all values stacked in one grid cell, only the current one visible), a confirm button at its armed words, a stepper at its widest value ("1,000 ft", "Ground (clears)"), a count in a label with room for two digits (tabular figures). Words that change with what happens on the map (Area's "Caster: Thorn", Fog's publish wording, a stamp's name) take their current width: they change while the finger is on the map, and the refit that follows obeys 6.4.

**Measuring.** Only the kit's controls stand in slots. The strip draws every slot that shows, in its full and its compact form, once more in a hidden measuring layer (`aria-hidden`, `inert`, `visibility: hidden`, out of flow) and reads their widths in layout px (a rectangle divided by the interface size, as Room's measures already are). The measuring copies render in a measuring mode of the kit: no radio `name` (a copy must never join the real radio group and uncheck its choice), no ids, no handlers, no live regions, no effects (a confirm's timer, a hold's repeat). A ResizeObserver on the layer measures again when a font loads or the interface size changes.

### 6.3 The fit

`fitRow` in `optionsLayout.ts`, a pure function of the room, the slots that show (with their widths, priorities, display order, homes and flags) and the pins (6.4):

1. **Without ⋯ first**, for a tool with no content always in ⋯. If every slot fits the room in its full form with its gaps, every slot is inline and there is no ⋯. If not, the slots with a compact form take it one at a time, the lowest priority first and, among equal priorities, the last in display order, until they all fit. If they all fit, the row has no ⋯. So a DM's Ruler at 374 px shows its kept rulers' chip in its short words rather than a ⋯ holding it. (This was first worked at 343 px. With Inter and the icons the visual pass gave Shared and Clear, the row there measures 351 px even in its short words, so the chip waits behind ⋯ at 343, by step 2.)
2. **With ⋯.** Otherwise, from the full forms again, 48 px are kept for ⋯ and its gap. Pinned slots go inline first. Then the others, highest priority first and in display order among equal priorities: each goes inline if its full form fits what is left, else it waits. A smaller slot later in the order may still fit after a larger one waited.
3. If a priority-1 slot waits, the slots with a compact form take it one at a time, in the order of step 1, and step 2 runs again, until every priority-1 slot is inline or no compact form is left. A waiting slot of priority 2 to 9 never makes another slot compact.
4. Every slot still waiting goes to its home, priority 1 included. This is the outcome where even the priority-1 controls do not fit: they lead the ⋯ popover, the primary first. Section 13.1 lists where it happens, and none is a player's tool on a sideways phone.
5. Then, from what is left, in this order: a value chip that hosts a waiting slot's value takes its wider form if it fits (Area's shape chip reads "Sphere 20 ft" while Size is in its popover, 9.3). A waiting slot whose compact form fits what is left comes back into the row in that form, highest priority first, so a chip shows its glyph alone rather than wait behind ⋯ where the row holds the glyph. Chips in their words form gain their glyph, one at a time, highest priority first and in display order among equals, while it fits. A flexible field grows into the rest. Adding a glyph never moves a control into ⋯, and a chip's width with its glyph is as stable as without it (its widest words and the glyph), so a pick in its popover never changes whether the glyph shows.

⋯ shows when any slot is in ⋯ or the tool has content always in ⋯. Same inputs give the same output, so a refit that changes nothing draws nothing.

### 6.4 When it runs, and what holds still

**It runs again** before paint (a layout effect) whenever its inputs change: the room (a resize, a rotation, a change of interface size, the side panel shown or hidden, the arrangement switching), the slots that show (a state of the tool, the role), or a measured width (a font, a value with open-ended words). A value a press changes never changes a width (6.2), so picking a color or stepping the size never refits.

**Holds.** The split between the row and ⋯ holds while:

- a press that began on the row is down: the refit waits for the press to end.
- the ⋯ popover is open: no slot crosses between the row and ⋯. A slot that goes leaves from wherever it is. A slot that appears joins ⋯ at its place in the display order. ⋯ itself stays, even if nothing waits any more, until the popover closes. Then the row refits once.

**Pins.** The fit never moves two slots out of the row: the one holding focus and the anchor of an open popover. Only an inline control's focus pins its slot: focus inside a popover is the popover's, its anchor's own pin holds the chip while it is open, and once focus leaves for ⋯, a popover or anything outside the row, no slot is pinned for it. They go inline first (step 2). Where the room cannot hold a pinned slot and ⋯ (a rotation to a much narrower room), the pin breaks: an open popover closes, and focus follows the next rule.

**Focus never falls to the page.** When the control holding focus leaves the row, whether into ⋯ or because its state ended (Fog's Discard, the builder's polygon Cancel, a stamp's Done), focus moves to the slot now in its place in display order, else the one before it, else ⋯, else the active tool's button. Controls that move focus on purpose keep doing so: Multi-select's Actions to the token bar, a chooser's picker returning to its chooser.

### 6.5 ⋯ and its popover

- **The button.** 44 px, the app's `more` icon, named "More options", `aria-haspopup="dialog"`, `aria-expanded`. Always last in the row. The pressed look while its popover is open.
- **The popover** (a setting popover, 7.2), titled "More" and named "More <tool> options". It holds the slots waiting for ⋯ in display order, then the tool's content always in ⋯ in its own order, each under its group name where it has one:
  - A button, a primary, a danger or a confirm button is a 44 px row as wide as the popover, with its own name and look. A confirm arms in place.
  - A pressed toggle is a row with a check mark, still a button with `aria-pressed` and its fixed name.
  - A segmented choice, swatches, a stepper or a field is a labelled group, wrapping to the popover's width.
  - A value chip shows its own popover's content inline under its title: there is never a popover inside a popover.
  - Plain text is a muted row.
- Inside ⋯ every slot uses its full form.

### 6.6 Empty rows, loading and failure

- A tool state with no slots (Pin with a pin's pane open, Line up grid with no map image or no box) draws no row, only its line, which then stands 6 px above the toolbar. Stacked, the map keeps the 53 px. (Map builder's Erase area has no controls of its own but keeps the builder's mode chip, Undo and Redo.)
- Fog, Map builder and Line up grid load their options on first use (`fog/tool.tsx:148-152`, `builder/tool.tsx:285-289`, `grid/tool.tsx:130-134`). While loading, the row holds today's "Loading the options…" status, shown after 200 ms. Stacked, the row is 53 px from the first frame, so nothing moves when the controls arrive.
- A tool whose options failed to load (`Room.tsx:1485`, `LoadBoundary`) shows the notice's words as its line in the warning tone and its Reload or Retry button as the row's one control, still `role="alert"` as today.

## 7. Popovers

### 7.1 The shared popover base

One base for every non-modal popover in the room: this design's tool popovers, Setup and Tools (5.1, 5.2), and the side panel's More menu (docs/design-v1-panel-tabs.md cites this section). Whichever of the two builds lands first writes it, and the other adopts it. A consumer adds its own role, look, keys and contents. It never changes the rules below.

- **Modules.** `client/components/Popover.tsx`, the component, and `client/components/popoverPlace.ts`, the placement, a pure function. One test file, `client/components/popover.test.ts`, holds the base's tests (14).
- **In the page.** The popover renders right after its anchor in the page, so it is next in Tab order, and positions itself from measured rectangles in the chrome's own px (a rectangle divided by the interface size, as Room's measures are), so the interface size never enters the rule.
- **Placement** (`popoverPlace`). Inputs: the anchor's rectangle, a **bound** (the rectangle the popover keeps inside), an optional **rise region** (a taller rectangle it may grow into where the bound leaves too little), the side it opens on (above or below its anchor), a gap from the anchor, a margin inside the bound, its content's natural size, and its minimum height. It takes:
  - **Width**: its content's natural width, at least the anchor's, at most the bound's width less both margins. Content wraps to that.
  - **Across**: its start edge at the anchor's start edge, moved back to stay a margin inside the bound's far edge, then inside its near edge.
  - **Down or up**: from the anchor's side, with the gap, as far as its content needs, up to the bound's edge less the margin. Where that leaves less than its minimum height, it grows into the rise region up to that region's edge. Past the room it has, its content scrolls (`overflowY: auto`, `overscrollBehavior: contain`), with "Scroll for more" (`ScrollForMore`, `canvas/TokenActionBar.tsx:897`) while it runs past its foot.
  - **When**: placed as it opens, and again when its anchor moves or changes size, or the bound or the rise region changes (a resize, a rotation, the turn band, a lasting notice). Changes in its own content never move or resize its box while it is open: past the box, the content scrolls. So nothing under a finger moves because a choice inside it added a line.
- **Non-modal.** No scrim, no inert room, no focus trap, no `aria-modal`. The map and every control outside it keep working.
- **One open popover in the room.** The room's scope holds the one open popover (a slot in `state/scope.ts`). Opening any popover closes the one that was open, whichever consumer owns it: More closes a tool popover, a tool popover or Setup closes More, Setup closes a tool popover.
- **Closing by a press.**
  - A press on its anchor closes it, and does nothing else.
  - A press anywhere outside it and its anchor, on anything but the map, closes it as the press starts, and the press goes on to its target: another chip, ⋯, a tool, a tab, the top bar, a notice's button, an alert card, the token window, a pane on the map.
  - **A press on the map** closes it only once the gesture resolves as one pointer: when the press ends (the finger or the button lifts) with no second touch having joined it. A second finger cancels the pending close for that whole gesture, so a pinch or a two-finger pan leaves the popover open, also after one of the two fingers lifts first. A drag with the right or middle button, with Space, or the wheel, never closes it. **A press on the map while any popover or menu is open does nothing but close it**: from the press's start the tool does nothing with it, for every consumer, More included (7.4). The room behaves one way whichever popover is open.
- **Focus goes in only on a key open.** Focus moves into a popover or menu only when a key opened it: Enter or Space on its anchor (a `click` whose `detail` is 0), or for a menu Down or Up on its anchor. It goes to the chosen option, a menu's checked item, else the first control or item (with Up, a menu's last). A pointer open puts focus on the anchor itself (`focus({ preventScroll: true })`), never into the popover or menu. Safari does not focus a pressed button by itself, so the base does it, and every browser ends the same way: focus on the anchor, ready for Escape, Tab or a key to go in.
- **Tab and Shift+Tab leave it, and it closes.** Tab out of it (in a menu at once, in a popover past its last control) closes it and moves focus on as Tab from its anchor would. Shift+Tab out of it (in a menu at once, in a popover before its first control) closes it and puts focus on the anchor.
- **Closing by focus.** It closes when focus moves from inside it or its anchor to another element outside both: a script, a dialog opening, a press on something that takes focus. Focus that falls to the page (no element takes it, as when a press lands on the map or the focused control leaves) is not a move away: a press is handled by the press rules above, and a focused control that leaves the popover hands focus to the popover's next control, else its previous, else its anchor. The popover's own box takes focus (`tabIndex={-1}`) when a press lands on a part of it that is not a control, so a press inside never reads as focus leaving.
- **Escape.** While it is open, the base listens for Escape in the capture phase. It closes the popover and marks the key used (`preventDefault`) unless a modal dialog is open, or the key's target is a text field or a select (`isTextField`, `state/shortcuts.ts:56-64`) that is neither inside the popover nor its anchor. That field keeps its Escape. So a DM typing in a journal page in the side panel keeps Escape in the page, while Escape in the popover's own spell field, or in a spell field the popover hangs from, closes it. A used key passes the room's Escape (`RoomChrome.tsx:111-141`), the map panes and the shortcuts, which all skip used keys. `escapeTarget` does not change.
- **Focus on closing.** Escape, Shift+Tab, a pick that closes it, and any other close while focus is inside it or on its anchor, except Tab (which moves on, above), put focus on the anchor, or where the anchor has gone, on what the consumer names (⋯ for a tool popover, 7.5). A press elsewhere leaves focus where the press put it.
- **Android's Back** closes it before anything else, through `useBackClose` (`lib/backClose.ts`) while it is open, on a phone and on an Android tablet alike.
- **Closes with its anchor or its surface**: when the anchor leaves the page or its surface hides (the options under a sheet, the side panel hidden), and when a modal dialog opens.
- **Stacking.** While open, the popover's stacking context (its consumer's element) takes `theme.z.popover` (21, 7.6).

The menu kind (More, Setup, Tools) uses `components/Menu.tsx` and its pure keys, `components/menuKeys.ts`, from docs/design-v1-panel-tabs.md 4.4 and 5.2: `role="menu"`, its items `menuitemradio`, arrows, Home and End, typeahead, Enter or Space to pick, Escape to close with focus on the anchor, Tab and Shift+Tab by the rule above, every handled key marked used. The focus and Tab rules above are the base's, not the menu's own, so More, Setup and Tools behave alike. Setup and Tools draw it as tiles (5.1).

### 7.2 Kinds and look

- **Choice popovers** hold one choice: the drawing tool, a color, a pin color, a tint, the fog's shape, a builder mode, a terrain, an edge, a light, a blank token kind, a segmented choice's compact chip, and the spell results of a spell field in the row. A pick closes them.
- **Setting popovers** hold settings that are changed together or in a row: Stroke (width and opacity), Nudge, Kept rulers, ⋯. They stay open until the map, the anchor, Escape or Back closes them. A button inside that ends the tool's current task (Place, Cancel, Done, Copy, Delete, the publish button, Discard, Apply, Finish, Add, a confirm's second press) closes it after it acts.
- **The shape popover** of Area holds the spell search, the shape tiles and, while it is not in the row, Size. A shape or a spell closes it. Typing and stepping do not.
- **Setup and Tools** are menus (7.1), not choice popovers: their tiles are menu items (5.1, 5.2).
- **Look**, from the handoff on the theme's tokens: `theme.color.surface` fill, a 1 px `border` line, `theme.radius.lg`, `theme.shadow.pane`, 12 px padding, a title in the 11 px capitals section label style (`SectionLabel`). Groups: tiles (a grid of 60 px tiles, words with a glyph above where one exists), swatches (the `Swatches` component, five to a row), segmented choices, rows (44 px, a check mark for a pressed toggle, red words for danger), a stepper, a search field. No animation, so reduced motion has nothing to stop.
- A choice tile is a native radio in a 60 px label, as `Segmented` builds its options, so a group is one Tab stop and the arrows move the choice.

### 7.3 Placement

Through `popoverPlace` (7.1), with these inputs:

- **Above** its anchor, 6 px from the row's top (stacked, floating) or the toolbar's top (merged, pair). A popover anchored in the toolbar (Setup, Tools) stands 6 px above the toolbar, over a stacked row.
- **The bound**: the map's area less the safe areas, from 8 px under the top bars (the top bar, the turn band in a fight) and under the last lasting notice, with an 8 px margin.
- **The rise region**: the same, up to the top safe area, over the top bars and the notices. The minimum height is its title and one 44 px row, so at 480 x 320 and 130% in a fight a popover rises over the bars rather than open with no room.
- Content that grows while it is open (Area's "Once a turn" appearing under the reminders, a kept ruler removed) scrolls inside the box, by the base's rule.

### 7.4 Opening and closing

The base's rules (7.1), and for the tool popovers, Setup and Tools:

- **Its anchor** opens it, and a second press on the anchor closes it.
- **A press on the map only closes it** (7.1), and suppresses the tool at once. From the press's start, the tool does nothing with it: no stroke, no ping, no ruler point, no fog edit, no area, no selection, no one-finger pan, no hold to ping, until its last finger or the button lifts. The popover itself closes only as the base says: when that press ends as one pointer. A second finger turns the press into a pinch or a two-finger pan, as always, and the popover stays open. The open popover is in the room's scope slot (7.1), and the map's gesture reads it as a press starts. Why: the popover covers the map near the row, the first tap after a pick most often means "close this", and a tool's act from it (a ping every player sees, a fog edit, a placed area) costs more than one more tap.
- **Leaves it open**: two fingers panning and pinching, the wheel, a drag with the right or middle button or with Space, and room keys that change no tool (Ctrl+Z, +, −, 0, the arrows on a selection).
- **Closes it, and acts as usual**: a press anywhere else outside it (7.1).
- **Closes it, by state**: a tool change (a key, a tile, a panel), tucking, a phone sheet or the list of panels opening (which hides the options, as today), any modal dialog opening (the stamp picker, a handout, the very short sheet, the alerts over the screen), the scene changing, the role changing, and its anchor leaving the row for any reason but the hold rules of 6.4.
- **A rotation or resize** places it again at its anchor. If the anchor no longer stands anywhere (a rotation into the pair takes Setup away), it closes.
- **A popover that opens by itself**, as the spell results open while their field has focus and text (9.3), stays closed after any close the person makes (a key, Tab or Shift+Tab out, a press, a pick, focus moving on, another popover opening) until the person asks again: new words, a press on the field, or Down. Only its own state closing it, or its anchor leaving, is no dismissal. The base owns that list (`dismissedBy`), so no consumer keeps a copy.

### 7.5 Focus, Escape and Back

- **Focus moves into a popover only when a key opened it** (7.1), for the tool popovers, Setup and Tools alike: to the chosen option of a choice, else the first control. A pointer open puts focus on the anchor (7.1).
- In a choice popover the arrow keys change the choice without closing it, and a pick by pointer, Enter or Space closes it. A native radio fires `click` on an arrow key too, with `detail` 0, so the popover closes on a pointer click (`detail` above 0) or on Enter or Space, never on an arrow.
- **Tab order.** The popover is the next thing after its anchor (7.1), so Tab from its last control goes to the control after its anchor and closes it, and Shift+Tab from its first control goes back to its anchor and closes it (7.1).
- **Escape and Back** as the base says (7.1). Where the anchor has left the row, focus goes to ⋯.
- **What else is on screen.** A popover can share the screen with the token's bar: with Select active and a token selected, a DM on the phone layout can open Setup over the spanning bar of an upright phone, or over the docked token window of an upright tablet (an 820 x 1180 tablet docks, `barDock.ts:32,112-115`). Escape closes Setup first (the base takes the key before the room's Escape reaches the bar), and a second Escape then closes the bar. A press on the window or the bar closes Setup and acts, by the base's press rule, so the bar's buttons take the press. Setup (z 21) stands over the window (`theme.z.pane`, 5). The same holds for Setup and Tools over a phone's sheet, since the toolbar stays usable under a sheet: Escape closes them first, and a press on the sheet closes them and acts. An options popover never shares the screen with a sheet: a phone sheet hides the options. A pane on the map (`data-map-pane`) sees the key already used and stays open, as it does for the room's other Escapes.
- **A modal dialog opened from inside a popover** (the stamp picker from a chooser in ⋯) closes the popover as it opens. When it closes, focus goes back to its opener if the opener is drawn, else to the popover's anchor.

### 7.6 Stacking

While a popover is open, its options element or toolbar takes `theme.z.popover`, a new token of 21 (today's "options over notices", `Room.tsx:1461`), so the popover stands over notices and toasts and under the alerts opened over the screen (22), a player's roll card (25) and modal dialogs. A roll card at a narrow screen's foot stands on the options row, where the options' popovers rise, so it folds into "Roll asked" while one of them is open, as under a sheet (docs/design-v1-visual.md 3.3.1), and comes back when it closes. The rest of the time the options keep `theme.z.options` (14) and the toolbar `theme.z.bars` (15). The compact token bar (16) covers the toolbar and the merged row together, as it covers the toolbar today.

### 7.7 Code it reuses

No popover exists in the app today: the map's panes anchor to canvas points (`builder/labelEdit.ts:150-179`, `movement/anchor.ts:13-28`), and the stamp sheets are modal Dialogs. The base (7.1) reuses what fits: `Button`'s `expanded` prop for anchors (`components/Button.tsx:39-45`), `ScrollForMore`, `SectionLabel`, `useBackClose`, `isTextField` and `cardPlace`'s clamping rule, rewritten for a DOM anchor in `popoverPlace`. Inside the tool popovers sit `Segmented`, `Swatches` and the kit's `OptButton`, `Stepper`, `ConfirmButton` and `OptInput`. Setup and Tools use the panel tabs design's `Menu` with its tile option.

## 8. The line

- **What it holds.** What each tool's `InfoLine` holds today, in the same four tones: a hint (13 px, muted), a reading (14 px, text color, a bold lead where the tool gives one: "35 ft", "Fireball"), a warning (13 px, warning color), and Line up grid's saved status ("Grid saved at 70 px per square.", 13 px, success color, today a separate `role="status"` line, `grid/Options.tsx:56-59`).
- **Its shape.** One line in a pill: 6 px by 10 px padding, `theme.radius.sm`, the bars' fill, a 1 px border. Place in 4.2, or 6 px above the toolbar where the state has no row (6.6). At most the map's width less the safe areas and 16 px wide, as wide as its words otherwise.
- **Cut words.** Where the words do not fit, they end in an ellipsis and the pill becomes a button named by its words, with `aria-expanded`. A tap shows the whole line, wrapping upward over the map, up to four lines and scrolling past that, as `InfoLine` does today. Another tap, a tap on the map (which then acts as usual), a popover opening or a tool change folds it again. A pill that is not cut takes taps without doing anything, as the bars do, so a tap on it never reaches the map.
- **While a popover is open** it is hidden from sight, since the popover stands where it is, but not from screen readers: it is visually hidden (`VISUALLY_HIDDEN`) and stays a polite live region, so an Area reading that changes while the shape popover is open is still spoken.
- **Tucked**, it goes with the row, except while a task is under way: then it stays, as the button "<tool> options hidden. Tap to show." in place of the line, whose press shows the options again (5.4). Under a sheet it goes with the options, as today.
- **Over a lasting notice.** Where the row and the line would stand above the bottom of the last lasting notice, as at 480 x 320 at 130% in a fight with Reconnecting up, both take `theme.z.popover` and stand over it, as the options do today, so the tool's controls stay in reach.
- **Where the map is shorter than the line.** Where the map between the top bars and the row has less height than the line and its gap, as at 480 x 320 at 130% with the turn band, the line is hidden from sight as under a popover and stays a live region, so it never covers the band's End turn. Its reserve keeps its last measure meanwhile.

## 9. Every control's home

Code wins over the handoff's list throughout. Priorities run 1 to 9. "⋯" in the priority column means always in ⋯. "Compact" gives the compact form. A slot's home is ⋯ unless the table names a chip. A control's name, role, tooltip, condition and default are today's, cited, unless the table says otherwise. Every button and toggle keeps its fixed name, and every key and Tab stop stays: the toolbar keeps its keys, and every control stays a Tab stop in the row or in its popover.

**The task rule.** While a tool has a task in progress (Draw's text or polygon, Fog's polygon corners, a builder room's corners, a stamp selected, Pin or Add token holding something to place), the task's controls take priority 1 or 2, and the tool's standing settings (its modes, shapes, terrains, colors, Undo and Redo) drop by 3. Draw's text and polygon controls also come first in the display order, where their rows stood above the settings row today. It is how today's bars put a task first, in one row.

### 9.1 Multi-select (`select/SelectOptions.tsx`)

Shows only while the mode is on, as today. No line: its words are in the row, as the handoff keeps its bar. No ⋯ content.

| Slot | Kind | Priority | Compact |
|---|---|---|---|
| "3 selected. Tap tokens to add or remove them, or drag a box on the map." | Plain text, flexible: the count bold and first, at least 48 px, growing up to the whole sentence, cut with an ellipsis | 1, never behind ⋯ | |
| Actions (while the group has tokens and its bar is hidden) | Button | 1 | |
| Done | Primary | 1 | |

The fit replaces the 600 px hint rule (`hintRoom`, `shortHint`, `LONG_HINT_MIN`): the sentence shows wherever the row holds it, which at 1280 x 800 it does with Actions shown (about 600 of 622 px). The whole sentence stays the row's description (`aria-describedby`), set by the strip through a prop rather than by `SelectOptions` editing Room's element (`SelectOptions.tsx:43-54`).

### 9.2 Ruler (`measure/RulerTool.tsx:177-232`, `KeptRulers.tsx`)

Line: today's hint, then the reading "35 ft (15 ft + 20 ft)" with the diagonal rule. No ⋯ content.

| Slot | Kind | Priority | Compact |
|---|---|---|---|
| Shared (DM) | Pressed toggle | 1 | |
| Measure, Straight or Walking (docs/design-v1-movement.md) | Segmented | 4 | A chip with "Line" or "Walk" |
| Keep ("Keep this ruler on the map") | Button | 2 | |
| Clear | Danger | 2 | |
| "Kept rulers (2)" (while this person has kept rulers to remove) | Chip, opens the "Kept rulers" setting popover | 3 | "Kept (2)" |

The popover holds today's row: one danger row per kept ruler, named "Remove the kept ruler: Pat · 30 ft · only DMs see it" as today, and Remove all with two or more. It stays open as rulers go, and closes when none is left, since its chip goes. In ⋯ the same rows show under "Kept rulers".

### 9.3 Area (`areas/AreaOptions.tsx`)

Amended by docs/design-v1-area-from-character.md section 4.

The More toggle and its store flag (`areas/store.ts:34`) go: its row is the tool's content always in ⋯. The spell results row goes too: results show in the shape popover under the spell field, or, while the field is in the row, in a "Spells" choice popover anchored to it that shows while the field has focus and text. Enter still applies the first match. The shape chip is named "Shape: Sphere" and its popover titled "Shape".

**Idle.** Line: today's hint.

| Slot | Kind | Priority | Home |
|---|---|---|---|
| "Not from Thorn" (a player with a default caster) | Button | 2 | ⋯ |
| Shape | Chip (shape tiles), compact: the shape's glyph | 1 | ⋯ |
| Spell | Field, flexible | 3 | the shape popover |

**Placing.** Line: today's hint, then the reading with the range warning inside it.

| Slot | Kind | Priority | Home |
|---|---|---|---|
| Shape | Chip, compact: glyph. Reads "Sphere 20 ft" while Size waits and the row holds it | 1 | ⋯ |
| Size | Stepper, 5 to 1,000 ft | 3 | the shape popover |
| Place | Primary | 1 | ⋯ |
| Shared | Pressed toggle | 4 | ⋯ |
| Cancel | Button | 2 | ⋯ |
| Spell | Field, flexible | 5 | the shape popover |
| More area options: Rotation snap, Aim up or down, Width, Height, Point on, Cube reaches, Elevation, Includes caster (or "Includes Goblin"), Moves with token, Caster (pick toggle), No caster, Reminders (Enters, Starts turn, Ends turn, Once a turn), Color, DM only | Today's controls, in today's order and conditions (`AreaOptions.tsx:292-352`) | ⋯ | |

**A placed area picked.** Line: today's reading.

| Slot | Kind | Priority |
|---|---|---|
| Size (editable) | Stepper | 3 |
| Hidden (editable, DM) | Pressed toggle | 4 |
| Damage (DM) | Button | 3 |
| Copy | Button | 2 |
| Delete (editable) | Danger | 3 |
| Done | Button | 1 |
| More area options (editable): Rotation snap, Aim, Width, Height, Includes caster, Moves with token, Reminders, Color, as today (`:399-436`) | | ⋯ |

### 9.4 Draw (`drawings/DrawTool.tsx:307-440`)

Line: today's hint by drawing tool, muted.

**Full.**

| Slot | Kind | Priority | Compact |
|---|---|---|---|
| Drawing tool: Pen | Chip (eight tiles: Pen, Line, Arrow, Box, Circle, Shape, Text, Eraser) | 1 | none: Pen, Text and Eraser have no plain glyph (17.2), so the chip keeps its words in every form |
| Color: Yellow | Chip, a 24 px disk (the ten member colors) | 1 | |
| Stroke: Mid, Solid | Chip: a preview bar 2, 4 or 8 px tall by Thin, Mid or Thick, in the color, at the opacity, then "Mid". Setting popover "Stroke" with today's Width and Opacity choices | 1 | the bar alone |
| Fill | Pressed toggle | 4 | |
| Undo ("Undo your last change") | Icon button, the top bar's undo arrow | 2 | |
| Redo ("Redo") | Icon button | 3 | |
| DM only (DM) | Pressed toggle | 5 | |
| Clear mine | Danger | 6 | |
| Clear all (DM) | Two-tap danger, armed 3 s, as today (`:419-436`) | ⋯ | |

**Text entry** (a tap in Text mode, task): Text field (flexible, focused as today) 1, Add (primary) 1, Cancel 2, then the full row's slots 3 lower.

**Polygon in progress** (task): Finish (primary) 1, Undo corner 1, Cancel 2, then the full row's slots 3 lower.

**Eraser only** (a player not allowed to draw, `:341-355`): Undo 1, Clear mine 1. Line: today's hint.

At 320 x 568 at 130% a player's Draw keeps its tool and color chips and sends its stroke chip behind ⋯, one tap away. That is a choice: the drawing tool chip keeps its words because Pen, Text and Eraser have no plain glyph (17.2), and those stacked rows, 230 px there and 259 px at 480 x 320 at 130%, are the rooms a player meets below `MERGE_MIN` (4.1). Every other player tool keeps its priority-1 controls inline there (13.1).

### 9.5 Ping (`pings/PingTool.tsx:64-91`)

Line: today's hint. Look here (DM) 1, Ping sound 1. Nothing in ⋯ at any size in 4.3.

### 9.6 Fog (`fog/Options.tsx`)

The More and Less toggle goes: Fog all and Reveal all are always in ⋯. Line: today's hint, its Live and vision additions, and its notes in the warning tone.

**Fog off for the scene.** Line: today's warning. Turn fog on (primary) 1.

**Fog on.**

| Slot | Kind | Priority | Compact |
|---|---|---|---|
| Clear or add fog: Clear fog, Add fog | Segmented | 1 | chip "Clear fog" |
| Shape: Rectangle | Chip (Rectangle, Polygon, Brush, Builder room), glyph and words where the row has room (6.2) | 2 | the glyph |
| Brush width (Brush) | Segmented, "5 ft", "10 ft", "20 ft" | 3 | chip "10 ft" |
| Close shape (Polygon, a task while it has corners) | Primary, or secondary while a draft waits (one primary), disabled under 3 corners as today | 1 | |
| Undo corner (Polygon) | Button | 2 | |
| Undo (a draft, "Take back the last draft edit") | Button, keeps its word | 3 | |
| Reveal to players (4), Fog for players (4), Show players the changes (4) (a draft) | Primary | 1 | "Reveal (4)", "Fog (4)", "Show (4)" |
| When players see edits: Draft, Live | Segmented | 4 | chip "Draft" |
| Discard (a draft) | Danger, one tap as today | 5 | |
| Fog all, Reveal all | Confirm buttons, as today | ⋯ | |

A compact form's name is its visible words, and its tooltip the full sentence, by the app's naming rule (`lib/a11y.ts:13-17`). A computer's row shows the full words, so the tests that press "Reveal to players (1)" there keep working.

### 9.7 Add token (`tokens/placeTool.tsx`)

**Nothing chosen.** Line: today's hint.

| Slot | Kind | Priority | Compact |
|---|---|---|---|
| Blank token kind: Blank monster | Chip, a rows popover (Blank monster, Blank NPC, Blank object, Blank player character) as a radio group | 1 | none: short words would read "Monster" beside "Monster…" |
| Monster… | Button | 2 | |
| Character… | Button | 3 | |

**Something chosen** (task). Line: "Tap the map to place 3 Goblins." Cancel 1. The tool's raw buttons and unnamed groups become kit slots (an adjacent cleanup that comes with the conversion).

### 9.8 Pin (`pins/PinTool.tsx:119-154`)

**Default.** Line: today's hint. Pin color: Yellow (a disk chip, the ten member colors) 1, DM only ("New pins start DM only") 1.

**A pin's pane open.** Line: today's hint. No row.

**Pinning a journal page** (task). Line: today's reading. Cancel 1.

### 9.9 Map builder (`builder/Options.tsx`, `heights/HeightOptions.tsx`, `lights/LightOptions.tsx`, `stamps/StampOptions.tsx`)

Line: each mode's hint and the builder's notes in the warning tone, as today. Always in ⋯: Clear build (confirm, "Tap again to clear").

| Slot | Kind | Priority | Compact |
|---|---|---|---|
| Builder mode: Brush | Chip, ten tiles, the short words of 6.2 in the chip | 1 | |
| Undo ("Undo your last change") | Icon button | 2 | |
| Redo | Icon button | 4 | |
| Brush: Terrain: Stone | Chip, eleven swatch tiles | 1 | the swatch |
| Brush: Brush size 1, 2, 3 | Segmented | 3 | chip "1" |
| Rectangle room: Terrain | Chip | 1 | the swatch |
| Shape room: Terrain | Chip | 1 | the swatch |
| Shape room: Close room (a task while it has corners) | Primary, disabled under 3 corners as today | 1 while it has corners, else 2 | |
| Shape room: Undo corner | Button | 2 | |
| Shape room: Cancel (with corners) | Button | 2 | |
| Erase: Brush size | Segmented | 2 | chip |
| Walls and doors: Edge: Wall | Chip, six rows (Wall, Door, Secret door, Window, No wall, Remove) | 1 | |
| Walls and doors: Secret door: Hidden, Found (Secret door) | Segmented | 2 | chip |
| Heights: Paint: Height, Stairs | Segmented, names "Paint a height", "Mark stairs" | 2 | chip |
| Heights: Brush 1, 2, 3, Area | Segmented | 3 | chip |
| Heights: Height, "5 ft lower", "5 ft higher" (Height) | Stepper with hold-repeat and its live value, as today | 1 | |
| Heights: Stairs point (Stairs) | Segmented, six choices | 1 | chip "Auto" |
| Label: Label text | Field, flexible | 1 | |
| Label: Label size S, M, L | Segmented | 2 | chip "M" |
| Lights: Light to place: Torch | Chip, six rows, "Lantern" in the chip for Hooded Lantern | 1 | |
| Stamp, none selected: the chooser ("Choose a stamp to place") | Primary until a stamp is chosen, then a button with its thumbnail and name (cut at 160 px) | 1 | the thumbnail, or the plus icon |
| Stamp, none selected: Snap | Pressed toggle | 2 | |

**A stamp selected** (task), after the builder's slots, which drop by 3, and the chooser and Snap, which take 4 and 5:

| Slot | Kind | Priority | Compact |
|---|---|---|---|
| Tint: None | Chip, nine swatches | 2 | |
| Flip | Pressed toggle | 3 | |
| Bring to front | Button | 5 | |
| Duplicate | Button | 4 | |
| DM only ("Hide it from players") | Pressed toggle | 3 | |
| Delete ("Delete this stamp") | Confirm, "Tap again to delete" | 2 | armed words "Delete?" |
| Done ("Let go of this stamp") | Button | 1 | |

Heights and stairs is the one place a DM's priority-1 controls outgrow a phone's pair room: the mode chip and the height stepper together are wider than the pair's room at 844 x 390 and 667 x 375 at 130% and at 568 x 320, so there the stepper waits in ⋯ (6.3 step 4), one tap away, its hold-repeat intact. A 1 px divider stands before the first inline stamp slot when builder slots are inline too, as `OptionsDivider` does today. The compact stamp bar goes (`useNarrowBar`, `useCompactStampBar`, `StampOptions.tsx:22-36,139-178`), and with it the modal Tint and More sheets (`StampSheet.tsx`): the fit and ⋯ do their job at every width, and the map stays live while a tint is picked. The stamp picker stays a modal dialog, opened by the chooser as today.

### 9.10 Line up grid (`grid/Options.tsx`)

No map image, or no box: the line only, no row. With a box, the line holds the hint, or the saved status after Apply.

| Slot | Kind | Priority |
|---|---|---|
| Apply | Primary | 1 |
| Nudge ("Move or size the box a pixel at a time") | Chip, the "Nudge the box" setting popover: ←, →, ↑, ↓ ("Nudge the box left" and so on), "Make the squares smaller", "Make the squares larger", as today | 2 |
| "70 px per square" | Plain text, tabular, at the width of its widest value | 3 |
| Resize scene (or "Resize scene to 30 × 20"), Grid lines | Pressed toggles, as today | ⋯ |

Nudge and More were pressed toggles opening rows. Nudge becomes a popover anchor with `aria-expanded` (the rule `Button.tsx` sets for disclosures), and More's two toggles live in ⋯.

## 10. What it replaces

### 10.1 Removed and kept

**Removed:**

- `client/pages/optionsPlace.ts` and its test: `RAIL_WIDTH`, `railAllowed`, `optionsPlace`, `wrapRecord`, `wrapsLines`.
- In `pages/Room.tsx`: `useWidth` and the rail's ref and width, `wrappedAt` and `recordWrap`, `OptionsBar`'s rail branch, its height cap and `optionsRoom`, its reveal-on-cap scroll, its wrap watch, its "Scroll for more", `OPTIONS_ROW`.
- `ToolDef.optionsAt` (`tools.ts:122-128`) and its four uses.
- `Chrome.rail`, `noticeSpan`, the rail terms of `freeArea` and `columnCards` (`barDock.ts`), of the alerts column's card width, shadow room and summary row (`InitiativeStrip.tsx:596,798-801`), and of the roll card's left (`PlayerRolls.tsx:513`). Each takes the branch it took with no rail.
- `insets.left`: always 0 again.
- `hintRoom`, `shortHint` and `LONG_HINT_MIN` (`barDock.ts:680-686`): the fit replaces them (9.1).
- Area's and Fog's More toggles, Line up grid's More and its open state, the compact stamp bar and `StampSheet`, the `fill` prop of `ScrollForMore` (its one caller was the rail).
- `data-rvtt-options="rail" | "foot"`.

**Kept:**

- The options element: one element, `role="toolbar"` named "<tool> options", before the toolbar in the page's order, never remounted by a rotation or a change of arrangement, so a draft, a half-typed field and focus survive turning the phone.
- `optionsShown` and the rule that a phone sheet or the list of panels hides the options (`Room.tsx:464`).
- Every tool's state, its reset rules on a tool, scene or role change (docs/design-v1-layout-hierarchy.md 3.5's list), and every key.
- The options over a lasting notice where they would meet it (8).
- The side panel's hiding, the sideways sheet's Hide, the very short sheet, the handout viewer and the ten moves of docs/design-v1-layout-hierarchy.md, unchanged.

**New:** the arrangement (4), the toolbar's grouping, pair and tuck (5), the strip and its fit (6), popovers (7), the line (8). `data-rvtt-arrangement` on the options element ("stacked", "floating", "merged", "pair"), `data-rvtt-slot` on each slot where it is drawn (never in the measuring layer), for the tests. On the phone layout the toolbar's fill and top edge move to an `aria-hidden` backdrop under the options (`theme.z.options − 1`), which takes the toolbar's taps between its buttons, so the merged row is never painted under the toolbar's fill. The `nav` keeps its buttons at `theme.z.bars`.

### 10.2 The measured box contract

Room measures the options as drawn, in layout px, and publishes three things:

- **The row**: the row's drawn height while it stands at the foot (stacked: its box. Floating: its box and the 6 px gap). 0 merged, in the pair, tucked, with no row (6.6), or under a sheet.
- **The line's reserve**: while the tool has a line, its one-line height and its 6 px gap, kept at its last measure while a popover hides it and while it is expanded, so nothing moves when a popover opens or the pill grows. Tucked mid-task, the "options hidden" pill's height and gap. 0 with no line, tucked with no task under way, or under a sheet.
- **The highest control**: the top of the row's highest control, never a popover's and never the measuring layer's. And the line's top, where the line holds a reading, a warning or a status rather than a hint.

From these:

- `Chrome.bottom` = the toolbar with the bottom safe area, the row and the line's reserve: everything that stands over the map's foot.
- `Chrome.controls` = the toolbar with the bottom safe area, then up to the row's highest control, or up to the line's top where the line is a reading, a warning or a status. A hint may be covered, as today.
- `Chrome.toolbar`, `Chrome.safe`, `Chrome.sheet`: unchanged. `Chrome.rail`: removed.
- `insets` for the camera: `top` the top bars, `bottom` = `Chrome.bottom` in screen px, `left` and `right` 0.
- **Popovers and an expanded line** are passing overlays: they change none of these numbers.

This keeps the rule today's design set (a tool's options report their drawn box and their highest control), with "the box" now one row plus one line.

### 10.3 Every reader, after

| Reader | Today | After |
|---|---|---|
| The free area (`freeArea`) and the docked token bar | Map less `Chrome.bottom`, the rail at the left | Map less `Chrome.bottom`, the left safe area at the left. The bar shows only with Select, whose Multi-select row is the only options it meets. Merged or in the pair, that row is inside the toolbar, so at 844 x 390 at 130% Multi-select's free height is 151 px and the bar docks (today 99, compact) |
| The lane, `shareLane`, Move bar, the stored spot | Read the free area | Unchanged rules on the new free area. The token window design may change the bar's size and buttons: these rules read only the free area |
| The compact token bar (`compactHang`) | To 8 px above the toolbar when that leaves 148 px, covering only the Multi-select bar, else over the toolbar | Unchanged rule. Stacked, it covers the Multi-select row as today. Merged and pair, the row is inside the toolbar: the bar either leaves the toolbar and its row in view, or covers both, hiding Done and Actions with the tools until it closes, as it hides them today. Its z (16) is over the row (14) and the toolbar (15) |
| The alerts column's cards | Width from the map less the rail. Height down to `Chrome.bottom` | Width from the map less the safe areas and a sheet, as before the rail. Height down to `Chrome.bottom`, so the cards stop above the line as they stop above today's hint |
| The column's cramped test (`toOptions`) | `Chrome.bottom` | The same reading. Against today's foot bar the number is smaller (one row stacked, none sideways), so the summary row stands in for the cards less often. Against the rail it is larger by the line, the price of keeping the cards off a reading |
| The alerts' summary row (`raisedRow`) | Best above `Chrome.bottom`, else above `Chrome.controls`, else highest. Its left past the rail | The same three floors on the new numbers. Its left past the left safe area. The third floor (no spot above the tool's buttons) remains reachable on a stacked 480 x 320 at 130% in a fight |
| The summary row's tap (`askedAlerts`) | Cards over the options down to the toolbar | Unchanged |
| The very short mode and its modal sheet | Decided from the top bars and the 60 px toolbar | Unchanged: it never read the options. It hides the options, so it closes any popover (7.4) |
| Notices, beside the lane or spanning | Spanning right of the rail | Beside the lane where 320 px are left there, else across the map, as before the rail. The row and the line stand over a lasting notice they meet (8) |
| "Viewing as Pat" | Room reports the free area's box while a rail shows | Room reports a box only beside the lane, as docs/design-v1-bar-dock.md 1.3 set it |
| A player's roll card at a narrow screen's foot | Stands on `Chrome.bottom` or the toolbar, right of the rail | Stands on `Chrome.bottom` (above the row and the line) or on the toolbar, from the left edge |
| Fit, Find, pans to a token, `keepInView` | Clear of `insets` with the rail at the left | Clear of the bars, the row and the line. Picking a tool refits a camera that is still a fit, as a bar appearing at the foot does today. Merged, a tool adds only its line |
| Panes on map points (label, light, pin, door, stop note, heights readout) | Clamp to `insets` | The same, so a pane never sits under the row or the line |
| Scene loading | Centers in the insets' area | The same, on the new insets |
| The Multi-select hint | `hintRoom` from the map or the bar's inner width | The fit (9.1) |
| The options' own cap | Under the top bars and lasting notices, at most half the screen | None: one row |

## 11. Accessibility

- **Names.** Every control keeps today's name, by today's rule: its visible words, or a tooltip that contains them, or a label where it has no letters. New names: a value chip is "<what>: <value>" ("Drawing tool: Pen", "Shape: Sphere", "Stroke: Mid, Solid", "Color: Yellow", "Pin color: Yellow", "Tint: None", "Builder mode: Heights and stairs"), which contains its visible words. ⋯ is "More options". The Setup button is "Setup tools", and "Setup tools: Map builder" while a setup tool is active, showing "Builder". The pair's second button is its tool's full label, described by "In use. Tap again for all tools." while active, since its menu takes the place of a pressed state, and by "Tap it, then again for all tools." while not. It carries its caret either way (5.1). Icon-only Undo and Redo keep "Undo your last change" and "Redo".
- **Roles.** The row stays `role="toolbar"` named "<tool> options", and the toolbar a `nav` named "Tools". Chips and ⋯ carry `aria-haspopup="dialog"` and `aria-expanded`, with `aria-controls` naming the popover while it is open. Setup, and the pair's button while its tool is active, carry `aria-haspopup="menu"` and `aria-expanded`. Tool popovers are `role="dialog"` without `aria-modal`, named by their title. A choice inside is a `radiogroup` of native radios with today's group name ("Drawing tool", "Shape", "Color", "Width", "Opacity"). Setup and Tools are `role="menu"`, named "Setup tools" and "Tools", their tiles `menuitemradio` named by the tool's full label with the active tool checked (5.1). A pressed toggle in ⋯ is still a button with `aria-pressed` and its fixed name.
- **The active tool's button** keeps `aria-pressed="true"`, as today, so a screen reader still hears which tool is chosen. `ToolButton` sets `aria-pressed` only while it has no `expanded` (`Room.tsx:1665`), so the active tool takes no `aria-expanded`: whether its options show goes in its description instead (`aria-describedby`, a visually hidden line), "Press again to hide its options." while they show and "Its options are hidden. Press again to show them." while they are tucked, for a tool with its own button (5.4). Setup and the pair's second button, whose second tap opens a menu, carry only the tucked line while their tool is tucked, "Its options are hidden. Pick it again in the menu to show them.", and the active tile in their menu carries the two lines of 5.1. It names the options with `aria-controls`. Other tool buttons carry none of these.
- **Live regions.** The line is one polite live region, visually hidden but present while a popover covers it. The heights stepper's value stays live as today. Nothing else announces: a refit, a chip's words and the pair's button are not live.
- **Tab order.** The line while it is a button, the row's controls in display order, ⋯, an open popover right after its anchor, then the toolbar. Merged or in the pair, the row stands right of the tools on screen and still comes before them in Tab order, where the options have always been. This is an accepted exception to a reading order that follows the screen (WCAG 2.4.3): the options must stay one element before the toolbar so a rotation never remounts them and keeps focus where it was (10.1), and Tab then meets them in the same place in every arrangement, the tool's options before the tools as everywhere else in the app. Each control and each popover control is its own Tab stop, except radio groups, which are one stop with arrow keys inside, as today. The measuring layer is inert and hidden.
- **Focus.** Picking a tool never moves focus. A popover or menu takes focus only when a key opened it (7.1). The fit never moves the focused control (6.4), and when the focused control leaves the row, focus moves to its neighbor, never to the page.
- **Targets and type.** 44 px targets in the row, the popovers and the toolbar. 16 px text in every field, the popovers' included. Disabled stays dim colors, never opacity. One primary per view: a popover adds none, and a primary in ⋯ keeps its look there.
- **Nothing needs hover or a long press.** Tooltips repeat or extend a visible name. A cut line opens with a tap.
- **Keys.** Unchanged (5.5). Inside a popover's radio group the arrow keys belong to the group (`ownsNavigationKeys`), and in its field the letters belong to the field (`isTextField`).

### 11.1 Keys for the shortcut sheet

The project owner's standing rule (2026-10-16): the shortcut sheet (`?`, and Menu, This device: `client/features/device/ShortcutSheet.tsx`) lists the room's keys and its key-plus-pointer combinations (Shift or Ctrl+click, a key with a drag, Space+drag, a right or middle drag, Ctrl+wheel), from the registry in `client/state/shortcuts.ts`, `SHORTCUTS` and `BEHAVIORS` beside it, and FEATURES.md's shortcut tables mirror them (`shortcuts.test.ts` fails when they disagree). Plain taps, clicks, drags and touch gestures are not listed there, by the project owner's word: "just the key + click and key + drag behaviors". So the tap that tucks, Setup's and the pair's taps, a press on the map closing a popover, two fingers keeping it open, and the taps on the line and the "options hidden" pill stay rules of this design (5.1, 5.2, 5.4, 7.1, 7.4, 8) and get no sheet row. This design adds no key-plus-pointer combination.

The rows below are in the registry's shape (`Behavior`: input, does, roles, when, device, surface), against its sections: "Keys" for the whole room, then one per surface (`SURFACES`). The toolbar's keys go in a "Toolbar" section. The two keys that work only in the options row and its popovers go in a "Tool options" section after it.

The sheet's registry is being revised in its own build now (keys and key combinations only, sections renamed: its dialog rows are `dialogEscape` and `dialogTab` in a "Dialogs" section, and it has no "Toolbar" section yet). So this build adds its rows against the registry as it stands when this build lands, adding the "Toolbar" and "Tool options" sections to `SURFACES` where they do not exist yet. The ids and section names below name the intended rows, not fixed names: where the registry has a row for the same key, such as the room's Escape, this build changes that row's words rather than adding one. User text says "pop-up", never "panel", which names the side panel's panels.

| id | Input | Does | Roles | When | Device | Surface | Change |
|---|---|---|---|---|---|---|---|
| `toolKeyShow` | The key of the tool in use | Show its hidden options again. It never hides them | everyone | | keys | Toolbar | New |
| `toolMenuKeys` | Arrow keys, Home, End or a letter in Setup or the tool menu | Move to a tool. Enter or Space picks it, or on the tool in use hides or shows its options. Escape closes the menu, and Tab closes it and moves on | everyone | | keys | Toolbar | New |
| `optionsOpenKey` | Enter or Space on a button that shows a value, or on More options | Open its pop-up with the keyboard in it | everyone | | keys | Tool options | New |
| `optionsChoiceKeys` | Arrow keys in a pop-up's choice | Change the choice and keep the pop-up open. Enter or Space picks it and closes the pop-up | everyone | | keys | Tool options | New |
| `escape` | Escape | Close an open pop-up first, then a sheet or the token's action bar. With neither open, let go of the selection and end Multi-select. A field outside the pop-up keeps its Escape | everyone | | keys | | Changed: the pop-up comes first |

- The "Toolbar" section's intro (`SURFACE_INTRO`) gains: "Each tool key picks its tool, also one behind Setup or the tool menu." The tool keys' own rows in "Keys" keep their words.
- The "Tool options" intro: "A tool's options row, its More options and the pop-ups its buttons open."
- Multi-select adds nothing here. Its rows are renamed by the token window build's first commit, which this build follows (15), and its row's Actions and Done are buttons, not keys.
- The sheet's own revision and the token window build may reword the room's Escape row too. Whichever lands last keeps every change in that row. Where the sheet build keeps a row for Android's Back, its words gain "a pop-up" among what Back closes first (7.1).
- Nothing is removed by this design: the rail, the More toggles and the compact stamp bar had no keys of their own, and their controls keep their names in the row or behind ⋯.

## 12. Mockups

The handoff's own frames, rendered from its board, are in the project owner's screenshot folder under `raccoon-vtt/tool-options-design`: `handoff-frame-2a.png` to `handoff-frame-2d.png` (the chosen direction), `handoff-frame-1a.png` to `handoff-frame-1f.png`, and `handoff-catalog.png` (every tool's row at 390 and 656 px). In 2b to 2d the mock draws the merged row under the toolbar's fill (section 2). The rows below use today's measured widths (3.4), so they show the rules at work, not final pixels.

A player, upright 390 x 844, Draw. The row is 53 px. The line floats:

```
+------------------------------------------+
| o Crypt  (Pat)                 Find Fit  |
|                                          |
|                  map                     |
|                                          |
| (Draw with one finger.)                  |
+------------------------------------------+
| [Pen v] (o) [== Mid v] [<-]        [...] |
+------------------------------------------+
| Select Ruler Area Draw Ping  |  Panels   |
+------------------------------------------+
```

The same player at 844 x 390, merged: the map keeps its whole height (256 px):

```
+------------------------------------------------------------------------------------+
|     o Crypt (Pat)                                                 Find  Fit        |
|                                                                                    |
|                                   map, 256 px                                      |
|     (Draw with one finger.)                                                        |
+------------------------------------------------------------------------------------+
|     Select Ruler Area Draw Ping | [Pen v] (o) [== Mid v] [<-] [...]  |  Panels     |
+------------------------------------------------------------------------------------+
```

A DM at 844 x 390, the pair, Fog with a draft and the Tools popover open over the toolbar:

```
+--------------------------------------------------------------------------------------------------+
|     o Crypt (DM)                               undo redo                       Fit               |
|        +-----------------------------------------------------+                                   |
|        | TOOLS                                               |            map                    |
|        | [Select] [Ruler] [Area] [Fog] [Draw] [Ping]         |                                   |
|        | [Add token] [Pin] [Map builder] [Line up grid]      |                                   |
|        +-----------------------------------------------------+                                   |
+--------------------------------------------------------------------------------------------------+
|     Select [Fog ^] | [Clear fog|Add fog] [□ v] [Undo] [Reveal to players (4)] [...]  |  Panels   |
+--------------------------------------------------------------------------------------------------+
```

A player at 844 x 390 at 130% (649 x 300), the pair, Area placing a Fireball, the shape popover open. Size and the spell search live in it while the row has no room for them:

```
+--------------------------------------------------------------------+
|     o Crypt (Pat)                                    Find  Fit     |
|         +-----------------------------+                            |
|         | SHAPE                       |                            |
|         | [Spell, e.g. fireball     ] |           map              |
|         | [Cone] [Sphere] [Cylinder]  |                            |
|         | [Cube] [Line] [Emanation]   |                            |
|         | Size   [-]  20 ft  [+]      |                            |
|         +-----------------------------+                            |
+--------------------------------------------------------------------+
|     Select [Area ^] | [Sphere v] [Place] [Cancel] [...]  |  Panels |
+--------------------------------------------------------------------+
```

A DM on a computer, 1280 x 800, Area placing. The row floats at the left with the line above it, cut and ready to open, and the side panel stands at the right:

```
+----------------------------------------------------------------------------------+
| o Crypt (DM)              undo redo [Goblin 2 R3]  Fit            | side panel   |
|                                                                   |              |
|                           map                                     |              |
| (Fireball · In area (3): Goblin 1, Goblin 2, Thorn (al…)          |              |
| +---------------------------------------------------------+       |              |
| | [Sphere v] [- 20 ft +] [Place] [Shared] [Cancel] [...]  |       |              |
| +---------------------------------------------------------+       |              |
| [sel][rul][area][fog][draw][ping] [add][pin][bld][grid]           |              |
+----------------------------------------------------------------------------------+
```

A player at 480 x 320, stacked: the pair would leave the row 174 px, so the row stands above the toolbar:

```
+--------------------------------------------------+
|     o Crypt (Pat)                 Find  Fit      |
|                  map, 134 px                     |
|     (35 ft · every diagonal 5 ft)                |
+--------------------------------------------------+
|     [Keep] [Clear] [Kept rulers (2) v]           |
+--------------------------------------------------+
|     Select Ruler Area Draw Ping  |  Panels       |
+--------------------------------------------------+
```

## 13. Edge cases

### 13.1 By size

Insets as in 4.3. "Map" is the map's height between the top bar and what stands at the foot, with a tool whose row shows and no turn band (48 px less with one), in layout px: the row's 53 px stacked, nothing merged. The line floats over the map either way. Player and DM give the arrangement and its room (4.3). What the rows show is in 13.2.

| Size | Interface | Player | DM | Map with a tool (today's worst) | Notes |
|---|---|---|---|---|---|
| 320 x 568 | 100% | stacked, 304 | stacked, 304 (toolbar scrolls) | 403 | |
| 320 x 568 | 130% (246 x 437) | stacked, 230 | stacked, 230 | 272 | The narrowest room, under `MERGE_MIN`. Every player tool keeps its priority-1 controls inline but Draw, whose stroke chip waits in ⋯. A DM's tools here send some to ⋯ (6.3 step 4): Fog with a draft keeps Clear fog as a chip and sends its publish button, Add token its kind chip, and the builder its edge, light or label text where they meet the mode chip |
| 390 x 844 | 100% | stacked, 374 | stacked, 374, seven buttons and Panels with no scroll | 598 (Area with More: 180) | |
| 390 x 844 | 130% (300 x 649) | stacked, 284 | stacked, 284, the toolbar scrolls | 403 | |
| 844 x 390 | 100% | merged, 358 | pair, 538 | 256 (61) | |
| 844 x 390 | 130% (649 x 300) | pair, 343 | pair, 343 | 166 (16) | Multi-select's free area 151: the token bar docks. A DM's height stepper waits in ⋯ (9.9) |
| 667 x 375 | 100% | merged, 275 | pair, 455 | 262 (75) | A player's Draw shows its stroke chip as the bar alone here |
| 667 x 375 | 130% (513 x 288) | pair, 301 | pair, 301 | 176 (32) | A DM's height stepper waits in ⋯ (9.9) |
| 480 x 320 | 100% | stacked, 370 | stacked, 370 | 134 | The pair would leave 174 |
| 480 x 320 | 130% (369 x 246) | stacked, 259 | stacked, 259 | 60, 12 with the band | Under `MERGE_MIN`: a player's Draw sends its stroke chip behind ⋯, as at 320 x 568. The row and line stand over Reconnecting where they meet it. With the band the line hides from sight (8). Popovers rise over the top bars where under one row is left (7.3). Tuck gives back 53 px |
| 932 x 430, side panel hidden | 100% (wide) | merged, 422 | pair, 602 | 296 | |
| 932 x 430, side panel shown | 100% | pair, 366 | pair, 366 | 296 | No Panels in the toolbar while the side panel shows |
| 932 x 430 | 130% (717 x 331) | pair, 387 | pair, 387 | 197 | |
| 1280 x 800 | 100% | floating, 622 | floating, 622 | 628 | All ten DM tools (17.1) |
| 1280 x 800 | 130% (985 x 615) | floating, 591 | floating, 591 | 443 | |
| 1280 x 480, mouse | 100% | merged, 960 | merged, 715 | 368 | A short computer window: the rail's last case |
| 820 x 1180 | 100%, 130% | stacked | stacked | | An upright tablet, the phone layout |

Interface sizes 85% and 115% fall between these rows. Every rule reads layout px, so a larger size moves a screen toward the pair and the stacked row sooner, never into a state these rows do not hold.

### 13.2 By role and tool state

What the row shows at four rooms, from today's widths: stacked at 390 (374), a player merged at 844 x 390 (358), the pair at 130% (343), floating at 1280 (622). "…" is ⋯.

| Tool and state | 374 | 358 | 343 | 622 |
|---|---|---|---|---|
| Ruler, DM, two kept | Shared, Keep, Clear, Kept (2) | (player) Keep, Clear, Kept rulers (2) | Shared, Keep, Clear, … | everything |
| Area placing | Sphere 20 ft, Place, Cancel, … | Sphere, Place, Cancel, … | Sphere, Place, Cancel, … | Sphere, Size, Place, Shared, Cancel, … (Spell in the shape popover) |
| Area, a placed area picked (DM) | Size, Copy, Done, … | (player) Size, Copy, Done, …, or for someone else's area Copy, Done | Size, Copy, Done, … | Size, Hidden, Damage, Copy, Delete, Done, … |
| Draw | Pen, color, Mid, Undo, … | Pen, color, Mid, Undo, … | Pen, color, Mid, … | Pen, color, Mid, Fill, Undo, Redo, DM only, … |
| Draw, text entry | Text, Add, Cancel, Pen, … | Text, Add, Cancel, color, … | Text, Add, Cancel, color, … | Text, Add, Cancel, Pen, color, Mid, Undo, … |
| Ping | Look here, Ping sound | Ping sound | Look here, Ping sound | the same |
| Fog with a draft | Clear fog \| Add fog, Reveal (4), … | | Clear fog \| Add fog, Reveal (4), … | Clear fog \| Add fog, Rectangle, Undo, Reveal to players (4), … |
| Builder, Brush | Brush, Undo, Stone, … | | Brush, Undo, Stone, … | Brush, Undo, Redo, Stone, 1 2 3, … |
| Builder, a stamp selected | Tint, Flip, Delete, Done, … | | Tint, Delete, Done, … | Snap, Tint, Flip, Duplicate, DM only, Delete, Done, … |
| Line up grid, a box | Apply, Nudge, 70 px per square, … | | Apply, Nudge, … | Apply, Nudge, 70 px per square, … |
| Add token | Blank monster, Monster…, … | | the same | everything |
| Pin | Pin color, DM only | | the same | the same |
| Multi-select | 3 selected., Actions, Done | the same | the same | the sentence, Actions, Done |

Chips with a glyph also show it where the row has room left after the fit (6.3 step 5): Area's shape chip at 358, 343 and 622, and Fog's shape chip at 622. Draw's tool chip keeps its words (6.2).

Roles: a player has no Shared, DM only, Clear all, Look here, Fog or setup tools, and a player not allowed to draw has the eraser-only Draw or no Draw. The arrangement counts Draw's button only while it shows for that player. "View as a player" is its own Room page with its own arrangement from the preview's size, its own last tool, tuck and popovers, and it answers no key.

### 13.3 By lifecycle

- **Rotation.** The arrangement changes (stacked and merged or pair), the options element stays mounted, the row refits around a pinned control, an open popover is placed again at its anchor or closes where its anchor is gone (Setup in the pair), tuck holds, and the tool's state and draft stay. A tool tucked from its own button can be shown again from the pair's Tools menu, and the reverse (5.2).
- **Interface size.** As a rotation: a new room, a refit, new measures.
- **The side panel shown or hidden** (wide). A new map width: the arrangement and the room follow, as the rail did.
- **A sheet opens** (phone). The options and the line go, a popover closes, tuck holds. A hidden sheet brings them back. Setup and Tools can still open over a sheet, from the toolbar (7.5).
- **The token's bar or window is open** (Select, a token selected). A DM on the phone layout can open Setup over the spanning bar or the docked token window. Escape closes Setup first, then the bar. A press on the window or the bar closes Setup and acts on what it pressed (7.1, 7.5).
- **Fingers arriving one by one.** A first finger on the map while a popover is open suppresses the tool and waits. A second finger turns it into a pinch or a two-finger pan, and the popover stays open, also when one finger lifts before the other. A finger that lifts alone, with no second having joined, closes the popover (7.1, 7.4).
- **Tucked mid-task.** The options hide and the line stays as "<tool> options hidden. Tap to show." (5.4). Stacked, the map gains the row's 53 px. The pill counts in the box (10.2).
- **The very short mode.** Over everything: the options are hidden under it as under any sheet.
- **Notices.** A lasting notice never moves the row. The row and the line stand over one they meet (8). A toast passes under an open popover.
- **A fight.** The turn band changes only the top bars: popovers lose 48 px of height and scroll sooner. The alerts column stops above the line. The summary row keeps above the row's controls and a reading.
- **A tool's state changes** (a draft begins, a polygon gets corners, a stamp is selected). The slots change, the row refits, unless held (6.4).
- **A remote change** (another DM device's fog draft, a kept ruler removed by the DM). As a state change.
- **Scene change.** Each tool resets as today, popovers close, the row refits.
- **Role change.** Tools reset as today, the arrangement counts the new role's toolbar, the last tool falls back to the Ruler if it is not in the new list.
- **Draw taken away from a player.** The tool closes as today, the toolbar loses Draw, the arrangement and the room follow (a player can move from the pair to merged as the toolbar shrinks).
- **Loading.** A lazy tool's row is drawn at full height from its first frame (6.6).
- **Offline.** Nothing new: the row is chrome.

### 13.4 Self-sweep

Swept against the matrix before commit. What it found, each fixed as a class:

- **A toolbar that changes with the tool** (the handoff's per-tool fallback): fixed by deciding the arrangement from the screen and the role (4.1).
- **A screen too narrow for the pair** (480 x 320): the stacked row (4.1).
- **Widths that move with a pick or a first tap**: stable widths for every control a press changes (6.2).
- **Things under the finger after a change**: the holds and pins (6.4), popovers placed once and scrolling inside (7.3), the line hidden only from sight (8).
- **A control in two places** (Size in the popover and in ⋯): homes (6.1), one place each.
- **Readers of the old box**: every reader in 10.3 checked for the rail, the cap and the hint. Three read the rail (the free area, the column, the roll card), two the cap (the options, the summary row's third floor), one the hint rule (Multi-select). The line counts wherever a hint counted before, so nothing that kept clear of a hint now covers the pill, and the summary row may still cover a hint.
- **Focus falling to the page** when a control unmounts (Fog's trio, the polygon's Cancel, a stamp's Done, which drop focus today): one rule (6.4).
- **Map presses that do two things**: a press that closes a popover never also acts (7.4).
- **Stacking**: the merged row painted under the toolbar's fill (the mock's slip) and popovers under notices: the backdrop (10.1) and `theme.z.popover` (7.6).
- **Radios duplicated by measuring**: the measuring mode (6.2).
- **Keys and the hidden tools**: `useShortcuts` reads `toolsFor`, not the buttons (5.5).
- **A ⋯ that held what it had room for**: with ⋯'s room always kept, the DM's Ruler at 343 px put its kept rulers behind ⋯. The fit now tries the row without ⋯ first (6.3 step 1). Multi-select's words became flexible text (9.1), so its count never waits behind ⋯ at any width.
- **Priority-1 sets against the floor**: each player tool's was summed in compact forms with ⋯, each DM tool's against the narrowest pair room (301 px). Draw's widest set (267.4 px as the kit draws it, 267.5 in Inter, its tool chip keeping its words since Pen, Text and Eraser have no glyph) set `MERGE_MIN` at 268, first set at 256 from narrower chips than the kit drew. The DM's own floor, `MERGE_MIN_DM` at 301, came from the same review: some sideways Android phones merged a DM's whole toolbar under 301 px. Draw's Undo at priority 1 made it outgrow the floor too, so it stays at the handoff's 2, where it still shows inline at 374 and 358 px. Draw's text Cancel went to 2 and the field's minimum to 96 px for the same reason. The one DM exception left is recorded where it lives (9.9) and in 13.1.
- **Short words that misled**: the blank token kind's "Monster" beside "Monster…" was dropped, and the kind keeps no compact form.
- **Focus out of ⋯**: a dialog opened from inside ⋯ returns focus to the anchor once its opener is gone (7.5).
- **Escape in a field**: the room's handler leaves fields alone, so the base takes Escape in the capture phase, in the popover's own field and in the field it hangs from, and leaves it to any other field (7.1).
- **The column against the line**: the cards keep off the line as they kept off the hint, which costs them the line's height against the rail, stated in 10.3 rather than hidden.

Round 1 of the design review found these, each fixed as a class:

- **Two contracts for one popover** (with the panel tabs design): one shared base, owned here (7.1), for placement, Escape, focus-out, Back, one open popover in the room and the map press, with one test file.
- **A first touch that closed a popover before a pinch could form**: the map press suppresses the tool at once but closes only when the press ends as one pointer (7.1, 7.4), with staggered touches tested.
- **Two keyboard models for one kind of choice**: Setup and Tools are the base's menus, drawn as tiles (5.1).
- **A pressed state lost to `aria-expanded`**: the active tool keeps `aria-pressed`, with shown or tucked in its description, and the merged row's Tab order is an accepted exception (11).
- **A popover beside the token's bar**: Setup can share the screen with the spanning bar and the docked window, and the press and Escape rules say what happens (7.5, 13.3).
- **A tuck that hid a task's way forward**: the "options hidden" pill (5.4, 8, 10.2).
- **Chip icons** by the project owner's answer (17.3): the glyph is added from the room left, so it never pushes a control behind ⋯, and a chip whose options do not all have a glyph keeps its words. Draw's tool chip therefore has no compact form, which set the floor at 268 (4.1).
- **Sheet rows in the wrong shape**: 11.1 is in the registry's own shape and sections, holds keys only by the project owner's later word, and no user text calls a popover a panel.
- **Build order**: after the rename (15).

Round 3 asked for two things, both done as rules: a pointer open now focuses the anchor itself, so Safari matches the other browsers (7.1), and a tool behind Setup or the pair's menu tucks by picking its tile again (5.1, 5.2, 5.4), so every tool but Select tucks.

Round 2 found one contract still split between this design and the panel tabs design, now set once in 7.1 for every popover and menu: a map press only closes, Tab moves on as from the anchor and Shift+Tab returns to it, and focus goes in only on a key open. Setup, Tools, their keys row, the unit tests and the toolbar e2e follow it. The stroke chip behind ⋯ at 320 x 568 at 130% is recorded as a choice under 9.4, and 11.1 now adds its rows to the sheet registry as it stands when this build lands.

Checked and left alone: the very short mode (it never read the options), the compact token bar's rule (it already covers the toolbar where it must, and the row goes with the toolbar), `askedAlerts`, the dock row (upright only), the stored bar spot.

## 14. Tests

Unit tests, `node:test`:

- New `client/components/popover.test.ts`, the shared base's one test file (7.1), for both consumers:
  - `popoverPlace`: the start edge clamped at both sides of the bound, the width cap and a minimum of the anchor's width, above and below, the height to the bound's edge, growing into the rise region below the minimum height and not without one, the scroll past both, a re-place when the anchor, the bound or the rise region changes, and none when only the content grows.
  - One open popover: opening a second closes the first, across consumers (a tool popover and More).
  - Escape: closes from inside, from the anchor, from the map and the page, and not from a text field or a select outside the popover and its anchor, nor under a modal dialog. The key is marked used only when it closes.
  - Focus: a key open puts focus on the chosen item or the first (Up, a menu's last), a pointer open puts it on the anchor, also where the browser would not (Safari). Tab past a popover's last control, or in a menu, closes it and moves on as from the anchor. Shift+Tab before a popover's first control, or in a menu, closes it with focus on the anchor. A move to another element outside closes, focus falling to the page does not, and a focused control that leaves hands focus to the next one.
  - The map press as a state machine over pointer events: one pointer down then up closes at up, a second touch before the first lifts cancels the close for that gesture, one of two fingers lifting then the other keeps it open, a right, middle or Space press and the wheel never close, a press elsewhere closes at once. The tool is suppressed from the first down for every consumer, More included.
- New `client/pages/optionsLayout.test.ts`:
  - `optionsArrangement`: every row of 4.3, a room one under the floor and one at it, the floor itself as the kit's chip and the theme give it, the DM's floor at the sizes it changes, heights of 499 and 500, a square layout, the side panel shown and hidden, labelled and icon-only buttons, a DM's grouped and wide toolbars, a player with and without Draw.
  - `fitRow`, each its own case:
    - Everything fits in full forms with no ⋯.
    - Everything fits with no ⋯ once compact forms are taken (the DM's Ruler at 374).
    - Content always in ⋯ skips the first pass and keeps ⋯.
    - Priority order, ties in display order, and a smaller later slot fitting after a larger one waited.
    - In the second pass, compact forms one at a time, lowest priority and last first, and never for a waiting slot of priority 2 to 9.
    - A priority-1 slot in ⋯ when nothing more compacts.
    - Homes in a chip's popover, and the shape chip's wider form only where it fits.
    - A flexible field's minimum and growth.
    - Pinned slots first, and a pin that cannot fit breaks.
    - The hold with ⋯ open: a slot that appears joins ⋯, one that goes leaves, ⋯ stays.
    - The same output for the same input.
  - The tool popovers' inputs to `popoverPlace` (7.3): the bound under the top bars and a lasting notice, the rise region to the top safe area, toolbar popovers over a stacked row.
  - The last tool: Ruler at the start, never Select, updated by every way a tool becomes active, back to the Ruler when its tool leaves the list. Tuck: a second tap on a tool's own button, a pick of the active tool's tile in Setup or Tools, a tool change, the active tool's key, and a change of arrangement, which keeps it.
- `client/canvas/barDock.test.ts`: the rail describe goes, except "the right safe area is off while the side panel shows" (`:540`), which moves to the free area's describe. The `phone()` fixture drops `rail`, and its `options` models a stacked row (53 px) or a merged one (0) with an optional line. The worked numbers of docs/design-v1-bar-dock.md 1.4 at 844 x 390 at 130% are recomputed with the merged row (Multi-select's free height 151: dock). `columnCards` without a rail. `noticeSpan` and the Multi-select hint tests go.
- `client/lib/escape.test.ts` is unchanged: `escapeTarget` keeps its order, since the base takes Escape before the room's handler sees it (7.1).
- `client/state/shortcuts.test.ts`: a key picks a setup tool and a tool the pair hides. The active tool's key shows tucked options and never tucks.
- `client/features/tools.test.ts`: the DM's phone toolbar with Setup, the wide toolbar with all ten, a player's unchanged.
- Delete `client/pages/optionsPlace.test.ts`. Drop `rail` from the `Chrome` literals in `client/canvas/barButtons.test.ts:71` and `client/features/tokens/statBlockOpen.test.ts:45`.

e2e, one file after another as docs/design-v1-visual.md 5.3 says. A new helper in `e2e/harness.ts`, `pickOption(page, tool, group, option)`, opens a group's chip, or ⋯ where the group waits there, and checks the option's radio, so tests stop reaching for native selects.

New `e2e/options.e2e.ts`, on E2E_PORT plus 15 (plus 12 to 14 went to other builds):

1. **Setup.** A DM's room with Pat's Thorn, goblins, ten of Pat's kept rulers, a fog draft, a map image with a grid box, a builder scene with a stamp, and a journal page.
2. **The reach sweep.** At 320 x 568, 390 x 844, 844 x 390, 667 x 375, 480 x 320 and 932 x 430 (insets as 4.3), and 1280 x 800, each at 100% and 130%, for the DM and the player, for every tool in every state of 13.2 and of section 9 (Area idle, placing on the map and picked, Draw full, text entry, polygon and eraser-only, Fog off, rectangle, polygon with corners, brush and with a draft, every builder mode with a stamp selected and not, Line up grid with no image, no box and a box, Add token both states, Pin all three, Ping, Ruler with ten kept rulers, Multi-select):
   - `data-rvtt-arrangement` equals 4.3's.
   - The row's controls stand on one line, and the row neither scrolls nor overflows (`scrollWidth <= clientWidth`).
   - Every slot of the state is reachable: inline and whole in reach (`wholeInReach`, nothing scrolled), or in ⋯ or its home popover, which opens with one tap, where it is whole in reach once the popover scrolls to it.
   - Every priority-1 slot is inline in the merged and pair arrangements, and for a player in every room at or over the floor: always for a player, and for the DM except the height stepper where 9.9 says.
   - The same checks at rooms just over the floor on phones the sizes above do not hold: a player at 844 x 390 at 115% (the pair) and 568 x 320 at 85% (merged, 276), a DM at 800 x 360 at 100% and 915 x 412 at 115% (the pair, under the DM's floor) and 740 x 360 at 85% (merged, 354).
   - The line stands above the row (or the toolbar), inside the map, and when cut its tap shows the whole text.
   - The map's height between the bars equals 13.1's, with no row height in the merged and pair arrangements.
3. **Nothing moves under the finger.** A `requestAnimationFrame` log shows a tool's first frame already in its arrangement. Picking Eraser in the drawing tool popover leaves Undo's box where it was. The first tap on Clear build (in ⋯) or a stamp's Delete leaves its box. Keeping a ruler with Keep leaves Keep and Clear where they were. A popover's controls stay put while Area's reminders grow it.
4. **Popovers.** A tap opens, a second closes. Two fingers pan with one open, and it stays (CDP touch), with the fingers arriving 50 ms apart, and again when one lifts before the other. A one-finger tap on the map with the stroke popover open closes it as the finger lifts and draws nothing, and with Ping and the Tools menu sends no ping. Opening More on the side panel closes an open tool popover, and opening a tool popover closes More. A tap on the map with More open and Ping active closes More and sends no ping. With Select and a token selected, Setup opens over the spanning bar at 390 x 844 and over the docked window at 820 x 1180: Escape closes Setup and leaves the bar, and a press on the window's Conditions closes Setup and opens Conditions. With a journal page being edited in the side panel at 1280 x 800 and a Draw popover open, Escape stays with the page. The wheel leaves it open. A tool key closes it. Escape closes it and focus returns to its anchor. Enter on a chip moves focus into its popover, and a tap puts focus on the chip. The arrows in the drawing tool popover change the tool without closing it. Back (`page.goBack()`, as the fold and bar dock tests press it) closes it before the room. A phone sheet opening closes it. Turning the phone places it again, or closes it where its anchor is gone. At 480 x 320 at 130% in a fight the shape popover shows its title and a row.
5. **The toolbar.** 390 x 844 DM: seven buttons and Panels, no sideways scroll. A tap on Setup opens the four setup tools as a `menu` with focus on Setup. Enter on Setup opens it with focus on the checked tile. Down, Right, Up, Left, Home, End and the letter M move through it, and Enter picks. Escape and Shift+Tab close it with focus on Setup, and Tab closes it with focus on Panels. Picking Map builder shows "Builder" on Setup, and T, M, B and G pick directly outside the menu. 844 x 390 DM: the pair. Ruler is the second button. A tap on it while active opens Tools, picking Fog puts Fog there, and R puts Ruler back. 844 x 390 player: five tools and the options in one row, and at 130% the pair.
6. **Tuck.** At 390 x 844 a DM with Map builder active opens Setup and picks Map builder's tile: the options hide, Map builder stays active (a stroke still paints), Setup shows the tucked chevron, and picking the tile again shows them. Enter on that tile does the same. At 844 x 390 in the pair the same holds through Tools for the Ruler. A tuck made in the pair holds after turning the phone upright, where the Ruler's own button shows it again. A second tap on Draw tucks: the button stays `aria-pressed="true"`, its description reads "Its options are hidden. Press again to show them.", the chevron shows, and stacked the map gains 53 px. Merged, the map's height does not change. D brings it back. Picking Ruler shows the Ruler's options. With an area on the map waiting for Place, a tuck leaves "Area options hidden. Tap to show." in reach, and its tap brings back Place.
7. **The box.** Fit with Draw active leaves no scene under the row or the line. With a concentration check at 480 x 320 at 130%, the summary row covers no control in the row and no reading. A player's roll card stands above the line. In a fight with Reconnecting at 480 x 320 at 130% the row and the line stand over the notice with every control in reach. A very short sheet opening closes an open popover.
8. **Accessibility.** The chips' names ("Drawing tool: Pen"), popovers as non-modal dialogs named by their title, choices as radio groups, the line one polite live region also while a popover covers it. A focused control is not moved into ⋯ by a resize. After Discard by keyboard, focus is on the next control in the row.
9. Nothing went wrong in the browsers.

Existing files:

- `e2e/layout.e2e.ts`: case 1's rail tests (`:447`, `:492`) and case 2 (`:514`, `:535`) become the arrangement checks of the new sweep and a rotation that keeps the options element (its marker stays). Case 3 (`:557`, `:614`) checks the cards, the summary row, a spanning notice and "Viewing as Pat" against the row and the line rather than a rail. Case 4 (`:647`) becomes Fit against the row and the line. `:700` drops its rail assertions (the options hide under the sheet and come back merged). `:1416` drops its rail assertions, and its toolbar padding check stays. `:1196` reads the `nav`'s buttons, which the options never join. The follow-ups `:1270` and `:1317` check their preconditions again with the stacked row at 480 x 320.
- `e2e/reach.e2e.ts`: `expectTool` stops scrolling the options and filtering by the bar's box. Every row control and ⋯ must be whole in reach as drawn. The sweep's sizes and states stay.
- `e2e/bardock.e2e.ts:606`: the Multi-select row stays one row with its sentence at 1280 x 800.
- `e2e/playerphone.e2e.ts`: tests 10 to 18 run on the new arrangements (Actions and Done stay inline at every size, 9.1). Test 19 (`:1088`, the capped Ruler options) becomes: the way-back row covers no row control and not ⋯, and the kept rulers in their popover are in reach. Test 14's "the card does not show" precondition is derived again.
- `e2e/dmphone.e2e.ts:602` and `:623`: their preconditions are derived again (the height 420 in `:623` was tuned to the old Ruler bar).
- `e2e/smoke.e2e.ts:288`, `e2e/vision.e2e.ts:503,536`, `e2e/maps.e2e.ts:335,358`, `e2e/size.e2e.ts:481-501`, `e2e/table.e2e.ts:235`: native selects become `pickOption`. `size.e2e.ts`'s compact stamp Tint and More dialogs become the Tint chip's popover and ⋯.
- Browsers: the e2e runs in Chrome only. These are checked by hand on real devices: on an iPhone in Safari, a spell field focused inside a popover with the on-screen keyboard up, a tap on a chip, Setup or the pair's button leaving focus on that button (7.1), which Safari does not do by itself, and, while typing Draw's text, whether a tap on the color chip drops the keyboard now that the base focuses the chip. On Android, Back closes a popover before anything else.
- Waived before merge by the project owner (2026-10-17): the build ships, and these hand checks follow on the devices named above, as with the PDF handouts.

## 15. Build plan

One part in one workspace, built after the token window build's first commit (the rename to Multi-select, docs/design-v1-token-window.md), since this design's tests, sheet rows and FEATURES text say "Multi-select". Each commit typechecks, passes the unit tests and builds. The e2e edits ride with the commit whose behavior they follow, and the new sweep comes last.

1. `feat(ui): layout rules for tool options in one row`: `client/pages/optionsLayout.ts` and its test (4, 6.3, 6.4, 5.2).
2. `feat(ui): popovers, value chips and the options strip`: the shared popover base (7.1), `client/components/Popover.tsx`, `client/components/popoverPlace.ts` and `client/components/popover.test.ts`, and `client/components/Menu.tsx` with `menuKeys.ts` and its tile option, unless the panel tabs build has landed them first, in which case this commit adopts them and adds the tile option. Then the strip, slots, measuring layer, value chip, tiles, ⋯ and line in `client/features/measure/controls.tsx`, the new glyphs in `components/Icon.tsx` (a caret, the up chevron, a sliders glyph for Setup, and the option glyphs of 17.2), `theme.z.popover` in `client/lib/theme.ts`. Every new size is a theme token, so the style drift tests (`client/lib/styleDrift.test.ts`, `styleDriftScan.test.ts`) pass. Nothing uses them yet.
3. One commit per tool, converting its `Options` to slots. Until step 4, the strip measures its own width inside today's bar, foot or rail, and draws its line above itself, so each commit runs:
   - `feat(ruler): ruler options in one row with kept rulers behind a chip`
   - `feat(areas): area options in one row, the more row behind more`
   - `feat(drawings): draw options in one row with tool, color and stroke chips`
   - `feat(fog): fog options in one row`
   - `feat(builder): builder options in one row, without the compact stamp bar and its sheets`
   - `feat(grid): line up grid options in one row with a nudge popover`
   - `feat(tokens): add token options in one row`
   - `feat(pins): pin options in one row`
   - `feat(pings): ping options in one row`
   - `feat(select): the multi-select bar on the options strip`
4. `feat(ui): one options row with a floating line replaces the rail`: `client/pages/Room.tsx` (the options element and its arrangements, the line, the measured box, `insets`, `Chrome` without `rail`, the toolbar's backdrop), `client/canvas/barDock.ts` and its test, `client/features/encounter/InitiativeStrip.tsx`, `client/features/rolls/PlayerRolls.tsx`, `client/canvas/Stage.tsx` (the map press a popover suppresses, read from the room's open-popover slot), `client/features/tools.ts` (no `optionsAt`), `client/canvas/TokenActionBar.tsx` (`ScrollForMore` without `fill`), the deletion of `client/pages/optionsPlace.ts` and its test, the fixtures in `barButtons.test.ts` and `statBlockOpen.test.ts`, the shortcut sheet's rows for Escape and the popovers' keys, with the "Tool options" surface (11.1), in `client/state/shortcuts.ts`, FEATURES.md (section 16: the options lines and the shortcut tables' rows for them).
5. `feat(ui): the toolbar merges with the options on short sideways screens`: `Room.tsx` `Toolbar` and `ToolButton` (Setup and Tools as tile menus, the pair, fixed widths, tuck with the active tool's description and the "options hidden" pill, the carets), the last tool and tuck in the room's scope (`client/state/scope.ts` slots), `client/state/shortcuts.ts` (a key shows tucked options, the wider reach of the tool keys, and the sheet's "Toolbar" rows and intro, 11.1) and its test, `client/features/tools.test.ts`, FEATURES.md (the toolbar lines, and the shortcut section's rows for them).
6. `test(e2e): every tool option reachable in the row or behind more at every size`: `e2e/options.e2e.ts`, `pickOption` in `e2e/harness.ts`.
7. `docs: point the layout, bar dock and visual designs at one-row tool options`: a status line in docs/design-v1-layout-hierarchy.md section 3 ("Replaced by docs/design-v1-tool-options.md") and its FEATURES line in section 9, the "options scroll past that room" and "capped options" sentences of docs/design-v1-bar-dock.md 1.3, and docs/design-v1-visual.md 3.4's first line.

The pointer registry and the sheet's Mouse, Touch and surface sections come from the shortcut sheet's own build. Whichever of the two lands second adds this design's rows to it.

Files the parallel token window build also edits: `canvas/barDock.ts` and its test (this design removes the rail and the hint rule there, that one the bar's buttons and size), `canvas/TokenActionBar.tsx` (this design only drops `ScrollForMore`'s `fill`). Whichever lands second keeps the other's change.

## 16. FEATURES.md

In "Phones, tablets and connection":

- The line "On a short screen held sideways, such as a phone, a tool whose options take more than one row opens them in a column on the left of the map that scrolls…" becomes: "A tool's options take one row. On a phone held upright it sits above the toolbar. On a phone held sideways it shares the toolbar's row, so the map keeps its whole height, and where the tools and the options do not fit side by side the toolbar shows Select and the last tool you used, whose second tap opens every tool. On a computer it floats above the toolbar. What does not fit the row waits behind ⋯ (More options), and a wider screen shows more of it. Choices with many values, such as the drawing tool, a color or an area's shape, show their value on a button that opens a small pop-up above the row, and the map stays live under it: two fingers still pan and zoom, and a tap on the map closes it without drawing or pinging. The tool's hint or reading floats above the row on one line, and a tap shows all of it when it is cut. A second tap on the active tool hides its options, and another brings them back, while the tool stays in use. For a tool behind Setup or the tool menu, picking it again there does the same. While a task is under way, such as an area not yet placed, a small "options hidden" line stays, and a tap on it brings them back. Buttons that show a value, such as an area's shape, add their icon where the row has room."
- After "On a phone, panels open as sheets…": "On a phone, the DM's setup tools (Add token, Pin, Map builder and Line up grid) sit behind Setup in the toolbar, which then shows the one in use. Their keys still pick them directly. On a computer all ten tools stay in the toolbar."
- In the line about notices that last: "Where even that leaves no room for a row of the tool's options, the options stand over it." stays.
- In the alerts line: "The action bar and the tool's options keep clear of notices that last, such as Reconnecting or the Starting view bar, and the options scroll past that room." becomes "The action bar keeps clear of notices that last, such as Reconnecting or the Starting view bar." and "as on a short phone with the Ruler" becomes "as on a small phone with the Ruler".

In "Building maps": the Stamp line ("A stamp turns, resizes, takes one of 8 tints…") gains "Its tint, flip, front, duplicate, DM only, delete and Done sit in the builder's row, or behind ⋯ where the row has no room, on every screen." The line "The builder's bar has Undo and Redo buttons" stays.

In the shortcut tables, mirroring the sheet: every row of 11.1 under its section, in the sheet build's table shape, with the changed `escape` row and the two section intros. Taps, clicks and touch gestures stay out of the tables, as the sheet keeps them out. `shortcuts.test.ts` compares the tables with the registry, so the two cannot drift.

## 17. Decided

The project owner answered on 2026-10-16: the first two with the recommended default, the third after the design review's first round.

1. **Setup on phones only.** The setup tools stand behind Setup on the phone layout, where that gives a toolbar that fits without scrolling. A computer keeps all ten tools with the divider, as today, since there is room and a DM preparing a scene there switches between them often (5.1).
2. **Plain glyphs, no new art.** The app keeps its own tool icons. Tiles, chips' compact forms and the Setup button use plain glyphs drawn in code in the toolbar icons' style, where a glyph shows the thing itself: a line, an arrow, a box, a circle, a polygon, the area shapes, the fog shapes, a caret, an up chevron, and a sliders glyph for Setup. Where no plain glyph fits (Pen, Text, Eraser, most builder modes), the tile shows words alone. No icon set is added (6.2, 7.2).
3. **Chip icons where there is room.** A chip with a glyph shows glyph and words, then words, then the glyph alone, by the room the fit gives it (6.2, 6.3 step 5). The glyph is the first thing to give way, and never pushes a control behind ⋯.
