# raccoon-vtt v1: the docked token action bar

Status: design, draft 1. No code has changed yet.

The project owner asked on 2026-10-15: "when select several is being used, the pane used for damage, conditions, etc should be positioned so it does not overlap any creatures to make them easier to select. honestly i wonder if we should pin the pane to the bottom right or allow the user to move it independently rather than snapping to the last clicked token?" They then chose: on computers and tablets the bar docks at the bottom right of the map, drags by its header, remembers its spot on each device and has "Reset position", and Fit and Find keep tokens out from under it. The single-token bar works the same way as the several-tokens bar, so there is one place to look. Phones held upright keep what they have. Then: "also clicking off of the pane that appears should make it go away, just make sure it does not interfere dragging around to see the map on mobile".

The fight alerts column and the floating notices share the right side of the map, so this design also settles five live play findings: LPD-PLAYER-2 and LPD-DMPHONE-3 (the column covers the bar), LPD-DMPHONE-4 (the column's margin runs past the screen) and LPD-DMPHONE-9 and LPD-DESK-6 (a notice covers the column's first card).

Every size here is in layout pixels, the chrome's own (`features/device/layout.ts`), so the interface size changes them as it changes everything else.

## 1. Where the bar sits

### 1.1 Span or dock

`barMode(layout)` in a new `client/canvas/barDock.ts`:

- **Span**: a layout under 600 px wide and no wider than tall, which is a phone held upright. Unchanged: the bar spans the screen with `space(2)` margins, hangs under or over its token, and folds into the dock under a sheet (docs/design-v1-visual.md 3.2.1).
- **Dock**: everything else. Every landscape layout docks at any width, phones included, and so does a tablet held upright.

600 lies above every phone held upright at 100% (the widest is 440) and at or below every tablet (600 for the smallest Android tablets, 744 for an iPad mini). Landscape phones dock because they have the same problem, and LPD-PLAYER-2 happened there. The fold rule (`foldsUnderSheet`) does not change: a portrait layout under 900 px with a sheet open folds the bar, docked or spanning, and Show brings it back to its spot.

### 1.2 The free area and the default spot

A docked bar lives in the **free area**: the map area, which from 900 px up already ends at the side panel, less the measured top inset (top bar, turn band and safe area, Room's `insets.top`), the measured bottom inset (toolbar, the active tool's options such as "Select several", and safe area, `insets.bottom`), the side safe areas and a phone's landscape sheet, and an 8 px margin (`space(2)`) all round. Stage passes Room's `insets` to the bar, so `BOTTOM_RESERVE`, `reserveBottom` and `SELECT_OPTIONS_PX` go.

The default spot is the free area's bottom right corner. The bar is `min(304, free width)` wide, as tall as its content up to the room it has (the 120 px floor stays), and grows upward. "Scroll for more" stays. The header becomes `position: sticky` at the top of the scrolling frame, so the handle and Close never scroll away. The bar still hides during a token drag, so the whole map shows while a token moves.

### 1.3 The right lane: the column, the bar and the notices

The **lane** is the right 312 px of the free area: room for the 304 px bar (the column is 300) and an 8 px gap before the map. The alerts column hangs at its top, and the docked bar sits at its bottom by default.

- **Who gives way.** When the bar and the column overlap across (a docked bar in the lane, or any spanning bar), they share the lane's height. The column gives way first, scrolling, but keeps its first card whole. The bar then gives way, scrolling, down to its 120 px floor. `shareLane` works it out:
  - the column keeps at least `k = min(first card, lane height − 8 − 120)`,
  - the bar's top is `max(wanted top, column top + k + 8)`, where the wanted top comes from the bar's spot (for a spanning bar, its place under or over its token),
  - the bar's max height runs to the lane's bottom, and the column's max height stops 8 px above the bar.

  At 844 x 390 the free height is 262 px, so a first card up to 134 px stays whole over a 120 px bar.
- **No feedback loop.** The column publishes its content height and its first card's height, and the bar its drawn box, to a slot in the Room scope. The bar reads only the column's content heights and the column only the bar's box.
- **Notices** (offline, scene loading, whispers and other toasts, the DM's frame bar, and "Viewing as Pat"). When the free width less the lane is at least 320 px, the notice stack centers in the free area left of the lane, whether or not the column holds anything, so nothing moves when an alert arrives. Otherwise (a phone held upright, or a narrow map beside the side panel) the stack spans as today and the column's top moves 8 px below the stack's measured bottom. Either way no notice covers a card (LPD-DMPHONE-9, LPD-DESK-6). "Viewing as Pat" moves from the preview's dialog into the previewed Room's notice stack, which reads `PreviewContext`, so it follows the same rule. The preview's accent border stays where it is.
- **Inside the screen** (LPD-DMPHONE-4). Nothing in the lane reaches past the free area's right edge. The column's scroll box ends at the screen edge, or at a landscape sheet's left edge, and its right padding is the 8 px margin rather than the 20 px shadow room. A card scrolled into view then never scrolls the room frame.

## 2. Moving the bar

- **The handle** is the header row: the bar's full width, 48 px tall. A grip icon at its start shows that it moves (`aria-hidden`). A primary press on the header, outside its buttons, takes `setPointerCapture`. The header has `touch-action: none` and, for a mouse, the `grab` and `grabbing` cursors. The bar moves once the pointer passes `TAP_SLOP_PX` (8 px), so a tap on the header does nothing. Touch, pen and mouse take the same path.
- **Kept clear.** During the drag the box is clamped into the free area, so it never covers the top bar, the turn band, the toolbar, the options bar, the side panel or a landscape sheet. The lane rule keeps it under the column's first card.
- **Snapping.** On release, any edge within 24 px of the free area's edge snaps to it. Dropped near the bottom right corner, the bar is in its default spot again. There is no grid.
- **Escape or `pointercancel` during a drag** puts the bar back where the drag began and keeps it open. The handler calls `preventDefault`, so Room's Escape leaves the bar be.
- **Stored per device.** Release writes localStorage key `rvtt.tokenBarSpot`, read and written in try and catch as every `rvtt.*` key is, for example `{"corner":"tl","x":120,"y":40}`. `corner` is the free area's corner nearest the bar's center (`tl`, `tr`, `bl` or `br`). `x` and `y` are the gaps from that corner's two edges to the bar's matching corner, integers from 0 to 4096. Anything else reads as the default, and the default is stored as no key. One spot serves every room and both roles. A DM's "view as a player" reads it and keeps a drag to itself, since nothing done there is saved.
- **Changes of size.** The box is worked out again from the corner and gaps whenever the free area changes: a resize, a rotation, a new interface size, the turn band coming or going, the options bar wrapping, a landscape sheet opening or closing. The gaps are clamped so the bar stays inside, and the stored value is left alone, so the bar returns to its spot when the room comes back. A bar in a right corner follows the free area's right edge, past a landscape sheet and back. A free area narrower than the bar pins it to the left margin and narrows it, as today. The side panel from 900 px up never opens or closes: crossing 900 px is a resize.
- **Reset position.** A button with that name and text, last in the bar's button row (after Details or Clear), shown only while the bar is away from its default spot. It removes the key. Focus moves to the bar's frame (`tabIndex={-1}`), since the button it was on goes away.
- **No keyboard moving.** Moving the bar exists to uncover tokens for a pointer. A keyboard user picks tokens through the tracker and the outliner and moves them with the arrow keys, every control in the bar stays in the Tab order wherever it sits, and Reset position is a plain button. A pointer user who cannot drag presses Fit, which keeps the map clear of the bar (section 4).

## 3. A tap off closes it

There is no `emptyTap.ts`. Today a tap on empty map reaches `CameraGesture.up` (`lib/gestures.ts`), which reports `tapOnEmpty`, Stage calls `onSelect(null)`, and `tapToken(local, null)` lets go, except while selecting several.

- **Off** is whatever reaches the map canvas: empty map, the gaps between alert cards (the column passes taps through), and a map label or door drawn into the map. A tap there lets go and closes the bar. A label or door also opens as it does today.
- **A token** tap selects that token, and the bar shows it in the same spot.
- **Everything else** acts and leaves the selection alone: the bar itself, a sheet, the side panel, the toolbar and options bar, the top bar, an alert card, the phone's dock, a notice, and panes on the map such as a door card or a stop note. They are DOM above the canvas, so their taps never reach it.
- **Not a tap:** a move past 8 px (a pan or a box drag), a second finger (a pinch), a mouse pan with the right or middle button or Space, the wheel, and from now on a press held 500 ms or more. `CameraGesture` notes when the press began and reports `tapOnEmpty` only under `LONG_PRESS_MS`. Today a hold-to-ping lets go when the finger lifts. After this it only pings, and a hold on a door or label no longer opens it.
- **Select several.** A tap off lets go of the group and closes the bar too. The mode stays on, so the next tap starts a new group. This changes the one rule in `state/selection.ts` that keeps the group, which was there so a miss on a phone never dropped one (question 1).
- Phones keep everything else. The rules are the same on every device, and the portrait bar closes the same way.

## 4. Fit, Find and pans

While a docked bar shows, it publishes its drawn box to the Room scope. A folded, spanning or hidden bar publishes nothing: a spanning bar follows its token, so it would move with the camera it shaped. `barCover(viewport, bars, box)` turns the box into one inset, on the side that leaves the largest clear rectangle, so a bar in its default spot covers the right 312 px.

- **Fit the map** fits into the bars plus that cover, the larger on each side. The fit remembers the cover it used, so the bar opening or closing later never moves the fitted map, and a bar that grows still refits as today.
- **Find my token** and the outliner's show on map pass it to `findCamera` with the open sheet's cover, the larger on each side. The zoom ignores it, as it ignores the sheet, and the token lands centered in what is left.
- **Pans that bring a token into view** (a tracker row, the party bar, follow the turn) place their anchor in the area the cover leaves. A pan that opens the bar uses the bar's spot and the height it last had, since its box does not exist yet. Without this, a 900 px window, whose map is 540 px wide, centers the token under the bar.
- Panes anchored to a map point (door card, stop note, label, light and pin panes) keep their anchors and draw over the bar, later in the same layer, as today.

## 5. What stays

Nothing loses a function, name or role. Both bars keep `role="dialog"` and their names ("Thorn actions", "3 selected tokens"), their closes ("Close", "Let go of all of them"), the Conditions drawer, More and its focus return, the mixed states (`aria-pressed="mixed"` and the dashed edge), the HP entry and the group HP entry, the busy and refused states (Undo move waiting on the server, Doesn't count refusing a second press, the armed Delete), the `key={selected.id}` remount, and "Scroll for more". The frame's script focus stays: `tabIndex={-1}`, focused by the dock's Show and by a closing sheet, never by a plain tap, so no keyboard opens. Escape (`lib/escape.ts`) and Back (`useBackClose` under 900 px) close it as before. On phones the dock and the fold stay: `usePublishBar`, `useSheetReturnFocus` at `RETURN_RANK.tokenBar` (2), and `hidden` while folded with its state kept. The single and group bars share `BarFrame`, so both dock and move, and they share one spot.

## 6. Which token it acts on

- The header names it, as today: the token's whole name, or "3 selected" with the names under it.
- The token keeps its accent selection outline, and each token of a group keeps its own.
- The selected token's plate (its whole name on the map) shows again while the bar is docked. It steps aside today only because the bar showed the name right under it (`Stage.tsx` `plateIds`), and a spanning bar still does, so the plate still steps aside there.

So the name shows in the header and over the token, and the outline marks it. No line joins the bar to the token: it would cross the very tokens this change keeps clear.

## 7. Tests

Unit tests, `node:test`:

- New `client/canvas/barDock.test.ts`: `barMode` at 599 and 600 px, portrait and landscape, at 100% and 130%. The free area with the band, the options bar, safe areas and a landscape sheet. The stored spot: valid, missing, bad JSON, an unknown corner, a fraction, a negative, over 4096. The nearest corner on release, snapping within 24 px, the default stored as no key, clamping into a smaller area and back out. `shareLane`: no column, both fit, the column down to its first card, the bar down to 120, a lane too short for both, a moved bar pushed under the first card, no overlap across. `barCover` on each side and with no box. Notice placement at 319 and 320 px free beside the lane.
- `client/lib/camera.test.ts`, which tests `CameraGesture`: a press under 500 ms is a tap, one held 500 ms is not, a move past 8 px is not, a second finger is not.
- `client/state/selection.test.ts`: a tap on empty map while selecting several lets go. It replaces the test that keeps the group.
- `client/features/find/findToken.test.ts`: with a bar cover the zoom is unchanged and the token lands clear of the bar.

e2e, one file after another as docs/design-v1-visual.md 5.3 says:

- New `e2e/bardock.e2e.ts`, on E2E_PORT plus seven, which it shares with the phone files: 1280 x 800, 1024 x 768 and 820 x 1180, at 100% and 130%.
  1. The single and group bars dock in the same spot, clear of the side panel, the top bar and the toolbar, and a tap on a second token does not move it.
  2. A mouse drag and a touch drag by the header move it. A drag past every edge keeps it inside. A drag into the column puts it under the first card.
  3. A reload keeps the spot in `rvtt.tokenBarSpot`, and a resize and a new interface size keep it in its corner. Reset position brings it back, removes the key and focuses the frame. Escape during a drag puts it back and keeps it open.
  4. With the bar open, Fit leaves no token under it, and Find and the outliner land the token clear of it.
  5. In a fight with three concentration prompts and a roll card, the bar's and the column's boxes never intersect, Conditions drawer open or not.
  6. A click on empty map closes it, a click on another token switches it, and clicks on a side panel tab, a tool, Fit and an alert card leave it open. So do a right-button pan, the wheel and a 600 ms hold. With Select several on, a click on empty map lets go.
  7. "Viewing as Pat" does not intersect the column, and Later on the previewed roll card takes the click (LPD-DESK-6).
- `e2e/playerphone.e2e.ts`, 844 x 390 and 390 x 844: in landscape the bar docks at the bottom right, left of an open sheet. The roll card and the bar never intersect, in landscape and in portrait after Show (LPD-PLAYER-2). A one-finger pan, a pinch and a 600 ms hold leave the bar open. A quick tap on empty map closes it, a token tap switches it, and taps on the toolbar, the top bar and an alert card leave it.
- `e2e/dmphone.e2e.ts`: in landscape the bar and the alerts never intersect (LPD-DMPHONE-3). The column's box ends inside the window, and after its last card takes focus the room frame's `scrollLeft` and `scrollTop` stay 0 (LPD-DMPHONE-4). "Viewing as Pat" covers no card at 390 x 844 or 844 x 390 (LPD-DMPHONE-9).
- `e2e/fold.e2e.ts` gains one case at 820 x 1180: the bar docks, folds under a sheet, and Show brings it back to its stored spot with focus on its frame. Its phone cases run unchanged.
- `smoke`, `table`, `regress`, `tools`, `rolls` and `vision` run unchanged, since they find the bar by role and name.

## 8. FEATURES.md

- Line 46 becomes: "Tapping a token opens its action bar. On a computer, a tablet or a phone on its side, it sits at the bottom right of the map, clear of the tokens. Drag it by its header to put it elsewhere. This device remembers the spot, and "Reset position" puts it back. On a phone held upright it spans the screen under the token."
- After it: "A tap on empty map closes the action bar. Panning, pinching and holding a finger down to ping leave it open."
- Under "Several tokens at once", after line 111: "With Select several on, a tap on empty map lets go of the group."
- Line 354 gains: "While you drag the action bar, Escape puts it back."

## 9. Build plan

One part in one workspace:

- New `client/canvas/barDock.ts` and its test: `barMode`, the free area, the stored spot, snapping, `shareLane`, `barCover`, notice placement, and the Room scope slot for the bar's box and the column's heights.
- `client/canvas/TokenActionBar.tsx`: BarFrame docks, drags, stores and resets, publishes its box, applies the lane rule in both modes, and gets the sticky header and Reset position.
- `client/components/SheetHeader.tsx`: PaneHeader takes an optional handle (the grip and the pointer handlers on its row).
- `client/canvas/Stage.tsx`: passes the insets, drops `SELECT_OPTIONS_PX`, the plate rule, Fit and show with the cover, the fit that remembers it, and pan anchors in the free area.
- `client/canvas/fitSlot.ts`: `show` hands over the cover.
- `client/lib/gestures.ts`, with `client/lib/camera.test.ts`: the press's duration.
- `client/state/selection.ts` and its test: the empty tap while selecting several.
- `client/features/encounter/InitiativeStrip.tsx`: the column's top, max height and right padding from the lane and notice rules, and its published heights.
- `client/pages/Room.tsx`: the notice stack's placement and measured bottom, and the preview's notice inside it.
- `client/features/dm/PlayerPreview.tsx`: its notice moves into Room.
- `client/features/find/findToken.ts` and its test, `client/pages/RoomChrome.tsx` and `client/features/outliner/focus.ts`: the cover in Find.
- `client/features/select/SelectOptions.tsx`: its comment about `SELECT_OPTIONS_PX`.
- The e2e files in section 7, FEATURES.md as in section 8, and the token bar row of docs/design-v1-visual.md 3.2, which points here.

## 10. Questions for the project owner

1. With Select several on, should a tap on empty map let go of the group? Recommended default: yes, and the mode stays on. That is what "clicking off ... should make it go away" asks, and the docked bar no longer hides the tokens a phone user aims at. The other choice keeps the group and hides only the bar, which then needs a "Show actions" button in the Select several bar to come back without changing the group.
