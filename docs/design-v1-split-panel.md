# raccoon-vtt v1: two panels at once in the side panel

Status: draft 2, with the project owner's answers of 2026-10-17 (section 15) and the fixes from the design review's round 1 (11.4). Code is cited from the wave 5 tip `bbaf7cec` (main with the four wave 5 builds). This design builds on docs/design-v1-panel-tabs.md ("the tabs design"), whose row, More and menu it extends (section 10 states each addition to its contract), on docs/design-v1-layout-hierarchy.md 4.1 (the side panel, hidden and shown) and 4.2 (a phone's sheet), and on the shared popover base of docs/design-v1-tool-options.md 7.1.

The project owner asked on 2026-10-17: "Support for a vertical Split View in sidebar would be great. Even just support for two panels so initiative and character stats can be up at the same time would be great. I'll let you design how this is initiated but please make it intuitive."

Every size is in layout px, the chrome's own (`features/device/layout.ts`). Inside the side panel sizes are in its own px, which the interface size zooms (`chromeZoom`): the side panel is 360 of them wide at every interface size. "Wide" means 900 px or wider (`theme.layout.wideMinWidth`). "The room" is the height under the side panel's tab row, where panels show. Measured numbers are in appendix A.

## 1. Summary

- **Two panels, one above the other**, in the side panel on a wide layout: a top pane and a bottom pane, each with its own scroll, and a bar between them that names the bottom panel and moves by drag or by keys. Any two of the role's panels, never the same one twice. "Vertical" is read as one above the other: side by side, the 360 px side panel would give each panel about 176 px, too narrow for Initiative's rows.
- **How it starts: "Two panels"**, a checkbox item at the top of More's menu, for the DM and players. The bottom pane opens on the role's stats: Token for the DM, Characters (the player's own character's card) for a player, or Initiative when that panel is on top. So Initiative and the stats are one pick away. The bar's own controls change the bottom panel, swap the two and close the bottom one.
- **One rule for which pane a panel lands in.** The tabs pick the top panel. The bar's name picks the bottom one. With two panels, a link elsewhere (Stat block, Details, the turn strip, `/`, a pin) leaves an open panel where it is, and otherwise opens in the pane it was not pressed in: below, unless it was pressed in the bottom pane. With one panel, every path works as today.
- **The tabs row is unchanged in size and order.** The top panel's tab is chosen as today. The bottom panel's tab carries a line along its foot, and pressing it swaps the two.
- **Room for two.** Each pane keeps at least a subpage header and the very short sheet's 88 px body. A side panel too short for both shows the top panel alone and keeps the split for when it is taller. A phone shows one panel at a time, as today.
- **Remembered on this device, per role**: the two panels and the bar's place (`rvtt.sidePanelSplit`).
- **Accessibility**: the top pane is the tab panel, as today, and the bottom pane a group named by the bar, with a focusable separator for the keys, a polite status as the split opens or swaps, and one new key, O, between the panes. No new landmark.
- No op, no schema change, no server change.

## 2. Today

- The side panel (`pages/Room.tsx:2027-2115`) stacks the party bar, the tab row (`pages/SideTabs.tsx`) and one tab panel, `flex: 1` and scrolling (`:2103-2112`), which holds one `PanelBody` (`Room.tsx:877`).
- One field names it: `LocalUi.tab` (`state/types.ts:142-171`). `withPanel` sets both `tab` and the phone's `panel` (`types.ts:222-225`), so a rotation shows the last opened panel. Every path calls `ui.openPanel(id)` (`state/store.ts:447-449`): a tab (`Room.tsx:871`), More's menu (`SideTabs.tsx:314`), the phone's list (`Room.tsx:801`), Details (`Room.tsx:301-309`), Stat block (`features/tokens/statBlockOpen.ts:57-68`, from the token window and from a tracker row at `features/encounter/Row.tsx:425,674,720`), the turn strip (`InitiativeStrip.tsx:329`), `/` (`state/shortcuts.ts:372-382`), a pin (`PinPane.tsx:189`, `PinLayer.tsx:142`), Add token (`placeTool.tsx:126-127`), an area's damage page (`areas/store.ts:199-202`) and a reopen after a failed load (`RoomChrome.tsx:155-161`).
- Readers of "the open panel": `tokenPanelShown` (`Room.tsx:422`), the Log's unread (`:385`), `PanelProps.shown`, the one `subpage` state (`:458`) and Room's focus request for the chosen tab (`placeFocus`, `:671-680`).
- Panels find their own scroller: Initiative's sticky round header measures `closest("[data-pane-body]")` (`panels/TrackerPanel.tsx:147`) and picks its form by `roundHeaderForm` (`features/encounter/logic.ts:347-352`), the Log's composer is sticky at its scroller's foot (`panels/LogPanel.tsx:276`), and the Library finds `closest('[role="tabpanel"]')` (`features/images/LibraryGrid.tsx:459-463`). Dialogs are modal portals (`components/Dialog.tsx:138`).

## 3. The layout

### 3.1 Two panes and the bar

```
+--------------------------------------------+
| PARTY v                    [Ask the party] |
+--------------------------------------------+
| Token_ [Initiative] Log²  More v      [|>] |   Token's tab: a line along its foot
+--------------------------------------------+
| Round 2                   [Previous][Next] |   top pane: Initiative, its own scroll
| Goblin 1                            7/7    |
| Thorn                              18/24   |
+--------------------------------------------+
| ::  Token v                       [^v] [x] |   the bar: grip, name, swap, close
+--------------------------------------------+
| Goblin 1                     AC 15  7/7    |   bottom pane: Token, its own scroll
| Stat block v                               |
+--------------------------------------------+
```

- **The panes.** The room is a column: the top pane, the bar, the bottom pane. Each pane holds its own header slot and its own scrolling body (`data-pane-body`, the body padding of `paneBodyPadding`), so a sticky header or footer inside a panel meets its own pane's edges. The top pane's header slot holds a subpage's header or the name More cut (the tabs design 3.8). The bottom pane's holds a subpage's header, under the bar.
- **One panel.** With no split, or with too little room (3.2), the top pane fills the room, exactly as the side panel's one tab panel does today.
- **The bar** is the bottom pane's header and the divider. It is 44 px tall with a 1 px border above and below, and holds, left to right: the grip, the bottom panel's name, then at the right Swap and Close (3.3). Its blank part is a drag handle too (3.4).
- **Its look.** `surfaceRaised` behind it, so it reads as a header between two bodies. The name in a tab's text style, the icons at `sm`.

### 3.2 Sizes

- **A pane's minimum** is a subpage header (the sheet header's 56 px and its 1 px border) above the very short sheet's minimum body, 88 px (docs/design-v1-layout-hierarchy.md 4.2): 145 own px, whether or not a header shows, so a subpage opening never moves the bar.
- **Room for two**: the room holds both minimums and the bar, 336 own px. It is measured on the room's own box, which holds both panes, so it never depends on whether two show. It is measured in a layout effect before the first paint, as the side panel shows and as its panels change, and after that by a ResizeObserver whose result commits with `flushSync`, as the tabs' fit is (`pages/SideTabs.tsx:151-162`). So no frame paints one pane and the next two.
- **No measure while hidden.** A hidden side panel is `display: none` (`[hidden]`, `client/globals.css:39-41`), so its room cannot be measured. While it is hidden on a wide layout the room is unknown (`splitFits` is null), never a measure kept from before, and a request that would place a panel by it waits for the side panel to show (5.1).
- **The share.** The bar's place is the top pane's share of the room less the bar, in thousandths. With no share stored, the split is even, except that a pane holding Initiative takes at least the height Initiative needs to keep its round header stuck (its full header and two standard rows, `roundHeaderForm`, `logic.ts:347-352`: 193 own px with today's header and rows, `INITIATIVE_STUCK` in `pages/splitPanes.ts`), as far as the other pane keeps its minimum. At 1280 x 800 at 130% that gives the DM 193 and 151 in place of 172 and 172. A stored share, from a drag or a key step, always wins. A share is clamped where it is drawn, so each pane keeps its minimum, and the stored share stays as it was, as the token window's stored size does (docs/design-v1-token-window.md 7).
- **What changes the panes' sizes**: the room (a resize, a rotation, the interface size, the party bar folding, a font), the share, and, while no share is stored, which pane holds Initiative. Never a subpage, a header, a badge or a panel's content.

### 3.3 The bar's controls

- **The grip**, 44 x 44, the six-dot `grip` icon the token window's grip draws. It takes focus and is the keyboard's way to move the bar (3.4, 9.1).
- **The name**: the bottom panel's title and a down caret, in a quiet button, as wide as its words. It opens "Panel below", a menu of every panel the role has from 900 px up, grouped as More's (`panelSections`, `features/panels.ts:138-151`), on the shared popover base. The bottom panel's item is checked. The top panel's item shows "on top" at its end, and picking it swaps the two. The menu opens on the side of the bar with more room, decided as it opens, inside the side panel's inner box, and scrolls past that.
- **Swap**, 44 x 44, a new `swapPanels` icon (an up arrow beside a down arrow, drawn in the icon set's 2 px stroke). It swaps the two panels.
- **Close**, 44 x 44, the `close` icon. It closes the bottom panel, and the top one fills the room.
- The bar has 4 px side padding and 4 px gaps, which leaves the name about 200 px. The widest title with its caret, "Encounters ▾", is at most 121 px in the fonts the tabs design measured (its 3.2). A longer title would end in an ellipsis inside the name, which keeps the whole title for screen readers.

### 3.4 Moving the bar

- **By pointer**: a press on the grip or on the bar's blank part, with pointer capture, `touch-action: none` and the row-resize cursor, moves the bar once it passes `TAP_SLOP_PX` (8 px). A press that never passes it does nothing. The top pane follows the pointer, clamped at both minimums. On release the share is stored. Escape or `pointercancel` puts the bar back where it was. These are the token window's drag rules (docs/design-v1-token-window.md 4.2), on one axis.
- **By keys**: with the grip focused, Up and Down move the bar 8 px, or 64 px with Shift, each press stored at once and clamped. Left, Right, Home and End do nothing there. Every key it handles is marked used.
- One pointer at a time, as for the token window. The side panel hiding mid-drag (S) ends the drag as `pointercancel` does.
- A press on the bar closes an open popover, by the base's rule, before it drags.
- No animation: the bar follows the pointer, a key step and a swap show at once.

### 3.5 Which panels

- **Any two** of the role's panels from 900 px up (`panelsFor(role, true)`, `features/panels.ts:112-114`): Token, Initiative, Log, Journal, Areas, Characters, Library and Menu for everyone, and DM, Scenes, Monsters, Encounters and Outliner for the DM.
- **Never the same panel twice.** Every way to put a panel in one pane takes it from the other, by swapping (5.1). One `PanelBody` per panel, so no panel's code meets a second copy of itself.

## 4. Starting, closing and swapping

### 4.1 How it starts

**Primary, and the only way: "Two panels" at the top of More's menu**, a `menuitemcheckbox` with a glyph of a framed panel split across its middle (a new `splitPanel` icon), then a line, then the panels under their headings. Picked, the side panel splits, with the open panel on top and the default panel below (4.2). Picked again, the bottom panel closes.

Why there:

- **It is seen.** A DM opens More in nearly every session: Journal, Areas, DM and Scenes are in play and in it, and so are the preparing panels. A player's More holds Journal, Characters, Library and Menu. At the top of the menu it shows each time, at every interface size, before any scrolling.
- **It costs the row nothing.** A split button beside Hide panels would take 48 px of the row, and in the 247 px left the fit holds Token and Initiative only, so Log would move into More for everyone (the tabs design 3.6). The project owner kept Log in the row once already for that reason.
- **It says what it does** in words, on every device, with a pointer, a finger, the keyboard or a screen reader.

Weighed and not taken:

- **Dragging a tab into the panel.** Found by trying, not by looking, so a DM who never reads docs may never find it. It needs drop targets, a ghost and an undo story, and on a tablet it competes with a tap. Every pair it could make, the menu and the bar make.
- **Stat block in a tracker row opening Token below, unasked.** It fits the request's own pair, but the token window's Stat block, the more used of the two, would still replace Initiative, so the same words would act two ways. And a DM who prefers one tall panel could not stop it. The project owner decided against it (section 15).
- **A Split item on each tab.** A tab has no menu without a long press or a right click, and the project's touch rules forbid both.

### 4.2 The panel below at the start

The role's stats panel, or Initiative when that panel is on top, decided by the project owner (section 15):

- **The DM**: Token. It follows the selection, so a tap on a tracker row or a token shows that creature below.
- **A player**: Characters, which opens a player's only character's card at once (`features/tokens/CharactersPanel.tsx:63`), with its stats. Token would stay empty until the player tapped a token.

Initiative is the fight, so either start gives the request's pair. The bar's name changes the bottom panel in one more pick.

### 4.3 Closing and swapping

- **Close** on the bar, or "Two panels" picked again: the bottom panel closes, its `PanelBody` unmounts as a tab's panel does today when another tab is chosen. After Close focus goes to the chosen tab. After "Two panels" it goes to More, the menu's anchor, as every pick in the menu does (9.2). The share stays stored for the next split.
- **Swap** on the bar: the two panels change places, focus stays on Swap (as the next bullet keeps it), and the status says "Token on top, Initiative below" (9.3). A tab press or a menu pick that names the other pane's panel swaps the same way (5.1).
- **What a swap keeps**: each panel's state, subpage, every scroll offset and focus. The panes and the bar are siblings in one list keyed by panel, so React mounts nothing again. It moves the elements with `insertBefore` (react-dom here has no `moveBefore`), and a moved element loses its scroll offsets and, by the browser's focus fixup, the focus inside it. So the room's box keeps, as they happen, every element inside it that scrolls and where (a capture `scroll` listener, nested scrollers such as a wide table included). Focus is read once, as the swap is asked for: the side panel subscribes to the room's store, and zustand calls a subscriber synchronously inside the state change, before React commits the move, so the subscriber reads `document.activeElement` whenever the pair is about to change places, whichever path asked (Swap, a tab, either menu's pick, rule 1's swap). In the layout effect after the move, before paint, it puts each offset back, and it focuses that element again with `preventScroll` only if the element was inside the moved panes or bar and no longer holds focus (`swapFocus` in `pages/splitPanes.ts`). No older record is used. Safari, VoiceOver included, does not focus a pressed button (`features/panels.ts:314-320`), so a tap on Swap there often starts with focus on the page, and focus then stays on the page: an old record, such as the Log's composer, would raise an iPad's keyboard. Every swap starts from a press or a key on a button, a tab or a menu item, never from typing, so the blur on the way saves nothing.

## 5. Where a panel opens

### 5.1 The rule

"Two show" means the split is on and the room holds two (3.2) on a wide layout. Every path gives `ui.openPanel` the panel and how it was asked:

- **`{ pane: "top" }`**: a tab, More's menu, a phone's list of panels.
- **`{ pane: "below" }`**: the bar's name and its menu.
- **`{ from: id }`**: a link inside panel `id`. Today only a tracker row's Stat block, which says `from: "tracker"`, and the Areas panel's damage button.
- **nothing**: everything outside the panels.

Then, in one pure function, `withPanel(local, id, how)` in `state/types.ts`:

0. **A phone-only panel** (`narrowOnly`, today the DM's Party, `features/panels.ts:105-106`), which only a phone's list opens: it becomes the phone's sheet (`panel`), and `tab` and `below` stay as they were. So the wide pair stays two different panels the side panel has, and the stored split never holds it.
1. **One shows** (no split, a room too short for two, or a phone): the panel goes on top, as today. If it was the bottom panel, the two swap, so a kept split never holds one panel twice.
2. **Two show, a pane named**: the panel goes there. If it was in the other pane, the two swap.
3. **Two show, already open**: a link leaves it where it is. Nothing moves.
4. **Two show, a link**: the panel replaces the one in the other pane from the one the link sits in: from the bottom pane it opens on top, and from the top pane or from outside the panels it opens below.

In every case the side panel shows (as `withPanel` clears `sidePanelHidden` today), the phone's `panel` becomes this one, so a rotation shows the panel opened last, and `panel` is always the top's, the bottom's, a phone-only panel or none. Closing the bottom panel moves `panel` to the top's when it was the bottom's. The phone's list marks `panel`, else the top's.

**The room unknown.** On a wide layout with a split kept and the side panel hidden, the room is unknown (3.2), so rules 1 to 4 cannot choose. The request then shows the side panel and waits in `local.pendingOpen`, the panel and how it was asked. `fitSplit`, which Room calls from the layout effect that measures the side panel as it shows, sets the room and places the waiting panel by rules 1 to 4 in the same step, before the first paint. A focus request for it (Details) waits for that placing too, and a later request replaces a waiting one. Closing the split while a request waits places it at once by rule 1, since the room no longer decides (found by the build's randomized test). With no split kept the room does not matter, and rule 1 places the panel at once, as today.

So a link never covers the panel it was pressed in. With two panels, a link from outside the panels always lands below, so the top panel changes only by the tabs or by a link pressed in the bottom pane. With one panel nothing changes from today.

### 5.2 Every path

| Path | Asks | With Initiative on top and Log below |
|---|---|---|
| A tab, More's pick, the phone's list | `pane: "top"` | Journal replaces Initiative. The Log tab swaps the two |
| The bar's name | `pane: "below"` | Journal replaces Log. Initiative's item swaps the two |
| Stat block in a tracker row | `from: "tracker"` | Token replaces Log, at its stat block |
| Stat block, Details in the token window | nothing | Token replaces Log. Details sends focus to the bar's name (9.2) |
| The turn strip | nothing | Initiative is open: nothing moves |
| `/` | nothing | Outliner replaces Log, focus in its search |
| A pin's journal page | nothing | Journal replaces Log, at the page |
| Add token's Monster…, Character… | nothing | Monsters or Characters replaces Log |
| An area's damage page, from the map | nothing | Areas replaces Log |
| The same, from the Areas panel | `from: "areas"` | Areas is open: its subpage opens where it is |
| A reload after a failed load | nothing | With two, the split was stored (8), so the panel is open again where it was |
| Party in a DM's phone list | `pane: "top"` | Rule 0: the sheet shows Party. Initiative and Log stay the pair for the next wide layout |
| Details with the side panel hidden | nothing | The side panel shows, and Token goes below once the room is measured, or on top if the room is now too short for two |

`openStatBlock` takes `from` as an option. Code inside a panel reads its own panel's id from a context `PanelBody` provides (`usePanelHere()` in `features/panels.ts`), so a panel never names itself.

## 6. The tabs row with two panels

An addition to the tabs design's contract (its sections 3, 4.1, 5.1, 5.2 and 6), with its one-row fit unchanged:

- **The chosen tab is the top panel's**, as today: in the row, or More named by it. The tab panel it labels is the top pane.
- **The bottom panel's tab**, where the row holds it, takes its rest look with a 2 px accent bottom border in place of its 1 px one. Its box is 44 px tall with `border-box` sizing, so neither its width nor its height changes and the fit reads nothing new, and a border, unlike a shadow, stays in forced colors. Its description is "Shown below", which says where it is and leaves the press to the swap's status. A press on it, or Enter or Space, swaps the two. Focus reaching it by Left, Right, Home or End chooses nothing, as on More, so passing over it never changes the bottom pane.
- **More's menu** gains "Two panels" at its top and a line under it (4.1). The bottom panel's item, where More holds it, shows "below" at its end and is described "Shown below". Picking it swaps the two. The menu's opening item becomes the checked panel's, else the first panel's, so "Two panels" never takes the place a key open lands on.
- **"Two panels" with too little room**: unchecked, it is disabled, with "too short" at its end and the description "The side panel is too short for two panels." Checked, it stays enabled, described "Too short for two now. They come back when the side panel is taller.", and picking it ends the split.
- **More's look and badges** do not change. More cannot name two panels, and the bar names the bottom one.
- **More is always there.** With today's registry More holds panels for both roles at every room (the tabs design 3.2), so "Two panels" always has its place. A registry that one day fits every tab in the row needs another place for it, and a unit test says so (12.1).
- **`Menu`** (`components/Menu.tsx`) gains an item kind `checkbox` (`menuitemcheckbox`, checked in the pressed look with a check mark at its end), `disabled` (`aria-disabled`, focusable, picks nothing) and `note` (muted text at its end, hidden from screen readers since the description says it). A row item may show its `glyph` at its start. `openingIndex` (`components/menuKeys.ts:61-65`) counts only radio items, so the opening item is the checked radio item, else the first radio item.

## 7. Phones, short side panels, rotation and resize

- **A phone** (under 900 px) shows one panel at a time, as today: the sheet, the very short sheet and the Panels list do not change. The split stays in the room's state and on the device. An open on the phone follows rule 1 (5.1), so the sheet's panel is the top one when the screen is wide again. The bottom one stays, unless the sheet's panel was it, when the two swap. A phone-only panel follows rule 0 and leaves the pair alone.
- **Crossing to 900 px or wider**: the side panel draws the top panel, and the bottom one with the bar when the room holds two. **Crossing below**: the sheet shows the panel opened last, as today (`crossWide`, `types.ts:266-269`). With Party opened last on the phone, crossing wide draws the pair as it was, where today the side panel fell back to its first tab, Token, since Party is no tab.
- **A side panel too short for two** (a large phone held sideways with the DM's party bar, a window dragged short): the top pane fills the room, the bottom pane stays mounted and hidden, as a hidden side panel keeps its content, so a half-typed Log message survives. "Two panels" stays checked. When the room grows, both show again with the stored share. Focus in the bottom pane as it hides goes to the chosen tab, and a focus request into the hidden pane waits until it shows (9.2). Folding the party bar can make room on a short screen, and the split then shows.
- **The side panel hidden** (Hide panels, S): both panes hide with it, and Panels brings both back with focus on the chosen tab, as today.
- **Every interface size**: the side panel is 360 own px wide and the room is measured in own px, so the rules hold as they are. 1024 x 768 at 130% lays out 788 px wide and is a phone layout.

## 8. Memory

- **The key**: `rvtt.sidePanelSplit`, read and written in try and catch as every `rvtt.*` key is (`pages/sidePanel.ts` is the pattern): an object with an entry per role, for example `{"dm":{"share":620,"top":"tracker","below":"token"},"player":{"share":500}}`.
- **An entry**: `share`, an integer from 1 to 999, else none, which draws the default of 3.2. `top` and `below`, both present, two different panels the role has from 900 px up: the split. Anything else in an entry reads as no split with that share. A bad or missing key reads as no split and no share for both roles.
- **Written** when the split opens, closes or swaps, when either of its panels changes, and when a drag or a key step ends. One panel's tab presses write nothing, as today.
- **Read** once per Room page, once the viewer's role is known. With a split stored, the page starts with its top and bottom panels in place of the default Initiative tab.
- **Per role**, because the roles have different panels and a DM's room is laid out for running it. The side panel's shown or hidden choice stays one value for both roles (`rvtt.sidePanel`).
- **"View as a player"** reads the player's entry and never writes, as it treats `rvtt.sidePanel` and the token window's spot.

## 9. Accessibility

### 9.1 Roles and names

The DM at 1280 x 800, Initiative on top, Token below:

```
tablist "Panels"
  tab "Token"            described "Shown below"
  tab "Initiative"       selected
  tab "Log"
  tab "More panels"      haspopup=menu
button "Hide panels"
tabpanel "Initiative"    (top pane)
separator "Resize the two panels"   focusable, horizontal, value 50, text "Initiative 50 percent"
button "Token below"     haspopup=menu, expanded=false
button "Swap panels"     described "Puts Token on top"
button "Close Token"
group "Token below"      (bottom pane, labelled by the button above)
status                   (visually hidden, polite)
```

- **One tab panel and a group.** The top pane is the tab panel, labelled by the chosen tab, as today. The ARIA tabs pattern shows one tab panel at a time, and a second one beside an unselected tab would be heard as "Token, not selected" and then a Token tab panel. So the bottom pane is `role="group"`, labelled by the bar's name, whose accessible name is its visible title with a visually hidden " below", so speech input that says "Token" finds it (WCAG 2.5.3). A group is no landmark, and no `region` is added, so the landmarks stay the side panel's `complementary` alone. Both panes carry `data-pane`, and the Library's focus helper (`features/images/LibraryGrid.tsx:460`) looks for `[data-pane]` before `[role="tabpanel"]`, so it finds its own pane in either place.
- **The grip** is `role="separator"` with `aria-orientation="horizontal"`, `aria-controls` the top pane, `aria-valuenow` the top pane's percent of the room less the bar, `aria-valuemin` and `aria-valuemax` from the clamps, and `aria-valuetext` "Initiative 50 percent". `[role="separator"]` joins `NAVIGATES` (`state/shortcuts.ts:68`), so no arrow or Page key on it ever moves a token.
- **"Two panels"** is `menuitemcheckbox`, checked while the split is on. "Panel below" is a `menu` of `menuitemradio` with the same groups, notes and keys as More's.
- **Targets**: the grip, the name, Swap, Close and every menu item are at least 44 x 44.

### 9.2 Focus

- **A panel's name.** Every request to focus "the panel" (Details, Panels, a phone pick) goes to the name of the pane that holds it: the chosen tab for the top, the bar's name for the bottom. Room's request carries the panel's id for this (`placeFocus`, `Room.tsx:671-680`).
- **Tab order** follows the page: the tab row, Hide panels, the top pane, the bar's grip, name, Swap and Close, the bottom pane.
- **Subpages.** Each pane runs `useSubpageFocus` with its own header, body and fallback: the chosen tab for the top, the bar's name for the bottom. Room keeps one subpage per panel id, not one for the side panel, so a swap carries each pane's header. The hook leaves focus alone on a pane's name and in either menu: the bar carries `data-pane-bar`, the bar's menu carries `data-tabs-menu`, and the hook's selector (`features/panels.ts:385`) gains `[data-pane-bar]`.
- **Picks.** "Two panels" and every item in either menu close by the base's rule, focus on their anchor (tool options 7.1). A pick in "Panel below" therefore ends on the bar's name, which names the new panel.
- **Closing** the bottom panel puts focus on the chosen tab. **A swap** leaves focus where it was: on Swap, on the tab, on More, or on the page when the press gave it nowhere (Safari), put back after React's move only when the move took it (4.3).
- **A focus request into a panel waits until its pane shows.** A mounted but hidden pane (the side panel hidden, or the bottom pane in a room too short for two) cannot take focus. So a panel takes a focus request from outside only in an effect after the commit in which its pane shows (`PanelProps.shown` true), never in the request's own call. The stat block's request already does (it is read in an effect, `StatBlockSection.tsx:82-90`). The Outliner takes `/` in the shortcut's own call (`shortcuts.ts:378-381`, `features/outliner/OutlinerPanel.tsx:73-86`), which with the Outliner in the hidden bottom pane spends the request before the swap shows it, and today does the same with the side panel hidden. So its listener only marks the request, and an effect on `shown` and the request focuses the search, selects it and clears the request.
- **A pane that hides with focus inside it** (the room too short for two, or rule 1's swap while one shows) puts focus on the chosen tab, unless the action that hid it places focus itself, as Stat block does at its block.
- **A dialog** from either pane is modal, so neither pane changes under it, and it returns focus to its opener as every dialog does. If a resize hid the bottom pane meanwhile, focus falls to the page, as when any dialog's opener has gone.

### 9.3 The status

One visually hidden polite status in the side panel. It says "Two panels, Token below" when the split opens, and "Token on top, Initiative below" after any swap, so a screen reader hears what moved while focus stays put. It says nothing for a resize, a close (focus moves to the tab and says it) or a change of the bottom panel (focus is on its name).

### 9.4 Keys and the shortcut sheet

The sheet lists keys and key-plus-pointer combinations only (the project owner, 2026-10-16). The rows are in the shape of `SHORTCUTS` and `BEHAVIORS` (`state/shortcuts.ts`), and FEATURES.md's Shortcuts tables mirror them.

**Keys** (`SHORTCUTS`, the sheet's Keys section):

| `id` | `keys` | `does` | `roles` | Change |
|---|---|---|---|---|
| `otherPanel` | O | Go to the other panel, with two in the side panel | everyone | New |

From anywhere in the side panel above the bar it goes to the bottom panel's name, and from anywhere else, the bar included, to the chosen tab. O is free (FEATURES.md "Keys"), a letter so `letterOf` finds it on every layout. F6, the usual key between panes, belongs to the browser. Its `when` is that two show, through a scoped slot as S uses (`sidePanelKeysSlot`, `shortcuts.ts:384-392`).

**A new surface, "Two panels"**, after "Side panel tabs" in `SURFACES` (`shortcuts.ts:430`), with the intro: "On a screen 900 px or wider, with two panels in the side panel. With the bar's grip focused, the arrow keys move the bar and never move a token."

| `id` | `input` | `does` | `when` | `device` | Change |
|---|---|---|---|---|---|
| `splitGripKeys` | Up, Down | Move the bar 8 px, or 64 px with Shift | with its grip focused | keys | New |
| `splitDragEscape` | Escape | Put the bar back where it was | while you drag it | keys | New |
| `splitNameKeys` | Enter, Space, Down, Up on the bottom panel's name | Open its list of panels, at the one open or the first, or with Up the last. The list takes More's list keys | | keys | New |

**"Side panel tabs"**, changed rows:

| `id` | `does` |
|---|---|
| `tabsSide` | Switch to the tab beside it, wrapping around at the ends. On More, or on the panel open below, stop there and switch nothing |
| `tabsEnds` | Go to the first tab, or to More, the last, switching as Left and Right do |
| `tabsListPick` | Open the panel, or turn Two panels on or off, and close the list. More then shows the panel's name |

No plain click, tap or drag has a row: the bar's drag, a press on Swap or Close, a tab press that swaps. Every row is for everyone.

## 10. What this changes in other designs

- **docs/design-v1-panel-tabs.md**: section 6 of this design is the addition to its contract, in one place: 3.8's header moves into the top pane, 4.1's menu gains "Two panels", 4.4's `Menu` gains its item kinds, 5.1's roles gain the bottom panel's tab and item, 5.2 and 5.4 change `tabsSide`, `tabsEnds` and `tabsListPick`, and 6's "no caller changes" becomes this design's rule (5.1). Its fit, cap, badges, More's look and every other rule hold.
- **docs/design-v1-layout-hierarchy.md 4.1**: "What follows its state" counts a panel shown in either pane: `tokenPanelShown`, the Log's and the Journal's "on screen" and `PanelProps.shown` hold for the top pane, and for the bottom pane while two show. 4.2's phone sheet is unchanged.
- **docs/design-v1-tool-options.md 7.1**: the bar's "Panel below" is one more popover on the base, adding nothing to it. Its side is the consumer's input, chosen as it opens.
- **docs/design-v1-token-window.md**: its drag rules are reused for the bar (3.4). The token window, its free area and the alerts column do not change, since the side panel's width does not.

## 11. Edge cases

### 11.1 By size

Room in the side panel's own px, from appendix A, measured with the dev fixture's party bar of two members. A smaller party leaves a taller room, so the build's e2e works the expected panes out from the room it measures. "Split" is the default's two panes with no share stored: even, or with Initiative given what it needs (3.2), shown as Initiative's first.

| Layout | Interface size | DM room, split | Player room, split | Notes |
|---|---|---|---|---|
| 1280 x 800 | 100% | 574: 264 and 264 | 739: 346 and 347 | Initiative's round header stays stuck in either pane |
| 1280 x 800 | 130% | 390: 172 and 172, or 193 and 151 with Initiative | 555: 254 and 255 | With Initiative, the default keeps its round header stuck. A share the DM stores below 193 makes it scroll with the order, its own rule for a short pane |
| 1920 x 1080 | 100%, 130% | 854: 404 each, and 606: 280 each | 1019, 770 | |
| 1024 x 768 | 100% | 542: 248 each | 707 | |
| 1024 x 768 | 130% | phone layout (788 px wide) | the same | One panel, as today |
| 1366 x 768 | 130% | 366: 160 each, or 175 and 145 with Initiative | 530 | Too little room for 193: Initiative takes what the other pane's minimum leaves, and its header scrolls |
| 900 x 800 | 100% | 574 | 739 | As 1280 x 800 |
| A tablet, 1180 x 820 | 100%, 130% | 594: 274 each, and 406: 180 each, or 193 and 167 with Initiative | 759, 570 | Touch: the bar drags with a finger |
| A large phone sideways, 932 x 430 | 100% | 264, too short: "Two panels" disabled | 369: 161 and 162, or 178 and 145 with Initiative | The DM's party bar starts folded there. Folded or not, the DM's room is under 336 |
| A phone sideways, 844 x 390 | 85% (993 x 459) | under 300, too short | about 380 to 400: two | Worked out from the 932 x 430 rows, less the 21 px home-bar inset |
| Under 900 px wide | any | phone layout | the same | One panel. The split stays for later |

### 11.2 By panel pair

- **Tall content** (Library, Monsters, a journal page, the Outliner): each scrolls in its pane. The Library's focus helper finds its own pane by `data-pane` (9.1).
- **A sticky header** (Initiative's round header, `panels/TrackerPanel.tsx:134-203`): measured on its own pane's scroller. Full and stuck from 193 own px, static below (appendix A). In the bottom pane it sticks under the bar.
- **A sticky footer** (the Log's composer, 113 px): at the 145 minimum it leaves one line of messages, at 172 about one message. The messages scroll above it. A DM who wants more drags the bar.
- **The Token panel's folds and its stat block**: the stat block request scrolls the block to the top of whichever pane holds Token, and focuses it.
- **Subpages** (a journal page, Members, the encounter editor with its "Discard changes?" Back): each pane draws its own header and Back, inside its minimum.
- **The journal editor, the PDF viewer, a picker, any dialog**: modal portals, whole screen or centered, from either pane.
- **Menu**: in either pane, the X-card first in it.
- **A panel loading the first time, or failing to load**: its `Loading` or its load notice shows in its own pane, and the other pane works on.
- **A phone-only panel** (Party): never in a pane. Rule 0 keeps it out of the pair and out of storage.
- **A panel that takes focus on request** (the Outliner for `/`, the stat block) in a hidden pane: the request waits until the pane shows (9.2).
- **Two panels that both badge** (Log below, Journal on top): each reads itself as on screen while shown, so neither counts unread.

### 11.3 By state

- **The same panel twice**: impossible. Every path swaps (5.1).
- **Opening a panel with the side panel hidden**: the side panel shows, and with a split kept the panel waits for the room's measure before it is placed (5.1). So with Initiative above Log, hidden, then the window made 1280 x 480 and Details pressed, Token opens on top, in sight, since the room is now too short for two. At 1280 x 800 it opens below. A side panel that starts hidden waits the same way.
- **A tab press on the bottom panel's tab**: swap. Arrowing past it: nothing.
- **The bar's menu open, then**: a drag on the bar closes it first, a tab press closes it and acts, and the side panel hiding or the room shrinking below two closes it with its anchor. More's menu stays open through the latter.
- **A stored split whose panel the role no longer has**, or a top equal to its bottom: no split, the share kept.
- **"View as a player"**: its own split, from the player's entry, never written.
- **A panel's own `close()`** (the X-card's button, a journal page's link): on a wide screen the side panel stays, in either pane, as today.
- **Two browser tabs on one device**: each page reads the key once as it loads, so a split made in one shows in the other only after a reload, as `rvtt.sidePanel` does.
- **A reload**: the split, its panels and its share come back. A reopen after a failed load finds its panel open (5.2).
- **The X-card's path**: unchanged on screen, Menu in More. At 1280 x 800 at 100% the DM's menu, now one item and a line taller, scrolls by about 14 px, so Menu's last pixels sit under "Scroll for more" until scrolled. At 130% it scrolled already.

### 11.4 Self-sweep

Checked against the matrix before commit, by class:

- **Anything that could move the bar.** Headers, subpages, badges and content: none, since the minimum holds a header whether or not one shows and the share is stored, not measured (3.2). The room moves it, by the share and the clamps, and with no share stored so does Initiative changing panes (round 1's default).
- **Anything that reads "the open panel".** `tokenPanelShown`, the Log's and the Journal's on-screen state, `shown`, the subpage state, the focus request, the reopen. Each now asks about a shown pane, or keys by panel (5.1, 9.2, 10). The sweep found the single `subpage` state, which a swap would have put on the wrong pane, and the focus request, which knew only the chosen tab.
- **Every path that opens a panel** (5.2): each has one row and one outcome from one function. The sweep found that a link from the top pane and one from the map need the same target, so the rule has three cases, not one per path.
- **Keys.** The grip's arrows, Escape while dragging, O, the tab keys passing the bottom panel's tab, both menus' keys. The sweep found that selection following focus would have swapped the panes as the tabs were only arrowed past, so the bottom panel's tab now chooses nothing on focus, as More does (6).
- **One panel twice, and losing state.** Swaps everywhere, keyed panes, scroll kept by panel (4.3). The sweep found that two sibling panes keyed by position would have remounted both panels on every swap.
- **Lifecycle.** Mount, a stored split, hide and show, the room too short and tall again, crossing 900 px, the preview. The sweep found that a hidden side panel measures 0, which would have ended "room for two" (round 1 then replaced the kept measure with an unknown room, below), and that a pane hiding with focus inside dropped focus to the page, so it goes to the chosen tab (9.2).
- **Looks.** The bottom panel's mark, the bar, the notes. The sweep found that an inset shadow for the mark vanishes in forced colors, so it is a border inside the tab's fixed box (6).

After the design review's round 1, by class:

- **What a DOM move loses** (W6-P-1): React's keyed move uses `insertBefore`, which drops focus and every scroll offset in the moved elements, not only the pane bodies'. A swap now puts back every recorded offset and the focus (4.3, 9.2). Re-swept: every swap path (Swap, a tab, More's pick, the bar's pick, rule 1's swap), e2e case 2.
- **Decisions from a stale or missing measure** (W6-ASTRA-03, W6-P-6): a hidden side panel's room is unknown, not kept, and a request waits for the measure taken before paint (3.2, 5.1). Re-swept: every path in 5.2 with the side panel hidden, a stored split's first frame, e2e case 6.
- **Requests a hidden pane cannot take** (W6-ASTRA-09): focus requests wait for `shown` (9.2). Re-swept: `/`, Stat block, Details, a pin's page, e2e case 8.
- **Panels the pair cannot hold** (W6D-02): phone-only panels have rule 0, so neither the pair nor storage meets Party. Re-swept: crossing 900 px both ways, storage, e2e case 7.
- **Roles and words** (W6-P-3, W6-P-2, W6-P-4): the bottom pane is a named group, "Shown below" says a state, a player starts on Characters, and "vertical" is read as stacked. Re-swept: 9.1, 6, 4.2, 12, 14.
- **The default share** (W6-P-5): Initiative's pane keeps its header stuck where the room allows (3.2). Re-swept: every row of 11.1.

After round 2:

- **Which focus a swap brings back** (W6-P-17): only the element focused as the swap was asked for, read synchronously at the state change, and only when the move took focus from it. A `focusin` record could be minutes old in Safari, which focuses no pressed button. Re-swept: each swap path with focus on its control, on the page (Safari), on a tab outside the room, and in the bar's menu, which closes to its anchor after the move.

## 12. Tests

### 12.1 Unit tests (node:test)

- **`client/state/split.test.ts`** (new), over `withPanel`, `withSplit`, `withoutBelow` and `withSwap` in `state/types.ts`: every row of 5.2 with two showing and with one, each way of asking against each place the panel may already be, the swap that keeps a kept split distinct with one showing, the start pair (Token below for the DM, Characters for a player, Initiative when that panel is on top), rule 0 for Party (the pair and `below` unchanged, `panel` Party, crossing wide and back), a request while the room is unknown held in `pendingOpen` and placed by `fitSplit` with each answer, closing moving `panel` to the top's, `sidePanelHidden` cleared, the same object back when nothing changes, and the preview's copy taking the same results.
- **`client/pages/splitPanes.test.ts`** (new), over `splitPanes`, `swapFocus` and the storage in `pages/splitPanes.ts`: `swapFocus` gives back the element read before the swap only when it was inside the moved panes or bar and lost focus, and nothing when focus was on the page or outside the room before, or still holds it after, so focus on the page before a swap stays on the page, room for two from exactly 336, the default with no share stored (even, and Initiative's pane given `INITIATIVE_STUCK` as far as the other keeps its minimum, in either pane), each pane's size from a share and its clamp at both minimums, a stored share kept while clamped, key steps of 8 and 64 clamped, a drag under the slop changing nothing, the separator's percent, and `rvtt.sidePanelSplit`'s parsing (each bad value section 8 names), per role, the preview never writing, storage that throws.
- **`client/components/menuKeys.test.ts`**: the opening item skips a checkbox, a disabled item is focusable and picks nothing.
- **`client/features/panels.test.ts`**: `panelSections` over every panel, as "Panel below" uses it.
- **`client/pages/tabFit.test.ts`**: with today's registry and measured widths, More holds at least one panel for both roles at every room from 1 to 295 px, the widest row the 360 px side panel has, so "Two panels" has its place.
- **`client/state/shortcuts.test.ts`**: O for both roles, `[role="separator"]` owning the arrow keys, the "Two panels" surface and its rows, the three changed rows, and the FEATURES.md check.

### 12.2 e2e: new `e2e/splitpanel.e2e.ts`

On E2E_PORT plus 17, the next free offset.

1. **On and off.** DM at 1280 x 800: More's first item is "Two panels", unchecked. Picked: the tab panel "Initiative" and the group "Token below", the separator where the default puts it, focus on More, the status "Two panels, Token below". Each pane at least 145 px, each scrolls without moving the other. The Token tab's description is "Shown below". Close: one pane, focus on the Initiative tab. On again, then a reload: both panels and the share come back. A player's "Two panels" opens Characters below, on their character's card. At 1280 x 800 at 130%, the DM's default split keeps Initiative's round header `data-form="full"`.
2. **The tabs pick the top.** Log: Log on top, Token below. The Token tab: a swap, the status "Token on top, Log below", focus on the tab. Swap by Enter on it: focus is still on Swap, and each pane's scroll offset, and a scrolled wide table's inside a journal page, are as before the swap. Then, as Safari does it: focus in the bottom pane's Log composer, blurred to the page, and Swap clicked from script (`element.click()`, which focuses nothing): focus is still on the page after the swap, not on the composer. Journal from More: Journal on top. Arrowing Left and Right across the bottom panel's tab swaps nothing. Every tab's box and Hide panels' box are unchanged from one panel, within 0.5 px.
3. **The bar's name.** "Panel below" lists every panel, the bottom's checked, the top's noted "on top". Journal: the bottom pane is Journal, focus on its name. The top's item: a swap.
4. **Links.** Initiative on top, Log below: a tracker row's Stat block puts Token below at its block, Initiative stays. The token window's Details leaves Token below and focuses its name. `/` puts the Outliner below with focus in its search. A pin's page puts the Journal below. The turn strip moves nothing. With one panel, a tracker row's Stat block replaces Initiative, as today.
5. **The bar.** A drag of 100 px moves the top pane's foot 100 px, clamps at both minimums, and a reload keeps it. Escape mid-drag puts it back. A 6 px wobble moves nothing. On the grip, Up moves 8 px and Shift+Up 64, and with a goblin selected no arrow on the grip moves it. A tablet context at 1180 x 820 drags the bar with a touch.
6. **Room.** At 932 x 430 with 59, 59 and 21 px insets, the DM's "Two panels" is disabled with its description, and a player's splits. A split DM window resized from 1280 x 800 to 1280 x 480 hides the bottom pane, a half-typed Log message there survives, "Two panels" stays checked and enabled, and back at 800 both show with the message. Initiative above Log, Hide panels, resized to 1280 x 480, then Details on a goblin: the side panel shows with Token on top and in sight, and focus on the Token tab. The same at 1280 x 800 puts Token below.
7. **Narrow.** Split, then resized to 800 x 800: no side panel. The list opens Journal as a sheet. Back at 1280: Journal on top, Token below. Again at 800, the DM's list opens Party. Back at 1280: Journal on top and Token below, two different panels, and the stored entry has no Party.
8. **Keys and names.** O from the map goes to the chosen tab, from the top pane to "Token below", from the bottom pane to the chosen tab. O in a text field types. A structural check over the side panel passes in place of an axe run, since axe-core is no dependency of the project: every id an `aria-labelledby`, `aria-describedby` or `aria-controls` names exists, no id repeats, there is one tab panel, the grip is a horizontal separator, and the room's children add a group and no landmark. A journal page opened in the bottom pane shows its header under the bar, and Back returns focus to its row. The journal editor opened there returns focus to its opener when it closes. With the Outliner in the bottom pane and the window made 1280 x 480, so it hides, `/` puts the Outliner on top with focus in its search.
9. **Reach.** At every size of 11.1 that is wide, for both roles, split: the grip, the name, Swap, Close and the menus' items are at least 44 x 44, inside the side panel, and take a tap at their centers. Misses are collected and named together, as `e2e/reach.e2e.ts` does.
10. **The preview.** The DM's "view as a player" splits its own side panel, and the DM's stored entry and the player's are unchanged afterwards.

### 12.3 Existing e2e

- **`e2e/paneltabs.e2e.ts`**: `menuShape` gains the line under "Two panels" at the start of each expected shape (the checkbox is not a `menuitemradio`, so it reads only as that line). Case 3's opening item stays Journal, and its Home now lands on "Two panels", the menu's first item. Case 7's reach sweep includes the new item.
- No other file splits the side panel, and with one panel every path is today's (5.1), so the rest hold. `openSideTab` (`e2e/harness.ts:332-344`) still opens a panel on top.

## 13. Build plan

Four commits, in this order. Run `pnpm -s typecheck`, `pnpm -s test` and `pnpm -s build` together after each. During the build run `e2e/splitpanel.e2e.ts`, `e2e/paneltabs.e2e.ts` and `e2e/reach.e2e.ts`.

1. **The menu's new items** (6).
   - `client/components/Menu.tsx` and `menuKeys.ts`: `checkbox`, `disabled` and `note`, the opening item over radio items, with tests.
   - Commit: `feat(ui): checkbox, disabled and noted items in the shared menu`.
2. **Two panels in the room's state** (5, 8).
   - `client/state/types.ts`: `LocalUi.below`, `LocalUi.splitFits` (page only, set by Room from 3.2, null while unknown) and `LocalUi.pendingOpen`, `withPanel(local, id, how)` by 5.1 with rule 0 and the wait, `withSplit`, `withoutBelow`, `withSwap`. `client/state/store.ts` and `features/dm/preview.ts`: `openPanel(id, how)`, `splitPanels`, `swapPanels`, `fitSplit`. Every caller of 5.2 passes its `how`, and `features/panels.ts` gains `usePanelHere`, with `PanelBody` (`panels/Panels.tsx`) providing it. `openStatBlock` takes `from`.
   - `client/pages/splitPanes.ts` (new): the sizes of 3.2 with `INITIATIVE_STUCK`, the key and drag steps, and `rvtt.sidePanelSplit`, with tests.
   - Commit: `feat(panels): a second panel below in the room's state, with one rule for where a panel opens`.
3. **The side panel's two panes** (3, 4, 6, 7, 9).
   - `client/pages/Room.tsx` `SidePanel`: the room's box and its measure before paint, the keyed panes and bar with `data-pane`, the bottom pane as a named group, a header slot and `useSubpageFocus` per pane, subpages by panel id, the hidden bottom pane, the offsets put back after a swap and the focus read at the state change and restored by `swapFocus`, the status, the readers of 10, and the focus request by panel. The storage read and writes of 8.
   - `client/pages/SplitBar.tsx` (new): the grip as a separator, the name and "Panel below", Swap and Close, the drag and keys.
   - `client/pages/SideTabs.tsx`: "Two panels" and its line, the bottom panel's mark, note and description, the tab keys passing it, and the cut name handed to the top pane.
   - `client/components/Icon.tsx`: `splitPanel` and `swapPanels`. `client/state/shortcuts.ts`: O, `[role="separator"]` in `NAVIGATES`, the "Two panels" surface and rows, the changed rows. `client/features/panels.ts`: `[data-pane-bar]` in `useSubpageFocus`. `client/features/outliner/OutlinerPanel.tsx`: `/`'s search focus taken once shown (9.2). `client/features/images/LibraryGrid.tsx`: `[data-pane]` in its focus helper.
   - `FEATURES.md` (14), and lines under docs/design-v1-panel-tabs.md 4.1 and 6 and docs/design-v1-layout-hierarchy.md 4.1 pointing here.
   - Commit: `feat(ui): two panels in the side panel, with a bar to resize, swap and close them`.
4. **e2e** (12.2, 12.3).
   - `e2e/splitpanel.e2e.ts` and the `paneltabs.e2e.ts` shapes.
   - Commit: `test(e2e): two panels in the side panel, their bar, their links and their reach`.

Files another build may also edit: `client/pages/Room.tsx` and `client/pages/SideTabs.tsx`, owned by the tabs design. This build lands after wave 5, so it builds on them as they are.

## 14. FEATURES.md

In "Phones, tablets and connection", a new bullet right after the bullet that begins "On a phone, panels open as sheets". docs/design-v1-sheet-swipe.md adds its own bullet after the same one, so this one comes first and the swipe's follows it:

- New: "Two panels, at the top of More, shows two panels at once, one above the other, such as Initiative above a token's stats, or for a player their character's card. The tabs pick the top one. The bottom one starts on Token for the DM and Characters for a player. The bar between them names it: press its name to pick another, or use Swap or Close, and drag the bar, or move it with the keys, to share the room. A link that opens a panel, such as Stat block, Details or a pin's page, leaves an open panel where it is and otherwise opens in the other pane, so the panel you are reading stays. This device remembers the two panels and where the bar sits, for a DM and for a player. A side panel too short for two shows the top one until there is room, and a phone shows one panel at a time."

In "Shortcuts", mirroring 9.4: the O row in "Keys", the three changed rows in "Side panel tabs", and a new "### Two panels" section with its intro and three rows after it.

## 15. Decided

The project owner answered on 2026-10-17.

1. **"Two panels" sits at the top of More's menu**, decided by the project owner. A visible button beside Hide panels would be easier to find but would move Log into More for everyone, as the project owner turned down for Menu (the tabs design 3.6).
2. **A player's bottom pane starts on Characters**, their own character's card with its stats, and the DM's on Token, decided by the project owner after the design review's round 1. Initiative when that panel is on top (4.2).
3. **Stat block in an Initiative row does not open a second panel by itself** while one panel shows, decided by the project owner. It replaces Initiative with Token, as today. The token window's Stat block, the more used path, does the same, so the button acts one way everywhere, and a DM who wants one tall panel keeps it. With two panels on, both paths open Token below (5.1).
4. **Each panel keeps its scroll**, decided by the project owner after wave 6 shipped: a panel that shows again, by its tab, More, a link, in either pane or after a swap, and in a phone's sheet, opens where it was left, put back before paint. The build had opened a returning panel at its top. Each panel's offset is kept by panel id for the Room page, as numbers only, so no panel that left holds its DOM (`usePanelScroll` in `features/panels.ts`).

## Appendix A: measurements

Chrome on macOS, the dev fixture room (`/dev/room`, a running fight), the side panel's own px, the side panel shown. Scripts in the session scratchpad (`w6split/measure.mjs`, `probe.mjs`, `menu.mjs`). Screenshots: `today-*.png` and `mock-dm-1280x800-*-initiative-top-half.png` (Initiative in a pane of the even split's height, with a drawn bar, for size only) in `raccoon-vtt/split-panel-design` in the project owner's screenshot folder.

| Layout | Scale | DM: aside, party bar, row, room | Player: room |
|---|---|---|---|
| 1280 x 800 | 100% | 800, 165, 61, 574 | 739 |
| 1280 x 800 | 130% | 615, 164, 61, 390 | 555 |
| 1920 x 1080 | 100% | 1080, 165, 61, 854 | 1019 |
| 1920 x 1080 | 130% | 831, 164, 61, 606 | 770 |
| 1024 x 768 | 100% | 768, 165, 61, 542 | 707 |
| 1366 x 768 | 130% | 591, 164, 61, 366 | 530 |
| 1440 x 900 | 130% | 692, 164, 61, 467 | 632 |
| 1180 x 820 | 100% | 820, 165, 61, 594 | 759 |
| 1180 x 820 | 130% | 631, 164, 61, 406 | 570 |
| 932 x 430 | 100% | 430, 105 (its short start), 61, 264 | 369 |
| 1024 x 768, 900 x 800, 932 x 430 | 130% | not wide | not wide |

Panels in a pane of a given body height (the tab panel resized, a 46 px bar drawn under it):

| Body | Initiative's round header | The Log | Token, nothing selected |
|---|---|---|---|
| 264 (1280 x 800, 100%, even) | full, stuck (68 px) | composer 113, sticky | fits |
| 200, 193 | full, stuck | composer 113 | fits |
| 172 (1280 x 800, 130%, even), 160 (1366 x 768, 130%) | static, scrolls with the order | composer 113, about one message above | fits |
| 145 (the minimum) | static | composer 113, one line above | fits |

Initiative keeps its header stuck from 193 own px: its 68 px header and two standard rows (`ROWS_UNDER_HEADER`, `logic.ts:332`).

More's menu at 1280 x 800, 100%: the DM's box is 530 px tall with its foot at 753 of 800, the bound's foot at 792. "Two panels" and its line add 53 px, so the box reaches the bound and scrolls by about 14 px. At 130% it scrolls today (528 of content in 383). The player's box is 246 px, 299 with the item.

## Appendix B: more mockups

The bar's menu, opened above the bar, Token below, Initiative on top, the DM:

```
| Token_ [Initiative] Log   More v      [|>] |
+--------------------+-----------------------+
| Round 2            | IN PLAY               |
|                    |  Token              * |   * checked
|                    |  Initiative    on top |
|                    |  Log                  |
|                    |  ...                  |
|                    +-----------------------+
| ::  Token ^                       [^v] [x] |
| Goblin 1                     AC 15  7/7    |
```

More's menu with the split on, a player, Journal below:

```
| Token [Initiative] Log   More v       [|>] |
+--------------------+-----------------------+
| Round 2            | [=] Two panels      * |   * checked
|                    | --------------------- |
|                    |  Journal        below |
|                    |  Areas                |
|                    |  Characters           |
|                    |  Library              |
|                    |  Menu                 |
|                    +-----------------------+
```

A large phone sideways, 932 x 430, the DM, More open: "Two panels" disabled.

```
| Token [Initiative] More ^        [|>] |///|
+-------------------+-------------------+///|
| Round 2           | [=] Two panels    |///|
|                   |        too short  |///|
|                   | ----------------- |///|
|                   | IN PLAY           |///|
```
