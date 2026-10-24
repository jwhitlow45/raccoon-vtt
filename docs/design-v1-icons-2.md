# raccoon-vtt v1: icons, the second pass

Status: designed and revised after review round 1, with three prototype commits and their fixes beside this note (section 12). Code is cited from main at `1ca246d2`. This pass keeps the first pass's rules (docs/design-v1-icons.md 3.1 to 3.3), its vocabulary (2.2), its collisions (2.3) and the owner's decisions (10), and adds the rules of section 3.

The project owner asked on 2026-10-24: "I don't know if this was just dropped as I thought I mentioned it before but a pass to add icons in the ui would be nice to make things more glanceable. Just ensure it does not cause unnecessary wrapping."

Then, the same day: "In this they should also be added to the panels tab selector."

And: "I also wonder if the combat tab should have them too. Overall I just want anywhere that visually makes sense to use them so long as they do not cause things to be too busy while improving glanceability."

And, of the token bar: "Thoughts on having more icons in the pop up token window?" (section 8).

## 1. Summary

- **Every panel gets an icon**: in the side panel's tabs, in More and its list, on the bar between two panels, and in a phone's Panels list. In today's 360 px side panel the tabs draw their icons alone, since icon and name would cost the row a tab. The row then holds four panels where it held three. On a touch pointer, wherever the row does not show the open panel's name, the side panel names it in a header line above the panel (D-261024-36). A computer names a tab on hover and focus instead and keeps the panel's height.
- **The combat tab reads at a glance**: the tracker's and party bar's condition chips draw the same art as the map's chips, in the same box, where the chip holds no number. Exhaustion keeps "E2". The turn timer wears a timer. The alerts' Dismiss, Collapse and Show become the close and chevrons every sheet and fold draws, and a line for time up or an ended effect starts with its kind.
- **The Token panel's groups and a character's page wear an icon each**, before the group's name. Inside a group the section labels stay words.
- **Nothing wraps that did not**. Every proposal was measured in the browser at 320 x 568 and 390 x 844 at 130%, 390 x 844 at 115% and 85%, and 1280 x 800 at 100%, 115% and 85%. Several candidates failed the measure (section 9). One cut is allowed by name: a folded group's summary gives way to its icon (3.3).
- **The token bar** takes a leading icon only in the expanded bar's rows, where they wrap. Its resting strip fits its buttons by width, and an icon there would push a control off it (section 8, from the bar design's widths, to be measured once the bar lands).
- **Rules terms and actions stay words**: Previous, Next, Use, Restore, Take a shape, Roll, Apply, a condition's name, Legendary Resistance.
- No data, op, protocol or stored key changes. Nineteen Lucide icons are copied and credited, two of them derived from Feather. One drawing is derived from the app's own art (the Dice panel's). None is drawn new.

## 2. Vocabulary

New meanings, one drawing each, checked against the first pass's 2.2 and 2.3. "Lucide" means its path data copied into `client/components/Icon.tsx`, as the first pass's section 6 says.

| Meaning (`IconName`) | Drawing | Source | Used for | Never for |
|---|---|---|---|---|
| `token` | person in a circle | Lucide `circle-user-round` | The Token panel | Members (`group`) |
| `combat` | crossed swords | Lucide `swords` | The Initiative panel, the Token panel's and a page's Combat group | Remove from the fight (`removeFromFight`) |
| `dice` | a d20's hexagon and face | derived from the app's `D20Icon`: its hexagon and face at half size, as lines, the spokes dropped | The Dice panel | A Roll button, which keeps its word |
| `log` | scroll with lines | Lucide `scroll-text` | The Log panel | |
| `journal` | notebook with lines | Lucide `notebook-text` | The Journal panel | A token's Notes (`notes`) |
| `areas` | circle and radius | Lucide `radius` | The Areas panel | One area's shape (`areaCone` and the rest) |
| `dm` | crown | Lucide `crown` | The DM panel | |
| `scenes` | folded map | Lucide `map` | The Scenes panel | The Pin tool's pin |
| `monsters` | skull | Lucide `skull` | The Monsters panel | Dead, a death save (words) |
| `encounters` | clipboard with a list | Lucide `clipboard-list` | The Encounters panel | |
| `characters` | person on a card | Lucide `contact-round` | The Characters panel | |
| `outliner` | indented list | Lucide `list-tree` | The Outliner | |
| `library` | books on a shelf | Lucide `library` | The Library panel | The DM guide (`guide`) |
| `timer` | stopwatch | Lucide `timer` | The turn timer's clock, a time up line | A duration in rounds (words) |
| `statBlock` | page of text | Lucide `file-text` | The Stat block group | |
| `notes` | sticky note | Lucide `sticky-note` | The Notes group | The Journal |
| `position` | compass | Lucide `compass` (Feather) | The Position group | |
| `image` | picture | Lucide `image` | The Image group | A button that picks a picture (words, first pass 2.2) |
| `stats` | hash | Lucide `hash` (Feather) | The Stats group | |
| `companion` | paw print | Lucide `paw-print` | The Companion and Companions groups | |

Reused meanings: Party takes `group` (several creatures at once) and Menu takes `more` (a menu of more). Token settings takes `settings`, and Owners and Played by take `group`, the Menu's Members. Hidden and Locked tags take `hidden` and `locked`. New and Add buttons take `plus`, and a page's Delete takes `delete`. The bar's two new meanings are in section 8.

Game concepts take the art the app already ships. A condition or status shows its game-icons.net art (`shared/credits.ts` `CONDITION_ICONS`, `STATUS_ICONS`) through a new `EffectArt`, the mask `EffectIcon` already draws, in the text's color.

The Dice panel's icon is derived, not copied. The app ships game-icons' `delapouite/dice-twenty-faces-twenty.svg`, but that art is a filled picture, and in the tab row beside four stroked Lucide icons it would read heavier than its peers: the reason Monsters takes Lucide's skull over the dragon head (decision 3). Lucide's `dices` draws two six-sided dice, which the first pass ruled out (its section 1). The app's own `D20Icon` drawn as lines at half size is a d20 in the row's stroke.

Collisions checked: the skull is no other meaning's, and Dead and the death save keep their words, so it never reads as dying. `combat` is not `removeFromFight`. `journal` and `notes` draw a notebook and a note. `timer` is the turn timer only: an effect's rounds left stay words, since the Readied status's art is an hourglass. The swords mean the fight wherever they stand, and the owner calls the Initiative panel the combat tab.

## 3. Rules this pass adds

### 3.1 Rows that hold a set of places

A tab row, More's list and a phone's list name places. Each panel shows its icon in each.

- **The side panel's tabs** draw each panel's icon before its name where the row then holds as many tabs as the names alone would. Otherwise they draw the icons alone, each a 44 px target. An icon-only tab is named by a visually hidden title beside its badge, never an `aria-label`, so the badge's words stay in its name ("Log 2 unread", "DM 1 upload waiting", panel-tabs 3.5). Its name shows on hover, keyboard focus and a long press, the first pass's tooltip (its 3.2). The choice is measured on the device, as the tab fit is (docs/design-v1-panel-tabs.md 3.2): `tabFit.ts` `tabLook` compares the two fits and `widthsFor` gives the fit its widths. An icon alone never holds fewer tabs than a name, since no tab is narrower than 44 px.
- **More** at rest keeps "More" and its caret: it is not a panel. Holding the open panel, it draws that panel's icon and name. Where the name would be cut it draws the icon alone, with the held panel's name as the same tooltip, keeping its menu on a click and its description. No tab is ever cut or wrapped.
- **The header line** (panel-tabs 3.8 as D-261024-36 amends it): on a touch pointer (`(pointer: coarse)`), wherever the row does not show the open panel's name, an icon-only tab chosen or More's icon alone, the side panel draws its compact header naming the panel above it. So a tablet never needs a long press to learn which panel is open. `tabFit.ts` `headerNamesOpen` decides it from the fit's numbers and the pointer, and `SideTabs` hands it up in a layout effect, so the header and the panel draw in one frame and never flicker. A computer never draws it: its icon tabs follow the first pass's rule 2, the name on hover and focus, and the panel keeps its height. Below 900 px of layout width a phone's sheet names the panel in its own header, so the sheet never draws it. A phone held sideways that docks the panel, which starts hidden there and is shown by choice (844 x 390 at 85%, 932 x 430), is a touch pointer and draws it. The split bar names the panel below, so the lower pane never draws it either. A subpage's header names the panel in its Back, as today.
- **More's list, the split bar's list and its name, and a phone's Panels list** draw the icon before the name, 16 px in a menu row and the bar, 20 px leading a phone's row in the muted color, the accent while chosen.

### 3.2 Where an icon goes, so nothing gets busy

- **An icon goes where the eye looks for a place**: a tab, a list of places, a group's header, an alert's kind, a control found among others such as a card's close.
- **Not on every word.** Section labels inside a group stay words: the group's icon finds the place and the capitals read it. Buttons in a row of word buttons (Roll, Skip, Dismiss under a card) stay words, since one icon among words is noise and icons on all of them would read slower than the words.
- **One icon per control at most**, and never a second drawing of what the row already shows. The tracker's Readied tag stays words because the row's chips now carry the Readied art. A token header's "Name hidden" stays words beside Hidden's eye.
- **Peers match.** Every group of the Token panel wears an icon, or none would. Where most peers have no art, such as the alert cards' titles or the bar's HP modes, all stay words.
- **Screens look calmer or equal.** Each screen's before and after shots are in `screenshots/icons2/r2/` and `r3/`, and section 10 says why each is calmer or equal.

### 3.3 No new wrap

An icon is out wherever it would make a label wrap, a row grow, a word cut or a row overflow where it did not before, at any of the seven sizes of section 1. Then the control stays words everywhere, so a control never changes look by size. Three exceptions, each by name:

- **The tab row** of 3.1 picks its look by room, as its rule says.
- **The token bar's Expand and Collapse** keep the chevron alone on a phone at 320 and 390 at 130%, where their words would cut the strip's status line, and take their words where room allows (D-261024-37 amended, section 8).
- **A folded group's summary may be cut** to keep the group's header on its line with the icon. The summary repeats what the open group shows, and its whole words stay in the fold button's description. Measured on `1ca246d2`: with the icon and today's summary rule, Thorn's folded Stat block header wraps at 1280 x 800 at 85%, 100% and 115% (48 px to 100 at 100%) and Wren's at 390 x 844 at 115% (55 to 115). With the summary's rule of section 5 no header grows anywhere, and these summaries are cut: Thorn's "Level 7, PB +3" to 70 px of 86 at 1280 x 800, Wren's "Level 4, PB +2" to 76 of 88 at 390 at 115%, both to 79 of their 86 and 88 at 320 at 130% (whole at 103 before), and a goblin's "Goblin Warrior, CR 1/4" to 133 of 135 at 390 at 130%.

## 4. The combat tab: the tracker and the alerts

| Control | Today | Icon | Rule | Measured (worst size) | Verdict |
|---|---|---|---|---|---|
| A row's condition chips | a two letter glyph | the condition's art in the chip | game art | the chip box is unchanged: 20 x 18 at 100%, 26 x 23 at 130% | in |
| A row's exhaustion chip | "E2" | none: its letters hold its level | 3.3 | the art and the level beside it measured 27 x 18 at 100% (35 x 23 at 130%), past the 20 px box. "E2" stays 20 x 18 | words |
| A row's counted effect ("Hx 3") | letters and number | none | 3.3 | Hexed's art and 3 is 27 px, its letters and 3 28, but a one letter glyph ("C 3") would grow by about 7 px | words |
| A custom status chip | its glyph | its glyph | | | unchanged |
| The party bar's chips | glyphs, no number | the art, and exhaustion keeps "E1" to "E6" | game art | the same box: Hexed 20.6 x 18 to 20 x 18, E2 20 x 18 | in |
| Round header's clock | "9:46" | `timer` at the clock's text size | 3 | the header's height unchanged: 68 px at 1280 x 800, 90 at 320 at 130% | in |
| Previous, Next, Start, End turn | words | none | 4 | | words |
| Tags LA, LR, Lair, Reaction used, Readied | words | none | 4, 3.2 | | words |
| Remove, Move up, Move down, Undo an HP change | icons | unchanged | | | built |
| Section labels (Auto Initiative, Turn timer and the rest) | words | none | 3.2 | | words |
| Turn card's Collapse | "Collapse" | `chevronDown` before the title, as the trap card's fold | 1 | about 86 px of words to 44, the card's height unchanged (227 px at 100%) | in |
| Folded turn card's Show | "Show" | `chevronRight` leading the folded line, as the trap card's, in one button named "Show {title}" and described by its count ("3 uses") | 1 | the chevron 17 px from the card's edge at 130%, the folded card 59 px as before | in |
| Turn card's and a line's Dismiss | "Dismiss" | `close`, alone | 1 | about 78 px to 44 | in |
| Time up line | words | `timer` before them | 3 | the x saves about 34 px and the timer takes 20, so the words have more room than today | in |
| "Frightened ended on Wren." | words | the effect's art before them, where it has art | game art | each line's height unchanged: 62 px at 100%, 80 at 130%, 71 at 115%, 53 at 85% | in |
| Concentration, save-ends, death save, regeneration and recharge titles | words | none | 3.2 peers | only concentration and save-ends have art | words |
| A trap card's title | "Poisoned Needle went off" | the trap's art | | wraps at 320 at 130% (266 px room) | out |
| Card buttons: Roll, Passed, Failed, Skip, Mark ready, Apply, Dismiss | words | none | 4, 3.2 | | words |
| A creature's Uses rows and Use, Restore, Roll recharge | words | none | 4 | | words |

Every tracker row's height is unchanged at all seven sizes, measured with an exhaustion chip and a counted effect in the rows. One `ChipFace` draws the tracker's and the party bar's chips: the art where the chip shows no number, else its letters, and a key with no art falls back to its letters. The turn card's and a line's buttons keep their names ("Collapse Adult Red Dragon's turn", "Dismiss Time is up for Wren's turn"), so every query by name keeps working.

## 5. The Token panel and a character's page

| Control | Today | Icon | Rule | Measured | Verdict |
|---|---|---|---|---|---|
| Group Stat block | words | `statBlock` | 3 | see the next paragraph | in |
| Group Combat | words | `combat` | 3 | every header row's height unchanged at every size | in |
| Groups Notes, Position, Image, Stats | words | `notes`, `position`, `image`, `stats` | 3 | unchanged | in |
| Groups Token settings, Owners, Companion | words | `settings`, `group`, `companion` | 3 | unchanged | in |
| Page groups Combat, Companions, Notes, Image, Stats, Played by | words | the same as the panel's | 3 | unchanged at all phone sizes | in |
| Sections inside a group (Hit Points, Conditions, Rest, Class resources, Range rings, Sight) | capitals | none | 3.2 | | words |
| Conditions' rows | the art | unchanged | | | built |
| Header tag Hidden from players | "Hidden from players" | `hidden`, words "Hidden", the full words as its tooltip | 3 | 188 px to 103 at 130%, the tags' row unchanged (85 px at 390 at 130%, 115 at 320) | in, shorter |
| Header tag Locked | words | `locked` | 3 | 82 px to 104 at 130%, the row unchanged | in |
| Header tag Name hidden | words | none | 3.2 | Hidden's eye already stands beside it | words |
| Header tags Riding, Carries, Dragged by | words | none | 4 | | words |
| Take a shape ("N shapes" for a druid with known forms), Re-sync, End the shape | words | none | 4 | | words |
| Class resources' Use, Give one back (Restore), Spend | words | none | 4 | | words |
| Rest's Short Rest, Long Rest | words | none | 4 | | words |
| Page's Delete {name} | words | `delete` and the words | 3 | the block button, unchanged | in |
| Add a companion | words | `plus` and the words | 3 | 187 px to 218 at 130%, its row unchanged | in |

**A group's summary gives way first.** A header's action (Take a shape, Attach a stat block) wraps under the name when the name, the whole summary and the action do not fit. On `1ca246d2` the folded Stat block header is one line at 1280 x 800 and wraps at 320 and 390 at 130% (Thorn at 390 at 115% too). The icon would add wraps at 1280 x 800 and 390 at 115% (3.3). So the summary has no width of its own past a floor of 4em: the name, the icon and the action keep their line, and the summary is cut sooner, 3.3's named exception. Without the floor the summary shrinks to a fragment, 10 px of Thorn's at 390 at 130%. Measured: no header row grows at any size. Rejected: no icon on a group with an action, since then one group of eight would have none.

## 6. The panels' selector

Measured in the side panel's own px with Inter, for the DM and a player, at 1280 x 800 at 85%, 100%, 115% and 130%, 1440 x 900, and a touch screen at 1180 x 820 and 844 x 390 at 85%: the tab list is 295 px at every one. Re-measured on `1ca246d2` at the 1280 x 800 sizes and the tablet.

| Look | Tabs in the row (DM and player) | More's room |
|---|---|---|
| Names, today | Token, Initiative, Dice | 118 |
| Icon and name | Token, Initiative | 124 |
| Icons alone | Token, Initiative, Dice, Log | 111 |

With the panel-tabs design's narrower rooms, 248 px (a phone held sideways at 85%) and 236 (a large phone held sideways): names hold two tabs, icon and name one, icons alone three. So the row draws its icons alone everywhere today, and the rule of 3.1 picks icon and name by itself if a future side panel or font leaves room.

More holding a panel at 295 px, measured at the five sizes: seven names fit with their icon and caret (Journal is 103 px at 100%). Monsters, Encounters and Characters do not, so More draws their icon alone, 50 px at 100%, shows the name on hover and focus, and on a tablet the header names the panel.

| Control | Icon | Rule | Measured | Verdict |
|---|---|---|---|---|
| Each tab | the panel's, alone | 3.1 | 44 px, the row one 45 px line at 100% | in |
| More, holding a panel | the panel's, then its name, or alone for Monsters, Encounters and Characters | 3.1 | no name cut at 295 | in |
| The side panel's header line | none: the panel's name | 3.1, 3.8 | 38 px at 85%, 45 at 100%, 52 at 115% and 58 at 130% on a 1180 x 820 tablet. 38 on a phone held sideways at 844 x 390 at 85%, 45 at 932 x 430. None on a computer or in a phone's sheet | in, touch only |
| More's list rows | the panel's, 16 px | 3.1 | one line each, full width | in |
| Two panels in More's list | `splitPanel` | | | built |
| The split bar's name | the panel's, then its name | 3.1 | 93 px for Token at 100%, not cut | in |
| The split bar's list rows | the panel's | 3.1 | | in |
| A phone's Panels list rows | the panel's, 20 px leading | 3.1 | every row's height unchanged at the four phone sizes | in |
| The toolbar's Panels button | `panels` | | | built |

The header line costs the panel its height whenever it shows, which is nearly always. The panel's body, before and after, on the tablet: 644 to 605 px at 85%, 614 to 569 at 100%, 583 to 531 at 115%, 553 to 495 at 130%. On a phone held sideways with the panel shown: 313 to 275 at 844 x 390 at 85%, 340 to 295 at 932 x 430, the most it costs, about an eighth. It stays there: a touch pointer has no hover, so without it the open panel is learned only by a long press, and on so short a screen the panel is shown by choice. Rejected: no header below the short landscape height, where the side panel starts hidden, and a shorter line of text, a second header look beside the subpage's 44 px one that would make the body jump on every subpage. Drawn on a computer too, it measured 38 px at 85%, 45 at 100%, 52 at 115% and 58 at 130% at 1280 x 800, for nearly every panel (594 px to 549 at 100%). So D-261024-36, as amended, draws it on a touch pointer only. A computer already names a tab on hover and focus, and its panel keeps its height.

On a touch screen the tabs draw their icons alone too. The first pass's rule 2 would draw words on touch. D-261024-36, a decision of this pass's review and not the owner's, keeps the icons alone there and, on a touch pointer, draws the header line wherever the row does not show the open panel's name. So a tablet keeps its fourth tab, the tab boxes never move on a pick, and no one needs a long press to learn which panel is open.

## 7. The rest of the app

What the first pass missed, or what arrived without words to scan.

| Screen | Control | Icon | Rule | Measured (worst size) | Verdict |
|---|---|---|---|---|---|
| Journal | New page | `plus` | 3 | the block button, unchanged | in |
| Encounters | New encounter | `plus` | 3 | unchanged | in |
| Characters | New character | `plus` | 3 | unchanged | in |
| Monsters | New monster | `plus` | 3 | wraps to two lines at 390 at 130% | out |
| DM panel | Add a TV | `plus` | 3 | its row 57 px to 125 at 390 at 130% | out |
| Scenes | a scene's menu rows | `duplicate`, `delete` and two new | 3 | each row grew with a leading stand-in, its hint narrowed | out |
| Log | Export's Download, Save or share | `download`, `share` | 3.2 | a pair of word buttons | words |
| Traps | the pane's groups | none | 3.2 | an editor read top to bottom once | words |
| Traps | Ask to search, Ask to disarm, Set it off, Arm | none | 4 | | words |
| Dice | the folds Saves and checks, Actions, Spells and the rest | none | 4 | rules terms | words |
| Outliner | its groups and filter chips | none | 3.2 peers | Doors and Drawings have no art | words |
| Attach | Controlled, Independent | none | 4 | | words |
| Known forms | Take a shape and its dialog | none | 4 | | words |

## 8. The token bar

The token bar's resting strip and expanded bar are rebuilt in another lane (docs/design-v1-bar-compact.md, read from its stack). D-261024-37 chose a leading icon on the controls found among others, icons alone only for shapes read at once on a phone, Expand and Collapse as words with their chevron, and HP's modes as words beside icons only where room allows. **Every number below comes from the bar design's own widths (its 3.1, 3.3, B.2 and B.4) and sums of them, in layout px, to be measured in the browser once the bar lands, when a short prototype and an addendum review follow.** The play row's lines are the DM's on Thorn, before Light and Attach, whose widths the design does not give.

The room: the quick row's inner width is 205 at 320 x 568 at 130% and 258 at 390 x 844 at 130% (348 at 390 x 844). A leading 16 px icon and its 8 px gap add 24 px to a button. At 100% the design measures Conditions 99, Multi-select 108, Uses 60, Details 72, Roll 51, Hidden 98 (icon and words) and the HP lead 174.

Two new meanings, checked against the first pass's 2.2 and 2.3: `conditions`, Lucide `tags` (the bar's Conditions, never one condition, which shows its art), and `uses`, Lucide `zap` (the bar's Uses, never a lightning damage type, which stays words). Details has no free drawing: Lucide `info` is `about`, the page is `statBlock`, the scroll is `log`.

| Control | Where | Icon | Rule | 320 x 568 at 130% | 390 x 844 at 130% | Verdict |
|---|---|---|---|---|---|---|
| Close, Deselect all | header | `close` alone | built | 44 | 44 | built |
| Expand, Collapse | header | `chevronUp`, `chevronDown`, then the words | D-261024-37 | the title 109 to 55 (Expand) or 45 (Collapse), under "HP 24/24", cut | the title 162 to 108 or 98, and the status line drops its AC (the design's 3.3 rule) | the chevron alone at both, its words as its name. Its words where room allows |
| Scroll for more | header | `scrollMore` alone | built | 44 | 44 | built |
| HP mode toggle | strip | its sign, − + = T | built | 44 | 44 | unchanged |
| HP field, Apply, Crit, Use 9 | strip | none | 4 | | | words |
| Conditions | strip | `conditions` | 3.3 | not shown today: the lead alone, 31 left | skipped today: 29 left of 99 | out: at 390 x 844 at 100%, 16 px are left, and the icon pushes Roll off the strip (Uses at 440 x 956) |
| Multi-select, Details | strip, a player's | `group`, none | 3.3 | 21 px left: one icon pushes Details off | 74 left: both would fit | out on the strip |
| Uses, Hidden, Roll, Undo move, Doesn't count, a door | strip | Hidden and Undo built, the rest none | 4 | | | as today |
| Damage, Heal, Set, Temp | expanded HP modes | none | 2.2, 2.3, 3.2 peers | | | words |
| Conditions | play row | `conditions` | D-261024-37 | three lines stay three (123, 132 with Roll, Uses 84 with Hidden) | two lines stay two | in |
| Uses | play row | `uses` | D-261024-37 | in the three lines above | in the two above | in |
| Multi-select | play row | `group` | 3.3 | its line holds | Conditions 123 and Multi-select 132 come to 259 of 258, a third line | out unless measured to hold |
| Size − and + | size row | `minus`, `plus` alone | built | | | built |
| Locked, Duplicate, Delete, a group's More and Clear | | as today | built | | | built |
| Roll, Request a roll, Roll a Death Save, Revive, Start a fight, Attach, Get off, Light, Stat block, Details, elevation −5 and +5 | | none | 4, 3.2 | | | words |
| Condition chips, the Conditions drawer | | the art | built | | | built |

- **The strip takes no new icon.** It fits its buttons by width and skips one that does not fit whole (the bar design's 3.3), so a 24 px icon never wraps it: it pushes a control into the expanded bar. By the design's widths that happens at every size where the strip holds Conditions, Uses or Details.
- **Expand and Collapse** change the whole bar, so they take their words with the chevron where room allows (D-261024-37 clarified). On the strip at 320 and 390 at 130% the header has no room for the words without cutting the status line, so there the chevron stands alone, as a fold's does (rule 1), with its words as its accessible name (D-261024-37 amended). This is 3.3's third exception. The browser confirms the room once the bar lands.
- **The HP modes stay words.** Heal takes no heart, which reads as HP, and Temp no shield, which is AC. Temp's other candidates are the Readied hourglass and the turn timer's stopwatch, and Set has none. Damage and Heal could take Lucide `droplet` and `bandage`, but an icon on two of four segments breaks 3.2's peers. The strip's toggle keeps its signs.
- **"Rest" is no bar control.** In the bar's code `RestRow` is the resting strip's quick row. The rules' rests are the Token panel's Short Rest and Long Rest, which stay words (section 5).
- The Uses drawer's rows keep their words (section 4). A toast's Dismiss takes `close` alone where it stands apart from word buttons.

## 9. What stays words for room

- A trap card's title with the trap's art: wraps at 320 x 568 at 130%.
- "Hidden from players" with its icon: cut at 320 x 568 at 130%. It reads "Hidden" with the icon instead, as the tracker's tag does.
- A chip with a number, exhaustion's included: the art beside the number is 27 px, past the 20 px box.
- New monster with `plus`: wraps at 390 x 844 at 130%.
- Add a TV with `plus`: its pair wraps at 390 x 844 at 130%.
- A scene's menu rows: each row grew with a leading icon.
- The tabs' names: in today's side panel they cost the row a tab, so the tabs draw icons alone.
- The bar's strip, and Multi-select in its play row (section 8).

## 10. Calmer or equal, screen by screen

Before and after shots in `screenshots/icons2/r2/before/` and `after/`, each pair from one restored database and one script: the same round, the same chosen tab, the same conditions, with an exhaustion chip on Wren and a counted Hexed on Thorn. Only the turn timer's "Time's up" differs, since it counts real time. After D-261024-36's amendment the computer and tablet sizes were shot again, before and after, in `r3/` from a fresh seed of the same room: no header line on a computer, the panel's body as tall as before (594 px at 100%), and 45 px on the tablet.

- **The tab row** (`tabs-d1280-100`, `tabs-t1180-100`, `tabs-more-menu-*`, `tabs-hover-d1280-100`): four 44 px icons and "More" in place of three words and "More", one more panel in reach. On a computer (`r3/`) the panel keeps its height, and the name shows on hover. Calmer. On the tablet a header line names the open panel: one line of words where the three tab names were, and the panel 45 px shorter. Calmer in the row, equal overall.
- **A phone's Panels list** (`panel-list-p320-130`, `p390-130`): an icon leads each row, the same height. Equal, and quicker to find a panel. A phone gains no header line.
- **The split bar** (`split-d1280-100`): its name gains the panel's icon, unchanged in size. Equal.
- **The tracker and the party bar** (`combat-tracker-*`): letters become the art the map's chips show, in the same box, where a chip holds no number. "E2" and "Hx 3" stay. The clock gains a timer at its own size. Equal in clutter, quicker to read.
- **The alerts** (`combat-alerts-*`, `combat-lines-*`): "Collapse" and "Dismiss" become a chevron and an x, and each line starts with its kind. Fewer words on every card. Calmer.
- **The Token panel** (`token-groups-*`): each group's header gains a muted icon, every row the same height. The folded Stat block's summary is cut where the icon takes its room (3.3). Equal in rows, a few summary words fewer.
- **The header's tags** (`token-goblin-tags-*`): "Hidden from players" becomes "Hidden" with its eye, "Locked" gains its lock, and "Name hidden" stays words, the rows the same height. Calmer.

## 11. Decisions, with what was rejected

1. **The tabs draw icons alone where names would cost a tab, and on a touch pointer the side panel names the open panel above it wherever the row does not (D-261024-36, amended).** Rejected: the header on a computer too, which costs the panel 45 px for nearly every panel. Icon and name always, which sends Dice to More. Names on touch, which costs a tablet a tab. The chosen tab named, which moves the tabs whenever the choice changes, where the tabs design keeps every box still as a panel is chosen (its test 2, "Nothing moves").
2. **More names a held panel by icon and name, or by its icon where the name would be cut**, with its tooltip, and on a tablet named above the panel. Rejected: a cut name, which the owner's amendment rules out.
3. **The panels take Lucide icons, and Dice a d20 derived from the app's own.** Rejected: game-icons.net's dragon head for Monsters and its d20 for Dice, filled pictures among stroked ones. Lucide's dices, which the first pass ruled out.
4. **Groups take icons, the sections in them stay words.** Rejected: an icon on every section label, busy, and Hit Points, Rest and Class resources have no art to take.
5. **A group's summary gives way to the icon and the action, down to 4em, cut where the icon would wrap the header (3.3).** Rejected: today's summary rule, which wraps Thorn's header at 1280 x 800. No floor, which leaves a 10 px fragment. No icon on a group with an action.
6. **The tracker's and party bar's chips draw the art where they hold no number.** Rejected: letters beside the art, twice as wide. The art beside a number, 27 px, past the 20 px box.
7. **The alert cards' titles stay words, the lines take their kind.** Rejected: a kind icon on every card. The trap's title wraps, and three kinds have no art.
8. **A token's header reads "Hidden" with the icon, and "Name hidden" in words.** Rejected: the icon with "Hidden from players", cut at 320 at 130%, no icon, where the tracker's tag has one, and the eye on "Name hidden" too, a second drawing of what the row shows.
9. **The bar's icons go in its expanded rows, not its strip. Expand and Collapse take their words where the header has room, and the chevron alone at 320 and 390 at 130% (D-261024-37 amended).** Rejected: icons on the strip, which push a control off it. Icons alone across the strip (D-261024-37). Expand's words at every size, which cut the status line on a 130% phone.

## 12. Prototypes

Three commits beside this note, each with its review fix as a child, never to be stacked as they are: they rebase onto the bar stack in the build (section 14).

- `pwpuyszt`, `zoutwwns` and `qmpukoym` (the header on a touch pointer only, at the stack's tip) the panels' selector: `Icon.tsx`, `panels.ts` (`PanelDef.icon`), `tabFit.ts` (`tabLook`, `widthsFor`, `rowNamesOpen`, `headerNamesOpen`, with tests counting Dice), `SideTabs.tsx` (`PanelTab` with its hidden title, More's tooltip, the header's title), `SideTabs.test.ts`, `SplitBar.tsx`, `Room.tsx` (`PanelPicker`, `SidePane`), the credit.
- `npszvprn` and `mwylkppw` the combat tab: `parts.tsx` (`Chips`, `TimerClock`'s `icon`), `PartyBar.tsx`, `EffectIcon.tsx` (`EffectArt`, `ChipFace`, `effectHasArt`, with tests), `TrackerPanel.tsx`, `TurnCard.tsx` (its leading chevrons, the folded count as the description, `unqnwkmz` at the stack's tip), `InitiativeStrip.tsx` (`AlertLine`'s `lead`, a notice's key), the credit.
- `sxmrqsll` and `sllyqkrn` the Token panel: `Panel.tsx` (`Group`'s `icon` and its summary's floor), `TokenPanel.tsx`, `CreatureHeader.tsx` (`HeaderTag`), `StatBlockSection.tsx`, `PcStatBlock.tsx`, `CompanionsSection.tsx`, `CharacterCard.tsx`, the credit.

Each fix passed typecheck and the tests it touches, and the stack's tip the whole unit suite. The New and Add buttons of section 7 were measured with a stand-in and are not in a prototype. The bar has no prototype yet (section 8).

## 13. UI checklist

- **Loading**: the art is a CSS mask of a file the map already loads. Until it arrives the chip shows its color in the same box, so nothing moves.
- **Keys and focus**: the tabs keep the tab pattern and its keys. An icon-only tab, and More with its icon alone, shows its name 150 ms after keyboard focus (first pass 3.2). The turn card's and lines' icon buttons are in the Tab order where their word buttons were. The header line takes no focus and is no subpage.
- **Screen readers**: every icon is `aria-hidden`. An icon-only tab is named by its hidden title and its badge's words. More keeps the held panel's title in a hidden span where it draws its icon alone, and its count in its description. A chip keeps `role="img"` and its full label. A tag shortened to "Hidden" keeps "Hidden from players" as its title.
- **Large interface sizes**: measured at 85%, 115% and 130% (section 1). The timer draws at the clock's text size, so a header line never grows.
- **Words shown**: "Hidden" in place of "Hidden from players" in a token's header. "Collapse", "Show" and "Dismiss" leave the alerts' screens as words and stay their buttons' names. The open panel's name above it on a tablet. No other words change.

| Case | Expected | Test |
|---|---|---|
| Side panel at 295 px | Token, Initiative, Dice, Log as icons, then More | tabFit.test.ts, alignment sweep |
| Side panel at 236 px | Token, Initiative, Dice as icons, More | tabFit.test.ts |
| A room where every named tab fits | icon and name on each | tabFit.test.ts |
| Any room 0 to 360, four fonts, both roles | the icons alone never hold fewer tabs than the names | tabFit.test.ts |
| An unread Log, its tab an icon | named "Log 2 unread" | SideTabs.test.ts, paneltabs e2e |
| An upload waiting on the DM tab | named "DM 1 upload waiting" | SideTabs.test.ts |
| An icon tab chosen on a tablet | the header names the panel, from the first frame | tabFit.test.ts (`headerNamesOpen`), paneltabs e2e |
| An icon tab chosen on a computer | no header, the name on hover and focus, the panel's height unchanged | tabFit.test.ts, paneltabs e2e |
| Encounters opened from More at 295 | its icon and caret, its name on hover and focus, on a tablet the header naming it | paneltabs e2e, tooltip tests |
| Journal opened from More at 295 | icon, "Journal", caret, no header | paneltabs e2e |
| A phone held sideways at 844 x 390 at 85%, the panel shown, an icon tab chosen | the header names the panel, 38 px | paneltabs e2e |
| A panel open in a phone's sheet, or below in two panels | no header line | sideheaders and splitpanel e2e |
| Hover or focus an icon tab | the panel's name, no native title | Button and Tooltip tests, sweep |
| A condition on a tracker row | its art in the 20 x 18 chip, its label read | EffectIcon.test.ts, sweep |
| Exhaustion 1 to 6 on a party chip | "E1" to "E6" in the 20 px box | PartyBar.test.ts, sweep |
| A counted effect on a row | its letters and number, as today | EffectIcon.test.ts, sweep |
| A custom status or an unknown key | its glyph | EffectIcon.test.ts |
| Turn timer on | a timer at the clock's size, the header's height unchanged | sweep |
| Turn card open, and folded | a chevron leading the title and an x, named Collapse and Dismiss, and a chevron leading Show | combatuses e2e |
| An effect ends | its art, the words, an x | fold e2e |
| Folded Stat block with Take a shape at 1280 | one line, the summary cut | sweep |
| A hidden, locked token with its name hidden | Hidden and Locked with icons, "Name hidden" in words | tokenpanel e2e |

## 14. Lane plan

One build lane, after the bar stack is on main, since it touches `Icon.tsx` and the credit (the bar adds `chevronsDown`), `Room.tsx`, `InitiativeStrip.tsx` and `CharacterCard.tsx` (the bar stack). In order, one commit each:

1. The new meanings in `Icon.tsx`, `shared/credits.ts` and CREDITS.md, with `EffectArt` and `ChipFace`.
2. The panels' selector and the header line, from `pwpuyszt` and `zoutwwns`, with panel-tabs 3.8's amended text.
3. The combat tab, from `npszvprn` and `mwylkppw`.
4. The Token panel and a page, from `sxmrqsll` and `sllyqkrn`.
5. New page, New encounter, New character, Add a companion and a page's Delete.
6. The tests of section 15.
7. FEATURES.md ("Icons with their names on hover and focus" gains the panels, the groups and the combat art) and the DM guide's lines on the side panel's tabs, with new screenshots.

Then the bar's section 8: a short prototype measured in the browser and an addendum review, as a follow-up of its own.

## 15. Tests

- **No new wrap, in the alignment sweep** (`e2e/alignment.e2e.ts`): reuse `e2e/helpers/wraps.ts` (`textLines`, `wrappedButtons`). At each size: the tab row is one line, each tab 44 px tall and no tab's or More's text cut. Each group header's name is one line. In a folded Stat block header with its action the action stands on the name's line at 1280 x 800, and wraps only where it does today. The round header's height with the timer equals one line. Each alert line's text lines and height match the same line drawn without its lead. The fixtures put an exhaustion chip and a counted effect in a tracker row and a party chip, each the height and width it has today.
- **Mutation**: with the summary back to today's rule, Thorn's header wraps at 1280 x 800. With the floor removed, a summary under 4em shows. With the timer at 16 px, the round header grows. With a tab given its name, the row holds three tabs. With an icon tab given an `aria-label`, the SideTabs test fails.
- **The header line** (paneltabs e2e): in a touch context (a tablet, and a phone held sideways at 844 x 390 at 85% with the panel shown), an icon tab chosen shows the header, read in the first animation frame after the pick, so it never draws a frame without it. More named shows none. A computer's context shows none and its panel keeps its height. A phone's sheet and the lower pane of two never draw it.
- **The first pass's names and tooltips** (its section 8): `components/Button.test.ts` covers the new icon-only buttons. `SideTabs.test.ts`: an icon-only tab's name is its hidden title and its badge's words, never an `aria-label`, with an unread count and a badge's own label. The Tooltip tests: an icon-only tab and More with its icon alone show the name on hover, keyboard focus and a long press, with no native `title`, and More still opens its menu on a click and keeps its description. `components/icons.test.ts` holds the 19 new Lucide names to the credit, CREDITS.md and the Feather list (`compass`, `hash`), and every new meaning draws its own shape.
- **Unit**: `tabFit.test.ts` (the cases above, Dice included), `EffectIcon.test.ts` (`ChipFace`: art with no number, "E4" for exhaustion, letters and number for a counter, letters for a custom status or unknown key), `PartyBar.test.ts` (E1 to E6 in the 20 px box, the art for a condition), `TurnCard.test.ts` (the folded card keeps "Show {title}" as its name and "3 uses" or "1 use" as its description).
- **e2e touched**: `alignment`, `tokenpanel`, `combatuses`, `fold`, `sideheaders`, `paneltabs`, `splitpanel`, and `reach`.

## 16. As built

The builder fills this in the lane's docs commit with every place the build went its own way.
