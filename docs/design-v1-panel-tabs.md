# raccoon-vtt v1: the side panel's tabs in one row with a grouped More menu

Status: draft 2, with the project owner's answers of 2026-10-16 (section 14) and the fixes from the design review's round 1 (9.3). Code is cited from main `e4ec8696`. This design builds on docs/design-v1-layout-hierarchy.md ("the layout design" below): its hidden side panel (4.1) and its panels' order and groups (M3, 6.4). Section 10 lists what changes in it.

The project owner asked on 2026-10-16: "This section of the app for the DM is getting super busy, please come up with a way to clean it up." The section is the side panel's tab list on a wide screen, where a DM has 13 tabs (Token, Initiative, Log, Journal, Areas, DM, Scenes, Monsters, Encounters, Characters, Outliner, Library, Menu) on four rows beside Hide panels. Of three ways offered (one row with More, a Play and Prepare switch, an icon rail), the project owner chose one row with More, and added: "make sure they are based on 'order of use' in the guess sense and do not actually change location over time based on how often the DM uses in reality. We just want the most used ones to be most prevalent statically." And: "Maybe it can just be an organized dropdown? Open to ideas."

Every size is in layout px, the chrome's own (`features/device/layout.ts`). "Wide" means 900 px or wider (`theme.layout.wideMinWidth`), where panels are tabs of the side panel. The interface size zooms the whole side panel (`chromeZoom`, `layout.ts:72-75`), so inside it sizes are in its own px: it is 360 of them at every interface size.

## 1. Summary

- **One row, a fixed order.** The tabs stand in one row in the registry's order (the layout design's M3). As many as fit, from the first, then a "More" tab at the row's end for the rest. Nothing reorders by use, and opening a panel never moves a tab.
- **What fits is measured**, not a set list per role: each tab's width in the font this device draws, against the room the row has, keeping room for More up to a cap. With macOS's system font, Segoe UI and DejaVu Sans alike, a computer or tablet shows Token, Initiative and Log, for the DM and for players, at every interface size. A phone held sideways with the side panel shown fits fewer. A long name on More may end in an ellipsis, and the side panel then names the panel in full above it (the project owner's answer, section 14).
- **More opens an organized menu** under itself: the panels not in the row, in order, under the same headings as a DM's phone list ("In play", "Prepare", and Menu after a line). A pick opens the panel, and More then shows its name and the caret in the chosen look, "Monsters ▾", so the open panel is always named in the row.
- **Badges sit on each tab's corner**, so a count never widens a tab. A count on a panel inside More shows on More too.
- **Menu stays a panel**, last in More. As an icon beside Hide panels it would push Log out of the row (section 3.6). The project owner decided this (section 14).
- **More is a tab with a menu** (`role="tab"`, `aria-haspopup="menu"`), so the tab list always has one selected tab. The menu has arrow keys, typeahead and focus back to More. It is a popover on the base that docs/design-v1-tool-options.md 7.1 ("The shared popover base") sets, and follows that section's rules. The shortcut sheet's "Side panel tabs" section changes for its keys (5.4).
- **The open panel gets the room back.** A DM's tab row goes from four rows, 199 px, to one, 61 px.
- Phones change nothing. No op, no schema, no stored key.

## 2. Today

### 2.1 The tab row

- Room lists the role's panels with `panelsFor(role, wide)` (`Room.tsx:292`, `features/panels.ts:112-114`): the registry (`panels.ts:94-110`) filtered by role, the phone-only Party left out from 900 px up, sorted by `order`. The groups are play (10 to 24), prepare (40 to 48) and room, Menu alone (`panels.ts:53-59`, the layout design's 6.4).
- `SidePanel` (`Room.tsx:1712-1846`) draws a DM's party bar (`:1812`), then the tab row (`:1813-1828`): the tab list, a flex row that wraps (`:1820`), and Hide panels outside it (`:1826`). Each tab is a `button role="tab"` holding its title and an inline `Badge` (`:1758-1792`), 44 px tall with 8 px side padding, the chosen one in the pressed look and the rest in `TAB_REST` (`:1696`). An 8 px gap opens each group (`:1760-1761`). The tab panel under the row is named by the chosen tab (`:1834-1843`).
- Keys follow the ARIA tab pattern: one Tab stop at the chosen tab, and Left, Right, Home and End choose as they move (`:1742-1756`, `lib/a11y.ts:32-39`). The map's arrow shortcuts stand aside inside a tab list (`state/shortcuts.ts:67,79-86`).
- On a short layout (under 500 px tall) the row is one line that scrolls sideways in a `ScrollStrip`, with a rule before Hide panels to set it apart from the strip's chevron (`Room.tsx:1815-1818,1824`, the layout design's 4.1).
- The badges are the Log's and the Journal's unread counts (`Room.tsx:362-364`), capped at "9+" (`features/log/unread.ts` `badgeText`). A badge adds "N unread" to its tab's name (`RoomChrome.tsx:347-373`).
- Room's comment says the tabs wrap "so a mouse reaches all of them" (`Room.tsx:205-206`).

Measured in Chrome on macOS in the dev fixture room (`/dev/room`), in the side panel's own px:

| | DM | Player |
|---|---|---|
| Tab list width | 295: the 360 px panel less its 1 px border, the row's 16 px padding, Hide panels and its 4 px gap | 295 |
| Tabs | 13, on four rows | 8, on two rows |
| Tab row, with its padding and rule | 199 | 107 |
| Initiative's body at 1280 x 800, 100% | 436 | 693 |
| The same at 130% | 252 | 509 |

The tabs measure the same at 85%, 100% and 130%, within a pixel of rounding. Screenshots: `today-*.png` in `raccoon-vtt/panel-tabs-design` in the project owner's screenshot folder.

### 2.2 What opens a panel

Every path calls `ui.openPanel(id)` (`state/store.ts:442-444`, `state/types.ts:207-211`), which sets the side panel's `tab`:

- a tab, and a phone's list of panels (`Room.tsx:801,753`)
- Details on the token bar (`Room.tsx:278-285`), "Stat block" and "Open the sheet" (`features/tokens/statBlockOpen.ts:62`), all to Token
- a tap on the turn strip, to Initiative (`InitiativeStrip.tsx:329`)
- `/`, the Outliner's search (`shortcuts.ts:366-376`)
- a pin's journal page (`PinPane.tsx:189`, `PinLayer.tsx:139`)
- Add token's Monsters and Characters (`tokens/placeTool.tsx:113,116`)
- an area's damage page (`areas/store.ts:201-203`)
- a reload that opens a panel again (`RoomChrome.tsx:160`)

Focus asked for "the panel" goes to the chosen tab from 900 px up (`Room.tsx:627-635`, `tabRef`). A subpage's Back falls back to the chosen tab when its row is gone (`useSubpageFocus`, `features/panels.ts:263-361`), and leaves focus alone while it is on a tab (`:347`).

### 2.3 Popovers and menus

`client/components` has no popover or menu. What comes nearest does another job:

- the table display's menu (`features/display/DisplayRoom.tsx:497-663`), a remote's menu on a 5 s timer, not anchored
- the panes anchored to map points (`features/movement/anchor.ts`)
- the modal dialog hook (`lib/modalDialog.ts`)

docs/design-v1-tool-options.md adds anchored popovers above the tool options row, and its 7.1 ("The shared popover base") sets the base the two designs share. More's menu is a popover on it (4.4).

## 3. The row

### 3.1 Order

The registry's order, unchanged. The row always holds a prefix of it, and More holds the rest in the same order. Nothing counts use, and nothing moves a tab: not opening a panel, not a badge, not a subpage, not the menu. A panel added to the registry later takes its place by its `order` and `group`.

The project owner's other idea, one organized dropdown for every panel, was weighed. Token and Initiative change every turn and the Log every scene (the layout design's 6.2). Behind a dropdown each change is two taps and the panels beside the open one are out of sight. So the row keeps the most used in view, and the dropdown holds what is used a few times a session or in setup.

### 3.2 What fits

**Measured, not a set per role.** The tab font is `system-ui`, so a title's width differs by system (San Francisco, Segoe UI, Roboto, a Linux font). A browser's minimum font size can widen every tab. The side panel holds the right safe area inside its 360 px (`Room.tsx:1808` `paddingRight: theme.safe.right`), so a large phone held sideways has 59 px less. A set chosen for one of these would overflow or waste the row on another.

**The rule**, `fitTabs` in a new `client/pages/tabFit.ts`:

- **Inputs**, all in the side panel's own px: each tab's width at rest (its title in the tab look), each panel's width as More would draw it (its title and the caret), More's rest width ("More" and the caret), the row's gap (2 px), the gap that opens a group (8 px, the layout design's M3), and the room, which is the tab list's width.
- **All fit.** When every tab fits with its gaps, the row holds them all and there is no More.
- **Otherwise** the row holds the first k tabs, for the largest k that leaves room, after one gap, for More's reserve: More at its widest label ("More", or the name of any panel it then holds), but no wider than the cap. When no tab leaves that room, More stands alone.
- **The cap**, `MORE_CAP` in `tabFit.ts`, is 92 own px: More with "More" or a name of about seven letters. It is set so that Token, Initiative, Log and More fit a 295 px row with each font the project owner named (measured below).
- A group's opening gap counts only between tabs in the row. More follows the last tab at the row's gap.
- A room of 0 (a hidden side panel) gives no fit. The side panel measures again each time it shows.
- **The result** is k and More's room: the row's width less the k tabs and their gaps. More's room is never less than its reserve.
- **More holding a single panel** happens only where the last panel's tab, with its group's gap, is wider than More's reserve. Menu is the last panel for both roles, and its tab with its group's gap is narrower than "More" with its caret, so with today's registry More holds two panels or more, or there is no More.

**Why a capped reserve.** The project owner chose it on 2026-10-16 (section 14): a long name on More may be cut, so that Log keeps its place in the row with a wider font. Below the cap, More is fitted at its widest name, so a font that leaves room never cuts one. A fit that kept room for "More" alone would sometimes put one more tab in the row and leave More a few letters for every name, and which of the two happened would turn on a pixel of font width.

**Measured**, in Chrome with each font loaded, 14 px at weight 600 as the tabs draw it, with 6 px side padding (3.4). Segoe UI was measured through Selawik, Microsoft's open font built to Segoe UI's metrics. DejaVu Sans has no 600 weight, so the browser draws its bold, as a Linux desktop would.

| Font | Token, Initiative and Log, with their gaps | More's room beside them at 295 | More's reserve, capped | Spare | Names More cuts there |
|---|---|---|---|---|---|
| macOS's system font | 174 | 119 | 92 (widest name 109) | 27 | none |
| Segoe UI | 172 | 121 | 92 (widest 103) | 29 | none |
| DejaVu Sans | 193 | 100 | 92 (widest 121) | 8 | Monsters, Encounters, Characters, each by a few letters |
| Verdana, Tahoma (not asked, for scale) | 196, 184 | 97, 109 | 92 | 5, 17 | the longest three, or only Encounters |

In no measured font does a fourth tab fit: Journal would leave More 58 px or less, under its reserve.

**What the result depends on**: only these inputs. Never the open panel, a badge, the menu or a subpage. A wider room never fits fewer tabs. The same inputs always give the same result.

**Measuring.** A measuring row inside the tab row holds every tab's title in the tab look, every title in More's look, and More's rest label. It is `aria-hidden`, `visibility: hidden`, placed absolutely so it takes no room, and made of spans, so it has no role and neither a test nor a screen reader finds it. The room is the tab list's width. The tab list is `flex: 1 1 auto` with `min-width: 0` beside the fixed Hide panels, so its width never depends on its content, and the fit never reads anything it changes. Widths come from bounding boxes, all inside the same zoomed side panel, so the interface size cancels out.

**When it runs.**

- In a layout effect when the side panel mounts or shows, and when the role's panels change, so the row is never painted unfitted.
- From a ResizeObserver on the tab list and on the measuring row: a window resize, a rotation that changes the safe area, a new interface size, a font that changes size. The new fit is committed with `flushSync`, so a resize never paints a frame with the old fit.
- Until the side panel has a fit for the room it has now, the row draws no tabs, and Room's request to focus the chosen tab waits for the commit that draws them (5.3). Both happen before the first paint.

**At 130%.** The side panel is 360 own px at every interface size and its tabs scale with it, so 130% shows the same tabs as 100%, each 1.3 times larger, in a side panel 468 screen px wide. Measured at 1280 x 800: Token, Initiative and Log at 85%, 100% and 130%, for both roles. A large phone held sideways leaves the wide layout at 115% and 130% (932 x 430 at 115% lays out 810 px wide) and keeps its sheets.

**Widening.** The side panel does not widen today (`theme.layout.sidePanelWidth`, 360). If it ever does, the fit puts more tabs in the row with no other change.

### 3.3 More

- **Place**: the last tab in the tab list, right after the last tab in the row. Hide panels stays outside the list at the row's end.
- **At rest**: "More" and a down caret (`chevronDown` at `sm`, 2 px after the text), in a tab's rest look.
- **With a panel of its own open**: that panel's title and the caret, in a tab's chosen look. More grows to the right into its room, so no tab moves, and Hide panels, at the row's end, does not move either. A title longer than More's room ends in an ellipsis, "Encount… ▾", and the side panel names the panel in full above it (3.8). More's accessible name keeps the whole title (5.1).
- **With its menu open**: the caret turns up (as `areas/AreaOptions.tsx:159` turns it), in whichever look More has.
- **One element** whatever it shows, so focus on it survives a change of its name.
- **The ellipsis** comes from More's title sitting in its own span with `text-overflow: ellipsis`. The span clips, not More, so the corner badge is never cut off. The same span also covers a font that grows between two fits: it cuts the title rather than pushing anything.
- No animation: the menu appears and goes at once, and the caret turns without a transition.

### 3.4 Tab padding

Tabs and More take 6 px side padding, down from 8 (`Room.tsx:1779`). Measured at 295 px: with 8 px, Token, Initiative and Log leave More 111 px on macOS, so "Encounters ▾" (113) would be cut there, and only 90 px with DejaVu Sans, under the cap, so Log would leave the row. With 6 px, More has 119 px on macOS and 121 with Segoe UI, wider than any name, and DejaVu Sans keeps Log with 8 px to spare. The tab's 44 px minimum stands.

### 3.5 Badges

- **On the corner.** Every badge in the row sits on its button's top right corner (`Badge` with `corner`, as on the toolbar's Panels button), so a count never changes a tab's width and the fit never reads one. Each tab is `position: relative` for it. The row's 8 px top padding holds the badge's 6 px rise.
- **On More.** More shows the sum of the counts of the panels it holds, the open one included, capped at "9+" as every badge is. So the Journal's count shows on More while the Journal is in More, and on the Journal's own tab wherever the row holds it, as a chosen Journal tab shows its count today.
- **In the menu.** Each item shows its own count at its end, as the phone's list does (`Room.tsx:1634`).
- **In names.** A tab's badge still adds "N unread" to the tab's name. More says its count in its description instead (5.1), since its name may be one panel's title while its count covers several. `Badge` gains a prop that leaves its hidden words out.
- Room's badge record (`Room.tsx:364`) stays the one list of counts. A panel that gains a count later adds it there, and the row, More and the menu show it with no other change.

### 3.6 Menu stays a panel

Menu stays a panel in the room group: the last item in More, after a line, as in the phone's list. An icon button beside Hide panels was weighed. It would take 48 px of the row (44 px and a 4 px gap), and in the 247 px left the fit holds Token and Initiative only: Log, an every-scene panel, would move into More for both roles to make room for a rarely used one.

The cost is the X-card, which sits at the top of Menu. On a wide screen it takes one more tap than today: More, Menu, X-card, then the X, where today the Menu tab stands in the row. That matches a phone today: Panels, Menu, X-card, the X. The project owner chose Menu in More on 2026-10-16 (section 14).

### 3.7 Every height

The row is the same on a short layout. The `ScrollStrip`, its chevron and the rule before Hide panels go (`Room.tsx:1815-1818,1824`), since nothing scrolls. The party bar's folded start on a short layout stays (the layout design's 4.1).

### 3.8 The full name above a cut one

Today the side panel draws a header only for a subpage, "since the chosen tab already names the panel" (`Room.tsx` `SidePanel`'s comment). A cut name on More breaks that reason, so the rule becomes: **the side panel draws its header whenever the row does not show the open page's whole name.**

- **A subpage**: as today, the subpage's name with "Back to" its panel's whole name.
- **A panel whose name More cuts**: the panel's whole name, with no Back. The fit says when: the open panel is in More and its More width is over More's room. It is worked out from the fit's numbers, not read from the span, so it never flickers.
- **Otherwise** no header, as today.

This header moves no focus and is not a subpage: `useSubpageFocus` keys on subpages only. It costs the body the header's height while it shows, which happens only with a font as wide as DejaVu Sans, or on a large phone held sideways (9.1).

## 4. The More menu

### 4.1 What it lists

- The panels More holds, in the registry's order, each once.
- Grouped as the phone's list groups them, through one helper both use: `panelSections(panels, grouped)` in `features/panels.ts`, in place of PanelPicker's own loop (`Room.tsx:1601-1645`, `GROUP_LABELS` at `:1591`). For a DM: "In play" and "Prepare" headings over their panels, and Menu after a plain line. A heading shows only for a group with a panel in More. A player's menu has no headings or line, as a player's list has none (the layout design's 6.4): five panels read at a glance.
- Each item: the panel's title, its badge at the end, 44 px tall, the menu's full width. The open panel's item is in the chosen look, and checked (5.1).
- The headings take the section label's look (`SectionLabel`, `components/Panel.tsx:23`), not its heading element (5.1).
- Extended by docs/design-v1-split-panel.md 6: "Two panels", a checkbox item, heads the menu with a line under it, and the panel shown below carries "below" at its end.

### 4.2 Where and how big

More's menu is a popover on the base in docs/design-v1-tool-options.md 7.1 ("The shared popover base"), which places it, closes it and returns focus by that section's rules and draws it in the base's look. What this design gives the base:

- **Its bound** is the side panel's inner box, inside its safe areas, and the menu is drawn in the side panel, not in a portal. So it takes the side panel's interface size, hides with it, lies over the panel's body and its sticky headers, and never covers the map. It has no region to rise into.
- **Its side** is below More, its left edge at More's, moved left as the base moves it to stay inside the bound.
- **Width**: its widest item, at least More's width.
- **Height**: up to the bound's foot. Past that it scrolls, as the base's popovers do, and opening scrolls the focused item into view.
- **In the page**, the menu comes right after the tab list and before Hide panels, so the base's Tab order (the popover next after its anchor, tool options 7.1) holds.

At 1280 x 800 a DM's whole menu shows at 100%, and at 130% it reaches the side panel's foot and scrolls. The mocks `mock-dm-1280x800-100-menu.png` and `mock-dm-1280x800-130-characters-menu.png` in the same folder are a DOM mock drawn over today's page, for size only.

### 4.3 Opening and closing

The rules of tool options 7.1 hold for More's menu as for any popover or menu, with no exception for More. In the side panel they mean:

- **One open popover in the whole room.** Opening More's menu closes an open tool popover, and opening a tool popover closes the menu.
- **Escape** closes the menu wherever focus is, by 7.1's rule, which leaves Escape to a text field outside the menu and More.
- **Tab in the menu** closes it and moves on as Tab from More would, to Hide panels. **Shift+Tab** closes it and goes back to More (7.1). Focus moving anywhere else outside the menu and More closes it too.
- **Android's Back** on a tablet wide enough for the side panel closes the menu first, through `useBackClose`.
- **A press on the map does nothing but close the menu** (7.1): the tool does nothing with that press, and on a touch screen the menu closes once the press turns out to be one finger, so a pinch or a two-finger pan leaves it open.
- **A press anywhere else** outside the menu closes it and acts as usual, so a press on another tab chooses that tab at once.
- **Focus on close** follows 7.1: after Escape, a pick, or a close with focus in the menu or on More, it is on More.

What the menu adds:

- **Opens** on a click or tap on More, or Enter, Space, Down or Up on More. Opened by a key, focus moves to the open panel's item when More holds it, else to the first item (with Up, the last). Opened by a pointer, the open puts focus on More itself (`preventScroll`), on every browser, Safari included, and focus enters the menu only when a key opened it (7.1). Down or Up on More then moves it into the open menu.
- **A pick** (a click, a tap, Enter or Space) opens the panel, then moves focus to More, which by then names it, then closes the menu (7.1's focus on closing). In that order, a screen reader hears "Monsters, tab, selected" from More, and focus is never lost to the page between the item going and More taking it. While the pick runs, focus is on the item, which `useSubpageFocus` treats as it treats a tab (5.3).
- **A second press on More** closes the menu.
- **Closes with More**: when the side panel hides (Hide panels, S, crossing below 900 px), when the fit changes, or when More leaves the row. Focus that was in the menu goes to Panels where the side panel hid, by the layout design's rule (4.1). Otherwise it goes to More, or where More is gone, to the chosen tab.

### 4.4 The menu

The menu's roles, keys, typeahead and groups are this design's `components/Menu.tsx`, its key logic pure in `components/menuKeys.ts` (5.1, 5.2), drawn in a popover on the shared base. docs/design-v1-tool-options.md builds Setup and Tools on the same `Menu`, drawn as tiles, so all three pick lists in the room take the same keys.

## 5. Accessibility

### 5.1 Roles and names

A DM at 1280 x 800, Initiative open, a chat message and a journal page unread:

```
tablist "Panels"
  tab "Token"
  tab "Initiative"          selected
  tab "Log 2 unread"
  tab "More panels"         haspopup=menu, expanded=false, described "1 unread"
button "Hide panels"
menu "More panels"          (while open)
  group "In play"
    menuitemradio "Journal 1 unread"
    menuitemradio "Areas"
    menuitemradio "DM"
    menuitemradio "Scenes"
  group "Prepare"
    menuitemradio "Monsters" ... "Library"
  separator
  menuitemradio "Menu"
tabpanel "Initiative"
```

With Monsters opened from More, the fourth tab is `tab "Monsters"`, selected, `haspopup=menu`, described "More panels, 1 unread", the tab panel is "Monsters", and the menu's Monsters is checked.

- **More is a tab.** A tab list may own only tabs (axe's `aria-required-children` flags a button inside one), and ARIA allows `aria-haspopup` on a tab. As a tab, More is the selected tab whenever the open panel is in it. So the tab list always has one selected tab, the tab panel is always named by it (`aria-labelledby`), and every rule that sends focus to "the chosen tab" finds More. Its `aria-controls` names the tab panel while it is chosen, and the menu while that is open.
- **More's name** is its visible text: "More" with a visually hidden " panels", or the open panel's whole title, even where its visible title is cut (3.3), which then begins the name. Speech input that says what it sees therefore finds it (WCAG 2.5.3). Its description, a visually hidden span through `aria-describedby`, says "More panels" while it shows a title, then its count when it has one: "More panels, 1 unread", or at rest "1 unread".
- **The menu** is named "More panels" by `aria-label`, not by More, whose name may be a title. Its items are `menuitemradio` with the open panel's checked, since choosing a panel is one choice. Each heading is `aria-hidden` text, and its `role="group"` is named by it through `aria-labelledby`. The line before Menu is `role="separator"`.
- **Targets**: every tab, More and every item is at least 44 x 44.

### 5.2 Keys

| Focus | Key | Does |
|---|---|---|
| A tab in the row | Left, Right | Moves to the tab or More beside it, wrapping. A tab is chosen as focus reaches it, as today. More takes focus and chooses nothing |
| | Home | The first tab, chosen |
| | End | More, or the last tab where there is no More |
| More | Enter, Space | Opens the menu with focus in it, on the open panel's item, else the first. With the menu open, closes it |
| | Down, Up | Opens the menu with focus on the open panel's item, else the first (Up: the last). With the menu open, moves focus into it the same way |
| | Left, Right, Home, End | As on a tab |
| The menu | Down, Up | The next or previous item, wrapping |
| | Home, End | The first or last item |
| | A letter | Typeahead: the next item, from the focused one and wrapping, whose title starts with what was typed in the last 500 ms. The same letter again steps through the items that start with it ("M": Monsters, then Menu) |
| | Enter, Space | Picks (4.3) |
| | Escape | Closes it, focus to More (7.1) |
| | Tab | Closes it and moves on as Tab from More would, to Hide panels (7.1) |
| | Shift+Tab | Closes it, focus back to More (7.1) |
| | Left, Right | Nothing |

- Every key the menu handles is marked used (`preventDefault`), so no room shortcut runs while focus is in it (`shortcutFor` skips a used key, `shortcuts.ts:407`): a letter types ahead rather than picking a tool, and S does not hide the side panel. Keys it does not handle, such as Ctrl+Z, act as anywhere.
- `[role="menu"]` joins `NAVIGATES` (`shortcuts.ts:67`), so an arrow on a menu never moves a token, handled or not.
- More chooses nothing as focus reaches it, so the tab keys never open a menu or a panel that the person only passed over. Its own keys are a menu button's.

### 5.3 Focus

- **The chosen tab is More** while the open panel is in it, for everything that asks for the chosen tab: Room's focus after Details, the turn strip and Panels (`Room.tsx:627-635`, `tabRef`), and Back's fallback when its row is gone (`useSubpageFocus`'s `fallback`). The roving Tab stop is the chosen tab, More included.
- **Waiting for the fit.** Room's request to focus the chosen tab waits until a commit in which the side panel has its fit (3.2): at most one commit later, and before paint. A side panel that starts hidden on a short layout has no fit until it first shows, and that first show is exactly when Panels asks for the chosen tab.
- **A pick**, by a key or a pointer, leaves focus on More, as a chosen tab keeps it (4.3, tool options 7.1). `useSubpageFocus` leaves focus alone while it is on a tab, and now also while it is in the tabs' menu (`features/panels.ts:347`, its selector gains `[data-tabs-menu]`). So picking a panel that shows a subpage does not pull focus to the subpage's title, and the next key still works the menu or the tabs.
- **A focused tab moved into More** by a new fit (a resize, a rotation): focus goes to More.
- **Hide panels, S and Panels** keep the layout design's rules (4.1). Hiding with focus in the side panel, the menu included, puts focus on Panels, and showing puts it on the chosen tab.

### 5.4 The shortcut sheet

The project owner's standing rule (2026-10-16) keeps the shortcut sheet complete, and FEATURES.md's "Shortcuts" tables mirror it. The project owner then narrowed it: the sheet lists keys and key-plus-pointer combinations (a key with a click or a drag) only, never a plain click or tap. So every key this design adds, changes or removes is listed, by section and role, and no click or tap is. The rows below are in the shape of the sheet build's `BEHAVIORS` registry (`client/state/shortcuts.ts` in that build: `id`, `input`, `touchInput`, `does`, `roles`, `when`, `device`, `surface`), in its existing "Side panel tabs" section. The tab row and its menu work only on the side panel, and the menu belongs to the row, so all of them go there. Every row has `roles: EVERYONE` and `surface: "Side panel tabs"`.

The section's intro (`SURFACE_INTRO`) becomes: "On a screen 900 px or wider, with a tab or More's list focused. There, and on a focused choice or slider, the arrow and Page keys never move a token, and in the list a letter goes to a panel instead of running a shortcut."

| `id` | `input` | `does` | `device` | Change |
|---|---|---|---|---|
| `tabsSide` | Left, Right | Switch to the tab beside it, wrapping around at the ends. On More, stop there and open nothing | keys | Changed |
| `tabsEnds` | Home, End | Switch to the first tab, or go to More, the last | keys | Changed |
| `tabsWheel` | Wheel over the tabs | Scroll them sideways | mouse | Removed: the row no longer scrolls (3.7) |
| `tabsMoreKeys` | Enter, Space, Down, Up on More | Open the list, at the open panel or the first, or with Up the last | keys | New |
| `tabsListMove` | Up, Down, Home, End in the list | Move through it, wrapping around at the ends | keys | New |
| `tabsListType` | Letters in the list | Go to the next panel whose name starts with them | keys | New |
| `tabsListPick` | Enter, Space in the list | Open the panel and close the list. More then shows its name | keys | New |
| `tabsListLeave` | Tab, Shift+Tab in the list | Close it. Tab goes on to the next control, Shift+Tab back to More | keys | New |
| `tabsListEscape` | Escape in the list | Close it, back to More | keys | New |

The comment above the section's rows names its code: `pages/Room.tsx`, `pages/tabFit.ts`, `components/Menu.tsx` and `menuKeys.ts`, `lib/a11y.ts` `tabKeyIndex`, in place of `components/ScrollStrip.tsx`.

**Rows this design does not add.** No click or tap: a click or tap on a tab, on More, on a panel in the list, or outside the list is a plain pointer press, which the sheet no longer lists. The row and the menu add no key-plus-pointer combination. Android's Back closes the list as it closes any popover on the shared base, under the room rows that docs/design-v1-tool-options.md keeps for an open popover. Escape anywhere closes the list under that design's room Escape row too, and `tabsListEscape` says what it does inside the list, where focus then goes back to More. S ("Hide or show the side panel") and `/` keep their rows and roles in "Keys".

## 6. Opening a panel from anywhere

Changed by docs/design-v1-split-panel.md 5.1: every caller now says how it asked for the panel, and with two panels a link opens in the pane it was not pressed in. With one panel what follows still holds.

No caller changes. Every path in 2.2 sets `tab`, and the row shows it: a tab in the row is chosen, or More names the panel and is chosen. No tab moves, the menu stays shut, and focus goes where the caller sends it. So `/` shows "Outliner ▾" chosen with focus in its search, a pin's journal page shows "Journal ▾" for a DM, and Add token's Monsters shows "Monsters ▾". A reload that opens a panel in More again shows it the same way. Details, "Stat block" and "Open the sheet" open Token, which is always first in the row.

## 7. Phones and narrow screens

Nothing changes below 900 px: the Panels button and its list (the layout design's 4.2 and 6.4). The list's grouping moves into `panelSections` (4.1) with the same rule as today, so a phone and a computer group panels one way.

## 8. Mockups

The side panel at 360 own px. `[x]` is the chosen look, `v` and `^` the caret, `[|>]` Hide panels, `²` a corner badge.

A DM at 1280 x 800 today:

```
+----------------------------------------------+
| PARTY v                      [Ask the party] |
| (T)  Thorn                          18/24 +5 |
| (Ve) Vex                                9/21 |
+----------------------------------------------+
| Token [Initiative] Log  Journal         [|>] |
| Areas  DM  Scenes  Monsters                  |
| Encounters  Characters  Outliner             |
| Library  Menu                                |
+----------------------------------------------+
| Round 2                    [Previous] [Next] |
| ...                                          |
```

New, Initiative open, a chat message unread:

```
+----------------------------------------------+
| PARTY v                      [Ask the party] |
| (T)  Thorn                          18/24 +5 |
| (Ve) Vex                                9/21 |
+----------------------------------------------+
| Token [Initiative] Log²  More v         [|>] |
+----------------------------------------------+
| Round 2                    [Previous] [Next] |
| ...                    138 px more of it ... |
```

Encounters opened from More. The three tabs and Hide panels stand where they stood:

```
| Token  Initiative  Log² [Encounters v]  [|>] |
```

The menu open, a journal page unread (the badge shows on More and on its item):

```
| Token [Initiative] Log²  More¹ ^        [|>] |
+--------------------------+-------------------+
| Round 2                  | IN PLAY           |
|                          |  Journal        1 |
|                          |  Areas            |
|                          |  DM               |
|                          |  Scenes           |
|                          | PREPARE           |
|                          |  Monsters         |
|                          |  Encounters       |
|                          |  Characters       |
|                          |  Outliner         |
|                          |  Library          |
|                          | ----------------- |
|                          |  Menu             |
|                          +-------------------+
```

At 130% everything above is the same in the side panel's own px and 1.3 times larger on screen, 468 px wide. The menu reaches the side panel's foot and scrolls, its checked item in view.

A player at 1280 x 800, 100% or 130% (no party bar), menu open:

```
+----------------------------------------------+
| Token [Initiative] Log   More ^         [|>] |
+--------------------------+-------------------+
| Round 2                  |  Journal          |
|                          |  Areas            |
|                          |  Characters       |
|                          |  Library          |
|                          |  Menu             |
|                          +-------------------+
```

A large phone held sideways, 932 x 430 at 100%, 59 px side insets, side panel shown. The row has 236 px, room for Token, Initiative and More's capped reserve. Encounters opened from More is cut, so the side panel names it above the panel (3.8):

```
+------------------------------------------+///+
| PARTY >                [Ask the party]   |///|
+------------------------------------------+///|
| Token  Initiative [Encount... v]   [|>]  |///|
+------------------------------------------+///|
| Encounters                               |///|
+------------------------------------------+///|
| ...                                      |///|
```

A computer whose font is as wide as DejaVu Sans, 1280 x 800. The row still holds Token, Initiative and Log. Characters opened from More is cut and named above, while Journal, opened the same way, is whole and has no header:

```
| Token  Initiative  Log [Charact... v]   [|>] |
+----------------------------------------------+
| Characters                                   |
+----------------------------------------------+
| ...                                          |

| Token  Initiative  Log [Journal v]      [|>] |
+----------------------------------------------+
| ...                                          |
```

## 9. Edge cases

### 9.1 By size, role and interface size

"Room" is the tab list's width in the side panel's own px. Widths are the measured ones of 3.2. Rows without a font name use macOS's system font: Token 54, Initiative 72, Log 44, More's reserve 92 (the cap), its widest name 109.

| Layout | Interface size | Room | DM's row | Player's row | Notes |
|---|---|---|---|---|---|
| A computer window from 900 layout px, such as 1280 x 800 | 85%, 100%, 115%, 130% | 295 | Token, Initiative, Log, More | the same | Measured at 1280 x 800 at 85%, 100% and 130%. More has 119, so no name is cut |
| The same, with Segoe UI | any | 295 | Token, Initiative, Log, More | the same | More has 121, so no name is cut |
| The same, with DejaVu Sans | any | 295 | Token, Initiative, Log, More | the same | More has 100: Monsters, Encounters and Characters are cut and named above the panel (3.8). A player's More holds only Characters of these |
| 900 x 800 | 100% | 295 | the same | the same | |
| A tablet sideways, 1180 x 820 | 100%, 130% (908 x 631) | 295 | the same | the same | Not short, so the side panel starts shown |
| A phone sideways, 844 x 390, 47 px side insets | 85% (993 x 459), side panel shown | about 248 | Token, Initiative, More | the same | More has 118, so no name is cut. Short, so it starts hidden |
| A large phone sideways, 932 x 430, 59 px side insets | 100%, side panel shown | 236 | Token, Initiative, More | the same | Room measured. More has 106: Encounters and Characters lose a letter or two and are named above the panel. Short, so it starts hidden |
| Any layout under 900 px wide: phones upright, most phones sideways at 100% and larger, tablets upright | any | none | the list of panels | the list | Unchanged |
| A wider font still, or a larger minimum font size | any | 295 | as many as fit | as many as fit | Measured on the device. Log leaves the row only where More's room beside it would be under the cap |

### 9.2 By state

- **Which panel is open.** A tab in the row: chosen, More at rest. A panel in More: More names it, chosen. A subpage of either: the header under the row names the subpage, and More names its panel. A stored tab the role's list lacks: the first tab, as today (`Room.tsx:360`).
- **With a badge.** On a tab in the row: its corner. On a panel in More: More's corner and the item. On the open panel in More: More's corner, as a chosen Journal tab shows its count today. A count that changes while the menu is open: the item and More update, and nothing moves.
- **With the side panel hidden.** The menu closed as it hid, and Panels shows the Log and Journal badge as today. Showing it measures the row again before paint, a rotation meanwhile included, and puts focus on the chosen tab, More when the open panel is in it.
- **After a panel in More is opened by a shortcut or a path in 2.2.** More names it and is chosen, the menu stays shut, nothing moves, focus goes where the path sends it (the Outliner's search for `/`).
- **The menu open, then:**
  - a press on another tab: the menu closes, and that tab is chosen
  - a press on the map: it does nothing but close the menu, on a touch screen once the press turns out to be one finger (tool options 7.1)
  - a pinch or a two-finger pan on a touch screen: the menu stays open
  - a tool's popover opening (a value chip, ⋯, Setup): the menu closes, since one popover is open in the room at a time
  - Android's Back on a tablet wide enough for the side panel: the menu closes first
  - a tap on the turn strip: the menu closes, and Initiative is chosen in the row
  - a handout, the X-card or any dialog opening: focus moves into it, and the menu closes
  - Hide panels: the menu closes, the side panel hides, and focus goes to Panels
  - a letter: typeahead, never a shortcut
  - a resize or rotation that changes the fit: the menu closes
  - crossing below 900 px: the menu goes with the side panel
- **A focused tab that a new fit moves into More**: focus goes to More.
- **A name More cuts**: the side panel's header names the panel in full (3.8). On one of its subpages the subpage's header shows as today, its Back naming the panel in full. The header comes and goes with the fit, never with a measurement of the span.
- **A DM's "view as a player"**: the preview's own side panel, the player's tabs and its own fit. Its room answers no shortcut (`shortcuts.ts:407`), and the menu's keys are its own, so they work there.
- **The X-card sent from Menu in More**: as today on a wide screen, the side panel stays on Menu (`XCardButton.tsx:47` closes the panel, which on a wide screen leaves the tab as it was), and More still names it.
- **More holding one panel**: never with today's registry, where Menu is last (3.2). More holds two panels or more, or there is no More.
- **A future panel**: takes its place by `order` and `group`. A long title widens More's widest name, and the fit takes it into account.

### 9.3 Self-sweep

Checked against this matrix before commit, by class:

- **Anything that changes a width after the fit.** A badge (now on the corner), the chosen look (the same 1 px border as rest), More's name (fitted to its capped reserve, a longer name cut inside its own span), the caret turning (the same icon box), focus rings (outlines), the interface size (cancels), a font or minimum size change (the measuring row resizes and the fit runs again), a safe area change on rotation (the tab list resizes). The sweep found the inline badge and More's growing label, each of which could push a tab or Hide panels, and the 8 px padding, with which More's widest name cost Log its place on every computer. Sections 3.5, 3.2 and 3.4 answer them.
- **Everything that reads the chosen tab.** Room's focus request, Back's fallback, the tab panel's label, the roving Tab stop, the e2e checks. Each finds More when the open panel is in it (5.1, 5.3). The sweep found two focus gaps: a side panel that starts hidden had no tabs drawn on its first show when Panels asked for the chosen tab, and a pick unmounted the menu item before More took focus, which let `useSubpageFocus` send focus to a subpage's title. Sections 5.3 and 4.3 answer both.
- **Everything that opens a panel.** All go through `openPanel` and `tab` (2.2), so none changes (6).
- **Keys.** Tab keys, More's keys, the menu's keys, the room's shortcuts and Escape, S and `/`: each key has one owner (5.2). The sweep found that typeahead letters would also run room shortcuts, and that More's count in its name would be heard as the open panel's. Sections 5.2 and 5.1 answer them. Every key the row and the menu add or change has a row in the sheet's "Side panel tabs" section and in FEATURES.md, and no plain click or tap has one, by the project owner's narrowed rule (5.4, 12).
- **Lifecycle.** Mount, hide, show, a resize, crossing 900 px, the preview, a hidden side panel measuring 0 (no fit, measured again as it shows). The sweep also found that More could have held a single panel at some width, and showed it cannot with today's registry (3.2).

After the design review's round 1, by class:

- **One popover contract.** More's menu now follows tool options 7.1 ("The shared popover base") instead of a copy of its own (4.2, 4.3): one popover open in the room, its Escape rule, closing on focus or Tab leaving, Android's Back, and its map rule for touch. Re-swept: 9.2's "the menu open" rows, 5.2's Escape and Tab rows, 5.3's pick, and e2e cases 3 and 9.
- **Round 2, one menu contract.** The three rules now stated once in tool options 7.1 were checked against every row, table and test here: a map press does nothing but close the menu (4.3, 9.2, e2e case 9), Tab moves on as Tab from More would and Shift+Tab goes back to More (4.3, 5.2, 5.4's `tabsListLeave`, e2e case 3), and focus enters the menu only on a key open (4.3, 5.3, e2e case 3, the Safari note in 11.3). Shift+Tab, which went back to the tab row's stop, now goes to More, and the pick now always ends on More.
- **Fonts.** Three tabs held only with macOS's font. The reserve is now capped, measured with macOS's system font, Segoe UI and DejaVu Sans (3.2), and a cut name gets the full name above the panel (3.8). Re-swept: every row of 9.1, the mockups, the 6 px padding's reason (3.4), the unit fixtures and e2e cases 6 and 8, and FEATURES.md, which names no number of tabs.
- **Shortcut rows.** Written in the sheet build's shape against its real "Side panel tabs" section, with the removed Wheel row and the new intro (5.4). Then, by the project owner's narrowed rule, keys only: the click row for More is gone, and the menu's Escape has its own key row. Re-swept: the build plan and FEATURES.md (12, 13).

## 10. What this changes in other designs

- **docs/design-v1-layout-hierarchy.md 4.1, "A short side panel":** the tabs no longer scroll in a `ScrollStrip` on a short layout. Every side panel has the fitted row. The party bar's folded start stays.
- **Its M3**, "The wide tab row puts an 8 px gap before each group's first tab": still true between tabs in the row, and the menu groups the rest.
- **Its 4.1 focus rules** ("Panels moves it to the chosen tab"): the chosen tab may be More.
- **docs/design-v1-tool-options.md**: More's menu is a popover on its 7.1 ("The shared popover base"), and its Setup and Tools use this design's `Menu` (4.4).

## 11. Tests

### 11.1 Unit tests (node:test)

- New `client/pages/tabFit.test.ts`: all tabs fit, no More. A prefix with More. More's reserve is its widest name among the panels it would hold, up to `MORE_CAP`, so a name past the cap never costs a tab. A group's 8 px gap counted only between tabs in the row. More alone when no tab leaves it room. A room of 0 gives no fit. More's room is never under its reserve. Whether the open panel's name is cut: true exactly for a panel in More whose More width is over More's room. With today's registry's widths, More never holds exactly one panel. For every room from 0 to 600 px, a wider room never fits fewer tabs. The measured widths of 3.2 as fixtures, for the DM and the player: at 295, three tabs with macOS's system font, Segoe UI and DejaVu Sans, More's room 119, 121 and 100, and the cut names exactly Monsters, Encounters and Characters with DejaVu Sans and none with the other two. With macOS's widths, 248 and 236 give two tabs, and at 236 exactly Encounters and Characters are cut. With 8 px padding, DejaVu Sans gives two tabs at 295.
- `client/features/panels.test.ts`: `panelSections` for a DM (grouped) and a player (not), over the whole list, as the phone's list uses it, and over each overflow the fit can leave, as More uses it. A heading only for a group with a panel in the slice, the line before Menu, and the registry's order kept.
- New `client/components/menuKeys.test.ts`: Down and Up wrap, Home and End. The opening item: the checked one, else the first, or with Up the last. Typeahead: the next match after the focused item, wrapping, a repeated letter stepping through its matches, two letters within 500 ms as one prefix and after 500 ms as a new one, and no match leaving focus where it is. Which keys it marks used.
- The popover's placement, closing and focus are tested in the shared base's own test file, `client/components/popover.test.ts` (tool options 7.1). That file's cases include a bound like the side panel's, below the anchor with no region to rise into. This design adds no placement test of its own.
- `client/state/shortcuts.test.ts`: `ownsNavigationKeys` inside `[role="menu"]`. A letter whose press is already marked used runs no shortcut. The sheet build's registry holds the "Side panel tabs" rows of 5.4, all of them keys, with no `tabsWheel` and no click or tap row, for the DM and for players, and its FEATURES.md check passes.

### 11.2 e2e: new `e2e/paneltabs.e2e.ts`

On E2E_PORT plus 12, the next free offset at `e4ec8696`. The e2e files run one after another (`--test-concurrency=1`), so a port shared with another new file would not collide, but whichever lands second takes the next free one.

1. **One row.** At 1280 x 800 at 85%, 100% and 130%, at 900 x 800 and at 1180 x 820 at 100% and 130%, for the DM and a player: every tab and More share one top, the tab list's `scrollWidth` is at most its `clientWidth`, and the row is one tab tall with its padding. The tabs in the row, then More's items, are the role's panels in order, each once. At 1280 x 800 the row is Token, Initiative and Log at every interface size. The DM's menu has "In play" over Journal, Areas, DM and Scenes, "Prepare" over Monsters, Encounters, Characters, Outliner and Library, a separator, and Menu. A player's has Journal, Areas, Characters, Library and Menu with no group.
2. **Nothing moves.** At 1280 x 800, for each panel in More, picked by a click: More is named by its title and selected, the tab panel is named by it, focus is on More, the menu is gone, and every tab in the row and Hide panels have the boxes they had before, within 0.5 px. Then a tab in the row: More is "More panels" again. A chat message from a player gives Log a badge, and Log's box is unchanged.
3. **Keys.** At 1280 x 800, a DM with a goblin selected, Log chosen: Right from Log puts focus on More and Log stays chosen. Enter opens the menu with focus on Journal. Down, Up, End and Home move. "c" reaches Characters, and "m", "m" reach Monsters then Menu. Enter on Characters: focus on More named "Characters", the tab panel is "Characters", no menu. Down opens it on Characters. Escape closes it, focus on More. Opened again by a key, Tab closes it and focus is on Hide panels. Opened again by a key, Shift+Tab closes it and focus is on More. Opened by a click, focus is on More, not in the menu, and Down moves it into the menu. In the menu, the arrows and "r" leave the goblin and the tool as they were. With the Journal showing a page, picking Journal by keyboard leaves focus on More, not on the page's title. Left from Token puts focus on More, choosing nothing.
4. **Opened from elsewhere.** `/` shows More named "Outliner", selected, with focus in its search. Add token's Monsters and a pin's journal page show More named "Monsters" and "Journal". Each time the tabs in the row keep their boxes and the menu stays shut. Details on the token bar chooses Token in the row.
5. **Badges in More.** The DM edits a journal page a player can read, at 1280 x 800: the player's More shows a corner badge of 1, its description says "1 unread", its name has no "unread", and the menu's Journal item shows 1.
6. **Hidden.** With Monsters opened from More, Hide panels then Panels: focus is on More named "Monsters". With the menu open, Hide panels closes it, and Panels shows the side panel with no menu. At 932 x 430 at 100% with 59, 59 and 21 px insets and no stored choice, the side panel starts hidden. Panels shows it with focus on the Initiative tab, and the row holds Token and Initiative. Encounters picked from More is cut there: More's name is "Encounters", and a header above the panel reads "Encounters". With focus on Log at 1280 x 800, a resize to 932 x 430 with those insets moves Log into More and focus to More.
7. **Reach sweep.** At 900 x 800, 1280 x 800 at 85%, 100%, 115% and 130%, 1180 x 820 at 100% and 130%, 844 x 390 at 85% with 47, 47 and 21 px insets, and 932 x 430 at 100% with 59, 59 and 21 px insets, for both roles: every panel opens with at most two taps, its tab or More then its item. Every tab, More and menu item is at least 44 x 44 layout px, lies inside the side panel and the screen (an item once the menu has scrolled it into view), and takes a tap at its center (`elementFromPoint` finds it or what it holds). The menu lies inside the side panel's inner box. The row is one line. Misses are collected and named together, as `e2e/reach.e2e.ts` does.
8. **A wider font.** At 1280 x 800, with a stylesheet that sets the side panel's font to Verdana, which macOS has and whose widths are within a few px of DejaVu Sans's on these titles (3.2): the row still holds Token, Initiative and Log. Picking Encounters cuts More's title (its span's `scrollWidth` over its `clientWidth`), More's name and the tab panel's name are "Encounters", and a header names it in full. Picking Journal shows no header. Every tab keeps its box through both.
9. **The shared base.** With a Draw chip's popover open, a click on More closes it and opens the menu, and a click on the chip then closes the menu. With the menu open, a history Back, as the sheet tests do it, closes the menu and leaves the room's address. In a touch context at 1180 x 820 with Ping, a one-finger tap on the map with the menu open places no ping and closes the menu once the finger lifts, and a two-finger pinch leaves the menu open.

### 11.3 Existing e2e

- **A helper**, `openSideTab(page, name)` in `e2e/harness.ts`: when the panel is already chosen it does nothing. When its tab is in the row it clicks it. Otherwise it clicks More (the tab with `aria-haspopup="menu"` in the "Panels" tab list), then the `menuitemradio` with that name. It then waits for the tab panel named by it.
- **Call sites**: 97 uses of `getByRole("tab", ...)` across 14 files at `e4ec8696` (bardock, combat, desk, display, layout, maps, notes, regress, size, smoke, table, tokenpanel, tools, vision). Those that click a panel More now holds switch to the helper. Those that read the chosen tab (`selected: true`), or click Token, Initiative or Log, keep working: More is a tab named by its panel while chosen. Mostly mechanical.
- **`e2e/desk.e2e.ts` 2** (the tab keys) follows 5.2: Left and Right choose among Token, Initiative and Log, reach More without choosing, and wrap. The check that focus is on the chosen tab holds on every tab but More.
- **`e2e/desk.e2e.ts` 4** (arrowing onto a tab whose panel shows a journal page) becomes the pick from 11.2 case 3: the Journal is in More at 1280 x 800, so it is picked by keyboard, and focus stays on More.
- **`e2e/layout.e2e.ts` 6** (932 x 430): the row is one line that does not scroll, Token and Initiative are in it, Hide panels' icon differs from More's caret, and the keys move along Token, Initiative and More.
- `e2e/size.e2e.ts:212` counts tabs among its targets, More included. It opens no menu, so it needs no change.

Browsers: the e2e runs in Chrome only. Safari does not focus a button on a click, so by tool options 7.1 a pointer open focuses More itself (`preventScroll`), never the menu, and a pick ends on More, as in Chrome. The build checks both by hand in Safari on a Mac and an iPad before it merges.

Waived before merge by the project owner (2026-10-17): the build ships, and these hand checks in Safari on a Mac and an iPad follow after the deploy, as with the PDF handouts. A problem found then is fixed in a follow-up.

## 12. FEATURES.md

In "Phones, tablets and connection":

- "On a screen 900 px or wider, panels are tabs in a side panel. Hide panels at the end of its tabs, or the S key, hides it, and Panels in the toolbar brings it back. This device remembers the choice. A short screen, such as a large phone held sideways, starts with it hidden, and shows its tabs in one row that scrolls." becomes "On a screen 900 px or wider, panels are tabs in a side panel, in one row: the most used first, as many as fit, then More, which lists the rest. A panel opened from More shows its name on More, and the tabs never move. A long name there may end in "…", and the panel then shows its full name at its top. A count on a panel inside More shows on More too. Hide panels at the end of the tabs, or the S key, hides the side panel, and Panels in the toolbar brings it back. This device remembers the choice. A short screen, such as a large phone held sideways, starts with it hidden." The rest of that line stays.
- "Panels are listed with the ones used in play first. A DM's phone list groups them under In play and Prepare." becomes "Panels are listed with the ones used in play first, in an order that never changes with use. A DM's phone list and the side panel's More group them under In play and Prepare."

In the shortcut tables, which the sheet build makes mirror its registry and checks in `shortcuts.test.ts`:

- The "Side panel tabs" intro and table follow 5.4 row for row: its new intro, `tabsSide` and `tabsEnds` with their new words, the six new rows, and no "Wheel over the tabs" row.
- If the sheet build has not landed when this one does, the paragraph "On a focused side panel tab, Left and Right switch to the tab beside it, and Home and End to the first and the last. There, and on a focused choice or slider, the arrow and Page keys never move a token." takes the same rows as sentences instead, and the sheet build's tables take them when it lands.

No line names how many tabs the row holds.

## 13. Build plan

Five commits, in this order. Run `pnpm -s typecheck`, `pnpm -s test` and `pnpm -s build` together after each, and the whole e2e after the last, since commit 4 touches 14 files.

1. **The menu** (4.4, 4.3, 5.1, 5.2).
   - The popover base itself is built as tool options 7.1 ("The shared popover base") says, by whichever of the two builds comes first. This build uses it and adds nothing to it.
   - `client/components/Menu.tsx` and `menuKeys.ts` with its test: roles, groups, separator, keys, typeahead, the opening item, the pick's order.
   - `client/state/shortcuts.ts`: `[role="menu"]` in `NAVIGATES`, with its test.
   - Commit: `feat(ui): a menu with keys and typeahead on the shared popover`.
2. **One grouping** (4.1, 7).
   - `client/features/panels.ts`: `panelSections`, with its test in `panels.test.ts`. `client/pages/Room.tsx` PanelPicker uses it, with no visible change.
   - Commit: `refactor(ui): one grouping for the phone's panel list and the side panel's more menu`.
3. **The row** (3, 4, 5.3, 6).
   - `client/pages/tabFit.ts` (new), with `MORE_CAP` and whether a name is cut, and its test with the measured fixtures.
   - `client/pages/Room.tsx` `SidePanel`: the measuring row, the fit and its observer, More as a tab with the menu, the row drawn from the fit, corner badges, 6 px padding, the `ScrollStrip` and its rule gone, the tab keys over the row and More, `tabRef` on More while it is chosen, focus to More when the fit moves a focused tab, and the header that names a cut panel in full (3.8). Room's focus request for the chosen tab waits for the fit (`:627-635`). The comment at `:205-206` says the tabs stand in one row with More.
   - `client/pages/RoomChrome.tsx` `Badge`: the prop that leaves out its hidden words.
   - `client/features/panels.ts` `useSubpageFocus`: `[data-tabs-menu]` beside the tab list (`:347`).
   - The shortcut sheet's "Side panel tabs" section (5.4) in the sheet build's `BEHAVIORS` and `SURFACE_INTRO` (`client/state/shortcuts.ts`, drawn by `client/features/device/ShortcutSheet.tsx`): two rows changed, six new, `tabsWheel` removed, the new intro, and the section's code comment. Its FEATURES.md table changes in the same commit, so the sheet build's check passes. If that build has not landed yet, this one writes the paragraph of section 12, and the rows go into the registry in the same piece of work as whichever build lands second.
   - `FEATURES.md` as in section 12, its "Keyboard shortcuts" part matching the sheet, and in docs/design-v1-layout-hierarchy.md a line under 4.1's "A short side panel" and under M3 pointing here.
   - Commit: `feat(ui): the side panel's tabs in one row with a grouped more menu`.
4. **Existing e2e** (11.3).
   - `e2e/harness.ts` `openSideTab`, and the call sites, `desk.e2e.ts` 2 and 4, and `layout.e2e.ts` 6.
   - Commit: `test(e2e): open a side panel tab through more where the row does not hold it`.
5. **New e2e** (11.2).
   - `e2e/paneltabs.e2e.ts`.
   - Commit: `test(e2e): the side panel's one row, its more menu and their reach`.

Files another build may also edit: `client/pages/Room.tsx`, where docs/design-v1-tool-options.md replaces the options rail and this design changes `SidePanel` and its focus request, in separate parts of the file. Whichever lands second keeps the other's change. The popover base is the other shared piece: tool options 7.1 rules it.

## 14. Decided

The project owner answered on 2026-10-16.

1. **Menu, and so the X-card, on a wide screen.** Menu goes inside More, last after a line, decided by the project owner. On a computer or tablet the X-card takes one more tap than today: More, Menu, X-card, then the X, as on a phone today. The other way, a Menu icon button beside Hide panels, would have kept the X-card where it is but taken the room of one tab, so Log would have moved into More for everyone (3.6).
2. **More's label.** A long name on More is cut with an ellipsis past a cap, "Encount… ▾", so that Log keeps its place with a wider font, and the side panel shows the full name above the panel, decided by the project owner after the design review's round 1. The cap is set from measurements with macOS's system font, Segoe UI and DejaVu Sans, so Token, Initiative, Log and More fit a 295 px row with each (3.2, 3.8). FEATURES.md promises no number of tabs (12).
