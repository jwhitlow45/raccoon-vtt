# raccoon-vtt v1: the token window, resizable, with fewer buttons, and a creature's size on the fly

Status: draft 3, with the project owner's answers of 2026-10-16 to design review round 1 and the fixes of rounds 1 and 2 (section 20 lists them). Code is cited from public main at `e4ec8696`. This design changes the docked token action bar of docs/design-v1-bar-dock.md, the bar's rows of docs/design-v1-token-panel.md 3.3, and how a token's size changes. Section 9 says, rule by rule, what of docs/design-v1-bar-dock.md and docs/design-v1-layout-hierarchy.md changes and what holds. Two designs built beside this one meet it: docs/design-v1-tool-options.md (tool options in one row) and docs/design-v1-companion-stat-blocks.md (companions' stat blocks). Section 12 lists where.

2026-10-17: wave 7 puts Roll in the single bar's play row after Multi-select, for the DM and the token's owners, in place of Request a roll (docs/design-v1-roll-options.md section 8, on the dice of docs/design-v1-dice.md). Where sections 1, 3.2, 15 and 17 say "then Request a roll and Light", the row now reads "then Roll and Light". The fit rules are unchanged.

The project owner's requests, 2026-10-16:

> "in the floating token window, move bar and select several can be "multi-select" so that it stays inline with conditions/hidden. move bar/reset position buttons can be removed. the floating token window should also be resizable on desktop with scroll to make it easy to shrink if needed. the resized size should be the size assigned to all future token windows when opened by default"
>
> "if we were to keep a way to reset the floating token window it should be in the header to the left of the close (X) button"
>
> "we also need support for changing the size of a creature on the fly. this should be in stats, as well as in the floating token window (make sure to position it well rather than just adding a new row without any thought as to where it is)"

The project owner's decisions the same day: "Grow away from walls" (a player's resize is checked like a move, the DM's never), and after round 1: the grip only drags and the resize handle only resizes, a tap on either does nothing, keys still move and resize, and Reset is the way back. A shrink puts a creature back on the square it grew from while it has not moved since. Undo move, Doesn't count and the door get a line of their own, so Conditions, Hidden and Multi-select are always one stable line.

**Terms.** "The token window" is the token action bar where it docks: a layout 600 px or wider, or one wider than tall, whose free area is at least 148 px tall (docs/design-v1-bar-dock.md 1.1). It is drawn by `BarFrame` (`client/canvas/TokenActionBar.tsx:647-885`) for the single token's bar and the group's bar alike, and placed by `client/canvas/barDock.ts`. "A computer" is a Room page whose device's main pointer is fine (`(pointer: fine)`), read once when the page mounts, as `touchFirst` is (`pages/Room.tsx:230`). "Resizable" means the window docks on a computer. "Blocks moves" means the scene's walls stop players' moves (`scene.blockMovement`). Every size is in layout px, the chrome's own (`features/device/layout.ts`), as in the designs above. FEATURES.md keeps calling the thing "the action bar". Its three window controls say "window", the project owner's word for it docked, and the shortcut sheet names dialogs "Dialogs" and this window's section "Token window" (section 11).

## 1. Summary

- **Multi-select.** "Select several" is "Multi-select" wherever the mode is named. The first button row splits: Undo move, Doesn't count and the door lead on a line of their own while they show, and the next line starts with Conditions, Hidden and Multi-select, then Request a roll and Light. The docked window's default width is the narrowest that holds those three on one line, measured from three hidden buttons in the page, never under 304: 316 px with the system font on macOS. A computer's window never gets narrower, so the three always share a line there.
- **Move bar and Reset bar position leave the rows.** The header moves the window as today. Its grip becomes a focusable control, "Move window": it drags, a tap on it does nothing, and while it has focus the arrow keys move the window, Shift by more. The project owner's reset is an icon button in the header, left of Close, "Reset window position and size", shown only while the window is away from its default spot or size. It is the single-pointer way back.
- **Resizable on a computer.** A round handle at the corner opposite the window's corner, and the two edges that meet there, resize it. A tap on the handle does nothing. The width is exact. The height is a cap: the window is as tall as its content up to that height, and scrolls inside past it, its header kept at the top. The handle, "Resize window", takes the arrow keys. Every limit keeps the whole handle on the map. Phones and touch screens keep today's sizes and get no handle.
- **Remembered on this device.** A new key, `rvtt.tokenBarSize`, beside `rvtt.tokenBarSpot`. Every token window this device opens takes it. Where the room is smaller, the window shrinks for that opening and the stored size stays.
- **Narrow windows.** Beside a phone's sideways sheet a docked window can be narrower than its header's row. Its header keeps one row: the elevation badge moves under the name, then a touch device's grip is drawn as its dots, and under that the window folds into the sheet's header.
- **Apply stays in view.** A window under 300 px tall takes the token panel design's short layout, so the HP field and Apply show at the smallest height. The group window's HP entry follows the same rule.
- **A creature's size on the fly.** The DM and the token's owners change it: a Size stepper in the token window, after Conditions, Hidden and Multi-select and before the less-used buttons, and a Size field in the token panel's Stats, which also has "Back to Medium" where the creature's own size is known. The footprint keeps its middle, and a shrink on the same device puts the creature back on the square it grew from while it has not moved since. On a scene that blocks moves, every owner's resize is checked like a move: its middle never crosses a wall, and a growth covers every square the creature filled and ends only where a move could end, the least distance from where it stood, or is refused with "No room to grow here". The DM's never are. A resize goes on its maker's undo stack and counts no movement.
- No new op. The op version goes to 6, since a resize's path changes how a stored size and place update replays, and a path stop gains one optional field. One new localStorage key. One new permission rule and one new pure rule (`shared/rules/resize.ts`).

## 2. Today

- **The rows.** `barButtons` (`client/canvas/barButtons.ts:54-74`) gives the play row Undo move, Doesn't count, the door, Conditions, Request a roll, Hidden, Light and "Select several", and the less-often row Locked, Duplicate, Delete or Dismiss, then Move bar and Reset bar position while the bar docks. The group bar has one row ending in "Select several", Clear and the same two (`TokenActionBar.tsx:468-508`, `PlaceButtons` at `:589-614`). The tracker's "Several at once" section turns the same mode on with a switch named "Select several" (`panels/TrackerPanel.tsx:469`).
- **Widths.** The docked bar is `BAR_WIDTH`, 304 px (`barDock.ts:20`), 278 inside its 12 px padding and 1 px borders. Measured on the dev fixture room at 1280 x 800: Conditions 99 px, Hidden 74, Light 60, "Select several" 121, Request a roll 118, with 4 px gaps. A DM's goblin shows Conditions and Hidden on the first line and "Select several" alone on the second, or Conditions, Hidden and Light and then "Select several" alone. "Multi-select" is 107 px, and Conditions, Hidden and Multi-select need 288: still 10 px over. Renaming alone does not keep it inline. By text width at the buttons' 600 weight and 14 px, the three need 284 (Arial) to 294 (Tahoma) and 317 (Verdana).
- **Moving.** The header row is the handle (`PaneHeader`, `components/SheetHeader.tsx:229-283`), with a 12 px grip that is decoration (`Grip`, `:286-293`). A press outside its buttons takes pointer capture and moves past 8 px, and a shorter press does nothing. Move bar cycles the corners and says where (`nextCorner`, `barDock.ts:249-259`). Reset bar position removes the key and focuses Move bar (`TokenActionBar.tsx:823-828`). The arrow keys never move the bar: they nudge the selected tokens (bar dock section 2).
- **Size of the bar.** It is `min(304, free width)` wide and as tall as its content up to its room (`spotHang`, `barDock.ts:217-225`, and `shareLane`). Nothing resizes it. The frame itself scrolls (`overflowY: auto`, `TokenActionBar.tsx:842-864`), and its header sticks inside it. A DM's goblin is 548 px of content at 1280 x 800, and a DM's player character with a roll to ask is 596.
- **The short layout.** `barShort` (`barButtons.ts:127-132`) makes a bar short when its capacity, the most it may draw where it stands, is under 300 px: the vitals keep to AC and HP, the HP field and Apply come first, and "More stats" holds the rest. Apply then ends 131 px below the bar's top (measured at 844 x 390), against 200 in the full layout. The group bar's HP entry always puts its modes first (`GroupHpEntry.tsx:29`).
- **A token change** remounts the bar (`key={selected.id}`, `canvas/Stage.tsx:1148`), so it opens scrolled to its top.
- **Narrow docked bars.** Beside a phone's sideways sheet the free area can be narrow: at 480 x 320 at 100% with 47 px side and 21 px bottom insets the sheet takes 288 px (60%) and the bar docks 129 px wide (`freeArea`, `barDock.ts:99-105`). Its header today holds only the name and Close.
- **A creature's size.** `Token.size` is Tiny to Gargantuan or Custom with `w` and `h` (`shared/model.ts:509-519,555-558`). The DM sets it in the token panel's Token settings (`panels/TokenPanel.tsx:324-338`) and for a group in More (`features/tokens/GroupMoreSheet.tsx:77-82`, one `token.updateMany`). It is not an owner field (`OWNER_TOKEN_FIELDS`, `shared/permissions.ts:60`, mirrored in `features/tokens/access.ts:17`), nor on a companion (`COMPANION_OWNER_FIELDS`, `:920`). A size change keeps the stored top-left corner, so a Medium creature grown to Huge spreads right and down. The reducer clears a squeeze on a size change (`SQUEEZE_FIELDS`, `shared/reducer/tokens.ts:251-252`), and on the acting creature's turn records a counted path stop wherever `x` or `y` change (`withPath`, `:312-331`), so a stored `token.update` with a size and a place records a counted leg on replay. A leg's feet come from the change in its two stops' top-left corners (`movedFeet`, `client/features/measure/movement.ts:44-50`), while the trail draws each stop with the token's size now (`turnTrail`, `:95-118`). A character's own size is a separate field on its card (`CharacterCard.tsx:80-81`) that no token follows. Nothing in the token bar shows or changes a size.
- **A player's undo** takes back drawings and moves only (`onPlayerUndoStack`, `shared/protocol.ts:1209-1212`). A move's step keeps where it left the token (`Pose`, `server/rooms/undo.ts:34`), and its undo puts back the place and the path alone, keeping later edits such as damage (`poseRestore`, `:260-283`, chosen at `server/rooms/actor.ts:890`).

## 3. Multi-select

### 3.1 One name

The mode is "Multi-select" everywhere it is named:

- The single token's toggle and the group's (`TokenActionBar.tsx:247-252,503-505`), each still `aria-pressed` while the mode is on.
- The tracker's switch (`TrackerPanel.tsx:469`), with its help unchanged. Its section keeps its heading, "Several at once", which names what the section does, not the mode.
- The shortcut sheet's rows and FEATURES.md's tables, such as Escape's "end Multi-select" (section 11).
- FEATURES.md (section 17), the comments that name the mode or its bar (`state/selection.ts`, `state/types.ts:135`, `state/store.ts:96`, `lib/escape.ts`, `pages/RoomChrome.tsx`, `pages/Room.tsx`, `canvas/Stage.tsx`, `canvas/emptyTap.ts`, `canvas/barDock.ts`, `features/select/SelectOptions.tsx`, `features/tools.ts`, `features/rolls/PlayerRolls.tsx`, `features/encounter/Row.tsx`), the button id `selectSeveral`, which becomes `multiSelect`, and every test that finds the button by its name.
- "The Multi-select bar" names the Select tool's options while the mode is on. That toolbar keeps the name Room gives every tool's options, "Select options", and its words do not name the mode.
- Built design docs keep their text as the record of what was built, each with a status line pointing here (section 16).

The state keeps its names: `local.multi`, `setMultiSelect`, `doneSelecting`.

### 3.2 Its place in the rows

The project owner asked for Multi-select inline with Conditions and Hidden, and then for that line to be stable. So the play row is two groups:

- **The passing line**, only while one of them shows: Undo move, Doesn't count, the door. They answer the move just made or a door just reached, come and go with it, and lead, as the token panel design ranks them (3.1 there).
- **The steady line**: Conditions, Hidden and Multi-select, those of them the viewer has, then Request a roll and Light where they show, which follow on the same line where room is left and start the next line otherwise.

The group window: Undo move on a line of its own while it shows, then Conditions, Hidden, Multi-select, Request a roll, Locked, Start a fight or Add to the fight, More, Delete, Clear.

- Request a roll moves from before Hidden to after Multi-select. It is used a few times a fight, Hidden and Multi-select less often, but between Conditions and Hidden it would push Hidden and Multi-select to the next line on every creature a player plays.
- Light's choices still open at the start of the rows (`order: -1`, `LightChip.tsx`), so they keep their place.
- `barButtons` returns `passing`, `play` and `less`. Each is its own wrapping row in the bar (`data-bar-row`).
- The less-often row loses Move bar and Reset bar position: Locked, Duplicate and Delete for the DM, Dismiss for a companion's owners, and nothing for any other player. Most players' bars lose a 44 px line.

### 3.3 The default width

The docked window's default width is the narrowest that holds Conditions, Hidden and Multi-select on one line as this page draws them, and never under 304:

`defaultWidth = max(304, ceil(26 + c + h + m + 2 × 4) + 1)`

26 is the frame's padding and borders (12 and 1 a side), 4 the row's gap, and the last pixel keeps sub-pixel rounding from wrapping the row. `c`, `h` and `m` are the widths of three hidden small buttons with those labels: an `aria-hidden` row with `visibility: hidden`, out of the flow, that the Room page draws once inside the chrome's zoom, measured in a layout effect when the page mounts and again whenever a ResizeObserver sees them change. Being real buttons in the page, they carry the device's font and the browser's minimum font size, and their widths in layout px are the same at every interface size. The measure lands in the Room scope before any window paints, since the row mounts with the page and a layout effect's update renders before the browser paints. That gives 316 with the system font on macOS, 311 with Arial, 321 with Tahoma.

- The width serves every docked window, a phone's on its side too, so a DM on a phone sees the same rows. The compact overlay takes it where it took 304 (`compactHang`, `barDock.ts:140`).
- A computer's window is never narrower (5.6). A phone's can be, only beside an open sideways sheet (7.1).
- The lane stays 312 px. It is the alerts column's, and the window's width no longer ties to it (9.1).

### 3.4 What the rows show

At the default width or wider, with the widths measured at 100% (the same at any interface size, in layout px):

| Viewer and token | Passing line | Steady line | Then |
|---|---|---|---|
| DM, a monster | | Conditions, Hidden, Multi-select | Light, where it shows |
| DM, a creature a player plays | | Conditions, Hidden, Multi-select | Request a roll, Light |
| DM, just after moving it, or after it moved this turn | Undo move, Doesn't count | Conditions, Hidden, Multi-select | Light |
| A player, their own creature | | Conditions, Multi-select, Light | |
| A player, their own creature with a door in reach | Open door | Conditions, Multi-select, Light | |
| A player, another's creature | | Multi-select | |

So Conditions, Hidden and Multi-select are one line in every case, and nothing that comes and goes moves them. The one place they wrap is a phone's window narrower than the default beside an open sheet (7.1), where the room cannot hold them.

## 4. The header

### 4.1 One row

```
[Move window grip] [name, two lines] [elevation badge] [Reset] [Close]
```

- **Move window**: a 44 px `<button>` at the header's start holding the six-dot grip (now an `Icon`, `grip`, in `components/Icon.tsx`), named "Move window", with that tooltip. It drags, and with focus its arrow keys move the window (4.3). A tap, Enter or Space does nothing (4.2). A touch device's window under 210 px, beside a sideways sheet, draws the dots alone with no button (7.1).
- **The name**, two lines at most, as today. It gives way first: below its 40 px floor it shrinks to nothing before any button leaves the window. Its lines break only between words, and a word longer than its line ends in an ellipsis, so a narrow window cuts a word short rather than breaking it (the build review's round 2, W5B-P-9).
- **The elevation badge**, as today. A window under 265 px shows it under the name instead (7.1).
- **Reset window position and size**: an `IconButton` left of Close, shown only while the window is away from its default spot or size (4.4). Its icon, `windowHome`, is a frame with its bottom right corner filled and an arrow toward it, so it reads as "back to its place" and never as Undo's curved arrow in the top bar (`RoomChrome.tsx:225`).
- **Close**, as today.

The grip and Reset show only where the window docks. A spanning bar and the compact overlay have neither, as they had no handle and no Move bar. Where the window is too narrow for this row, the badge moves under the name, the grip becomes its dots, or the window folds (7.1).

### 4.2 Moving by pointer

Today's rules stand (docs/design-v1-bar-dock.md section 2): the header row outside its other buttons is the handle, with pointer capture, `touch-action: none`, the grab cursors, the 8 px slop, the clamp into the free area while dragging, the lane rule on release, snapping within 24 px of an edge, Escape or `pointercancel` putting the window back, and the spot stored per device in `rvtt.tokenBarSpot`. One change: a press on the grip starts the same drag, which the header's pointer handler today skips for buttons. A press on the grip or the header that never passes the slop does nothing, by the project owner's answer, so a grab that wobbles a few pixels never moves the window.

### 4.3 The grip's arrow keys

While Move window has focus:

- An arrow key moves the window 8 px that way (the free area's margin, `EDGE`), and with Shift 64 px. A held key repeats.
- Each step starts from the box as drawn, is clamped into the window's room (5.3), and is stored at once as the spot of the nearest corner, with no snapping: a 24 px snap would never let an 8 px step leave an edge. The clamp brings it flush to an edge.
- The lane rule applies after each step, as after a drop. A step that the lane takes back (into the alerts column's first card, say) leaves the window where the lane puts it, and the next step starts from there.
- The handler calls `preventDefault`, so the room's shortcuts (`shortcutFor`, `state/shortcuts.ts:406-407`) pass over the key and no selected token moves. Escape is not taken: it closes the bar, as from any control in it.
- The status (`role="status"` in the frame, `TokenActionBar.tsx:879-881`) speaks once the keys rest for 500 ms, so a held key is heard once: "Window at bottom right" at a corner, "Window at the bottom edge, 120 pixels from the right" against one edge, and "Window 120 pixels from the right and 40 pixels from the bottom" elsewhere, read from the stored spot. Distances are spoken as "pixels" in full, since several screen readers spell "px" out as two letters (the build review's W5B-P-6).

The bar dock design ruled arrow keys out because they nudge the selected tokens. With the grip focused there is no nudge to lose: focus is in the bar, not on the map, and the keys go back to the tokens as soon as focus leaves the grip.

### 4.4 Reset

- **Shown** while the stored spot is not the default, or, on a computer, while a size is stored. A size stored on a device whose window does not resize there counts as none (5.1).
- **A press** removes both keys. The window returns to the bottom right at its default size, focus moves to Close first, since Reset goes, and the status says "Window back at bottom right".
- **Focus.** Whenever Reset leaves while it has focus, focus goes to Close, whatever took it away (a drag back home, say).
- **Its name** equals its tooltip, "Reset window position and size", on every device.
- **The single-pointer way.** By the project owner's answer the grip only drags and the handle only resizes, so a mouse or touch user who cannot drag has no way to move or resize the window (WCAG 2.2 SC 2.5.7). The project owner accepts that. Reset is their way back to the default spot and size, and the keys reach every spot and size.

### 4.5 What the lane, snapping and storing rules keep

- **Snapping** applies to a pointer drop and a pointer resize's release (5.4). Keys never snap.
- **Storing**: every move or resize, by any path, stores at once. A "view as a player" preview reads this device's keys and keeps its changes to itself, as it does the spot today.
- **The lane** applies after a drop, each arrow step and a resize's release.
- **Corners**: a move by pointer or key picks the free area's corner nearest the window's middle, as a drop does. A resize keeps the corner (5.4).

## 5. Resizing on a computer

### 5.1 Where

The window resizes only while it docks on a computer. The compact overlay, a spanning bar, a folded bar and every touch device keep today's sizes, show no handle and ignore a stored size, which stays stored. Phones and touch screens keep today's size rules.

### 5.2 The size it keeps

- **Width**: exact. The window is that wide, within its limits (5.6).
- **Height: a cap.** The window is as tall as its content up to the stored height and the room it has, and scrolls inside past that. It never shows empty space under short content.
- **Default**: the default width (3.3) and no cap, which is today's "as tall as its content up to its room".
- The single token's window and the group's share the size, and so does every token: "the resized size should be the size assigned to all future token windows".

### 5.3 The handle, and the room it keeps

- **Where**: at the window's corner diagonally opposite its spot's corner: the top left for a window in the bottom right corner (the default), the top right for bottom left, the bottom left for top right, the bottom right for top left. The anchored edges are the spot's, so the window grows and shrinks away from the screen edge it keeps to.
- **Its look**: a 24 px disc centered on the corner, on the window's `surface` fill with a 1 px `border`, holding a 16 px diagonal double arrow (`resize` in `Icon.tsx`, turned to the corner's diagonal), `textMuted`, `accent` on hover and focus, with the app's focus ring. It shows whenever the window is resizable, so nothing depends on hover.
- **Its target**: the 24 px disc, the WCAG 2.2 AA minimum (SC 2.5.8). It shows only with a fine pointer, so the project's 44 px touch target does not apply, and a 44 px square at a top corner would cover the grip or Close. Half the disc lies outside the window. The inner quarter, 12 x 12 px, lies in the frame's corner, inside its 12 px side padding and the header's 4 px top padding, clear of the grip and Close. At a bottom corner it covers the last 12 px of the scroller's track, which still scrolls by the wheel, the thumb and the keys.
- **The edges**: the two edges that meet at the handle's corner are 8 px bands just outside the border, `aria-hidden`, with `ns-resize` or `ew-resize`. A drag on one changes that one dimension. Nothing inside the border changes: a press on the header still moves the window, and the scrollbar still scrolls.
- **The cursor**: `nwse-resize` or `nesw-resize` on the handle, held for the whole drag.
- **The handle's reach.** The disc reaches 12 px past the window, and the free area's margin and the lane's gap are 8, so the map's edge (the stage clips its overflow, `Stage.tsx:1085`), the top bar, the toolbar, a lasting notice, a sheet or the alerts column's first card would cut 4 px off it. So while the window is resizable, its two free sides (the ones away from its corner) keep 12 px, not 8, from everything that clips or covers: the room the spot and the lane give it on those sides is 4 px less, a stacked window under the column's first card keeps 12 px below it, a window beside the lane keeps 12 px from the free area's far edge, and a drag, a key step, a resize and a stored size are clamped to that room. Its anchored sides keep 8, so a docked window's right edge still lines up with the column's. The bands lie inside the same 12 px. The whole disc and both bands are therefore always on the map and on top, at every corner and at the largest size.
- **Over other things**: the handle and bands belong to the window's layer (`theme.z.pane`). A toast passing over for its 5 s may cover them, as it covers the window.

### 5.4 A pointer resize

- A primary press on the handle or a band takes pointer capture. Nothing changes until the pointer passes the 8 px slop, and a press that never passes it does nothing, by the project owner's answer.
- The anchored edges stay put and the far edges follow the pointer. The width runs from the default width to its room (5.3). The height runs from 152 px (`MIN_WINDOW_HEIGHT`, the header and two button rows) to the smaller of its room and the content's own height, so a drag never opens empty space, and a drag past all the content stops there.
- During the drag the window takes exactly the dragged box, is clamped to its room alone, may pass under the column, publishes nothing new to the Room scope, and keeps its short layout as it was at the start, so nothing reflows under the pointer. Escape (the drag's capture listener, as for a move) or `pointercancel` puts the size back and stores nothing.
- **On release**, from the box as drawn:
  - A dimension the drag changed by no more than the 8 px slop keeps its stored value. So a clamped stored width is never written down as the clamp, and a drag along one edge leaves the other dimension alone.
  - A width within 24 px of the default width stores no width.
  - A height within 24 px of the most it may take there (the content or the room) stores no height: the window grows with its content again.
  - Otherwise the new width or height is stored, as whole px.
  - The spot is stored from the drawn box's anchored edges, keeping its corner, with no snapping. A window clamped against the free area would otherwise jump on release by the clamp it had.
  - A size and spot that end at the defaults are stored as no keys, and Reset goes.
  - Then the lane rule, the short layout and the published box follow, as after a drop.
- **A window unmounted mid-drag** (its token deleted, a sheet folding it, the mode changing with a rotation) ends the drag and stores nothing.

### 5.5 The handle as a control

The handle is a `<button>`, "Resize window", described (a visually hidden `aria-describedby`) by "Drag to resize the window. With this focused, the arrow keys resize it, and Shift resizes it faster. Reset, beside Close, puts it back." It is an icon alone, so its name shows in the shared tooltip on hover and keyboard focus (docs/design-v1-icons.md 3.2), never in a native title. The grip's description is the same with "move". Enter and Space do nothing on either, as a tap does nothing, by the project owner's answer.

- **Arrow keys** move the handle's corner 8 px, or 64 with Shift, so the window grows or shrinks with the same sense as a drag of the handle: for the top-left handle, Left widens and Up heightens. Each press is stored at once by the release rules, with no snapping: a width exactly at the default stores none, and a height at the most it may take stores none. A press against a limit changes nothing. The handler calls `preventDefault`, as the grip's does.
- **The status** speaks after the keys rest: "Window 316 by 400 pixels", with ", narrowest", ", widest", ", shortest" or ", tallest it can be here" when a press meets that limit.
- **Its place in Tab order** is last in the window, after the body, as Move bar's was.
- **Focus.** A resize keeps the spot's corner, so the handle never jumps corners while it has focus. A move (by pointer or the grip's keys) may send it to another corner, as the same element, keeping its focus.

### 5.6 Limits

- **Narrowest: the default width** (3.3). Below it, Conditions, Hidden and Multi-select would leave their line, which the project owner asked to keep stable, and the header's whole row (265 px, 7.1) fits it anyway.
- **Shortest: 148 px** (`MIN_BAR_HEIGHT`, the header and two 44 px rows, the least a docked bar needs). In the short layout Apply ends 131 px below the window's top, inside.
- **Smallest**: the default width by 148 px, 316 x 148 on macOS.
- **Widest and tallest**: the window's room (5.3), measured from the anchored edges. The stored size may say more: it is clamped for each opening (section 7).
- A stored value is an integer from 1 to 4096, clamped to these limits where it is drawn.

### 5.7 What scrolls

- **The frame splits in two.** The dialog element keeps its role, name, `data-bar-mode`, `tabIndex={-1}`, `hidden`, box, border, radius, shadow and z, and no longer scrolls. Inside it: a scroller (`data-bar-scroll`, `overflowY: auto`, `overscrollBehavior: contain`, its radius one less than the frame's, `scrollbar-width: thin`) holding the content and its "Scroll for more" fade, then the handle and the bands while resizable, then the status. The handle and bands sit outside the scroller so they never scroll or clip. `onScroll` and the clipped measure move to the scroller. On every device the header stays sticky inside the scroller as today, and the compact overlay's header still scrolls with its content.
- **Scroll padding.** The scroller's `scroll-padding-top` is the sticky header's measured height, and its `scroll-padding-bottom` the fade's height while the fade shows. So a control scrolled into view by focus, a reveal or the browser lands below the header and above the fade, never under them.
- **Reveals.** What opens inside the window scrolls itself into view (`block: "nearest"`): the Conditions drawer in both windows and "More stats", as Light's choices already do (`LightChip.tsx`, `reveal`). In a shrunk window the drawer opens above the rows, and without this it opened out of sight.
- **Kept or not.** A window keeps its scroll through its own resizes, moves, lane changes and content changes. A new token's window opens at its top, as today (`key={selected.id}`): its name, vitals, HP field and Apply come first, an armed Delete or a half-typed entry never carries over, and the same scroll offset in a different token's content would show a different thing. The group window stays one window while tokens join and leave it, so it keeps its scroll.

### 5.8 The short layout, More stats and Apply

- **Capacity counts the cap.** `barCapacity` (`barButtons.ts:110-120`) is the room `placeBar` gives a bar of unbounded content, now with the stored height as a cap, so a window under 300 px tall is short: the vitals keep to AC and HP, the HP field and Apply come first, and "More stats" holds the rest. Apply ends 131 px below the window's top, inside the smallest window.
- **Decided at rest.** The short layout is decided when the window opens and when a resize ends, never during a drag.
- **A flip keeps focus.** A flip reorders the HP entry (`HpEntry` `fieldFirst`, `HpSection.tsx:113,132`). Its mode buttons stay mounted and are placed by CSS `order`, so a flip never drops focus from a mode button or the field. Today a flip remounts the mode buttons when alert cards change a docked bar's capacity. The page's order follows what shows, the field first in the short layout, so Tab and a screen reader meet them in the order drawn (WCAG 1.3.2 and 2.4.3, the build review's W5B-P-5). Only a flip while focus is inside the entry keeps the old order, shown by CSS order alone until focus leaves, since moving the focused element would drop its focus.
- **The group window** follows the frame's short flag too: its HP entry puts the field and Apply first when short (`GroupHpEntry` passes `fieldFirst`). With its names on one line, Apply shows in the smallest window. A longer list of names pushes it down, and the window scrolls, as a dead creature's Revive line does in the single window.
- **Focus after a resize.** When a resize ends, a focused control the new size hides scrolls into view (`block: "nearest"`, inside the scroll padding).

## 6. The size it keeps on this device

- **The key**: `rvtt.tokenBarSize`, read and written in try and catch as every `rvtt.*` key is, for example `{"w":400,"h":300}`, `{"w":400}` or `{"h":300}`. Each of `w` and `h` is an integer from 1 to 4096. A missing key, bad JSON, a fraction, a negative, zero, over 4096, a string, or no field at all reads as the default, which is stored as no key.
- **The Room scope's slot** (`barDockSlot`, `barDock.ts:693-730`) gains `size` (read at the slot's creation, as `spot`), `defaultWidth` (from the hidden buttons, 3.3) and `finePointer`.
- **Placement.** `placeBar` (`barDock.ts:466-501`) takes the window's width, its height cap and whether it is resizable, for the handle's reach (5.3). On a touch device the caller passes the default width, no cap and not resizable. The cap applies last, after the spot and the lane: whatever room they give, the window takes at most its stored height. A bottom-anchored window that the lane moves down keeps `min(content, cap)` of height, as it kept its content's. `restingBar` (`:509-513`) takes the same, so a pan expects the window where it will be.

## 7. When the free area is smaller than the stored size

One rule: **the window is clamped for this opening, and the stored size stays**. Reset shows while a size is stored, whether or not it is clamped.

- **Width**: the stored width, or the default, never under the default where the room allows it, at most its room (5.3), and narrower only beside a phone's sheet (7.1). Beside the lane, at most the room left of the lane.
- **Height**: `min(content, cap, room)`, the room from the spot and the lane.
- **The side panel** shown or hidden (S, Hide panels, Panels, docs/design-v1-layout-hierarchy.md 4.1) narrows or widens the free area by 360 px. The window shrinks and grows back with it.
- **A sheet on the right** (a landscape layout under 900 px, a computer at 130% included) narrows the free area by the sheet. A free area narrower than the default width draws the window narrower (7.1). The very short sheet folds the window (`hidden`), size untouched.
- **An interface size change** changes the free area in layout px. The stored size is in layout px, so the window keeps its size against its own content and clamps where the room is less.
- **A short screen**: the room clamps the height. Under 148 px of free height the bar opens compact, which ignores the stored size (5.1).
- **A fight starting**: the turn band (on a layout under 900 px) lowers the free area's top by 48 px, and alert cards share the lane. Stacked, the window's room is below the first card, and the cap applies after. Beside, its width is at most the room left of the lane. Summarized, its room is below the summary row.
- **The short layout** follows the clamped capacity, so a window clamped under 300 px is short for that opening.
- **Rotation** of a computer's window or a tablet with a mouse changes the free area as a resize does.

### 7.1 Narrow windows

A window narrower than the default width happens only beside a phone's open sideways sheet, where the free area is what is left: 311 px at 667 x 375 at 100%, 246 at 844 x 390 at 130% (47 px insets, the sheet 340), 189 at 667 x 375 at 130% (the sheet 308, its 60%), and 129 at 480 x 320 at 100% (47 px insets, the sheet 288). There the header and the rows follow the width they get. The header keeps one row at every width the window shows at. A header in two rows left such a short window little more than its header, with the HP field and Apply under "Scroll for more" (the build review's W5B-P-3). So what gives way first is what the window also shows elsewhere. Reset counts whether it shows or not, so moving the window never changes the header.

- **265 px and wider: the whole row**, as 4.1: the grip, the name's 40 px floor, a badge up to "↑120 ft" (about 51 px), Reset and Close, with four 4 px gaps and the frame's 26 px. The steady line wraps where the window is under the default width (3.4).
- **210 to 264 px: the badge moves under the name**, to the end of the vitals line after AC and HP, in its own color. The Elevation row still says it. 210 is the row without it: the grip, the name's floor, Reset and Close, three gaps and the frame.
- **182 to 209 px: the grip becomes its dots.** On a touch device the grip draws its six dots in 16 px, with no button. The header drags from them as from anywhere else on it, the arrow keys the button took need a keyboard a phone seldom has, and Reset still brings the window home. 182 is the row with the dots. A computer's window is never this narrow (5.6). Should one be, its grip stays a button, the keys' control, and the name gives up its floor instead.
- **Under 182 px: the window folds** as under a very short sheet (docs/design-v1-layout-hierarchy.md 4.2): it takes `hidden` with its state kept, and its "Show Thorn actions" joins the sheet's header with the dock's other buttons (`DockHeaderActions`). `foldsUnderSheet` (`pages/fold.ts:33-35`) gains this case. Show closes the sheet, as it does under an upright sheet, and the window opens at its full width again. Only 480 x 320 at 100% with a side sheet is this narrow, and there the window was a 129 px column with 103 px of room for its controls.

The compact overlay has no grip and no Reset, so its header is the name, the badge and Close at any width it takes.

## 8. A creature's size on the fly

### 8.1 Who

- **The DM**, on any token, never checked against walls (8.4). The six sizes and Custom, with its width and height.
- **The token's owners**, on a token they own (`ownsToken`), companions included, through one permission (8.6). The six sizes, never Custom. A token the DM made Custom shows its size read-only to its owners, "Custom, 2 by 3 squares, set by the DM", and only the DM changes it. Enlarge or Reduce, Wild Shape and polymorph are the player's to play, and the project owner chose the same for companions, which docs/design-v1-companion-stat-blocks.md points here for.
- **A locked token** takes no owner's resize, as it takes no owner's move (`moveCheck`, `permissions.ts:711-717`): the change can shift the token. The DM's lock is the DM's way to keep a token where it is.
- **Nobody else.** A player who may move any token (`playersMoveAny`) does not own it and may not resize it.
- It is the token's size on the map. The character's size on its card, and a stat block's size, stay as they are.

### 8.2 Where the footprint goes

**The base spot**: of the footprints of the new size on its snap grid (whole cells, half cells for Tiny, `snapPosition`, `lib/scene.ts:28-31`), the one whose middle is nearest the old footprint's middle. Where two are as near, the one whose top-left corner is nearest the old one. Then it is moved the least to lie inside the scene, where the scene is big enough. For the six sizes:

- **Growing**, the new footprint covers the old one: a Medium at (4, 4) becomes a Large at (4, 4), spreading right and down as today, a Huge at (3, 3), centered on the old square, a Gargantuan at (3, 3).
- **Shrinking**, the new footprint lies inside the old one: a Large becomes a Medium in its top-left square, a Huge a Medium in its middle square.
- **Tiny** takes half cells: a Medium at (4, 4) becomes a Tiny at (4, 4), and a Tiny anywhere in a square becomes a Medium in that square.
- **Small and Medium** are both one square, so between them nothing moves, and a resize between them keeps its place.
- **Custom** (the DM's) follows the same rule, and where the grid offers no covering or inner spot for an odd width, the nearest middle decides.

The token's middle is its stored center (`storedCenter`, `shared/rules/footprint.ts`), the full footprint's middle even while squeezed, and every resize clears a squeeze, as today.

**Back to the square it grew from** (the project owner's answer). The base rule alone can leave a creature a square from where it started: grown away from a wall, its shrink takes the grown footprint's top-left square. So the device that grows a token remembers where it grew from:

- The Room scope keeps, per token, a short list of growths this page sent: the place and size before each, and the place and size it left.
- A shrink from this page, while the token stands exactly where and as big as the newest growth left it, to the size one of those growths started from, goes back to that growth's place and drops it and every newer one. So Medium to Large to Huge, then Huge to Medium in one step, lands on the Medium's own square.
- Anything else about the token's place or size, by anyone (a move, an undo, another device's resize), makes the list stale, and the next shrink drops it and takes the base spot.
- The remembered square lies inside the grown footprint, since every growth covers every square the creature filled before (8.3, and rule 4 of 8.6 for an owner's), so the permission takes it as any shrink's spot. An owner's shrink to it is still checked by 8.3 on a scene that blocks moves.
- **The limit**, stated as the guarantee and nothing more: on the device and page that grew it, a creature that has not moved or been resized since shrinks back to the square it grew from, a Tiny one to its own quarter. Another device, a reload, or a move in between leaves the base rule, which may differ by a square after a shift, or by a quarter for Tiny.

### 8.3 An owner's resize on a scene that blocks moves

The project owner's decision: an owner's resize is checked like a move. It applies to every resize by someone who is not the DM, on a scene that blocks moves: growing, shrinking or keeping its size. Elsewhere nothing is checked.

**Clearance is the move rules' standing test**, the one a move ends on: the token's core at a spot touches no movement blocker (`coreBlocked`, `shared/rules/movement.ts:443-448`). The core is the footprint less about a cell on each axis (`coreSize`, `:39-45`), so the drawn footprint may reach under half a square past a wall where a move could stop the same way, and a creature standing on the grid needs its full width of open floor: a Large creature needs 10 ft between walls, a Huge 15 ft. One definition serves docs/design-v1-companion-stat-blocks.md too.

**Two tests**, each the move rules' own, so a resize and the next move always agree:

1. **Standing**, for a growth: the new spot passes the standing test.
2. **Not crossing**, for every resize that moves the token's middle: the straight leg from its current middle to the new spot's middle, swept with the new size's core, is clear (`legClear` through `legOf`, `:312-360`). A wall the new core already touches at the current middle may be left only toward the side the middle is on, never crossed (`partClear`, `:278-306`). That is "stays on its own side of every wall, judged from the token's current middle".

**What counts** is the movement set, exactly as for a move: walls, closed and locked doors, a secret door not yet found (a wall, as players see it), windows and pillars. An open door does not count. Ledges count as they do for its move, by where it stands at its elevation (`ledgeFloor`, `:198-208`): a creature on the ground meets a ledge it could not climb, a flier only ledges above it.

**Keeping its size** (Small and Medium, or a patch naming the current size) keeps its place: such a patch may not change `x` or `y`.

**Growing.**

- **The candidates**: the footprints of the new size on its snap grid that lie inside the scene and cover every square the creature filled before, or every quarter for a Tiny one: the new footprint contains the old one. So the creature grows into the space around where it stood and never leaves a square it held, and its undo and its remembered return always land inside the grown footprint. A creature n squares wide growing to N squares has N − n + 1 spots each way: at most 16, a Medium growing to Gargantuan. Beside walls fewer spots qualify than "any spot that holds its middle" would give, so more growths there are refused, as a creature that grows only into the space around it would be.
- **The least distance**: of the candidates that pass both tests, the one whose middle is nearest the token's current middle, in cells, straight line. Among equally near ones, the base spot first, then the smaller vertical shift from it, then the smaller horizontal shift, then up before down, then left before right, which leaves no two tied. The base spot is among the nearest, so with no wall near nothing shifts.
- **No room**: where none passes, the resize is refused with "No room to grow here." The device finds that before it sends anything, shows it as the room's refusal toast, and changes nothing. The server refuses the same way where its view differs from the device's (8.6).
- **Never squeezed.** A resize clears a squeeze and never ends in one, so a creature that could squeeze into a corridor one size too small by moving (`landing`, `movement.ts:538-566`) cannot grow into it.

**Shrinking.**

- **The candidates**: the footprints of the new size on its snap grid inside the current footprint.
- **The spot**: the remembered square (8.2) where it applies, else the base spot, if it passes the not-crossing test. Otherwise the candidate nearest the token's current middle that passes it, with the same ties. A shrink needs no standing test of its own: the not-crossing sweep runs to the new spot, so a wall the smaller core meets there stops it, except a wall that core already met at the creature's middle, which the move rules let it step off on the middle's side, as a move may (`partClear`).
- **Where none passes.** Every candidate's middle lies inside the old footprint, so on open floor, or beside a wall the old footprint only reaches over, the base spot or a neighbor passes: a wall a footprint reaches over lies to one side of its middle, and the candidates on the middle's side pass. Only walls inside the old footprint that cut every candidate off from the middle refuse them all, and then the shrink is refused with "A wall is in the way.", the move's words (`WALL_IN_THE_WAY`, `permissions.ts:768`). The size stays, and the DM can still shrink it.

Worked examples:

- **A corner.** Walls along the left and top of square (4, 4), a Medium standing in it. To Large: the base (4, 4) to (6, 6) has its core clear. Nothing shifts. To Huge: the base (3, 3) puts its core over both walls. Of the nine spots covering the square (4, 4), only (4, 4) keeps its core clear, 1.4 cells away, so it grows right and down, away from both walls.
- **A short wall** (round 1's case): a Medium at (4, 4) grows to Gargantuan with a wall at x 3.75 from y 6.25 to 6.5. The base (3, 3) is blocked, and so is (2, 3). (3, 2) and (2, 2) pass with their middles 0.71 cells from (4.5, 4.5), and (3, 2) shifts less across from the base, so it takes (3, 2). (4, 3), which ranking from the base spot picked, passes too but is 1.58 away.
- **Two pairs of short walls** (round 2's cases): a Large at (4, 4), its core clear, grows to Huge, with walls at x 5.75 from y 3.5 to 4 and at x 4.75 from y 5.75 to 6.5, or instead with walls at x 4.625 from y 4.25 to 4.375 and from y 5.625 to 5.75. The four Huge spots that cover the Large's squares are (3, 3), (4, 3), (3, 4) and (4, 4). In the first case (3, 3) stands clear but its leg from (5, 5) crosses the wall at x 4.75, and the other three put their cores on a wall. In the second all four put their cores on a wall. Both say "No room to grow here." Round 1's rule took (5, 4), which left the Large's left squares, so its undo and its return were refused.
- **A 5 ft corridor**, to Large: every candidate's core straddles a corridor wall. "No room to grow here."
- **A 10 ft corridor**, to Gargantuan: no candidate's core fits. "No room to grow here."
- **A shrink beside a free wall.** A Medium at (4, 4) with a free wall at x 4.375 inside its square, its middle (4.5, 4.5) right of it. To Tiny, the base (4, 4) would put its middle at (4.25, 4.25), across the wall, so it takes (4.5, 4), middle (4.75, 4.25), on the middle's side.
- **A crafted patch**: a Large at (4, 4) sending Large at (3, 4) is refused, since a patch that keeps its size keeps its place. A Medium sending Tiny at (4, 4) across that free wall is refused with "A wall is in the way."
- **An open door.** The doorway does not count, and the creature may grow into it. Closed, it counts.

### 8.4 The DM's resize

The base spot, or the remembered square on a shrink, with no wall search and no check, on every scene. The DM places tokens anywhere today, over walls too, and the project owner chose that the DM's resizes are never checked.

### 8.5 What follows a resize

- **Elevation** stays. The creature's bottom keeps its height, so a flier stays up and a creature on a 10 ft ledge stays at 10 ft. Its next move is judged by the ledges from where it stands.
- **Height**: a token without its own height stands as tall as its new footprint's shorter side (`tokenHeightFt`, `footprint.ts:145-149`): 10 ft for Large at 5 ft per cell. Its eye, its carried light, the areas' vertical overlap and the sight rules follow. A height the DM set stays.
- **Reach and range rings** are counted from the footprint's edge (`features/measure/rings.ts:35-37`), so they grow and shrink with it, and follow a shift.
- **Attached areas** (`attachedTo`, `shared/rules/aoe.ts:523-526`) are worked out from the token each time, so an emanation such as Spirit Guardians grows with the creature and follows a shift. An area cast in place from a token (`footprint` stored, Tiny Hut) keeps the shape it was cast with.
- **The fight.** The tracker's rows do not change. A size or place change during a turn already counts as a place change for the areas that remind on entering (`placeChanged`, `shared/reducer/areaTriggers.ts:155-170`), so a creature that grows or shifts into such an area, or whose attached area grows onto others, gets its reminder. A resize counts no movement (8.7).
- **The table display** draws what players get, so it shows the new footprint.
- **The squeeze** clears, as on any size change.
- **HP-less tokens and effect companions** resize the same way, for whoever may resize them. They have no HP entry, so the window's short layout changes nothing for them.

### 8.6 One op and one permission

- **The op** is today's `token.update`, its patch a **resize patch**: `size`, and `x` and `y` where the spot changes. The DM's patch also clears `w` and `h` when leaving Custom, or sets them for Custom. No protocol change.
- **Every place that changes a size builds the patch with one client function**, `resizePatch(view, token, size, role, memory)` in `client/features/tokens/resize.ts`, over the shared rule `resizeSpot` in a new `shared/rules/resize.ts`: the token window's stepper, the panel's Size field, "Back to …", and the DM's Custom fields. It answers `{ patch, shifted }` (whether the spot moved off the base spot to clear a wall) or `{ refused }` with the words, so a caller can preview the outcome before sending, as the companion design's Size line does. The DM's group More sends one resize patch per token as one gesture (`dispatchGesture`), in place of one `token.updateMany`, so each keeps its middle. One undo step takes them all back.
- **The reads.** A resize patch reads what any `token.update` reads, the token (`shared/reads.ts:91-99`), so a device holding the token predicts it at once. Its path stop reads the turn as a move's stop does, from the copy's encounter, and a player's copy that cannot see the turn's start leaves the path for the server's answer, as for moves (`withPath`, `tokens.ts:317-322`). The walls are the permission's, read from the copy's build chunks, which is why the server judges the spot it is sent.
- **The permission**, `resizeCheck` in `shared/permissions.ts`, for a player's `token.update` whose patch holds `size`. `token.update`'s owner branch and `companionUpdateCheck` both hand such a patch to it, so a companion and any other owned token are judged by one rule:
  1. The player owns the token, else "that is not yours".
  2. It is not locked, else "that token is locked".
  3. The patch holds only `size`, `x` and `y`. `size` is one of the six sizes, and the token's size now is not Custom. Else "owners pick one of the six sizes".
  4. The place, at `x` and `y` (the current ones where absent), is on the new size's snap grid. Keeping its size, it is the current place. Growing, the new footprint lies inside the scene and contains the current footprint. Shrinking, it lies inside the current footprint. Else "a resize keeps the creature where it stands".
  5. On a scene that blocks moves, a growth passes both tests of 8.3, else "No room to grow here.", and a shrink that moves the middle passes the not-crossing test, else "A wall is in the way."
- **A permission, never a reducer rule**, so stored ops replay as they were made, as the move rules do (`legCheck`, `permissions.ts:772-796`). The server judges the spot it is sent, not the one its own search would pick: a device whose view lacks a wall it has not seen may send a spot the server refuses, and one with the same view always sends a spot the server takes.
- **The reducer** applies the patch as it applies any `token.update` (`tokenUpdate`, `shared/reducer/tokens.ts:140-196`), with one change for the turn's path (8.7).
- **`access.ts`** gains `canResize(token)`: the DM, or an owner of an unlocked token whose size is not Custom. The window and the panel show their controls by it.

### 8.7 Undo, the turn's path and the op version

**Undo.** A resize goes on its maker's undo stack, a player's included, and its undo takes back the resize alone:

- **A pose with a size.** `Pose` (`server/rooms/undo.ts:34`) gains the footprint's `size`, `w` and `h`. `isResizeOp(op)` beside `isPoseOp` (`shared/protocol.ts:1202-1207`) names a resize patch, and `onPlayerUndoStack` takes it. `server/rooms/actor.ts:890` records poses for a player's resize as for a move, so the step keeps where and how big the resize left the token.
- **The restore.** `poseRestore` (`undo.ts:260-283`) puts back the place, the squeeze, the path and now the size, `w` and `h`, and leaves everything else as it is now: damage dealt since, a condition, a light or a new name survive the undo. It is refused when the token's pose is not what the step left, someone having moved or resized it since, with "it was moved or resized since" (`MOVED_SINCE`, `:291`). The DM's undo restores whole values, as for every op, guarded as today.
- **The check.** `restoreMoveCheck` (`permissions.ts:754-764`) becomes `restorePoseCheck`, which judges two kinds of restore two ways:
  - **A restore that keeps the size** (the same `size`, `w` and `h` as now) is judged by today's `restoreMoveCheck`, whole and unchanged: it may differ from the token now only in the pose fields, and a restore that leaves the token in place (an elevation or a facing undone, with no change of position or scene) passes for its owner even on a locked token, while any other needs `moveCheck` (`permissions.ts:711-717`: the owner or a player who may move any token, on an unlocked token). Its tests (`shared/permissions.test.ts:255-279`) stay as they are.
  - **A restore that changes the size** may differ from the token now in the pose fields and in `size`, `w` and `h`, and needs the rights a resize needs, checked against the token as it is at the undo or redo, not as it was when the step was made: the player owns it now, it is unlocked, and neither its size now nor the restored one is Custom (`resizeCheck`'s rules 1 to 3). Then the restored footprint is judged as a resize by rules 4 and 5. So a player who resized a token and then lost it to another player can neither undo nor redo that resize, even where they may still move any token (`playersMoveAny`): "that is not yours". An undo of a growth is a shrink back into the grown footprint, which a wall drawn since across its middle refuses, and a redo of a growth needs room again.
- **"Undo move"** in the bar goes after a resize, since a resize is not a move (`undoMove.ts:69`), and Ctrl+Z takes the resize back first.
- **Tests** cover resize then damage then undo (the damage stays) and redo, a move or another resize between them (refused), a wall drawn between a growth and its redo, and the token given to another player with `playersMoveAny` on before the undo and before the redo (both refused, while a move's undo in the same room still passes).

**The turn's path.** A resize is not a move, and the legs before it keep everything they had, their size included, wherever the path goes:

- **Each stop knows its size.** `PathStop` (`shared/model.ts:654-670`) gains an optional `footprint: { w, h }`, in cells: the footprint the creature had when the stop was made, wherever that differs from the token's size now. A stop without it was made at the token's size now. On the acting creature's turn, a size change writes its old size into `footprint` on every earlier stop of the path that holds none, then appends one stop at the new place, `uncounted` as a leg that does not count is, holding none. Stops made later hold none until the next resize. Where the turn has no path yet, it starts from the turn's start as for a move. Nothing else about an earlier stop is rewritten: its place, elevation and marks stay.
- **And whether it was squeezed** (the build review's round 1, W5-BUILD-DATA-01). A squeezed footprint is read centered and unsnapped, so a stop made squeezed and read later at full size moves by half a square. The rule is one: a stop is read with the footprint now unless it holds its own, so whenever the footprint changes on the acting creature's turn, by a resize or by a move into or out of a squeeze, every earlier stop that holds none takes the old one, `{ w, h, squeeze: true }` where it was squeezed. A move into or out of a squeeze appends its own stop as any move does, counted. A squeeze keeps the size, so it is no resize: "Doesn't count" still marks it. Only ops from version 6 on do this, so older ones replay as they were.
- **A squeeze taken or left in place** (the build review's round 2). A same-size update clears a squeeze where the creature stands, as a group's resize does for a member already at the size chosen, and a move to the spot it stands on may take or leave one. That changes the footprint and moves nothing, so it is a resize's twin: the earlier stops take the old footprint, and one uncounted stop is appended where it stands. Counted, its leg would read up to half a square, between a squeezed footprint's unsnapped middle and a full one's snapped one. "Doesn't count" has nothing to mark there, and the reducer refuses it on such a leg as on a resize's (`reshapeLeg` in `shared/rules/path.ts`). The rule for every op is one: no op changes the feet of a leg made before it, and an op that leaves the creature where it stood adds no feet. A randomized test runs turns of moves, resizes, squeezes, group resizes, climbs, teleports and marks against both.
- **Distance reads it, as drawing does.** `movedFeet` (`movement.ts:44-50`) snaps and measures each end of a leg at its own stop's size (`footprintRect` snaps by the footprint's step, `shared/rules/footprint.ts:99-104`), not the token's size now. So a Tiny's half-square leg keeps its 2.5 ft after the creature grows, a squeezed creature's leg through a corridor keeps its 37.5 ft after it shrinks there, and every completed leg keeps its feet. A leg whose ends differ in squeeze, as a move into a corridor, runs between the two footprints' middles, as a leg across sizes does. An uncounted leg takes no diagonals, so the 5-10-5 count runs on across the resize unchanged (`movement.ts:115-116`).
- **The resize stop's own leg**, whose two ends differ in size, is uncounted, takes no diagonals, is drawn faint between the two footprints' middles, and draws nothing where the middle did not move. The trail draws every stop at its own size, and `TurnTrail.from` takes the first stop's.
- **Projection.** `plainStop` (`shared/rules/path.ts:81-85`) copies `footprint`, so owners (`stopsForOwners`, `:77-79`) and non-owners (`stopsForNonOwners`, `:65-74`) get every stop's size with it, in the server's answer, in a snapshot and after a reconnect. A non-owner whose view drops unseen stops keeps each seen stop's own size, since every stop carries its own. The field tells them nothing they could not see: it is the size the creature had where they saw it.
- **Compaction.** At `MAX_PATH_STOPS` (50) `withStop` (`path.ts:47-57`) joins two legs by dropping a corner. It now drops the oldest eligible corner: one whose legs on both sides lie at one size, so never a resize stop nor the stop before one. A joined leg then never spans a resize, and the joined stop keeps the later stop's fields, `footprint` with them, as it keeps its marks today. When no eligible corner remains, as in a turn that alternates a move and a resize until the path is full, it drops the oldest corner, and the joined leg, whose ends differ in size, is measured between the two footprints' middles and counts if either leg counted, as joined legs do today.
- The field joins the path's schema in `server/rooms/stateSchema.ts:200-207`.

**The op version.** Today a stored `token.update` with a size and a place records a counted stop. From op version 6 it records the resize stop. So `OP_VERSION` goes to 6 (`shared/migrate.ts:14`) with a step from 5 to 6 that returns the op unchanged, as the steps from 3 and 4 do, and `resizeStop(opVersion)` in `shared/migrate.ts` (false before 6, true at 6 and for a live op), read in `withPath` through `tx.env.opVersion`, as `healRevivesDead` is. A version 5 op replays by the old rule and makes the state it made then. Fixtures at version 5: a combined size and place update on the acting creature records a counted stop on replay, and the same op at version 6 records the resize stop. docs/design-v1-companion-stat-blocks.md changes a link patch's result at the same boundary: if the two builds deploy together they share version 6, and if this one deploys first, that one takes 7.

**Rolling back.** An older build refuses to migrate a version 6 op down (`runMigrations`), and its state schema refuses a path stop with `footprint`. So a room that has stored either loads only on this build or later. Rolling back past it needs the backup taken before the update, as for version 5.

### 8.8 The base size and "Back to"

- **The base** is the creature's own size where the viewer's copy knows it: a PC's character's size, a token linked to a room monster or an SRD monster's block (`tokenStatBlock`, `features/monsters/statBlockLink.ts:24-31`, the SRD's once its block has loaded), and a companion's linked block (docs/design-v1-companion-stat-blocks.md). For "Medium or Small" both count, and "Back to" names the first. An unlinked NPC, a monster without a block, an object and a companion with no block have none.
- **"Back to Medium"** is in the panel's Stats only (8.10), where the base is known and the token's size is neither base size. In the window the stepper gets back in one press from one size off, and a second row there would push the steady line down. It is a resize like any other: back down by the shrink rule, back up checked by 8.3 for an owner.

### 8.9 In the token window

The window holds the size after the steady line and before the less-used buttons:

```
| [Conditions] [Hidden] [Multi-select]  |   the steady line
| [Light]                               |
| Size                [-] Medium  [+]   |
| [Locked] [Duplicate] [Delete]         |   the less-used buttons
```

- **Why there** (the project owner's answer to the build review's W5B-P-2). Size is used rarely but at a moment that matters, Enlarge or Reduce cast, a Wild Shape, a polymorph. Under Elevation, with the rows that change how the map draws the creature, it pushed Conditions and Multi-select out of a player's view on an upright phone, the device players use most, for a control used a few times a campaign. After the steady line it moves nothing that play needs every turn, in any layout: the spanning bar, a docked window, the short layout, a narrow window beside a sheet and the very short mode. The less-used buttons after it are the DM's and few players have any, so for most players it costs no line above anything. It is a control, not a reading, so it is not in the vitals line, which only reads, and not in the button rows, where it would break the steady line.
- **A stepper, as Elevation is.** "One size smaller" and "One size larger", 44 px each, with the size between them, weight 700, in a slot as wide as "Gargantuan" in that font, so the buttons never move under the thumb. Each press is one size: Reduce and Enlarge are one size, and Medium steps to Small, which is the same square. The buttons disable at Tiny and Gargantuan. The value is `aria-live="polite"`, so a press is heard ("Large"). The row is a `group` named "Size".
- **Who sees it**: whoever may resize the token now (`canResize`): a player's own creature and their companions, and every token for the DM. Not a locked token for its owners, and not another's creature.
- **Custom**: a Custom token's row is its size read-only, "Custom, 2 by 3 squares", with ", set by the DM" for its owners. The DM changes it in Stats.
- **Refused**: "No room to grow here." or "A wall is in the way." shows as the room's refusal toast. The size stays.
- **The stepper row's width.** A label and a stepper that does not fit beside it wraps under it, right-aligned (`flex-wrap`, the stepper `flex: none` with `margin-left: auto`). One rule for Elevation and Size: it keeps both rows inside the window at any width and font. Measured, the size row needs about 209 px inside the window and Elevation about 214, so both stay one line in every window from 240 px (every computer's, and the one beside a sheet at 246 px) and wrap only in narrower ones: beside a sheet at 189 px, and the narrowest phone's spanning bar (320 px at 130%, 204 inside). Today Elevation runs about 10 px into the padding there. That is fixed by the same rule.
- **Short and compact.** The row keeps its place in the short layout: "More stats" holds readings, and Size is a control, after the steady line, so neither Apply's reach nor the steady line's changes. The compact overlay scrolls as a whole, with the row in the same order. The upright phone's spanning bar holds it in the same place.
- **The group window** has no Size row. The DM resizes a group from More, as today.

### 8.10 In the token panel's Stats

The project owner asked for it "in stats". The token panel's Stats section (`TokenPanel.tsx:169-179`) gains a Size row first:

- **For the DM**: the Size select with Custom, and Custom's width by height fields, moved here from Token settings (`TokenPanel.tsx:324-338`). Token settings no longer has Size, so one place edits it.
- **For an owner who may resize**: the same select with the six sizes.
- **"Back to Medium"** under it, by 8.8.
- **Read only**: for an owner of a locked token, "Medium (5 ft), locked by the DM", and for an owner of a Custom token, "Custom, 2 by 3 squares, set by the DM", as text.
- Every change goes through `resizePatch`, so the panel and the window place the footprint alike, and the panel shows a refusal's words under the field.
- The name block's size line (`NameBlock`, `TokenPanel.tsx:200-222`) reads the token's size, as it does.
- Stats shows wherever the viewer has the full card and the token's creature is in their copy (`panelSections`, `features/tokens/panelOrder.ts:56`): every token for the DM, objects included, and every token an owner owns. So the panel's Size is there wherever a resize is allowed.

## 9. What changes in the earlier designs, and what holds

### 9.1 docs/design-v1-bar-dock.md

| Rule | Change |
|---|---|
| 1.1 Span, dock or compact | Holds. "Desktop" (a computer) adds resizing in the dock mode only |
| 1.2 The free area | Holds, as does the default spot. "`min(304, free width)` wide" becomes the window's width (3.3, 5.2, section 7), and "as tall as its content up to its room" gains the cap. A resizable window's free sides keep 12 px (5.3) |
| 1.2 Sticky header and "Scroll for more" | Hold, inside the new scroller (5.7), with scroll padding |
| 1.3 The lane | Holds at 312 px, the column's. Stacked holds, with 12 px under the first card for a resizable window whose free side is its top. Summary holds. Beside: at most the room left of the lane, less the handle's reach where resizable. "Applied on release" adds each arrow step and a resize's release |
| 1.3 Notices, "Viewing as Pat", the column's measures | Hold. Lasting notices stay outside the free area. A toast may pass over a wide window's top for its 5 s, as it passes over a moved bar today |
| 1.4 Compact | Holds. No grip, handle or Reset. Its width is the default width (3.3). It ignores the stored size |
| 2 Moving | The handle, capture, slop, clamp, snapping, Escape and storing hold, and a short press still does nothing, on the grip too. Move bar and Reset bar position go: the grip's keys (4.3) and the header's Reset (4.4) take their places. "No arrow-key moving" is reversed for the focused grip |
| 3 Taps off the bar | Holds, names aside. A press on the handle or a band is the window's own and reaches no map |
| 4 Fit, Find and pans | Hold, with one generalization: a window against the free area's right edge, or inside the lane, covers the right side from its own left edge or the lane's, whichever is further left, whatever its height. A window elsewhere covers the side that leaves the largest clear rectangle, as before. `barCover` takes the free area's right edge with the bar (`BarFacts`). The cover is the window's box, not its handle. A resize, like a move, never moves a fitted map, and the next Fit uses the new box |
| 5 What stays | Holds, with "Multi-select" for "Select several", and Move bar's focus target becoming the grip |
| 7 Its tests | Test 4's Move bar and Reset bar position cases change (section 15) |

### 9.2 docs/design-v1-token-panel.md 3.3

- The play row splits into the passing line and the steady line, and Request a roll follows Multi-select (3.2). The less-often row loses Move bar and Reset bar position.
- The short layout's rule holds, with capacity counting the cap (5.8). Its 300 px threshold and the spanning bar's 210 hold.
- The body gains Size after the steady line and before the less-often row (8.9).
- Its mockups' widths are 278 px inside, which the default width makes about 290. Nothing there depended on 278.

### 9.3 docs/design-v1-layout-hierarchy.md

- **3.5 and 8.2** (the free area with a rail, "Move bar" and the stored spot following the rail): hold for the stored size too, which clamps into the narrower free area. The rail itself goes with docs/design-v1-tool-options.md (section 12), and nothing here reads it.
- **4.1 and 4.3** (the side panel hidden, the right safe area): change the free area, so the window clamps and grows back (section 7).
- **4.2** (the sideways sheet and the very short mode): the window folds as the bar does, its size untouched, and also folds beside a side sheet that leaves it under 182 px (7.1).
- **8.1's table**: every docked row docks as before, a little wider by default (3.3). "480 x 320, 100%" with a side sheet folds the window into the sheet's header (7.1).

## 10. Accessibility

- **Names and roles.** "Move window" and "Resize window" are buttons, each described by a visually hidden line of its keys (5.5). "Reset window position and size" is a button whose tooltip equals its name. "One size smaller" and "One size larger" are buttons in a group named "Size", and the value is a polite live region. "Back to Medium" is named by its words. "Multi-select" keeps `aria-pressed`.
- **Keyboard.** Every new control takes Tab: the grip first in the window, Reset and Close after it, the size buttons in the body, the handle last. The grip's and the handle's arrow keys work while they have focus and call `preventDefault`, so no token moves.
- **Enter and Space** do nothing on the grip and the handle, as a tap does nothing (the project owner's answer). Their descriptions name their keys, and a screen reader user reaches those keys in focus mode.
- **Single pointer (SC 2.5.7).** Moving and resizing take a drag. A user who cannot drag has Reset, the keys, and the default spot and size. The project owner accepted this when choosing drag only (4.4).
- **Target size (SC 2.5.8).** 44 px everywhere a touch can reach. The handle, a fine pointer's only, is 24 px, its edges extend it, and every limit keeps it whole (5.3).
- **Live announcements.** The window's one polite status: corners, edges and gaps after a key move, sizes after a key resize, spoken once the keys rest, and cleared then set, so the same words twice are heard twice (today's `say`, `TokenActionBar.tsx:681-688`). Reset says "Window back at bottom right".
- **Focus after Reset**: Close. After a key step: where it was. After a resize: where it was, scrolled into view if hidden. After a size press: on the button, or on the other one where a press reaches Tiny or Gargantuan and disables it. A window that folds beside a sheet (7.1) hands focus to its Show button in the sheet's header, as the very short mode's fold does.

## 11. Keys and pointer behaviors

The shortcut sheet lists keys and key-with-pointer combinations only, such as Shift with a click or a drag, by the project owner's narrowing of 2026-10-16: no plain click, tap or drag. So this section lists every key and key combination this design adds, changes or removes, in the shape of the sheet's registry (`SHORTCUTS` and `BEHAVIORS` in `client/state/shortcuts.ts`, as the sheet build writes them: input, does, roles, when, device, surface), against the sheet's sections: Keys, then the surfaces. FEATURES.md's Shortcuts tables mirror the registry, and its test fails when they disagree.

**Against the registry as it stands.** The sheet's registry is still being revised in its own build, so its ids, words and sections may have moved by the time this build lands. This build adds and changes its rows against the registry as it stands then, and adds any section it needs that is missing. The ids, words and section names below are the intended rows, not fixed names. As of this draft the registry already names "Dialogs" (`dialogEscape`, `dialogTab`), so "window" there needs no change, and still names "Token action bar", which this build renames **"Token window"**, so the sheet never says "window" for two things.

New and changed rows, all for everyone (`roles: ["dm", "player"]`), all `device: "keys"` but `selectAdd`:

| id | input | does | when | surface | change |
|---|---|---|---|---|---|
| `barEscape` | Escape | Put it back where it was | while you drag its header or resize it | Token window | changed: resizing added, and its section's name |
| `windowMoveKeys` | Arrow keys | Move it 8 px, or 64 px with Shift | with its grip focused | Token window | new |
| `windowResizeKeys` | Arrow keys | Resize it 8 px, or 64 px with Shift | with its corner handle focused, on a computer | Token window | new |
| `escape` | Escape | its words as the registry has them, with "Multi-select" for "Select several" | | | changed: the name |
| `selectAdd` | Shift or Ctrl+click a token (Cmd on a Mac) | Add it to the selection, or take it out, as Multi-select does | with the Select tool | | changed: "as Multi-select does" added. `device: "mouse"` |
| `dialogEscape`, `dialogTab` | | | | Dialogs | unchanged, named here since the Keys intro now points to them. A registry that still says "Windows" there takes "Dialogs" |

- **The Token window section's intro** (`SURFACE_INTRO`): "Where the action bar opens as a window: on a screen 600 px or wider, or a phone on its side. With its grip or corner handle focused, the arrow keys move or resize it and never move a token."
- **The Keys intro** (`KEYS_INTRO`): "They do nothing while you type in a field or a dialog is open." for "a window is open".
- **Any other row of the sheet that names the mode** in its `when`, such as a key-with-click row "with Select several off", says "Multi-select" instead. The Keys section's arrow-key row (`nudge` in `SHORTCUTS`) is unchanged: the Token window intro states its exception.
- **Not in the sheet**, being plain pointer actions: dragging the window's header or grip, dragging its corner handle or edges, and a tap on the grip or the handle, which does nothing. FEATURES.md's action bar line (section 17) describes them.
- **Removed**: no row. Move bar and Reset bar position were buttons.
- **The size change** adds no key and no key combination: its controls are buttons and a field, and a resized creature moves by today's keys and gestures. The stepper's buttons take Enter and Space as every button does, which the sheet does not list.

## 12. Where this meets the designs built beside it

- **docs/design-v1-tool-options.md** (one options row). It names the mode and its bar Multi-select, leaves the rename to this design, and builds after this build's first commit, the rename. Nothing in either depends on the other: the window reads the free area, whatever the options publish into `Chrome.bottom` and `Chrome.controls`. It removes `Chrome.rail`, `noticeSpan`, `hintRoom`, `shortHint` and `LONG_HINT_MIN` from `barDock.ts` and `ScrollForMore`'s `fill`, and this design adds the window's size there and moves `ScrollForMore` into the scroller. Both edit `barDock.ts` and its test, `TokenActionBar.tsx`, `client/state/shortcuts.ts`, `e2e/bardock.e2e.ts`, `reach.e2e.ts`, `layout.e2e.ts`, `playerphone.e2e.ts` and FEATURES.md. Whichever lands second keeps the other's change. Merged into the toolbar at 844 x 390 at 130%, the Multi-select row gives the window a free height of 151 and it docks there instead of opening compact. Section 13's phone rows say which.
- **docs/design-v1-companion-stat-blocks.md** (companions' stat blocks). It makes a placed companion's `size` its owners' through this design's rule, which it cites for every size change. The contract:
  - **Two ops.** The attach sends the link and numbers in one `token.update`, waits for its answer, then sends the size as a resize patch built by `resizePatch`, its own op. A resize patch never carries other fields (8.6, rule 3).
  - **Its preview** is `resizePatch`'s answer: `{ shifted }` for "It moves a little to clear the wall.", `{ refused }` for "No room to grow here.", sent as nothing.
  - **Its reads** are a resize patch's (8.6).
  - **Undo.** The resize goes on the player's undo stack and the attach does not, so Ctrl+Z right after attaching takes back the size alone, as its 5.1 says, and keeps the attached numbers.
  - **Clearance** is one definition, the move rules' standing test (8.3).
  - **The op version**: version 6 shared if both deploy together, else that build takes 7 (8.7).
- **docs/design-v1-token-panel.md**: Stats gains Size, and Token settings loses it (8.10).
- **The shortcut sheet's build** (`openvtt-sheet`): its registry and sections are what section 11 writes into. If this build lands first, it adds the two section renames and its rows to that registry when the sheet build has landed, or that build adds them from section 11.

## 13. Edge cases

### 13.1 By size

The DM's goblin, about 548 px of content at the default width. "Shown" and "hidden" are the side panel's states from 900 px up. Free areas are layout px, less the top bar, the toolbar and 8 px margins, with no tool's options (the Select tool shows none outside Multi-select). A computer's largest window is its free area less the handle's 4 px on each free side (5.3).

| Size and interface size | Layout | Free area | Default window | Stored 600 x 400 | Stored 4096 x 4096 | Smallest |
|---|---|---|---|---|---|---|
| 1280 x 800, 100% | 1280 x 800, wide | 904 x 671 shown, 1264 x 671 hidden | 316 x 548, full layout | 600 x 400, full, scrolls | 900 x 548 shown, 1260 x 548 hidden | 316 x 148, short |
| 1280 x 800, 130% | 985 x 615, wide | 609 x 486, 969 x 486 | 316 x 482, scrolls | 600 x 400 | 605 x 482, 965 x 482 | 316 x 148 |
| 1920 x 1080, 100% | wide | 1544 x 951, 1904 x 951 | 316 x 548 | 600 x 400 | 1540 x 548, 1900 x 548 | 316 x 148 |
| 1920 x 1080, 130% | 1477 x 831, wide | 1101 x 702, 1461 x 702 | 316 x 548 | 600 x 400 | 1097 x 548, 1457 x 548 | 316 x 148 |
| 1024 x 768, 100% | wide | 648 x 639, 1008 x 639 | 316 x 548 | 600 x 400 | 644 x 548, 1004 x 548 | 316 x 148 |
| 1024 x 768, 130% | 788 x 591, phone layout, panels as a sheet on the right | 772 x 462, or 414 with the turn band. With a sheet, 432 wide | 316 x 458 (410), scrolls | 600 x 400, or 428 x 400 beside a sheet | 768 x 458, or 428 beside a sheet | 316 x 148 |
| 900 x 600, 100% | wide | 524 x 471, 884 x 471 | 316 x 467, scrolls | 520 x 400 shown (clamped), 600 x 400 hidden | 520 x 467, 880 x 467 | 316 x 148 |
| 900 x 600, 130% | 692 x 461, phone layout, short | 676 x 332, or 284 if the strip needs a band. With a sheet, 336 wide | 316 x 328 full, or 280 short | 600 x 328, or 280 short | 672 x 328, or 332 beside a sheet | 316 x 148 |
| 1280 x 480 window, 100% | wide, short: the side panel starts hidden | 1264 x 351, 904 x 351 shown | 316 x 347, scrolls | 600 x 347 | 1260 x 347 | 316 x 148 |
| 844 x 390, 100%, touch, 47 px sides and 21 px foot | phone on its side | 734 x 241. With a sheet, 441 wide | 316 x 241, short. No handle, size not applied | not applied | not applied | none |
| 844 x 390, 130%, touch | 649 x 300 | 539 x 151, or 99 with today's Multi-select bar. With a sheet, 246 wide | 316 x 151, short. Compact with today's Multi-select bar, 316 wide, over it. Docked once the options merge (section 12). Beside a sheet, 246 wide: one-row header, the badge under the name (7.1) | not applied | not applied | none |
| 667 x 375, 100%, touch | phone on its side | 651 x 246. With a sheet, 311 wide | 316 x 246, short. Beside a sheet, 311 wide: one-row header, the steady line wraps (7.1) | not applied | not applied | none |
| 667 x 375, 130%, touch | 513 x 288 | 497 x 160, 112 with the band. With a sheet, 189 wide | 316 x 160, short. Beside a sheet, 189 wide: one-row header with the grip's dots, the badge under the name. With the band the sheet is very short and the window folds | not applied | not applied | none |
| 480 x 320, 100%, touch, 47 px sides | phone on its side | 370 x 171. With a sheet, 129 wide | 316 x 171, short. Beside a sheet, 129 wide: folds into the sheet's header (7.1) | not applied | not applied | none |
| 390 x 844, 320 x 480, any | upright | | Spans, as today, Size row inside. At 320 px and 130% (204 inside) Elevation and Size each wrap to two lines | | | |

At every computer's window the header holds the grip, Reset and Close and some of the name on one row (4.1), Conditions, Hidden and Multi-select share a line (3.4), the Size row is one line (8.9), and the whole handle is on the map (5.3). On a computer at 130% the default 316 layout px are 411 screen px, so the steady line holds there as at 100%.

### 13.2 By role

- **The DM**: every control. Resizes are never checked (8.4).
- **A player on their own creature**: the grip, Reset, the handle on a computer, Multi-select, and Size while it is unlocked and not Custom, checked by 8.3 on a scene that blocks moves.
- **A player on another's creature**: the grip, Reset, the handle, Multi-select. No Size.
- **A DM's "view as a player"**: reads this device's spot and size, keeps its window's moves and resizes to itself, and writes neither key. It shows the player's Size controls, and a press there is refused as every op in the preview is (`features/dm/preview.ts:141-144`), so the room's creature keeps its size.

### 13.3 By token and content

- **A monster, a PC played, a player's own, another's, a companion, an effect companion, an object**: rows by 3.4, Size by `canResize`.
- **Passing buttons**: Undo move, Doesn't count or the door on their own line above the steady line, which never moves (3.2).
- **Dead**: Revive and its line sit above the HP field, so in the smallest window Apply needs a scroll, while Revive, the control that applies, is in view (as the token panel design accepts at 130%).
- **Dying**: death saves come after the HP entry, so Apply's reach holds.
- **HP-less**: no HP entry. The short layout changes nothing for it.
- **A long name**: two lines in the header at any width, the name giving way first at 265 px. Beside a sheet at 189 px it keeps 47 px, where "Goblin 1" reads "Gob…" over "1": lines break only between words, and a word too long for its line ends in an ellipsis. The title's text and the window's name ("Goblin 1 actions") keep the whole name for a screen reader.
- **An elevation badge**: up to "↑120 ft" keeps the name's 40 px floor at 265 px. Longer, the name gives way. Under 265 px it moves under the name (7.1).
- **Light shown**: follows the steady line, on it where room is left (3.4).
- **Custom size**: a read-only size row in the window and in Stats for its owners, "set by the DM". The DM edits it in Stats.
- **Tiny**: half-cell spots (8.2). Its size row disables "One size smaller". A Tiny grown and shrunk on the same device, unmoved, returns to its quarter.
- **Squeezed**: its middle is the full footprint's. A resize clears the squeeze.
- **At the scene's edge**: the base spot moves inside the scene. An owner's growth candidates lie inside it.
- **Locked**: no owner Size, read-only in Stats.

### 13.4 By lifecycle

- **A stored size larger than the area**: clamped for this opening, kept stored, Reset shown (section 7).
- **The side panel opened and hidden**: the window shrinks and grows back.
- **A sideways sheet opened on a phone**: the window narrows with the free area, its header keeping one row or the window folding by 7.1, and comes back whole when the sheet closes or hides.
- **The lane sharing**: stacked, beside and summary as 9.1, the cap after them, the handle's reach kept.
- **A fight starting**: the band and the cards (section 7). A resize during a turn appends an uncounted resize stop, keeps every earlier leg's feet and diagonals, and may remind of an area entered (8.5, 8.7).
- **A resize after counted moves, diagonals or Tiny half-cell moves**: those legs keep their feet and the diagonal count runs on (8.7).
- **Rotation**: a touch device keeps today's sizes. A computer's free area changes as for a resize.
- **An interface size change**: clamped in layout px. The default width is re-measured in layout px and is the same.
- **A browser minimum font size or a font that loads late**: the hidden buttons grow, the ResizeObserver re-measures, and windows with no stored width take the new default.
- **A sheet opening**: on the right, the free area narrows. Upright or very short, the window folds and keeps its size and scroll.
- **Compact and short**: compact ignores the size. Short follows the clamped capacity.
- **A resize while alerts arrive**: the lane applies on release.
- **The window's token deleted mid-drag**: the drag ends, nothing stored.
- **A drag to the room's top**: no height stored, the window grows with its content again.
- **Storage blocked**: the spot and size last the page.
- **A size change refused by the server** (an unseen wall): the predicted footprint goes back, and the toast says "No room to grow here." or "A wall is in the way."
- **Grown, then shrunk on the same device without moving**: back to the square it grew from. With a move, another device's change, an undo or a reload between: the base rule (8.2).
- **Undo and redo of a resize**: the size and place together, keeping damage and conditions dealt since. A move or resize since refuses the undo. A redo of a growth is checked again. A token given to another player since refuses both, even where the first player may still move it.
- **A resize in a turn seen by others**: owners and other players get each stop's size, on the server's answer, in a snapshot and after a reconnect, so the trail and its feet read the same for all (8.7).
- **A turn at the 50-stop limit with resizes in it**: compaction never joins a leg across a resize while an eligible corner remains, and measures a joined leg between middles once none does (8.7).
- **Two devices of one player**: each keeps its own window size and its own growth memory. The creature's size is the room's, on both.
- **A replayed room**: a version 5 size and place update replays with its counted stop, a version 6 one with its resize stop (8.7).

## 14. Mockups

The DM's goblin docked at its default spot on a computer, 316 px. `::` is Move window, `o` the Resize window handle at the top left:

```
o----------------------------------------+
| ::  Goblin 4                       [X] |
| (15) HP 10/10  Speed 30 ft             |
| Passive Perception 9                   |
| [Damage][Heal][ Set ][Temp]            |
| [7 or -7                   ] [Apply]   |
| Saves Str -1 Dex +2 Con +0 Int +0 ...  |
| [Stat block] [Details]                 |
| Elevation             [-5]  0 ft  [+5] |
| [Conditions] [Hidden] [Multi-select]   |
| [Light]                                |
| Size                  [-] Medium  [+]  |
| [Locked] [Duplicate] [Delete]          |
+----------------------------------------+
```

The same goblin just after the DM moved it in a fight: the passing line leads, and the steady line stays as it was:

```
| [Undo move] [Doesn't count]            |
| [Conditions] [Hidden] [Multi-select]   |
| [Light]                                |
```

The same window shrunk to 316 x 220 and moved up from the toolbar, so Reset shows. It takes the short layout and scrolls under its header:

```
o----------------------------------------+
| ::  Goblin 4                  [<>] [X] |
| (15) HP 10/10                          |
| [7 or -7                   ] [Apply]   |
| [Damage][Heal][ Set ][Temp]            |
|            Scroll for more             |
+----------------------------------------+
```

`[<>]` is Reset window position and size. Where the handle stands by the window's corner:

```
spot top left      the handle at the bottom right
spot top right     the handle at the bottom left
spot bottom left   the handle at the top right
spot bottom right  the handle at the top left (the default)
```

A phone on its side at 844 x 390 at 130% with a side sheet open: the window is 246 px wide, so its badge moves under the name, with Reset counted:

```
+----------------------------+
| :: Goblin 4       [<>] [X] |
| (15) HP 10/10  ↑10 ft      |
| [7 or -7         ] [Apply] |
| ...                        |
+----------------------------+
```

Thorn, Pat's druid, in the top-left corner of a room on a scene that blocks moves, grown from Medium to Huge with "One size larger" twice. The base spot, centered on his square, would put his core over both walls, so he grows right and down. Shrunk back on the same device without moving, he returns to his square:

```
  before, Medium          after, Huge
  +===========            +===========
  | T .  .  .             | T  T  T  .
  | .  .  .  .            | T  T  T  .
  | .  .  .  .            | T  T  T  .
```

A player's own creature on a phone held sideways, short, with its Size row after a Wild Shape to Large:

```
+----------------------------------+
| ::  Thorn                    [X] |
| (16) HP 31/38 +5                 |
| [                    ] [Apply]   |
| [Damage][Heal][ Set ][Temp]      |
| [More stats                   v] |
| [Open the sheet] [Details]       |
| Elevation       [-5]  0 ft  [+5] |
| [Swap image]                     |
| [Conditions] [Multi-select]      |
| [Light]                          |
| Size            [-] Large   [+]  |
+----------------------------------+
```

## 15. Tests

Unit tests, `node:test`:

- `client/canvas/barButtons.test.ts`: `passing` holds Undo move, Doesn't count and the door, `play` Conditions, Hidden, Multi-select, then Request a roll and Light, for each viewer of 3.4, and no `moveBar` or `resetBar`. `docked` and `moved` leave the input. `barCapacity` and `barShort` with a cap: 299 short, 300 not, a cap above the room leaves the room deciding, a touch device's null cap, and compact ignoring it.
- `client/canvas/barDock.test.ts`:
  - `defaultWidth` from given button widths: 304 for narrow ones, 316 for the macOS widths, 321 for Tahoma's, rounding up plus one.
  - The size key: valid, width only, height only, missing, bad JSON, `{}`, a fraction, a negative, zero, over 4096 and a string. The default stored as no key. A throwing storage.
  - `placeBar` with a width, cap and resizable flag: the width clamped from the default width to the room, the cap after the spot and after the lane (stacked, beside, summary), a bottom-anchored window moved down by the lane keeping `min(content, cap)`, compact ignoring both. The handle's reach: a resizable window's free sides 12 px from the free area's edges and from a stacked first card, its anchored sides 8, and none of it for a touch device. `restingBar` with them.
  - `resizeBox` for each corner, by the handle and by each band: the anchored edges fixed, the limits (the default width, 148, the room, the content).
  - The release: an unchanged dimension keeping its stored value (a clamped stored width included), the default width snap at 24 and not at 25, the height snap to no cap, the spot from the drawn box keeping its corner, both defaults stored as no key.
  - Key steps: 8 and 64 px, clamped, unsnapped, the nearest corner for a move and the kept corner for a resize.
  - The spot's words at a corner, an edge and neither, and the size's words with each limit.
  - `barCover`: a window against the right edge wider than the lane covers from its left, a narrower one covers the lane, one elsewhere picks the largest clear rectangle, and the lane's existing cases hold.
  - The narrow header of 7.1: the badge in the header at 265 and under the name at 264, a touch device's grip a button at 210 and its dots at 209, a computer's a button at any width, and Reset counted though hidden.
- `client/pages/fold.test.ts`: `foldsUnderSheet` folds a docked window beside a side sheet under 182 px and not at 182.
- `shared/rules/resize.test.ts`, new:
  - `resizeBase` between every pair of the six sizes from whole and half cell positions: growing covers the old footprint, shrinking lies inside it, ties go to the old top-left, Small and Medium keep their place, Tiny on half cells, a Custom odd width taking the nearest middle, and the scene's edge moving it inside.
  - Growing: no wall (the base), a wall on each side, a corner (Huge grows away from both), round 1's short wall (Gargantuan to (3, 2), not (4, 3)), a 5 ft corridor to Large (none), a 10 ft corridor to Large (fits) and to Gargantuan (none), closed and locked doors counting, an open door not, an unfound secret door counting, a window and a pillar counting, a ground walker beside a 10 ft ledge and a flier above it, the ranking by distance from the current middle with its ties, a squeezed token's middle, and the candidates containing the old footprint and lying inside the scene. Round 2's two cases (a Large to Huge between two pairs of short walls) say "No room to grow here", and never offer (5, 4). For every growth the search allows, in every case above, the remembered return and the undo's footprint lie inside the grown footprint and pass rule 4.
  - Shrinking: the base when clear, a free wall at x 4.375 sending a Medium's Tiny to (4.5, 4), a remembered square taken, a remembered square refused by a wall drawn since across the middle's path and the search taking the next, and a wall through the old middle refusing every candidate.
  - Keeping its size: no change of place.
- `client/features/tokens/resizeMemory.test.ts`, new: a growth remembered, a shrink to its starting size back to its place, Medium to Large to Huge then Huge to Medium back to the Medium's square, Huge to Large back to the Large's place, and the list dropped after a move, an undo, another device's resize and a reload. A Tiny's quarter kept.
- `shared/permissions.test.ts`, a new describe for `resizeCheck`: an owner may, a non-owner gets "that is not yours" (one who may move any token too), a locked token "that token is locked", Custom asked or a Custom token refused, `w` or `h` refused, a mixed patch refused, a same-size patch with another `x` or `y` refused, a growth's spot off the grid, outside the scene, or holding the middle but not covering every old square refused, a shrink's spot outside the current footprint refused, a blocked growth on a scene that blocks moves refused with "No room to grow here.", a shrink crossing a free wall at a quarter cell refused with "A wall is in the way.", the same allowed on a scene that does not block moves, a companion's owner judged the same through `companionUpdateCheck`, and the DM never refused. Each crafted case runs on the client's check too, so the device sends none of them. `restorePoseCheck`: a restore that keeps the size passes and fails exactly as `restoreMoveCheck` does today, the owner's in-place restore of elevation or facing on a locked token included, and today's tests (`shared/permissions.test.ts:255-279`) run unchanged against it. A restore that changes the size passes only for the token's owner now, on an unlocked token that is not Custom, judged as a resize to that footprint. It is refused for any field outside the pose and the size, on a locked token, and after the DM gives the token to another player with `playersMoveAny` on, for the undo and for the redo alike. `onPlayerUndoStack` takes a resize patch and not a patch with another field.
- `server/rooms/undo.test.ts`: a resize, then damage, then undo: the size and place come back and the damage stays. Redo grows it again. A move or another resize between refuses the undo with "it was moved or resized since". A wall drawn between a growth and its redo refuses the redo. The token given to another player, with `playersMoveAny` on, before the undo and before the redo, refuses each with "that is not yours".
- `shared/rules/path.test.ts`: `stopsForOwners` and `stopsForNonOwners` keep every kept stop's `footprint`, and a non-owner's view that drops an unseen stop keeps the others' sizes. `withStop` at 50 stops drops the oldest eligible corner, whose legs lie at one size, never a resize stop or the stop before it, the joined stop keeping its `footprint`. With 25 pairs of a move and a resize after the turn's start (51 stops, no eligible corner left), it drops the oldest corner and measures the joined leg between the two middles.
- `shared/reducer` tests: a resize patch applied with its spot, the squeeze cleared, an attached emanation following, and an "enter" reminder for a creature that grows into an area. On the acting creature's turn: a resize after counted moves writes the old size into every earlier stop's `footprint` and appends an uncounted resize stop, leaving the earlier stops' places and marks as they were, its feet this turn unchanged (15 ft stays 15 ft, as in round 1's case), a diagonal before and after the resize counted 5 then 10, and a Tiny's half-cell legs then a growth keeping their feet.
- `shared/reducer/opVersion5.test.ts`, new, and its fixture: a version 5 `token.update` with a size and a place on the acting creature replays with its counted stop, the same op at version 6 with the resize stop, and every earlier fixture replays unchanged.
- `client/features/measure/movement.test.ts`: `movedFeet` measures each end at its own stop's footprint, so a Tiny's half-square leg reads 2.5 ft after it grows to Medium. `turnTrail` draws each stop at its own size, the resize leg faint and not counted, and `from` at the size the turn began at.
- `shared/rules/movement.test.ts`: after a resize, the next leg judged at the new size, a DM's footprint grown over a wall stepping off only toward its middle's side.
- `server/rooms/undoLabels.test.ts`: "resizing Thorn to Large".
- `client/features/tokens/resize.test.ts`, new: `resizePatch` for the DM (the base spot, Custom's `w` and `h`), for an owner on a scene that blocks moves (the search, `shifted`) and does not (the base), the refusals' words, and the remembered square. `baseSize` for a PC, a linked room monster, an SRD monster before and after its block loads, "Medium or Small", a companion's block, and none. `canResize` by role, lock and Custom.
- `client/state/shortcuts.test.ts`: an arrow key whose default is prevented runs no nudge. The registry holds section 11's rows in the "Token window" and "Dialogs" sections, every "Multi-select", and the new Keys intro, and FEATURES.md's tables agree.

e2e, one file after another as docs/design-v1-visual.md 5.3 says:

- `e2e/bardock.e2e.ts` (E2E_PORT plus seven):
  - Test 3: a press of the grip that moves under 8 px, and one on the name, each move nothing and store nothing. Its last step presses "Reset window position and size".
  - Test 4 becomes the grip's keys: from the frame, Tab reaches Move window first. ArrowLeft three times moves the window 24 px left, the selected token's place on the server does not change, the key stores `{"corner":"br","x":24,"y":0}`, and the status says "Window at the bottom edge, 24 pixels from the right" once. Shift and ArrowUp move 64 px. A held key moves it to its room's edge and no further. Enter and Space change nothing. Reset is absent at the default, left of Close at one top, its tooltip its name, and a press removes both keys, brings the window home, focuses Close and says "Window back at bottom right". A reload, 1024 x 768 and 130% keep a stored corner, as today's test 4 does.
  - Tests 8 and 13: "Multi-select".
  - New, the rows: at 1280 x 800 and 1024 x 768, at 100% and 130%, with no stored size, the window's width is the measured default within 1 px, and on the DM's goblin Conditions, Hidden and Multi-select share one top. After moving the goblin, Undo move and Doesn't count share a line above them, and the three keep their top as before. On Thorn for the DM, Request a roll starts the next line. On Pat's Thorn, Conditions, Multi-select and Light share one. With a browser minimum font size of 16 px (the profile preference `webkit.webprefs.minimum_font_size`, in a persistent context), the window is wider and the three still share one top.
  - New, resizing with a mouse: the handle stands at the corner opposite the spot's at each of the four corners. A drag of the top-left handle to 400 x 300 stores `{"w":400,"h":300}`, the scroller scrolls, the header's top stays at the window's top when scrolled to the foot, and "Scroll for more" shows. A drag to 400 x 250 takes the short layout with the HP field and Apply inside the scroller's view at `scrollTop` 0. A reload, another token's window and the group window open at 400 wide. The top band changes only the height and the left band only the width. A press of the handle that moves under 8 px changes nothing. Escape mid-drag puts the size back and stores nothing. A drag to the room's top stores `{"w":400}`, and a drag back within 24 px of the default width stores no key. A drag narrower than the default stops at it. On the focused handle, ArrowLeft widens by 8 and Shift with ArrowUp heightens by 64, stored, and no token moves. On a touch tablet context (820 x 1180) there is no "Resize window" and no band, and a stored `{"w":600,"h":200}` is not applied and shows no Reset.
  - New, the handle's reach: at 1280 x 800 with `{"w":4096,"h":4096}` stored, at each of the four corners, with the side panel shown and hidden, and stacked under a concentration card, the topmost element at the disc's center and at its four extreme points, and at each band's middle, is the handle or its band.
  - New, a smaller room: `{"w":1100,"h":700}` at 1280 x 800 with the side panel hidden draws 1100 wide. S shows the side panel and the window is its room's 900, the key unchanged. S again, 1100. At 130% the same key draws 605 x 482, with Reset shown. In a fight with three concentration checks, the window and the cards never meet at the default spot with the stored size, after a resize dropped on the column, and at the smallest size.
  - New, the computer's reach sweep, one page per side resized between steps, misses collected as in `e2e/reach.e2e.ts`: 1280 x 800, 1920 x 1080, 1024 x 768 and 900 x 600 at 100% and 130%, the side panel shown and hidden where it exists, a stored size of none, the smallest and `{"w":4096,"h":4096}`, the DM on a goblin and on Thorn and Pat on Thorn, without a fight and with three checks and a roll card, and at 1024 x 768 and 900 x 600 at 130% with a sheet open on the right. Each time: the window inside its room, Move window, Reset where shown, Close, Resize window and the Size buttons whole on screen and each the topmost element at its center, no horizontal scroll in the scroller, and in the smallest window the HP field and Apply in view without scrolling.
- `e2e/reach.e2e.ts`: the tool "Multi-select", and Move window whole in reach beside Close wherever the bar docks. New side-sheet steps with the window moved off its spot (Reset shown), with and without an elevation badge: at 667 x 375 at 100% (311 px, the whole row), 844 x 390 at 130% (246 px, the badge under the name) and 667 x 375 at 130% (189 px, the grip's dots too), the header in one row with the name broken only between words, the HP field and Apply in view at once with Apply's label clear of "Scroll for more", Move window or its dots, Reset, Close and the Size buttons whole in reach and no horizontal scroll, and at 480 x 320 at 100% the window folded with "Show Goblin 4 actions" whole in the sheet's header, its tap bringing the window back with focus on its frame.
- `e2e/tokenpanel.e2e.ts`: test 1's rows read Conditions, Hidden, Multi-select, and Locked, Duplicate, Delete, with Multi-select on Conditions' top. Its `scrollTop` reads (`:207`, `:867`) read `[data-bar-scroll]`. New, sizes:
  - The DM steps a goblin Medium to Large to Huge from the window, its footprint's middle kept, and back to Medium on its own square. Stats holds Size with Custom and "Back to Medium" for a Large goblin. Token settings has no Size. A Custom goblin's window shows "Custom, 2 by 3 squares".
  - Pat grows Thorn in a walled corner of a scene that blocks moves: Huge grows right and down with its core clear of the walls. Shrunk back to Medium without moving, he is on his own square. In a 5 ft corridor, Large says "No room to grow here." and nothing changes. Ctrl+Z after a growth and a hit the DM deals puts Thorn back to Medium where he stood with the damage kept. A drag after a resize is judged at the new size. On a scene that does not block moves, Huge takes the base spot. Pat's locked token shows no Size row and a read-only size in Stats. Pat's Custom token shows "Custom, 2 by 3 squares, set by the DM" in both.
  - In a fight, Thorn moves 15 ft, grows to Huge on his turn, and his trail still reads 15 ft, its earlier legs drawn at Medium's size and the resize leg faint: for Pat once the server answers, for the DM, for another player who saw him move, and again on Pat's page after a reconnect. A Tiny familiar's half-square move, then its growth to Medium, still reads 2.5 ft for its owner and for the others.
  - At 844 x 390 with insets, and 320 x 480 at 130%, the Size row's buttons take a tap with no horizontal scroll, the narrow one wrapped to two lines.
- `e2e/fold.e2e.ts` test 15: Reset's new name for Reset bar position, and the grip's keys for Move bar.
- `e2e/playerphone.e2e.ts`, `e2e/layout.e2e.ts` and `e2e/dmphone.e2e.ts`: "Multi-select" for "Select several". dmphone 7's loop presses every button in the bar, now including Move window, which does nothing on a tap, so the loop needs no change.
- `smoke`, `table`, `regress`, `tools`, `rolls`, `vision` and `combat` run unchanged.

## 16. Build plan

One part in one workspace, from main at `e4ec8696` or later. Each commit typechecks, passes the unit tests and builds, and its e2e edits ride with it. The shortcut sheet's registry rows and FEATURES.md's lines go with the commit whose behavior they describe.

1. `feat(tokens): select several is named multi-select`: the names of 3.1 in `client/canvas/TokenActionBar.tsx`, `client/canvas/barButtons.ts` and its test, `client/panels/TrackerPanel.tsx`, the comments of 3.1, the names in every e2e file of section 15, the "Multi-select" rows of section 11 in `client/state/shortcuts.ts`, and FEATURES.md's names. Small, so the tool options build can start after it.
2. `feat(tokens): conditions, hidden and multi-select keep one line in the token bar`: the passing and steady lines in `barButtons.ts` and `TokenActionBar.tsx`, `defaultWidth` from the hidden buttons (`client/pages/Room.tsx` draws them, `barDock.ts` takes the width), the slot, `placeBar`'s width, `compactHang`, FEATURES.md's buttons line, and the rows e2e step.
3. `feat(tokens): the token window moves by its grip and resets from its header`: `client/components/SheetHeader.tsx` (`PaneHeader`'s grip button, its drag, the narrow header's stacked form), `client/components/Icon.tsx` (`grip`, `windowHome`), `TokenActionBar.tsx` (the grip's keys, Reset in the header, the narrow bands, `PlaceButtons`, `MoveBarButton` and `ResetBarButton` removed), `barDock.ts` (statuses and words, `nextCorner` removed), `client/pages/fold.ts` (the narrow fold), `client/state/shortcuts.ts` (the "Token window" section, "Dialogs" where the registry still says "Windows", `barEscape`, `windowMoveKeys`, the two intros, against the registry as it stands, section 11), FEATURES.md, e2e bardock 3 and 4, fold 15 and reach's side-sheet steps.
4. `feat(tokens): resize the token window on a computer, remembered on this device`: the frame and scroller split, the handle and bands, the handle's reach in `placeBar` and `shareLane`, `rvtt.tokenBarSize`, placement with the cap, `barCapacity`, `barCover`, `restingBar`, scroll padding, the reveals, the mode buttons kept mounted through a flip (`client/features/tokens/HpSection.tsx`), the group's `fieldFirst` (`GroupHpEntry.tsx`), `client/lib/device.ts` (`isFinePointer`), `client/canvas/Stage.tsx` (the cover's right edge, the resting size), `windowResizeKeys` in `shortcuts.ts`, FEATURES.md, the unit tests and bardock's resizing, reach, smaller-room and `scrollTop` steps.
5. `feat(rules): where a resized creature stands, checked like a move`: `shared/rules/resize.ts` and its test, `resizeCheck` and `restorePoseCheck` in `shared/permissions.ts` (`companionUpdateCheck` handing size patches over), `isResizeOp` and `onPlayerUndoStack` in `shared/protocol.ts`, `Pose` with a size and `poseRestore` in `server/rooms/undo.ts`, the resize's poses in `server/rooms/actor.ts`, the resize stop in `shared/reducer/tokens.ts`, `PathStop.footprint` in `shared/model.ts` and `server/rooms/stateSchema.ts`, `plainStop` and `withStop` in `shared/rules/path.ts`, `OP_VERSION` 6 and `resizeStop` in `shared/migrate.ts`, `server/rooms/undoLabels.ts`, `movedFeet` and `turnTrail` in `client/features/measure/movement.ts`, and their tests and the version 5 fixture.
6. `feat(tokens): change a creature's size from its token window and its stats`: `client/features/tokens/resize.ts` (`resizePatch`, `baseSize`) and the growth memory in the Room scope with their tests, `access.ts` (`canResize`), the Size row and the stepper-row wrap in `TokenActionBar.tsx`, Size in Stats and out of Token settings in `client/panels/TokenPanel.tsx`, the group's More per token in `GroupMoreSheet.tsx`, FEATURES.md, the tokenpanel e2e sizes step.
7. `test(e2e): the token window's reach on a computer at every size it opens at`: bardock's sweep.
8. `docs: point the bar dock, token panel, layout and visual designs at the token window`: status lines in docs/design-v1-bar-dock.md (sections 1.2, 1.4, 2, 4), docs/design-v1-token-panel.md 3.3, docs/design-v1-layout-hierarchy.md 3.5 and 4.2, docs/design-v1-visual.md 3.2's token bar row, and docs/design-v1-heights-readout.md's "Select several".

Files the builds beside it also edit are listed in section 12. Whichever lands second keeps the other's change.

**Deploy.** Nothing to run. The first op after it is stored at version 6. Rolling back needs the backup taken before the update (8.7).

## 17. FEATURES.md

In "Phones, tablets and connection":

- The line that begins "Tapping a token opens its action bar" becomes: "Tapping a token opens its action bar. On a screen 600 px or wider, or a phone on its side, it opens as a window at the bottom right of the map instead of under the token. Drag it by its header, or by the grip at the header's start ("Move window"). With the grip focused, the arrow keys move it, and Shift moves it further. On a computer, drag the round handle at its free corner, or an edge beside it, to resize it ("Resize window"), and with the handle focused the arrow keys resize it. It scrolls inside when it is smaller than what it holds. This device remembers the spot and the size for every token's window, and the reset button left of Close ("Reset window position and size") puts both back. Beside a phone's sideways sheet it narrows, and where it would be too narrow it folds into the sheet's header. "Fit the map" keeps the map out from under it. On a phone held upright it spans the screen under the token. On a screen too short for either, it opens taller, over the Multi-select bar and if need be the toolbar. Close it to reach the toolbar again."
- In the summary line, "On a phone held sideways, or a screen too short for the whole bar" becomes "On a phone held sideways, a window made shorter than 300 px, or a screen too short for the whole bar".
- The buttons line becomes: "The action bar's buttons come in rows. Undo move, Doesn't count and the door lead on a line of their own when they apply. Then come Conditions, Hidden and Multi-select, always together on one line, then Request a roll and Light. The last row holds Locked, Duplicate and Delete for the DM, or Dismiss for a companion's player."
- The one-row tools line: "Select several" becomes "Multi-select".

In "Tokens", after the line on what each token has:

- "The DM and a creature's owners change its size on the fly, for Enlarge or Reduce, a Wild Shape or a polymorph: Size in its action bar, below Conditions and Multi-select, steps it one size larger or smaller, and Size in its Stats picks any, with "Back to Medium" where its character or stat block gives its own size. The creature keeps its middle and its elevation, and its height, reach rings and attached areas follow. Shrunk back on the same device before it moves, it returns to the square it grew from. On a scene where walls stop moves, a player's resize is checked like a move: the creature never crosses a wall, and grows over the squares it filled into the room around them, away from walls the least it must, or keeps its size with "No room to grow here". The DM's changes are never stopped. A size change undoes as one step, keeping damage dealt since, and counts no movement. The DM alone sets and changes a custom size, and a locked token keeps its size for its players."

In "Several tokens at once":

- "Select several with Shift or Cmd and a click, with the "Select several" button, or with a box drag." becomes "Select several tokens with Shift or Ctrl and a click (Cmd on a Mac), with "Multi-select" in a token's action bar or the Initiative panel, or with a box drag."
- The next line: "Select several" becomes "Multi-select" three times, and "the Select several bar" becomes "the Multi-select bar".

In "Rolls": "such as the Select several bar" becomes "such as the Multi-select bar".

In the Shortcuts section, the sheet build's tables, mirrored from the registry: section 11's rows, the "Token window" and "Dialogs" headings, the Token window intro, and the Keys intro's "a dialog is open".

## 18. Decided, for the project owner to overrule

By the project owner (2026-10-16):

1. The grip only drags and the handle only resizes. A tap, Enter or Space on either does nothing. The keys move and resize, and Reset is the single-pointer way back. No single-pointer move or resize remains (SC 2.5.7), accepted.
2. A shrink returns a creature to the square it grew from while it has not moved since: remembered by the device that grew it, for that page.
3. Undo move, Doesn't count and the door lead on a line of their own, so Conditions, Hidden and Multi-select are always one line.
4. "Grow away from walls": a player's resize is checked like a move, the DM's never.

By default, with the reason in the section named:

5. "Multi-select" everywhere the mode is named, the tracker's switch and the shortcut sheet included (3.1).
6. Request a roll follows Multi-select, so it never splits the steady line (3.2).
7. The default width is measured from three hidden buttons in the page, so the browser's font settings count, 316 px on macOS, on every docked window, phones on their side included (3.3). Rejected: keeping 304, where renaming alone still wraps by 10 px.
8. A computer's window is never narrower than the default width, so the steady line always holds there (5.6).
9. Reset is an icon in the header left of Close, resetting spot and size, with focus to Close. Its icon is a frame with its corner filled and an arrow toward it, unlike Undo's (4.1).
10. Resizing only on a computer (a fine main pointer, read once per page) where the window docks. Touch keeps today's sizes and ignores a stored size (5.1).
11. The height is a cap, never a fixed height, so the window never shows empty space (5.2).
12. The handle sits at the corner opposite the window's corner, with the two edges beside it, 24 px, a fine pointer's only, and every limit keeps it whole (5.3).
13. One stored size for every token window on the device, single and group (5.2).
14. A width near the default stores none, and a height near the most it may take stores none (5.4).
15. A token's window opens scrolled to its top. The group window keeps its scroll (5.7).
16. A window under 300 px tall takes the short layout, and the group window's HP entry puts Apply first when short (5.8).
17. Beside a sideways sheet a narrow window keeps its header in one row, the badge moving under the name from 264 px down and a touch device's grip drawn as dots from 209, and folds into the sheet's header under 182 (7.1).
18. The shortcut sheet's "Token action bar" becomes "Token window", and its dialogs' section is "Dialogs", as the registry already names it (section 11).
19. Who changes a size: the DM and the token's owners, companions included, the six sizes for owners and Custom for the DM alone. A locked token takes no owner's resize (8.1).
20. It is the token's size, not the character's or the stat block's, with "Back to" the base in Stats where one is known (8.8).
21. The footprint keeps its middle, growing over its old squares and shrinking into them, ties to the old top-left (8.2). An owner's growth must cover every square the creature filled, so its undo and its remembered return always land inside it (8.3, the review's decision of round 2).
22. Clearance is the move rules' standing test, so a resize and a move agree on where a creature may stand (8.3).
23. A resize goes on its maker's undo stack, a player's included, takes back the size and place alone, and counts no movement, every path stop keeping the size it was made at. An undo or redo that changes a size needs the rights of a resize at that moment, and one that keeps the size keeps today's rule, the owner's in-place undo on a locked token included (8.7).
24. In the window, Size is a stepper after the steady line and before the less-used buttons, not in the vitals or the button rows, by the project owner's answer to W5B-P-2. In the panel, Size moves from Token settings to Stats (8.9, 8.10).

## 19. Questions for the project owner

None. The project owner's answers of 2026-10-16 settle every question round 1 raised, and each default above has its reason in the section it names.

## 20. Self-review

### 20.1 Round 1, item by item

- **Grip and handle drag only** (the project owner's answer 1, PDW-P-4): the grip's corner press and the handle's smallest toggle are gone, a short press does nothing, Enter and Space do nothing, and SC 2.5.7 is recorded as accepted with Reset as the way back (4.1, 4.2, 4.4, 5.4, 5.5, 10).
- **Shrink returns to its spot** (answer 4, PDW-P-7, DW5-ASTRA-07, W5-DATA-09): the device's growth memory, with the guarantee stated as exactly what it covers, and the Tiny quarter (8.2, tests).
- **Passing buttons on their own line** (answer 6, PDW-P-10): the passing line and the steady line, Request a roll after Multi-select, and a computer's window never narrower than the default (3.2, 3.4, 5.6).
- **Clearance is the movement core** (the review's decision on W5-DATA-05): one definition, and the 5 ft corridor now refuses a Large (8.3).
- **Every owner resize is checked** (W5-DATA-01, DW5-ASTRA-02): same-size patches keep their place, a shrink never crosses, with its own search on the original side, and the crafted patches are tested on client and server (8.3, 8.6).
- **The growth search ranks from the current middle** (DW5-ASTRA-06): round 1's short-wall case is a worked example and a test (8.3).
- **A resize's relocation is not movement** (DW5-ASTRA-03, W5-DATA-02): an uncounted resize stop with the earlier size, earlier legs untouched, the trail drawn by the size in force, and tests after moves, diagonals and Tiny moves (8.7).
- **Undo of a resize** (DW5-ASTRA-04): `Pose` with a size, `poseRestore` putting back size and place alone, its check, redo judged as a resize, and the tests (8.7).
- **The op version** (DW5-ASTRA-05): version 6, the gate, the fixtures and rolling back, shared with the companion build when they deploy together (8.7).
- **The handle never clips** (DW5-ASTRA-09, W5-DATA-07): the handle's reach of 12 px on the free sides in placement, clamps and the lane, and the whole-target test at every corner (5.3, 15).
- **Narrow windows** (W5-DATA-04): the three bands, the stacked header, the fold beside a sheet, and the side-sheet reach steps (7.1, 15).
- **The resize contract with the companion doc** (PDW-P-2): two ops, the preview, the reads, the undo outcome (8.6, 12).
- **"Back to Medium" out of the window** (PDW-P-8): Stats only (8.8, 8.9).
- **A Custom token** (PDW-P-9): read-only "set by the DM" for its owners in both places (8.1, 8.9, 8.10).
- **The default width from page buttons** (PDW-P-15): three hidden buttons, re-measured on change (3.3).
- **Shortcut rows** (PDW-P-3): the registry's shape and sections, the two section renames, the sheet's Ctrl and Cmd words, and keys and key combinations only, with the plain header and handle drags left out, by the project owner's narrowing (section 11).

### 20.2 Round 2, item by item

- **Resize history through projection and compaction** (DW5-ASTRA-03, W5-DATA-10): every stop keeps the footprint it was made at (`PathStop.footprint`, written back onto earlier stops at a resize), `plainStop` copies it for owners and non-owners, compaction never joins a leg across a resize while an eligible corner remains, and distance reads each stop's own size as drawing does. Tests for both views after the server's answer and a reconnect, and at the 50-stop limit (8.7, 13.4, 15).
- **A growth covers the old footprint** (DW5-ASTRA-11, W5-DATA-12): an owner's growth candidates contain every square, or quarter for Tiny, the creature filled, so the remembered return and the undo of a growth always lie inside the grown footprint. Rule 4 says so. Both reviewers' cases are worked examples that now say "No room to grow here", and a test checks every allowed growth's return and undo against rule 4 (8.2, 8.3, 8.6, 15).
- **A restore that changes the footprint needs resize rights now** (DW5-ASTRA-12, W5-DATA-11): ownership now, unlocked, not Custom, then rules 4 and 5. A restore that keeps the size keeps today's `restoreMoveCheck` whole, the owner's in-place undo on a locked token included (round 3, DW5-ASTRA-13 and W5-DATA-14). Tests with the token given to another player and `playersMoveAny` on, before the undo and the redo (8.7, 15).
- **The shrink claim** (PDW-P-21): the not-crossing sweep reaches the new spot, which is why a shrink needs no standing test of its own. The false "its core lies inside the old core" is gone (8.3).
- **Registry references** (W5-DATA-13): the build writes against the registry as it stands, adds missing sections, and treats the ids here as intended rows. `dialogEscape` and `dialogTab` in "Dialogs" replace the old ids (section 11).

- **Round 3** (DW5-ASTRA-14, W5-DATA-15): compaction's fallback is defined by what remains, no eligible corner, not by a count of resizes, and its fixture is 25 pairs of a move and a resize (8.7, 13.4, 15).

### 20.3 Swept again

Every row of section 13 that these changes touch was worked again:

- **Widths.** The largest windows lose 4 px on each free side to the handle's reach (13.1). The smallest is the default width by 148. The side-sheet rows give each phone's narrow window its band (one row at 311, stacked at 246 and 189, folded at 129), all with Reset and a badge counted.
- **Rows.** Every viewer and token of 3.4 keeps the three on one line at the default width, and only a phone beside a sheet wraps them.
- **Size.** The corner, both short-wall cases, the corridors, the free wall and the crafted patches each have one outcome by 8.3 and 8.6, the same on the device and the server. With growth bound to the old footprint, the corner and round 1's short wall keep their spots, since for a one-square creature "covers its square" and "holds its middle" pick the same spots, and round 2's two Large cases change from a shift to "No room to grow here". The DM's resize is never refused. A shrink finds a spot on the creature's side except where walls inside its footprint cut every candidate off, and then says "A wall is in the way.". A remembered return and an undo of any allowed growth always pass rule 4.
- **Fight and undo.** A resize after any moves keeps the turn's feet and diagonals, the trail and its feet read every stop at its own size for owners and others alike, after a reconnect and at the stop limit, and an undo keeps damage dealt since. An undo or redo that changes a size needs the token's owner, as a resize does.
- **Classes fixed in drafts 1 and 2**, still true: the default width from the page, "a dialog" in the Keys intro, the frame and scroller split, the cap, the unchanged-dimension rule, the spot from the drawn box, keys never snapping, reveals and scroll padding, the short layout decided at rest with focus kept, the group's Apply, `barCover`'s generalization, the stepper-row wrap, the middle kept on a resize, the handle's reach and the narrow bands.
