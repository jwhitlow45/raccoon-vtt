# raccoon-vtt v1: a resting token bar on upright phones

Status: draft 1, 2026-10-24. Code is cited from `28ce4977` (main with batch 24, the bar's toast and tall-token fixes). This design changes how the token action bar sits on a phone held upright, as docs/design-v1-bar-dock.md 1.1 and 1.5 set it out. A computer, a tablet and a phone on its side keep the docked window of docs/design-v1-token-window.md, which section 7 shows does not share the problem. Combat's Uses button and drawer (docs/design-v1-combat-controls.md section 6), built beside this in lane B, fit both states (section 6).

The project owner, 2026-10-24:

> "The token pop up menu now kind of moves and grows weirdly even when collapsed such that it is impossible to get to some tokens near the edge of the map when it is open on mobile. Please do a design ui ux pass on it to come up with a way to make it a bit less intrusive while still being useful. When it is expanded it is totally fine to take up a lot of the screen just not when collapsed"

**What the owner calls collapsed** is the bar's usual size: Smaller, the size every bar opens at unless this device stored Larger (`rvtt.tokenBarLarger`). "Expanded" is Larger. The two other small forms are not it. The fold under a sheet is a row on the sheet's edge, not on the map, and the compact overlay appears only where the free area is under 148 px tall, which none of the phones measured reaches at 100%, nor 320 x 568 at 130% (every bar there opened with `data-bar-mode="span"`). Section 1.4 has the numbers.

**The answer in short.**
- **Resting** replaces Smaller. It is a strip of a fixed 114 layout px at the foot of the map's free area, across its width: a one-line header (name, AC and HP, Expand, Close) and one row of quick actions (the HP entry's field and Apply, then Conditions, Roll, Uses and the rest that fit). It never follows the token, never changes height while it rests, and never moves the map.
- **Reach**: the strip is a fixed cover at the map's foot. Pans keep 64 px of map clear of it, Fit, Find and every pan that opens the bar keep tokens out from under it, and any token can be panned into the band above it and tapped.
- **Expanded** replaces Larger. It grows up from the strip's place to about two thirds of the screen, sized from its content as it expands, and moves the map once so its token stays above it. It too stays put on a pan. It lasts while the bar stays open, and every new opening rests. Nothing is stored.

## 1. What happens today, measured

Measured on a production build of `28ce4977` on its own server with the e2e harness's settings, in Chrome with touch, upright phones of 390 x 844, 375 x 667 and 440 x 956 at 100% and 320 x 568 at 130%, as the DM and as a player (Pat, who owns Thorn). The map is 30 x 20 cells. Thorn (Medium, Pat's) stands in its middle with goblins below and right of him, and tokens of each size wait at the edges and corners: a Small darkmantle top left, a Large allosaurus top right, a Huge adult black dragon bottom left, a Gargantuan ancient black dragon bottom right, and Medium goblins at the middle of each edge. "Close" zoom is about 44 px a cell, a common table zoom on a phone, and "fit" is the camera a room opens with. A probe read the bar's box, its header, the camera and the toasts on every animation frame for 2 s after each event. All boxes are in CSS px from the page's top. Appendix A has every run, and the screenshots are in the `token-bar-pass` folder.

### 1.1 What moves or grows, and which code does it

Each row says what moved or grew, by how much (close zoom, CSS px), and the code that does it. The free area is 715 px tall at 390 x 844, 538 at 375 x 667, 827 at 440 x 956 and 401 at 320 x 568 at 130%.

| Event | What moved or grew | Code |
| --- | --- | --- |
| Opening | Right on its first frame and still for the next 2 s at every size, apart from a 4 px settle in the first 15 ms on an SRD monster. But it opens as tall as its content up to its side's room: Pat 195 to 358 at 390 x 844 (27 to 50% of the free area), the DM 302 to 554 (42 to 77%), the DM 213 to 460 at 375 x 667 (40 to 85%), 156 to 315 at 320 x 568 at 130% (39 to 79%) | `placeBar` and `spanHang` (barDock.ts:849, :802), the content measured before paint (TokenActionBar.tsx:893-920) |
| A pan of 120 or 240 px | The bar follows the token on every frame (12 or 13 boxes in a 200 ms pan), and its height follows the room on that side: at 390 x 844 Pat's bar went 358, then 404, then 298, and the DM's 358 to 478, and at 375 x 667 both went 208 to 372 | Stage's anchor from the camera on every frame (Stage.tsx:1374), `spanHang`, `maxHeight: hang.room` (TokenActionBar.tsx:1240-1242) |
| The token passes the middle | The bar flips sides: 418-776 under Thorn to 61-409 over him in one 240 px pan at 390 x 844, 347-599 to 61-339 at 375 x 667 | `spanHang`'s side rule, `height <= spaceBelow \|\| spaceBelow >= spaceAbove` (barDock.ts:810) |
| The token leaves the screen | The bar pins to the free area's foot or top at its whole content height: 372-776 for Pat and 272-776 for the DM at 390 x 844 with Thorn below the screen | `topBelow = max(ceiling, …)` and `bottomAbove = min(bottom, …)` (barDock.ts:806-809) |
| A roll card at Pat's foot | The free area's foot rises by the card, so the bar flips over Thorn and changes height: 418-776 to 61-289 at 390 x 844, 347-599 to 61-219 at 375 x 667, 463-867 to 61-334 at 440 x 956, and 324-480 to 147-480 at 320 x 568 at 130% (it grows, 156 to 333). It flips back as the card goes | `foot` (features/rolls/PlayerRolls.tsx:225) in `freeArea` (barDock.ts:122) |
| An alert card in the DM's column | No change for a bar under its token. A bar over its token is held under the card, and while one stands, a pan of 200 px grew the bar under Thorn from 358 to 504 | `spanLane` (barDock.ts:838) |
| A whisper | No change to the bar. The toast stood at 68-112, clear of it | Toasts move under a bar's header only where the header stands over them (`barToastTop`, design-v1-bar-dock.md 1.5) |
| Larger | The map moves once: 45 px (Pat) and 145 px (DM) at 390 x 844, 167 at 375 x 667, 79 at 440 x 956, 98 at 320 x 568 at 130%, and the bar grows to 404, 504, 418, 504 and 245. Smaller moves it back. With Larger stored, every opening moves the map | `largerShift` at the press and at each opening (TokenActionBar.tsx:977-1004), Stage's `shiftForBar` (Stage.tsx:452) |
| A drag of Thorn | The bar hides for about 440 ms and comes back in the same place. Pat's content grows by the Undo move row (402 to 454), and so does the box where its side has room (404 to 425 at 440 x 956) | The bar hides during a drag (Stage `barShown`), and the content's ResizeObserver |
| Another token tapped | The bar jumps to that token's place and size: 418-776 to 453-648 for a goblin at 390 x 844, 324-480 under Thorn to 79-235 over the goblin at 320 x 568 at 130% | The anchor and content change with the selection |
| A reload | The bar closes, since the selection is not kept, and the camera goes back to the room's fit | |

### 1.2 Tokens out of reach while the bar is open

A sweep kept Thorn's bar open (Smaller, as it opens) and, for each other token, panned it to seven heights down the free area, from 8% to 92%, at its own x, tapping where it stood. "Out of reach" means no height took the tap: the bar was there every time.

| Phone | Close zoom, Pat | Close zoom, DM | Fit, both |
| --- | --- | --- | --- |
| 390 x 844 | 6 of 10 | 6 of 10 | 0 of 10 |
| 375 x 667 | 6 of 10 | 6 of 10 | 0 of 10 |
| 440 x 956 | 4 of 10 | 4 of 10 | 0 of 10 |
| 320 x 568 at 130% | 6 of 10 | 6 of 10 | 0 of 10 |

Out of reach at close zoom: the darkmantle (top left corner), the allosaurus (top right), the goblins at the middle of the top and bottom edges, and, except at 440 x 956, both dragons (the bottom corners). In reach: the goblins beside and below Thorn and those at the left and right edges, which share his row. Every size of token was out of reach somewhere: Small, Medium, Large, Huge and Gargantuan.

### 1.3 Why

- **The bar follows the token, so it covers the same part of the map whatever the pan.** The unreachable tokens stand 9 to 10 cells (400 to 440 px at close zoom) above or below Thorn. Panned near the top, the darkmantle sat under the bar hung over Thorn (at 390 x 844 it stood at y 111 under 91-495). Panned lower, Thorn left the screen and the bar pinned to the foot at its whole height (372-776), where the darkmantle then stood. The bottom tokens met the same in mirror.
- **Its height is its content up to the room, which is most of the screen.** 195 to 554 px of a 538 to 827 px free area leaves no height where a token 400 px from Thorn stands clear of it. At 440 x 956 the taller screen let the two bottom dragons out, and at fit zoom the whole map is about 228 px tall, so a token is never that far from Thorn.
- **Not the pan limit.** `keepInView` keeps only 64 px of the map on screen, so any cell can be panned anywhere, and nearly every try landed within 2 px of its mark. The few that landed lower (the bottom tokens' first try, Appendix A.2) ran out of the sweep's strokes, not of the map's room. The bar's place, not the camera, keeps them covered.
- **The bar never covered its own token** in any opening measured. That rule (`spanHang`: a bar over the creature it acts on is what the dock exists to stop) is what forces the flip and the pin.

### 1.4 Collapsed, compact and folded

Every bar measured on the four phones (8 runs of 9 tokens at close zoom and 8 at fit, both roles) opened with `data-bar-mode="span"`, Smaller, at the heights above, and grew only by Larger. None opened compact: that needs a free area under 148 layout px, and the smallest here is 309 (320 x 568 at 130%, the turn band and Multi-select's bar would take it to 209). The fold under a sheet is a row on the sheet's top edge, off the map, and covers no token. So the owner's "collapsed" is Smaller, and the moving and growing are Smaller's: it follows, flips, pins and resizes as in 1.1, all at its usual size.

## 2. States on an upright phone

"Upright phone" is today's span mode (docs/design-v1-bar-dock.md 1.1): a layout under 600 px wide and no wider than tall, whose free area is at least 148 px tall. Everywhere else nothing changes.

| State | What it is for | Place and size | Moves the map |
| --- | --- | --- | --- |
| Closed | No bar | | |
| **Resting** | The selected token's name, AC and HP, the HP entry and the few actions used most, with the map in reach | A strip at the free area's foot, its full width, 114 layout px tall (3.1) | Never |
| **Expanded** | Everything the bar holds, with room to read it | Grows up from the same foot, as tall as its content up to about two thirds of the screen (5.1) | Once as it expands, and once for each new token it shows, so the token stays above it (5.2) |
| Folded | A sheet is open over the map | A row on the sheet's edge, as today (pages/fold.ts) | No |
| Hidden for a drag | A token drag is under way | Not drawn, as today | No |
| Hidden by a tap off | Multi-select's tap on empty map (docs/design-v1-bar-dock.md 3) | Not drawn, as today | No |

The compact overlay (docs/design-v1-bar-dock.md 1.4) stays as it is for screens too short to span, upright or not. It has no resting state, since its free area (under 148 px) would leave no map above a 114 px strip.

## 3. The resting bar

### 3.1 Place and size

- **Across**: the free area's width, as the span is today (8 px margins, safe areas out).
- **Down**: its bottom on the free area's foot, 8 px above whatever stands at the map's foot: the toolbar, the tool's options row (Multi-select's bar), and a roll card standing at a narrow screen's foot (`foot`, features/rolls/PlayerRolls.tsx). Its top 114 layout px above that.
- **114 px** (`REST_HEIGHT` in barDock.ts): the 1 px border, the sticky header's 52 (its 48 px row and the frame's 4 px top padding it takes in), an 8 px gap, the 44 px quick row, an 8 px bottom padding and the 1 px border. At 130% that is 148 screen px.
- **The strip draws exactly that height** (`height`, not `maxHeight`), and its scroller does not scroll: what does not fit the header's line or the quick row is in the expanded bar, never under a fade.

| Phone | Free area (layout px) | Strip | Band above it |
| --- | --- | --- | --- |
| 390 x 844, 100% | 61 to 776, 715 | 662 to 776, 16% | 593 |
| 375 x 667, 100% | 61 to 599, 538 | 485 to 599, 21% | 416 |
| 440 x 956, 100% | 61 to 888, 827 | 774 to 888, 14% | 705 |
| 320 x 568, 130% (246 x 437) | 60 to 369, 309 | 255 to 369, 37% | 187 |
| 320 x 568, 130%, Multi-select and a turn band | 60 to 269, 209 | 155 to 269, 55% | 87 |

Today's Smaller bar is 195 to 554 px tall at 390 x 844 (27% to 77% of the free area), on a side that changes with the token (1.1).

### 3.2 Still

While it rests, the strip's box changes only when the map's frame changes: a rotation, a new interface size, the toolbar's or the options row's height, a turn band or lasting notice coming or going at the top (which change the free area's top, not the strip), and a roll card standing at the foot or leaving it. Each of these changes the layout around it anyway. Nothing else moves or grows it:

- **A pan, a pinch or a zoom**: the strip is placed from the free area alone and reads no anchor (`placeBar`'s rest branch, 9.1).
- **Its content**: its height is fixed. A name of any length takes one line, with an ellipsis. The quick row never wraps (3.3). An Undo move or Doesn't count that comes after a move, a "Use 9" from a damage roll, a stat block that loads late, a death save, or new conditions change what the row holds, never its height.
- **Toasts**: they keep above it (3.5) and it publishes no header for them to move under.
- **Alerts**: the alerts column keeps above it or shows its summary row (3.5). A card never pushes the strip.
- **Time**: nothing waits on a timer. The box is right on its first frame, since its height is a constant and needs no measuring.
- **Another token tapped**: the new token's strip stands in the same box.

A roll card that comes to a narrow screen's foot lifts the strip by the card's height while it stands there, and lowers it when it goes. Recommendation R4 weighs this against the card standing on the strip.

### 3.3 What it holds

**The header**, one 48 px row, sticky as today, so Close and Expand stand where they stand in the expanded bar. Its title holds two lines: the token's name on one line with an ellipsis (the frame's name keeps the whole name), and under it, in the small muted size, the vitals the short layout keeps: AC and HP ("AC 14 · HP 24/24", or a player's "Healthy" for a creature whose numbers they lack, and "Dying", "Stable" or "Dead" where those replace HP). Where both do not fit on that line, AC goes first ("HP 195/195" at 320 x 568 at 130%), then the HP ends in an ellipsis. Then come the elevation badge where the token is off the ground, **Expand** (chevron up) and **Close**, which never shrink. A group's header reads "3 selected" with no vitals line. The mockup first put the vitals beside the name: at 320 x 568 at 130% that pushed Close off the strip and cut the name to "Th…", so they stand under it.

**The quick row**, one 44 px line, built from left to right:

1. **The HP entry's field and Apply**, for a viewer who may change the token's HP. The field takes the room the buttons after it leave, never under 72 px. It has no mode buttons: it takes the entry's typed math (`7` or `-7` damage, `+5` heal, `=20` set, `t5` temporary), and its placeholder names the mode it is in, as the entry's does. It is the same entry as the expanded bar's, so a half-typed number survives Expand and Collapse.
2. **"Use 9"**, the newest damage or healing roll the HP entry offers, while it offers one.
3. **The passing actions**: Undo move, Doesn't count, the door's, while they apply, in the full bar's order.
4. **Conditions**, for the DM and the token's owners. It expands the bar with the Conditions drawer open (3.4).
5. **Roll**, for the DM and the token's owners, which opens the Dice panel as today.
6. **Uses**, where combat lane B shows it (section 6).
7. **Hidden**, for the DM.
8. **Details**, then **Multi-select**, for a viewer with none of the above, such as a player on a monster.

Each shows only where it fits whole in what is left of the line after those before it, with the field kept at 72 px. One that does not fit is skipped, and a narrower one after it may still fit. A skipped action is in the expanded bar, where every action stays. The fit reads each button's drawn width, so the device's font, the interface size and the browser's minimum font size count (as `BarWidthProbe` measures the window's default width).

Measured in the mockup (Appendix B), the DM and Pat on Thorn get the field and Apply, then: Conditions and Roll at 390 x 844 and 375 x 667 (348 and 333 px inside the padding), and room for one more at 440 x 956 (a Uses there, but not Hidden, at 98 px). Conditions alone fits at 390 x 844 at 130% and 320 x 568 at 100%, and Roll alone at 320 x 568 at 130%, where Conditions is too wide and Roll, after it, fits. Pat on a goblin gets Details and Multi-select.

### 3.4 Why these

The HP entry leads because HP is the change made most at the table, and because the bar's own ranking (docs/design-v1-token-panel.md 3.3) and the short layout keep "AC, HP and the HP entry at the top" with "Apply in view" on every phone (docs/design-v1-token-window.md 5.8). Conditions and Roll come next because the play row ranks them first for the DM and the owners (barButtons.ts `barButtons`). The passing actions answer the move just made, so they come before the steady ones while they apply, but after the HP entry, so the field and Apply never move under a thumb. Hidden is the DM's most-used setup toggle. Duplicate, Locked, Delete, Size, elevation, Light, Attach and the summary's saves and defenses are rarer, and they wait one tap away in the expanded bar.

A drawer would grow the strip, so the actions that open one (Conditions, Uses) expand the bar with it open, and closing that drawer brings the bar back to rest (5.3).

### 3.5 Beside the alerts column and the toasts

- **The column** keeps its cards above the strip. Where its first card ends at least 8 px above the strip's top, the column stacks there and stops 8 px above it (`columnRoom`). Where it does not, the column shows its 44 px summary row (docs/design-v1-bar-dock.md 1.3), whose tap hides the bar as today. The strip itself never moves for a card: `restLane` in barDock.ts gives "stacked" or "summary" and never pushes the box.
- **Toasts** stop 8 px above the strip: while the bar rests, its top is the foot of the toasts' room, in place of the tool's highest control, so a stack that would reach it drops and scrolls by the existing rule (`fitToasts`, `toastTop`'s `optionsTop`). The strip publishes no header to `spanToastSlot`, so no toast moves for it (1.5's header rules apply to the expanded bar only).

## 4. Reach

**The mechanism: the strip is a fixed cover at the map's foot, which the camera keeps clear.**

- **Pans.** Stage's `keepInView` (lib/camera.ts) keeps 64 px of the map clear of the top bars and the toolbar. While the bar shows on an upright phone it also counts the bar's cover at the foot (`barCover`, now the bottom side for a bar across the free area), so the map's top edge never goes under the strip. The map's bottom edge may still rise to 64 px under the top bars, and the top edge come down to 64 px above the strip. So any cell can be panned into the band above the strip: a token at the top edge to the band's foot, one at the bottom edge to the band's top, corners likewise, at any zoom. The band is at least 87 layout px on the smallest case in 3.1 and about 600 on a 390 x 844 phone.
- **Nothing follows the token**, so a pan moves the token and leaves the strip. Today's bar moved with the selected token and pinned to an edge once it left the screen (1.3), which is what kept the edge tokens covered.
- **Fit the map, Find my token, the outliner's show on map, a tracker row, the party bar and follow the turn** fit or place into the area the cover leaves, as they do for a docked window (docs/design-v1-bar-dock.md section 4). A pan that opens the bar knows the strip's box before it exists (`restingBar`), since its place and height are fixed, so the token lands above it.
- **The token just tapped** may stand where the strip opens, if it was in the bottom 114 px of the free area. The strip then covers it, and the map does not move (R2). A one-finger pan, which leaves the bar open, brings it above. Every programmatic opening in the item above lands it clear already.
- The mockup (Appendix B) measured every edge and corner token reachable above the strip at all four phones, as the DM and as Pat, where today six of them are not (1.2).

The expanded bar keeps the same rule: it is the cover then, and the band above it is at least 120 px less its 8 px gap (5.1), so every token can still be panned above it and tapped.

## 5. Expanded

### 5.1 Place and size

- **Bottom** on the same foot as the strip. It never hangs over its token and never flips: the top edge alone moves as it expands, collapses or changes token.
- **Height**: its content as measured when it expands, up to `largerRoom` as today: two thirds of the layout's height, but leaving at least 120 px of the free area above it (below the column's first card where the column stacks) for the token and its label, or the label gap, the token's drawn height and 12 px for a tall or zoomed token (docs/design-v1-bar-dock.md 1.5, reviews BS-F1 and BS-ASTRA-01). Content that grows after that, such as a stat block that loads late or a drawer opened inside it, scrolls under "Scroll for more" (review BS-O3).
- At 390 x 844 that is at most 563 px (the DM's Thorn bar measures 502, so it shows whole), 418 at 375 x 667, 637 at 440 x 956 and about 189 at 320 x 568 at 130%.
- Everything the bar holds today shows, in today's order, with the short layout ("More stats") where today's rule gives it (`barShort`, 9.3).
- Its header publishes to `spanToastSlot` as the spanning header does today, so a toast that would cover Close or Collapse moves under the header (docs/design-v1-bar-dock.md 1.5, reviews LP19-BS-2 and FU24-OPUS-1). It changes its place only as it expands, as a card stacks above it, or as its content shrinks below its height.

### 5.2 The map as it expands

As the bar expands, after its content is measured and before the browser paints, the map moves up just enough that the token's label clears the expanded bar's top (`expandShift`, today's `largerShift` for a bar under its token), and no more than keeps the token's top, at its drawn height, below the toasts' foot as they stand (review LP19-BS-3) and inside the free area. A token already above the bar moves nothing. The same happens once for each new token the expanded bar shows (a tap on another token, Multi-select gathering or letting go). It never happens on a pan, a pinch, a drag's return, a fold's return or a turn of the screen.

### 5.3 Between resting and expanded

- **Expand** (chevron up) in the header, left of Close, expands. **Collapse** (chevron down), in the same place, rests again. Each is a 44 px icon button whose tooltip is its name, as Larger and Smaller are.
- **Conditions or Uses** in the quick row expands with that drawer open and scrolled into view. Closing that drawer (its button again) rests again, as does Collapse.
- **Collapse moves nothing.** The map stays where the expand left it, so the token, which now stands above the strip's top, stays in view. Today's Smaller moved the map back (R3).
- **What is kept**: expanded lasts while the bar stays open: through a tap on another token, Multi-select gathering or letting go of tokens, a token drag (the bar comes back expanded and moves no map), a fold under a sheet and the dock's Show. Once the bar closes (Close, Escape or Back, a tap on empty map, Done), the next bar rests. Nothing is stored: `rvtt.tokenBarLarger` is no longer read and is removed once, in try and catch, as the dock store starts (R1).

## 6. Combat's Uses

- **Resting**: Uses is the quick row's sixth action (3.3), after Roll, where lane B's rule shows it (the DM on any creature with a use, owners on theirs). After the field, Apply, Conditions and Roll, about 98 px are left at 440 x 956 and 48 at 390 x 844, so Uses (about 60) shows in the strip on the wider phones and is Expand then Uses on the narrower. In the strip, Uses expands the bar with the Uses drawer open, and closing the drawer rests again (R11). A Uses button whose block is still loading holds its place, as lane B's rule says, and the fit counts it so.
- **Expanded**: as lane B designs it, in the play row after Roll, with the drawer where Conditions opens. Its 44 px rows scroll inside the expanded bar's room under "Scroll for more".
- **Room**: neither state needs a new slot from lane B beyond the button's id in the quick row's order and the drawer's name for `expand` (9.4).

## 7. Larger screens and a phone on its side

The docked window stays as it is. Measured at 844 x 390 (a phone on its side) and 820 x 1180 (a tablet), with the same probe, the window never moved with a pan (one box through 12 camera frames each way, at both sizes), a toast or a drag. It changed only as the column stacked a roll card above it in the lane (61-322 to 113-322 at 844 x 390, the docked rule of docs/design-v1-bar-dock.md 1.3) and for another token's content (61-322 to 127-322 for a goblin), and its content grows it at its top edge, which stays away from its token since the window is not placed by one. Every token was in reach at 820 x 1180. At 844 x 390 the three tokens at the map's right edge stood under the window at every height the sweep tried at their own x, and a pan that brought each 80 px from the left edge reached it, as Fit and Find would. Neither the moving with the map nor the unreachable tokens happen there, so the window keeps today's rules.

## 8. The UI checklist

- **Loading**: nothing new waits. The strip's box needs no measuring. A quick action keeps its own busy and refused states (Undo move waiting on the server, Doesn't count refusing a second press). A Uses button still loading holds its place (section 6). Expanding shows the content at once, as Larger does today.
- **Keys and focus**: Expand and Collapse keep focus on themselves, which stay at the header's right edge. Conditions or Uses pressed in the quick row moves focus to the same button in the expanded bar, pressed, with its drawer after it, and closing the drawer from there keeps focus on the quick row's button again. Escape and Android's Back close the bar in either state, as today. Tab order: Expand, Close, then the field, Apply and the quick actions left to right. The frame stays focusable from script only (`tabIndex={-1}`). The field at the foot takes the phone's keyboard as the roll card's Total field at the foot does today, and focusing it changes nothing about the strip's box.
- **Screen readers**: the frame keeps `role="dialog"` and its name ("Thorn actions", "3 selected tokens"). Expand and Collapse are named by their action, with no `aria-expanded`, as Larger and Smaller are. A skipped quick action is simply absent from the strip, not hidden there, and is in the expanded bar's tree once it expands. The vitals line is read as part of the header's title, after the name.
- **Large interface sizes**: every size above is in layout px, so the strip is 148 screen px at 130% (3.1). The quick row's fit measures drawn widths inside the chrome's zoom. Alignment is measured at 390 x 844 and 320 x 568, at 100% and 130%, and at 1440 x 900 where the window docks as before. The mockup's strip had no finding over 1 px at any of the six phone sizes it ran (Appendix B).
- **Exact words**: "Expand", "Collapse", "AC 14 · HP 24/24" (the middle dot with a space each side), the entry's own placeholder ("7 or -7" in Damage mode) and Apply, and the quick actions' existing names: "Use 9", "Undo move", "Doesn't count", "Open door", "Conditions", "Roll", "Uses", "Hidden", "Details", "Multi-select". No new sentence.

## 9. The rules in code

### 9.1 barDock.ts

- `REST_HEIGHT = 114`.
- `placeBar` takes `state: "rest" | "expanded"` (default "rest") and, in span mode, returns for rest `{ anchor: "bottom", at: free bottom, room: REST_HEIGHT, left, width }` with `lane` from `restLane`, and for expanded the same bottom with `room = min(expandedHeight, largerRoom(layout, free, floor, tokenHeight))`, `floor` from `spanLane`. Neither reads the anchor for its place. `spanHang` goes.
- `restLane(column, restTop)`: "stacked" where the column's first card ends 8 px or more above `restTop`, else "summary". With no column, "none".
- `expandShift(input)`: today's `largerShift` for a bar under its token, with its toast rule. `smallerShift`, `carriedMove`, `readLarger` and `writeLarger` go, and `LARGER_KEY` stays only for the one removal.
- `barCover`: a bar as wide as the free area covers the bottom from its top. `restingBar` returns the strip's box in span mode (its place and height are known), so a pan that opens the bar lands clear of it.
- `spanRoomAtWorst(free)` keeps its name and signature for barButtons.ts and returns the expanded room for a 40 px token, `largerRoom` with no column. The short layout's verdicts do not change at the four phones (Appendix A).
- The dock store's `larger`, `largerFor` and `largerMoved` become `expanded: boolean`, `expandedFor: string | null` (the opening that moved the map) and `expandedHeight: number`. `expanded` resets where `largerFor` does today, as the bar goes away other than for a token drag.
- `restFit(widths, room, gap, fieldMin)`: which candidates show, in order, each where it fits whole.

### 9.2 The frame (TokenActionBar.tsx `BarFrame`, `BarHeader`, `FrameControls`)

- `FrameControls.rest: { resting: boolean; expand(): void; collapse(): void } | null`, null where the bar docks or opens compact. `size` goes.
- `BarHeader` shows Expand or Collapse in Larger's place. While resting it draws the name on one line and, under it, a `vitals` node the content passes, dropping its AC part first where the line is short (3.3).
- `BarFrame` draws `height: REST_HEIGHT` while resting and today's `maxHeight` while expanded, from `placeBar`. On Expand it measures the content first, stores `expandedHeight`, then calls `onShift(expandShift(...))` once per opening, before paint, as the Larger opening does today (`contentMeasured`, `openChecked`). It publishes the header to `spanToastSlot` only while expanded, and its box to `barDockSlot.bar` in both states.

### 9.3 Stage.tsx and Room.tsx

- Stage's `barCoverRef` counts a spanning bar's box (no longer `null` for span), and `scheduleCam` passes `largerEach(insets, cover)` to `keepInView` while a bar shows on an upright phone. `shiftForBar` is unchanged.
- Room's toasts take `min(optionsTop, rest top)` and `min(foot, rest top − 8)` while the bar rests (3.5).

### 9.4 The content (lane B's files)

- barButtons.ts `restButtons(input)`: the quick row's order of 3.3 as ids, from the same input as `barButtons`, plus whether the HP entry shows and whether Uses applies.
- TokenActionBar.tsx `TokenBarBody` and `GroupActionBar`: while `frame.rest?.resting`, `<BarHeader>` first, as in the expanded bar so React keeps it and its focus, with `vitals` (the short line's AC and HP as two parts), then `<RestRow lead={hp entry} items={...}/>` from the frame's new file. Conditions and Uses there call `frame.rest.expand()` and open their drawer, and the drawer's closing calls `collapse()` when it was opened so.
- features/tokens/HpSection.tsx: `HpEntry` takes `layout: "rest"`, which draws the field and Apply alone, the mode buttons and chips out (the chip comes back as the quick row's "Use 9").

## 10. Cases

| Case | Expected | Test |
| --- | --- | --- |
| Tap Thorn at 390 x 844 | The strip at 662 to 776, 114 tall, at once | e2e br-f-1 |
| Pan 240 px, both ways, bar resting | Strip box unchanged on every frame | e2e br-f-2 |
| Pinch zoom with the bar resting | Strip box unchanged | e2e br-f-2 |
| A whisper arrives | Strip unchanged, toast above it | e2e br-f-3 |
| Toasts that would reach the strip | Oldest logged ones drop, the rest scroll above it | unit `fitToasts` with the rest foot, e2e br-f-3 |
| A concentration card in the column (DM) | Strip unchanged, the card above it, or the summary row | unit `restLane`, e2e br-f-3 |
| A roll card at the foot (player) | Strip rises by the card's height, unchanged in height, and back after | e2e br-f-3 |
| Thorn dragged a cell | Bar hides during the drag, the strip returns in the same box, Undo move in its row | e2e br-f-4 |
| Undo move, Use 9, a late stat block | Row content changes, height stays 114 | unit `restFit`, e2e br-b-1 |
| Another token tapped while resting | Same box, new content, no camera move | e2e br-f-1 |
| A long name | One line, ellipsis, frame name whole | e2e br-b-1 |
| Every edge and corner token, bar resting, close zoom | Panned above the strip and tapped, at the four phones, both roles | e2e br-f-5 (reach) |
| A token in the strip's band tapped | Strip covers it, no map move, a pan reveals it | e2e br-f-5 |
| Fit the map, Find, a tracker row with the bar opening | Token lands above the strip | unit `restingBar`, `barCover`, e2e br-f-6 |
| Pan the map's top edge toward the strip | Stops 64 px above the strip | unit `keepInView` with the cover |
| Expand on a token in the middle | Bar grows up to min(content, cap), map moves so the label clears its top, once | unit `expandShift`, e2e br-f-7 |
| Expand on a token already above the cap | No map move | unit `expandShift` |
| Expand on a tall or zoomed token | Its top stays below the toasts' foot and the free area's top | unit `expandShift` |
| Collapse | Strip again, map unmoved, focus on Expand | e2e br-f-7 |
| Conditions from rest | Expanded with the drawer open, focus on Conditions. Closing it rests | e2e br-b-2 |
| Uses from rest | Expanded with the Uses drawer open. Closing it rests | lane B's combatuses e2e |
| Expanded, tap another token | Stays expanded, resized for its content, one map move at most | e2e br-f-7 |
| Expanded, drag, close, reopen | Comes back expanded after the drag with no move. A fresh opening rests | e2e br-f-7 |
| Expanded under a sheet, then Show | Folds, returns expanded | e2e fold (unchanged steps) |
| A stored `rvtt.tokenBarLarger` | Removed, bar opens resting | unit dock store start |
| Multi-select group, resting and expanded | Same rules, the group's header "3 selected" | e2e br-b-1 |
| Multi-select and a turn band at 320 x 568 at 130% | Strip 114, band 87, edge tokens reachable | e2e br-f-5 |
| Compact screen (480 x 320 at 130%) | Today's compact overlay, no resting state | playerphone, dmphone (unchanged) |
| Phone on its side, tablet, computer | Docked window as today | bardock, playerphone (unchanged) |
| View as a player | Same states, nothing stored | e2e br-f-7 |

## 11. Tests

**Unit** (`node:test`): barDock.test.ts gains `placeBar` in span mode for rest and expanded at the four phones and with a foot card, `restLane` at 7, 8 and 9 px of gap and with no column, `expandShift` under and above the cap, with a tall token and with a toast stack, `barCover` for a bar across the free area, `restingBar` in span mode, `restFit` (fits whole, skips one and keeps a narrower next, the 72 px field, nothing at 0 room), and `keepInView` with a cover (camera.test.ts). barButtons.test.ts gains `restButtons` for the DM, an owner, a player on a monster, a dead and a dying creature, with and without the passing actions and Uses. Each new test fails with its rule taken out: the builder removes the rest branch, the cover, the 72 px floor and the gap check in turn, and says so.

**e2e**, a new `e2e/barrest.e2e.ts` on E2E_PORT plus seven, which it shares with the phone files, run one file at a time. The frame lane's steps carry `br-f-`, the content's `br-b-`. Each step runs at 390 x 844, 375 x 667, 440 x 956 at 100% and 320 x 568 at 130%, as the DM and as Pat, with the probe of section 1 reading the bar on every frame:
1. `br-f-1` The strip opens at its place and height on its first frame and keeps them for 2 s, on Thorn and on each sized token near each edge, and a tap on another token keeps the box.
2. `br-f-2` Pans of 120 and 240 px both ways and a pinch leave the box unchanged on every frame, and the camera's only moves are the gestures'.
3. `br-f-3` A whisper, a concentration card (DM) and a roll card (Pat): the box is unchanged, or for the roll card raised by the card's height and back, and no toast overlaps the strip.
4. `br-f-4` A drag of Thorn: the bar hides and returns in the same box with Undo move in its row.
5. `br-f-5` Reach: with the bar resting on Thorn, every edge and corner token is panned into the band above the strip and a tap at its middle opens its bar. Also with Multi-select and a turn band at 320 x 568 at 130%.
6. `br-f-6` Fit, Find and a tracker row's tap leave the token above the strip.
7. `br-f-7` Expand: the bar grows to min(content, cap), and the map moves once so the token's label clears its top. A pan moves nothing but the map. Collapse rests and moves nothing. A tap on another token stays expanded. A drag returns expanded with no move. Close, then a new tap, rests. In "view as a player", the same, and no `rvtt.*` key is written.
8. `br-b-1` and `br-b-2` (content): the quick row's actions per role, a long name, Undo move after a drag, and Conditions from rest expanding with the drawer and resting again as it closes.

`playerphone.e2e.ts` bs-1 to bs-3 and `dmphone.e2e.ts` lp19-bs2 and lp19-bs3 test Larger and Smaller. They become Expand and Collapse steps (bs-1 the button's place and size, bs-2 the drag, bs-3 the next token, lp19-bs2 a toast under the expanded header, lp19-bs3 the toast foot), with Collapse moving no map. Run them, `bardock` (docked windows unchanged), `fold`, `reach` and `alignment`.

**Alignment roots**: on the upright phones `window-thorn`, `window-goblin` and `window-group` now measure the resting strip, and `window-larger` and `group-larger` become `window-expanded` and `group-expanded`, at 390 x 844 and 320 x 568, 100% and 130%. A new root, `rest-row-pat`, measures Pat's strip on Thorn after a drag, with Undo move in its row. At 1440 x 900 the window's roots are unchanged. e2e/alignment.e2e.ts covers every screen this changes once those are in.

## 12. Build lanes

**Lane F, the frame**, beside combat lane B. It owns:
- client/canvas/barDock.ts and barDock.test.ts (9.1).
- client/canvas/TokenActionBar.tsx, only `FrameControls`, `FrameContext`'s default, `BarHeader` and `BarFrame` (the file's lines from `type FrameControls` to the end of `BarFrame`, today's 708 to 1340), and their imports.
- client/canvas/RestRow.tsx (new): `RestRow`, which lays out the lead and the candidates by `restFit`, measuring each candidate's drawn width.
- client/canvas/Stage.tsx, client/pages/Room.tsx (the toasts' two inputs only), client/lib/camera.ts and camera.test.ts if `keepInView` needs a change for the cover.
- e2e/barrest.e2e.ts, which its first commit creates with the room's setup, its `br-f-` steps, and an empty `br-b` block at its end for lane B. Also the Larger steps of playerphone.e2e.ts and dmphone.e2e.ts, and the alignment roots of section 11 in a block of their own at the end of alignment.e2e.ts.
- FEATURES.md lines 49 and 50 and docs/dm-guide.md's "On a phone held upright, the bar opens under the token", in its last commit.

**Lane B, the content**, owns, as its own design already gives it: client/canvas/barButtons.ts and its test (`restButtons`), TokenActionBar.tsx's `TokenBarBody`, `GroupActionBar` and every component they draw, features/tokens/HpSection.tsx (`layout: "rest"`), and the `br-b-` steps in barrest.e2e.ts's last block. If lane B's brief is already full, a short content lane stacked on lane B builds 9.4 with the same files, after it.

**What the two agree on, first** (lane F's first commit, a stub B builds against):
- `FrameControls.rest: { resting: boolean; expand(): void; collapse(): void } | null`, which replaces `size`.
- `RestRow` exported from client/canvas/RestRow.tsx with props `{ lead: ReactNode | null; items: readonly { id: string; node: ReactNode }[] }`. The ids are `BarButtonId`s or `"useRoll"`. RestRow keeps the order given and decides only which fit.
- `BarHeader`'s new `vitals?: { ac: ReactNode | null; hp: ReactNode }`, drawn under the name while resting.
- `REST_HEIGHT` (barDock.ts), which content never reads, since the frame fixes the height.
- The drawers that expand: `"conditions"` and lane B's `"uses"`, opened by content itself before it calls `expand()`.

Landing order: lane F's stub first, then B and F in either order. Lane F's alignment block and B's block are separate hunks at the file's end.

## 13. Recommendations to check

Each settles something the owner's words leave open, with the alternative rejected, judged by past decisions.

- **R1. Expanded lasts while the bar is open, and nothing is stored.** Rejected: remembering it per device, as Larger was (decision "token pop-up size on phones", a guess). Why: the owner now names collapsed as the state that must stay small. A stored expanded state would open every later token large and move the map each time, which is the "moves weirdly" the owner reports, and Larger stored once is how a phone gets there today.
- **R2. A tap on a token in the strip's band does not move the map, and the strip covers that token until a pan.** Rejected: lifting the map once at opening (a map move at rest), and opening the strip at the top for such a token (the top holds the column, the toasts and the notices, and a strip there would move for a card). Why: the brief's "never moves the map by itself", and every programmatic opening lands the token clear already.
- **R3. Collapse moves the map nowhere.** Rejected: Smaller's move back (docs/design-v1-bar-dock.md 1.5, review LP19-BS-1). Why: with the bar always at the foot, moving back would often put the token under the strip, and dropping the move removes `carriedMove`'s bookkeeping.
- **R4. A roll card at the foot lifts the strip.** Rejected: the card standing on the strip. Why: the card's place rules (features/rolls/PlayerRolls.tsx, docs/design-v1-roll-request.md 5.7) took several review rounds and live in a third owner's file. The lift is one move as a new card arrives, when the layout changes anyway, and the strip keeps its height.
- **R5. The expanded bar grows up from the strip's foot and never hangs over its token.** Rejected: today's Larger as it is (it follows the token on a pan and flips over it). Why: one physical model, a bar that lives at the foot, and the owner's report that the bar moves. Expanded may be large, but not restless.
- **R6. "Expand" and "Collapse".** Rejected: keeping "Larger" and "Smaller" (decided for the chevrons in "Token bar size, review round 1"). Why: the owner's own words are expanded and collapsed, and the two states now differ in what they hold, not only in size. The chevrons stay.
- **R7. Conditions and Uses expand the bar with their drawer, and closing the drawer rests again.** Rejected: a pop-up above the strip, and expanding without closing again. Why: a pop-up would be a second way to show the same drawer, and a bar left expanded after one condition would undo the resting default.
- **R8. The quick row fits by measured widths.** Rejected: a fixed set per screen width, and a row that scrolls sideways. Why: labels change with font and interface size, as the window's default width already found (`BarWidthProbe`), and a sideways scroller hides actions with no hint.
- **R9. The compact overlay keeps no resting state.** Rejected: a strip there too. Why: its free area is under 148 px, so a 114 px strip would leave no map.
- **R10. The tool's options, the Multi-select bar included, stay under the strip as part of the foot.** Rejected: the strip covering them. Why: Actions and Done must stay in reach (docs/design-v1-bar-dock.md 3).
- **R11. Uses ranks after Roll in the strip.** Rejected: before Conditions for a creature with uses. Why: Conditions and Roll would then change places from creature to creature, and a quick row's places should hold. Uses is one more tap (Expand) on phones under 440 px.
- **R12. The vitals stand under the name, not beside it.** Rejected: one line with the name. Why: measured at 320 x 568 at 130%, the one line pushed Close off the strip and cut the name to two letters.

## 14. FEATURES.md and the DM guide

- Line 49's "On a phone held upright it spans the screen under the token." becomes: "On a phone held upright it rests as a strip at the foot of the map with the token's name, AC and HP, the HP entry and the actions used most, such as Conditions and Roll, and it stays put as you pan, so every token can be brought above it."
- Line 50 becomes: "On a phone held upright, Expand, just left of the action bar's Close, opens the whole bar, up to about two thirds of the screen, and moves the map so the token stays in view above it. Collapse rests it again. Conditions in the resting bar expands it with the Conditions grid open, and closing the grid rests it again. A bar you open afresh rests." The toast sentences that follow keep their meaning for the expanded bar's header.
- Line 51's "A phone held upright keeps one layout whichever token you tap, with Apply in view" holds for both states.
- docs/dm-guide.md's "On a phone held upright, the bar opens under the token." becomes "On a phone held upright, the bar rests at the foot of the map, and Expand shows all of it." The guide pass after the run retakes action-bar.webp on a phone.

## As built

(The builder fills this in the lane's docs commit with every place the build went its own way.)

## Appendix A. Measurements

### A.1 Openings

The bar's box on its last frame of 2 s after the tap, top to bottom, in CSS px, for each token near its edge or corner of the screen (close zoom) or where the room's fit put it. "Still" counts the boxes drawn in those 2 s.

| Phone | Who | Zoom | Darkmantle | Allosaurus | Dragon | Ancient dragon | Goblin top | Goblin bottom | Goblin left | Goblin right | Thorn | Still |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 390 x 844 | Pat | close | 157-352 | 189-384 | 429-624 | 387-582 | 147-342 | 503-698 | 482-677 | 482-677 | 61-363 | 1 each |
| 390 x 844 | Pat | fit | 356-551 | 367-562 | 573-768 | 573-768 | 356-551 | 573-768 | 470-665 | 470-665 | 470-776 | 1 each |
| 390 x 844 | DM | close | 166-695 | 198-727 | 70-624 | 61-582 | 156-660 | 194-698 | 61-363 | 61-363 | 61-363 | 1, 2 once |
| 390 x 844 | DM | fit | 356-776 | 372-776 | 61-464 | 61-453 | 356-776 | 61-465 | 470-776 | 470-776 | 470-776 | 1 each |
| 375 x 667 | Pat | close | 157-352 | 189-384 | 252-447 | 210-405 | 147-342 | 326-521 | 61-274 | 394-589 | 61-274 | 1 each |
| 375 x 667 | Pat | fit | 272-467 | 283-478 | 176-371 | 166-361 | 272-467 | 176-371 | 381-599 | 381-576 | 381-599 | 1 each |
| 375 x 667 | DM | close | 166-599 | 198-599 | 61-447 | 61-405 | 156-599 | 61-521 | 61-274 | 61-274 | 61-274 | 1 each |
| 375 x 667 | DM | fit | 272-599 | 288-599 | 61-372 | 61-361 | 272-599 | 61-371 | 381-599 | 381-599 | 375-599 | 1 each |
| 440 x 956 | Pat | close | 157-352 | 189-384 | 541-736 | 499-694 | 147-342 | 615-810 | 538-821 | 538-733 | 61-419 | 1 each |
| 440 x 956 | Pat | fit | 397-592 | 410-605 | 645-840 | 645-840 | 397-592 | 645-840 | 528-755 | 528-723 | not measured | 1 each |
| 440 x 956 | DM | close | 166-695 | 198-727 | 182-736 | 140-694 | 156-660 | 306-810 | 61-419 | 61-419 | 61-419 | 1, 2 once |
| 440 x 956 | DM | fit | 397-888 | 415-888 | 61-532 | 61-519 | 397-888 | 61-537 | 528-888 | 528-888 | not measured | 1 each |
| 320 x 568 at 130% | Pat | close | 194-446 | 226-478 | 79-320 | 79-278 | 184-436 | 141-394 | 79-235 | 79-235 | 79-235 | 1 each |
| 320 x 568 at 130% | Pat | fit | 259-480 | 268-480 | 79-290 | 79-290 | 259-480 | 79-290 | 324-480 | 324-480 | 324-480 | 1 each |
| 320 x 568 at 130% | DM | close | 205-480 | 237-480 | 79-320 | 79-278 | 195-480 | 79-394 | 79-235 | 79-235 | 79-235 | 1 each |
| 320 x 568 at 130% | DM | fit | 259-480 | 274-480 | 79-297 | 79-290 | 259-480 | 79-290 | 324-480 | 324-480 | 324-480 | 1 each |
| 844 x 390 | Pat | close | 127-322 | 127-322 | 127-322 | 127-322 | 127-322 | 127-322 | 61-322 | 127-322 | 61-322 | 1 each |
| 820 x 1180 | DM | close | 514-1112 | 514-1112 | 489-1112 | 489-1112 | 560-1112 | 560-1112 | 388-1112 | 560-1112 | 560-1112 | 1, 2 once |

### A.2 Reach sweeps

For each token out of reach, the heights tried (CSS px from the page's top) and what took the tap at its middle there: Thorn's bar, with its box. Every other token was reached at one of the heights.

- **390 x 844, Pat, close**: 6 of 10 out of reach.
  - Darkmantle TL: y 111: the bar 91-495, y 199: the bar 179-583, y 309: the bar 289-693, y 419: the bar 372-776, y 528: the bar 372-776, y 638: the bar 372-776, y 726: the bar 372-776.
  - Allosaurus TR: y 111: the bar 69-473, y 199: the bar 157-561, y 309: the bar 267-671, y 419: the bar 372-776, y 528: the bar 372-776, y 638: the bar 372-776, y 726: the bar 372-776.
  - Dragon BL: y 111 (landed 296): the bar 61-465, y 199: the bar 61-465, y 309: the bar 61-465, y 419: the bar 139-543, y 528: the bar 249-653, y 638: the bar 358-762, y 726: the bar 446-776.
  - Ancient BR: y 111: the bar 61-465, y 199: the bar 61-465, y 309: the bar 61-465, y 419: the bar 161-565, y 528: the bar 271-675, y 638: the bar 380-776, y 726: the bar 468-776.
  - Goblin Top: y 111: the bar 91-495, y 199: the bar 179-583, y 309: the bar 289-693, y 419: the bar 372-776, y 528: the bar 372-776, y 638: the bar 372-776, y 726: the bar 372-776.
  - Goblin Bottom: y 111 (landed 362): the bar 61-465, y 199: the bar 61-465, y 309: the bar 61-465, y 419: the bar 95-499, y 528: the bar 205-609, y 638: the bar 314-718, y 726: the bar 402-776.
- **390 x 844, Pat, fit**: 0 of 10 out of reach.
- **390 x 844, DM, close**: 6 of 10 out of reach.
  - Darkmantle TL: y 111: the bar 61-495, y 199: the bar 79-583, y 309: the bar 189-693, y 419: the bar 272-776, y 528: the bar 272-776, y 638: the bar 272-776, y 726: the bar 272-776.
  - Allosaurus TR: y 111: the bar 61-473, y 199: the bar 61-561, y 309: the bar 167-671, y 419: the bar 272-776, y 528: the bar 272-776, y 638: the bar 272-776, y 726: the bar 272-776.
  - Dragon BL: y 111 (landed 296): the bar 61-565, y 199: the bar 61-565, y 309: the bar 61-565, y 419: the bar 139-643, y 528: the bar 249-753, y 638: the bar 358-776, y 726: the bar 446-776.
  - Ancient BR: y 111: the bar 61-565, y 199: the bar 61-565, y 309: the bar 61-565, y 419: the bar 161-665, y 528: the bar 271-775, y 638: the bar 380-776, y 726: the bar 468-776.
  - Goblin Top: y 111: the bar 61-495, y 199: the bar 79-583, y 309: the bar 189-693, y 419: the bar 272-776, y 528: the bar 272-776, y 638: the bar 272-776, y 726: the bar 272-776.
  - Goblin Bottom: y 111 (landed 362): the bar 61-565, y 199: the bar 61-565, y 309: the bar 61-565, y 419: the bar 95-599, y 528: the bar 205-709, y 638: the bar 314-776, y 726: the bar 402-776.
- **390 x 844, DM, fit**: 0 of 10 out of reach.
- **375 x 667, Pat, close**: 6 of 10 out of reach.
  - Darkmantle TL: y 97: the bar 61-481, y 164: the bar 96-548, y 247: the bar 147-599, y 330: the bar 147-599, y 413: the bar 147-599, y 496: the bar 147-599, y 563: the bar 147-599.
  - Allosaurus TR: y 97: the bar 61-459, y 164: the bar 74-526, y 247: the bar 147-599, y 330: the bar 147-599, y 413: the bar 147-599, y 496: the bar 147-599, y 563: the bar 147-599.
  - Dragon BL: y 97 (landed 133): the bar 61-513, y 164: the bar 61-513, y 247: the bar 61-513, y 330: the bar 61-513, y 413: the bar 134-586, y 496: the bar 217-599, y 563: the bar 283-599.
  - Ancient BR: y 97: the bar 61-513, y 164: the bar 61-513, y 247: the bar 61-513, y 330: the bar 72-524, y 413: the bar 156-599, y 496: the bar 239-599, y 563: the bar 305-599.
  - Goblin Top: y 97 (landed 93): the bar 61-477, y 164: the bar 96-548, y 247: the bar 147-599, y 330: the bar 147-599, y 413: the bar 147-599, y 496: the bar 147-599, y 563: the bar 147-599.
  - Goblin Bottom: y 97 (landed 199): the bar 61-513, y 164: the bar 61-513, y 247: the bar 61-513, y 330: the bar 61-513, y 413: the bar 90-542, y 496: the bar 173-599, y 563: the bar 239-599.
- **375 x 667, Pat, fit**: 0 of 10 out of reach.
- **375 x 667, DM, close**: 6 of 10 out of reach.
  - Darkmantle TL: y 97: the bar 61-481, y 164: the bar 61-548, y 247: the bar 95-599, y 330: the bar 95-599, y 413: the bar 95-599, y 496: the bar 95-599, y 563: the bar 95-599.
  - Allosaurus TR: y 97: the bar 61-459, y 164: the bar 61-526, y 247: the bar 95-599, y 330: the bar 95-599, y 413: the bar 95-599, y 496: the bar 95-599, y 563: the bar 95-599.
  - Dragon BL: y 97 (landed 133): the bar 61-565, y 164: the bar 61-565, y 247: the bar 61-565, y 330: the bar 61-565, y 413: the bar 134-599, y 496: the bar 217-599, y 563: the bar 283-599.
  - Ancient BR: y 97: the bar 61-565, y 164: the bar 61-565, y 247: the bar 61-565, y 330: the bar 72-576, y 413: the bar 156-599, y 496: the bar 239-599, y 563: the bar 305-599.
  - Goblin Top: y 97 (landed 93): the bar 61-477, y 164: the bar 61-548, y 247: the bar 95-599, y 330: the bar 95-599, y 413: the bar 95-599, y 496: the bar 95-599, y 563: the bar 95-599.
  - Goblin Bottom: y 97 (landed 199): the bar 61-565, y 164: the bar 61-565, y 247: the bar 61-565, y 330: the bar 61-565, y 413: the bar 90-594, y 496: the bar 173-599, y 563: the bar 239-599.
- **375 x 667, DM, fit**: 0 of 10 out of reach.
- **440 x 956, Pat, close**: 4 of 10 out of reach.
  - Darkmantle TL: y 120: the bar 100-504, y 222: the bar 202-606, y 348: the bar 328-732, y 475: the bar 455-859, y 601: the bar 484-888, y 727: the bar 484-888, y 829: the bar 484-888.
  - Allosaurus TR: y 120: the bar 78-482, y 222: the bar 180-584, y 348: the bar 306-710, y 475: the bar 433-837, y 601: the bar 484-888, y 727: the bar 484-888, y 829: the bar 484-888.
  - Goblin Top: y 120: the bar 100-504, y 222: the bar 202-606, y 348: the bar 328-732, y 475: the bar 455-859, y 601: the bar 484-888, y 727: the bar 484-888, y 829: the bar 484-888.
  - Goblin Bottom: y 120 (landed 465): the bar 141-545, y 222: the bar 61-465, y 348: the bar 61-465, y 475: the bar 151-555, y 601: the bar 277-681, y 727: the bar 404-808, y 829: the bar 505-888.
- **440 x 956, Pat, fit**: 0 of 10 out of reach.
- **440 x 956, DM, close**: 4 of 10 out of reach.
  - Darkmantle TL: y 120: the bar 61-504, y 222: the bar 102-606, y 348: the bar 228-732, y 475: the bar 355-859, y 601: the bar 384-888, y 727: the bar 384-888, y 829: the bar 384-888.
  - Allosaurus TR: y 120: the bar 61-482, y 222: the bar 80-584, y 348: the bar 206-710, y 475: the bar 333-837, y 601: the bar 384-888, y 727: the bar 384-888, y 829: the bar 384-888.
  - Goblin Top: y 120: the bar 61-504, y 222: the bar 102-606, y 348: the bar 228-732, y 475: the bar 355-859, y 601: the bar 384-888, y 727: the bar 384-888, y 829: the bar 384-888.
  - Goblin Bottom: y 120 (landed 465): the bar 141-645, y 222: the bar 61-565, y 348: the bar 61-565, y 475: the bar 151-655, y 601: the bar 277-781, y 727: the bar 404-888, y 829: the bar 505-888.
- **440 x 956, DM, fit**: 0 of 10 out of reach.
- **320 x 568 at 130%, Pat, close**: 6 of 10 out of reach.
  - Darkmantle TL: y 103: the bar 79-476, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 79-480, y 406: the bar 79-480, y 456 (landed 448): the bar 79-480.
  - Allosaurus TR: y 103: the bar 79-454, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 79-480, y 406: the bar 79-480, y 456: the bar 79-480.
  - Dragon BL: y 103: the bar 79-480, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 87-480, y 406: the bar 150-480, y 456: the bar 201-480.
  - Ancient BR: y 103: the bar 79-480, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 109-480, y 406: the bar 172-480, y 456: the bar 223-480.
  - Goblin Top: y 103: the bar 79-476, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 79-480, y 406: the bar 79-480, y 456 (landed 448): the bar 79-480.
  - Goblin Bottom: y 103 (landed 111): the bar 79-480, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 79-480, y 406: the bar 106-480, y 456: the bar 157-480.
- **320 x 568 at 130%, Pat, fit**: 0 of 10 out of reach.
- **320 x 568 at 130%, DM, close**: 6 of 10 out of reach.
  - Darkmantle TL: y 103: the bar 79-476, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 79-480, y 406: the bar 79-480, y 456 (landed 448): the bar 79-480.
  - Allosaurus TR: y 103: the bar 79-454, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 79-480, y 406: the bar 79-480, y 456: the bar 79-480.
  - Dragon BL: y 103: the bar 79-480, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 87-480, y 406: the bar 150-480, y 456: the bar 201-480.
  - Ancient BR: y 103: the bar 79-480, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 109-480, y 406: the bar 172-480, y 456: the bar 223-480.
  - Goblin Top: y 103: the bar 79-476, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 79-480, y 406: the bar 79-480, y 456 (landed 448): the bar 79-480.
  - Goblin Bottom: y 103 (landed 111): the bar 79-480, y 153: the bar 79-480, y 216: the bar 79-480, y 280: the bar 79-480, y 343: the bar 79-480, y 406: the bar 106-480, y 456: the bar 157-480.
- **320 x 568 at 130%, DM, fit**: 0 of 10 out of reach.
- **844 x 390, Pat, close**: 0 of 10 out of reach.
- **820 x 1180, DM, close**: 0 of 10 out of reach.

### A.3 Events on Thorn's bar

Close zoom, Thorn 40% down the free area. First and last box of each 2 s probe, the range of heights and tops seen, and how many boxes it drew.

| Phone | Who | Event | First | Last | Heights | Tops | Boxes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 390 x 844 | Pat | open | 418-776 | 418-776 | 358 | 418 | 1 |
| 390 x 844 | Pat | toast | 418-776 | 418-776 | 358 | 418 | 1 |
| 390 x 844 | Pat | alert | 418-776 | 61-289 | 228 to 358 | 61 to 418 | 2 |
| 390 x 844 | Pat | alert gone | 61-289 | 418-776 | 228 to 358 | 61 to 418 | 2 |
| 390 x 844 | Pat | larger | 418-776 | 372-776 | 358 to 404 | 372 to 418 | 2 |
| 390 x 844 | Pat | smaller | 372-776 | 418-776 | 358 to 404 | 372 to 418 | 2 |
| 390 x 844 | Pat | pan -120 | 418-776 | 298-702 | 358 to 404 | 298 to 418 | 13 |
| 390 x 844 | Pat | pan 240 | 298-702 | 61-409 | 298 to 404 | 61 to 478 | 13 |
| 390 x 844 | Pat | pan -120 | 61-409 | 418-776 | 298 to 358 | 61 to 478 | 13 |
| 390 x 844 | Pat | drag | 418-776 | 418-776 | 358 | 418 | 1 |
| 390 x 844 | Pat | tap other | 418-776 | 453-648 | 195 to 358 | 418 to 453 | 2 |
| 390 x 844 | Pat | tap back | 453-648 | 418-776 | 195 to 358 | 418 to 453 | 2 |
| 390 x 844 | Pat | reload | - | - | - | - | 0 |
| 390 x 844 | DM | open | 418-776 | 418-776 | 358 | 418 | 1 |
| 390 x 844 | DM | toast | 418-776 | 418-776 | 358 | 418 | 1 |
| 390 x 844 | DM | alert | 418-776 | 418-776 | 358 | 418 | 1 |
| 390 x 844 | DM | alert gone | 418-776 | 418-776 | 358 | 418 | 1 |
| 390 x 844 | DM | larger | 418-776 | 272-776 | 358 to 504 | 272 to 418 | 2 |
| 390 x 844 | DM | smaller | 272-776 | 418-776 | 358 to 504 | 272 to 418 | 2 |
| 390 x 844 | DM | pan -120 | 418-776 | 298-776 | 358 to 478 | 298 to 418 | 13 |
| 390 x 844 | DM | pan 240 | 298-776 | 61-409 | 298 to 478 | 61 to 478 | 13 |
| 390 x 844 | DM | pan -120 | 61-409 | 418-776 | 298 to 358 | 61 to 478 | 13 |
| 390 x 844 | DM | drag | 418-776 | 418-776 | 358 | 418 | 1 |
| 390 x 844 | DM | tap other | 418-776 | 462-776 | 314 to 358 | 418 to 462 | 2 |
| 390 x 844 | DM | tap back | 462-776 | 418-776 | 314 to 358 | 418 to 462 | 2 |
| 390 x 844 | DM | dm alert | 418-776 | 418-776 | 358 | 418 | 1 |
| 390 x 844 | DM | dm alert pan -200 | 418-776 | 218-722 | 358 to 504 | 218 to 418 | 13 |
| 390 x 844 | DM | reload | - | - | - | - | 0 |
| 375 x 667 | Pat | open | 347-599 | 347-599 | 252 | 347 | 1 |
| 375 x 667 | Pat | toast | 347-599 | 347-599 | 252 | 347 | 1 |
| 375 x 667 | Pat | alert | 347-599 | 61-219 | 158 to 252 | 61 to 347 | 2 |
| 375 x 667 | Pat | alert gone | 61-219 | 347-599 | 158 to 252 | 61 to 347 | 2 |
| 375 x 667 | Pat | larger | 347-599 | 181-599 | 252 to 418 | 181 to 347 | 2 |
| 375 x 667 | Pat | smaller | 181-599 | 347-599 | 252 to 418 | 181 to 347 | 2 |
| 375 x 667 | Pat | pan -120 | 347-599 | 227-599 | 252 to 372 | 227 to 347 | 13 |
| 375 x 667 | Pat | pan 240 | 227-599 | 61-339 | 212 to 372 | 61 to 387 | 13 |
| 375 x 667 | Pat | pan -120 | 61-339 | 347-599 | 208 to 278 | 61 to 387 | 13 |
| 375 x 667 | Pat | drag | 347-599 | 347-599 | 252 | 347 | 1 |
| 375 x 667 | Pat | tap other | 347-599 | 382-577 | 195 to 252 | 347 to 382 | 2 |
| 375 x 667 | Pat | tap back | 382-577 | 347-599 | 195 to 252 | 347 to 382 | 2 |
| 375 x 667 | Pat | reload | - | - | - | - | 0 |
| 375 x 667 | DM | open | 347-599 | 347-599 | 252 | 347 | 1 |
| 375 x 667 | DM | toast | 347-599 | 347-599 | 252 | 347 | 1 |
| 375 x 667 | DM | alert | 347-599 | 347-599 | 252 | 347 | 1 |
| 375 x 667 | DM | alert gone | 347-599 | 347-599 | 252 | 347 | 1 |
| 375 x 667 | DM | larger | 347-599 | 181-599 | 252 to 418 | 181 to 347 | 2 |
| 375 x 667 | DM | smaller | 181-599 | 347-599 | 252 to 418 | 181 to 347 | 2 |
| 375 x 667 | DM | pan -120 | 347-599 | 227-599 | 252 to 372 | 227 to 347 | 13 |
| 375 x 667 | DM | pan 240 | 227-599 | 61-339 | 212 to 372 | 61 to 387 | 13 |
| 375 x 667 | DM | pan -120 | 61-339 | 347-599 | 208 to 278 | 61 to 387 | 13 |
| 375 x 667 | DM | drag | 347-599 | 347-599 | 252 | 347 | 1 |
| 375 x 667 | DM | tap other | 347-599 | 391-599 | 208 to 252 | 347 to 391 | 2 |
| 375 x 667 | DM | tap back | 391-599 | 347-599 | 208 to 252 | 347 to 391 | 2 |
| 375 x 667 | DM | dm alert | 347-599 | 347-599 | 252 | 347 | 1 |
| 375 x 667 | DM | dm alert pan -200 | 347-599 | 193-599 | 252 to 406 | 193 to 347 | 11 |
| 375 x 667 | DM | reload | - | - | - | - | 0 |
| 440 x 956 | Pat | open | 463-867 | 463-867 | 404 | 463 | 1 |
| 440 x 956 | Pat | toast | 463-867 | 463-867 | 404 | 463 | 1 |
| 440 x 956 | Pat | alert | 463-867 | 61-334 | 273 to 404 | 61 to 463 | 2 |
| 440 x 956 | Pat | alert gone | 61-334 | 463-867 | 273 to 404 | 61 to 463 | 2 |
| 440 x 956 | Pat | larger | 463-867 | 463-867 | 404 | 463 | 1 |
| 440 x 956 | Pat | smaller | 463-867 | 463-867 | 404 | 463 | 1 |
| 440 x 956 | Pat | pan -120 | 463-867 | 343-747 | 404 | 343 to 463 | 13 |
| 440 x 956 | Pat | pan 240 | 343-747 | 61-454 | 353 to 404 | 61 to 523 | 13 |
| 440 x 956 | Pat | pan -120 | 61-454 | 463-867 | 353 to 404 | 61 to 533 | 13 |
| 440 x 956 | Pat | drag | 463-867 | 463-888 | 404 to 425 | 463 | 2 |
| 440 x 956 | Pat | tap other | 463-888 | 498-693 | 195 to 425 | 463 to 498 | 2 |
| 440 x 956 | Pat | tap back | 498-693 | 463-888 | 195 to 425 | 463 to 498 | 2 |
| 440 x 956 | Pat | reload | - | - | - | - | 0 |
| 440 x 956 | DM | open | 463-888 | 463-888 | 425 | 463 | 1 |
| 440 x 956 | DM | toast | 463-888 | 463-888 | 425 | 463 | 1 |
| 440 x 956 | DM | alert | 463-888 | 463-888 | 425 | 463 | 1 |
| 440 x 956 | DM | alert gone | 463-888 | 463-888 | 425 | 463 | 1 |
| 440 x 956 | DM | larger | 463-888 | 384-888 | 425 to 504 | 384 to 463 | 2 |
| 440 x 956 | DM | smaller | 384-888 | 463-888 | 425 to 504 | 384 to 463 | 2 |
| 440 x 956 | DM | pan -120 | 463-888 | 343-847 | 425 to 504 | 343 to 463 | 13 |
| 440 x 956 | DM | pan 240 | 343-847 | 61-454 | 353 to 504 | 61 to 523 | 13 |
| 440 x 956 | DM | pan -120 | 61-454 | 463-888 | 353 to 425 | 61 to 533 | 13 |
| 440 x 956 | DM | drag | 463-888 | 463-888 | 425 | 463 | 1 |
| 440 x 956 | DM | tap other | 463-888 | 507-888 | 381 to 425 | 463 to 507 | 2 |
| 440 x 956 | DM | tap back | 507-888 | 463-888 | 381 to 425 | 463 to 507 | 2 |
| 440 x 956 | DM | dm alert | 463-888 | 463-888 | 425 | 463 | 1 |
| 440 x 956 | DM | dm alert pan -200 | 463-888 | 263-767 | 425 to 504 | 263 to 463 | 13 |
| 440 x 956 | DM | reload | - | - | - | - | 0 |
| 320 x 568 at 130% | Pat | open | 324-480 | 324-480 | 156 | 324 | 1 |
| 320 x 568 at 130% | Pat | toast | 324-480 | 324-480 | 156 | 324 | 1 |
| 320 x 568 at 130% | Pat | alert | 324-480 | 147-480 | 156 to 333 | 147 to 324 | 2 |
| 320 x 568 at 130% | Pat | alert gone | 147-480 | 324-480 | 156 to 333 | 147 to 324 | 2 |
| 320 x 568 at 130% | Pat | larger | 324-480 | 235-480 | 156 to 245 | 235 to 324 | 2 |
| 320 x 568 at 130% | Pat | smaller | 235-480 | 324-480 | 156 to 245 | 235 to 324 | 2 |
| 320 x 568 at 130% | Pat | pan -120 | 324-480 | 214-480 | 156 to 266 | 214 to 324 | 12 |
| 320 x 568 at 130% | Pat | pan 240 | 214-480 | 79-291 | 156 to 266 | 79 to 324 | 11 |
| 320 x 568 at 130% | Pat | pan -120 | 79-291 | 324-480 | 156 to 212 | 79 to 324 | 8 |
| 320 x 568 at 130% | Pat | drag | 324-480 | 324-480 | 156 | 324 | 1 |
| 320 x 568 at 130% | Pat | tap other | 324-480 | 79-235 | 156 | 79 to 324 | 2 |
| 320 x 568 at 130% | Pat | tap back | 79-235 | 324-480 | 156 | 79 to 324 | 2 |
| 320 x 568 at 130% | Pat | reload | - | - | - | - | 0 |
| 320 x 568 at 130% | DM | open | 324-480 | 324-480 | 156 | 324 | 1 |
| 320 x 568 at 130% | DM | toast | 324-480 | 324-480 | 156 | 324 | 1 |
| 320 x 568 at 130% | DM | alert | 324-480 | 324-480 | 156 | 324 | 1 |
| 320 x 568 at 130% | DM | alert gone | 324-480 | 324-480 | 156 | 324 | 1 |
| 320 x 568 at 130% | DM | larger | 324-480 | 235-480 | 156 to 245 | 235 to 324 | 2 |
| 320 x 568 at 130% | DM | smaller | 235-480 | 324-480 | 156 to 245 | 235 to 324 | 2 |
| 320 x 568 at 130% | DM | pan -120 | 324-480 | 214-480 | 156 to 266 | 214 to 324 | 12 |
| 320 x 568 at 130% | DM | pan 240 | 214-480 | 79-291 | 156 to 266 | 79 to 324 | 11 |
| 320 x 568 at 130% | DM | pan -120 | 79-291 | 324-480 | 156 to 212 | 79 to 324 | 8 |
| 320 x 568 at 130% | DM | drag | 324-480 | 324-480 | 156 | 324 | 1 |
| 320 x 568 at 130% | DM | tap other | 324-480 | 79-235 | 156 | 79 to 324 | 2 |
| 320 x 568 at 130% | DM | tap back | 79-235 | 324-480 | 156 | 79 to 324 | 2 |
| 320 x 568 at 130% | DM | dm alert | 324-480 | 324-480 | 156 | 324 | 1 |
| 320 x 568 at 130% | DM | dm alert pan -200 | 324-480 | 324-480 | 156 | 324 | 1 |
| 320 x 568 at 130% | DM | reload | - | - | - | - | 0 |
| 844 x 390 | Pat | open | 61-322 | 61-322 | 261 | 61 | 1 |
| 844 x 390 | Pat | toast | 61-322 | 61-322 | 261 | 61 | 1 |
| 844 x 390 | Pat | alert | 61-322 | 113-322 | 209 to 261 | 61 to 113 | 2 |
| 844 x 390 | Pat | alert gone | 113-322 | 61-322 | 209 to 261 | 61 to 113 | 2 |
| 844 x 390 | Pat | pan -120 | 61-322 | 61-322 | 261 | 61 | 1 |
| 844 x 390 | Pat | pan 240 | 61-322 | 61-322 | 261 | 61 | 1 |
| 844 x 390 | Pat | pan -120 | 61-322 | 61-322 | 261 | 61 | 1 |
| 844 x 390 | Pat | drag | 61-322 | 61-322 | 261 | 61 | 1 |
| 844 x 390 | Pat | tap other | 61-322 | 127-322 | 195 to 261 | 61 to 127 | 2 |
| 844 x 390 | Pat | tap back | 127-322 | 61-322 | 195 to 261 | 61 to 127 | 2 |
| 844 x 390 | Pat | reload | - | - | - | - | 0 |
| 820 x 1180 | DM | open | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | toast | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | alert | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | alert gone | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | pan -120 | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | pan 240 | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | pan -120 | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | drag | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | tap other | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | tap back | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | dm alert | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | dm alert pan -200 | 560-1112 | 560-1112 | 552 | 560 | 1 |
| 820 x 1180 | DM | reload | - | - | - | - | 0 |

"Not measured": a stray tap in an earlier sweep had shrunk Thorn to Tiny before those two runs, so the tap missed him. Every run after that reset each token's size and cell first, and the runs it spoiled were made again (the tables hold the reruns). The reach sweeps at 844 x 390 tried the right-edge tokens at their own x first, then 80 px from the left edge.

## Appendix B. The mockup

The mockup restyled the real bar in the page, keeping its own header, HP field and buttons, so the device's fonts and the interface size count: the frame fixed at the free area's foot at 114 layout px, the title as two lines (name, then vitals), and the quick row built from the bar's own field row and buttons by the fit rule of 3.3. It ran in the test browser only (a stylesheet the app's style-src would refuse), and none of it is in the commit. For each phone it then panned each of the six edge tokens to the middle of the band above the strip and hit-tested its middle, and last drew the expanded box (min(content, cap), without the map move). Screenshots: `mock-rest-*`, `mock-rest-reach-*` and `mock-expanded-*` in the `token-bar-pass` folder.

| Phone | Who, token | Strip (CSS px) | Height (layout px) | Quick row after the field and Apply | Alignment findings | Edge tokens reached | Expanded (layout px) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 320 x 568 at 130% | DM, Thorn | 331-480 | 114 | Roll | 0 | 6 of 6 | 188 |
| 320 x 568 at 130% | Pat, Thorn | 331-480 | 114 | Roll | 0 | 6 of 6 | 188 |
| 390 x 844 | DM, Thorn | 662-776 | 114 | Conditions, Roll | 0 | 6 of 6 | 504 |
| 390 x 844 | Pat, Thorn | 662-776 | 114 | Conditions, Roll | 0 | 6 of 6 | 404 |
| 375 x 667 | DM, Thorn | 485-599 | 114 | Conditions, Roll | 0 | 6 of 6 | 418 |
| 375 x 667 | Pat, Thorn | 485-599 | 114 | Conditions, Roll | 0 | 6 of 6 | 418 |
| 440 x 956 | DM, Thorn | 774-888 | 114 | Conditions, Roll, Details | 0 | 6 of 6 | 504 |
| 440 x 956 | Pat, Thorn | 774-888 | 114 | Conditions, Roll, Details | 0 | 6 of 6 | 404 |
| 390 x 844 at 130% | DM, Thorn | 607-756 | 114 | Conditions | 0 | 6 of 6 | 400 |
| 390 x 844 at 130% | Pat, Thorn | 607-756 | 114 | Conditions | 0 | 6 of 6 | 388 |
| 320 x 568 | DM, Thorn | 386-500 | 114 | Conditions | 0 | 6 of 6 | 319 |
| 320 x 568 | Pat, Thorn | 386-500 | 114 | Conditions | 0 | 6 of 6 | 319 |
| 320 x 568 at 130% | DM, the dragon | 331-480 | 114 | Roll | 0 | 6 of 6 | 188 |
| 390 x 844 | Pat, a goblin | 662-776 | 114 | Details, Multi-select | 0 | 6 of 6 | 195 |
| 390 x 844 | DM, a goblin | 662-776 | 114 | Conditions, Roll | 0 | 6 of 6 | 504 |

The mockup's candidates after the field and Apply were Undo move, Doesn't count, Conditions, Roll, Hidden, Details and Multi-select, as this room offered no Uses, so its third action at 440 x 956 is Details, where the design puts Uses, or nothing for a creature with none (3.3).
