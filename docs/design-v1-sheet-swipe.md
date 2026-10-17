# raccoon-vtt v1: swipe down to close a phone's bottom sheet

Status: draft 3, with design review rounds 1 and 2 and the project owner's answer on unsaved input (2026-10-17) folded in. Code is cited from the wave 5 tip in the `openvtt-w6swipe` workspace (`bbaf7cec`), which holds main, the PDF handouts and the four wave 5 builds.

The project owner asked on 2026-10-17: "Also swiping down from the top of the panel appearing from the bottom on mobile should close it, as well as swiping down when it's already scrolled all the way to the top".

## 1. Summary

- Every surface that rises from the bottom of the screen closes with a downward swipe: the panel sheet and the Panels list, the dialogs shaped as sheets (the scene menu, the monster filters, Request a roll, the group's More, the stamp picker, Export the log, the X-card), the label, pin and light panes, and a player's roll card, which a swipe puts off as Later does. Section 3 lists each, and what does not swipe.
- One rule for every one of them. A drag that starts on the surface's header always moves it. A drag that starts anywhere else moves it only when the surface is scrolled to its top as the drag starts. The surface follows the finger, and on release it closes when it went a quarter of its height, or when the finger flicked down. Otherwise it springs back.
- Taps stay taps. Until the finger has moved past the tap slop the swipe touches nothing, so a tap is the browser's own, with its one click.
- A swipe closes through the surface's own close, the function its Close button calls. A surface holding unsaved input springs back instead, by the project owner's answer, and its Close and Back behave as today.
- What owns its own touches keeps them: fields, sliders, drag handles, sideways scrolling, a second finger, a press held still, and the browser's own edge swipes.
- The swipe is an extra. Close, Escape and Back stay, nothing is added for keys, and reduced motion closes without the slide.
- One new module, `client/lib/sheetSwipe.ts`: a state machine with no DOM, as `lib/gestures.ts` holds the map's, and a hook each surface calls.

## 2. Today

- **The panel sheet** (`components/Sheet.tsx`) is one `<dialog>` in three modes (`Sheet.tsx:11`). Below 900 layout px, on a layout no wider than tall (`Room.tsx:245-246,473`), it is "bottom": absolute, spanning the screen, standing on the 60 px toolbar (`Sheet.tsx:105-121`), opened with `show()` and so not modal (`lib/modalDialog.ts:231-322`). Its header is `SheetHeader` (`Sheet.tsx:172-184`), its one scroller the `data-pane-body` div with `overscrollBehavior: "contain"` (`:190-194`). Room draws two of them, the open panel and the Panels list (`Room.tsx:750-805`), and the dock row rides 56 px above the sheet's top edge, placed from the sheet's measured height (`RoomDock.tsx:56-83`, `Room.tsx:519,689,807`). Close calls `ui.closePanel()` or `setPicker(false)` (`Room.tsx:756,784`), Escape and Back call `closeSheets()` (`Room.tsx:411-413,443`). Nothing asks before it closes: only a subpage's Back can ask, in the encounter editor (`EncountersPanel.tsx:193-208`).
- **The dialog shell** (`components/Dialog.tsx`) with `phone="sheet"` is a bottom card below 600 layout px (`Dialog.tsx:10,84-95`), modal, portaled to the body, on a scrim whose tap closes it (`:145-147`). Header `SheetHeader` (`:179`), one scroller (`:180`), a footer (`:181-199`). Its wrappers: `SceneSheet` (`scenes/SceneSheet.tsx:29`), the X-card with no header (`xcard/XCardHost.tsx:53`), `ExportLog` (`log/ExportLog.tsx:143`), `StampPicker` (`builder/stamps/StampPicker.tsx:48`), the monster filters (`tokens/MonsterFilters.tsx:155-171`) and `SheetDialog` (`tokens/SheetDialog.tsx:30`), used by the group's More (`GroupMoreSheet.tsx:80`) and the DM's Request a roll (`rolls/RequestSheet.tsx:109`). None refuses a close. Request a roll drops its draft on any close and says where a pending send stands (`RequestSheet.tsx:102-106`).
- **The map panes** (label, pin, light) are a bottom sheet where the map is under 600 layout px wide (`builder/labelEdit.ts:142,165-166`, `labelPaneFrame.ts:39-50`): plain `role="dialog"` divs in the zoomed layer over the map (`canvas/Stage.tsx:1179,1203-1205`), each its own scroller with a `PaneHeader` that scrolls with it (`LabelPane.tsx:91`, `PinPane.tsx:88`, `LightPane.tsx:85`). Each host renders one pane and swaps the item it shows: only the editor inside is keyed (`LabelPane.tsx:93`). Close: the label's "Close without saving" (`LabelPane.tsx:137`), the pin's `close` (`PinPane.tsx:173-177,195`), the light's (`LightPane.tsx:113`). Back closes each (`:37`, `:45`, `:42`).
- **A player's roll card** below 600 layout px (`rolls/logic.ts:599`) is a fixed card standing on the toolbar or the tool's options, portaled to the body at z 25 (`rolls/PlayerRolls.tsx:345,505-535`). It is its own scroller (`:522-523`) under a header of its own with the question and Later (`:441-468`). Later folds it with its draft kept (`:463-467`), and Back does the same (`:389`).
- **Touch today.** The room's root takes `touch-action: pan-x pan-y` (`Room.tsx:705`), the body `overscroll-behavior: none` (`globals.css:26-28`). Every control that drags under a finger sets `touch-action: none`: the tracker's drag handle (`encounter/Row.tsx:467`), the token window's grip and handle header (`SheetHeader.tsx:277,309`) and resize parts (`TokenActionBar.tsx:1135,1148`), the handout viewer (`HandoutViewer.tsx:565`), the crop editor (`CropEditor.tsx:231`). No surface animates when it opens or closes. The only stepper that repeats while held is in the tool options (`heights/HeightOptions.tsx:82`), and it relies on the browser's `pointercancel` when a scroll takes its press (`lib/holdRepeat.ts:16-18`, `measure/controls.tsx:1394-1416`).

## 3. Which surfaces swipe

A surface swipes while it stands at the screen's foot as a sheet: spanning the screen's width, with its top corners rounded. Each closes through what its Close button does, unless it holds unsaved input (4.5).

| Surface | Swipes when | A swipe does |
|---|---|---|
| Panel sheet, open panel | mode "bottom": below 900 layout px, no wider than tall | `onClose`: `ui.closePanel()` |
| Panel sheet, Panels list | mode "bottom" | `onClose`: `setPicker(false)` |
| Dialog `phone="sheet"`: scene menu, monster filters, Request a roll, group's More, stamp picker, Export the log | its card is the bottom card (`dialogCard(...).bottom`): below 600 layout px | the dialog's `onClose` |
| X-card | as above. It has no header, so only the content rule applies | `onDismiss`, as Dismiss and a tap beside it do |
| Label, pin and light panes | `panePlacement` gives "sheet": the map below 600 layout px, at any layout width | its Close button's handler |
| A player's roll card | it is the bottom card (below 600 layout px, not folded) | Later (`onFold`), its draft kept |

Not these:
- **The sideways sheet** (mode "side") stands on the right, from the top bars to the toolbar. A downward swipe there has no foot to go to. It keeps Hide and Close.
- **The very short mode** (mode "full") covers the whole screen and does not rise from the bottom. So both sideways modes stay alike.
- **Whole-screen dialogs** (`phone="fill"`, or `full`): the journal's and the monster's editors ask before they throw away changes (`Dialog.tsx:207-219`), the image picker, the crop editor, the handout viewer, the shortcut sheet, the companions' stat blocks, the monster picker, the map import, "view as a player". Their own close stays the only one.
- **A dialog shaped as a sheet from 600 layout px up** floats as a card in the middle.
- **The token window** in every mode: on an upright phone it hangs by its token (`barDock.ts:131-134,710-727`) and is no sheet. It never sits inside a sheet either: beside or under one it folds into a button (docs/design-v1-token-window.md 7.1, docs/design-v1-bar-dock.md 3.2.1).
- **The fight's alerts opened over the screen**, popovers and menus: none stands at the foot.

## 4. The gesture

### 4.1 Where a touch starts

Walking up from the element the finger touched to the surface, the first match decides:

1. **Owned.** A field (anything that takes typing, a `select`, a slider `input[type=range]`), or an element whose `touch-action` is `none`. These handle their own touches: the browser's caret and selection, a slider's thumb, a drag handle. The swipe leaves such a touch alone, whatever its direction.
2. **The grab area**: the surface's header, marked `data-sheet-grab` (4.6), and every rider (the dock row on the panel sheet's top edge). A downward drag here always moves the surface.
3. **Content**: everything else on the surface, its footer included. A downward drag here moves the surface only when it is **at its top**: the surface's own scroller, and every element between the finger and the surface that scrolls up and down (`overflow-y` auto or scroll, with more to show), each scrolled less than 1 px from its top as the touch starts. Less than 1 px, since a scroll position can be fractional under the interface size's zoom, and iOS reports a negative one while it bounces. So a footer drag on a dialog whose body is scrolled down closes nothing, and an element that scrolls only sideways, such as a Markdown table (`Markdown.tsx:94`) or the new scene's row of maps (`NewScene.tsx:245`), does not count.

Two more rules make a touch that cannot swipe:
- **Typing.** While a field that takes typing (any text or number input that opens a keyboard, a textarea, editable text) inside the surface has focus, the keyboard is likely up, and a drag in content may be scrolling to see past it or selecting text. A content drag then stays the browser's. A grab-area drag still moves the surface, and 4.5 decides whether it closes or springs back.
- **One finger.** A touch that starts while another finger is on the screen never swipes.

### 4.2 Taps first, then one claim past the slop

- **Inside the slop nothing happens.** Until the finger is more than the tap slop (`TAP_SLOP_PX`, 8 screen px, `lib/gestures.ts:10`) from where it went down, the swipe cancels nothing, moves nothing and sends nothing. The touch is an ordinary one, and a lift inside the slop is the browser's own tap: one click, with its focus and its default action, exactly as today. Nothing is synthesized.
- **The claim.** The first move past the slop decides, once for the touch. It claims the touch when the touch began where a swipe may begin (4.1), it goes **down at least as far as sideways**, it is not a hold (4.3), and the browser still lets the page cancel it (`event.cancelable`). The swipe then cancels that move and every later one (`preventDefault`), so the browser neither scrolls, bounces, refreshes nor zooms for it. Any other first move past the slop leaves the touch to the browser for good.
- **Why that move can still be cancelled.** Chrome sends a page no move inside its own touch slop, so the first move a page hears there is the one that would start Chrome's scroll, and Chrome waits for the page's answer to it. iOS Safari starts its pan about 10 points from the touch, past the swipe's 8 px. Where a browser has begun its own pan anyway, it marks the move as not cancelable, and the swipe stands aside: the content scrolls or bounces as today, and the surface stays. So the browser and the swipe never both act on one touch. The grab area takes `touch-action: pinch-zoom` (4.6), so no pan starts there at all.
- **A claimed touch activates nothing.** It has left the slop, which no browser takes for a tap, and the swipe cancels its end (`touchend`) as well, so no click or compatibility mouse event follows. A tap activates once, a swipe never.

So in content at its top, a drag up scrolls the content as today, a drag sideways scrolls a sideways row, and only a drag down moves the surface.

### 4.3 Following the finger

- **The hold.** In content, a touch whose first move past the slop comes `REPEAT_DELAY_MS` (400 ms, `lib/holdRepeat.ts:21`) or more after it went down, the shortest hold the app gives a meaning to, is a hold: it never claims, and the browser keeps it, so a press held to select text, or held on a stepper, is never a swipe. The grab area holds no text to select and no stepper, so there a finger may rest before it drags.
- **The press it takes.** At the claim, the swipe does to the control under the finger what the browser does when it takes a touch for a scroll. It sends that pointer a `pointercancel` (its id read from the touch's `pointerdown`, heard in the capture phase), releases the pointer's capture from whatever element took it (heard from `gotpointercapture`), and until the touch ends it stops that pointer's later `pointermove`, `pointerup` and `click` at the window in the capture phase. That stop is added on `window` when the hook mounts, not at the claim, and acts only for a claimed pointer, so it runs before every window listener added later and before every listener on the page below the window. So no control hears a move, an up or a click after its cancel, as when a browser takes a touch. The one earlier window capture listener that still hears the claimed pointer's up is the popover base's press tracker (`components/Popover.tsx:473-475`), attached with the room. It heard the `pointercancel` first, which ended that press, so the up reaches it for a pointer it no longer tracks, and it does nothing. A unit case in the popover's tests pins that. A stepper that steps on its press (`holdRepeat.ts:16-18`) puts its value back, as it does under a scroll.
- **Where it stands.** The surface's offset is the finger's distance below where it went down, less the slop, never below 0: it never rises above its place, and a finger moving back up brings it back to its place and stops there. The rest of the touch moves the surface, never the content: one owner per touch.
- **Units.** Offsets, the slop and speeds are screen px, the finger's own. The surface takes the interface size as CSS `zoom` (`features/device/layout.ts:72-75`), on itself or on the layer that holds it (`Stage.tsx:1179`), and zoom multiplies its transform too. So the transform is the offset divided by the interface size (`inZoomed`, `layout.ts:88-90`), and the surface stays under the finger at 130% as at 100%.
- **The dock rides along.** The dock row (docs/design-v1-bar-dock.md 3.2.1) takes the same transform while the sheet moves, so it never floats loose over the map, and it is part of the grab area (4.1): a finger that lands on it first, in a fight, drags the sheet. Its buttons still tap inside the slop, as the header's do.
- **Nothing else moves.** The surface's layout, its measured height and the dock's place are unchanged. Only a transform moves it, set while it is dragged or sliding and removed at rest, so at rest nothing differs from today (a transform makes the surface a containing block for anything fixed inside it).

### 4.4 On release

Let **height** be the surface's drawn height as the touch started (`getBoundingClientRect`, screen px), **floor** one touch target (`theme.touch`, 44 px) times the interface size, and **speed** the finger's speed at the lift (screen px per ms, over the last 100 ms of moves, down positive). A finger that rested still at the end has speed 0.

- **A flick** (speed of 0.5 px per ms or more down) closes once the surface has moved at least half the floor. A fast, sloppy tap that slides a few px past the slop therefore springs back.
- **A flick back up** (0.5 px per ms or more up) springs back, however far the drag.
- **Otherwise the distance decides**: the surface closes when its offset is at least the larger of a quarter of its height and the floor. The quarter scales with the surface, so a tall sheet asks for a longer drag than a short picker. The floor keeps a short sheet from closing on a drag shorter than a button is tall.

At 130% the same sheet takes the same share of the screen, so the distance in screen px is the same, the floor grows with the targets the finger sees, and the flick's speed is the finger's at any size. Worked numbers are in the appendix.

### 4.5 Closing, springing back and cancelling

- **Unsaved input springs back** (the project owner, 2026-10-17). A surface holds unsaved input while anything it shows reports a draft that its close would throw away (4.6), or while a field that takes typing inside it has focus and its value differs from its value when it took focus (a field that saves on blur may hold a change not yet saved). A focused field with nothing typed into it counts for nothing, and so does a search field (`type="search"`), which every search and filter field in a swiping surface is (`MonstersPanel.tsx:102`, `EncountersPanel.tsx:431`, `StampPicker.tsx:52`, `OutlinerPanel.tsx:115`). A select or a slider sends its value as it changes, so its focus counts for nothing either. The hook reads a field's value as it takes focus (`focusin` on the surface) and again at the claim. The roll card takes no part: its swipe is Later, which keeps everything. Read at the claim, such a surface follows the finger at half its distance, a sign that it will not go, and on release always springs back, whatever the distance or speed. Its close never runs. Close and Back behave as today: the encounter editor's Back still asks "Discard changes?", and Close still closes.
- **Close.** The surface and its riders slide down until the highest of their top edges reaches the **clip edge**, then its close runs: the very function its Close button calls (section 3). The clip edge is where what covers the surface's foot begins. The panel sheet and the panes are drawn under the toolbar and the tool's options (z 10 and 5 under 14 and 15, `theme.ts:141-159`), so theirs is their own foot, and the dock, 56 px above the sheet, passes under the toolbar too. A dialog's card and the roll card are drawn over everything at the foot, so theirs is the screen's foot, and a roll card standing on the options travels its height plus that standing. The distance comes from the boxes as the slide starts (screen px), so the last frame shows none of the surface or its riders. While it slides it takes no touches.
- **Kept open.** If the surface still shows once its close has run, because its owner kept it open, it springs back. The rule keeps the swipe from ever skipping a question an owner asks.
- **Replaced.** Every surface passes the item it shows as `item`, and none relies on a remount: the panel sheet its panel's name (fixed and unique per panel) and its subpage's key, the list "Panels", a dialog its title (which names its step, as the scene menu's do), a pane the id of its label, pin or light, the roll card its request's id. The subpage's key is the one `useSubpageFocus` already uses, `parent` and `id ?? title` (`features/panels.ts:338`), exported from there as `subpageKey` so both read one definition: two journal pages with one title differ by their ids (`JournalPanel.tsx:48`), and a title that changes in place (the encounter editor's draft name, a page renamed on another device, `panels.ts:165-176`) is no new item. When `item` changes during a drag, the drag ends at once without motion, and the touch moves nothing more. When it changes during the slide, the slide stops, the transform goes and the close is dropped. The same holds when the surface closes, hides or changes mode by any other path. So a swipe never closes what replaced the surface.
- **Spring back**: to its place, then the transform is removed.
- **A second finger.** From its first touch until its last finger lifts, the surface listens for new touches on the whole document, in the capture phase. Any new touch, wherever it lands (the map, the scrim, the bars), cancels the swipe for good: a surface that moved springs back, one that had not claimed never claims, and lifting the fingers closes nothing.
- **Cancel.** A `touchcancel` (the system took the touch) or the surface changing mode, hiding or unmounting mid-drag ends the drag too: it springs back, or snaps back without motion for a change of mode, since the surface is about to stand somewhere else.
- **Focus, Back and drafts** follow from the close. A panel sheet closed with focus inside loses focus to the page and Room places it (`modalDialog.ts:139-150,313-319`), as when Back closes it. The Back entry comes off as for Close (`backClose.ts:83-98`). Request a roll still says where a pending send stands, and the roll card keeps its draft as Later does.

### 4.6 The pieces

- **`client/lib/sheetSwipe.ts`**: `SheetSwipe`, a state machine with no DOM, as `CameraGesture` is (`gestures.ts:45-144`). `start({ on, atTop, typing, fingers, height, scale, at })`. `move({ dx, dy, at, cancelable })` returns whether to cancel the move, the offset to show, and the one press to cancel at the claim. `claimed(unsaved)` takes the unsaved read. `end({ at })` returns "close", "back", "tap" or nothing. `cancel()` for a second finger or a `touchcancel`, `replaced()` for a new item. The constants beside it: the share (1/4), the flick (0.5 px per ms) and its travel (half the floor), the speed's window (100 ms), the slide (200 ms), the unsaved follow (1/2), with `TAP_SLOP_PX`, `REPEAT_DELAY_MS` and `theme.touch` imported. Its DOM reads, `startsOn(target, surface, riders)`, `atTop(target, surface, scroller)` and `slideDistance(surface, riders, clip)`, take a small node interface, so they are unit tested too.
- **`useSheetSwipe(surface, { enabled, onClose, scroller, riders, item, clip })`** in the same file. `clip` is "foot" (the panel sheet, the panes) or "screen" (a dialog's card, the roll card). Native listeners while `enabled`, since React's own touch listeners are passive and cannot cancel a move: on the surface and each rider, `touchstart` passive, `touchmove` and `touchend` not passive, `touchcancel` passive, and `pointerdown` and `gotpointercapture` in the capture phase. While a touch is tracked: `touchstart` on the document in the capture phase (4.5), and the window's capture-phase stop for the claimed pointer (4.3). It reads the interface size itself (`useUiScale`), as every surface that swipes takes it. The cost: a scroll inside a surface starts once the page has heard its first move past the slop, which a busy page can hold back by about a frame. The listener returns at once for a touch that cannot swipe.
- **`useUnsavedInput(unsaved)`**, in the same file: a component inside a swiping surface reports a draft through the context each surface provides (Sheet, Dialog, the panes), so a panel's subpage or a dialog's body reports without passing props. A draft is text or a choice the viewer typed or picked that only a later button sends (Send, Save, Done, Create, Add), while it differs from where it started. A search or a filter is not one: it is a view of the list, and losing it loses no work. Outside a swiping surface, as in the side panel, the hook does nothing. The drafts at this tip, from a search of every component a swiping surface can show: the encounter editor (`changed`, `EncountersPanel.tsx:163`), the Log's message (`LogPanel.tsx:253`), a new character's form (`CharactersPanel.tsx:470-475`), a companion being added (`CompanionForm`, `CompanionsSection.tsx:175`, which takes the Characters panel's place, `CharactersPanel.tsx:83-95`), an effect or condition being added or edited (`EffectsSection.tsx:255-268`), a scene folder being renamed (`SceneList.tsx:308`), a new scene's name (`NewScene.tsx:34`), a ready action's trigger (`encounter/ReadyControls.tsx:28`), an area's damage (`areas/AreaDamage.tsx:48`), the room's name typed to delete it (`dm/Access.tsx:492`), the scene menu's new folder (`SceneMenu.tsx:162`), Request a roll's draft (`RequestSheet.tsx:52`), the label pane's text and size (`LabelPane.tsx:102`) and the pin pane's draft (`PinPane.tsx:105`). Not drafts: the token's fields (`tokens/ui.tsx:50-70`), which commit what was typed when they are taken away, and the light pane, which sends each choice at once and its name on blur, so the focus rule covers it. The search was repeated in round 2 over every `useState` holding text or a form in `client/panels` and `client/features`.
- **The grab area.** `SheetHeader` and `PaneHeader` gain `grab`, which marks the header `data-sheet-grab` and gives it `touch-action: pinch-zoom`: no pan starts there, so every move is the page's to read, and pinch zoom still works where the page allows it. The roll card's header and the dock row, while it rides a swiping sheet, take the same.
- **Motion.** While dragged: the transform follows each move with no transition, and `will-change: transform`. On release: a 200 ms transition, decelerating, to the slide's distance (4.5) or to 0 (back). The dialog's scrim stays as it is until the dialog closes. With `prefers-reduced-motion: reduce`, read at the release, the close runs at once and a spring back is a jump: following the finger stays, since that motion is the finger's own. Nothing runs at rest, and no surface gains an opening animation.

## 5. Conflicts, one rule each

| What | Rule |
|---|---|
| A list inside a panel that scrolls up and down | It must be at its top too (4.1). Scrolled, a drag down scrolls it. The Log, usually scrolled to its newest message at the foot, closes only from its header |
| A row that scrolls sideways (Markdown tables, the new scene's maps) | Not a vertical scroller (4.1). A first move past the slop more sideways than down scrolls it (4.2) |
| The tracker's drag handle (`Row.tsx:450-470`, `TrackerPanel.tsx:364-396`) | `touch-action: none`, so owned (4.1). It reorders as today |
| The token window's grip | No surface holds it (section 3). If one ever did, `touch-action: none` makes it owned |
| Text fields, the caret and selection | A field is owned. While one has focus a content drag is the browser's, and a grab-area drag springs back only if the field's value changed since it took focus (4.5). A press held to select is a hold (4.3) |
| Sliders (`scenes/controls.tsx:124-145`) and selects | Owned |
| Steppers held down | No repeating stepper sits in a surface (section 2). A plain stepper acts on its click, which a claimed touch never makes. A repeating one would get the `pointercancel` a scroll gives it (4.3) |
| A tap on any button, header or content | Inside the slop the swipe does nothing at all: the browser's tap, one click (4.2) |
| The map behind | A touch that starts on a surface is never the map's, and one that starts on the map is never a swipe, as today. A second finger on the map cancels the swipe (4.5) |
| The PDF and image viewers, the crop editor | Whole-screen, so they do not swipe (section 3), and their stages are owned anyway |
| Pinch, a second finger | A touch that starts with another finger down never swipes. A new finger anywhere cancels a swipe (4.5). The grab area keeps the browser's pinch where the page allows one (4.6) |
| A popover open from a surface's button | Its outside press closes it as today. The touch may then swipe |
| A modal dialog over the panel sheet | The sheet is inert under it and hears nothing. The dialog swipes on its own |
| iOS Safari's back swipe from the left edge | Sideways, so the first move past the slop leaves it to the browser (4.2) |
| iOS's home bar swipe, the status bar's pulls | Upward from the screen's foot, or from above the page: never a downward move on a surface |
| Pull to refresh, the rubber band | A claimed touch's moves are cancelled. Unclaimed ones meet `overscroll-behavior: none` on the body (`globals.css:26-28`) and `contain` on each surface's scroller (`Sheet.tsx:193`, `Dialog.tsx:180`), as today |
| A browser that started its own pan first | The move is not cancelable, so the swipe stands aside (4.2) |
| A mouse, a trackpad | Only touch events drive it. A computer's sheet or narrow-map pane keeps Close and Escape |
| A screen reader's gestures | VoiceOver and TalkBack take one-finger swipes for themselves, so the page hears none. Close stays |

## 6. Accessibility

- The swipe is a path-based gesture with a single-pointer alternative everywhere: the Close button (Dismiss and a tap beside the X-card, Later on the roll card) stays in every surface (WCAG 2.2 SC 2.5.1 and 2.5.7). Escape and Back stay as they are.
- Nothing new for keys, and no row for the shortcut sheet: it lists keys and key-with-pointer combinations only.
- No new announcement. A swipe closes as Close does, and focus moves as it does after Back. A spring back from unsaved input changes nothing a screen reader hears.
- Reduced motion: no slide after release (4.6, SC 2.3.3).
- Targets, names and roles are unchanged. The grab area adds no element.

## 7. Contracts this adds to

- **The sheet as one `<dialog>`** (docs/design-v1-layout-hierarchy.md 4.2): holds. In "bottom" mode the sheet swipes. The hook owns the dialog's transform, and no mode's box sets one (`Sheet.tsx:105-149`). New optional `riders`, the elements that ride its top edge: Room passes the dock row (`RoomDock.tsx:56`, which takes a ref). The sheet provides the unsaved-input context to its panel.
- **The dialog shell** (docs/design-v1-visual.md 2.3, and its structure that `e2e/size.e2e.ts` checks): holds. The bottom card swipes, with its header as the grab area and its one scroller as the scroller, and it provides the unsaved-input context to its body. No new prop.
- **The one header** (docs/design-v1-visual.md 2.3): `SheetHeader` and `PaneHeader` gain `grab` (4.6). Sheet and Dialog pass it while they swipe. The panes pass it in sheet placement.
- **The dock** (docs/design-v1-bar-dock.md 3.2.1, docs/design-v1-visual.md 3.2.1): rides the sheet while it moves and is part of its grab area. Its fold rules, focus and buttons hold.
- **The roll card** (docs/design-v1-visual.md 3.3.1): a swipe is Later. Its folding rules hold.
- **The wave 5 designs** this does not change: the tool options row is not drawn under a shown sheet (`Room.tsx:490`), the side panel's tabs are 900 px up only, and the token window never swipes (section 3).

## 8. Edge cases

### 8.1 By size

Three thresholds, each its surface's own: the panel sheet is "bottom" below 900 layout px on a layout no wider than tall, a dialog's card and the roll card are bottom cards below 600 layout px, and a pane is a sheet where the map is below 600 layout px, which a wide layout reaches beside the 360 px side panel.

| Screen and interface size (layout px) | Surfaces that swipe |
|---|---|
| 375 x 667, 390 x 844 (47/34 px insets), 412 x 915, upright, 100% and 130% | Every kind. The distance holds in screen px across 100% and 130% (appendix) |
| 320 x 480 at 130% in a fight with the dock (sheet 153 px) | Every kind. Panel sheet: the floor (57 px) sets the distance. The dock rides and is grab area |
| 320 x 480 at 130% with 44/34 px insets, dock in the header | The header holds the dock's buttons. A drag on them moves the sheet, a tap shows the token |
| 768 x 1024 upright at 100% and 115% (768, 668) | The panel sheet and the list only. Dialogs and the roll card are cards, and the map leaves the panes cards |
| 768 x 1024 upright at 130% (591) | Every kind |
| 820 x 1180 and 834 x 1194 upright, 100% to 130% (631 to 834), and 1024 x 1366 at 115% and 130% (890, 788) | The panel sheet and the list only |
| 667 x 375 sideways at 100% (667) | Nothing: the panel is a side sheet, the rest are cards |
| 667 x 375 at 115% and 130% (580, 513) | Dialog sheets, the panes and the roll card. Not the panel (side) |
| 844 x 390 sideways, 100% to 130% (844 to 649) | Nothing |
| 480 x 320 at 130% (369, the very short mode) | Dialog sheets, the panes and the card. Not the panel (full) |
| A 940 x 800 window with the side panel shown (map 580) | The panes, by touch only. Panels are tabs, dialogs cards |
| 960 px and wider with the side panel, or 900 px and wider with it hidden | Nothing |

### 8.2 By drag

| Drag | Result |
|---|---|
| Header, slow, past the distance | Closes after its slide |
| Header, slow, short of it | Springs back |
| Header, with the body scrolled down | Moves the surface (the grab area ignores scroll) |
| Content at its top, slow past / short / a flick | Closes / springs back / closes |
| Content scrolled down, a drag down | Scrolls the content up. The surface never moves, even when the content reaches its top mid-drag |
| Content still gliding from a fling, touched | Not at its top: the touch stops the glide and scrolls |
| Content at its top, a drag up | Scrolls the content |
| A tap with a few px of jitter, header or content | The browser's tap: one click. Nothing cancelled |
| A fast sloppy tap that slides 12 px down in 15 ms | Claimed (past the slop), offset 4 px, under half the floor: springs back, no click, as today where a browser takes such a slide for a scroll |
| A flick down after the drag went back up | The flick decides: closes, once the offset is past half the floor |
| Past the distance, then a flick up | Springs back |
| Past the distance, finger rested 100 ms, lifted | Speed 0: closes by distance |
| A drag that goes down, then sideways | The surface follows only the vertical part |
| In content, held still 400 ms, then dragged | Never claims: the browser's (a hold). On the header, the surface moves |
| A second finger lands on the map while the first rests past the distance, then both lift | Springs back, closes nothing |
| A browser marks the claiming move not cancelable | The swipe stands aside: the content bounces, the surface stays |
| A rotation mid-drag, or a resize that changes the mode | Snaps back, the sheet takes its new mode. A resize that keeps the mode, such as a keyboard opening, leaves the drag going, its height as read at the start |
| Another label tapped during the closing slide, or another panel opened mid-drag by another path (a server change, a key) | The slide stops, or the drag snaps back: the close is dropped, the new item stays |
| A server change closes the surface mid-slide | The slide stops, nothing more closes |

### 8.3 By surface and content

| Case | Result |
|---|---|
| Initiative with its sticky round header, scrolled | Not at its top: scrolls. The round header is content |
| Log, scrolled to its newest message | Only the header moves it |
| Log with a half-typed message, blurred or not | Follows at half, springs back. The message stays |
| The encounter editor with unsaved changes | Springs back. Its Back still asks "Discard changes?", Close still closes |
| A panel's subpage with nothing unsaved | The swipe closes the panel, as Close does, not Back |
| Request a roll with a note typed, or its choices changed | Springs back. Unchanged, it closes as Close, and a pending send's toast shows |
| Label pane with typed text, or the pin pane with a changed draft | Springs back. Unchanged, it closes |
| Any surface with a typing field focused, nothing typed (the Log's empty composer, a search) | A header drag closes. A content drag is the browser's |
| A typing field focused with its value changed (a token's number half-typed) | A header drag springs back |
| A companion being added, a field changed and blurred | Springs back, every value kept |
| A journal page closing by swipe, and another page with the same title opened from a pin during the slide | The new page's key differs: the slide stops, the new page stays |
| The same journal page renamed on another device mid-drag | Same key: the drag goes on and closes as usual |
| Scene menu over the Scenes panel | Only the scene menu closes, focus to its opener. The panel stays |
| Monster filters | Closes. The filters already applied as tapped |
| X-card | Any downward drag on the card dismisses it, as a tap beside it does |
| Roll card, answer typed, its field focused or not | Later: the chip shows, the typed total kept. Later loses nothing, so no spring back |
| Roll card standing on Multi-select's bar | Its slide passes the screen's foot: its height plus the bar and toolbar it stood on |
| Panels list | Closes the list |
| The dock showing with a selected token | It rides the sheet and slides under the toolbar with it. Once the sheet closes the bar unfolds as after Close |
| Reduced motion | The surface follows the finger, then closes or returns at once |
| "View as a player" on a phone-sized preview | The previewed room's surfaces swipe as in a room |

## 9. Tests

**Unit, `client/lib/sheetSwipe.test.ts`** (the state machine and the DOM reads over a fake node tree):
1. Who may start: grab, a rider, content at its top, content not at its top, owned, typing (grab still moves, content does not), a second finger.
2. Inside the slop: moves of 2, 4 and 6 px down cancel nothing, show no offset and cancel no press. A lift then ends as "tap".
3. The claim at the first move past the slop: down, down and sideways equally (claims), more sideways, up, not cancelable (each lets go), a content touch first past the slop at 400 ms (lets go), a grab touch at 400 ms (claims). The decision never changes later in the touch.
4. The press: one `pointercancel` at the claim and none before, capture released, the pointer's later events stopped, and `touchend` cancelled only for a claimed touch.
5. The offset: less the slop, never below 0, back to 0 when the finger returns, and its transform divided by each interface size (0.85, 1, 1.15, 1.3, `settings.ts:88`).
6. Release: by distance at 100% and 130% (the appendix's sheets), the floor on a 153 px sheet, a flick past half the floor, a 12 px slide in 15 ms (back), a flick up past the distance, a rest of 100 ms before the lift, and the speed over the last 100 ms.
7. Unsaved: read at the claim, follows at half, always "back", the close never called. A focused typing field counts only with its value changed since it took focus. A focused empty field, a search field and a select do not, and the roll card ignores it.
8. Cancel and replace: a second finger at any point (after it, `end` closes nothing), `touchcancel`, a change of mode (no motion), a new item mid-drag (no motion) and mid-slide (close dropped), and `subpageKey`: two pages with one title and different ids differ, one page renamed does not.
9. `slideDistance`: a sheet with a rider 56 px above (height plus 56, to its foot), a dialog's card (its height), a roll card standing 113 px above the screen's foot (height plus 113).
10. `atTop`: the surface's scroller, a nested scroller, a sideways-only scroller ignored, a fractional and a negative position, a footer outside the scroller. `startsOn`: a field, a range, `touch-action: none`, the grab area, a button in it, a rider, content.

**e2e, a new `e2e/swipe.e2e.ts`**, Chromium touch through `Input.dispatchTouchEvent` (as `bardock.e2e.ts:240-247`, two points as `playerphone.e2e.ts:651-653`), in contexts with `isMobile` and `hasTouch`. A slow drag spaces its moves by 30 ms (about 0.3 px per ms), a flick sends them back to back.
1. Panel sheet at 375 x 667 and 390 x 844 at 100% and 130%, and 768 x 1024 at 100%: from the header, slow past the distance closes, with focus and the Back entry as after Close (`history.state` no longer the overlay's). Slow short of it springs back, and the transform is gone at rest.
2. Content at its top: slow past closes, a flick closes. Content scrolled: a drag down scrolls it and the sheet stays. At its top, a drag up scrolls it.
3. Taps: a touch with real moves of 2, 4 and 6 px down, then a lift, on the header's Close and on a checkbox in content at its top. An in-page listener records each move that reaches the page and whether it was cancelled: none was, whether or not Chromium delivers them. Close closes once, the checkbox flips once.
4. A sideways Markdown table scrolls sideways. The tracker's handle reorders tied rows (DM). The Scenes panel's slider moves. A focused field: a content drag does not move the sheet. A header drag closes with nothing typed, and springs back once the field's value has changed.
5. A second finger lands and lifts on the map while the first rests past the distance, then the first lifts: the sheet springs back. A content press held 500 ms then dragged moves nothing.
6. Unsaved: a half-typed Log message (blurred), a changed encounter, Request a roll with a note, a typed label (DM), a companion being added with a field changed and blurred: each springs back with its input kept. With nothing typed each closes, and so does the Log with its empty composer focused, by a header swipe.
7. Monster filters over the Monsters panel: the swipe closes the filters only, focus on Filters. The X-card dismisses. At 768 x 1024 at 100% a dialog is a card and a drag on it does nothing.
8. Sideways at 844 x 390: a header drag on the side sheet does nothing. At 480 x 320 at 130%: the very short mode does nothing.
9. With a selected token in a fight, the dock moves with the sheet during a held drag, and the slide's end (the hook exposes it as `data-sheet-swipe-to` on the surface) puts the dock's top and the sheet's at or below the toolbar's top. A roll card standing on Multi-select's bar: its end is at or below the screen's foot. The card folds to its chip with its total kept.
10. The label pane by its header (DM, 375 x 667), and in a 940 x 800 window with the side panel shown. A second label tapped during the closing slide: its pane stays open. A journal page swiped closed, and another page with the same title opened from a pin during the slide: the new page stays. A page renamed from a second device mid-drag: the drag closes it as usual.
11. Reduced motion (`emulateMedia({ reducedMotion: "reduce" })`): the sheet is gone within one frame of the lift.

**Existing e2e this touches**: `fold.e2e.ts` (the dock), `size.e2e.ts` (the dialog's structure), `rolls.e2e.ts` (the card), plus `reach`. Run with `E2E_SCREENSHOT_DIR` as usual.

## 10. Build plan

One builder, in this order, one commit each:
1. `feat(ui): the swipe that closes a bottom sheet, as a state machine with its tests`: `client/lib/sheetSwipe.ts`, `client/lib/sheetSwipe.test.ts`.
2. `feat(ui): swipe down to close a phone's panel sheet and dialog sheets`: `components/Sheet.tsx`, `components/Dialog.tsx`, `components/SheetHeader.tsx` (`grab`), `pages/Room.tsx` and `pages/RoomDock.tsx` (the dock as a rider).
3. `feat(ui): a sheet holding unsaved input springs back from a swipe`: the reporters named in 4.6. The builder searches again for drafts in every component a swiping surface shows, and adds any found since this tip.
4. `feat(builder): swipe down to close the label, pin and light panes`: the three panes.
5. `feat(rolls): a swipe puts a roll card off as Later does`: `features/rolls/PlayerRolls.tsx`.
6. `test(e2e): swipe down to close`: `e2e/swipe.e2e.ts`.
7. `docs: swipe down to close in the feature list and the design`: FEATURES.md (section 11) and one line in docs/design.md 14.4 pointing here.

Checks: typecheck, unit, build and test:int in parallel, then the e2e files named in section 9. Screenshots of a sheet mid-drag at 375 x 667 at 100% and 130%. No server, protocol or data change. No package added.

## 11. FEATURES.md

A new bullet under "Phones, tablets and connection", after the bullet that begins "On a phone, panels open as sheets", and after the split panel design's new bullet there when that build lands first:

- Swipe a sheet down to close it: from its header at any time, or from anywhere on it once it is scrolled to the top. A quick flick down closes it too, and a short drag lets it spring back. Panels, the menus and pickers that rise from the bottom (such as a scene's menu, the monster filters and Request a roll), the X-card, and the label, pin and light panes all close this way, and a roll request swiped down waits for later, as Later does. A sheet holding something you typed and have not sent or saved, such as a chat message or an encounter being edited, springs back and stays open. A sheet on the right of a phone held sideways keeps Hide and Close.

The shortcut sheet and FEATURES.md's Shortcuts tables are unchanged: a swipe is no key.

## 12. Decided

Settled by the project owner (2026-10-17): a sheet with unsaved input springs back from a swipe, and Close and Back behave as today (4.5).

For the project owner to overrule:
1. **The panes and the roll card swipe too**, since they rise from the bottom as the panels do. The roll card's swipe is Later, which keeps the answer typed so far, as Back already does.
2. **No drawn grab handle.** The header is the grab area. A handle bar would take height from a 120 px sheet, and the gesture is an extra.
3. **The sideways modes do not swipe**: they do not rise from the bottom (section 3).
4. **A surface with unsaved input follows the finger at half its distance** before it springs back, so the drag itself shows that it will not close.

## 13. Question for the project owner

1. The e2e drives Chromium only. iOS Safari's touch handling is the one part it cannot check. Will you try a swipe on an iPhone once this deploys? Recommended: yes, in the live play review after the wave: from the header, from content at its top, a tap on a button with a little jitter, and a scroll of content that is scrolled down.

## 14. Self-sweep

Draft 1 swept every row of section 8 and every conflict in section 5 against sections 4.1 to 4.5, and fixed as classes: owned controls as one rule (fields and `touch-action: none`), "at its top" always including the surface's own scroller, the hold for content only, a taken press cancelled as a scroll cancels it.

Round 1, each fixed as a class and every row it touches swept again:
- **Taps** (W6-ASTRA-01, W6D-01): the swipe now does nothing inside the slop and claims only at the first move past it, so a tap is the browser's own. The claim needs a cancelable move, so a browser that panned first keeps the touch (4.2). Rows: 8.2's taps, sloppy tap and not-cancelable rows, 5's tap row, tests unit 2 to 4 and e2e 3.
- **A second finger anywhere** (W6-ASTRA-07, W6D-03): document capture while a touch is tracked (4.5). Rows: 8.2, 5, unit 8, e2e 5.
- **Replacement** (W6-ASTRA-06, W6D-04, W6-P-12): every surface passes its item, the panes their item's id and the sheet its subpage too, for a drag and for a slide (4.5). Rows: 8.2, unit 8, e2e 10.
- **Closing hides everything** (W6-ASTRA-10, W6D-05, W6-P-14): the slide runs to the clip edge from the highest top among the surface and its riders, and the dock is grab area (4.3, 4.5). Rows: 8.3's dock and card rows, unit 9, e2e 9.
- **Sizes** (W6-ASTRA-08): three thresholds named, tablets upright and a wide layout with a narrow map added (8.1, e2e 1, 7, 10).
- **Unsaved input** (W6-P-11, the owner's answer): one rule, focus or a reported draft, with one hook and a class definition of a draft (4.5, 4.6). Rows: 8.3, unit 7, e2e 6.
- **A flick needs travel** (W6-P-13), **what a cancelled control hears** (W6-P-15: capture released, later events stopped at the window), **where FEATURES.md's bullet goes** (W6-P-16).

Round 2, each fixed as a class and its rows swept again:
- **A subpage's identity** (W6-ASTRA-06, W6D-04, W6-P-19): the sheet's item uses `subpageKey`, the key `useSubpageFocus` uses, so an id decides where one exists (4.5). Rows: 8.3's two journal rows, unit 8, e2e 10.
- **A focused empty field** (W6-P-18): focus counts only with the value changed since it took focus, never for a search (4.5). Rows: 8.3's focused-field rows, 4.1's typing rule (unchanged: content drags stay the browser's), unit 7, e2e 6, FEATURES.md.
- **The companion form** (W6-P-11): added, with the effect form and the folder rename that the repeated search found (4.6). Rows: 8.3's companion row, e2e 6, build step 3.
- **Listener order** (W6-P-20): the stop is added at mount, and the one earlier listener that hears the up is named, with why it is harmless (4.3).
No row is left with two answers.

## Appendix: worked numbers

Layout px are screen px divided by the interface size. The panel sheet's cap is `max(120, min(60% of the layout's height, the height less the bars, the 24 px gap and the safe areas))` (`sheetCap.ts:43-45`), with the top bar 52 px and the toolbar 60 px. A sheet whose content is shorter is shorter, and its drawn height is what counts. The flick's travel is half the floor: 22 px at 100%, 29 px at 130%.

| Screen, size | Layout height | Sheet (layout px) | Drawn (screen px) | Quarter | Floor | Distance |
|---|---|---|---|---|---|---|
| 375 x 667, 100% | 667 | min(400, 531) = 400 | 400 | 100 | 44 | 100 |
| 375 x 667, 130% | 513 | min(308, 377) = 308 | 400 | 100 | 57 | 100 |
| 390 x 844, 47/34 insets, 100% | 844 | min(506, 627) = 506 | 506 | 127 | 44 | 127 |
| 390 x 844, 130% | 649 | min(390, 432) = 390 | 506 | 127 | 57 | 127 |
| 412 x 915, 100% | 915 | min(549, 779) = 549 | 549 | 137 | 44 | 137 |
| 768 x 1024, 100% | 1024 | min(614, 888) = 614 | 614 | 154 | 44 | 154 |
| 320 x 480, 130%, fight, dock | 369 | 153 (docs/design-v1-bar-dock.md 3.2.1) | 199 | 50 | 57 | 57 |
| Minimum sheet, 100% / 130% | | 120 | 120 / 156 | 30 / 39 | 44 / 57 | 44 / 57 |
| Monster filters at 375 x 667 (92% cap) | | up to 613 | up to 613 | 153 | 44 | 153 |

Speeds: a deliberate slow drag runs about 0.1 to 0.3 px per ms, a flick 1 to 3. The e2e's slow drag sends 10 px every 30 ms (0.33), its flick 10 px moves back to back. At 0.5 px per ms a finger crosses a 400 px sheet in 0.8 s.

The slide's distance: the panel sheet with the dock is its drawn height plus the dock's 56 px (48 and its 8 px gap, `Room.tsx:689`) times the interface size. The roll card standing on Multi-select's bar at 375 x 667 travels its height plus the bar and the toolbar under it.
