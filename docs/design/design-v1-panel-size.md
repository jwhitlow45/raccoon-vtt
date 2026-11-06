# raccoon-vtt: a side panel that resizes, and a sheet a mouse can grow and shrink

Status: built (2026-11-05), from design draft 3 at review consensus, in lanes PS-A, PS-B and PS-C (section 10). "As built" (section 12) says where the build went its own way.

Draft 3, lane panelsize. Draft 1 was written on main `e58995ac`. Draft 2 folds in design review round 1 (section 13) and draft 3 round 2 (section 14), with every finding checked against `584fa7da`. Ids D-261102-972 to 979. Builds on D-261102-970 (the sheet with a mouse) and D-261102-971 (the resizable panel).

The owner (2026-11-05): "On PC narrow screens should be able to drag panel to maximize and close when grabber is visible, not currently possible on PC. Maybe instead we just have up/down arrows for max/minimize in these states on PC?" and "Resizable side panel with button to reset to default size (which will be the currently designed for size) Open to size restrictions here and other considerations."

## 1. Summary

- **Side panel.** From 900 px up, the panel's map-facing (left) edge drags to resize it, from its default 360 px up to the smaller of 640 px and what leaves the map 600 px. A Reset width button stands in the tab row while it is wider than 360. Double-clicking the edge resets it too. The edge is a keyboard separator. The width is this device's (a device setting), never the room's. The top bar gives way by its own width, so a resize never leaves its controls stuck away.
- **Sheet with a mouse.** Where the device has a mouse or trackpad, a sheet that swipes shows a small up arrow and down arrow beside its grabber. Up fills the screen. Down steps down, and from the normal height it puts the sheet away as a swipe down does. The strip around the grabber also drags with a mouse, through the same swipe machine a finger uses, under one rule of who owns the input. The sheet's content never drags with a mouse.
- Nothing changes on a phone, or for a finger anywhere.

## 2. Today (audit at `e58995ac`, rechecked at `584fa7da`)

- **Breakpoints** (`lib/theme.ts:421-446`): the wide layout from 900 layout px, with the side panel at a fixed `sidePanelWidth` 360. Under 900, panels open as sheets: a bottom sheet (at most 560 wide) or, held sideways, a 340 px sheet on the right. `chipNameMinWidth` 1100 reads the window's width.
- **The side panel** (`Room.tsx` `SidePanel`): the party dock, `SideTabs` (tabs, More, Hide panels), then one or two panes with the split bar (a separator grip, 8 px steps, 64 with Shift). 360 is read by the aside, `mapWidthOf` (`optionsLayout.ts:104`, which the toolbar's arrangement, the tool options, popovers and the alerts column read), two popover caps that borrow the number (`AttachButton.tsx:180`, `viewAs.tsx:164`) and More's menu fixture (`e2e/helpers/menuFixture.ts:42`).
- **The top bar** (`Room.tsx:1446-1498` `TopBar`) gives way step by step as its row overflows: the clock chip, the blackout notice, the DM's chip to its dot, the View button's gaps and fold, Full screen, the Phase menu. Each step records the window's layout width at which it went (`layoutWidth()`) and comes back only once the window is wider. The bar spans the map only, so a panel that widens narrows the bar with no change to the window, and the steps never come back. Hiding the panel (S) already has a milder form of this.
- **The sheet** (`lib/sheetSwipe.ts`): one machine, `SheetSwipe` in `SwipeSession`, driven by touch events. Stands: normal and full (the panel sheet and the Panels list only). `onPointerDown` returns unless `pointerType === "touch"` (`:1095`), so a mouse never drags. A claim's `takePress` cancels the press recorded in `lastDown` and marks its pointer `claimed`, whose later moves and release a window listener stops (`:881-897`, `:1019-1024`). The hook's session lives inside its effect, and its hosts (`Sheet.tsx:159`, `Dialog.tsx:212`, the four panes, the roll card) get back only `rising` and `expand`. "Expand sheet" is a hidden button that shows on keyboard focus (`SheetHeader.tsx:208`).
- **The map camera** (`Stage.tsx:394-416`): a size change keeps the world point at the center, and a fitted map refits.
- **Wider, as the prototype drew it** (shots `v2-<panel>-<width>-<size>-<scheme>`): the tab row fits 4 tabs at 360, 7 at 560, 9 at 640. Initiative's rows stop wrapping at 560. Settings rows, the Menu's cards and the Token panel read well at 640, where help runs to about 85 characters a line (95 at 720). Rows of equal buttons stretch, and Max HP and Temp HP drift apart on their row: noted for the polish pass. The token window docks against the map's right edge and follows it. The SRD stat block was not in the preview room, so the builder shoots one at 640.
- **The toolbar runs under the panel when the map is 540 wide** (`v2-clamped-1100x900-dark`, from the prototype's 540 bound): the DM's mouse toolbar needs about 546 px with its margins. A 900 px window has that 540 px map today, so section 9 checks 900 as it is.
- **Measured alignment** of the whole aside at 1440 x 900 and 1920 x 1080, at 360, 560 and 640, 100% and 130%, dark and light: one new finding, the tab row's spacing check flags the intended 8 px group gap (`tabFit.ts:30`) once two groups share the row. The sheet header with arrows measured clean at 700 x 900.

## 3. Rules shared by both parts

- **Units and rounding.** Widths are layout px (the chrome's own, before the interface size's zoom). The drawn width, every stored width and `aria-valuenow` are whole layout px, rounded down, so the 600 px map holds exactly: 1440 at 130% is a layout of 1107.7, whose cap is 507.
- **One source.** `pages/panelWidth.ts` holds the bounds, the clamp and the rounding. Room passes the drawn width to the aside, to `mapWidthOf` and to the top bar. `theme.layout.sidePanelWidth` stays the default's name. The two popover caps move to their own `theme.layout.listCap` (360), so they never follow a drag. `menuFixture.ts` keeps reading the default, since More's menu is tested at it.
- **The setting** (`features/device/settings.ts`, its own lines at the end): `null` is the default. It parses a missing key, an empty or non-number value, and any value at or under 360 as `null`, and a width equal to 360 is stored as `null`, so a later change of the default carries. Writes follow three rules, since a drag shows through the page-only `apply`, which only `set` or `restore` ends (`settings.ts:68-93`):
  - A key step compares its result with the width drawn before the key: a change stores it, and no change stores nothing.
  - A drag's release compares its final width with the width drawn as the drag began: a change commits it (`set`), and no change restores (`restore`), so a released drag always leaves page-only mode.
  - Double-click, Home and Reset width store `null` whenever the stored value is not `null`, even when the panel already draws 360 (a stored 640 in a 960 window).

## 4. The resizable side panel

### 4.1 The edge (D-261102-972)

- **Where.** An element on the aside's left border: 8 px over the map, the 1 px border and 4 px into the panel, the aside's full height. `cursor: col-resize`, `touch-action: none`.
- **Stacking.** The edge is `theme.z.panelEdge` 1: over the map's canvas and under every map layer that has a z (the token window and panes 5, sheets 10, options 14, bars 15). So where the top bar, the toolbar or a docked token window meets the map's right edge, the map's control wins the press, and only the edge's inner 4 px take it there.
- **Look.** At rest: the border, and a grip on it at the aside's mid height, a 6 x 32 px pill of `surfaceRaised` with a `controlBorder` outline. Pressed, dragged or keyboard-focused: a 3 px `accent` line the edge's whole height and the grip filled with `accent`. Keyboard focus rings the grip only (a ring round the whole strip covered the party dock's first letters). Nothing depends on hover.
- **A finger.** On `(any-pointer: coarse)`, the grip's hit grows to 44 x 44 px, all on the map's side: 43 px over the map and the 1 px border, none into the panel, so it never takes the split bar's grip or a full-width row at that height. A touch-only tablet can resize, and map layers with a z still win where they overlap it.
- **Drag.** A press (a mouse's main button, a pen or a finger) is captured. Inside the tap slop nothing moves, so a double-click never drags. Past it, the width follows the pointer, clamped and rounded (3, 4.2), shown through the setting's page-only `apply`, and the release commits or restores by section 3's rule. Escape, a cancelled pointer, S hiding the panel and the layout dropping under 900 put it back and store nothing (the split bar's and the token window's rule).
- **Double-click** stores `null` (section 3), the default.
- **Keyboard.** `role="separator"`, `aria-orientation="vertical"`, the aside's first Tab stop, `aria-label="Side panel width"`, `aria-controls` the aside, `aria-valuemin` 360, `aria-valuemax` the cap now, `aria-valuenow` the drawn width, `aria-valuetext` "360 pixels, the default" or "500 pixels". Left widens and Right narrows by 8 px, or 64 with Shift, Home goes to the default and End to the cap. Each press writes by section 3's rule. `NAVIGATES` (`shortcuts.ts:101`) already holds `[role="separator"]`, so arrows on the edge never move a token.
- Rejected: hover as the only sign, a full-height 44 px strip (it takes the first tab's and the panel's content's presses), a ring round the whole strip, an edge over the map's chrome (the toolbar's end and the bar's last button would lose presses).

### 4.2 The bounds (D-261102-973)

- **Least: 360**, the width every panel is designed and measured at (D-971).
- **Most: `floor(min(640, layout width − 600))`**, never under 360. 640 keeps help lines near 80 characters at 16 px. A 600 px map keeps the DM's mouse toolbar whole with room for the tool options. At 1440 the cap is 640 (map 800), at 1920 it is 640, at 1100 it is 500, and from 960 down it is 360.
- **The window narrows**: the panel draws at the cap now, and the stored width stays, to return when the window widens. Under 900 the sheets take over and the stored width waits. A drag or key in a narrow window that changes the width stores what it draws, so that choice wins from then on.
- A unit property holds for any stored value and any layout width: the drawn width is a whole number in [360, cap], equals the stored one clamped and floored, and the map keeps at least 600 whenever the layout is 960 or wider.
- Rejected: 720 (help past 90 characters), half the window (960 at 1920), a 540 px map (the toolbar ran under the panel), shrinking the stored width with the window.

### 4.3 Reset width (D-261102-974)

- An icon button in the tab row just before Hide panels, shown while the drawn width is over 360. Icon: Lucide `fold-horizontal` (ISC, Lucide is already credited). Name and tooltip "Reset width". It stores `null`, and focus moves to the edge as the button leaves. The tab row's fit already measures its room. It follows the token window's Reset, shown "while the window is away from its default" (`TokenActionBar.tsx:961`).
- Rejected: a button on the edge over the map, an item in More's menu, a This device row.

### 4.4 The map, the top bar and the layout while it moves (D-261102-975)

- The map's column follows, and the camera keeps Stage's rule: the center point stays, a fitted map refits, as on a window resize. Rejected: holding the map's left edge.
- Room renders on each move, so `mapWidthOf`, the toolbar's arrangement, the options, popovers and the alerts column follow live. A builder check: a 300 px drag in 20 steps shows no long task over 50 ms on the preview room.
- **The top bar keys on its own width.** `TopBar` takes `barWidth` (the map's width from 900 up, the window's below) in place of `useLayoutSize().width` and `layoutWidth()`. Every give-way record (`chipOff`, `blackoutShortUpTo`, `dmDotUpTo`, `tightUpTo`, `viewFoldUpTo`, `wideTightUpTo`, `wideFoldUpTo`, `phaseOffUpTo`, `fullscreenOffUpTo`, and the phone strip's `recordOverflow`) stores the bar's width, and every comparison reads it. While the panel is hidden the bar's width is the window's, so that case behaves as today. A panel that widens and comes back, and S hiding and showing the panel, now bring each step back once the bar has its room again.
- **`chipDot`** follows the same rule: while the panel shows, the dot shows when `width − (drawn − 360) < 1100`, and while it is hidden, when `width < 1100`, as today.
- The split panel's panes keep their heights. **View as a player** draws the Room page again on the same device, so it draws the same width.

### 4.5 Words, screen readers and sizes

- Words: "Side panel width", "Reset width", "{n} pixels", "{n} pixels, the default". A screen reader hears the separator's value as it changes. Nothing waits on the network, so nothing shows loading.
- At 1440 x 900 at 130% the cap is 507. At 1920 x 1080 at 130% (layout 1476.9) it is a genuine 640.

## 5. The sheet with a mouse

### 5.1 Who sees the arrows (D-261102-976)

- Wherever `(any-pointer: fine)` matches, read live by a new `useFinePointer()` in `lib/device.ts` (`useSyncExternalStore` on the query's `change`, as `subscribeKeyboard` listens): any mouse or trackpad, beside a touch screen too. It is the shortcut sheet's own test (`device.ts:76`).
- A touch laptop with a trackpad shows the arrows, and its finger still swipes. An iPad with a trackpad shows them. A phone never does, and a phone with a mouse does.
- Rejected: `(pointer: fine)` (a touch laptop whose primary pointer is its screen loses them), the last input used (the header would change shape as the hand moves), a This device switch.

### 5.2 The arrows (D-261102-977)

- **Look and place.** A 44 px strip at the top of the header. `useGrabberRoom` returns 44 only where `controls` reach the header and `useFinePointer()` is true, and `grabberRoom(design)` everywhere else, so a grab header with no controls keeps today's room. There `SheetGrabber` draws the grabber centered in the strip, `(44 − height) / 2` from its top, and everywhere else at `GRABBER_TOP` as today, the X-card's body included. `grabberDesigns.ts` stays pure. `useFinePointer()` reads false where `matchMedia` is missing and on the server (unlike `sheetDevice`, which counts those as a mouse), so server-rendered unit tests keep today's room. Up stands on the grabber's left and Down on its right. Each is a 44 x 44 px hit area holding the drawn 32 x 24 px pill with a 16 px `chevronUp` or `chevronDown` in `textMuted` (IconButton's transparent look), so the visible arrows are as in the preview. The drag band between them is the grabber's width and 4 px each side. The strip keeps each pill's focus ring whole at the screen's top in full screen.
- **What they do**, by the sheet's stand:

  | Sheet | Up | Down |
  |---|---|---|
  | Panel sheet or Panels list, normal | "Expand sheet": fills the screen | "Put away sheet": slides off and closes it |
  | The same, full | "Expand sheet", `aria-disabled`, a press does nothing | "Shrink sheet": back to normal |
  | A dialog as a sheet, a pane | none | "Put away sheet": their swipe's close |
  | The roll card | none | "Put away roll": Later, as its swipe does |

  The X-card has no header and no strip: Dismiss stays its way. Where the arrows show, the hidden Expand sheet button is not drawn, since Up is it, with the same name.
- **Down's words** never start with "Close" and never repeat the header's X, so a test's `/^Close/` or a screen reader's list of buttons meets one Close per sheet. "Put away" matches the roll card's. Rejected: "Close sheet" (it starts with Close, and 59 e2e Close locators match by prefix), "Lower sheet" (it does not say the sheet goes), "Dismiss" (the X-card's word), "Hide sheet" (Hide is the sideways sheet's button and Hide panels').
- **Focus.** Up stays focusable at full (`aria-disabled`), so the full sheet's modal focus restore (`modalDialog.ts:288`) finds it and focus stays on the arrow pressed. Down keeps focus as its name changes, and a screen reader reads the new name on the next focus. "Put away sheet" closes the sheet, and focus then goes where Close sends it.
- **Motion.** A press plays the slide a release at that end plays, then the close runs, the very function Close calls. A kept-open surface springs back. Reduced motion has no slide. Unsaved input never blocks Down, since it is as deliberate as Close, and the close asks whatever Close asks.
- Rejected: arrows in the header's row beside Close (a long title loses room, and at small widths the arrows' hits met the row's actions), arrows that hide at the end of their range (the other arrow would jump), a native `disabled` Up (it drops focus inside the modal sheet).

### 5.3 The controls and the input owner (D-261102-978)

**One controller per surface.** `useSheetSwipe` returns `{ rising, expand, controls }`, and `controls` is `{ stand, canFill, step(to) }`, where `stand` is "normal" or "full" and `canFill` says whether a full stand exists. Each host passes `controls` to the header that draws its grabber: `Sheet.tsx` and `Dialog.tsx` to `SheetHeader`, `LabelPane`, `LightPane`, `PinPane` and `TrapPane` to `PaneHeader`, and the roll card (`PlayerRolls.tsx`) to its own header. `SheetGrabber` draws the arrows from it. A later music player sheet passes it the same way.

**`step(to)`: the hook measures, the session moves.** The hook's `step` returns at once while a press is followed or a slide runs. Otherwise it reads fresh geometry (`readGeometry(stand)`), builds the start, and hands both to a new `SwipeSession.step(to, start)`. The session owns `risen`, `placed`, the settle and the cleanup, as for a release, so its `rest()` (`sheetSwipe.ts:585-590`) clears `rising` on arrival, on a cancel and on an item change, and `Sheet.tsx:162`'s `filled && !swipe.rising` turns the full sheet modal.
- **Up from normal:** the session sets `risen` and calls `host.rise(true)` (the whole-screen box), places the sheet at 0 in it, then slides to `−up`. Reduced motion skips the slide and arrives at once.
- **Down from full:** the slide starts from `−up`, the stand's own place, never from the last touch's position. `settle` takes the start position as an argument: the finger's for a release, the stand's for a step.
- **Down from normal:** it slides to `closeAt`, then closes.

**The input owner.** One active gesture owns a surface at a time, across touch, mouse, pen and the arrows.
- **A mouse or pen** press with the main button on the drag band calls `preventDefault`, so no text selection starts. It captures its pointer on the band and begins a session as a touch on the grab area does (`on: "grab"`, one finger, `control: false`).
  - A mouse session takes no press. Its claim skips `takePress` and `claimed`, so the window listener never stops its own moves and release, and a stale touch's `lastDown` is never cancelled for it.
  - Its `pointermove` feeds `move`, and its `pointerup` feeds `end`, wherever the pointer is, since it is captured. `pointerup` and `pointercancel` then call `lifted()`, so the document's touch watch comes off.
  - The release's ends, the flick speeds and the unsaved half-follow are the touch's own.
- **A touch** that lands while a mouse drags cancels the drag (it springs back) and starts no swipe: `onDocStart` checks the mouse session as well as the followed touch, and `onStart` returns while either is held.
- **A mouse press** on the band while a touch swipe is followed or a slide runs is ignored.
- **The arrows** do nothing while any press is followed or a slide runs.
- **Cleanup.** The mouse path's listeners and its capture come off at `end`, at a cancel, and when the item changes, the surface hides or unmounts, as the touch path's do.
- `onPointerDown` keeps returning for every pointer but touch, so the touch path is unchanged.
- Rejected: dragging the whole header with a mouse (the title's text), the content (selection and the wheel), arrows only (D-970), a mouse claim through `takePress` (the window listener froze the drag).

## 6. The shortcut sheet (D-261102-979)

| Id | Input | Does | When | Device | Section |
|---|---|---|---|---|---|
| `panelEdgeKeys` | Left, Right | Widen or narrow the side panel 8 px, or 64 px with Shift | with its edge focused | keys | Side panel width |
| `panelEdgeEnds` | Home, End | Make it its default width, or its widest | with its edge focused | keys | Side panel width |
| `panelEdgeEscape` | Escape | Put the edge back where it was | while you drag it | keys | Side panel width |
| `panelEdgeDouble` | Double-click the side panel's edge | Put it back to its default width | | mouse | Mouse with keys |

The new surface "Side panel width" follows "Side panel tabs" in `SURFACES`, with the intro "On a screen 900 px or wider. With the edge focused, the arrow keys resize the panel and never move a token." The arrows are buttons and the grabber drag is a plain drag, so they add no rows. `shortcuts.test.ts:817` and `:844` hold FEATURES.md's Shortcuts tables and intros to the registry word for word, so the rows, the intro and FEATURES.md's matching rows land in one commit (10).

## 7. UI checklist

- Loading: none (a local setting and layout only).
- Keys and focus: the edge is the aside's first Tab stop. Reset width moves focus to the edge. The arrows come before Back in the header's order. Up keeps focus at full (`aria-disabled`). The full sheet keeps focus inside, as today.
- Screen readers: the separator's name, value and value text. Arrows: "Expand sheet" (unavailable at full), "Shrink sheet", "Put away sheet", "Put away roll".
- Large sizes: the bounds are in layout px, so 130% at 1440 caps at 507. The strip is in the header's own px and scales with it.
- Targets: the arrows 44 x 44, the edge 13 px for a fine pointer with a 44 x 44 grip on a coarse one.
- Words shown: "Side panel width", "Reset width", "Expand sheet", "Shrink sheet", "Put away sheet", "Put away roll", and section 6's rows.

## 8. Cases

| Case | Expected | Test |
|---|---|---|
| Drag the edge 140 px left at 1440 | 500, stored at release, map center kept | pw-1 |
| Drag past the cap or under 360 | stops at 640 or 360, whole px | unit, pw-1 |
| Escape mid-drag, S mid-drag, a press inside the slop | back to the start, nothing stored | pw-2 |
| Double-click the edge, or Reset width | `null` stored, 360, button gone, focus on the edge | pw-3 |
| Left, Shift+Left, Home, End from 360 | 368, 432, 360 (`null`), 640 | pw-4 |
| Left at the cap in a narrow window | nothing stored | unit, pw-4 |
| Stored 640, window 1100, 960, 899, 1440 | 500, 360, sheets, 640 | unit, pw-5 |
| 1440 at 130%, and 1920 at 130% | cap 507, and 640 drawn | unit, pw-5 |
| Another window of the app changes it | this one follows (`adopt`) | unit |
| Crowded DM bar at 1440 (fight, clock, phases), drag to 640, then Reset | chip, Full screen and Phase leave, then come back | pw-6 |
| Player's chip with 640 drawn at 1440 and at 1300, and hidden at 1000 | names, dot, dot as today | pw-6 |
| Presses at the map's right edge: the toolbar's end, the top bar's end, a docked token window's band | each reaches its control, not the edge | pw-7 |
| Touch-only tablet at 1180 x 820, a finger on the grip | resizes | pw-8 |
| Phone, touch only | no arrows, Expand sheet hidden as today | sm-1 |
| 700 x 900 mouse, Enter on Up | full, focus on Up, `aria-disabled` | sm-2 |
| Then Tab, Enter | focus on "Shrink sheet", normal, focus stays, name "Put away sheet" | sm-2 |
| Then Enter | slides off, closed | sm-2 |
| Down with unsaved input | closes as Close does | sm-3 |
| An arrow as the first interaction: panel sheet, dialog as a sheet, a pane, the roll card | each steps or puts away with its slide, no jump | sm-4 |
| Mouse drag on the band up 200 px, released outside the band | full | sm-5 |
| Mouse press on the title or the content and move | text selects, the sheet stays | sm-5 |
| A touch lands during a mouse drag | the drag springs back, no swipe starts | sm-6 |
| A mouse press during a touch swipe | ignored, the swipe ends as a swipe | sm-6 |
| A touch tap, then a mouse drag (stale `lastDown`) | the drag moves and ends, no synthetic cancel | sm-6 |
| Double press Down from full | one step | unit |
| A drag released where it began | `restore`, nothing stored, page-only mode ends | unit, pw-2 |
| A drag released elsewhere | stored, and a reload draws it | pw-1 |
| Stored 640 in a 960 window (drawn 360), double-click | `null` stored, a 1440 window then draws 360 | pw-3 |
| Up from normal, then at rest | `rising` false, the sheet modal, focus inside | unit, sm-2 |
| Up with reduced motion, and an item change mid-step | arrives at once, and rests with `rising` false and no close | unit |
| X-card on a mouse device, and a grab header with no controls | grabber at `GRABBER_TOP`, today's room | unit, sm-1 |
| Touch swipes on the header and content | as today | swipe.e2e.ts |

## 9. Tests

- **Unit** (`pages/panelWidth.test.ts`): the clamp, the floor and the cap as properties over stored values and layout widths, `null` for the default, nothing stored for no change. `optionsLayout.test.ts`: `mapWidthOf` with a width, and the DM's widest mouse toolbar fits in 600 (it fails if a tool is added without moving the bound). `settings.test.ts`: the parse.
- **Unit** (`lib/sheetSwipe.test.ts`): `step` from each stand through the fake host (rise before an upward slide, a slide from `−up`, ignored while followed or sliding), the mouse session's claim with no `takePress`, `lifted()` at a mouse release, and one randomized test over touches, mouse presses, moves, arrow presses, releases outside the band, cancels and item changes. Its invariants: one owner at a time, no `takePress` for a mouse, never two closes, nothing after a cancel or an item change, a rest only at full, normal or closed, and Up never closes. `SheetGrabber.test.ts`: `useGrabberRoom` is 44 with a fine pointer, and `grabberRoom` keeps its values (`:108`).
- **E2E**: a new `panelwidth.e2e.ts` on port offset +52 (registered), with pw-1 to pw-8 and sm-1 to sm-6 on its own room. A context with both touch and a fine pointer (sm-6, the touch laptop) stubs `matchMedia` for `(any-pointer: fine)` in an init script, since Chromium's touch emulation reports a coarse pointer. `swipe.e2e.ts` runs as the touch proof. `paneltabs`, `splitpanel` and `layout` show 360 is still the default. Plus `reach`.
- **E2E that move with the arrows**: every swiping header grows 34 px (44 less the default grabber's 10) in a context without touch under 900 px. Candidates found by their contexts and viewports at `584fa7da`: bardock, blockrolls, combat, companions, dice, dmphone, encounters, fogedge, fold, iso, layout, maps, options (and options-dm-100, -130, the floor files through `optionsRoom.ts`), paste, pcstats, pdf, resync, rollmodes, rolls, shortcuts, sideheaders, size, swipe, tokenpanel-summaries, traps, undo-scope, vision. PS-B confirms each by running it on its build, fixes any height or locator it breaks, and names the files that changed. Fixes in files a panel-groups lane edits (`layout.e2e.ts`, `swipe.e2e.ts`, `animmap.e2e.ts`, `lighttheme.e2e.ts` and any other) land after lane D, on its tip (10). Down's name keeps `/^Close/` locators on the X.
- **Check of today:** a 900 x 900 window with a mouse, whether the DM's toolbar is whole. A cut there is a separate follow-up.
- **Mutation checks:** remove the clamp, the floor, the Escape restore, the top bar's `barWidth`, the any-pointer test, the arrows' guard while followed, the rise before an upward step, and the mouse claim's skip of `takePress`. Each named test fails.
- **Alignment roots** (`e2e/alignmentRoom.ts`): the tab row with Reset width at 1440 x 900 drawn at 640 at 100%, at 507 (the cap) at 130%, and at 1920 x 1080 drawn at 640 at 130%, as pw-5. The edge's grip centered on the aside's height. The sheet header with arrows at a new 700 x 900 mouse size, normal and full. `e2e/helpers/spacing.ts` learns the tab row's group gap from a `data-group-start` mark on the tab that opens a group.

## 10. Lanes and order

| Lane | Owns | Commits |
|---|---|---|
| PS-A, width | new `pages/panelWidth.ts` and test, new `pages/PanelEdge.tsx`, `features/device/settings.ts` and test (the setting, its own lines at the end), `pages/Room.tsx` (`SidePanel`'s width, `mapWidthOf`'s input, `TopBar`'s `barWidth`, `chipDot`), `pages/optionsLayout.ts` and test, `pages/SideTabs.tsx` (Reset width, the `data-group-start` mark), `components/Icon.tsx` and `CREDITS.md` (`foldWidth`), `lib/theme.ts` (`listCap`, `z.panelEdge`), `AttachButton.tsx`, `viewAs.tsx`, `state/shortcuts.ts` and `state/shortcuts.test.ts`, FEATURES.md's four Shortcuts rows and the new intro (on their own lines), `panelwidth.e2e.ts` and its pw steps | `feat(ui): a side panel that resizes from its edge`, `feat(ui): the top bar gives way by its own width`, `test(ui): ...` |
| PS-B, sheet | `components/SheetGrabber.tsx` and test, `SheetHeader.tsx` (the header and `PaneHeader`), `Sheet.tsx`, `Dialog.tsx`, `lib/sheetSwipe.ts` and test, `lib/device.ts` (`useFinePointer`), `features/builder/LabelPane.tsx`, `features/lights/LightPane.tsx`, `features/pins/PinPane.tsx`, `features/traps/TrapPane.tsx`, `features/rolls/PlayerRolls.tsx`, the sm steps in `panelwidth.e2e.ts`, and the e2e files section 9 finds that break | `feat(ui): step arrows and a mouse drag for sheets`, `test(ui): ...` |
| PS-C, sweep and docs | `e2e/alignmentRoom.ts`, `alignment-wide.e2e.ts`, `e2e/helpers/spacing.ts`, then FEATURES.md's feature prose, `docs/dm-guide.md` (a short paragraph on widening the side panel and the arrows beside the sheet's swipe), this note into `docs/design/` with its README line | `test(alignment): ...`, last `docs: a side panel that resizes and arrows for sheets` |

- PS-A and PS-B share no file and run together. PS-A creates `panelwidth.e2e.ts` with both halves' setup, and PS-B adds its steps after.
- **PS-B's start point:** its code and `panelwidth.e2e.ts` steps start on the stack's tip when it begins. Its fixes to e2e files a panel-groups lane edits land after lane D, rebased onto lane D's tip, as a last test commit.
- **Shared with panel-groups** (docs/design/design-v1-panel-groups.md 12):
  - `pages/Room.tsx` is lane A's, and lane A's chip and clock toasts sit beside `chipDot` (`Room.tsx:1026-1031`) and in `TopBar`. PS-A starts on the tip after lane A lands and merges those lines by hand.
  - `components/Icon.tsx` and `CREDITS.md` are lane A's and step 0b's. PS-A adds `foldWidth` on its own lines after them.
  - `features/dm/viewAs.tsx` is lane C's (`features/dm/*`). Lane C lands before A, so PS-A's one-line cap change comes after both.
  - FEATURES.md: PS-A's Shortcuts rows land after lane D's FEATURES.md edits, or in step with lane D, each on its own lines. PS-C keeps the feature prose.
  - `e2e/alignmentRoom.ts` is lane D's: PS-C runs after lane D, on its tip. `components/Panel.tsx` is not edited. `e2e/layout.e2e.ts` and the other panel-groups e2e files change only by PS-B's height and locator fixes, after lane D.
- **Shared with the music player** (its design, still drafting): a player sheet on a phone wires `controls` into its header as section 5.3 says. On a computer the player is a modal Music dialog (music-player D-261102-960, which rejected a floating window), so it does not depend on `mapWidth`. The music player lanes build after PS-A and PS-B (coordinator's note, 2026-11-05). `state/shortcuts.ts`, FEATURES.md and `alignmentRoom.ts` are shared hotspots, each lane on its own lines. PS-A comes before the player's window lane.
- No lane touches shared/, db/ or server code.

## 11. The preview (done)

A throwaway prototype on `e58995ac` (a patch kept outside the repository, nothing committed) drew the edge, its grip and accent, the clamp, Reset width, and arrows that worked through Expand sheet and Close. The mouse drag was not built (cursor only). It used a 540 px map bound, a 32 px strip and a native `disabled` Up, which draft 2 changed (4.2, 5.2). The shots are the `v2-` files in the `panel-size-preview` screenshots folder. The files without `v2-` come from a first run shot before the panels loaded: ignore them.

**Changed since the owner's preview:** the arrows' strip grows from 32 to 44 px so each arrow is a 44 px target, which puts 12 px more space above the header's row. The arrows look the same. Down at normal height is named "Put away sheet" in place of "Close sheet". Reset width keeps its place. Draft 3 changes nothing the owner sees: the coarse grip's hit moves wholly over the map, which draws nothing new.

## 12. As built

Built in three lanes as section 10 plans: PS-A the width, PS-B the sheet, PS-C the alignment sweep and the docs. Where the build went its own way:

- **pw-6** (D-261102-988): at 1440 a 640 panel leaves an 800 px bar, where the clock's chip and the DM chip's name give way but Full screen and the Phase menu keep their room. The test checks those two at 1440, and Full screen and the Phase menu at 1280, where they go too. Every step comes back after Reset width, a double-click and S.
- **The stored form** (D-261102-985): the default is written as an empty string, which the parse reads as `null`, since the shared `setting` always writes its format. The parse floors before it compares, so "360.5" reads as the default too.
- **Focus** (D-261102-986): a press on the edge focuses it, so its keys work right after a drag. The accent look on focus follows `lib/inputModality.ts`, and any edge key counts as the keyboard.
- **View as a player** (D-261102-989): the preview's edge resizes and stores the device's width, as the room's does.
- **The shortcut sheet** (D-261102-987): its test's rule that mouse rows name a key gains a named exception for the double-click row. FEATURES.md's four Shortcuts rows and the new intro landed with the registry in one commit, as section 6 asks. Lucide is credited in `shared/credits.ts` as well as CREDITS.md, since the icons test requires it.
- **The sheet's controls** (D-261102-982): `useSheetSwipe` returns `controls` as `null` while the surface does not swipe, so a hidden or sideways sheet draws no arrows. The owner state lives in `SwipeSession` (`holder`, `busy`, `drop()`, `landed()`, `step()`), so the randomized test covers it. `useFinePointer` reads the same query on the server as in the page.
- **The arrows' place** (D-261102-980): each 44 px target meets the drag band, so each pill sits 10 px from the grabber where the preview drew it 4 px away. The roll card's stuck header grows only above the question (D-261102-981).
- **A lost capture** (D-261102-983): while a mouse or pen drags, the hook also listens on the window, so a lost capture never leaves the sheet owned. A pen's own stylus touch does not cancel the pen's drag. A mouse press on the band lights the grabber as a finger does (D-261102-984).
- **E2E heights:** only `combat.e2e.ts` and `fold.e2e.ts` broke on the 34 px growth, and were fixed. No panel-groups e2e file needed a change.
- **One e2e file** (D-261102-991): `panelwidth.e2e.ts` holds both halves, each in its own room and contexts under one server on +52: pa-0 to pa-10 (the pw cases) and steps 0 and sm-1 to sm-6.
- **The group gap** (D-261102-990): the alignment helper's same-kind gap check (`e2e/helpers/alignment.ts`, not `spacing.ts`, which measures no row's gaps) holds the gap before a `data-group-start` control only to the other groups' gaps. Drawn cases in pl3-0 pass it marked and catch it unmarked or uneven.
- **The sweep's roots:** ps-a and ps-b in `alignment-wide.e2e.ts`. ps-a measures the tab row with Reset width and the grip at 1440 x 900 and 1920 x 1080, at 100% and 130%, at 360 and at the cap (640, or 507 at 1440 and 130%), dark and light. ps-b measures a sheet's header with its arrows at 700 x 900 with a mouse, normal and full, at 100% and 130%, dark and light.
- **The check of today** (9): at 900 x 900 with a mouse the DM's toolbar ends at 539 and the panel starts at 540, so it is whole.
- **The guide's pictures** come from `scripts/guide-panel-size.ts`. The sheet's is a 390 x 844 window with a mouse (D-261102-992), since a guide picture is 1280 x 800 or a phone's size, and a 1280 x 800 window under 900 layout px holds its sheets sideways.

## 13. Round 1 dispositions

| Id | Fix |
|---|---|
| PS-01 (P1) | 4.4: `TopBar` records and compares on `barWidth`, the map's width. Hidden panel as today. Case pw-6. |
| PS-02 | 5.3: the mouse session takes no press, calls `lifted()`, prevents selection, a touch cancels it and starts nothing. Stale-touch order in sm-6 and the randomized test. |
| PS-03 | 5.3: `step` at hook level: fresh geometry, rise before Up, slide from `−up`, ignored while followed or sliding. |
| PS-04 | 5.2: Up is `aria-disabled` and keeps focus. Keyboard steps in sm-2. |
| PS-05 | 5.3: `useSheetSwipe` returns `controls`. Sheet, Dialog, the four panes and the roll card pass it on, and join PS-B. The music player wires it too. sm-4. |
| PS-06 | 5.2: Down is "Put away sheet" or "Put away roll", never "Close". 9 lists the mouse-context e2e under 900 for PS-B, with the 34 px growth. |
| PS-07 | 10: PS-A owns `shortcuts.test.ts`, FEATURES.md's Shortcuts rows and intro, after or in step with lane D. |
| PS-08 | 4.4: `chipDot` by the bar's width while the panel shows, today's rule while hidden. pw-6. |
| PS-09 | 5.2: arrows are 44 x 44 in a 44 px strip. 4.1: a 44 x 44 grip on a coarse pointer, pw-8. |
| PS-10 | 3: `null` is the default, a width of 360 stores `null`, no change stores nothing. |
| PS-11 | 5.2: the 44 px lives in `useGrabberRoom` with `useFinePointer()`, the grabber centered, `grabberDesigns.ts` pure. |
| PS-12 | 4.1: the edge is z 1, under every map layer with a z. pw-7. |
| PS-13 | 3: whole layout px, rounded down. 507 at 1440 and 130%. |
| PS-14 | 10: lane A's chip and clock toasts, `viewAs.tsx` lane C's, `Icon.tsx` and `CREDITS.md` lane A's and step 0b's. 3: `menuFixture.ts:42`. Port +52 registered. |
| PS-15 | No change. PS-A before the player's window lane. |
| PS-ASTRA-01 | As PS-02: section 5.3's input owner, with both orders, a release outside the band and cleanup. |
| PS-ASTRA-02 | As PS-03 and PS-05. |
| PS-ASTRA-03 | As PS-04. |
| PS-ASTRA-04 | As PS-13: 507 at 1440 and 130%, 640 at 1920 and 130% (pw-5). |

## 14. Round 2 dispositions

| Id | Fix |
|---|---|
| PS-ASTRA-05 with PS-R2-03 | 3: a key step compares with the width before the key, a drag's release with its start, then commits or restores. Double-click, Home and Reset store `null` whenever the stored value is not `null`. Three new cases in 8. |
| PS-ASTRA-06 | 5.3: the hook measures and `SwipeSession.step(to, start)` owns `risen`, `placed`, settling and cleanup, so `rest()` clears `rising`. Cases for the modal turn, reduced motion and an interrupted step. |
| PS-ASTRA-04 | 9: the alignment root is 507 at 1440 and 130%, and 640 at 1920 and 130%. |
| PS-R2-01 | 5.2: the 44 px room only where `controls` reach the header and the pointer is fine. The X-card keeps `GRABBER_TOP`. `useFinePointer` is false with no `matchMedia` and on the server. |
| PS-R2-02 | 4.1: the coarse 44 px hit is 43 px over the map and the 1 px border, none into the panel. |
| PS-R2-04 | 9, 10: PS-B's fixes in panel-groups e2e files land after lane D, on its tip, as its last test commit. |
