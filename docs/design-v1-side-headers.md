# raccoon-vtt v1: compact, consistent headers in the side panel

Status: decided and built. The project owner chose option A on 2026-10-17, with "Ask" on the folded party line and one 45 px row height everywhere (section 14). Prototypes B and C were dropped. Section 12 lists the build. Code is cited from the stacked tip `wotwryrz` (main with the live play dice fixes and the critical hit rules). This design builds on docs/design-v1-panel-tabs.md ("the tabs design"), docs/design-v1-split-panel.md ("the split design"), docs/design-v1-visual.md 2.3 ("the visual design") and docs/design-v1-layout-hierarchy.md 4.1, and keeps what they decided except where section 10 says.

The project owner asked on 2026-10-17, with a screenshot of the side panel on a computer: "the collapsed party header should take up less space. it could be side scrolling when collapsed, also, the headers in the sidebar when in split mode should take up less room if possible? open to ideas here." And: "i also just generally want the headers in the sidebar to be more consistent looking (between the top and bottom split panels)".

Sizes are in the side panel's own px (360 wide at every interface size, `chromeZoom`), so 130% draws each 1.3 times larger on screen. Measured numbers are in appendix A, screenshots in appendix B.

## 1. Summary

- **Every header in the side panel becomes one 44 px row with a 1 px rule**, 45 px in all. The rows lost their room to padding above and below, not to their controls: the tab row's 8 px above and below came from the wrapping tabs it no longer has.
- **The folded party bar is one line**: Party, the names and HP in a strip that scrolls sideways under a fade, and Ask. 105 px becomes 45.
- **The two panes' headers share one look**: the same band, height, type, padding and icons, and each pane's chosen panel wears the same pressed pill, in the tab row for the top pane and on the bar's name for the bottom one.
- **Saved**, for a DM at every measured size: 76 px with one panel, 77 with two, and 101 with a subpage open in each pane. A player saves 16, or 17 with two panels. At 130% that is about 99, 100, 131 and 21 screen px. On a phone held sideways at 85% (844 x 390) and a large phone at 932 x 430, the DM's side panel now holds two panels, where before it was too short.
- **Three options** were prototyped: A, compact rows in place. B, the panel below gets a tab row of its own. C, Hide panels moves onto the party line so the DM's row gains Log. The project owner chose A (section 14).
- **Two layout bugs** found on the way are fixed in every option: a long name pushed every party row's HP past the edge, and a folded chip for a character off the scene could not be reached by keyboard.
- No data, protocol, op, stored key or panel rule changes. Phones keep their sheets as they are, with the long name fix.

## 2. Today

### 2.1 The headers

| Header | Where | Height | Made of |
|---|---|---|---|
| Party, folded | `features/party/PartyDock.tsx:20`, `PartyBar.tsx:104-141` | 105 | 4 px padding, a row with "PARTY >" and "Ask the party" (44), a 4 px gap, a row of chips (44), 8 px padding, a 1 px rule |
| Party, open | the same | 381 at 1280 x 800 | the heading row, then the list, up to 40% of the screen |
| Tab row | `pages/SideTabs.tsx:315` | 61 | 8 px padding, the 44 px tabs, 8 px, a rule, on the panel's surface |
| The bar between two panes | `pages/SplitBar.tsx:170-190` | 46 | a rule, 44 px, a rule, on the raised surface, 4 px side padding |
| A subpage's header in a pane | `pages/Room.tsx:2510`, `components/SheetHeader.tsx:170` | 57 | the sheet header's 56 px row, title at 18 px, and a rule |
| A phone's sheet header | `components/Sheet.tsx` | 60 | 56 and the swipe pill's room |

A DM at 1280 x 800 with two panels and a subpage in each spends 326 of 800 px on headers, and each pane keeps 237 px of body.

### 2.2 Findings

| # | Finding | Severity |
|---|---|---|
| F1 | The folded party bar takes two rows, 105 px, where its heading row holds only "Party" and Ask. Its chips already scroll, under a thin scrollbar | Medium |
| F2 | The tab row keeps 8 px above and below. It held four wrapped rows and the corner badge's 6 px rise before the tabs design, and holds one row now | Medium |
| F3 | The two panes' headers differ in every part: the tab row is on the surface with 8 px padding and the chosen tab in the pressed look, the bar is raised with 4 px padding and its panel's name in plain text with no chosen look. The bottom panel does not read as the same kind of thing as the top one | Medium |
| F4 | A subpage's header in a pane is the 56 px sheet header with an 18 px title, under a row that already names the panel. Two of them cost 114 px | Low |
| F5 | On a phone held sideways at 85%, the DM's room is 292 px, under the split's 336, so "Two panels" is disabled there. The headers above take 166 | Medium |
| F6 | A long character name (40 letters) pushed every row of the open party list wider than the panel, cutting each row's HP, on the side panel and on a phone's Party sheet. The list and the row's text are grids whose one column took the name's whole width (`PartyBar.tsx:121,187`) | High |
| F7 | A folded chip for a character with no token on the scene is `disabled` (`PartyBar.tsx:145`), so Tab skips it and a keyboard cannot scroll the strip to read it | Medium |
| F8 | A DM whose room has characters but none a player owns gets an empty 13 px strip with a rule, since the dock counts every character and the bar counts the party's (`PartyDock.tsx:17`) | Low |

Screenshots: `audit/` (appendix B). The fixture's new `party=1` adds six characters, two off the scene and one with a 40 letter name, so the folded line scrolls and F6 shows.

## 3. What every option shares

The prototypes were built in one stack: A first, then B and C each on top of A, so each option below is A's base plus what it changes. A is built (section 12), and B and C were dropped.

### 3.1 The header row

`components/HeaderRow.tsx` (new) gives every header in the side panel one shape:

- **One line of 44 px targets with a 1 px rule at its foot**, 45 px. No padding above or below. 8 px at the sides and 4 px between controls, as today.
- **A control with a shape of its own draws it on a pill**: 32 px tall, centered in its 44 px target, radius `md`. The chosen tab, More, the bar's name, a party chip and Ask take it. The target stays 44 x 44, and the outline never meets the rules above and below, where a 44 px box in a 45 px row looked jammed.
- **The focus ring goes on the pill** (`[data-pill-focus]` in `client/globals.css`), so it hugs the shape and stays inside the party strip, which clips above and below.
- **The pill takes no room.** It lies under the text, so a tab's width is its text's alone and the tab fit (the tabs design 3.2) reads nothing new. Tabs keep their 6 px side padding and More its cap.
- **Badges sit on the pill's corner**, inside the row. With no padding above, the old 6 px rise would have crossed the party line's rule.
- **The pill comes last in its control** and paints behind its words (the control is its own stacking context). So a badge's hidden words follow the title in the control's name, "Log 2 unread", as the tabs design names it.
- **The bar between two panes is a header row too**: 45 px with the rule at its foot. The line where it meets the pane above is drawn inside its band, so it divides the panes without growing.

### 3.2 The party line

- **Folded: one row.** "PARTY >" (the fold button, as today), the chips in a strip that scrolls sideways, then Ask. The strip is the toolbar's `ScrollStrip`: no scrollbar, a 32 px fade on a side that hides more, a chevron over the fade that pages it (hidden from screen readers and Tab, as the toolbar's), and the mouse wheel scrolls it sideways.
- **Ask** reads "Ask" on the folded line, its name and tooltip "Ask the party", so speech input that says either finds it (WCAG 2.5.3). The two missing words cost about 70 px, most of a chip (question 2). Open, it reads "Ask the party".
- **A chip** shows the name, cut with an ellipsis past 96 px, and HP or Dying, Stable or Dead in its label's color. Its tooltip and name hold the whole name. A chip off the scene shows its name muted and is `aria-disabled` rather than `disabled`, so Tab reaches it, and its name ends "not on this scene" (F7).
- **Keyboard**: Tab moves through Party, each chip, then Ask. A chip that Tab reaches scrolls clear of the fade (`ScrollStrip` now does for focus what it does for its active button), so the keyboard reads every name.
- **Open**: the heading row is one 44 px line too, and the list keeps its 40% cap with 8 px under it. The list and each row's text get a column no wider than the panel, so a long name ends in an ellipsis and HP stays in view (F6, also on a phone's Party sheet).
- In the 360 px panel the strip has 219 px: two or three chips at once. The fixture's default party, Thorn and Vex, fits whole with no scrolling.

### 3.3 The subpage header

In a pane, a subpage's header and the full name More cut (the tabs design 3.8) take the row's height: 44 px with the title at 16 px weight 700, a pane title's size (`SheetHeader` gains `compact`). Back stays a 44 px icon named "Back to" its panel. A phone's sheet header keeps 56 px and 18 px: it is the swipe's grab area there and holds up to five buttons.

## 4. The options

### 4.1 A: compact rows in place (recommended)

Every control stays where it is. The tab row and the bar become the same kind of row:

```
+--------------------------------------------+
| PARTY > [Ash 12/12][Bartholome…  >  [Ask]  |  45: the party line
+--------------------------------------------+
| Token [Initiative] Dice  More v       [|>] |  45: raised band
+--------------------------------------------+
| Round 2                   [Previous][Next] |  top pane
| ...                                        |
+--------------------------------------------+
| ::  [Characters v]                [^v] [x] |  45: raised band, a line drawn inside its top
+--------------------------------------------+
| < Ash                                      |  45: a subpage, when one is open
+--------------------------------------------+
| ...                                        |  bottom pane
```

- **The tab row**: raised band, no padding above or below, the chosen tab's pressed look on its pill.
- **The bar**: the same band, 8 px side padding (was 4), and the bottom panel's name drawn as More draws a panel it holds: the title and a caret in the chosen tab's type and pressed pill. So both panes' chosen panels wear one marker, and the bar's name reads as a picker, which it is. Grip, Swap and Close keep their places and icons.
- **Saved**: 76 px for a DM, 77 with two panels and 101 with a subpage in each pane, 16 for a player (appendix A). Two panels fit from a 311 px room: a pane's minimum counts the compact header (133) and the bar is 45. The DM's side panel at 844 x 390 at 85% has 368.
- **Cost**: the least. Names, roles, keys, focus order and every e2e query stay. The look of the tab row changes for everyone (a raised band), and the bar's name gains the accent.

Screenshots: `option-a/` (the prototype) and `build/` (as built).

### 4.2 B: the panel below gets a tab row of its own (not taken)

A, and the bar becomes the bottom pane's own tab row: the same component as the one on top, its tabs fitted to the same 295 px, its More holding the rest, and Close where Hide panels stands above. Nothing tells the two rows apart but their pane.

```
| Token [Initiative] Dice  More v       [|>] |  picks the top panel
| Round 2 ...                                |
+-------------------- == --------------------+  == the separator's pill
| Token  Initiative‾ Dice [Characters v] [x] |  picks the bottom panel. ‾ marks the top's
| ...                                        |
```

- **Its tabs pick the bottom panel** (`openPanel(id, { pane: "below" })`, the split design 5.1, unchanged). The top panel's tab carries the accent line along its pill's top, "Shown on top", and a press on it swaps the two, as a press on the bottom panel's tab in the top row does.
- **Swap** moves into the bottom row's More, as its first item, where "Two panels" heads the top's. **The grip goes**: a press anywhere on the bar, a tab included, drags once it passes the 8 px slop, and a press under the slop is a tap. Pointer capture starts only past the slop, so a tap reaches its tab. **The keyboard's separator** is a pill on the bar's top edge, as a sheet's grabber, focusable, with today's Up and Down steps.
- **Roles**: two tab lists, "Panels" and "Panels below", each naming its own tab panel. The bottom pane becomes a tab panel, not a group. O goes to the bottom row's chosen tab.
- **Saved**: as A.
- **Cost**: the most. It changes how the bottom panel is picked (tabs in place of the "Panel below" menu), drops the visible grip and Swap, and rewrites `e2e/splitpanel.e2e.ts`. Its gain over A is one tap to switch the bottom panel among the row's tabs.

Screenshots: `option-b/` (two panels only: with one panel it is A). Its prototype commit was abandoned.

### 4.3 C: Hide panels on the party line (not taken)

A, and while a DM's party bar shows, Hide panels stands at the end of its first line, the side panel's top right corner. The tab row is then the tabs' alone: 343 px, which holds Token, Initiative, Dice, Log and More. Log, an every scene panel, went into More when Dice arrived, and comes back for the DM.

```
| PARTY > [Ash 12/12][Bart…  >  [Ask]  [|>]  |
| Token [Initiative] Dice  Log  More v       |
```

- A player has no party bar, so Hide stays at the tab row's end, which is the same corner. Hide stands outside the lazily loaded bar, so it never waits for it, and the dock now shows only for a party a player owns (F8).
- **Saved**: as A, plus a tab for the DM.
- **Cost**: the party strip shrinks to 171 px, one or two chips (the default party's Vex is cut), and Hide sits in a different row for a DM and a player. Tab order puts Hide before the tabs for a DM.

Screenshots: `option-c/` (the DM's states: a player's is A). Its prototype commit was abandoned, and its fix for F8 went into the build.

### 4.4 Weighed and not taken

- **Icon tabs.** Five icons fit where three titles do, but Token, Initiative, Log and Journal have no icon a touch user reads at once, and the project owner's rule keeps a short label on a touch screen unless the icon is unmistakable. Two looks, icons on a mouse and titles on touch, would make the tab fit differ by pointer.
- **The folded party as a summary in the tab row** (a "Party" button with colored dots). It saves the whole party line, but the folded bar's purpose is names and HP at a glance, which the request keeps by scrolling them.
- **Panel title pickers in place of the tabs** ("Initiative v" atop each pane). Perfectly consistent, but it takes back the one-tap tabs the project owner chose in the tabs design.
- **36 px rows with a mouse.** About 8 px more per row, but the app keeps one size for every pointer, and a laptop with a touch screen reports a fine pointer (question 3).

### 4.5 Recommendation and decision

**A**, which the project owner chose. It saves what B and C save, keeps every control and behavior where it is, and makes the two panes' headers one thing in band, height, type, padding, icons and marker. B's extra consistency costs a new way to pick the bottom panel and a hidden grip, for one tap saved. C's tab costs the party line most of its room. B and C build on A, so either can follow later.

## 5. The rules both panes' headers follow

1. **Row**: 44 px targets and a 1 px rule at the foot, no padding above or below, 8 px at the sides, 4 px between controls, 2 px between tabs and 8 px before a group's first tab (the layout design's M3). The bar draws the line over it inside its band, where it meets the pane above, so it is 45 px too.
2. **Band**: a pane's own header (the tab row, the bar) is raised (`surfaceRaised`). The party line and a subpage's header sit on the surface.
3. **Type**: tabs, More and the bar's name at 14 px weight 600, muted at rest and in the accent when chosen. A subpage's title at 16 px weight 700. Party in the section label's capitals.
4. **Marker**: each pane's chosen panel wears the pressed look (accent tint and outline) on its pill: a tab or More in the top row, the bar's name below. The bottom panel's tab in the top row keeps the 2 px accent line, now along its pill's foot.
5. **More and the bar's name** are one shape: a title and a caret, the title cut with an ellipsis in its own span, the name kept whole. Each opens a grouped menu on the shared popover base, as today.
6. **Icons**: 44 x 44 icon buttons, muted, at the row's ends: Hide panels after the tabs, the grip before the bar's name, Swap and Close after it.
7. **Pills**: a 32 px shape in a 44 px target. The focus ring goes on the pill, and a badge on its top right corner.

## 6. Accessibility

Option A changes no role and no name but these:

- A folded chip off the scene: `aria-disabled="true"` in place of `disabled`, its name "Ash, HP 12/12, not on this scene". A press does nothing.
- Ask on the folded line: visible "Ask", name and tooltip "Ask the party".

**Focus order** (a DM, two panels): Party, each chip, Ask, the tab list (one stop), More's menu while open, Hide panels, the top pane, the grip, the bar's name, Swap, Close, the bottom pane. Today's order, with the off-scene chips now in it. B: ... the top pane, the separator, the bottom tab list (one stop), Close, the bottom pane. C: ... Ask, Hide panels, the tab list, the top pane.

**Screen readers**: the party line stays the region "Party" with its list of chips. The strip's chevron is `aria-hidden` and out of the Tab order, as the toolbar's is. Badges keep their hidden "N unread".

**Forced colors**: the pills' outlines are borders, which forced colors draw, as the tabs' were.

## 7. Icons

The prototypes add no icon: each header keeps the app's own icon set. For the icon pass, which takes Lucide (ISC) for interface controls, these are the headers' icons, what each means, and the Lucide icon that fits:

| `IconName` today | Where | Means | Lucide |
|---|---|---|---|
| `chevronRight`, `chevronDown` | Party's fold | Folded, open | `chevron-right`, `chevron-down` |
| `chevronDown` (turned while open) | More, the bar's name | Opens a list of panels | `chevron-down` |
| `back`, `chevronRight` | The party strip's chevrons | More names that way | `chevron-left`, `chevron-right` |
| `collapsePanel` | Hide panels | Put the side panel away | `panel-right-close` |
| `splitPanel` | "Two panels" in More | Two panels, one above the other | `rows-2` |
| `grip` | The bar's grip (A, C) | Drag to resize | `grip-horizontal` |
| `swapPanels` | Swap, and B's menu item | Swap top and bottom | `arrow-down-up` |
| `close` | Close the bottom panel | Close | `x` |
| `back` | A subpage's Back | Back to the panel | `chevron-left` |

Each stays a labeled control with a tooltip. Ask, the tabs and the chips keep their words. The pass credits Lucide with its ISC notice in CREDITS.md and the About page.

## 8. Edge cases

| Case | A | B | C |
|---|---|---|---|
| Eight characters (`party=1`) | The strip scrolls: fade and chevron at the cut edge, the wheel and a swipe scroll it, Tab reaches each chip | as A | as A, in 171 px |
| A 40 letter name | Chip: "Bartholome…" and its HP, whole name in its tooltip and name. Open list: an ellipsis, HP in view | as A | as A |
| No character a player owns | No party line | as A | as A, and no empty strip (F8) |
| A player | No party line, the tab row and bar as the DM's | as A | Hide stays in the tab row |
| A subpage in each pane | 45 px header in each, under its row or the bar | as A, under each pane's own row | as A |
| 130% | The same in own px, 1.3 times on screen | as A | as A |
| 844 x 390 at 85% (short) | The party starts folded, as today. The DM's room is 368: two panels fit (today 292, one) | as A | as A |
| 932 x 430 at 100%, DM | Room 340, two fit, where before 264 did not. With a 21 px home bar inset 319, over the 311 two need | as A | as A |
| A panel opened from More | More names it in the pressed pill | as A, in either row | as A |
| A name More cuts (the tabs design 3.8) | Named in full in a 45 px header | as A, for either pane | as A |
| A count on a tab | On the pill's corner, inside the row | as A | as A |
| Keyboard | Section 6. The tab keys, More's keys, the grip's Up and Down, O, S, unchanged | Separator keys as the grip's. O goes to the bottom row's chosen tab | Section 6 |
| Tablet touch (1180 x 820) | Every target 44 x 44. The strip swipes with no scrollbar. The bar drags by its grip and blank part | The bar drags from anywhere on it, a tab under the slop is a tap | as A |
| Too short for two | The bar and bottom pane hide, as today | as A | as A |

## 9. What must not change

- Every control stays reachable, and every target is 44 x 44 on every pointer.
- The tab fit: the same widths, padding, cap and order, so the same tabs stand in the row (C gives the DM's row more room, so it holds more).
- More's behavior, its menu, "Two panels" and the cut name's header (the tabs design, the split design 6).
- The split: its drag (8 px slop, Escape, one pointer), its keys (8 and 64 px), its sizes and stored share, swaps and where panels open. B moves the drag from the grip to the whole bar and the keys to a separator pill, with the same rules.
- The party bar's fold, remembered as `rvtt.partyFolded`, its folded start on a short layout, and every name the e2e reads: "Ask the party", "Hide panels", "Panels", "More panels", "Token below", "Swap panels", "Close Token". B replaces "Token below" with the bottom row's tabs and makes "Swap panels" a menu item.
- Phones: the sheets, their headers and the Panels list.

## 10. What this changes in other designs

- **docs/design-v1-visual.md 2.3**: a panel subpage's header in the side panel is 44 px with a 16 px title. Sheets and dialogs keep 56 px. The side panel's chosen tab takes the pressed look on a pill.
- **docs/design-v1-panel-tabs.md 3.5**: badges sit on the pill's corner, inside the row, not in the row's top padding, which is gone. 3.7: the tab row is one 45 px line.
- **docs/design-v1-split-panel.md 3.1, 3.3**: the bar is a 45 px header row, its name wears the chosen tab's pill, and it has 8 px side padding. 3.2: a pane's minimum counts the 45 px header, 133 px, so room for two is 311.
- **docs/design-v1-dm-tools.md 3.4** and **docs/design-v1-layout-hierarchy.md 4.1**: the folded party bar is one line, its names scrolling sideways.

## 11. Tests

### 11.1 Unit (node:test)

- `client/components/HeaderRow.test.ts` (new): a header row is 45 px with no padding above or below and its rule at the foot, a pane's band raised and the party line's on the surface, and a pill is 32 px in a 44 px target, last in its control and behind its words.
- `client/components/SheetHeader.test.ts`: `compact` draws a 44 px row with a 16 px title, and a sheet keeps 56 px and 18 px.
- `client/features/party/PartyBar.test.ts`: a chip off the scene is a focusable button with `aria-disabled`, its name ending "not on this scene", and a press does nothing. A long name is cut on its chip and whole in its name and tooltip. A row's text is one column no wider than the row (F6). The side panel shows the bar only for a party a player owns (F8).
- `client/pages/splitPanes.test.ts`: `PANE_MIN` 133, `BAR_PX` 45, `SPLIT_ROOM` 311, and the size table at the rooms the compact headers leave.

### 11.2 e2e: new `e2e/sideheaders.e2e.ts`

On E2E_PORT plus 23. A room where Pat owns eight characters, two off the scene and one with a 40 letter name.

1. **Heights.** At 1280 x 800 at 100% and 130%, 1180 x 820, and 844 x 390 at 85% with 47, 47 and 21 px insets: the party line, the tab row, the bar and a subpage's header in each pane are 45 own px, within half a pixel. Every control in them is at least 44 x 44 and takes a tap at its center.
2. **One look.** With two panels, the bar's name and the chosen tab have the same pill colors and height, font size, weight and color, and the tab row and the bar the same band.
3. **The strip.** Folded, every chip shares one row, a fade shows where it hides more, and no scrollbar takes room. The wheel scrolls it, over its chips and over the chevron at its start. Tab from Party reaches every chip in order, each inside the strip and clear of a fade, then Ask, which reads "Ask" with "Ask the party" as its name. The off-scene chip is not disabled, says "not on this scene", and Enter on it opens nothing. On a touch screen a swipe scrolls it.
4. **Long names.** The long chip's name is cut and whole in its tooltip. Open, every row's HP lies inside the side panel, and on a 390 x 844 phone inside the Party sheet.
5. **Short.** At 844 x 390 at 85% with insets, the DM's "Two panels" is enabled and two panes show.

### 11.3 Existing e2e

`e2e/splitpanel.e2e.ts` takes the new numbers: a pane's minimum 133 and the bar 45. Its case 6 finds "Two panels" enabled for the DM at 932 x 430, and checks the disabled item and the hidden bottom pane at 1280 x 380, where 1280 x 480 now holds two. `paneltabs`, `layout`, `swipe`, `reach`, `rolls`, `size`, `tools` and `desk` pass unchanged: every name they read stays.

## 12. Build

Built on the prototype, in these commits after the design:

1. `kqlvnrwz` `fix(party): a long name ends in an ellipsis in the party list, so every row keeps its hp in view` (F6).
2. `smknpxwk` `feat(ui): the side panel's header rows in one compact look, the bar between two panels as the tab row` (3.1, 3.3, 4.1): `components/HeaderRow.tsx`, `pages/SideTabs.tsx`, `pages/SplitBar.tsx`, `components/SheetHeader.tsx` (`compact`), `pages/Room.tsx` (`SidePane`), `client/globals.css` (the pill's ring).
3. `xooqkoqt` `feat(party): the folded party bar is one line whose names scroll sideways, each one in reach of the keyboard` (3.2, F7): `PartyBar.tsx`, `PartyDock.tsx`, `components/ScrollStrip.tsx` (focus scrolls clear of the fade, and the wheel works over the chevrons too).
4. `zxvmowmr` `feat(ui): the bar between two panels is a 45 px header row, and two panels fit from 311 px` (`pages/splitPanes.ts`, `SplitBar.tsx`).
5. `pyklzvnt` `fix(party): the side panel shows the party bar only once a player owns a character, not an empty strip` (F8).
6. The unit tests, the e2e (11.2, 11.3) and FEATURES.md (13), each a commit of its own.

The dev fixture's `party=1` (`qmxpxqkn`) stays for looking at the strip by hand.

## 13. FEATURES.md

- **Party bar**: "folds to one line" now says what the line holds: the names and HP, which scroll sideways when they don't all fit (the wheel with a mouse, and Tab reaches each one), and Ask, short for Ask the party, and that a long name ends in "…" with its HP in view.
- **Request a roll**: "Ask the party" is in the party bar, shortened to "Ask" while the bar is folded.

## 14. Decided

The project owner answered on 2026-10-17.

1. **Option A**, compact rows in place. B and C were dropped, and their prototype commits abandoned.
2. **"Ask" on the folded line**, its name and tooltip "Ask the party", and the full words when the bar is open.
3. **One 45 px row height everywhere**, on every pointer, with no denser rows for a mouse. The bar between two panes takes it too: 45 px, the line over it drawn inside its band.

Assumptions taken: phones keep their 56 px sheet header and change only by the long name fix. The build adds no icon, and the icon pass maps the headers' icons (section 7).

## Appendix A: measurements

Chrome on macOS, the dev fixture room with `party=1`, the party folded unless "open", in the side panel's own px. "Headers" sums the party line, the tab row, the bar and any subpage headers. "Built" is the build of section 12. The prototypes measured the same but for the bar, 46 there. Script: `sideheaders/shoot.mjs` in the session scratchpad, results in each folder's `measure.json`.

| State | Size | Before: party, tabs, bar, subpages = headers | Built | Bodies before, built |
|---|---|---|---|---|
| DM, one panel | 1280 x 800, 100% | 105, 61, -, - = 166 | 45, 45 = 90 (76 saved) | 634, 710 |
| DM, party open | 1280 x 800, 100% | 381, 61 = 442 | 369, 45 = 414 (28) | 358, 386 |
| DM, two panels | 1280 x 800, 100% | 105, 61, 46 = 212 | 45, 45, 45 = 135 (77) | 294 each, 332 each |
| DM, a subpage in each | 1280 x 800, 100% | 105, 61, 46, 57 + 57 = 326 | 45, 45, 45, 45 + 45 = 225 (101) | 237 each, 287 each |
| DM, two panels | 1280 x 800, 130% | 211 | 135 (77, 100 on screen) | 202 each, 240 each |
| DM, a subpage in each | 1280 x 800, 130% | 325 | 224 (101, 131 on screen) | 145 each, 195 each |
| DM, two panels | 1024 x 768, 100% | 212 | 135 (77) | 278 each, 316 each |
| DM, a subpage in each | 1180 x 820 touch, 100% | 326 | 225 (101) | 247 each, 297 each |
| DM, a subpage in each | 1180 x 820 touch, 130% | 325 | 224 (101) | 153 each, 203 each |
| DM, one panel | 844 x 390 at 85%, touch | 166 | 90 (76) | 293, 369 |
| DM, two panels | 844 x 390 at 85%, touch | 166, one pane (room 292, too short) | 135, two panes | 293, 162 each |
| Player, one panel | 1280 x 800, 100% | 61 | 45 (16) | 739, 755 |
| Player, two panels | 1280 x 800, 130% | 107 | 90 (17) | 254 each, 262 each |
| Phone 390 x 844, Party sheet | 100%, 130% | header 60, rows past the sheet's edge | header 60, rows inside | |

Tabs in the row at every measured size (the harness draws no side insets): Token, Initiative, Dice and More for both roles. A phone's 47 px side insets narrow the row as before (the tabs design 9.1): at 844 x 390 at 85% with them, Token, Initiative and More.

At 932 x 430 at 100% with two panels stored, the DM's room is 340 (264 before), and at 844 x 390 at 85% it is 368 (292 before), both with no insets. With the 21 px home bar inset, 319 and about 347, over the 311 two panels need.

The folded strip at 1280 x 800 is 219 px: Ash's chip (76 px) and most of the long name's (151). The default party's chips, Thorn 112 and Vex 69, fit it whole.

## Appendix B: screenshots

In `raccoon-vtt/side-headers/` in the project owner's screenshot folder: `audit/` (before), `option-a/`, `option-b/` and `option-c/` (the prototypes), and `build/` (as built, the same states and sizes as `audit/`). Each file is `<state>-<size>.png`:

- States: `dm-one-folded`, `dm-one-open`, `dm-split` (Initiative over Characters), `dm-split-subpages` (Menu's Members over a new encounter), `dm-more-picked` (Monsters from More), `player-one`, `player-split`, and on phones `dm-party-sheet` and `dm-subpage-sheet`.
- Sizes: `1280x800-100`, `1280x800-130`, `1024x768-100`, `1180x820-100-touch`, `1180x820-130-touch` (the tablet held sideways), `844x390-85-touch` (a phone held sideways, wide at 85%), and for phones `390x844-100`, `390x844-130`, `844x390-100` and `820x1180-100` (the tablet upright, a phone layout).
- `option-b/` holds the split states only and `option-c/` the DM's: the rest are A's.
