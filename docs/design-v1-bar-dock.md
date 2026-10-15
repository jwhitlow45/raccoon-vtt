# raccoon-vtt v1: the docked token action bar

Status: design, draft 2, after design review round 1 and the project owner's decisions of 2026-10-15. No code has changed yet. The build waits for the height readout build (its workspace `openvtt-heights`, not on main yet). Section 3 builds on that build's hold signal and on its `client/canvas/emptyTap.ts`.

The project owner asked on 2026-10-15: "when select several is being used, the pane used for damage, conditions, etc should be positioned so it does not overlap any creatures to make them easier to select." They chose: on large screens the bar docks at the bottom right of the map, drags by its header, remembers its spot on each device and can be put back, and Fit and Find keep tokens out from under it. The single-token bar works the same way as the several-tokens bar, so there is one place to look. Phones held upright keep what they have. Then: "also clicking off of the pane that appears should make it go away, just make sure it does not interfere dragging around to see the map on mobile". After round 1 they settled Select several: "tapping off makes the pane itself go away, but does not deselect the group", and "i would also like tapping a selected token in a group to deselect it".

The fight alerts column and the floating notices share the right side of the map, so this design also settles five live play findings: LPD-PLAYER-2 and LPD-DMPHONE-3 (the column covers the bar), LPD-DMPHONE-4 (the column's margin runs past the screen), and LPD-DMPHONE-9 and LPD-DESK-6 (a notice covers the column's first card).

Every size is in layout pixels, the chrome's own (`features/device/layout.ts`), so the interface size changes them as it changes everything else.

## 1. Where the bar sits

### 1.1 Span or dock

`barMode` in a new `client/canvas/barDock.ts` gives one of three:

- **Upright span**: a layout under 600 px wide and no wider than tall. Unchanged: the bar spans the screen with `space(2)` margins, hangs under or over its token, and folds into the dock under a sheet (docs/design-v1-visual.md 3.2.1).
- **Short span**: a free area (1.2) under 120 px tall, the bar's floor. Examples: 480 x 320 at 130% (118 px), or 844 x 390 at 130% with Select several on (112 px, or 91 with a 21 px home bar inset). The bar spans the free area's width at its bottom, takes all of its height, and scrolls. While the column has cards, the bar stops at the lane's left edge (1.3) if that leaves it 304 px, so both show, as at 844 x 390 at 130%. Under a sheet it does what the bar does today: it folds under a portrait sheet and stops at a landscape sheet's left edge.
- **Dock**: everything else, so every layout 600 px or wider and every phone held sideways (the project owner's choice, since LPD-PLAYER-2 happened there), except the short case.

600 lies above every phone held upright at 100% (the widest is 440) and at or below most tablets at 100% (600 for the smallest Android tablets, 744 for an iPad mini). A larger interface size can bring an upright tablet under it (an iPad at 768 px and 130% lays out at 591), and then it spans as a phone does. The fold rule (`foldsUnderSheet`) does not change.

### 1.2 The free area and the default spot

A docked bar lives in the **free area**. That is the map area (which from 900 px up already ends at the side panel), less the measured top inset (top bar, turn band and safe area, Room's `insets.top`), the measured bottom inset (toolbar, the active tool's options such as the Select several bar, and safe area, `insets.bottom`), the side safe areas and a phone's landscape sheet, and an 8 px margin (`space(2)`) all round. Stage passes Room's `insets` to the bar, so `BOTTOM_RESERVE`, `reserveBottom` and `SELECT_OPTIONS_PX` go.

The default spot is the free area's bottom right corner. The bar is `min(304, free width)` wide and grows upward. It is as tall as its content up to the room it has, with a floor of `min(120, free height)`. "Scroll for more" stays. The header is `position: sticky` at the top of the scrolling frame in every mode, so the handle and Close never scroll away. It has an opaque `surface` background that reaches across the frame's 12 px side padding, and it clips the name to two lines. The bar still hides during a token drag, so the whole map shows while a token moves.

### 1.3 The right lane: the column, the bar and the notices

The **lane** is the right 312 px of the free area: room for the 304 px bar (the column is 300) and an 8 px gap before the map. The alerts column hangs at its top. The docked bar sits at its bottom by default.

- **Who gives way.** When the bar and a column with cards overlap across (a bar in the lane, or any spanning bar), they share the lane's height. The column gives way first, scrolling, but keeps its first card whole. Then the bar gives way, scrolling, down to its floor. `shareLane` works it out, with the floor `f = min(120, free height)`:
  - the column keeps at least `k = max(0, min(first card, lane height − 8 − f))`,
  - the bar's top is `max(wanted top, column top + k + 8)`, where the wanted top comes from the bar's spot (for an upright span, its place under or over its token),
  - the bar's max height runs to the lane's bottom, and the column's max height stops 8 px above the bar.

  At 844 x 390 with a 21 px home bar inset the free height is 241 px, so a first card up to 113 px stays whole over a 120 px bar. Where `k` is 0, the column shows nothing while the bar is open. Its cards come back when the bar closes, and meanwhile Room's status region (`FoldStatus`) speaks each alert that arrives, as it does for a folded column.
- **A clipped column says so.** While the column is cut short, it shows the bar's sticky `aria-hidden` "Scroll for more" fade at its foot.
- **Measuring.** The column publishes its content height and its first card's height to a slot in the Room scope. The first card is the first child with a box, looking inside the rolls' `display: contents` wrapper (`InitiativeStrip.tsx:455`). The bar publishes its drawn box. The bar reads only the column's content heights and the column only the bar's box, so neither feeds back on itself.
- **Applied on release.** During a drag the bar follows the finger, clamped only to the free area, and may pass under the column (z 15 over 5). The lane rule moves it on release, and after "Move bar".
- **Notices.** The lasting ones are the offline banner (`Banner`), a map layer that did not load (`QuietLoadNotice`), the DM's frame bar (`FrameViewBar`) and "Viewing as Pat". Toasts (whispers, refusals) last 5 s. When the free width less the lane is at least 320 px, the whole notice stack, toasts included, centers in the free area left of the lane, column or not, so nothing moves when an alert arrives. Otherwise the stack spans as today, and the column's top moves 8 px below the last lasting notice. Toasts keep today's place there, so a card never jumps under a finger for a toast (the project owner's choice). The scene loading notice sits centered under the top bar's layer (z 5 under 15), so it never covers the column.
- **Viewing as Pat** stays in PlayerPreview, outside the previewed Room, with its Exit and its `flash` state, so a blackout and the ended screen keep Exit. Through `PreviewContext`, PlayerPreview passes in the notice's measured height, and Room reports back the box the notice takes by the rule above, in window pixels. Beside the lane it centers left of it. On a narrow screen it spans as today, and Room's own notices and the column start below it (today Room's notices sit under it). While Room reports nothing (a blackout, the ended screen, the first frame), it sits where it does today.
- **Inside the screen** (LPD-DMPHONE-4). Nothing in the lane reaches past the free area's right edge. The column's scroll box ends at the screen edge, or at a landscape sheet's left edge, and its right padding is the 8 px margin rather than the 20 px shadow room. A card scrolled into view then never scrolls the room frame.

## 2. Moving the bar

- **The handle** is the header row. A grip icon at its start shows that it moves (`aria-hidden`). A primary press on the header, outside its buttons, takes `setPointerCapture`. The header has `touch-action: none` and, for a mouse, the `grab` and `grabbing` cursors. The bar moves once the pointer passes `TAP_SLOP_PX` (8 px), so a tap on the header does nothing. Touch, pen and mouse take the same path.
- **Kept clear.** During the drag the box is clamped into the free area, so it never covers the top bar, the turn band, the toolbar, the options bar, the side panel or a landscape sheet. On release the lane rule applies.
- **Snapping.** On release, any edge within 24 px of the free area's edge snaps to it. Dropped near the bottom right corner, the bar is in its default spot again. There is no grid.
- **Escape or `pointercancel` during a drag** puts the bar back where the drag began and keeps it open. A press on the header focuses the frame, so a listener on the header would never see the key. Instead a capture-phase keydown listener on window, added when the drag starts and removed when it ends, takes Escape and calls `preventDefault`. Room's `useEscape`, a bubble listener that skips handled keys, then leaves the bar alone.
- **Stored per device.** Release writes localStorage key `rvtt.tokenBarSpot`, read and written in try and catch as every `rvtt.*` key is, for example `{"corner":"tl","x":120,"y":40}`. `corner` is the free area's corner nearest the bar's center (`tl`, `tr`, `bl` or `br`). `x` and `y` are the gaps from that corner's two edges to the bar's matching corner, integers from 0 to 4096. Anything else reads as the default, and the default is stored as no key. One spot serves every room and both roles. A DM's "view as a player" reads it and keeps a drag to itself, since nothing done there is saved.
- **Changes of size.** The box is worked out again from the corner and gaps whenever the free area changes: a resize, a rotation, a new interface size, the turn band coming or going, the options bar wrapping, a landscape sheet opening or closing. The gaps are clamped to keep the bar inside, and the stored value is left alone, so the bar returns to its spot when the room comes back. A bar in a right corner follows the free area's right edge, past a landscape sheet and back. The side panel from 900 px up never opens or closes: crossing 900 px is a resize.
- **Move bar.** A button whose name is its text, "Move bar", in the bar's button row while it docks. Each press sends the bar to the next corner of the free area, clockwise from the bottom right, flush with it, and stores it. It is the single-pointer and keyboard way to move the bar (WCAG 2.2 SC 2.5.7), and focus stays on it.
- **Reset bar position.** A button whose name is its text, after Move bar, shown only while the bar is away from its default spot. It removes the key. Focus moves to Move bar, since this button goes away.
- There is no arrow-key moving, since the arrow keys nudge the selected tokens.

## 3. Taps off the bar

In the height readout build, a tap on empty map reaches `CameraGesture.up` (`lib/gestures.ts`), which reports `tapOnEmpty` and `held`, and Stage runs `emptyTap(ctx, tool, world, held, deselect)`. With Select several on, a press on empty map is a box gesture instead. Stage passes `onEmpty = false` (`Stage.tsx:655-658` on main), so `tapOnEmpty` never fires, and the box's release (`:744-752`) acts only past `TAP_SLOP_PX`.

- **One token selected**, or a Shift group with Select several off: a tap on empty map lets go and closes the bar, as today, and `emptyTap` goes on to a label, a door or the height readout.
- **Select several on**: a tap off hides the bar and keeps the group, its outlines and the mode. Stage's box release counts a box as that tap when it moved no more than `TAP_SLOP_PX`, was not cancelled or held, and was not made with Shift. It calls `onSelect(null)`, and `tapToken(local, null)` while selecting several now hides the bar (`showActions(false)`) instead of doing nothing. A box tap opens no door or label, as today. A real box drag keeps adding to the group.
- **A token tap** with one token selected selects that token, and the bar shows it in the same spot. With Select several on, a tap toggles, as today: a token outside the group joins it and shows the bar again, and a token in it leaves the group without reopening a hidden bar (today any toggle reopens it). Taking out the last token empties the selection and closes the bar, and the mode stays on. A box drag that adds tokens shows the bar again too.
- **Actions.** A button whose name is its text, in the Select several bar, shown while the group has tokens and its bar is hidden. It shows the bar (`showActions(true)`) and focuses the bar's frame.
- **Done** in the Select several bar turns the mode off and lets go of the group, closing its bar, as the project owner described it. Today it only turns the mode off and keeps the group and its bar (`setMultiSelect` in `state/selection.ts`, whose test says "Turning the mode off keeps the group, ready to move"). That test changes. The bar's own "Select several" toggle keeps today's behavior, for someone who wants to leave the mode and still act on the group.
- **Escape and Back** do what the bar's close does, in both modes, as today: they let go.
- **Off** is whatever reaches the map canvas: empty map, the gaps between alert cards (the column passes taps through), and a map label or door drawn into the map. Everything else acts and leaves the selection alone: the bar, a sheet, the side panel, the toolbar and the Select several bar, the top bar, an alert card, the phone's dock, a notice, and panes on the map such as a door card or a stop note. These are DOM above the canvas, so their taps never reach it.
- **Not a tap:** a move past 8 px (a pan or a box drag), a second finger (a pinch), a mouse pan with the right or middle button or Space, the wheel, and a press the hold-to-ping fired for. "Held" is the readout build's signal, not a second clock: the ping layer reports each press it pinged (`features/pings/hold.ts`), `CameraGesture.hold(id)` marks it, and `up` reports `held`. This design changes two things in that build. `up` reports `held` for any still one-finger press, not only one on empty map, so the box path can read it. `emptyTap` returns before `deselect` for a held press, so a ping neither deselects, hides the bar nor opens anything (the readout design lets a held press deselect).
- The rules are the same on every device. Outside Select several a phone behaves as today, except that a hold to ping no longer lets go.

## 4. Fit, Find and pans

While a docked bar shows, it publishes its drawn box to the Room scope. A folded, spanning or hidden bar publishes nothing: a spanning bar is placed by its token or the screen's bottom, not by the map. `barCover(viewport, bars, box)` turns the box into one inset. A bar in the lane covers the lane's side, the right 312 px plus the margin and safe area, whatever its height. A bar elsewhere covers the side that leaves the largest clear rectangle.

- **Fit the map** fits into the bars plus that cover, the larger on each side. The fit remembers the cover it used, so the bar opening or closing later never moves the fitted map, and a bar that grows still refits as today.
- **Find my token** and the outliner's show on map pass it to `findCamera` with the open sheet's cover, the larger on each side. The zoom ignores it, as it ignores the sheet, and the token lands centered in what is left.
- **Pans that bring a token into view** (a tracker row, the party bar, follow the turn) place their anchor in the area the cover leaves. A pan that opens the bar uses the bar's spot and the height it last had, since its box does not exist yet. Without this, a 900 px window, whose map is 540 px wide, centers the token under the bar.
- Panes anchored to a map point (door card, stop note, label, light and pin panes) keep their anchors and draw over the bar, later in the same layer, as today.

## 5. What stays

Nothing loses a function, name or role. Both bars keep `role="dialog"` and their names ("Thorn actions", "3 selected tokens"), their closes ("Close", "Let go of all of them"), the Conditions drawer, More and its focus return, the mixed states (`aria-pressed="mixed"` and the dashed edge), the HP entry and the group HP entry, the busy and refused states (Undo move waiting on the server, Doesn't count refusing a second press, the armed Delete), the bar's own "Select several" toggle, the `key={selected.id}` remount, and "Scroll for more". The frame's script focus stays: `tabIndex={-1}`, focused by the dock's Show, by a closing sheet and now by Actions, never by a plain tap, so no keyboard opens. On phones the dock and the fold stay: `usePublishBar`, `useSheetReturnFocus` at `RETURN_RANK.tokenBar` (2), and `hidden` while folded with its state kept. The single and group bars share `BarFrame`, so both dock and move, and they share one spot.

## 6. Which token it acts on

- The header names it: the token's whole name, clipped to two lines, or "3 selected" with the names under it. The frame's name always holds the whole name.
- The token keeps its accent selection outline, and each token of a group keeps its own.
- The selected token's plate (its whole name on the map) now shows in every mode. It stepped aside only because the bar's header showed the whole name (`Stage.tsx:367-368`), which a long name no longer gets. Under an upright span, `belowLabel` already hangs the bar below a plate.

No line joins the bar to its token: it would cross the very tokens this change keeps clear.

## 7. Tests

Unit tests, `node:test`:

- New `client/canvas/barDock.test.ts`:
  - `barMode`: 599 and 600 px, portrait and landscape, 100% and 130%, and free heights of 119 and 120 px.
  - The free area with the band, the options bar, safe areas and a landscape sheet.
  - The stored spot: valid, missing, bad JSON, an unknown corner, a fraction, a negative, over 4096. Also the nearest corner on release, snapping within 24 px, the default stored as no key, clamping into a smaller area and back out, and Move bar's cycle.
  - `shareLane`: no column, both fit, the column down to its first card, the bar down to its floor, a lane shorter than the floor (`f` is the free height, `k` is 0), a short span beside the lane at exactly 304 px and stacked below that, and a dropped bar pushed under the first card. With no overlap across, nothing changes.
  - `barCover`: a bar in the lane covers the right at 120, 300 and 600 px tall. A bar elsewhere covers each side in turn. No box covers nothing.
  - Notices: placement at 319 and 320 px beside the lane, and the column's top below lasting notices only.
- `client/lib/camera.test.ts`: a still box-mode press the ping reported is held. A pan or a pinch holds nothing.
- `client/features/builder/heights/tap.test.ts` (the readout build's `emptyTap` tests): a held press calls neither `deselect` nor any step. It counted one deselect before.
- `client/state/selection.test.ts`: the Select several test changes. A tap on empty map hides the bar and keeps the group. A removal leaves a hidden bar hidden, and an addition shows it. Removing the last token empties the selection and closes the bar. Done turns the mode off and empties the selection, and the bar's own toggle still keeps the group.
- `client/features/find/findToken.test.ts`: with a bar cover the zoom is unchanged and the token lands clear of the bar.

e2e, one file after another as docs/design-v1-visual.md 5.3 says:

- New `e2e/bardock.e2e.ts`, on E2E_PORT plus seven, which it shares with the phone files. Sizes are 1280 x 800, 1024 x 768 and 820 x 1180, at 100% and 130%.
  1. The single and group bars dock in the same spot, clear of the side panel, the top bar and the toolbar, and a tap on a second token does not move it.
  2. A mouse drag and a touch drag by the header move it. A header tap under 8 px neither moves nor closes it. A drag past every edge keeps it inside. A drop on the column moves it under the first card.
  3. A reload keeps the spot in `rvtt.tokenBarSpot`, and a resize and a new interface size keep it in its corner. Move bar visits all four corners and stores each. Reset bar position is absent at the default spot, brings the bar back, removes the key, and leaves focus on Move bar. Both buttons' names equal their text. Escape during a drag puts the bar back and keeps it open.
  4. With the bar open, Fit leaves no token under it, and Find and the outliner land the token clear of it.
  5. In a fight with three concentration prompts and a roll card, the bar's and the column's boxes never intersect, and with Conditions open the clipped column shows "Scroll for more".
  6. One token: a click on empty map closes the bar, and a click on another token switches it. Clicks on a side panel tab, a tool, Fit and an alert card leave it open. So do a right-button pan, the wheel, and a press held until it pings, which keeps the token selected.
  7. Select several: a click on empty map hides the bar and keeps every outline. Actions brings the bar back and focuses its frame. A click on a token in the group takes it out and leaves the hidden bar hidden. A click on another token adds it and shows the bar. With the mode off, Shift with a click on empty map changes nothing. Done ends the mode, every outline goes and the bar closes.
  8. "Viewing as Pat" does not intersect the column, and Later on the previewed roll card takes the click (LPD-DESK-6). In a blackout the preview still shows Exit, and a click on it leaves the preview.
- `e2e/playerphone.e2e.ts`, at 844 x 390, 390 x 844, and 844 x 390 at 130%:
  - In landscape the bar docks at the bottom right, left of an open sheet. The roll card and the bar never intersect, in landscape and in portrait after Show (LPD-PLAYER-2).
  - A one-finger pan, a pinch and a press held until it pings leave the bar open. A quick tap on empty map closes it, a token tap switches it, and taps on the toolbar, the top bar and an alert card leave it.
  - Select several by touch: a tap that moves less than 8 px hides the bar and keeps the group, and a real box drag adds and does not hide it.
  - At 130% with Select several on, the bar spans the bottom, beside the lane while a card shows. Every button in the bar, the column and the Select several bar lies inside the window and takes a tap.
- `e2e/dmphone.e2e.ts`, at 844 x 390 at 100% and 130%, and 390 x 844:
  - In landscape the bar and the alerts never intersect (LPD-DMPHONE-3).
  - The column's box ends inside the window, and after its last card takes focus the room frame's `scrollLeft` and `scrollTop` stay 0 (LPD-DMPHONE-4).
  - "Viewing as Pat" covers no card, and at 390 x 844 a toast does not move the column (LPD-DMPHONE-9).
- `e2e/fold.e2e.ts` gains one case at 820 x 1180: the bar docks, folds under a sheet, and Show brings it back to its stored spot with focus on its frame. Its phone cases run unchanged.
- `smoke`, `table`, `regress`, `tools`, `rolls` and `vision` run unchanged, since they find the bar by role and name.

## 8. FEATURES.md

- The line that says "Tapping a token opens a small action bar under it" becomes: "Tapping a token opens its action bar. On a screen 600 px or wider, or a phone on its side, it sits at the bottom right of the map instead of under the token. Drag it by its header, or press "Move bar" to send it to the next corner. This device remembers the spot, and "Reset bar position" puts it back. "Fit the map" keeps the map out from under it. On a phone held upright it spans the screen under the token, and on a screen too short for it, across the bottom."
- After it: "A tap on empty map closes the action bar. Panning, pinching and holding a finger down to ping leave it open."
- Under "Several tokens at once": "With Select several on, a tap on empty map hides the group's action bar and keeps the group, and "Actions" in the Select several bar brings it back. A tap on a token in the group takes it out." Then: "Done ends Select several and lets go of the group."
- The mouse line that ends "Escape closes a sheet or the token's action bar" gains: "While you drag the action bar, Escape puts it back."

## 9. Build plan

One part in one workspace, built once the height readout build has merged:

- New `client/canvas/barDock.ts` and its test: `barMode`, the free area, the stored spot, snapping, Move bar's cycle, `shareLane`, `barCover`, notice placement, and the Room scope slot for the bar's box and the column's heights.
- `client/canvas/TokenActionBar.tsx`: BarFrame docks, drags, stores, moves and resets, publishes its box, and applies the lane rule in all three modes. Its stale comments go: `:58-65` (`TOP_GAP`, `BOTTOM_RESERVE`), `:154` (the plate steps aside) and `:445-467` (BarFrame).
- `client/components/SheetHeader.tsx`: PaneHeader takes an optional handle (the grip and the pointer handlers on its row), the sticky opaque style and the two-line name.
- `client/canvas/Stage.tsx`: passes the insets, drops `SELECT_OPTIONS_PX`, the plate rule (`:367-368`, `:967`), the box tap off (reading `held` from `gesture.up` before the box branch), Fit and show with the cover, the fit that remembers it, and pan anchors in the free area.
- `client/canvas/fitSlot.ts`: `show` hands over the cover.
- `client/lib/gestures.ts` with `client/lib/camera.test.ts`, and `client/canvas/emptyTap.ts` with `heights/tap.test.ts`: the two `held` changes.
- `client/state/selection.ts` and its test: the empty tap and the toggle while selecting several.
- `client/features/select/SelectOptions.tsx`: Actions, Done letting go of the group, and its comment on `SELECT_OPTIONS_PX`.
- `client/features/encounter/InitiativeStrip.tsx`: the column's top, max height, right padding and clipped hint, and its published heights.
- `client/pages/Room.tsx` and `client/pages/RoomDock.tsx`: the notice stack's placement and its lasting notices' measured bottom, the report to PlayerPreview, and `FoldStatus` while the column shows nothing.
- `client/features/dm/PlayerPreview.tsx` and `client/features/dm/previewContext.ts`: the notice placed from Room's report. Their stale comments `:16-27` and `:35-36` go.
- `client/features/find/findToken.ts` and its test, `client/pages/RoomChrome.tsx` and `client/features/outliner/focus.ts`: the cover in Find.
- The e2e files in section 7, FEATURES.md as in section 8, and the token bar row of docs/design-v1-visual.md 3.2, which points here.

## 10. Questions for the project owner

None. What Done does was settled by the project owner's description of it (section 3).
