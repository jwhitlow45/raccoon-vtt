# raccoon-vtt v1: a resting token bar on upright phones

Status: draft 5, 2026-10-24, revised for design review rounds 1 to 4 (findings BAR-ASTRA-01 to 10 and BC-OPUS-1 to 35, and the owner's decisions D-261024-9 to 13). Appendix D maps each finding to the sections that close it. Code is cited from main at `6432b496`, whose bar code is the same as `28ce4977`'s. This design changes how the token action bar sits on a phone held upright, as docs/design-v1-bar-dock.md 1.1 and 1.5 set it out. A computer, a tablet and a phone on its side keep the docked window of docs/design-v1-token-window.md, which section 7 shows does not share the problem. Combat's Uses button and drawer (docs/design-v1-combat-controls.md section 6), already built in lane B, fit both states (section 6).

The project owner, 2026-10-24:

> "The token pop up menu now kind of moves and grows weirdly even when collapsed such that it is impossible to get to some tokens near the edge of the map when it is open on mobile. Please do a design ui ux pass on it to come up with a way to make it a bit less intrusive while still being useful. When it is expanded it is totally fine to take up a lot of the screen just not when collapsed"

**What the owner calls collapsed** is the bar's usual size: Smaller, the size every bar opens at unless this device stored Larger (`rvtt.tokenBarLarger`). "Expanded" is Larger. The two other small forms are not it. The fold under a sheet is a row on the sheet's edge, off the map, and the compact overlay appears only where the free area is under 148 px tall, which no phone measured reaches when it opens, except where a player's roll card already stands at the foot: at 320 x 568 at 130% that card takes the free area under 148, and the bar opens compact today (1.4). This design opens the strip there (2).

**The answer in short.**
- **Resting** replaces Smaller: a strip of 114 layout px at the foot of the map's free area, across its width, shorter only where the free area is too short to leave a 44 px band of map above it (3.1). It holds a header (name, a status line with AC and HP, Expand, Close) and one quick row: a Damage or Heal toggle, the HP field and Apply, then Conditions, Roll and what else fits by measured width. It never follows the token, never changes height while it rests, and moves the map only to clear its own token as the viewer opens it or shows another token in it, or as it comes back after a drop (3.6).
- **Reach**: the strip is a fixed cover at the map's foot. Pans keep the map from going further under it, Fit, Find and every pan that opens the bar keep tokens out from under it, and any token can be panned into the band above it and tapped.
- **Expanded** replaces Larger. Where it can grow by at least a header's height, it grows up from the strip's place to at most two thirds of the screen, leaving 120 px for its token, and moves the map once so the token stays above it. Elsewhere Expand is not offered, and the strip scrolls instead, with its header scrolling too and nothing laid over its rows. Expanded lasts while the bar stays open. Nothing is stored.

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
| A roll card at Pat's foot | The free area's foot rises by the card, so the bar flips over Thorn and changes height: 418-776 to 61-289 at 390 x 844, 347-599 to 61-219 at 375 x 667 and 463-867 to 61-334 at 440 x 956. It flips back as the card goes. At 320 x 568 at 130% the card would leave the free area under 148, so the bar turns into the compact overlay in 48 ms (324-480 to 147-480, 156 to 333 tall) and the card folds into the alerts, its kept height holding the bar compact until it goes | `foot` (features/rolls/PlayerRolls.tsx:225) in `freeArea` (barDock.ts:122), `barMode`, and the card's fold for a compact bar (`yieldsToBar`, PlayerRolls.tsx:202) |
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

Every bar measured on the four phones (8 runs of 9 tokens at close zoom and 8 at fit, both roles) opened with `data-bar-mode="span"`, Smaller, at the heights above, and grew only by Larger. None opened compact: that needs a free area under 148 layout px, and the smallest here is 309 (320 x 568 at 130%, the turn band and Multi-select's bar would take it to 209). One turned compact after it opened: Pat's at 320 x 568 at 130% as a roll card came (1.1). By the same count, a bar opened while that card stands opens compact there today (review BC-OPUS-25). The fold under a sheet is a row on the sheet's top edge, off the map, and covers no token. So the owner's "collapsed" is Smaller, and the moving and growing are Smaller's: it follows, flips, pins and resizes as in 1.1, all at its usual size.

## 2. States on an upright phone

"Upright phone" is today's span mode (docs/design-v1-bar-dock.md 1.1): a layout under 600 px wide and no wider than tall, whose free area F is at least 148 px tall when the bar opens, by the opening rule below. Elsewhere nothing changes.

| State | What it is for | Place and size | Moves the map |
| --- | --- | --- | --- |
| Closed | No bar | | |
| **Resting** | The token's name, AC and HP, the HP entry and the actions used most, with the map in reach | A strip at the free area's foot, its full width, 114 px, or 94 to 114 on a short free area (3.1) | Once as the viewer opens it or shows another token, or it comes back after a drop, only to clear its token (3.6) |
| **Expanded**, where it gains 52 px or more | Everything the bar holds | From the same foot up, 114 px at least and as tall as its content up to two thirds of the screen and F − 128 (5.1) | Once as it expands, and once for each new token it shows (5.2) |
| **Scrolling strip**, elsewhere | Everything the bar holds, where too little room is left to expand | The resting strip's box, with the rest of the bar under the quick row, scrolling (5.4) | As resting |
| Folded | A sheet is open over the map | A row on the sheet's edge, as today (pages/fold.ts) | No |
| Hidden for a drag, or by a tap off | A token drag, or Multi-select's tap on empty map | Not drawn, as today | No |

**The opening rule** (BC-OPUS-25). On an upright phone the bar's mode at opening (`openMode`) reads F without the foot of a roll card standing at the foot, but with one summoned onto the toolbar or the screen (the dock store's `cardAt`, 9.1). Where that F is at least 148, the bar opens as the strip, and the card stands above it where both fit and folds only where it would take F under 148 (3.2). Elsewhere it opens compact, as today (docs/design-v1-bar-dock.md 1.4), with no resting state (R9).

**Only the strip is held.** A strip's mode is kept in the dock store (`heldMode: "span"`) and passed to `placeBar`, `restingBar` and `barCapacity`'s input, which today work it out from F on every render. It holds through hiding for a drag, a tap off or "Roll asked", a tap on another token, a drag's return and a fold, whatever the foot, the options row and the top bars do. It resets only when the selection is let go, the screen turns or the interface size changes. So a strip never turns into the compact overlay by itself. A compact bar is not held: it turns into the strip once F (without a standing card) reaches 148, keeping the selection and with no clearing move (3.6). A strip never turns back, so the two never flip. `expanded` survives a turn to landscape and back while the bar stays open, and is ignored where the bar docks or opens compact.

## 3. The resting bar

### 3.1 Place, size and the band above it

- **Across**: the free area's width (8 px margins, safe areas out).
- **Down**: its bottom 8 px above whatever stands at the map's foot: the toolbar, the tool's options row (Multi-select's bar) and a roll card standing at a narrow screen's foot (`foot`).
- **114 px** (`REST_HEIGHT`): the 1 px border, the header's 52 (its 48 px row and the frame's 4 px top padding), an 8 px gap, the 44 px quick row, an 8 px bottom padding and the 1 px border. The frame's content keeps a 12 px bottom padding today and in the expanded bar. The strip's is 8, so its two rows fit. At 130% the strip is 148 screen px. Measured at 114.0 in every mockup run (Appendix B).
- **Shorter only to keep the band**: where F is under 166, the strip is F − 52 tall (`restHeight`), so 44 px of map (`BAND_MIN`) and the 8 px gap stay above it, and never under 94 (`REST_TIGHT`). It gives up its top padding, the gap and its bottom padding first, so the header and the quick row still show whole: at F = 148 it is 96 px, measured with both whole (B.3). This happens only where F is that short, so only a frame change (3.2) changes the strip's height.
- It draws exactly that height (`height`, not `maxHeight`).

| Phone | Free area F | Strip | Band above it (F − 122) |
| --- | --- | --- | --- |
| 390 x 844, 100% | 61 to 776, 715 | 662 to 776, 16% | 593 |
| 375 x 667, 100% | 61 to 599, 538 | 485 to 599, 21% | 416 |
| 440 x 956, 100% | 61 to 888, 827 | 774 to 888, 14% | 705 |
| 320 x 568, 130% (246 x 437) | 60 to 369, 309 | 255 to 369, 37% | 187 |
| 320 x 568, 130%, Multi-select and a turn band | 60 to 269, 209 | 155 to 269, 55% | 87 |
| A free area of 148 at 130% (B.3) | 148 | 96 tall | 44 |

**The smallest band guaranteed is 44 layout px of map wherever F is at least 146**, so at every opening (a strip opens only where F ≥ 148) and through a roll card (3.2), with nothing of the bar's or the room's own laid over it: the alerts' summary row and the toasts keep out of it (3.5), and only the HP entry's note while the viewer types (3.3) and a toast the viewer opens whole (3.5) cover it. 44 px is a touch target's height, and takes a token's middle, of any size, for a tap. On the four phones measured the smallest band is 87. Only what arrives after the opening at the top, or in the tool's options row, can take F under 146: a turn band, a lasting notice, or Multi-select's row on a phone smaller than any measured (320 x 480 at 130% with a turn band, F = 141 by playerphone test 11). The strip keeps its mode and 94 px there, and the band is F − 102, 39 px, until they go. In Multi-select a tap on empty map hides the bar, as today.

### 3.2 Still

While it rests, the strip's box changes only when the map's frame changes: a rotation, a new interface size, the toolbar's or the options row's height, and a roll card standing at the foot or leaving it. Top bars that come or go change F, and the strip's height only where F is under 166 (3.1). Nothing else moves or grows it:

- **A pan, a pinch or a zoom**: it reads no anchor (9.1).
- **Its content**: a name of any length takes one line. The quick row never wraps. An Undo move, a "Use 9", a stat block that loads late, a death save or new conditions change what it holds, never its height.
- **Toasts** keep above it (3.5). **Alerts**: the column keeps above it or shows its summary row (3.5).
- **Time**: its box is right on its first frame, since its height needs no measuring.

**A roll card at the foot.** Where the card leaves F at 148 or more, the card stands and the strip rises above it by the card's height while it stands (R4). Where it would leave F under 148, the card folds at once into the alerts' "Roll asked" row, as it folds today for a compact bar, and the strip stays above the toolbar. The fold reads the card's kept height (`foot`), so it holds until the card goes and never flickers. In features/rolls/PlayerRolls.tsx, `yieldsToBar` also reads `stripSqueezed` (9.1), and the strip places itself as if a folded card were not there. A squeeze counts only while the bar is open in its held strip mode, shown or hidden for a drag, so with no bar open the card stands as today (BC-OPUS-21). The "Roll asked" row's tap hides the bar (`showActions(false)`, PlayerRolls.tsx:258), keeping the selection and the held strip. No squeeze counts while it is hidden so, and the card stands at the foot to be answered. Nothing brings the bar back by itself: Actions (SelectOptions.tsx:48) or a tap on the token does, as today, and the strip then comes back with its clearing move (3.6), folding the card again only if one still stands.

### 3.3 What it holds

**The header**, one 48 px row, sticky in the expanded bar and not in the scrolling strip (5.4), with Close and Expand where they stand in the expanded bar. Its title holds two lines: the name on one line with an ellipsis (the frame's name keeps the whole name), and under it, in the small muted size, the **status line**. **Expand** (chevron up) and **Close** follow, and never shrink. A group's header reads "3 selected" on the first line.

The status line shows the first of these that applies:
1. An error or refusal from the HP entry, in the error tone, such as "Use a positive number, or start with + or -." or a player's "=20" refused.
2. A line on the dead, in the strip's wording below, with a group's left-out creatures after it (BC-OPUS-28): "Healing does nothing while Thorn is dead. Revive first." or "Healing does nothing to the 1 dead. Leaves out Goblin 2."
3. The preview while the field holds text that parses, naming every kept state that changes what Apply does and whose own control is not in the quick row (BAR-ASTRA-03, BC-OPUS-24): a Critical Hit that Apply will send (`crit && showCrit`, as HpSection.tsx:109 sends it, so never in Heal mode or once the target is above 0 HP) and a group's left-out creatures. So "7 damage", "Heal 5", "7 damage, Critical Hit", "7 damage, to each of 3, not Goblin 2" and "7 damage, Critical Hit, to each of 3, not Goblin 2".
4. "Critical Hit" while `crit && showCrit`, the field is empty and the Crit toggle is not in the row.
5. For a group with the field empty, its standing note: "Leaves out Goblin 2: you cannot change their HP.", "Damage and healing only, since some of them are not yours." or "You cannot change the HP of any of them.".
6. The vitals the short layout keeps: "AC 14 · HP 24/24", a player's "Healthy" for a creature whose numbers they lack, and "Dying", "Stable" or "Dead" where those replace HP. Where they do not fit, AC goes first, then HP ends in an ellipsis. Thorn's "AC 14 · HP 24/24" overflows by under 1 px at 320 x 568 at 130%, so there it reads "HP 24/24" (Appendix B.2).

**The strip's wording of the dead lines** names the creature once, since the header names it, and drops words a group line can spare, so each fits two lines (B.4): "Healing does nothing while {name} is dead. Revive first." (the DM), "Healing does nothing while {name} is dead." (a player, as today), "{name} stays dead at the new HP. Only Revive brings them back.", "Healing does nothing to the {n} dead.", "{n} dead stay dead. Only Revive brings them back." ("1 dead stays dead." for one) and "Brings back {n} dead creatures." (as today). The entry's own sentence stays the field's description.

Items 1 to 3 may take both lines of the title, the name stepping aside visually (it stays the frame's name). **A sentence that needs more than those two lines** shows in a note on the strip's top edge while it applies, and the title's status line shows the vitals meanwhile. **The note never passes two lines** (BAR-ASTRA-08, BC-OPUS-29). Where a sentence would, it gives way in this order, by the measured width, never by a count of characters: the creature's name is cut from its end with an ellipsis, then left-out names become a count ("not 2 of them", "Leaves out 2."). The warning and the recovery stay whole. Measured with an 80-character name (B.4), the note at 320 x 568 at 130% (206 px) keeps 15 letters of it in the DM's heal line, 26 in a player's, 5 in the Set line and 22 in a preview with a crit and an exclusion, and every group line fits with its count. Two lines are 52 px with the note's padding, which the band's foot and the gap hold wherever F ≥ 146 (3.1), down to the 94 px strip. It goes as the field empties, Apply succeeds or focus leaves the strip, and it moves with the strip. From 375 x 667 up every sentence measured with Thorn fits the title. At 320 x 568 the dead line needs the note, and at 130%, where the title is 109 px, so do the error, the refusal and a group's preview. "7 damage, Critical Hit" fits the title everywhere. The status line, and the note while it shows, are the field's description (`aria-describedby`) with the entry's whole sentence, and an error or refusal is also spoken once by the frame's polite status region.

**The quick row**, one 44 px line. Its display order, left to right:
1. **The mode toggle**, one 44 px button. It draws the entry's mode as a sign in the mode's colour: − Damage, + Heal, = Set, T Temp. Its name and tooltip are the mode's name. A tap switches between Damage and Heal. From Set or Temp it goes to Damage. With "players apply damage" access it offers Damage and Heal only, as the entry does.
2. **The HP field**, at least 56 px, taking the room the actions after it leave. Its placeholder is the mode's sample ("7" or "5"), since the toggle names the mode. It takes the entry's typed math too.
3. **Apply**, in words, as the entry's primary.
4. **Crit**, a toggle, while the entry would show "Critical Hit (two failed Death Saves)" (its name and tooltip), pressed while ticked. Where it does not fit, the box is in the expanded bar, or in the scrolling strip's content where Expand is not offered, and the status line names "Critical Hit" while it is ticked (the status line's items 3 and 4).
5. **"Use 9"**, the newest rolled amount the entry offers for its mode. Its name and tooltip are the chip's own words, "Use 9 (Fire Bolt)".
6. **Conditions**, for the DM and the token's owners. It expands with the Conditions drawer open (5.3).
7. **Roll's place**: Roll, for the DM and the owners. While a passing action applies (Undo move, Doesn't count or the door's), the first of them takes this place instead where it fits whole there, and else Roll stays and it waits in the expanded bar. Undo move is drawn as the undo arrow alone, 44 px, named and tipped "Undo move", as the top bar's Undo is (R13). The others keep their words.
8. **Multi-select**. 9. **Uses**, where lane B shows it. 10. **Hidden**, for the DM. 11. **Details**, for a viewer with no HP entry.

The toggle, field and Apply (the lead) show for a viewer who may change the token's HP, on a token that has HP. With no lead, the row starts at Conditions, or at Multi-select for a viewer with nothing before it.

**Fitting** is a separate order, so a passing action can never put Conditions out: the lead, Crit, Conditions, Roll's place, "Use 9", Multi-select, Uses, Hidden, Details. Each shows where it fits whole in what is left after those before it in this order, with the field at its 56 px least. One that does not fit is skipped, and a narrower one after it may still fit. A skipped action is in the expanded bar. The fit reads each button's drawn width, so the font, the interface size and the browser's minimum font size count.

**Measured** (Appendix B.2), for a creature with HP:

| Phone | DM or owner | With a passing action | At 0 HP, dying |
| --- | --- | --- | --- |
| 390 x 844 | Conditions, Roll | Undo move takes Roll's place. Doesn't count (121 px) does not fit, so Roll stays | Crit, Conditions |
| 375 x 667 | Conditions, Roll | Undo move takes Roll's place. Doesn't count waits | Crit, Conditions |
| 440 x 956 | Conditions, Roll, and Uses where it applies | as 390 | Crit, Conditions, Roll |
| 320 x 568, 130% | the lead alone | nothing fits: Undo move waits in the expanded bar | the lead alone: the status line says "Critical Hit" while ticked |

At the two other alignment sizes, 390 x 844 at 130% gets Roll alone (Conditions, 99 px, is skipped), with Undo move in its place and Crit at 0 HP. 320 x 568 at 100% gets Conditions alone and Crit at 0 HP, and Undo move waits.

- **Multi-select** (D-261024-11 and 13) fits after the lead at **none** of the four phones, not even 440 x 956 (108 px against 66 left). It shows where there is no lead: on every phone for a player on another's token, and from 375 x 667 up on a token with no HP. Elsewhere it is Expand, then Multi-select.
- **Hidden** shows only for the DM on a token with no HP: at 440 x 956, and at 375 x 667 while Doesn't count takes Roll's place and leaves no room for Multi-select.
- **A player** on a creature they do not own gets Multi-select and Details at all four phones. **A token with no HP**, for the DM or its owner: Conditions, Roll and Multi-select at 375 x 667, then Details at 390 x 844, and at 440 x 956 Hidden for the DM or Details for an owner. At 320 x 568 at 130% it is Conditions and Roll.

### 3.4 Why these

The HP entry leads because HP is the change made most at the table, and the bar's own ranking keeps "AC, HP and the HP entry at the top" with "Apply in view" on every phone (docs/design-v1-token-panel.md 3.3, docs/design-v1-token-window.md 5.8). The toggle makes the mode visible and lets an iPhone's number pad heal, which it cannot type with a plus sign (D-261024-10). Crit comes next because a retained tick changes what Apply sends. The bar's play row ranks Conditions, Hidden, Multi-select, then Roll (barButtons.ts `barButtons`). The strip keeps Conditions first and moves Roll ahead of the two toggles, since they set the token up and Roll is used every turn in a fight. Multi-select follows Roll (D-261024-11). The passing action takes Roll's place because a player's Undo after a mis-drop must stay one tap, and Conditions must not move (D-261024-12). Duplicate, Locked, Delete, Size, elevation, Light, Attach and the summary's saves and defenses are rarer and stay one tap away behind Expand.

### 3.5 Beside the alerts column and the toasts

- **The column** keeps its cards above the strip (`restLane`). It stacks where at least 44 px of band are left between its first card's foot plus 8 and the strip's top less 8, so a token can still be panned in under the card. Otherwise it shows its 44 px summary row (docs/design-v1-bar-dock.md 1.3), whose tap hides the bar as today. The strip never moves for a card. Beside the column the band also stays clear left of it: 62 px at 390 x 844, none at 320 x 568 at 130%, where the column spans the band.
- **One spacing rule for both the summary row and the toasts**: their foot keeps at least 8 px above the band's last 44 px, so at or above the strip's top less 60. Both fit in the band where it is 96 or more, a 44 px row, the 8 px gap and 44 px of map (BAR-ASTRA-06, BC-OPUS-31).
- **The summary row** stands at its usual place, the column's top, where the band is 96 or more. Otherwise it rises over the turn band and then the top bar's row, by today's `raisedRow` with the strip's top less 60 as its `floor`, into a gap between their buttons and never over one. Where no gap is left, it stands in the strip's header as a 44 px button left of Expand, showing the summary's count, named and tipped by its words ("Roll asked"), with the row's tap. The title then narrows by 48 px, and long feedback goes to the note (3.3). In the scrolling strip that button scrolls away with the header, and the alerts are reached by scrolling back up (5.4).
- **Toasts** take the strip's top less 60 as the foot of their room, in place of the tool's highest control (`toastTop` and `paneToastTop`'s `optionsTop`, and `fitToasts`' room). Where that leaves under 44 px (`TOAST_MIN`), so where the band is under 96 (`toastsOverBars`), the newest toast shows instead as **one row over the top bar's row**, and the older ones wait behind it. **A toast's time starts once, when it first draws** (its `shownAt`, which the store sets then, 9.3), so one that has never shown, such as an error behind an action toast, never runs out unseen, and one that has shown runs on behind the newest (BC-OPUS-35):
  - The row is 44 px tall with its outline drawn inside, centred in the top bar's 52 px row, so 4 px from the safe top. It is as wide as the toast layer (222 px at 320 wide at 130%).
  - Its action button keeps its words whole and the row's full 44 px height, at the right end. The text button takes the rest, at least 44 px wide, on one line cut with an ellipsis, and the whole text stays its accessible name. Where under one word fits, it shows the first letters and the ellipsis, and the action's own words still say what it does. Error and refusal toasts take the same row with no action.
  - Measured (B.5) at 320 x 440 at 130% on Thorn's turn, the band 44: "Save and damage" is 145 px wide and leaves the text 62 ("Hid…"), "Ask for the save" 135 and 73 ("Pip m…"), and an error 207 ("A group save with rolls is …"). The row stands at 4 to 48, End turn at 54 to 98 and the band at 109 to 153, so neither is covered.
  - A tap on the text, which today dismisses the toast (Room.tsx:1914), shows it whole instead: today's toast, 105 to 120 px tall for those measured, from the safe top down, over the turn band and the band if it must, since the viewer asked. Whole, it gains a 44 px Close at its top right. Close and Escape shrink it back to its row, and a tap on its text dismisses it as today. Its time (`ACTION_TOAST_MS`, 12 s, or `TOAST_MS`, 5 s) stops while it shows whole and runs on from what was left as it shrinks back. A toast that arrives meanwhile waits, not yet drawn, and takes the row then.
  - It covers the top row's room name, Undo, Redo, Find and full screen until it goes, and never the turn band or the band.
- **Stacks already placed** take their place anew, as if they came then, when resting begins and each time the strip's top rises (a roll card arriving): every stack whose drawn foot is lower than the strip's top less 60, a stack a pane left included (`restFloor` in `nextToastPlaces`, 9.1).
- So nothing of the room's own stands over the band's last 44 px unless the viewer asks (typing, or a toast shown whole), and the smallest real band is 3.1's.
- The strip publishes no header to `spanToastSlot`, so no toast moves under it. The expanded bar does (5.1).

### 3.6 Clearing its own token (D-261024-9 and 13)

The bar never covers its own token at the two events it controls: **when the viewer opens it or shows another token in it**, and **when it comes back after a drag's drop**. If the token's label clearance meets the strip, that is `anchor.y + OFFSET_Y` (the point under its label or plate that `belowLabel` gives today, for a group its anchor token's, `selectedId`) lower than the strip's top, the map moves up once, just enough (`clearShift`, 9.1):
- **dy = stripTop − (anchor.y + OFFSET_Y)**, and no further than keeps the token's top, at its drawn height, inside the free area and below the toasts' foot as they stand (today's `largerHang` rule, review LP19-BS-3). A token taller than the band so clears as far as its top allows and may stay partly under the strip. With the label clearance already above the strip, nothing moves.
- **It goes through the camera's bounds** (BAR-ASTRA-07). Stage's `shiftForBar(dy)` today calls `panBy` with no bound. Its new contract: it applies `barShift(camera, dy × uiScale(), viewport, bounds, insets)` (lib/camera.ts), which is `keepInView(panBy(camera, 0, dy × uiScale()), viewport, scene bounds, insets with the strip's cover, 64, from: camera)`, with the camera as it stands before the move. `dy` is in the chrome's px, as `clearShift` gives it, and `uiScale()` turns it into the canvas's px, the units of the camera, the viewport and the insets, as Stage.tsx:456 scales it today (BC-OPUS-32). So the move never takes the map further out than a pan could, and a camera already past the new bound, because the strip appeared over it, may come toward the bound but never go further past it.
- **It runs only on an explicit, single-use request, from an opening's own intent** (BC-OPUS-19, BAR-ASTRA-09), never from how the selection changed: `keepSelected` (a token deleted by someone else or gone from the scene, Stage.tsx:516) and `selectToken` change the token shown with no tap. `ui.tap` and `showActions(true)` carry the intent, since every caller is the viewer's gesture: the token tap (Room.tsx:316), a tracker row, the party bar, a companion's show and a companion just added (CompanionsSection.tsx:117 and :313), Actions and the outliner's show. `ui.select(id, { opens: true })` carries it where a caller passes it: a placed token (placeTool.tsx:29 and :38, CharactersPanel.tsx:417, CharacterCard.tsx:310, EncountersPanel.tsx:332), a duplicate (TokenActionBar.tsx:271), a stat block's open (statBlockOpen.ts:64) and the attach holder links (BarParts.tsx:119 and :133). Each sets the room store's `local.opening` where its result leaves the bar on, and any result that leaves it off clears it (9.3). A drag's drop sets a request in Stage as the drag ends.
- **It counts only where the bar ends up showing a new token.** Stage judges each new intent once, at the first commit after it, so the calls of one handler count together (placeTool's select then Select, the outliner's Select, select and show). It keeps one only where the bar now shows (`actionBar` on, the Select tool, no drag) and, at the commit before, either showed nothing or showed one token and now shows another (`keepsOpening`, 9.1). It then sets the dock store's `clearRequest`, naming the token, or the anchor of a group's bar that opens. Any other it drops, never to replay. So none comes from `ui.select` with the bar off, `openStatBlock` hiding the bar (statBlockOpen.ts:75), the tracker's Multi-select branch (a tap, then the bar hidden), a gathering tap on an open bar, `keepSelected`, follow the turn, or the pans of lights, pins, labels and traps, which select nothing (`watchPans`). `PanRequest` needs no origin, and the tracker, the party bar, the companions, SelectOptions.tsx and focus.ts stay as they are.
- **The frame consumes it** in an effect keyed on `clearRequest` once its content is measured, before paint, not on mounting, so the unkeyed GroupActionBar consumes it too, and runs the move once for the token named. A frame that cannot use it (docked, compact or folded) drops it. A pan the viewer has started before then (a finger down on the map, or a pan's frame pending), a close (a switch away from Select is one, as it hides the bar) and a blackout's start cancel it. A switch to Select does not. A frame with no request moves nothing, so the bar coming back after a pointer tool and Select again, after a blackout ends with the selection kept, or as a compact bar turns into the strip (2), never moves the map. The programmatic pans of the tracker, the party bar, the companions and the outliner land the token clear already, so they rarely move.
- It never runs on a pan, a pinch, Collapse, a content change, a toast, a card, an arrow-key nudge (though it moves the token as a drop does, so a run of nudges never moves the map), a fold's return or a turn of the screen. So a later pan or card may still bring the token under the strip, and only those events guarantee it clear.

## 4. Reach

**The mechanism: the strip is a fixed cover at the map's foot.**

- **Pans.** `keepInView` (lib/camera.ts) keeps 64 px of the map clear of the top bars and the toolbar. While a bar shows on an upright phone it also counts the bar's cover at the foot (`barCover`, now the bottom side for a bar across the free area). It clamps only against moving further out: a camera already past the new bound, because the strip appeared over it, may move toward the bound or stay, and never jumps to it (`keepInView`'s `from`, 9.3). So the map's bottom edge may still rise to 64 px under the top bars, and its top edge come down to 64 px above the strip. Any cell can be panned into the band: a token at the top edge to the band's foot, one at the bottom edge to the band's top, corners likewise, at any zoom.
- **Nothing follows the token**, so a pan moves the token and leaves the strip. Today's bar followed it and pinned to an edge once it left the screen (1.3).
- **Fit the map, Find my token, the outliner's show on map, a tracker row, the party bar and follow the turn** place into the area the cover leaves, as they do for a docked window (docs/design-v1-bar-dock.md section 4). A pan that opens the bar knows the strip's box before it exists (`restingBar`), so the token lands above it.
- **The DM's stacked column** covers the band's top right. The band left of it and under its first card stay, by 3.5's 44 px rule, so a token behind a card is panned below the card or left of it. **The summary row** never stands over the band's last 44 px (3.5), so a token is panned under it as under a card.
- **Measured** in the mockup: every edge and corner token was panned above the strip and took a tap, at all six phone sizes, as the DM and as Pat, where today 4 to 6 of 10 cannot (1.2).
- **Expanded** is the cover while it shows, with a band of at least 120 px above it (5.1), so tokens stay in reach there too.

## 5. Expanded

### 5.1 Place and size

- **Offered only where it gains at least a header's height** (BC-OPUS-22): where its reach, `min(round(⅔ × layout height), F − 128)`, is at least 166 (`REST_HEIGHT` + 52), so F ≥ 294 on that count. The column never caps it lower: where a stacked card would leave the expanded bar under 166, the column shows its summary row instead, kept out of the band by 3.5's rule with the expanded bar's top. Elsewhere Expand is not drawn, and the scrolling strip (5.4) takes its place. The reach is read live for the button and frozen for the height (below).
- **Bottom** on the strip's foot. It never hangs over its token and never flips. Only its top edge moves.
- **Height**, the frame's own, apart from the camera's move: **H = max(114, min(content, reach, room under the column's stacked first card))**, where content is measured when it expands. F − 128 leaves 120 px for its token and label above it and the 8 px gap, so the band above an expanded bar is at least 120. H is under 166 only for content that short, such as a player's bar on another's goblin.
- **Frozen**: H is worked out at Expand and for each new token the expanded bar shows, and again only on a frame change (rotation, interface size, toolbar, options row, top bars, a roll card, a column card stacking). It reads no token height, so a pinch never changes it (BC-OPUS-8). Content that grows after, such as a stat block that loads late or a drawer opened inside, scrolls under "Scroll for more" (review BS-O3).
- At most 563 px at 390 x 844 (the DM's Thorn bar measures 502, so it shows whole), 410 at 375 x 667 with no card, 637 at 440 x 956 and 181 at 320 x 568 at 130%, all over 166. Not offered at 375 x 667 with a roll card (F = 237 by `freeArea`, reach 109, B.3) or at F = 209.
- Its content is today's, in today's order, with the short layout ("More stats") where `barShort` gives it (9.1).
- Its header publishes to `spanToastSlot` as the spanning header does today, so a toast that would cover Close or Collapse moves under it (docs/design-v1-bar-dock.md 1.5, reviews LP19-BS-2 and FU24-OPUS-1).

### 5.2 The map as it expands

On the Expand press, after its content is measured and before paint, `clearShift` (3.6) runs once with the expanded bar's top in place of the strip's, through `barShift`: the map moves up just enough that the token's label clears it, and no further than keeps the token's top in the free area and below the toasts' foot. A token already above it moves nothing. A tall token may stay partly behind the bar, and H does not shrink for it. The same happens once for each clear request (3.6) the expanded bar consumes. Never on a pan, a pinch, a drag's return, a fold's return or a turn of the screen.

### 5.3 Between resting and expanded

- **Expand** (chevron up) left of Close expands. **Collapse** (chevron down) in its place rests again. Each is a 44 px icon button named and tipped by its action.
- **Conditions or Uses** in the quick row expands with that drawer open and scrolled into view. Closing that drawer, by its button again, rests again, as does Collapse. Where Expand is not offered, they open their drawer inside the scrolling strip instead.
- **Collapse moves nothing** (R3).
- **The HP entry is one element in both states.** The header, the vitals line (hidden while resting) and the entry keep their places in the content, and the entry's field row keeps its key, so the same input carries over: what was typed, the mode, the crit tick, the caret, focus and the phone's keyboard survive Expand and Collapse.
- **What is kept**: expanded lasts while the bar stays open, through a tap on another token, Multi-select gathering or letting go, a drag (it comes back expanded with no map move), a fold and the dock's Show, a turn to landscape and back, and a time without Expand (5.4). Once the bar closes, the next bar rests. Nothing is stored: `rvtt.tokenBarLarger` is no longer read, and is removed once, in try and catch, as the dock store starts (R1).

### 5.4 Where Expand is not offered: the scrolling strip

Where Expand is not offered (320 x 568 at 130% with Multi-select and a turn band, F = 209, or 375 x 667 with a roll card, F = 237), the strip keeps its place and height, and its scroller scrolls one column: the header, the quick row, then everything the expanded bar holds that the strip does not, in today's order. Nothing is laid over its rows (BAR-ASTRA-05, BC-OPUS-18):
- **The header scrolls with the content.** It is not sticky here, so the whole 112 px window (94 at F = 148) is free for rows.
- **No fade.** Today's "Scroll for more" fade (48 px, `SCROLL_FOR_MORE_PX`) is not drawn in the strip. In Expand's place the header holds a 44 px button named and tipped "Scroll for more", which scrolls the strip down by its window less 44, so the row at its foot comes to its top. Its glyph is a double chevron (a new `scrollMore` icon, Lucide's chevrons-down), not Collapse's single chevron, so an expanded bar that turns into the scrolling strip never puts one meaning under the thumb in the other's place (BC-OPUS-30). The next row's top edge showing at the strip's foot is the other cue.
- **The header and quick row come back** when the HP field takes focus or the status line turns to an error or a refusal: the strip scrolls to its top, where both show whole (3.1). Close, Expand's place, the status line and a summary row's button there (3.5) scroll away with the header otherwise. Back and Escape still close the bar, and a scroll back up brings them back, which is how the alerts are reached from the strip's foot.
- **Measured** (B.3) at F = 210 and F = 148 at 320 x 568's width at 130% (320 x 440 and 320 x 360 windows), and at 375 x 667 with a roll card (F = 237): every one of the 15 to 19 controls and lines below the header, scrolled into view, showed whole and was the top thing at its middle and four corners, and the alignment helper found nothing at the top and middle scroll positions.

Conditions and Uses open their drawer here, scrolled into view. The HP entry's feedback keeps its place in the status line or the note (3.3). A bar expanded when Expand stops being offered (a card arrives) shows the scrolling strip, keeps `expanded`, and expands again when it is offered, with no map move.

## 6. Combat's Uses

- **Resting**: Uses is ninth in display order and seventh in fitting, after Multi-select (D-261024-11). Measured, it fits after the lead only at 440 x 956. Elsewhere it is Expand, then Uses. In the strip it expands with the Uses drawer open, and closing the drawer rests again (R11). A Uses button whose block is still loading holds its place, as lane B's rule says, and the fit counts it.
- **Expanded**: as lane B built it, in the play row after Roll, with the drawer where Conditions opens.
- **Agreed names**: the `"uses"` id in the strip's order and the drawer's name for `expand` (9.4).

## 7. Larger screens and a phone on its side

The docked window stays as it is. Measured at 844 x 390 (a phone on its side) and 820 x 1180 (a tablet), the window never moved with a pan, a toast or a drag. It changed only as the column stacked a roll card above it (61-322 to 113-322 at 844 x 390, docs/design-v1-bar-dock.md 1.3) and for another token's content. Every token was in reach at 820 x 1180, and at 844 x 390 the three tokens at the map's right edge, under the window at their own x, took a tap once panned left of it. So the window keeps today's rules.

## 8. The UI checklist

- **Loading**: nothing new waits. The strip's box needs no measuring. Quick actions keep their busy and refused states (Undo move waiting on the server, Doesn't count refusing a second press). A Uses button still loading holds its place.
- **Keys and focus**: Expand and Collapse keep focus, since they stay at the header's right edge. Conditions or Uses pressed in the strip moves focus to the same button in the expanded bar, pressed, and closing its drawer from there returns focus to the strip's button. The HP field keeps focus through Expand and Collapse (5.3). Escape and Back close the bar in either state, and Escape shrinks a toast shown whole back to its row first (3.5). Tab order: Expand (or "Scroll for more" in its place), Close, then the toggle, the field, Apply and the quick actions in display order. In the scrolling strip, focus moving to a control scrolls it whole into view. The field at the foot takes the phone's keyboard as the roll card's Total field at the foot does today. The frame stays focusable from script only.
- **Screen readers**: the frame keeps `role="dialog"` and its name ("Thorn actions", "3 selected tokens"). The toggle is named by its mode ("Damage"), Expand and Collapse by their action, Crit by its full words, Undo move and "Use 9" by their full names. The status line, and the note while it shows, are the field's description. An error or refusal is spoken once by the frame's polite status. A summary row standing in the header keeps its words as its name, and a toast's one-row form its whole text. A skipped action is absent from the strip, and present in the expanded bar.
- **Large interface sizes**: every size is in layout px, so the strip is 148 screen px at 130%. The fit measures drawn widths inside the chrome's zoom. Alignment is measured at 390 x 844 and 320 x 568, 100% and 130%, plus 375 x 667 and 440 x 956: every mockup run the appendix uses had no finding over 1 px (Appendix B), and the window's roots at 1440 x 900 are unchanged.
- **Exact words**: "Expand", "Collapse", "Damage", "Heal", "Set", "Temp" (the toggle's names), "Crit" (named "Critical Hit (two failed Death Saves)"), "Critical Hit" (the status line), "AC 14 · HP 24/24" (a middle dot with a space each side), the entry's own preview, error and refusal sentences, and the existing names "Apply", "Undo move", "Doesn't count", "Open door", "Conditions", "Roll", "Multi-select", "Uses", "Hidden", "Details", and "Use 9" named "Use 9 (Fire Bolt)", and "Scroll for more" for the scrolling strip's button. The new words are the preview's ", Critical Hit", ", not Goblin 2" and ", not 2 of them", the dead lines' " Leaves out Goblin 2." and " Leaves out 2.", and the strip's wording of the dead lines (3.3): "Healing does nothing while {name} is dead. Revive first.", "{name} stays dead at the new HP. Only Revive brings them back.", "Healing does nothing to the {n} dead." and "{n} dead stay dead. Only Revive brings them back." The whole toast's "Close" is the app's own word.

## 9. The rules in code

### 9.1 barDock.ts

- `REST_HEIGHT = 114`, `REST_TIGHT = 94`, `BAND_MIN = 44`, `EXPAND_GAIN = 52`. `restHeight(F)`: 114, or F − 52 between 94 and 114 (3.1). `expandReach({ layout, free })`: 5.1's reach, and Expand shows where it is at least `REST_HEIGHT + EXPAND_GAIN`.
- `openMode({ layout, free, foot, cardAt })`: 2's opening rule, F read without the card's foot where `cardAt` is "foot". `placeBar` takes `heldMode` (2, "span" or null), `state: "rest" | "expanded"`, `expandedHeight` and `restFoot` (the foot it places by: `foot`, or 0 while the card yields). With `heldMode` "span" it returns for rest `{ anchor: "bottom", at: free bottom, room: restHeight(F) }` with `lane` from `restLane`, and for expanded the same bottom with `room = expandedHeight`, whatever F is now. With null it takes `openMode`, so a compact bar turns into the strip once F reaches 148, and a layout on its side docks. Neither reads the anchor. `spanHang` goes. `restingBar` takes `heldMode` too, and PlayerRolls's `compactBar` reads the mode through `bar.mode`.
- `expandedRoom({ layout, free, column, content })`: H of 5.1, never under REST_HEIGHT.
- `restLane(column, restTop)`: "stacked" where 44 px of band are left under the first card (3.5), else "summary", "none" with no column.
- `clearShift({ anchor, tokenHeight, free, barTop, toastFoot })`: 3.6's move in px, used at rest and at expand, which Stage bounds by `barShift`. `largerShift`, `largerRoom`'s use for the frame, `smallerShift`, `carriedMove`, `readLarger` and `writeLarger` go. `LARGER_KEY` stays for the one removal.
- `stripSqueezed({ viewport, chrome, foot, held })`: F with the card under 148, while `held`, the bar open in its held strip mode (3.2). PlayerRolls reads it.
- `barCover`: a bar as wide as the free area covers the bottom from its top. `restingBar` returns the strip's box in span mode.
- `spanRoomAtWorst(free)` keeps its name and signature for barButtons.ts and returns `min(⅔ × layout height, F − 128)`, the expanded room with no content. The short layout's verdict changes at two alignment sizes: 320 x 568 at 100% (166 short, now 312) and 390 x 844 at 130% (206.5 short, now 393). It stays short at 320 x 568 at 130% (181).
- `nextToastPlaces` takes `restFloor`, the strip's top less 60, or null: a stack whose foot is lower takes its place anew (3.5). `toastsOverBars({ restFloor, top })`: whether the newest toast shows as the one row over the top bar's row, its room under 44 px.
- `restFit(widths, room, gap, fieldMin)` and `restOrder(ids)`: the fitting priority and display order of 3.3, apart.
- `restStatus(input)`: the status line's choice of 3.3 in the strip's wording, with the crit named only for `crit && showCrit`, a group's left-out creatures after the preview and the dead line, and a `fit(text)` the caller measures with, so the creature's name is cut and then the names counted until the note holds two lines. `nextRestMode(mode)`: Damage to Heal, anything else to Damage.
- `keepsOpening(before, now)`: whether an opening's intent counts (3.6), from what the bar showed at the commit before and shows now, each null, a token's id or "group": true where it shows now and showed nothing before, or showed one token before and another one now.
- The dock store's `larger`, `largerFor` and `largerMoved` become `expanded`, `expandedHeight`, `heldMode` (2) and `clearRequest: { tokenId } | null` (3.6), set by Stage from an intent that counts and from the drop, and cleared as the frame consumes it or a cancel drops it. `heldMode` is set as a strip shows and cleared as the selection is let go, the screen turns or the interface size changes (BC-OPUS-33). New is `cardAt: "foot" | "toolbar" | "screen" | null`, where a player's roll card stands (BAR-ASTRA-10, 9.3).

### 9.2 The frame (TokenActionBar.tsx `FrameControls`, `BarHeader`, `BarFrame`)

- `FrameControls.rest: { resting: boolean; scrolls: boolean; expand(): void; collapse(): void } | null`, null where the bar docks or opens compact. `scrolls` is the scrolling strip. `size` goes.
- `BarHeader` draws Expand or Collapse in Larger's place ("Scroll for more", with the new `scrollMore` icon, in the scrolling strip, 5.4), and while resting the name and, under it, the `status` node the content passes, with the note (3.3) on the frame's top edge where the status needs more than two lines. It is not sticky in the scrolling strip, and draws the summary row's button where 3.5 puts it there.
- `BarFrame` draws `height: restHeight(F)` while resting and `expandedHeight` while expanded, from `placeBar`, with no `ScrollForMore` fade while resting. It consumes `clearRequest` in a layout effect keyed on the request once its content is measured, not on mounting (3.6), and runs `clearShift` at the Expand press (5.2), each once, through Stage's `onShift`. It publishes the header to `spanToastSlot` only while expanded, and its box to `barDockSlot.bar` in both states.

### 9.3 Stage.tsx, lib/camera.ts, Room.tsx, PlayerRolls.tsx and the room store

- Stage's `barCoverRef` counts a spanning bar's box. `scheduleCam` passes `largerEach(insets, cover)` and the camera before the gesture to `keepInView`, whose new optional `from` relaxes each bound to where `from` already stands, so it clamps only against moving further out (BC-OPUS-7). `shiftForBar(dy)` applies `barShift` (3.6) with the camera before the move, the scene bounds and the same insets with the cover, in place of a bare `panBy` (BAR-ASTRA-07). Stage judges each new `local.opening` once, at the commit after it, by `keepsOpening` with the bar's subject at the commit before, and sets `clearRequest` for one that counts (3.6). It sets one as a drag ends, treats an intent it finds as it mounts as judged, and drops the request on a switch away from Select or a blackout's start. It sets `heldMode` as a strip shows and clears it as the selection is let go, the layout turns between upright and on its side, or `uiScale()` changes (2).
- Room's toasts take the strip's top less 60 as the foot of their room, `restFloor` and `toastsOverBars` while the bar rests (3.5). `ToastNote` (Room.tsx:1890-1930) gains the one-row form and the shown-whole form with its Close, Escape and held time. The toast layer calls `toastsDrawn` in a layout effect with the toasts it drew, only the row's toast while the one row shows, and `recent` (Room.tsx:1605) counts a toast not yet drawn as new. InitiativeStrip.tsx's summary row takes the strip's top less 60 as `raisedRow`'s `floor`, and hands itself to the strip's header where no spot is left (3.5).
- PlayerRolls.tsx, today's 193 to 229: `yieldsToBar` adds `|| stripSqueezed(...)` for an upright bar, and a layout effect publishes `cardAt` from `atFoot`, `onToolbar` and `stand`: "foot" while the card stands or folds at the foot, "toolbar" or "screen" while summoned, null with no card at the foot. The unmount effect clears it with `foot`.
- **The room store** (state/selection.ts, types.ts and store.ts, and features/dm/preview.ts's own `RoomUi`). `LocalUi.opening: { tokenId } | null`, a new object for each opening: `tapToken` and `showActions(local, true)` set it where their result leaves the bar on, `selectToken(local, id, opens)` only with `opens`, and `withIds` and `showActions` clear it wherever the bar ends off. `RoomUi.select(id, { opens })` passes it through in both stores. `Toast.shownAt` becomes optional and is no longer set as a toast is made (store.ts:467, :683 and :688, preview.ts:86 and :117). Both stores' `RoomUi` gain `toastsDrawn(ids)`, which sets it on each toast drawn for the first time, and `holdToast(id, held)`, which stops a toast's time while it shows whole (`pausedAt`) and on release moves `shownAt` on by the time held. `toastsLeft` gives no timer to a toast not yet drawn or held, so the Room.tsx:1623 effect sets each from its stamps, its comment stays true, and a rerender or an arrival never resets one.

### 9.4 The content (the content lane, after lane B)

- barButtons.ts `restButtons(input)`: the quick row's candidate ids by role and token, including `"uses"`, plus the group's. `barCapacity` (barButtons.ts:121), which calls `barMode` itself today, takes the held mode from the `BarRoom` it is given, which carries `placeBar`'s input, so a held strip keeps its layout (BC-OPUS-32), and while none is held takes `openMode`, as `placeBar` does, so the first render with a card standing gets the strip's layout (BC-OPUS-33). Its comment says the short layout now holds only on the smallest phones at a larger interface size.
- TokenActionBar.tsx `TokenBarBody` and `GroupActionBar`: Duplicate's `ui.select(id, { opens: true })` (TokenActionBar.tsx:271, 3.6). While `frame.rest?.resting`, `<BarHeader>` first with the status node, the vitals line hidden, the entry in its place with `layout: "rest"`, and `<RestRow>` from the frame's file with the candidates. While `frame.rest.scrolls`, the rest of the bar's sections follow the quick row. Conditions and Uses there open their drawer and call `expand()`, and the drawer's closing calls `collapse()` when it was opened so.
- features/tokens/HpSection.tsx: `HpEntry` takes `layout: "rest"`: the toggle, the field and Apply in one row (its field row keeping its key), Crit and the newest chip as quick candidates, and its notes handed to the status line (`onStatus`). features/tokens/GroupHpEntry.tsx passes `layout` through and hands its standing notes to the status line.
- The group strip: header "3 selected", status line of 3.3, the group entry as the lead, then Conditions, Roll (the DM), Multi-select, Hidden (the DM), in that order for both display and fitting. Request a roll, Locked, Start a fight, More and Delete stay behind Expand. By the widths measured for Thorn (Appendix B.2), with the group's lead as wide as one token's: Conditions and Roll at 390, 375 and 440, and the lead alone at 320 x 568 at 130%.

## 10. Cases

| Case | Expected | Test |
| --- | --- | --- |
| Tap Thorn mid-map at 390 x 844 | Strip at 662 to 776, 114 tall, first frame, no map move | br-f-1 |
| Tap a token whose label meets the strip, and a Gargantuan token low on the screen | Map moves up once, just enough, then the strip stands still. The Gargantuan clears as far as its top stays in the free area | unit `clearShift`, br-f-8 |
| Drag a token and drop it into the strip's band | Bar hides, comes back, map moves once to clear it | br-f-8 |
| Arrow-key nudge into the band, and a pan under way as the bar opens | No map move. The strip may cover the nudged token | unit, br-f-8 |
| Ruler, then Select, with the bar open, and a blackout's end with the selection kept | The bar comes back with no map move | br-f-8 |
| A gathering tap in Multi-select, the tracker's Multi-select branch, follow the turn, and a pin's show on map | No clear request, no map move | unit `keepsOpening`, `tapToken`, br-f-8 |
| A tracker row, the party bar, a companion's show, Actions, or the outliner's show after Ruler | One clear request, consumed once, not cancelled by the switch to Select | unit `keepsOpening`, br-f-6 |
| Someone else deletes a group's anchor with Multi-select off, or moves a selected token to another scene | `keepSelected` changes the token shown: no request, no map move | unit `keepSelected`, br-f-8 |
| A placed token or a stat block opened with the bar off | No request | unit `selectToken`, br-f-8 |
| A placed token, an attach holder link or a duplicate with the bar open | One request | unit `selectToken`, `keepsOpening`, br-f-8 |
| A clearing move with the camera already past the cover's bound | It moves toward the bound only, never further out | unit `barShift`, br-f-8 |
| Pan 120 and 240 px, pinch, bar resting | Strip box unchanged on every frame | br-f-1 |
| A whisper, and an actionable toast placed low before the strip opens | The whisper above the strip. The low one takes its place anew above it | unit `nextToastPlaces`, br-f-3 |
| A concentration card (DM) | Strip unchanged, the card above it with 44 px of band, or the summary row | unit `restLane`, br-f-3 |
| A roll card arrives and leaves at 390 x 844 | Strip rises by the card's height and back, height 114 | br-f-9 |
| The same at 320 x 568 at 130% with Multi-select and a turn band | The card folds into "Roll asked", the strip stays, no compact overlay. Both come back as the card goes | unit `stripSqueezed`, br-f-9 |
| That card with no bar open, and with "Roll asked" tapped | The card stands. The tap hides the bar | unit `stripSqueezed`, br-f-9 |
| Pat at 320 x 568 at 130%, a card standing, taps Thorn | `openMode` gives the strip, and on the first render, no mode held yet, so does `barCapacity`'s layout. The card folds into "Roll asked". Summoned onto the toolbar or the screen, F counts the card's foot | unit `openMode`, `barCapacity`, br-f-9 |
| He taps "Roll asked", answers the card, then taps Actions | The bar hides with the selection and held strip kept, the card stands and is answered, and Actions brings the strip back | br-f-9 |
| A turn to landscape with the strip held, and back | `heldMode` clears, the bar docks, and back upright `openMode` decides | unit `placeBar`, br-f-7 |
| A compact bar (F 141 at opening) as F reaches 148 | It turns into the strip, selection kept, no map move, and never turns back | unit `placeBar`, br-f-10 |
| The bar hidden for a drag or switched to another token while F falls under 148 | The held strip mode stays | unit `placeBar` |
| Multi-select's row and a turn band take F to 141 at 320 x 480 at 130% | The strip stays a strip, 94 px, and the band is 39. A tap on empty map hides the bar | playerphone 11 |
| F = 148 at 130% | The strip is 96 px with its header and quick row whole, and the band 44 | unit `restHeight`, br-f-10 |
| The summary row, and an actionable toast, where the band is under 96 | The row rises or stands in the header, the toast as one 44 px row over the top bar's row, End turn and the band clear | unit `toastsOverBars` at 43 and 44 px of room, br-f-11 |
| A tap on that row's text, then Close or Escape | Shown whole, its time held. Close or Escape shrinks it back with the time it had left | unit `holdToast`, br-f-11 |
| An error behind an action toast in the one row, a toast arriving while one shows whole, and rerenders | Neither waiting toast has a timer until it first draws, then its whole time. No rerender or arrival restarts a timer | unit `toastsLeft`, `toastsDrawn`, br-f-11 |
| Edge tokens at F = 148 with the summary row showing | Panned into the band and tapped | br-f-10 |
| A roll card arrives while expanded (375 x 667, F = 237) | Scrolling strip with `expanded` kept. It expands again after, with no map move | unit, br-f-9 |
| Expand where the reach is at least 166, then a pinch on a Large token | H = max(114, min(content, reach)), one clearing move. The pinch leaves H | unit `expandReach`, `expandedRoom`, br-f-7 |
| F of 293 and 294, and a stacked card that would cap H under 166 | Expand drawn only at 294. The card gives way to the summary row | unit `expandReach`, br-f-7 |
| The scrolling strip at F = 210 and 148 and at 375 x 667 with a card | Every row whole and on top when scrolled to. "Scroll for more", a double chevron, moves one window less 44 | br-c-3, `rest-scrolls` |
| The alerts from the scrolling strip's foot, the summary in its header | A scroll back up brings the header and the summary's button | br-c-3 |
| Collapse | Strip, map unmoved, focus on Expand | br-f-7 |
| Type 7 in Heal mode kept from the expanded bar | Toggle shows +, Apply heals 7 | br-c-2 |
| Crit kept from the expanded bar, 7 typed, at 320 x 568 at 130% | "7 damage, Critical Hit", and Apply counts two failed saves | unit `restStatus`, br-c-2 |
| A group leaving out Goblin 2, 7 typed | "7 damage, to each of 3, not Goblin 2", in the note at 320 x 568 at 130%. Long names counted | unit `restStatus`, br-c-2 |
| Crit kept, then Heal, or the target above 0 HP | No "Critical Hit" anywhere, as Apply will not send it | unit `restStatus`, br-c-2 |
| A group heal with a dead creature and Goblin 2 left out | "Healing does nothing to the 1 dead. Leaves out Goblin 2." | unit `restStatus`, br-c-2 |
| An 80-character name: the DM's heal line, a player's, the Set line, a preview with crit and exclusion, at 320 x 568 at 130% and on the 94 px strip | The note keeps two lines, the name cut by width, the warning and recovery whole | unit `restStatus`, br-c-2, B.4 |
| Type "abc", Apply, and Pat's "=20" on a goblin with "players apply damage" | The status line shows the error, focus in the field, then the refusal, Apply disabled | br-c-2 |
| Damage a dying creature with Crit ticked, and heal a dead one | Crit pressed in the row (or "Critical Hit" in the status line where it does not fit), two failed saves. The dead line in the status line | br-c-2 |
| Undo move after a drag at 375 x 667, and Doesn't count at 390 x 844 | The undo arrow in Roll's place, Conditions kept. Roll stays, Doesn't count behind Expand | unit `restFit`, br-c-1 |
| 375 x 667 with the strip's buttons drawn wider | Roll drops behind Expand by the drawn widths, Conditions kept | br-c-1 |
| Conditions from rest | Expanded with the drawer, focus on Conditions. Closing it rests | br-c-1 |
| Uses from rest at 440 x 956 | Expanded with the Uses drawer. Closing it rests | lane B's combatuses |
| The group's strip | "3 selected", group entry, Conditions, Roll. The exclusion note in the status line | br-c-1 |
| Every edge and corner token, close zoom, four phones, both roles | Panned above the strip, tapped | br-f-5 |
| The same with the DM's concentration card standing | Reached left of or under the card | br-f-5 |
| Fit, Find, a tracker row opening the bar | Token lands above the strip | unit `restingBar`, br-f-6 |
| The map's top edge under a strip that just opened | The next pan moves it toward its bound, never further out | unit `keepInView` |
| Compact screen, phone on its side, tablet, computer | As today | playerphone, dmphone, bardock |
| A stored `rvtt.tokenBarLarger`, and View as a player | Removed, bar rests. The preview's strip, a tap's one request and its toasts' times as in the room, `rvtt.tokenBarLarger` never written | unit, br-f-7 |

## 11. Tests

**Unit** (`node:test`): barDock.test.ts gains these cases:
- `placeBar` for rest and expanded at the four phones, with a standing and a folded card, with `heldMode` "span" at F = 140, with none at F of 141 then 148 (compact, then the strip), and with none in a layout on its side after a turn (docked). `openMode` at 320 x 568 at 130% with a card standing (the strip), summoned onto the toolbar and summoned onto the screen (each by `cardAt`).
- `restHeight` at F of 140, 146, 148, 165, 166 and 715. `expandReach` at F of 293 and 294, and `expandedRoom` at F of 294 and 715 and with a column card.
- `restLane` at 43, 44 and 45 px of band.
- `clearShift` under, at and over the strip, a tall token, a group's anchor and a toast stack.
- `stripSqueezed` at F of 147 and 148, held and not. `barCover` for a bar across the free area. `restingBar` in span mode.
- `restFit` and `restOrder`: fitting apart from display, a passing action never evicting Conditions, the skip rule, the 56 px field, no room.
- `restStatus`'s order, with a kept crit and valid text, a kept crit then Heal, a crit once the target is above 0 HP, a group's left-out creature with valid text, both, a group heal with dead and left-out creatures, and an 80-character name in the DM's heal line, a player's, the Set line and a preview with a crit and an exclusion, its `fit` measuring the note's 206 px. `nextRestMode`.
- `keepsOpening` from nothing shown, from another token, from the same token, from one token to a group (a gathering tap), from group to group, and to nothing shown (the bar hidden or off Select).
- `nextToastPlaces` with `restFloor`, a stack a pane left included, and `toastsOverBars` at 43 and 44 px of room.

camera.test.ts gains `keepInView` with `from` beyond the bound, and `barShift` at the pan limit and past it, with `dy` scaled at 130%. barButtons.test.ts gains `restButtons` for the DM, an owner, a player, a token with no HP, a group, and with Uses, and `barCapacity` on the first render with a card standing at 320 x 568 at 130% (the strip's layout). selection.test.ts gains `local.opening`: set by a tap, Actions and `selectToken` with `opens` and the bar on, cleared by a hide and a let-go, and never set by `selectToken` without `opens` or with the bar off, or by `keepSelected` after a group's anchor goes with Multi-select off. toasts.test.ts gains an error waiting behind an action toast (no timer until `toastsDrawn`), a toast arriving while another is held, `holdToast` keeping the time left across showing whole and shrinking back, and a second `toastsDrawn` and a later `toastsLeft` that never move a stamp. Each new test fails with its rule taken out, and the builder says how.

**e2e**: a new `e2e/barrest.e2e.ts` on E2E_PORT plus seven, which it shares with the phone files. Its 2 s probes run on Thorn only, at 390 x 844. Frame steps carry `br-f-`, content steps `br-c-`:
1. `br-f-1` Opening, pans, a pinch and a tap on another token: the strip's box on every frame.
2. `br-f-3` A whisper, an actionable toast placed before the strip opens, and a concentration card.
3. `br-f-5` Reach at the four phones, as the DM and as Pat: every edge and corner token panned above the strip and tapped, once with the DM's card standing.
4. `br-f-6` Fit, Find, a tracker row, the party bar, a companion's show and the outliner's show after Ruler, each with one clear request.
5. `br-f-7` Expand, its rule at F of 209 and with a column card, a pinch, Collapse, another token, a drop, Close, a turn to landscape and back with the strip held, and the preview's tap.
6. `br-f-8` The clearing move on a tap, a drop, an arrow nudge, a pan under way, Ruler then Select, a blackout's end, a placed token, an attach holder link and a duplicate with the bar open (one request each), a gathering tap in Multi-select, the tracker's Multi-select branch, a follow-turn pan, a pin's show on map, a placed token and a stat block with the bar off, and a second client deleting a group's anchor with Multi-select off and moving a token to another scene (no request), and a token in the map's top row with the camera at its pan limit.
7. `br-f-9` A roll card arriving and leaving at 390 x 844 and at 320 x 568 at 130% with Multi-select and a turn band, the same card with no bar open, and "Roll asked" tapped. Pat at 320 x 568 at 130% with a card standing taps Thorn (the strip, the card folded), taps "Roll asked", answers the card and reopens the bar by Actions.
8. `br-f-10` A free area of 148 at 130% (a 320 x 360 window, F = 148.9 by `freeArea`): the strip's height, the DM's summary row out of the band, and reach to the edge tokens with the summary showing. A compact bar opened at 320 x 480 at 130% with Multi-select and a turn band turns into the strip as the fight ends, with the camera unmoved.
9. `br-f-11` At 320 x 440 at 130% on Thorn's turn, a trap's "Save and damage" toast and a fall's "Ask for the save" reminder: one 44 px row over the top bar's row, its action 44 px tall and whole, End turn and the band uncovered, a tap on its text showing it whole with its time held, a toast arriving meanwhile, Close and Escape shrinking it back with its time left, and an error behind an action toast drawn with its whole time once that toast goes.
10. `br-c-1` The quick row per role and token, the group's, Undo move in Roll's place, Conditions from rest. At 375 x 667 it reads the candidates' drawn widths and asserts what `restFit` gives for them, not a fixed list, once more with letter spacing widened on the strip's buttons by a test stylesheet (in a context that bypasses the page's style policy), so Roll drops. `br-c-2` The HP entry: kept Heal mode, invalid input, a refusal, Crit on a dying creature, a kept Crit with valid text at 320 x 568 at 130%, a group's left-out creature, a dead line. `br-c-3` The scrolling strip at F of 210 and 148 (320 x 440 and 320 x 360 at 130%) and at 375 x 667 with a card: each control scrolled to shows whole and on top, as B.3 measured, "Scroll for more", and the DM's alerts reached after scrolling to the strip's foot and back up to its header's summary button.

**Steps that use controls outside the strip** (Appendix C, by file) take one helper, `barControl(bar, name)` in e2e/harness.ts, which presses Expand first when the control is not in the strip and the bar rests. Helpers call it too: `setTool` (reachRoom.ts:236), `measureWindow` (alignment.e2e.ts:459) and `selectGoblins` (groupsave.e2e.ts:126). Steps that assert today's span place or Larger are rewritten for the strip or Expand:
- playerphone 7, 11, bs-1 to bs-3, fu24r1-own and fu24r1-pan.
- dmphone 7's "keeps off the Hag", lp19-bs2, lp19-bs3, and fu24-q1 and fu24-o3 with `lowBrute`.
- tokenpanel 6, 7b, 8's in-view checks and 9c's reach.
- fold 9, and alignment's window-larger and group-larger.

The build runs every file Appendix C names, with `reach` and `bardock`.

**Alignment roots** stand in the token window's section of e2e/alignment.e2e.ts (today's 655 to 700, where window-larger is measured), apart from lane B's block at the file's end. `window-thorn`, `window-goblin` and `window-group` now measure the strip. `window-expanded` and `group-expanded` replace the Larger roots. New are `rest-row-pat` (Undo move in Roll's place where it fits) and `rest-crit` (a dying Thorn, with Crit in the row where it fits), at 390 x 844 and 320 x 568, 100% and 130%, and `rest-scrolls` (the scrolling strip at its top and middle positions, at 375 x 667 with a roll card and in the 320 x 440 and 320 x 360 windows at 130%). `measureWindow` expands first for its play-row measures.

## 12. Build lanes

Lane B has built its bar content (Uses in barButtons.ts, the drawer, its TokenActionBar.tsx regions). This work stacks on it:

**Content lane**, after lane B, owns: client/canvas/barButtons.ts and its test, TokenActionBar.tsx's content (everything outside lane F's region: `TokenActionBar`, `TokenBarBody` with its Duplicate, `GroupActionBar` and the components they draw), features/tokens/HpSection.tsx, features/tokens/GroupHpEntry.tsx, and barrest.e2e.ts's `br-c` block.

**Lane F, the frame**, beside the content lane from lane F's first commit, owns:
- client/canvas/barDock.ts and its test, and a new client/canvas/RestRow.tsx (the fit's layout).
- TokenActionBar.tsx from `type FrameControls` to the end of `BarFrame` (today's 708 to 1340) and the barDock import block (37 to 53). The content lane adds its imports as separate statements.
- client/canvas/Stage.tsx, client/lib/camera.ts and camera.test.ts, client/pages/Room.tsx (the toasts' inputs, `toastsDrawn` and `recent`, and `ToastNote`'s row and whole forms), features/rolls/PlayerRolls.tsx (today's 193 to 229: `yieldsToBar` and `cardAt`), and features/encounter/InitiativeStrip.tsx's summary row placement only (the `raisedRow` effect, today's 641 to 693).
- The room store (3.6, 9.3): client/state/selection.ts, types.ts and store.ts, with selection.test.ts and toasts.test.ts, and features/dm/preview.ts's `RoomUi`. The `{ opens: true }` at 3.6's `ui.select` callers, that call only: features/tokens/placeTool.tsx, CharactersPanel.tsx, CharacterCard.tsx and statBlockOpen.ts, features/encounters/EncountersPanel.tsx and features/attach/BarParts.tsx.
- The new `scrollMore` icon: client/components/Icon.tsx's LUCIDE list and path, with its credit in shared/credits.ts and CREDITS.md.
- e2e: barrest.e2e.ts (it creates the file with the room's setup and an empty `br-c` block), the helper in harness.ts, and its alignment roots in the token window's section.
- The steps of Appendix C in tokenpanel, playerphone, dmphone, alignment, size, attach, fold, combat, groupsave and savespell, and reachRoom.ts's `setTool`. Dicefolds, vision, regress, traps and table only run.
- FEATURES.md lines 49 to 52, docs/dm-guide.md's line, and "Status: changed by docs/design-v1-bar-compact.md" lines under docs/design-v1-bar-dock.md 1.1 and 1.5.

**Contract**, lane F's first commit, which the content lane builds against:
- `FrameControls.rest { resting, scrolls, expand(), collapse() } | null`, replacing `size`.
- `BarHeader`'s `status?: ReactNode`.
- `RestRow({ items: readonly { id: string; node: ReactNode }[] })`, which lays out what fits in the room its row leaves. Its ids are strings: BarButtonIds, `"details"`, `"crit"`, `"useRoll"`, `"mode"` and the group's.
- `REST_HEIGHT`, `REST_TIGHT`, `restHeight`, `restOrder`, `openMode`, the dock store's `heldMode` and `BarRoom`'s held mode, which the content lane's `barCapacity` reads, and `RoomUi.select`'s `{ opens }`, which its Duplicate passes.

**Landing order**: lane F's contract, lane B, the content lane, then lane F's build and its e2e and docs commits last, since only then does the strip hide controls.

## 13. Recommendations to check

Each settles something the owner's words leave open, with the alternative rejected, judged by past decisions. R2 is the owner's decision now.

- **R1. Expanded lasts while the bar is open, and nothing is stored.** Rejected: remembering it per device, as Larger was (decision "token pop-up size on phones"). Why: a stored expanded state would open every later token large and move the map each time, the "moves weirdly" the owner reports.
- **R2. The bar clears its own token at a tap and a drop (D-261024-9 and 13).** Rejected: the strip covering it until a pan (draft 1), which reversed the bar-dock rule that the pane not cover creatures.
- **R3. Collapse moves nothing.** Rejected: Smaller's move back. Why: it would often put the token back under the strip.
- **R4. A roll card at the foot lifts the strip, or folds where it would leave F under 148.** Rejected: the card standing on the strip, and the bar turning compact. Why: the card's own rules stay, and the bar never grows by itself.
- **R5. Expanded grows up from the strip's foot and never hangs over its token.** Rejected: today's Larger. Why: one place for the bar, and no following or flipping.
- **R6. "Expand" and "Collapse"**, chevrons kept. Rejected: "Larger" and "Smaller". Why: the owner's own words.
- **R7. Conditions and Uses expand with their drawer, and closing it rests again.** Rejected: a pop-up, or staying expanded.
- **R8. The quick row fits by measured widths.** Rejected: a fixed set, or a sideways scroller.
- **R9. The compact overlay keeps no resting state, a strip never becomes compact by itself, and a compact bar becomes the strip once room returns** (BC-OPUS-25). Rejected: holding compact until the bar closes, which kept the full overlay up after a roll card went.
- **R10. The tool's options stay under the strip as part of the foot**, so Actions and Done stay in reach.
- **R11. Uses after Multi-select.** Rejected: before Conditions. Why: D-261024-11 puts Multi-select after Roll, and the places should hold.
- **R12. The status line under the name** carries vitals and the HP entry's feedback. Rejected: vitals beside the name (measured: Close pushed off at 320 x 568 at 130%), and expanding for each error. Why: it works where Expand is not offered too, and keeps focus and typing where they are.
- **R13. Undo move in the strip is the undo arrow alone**, as the top bar's Undo. Rejected: its words, 103 px, against the 67 px Roll's place leaves at 390 x 844 and 52 at 375 x 667 (Appendix B.2). Why: D-261024-12's one tap at 390 and 375.
- **R14. The field's least width is 56 px with the mode's sample as placeholder.** Rejected: 72 px, with which neither Roll nor Undo move fits at 375 x 667, and Uses does not fit at 440 x 956. Why: three digits and a sign still show, and the toggle names the mode.
- **R15. Expand shows only where it can grow by a header's height (a reach of 166 px), and the strip scrolls elsewhere** (BC-OPUS-22). Rejected: the 242 px floor of draft 2, where Expand gained nothing yet moved the map, and a full-screen overlay. Why: Expand should always show more.
- **R16. "Use 9" ranks after Roll's place.** Rejected: before Conditions. Why: chips come and go with each roll, and Conditions must not move. By the measured widths, it fits after Roll at none of the four phones, so it is one tap behind Expand, and the typed number does the same.
- **R17. The strip gives up height where F is under 166, down to 94 px, to keep 44 px of map above it** (BAR-ASTRA-06). Rejected: a fixed 114 px with a 26 px band. Why: 44 px is a touch target, and the header and quick row still show whole.
- **R18. Where the band is short, the newest toast is one 44 px row over the top bar's row, its words cut to a line and its action whole, and a tap on the words shows it whole** (BAR-ASTRA-06, BC-OPUS-31). Rejected: the whole toast over the top bars, 105 px or more at 320 wide, which reaches past the turn band, and toasts over the band or the strip's header. Why: End turn and the band stay clear, and nothing is lost, since the words are one tap away and the accessible name. A leading noun in place of the first letters (the round 4 option) is not added: the only rule from the text alone, the first word whole where it fits, gives "Hid…" again ("Hidden" is wider than the 62 px left, B.5) and "Pip…" for "Pip m…".
- **R19. The summary row rises, else stands in the strip's header.** Rejected: standing in the band.
- **R20. The scrolling strip's header scrolls, with "Scroll for more" in Expand's place and no fade** (BAR-ASTRA-05). Rejected: a sticky header with a smaller hint, which leaves 60 px of window, a 44 px row and no room for the hint. Why: every row shows whole.
- **R21. Feedback longer than the title's two lines shows in a note on the strip's top edge, never past two lines: the creature's name is cut by width, and the dead lines name it once** (BAR-ASTRA-08, BC-OPUS-29). Rejected: shorter sentences for the strip only, expanding, and a note that grows with the name. Why: the warning and the recovery always show whole, and the full sentence stays the field's description.
- **R22. No undo arrow in the header where Roll's place does not fit** (the round 2 option). Measured (B.4): at 320 x 568 at 130% it leaves the title 61 px, where "AC 14 · HP 24/24" takes two lines and "7 damage, Critical Hit" four. At 100% (134 px) the error and the refusal take three. Undo move stays one tap behind Expand there.
- **R23. The opening rule reads F without a roll card standing at the foot** (BC-OPUS-25). Rejected: today's count, which opens the compact overlay at 320 x 568 at 130% whenever a player's card stands. Why: the card folds into "Roll asked" instead, and the strip stays small.
- **R24. A clear request comes from an opening's own intent, kept only where the bar then shows a new token** (BAR-ASTRA-09). Rejected: reading it from how the selection changes (round 3's `opensBar`), which a deletion's cleanup meets with no tap, and marking pans in `watchPans`, which needs an origin on every `PanRequest`. Why: only the viewer's own opening moves the map, and `tap` and `showActions` carry it with no edit to their callers.

## 14. FEATURES.md and the DM guide

- Line 49's "On a phone held upright it spans the screen under the token." becomes: "On a phone held upright it rests as a strip at the foot of the map with the token's name, AC and HP, a Damage or Heal switch, the HP entry and the actions used most that fit, such as Conditions and Roll. It stays put as you pan, so every token can be brought above it, and as it opens it moves the map just enough to keep its token in view."
- Line 50 becomes: "On a phone held upright, Expand, just left of the action bar's Close, opens the whole bar, up to about two thirds of the screen, and moves the map so the token stays in view above it. Collapse rests it again. Conditions in the resting bar opens the bar with its grid, and closing the grid rests it again. A bar you open afresh rests. On a screen too short to expand, the resting bar scrolls to everything else. While you type an HP change, the line under the name says what Apply will do, a kept Critical Hit and who it leaves out included, or why it cannot, and a longer message shows just above the bar." Line 50's toast sentences gain: "Where the map above the resting bar is short, a new toast shows as one line over the top bar, its button whole, and a tap on its words shows all of it." The toast sentences already there keep their meaning for the expanded bar's header.
- Line 51's "such as a phone held upright at a larger interface size" becomes "such as a small phone held upright at a larger interface size", and "A phone held upright keeps one layout whichever token you tap, with Apply in view" holds for both states.
- Line 52 gains: "On a phone held upright the resting bar shows what fits of these, Undo move as its arrow in Roll's place, and Expand shows them all."
- docs/dm-guide.md's "On a phone held upright, the bar opens under the token." becomes "On a phone held upright, the bar rests at the foot of the map, and Expand shows all of it." The guide pass after the run retakes action-bar.webp on a phone.

## As built

### 9.1 to 9.3, the frame lane

- **RestRow measures in place.** Every candidate is mounted once, under a wrapper keyed by its id, and never drawn twice. One that does not fit takes an absolute place at the row's right corner with `visibility: hidden` and no pointer events, so one wider than the row runs out on the left, which no box scrolls to, so it leaves the row's flow, the focus order and the accessibility tree but keeps its node, its typing and its width, which a ResizeObserver on the row and each wrapper reads again as fonts, words or the row's width change. The lead's field is the element marked `data-rest-field`, or else its input, and the lead counts without it. Widths are read as drawn and the gap and the field's 56 px least scale with the chrome's zoom. `onFit` hears the ids shown, in order, from a layout effect, only when they change. The row clips by a clip path 4 px past its own edges (`inset(-4px)`), so the 2 px focus ring and its 2 px offset show whole around every control in it (the content lane's finding), and the row's box stays its parent's width, the fit's room. Rejected: a 4 px padding pulled back by a negative margin, which ran 4 px past the row's parent on each side (tokenpanel's no-sideways-scroll check).
- **restFit** comes from barButtons.ts, the content lane's (9.4). `restOrder` stays in barDock.ts and keeps any id it does not know after the known ones, in the order given.
- **The held mode counts only on an upright layout** (`heldOrOpenMode`): the render between a turn of the screen and Stage letting go of `heldMode` draws the opening rule's mode. `openMode` counts a card at the foot as map on an upright layout only.
- **The dock store** gains `barOpen`, which Stage publishes and which ends `expanded`, `expandedHeight` and any `clearRequest` as the bar closes, and `headerSummary`, which the alerts' summary row hands to the strip's header from InitiativeStrip.tsx's `raisedRow` effect, its count read from the row's "+N". `clearRequest` carries `drop: true` for the request a drop sets, and an expanded bar drops that one, since it comes back with no map move (5.3). A request waits for the expanded bar's height before it is used. Stage refuses `shiftForBar` while a camera move it has asked for is still to land.
- **BarFacts.rests** marks the resting strip for the toasts and the column. The frame carries `data-bar-state` ("rest", "expanded" or "scrolls") on its dialog, for the tests.
- **BarHeader's `sentence`** draws over the title's lines or as the note on the strip's top edge, 12 px in from each side (`NOTE_INSET` in barDock.ts, which TokenActionBar.tsx imports as `STRIP_NOTE_INSET` beside the content's own copy until the content imports it).
- **The column's fade.** A bar stacked under the alerts column's first card keeps up to 48 px more under it while more cards follow (`COLUMN_FADE`, `firstFoot`), so "Scroll for more" lies past the first card and never over its last line, as it did over a time-up line's second at 844 x 390 (lane B). The expanded bar's cap under a stacked card counts the same room. Its frame key, which works the expanded height out again, counts the column's content too. Over the resting strip the column stacks only where all its cards, not only the first, leave the 44 px band whole, and otherwise shows its summary row (`restLane`), since a stacked column reaches down to the strip and its later cards and fade would cover the band. Rejected: keeping the stacked column to its first card and the fade by its room (`columnRoom`), which needs InitiativeStrip.tsx outside the `raisedRow` effect and keeps less map than the summary row.
- **The expanded room** for `barCapacity` is `spanRoomAtWorst(free, layout?)`, the expanded reach (5.1), with the layout optional: without it the reach is F − 128.
- **Larger is gone**: `forgetLarger` removes `rvtt.tokenBarLarger` as the dock store is made, in try and catch.
- **The toasts.** `nextToastPlaces` takes `anew`, the ids of a layer stack whose foot stands lower than the strip's top less 60 as it rests or its top rises. `clearShift` counts the toasts' foot only while it stands at or above the token's top less 8 (review LP19-OPUS-1). In the one row, the newest toast takes the row, and a toast that came while one showed whole takes it as that one shrinks back (3.5), the older running on behind it.
- **The free area reads the bars as drawn.** The token bar's chrome takes the top bar's and the toolbar's heights unrounded (Room.tsx `useHeight`, which keeps the rounded one for the map's insets). Rounded, they took a third of a pixel at 130%, F came out 147.8 at a 320 x 360 window and the compact overlay opened there. As drawn F is 148.2, and the strip opens. br-f-10 grows the window a pixel at a time from 349 and finds the strip at 360. The alerts column reads the same chrome, so at 320 x 480 at 130% with 44 and 34 px insets on Thorn's turn it now stands as its summary row, where a card fit by less than a pixel before (fold 9 waits for the cards however the column draws them).
- **The expanded height lasts through a drag.** The dock store keeps what the height was worked out for (`expandedFor`: the bar's token and the map's frame), since a drag unmounts the frame. So the bar comes back at the height it had, and what the drop adds, such as Undo move, scrolls under Scroll for more, as 5.1 freezes it (playerphone bs-2).
- **A turn's first card takes the toasts under it** (review LP20-CC-2, D-261024-19). For a moment after the active turn changes (`turnStarted`, Room.tsx, as long as `CARD_MS`), the toasts at the notices' top take their places again, as toasts that came then would, on the first render with a place under a card where the render before had none (`nextToastPlaces`, `turnCard`): the turn card or a death save card coming to a column that showed no card. So the folded turn card's Show and the death save card's words are never under a toast. Rejected: any first card at any time, which the bar dock's rule that nothing jumps under a finger keeps out (docs/design-v1-bar-dock.md 1.3), and hiding the toast until the card folds, which loses its button meanwhile.
- **The br-f steps' cases.** br-f-3 and br-f-11 use whispers for the toast placed low and for the row's toasts, where 11 names a trap's "Save and damage" and a fall's "Ask for the save". br-f-8 drives a tap, a Gargantuan, a drop, Ruler then Select, a blackout's end, a gathering tap, a removal, a plain tap from a group (review BC-OPUS-37) and a duplicate. An arrow nudge, a pan under way, a placed token, a holder link, the tracker's Multi-select branch, a follow-turn pan, a pin's show, a stat block with the bar off, another client's deletion or scene move, and the camera at its pan limit rest on the unit tests (`keepsOpening`, `selectToken`, `tapToken`, `keepSelected`, `barShift`). br-f-6 leaves out a companion's show and br-f-7 the preview's tap, which the same unit tests cover.
- **e2e.** `barControl(bar, name, role?)` and `expandBar(bar)` in e2e/harness.ts press Expand on a resting strip when the control is not in it. Appendix C's steps use them, and the span and Larger steps are rewritten for the strip and Expand. alignment.e2e.ts measures each token window's header on the strip (or, on a strip that scrolls, the row that holds its Close) and the rest expanded, `window-expanded` and `group-expanded` in place of the Larger roots at the 5 sizes where Expand is drawn in the sweep's fight, `rest-row-pat` and `rest-crit` wherever the strip draws its quick row, and `rest-scrolls` at 375 x 667 with a roll card and in 320 x 440 and 320 x 360 windows at 130%. `cu-turn-hidden-bar` shows at 4 sizes, not 8: on the upright phones the strip stands at the map's foot, clear of the turn card. br-f-12 checks that nothing clips the quick row's focus rings, the row and every box above it to the frame, that the row runs out of nothing sideways, and its alignment, wherever the strip draws the row. br-f-13 checks a toast going under a death save card as a turn starts. `multiSelect(bar)` in e2e/harness.ts turns Multi-select on by `barControl` and rests a strip it expanded, so the gathering taps meet the map (savespell, groupsave, br-f-8), and in Multi-select one finger on the map draws a box that gathers, so br-f-8 pans with two. An expanded bar a drop leaves over its token rests before the next tap (attach), and tokenpanel fits the map after a clearing move took its tokens away. In br-c-3, the content lane's block, changed in this lane once the strip opened at 320 x 360 at 130%: the DM's step pans Thorn below the concentration card before its tap, and finds the summary row risen into the top bar's gap left of Undo, which 3.5 allows before the header, so it checks that row in reach there, and the header's scroll where the header holds it.

### 9.4, the content lane

- **Where the rules live.** `restFit`, `restStatus`, `nextRestMode` and `restButtons` are in barButtons.ts, not barDock.ts, which is the frame's: the content lane owns them and their tests. `restOrder` stays in barDock.ts. barButtons.ts also gives `groupRestButtons` (the group's candidates), `restDead` (the dead lines' cases, by the rule of groupHp.ts `deadLines`), `critSent` (whether Apply sends a Critical Hit, which the entry's Apply and the status line now share) and `REST_FIELD_MIN` (56).
- **`restFit(widths, room, gap, fieldMin)`** reads the lead's width without its field, and counts the field at `fieldMin`. The lead always shows, its field giving up room first. A candidate drawn 0 px wide is left out, so a door's button with no door in reach, or Doesn't count on a resize's leg, never takes Roll's place. Only the first passing action is offered Roll's place.
- **The group's strip** offers Undo move in Roll's place after a group's drag, as one token's strip does (D-261024-12). 9.4 lists Conditions, Roll, Multi-select and Hidden only.
- **`restStatus`** takes three measures, the line's one line, the title's two lines and the note's two lines, and returns the line under the name, the sentence that needs more room with its place ("title" or "note"), and the whole sentence. A sentence (items 1 to 3) that fits one line stands under the name, which stays. Items 4 and 5 always take the line, cut with an ellipsis where they must, the whole sentence being the field's description. The frame draws the sentence over the title or in the note through `BarHeader`'s `sentence` prop, a contract addition agreed with the frame lane. The status span carries it as `data-rest-sentence` and `data-rest-place` too, which br-c reads.
- **Cutting in the note** goes: the dead creature's name, or the one creature a group leaves out, to its most letters that fit (at least one), then the names left out as their count, cutting the dead name again there if it must. Several creatures left out go to their count at once, since there is no one name to cut. Left-out names are joined with commas: "7 damage, not Goblin 1, Goblin 2".
- **The group's line with nothing else to say** names who is selected, as the line under the expanded group bar's header does. 3.3 leaves it open.
- **`HpEntry` takes `rest: HpRest`** in place of `layout: "rest"`: `resting`, `scrolls`, the bar's own candidates, the ids the quick row drew and `onStatus`. It also takes `standing`, a group's note, and `describedBy`. On an upright phone its field row is a `RestRow` in both states, the lead alone while expanded, so the same input carries over.
- **"Use 9"** is the newer of the entry's chips (this viewer's own roll and the newest of anyone else's), by its place in the log.
- **The field's description** while the strip rests is a visually hidden copy of the entry's own sentences, and its error or refusal is said once by a polite status region in the entry, not the frame's.
- **The scrolling strip** hides the vitals line, as the quick row and the status line hold them, and so draws Revive and the dead creature's note under the quick row. The rest follows in today's order, less what the strip holds.
- **Conditions or Uses from the strip** that expanded the bar close their drawer as Collapse rests it, so the next Expand shows the bar plain.
- **`GroupActionBar`** draws its content in a new `GroupBarBody`, so the content reads the frame's controls as `TokenBarBody` does.
- **Waiting on the frame's build**, in the content lane's files, once the lanes are stacked: `RestRow`'s `onFit` feeds `HpRest.shown`, the bars' `inStrip` and `critInRow` (until then every candidate counts as drawn, as the contract's `RestRow` draws them), `NOTE_INSET` comes from barDock.ts in place of the local 12, `BarHeader` gets `sentence`, and `barCapacity` passes the layout to `spanRoomAtWorst`.

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

## Appendix B. The mockups

### B.1 Draft 1's mockup: reach and the first fit

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

Draft 1's candidates after the field and Apply were Undo move, Doesn't count, Conditions, Roll, Hidden, Details and Multi-select, as this room offered no Uses, so its third action at 440 x 956 is Details. Draft 1 had no mode toggle and a 72 px field, so B.2 replaces its quick row column. Its expanded column used draft 1's cap, and 5.1 now gives at most 563, 410, 637 and 181 px at the four phones. Its reach column still holds, since the strip's box is the same.

### B.2 Revision 1's mockup: the measured fits

The same restyled bar, rebuilt for this revision: the mode toggle (44 px, the minus sign in the Damage colour), the field at its 56 px least and Apply as the lead, Undo move as the 44 px undo arrow, and the quick row filled by 3.3's fitting order and drawn in its display order. The status line drops AC where the vitals overflow by any amount, as Chrome draws the ellipsis for less than a pixel. It drew vitals only for a token with the lead. Every run measured the strip at 114.0 layout px, at (layout px from the page's top) 662-776 (390 x 844), 485-599 (375 x 667), 774-888 (440 x 956), 255-369 (320 x 568 at 130%), 467-581 (390 x 844 at 130%) and 386-500 (320 x 568), with no alignment finding with or without the passing action. The room's tokens are Thorn (Pat's, 24 HP), a goblin, a barrel with no HP and Pat's lantern with no HP. Crit, "Use 9" and Uses are drawn as bar buttons with those words: Uses stands in for lane B's button, which is not on main. "Inner" is the row's width in layout px. "Passing" is the row while Undo move (Pat) or Doesn't count (the DM) applies, and "waits" means it does not fit Roll's place, so Roll stays. "At 0 HP" adds Crit and "Use 9" to the candidates. Screenshots: `r1c-rest-*` in the `token-bar-pass` folder.

| Phone | Who, token | Inner | Lead | Quick row after the lead | Passing | At 0 HP | Status line | Alignment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 390 x 844 | DM, Thorn | 348 | yes | Conditions, Roll | waits | Crit, Conditions | AC 14 · HP 24/24 | 0 |
| 390 x 844 | Pat, Thorn | 348 | yes | Conditions, Roll | Conditions, Undo move | Crit, Conditions | AC 14 · HP 24/24 | 0 |
| 390 x 844 | Pat, a goblin | 348 | no | Multi-select, Details |  |  |  | 0 |
| 390 x 844 | DM, the barrel | 348 | no | Conditions, Roll, Multi-select, Details | Conditions, Doesn't count, Multi-select |  |  | 0 |
| 390 x 844 | Pat, his lantern | 348 | no | Conditions, Roll, Multi-select, Details | Conditions, Undo move, Multi-select, Details |  |  | 0 |
| 390 x 844 | Pat, the barrel | 348 | no | Multi-select, Details |  |  |  | 0 |
| 375 x 667 | DM, Thorn | 333 | yes | Conditions, Roll | waits | Crit, Conditions | AC 14 · HP 24/24 | 0 |
| 375 x 667 | Pat, Thorn | 333 | yes | Conditions, Roll | Conditions, Undo move | Crit, Conditions | AC 14 · HP 24/24 | 0 |
| 375 x 667 | Pat, a goblin | 333 | no | Multi-select, Details |  |  |  | 0 |
| 375 x 667 | DM, the barrel | 333 | no | Conditions, Roll, Multi-select | Conditions, Doesn't count, Hidden |  |  | 0 |
| 375 x 667 | Pat, his lantern | 333 | no | Conditions, Roll, Multi-select | Conditions, Undo move, Multi-select |  |  | 0 |
| 375 x 667 | Pat, the barrel | 333 | no | Multi-select, Details |  |  |  | 0 |
| 440 x 956 | DM, Thorn | 398 | yes | Conditions, Roll, Uses | waits | Crit, Conditions, Roll | AC 14 · HP 24/24 | 0 |
| 440 x 956 | Pat, Thorn | 398 | yes | Conditions, Roll, Uses | Conditions, Undo move, Uses | Crit, Conditions, Roll | AC 14 · HP 24/24 | 0 |
| 440 x 956 | Pat, a goblin | 398 | no | Multi-select, Details |  |  |  | 0 |
| 440 x 956 | DM, the barrel | 398 | no | Conditions, Roll, Multi-select, Hidden | Conditions, Doesn't count, Multi-select |  |  | 0 |
| 440 x 956 | Pat, his lantern | 398 | no | Conditions, Roll, Multi-select, Details | Conditions, Undo move, Multi-select, Details |  |  | 0 |
| 440 x 956 | Pat, the barrel | 398 | no | Multi-select, Details |  |  |  | 0 |
| 320 x 568 at 130% | DM, Thorn | 205 | yes | none | waits | none | HP 24/24 | 0 |
| 320 x 568 at 130% | Pat, Thorn | 205 | yes | none | waits | none | HP 24/24 | 0 |
| 320 x 568 at 130% | Pat, a goblin | 205 | no | Multi-select, Details |  |  |  | 0 |
| 320 x 568 at 130% | DM, the barrel | 205 | no | Conditions, Roll | waits |  |  | 0 |
| 320 x 568 at 130% | Pat, his lantern | 205 | no | Conditions, Roll | Conditions, Undo move |  |  | 0 |
| 320 x 568 at 130% | Pat, the barrel | 205 | no | Multi-select, Details |  |  |  | 0 |
| 390 x 844 at 130% | DM, Thorn | 258 | yes | Roll | waits | Crit | AC 14 · HP 24/24 | 0 |
| 390 x 844 at 130% | Pat, Thorn | 258 | yes | Roll | Undo move | Crit | AC 14 · HP 24/24 | 0 |
| 320 x 568 | DM, Thorn | 278 | yes | Conditions | waits | Crit | AC 14 · HP 24/24 | 0 |
| 320 x 568 | Pat, Thorn | 278 | yes | Conditions | waits | Crit | AC 14 · HP 24/24 | 0 |

Widths drawn, in layout px at 100% (130% within 1 px): the toggle 44, Apply 66, Crit 51, Roll 51, "Use 9" 65, Uses 60, Details 72, Hidden 98, Conditions 99, Multi-select 108, Doesn't count 121, Undo move 44 as the arrow and 103 in words. The lead takes 174 with a 4 px gap. With a 72 px field (the first run of this revision, `r1-rest-*`), 375 x 667 got Conditions alone, with Roll and Undo move both out, and 440 x 956 lost Uses (R14).

### B.3 The scrolling strip (revisions 2 and 3)

The same restyled bar as B.2, with Expand not offered: the header not sticky, no fade, a double-chevron "Scroll for more" in Expand's place, the quick row under the header, and the rest of the bar under it in today's order, the vitals line and the entry's own field and modes hidden as the quick row holds them. The window's height set the free area, read as barDock's `freeArea` does, 8 px in from the top bars and from the foot (review BC-OPUS-26): 320 x 440 and 320 x 360 at 130% have 320 x 568's width and F of 210 and 148.9, where the strip is `restHeight(F)` tall and gives up its paddings and gap first. Today's bar opens compact at F = 148, with no Larger to relabel, so there the mockup drew its own button. For every control and line of text below the header (buttons, fields, checkboxes, paragraphs, the vitals and saves lines), it scrolled the item into view (nearest edge) and checked that it lay whole in the scroller and was the top thing at its middle and 2 px in from each corner. The alignment helper ran at the top and middle scroll positions. Screenshots: `r3-scroll-at210v-*`, `r3-scroll-at148v-*` and `r3-scroll-card375v-*` (top, mid and end) in the `token-bar-pass` folder. Revision 2's runs (`r2-scroll-*`) read F 16 px high, from the top bars to the foot with no edges, so their 320 x 339 window was F = 133, not 148, and its 375 x 667 card F was 237, not 253. Their checks held for the strip heights they drew, and they are kept, not used.

| Window, who | F | Strip | Band | Quick row after the lead | At the top: header, row (layout px) | Content in window | Whole and on top | Alignment, top and middle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 320 x 440 at 130%, the DM on Thorn | 210 | 114 | 88 | none | 52, 60-104, both whole | 666 in 112 | 19 of 19 | 0, 0 |
| 320 x 360 at 130%, the DM on Thorn | 148 | 96 | 44 | none | 48, 50-94, both whole | 656 in 94 | 19 of 19 | 0, 0 |
| 375 x 667, Pat on Thorn, a roll card standing | 237 | 114 | 115 | Conditions, Roll | 52, 60-104, both whole | 380 in 112 | 15 of 15 | 0, 0 |

### B.4 The status line's lines (revisions 2 and 3)

The real header of Thorn's bar as the DM, its title drawn as the strip's (the name, then the status line in 13 px on 18 px lines), with each sentence set in turn and its lines counted: as the title has it, with a 44 px undo arrow or summary button added before Expand, with both, and in the note on the strip's top edge (12 px in from each side, 8 px above and below). The group's sentences were measured without the comma after "damage" that 3.3 keeps, one character shorter. Screenshots: `r2-status-*` and `r2-status2-320x568@130-both`.

| Sentence | 320 x 568 at 130%: title 109, with one button 61, note 205 | 320 x 568: title 182, with one button 134 | 375 x 667: title 237 | 390 x 844: title 252 |
| --- | --- | --- | --- | --- |
| HP 24/24 | 1, 1, 1 | 1, 1 | 1 | 1 |
| AC 14 · HP 24/24 | 1, 2, 1 | 1, 1 | 1 | 1 |
| Heal 5 | 1, 1, 1 | 1, 1 | 1 | 1 |
| 7 damage, Critical Hit | 2, 4, 1 | 1, 1 | 1 | 1 |
| 7 damage to each of 3, not Goblin 2 | 3, 4, 2 | 2, 2 | 1 | 1 |
| 7 damage to each of 3, not Goblin Warrior 2 | 3, 5, 2 | 2, 3 | 2 | 2 |
| 7 damage to each of 4, not 2 of them | 3, 4, 2 | 2, 2 | 1 | 1 |
| 7 damage to each of 3, Critical Hit, not Goblin 2 | 3, 6, 2 | 2, 3 | 2 | 2 |
| Use a positive number, or start with + or -. | 3, 6, 2 | 2, 3 | 2 | 2 |
| You can only deal damage to or heal this creature. | 4, 6, 2 | 2, 3 | 2 | 2 |
| Healing does nothing while Thorn is dead. Revive Thorn first. | 5, 9, 2 | 3, 3 | 2 | 2 |

**Round 3: an 80-character name** (the most a name may hold, `MAX_NAME`), "Aldric Thornwood, Sworn Warden of the Sunken Citadel and Keeper of the Last Fire". Each cell gives how many of its letters the sentence keeps, cut from the end with an ellipsis, so that it takes two lines at most, first in the note and then in the title. "none fits" means the sentence passes two lines there with no letter of the name at all. The sentences once named keep many more letters than today's, and the warning and the recovery show whole in the note at every phone. The group heal with "among them" keeps no letter at 130%, so the strip's group wording drops "among them" and counts the left-out names (below). The note's two lines are 52 px with its padding, which is the band's 44 and the gap's 8 on the 94 px strip at F = 146.

| Sentence | 320 x 568 at 130%: note 206, title 109 | 320 x 568: note 280, title 182 | 375 x 667: note 335, title 237 | 390 x 844: note 350, title 252 |
| --- | --- | --- | --- | --- |
| The DM's heal line, strip wording: "Healing does nothing while {name} is dead. Revive first." | 15, none fits | 26, 7 | 54, 20 | 57, 22 |
| The DM's heal line, today's wording (name twice): "Healing does nothing while {name} is dead. Revive {name} first." | 4, none fits | 14, 2 | 22, 9 | 25, 11 |
| A player's heal line: "Healing does nothing while {name} is dead." | 26, none fits | 38, 18 | 65, 31 | 68, 34 |
| The Set line, strip wording: "{name} stays dead at the new HP. Only Revive brings them back." | 5, none fits | 28, none fits | 42, 13 | 50, 19 |
| The Set line, today's wording (name twice): "{name} stays dead at the new HP. Only Revive brings {name} back." | 5, none fits | 15, 0 | 24, 9 | 25, 12 |
| A group heal, dead and the name left out: "Healing does nothing to the 1 dead among them. Leaves out {name}." | 0, none fits | 22, none fits | 38, 10 | 46, 12 |
| A group preview, the name left out: "7 damage, to each of 3, not {name}" | 28, 0 | 45, 24 | 74, 39 | 77, 41 |
| The same with a crit: "7 damage, Critical Hit, to each of 3, not {name}" | 22, none fits | 45, 12 | 55, 29 | 57, 36 |

**Round 3: the group lines**, which name no creature, in the note at 320 x 568 at 130% (206 px), by lines. Today's wording passes two lines there, so the strip's drops "among them" and "at the new HP" and starts the Set line with its count, the worst case being two-digit counts. A left-out name that would take the line past two becomes its count.

| Sentence | Lines |
| --- | --- |
| "The 1 dead among them stay dead at the new HP. Only Revive brings them back." | 3 |
| "Healing does nothing to the 12 dead among them. Leaves out 12." | 3 |
| "Healing does nothing to the 12 dead. Leaves out 12." | 2 |
| "Healing does nothing to the 1 dead. Leaves out Goblin 2." | 2 |
| "Healing does nothing to the 1 dead. Leaves out Goblin Warrior 2." | 3 |
| "The 12 dead stay dead. Only Revive brings them back." | 2 |
| "The 12 dead stay dead. Only Revive brings them back. Leaves out 12." | 3 |
| "12 dead stay dead. Only Revive brings them back. Leaves out 12." | 2 |
| "The 1 dead stay dead. Only Revive brings them back. Leaves out Goblin 2." | 3 |
| "Brings back 12 dead creatures. Leaves out 12." | 2 |
| "7 damage, Critical Hit, to each of 12, not 12 of them" | 2 |

### B.5 A toast over a short band (revision 3)

The newest toast drawn as 3.5's one row, in Pat's and the DM's rooms at 320 x 440 at 130% during a fight on Thorn's turn, so the turn band shows. Its look (fill, radius, shadow, font) is a real whisper toast's, its outline drawn inside its 44 px, and its action a clone of the app's sm Button with the action's words, as `ToastNote` draws one. F is 161.7 by `freeArea`, so the strip is 109.7 px and the band runs 109 to 153. The top bar's row runs 0 to 52 and Pat's End turn 54 to 98 (layout px from the page's top). The toast layer is 222 px wide. "Whole" is today's toast at that width, the text and the action wrapping into two rows. The DM's run gave the same boxes. Its turn band showed no button named End turn or Next turn on Thorn's turn, so Pat's End turn is the one checked. Screenshots: `r3-toast-pat440` and `r3-toast-dm440`.

| Toast | Action, w x h | Text area | Text shown | Row | Over End turn, over the band | Whole |
| --- | --- | --- | --- | --- | --- | --- |
| "Hidden Pit went off: Thorn." | "Save and damage", 145 x 44 | 62 | "Hid…" | 4 to 48 | no, no | 105 |
| "Pip may fall off Bessie: DC 10 Dexterity save." | "Ask for the save", 135 x 44 | 73 | "Pip m…" | 4 to 48 | no, no | 105 |
| "Hidden Pit went off: Goblin Warrior 2, Goblin Warrior 3 and Thorn." | "Save and damage", 145 x 44 | 62 | "Hid…" | 4 to 48 | no, no | 120 |
| "A group save with rolls is already open. Use Save and damage on the trap's card, which asks before replacing it." | none | 207 | "A group save with rolls is …" | 4 to 48 | no, no | 108 |

## Appendix C. e2e steps that use the bar on an upright phone

Every step at an upright phone size (320 x 480 to 440 x 956, at 100% to 130%) that touches a bar control or asserts the bar's place, read from the files at `6432b496`. Lines are today's. "Expand first" steps take `barControl(bar, name)`, which presses Expand when the control is not in the strip and the bar rests. "Rewrite" steps assert today's span place, Larger or Smaller, and are rewritten for the strip or Expand. "Confirm" steps should pass as they are, and the build runs them to check. Landscape, tablet and computer steps are left out.

| File | Lines | Step | Size | Control or assertion | Needs |
| --- | --- | --- | --- | --- | --- |
| reachRoom.ts | 236 | `setTool` helper, called at reach.e2e.ts:102 and reachRoom.ts:516 | 390 x 844, 320 x 480, 100% and 130% | Multi-select | expand first |
| reachRoom.ts | 207-211, 282-283, 380-381 | `expectBarClose`, `selectThorn`, `selectHag` | all | Close, "<name> actions" | confirm |
| tokenpanel | 988-1004 | 5, dragon and swift bars | 390 x 844 | More stats, speeds, Details | expand first |
| tokenpanel | 1015-1026 | 5b, an 80-letter name | 390 x 844 | the header's clamp (confirm), Details (expand first) | both |
| tokenpanel | 1040-1060 | 6, vitals and saves on one line, Apply in view, the mode radios | 390 x 844 | span layout | rewrite |
| tokenpanel | 1064, 1084, 1092-1093 | 6 | 390 x 844 | Details, Stat block | expand first |
| tokenpanel | 1197-1231 | 7b, the short layout | 390 x 844 at 130% | More stats, Apply in view, saves, Stat block | rewrite |
| tokenpanel | 1324-1341 | 8, Pat on Thorn | 390 x 844 | AC, vitals, sheet link, Details, saves (expand first), Conditions and Multi-select in view (rewrite) | both |
| tokenpanel | 1348-1377 | 8, Bree, the goblin, the bear | 390 x 844 | vitals, Details, the mode radios with "players apply damage", saves, Stat block | expand first |
| tokenpanel | 1397-1405 | sheetlink-a | 390 x 844 | AC, vitals link, Read more | expand first |
| tokenpanel | 1526-1533 | pl1-e, the goblin | 320 x 568 and 390 x 844, 100% and 130% | More stats, Details | expand first |
| tokenpanel | 1766-1787 | 9c, the size row | 320 x 480 at 130% | Size row reach | expand first, reach rewritten |
| playerphone | 576 | 5 | 390 x 844 | Details | expand first |
| playerphone | 588-600 | 6 | 390 x 844 | the Heal radio, kept after a blackout | expand first, or the strip's toggle |
| playerphone | 591-628 | 6 | 390 x 844 | HP change, Apply, Close | confirm |
| playerphone | 690-697 | 7, upright after Show | 390 x 844 | the roll card clear of the bar | rewrite |
| playerphone | 794, 904 | 10, 12 | 320 x 480 at 130%, 390 x 844 | Multi-select | expand first |
| playerphone | 836-885 | 11 | 320 x 480 at 130% | Multi-select (expand first), then "compact" and the summary row (rewrite: the strip stays a strip, 3.1) | both |
| playerphone | 1266-1318 | bs-1 | 390 x 844, 440 x 956 | Larger and Smaller, `rvtt.tokenBarLarger` | rewrite |
| playerphone | 1323-1362 | bs-2 | 390 x 844 | Larger, then a drag | rewrite |
| playerphone | 1364-1467 | bs-3 | 390 x 844 | Larger and Smaller on Thorn, Echo and a group, Multi-select at 1425 | rewrite |
| playerphone | 1469-1550 | fu24r1-own, fu24r1-pan | 390 x 844 | a whisper under the hanging bar's header | rewrite |
| dmphone | 436-466 | 7 | 390 x 844, 320 x 480 at 130% | the Hag's bar, every button takes a tap (confirm), the bar keeps off the Hag (rewrite) | both |
| dmphone | 1292-1389 | lp19-bs2, lp19-bs3 | 390 x 844 | the bar's room, Larger's map move | rewrite |
| dmphone | 1392-1480 | `lowBrute`, fu24-q1, fu24-o3 | 390 x 844 | a bar over its token, toasts under its header | rewrite |
| alignment | 459-467 | `measureWindow`, called at 654, 682, 692 and 708 | 390 x 844, 360 x 740, 320 x 568, 100% and 130% | the play row, Attached tokens | expand first |
| alignment | 660-666, 693-701 | window-larger, group-larger | same | Larger and Smaller | rewrite |
| alignment | 668-676, 683-684, 812 | attach-list, attach-ride, the goblin, dmDiceScreens | same | Attach, Multi-select | expand first |
| alignment | 792, 823 | dmDiceScreens | same | Roll | confirm |
| size | 545, 556, 809 | 2, lp2-3a-size | 390 x 844 at 115% and 130%, 320 x 568 | Details, Attach | expand first |
| attach | 281, 323, 347, 385, 413-432 | lp2-3a, lp2-3c-busy, at-1, at-3, fu22b-at | 430 x 932, 390 x 844, 320 x 568 at 130% | Attach, Get off | expand first |
| attach | 396-398 | at-3b | 390 x 844 | Undo move, in Roll's place where it fits | confirm |
| attach | 597-757 | pl2-a, pl2-c, pl2-d | 390 x 844, 360 x 740, 320 x 568, 100% and 130% | Attached tokens, the rows' line fill | expand first |
| fold | 441-496, 543-597, 663-711, 746-791 | 4, 6, 7, 8, 10, 11, 13 | 320 x 480 to 375 x 812 | the fold, the dock, focus | confirm |
| fold | 599-657 | 9, too short to dock | 320 x 480 at 130% | compact over the toolbar | rewrite where it opens as a strip |
| combat | 1277, 1287 | 13f | 390 x 844 | Details | expand first |
| groupsave | 141, 365, 498 | `selectGoblins` (called at 547), 3, 5 | 375 x 667 at 130% | Multi-select | expand first |
| groupsave | 182, 279, 316, 368, 482, 501, 536 | `openGroupRolls`, 2, 2b, 3, 5, 7 | 375 x 667 at 130% | the group's Roll, which fits there (about 74 px left after the lead, by the widths measured at 390 x 844 at 130%) | confirm |
| savespell | 384, 440, 477 | ss-5, ss-7, ss-7b | 390 x 844 | Multi-select | expand first |
| dicefolds | 399, 426, 433 | df-6, df-6c | 390 x 844 | Pat's Roll on Thorn | confirm |
| vision | 660-679 | 9 | 390 x 844 | a stopped walk's note over the bar | confirm |
| regress, traps, table | 252-255, 391-402, 243-258 | 5, tr-3, 4 | 390 x 844 | Undo move, Close, Back | confirm |

No step needs a change in layout, bardock, bardockRoom, the bardock sweeps, stickyfoot, rolls, smoke, tools, characters or companions: their bars are on landscape, tablet or computer screens, or they open none at an upright size.

## Appendix D. Where review rounds 1 to 4 are closed

| Finding or decision | Where |
| --- | --- |
| BAR-ASTRA-01, BC-OPUS-4: a usable expanded floor, the smallest band | 3.1, 5.1, 5.4, R15 |
| BAR-ASTRA-02, BC-OPUS-4, BC-OPUS-17: span to compact and back | 2 (the held mode), 3.2, 9.3, 12, R4, R9 |
| BAR-ASTRA-03, BC-OPUS-1, BC-OPUS-2: the HP entry's feedback, crit and mode | 3.3 (the status line, the toggle, Crit), 5.3, 9.4, br-c-2 |
| BAR-ASTRA-04: stacks already placed | 3.5, 9.1 `nextToastPlaces`, br-f-3 |
| BC-OPUS-3, D-261024-9 and 13: the clearing move | 3.6, 5.2, 9.1 `clearShift`, br-f-8, R2 |
| BC-OPUS-5: the group strip | 3.3, 9.4, 12 (GroupHpEntry.tsx, RestRow's string ids) |
| BC-OPUS-6, BC-OPUS-13: the e2e inventory and a light barrest | 11, 12, Appendix C |
| BC-OPUS-7: keepInView clamps only against moving further out | 4, 9.3 |
| BC-OPUS-8: the expanded height frozen | 5.1 |
| BC-OPUS-9: the short layout at two alignment sizes | 9.1 `spanRoomAtWorst`, 9.4, 14 (line 51) |
| BC-OPUS-10: the lanes | 12 |
| BC-OPUS-11: the ranking citation, Hidden, Multi-select | 3.3, 3.4 |
| BC-OPUS-12: stale text | 1.1 (the roll card at 320 x 568 at 130%), 3.1 (the padding), 3.3 (AC first, "Use 9 (Fire Bolt)"), 4 (the DM's column), 10 (`rvtt.tokenBarLarger`), 12 (the status lines), 14 (line 52) |
| BC-OPUS-14, D-261024-12: passing actions in Roll's place | 3.3, R13 |
| BC-OPUS-15, D-261024-10, 11 and 13: the toggle and measured fits | 3.3, 6, Appendix B.2, R14 |
| BC-OPUS-16: the move's details | 3.6 |

Round 2, where each finding and the completion conditions its confer added are met:

| Round 2 finding, with its confer conditions | Where |
| --- | --- |
| BAR-ASTRA-03, BC-OPUS-24: the preview carries every kept state that changes Apply, a crit and a group's exclusions, whenever their control is not in the strip. `restStatus` cases for each, and a kept Crit with valid text at 320 x 568 at 130% | 3.3 (item 3 and the note), 9.1 `restStatus`, 10, 11 (unit, br-c-2), B.4 |
| BAR-ASTRA-05 = BC-OPUS-18: the quick row and every later row whole and tappable, clear of the header and any hint, by a header that scrolls and no fade. Mocked at F = 209, F = 148 and 375 x 667 with a roll card. A `rest-scrolls` alignment root | 5.4, 9.2, 10, 11 (br-c-3, `rest-scrolls`), B.3, R20 |
| BAR-ASTRA-06: the strip's controls and a tappable band kept together, the summary row and actionable toasts counted. The smallest real band stated. Reach tested with the summary showing | 3.1, 3.5, 4, 9.3, 10, 11 (br-f-10), R17 to R19 |
| BAR-ASTRA-07: the move applied with the actual camera, the scene bounds and the strip's cover, `from` being the camera before the move. Tested at the pan limit | 3.6, 9.3 `shiftForBar` and `barShift`, 10, 11 (unit, br-f-8) |
| BC-OPUS-19: an explicit, single-use request from the tap, Actions, the tracker and party taps and a drop, consumed or cancelled, never replayed by a tool switch, a blackout's end or a remount. Case rows for both | 3.6, 9.1 `clearRequest`, 9.3, 10, br-f-8 |
| BC-OPUS-20: a held mode set at opening and passed to `placeBar`, `restingBar` and `barCapacity`, kept through hiding, token switches and drag remounts, reset only by a close, a turn or a new interface size. A unit case | 2, 9.1, 10, 11 (unit) |
| BC-OPUS-21: a squeeze only while an upright strip shows, and "Roll asked" tapped hides the bar. Both tested | 3.2, 9.1 `stripSqueezed`, 10, br-f-9 |
| BC-OPUS-22: Expand only where it gains a header's height, checked against the reach after the column's limits, with the examples and transitions updated | 5.1, 5.4, 9.1 `expandReach`, 10, br-f-7, R15 |
| BC-OPUS-23: fits at 375 asserted from drawn widths and priority, not a list, with a wider-font case that drops a candidate | 10, 11 (br-c-1) |
| The header undo arrow, only if it measures with long names, the HP feedback and the header's controls | R22, B.4: it does not fit, and is not added |

Round 3, where each finding and the completion conditions its confer added are met:

| Round 3 finding, with its confer conditions | Where |
| --- | --- |
| BC-OPUS-25: the opening mode reads F without a card standing at the foot (`atFoot`), not one summoned. The card folds only where it would take F under 148, and stands where both fit. Only the strip is held. A compact bar turns into the strip at F ≥ 148 with no clearing move, keeping the selection, and never back. "Roll asked" keeps the selection and the held strip, with no squeeze while hidden, and the bar comes back by Actions. Line 9 fixed. A unit case with a standing card at 320 x 568 at 130%, answering and reopening through Actions, and compact to strip with no camera move. The case rows for Pat | Intro, 1.4, 2, 3.2, 3.6, 9.1 `openMode` and `placeBar`, 10, 11 (unit, br-f-9, br-f-10), R9, R23 |
| BAR-ASTRA-06 with BC-OPUS-31: over a short band the newest toast is one row of 44 px with borders and padding, its text one line with an ellipsis, its action whole and 44 px tall. Errors and refusals likewise. The whole text is its accessible name, and older toasts wait. A tap on the text shows it whole, with a Close, Escape, and its time stopped. "Save and damage" and "Ask for the save" measured at 320 wide at 130% in a fight: the action's width, the text's least width, what shows under one word, and End turn and the band clear. One spacing rule, 8 px above the band's last 44, so 96 for both the summary row and toasts, used in 3.5, 9.1 and the unit case at 43 and 44 px | 3.5, 9.1 `toastsOverBars` and `restFloor`, 9.3 `ToastNote`, 10, 11 (unit, br-f-11), B.5, R18 |
| BAR-ASTRA-08 = BC-OPUS-29: the note never passes two lines. Only the creature's name is cut, by the measured width, the warning and the recovery whole, at the note and wherever the title holds the sentence. The dead lines name the creature once in the strip, listed as new words, with the entry's whole sentence in `aria-describedby`. Cases with an 80-character name: the DM's heal line, a player's, the Set line, the combined dead line with exclusions and the shortest strip | 3.3, 8 (new words), 9.1 `restStatus`, 10, 11 (unit, br-c-2), B.4, R21 |
| BC-OPUS-26: F through `freeArea`, windows of 320 x 360 (F = 148.9) and 320 x 440 (F = 210), the 375 x 667 card figures restated (F = 237, band 115, reach 109), and B.3's checks and `rest-scrolls` run again there | 3.1, 5.1, 5.4, 10, 11 (br-f-10, br-c-3, `rest-scrolls`), B.3 |
| BC-OPUS-27: the request consumed by an effect keyed on it once the content is measured. An anchor change sets one only when its tap opens the bar. Openings told apart by the selection they make (`opensBar`), so `watchPans` needs no origin, TrackerPanel.tsx and PartyBar.tsx stay untouched, and no new file joins lane F. The outliner sets one. A follow-turn pan and a pane's pan set none, tested | 3.6, 9.1 `opensBar`, 9.2, 9.3, 10, 11 (unit, br-f-6, br-f-8), R24 |
| BC-OPUS-28: the crit named only for `crit && showCrit`, and a group's left-out creatures after the dead line. Cases for a kept crit then Heal, a crit once the target leaves 0 HP, and a group heal with dead and left-out creatures | 3.3, 9.1 `restStatus`, 10, 11 (unit, br-c-2), B.4 |
| BC-OPUS-30: a double chevron for "Scroll for more", not Collapse's chevron. Alerts reached by scrolling back up to the header, tested from the strip's foot | 3.5, 5.4, 9.2, 10, 11 (br-c-3), 12 (the icon) |
| BC-OPUS-32: `barCapacity` in the content lane, reading the held mode from `BarRoom`. `barShift`'s `dy` in the chrome's px, scaled by `uiScale()` into the canvas's px of the camera, viewport and insets | 3.6, 9.3, 9.4, 12, 11 (unit) |


Round 4, where each finding and the completion conditions its confer added are met. BAR-ASTRA-09 replaces round 3's `opensBar` rule for BC-OPUS-27:

| Round 4 finding, with its confer conditions | Where |
| --- | --- |
| BAR-ASTRA-09 with BC-OPUS-34: a clear request from an opening's own intent, never a selection diff. `ui.tap` (its `add` kept) and `showActions(true)` carry it, `ui.select` only where its caller passes it, in the preview's `RoomUi` too. It counts only where the bar ends up showing a new token, so `ui.select` with the bar off, `openStatBlock` hiding it and the tracker's Multi-select branch set none, and a hidden bar replays nothing. A switch to Select never cancels one. Every file it touches named with its lane. Cases: a remote deletion of a group's anchor with Multi-select off, a token leaving the scene, a placed token and a stat block with the bar off, a placed token and an attach holder link with the bar open, a companion's show, the outliner's show after a switch to Select, the tracker's Multi-select branch, and the preview. Companion shows do change the selection | 3.6, 9.1 `keepsOpening`, 9.3 (Stage, the room store), 9.4, 10, 11 (unit, br-f-6 to br-f-8), 12, R24 |
| BAR-ASTRA-10: the card's placement published as one field, its three places told apart, published and cleared by lane F, whose PlayerRolls region is today's 193 to 229. Standing, summoned onto the toolbar and summoned onto the screen tested in `openMode` | 2, 3.2, 9.1 (`openMode`, the dock store's `cardAt`), 9.3, 10, 11 (unit), 12 |
| BC-OPUS-33: `heldMode` cleared by a turn and a new interface size in 9.1 and 9.3, a `placeBar` case on its side, `barCapacity` on `openMode` while none is held, `openMode` in the contract. The first render with a card standing and a turn tested | 9.1, 9.3, 9.4, 10, 11 (unit, br-f-7), 12 |
| BC-OPUS-35: state/store.ts in lane F. A waiting toast's time starts once, as it first draws, by a `shownAt` the store sets then, so no error runs out unseen and the Room.tsx:1623 comment holds. The time left survives showing whole and shrinking back. Unit cases for an error behind an action toast, an arrival while one shows whole, and rerenders that never reset a timer | 3.5, 8, 9.3 (Room, the room store), 10, 11 (unit, br-f-11), 12 |
| The optional leading noun, only by a rule from the text alone | Not added: the first word whole gives nothing better (R18) |
