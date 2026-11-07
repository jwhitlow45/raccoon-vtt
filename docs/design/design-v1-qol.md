# raccoon-vtt: the quicker table, the chips' menus and the room search

Status: built (2026-11-06), from three designs and their contract note, each at review consensus after three rounds. Base main `069591ea` when designed, built on the polish pass and the sound layout. Decisions D-261106-100 to 179 (section 9), and the build's D-261106-206 to 334. The "As built" section at the end says where the build went its own way. This note is the three designs shortened to what a later reader needs: the audit (Q1 to Q13), the chips (C1 to C8) and the search (S), with the contract that joined them.

The project owner (2026-11-06): "to cap the v1 we should begin doing some QOL/ease of use work to limit the amount of clicks someone has to do to perform common actions, and overall just make the app quicker to use." The same note asked for the top bar's chips to do more ("maybe clicking on players see black allows the dm to easily dismiss it in a dropdown somehow, and also maybe clicking on dm could have some quick dm options like show a handout") and for "an intelligent search of the menus". After the options page, every idea at its recommended option, with its shots: "All artifacts look good to me."

## 1. Scope

**In**: every idea at its recommended option. The audit's Q1 to Q13 (Q5's second option, moving Find my token, is out: it moves a control the owner saw). The chips' C1 to C8 (C8 adds no key, and the search is the keyboard path to the DM menu). The search, with Ctrl+K and Cmd+K as its key and the Panels list's field as its phone entry.

**Out, on purpose**: Short Rest for the party, a quick d20 that rolls at once, a floating Next or End turn over the map, a key for the DM menu, a bottom sheet for the DM menu, the DM menu holding Long Rest, Ask the party, starting a fight or a scene switcher, chips in Recent rolls, and any ranking by use ("nothing reorders by use", design-v1-panel-tabs).

## 2. How it was measured

Each design ran a throwaway prototype on main, never committed, with a seeded room (scenes, a fight, players, sound) and `measureAlignment` at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%. The audit counted the presses of each common action before and after. The chips measured the top bar's row in every state. The search measured the matcher in Node on 3,000 entries and in a browser with the CPU slowed 4x and 6x. The presses in section 3 are the prototypes' counts, and the build's e2e counts them again.

## 3. The audit's ideas (Q1 to Q13)

| Id | What changes | Presses |
|---|---|---|
| Q1 | A creature's turn card lists its attacks as the Dice panel's own rows, with this turn's results under each. A player's card lists their creature's weapons | Tap, Roll, scroll, Attack, Damage to the card's rows |
| Q2 | **Apply to** chips under a damage roll: the turn card's result, the Dice panel's newest roll, and on the DM's device the toast of someone else's roll | 3 clicks (4 taps) to 1 |
| Q3 | The keys 1 to 9 start the HP entry | 2 to 1 |
| Q4 | **Next** on the DM's turn chip and band (built as C3) | 3 taps to 1 on a phone |
| Q5 | Find my token also selects the token and opens its bar | 1 tap fewer |
| Q6 | End turn on a phone's own action bar, on your turn | thumb reach |
| Q7 | **All 4 Goblin Warriors** in a monster's bar | 3 to 1 |
| Q8 | The group bar's **Save** opens the group save, and once the Damage field holds dice one press rolls saves and damage | 10 clicks and 2 typed to about 9 and 1 typed |
| Q9 | Recent DCs for a save | typing to a tap |
| Q10 | **Tab row** in This device: the panels that may be tabs | 2 clicks to 1 |
| Q11 | Recent handouts in the DM panel, each shown again to its own audience | 7 and a title to 3 |
| Q12 | **Roll monsters' Initiative**, a switch on by default, rolls as the fight starts | 3 clicks and a scroll to 2 |
| Q13 | The key C opens the Conditions, which start with the three used last | 3 clicks to 1 and a key |

**Q2, the chips.** A logged roll knows at most its creature, never the attack or its range, so chips rank and never cut by range. The origin is the roll's token on this device's scene, else its character's nearest token, else the selected tokens. Candidates are creatures this viewer may change the HP of, not dead and not the roller. The roller's enemies come first (a neutral roller has none), each group by distance, then name. The first four show.
- The DM's chip applies at once through `sendHpEntry`, as one Play step, busy until the server answers, then gone from the row, which reads "Applied to Thorn." Undo takes it back.
- A player's chip only fills the HP entry, since a player has no Undo, and only with "Players can apply damage and healing" on and only under their own roll.

**Q3.** A digit keeps its browser default so the field takes it. A browser that types nothing into a field focused during the key's own event gets the digit put in by an input event, never through the HP draft, and Enter then returns focus to the page, only for an entry a digit started. A key a device moved to a digit keeps it and leaves the HP range on that device. The sheet shows "1 to 9", or "2 to 9" with "1 is Ruler on this device."

**Q8, Q9, Q12.** Q8's count was recounted in round 2: the group bar's Save opens the page with its own ability picker, one press more than draft 2 said. Q9 shows the last three DCs sent for a save only, since a save's DC is the effect's. Q12 starts the fight, then runs Auto Initiative's own press for the monster rows without a value. The start's ops (`encounter.start` and every `encounter.add` batch) go as one gesture with one group, so a fight of 101 rows is one Play step, and the totals stay their own. With `monsterInitScore` on, the switch rolls only monster rows still without a score.

**Q11.** `handouts/recent.ts` keeps this device's last five showings for a room: the pick's kind and id, its title, its audience and when. A document is a whole-document reference with no page, and a re-show sends its pages as they are now. A re-show goes to the same audience less members who left, and an entry with no one left, a deleted image or a deleted document is not offered. It is device storage only, never in the room.

**Weighed and left**: chips under Recent rolls, a player's damage toast for a DM whose Dice panel shows (no toast comes then), and the Q4 option that drops the band's faces on a phone (it changes the band the owner saw).

## 4. The chips (C1 to C8)

- **C1, the DM menu.** The DM chip opens a dropdown on a computer and a phone alike, with a caret and `aria-haspopup="menu"`. Sections show only when they hold something: **Handouts** (Hide for each showing, Show for up to three recent ones, Show a handout…), **Players' screens** (Black out, Follow me, Bring everyone here or Move players here), **Map phase** (two or more phases), **Preview** ("View as <player>"), then what gave way from the bar (**Time**, **Now playing**). Each item is 2 presses from rest. Left out on purpose: Long Rest, Ask the party, starting or ending a fight, a scene switcher, and a "DM panel" item.
- **C2, the Blackout menu.** Players see black opens **End the blackout** and, while the DM looks at another scene, **Show players <scene>**. The reveal sends the move, then `view.blackout` with `whilePlayersOn: <scene>`, as one gesture and one Undo. The server lifts the blackout only while the players are on that scene, so a refused move, a deleted scene or a co-DM's move in between leaves it on. Where the bar is short the crossed eye opens the DM menu, whose first items are the same two.
- **C2's move.** Both moving items use one helper, lifted from SceneList: `moveWarning`'s confirm, `moveSoundOp` and the "Moving players…" state. A warning (fog off, or no party creature that can see) turns the item into "Move players anyway" or "Show players anyway" with the warning under it, and Cancel. The menu stays open while the server answers. A refusal shows in place, or as a toast if the menu has closed.
- **C3, Next.** An outlined pill at the turn chip's end for the DM ("Start" before the first turn), and at the end of a phone's band. It sends what N sends, busy until the answer.
- **C4, Show a handout…** opens the DM panel's form in a dialog, one component in two places sharing its draft. A library image takes the title this device last showed it with, under a hint.
- **C5, the clock chip** opens a popover from 900 px: the date line, the four steps and Open Time, staying open for a second step. The DM menu's Time opens the same steps as a sheet on a phone.
- **C6, the bar gives back what it took.** The bar re-measures from the whole row whenever its content changes or it widens, so a bar that lost its clock after a fight does not keep losing it.
- **C7, the You menu.** A player's chip opens a dropdown headed with their name: "<Character>'s sheet" for each character they own, and "X-card…".
- **C8, keys.** No new key. The chips are in Tab order after the room name.

**The top bar's order**, left to right: dot, room name, the DM chip (or the player's), Players see black, Search, the gap, Now playing, clock, Undo, Redo, Phase menu, the turn chip with Next, Find my token, View, Fit, Full screen.

**The give-way from 900 px up**, each step putting what left the bar into the DM menu (Search's home off the bar is the Panels field):

0. Search goes to its 44 px icon and never leaves.
1. In a fight, the next faces go from 5 to 3.
2. The clock chip leaves.
3. Now playing goes from full to compact.
4. Players see black folds into the crossed eye.
5. The DM chip keeps its dot and caret.
6. Now playing compact leaves.
7. Full screen leaves.
8. The Phase menu leaves.
9. The next faces go from 3 to none.
10. The gaps tighten, then View folds into the Menu.
11. The turn chip's name gives way by what the row lacks, down to 40 px, then leaves, with the whole name as a tooltip.
12. An overrun timer shows only "+1:25".

A player's strip takes steps 11 and 12 too, and if it is still short, "Your turn" drops while End turn stays. Its notice stays announced from a visually hidden live region that stays mounted. Below 900 px the strip goes to the band, the blackout folds, the DM chip keeps its dot, Search folds into the Panels field, Now playing compact leaves, the gaps tighten and View folds. Undo, Redo, Search's icon, the turn chip's round, face and timer, Next and Fit never leave.

**The worst case**, a long room name, a fight with a timer and a long turn name, a blackout, two phases, the clock, Search and Now playing, at 900 x 900 and at 1170 x 900 at 130%, overflowed by 229 px with steps 0 to 10. Steps 11 and 12 free 186 and 66 px. No measured state overflows. The turn chip's faces failed the alignment row-height check at 1440 (a 26 px face beside 22 px faces), so the next faces stand in one unpainted group.

**The chips' look.** A chip that opens a menu has a 16 px caret inside the same 28 px pill, in a 44 px tall target. The round forms, a member's dot and the crossed eye, stand where the bar is shortest, so their caret is smaller and tighter: 32 px wide against the plain dot's 28. Hover and focus show a tooltip only where the words are cut.

**Words.** The DM chip reads "DM", named "DM options" (its dot adds "You are the DM"). The crossed eye is named "DM options. Players see black". The menu's headings are Handouts, Players' screens, Map phase, Preview, Time and Now playing. Handout items read "Hide <title>" with "Showing", and "Show <title>" with "to everyone" or "to Pat". The blackout menu reads "End the blackout" ("Players see the map again.") and "Show players <scene>" ("Moves the players here and ends the blackout in one step."). A player's chip is named "You are Pat. Your options", and its menu "You".

## 5. The search

**Opening.** Ctrl+K or Cmd+K, the top bar's **Search** (a 28 px field-like button after the chips with the key, then a 44 px icon), or on a phone the field atop the Panels list and the top bar's icon. A dialog 640 px wide under the bar on a computer, and below 600 px a whole-screen sheet with Cancel. Pressing the key again, Escape, a click outside or Cancel close it, and focus goes back where it was, or to the map's focus target when it was on the page itself. There is no search in View as a player or on a table display.

**What it finds.** Panels, their sections and settings, actions with every DM menu item, keys but the arrows and Page keys, the tokens on the scene in view, characters and their fields, the selection's fields and conditions, scenes, monsters, playlists and tracks, journal pages, handouts and a typed dice formula. A player finds their own panels, the tokens their map draws, their characters with every field, and the pages and handouts they hold. A DM finds the few fields play reads on every character: HP, AC, Passive Perception, Senses, the rests and conditions. Each feature lists its rows in a `search.ts` beside it, gathered in `features/search/catalog/`. The DM menu's Time and Now playing are left out, since the search reaches Time and Sound as panels. A creature's field is offered only where its token panel or page draws the control, by that surface's own rule (`features/tokens/panelDraws.ts`), so a player lent a character's token without the character finds none of its card.

**The results.** An empty field shows **Recent** (this device's last five picks for the room and member, shown only while still in the index) then **Suggested**: in a fight Next turn first, else Start a fight, then Show a handout, Black out, Long Rest for the party and Sound, and for a player their character's page, Dice and the X-card. Typed words give one flat list of at most 40 rows, the first highlighted, each with the kind's icon, the title with the starts of typed words in bold, a second line with the kind and where it lives, a value where there is one, and the key where a key does the same. One flat list, not groups, since Enter runs the top row.

**Matching** (`features/search/match.ts`, pure, on words folded once):
- Every typed word must match, in any order. Small words may match nothing.
- A word grades as the word, its start, inside a word from 3 letters, a plural's singular, then a typo (Damerau distance 1 from 5 letters, 2 from 8). Typo matches show only when nothing better matched.
- Fields are the title, its other names and where it lives, each a little weaker. Joined words ("longrest") match.
- About 80 synonyms stand for app words ("hp", "init", "conc", "dv", "lr"), matching whole words or starts and never by typo.
- An entry may name best bets, the words it is meant by most often, and it comes first for them.
- Rank order: tier, then nearness (the selection, a player's own character), then the kind's group, then cost, then the shorter title, then A to Z with numbers in order. Nothing ranks by use.

**Words.** The field's placeholder reads "Search panels, settings, actions, tokens…" for a DM and "Search panels, settings, your character…" for a player, and the Panels list's field "Search panels, settings and the room". The list says "Recent", "Suggested", "No match for “x”.", "Loading monsters…", "Loading the DM's results…" and "Some results could not load." A DM menu item's row takes the menu's own words. The synonyms live in `features/search/words.ts`.

**Acting.** A verb does it and a noun goes to it.

| Result | Enter | Shift+Enter |
|---|---|---|
| Panel, section, setting | opens it, unfolds what holds it for now, focuses the control and rings it 1.5 s | the same |
| Action | as a setting, then presses the control, which shows its own confirm. A control that is off is focused | goes there without pressing |
| DM menu item | runs the item's own function from `dmMenuSections`, its ask, wait and refusal drawn in the row | goes to the item's twin in a panel |
| Key | runs it | the same |
| Token | selects it, frames it as the Outliner does and opens its bar | opens its panel |
| Condition | adds it to the selected token or takes it off, through the picker's op | opens the token's Conditions |
| Scene, playlist, track, monster, page, handout, character, field | opens at it, never moving the map or the players | the same |
| Dice formula | rolls it as the Dice panel does | puts it in the Dice field |

A press goes through the real control, so confirm, disabled state, busy look and Undo are the control's own. The search never sends an op of its own. Two kinds run a function instead: a condition (the picker's op) and a DM menu item (its run function), since a menu-only item has no panel control and pressing a twin would swap the side panel's tab. A DM menu kind has a twin that Shift+Enter goes to, and a unit test fails for a kind without one.

**The route.** One `openAt(scope, ui, route)` in `features/search/route.ts` blurs what the panel holds, reveals the folds on the route, publishes a request `{panel, page?, section?, anchor, press, seq}` and opens the panel. Room's focus kind `anchor` lands on the control after the panel's own focus placement. It never matches by words, only by `data-search="<id>"`, an optional `search` prop on the kit's Group, Switch, Checkbox, Segmented, Field and Button and the token panel's fields.

**Loading.** Everything is on the device. The player's catalog (`catalog/everyone.ts`) ships in the room's chunk. The DM's (`catalog/dm.ts`) is a chunk of its own, loaded by `dmCatalog.ts` behind a strict DM role check, preloaded with the DM's panels, and imported nowhere else (a source scan fails on any other import). While a part is not in, the list shows the rest and, after 200 ms, "Loading monsters…" or "Loading the DM's results…". A failed part says "Some results could not load." with Try again, then Reload.

**Players.** A player's index holds only what that player's projection holds and what they may do, enforced by where it comes from and never by filtering a fuller list.
- The room's things come only from `state.view`. A hidden token, a monster under fog, a DM-only page, an unrevealed handout and the sound library never reach a player's device, so they cannot be indexed. A hidden name is indexed by the public one. No notes text is indexed.
- Actions come only from `youMenuSections` and `catalog/everyone.ts`, never a DM menu item. Kinds a player has no panel for are not built. The list shows no counts of what is left out.
- Recents are stored per room and member as ids only.

**Size.** On a 3,000-entry room the matcher's keystroke median is about 0.6 ms (p95 1.3 ms), so about 3.5 and 8 ms on a phone 6x slower. A per-keystroke memo of word grades keeps the p95 down. Entries are folded once and the index rebuilds when the view, scene or selection changes.

**What keeps it current.** A unit test holds ids unique, each route to a real panel and fold, each anchor to exactly one `search=` in client code and the reverse, every panel and shortcut in the index for its roles, and every kind of DM menu item with a twin. An e2e sweep opens every panel and page as the DM and a player, unfolds every fold, and fails on any fold header, switch, checkbox, radio group, select, slider or labeled field with no anchor, short of an allowlist. Golden queries hold each case's first result.

**Keys.** Ctrl+K in the Keys table, and a Search surface: Up and Down, Enter, Shift+Enter and Escape. Ctrl+K and Cmd+K open it from anywhere but a dialog, a one-line field and a select box included, while a text area keeps every key. A Mac's Ctrl+K in a one-line field stays the field's (it deletes to the line's end), so there only Cmd+K opens it. Up, Down, Enter and Shift+Enter act on the list from the field alone, which keeps its own Home, End, Left and Right, and a button in the sheet, such as Cancel or Try again, keeps its own Enter. The top bar's button carries `aria-keyshortcuts="Control+K Meta+K"` and the tooltip "Search (Ctrl+K)".

## 6. Shared pieces, one owner each

| Piece | Owner | Users |
|---|---|---|
| `handouts/recent.ts` | Q0 | Q11's list, the DM menu's Show <title>, C4's remembered title |
| `view.blackout`'s optional `whilePlayersOn`, the one op step (OP_VERSION 49, an identity step) | Q0 | the reveal |
| The scene move's preparation, one helper | Q0 | SceneList, the DM menu, the Blackout menu |
| The toast's buttons, with a busy state that keeps the toast open | L1 | Q2's chips on a toast |
| `pages/chipMenus.ts` `dmMenuSections` and `youMenuSections`, each item with its own run function | QC-A | the menus and the search's catalog |
| `features/search/route.ts` `openAt` | S1 | the search and any action that opens a panel at a section |
| `pages/topBarFit.ts`, the bar's give-way and its order | QC-B | Now playing, Search, Next |
| End turn's wait, a Room scope slot with `useEndTurn` | Q0 | the strip's End turn, Next, a phone bar's End turn |

The streams and their order were the sound layout, then the polish pass, then this one, each deployed on its own. Inside it, a lane that edits a file another lane edits started on that lane's commit.

## 7. UI checklist

- **Loading.** The search's parts, a re-show, a move, Next, an apply chip and the start's roll each show busy and refuse a second press. Slow rows use the shared indicator after 200 ms.
- **Keys and focus.** A menu opens on its first item. Escape closes back to its chip. C opens the Conditions on their first cell, and Escape closes them back on the bar. A landing focuses the control and rings it, and a key pressed meanwhile ends a landing still waiting. Enter after a typed digit returns focus to the page.
- **Screen readers.** The search is a combobox over a listbox with a polite status ("No match", "1 result", "<n> results"). A chip's name is its words. A cramped player's bar keeps its turn notice in a live region.
- **Large interface sizes.** Every surface was measured at 130%. A target is 44 px tall. Nothing needs hover or a long press.
- **Words.** Headings are short nouns ("Tab row", "Recent"). Buttons are verbs.

## 8. Cases

| Case | Expected |
|---|---|
| A DM at 1440 in a fight with a blackout and music, narrowed to 900 and widened back | each step comes back as content and width allow, and Search is an icon from the first step |
| A DM at 320 at 130% | Search in the Panels field and no overflow |
| A recent handout shown to Pat alone, then Show <title> from the menu | "Show to Pat", and it goes to Pat only. If Pat left it is not offered |
| Show players <scene> while a co-DM deletes the scene or moves the players | the blackout stays on and the item shows the refusal |
| "black out" in the search and the DM menu's item | the same action, one press each, the same op |
| A player's search | no DM menu item, no hidden token, nothing from the DM's chunk |
| A fight of more than one batch, then Undo twice | the totals, then the whole start |
| A chip applied twice | the first lands, the creature leaves the row, one Play step |
| A digit moved to another action on this device | that digit leaves the HP range |
| An overrun timer on a cramped bar | "+1:25", "Your turn" dropped and still announced |
| Enter on Long Rest for the party in the search | Characters opens with the party's card and its Finish focused, and nobody rests until Finish is pressed |

## 9. Decisions

- D-261106-100 to 115 (the audit), 120 to 136 (the chips) and 140 to 152 (the search), each at the recommended option the owner okayed.
- D-261106-166 to 171: the shared pieces with one owner each, Search's give-way step first with its home off the bar the Panels field, three streams in order, the lanes, the Now playing chip moving into this stack, and Next in the chips' form (faces kept where they fit).
- D-261106-172: the reveal guards the lift on the server. Rejected: lifting from the move's answer on the client, which a co-DM's move still beats.
- D-261106-173: recent handouts keep their kind and audience. Rejected: listing only those shown to everyone.
- D-261106-174: a player's chips fill the HP entry. The DM's apply at once, with Undo.
- D-261106-175: the search breaks ties by kind and words, never by use.
- D-261106-176: the DM menu stays a dropdown that scrolls on a phone, and Show a handout… stays a dialog.
- D-261106-177: Roll monsters' Initiative is on by default.
- D-261106-178: Tab row starts with every panel ticked.
- D-261106-179: a key a device moved to a digit keeps it.
- The build's guesses are in the lanes' reports: D-261106-206 to 210 (the contract), 220 to 224 (the search core), 225 to 229 (apply chips), 230 to 234 (keys and the bar), 238 to 242 (panels), 250 to 254 (the menus), 255 to 259 (the give-way), 281 to 285 (Now playing), 310 to 314 (the route), 320 to 329 (anchors and the sheet) and 330 to 334 (the rest of the catalog).

## 10. As built

Built in lanes Q0 (the contract), S0 (the search core), L1 to L4 (attacks and apply, keys and the bar, phone reach, panels), QC-A and QC-B (the menus and the give-way), SL-C (Now playing), S1, S2a, S2b and S3 (the route, the catalogs and the sheet), then E (e2e) and D (docs). OP_VERSION is 49 and SNAPSHOT_VERSION stays 38: nothing changes shape, and the only protocol change is the identity step for `whilePlayersOn`. Where the build went its own way:

- **The contract** (Q0). A refused lift is `invalid` with `PLAYERS_ELSEWHERE`, "the players are on another scene now", and the guard covers any blackout value. If a co-DM moved the players between the move and the lift, the DM's Undo is refused with "it was changed since" and does not take back only the move. A move refused with `gone` shows no toast, so the menu says "Players not moved…" itself. A recent image is offered before the library loads, and members made DMs drop from an audience. End turn's wait is exported as `useEndTurn`, and its import from the action bar makes a safe cycle (the slot is read at render).
- **Apply chips and the card** (L1). The toast draws its buttons in `ToastParts.tsx`, not Room.tsx. The first chip is primary and chips grow to fill lines, one apply at a time per roll. A player's fill reaches only the token bar's entry, not the Token panel's, and drops when another token is selected. A toast with four chips on a 320 px phone at 130% stands tall over the map. The card shows a result line and throws no dice from itself.
- **Keys and the bar** (L2). A fast Enter after a digit typed it back after Apply emptied the field, so the guard waits for the browser's input event or the next key. The kind of "All N" is the monster block plus the name, on the token's scene, hidden included, not the camera's frame. Recent conditions are device-wide, recorded on add and frozen while the grid is open. At 320 x 568 at 130% End turn sits in the strip's play row. The group save's own Add a condition picker shows Recent and does not record.
- **Phone reach** (L3). Find my token calls `ui.tap`, since `ui.select` with `opens` does not open a closed bar. Start shows while `activeEntryId === null`, as the tracker does. A disabled Next uses the muted text color, not opacity.
- **Panels** (L4). The start's button keeps the saves' count in its words. Recent DCs go lowest first, per room, for saves only. Tab row is stored per role as the panels left out, and only the wide layout shows it. Every start button with someone to roll rolls, Selected token included, with the switch on, and the start is one step with it off too. `useRollBusy` is true from the press until the roll goes. A Recent handout's button wraps under its title at 320 at 130%. With the switch on, a fight start in an e2e step that types monster values must turn it off or expect the roll.
- **The menus** (QC-A). YouChip lives in Room.tsx and the clock chip's player form is untouched. BlackoutChip is gone, folded into one chip button. The popover re-places when an item arms or answers. A player's projection drops other players' characters' owners, which crashed the You menu in View as Pat before a fix. The handout form's tile pictures are blocks, which removes a 3 px baseline gap. The alignment helper did not count `[role="menuitemcheckbox"]` as a control, so the DM menu on another scene (Follow me's "only on <scene>") needed it added.
- **The give-way** (QC-B). The band step starts over with the rest, replacing the grow-only record. A late font starts the steps over, timer ticks do not. At 1440 with the side panel, a DM's fight on a scene with phases takes steps 1 and 2, since Next added about 80 px. The tooltip with the whole name shows after step 11. The short timer reads "0:00" in the second time runs out. The "Your turn" flare is as tall as the acting face. On the tightest bar during a blackout, the last step drops the crossed eye's caret so it takes the dot's width, which keeps a DM at 320 x 568 at 130% with a long room name inside the bar.
- **Now playing** (SL-C). The pill is drawn as two halves inside the two targets, since one pill around both stood as a painted 28 px box beside the connection dot and failed row-height by 18 px. Pause's target is 36 x 44. The chip shows only while the room's sound switch is on. Its card is a chip dialog, so it outlives a give-way. Background rows go in start order and the popover is placed again as its body loads. `usePopover` takes `anchorGoes`, so focus goes where its owner names when the anchor leaves, which the sound layout note's contract line had said was not declared. The DM menu's Now playing opens the card or sheet at every width.
- **The search core** (S0). The index rebuilds whole, keeping static entries' folded words in a WeakMap, and fields are catalog data. A value counts beside the title, "darkvision" has no synonym and "dv" stands for it, and a player's selection fields cover only a token they own. A DM's hidden-name token is found by its public name.
- **The route** (S1). One microtask-ordered landing with no waits, which waits for the pane, the page and the anchor, and a MutationObserver asks again when code loads late. A route that names only a panel focuses the panel. A waiting landing ends at the viewer's next press or the panel closing, with no timer. A scene lands on its row with the folder opened for now. A player never reaches Menu's settings page.
- **The catalogs** (S2a, S2b). Anchors sit on fold headers. Room settings' anchors are made from the form's data with their values. The DM menu's view reaches the context so a recent showing reads "Show Belak's letter to Pat". A phase's and a move's twin is the scene's row. A row is offered only while its control is drawn. Light level and Automatic walls anchor at their wide setting row so the name stays in view. Shift+Enter on a dice row fills the field without rolling. Not placed: Dice actions and spells (they load after the panel opens), the clock's start switch, an Initiative Turn sound row, and Join requests. Room name and New scenes anchor on the control under their name for now.
- **The sheet** (S3). A dice row rolls, then opens Dice. "Ctrl+K" is written as Ctrl+Z is. The phone sheet is used below 600 px and the bar's field is a fixed 240 px. Every index pick is kept as Recent. A phone's DM placeholder runs past the field beside Cancel and cuts mid-word, since Chrome draws no ellipsis in a focused input. At 390 at 130% Search folds into the Panels field before the gaps tighten and View folds, by this note's order.
- **Open items.** The Now playing item in the DM menu names no track. Short Rest for the party stays for later (D-261106-113).
